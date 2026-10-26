import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Tests the real Page code with an explicit fake host, never a user's sessions.
export async function browserHarness() {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const bundle = await build({
    absWorkingDir: root, entryPoints: ['panel/main.ts'], bundle: true,
    format: 'iife', platform: 'browser', write: false,
    plugins: [{ name: 'synthetic-host', setup(b) {
      b.onResolve({ filter: /^@openchamber\/sdk$/ }, () => ({ path: 'host', namespace: 'fixture' }));
      b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const connectHost = () => window.__host;', loader: 'js' }));
    } }],
  });
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path.endsWith('main.js')) { res.setHeader('content-type', 'text/javascript'); res.end(bundle.outputFiles[0].text); }
    else if (path.endsWith('styles.css')) { res.setHeader('content-type', 'text/css'); res.end(await readFile(new URL('../panel/styles.css', import.meta.url))); }
    else { res.setHeader('content-type', 'text/html'); res.end(await readFile(new URL('../panel/index.html', import.meta.url))); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  const baseURL = `http://127.0.0.1:${server.address().port}`;
  return {
    browser, baseURL,
    async page(options = {}) {
      const page = await browser.newPage({ viewport: { width: 1100, height: 820 } });
      await page.addInitScript(({ connected, outcome, delay }) => {
        const projects = [{ id: 'fixture-project', name: 'Synthetic studio', directory: '/fixture/studio' }];
        const sessions = [
          { id: 'fixture-ops', title: 'Sensitive ops', projectId: projects[0].id, directory: projects[0].directory, createdAt: 1 },
          { id: 'fixture-course', title: 'Course webpage', projectId: projects[0].id, directory: projects[0].directory, createdAt: 2 },
        ];
        const store = {}, sessionListeners = [], updateWaiters = new Set();
        let updateVersion = 0;
        const state = window.__fixture = { connected, outcome, delay, guidance: { revision: 0, text: '' }, calls: [], creates: [], sent: [], stopped: [], opened: [], messages: [
          { id: 'fixture-m1', sessionId: sessions[0].id, directory: projects[0].directory, role: 'assistant', text: 'Synthetic ops exchange.', createdAt: 1000 },
          { id: 'fixture-m2', sessionId: sessions[1].id, directory: projects[0].directory, role: 'assistant', text: 'Synthetic course exchange.', createdAt: 2000 },
        ] };
        state.bump = () => { updateVersion++; for (const wake of updateWaiters) wake(); };
        const reply = body => ({ status: 200, body: JSON.stringify(body) });
        window.__host = {
          onReady: () => () => {}, onDirectory: () => () => {}, onSession: () => () => {},
          openSession: async id => { state.opened.push(id); },
          listProjects: async () => ({ kind: 'projects', state: 'ready', projects }),
          listSessions: async () => ({ kind: 'sessions', state: 'ready', sessions }),
          onProjects: async () => () => {}, onSessions: async (_projectId, listener) => { sessionListeners.push(listener); return () => {}; }, dispose() {},
          storage: { get: async key => store[key], set: async (key, value) => { store[key] = value; }, delete: async key => { delete store[key]; } },
          serviceRequest: async req => {
            const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
            state.calls.push({ ...req, body });
            if (req.path === '/connection') return reply({ connected: state.connected, configured: state.connected, status: state.connected ? 'connected' : 'unconfigured' });
            if (req.path === '/guidance') {
              if (req.method === 'POST' || req.method === 'PUT') {
                if (body.revision !== state.guidance.revision) return { status: 409, body: '{"error":"Guidance changed in another window"}' };
                state.guidance = { revision: state.guidance.revision + 1, text: body.text };
              }
              return reply(state.guidance);
            }
            if (req.path === '/messages') return reply({ messages: state.messages.filter(m => body.sessions.some(s => s.id === m.sessionId)), statuses: body.sessions.map(s => ({ sessionId: s.id, directory: s.directory, status: 'ok' })) });
            if (req.path === '/updates') {
              if (body.cursor === String(updateVersion)) await new Promise(resolve => {
                let timer;
                const wake = () => { clearTimeout(timer); updateWaiters.delete(wake); resolve(); };
                updateWaiters.add(wake); timer = setTimeout(wake, 1000);
              });
              const changed = body.cursor !== String(updateVersion);
              return reply({ cursor: String(updateVersion), changed, mode: 'events', streamStatus: 'connected', messages: changed ? state.messages.filter(m => body.sessions.some(s => s.id === m.sessionId && s.directory === m.directory)) : [], statuses: body.sessions.map(s => ({ sessionId: s.id, directory: s.directory, status: 'ok' })) });
            }
            // Synthetic response exercising the required production envelope.
            if (req.path === '/recommend') return state.recommendationUnavailable ? { status: 503, body: '{"error":"Synthetic router unavailable"}' } : reply({ revision: body.revision, guidanceRevision: state.guidance.revision, sessionId: /course/i.test(body.draft) ? 'fixture-course' : /ops/i.test(body.draft) ? 'fixture-ops' : null, model: 'decision-large', verified: true, latencyMs: 0, ...(state.routingOverride||{}) });
            if (req.path === '/explain-route') {
              state.lastExplanation=body;
              return reply({ revision: body.revision, guidanceRevision: state.guidance.revision, candidateSessionId: body.candidateSessionId, recommendationSessionId: body.recommendationSessionId, text: body.routingOutcome==='abort' ? 'Review this draft before sending. Consider revising it or choosing the suggested conversation.' : 'This draft refers to the course webpage, while the ops session concerns deployment. You can still choose ops if that is your intent.', model: 'deepseek-v4-1-flash', verified: true, latencyMs: 0 });
            }
            if (req.path === '/router') return reply({ configured: true, routingModel: 'decision-large', managementModel: 'deepseek-v4-1-flash', verified: true, transport: 'attested-ehbp' });
            if (req.path === '/manage') {
              state.lastManagement = body;
              return reply({ model: 'deepseek-v4-1-flash', guidanceRevision: state.guidance.revision, verified: true, latencyMs: 0, text: /tools/i.test(body.text) ? 'I can **propose an aside** or select a session. These actions require your acceptance.' : '', proposals: /tools/i.test(body.text) ? [] : /guidance|remember/i.test(body.text) ? [{ name: 'propose_guidance_update', arguments: { text: 'Private synthetic student information belongs in the course session.', baseRevision: state.guidance.revision } }] : [{ name: 'propose_start_aside', arguments: { projectId: projects[0].id, title: 'Synthetic aside', initialText: 'A synthetic initial message.' } }] });
            }
            if (req.path === '/stop') {
              state.stopped.push(body);
              const session = sessions.find(s => s.id === body.sessionId);
              if (session) session.activity = 'idle';
              sessionListeners.forEach(fn => fn({ state: 'ready', sessions }));
              state.bump();
              return reply({ ...body, status: 'stopped' });
            }
            if (req.path === '/dispatch') {
              state.sent.push(body);
              if (state.delay) await new Promise(r => setTimeout(r, state.delay));
              const session = sessions.find(s => s.id === body.sessionId);
              if (session) session.activity = 'running';
              sessionListeners.forEach(fn => fn({ state: 'ready', sessions }));
              state.bump();
              return reply({ requestId: body.requestId, sessionId: body.sessionId, directory: body.directory, status: state.outcome });
            }
            return { status: 404, body: '{}' };
          },
          startSession: async req => {
            state.creates.push(req);
            return { sessionId: 'fixture-aside', directory: projects[0].directory, sent: req.text ? 'sent' : 'skipped', linked: true };
          },
        };
      }, { connected: true, outcome: 'accepted', delay: 0, ...options });
      await page.goto(baseURL);
      return page;
    },
    async close() { await browser.close(); await new Promise(resolve => server.close(resolve)); },
  };
}
