import { connectHost } from '@openchamber/sdk';
import { applyHostReady } from '@openchamber/sdk/ui';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

type Project = { id: string; name: string; directory: string };
type Session = { id: string; title: string; projectId: string; directory: string; createdAt: number; activity?: string; model?: string };
type Message = { id: string; sessionId: string; directory: string; role: string; text: string; createdAt: number };
type Source = Session & { slot: number };
type SourceStatus = { sessionId: string; directory: string; status: string; error?: string; truncated?: boolean };
type UncertainDispatch = { requestId: string; sessionId: string; directory: string; text: string; sourceKey: string; draftRevision: number };
type PendingDispatch = { requestId: string; sessionId: string; directory: string; sourceKey: string; payloadHash: string };
type RoutingOutcome = 'destination'|'abort'|'uncertain';
type RouteRecovery = {action:'revise'}|{action:'reroute';sessionId:string};
const $ = (s: string, root: ParentNode = document) => root.querySelector(s) as HTMLElement;
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const demo = new URLSearchParams(location.search).get('demo') === '1';
const app = $('#app');
let host: ReturnType<typeof connectHost> | null = null;
let projects: Project[] = [], sessions: Session[] = [], sources: Source[] = [];
let error = '', serviceState = 'Not connected', connectionMessage = '';
let draftRevision = 0, evalTimer = 0, routeTimer = 0, cooled = false;
let recommendation: string | null = null, routeText = '';
let routingOutcome: RoutingOutcome = 'uncertain', routeRecovery: RouteRecovery|null = null;
let routeStartedAt = 0;
let humanSelection: string | null = null, selectionVersion = 0;
let destinationChooserOpen = false;
let explanationGeneration = 0;
const explanationCache = new Map<string,string>();
const explanationFailures = new Map<string,string>();
let explainInFlightKey: string | null = null;
let recommendationGeneration = 0, recommendationInFlight = false, recommendationWanted = false;
let lastOutgoing: string | null = null, inFlight = false, asideInFlight = false;
let asideOutcomeUnknown = false;
let routerStatus:any=null, manageBusy=false, proposalResults:any[]=[];
let routerModel='', routerLatency:number|null=null;
let routerConfidence:number|null=null;
let managementMessage='', managementAnswer='';
let managementConversation:{role:'user'|'assistant';text:string}[]=[];
let guidanceRevision:number|null=null, guidanceText='', guidanceExists=false, guidanceLoading=false, guidanceSaving=false;
let guidanceProposal:string|null=null, guidanceProposalBase:number|null=null;
let updateGeneration = 0, updateLoopBusy = false, updateCursor: string | null = null;
let updateWake: (() => void) | null = null, streamNotice = '';
let messages: Message[] = [], statuses: SourceStatus[] = [], uncertainDispatch: UncertainDispatch | null = null;
let pendingDispatch: PendingDispatch | null = null;
let pendingRecoveryReady = false;
let pendingDispatchDurable = false;
const pendingResponses = new Map<string, number>();
const stoppedResponses = new Set<string>();
let storageQueue: Promise<void> = Promise.resolve();
const unsubscribers: (() => void)[] = [];
let disposing = false;
const storageKey = 'maxwell.sources.v1';
const pendingDispatchStorageKey = 'maxwell.pending-dispatch.v1';
const sourceKey = (s: Pick<Session,'id'|'directory'|'projectId'>) => `${s.projectId}\u0000${s.directory}\u0000${s.id}`;
const messageKey = (s: Pick<Session,'id'|'directory'>) => `${s.directory}\u0000${s.id}`;
const messageSessionKey = (m: Pick<Message,'sessionId'|'directory'>) => `${m.directory}\u0000${m.sessionId}`;
const statusKey = (s: Pick<SourceStatus,'sessionId'|'directory'>) => `${s.directory}\u0000${s.sessionId}`;
function setServiceState(value:string, message='') {
  serviceState=value; connectionMessage=message;
  const label=$('#connection-label'); if(label) label.textContent=value;
  const dot=$('#connDot'); if(dot) dot.setAttribute('data-tone',value==='Connected'?'success':value==='Unavailable'||value==='Invalid configuration'?'error':value==='Checking connection'?'pending':'warning');
  renderStatus();
}

function shell() {
  app.innerHTML = `<svg class="svg-defs" aria-hidden="true"><symbol id="demon" viewBox="0 0 24 24"><path class="demon-fill" d="M7.2 6.4 6 2.8l3.3 2.4ZM16.8 6.4 18 2.8l-3.3 2.4Z"/><circle class="demon-fill" cx="12" cy="12.5" r="6.6"/><path class="demon-stroke" d="M17.6 15.6c1.5.6 2.4 1.6 2.2 3-.15 1-1 1.5-1.8 1.2"/><g class="demon-eyes"><circle cx="9.6" cy="12" r="1.15"/><circle cx="14.4" cy="12" r="1.15"/></g><path class="demon-mouth" d="M10.6 15.1q1.4 1 2.8 0"/><path class="demon-muted" d="M2 21.5h7"/><path class="demon-gate" d="M3.2 21.5v-3.2"/></symbol></svg>
    <div class="shell"><main class="stream" id="stream" role="log" aria-label="Merged conversation stream" aria-live="polite"><div class="col"><div id="status" class="notice" role="status" hidden></div><div class="empty"><svg class="demon" aria-hidden="true"><use href="#demon"/></svg><h2>No sessions in view</h2><p>Choose sessions to read together, or start an aside. Their messages stay in their own sessions.</p><button class="ghost-btn" data-open-picker>Choose sessions <span class="kbd">Ctrl K</span></button></div><div class="feed" id="feed"></div></div></main>
       <footer class="composer"><div class="col"><div class="box"><textarea class="draft" id="draft" rows="2" placeholder="Write a message" aria-describedby="route route-advice"></textarea><div id="route-advice" class="route-advice" aria-live="polite" hidden></div><div class="box-foot"><div class="hint" id="route" aria-live="polite"></div><div id="response-controls"></div><div class="send-controls"><button class="send" id="send" disabled>Choose destination</button><button id="destination-toggle" class="destination-toggle" aria-label="Change destination" aria-expanded="false" aria-controls="dests">▾</button></div></div><div class="dests" id="dests" role="group" aria-label="Choose destination" hidden></div></div></div></footer></div>
     <div class="scrim" id="scrim"></div><section class="sheet picker" id="picker" role="dialog" aria-label="Sessions" aria-modal="true"><div class="picker-search"><span aria-hidden="true">⌕</span><input id="pickerQ" placeholder="Find a session" autocomplete="off"><button class="kbd" id="pickerClose" aria-label="Close sessions">Esc</button></div><button class="ghost-btn" id="connBtn" aria-haspopup="dialog">Connection settings</button><button class="ghost-btn" id="guidanceOpen" type="button">Guidance <span id="guidanceIndicator" class="fine"></span></button><div class="picker-body" id="pickerBody"></div><form class="aside-form" id="asideForm"><div class="lbl">Start an aside <span>A new session; nothing from this stream is copied.</span></div><label class="sr" for="asideTitle">Aside title</label><input id="asideTitle" name="title" placeholder="Title" required maxlength="120"><label class="sr" for="asideText">Initial message</label><textarea id="asideText" name="text" rows="2" placeholder="Initial message (optional)"></textarea><div class="line"><select id="asideProject" name="project" aria-label="Project"></select><button class="pbtn" id="asideGo" type="submit">Start aside</button></div></form><form class="manage-form" id="manageForm"><label for="manageText">Ask Maxwell to manage sessions</label><textarea id="manageText" rows="2" placeholder="Start an aside about… or select the session on…"></textarea><button class="pbtn" type="submit">Ask Maxwell</button><div class="fine">DeepSeek V4.1 Flash proposes actions; nothing happens until you review and accept.</div><div id="manageResults" aria-live="polite"></div></form></section><section class="sheet guidance-sheet" id="guidanceSheet" role="dialog" aria-label="Routing guidance" aria-modal="true"><div class="conn-head"><strong>Routing guidance</strong><button id="guidanceClose" class="kbd" aria-label="Close guidance">Esc</button></div><p class="fine">Private to Maxwell; used for routing advice, never appended to session messages. You can override recommendations.</p><div id="guidanceReview"></div><textarea id="guidanceText" rows="12" maxlength="16000" aria-label="Routing guidance text" placeholder="Optional guidance for routing recommendations"></textarea><div class="guidance-actions"><span id="guidanceStatus" class="fine" role="status"></span><button id="guidanceReload" class="toggle" type="button" hidden>Reload server version</button><button id="guidanceSave" class="pbtn" type="button">Save guidance</button></div></section>
    <section class="sheet connsheet" id="connSheet" role="dialog" aria-label="Connection"><div class="conn-head"><strong>Connections</strong><button id="connClose" class="kbd" aria-label="Close connection status">Esc</button></div><div id="connRows"></div><hr><form id="connectionForm" class="config-form"><strong>OpenChamber provider</strong><label>HTTP(S) origin<input name="endpoint" type="url" required placeholder="http://127.0.0.1:PORT"></label><label>Client token<input name="token" type="password" autocomplete="new-password" placeholder="Optional; never stored in Page storage"></label><button type="submit">Save and test</button></form><form id="routerForm" class="config-form"><strong>Tinfoil router</strong><label>Inference key file<input name="keyFile" type="text" required placeholder="~/.tokens/TINFOIL_KEY"></label><button type="submit">Configure router</button></form><div id="connectionFeedback" class="fine" role="status"></div></section>`;
  $('#connBtn').addEventListener('click',()=>toggleSheet('connSheet'));
   $('#pickerClose').addEventListener('click',closeSheets); $('#connClose').addEventListener('click',closeSheets);
   $('#guidanceClose').addEventListener('click',closeSheets);$('#guidanceOpen').addEventListener('click',()=>void openGuidance());$('#guidanceReload').addEventListener('click',()=>void loadGuidance(true));$('#guidanceSave').addEventListener('click',()=>void saveGuidance());
  $('#scrim').addEventListener('click',closeSheets);
  document.querySelectorAll('[data-open-picker]').forEach(b=>b.addEventListener('click',()=>toggleSheet('picker')));
  $('#pickerQ').addEventListener('input',renderPicker);
  $('#pickerBody').addEventListener('click',e=>{const b=(e.target as HTMLElement).closest<HTMLButtonElement>('[data-action="toggle"][data-session]'); if(b) toggleSource(b.dataset.session!,b.dataset.directory!,b.dataset.project!);});
  $('#draft').addEventListener('input',()=>{autoSizeDraft();evaluateRoute();});
    $('#send').addEventListener('click',()=>void dispatch());
    $('#destination-toggle').addEventListener('click',()=>setDestinationChooser(!destinationChooserOpen));
    $('#response-controls').addEventListener('click',e=>{const b=(e.target as HTMLElement).closest<HTMLButtonElement>('[data-action="stop-receipt"]');if(b)void stopResponse(b.dataset.session!,b.dataset.directory!,b);});
    $('#route-advice').addEventListener('click',e=>{const b=(e.target as HTMLElement).closest<HTMLButtonElement>('[data-action="select-destination"]'),source=b&&sources.find(s=>s.slot===Number(b.dataset.slot));if(source)selectHumanDestination(sourceKey(source));});
    $('#dests').addEventListener('keydown',e=>{if((e as KeyboardEvent).key==='Escape'){e.preventDefault();setDestinationChooser(false);$('#destination-toggle').focus();}});
    document.addEventListener('click',e=>{if(destinationChooserOpen&&!(e.target as HTMLElement).closest('#dests, #destination-toggle'))setDestinationChooser(false);});
   $('#dests').addEventListener('click',e=>{const b=(e.target as HTMLElement).closest<HTMLButtonElement>('[data-action]');if(!b)return;const source=sources.find(s=>s.slot===Number(b.dataset.slot));if(b.dataset.action==='stop-receipt')void stopResponse(b.dataset.session!,b.dataset.directory!,b);else if(b.dataset.action==='select-destination'&&source)selectHumanDestination(sourceKey(source));else if(b.dataset.action==='clear-selection')clearHumanSelection();else if(b.dataset.action==='explain'&&source)void explainRoute(sourceKey(source));});
  $('#draft').addEventListener('keydown', ev => {
    const e = ev as KeyboardEvent;
    if ((e.ctrlKey || e.metaKey) && /^[1-9]$/.test(e.key)) { e.preventDefault(); chooseSlot(Number(e.key)); return; }
     if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); void dispatch(); }
  });
  $('#dests').addEventListener('click',e=>{const b=(e.target as HTMLElement).closest<HTMLButtonElement>('[data-action="destination"]'); if(b) openPicker();});
  // The host iframe deliberately omits allow-forms. Handle actions directly,
  // rather than relying on native form submission inside that sandbox.
  bindFormAction('asideForm', () => void createAsideFromForm());
  bindFormAction('manageForm', () => void requestManagement());
  bindFormAction('connectionForm', form => void saveConnection(form));
  bindFormAction('routerForm', form => void saveRouter(form));
  $('#feed').addEventListener('click',e=>{
    const link=(e.target as HTMLElement).closest<HTMLAnchorElement>('a[href]');
    if(link) {
      let url:URL|null=null;try{url=new URL(link.href);}catch{}
      if(url?.protocol==='openchamber:'&&url.hostname==='session') { e.preventDefault();void openSessionLink(url.pathname.slice(1),url.searchParams.get('dir')||undefined);return; }
      if(url&&['http:','https:'].includes(url.protocol)) { e.preventDefault();void host?.openUrl(url.href).catch(err=>setError(`Could not open link: ${String(err)}`));return; }
      e.preventDefault();return;
    }
    const button=(e.target as HTMLElement).closest<HTMLButtonElement>('[data-action]');if(!button)return;
      if(button.dataset.action==='reply') { const s=sources.find(x=>x.id===button.dataset.session&&x.directory===button.dataset.directory&&x.projectId===button.dataset.project);if(s)selectHumanDestination(sourceKey(s)); }
     if(button.dataset.action==='stop') void stopResponse(button.dataset.session!,button.dataset.directory!,button);
    if(button.dataset.action==='open') {
      if(!host)return;const draft=($('#draft') as HTMLTextAreaElement).value;
      if(draft.trim()&&!confirm('Opening a session closes Maxwell. Your unsent draft will not be transferred. Continue?'))return;
      void host.openSession(button.dataset.session!).catch(err=>setError(`Could not open session: ${String(err)}`));
    }
  });
   $('#picker').addEventListener('keydown',e=>{if((e as KeyboardEvent).key==='Escape')closeSheets();});$('#guidanceSheet').addEventListener('keydown',e=>{if((e as KeyboardEvent).key==='Escape')closeSheets();});
  $('#connSheet').addEventListener('keydown',e=>{if((e as KeyboardEvent).key==='Escape')closeSheets();});
  renderSources(); renderStream(); updateRouteUI();
}
async function openSessionLink(rawId:string,directory?:string) {
  let sessionId='';try{sessionId=decodeURIComponent(rawId);}catch{setError('The session link is malformed.');return;}
  const matches=sessions.filter(s=>s.id===sessionId&&(!directory||s.directory===directory));
  if(matches.length!==1){setError(matches.length?'This session link is ambiguous across projects.':'This session link does not match a session available to this OpenChamber account.');return;}
  if(!host)return;
  const draft=($('#draft') as HTMLTextAreaElement).value;
  if(draft.trim()&&!confirm('Opening a session closes Maxwell. Your unsent draft will not be transferred. Continue?'))return;
  try{await host.openSession(sessionId);}catch(err){setError(`Could not open session: ${String(err)}`);}
}
function bindFormAction(id:string, action:(form:HTMLFormElement)=>void) {
  const form=$(`#${id}`) as HTMLFormElement;
  const button=form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  button.addEventListener('click',event=>{
    event.preventDefault();
    if(!button.disabled&&form.reportValidity())action(form);
  });
  form.addEventListener('submit',event=>event.preventDefault());
  form.addEventListener('keydown',event=>{
    if(event.key==='Enter'&&event.target instanceof HTMLInputElement&&!event.isComposing) {
      event.preventDefault();button.click();
    }
  });
}
function statusText() {
  const parts:string[]=[];
  if(error) parts.push(error);
  if(connectionMessage&&serviceState!=='Connected') parts.push(connectionMessage);
  if(!demo&&!pendingRecoveryReady) parts.push('Dispatch recovery state unavailable. Sending is disabled.');
  if(pendingDispatch&&!error) parts.push(`Unresolved delivery request ${pendingDispatch.requestId}. Retry its exact payload or inspect the original session before acknowledging.`);
  if(sources.length) for(const src of sources) {
    const status=statuses.find(s=>s.sessionId===src.id&&s.directory===src.directory);
    if(status?.status==='error') parts.push(`${src.title}: history unavailable${status.error?` (${status.error})`:''}. Existing messages are retained.`);
    else if(status?.truncated) parts.push(`${src.title}: showing the latest 100 messages; older history is available.`);
  }
  return parts.join('\n');
}
function renderSources() {
  renderPicker(); renderDests();
  const scope=$('#scopeText'); if(scope) scope.textContent=`${sources.length} session${sources.length===1?'':'s'}`;
  const projectSelect=$('#asideProject') as HTMLSelectElement|null;
  if(projectSelect) {
    const current=projectSelect.value;
    projectSelect.innerHTML=projects.map(p=>`<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
    if(projects.some(p=>p.id===current)) projectSelect.value=current;
  }
  renderConnectionRows();
  renderStatus();
}
function renderDests() {
  const el=$('#dests'); if(!el) return;
  const focused=el.contains(document.activeElement)?document.activeElement as HTMLButtonElement:null;
  const focusAction=focused?.dataset.action,focusSlot=focused?.dataset.slot;
  const currentRecommendation=!routeIsStale()?recommendation:null;
  const selected=humanSelection?sources.find(s=>sourceKey(s)===humanSelection):null;
  const pendingSource=lastOutgoing?sources.find(s=>sourceKey(s)===lastOutgoing):undefined;
  const stop=pendingSource&&pendingResponses.has(messageKey(pendingSource))&&!stoppedResponses.has(messageKey(pendingSource))?`<button class="stop-receipt" data-action="stop-receipt" data-session="${esc(pendingSource.id)}" data-directory="${esc(pendingSource.directory)}">Stop response in ${esc(pendingSource.title)}</button>`:'';
  const label=selected?`Selected by you: ${esc(selected.title)}`:pendingSource?`Last sent to: ${esc(pendingSource.title)}`:'Choose a destination';
  const clear=selected?'<button class="clear-selection" data-action="clear-selection">Use last recipient</button>':'';
  const chips=sources.map(s=>{
    const key=sourceKey(s),isSelected=humanSelection===key,isRecommended=currentRecommendation===key;
    const explainable=!!routeText.trim()&&key!==currentRecommendation;
    const cacheKey=routeExplanationKey(key,currentRecommendation);
    const explanation=explanationCache.get(cacheKey);
    const advisory=explainable&&(explanation||explanationFailures.has(cacheKey)||explainInFlightKey===cacheKey)?`<span class="route-explanation" role="status">${explanation?esc(explanation):explanationFailures.has(cacheKey)?esc(explanationFailures.get(cacheKey)):'Considering this alternative…'}</span>`:'';
    return `<span class="destination-wrap"><button class="chip destination ${isSelected?'human-selected':''} ${isRecommended?'model-recommended':''}" data-action="select-destination" data-slot="${s.slot}" aria-pressed="${isSelected}" aria-label="Select ${esc(s.title)}${isRecommended?', recommended by model':''}" ${explainable?`data-explain-key="${s.slot}" title="${explanation?esc(explanation):'Ask for an advisory explanation'}"`:''}><span class="slotkey" data-src="${s.slot}">${s.slot}</span><span class="name">${esc(s.title)}</span>${isSelected?'<span class="state-label">Selected</span>':''}${isRecommended?'<span class="state-label">Recommended</span>':''}</button>${explainable?`<button class="explain-button" data-action="explain" data-slot="${s.slot}" aria-label="Explain why ${esc(s.title)} is not recommended">?</button>${advisory}`:''}</span>`;
  }).join('');
  el.dataset.humanSelection=humanSelection||'';
   el.innerHTML=`<span class="to">${label}</span>${clear}${chips}<button class="chip add" data-action="destination">Manage sessions</button>`;
   if(destinationChooserOpen&&focusAction)el.querySelector<HTMLButtonElement>(`[data-action="${CSS.escape(focusAction)}"]${focusSlot?`[data-slot="${CSS.escape(focusSlot)}"]`:''}`)?.focus({preventScroll:true});
   $('#response-controls').innerHTML=stop;
   renderRouteAdvice();
}
function setDestinationChooser(open:boolean) {
  destinationChooserOpen=open;$('#dests').hidden=!open;$('#destination-toggle').setAttribute('aria-expanded',String(open));
  if(open)$('#dests').querySelector<HTMLButtonElement>('[data-action="select-destination"],button')?.focus();
}
function renderRouteAdvice() {
  const el=$('#route-advice');if(!el)return;
  const implied=sources.find(s=>sourceKey(s)===(humanSelection??lastOutgoing));
  const rec=sources.find(s=>sourceKey(s)===recommendation);
  const settled=!!routeText.trim()&&!routeIsStale()&&!recommendationInFlight&&cooled;
  const aborted=routingOutcome==='abort';
  const recovery=routeRecovery;
  const recoveryTarget=recovery?.action==='reroute'?sources.find(s=>s.id===recovery.sessionId):undefined;
  el.hidden=!settled||(!aborted&&(!rec||!!implied&&sourceKey(implied)===sourceKey(rec)));
  if(el.hidden){el.replaceChildren();return;}
  // Explanation needs a context candidate, which is not a destination selection.
  const candidate=implied||(aborted?(recoveryTarget||sources[0]):undefined);
  const key=candidate?routeExplanationKey(sourceKey(candidate),recommendation):null;
  const explanation=key?(explanationCache.get(key)||explanationFailures.get(key)):null;
  const selectButton=(source:Source)=>`<button data-action="select-destination" data-slot="${source.slot}" aria-label="Select ${esc(source.title)}, suggested by model">${esc(source.title)}</button>`;
  const advice=aborted?recoveryTarget?`Model advice: consider another destination, ${selectButton(recoveryTarget)}.`:routeRecovery?.action==='revise'?'Model advice: revise before sending. Edit the draft to clarify its intended conversation.':'Model advises revising the draft or choosing a destination before sending.':`Model recommends ${selectButton(rec!)}.`;
  el.dataset.outcome=routingOutcome;
  el.dataset.recovery=routeRecovery?.action||'';
  el.innerHTML=`<div>${implied?`Current destination: <b>${esc(implied.title)}</b>${humanSelection?' (selected by you)':''}. `:'No destination selected. '}${advice}</div>${candidate?`<p>${explanation?esc(explanation):'Considering this draft and the active conversations…'}</p>`:''}`;
  // Failures are cached too: repainting must never become an inference retry loop.
  if(candidate&&key&&!explanation&&!explainInFlightKey)void explainRoute(sourceKey(candidate));
}
function paintDestinations() {
  document.querySelectorAll<HTMLButtonElement>('.chip[data-slot]').forEach(chip=>{
    const source=sources.find(s=>s.slot===Number(chip.dataset.slot));if(!source)return;
    const isRec=sourceKey(source)===recommendation&&!routeIsStale(),isLast=sourceKey(source)===lastOutgoing;
    chip.classList.toggle('last',isLast);chip.classList.toggle('rec',isRec);chip.classList.toggle('settled',isRec&&cooled);chip.classList.toggle('cooling',isRec&&!cooled);
    if(isRec&&!cooled)chip.style.setProperty('--cool-ms',`${Math.max(0,1000-(Date.now()-routeStartedAt))}ms`);else chip.style.removeProperty('--cool-ms');
  });
}
function renderPicker() {
  const el=$('#pickerBody'); if(!el) return;
  const focused=document.activeElement as HTMLElement|null;
  const focusKey=focused?.dataset?.action==='toggle'?{id:focused.dataset.session,dir:focused.dataset.directory,project:focused.dataset.project}:null;
  const query=(($('#pickerQ') as HTMLInputElement|null)?.value||'').trim().toLocaleLowerCase();
  const matches=(s:Session)=>!query||`${s.title} ${projects.find(p=>p.id===s.projectId)?.name||''} ${s.directory}`.toLocaleLowerCase().includes(query);
  const row=(s:Session)=>{
    const selected=sources.find(x=>sourceKey(x)===sourceKey(s));
    return `<div class="row"><span class="slotkey ${selected?'':'none'}" ${selected?`data-src="${selected.slot}"`:''}>${selected?.slot||''}</span><span class="row-main"><span class="row-title">${esc(s.title||'Untitled session')}</span><span class="row-sub">OpenChamber · <code>${esc(projects.find(p=>p.id===s.projectId)?.name||s.directory)}</code>${s.activity==='running'?' · working':''}</span></span><span class="row-end"><button class="toggle" data-action="toggle" data-session="${esc(s.id)}" data-directory="${esc(s.directory)}" data-project="${esc(s.projectId)}" aria-pressed="${!!selected}">${selected?'In view':'Add'}</button></span></div>`;
  };
  const selected=sessions.filter(s=>sources.some(x=>sourceKey(x)===sourceKey(s))&&matches(s)).sort((a,b)=>(sources.find(x=>sourceKey(x)===sourceKey(a))?.slot||99)-(sources.find(x=>sourceKey(x)===sourceKey(b))?.slot||99));
  const other=sessions.filter(s=>!sources.some(x=>sourceKey(x)===sourceKey(s))&&matches(s)).sort((a,b)=>a.title.localeCompare(b.title));
  el.innerHTML=(selected.length?`<div class="group">In this view</div>${selected.map(row).join('')}`:'')+(other.length?`<div class="group">Other sessions</div>${other.map(row).join('')}`:'')+(!selected.length&&!other.length?'<div class="group">No matching sessions</div>':'');
  if(focusKey)el.querySelector<HTMLButtonElement>(`[data-action="toggle"][data-session="${CSS.escape(focusKey.id||'')}"][data-directory="${CSS.escape(focusKey.dir||'')}"][data-project="${CSS.escape(focusKey.project||'')}"]`)?.focus({preventScroll:true});
}
function toggleSheet(id:'picker'|'connSheet') {
  const sheet=$(`#${id}`), open=sheet.classList.contains('open');closeSheets();
  if(open)return;
  $('#scrim').classList.add('open');sheet.classList.add('open');
  if(id==='picker') { const query=$('#pickerQ') as HTMLInputElement;if(query.value)query.value='';renderPicker();((document.querySelector('#pickerQ') as HTMLInputElement).focus()); }
  else void refreshConnectionRows();
}
function openPicker(focusAside=false) {
  const sheet=$('#picker');if(!sheet.classList.contains('open'))toggleSheet('picker');
  const target=focusAside?$('#asideTitle'):$('#pickerQ');target.focus();
}
function closeSheets() {
  $('#scrim')?.classList.remove('open');$('#picker')?.classList.remove('open');$('#connSheet')?.classList.remove('open');$('#guidanceSheet')?.classList.remove('open');
}
function paintGuidance() {
  const indicator=$('#guidanceIndicator');if(indicator)indicator.textContent=guidanceExists?'· stored':'';
  const status=$('#guidanceStatus');if(status&&!guidanceLoading&&!guidanceSaving&&!status.textContent)status.textContent=guidanceExists?'Saved in Maxwell':'No guidance saved';
}
async function loadGuidance(reload=false) {
  if(!host||demo)return;
  guidanceLoading=true;const status=$('#guidanceStatus');if(status)status.textContent='Loading…';
  try {
    const response=await host.serviceRequest({method:'GET',path:'/guidance'}),body=responseJson(response.body);
    if(response.status<200||response.status>=300||!Number.isInteger(body?.revision)||typeof body?.text!=='string'||body.text.length>16000)throw new Error(body?.error||`Invalid guidance response (HTTP ${response.status}).`);
    const area=$('#guidanceText') as HTMLTextAreaElement|null,dirty=!!area&&area.value!==guidanceText,firstLoad=guidanceRevision===null;
    const changed=guidanceRevision!==null&&body.revision!==guidanceRevision;guidanceRevision=body.revision;guidanceText=body.text;guidanceExists=!!body.text;
    if(changed||firstLoad)guidanceChanged();
    if(reload){if(area)area.value=body.text;guidanceProposal=null;guidanceProposalBase=null;renderGuidanceReview();}
    else if(area&&!dirty)area.value=body.text;
    if(status)status.textContent=changed?'Server version loaded; previous recommendations were invalidated.':guidanceExists?'Saved in Maxwell':'No guidance saved';
  }catch(e){if(status)status.textContent=`Could not load guidance: ${e instanceof Error?e.message:String(e)}`;}
  finally{guidanceLoading=false;paintGuidance();}
}
function guidanceChanged() {
  routingOutcome='uncertain';routeRecovery=null;
  recommendationGeneration++;recommendation=null;cooled=false;routeStartedAt=0;explanationGeneration++;explainInFlightKey=null;explanationCache.clear();explanationFailures.clear();
  if(host&&serviceState==='Connected'&&($('#draft') as HTMLTextAreaElement|null)?.value.trim())evaluateRoute();else renderSources();
}
async function openGuidance() {
  closeSheets();$('#scrim').classList.add('open');$('#guidanceSheet').classList.add('open');
  const area=$('#guidanceText') as HTMLTextAreaElement;area.value=guidanceText;
  guidanceProposal=null;guidanceProposalBase=null;renderGuidanceReview();
  await loadGuidance(false);if(area.value===guidanceText)area.value=guidanceText;area.focus();
}
function renderGuidanceReview() {
  const review=$('#guidanceReview');if(!review)return;review.replaceChildren();
  if(guidanceProposal===null)return;
  const label=document.createElement('p');label.className='fine';label.textContent='Proposed change: review the current and proposed guidance before saving.';
  const beforeLabel=document.createElement('strong');beforeLabel.className='fine';beforeLabel.textContent='Current';
  const before=document.createElement('pre');before.className='guidance-preview';before.textContent=guidanceText||'(empty)';
  const afterLabel=document.createElement('strong');afterLabel.className='fine';afterLabel.textContent='Proposed';
  const after=document.createElement('pre');after.className='guidance-preview';after.textContent=guidanceProposal||'(empty)';
  review.append(label,beforeLabel,before,afterLabel,after);const area=$('#guidanceText') as HTMLTextAreaElement;area.value=guidanceProposal;
  const status=$('#guidanceStatus');if(status)status.textContent=`Proposal based on revision ${guidanceProposalBase}; Save guidance to accept.`;
}
async function saveGuidance() {
  if(!host||guidanceSaving)return;const area=$('#guidanceText') as HTMLTextAreaElement,text=area.value;
  if(text.length>16000)return;
  guidanceSaving=true;const button=$('#guidanceSave') as HTMLButtonElement,status=$('#guidanceStatus');button.disabled=true;if(status)status.textContent='Saving…';
  try {
    const response=await host.serviceRequest({method:'POST',path:'/guidance',body:JSON.stringify({revision:guidanceProposalBase??guidanceRevision??0,text})}),body=responseJson(response.body);
    if(response.status===409){if(status)status.textContent='Guidance changed on the server. Your edits are preserved; reload explicitly to replace them.';($('#guidanceReload') as HTMLButtonElement).hidden=false;return;}
    if(response.status<200||response.status>=300||!Number.isInteger(body?.revision)||typeof body?.text!=='string')throw new Error(body?.error||`Save failed (HTTP ${response.status}).`);
    guidanceRevision=body.revision;guidanceText=body.text;guidanceExists=!!body.text;area.value=body.text;guidanceProposal=null;guidanceProposalBase=null;renderGuidanceReview();($('#guidanceReload') as HTMLButtonElement).hidden=true;if(status)status.textContent='Guidance saved in Maxwell.';guidanceChanged();
  }catch(e){if(status)status.textContent=`Save failed; your edits are preserved: ${e instanceof Error?e.message:String(e)}`;}
  finally{guidanceSaving=false;button.disabled=false;paintGuidance();}
}
function autoSizeDraft() {
  const draft=$('#draft') as HTMLTextAreaElement;draft.style.height='auto';draft.style.height=`${Math.min(draft.scrollHeight,224)}px`;
}
function renderManagementProposals() {
  const el=$('#manageResults');if(!el)return;el.innerHTML='';
  const reset=document.createElement('button');reset.type='button';reset.className='ghost-btn';reset.textContent='New conversation';reset.disabled=manageBusy;reset.onclick=()=>{managementConversation=[];proposalResults=[];managementAnswer='';managementMessage='';renderManagementProposals();};el.append(reset);
  const note=document.createElement('p');note.className='fine';note.textContent='Private to Maxwell. This conversation lasts until you reload the Page or start a new one.';el.append(note);
  for(const turn of managementConversation){const entry=document.createElement('div');entry.className='prose';const label=document.createElement('strong');label.textContent=turn.role==='user'?'You':'Maxwell';const content=document.createElement('div');content.innerHTML=DOMPurify.sanitize(marked.parse(turn.text,{async:false}) as string);entry.append(label,content);el.append(entry);}
  if(managementMessage) {const status=document.createElement('p');status.className='fine';status.textContent=managementMessage;el.append(status);}
  proposalResults.forEach((proposal,index)=>{
    const card=document.createElement('div');card.className='proposal';
    const title=document.createElement('strong');
    const detail=document.createElement('p');
    const button=document.createElement('button');button.className='toggle';
    if(proposal.name==='propose_guidance_update') {
      title.textContent='Update private routing guidance';detail.textContent='Review the existing guidance and proposed text. Saving changes only Maxwell service state.';
      button.textContent='Review guidance';button.onclick=()=>{closeSheets();$('#scrim').classList.add('open');$('#guidanceSheet').classList.add('open');guidanceProposal=proposal.arguments.text;guidanceProposalBase=proposal.baseRevision;renderGuidanceReview();};
    } else if(proposal.name==='propose_start_aside') {
      const p=projects.find(x=>x.id===proposal.arguments.projectId);title.textContent=`Start aside: ${proposal.arguments.title}`;
      detail.textContent=`Project: ${p?.name||'Unknown'} · First message: ${proposal.arguments.initialText}`;
      button.textContent='Review aside';button.onclick=()=>{
        const form=$('#asideForm') as HTMLFormElement;
        ($('#asideProject') as HTMLSelectElement).value=proposal.arguments.projectId;
        ($('#asideTitle') as HTMLInputElement).value=proposal.arguments.title;
        ($('#asideText') as HTMLTextAreaElement).value=proposal.arguments.initialText;
        form.classList.add('proposal-review');form.scrollIntoView({behavior:'smooth',block:'nearest'});($('#asideTitle') as HTMLInputElement).focus();
        error='Management proposal filled the aside form. Review and press Start aside to create it.';renderStatus();
      };
    } else {
      const s=sessions.find(x=>x.id===proposal.arguments.sessionId);title.textContent=`Select session: ${s?.title||'Unknown session'}`;
      detail.textContent=`${projects.find(p=>p.id===s?.projectId)?.name||s?.directory||''}. This only selects a route; it does not send.`;
      button.textContent='Choose route';button.onclick=()=>{
        if(!s||!sources.some(x=>sourceKey(x)===sourceKey(s))) { error='That session is not currently selected as a source.';renderStatus();return; }
        selectHumanDestination(sourceKey(s));error='Management proposal selected a destination. Nothing was sent.';renderSources();
      };
    }
    card.append(title,detail,button);el.append(card);
  });
}
async function requestManagement() {
  if(manageBusy)return;
  const form=$('#manageForm') as HTMLFormElement,input=$('#manageText') as HTMLTextAreaElement,text=input.value.trim(),button=form.querySelector<HTMLButtonElement>('button[type="submit"]')!,results=$('#manageResults');
  if(!text){input.focus();return;}
  if(demo||!host){results.textContent='Management inference is unavailable in demo mode.';return;}
  if(managementConversation.length>20||managementConversation.reduce((n,t)=>n+t.text.length,0)>48000){managementMessage='This short conversation is full. Start a new conversation to continue.';renderManagementProposals();return;}
   manageBusy=true;button.disabled=true;button.textContent='Thinking…';managementAnswer='';proposalResults=[];managementMessage='Thinking…';renderManagementProposals();
  try {
    const response=await host.serviceRequest({method:'POST',path:'/manage',body:JSON.stringify({text,conversation:managementConversation,sessions:sources.map(s=>({id:s.id,title:s.title,directory:s.directory,projectId:s.projectId,slot:s.slot})),projects:projects.map(p=>({id:p.id,name:p.name}))})});
    const body=responseJson(response.body);
     if(response.status<200||response.status>=300)throw new Error(body?.error||`Management endpoint returned HTTP ${response.status}.`);
    if(body?.model!=='deepseek-v4-1-flash'||body?.verified!==true||!Array.isArray(body.proposals)||body.proposals.length>4)throw new Error('Management response failed model, attestation, or proposal validation.');
    if(body.text!==undefined&&(typeof body.text!=='string'||body.text.length>16000))throw new Error('Invalid management answer.');
    const checked=body.proposals.map((p:any)=>{
      if(p?.name==='propose_start_aside') {
        const a=p.arguments,project=projects.find(x=>x.id===a?.projectId);
        if(!a||Object.keys(a).sort().join(',')!=='initialText,projectId,title'||!project||typeof a.title!=='string'||!a.title.trim()||a.title.length>120||typeof a.initialText!=='string'||!a.initialText.trim()||a.initialText.length>10000)throw new Error('Aside proposal contained invalid or unregistered values.');
        return {name:p.name,arguments:{projectId:project.id,title:a.title,initialText:a.initialText}};
      }
       if(p?.name==='propose_guidance_update') {
          const a=p.arguments;if(!a||Object.keys(a).sort().join(',')!=='baseRevision,text'||typeof a.text!=='string'||a.text.length>16000||!Number.isInteger(a.baseRevision)||a.baseRevision!==guidanceRevision)throw new Error('Guidance proposal was invalid or based on a stale revision.');
          return {name:p.name,arguments:{text:a.text},baseRevision:a.baseRevision};
       }
       if(p?.name==='propose_select_session') {
        if(!p.arguments||Object.keys(p.arguments).join(',')!=='sessionId')throw new Error('Session proposal contained unexpected arguments.');
        const s=sources.find(x=>x.id===p.arguments.sessionId);
        if(!s)throw new Error('Session proposal was not one of the selected sources.');
        return {name:p.name,arguments:{sessionId:s.id}};
      }
      throw new Error('Management response contained an unsupported proposal.');
    });
     proposalResults=checked;managementAnswer=body.text||'';
     const summaries=checked.map((p:any)=>`Proposed, not executed: ${p.name} ${JSON.stringify(p.arguments)}`).join('\n');
     const answer=[managementAnswer,summaries].filter(Boolean).join('\n\n')||'No response returned.';
     managementConversation.push({role:'user',text},{role:'assistant',text:answer.length>16000?answer.slice(0,15940)+'\n[Proposal detail abbreviated; review the current card.]':answer});
     managementMessage=checked.length?'Review proposed actions below.':'';
    if(input.value.trim()===text)input.value='';
   } catch(e) { proposalResults=[];managementAnswer='';managementMessage=`Maxwell could not answer: ${e instanceof Error?e.message:String(e)}`;renderManagementProposals(); }
  finally {manageBusy=false;button.disabled=false;button.textContent='Ask Maxwell';renderManagementProposals();}
}
function renderConnectionRows() {
  const rows=$('#connRows');if(!rows)return;
  const serviceLabel=serviceState==='Connected'?'running':serviceState.toLowerCase();
  const provider=serviceState==='Connected'?'connected':serviceState==='Unconfigured'?'not configured':serviceState.toLowerCase();
  const router=routerStatus?.verified?'verified':routerStatus?.configured?'configured, not verified':'not configured';
  const model=routerStatus?.routingModel||'decision-large';
  const management=routerStatus?.managementModel||'deepseek-v4-1-flash';
  const row=(tone:string,name:string,state:string,detail:string)=>`<div class="crow"><span class="dot" data-tone="${tone}"></span><b>${esc(name)} <span>${esc(state)}</span></b><p>${esc(detail)}</p></div>`;
  rows.innerHTML=row('success','OpenChamber','sessions grant',`${projects.length} registered projects · ${sessions.length} discovered sessions.`)+row(serviceState==='Connected'?'success':serviceState==='Unavailable'?'error':'warning','Maxwell service',serviceLabel,'Host-managed service, accessed through the OpenChamber proxy.')+row(serviceState==='Connected'?'success':'warning','History and dispatch',provider,'Reads selected sessions and addresses prompts without switching the host session.')+`<hr>${row(routerStatus?.verified?'success':routerStatus?.configured?'warning':'error','Router',`${model} · ${router}`,`Attested Tinfoil decision model. ${routerStatus?.transport||'Configure a regular Tinfoil key file below.'}`)}${routerStatus?.verified?row('success','Launcher',management,'DeepSeek management proposals require separate human acceptance.'):''}`;
  const endpointInput=($('#connectionForm') as HTMLFormElement|null)?.elements.namedItem('endpoint') as HTMLInputElement|null;
  if(endpointInput&&routerStatus?.endpoint&&!endpointInput.value)endpointInput.value=routerStatus.endpoint;
}
async function refreshConnectionRows() {
  const wasConnected=serviceState==='Connected';
  renderConnectionRows();
  if(demo||!host)return;
  const [connectionResult,routerResult]=await Promise.allSettled([
    host.serviceRequest({method:'GET',path:'/connection'}),host.serviceRequest({method:'GET',path:'/router'})
  ]);
  if(connectionResult.status==='fulfilled') {
    try {
      const r=responseJson(connectionResult.value.body);
      if(connectionResult.value.status<200||connectionResult.value.status>=300||typeof r?.connected!=='boolean')throw new Error(r?.error||'Invalid connection response');
      if(r.connected)setServiceState('Connected');
      else setServiceState(r.status==='unconfigured'?'Unconfigured':r.status==='invalid-configuration'?'Invalid configuration':'Unavailable',r.error||'Provider connection is not ready.');
      const endpoint=$('#connectionForm')?.querySelector<HTMLInputElement>('[name="endpoint"]');if(endpoint&&r.endpoint&&!endpoint.value)endpoint.value=r.endpoint;
    }catch(e){setServiceState('Unavailable',String(e));}
  } else setServiceState('Unavailable',`Service request failed: ${connectionResult.reason}`);
  if(routerResult.status==='fulfilled') {
    try { const r=responseJson(routerResult.value.body);if(routerResult.value.status<200||routerResult.value.status>=300)throw new Error(r?.error||`HTTP ${routerResult.value.status}`);routerStatus=r; }
    catch(e){routerStatus={configured:false,verified:false,error:String(e)};}
  } else routerStatus={configured:false,verified:false,error:String(routerResult.reason)};
  const label=$('#connection-label');if(label)label.textContent=serviceState==='Connected'?(routerStatus?.verified?'Live':routerStatus?.configured?'Router starting':'Router setup'):demo?'Demo data':serviceState;
  renderConnectionRows();renderRouteOnly();
  if(wasConnected!==(serviceState==='Connected'))restartUpdates(serviceState==='Connected');
}
async function saveConnection(form:HTMLFormElement) {
  const feedback=$('#connectionFeedback'),button=form.querySelector<HTMLButtonElement>('button[type="submit"]')!,endpoint=form.elements.namedItem('endpoint') as HTMLInputElement,token=form.elements.namedItem('token') as HTMLInputElement;
  if(demo||!host)return;
  button.disabled=true;button.textContent='Saving and testing…';
  try {
    const response=await host.serviceRequest({method:'POST',path:'/connection',body:JSON.stringify({endpoint:endpoint.value.trim(),...(token.value?{token:token.value}:{})})});
    const result=responseJson(response.body);token.value='';
    if(response.status<200||response.status>=300)throw new Error(result?.error||`HTTP ${response.status}`);
    if(typeof result?.connected!=='boolean')throw new Error('Configuration response omitted the actual probe result.');
    if(result.connected){setServiceState('Connected');connectionMessage='';if(feedback)feedback.textContent='Provider connected and tested.';error='';evaluateRoute();}
    else {setServiceState(result.status==='invalid-configuration'?'Invalid configuration':'Unavailable',result.error||'Saved, but provider probe failed.');if(feedback)feedback.textContent=`Saved, but not connected: ${connectionMessage}`;}
    restartUpdates(true);
  } catch(e){token.value='';setServiceState('Unavailable');restartUpdates(true);if(feedback)feedback.textContent=`Connection setup failed: ${e instanceof Error?e.message:String(e)}`;}
  finally{button.disabled=false;button.textContent='Save and test';renderSources();}
}
async function saveRouter(form:HTMLFormElement) {
  const input=form.elements.namedItem('keyFile') as HTMLInputElement,button=form.querySelector<HTMLButtonElement>('button[type="submit"]')!,feedback=$('#connectionFeedback');
  if(demo||!host)return;
  button.disabled=true;button.textContent='Configuring…';
  try {
    const response=await host.serviceRequest({method:'POST',path:'/router',body:JSON.stringify({keyFile:input.value.trim()})}),body=responseJson(response.body);
    if(response.status<200||response.status>=300)throw new Error(body?.error||`HTTP ${response.status}`);
    if(typeof body?.configured!=='boolean')throw new Error('Router configuration response was incomplete.');
    if(feedback)feedback.textContent=body.verified?'Router configured and attestation verified.':body.configured?'Key file configured; attestation is initialized on the next route request.':'Router is not configured.';
    routerStatus=body;await refreshConnectionRows();if(body.configured&&serviceState==='Connected')evaluateRoute();
  }catch(e){if(feedback)feedback.textContent=`Router configuration failed: ${e instanceof Error?e.message:String(e)}`;}
  finally{button.disabled=false;button.textContent='Configure router';renderSources();}
}
function routeIsStale() { return routeText!==((document.querySelector('#draft') as HTMLTextAreaElement|null)?.value); }
function renderStream() {
  const el = $('#feed'); if (!el) return;
  const scroll=$('#stream'), nearBottom=scroll.scrollHeight-scroll.scrollTop-scroll.clientHeight<100;
  const scrollTop=scroll.getBoundingClientRect().top;
  const anchor=[...el.querySelectorAll<HTMLElement>('.msg')].find(node=>node.getBoundingClientRect().bottom>scrollTop);
  const anchorOffset=anchor?anchor.getBoundingClientRect().top-scrollTop:0;
  const visible=messages.filter(m=>sources.some(s=>s.id===m.sessionId&&s.directory===m.directory));
  const empty=$('.empty'); if(empty) empty.style.display=visible.length?'none':'';
  document.body.classList.toggle('is-empty',!visible.length);
  if (!visible.length) { el.replaceChildren(); return; }
  const sorted=[...visible].sort((a,b)=>a.createdAt-b.createdAt||a.id.localeCompare(b.id));
  type Run={key:string;first:Message;items:Message[];source?:Source;project?:Project};
  const runs:Run[]=[];let day='',lastSourceKey='';
  for(let i=0;i<sorted.length;i++) {
    const m=sorted[i],source=sources.find(s=>s.id===m.sessionId&&s.directory===m.directory),key=source?sourceKey(source):messageSessionKey(m),project=projects.find(p=>p.id===source?.projectId);
    if(key!==lastSourceKey) runs.push({key,first:m,items:[],source,project});
    runs[runs.length-1].items.push(m);lastSourceKey=key;
  }
  const desired:HTMLElement[]=[];let shownDay='';
  const createHeader=(run:Run)=>{
    const {first,source,project}=run,d=new Date(first.createdAt),slot=source?.slot,runKey=messageSessionKey(first),canStop=!!source&&(source.activity==='running'||source.activity==='retrying'||pendingResponses.has(runKey))&&!stoppedResponses.has(runKey);
    const section=document.createElement('section');section.className='run';section.dataset.runKey=JSON.stringify([run.key,first.id]);section.dataset.src=String(slot||'');section.dataset.session=first.sessionId;section.dataset.directory=first.directory;
    section.innerHTML=`<header class="run-head"><span class="slotkey ${slot?'':'none'}" ${slot?`data-src="${slot}"`:''}>${slot||''}</span><a class="run-title session-link" href="openchamber://session/${encodeURIComponent(first.sessionId)}?dir=${encodeURIComponent(first.directory)}" title="Open ${esc(source?.title||'session')} in OpenChamber">${esc(source?.title||'Session')}</a><span class="run-meta">${esc(project?.name||first.directory)}</span><span class="run-actions">${canStop?`<button data-action="stop" data-session="${esc(first.sessionId)}" data-directory="${esc(first.directory)}">Stop response</button>`:''}</span><time>${d.toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'})}</time></header><div class="run-messages"></div><footer class="run-footer run-actions"><button data-action="reply" data-project="${esc(source?.projectId||'')}" data-directory="${esc(first.directory)}" data-session="${esc(first.sessionId)}" aria-label="Reply here in ${esc(source?.title||'session')}">Reply here</button></footer>`;
    section.dataset.headerState=JSON.stringify([source?.title,project?.name,slot,source?.activity,canStop]);return section;
  };
  const existingRuns=new Map([...el.querySelectorAll<HTMLElement>('.run')].map(run=>[run.dataset.runKey!,run]));
  const existingDays=new Map([...el.querySelectorAll<HTMLElement>('.day')].map(node=>[node.dataset.renderKey||'',node]));
  for(const run of runs) {
    const label=new Date(run.first.createdAt).toLocaleDateString(undefined,{weekday:'long',month:'long',day:'numeric'});
    if(label!==shownDay) { const dayKey=`day:${label}`,dayNode=existingDays.get(dayKey)||document.createElement('div');dayNode.className='day';dayNode.dataset.renderKey=dayKey;dayNode.textContent=label;desired.push(dayNode);shownDay=label; }
    const stableKey=JSON.stringify([run.key,run.first.id]);
    let section=existingRuns.get(stableKey)||createHeader(run);
    const {source,project,first}=run,slot=source?.slot,runKey=messageSessionKey(first),canStop=!!source&&(source.activity==='running'||source.activity==='retrying'||pendingResponses.has(runKey))&&!stoppedResponses.has(runKey);
    const headerState=JSON.stringify([source?.title,project?.name,slot,source?.activity,canStop]);
    if(section.dataset.headerState!==headerState) {
      const header=section.querySelector('.run-head')!;
      header.innerHTML=`<span class="slotkey ${slot?'':'none'}" ${slot?`data-src="${slot}"`:''}>${slot||''}</span><a class="run-title session-link" href="openchamber://session/${encodeURIComponent(first.sessionId)}?dir=${encodeURIComponent(first.directory)}" title="Open ${esc(source?.title||'session')} in OpenChamber">${esc(source?.title||'Session')}</a><span class="run-meta">${esc(project?.name||first.directory)}</span><span class="run-actions">${canStop?`<button data-action="stop" data-session="${esc(first.sessionId)}" data-directory="${esc(first.directory)}">Stop response</button>`:''}</span><time>${new Date(first.createdAt).toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'})}</time>`;
      section.querySelector('[data-action="reply"]')?.setAttribute('aria-label',`Reply here in ${source?.title||'session'}`);
      section.dataset.headerState=headerState;
    }
    const holder=section.querySelector<HTMLElement>('.run-messages')!,existingMessages=new Map([...holder.querySelectorAll<HTMLElement>('.msg')].map(msg=>[msg.dataset.messageId!,msg])),keepMessages=new Set<string>();
    for(const [messageIndex,message] of run.items.entries()) {
      keepMessages.add(message.id);let article=existingMessages.get(message.id);
      if(!article) { article=document.createElement('article');article.className='msg';article.dataset.messageId=message.id;article.dataset.text=''; }
      const messageState=JSON.stringify([message.role,message.text]);
      if(article.dataset.messageState!==messageState) {
        article.className=`msg ${message.role==='user'?'user':''}`;
        if(message.role==='user')article.innerHTML=`<span class="who">You</span><div class="markdown">${DOMPurify.sanitize(marked.parse(message.text,{async:false}) as string,{ALLOWED_URI_REGEXP:/^(?:(?:https?):|openchamber:\/\/session\/[A-Za-z0-9._~%+-]+(?:\?dir=[A-Za-z0-9._~%+-]*)?$)/i})}</div>`;
        else article.innerHTML=`<div class="markdown">${DOMPurify.sanitize(marked.parse(message.text,{async:false}) as string,{ALLOWED_URI_REGEXP:/^(?:(?:https?):|openchamber:\/\/session\/[A-Za-z0-9._~%+-]+(?:\?dir=[A-Za-z0-9._~%+-]*)?$)/i})}</div>`;
        article.dataset.messageState=messageState;
      }
      if(holder.children[messageIndex]!==article)holder.insertBefore(article,holder.children[messageIndex]||null);
    }
    for(const [id,node] of existingMessages)if(!keepMessages.has(id))node.remove();
    desired.push(section);
  }
  const keepNodes=new Set(desired);for(const child of [...el.children])if(!keepNodes.has(child as HTMLElement))child.remove();
  desired.forEach((node,index)=>{if(el.children[index]!==node)el.insertBefore(node,el.children[index]||null);});
  if(nearBottom)scroll.scrollTop=scroll.scrollHeight;
  else if(anchor?.isConnected)scroll.scrollTop+=anchor.getBoundingClientRect().top-scrollTop-anchorOffset;
}
async function stopResponse(sessionId:string,directory:string,button:HTMLButtonElement) {
  const source=sources.find(s=>s.id===sessionId&&s.directory===directory);if(!source||!host||demo)return;
  button.disabled=true;button.textContent='Stopping…';
  try {
    const response=await host.serviceRequest({method:'POST',path:'/stop',body:JSON.stringify({sessionId,directory})});
    const result=responseJson(response.body);
    if(response.status<200||response.status>=300||!['stopped','idle','stop-requested'].includes(result?.status))throw new Error(result?.error||`Stop outcome is unknown (HTTP ${response.status}).`);
    if(result.status==='stop-requested') error=`Stop requested for ${source.title}. The provider may still be finishing; check its session.`;
    else { stoppedResponses.add(messageKey(source));pendingResponses.delete(messageKey(source));error=`Stopped the response in ${source.title}. Earlier output was not undone.`; }
  } catch(e) { error=`Could not confirm stopping ${source.title}: ${e instanceof Error?e.message:String(e)}. Check that session; it may still be responding.`; }
  renderSources();renderStream();
}
function renderRouteOnly() { updateRouteUI(); }
function updateRouteUI() {
  const el = $('#route'); if (!el) return;
  const current = recommendation && sources.find(s=>sourceKey(s)===recommendation);
  const prev = lastOutgoing ? sources.find(s=>sourceKey(s)===lastOutgoing) : undefined;
  const stale = routeText !== ($('#draft') as HTMLTextAreaElement | null)?.value;
  const visibleCurrent=stale?undefined:current||undefined;
  const draft=(($('#draft') as HTMLTextAreaElement|null)?.value||'').trim();
   let hint=''; let tone='';
   const state=!draft&&!sources.length?'idle':serviceState!=='Connected'&&!demo?'unavailable':stale||recommendationInFlight?'evaluating':!draft?'idle':!visibleCurrent&&routingOutcome!=='abort'?'unavailable':!cooled?'cooling':'settled';
   el.dataset.state=state;
   el.dataset.outcome=stale||recommendationInFlight?'pending':routingOutcome;
   if(draft&&(stale||recommendationInFlight)) hint='Reading draft';
   else if(draft&&!visibleCurrent&&routingOutcome!=='abort') hint=humanSelection?'Routing uncertain.':'Routing uncertain. Choose a destination.';
   else if(draft&&!cooled) hint='Considering destination';
   const selected=humanSelection?sources.find(s=>sourceKey(s)===humanSelection):undefined;
   if(selected&&!hint)hint='Selected by you';
   el.innerHTML=`<span class="hint-text" data-tone="${tone}">${hint}</span>${streamNotice?`<span class="stream-state" role="status">${esc(streamNotice)}</span>`:''}`;
   const sendTarget=selected||prev;
   const selectionReady=!!selected;
   const recommendationReady=!!visibleCurrent&&cooled&&!!prev&&sourceKey(visibleCurrent)===sourceKey(prev);
   const send=$('#send') as HTMLButtonElement; if(send) { send.dataset.slot=String(sendTarget?.slot||''); send.disabled=!draft.trim()||!sendTarget||(!selectionReady&&!recommendationReady)||inFlight||(!demo&&serviceState!=='Connected'); send.textContent=sendTarget?`Send to ${sendTarget.title}`:'Choose destination'; }
   renderDests();
  renderStatus();
}
function renderStatus() {
  const el=$('#status'); if(!el) return;
  const text=statusText(); el.innerHTML='';
  el.hidden=!text&&!demo&&!asideOutcomeUnknown;
  if(demo) { const s=document.createElement('span');s.innerHTML='<b>Illustrative demo.</b> Sessions are fictional; sending is simulated.';el.append(s);const b=document.createElement('button');b.textContent='Connection details';b.onclick=()=>toggleSheet('connSheet');el.append(b); }
  if(text) { const span=document.createElement('span');span.textContent=text;el.append(span); }
  if(pendingDispatch) {
    const retry=document.createElement('button'); retry.className='source-action'; retry.textContent='Retry same request id'; retry.disabled=inFlight; retry.onclick=()=>void retryUncertain();
    el.append(document.createElement('br'),retry);
    if(!uncertainDispatch) el.append(document.createTextNode(' Re-enter the exact draft and select its original destination to retry after reload.'));
    const ack=document.createElement('button'); ack.className='source-action'; ack.textContent='I inspected the original session'; ack.disabled=inFlight;
    ack.setAttribute('aria-label','Acknowledge that you inspected the original session before allowing a new request id');
    ack.onclick=()=>void acknowledgePendingDispatch();
    el.append(document.createTextNode(' '),ack);
  }
  if(asideOutcomeUnknown) {
    const ack=document.createElement('button'); ack.className='source-action'; ack.textContent='I inspected the project; allow another aside'; ack.disabled=asideInFlight;
    ack.onclick=()=>{ asideOutcomeUnknown=false; error='Project inspection acknowledged. You may create another aside.'; renderSources(); };
    el.append(document.createElement('br'),ack);
  }
}
async function acknowledgePendingDispatch() {
  if(inFlight||!pendingDispatch||!pendingRecoveryReady) return;
  try {
    if(!demo) await host?.storage.delete(pendingDispatchStorageKey);
    pendingDispatch=null; uncertainDispatch=null; pendingDispatchDurable=false;
    error='Inspection acknowledged. A new request id is now permitted.'; renderSources();
  } catch(e) { error=`Could not safely clear the pending dispatch record: ${e instanceof Error?e.message:String(e)}. No new request id is allowed.`; renderSources(); }
}
function persist() {
  const value=sources.map(s=>({id:s.id,directory:s.directory,projectId:s.projectId,slot:s.slot}));
  storageQueue=storageQueue.then(async()=>{
    try { if(demo) localStorage.setItem(storageKey,JSON.stringify(value)); else await host?.storage.set(storageKey,value); }
    catch(e) { error=`Could not save source selection: ${e instanceof Error?e.message:String(e)}`; renderSources(); }
  });
  return storageQueue;
}
function getStableSlot() { const used = new Set(sources.map(s=>s.slot)); for(let n=1;n<=9;n++) if(!used.has(n)) return n; return 0; }
function toggleSource(id:string,directory:string,projectId:string) {
  const existing=sources.find(s=>s.id===id&&s.directory===directory&&s.projectId===projectId);
  if(existing) { sources=sources.filter(s=>sourceKey(s)!==sourceKey(existing)); if(humanSelection===sourceKey(existing)){humanSelection=null;selectionVersion++;}if(recommendation===sourceKey(existing)) { recommendation=null; cooled=false; routeStartedAt=0; } }
  else { const session=sessions.find(s=>s.id===id&&s.directory===directory&&s.projectId===projectId); const slot=getStableSlot(); if(!session || !slot) return; sources=[...sources,{...session,slot}]; }
  messages=messages.filter(m=>sources.some(s=>s.id===m.sessionId&&s.directory===m.directory));
  statuses=statuses.filter(st=>sources.some(s=>s.id===st.sessionId&&s.directory===st.directory));
  void persist(); renderSources(); renderStream(); evaluateRoute(); restartUpdates();
}
function chooseSlot(n:number) {
  const source=sources.find(s=>s.slot===n); if(!source) { setError(`Slot ${n} has no selected destination.`); return; }
  selectHumanDestination(sourceKey(source));
}
function selectHumanDestination(key:string) {
  if(!sources.some(s=>sourceKey(s)===key))return;
  humanSelection=key;selectionVersion++;error='';setDestinationChooser(false);renderRouteOnly();renderDests();$('#draft').focus();
}
function clearHumanSelection() {
  if(!humanSelection)return;
  humanSelection=null;selectionVersion++;error='';setDestinationChooser(false);renderRouteOnly();renderDests();$('#draft').focus();
}
function routeExplanationKey(candidateKey:string,recommendationKey:string|null) {
  const draft=($('#draft') as HTMLTextAreaElement|null)?.value||'';
  const candidate=sources.find(s=>sourceKey(s)===candidateKey),recommended=recommendationKey?sources.find(s=>sourceKey(s)===recommendationKey):undefined;
  return JSON.stringify({draft,revision:draftRevision,guidanceRevision,routingOutcome:routeIsStale()?'uncertain':routingOutcome,recovery:routeIsStale()?null:routeRecovery,sessions:sources.map(s=>({id:s.id,title:s.title,directory:s.directory,slot:s.slot,projectId:s.projectId})),lastOutgoing:lastOutgoing?sources.find(s=>sourceKey(s)===lastOutgoing)?.id||null:null,candidate:candidate?.id||null,recommendation:recommended?.id||null,history:messages.map(m=>[m.sessionId,m.directory,m.role,m.text,m.createdAt])});
}
function setExplanationFailure(key:string,text:string) { explanationFailures.set(key,text);while(explanationFailures.size>40)explanationFailures.delete(explanationFailures.keys().next().value!); }
async function explainRoute(candidateKey:string) {
  const candidate=sources.find(s=>sourceKey(s)===candidateKey),draft=($('#draft') as HTMLTextAreaElement|null)?.value||'';
  const recommendationKey=!routeIsStale()?recommendation:null,rec=recommendationKey?sources.find(s=>sourceKey(s)===recommendationKey):undefined;
  if(!candidate||!draft.trim()||candidate===rec)return;
  const contextKey=routeExplanationKey(candidateKey,recommendationKey),cached=explanationCache.get(contextKey);
  if(cached||explainInFlightKey===contextKey)return;
  if(!host||serviceState!=='Connected'||demo) {setExplanationFailure(contextKey,'Advisory explanation is unavailable while the router is disconnected.');renderDests();return;}
  const generation=++explanationGeneration,revision=draftRevision;
  explainInFlightKey=contextKey;renderDests();
  try {
     const response=await host.serviceRequest({method:'POST',path:'/explain-route',body:JSON.stringify({draft,revision,...(guidanceRevision===null?{}:{guidanceRevision}),routingOutcome:routeIsStale()?'uncertain':routingOutcome,recovery:routeIsStale()?null:routeRecovery,sessions:sources.map(s=>({id:s.id,title:s.title,directory:s.directory,slot:s.slot})),lastOutgoing:lastOutgoing?sources.find(s=>sourceKey(s)===lastOutgoing)?.id||null:null,candidateSessionId:candidate.id,recommendationSessionId:rec?.id||null})});
    if(response.status<200||response.status>=300)throw new Error(`HTTP ${response.status}`);
    const result=responseJson(response.body);
     if(guidanceRevision!==null&&result?.guidanceRevision!==guidanceRevision){void loadGuidance(false);throw new Error('Guidance changed; refreshing routing advice.');}
     if(!result||result.revision!==revision||result.candidateSessionId!==candidate.id||result.recommendationSessionId!==(rec?.id||null)||result.model!=='deepseek-v4-1-flash'||result.verified!==true||typeof result.text!=='string'||!result.text.trim()||result.text.length>2000)throw new Error('Invalid advisory response');
    if(generation!==explanationGeneration||routeExplanationKey(candidateKey,recommendationKey)!==contextKey||disposing)return;
    explanationCache.set(contextKey,result.text.trim());
    explanationFailures.delete(contextKey);
    while(explanationCache.size>80)explanationCache.delete(explanationCache.keys().next().value!);
  } catch {
    if(generation===explanationGeneration&&routeExplanationKey(candidateKey,recommendationKey)===contextKey)setExplanationFailure(contextKey,'Advisory explanation unavailable. You can still choose a destination.');
  } finally {
    if(explainInFlightKey===contextKey)explainInFlightKey=null;
    if(generation===explanationGeneration)renderDests();
  }
}
function setError(text:string) { error=text; renderSources(); }
function responseJson(body: unknown): any {
  if(typeof body==='string') { try { return JSON.parse(body); } catch { throw new Error('Service response was not valid JSON.'); } }
  return body;
}
async function probeConnection() {
  try {
    const response=await host!.serviceRequest({method:'GET',path:'/connection'});
    if(response.status<200||response.status>=300) throw new Error(`Connection endpoint returned HTTP ${response.status}.`);
    const result=responseJson(response.body);
    if(typeof result?.connected!=='boolean') throw new Error('Connection endpoint omitted its connected status.');
    if(result.connected) { setServiceState('Connected'); connectionMessage=''; }
    else if(result.status==='invalid-configuration') { setServiceState('Invalid configuration'); connectionMessage='The saved provider connection is invalid. Update it in Connection settings.'; }
    else if(!result.configured) { setServiceState('Unconfigured'); connectionMessage='Configure the OpenChamber HTTP origin and optional client token to load messages and dispatch.'; }
    else { setServiceState('Unavailable'); connectionMessage=`Provider unavailable${result.error?`: ${result.error}`:''}. Check the endpoint/token and probe again.`; }
    renderSources();
    return result;
  } catch(e) {
    setServiceState('Unavailable'); connectionMessage=`Connection probe failed: ${e instanceof Error?e.message:String(e)}`; renderSources(); throw e;
  }
}
async function retryUncertain() {
  if(inFlight||!pendingDispatch||demo) return;
  const source=sources.find(s=>s.id===pendingDispatch?.sessionId&&s.directory===pendingDispatch?.directory);
  const draft=$('#draft') as HTMLTextAreaElement;
  if(!source||routeText!==draft.value) { setError('To retry safely, re-enter the original draft and select its original destination.'); return; }
  const hash=await payloadHash(source.id,source.directory,draft.value);
  if(hash!==pendingDispatch.payloadHash||sourceKey(source)!==pendingDispatch.sourceKey) { setError('The current draft does not match the uncertain payload. It was not retried.'); return; }
  if(humanSelection!==sourceKey(source)) { setError('Select the original destination before retrying the uncertain delivery.'); return; }
  void dispatch();
}
function tokens(s:string) { return (s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu)||[]).filter(x=>!['the','and','for','with','that','this','from','about','into','your','have','what','when','where','could','would','please'].includes(x)); }
function heuristic(text:string):string|null {
  const words=tokens(text); if(!words.length) return null;
  let best: {id:string;score:number}|null=null;
  for(const src of sources) {
    const context=tokens(`${src.title} ${projects.find(p=>p.id===src.projectId)?.name||''} ${src.directory}`);
    const overlap=words.filter(w=>context.includes(w)).length;
    const score=overlap / Math.sqrt(words.length * Math.max(context.length,1));
    const key=sourceKey(src);
    if(overlap && (!best || score>best.score || score===best.score && src.slot < (sources.find(s=>sourceKey(s)===best!.id)?.slot||99))) best={id:key,score};
  }
  return best?.id || null;
}
function evaluateRoute() {
  const text=($('#draft') as HTMLTextAreaElement | null)?.value || ''; draftRevision++;
  const revision=draftRevision; cooled=false; explanationGeneration++;explainInFlightKey=null;recommendationGeneration++;
  if(explanationCache.size>80)explanationCache.clear();
  window.clearTimeout(evalTimer); window.clearTimeout(routeTimer);routerModel='';routerLatency=null;routerConfidence=null;
  evalTimer=window.setTimeout(() => {
    if(revision!==draftRevision) return;
    if(!text.trim()||!sources.length) { setRecommendation(null,text); return; }
    if(demo) setRecommendation(heuristic(text),text);
    else void requestRecommendation(text,revision,recommendationGeneration);
  }, 300);
  renderRouteOnly();
}
async function requestRecommendation(text:string,revision:number,generation:number) {
  if(recommendationInFlight) { recommendationWanted=true; return; }
  if(!host||serviceState!=='Connected'||disposing) { setRecommendation(null,text); error='Live route unavailable. Configure and test the provider connection before sending.'; renderSources(); return; }
  recommendationInFlight=true; recommendationWanted=false;
  try {
     const body={draft:text,revision,...(guidanceRevision===null?{}:{guidanceRevision}),sessions:sources.map(s=>({id:s.id,title:s.title,directory:s.directory,projectId:s.projectId,slot:s.slot}))};
    const response=await host.serviceRequest({method:'POST',path:'/recommend',body:JSON.stringify(body)});
    if(response.status<200||response.status>=300) throw new Error(`Recommendation endpoint returned HTTP ${response.status}.`);
    const result=responseJson(response.body);
     if(guidanceRevision!==null&&result?.guidanceRevision!==guidanceRevision){void loadGuidance(false);throw new Error('Guidance changed; refreshing routing advice.');}
     if(!result||result.revision!==revision||!(result.sessionId===null||typeof result.sessionId==='string')||result.model!=='decision-large'||result.verified!==true) throw new Error('Recommendation response did not match the requested revision or verified model contract.');
    if(generation!==recommendationGeneration||revision!==draftRevision||text!==($('#draft') as HTMLTextAreaElement).value||disposing) return;
    const outcome=result.outcome===undefined?(result.sessionId===null?'uncertain':'destination'):result.outcome;
    if(!['destination','abort','uncertain'].includes(outcome)||(outcome==='destination')!==(result.sessionId!==null))throw new Error('Recommendation outcome and destination were inconsistent.');
    let recovery:RouteRecovery|null=null;
    if(result.recovery!==null&&result.recovery!==undefined) {
      const value=result.recovery;
      if(outcome!=='abort'||typeof value!=='object'||Array.isArray(value))throw new Error('Recovery requires an abort outcome.');
      if(value.action==='revise'&&Object.keys(value).join(',')==='action')recovery={action:'revise'};
      else if(value.action==='reroute'&&Object.keys(value).sort().join(',')==='action,sessionId'&&typeof value.sessionId==='string'&&sources.filter(s=>s.id===value.sessionId).length===1)recovery={action:'reroute',sessionId:value.sessionId};
      else throw new Error('Recovery contained an unsupported action or inactive destination.');
    }
    let target:string|null=null;
    if(result.sessionId!==null) {
      const matches=sources.filter(s=>s.id===result.sessionId&&(!result.directory||s.directory===result.directory)&&(!result.projectId||s.projectId===result.projectId));
      if(matches.length!==1) throw new Error(matches.length?'Recommendation matched multiple selected sessions.':'Recommendation was not a selected source.');
      target=sourceKey(matches[0]);
    }
    setRecommendation(target,text,outcome,recovery);routerModel=result.model;routerLatency=Number.isFinite(result.latencyMs)?result.latencyMs:null;routerConfidence=Number.isFinite(result.confidence)?result.confidence:null;
    routerStatus={...(routerStatus||{}),configured:true,verified:true,routingModel:result.model};error='';renderConnectionRows();
  } catch(e) {
    if(generation===recommendationGeneration&&revision===draftRevision) {
      setRecommendation(null,text); error=`Routing advice unavailable: ${e instanceof Error?e.message:String(e)}.`; renderSources();
    }
  } finally {
    recommendationInFlight=false;
    renderRouteOnly();
    if(recommendationWanted&&!disposing&&!document.hidden) {
      recommendationWanted=false; const draft=$('#draft') as HTMLTextAreaElement;
      void requestRecommendation(draft.value,draftRevision,recommendationGeneration);
    }
  }
}
function setRecommendation(id:string|null,text:string,outcome:RoutingOutcome=id?'destination':'uncertain',recovery:RouteRecovery|null=null) {
  const changed=id!==recommendation||outcome!==routingOutcome||JSON.stringify(recovery)!==JSON.stringify(routeRecovery);
  if(changed) { recommendation=id; cooled=false; routeStartedAt=id||outcome==='abort'?Date.now():0; }
  routingOutcome=outcome;routeRecovery=recovery;
  routeText=text;
  const captured=draftRevision, capturedId=id,capturedOutcome=outcome,capturedRecovery=JSON.stringify(recovery);
  if(id||outcome==='abort') {
    if(Date.now()-routeStartedAt>=1000) { cooled=true; renderRouteOnly(); return; }
    window.clearTimeout(routeTimer);
    routeTimer=window.setTimeout(()=>{
      if(captured===draftRevision && routeText===($('#draft') as HTMLTextAreaElement).value && recommendation===capturedId&&routingOutcome===capturedOutcome&&JSON.stringify(routeRecovery)===capturedRecovery) { cooled=true; renderRouteOnly(); }
    },Math.max(0,1000-(Date.now()-routeStartedAt)));
  } else { window.clearTimeout(routeTimer); cooled=false; }
  renderRouteOnly();
}
function sameTargetCurrent(key:string, text:string, rev:number) { return rev===draftRevision && text===(($('#draft') as HTMLTextAreaElement).value) && key===recommendation && cooled && sources.some(s=>sourceKey(s)===key); }
async function payloadHash(sessionId:string,directory:string,text:string) {
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([sessionId,directory,text])));
  return Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
}
async function persistPendingDispatch(value:PendingDispatch|null) {
  if(demo) return;
  if(value) await host!.storage.set(pendingDispatchStorageKey,value as any);
  else await host!.storage.delete(pendingDispatchStorageKey);
}
async function dispatch() {
  if(inFlight) return;
  if(!demo&&!pendingRecoveryReady) { setError('Dispatch is disabled because the persistent uncertainty ledger could not be read. Reload after storage is available.'); return; }
   const draft=$('#draft') as HTMLTextAreaElement, text=draft.value, rev=draftRevision,submittedSelectionVersion=selectionVersion;
  if(!text.trim()) { setError('Write a message before sending.'); return; }
   const explicitSelection=humanSelection;
   let target=explicitSelection;
   if(!target) {
     target=recommendation;
     if(!target||!sameTargetCurrent(target,text,rev)||!lastOutgoing||lastOutgoing!==target) { setError('Not sent: without a selected destination, the current settled recommendation must match the last successful destination.');return; }
   }
   if(!target||!sources.some(s=>sourceKey(s)===target)) { setError('Not sent: selected destination is no longer available.'); return; }
  if(!demo&&serviceState!=='Connected') { setError('Not sent: provider connection is not verified. Configure and test it first.'); return; }
  const source=sources.find(s=>sourceKey(s)===target)!;
  if(pendingDispatch&&!(pendingDispatch.sessionId===source.id&&pendingDispatch.directory===source.directory)) {
    setError('A previous delivery is unresolved. Retry its exact payload or inspect that original session and acknowledge before sending anything else.'); return;
  }
  inFlight=true; renderRouteOnly(); setError(pendingDispatch?'Retrying the same uncertain request id.':'Preparing a protected dispatch…');
  let requestId='', attempted=false;
  try {
    const hash=await payloadHash(source.id,source.directory,text);
    const retry=!!pendingDispatch && pendingDispatch.sessionId===source.id&&pendingDispatch.directory===source.directory&&pendingDispatch.payloadHash===hash&&pendingDispatch.sourceKey===target;
    if(pendingDispatch&&!retry) throw new Error('This draft differs from the unresolved payload. Inspect the original session and acknowledge before sending a new request.');
    requestId=retry?pendingDispatch!.requestId:`maxwell-${crypto.randomUUID()}`;
    if(!demo) {
      const attempt={requestId,sessionId:source.id,directory:source.directory,sourceKey:target,payloadHash:hash};
      if(!retry||!pendingDispatchDurable) {
        pendingDispatch=attempt; pendingDispatchDurable=false;
        uncertainDispatch={...attempt,text,sourceKey:target,draftRevision:rev};
        await persistPendingDispatch(attempt);
        pendingDispatchDurable=true;
      }
      pendingDispatch=attempt;
      uncertainDispatch={...attempt,text,sourceKey:target,draftRevision:rev};
    }
    let outcome: any;
    if(demo) { attempted=true; outcome={status:'accepted'}; }
    else {
      if(!host) throw new Error('Host SDK is unavailable.');
      attempted=true;
      const response=await host.serviceRequest({method:'POST',path:'/dispatch',body:JSON.stringify({requestId,sessionId:source.id,directory:source.directory,text})});
      if(response.status<200 || response.status>=300) throw new Error(`Dispatch service returned HTTP ${response.status}.`);
      outcome=responseJson(response.body);
      if(!outcome || !['accepted','uncertain'].includes(outcome.status)) throw new Error(outcome?.error || 'Dispatch outcome is unknown.');
    }
    if(outcome.status==='accepted') {
       lastOutgoing=target; pendingResponses.set(messageKey(source),Date.now()); stoppedResponses.delete(messageKey(source));
      if(!demo) {
        pendingDispatch=null; uncertainDispatch=null; pendingDispatchDurable=false;
        try { await persistPendingDispatch(null); }
        catch(e) { pendingDispatch={requestId,sessionId:source.id,directory:source.directory,sourceKey:target,payloadHash:await payloadHash(source.id,source.directory,text)}; pendingDispatchDurable=true; error=`Dispatch was accepted, but its recovery record could not be cleared: ${e instanceof Error?e.message:String(e)}. The same id remains protected.`; }
      }
       if(selectionVersion===submittedSelectionVersion&&humanSelection===explicitSelection&&explicitSelection) {humanSelection=null;selectionVersion++;}
       if(draftRevision===rev && draft.value===text) { draft.value=''; evaluateRoute(); }
      if(!error.includes('recovery record could not be cleared')) error=demo?'Demo only: no message was sent.':'Dispatch accepted by the upstream API.';
      renderSources(); renderStream();
    } else {
      error=`Delivery is uncertain: ${outcome.error||'inspect the original session before deciding what to do'}`;
    }
  } catch(e) {
    if(attempted) error=`Delivery is uncertain: ${e instanceof Error?e.message:String(e)}. Retry will reuse request id ${requestId}. Inspect the original session before authorizing a new request id.`;
    else if(pendingDispatch) error=`The request was not sent because recovery could not be confirmed: ${e instanceof Error?e.message:String(e)}. Retry may reuse ${pendingDispatch.requestId}; do not issue a different request until resolved.`;
    else error=`Dispatch was not sent because its recovery record could not be prepared: ${e instanceof Error?e.message:String(e)}.`;
  }
  finally { inFlight=false; renderRouteOnly(); renderSources(); }
}
async function createAsideFromForm() {
  if(asideInFlight)return;
  if(asideOutcomeUnknown){setError('A previous aside creation had an unknown outcome. Inspect the project before explicitly allowing another creation.');return;}
  const form=$('#asideForm') as HTMLFormElement, projectId=($('#asideProject') as HTMLSelectElement).value, title=($('#asideTitle') as HTMLInputElement).value.trim(), text=($('#asideText') as HTMLTextAreaElement).value.trim(), button=$('#asideGo') as HTMLButtonElement;
  if(!projects.some(p=>p.id===projectId)){setError('Choose a registered project for the aside.');return;}
  if(!title){($('#asideTitle') as HTMLInputElement).focus();return;}
  if(text.length>10000){setError('The initial message is too long.');return;}
  button.disabled=true;button.textContent='Creating…';asideInFlight=true;
  try {
    if(demo){const p=projects.find(x=>x.id===projectId)!;const s={id:`demo-${Date.now()}`,title,projectId,directory:p.directory,createdAt:Date.now()};sessions=[s,...sessions];addSource(s);error='Demo only: aside created locally, no host session exists.';}
    else {
      if(!host)throw new Error('Host SDK is unavailable.');
      const result=await host.startSession({projectId,providerId:'maxwell',id:`aside-${crypto.randomUUID()}`,title,url:'',text:text||undefined,navigation:'preserve'});
      if(!result.sessionId)throw new Error(`Host did not create a session (${('failure'in result)?result.failure:'unknown failure'}).`);
      const sourceSession=sessions.find(s=>s.id===result.sessionId)||{id:result.sessionId,title,projectId,directory:result.directory||projects.find(p=>p.id===projectId)!.directory,createdAt:Date.now()};
      sessions=[sourceSession,...sessions.filter(s=>s.id!==sourceSession.id)];addSource(sourceSession);
       error=result.sent==='failed'?'Session created, but the initial message failed.':result.sent==='no-model'?'Session created, but no model was available for the initial message.':result.sent==='skipped'?'Session created, but initial message was skipped.':'Aside created. Navigation stayed on Maxwell.';
    }
     form.reset();form.classList.remove('proposal-review');proposalResults=[];closeSheets();renderSources();renderStream();restartUpdates();
  } catch(err){asideOutcomeUnknown=true;setError(`Aside creation outcome is unknown: ${err instanceof Error?err.message:String(err)}. Inspect the project before attempting another creation.`);button.textContent='Outcome unknown';}
  finally{asideInFlight=false;if(!asideOutcomeUnknown){button.disabled=false;button.textContent='Start aside';}}
}
function addSource(s:Session) { if(sources.some(x=>sourceKey(x)===sourceKey(s))) return; const slot=getStableSlot(); if(slot) sources=[...sources,{...s,slot}]; void persist(); }
type UpdateResponse={cursor:string|null;changed:boolean;mode:'events'|'polling';streamStatus:string;messages:Message[];statuses:SourceStatus[];reset?:boolean};
function updateSelectionKey(selected:Source[]) { return selected.map(sourceKey).sort().join('\u0001'); }
function isCurrentUpdate(gen:number,selection:string) { return gen===updateGeneration&&selection===updateSelectionKey(sources)&&serviceState==='Connected'&&!document.hidden&&!disposing; }
function validSnapshot(body:any):body is {messages:Message[];statuses:SourceStatus[]} {
  return !!body&&Array.isArray(body.messages)&&Array.isArray(body.statuses)
    &&body.messages.every((m:any)=>m&&typeof m.id==='string'&&typeof m.sessionId==='string'&&typeof m.directory==='string'&&typeof m.text==='string'&&Number.isFinite(Number(m.createdAt)))
    &&body.statuses.every((s:any)=>s&&typeof s.sessionId==='string'&&typeof s.directory==='string'&&typeof s.status==='string');
}
function applyCompleteSnapshot(body:{messages:Message[];statuses:SourceStatus[]},selected:Source[]) {
  const scope=new Set(selected.map(messageKey)),goodStatuses=body.statuses.filter(s=>scope.has(statusKey(s)));
  const failed=new Set(goodStatuses.filter(s=>s.status==='error').map(statusKey));
  const oldFailed=messages.filter(m=>failed.has(messageSessionKey(m)));
  const received=body.messages.filter(m=>scope.has(messageSessionKey(m))).map(m=>({...m,createdAt:Number(m.createdAt)}));
  const byIdentity=new Map<string,Message>();
  for(const m of [...oldFailed,...received])byIdentity.set(`${messageSessionKey(m)}\u0000${m.id}`,m);
  messages=[...byIdentity.values()];statuses=goodStatuses;
  for(const m of received)if(m.role==='assistant'){const sentAt=pendingResponses.get(messageSessionKey(m));if(sentAt&&m.createdAt>=sentAt)pendingResponses.delete(messageSessionKey(m));}
  renderStream();renderSources();
}
function waitForUpdate(ms:number) {
  return new Promise<void>(resolve=>{
    let done=false;const finish=()=>{if(done)return;done=true;clearTimeout(timer);if(updateWake===finish)updateWake=null;resolve();};
    const timer=window.setTimeout(finish,ms);updateWake=finish;
  });
}
function setStreamNotice(value:string) { if(streamNotice===value)return;streamNotice=value;renderRouteOnly(); }
function restartUpdates(clearContext=false) {
  updateGeneration++;updateCursor=null;updateWake?.();
  if(clearContext){messages=[];statuses=[];setStreamNotice('');renderStream();}
  if(!sources.length) {setStreamNotice('');return;}
  if(!demo&&serviceState==='Connected'&&!document.hidden&&!disposing)void runUpdates(updateGeneration);
}
async function fetchPollingSnapshot(gen:number,selection:string,selected:Source[]) {
  if(!host||!isCurrentUpdate(gen,selection)||!selected.length)return false;
  try {
    const response=await host.serviceRequest({method:'POST',path:'/messages',body:JSON.stringify({sessions:selected.map(s=>({id:s.id,directory:s.directory,projectId:s.projectId}))})});
    if(!isCurrentUpdate(gen,selection))return false;
    if(response.status<200||response.status>=300)throw new Error(`HTTP ${response.status}`);
    const body=responseJson(response.body);if(!validSnapshot(body))throw new Error('Invalid messages snapshot');
    applyCompleteSnapshot(body,selected);return true;
  } catch { if(isCurrentUpdate(gen,selection))setStreamNotice('Polling fallback: message refresh unavailable');return false; }
}
async function runUpdates(gen:number) {
  if(updateLoopBusy||!host||demo||serviceState!=='Connected'||document.hidden||disposing||!sources.length)return;
  updateLoopBusy=true;let delay=1000,nextPollAt=0;
  try {
    while(gen===updateGeneration&&serviceState==='Connected'&&!document.hidden&&!disposing&&sources.length) {
      const selected=[...sources],selection=updateSelectionKey(selected);
      if(!selected.length)break;
      try {
        const requestStarted=Date.now();
        const response=await host.serviceRequest({method:'POST',path:'/updates',body:JSON.stringify({sessions:selected.map(s=>({id:s.id,directory:s.directory,projectId:s.projectId})),cursor:updateCursor})});
        if(!isCurrentUpdate(gen,selection))break;
        if(response.status<200||response.status>=300)throw new Error(`Updates endpoint returned HTTP ${response.status}`);
        const body=responseJson(response.body) as UpdateResponse;
        if(!body||typeof body.changed!=='boolean'||!['events','polling'].includes(body.mode)||typeof body.streamStatus!=='string'||!(body.cursor===null||typeof body.cursor==='string')||!Array.isArray(body.messages)||!Array.isArray(body.statuses))throw new Error('Invalid updates response');
        if(body.changed&&!validSnapshot(body))throw new Error('Invalid update snapshot');
        updateCursor=body.cursor;
        if(body.reset){updateCursor=null;messages=[];statuses=[];renderStream();}
        if(body.mode==='events') {
          setStreamNotice('');nextPollAt=0;delay=1000;
          if(body.changed)applyCompleteSnapshot(body,selected);
          else if(Date.now()-requestStarted<250)await waitForUpdate(250-(Date.now()-requestStarted));
        } else {
          setStreamNotice(`Polling fallback: ${body.streamStatus}`);
          if(Date.now()>=nextPollAt){await fetchPollingSnapshot(gen,selection,selected);if(gen!==updateGeneration)break;nextPollAt=Date.now()+5000;}
          await waitForUpdate(delay);delay=Math.min(delay*2,30000);
        }
      } catch {
        if(!isCurrentUpdate(gen,updateSelectionKey(sources)))break;
        setStreamNotice('Polling fallback: live updates unavailable');
        if(Date.now()>=nextPollAt){const selected=[...sources],selection=updateSelectionKey(selected);await fetchPollingSnapshot(gen,selection,selected);if(gen!==updateGeneration)break;nextPollAt=Date.now()+5000;}
        if(gen!==updateGeneration)break;
        await waitForUpdate(delay);delay=Math.min(delay*2,30000);
      }
    }
  } finally {
    updateLoopBusy=false;
    if(updateWake)updateWake();
    if(gen!==updateGeneration&&serviceState==='Connected'&&!document.hidden&&!disposing&&sources.length)void runUpdates(updateGeneration);
  }
}
async function restoreSources() {
  let saved:any;
  try { saved=demo?JSON.parse(localStorage.getItem(storageKey)||'[]'):await host?.storage.get(storageKey); } catch { saved=[]; }
  if(!Array.isArray(saved)) saved=[];
  for(const entry of saved) {
    if(!entry||typeof entry.id!=='string'||typeof entry.directory!=='string'||typeof entry.projectId!=='string'||!Number.isInteger(entry.slot)||entry.slot<1||entry.slot>9) continue;
    const s=sessions.find(x=>x.id===entry.id&&x.directory===entry.directory&&x.projectId===entry.projectId);
    if(s&&!sources.some(x=>sourceKey(x)===sourceKey(s))&&!sources.some(x=>x.slot===entry.slot)) sources.push({...s,slot:entry.slot});
  }
  if(demo) pendingRecoveryReady=true;
  else {
    try {
      const value=await host?.storage.get(pendingDispatchStorageKey);
      if(value!==undefined) {
        if(!value||typeof value!=='object'||Array.isArray(value)) throw new Error('Stored dispatch recovery record is malformed.');
        const record=value as any;
        if(typeof record.requestId==='string'&&/^[a-zA-Z0-9_-]{1,160}$/.test(record.requestId)&&typeof record.sessionId==='string'&&typeof record.directory==='string'&&typeof record.sourceKey==='string'&&typeof record.payloadHash==='string'&&/^[a-f0-9]{64}$/.test(record.payloadHash)) { pendingDispatch=record as PendingDispatch; pendingDispatchDurable=true; }
        else throw new Error('Stored dispatch recovery record is malformed.');
      }
      pendingRecoveryReady=true;
    } catch(e) {
      pendingRecoveryReady=false;
      error=`Could not read pending dispatch recovery state: ${e instanceof Error?e.message:String(e)}`;
    }
  }
  renderSources(); renderStream();
}
async function initLive() {
  try {
    host=connectHost();
    void loadGuidance(false);
    unsubscribers.push(host.onReady(context=>applyHostReady(context,document.documentElement)));
    // SDK subscriptions are the authority for discovery; service calls only provide message contents and addressed dispatch.
    const ps=await host.listProjects(); if(ps.state==='error') throw new Error('Project discovery failed.'); projects=ps.projects;
    const snapshots=await Promise.all(projects.map(p=>host!.listSessions(p.id)));
    sessions=snapshots.flatMap(s=>s.sessions).map(s=>({...s,id:s.id,title:s.title,projectId:s.projectId,directory:s.directory,createdAt:s.createdAt}));
    await restoreSources();
    renderSources(); renderStream();
    for(const p of projects) await subscribeProject(p);
    const removeProjects=await host.onProjects(snapshot=>{
      if(snapshot.state!=='ready') return;
      projects=snapshot.projects;
      const active=new Set(projects.map(p=>p.id));
      for(const [projectId,off] of sessionUnsubscribers) if(!active.has(projectId)) { off(); sessionUnsubscribers.delete(projectId); subscribedProjects.delete(projectId); }
      for(const p of projects) void subscribeProject(p);
      renderSources();
    });
    if(disposing) removeProjects(); else unsubscribers.push(removeProjects);
    setServiceState('Checking connection');
    try { await probeConnection(); if(serviceState==='Connected') restartUpdates(); }
    catch { /* probeConnection provides the actionable state */ }
  } catch(e) { setServiceState('Unavailable'); connectionMessage=`Host discovery unavailable: ${e instanceof Error?e.message:String(e)}`; renderSources(); }
}
const subscribedProjects=new Set<string>();
const sessionUnsubscribers=new Map<string,()=>void>();
async function subscribeProject(project:Project) {
  if(!host||disposing||subscribedProjects.has(project.id)) return;
  subscribedProjects.add(project.id);
  try {
    const off=await host.onSessions(project.id,snapshot=>{
      if(snapshot.state!=='ready') return;
      const next=snapshot.sessions.map(s=>({...s,id:s.id,title:s.title,projectId:s.projectId,directory:s.directory,createdAt:s.createdAt}));
      sessions=[...sessions.filter(s=>s.projectId!==project.id),...next];
       let sourceTitleChanged=false;
      sources=sources.map(old=>{
        const current=next.find(s=>sourceKey(s)===sourceKey(old));
         if(!current||(current.title===old.title&&current.activity===old.activity)) return old;
         if(current.title!==old.title) sourceTitleChanged=true;
         return {...current,slot:old.slot};
      });
       if(sourceTitleChanged) evaluateRoute();
      renderSources();
    });
    if(disposing||!projects.some(p=>p.id===project.id)) off();
    else { sessionUnsubscribers.set(project.id,off); unsubscribers.push(off); }
  } catch(e) { subscribedProjects.delete(project.id); error=`Could not subscribe to ${project.name}: ${e instanceof Error?e.message:String(e)}`; renderSources(); }
}
function bootDemo() {
  serviceState='Demo'; projects=[{id:'proj-1',name:'Maxwell studio',directory:'/demo/maxwell'},{id:'proj-2',name:'Field notes',directory:'/demo/field-notes'}];
  sessions=[{id:'s-1',title:'Maxwell routing design',projectId:'proj-1',directory:'/demo/maxwell',createdAt:Date.now()-50000},{id:'s-2',title:'Field notes on archives',projectId:'proj-2',directory:'/demo/field-notes',createdAt:Date.now()-40000},{id:'s-3',title:'CSS layout experiments',projectId:'proj-1',directory:'/demo/maxwell',createdAt:Date.now()-30000}];
  try { const saved=JSON.parse(localStorage.getItem(storageKey)||'[]'); for(const entry of saved) { const s=sessions.find(x=>x.id===entry.id); if(s&&Number.isInteger(entry.slot)&&entry.slot>0&&entry.slot<=9) sources.push({...s,slot:entry.slot}); } } catch {}
  if(!sources.length) sources=sessions.map((s,i)=>({...s,slot:i+1}));
  messages=[{id:'m1',sessionId:'s-2',directory:sessions[1].directory,role:'user',text:'I want the archive to preserve the relationships between notes, not only their dates.',createdAt:Date.now()-220000},{id:'m2',sessionId:'s-2',directory:sessions[1].directory,role:'assistant',text:'Then chronology can be one view among several. Let links remain first-class.',createdAt:Date.now()-210000},{id:'m3',sessionId:'s-1',directory:sessions[0].directory,role:'user',text:'The routing rule should fail closed when a recommendation is still changing.',createdAt:Date.now()-120000},{id:'m4',sessionId:'s-1',directory:sessions[0].directory,role:'assistant',text:'Agreed. A destination must be stable for the draft, and Enter should require agreement with the last successful destination.',createdAt:Date.now()-110000},{id:'m5',sessionId:'s-3',directory:sessions[2].directory,role:'assistant',text:'The stream should remain readable on narrow widths without hiding the composer.',createdAt:Date.now()-45000}];
   shell();renderSources(); renderStream();
}
if(demo) bootDemo(); else { shell(); void initLive(); }
document.addEventListener('visibilitychange',()=>{
  if(document.hidden) { updateGeneration++;updateCursor=null;updateWake?.(); }
  else if(!demo) restartUpdates();
});
window.addEventListener('pagehide',()=>{
  disposing=true;updateGeneration++;updateWake?.();window.clearTimeout(evalTimer);window.clearTimeout(routeTimer);
  for(const off of unsubscribers.splice(0)) { try { off(); } catch {} }
  sessionUnsubscribers.clear(); subscribedProjects.clear();
});
window.addEventListener('keydown',e=>{
  if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k') { e.preventDefault();toggleSheet('picker');return; }
  if(e.target instanceof HTMLTextAreaElement||e.target instanceof HTMLInputElement||e.target instanceof HTMLSelectElement) return;
  if((e.ctrlKey||e.metaKey)&&/^[1-9]$/.test(e.key)) { e.preventDefault(); chooseSlot(Number(e.key)); }
  if(e.key==='Escape')closeSheets();
});
