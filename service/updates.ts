import { createHash, randomUUID } from 'node:crypto';

type Connection = { endpoint: string; token?: string };
type Session = { id: string; directory: string };
type Snapshot = { messages: any[]; statuses: any[] };
type LiveText = {
  id: string; sessionId: string; directory: string; createdAt: number;
  blocks: Map<number, string>; ended: boolean; gap: boolean;
};
type Watch = {
  sessions: Session[]; touched: number; active: number; revision: number;
  dirty: Set<string>; snapshot: Snapshot; pending?: ReturnType<typeof setTimeout>;
  fetching: boolean; ready: boolean; listeners: Set<() => void>;
  live: Map<string, LiveText>; publish?: ReturnType<typeof setTimeout>;
};
const key = (s: Session) => JSON.stringify([s.id, s.directory]);

// SSE is volatile, not a replay log. Keep only selected bounded snapshots and
// re-read them on every connection, including reconnections after missed events.
export function createUpdates(options: {
  fetch: typeof fetch;
  history: (sessions: Session[], connection: Connection, signal: AbortSignal) => Promise<Snapshot>;
  timing?: { pollMs?: number; idleMs?: number; coalesceMs?: number; reconnectMs?: number };
}) {
  const pollMs = Math.min(options.timing?.pollMs ?? 12000, 12000);
  const idleMs = options.timing?.idleMs ?? 30000;
  const coalesceMs = options.timing?.coalesceMs ?? 150;
  const retryMs = options.timing?.reconnectMs ?? 1000;
  let connection: Connection | undefined;
  let generation = randomUUID();
  let status = 'idle';
  let controller: AbortController | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  let closed = false;
  const watches = new Map<string, Watch>();
  const wake = (w: Watch) => { for (const listener of [...w.listeners]) listener(); };
  const wakeAll = () => { for (const w of watches.values()) wake(w); };
  const liveKey = (session: Session, messageId: string) => JSON.stringify([session.id, session.directory, messageId]);
  const liveText = (live: LiveText) => [...live.blocks].sort(([a], [b]) => a - b).map(([, text]) => text).join('\n');
  function rendered(w: Watch): Snapshot {
    const messages = new Map(w.snapshot.messages.map(m => [JSON.stringify([m.sessionId, m.directory, m.id]), m]));
    for (const [id, live] of w.live) messages.set(id, { id: live.id, sessionId: live.sessionId, directory: live.directory, role: 'assistant', createdAt: live.createdAt, text: liveText(live) });
    return { messages: [...messages.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)), statuses: w.snapshot.statuses };
  }
  function publish(w: Watch) {
    if (w.publish) return;
    w.publish = setTimeout(() => {
      w.publish = undefined;
      w.revision++;
      wake(w);
    }, coalesceMs);
  }

  function schedule(w: Watch) {
    if (w.pending || w.fetching || !w.dirty.size || status !== 'connected' || !connection) return;
    w.pending = setTimeout(async () => {
      w.pending = undefined;
      if (status !== 'connected' || !controller || !connection) return;
      w.fetching = true;
      const selected = w.sessions.filter(s => w.dirty.has(key(s)));
      w.dirty.clear();
      const epoch = generation;
      const target = connection!;
      const source = controller;
      try {
        const snapshot = await options.history(selected, target, AbortSignal.any([source.signal, AbortSignal.timeout(5000)]));
        if (epoch !== generation || controller !== source || closed || ![...watches.values()].includes(w)) return;
        const changed = new Set(selected.map(key));
        const retain = (item: any) => !changed.has(JSON.stringify([item.sessionId, item.directory]));
        const next = {
          messages: [...w.snapshot.messages.filter(retain), ...snapshot.messages].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)),
          statuses: [...w.snapshot.statuses.filter(retain), ...snapshot.statuses],
        };
        if (Buffer.byteLength(JSON.stringify(next)) > 2097152) throw new Error('Selected snapshot exceeds cache limit');
        w.snapshot = next;
        if (Buffer.byteLength(JSON.stringify(rendered(w))) > 2097152) { w.live.clear(); throw new Error('Selected live snapshot exceeds cache limit'); }
        for (const [id, live] of w.live) {
          const authoritative = next.messages.find(m => m.id === live.id && m.sessionId === live.sessionId && m.directory === live.directory);
          // An in-flight history read may still be the empty committed assistant
          // shell. Only retire an ended overlay once its full text is committed.
          if (live.ended && authoritative && (authoritative.text === liveText(live) || (live.gap && authoritative.text.length >= liveText(live).length))) w.live.delete(id);
        }
        w.revision++;
        w.ready = true;
        wake(w);
      } catch {
        if (epoch === generation && controller === source && !closed) {
          w.snapshot = { messages: [], statuses: w.sessions.map(s => ({ sessionId: s.id, directory: s.directory, status: 'error', error: 'Selected-session history unavailable' })) };
          w.revision++;
          w.ready = true;
          wake(w);
        }
      } finally {
        w.fetching = false;
        schedule(w);
      }
    }, coalesceMs);
  }
  function invalidateAll() {
    for (const w of watches.values()) {
      w.ready = false;
      // Preserve the known prefix across reconnects, but do not concatenate a
      // tail after missed deltas. A full text.ended block or committed ended-step
      // snapshot repairs the gap. Configuration changes discard the whole watch.
      for (const live of w.live.values()) live.gap = true;
      for (const session of w.sessions) w.dirty.add(key(session));
      schedule(w);
    }
  }
  function event(frame: string) {
    const lines = frame.split('\n');
    if (lines.some(l => l === 'event: effect/http-api/stream/failure')) throw new Error('Event stream failed');
    const data = lines.filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
    if (!data) return;
    const value = JSON.parse(data);
    if (typeof value.type !== 'string') throw new Error('Invalid event envelope');
    if (!value.type.startsWith('session.') || typeof value.data?.sessionID !== 'string') return;
    for (const w of watches.values()) {
      for (const s of w.sessions) {
        if (s.id !== value.data.sessionID || (value.location?.directory !== undefined && value.location.directory !== s.directory)) continue;
        const data = value.data;
        const isText = value.type.startsWith('session.text.');
        // Content-bearing events must carry the verified location. Location-less
        // activity is only an invalidation, never permission to expose content.
        if (value.location?.directory === s.directory && typeof data.assistantMessageID === 'string') {
          const id = liveKey(s, data.assistantMessageID);
          if (value.type === 'session.step.started') {
            if (w.live.size >= 100 && !w.live.has(id)) throw new Error('Too many live assistant messages');
            w.live.set(id, { id: data.assistantMessageID, sessionId: s.id, directory: s.directory, createdAt: typeof data.started === 'number' ? data.started : value.created ?? Date.now(), blocks: new Map(), ended: false, gap: false });
          }
          const live = w.live.get(id);
          // Without an observed step start, a delta may be only the tail after a
          // reconnect. Do not present it as a complete assistant message.
          if (live && isText && Number.isSafeInteger(data.ordinal) && data.ordinal >= 0) {
            if (value.type === 'session.text.started') {
              if (live.blocks.size >= 256 && !live.blocks.has(data.ordinal)) throw new Error('Too many live text blocks');
              live.blocks.set(data.ordinal, '');
            }
            if (value.type === 'session.text.delta' && !live.gap && typeof data.delta === 'string' && live.blocks.has(data.ordinal)) live.blocks.set(data.ordinal, live.blocks.get(data.ordinal)! + data.delta);
            if (value.type === 'session.text.ended' && typeof data.text === 'string') live.blocks.set(data.ordinal, data.text);
            if (Buffer.byteLength(JSON.stringify(rendered(w))) > 2097152) { w.live.delete(id); throw new Error('Live text exceeds cache limit'); }
            publish(w);
          }
          if (live && value.type === 'session.step.ended') { live.ended = true; publish(w); }
        }
        // Delta text is ephemeral: histories need not contain it until the
        // block/step ends. Coalesce publication, not repeated empty-history reads.
        if ((!isText && !value.type.endsWith('.delta') && !value.type.endsWith('.progress')) || value.type === 'session.text.ended') w.dirty.add(key(s));
      }
      schedule(w);
    }
  }
  function start() {
    if (closed || controller || retry || !connection || !watches.size) return;
    const target = connection;
    const current = new AbortController();
    controller = current;
    status = 'connecting';
    const handshake = setTimeout(() => current.abort(), 5000);
    void (async () => {
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        const response = await options.fetch(new URL('/api/event', target.endpoint), {
          headers: { accept: 'text/event-stream', ...(target.token ? { authorization: `Bearer ${target.token}` } : {}) },
          redirect: 'error', signal: current.signal,
        });
        clearTimeout(handshake);
        if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream') || !response.body) {
          await response.body?.cancel();
          throw new Error('Event stream unavailable');
        }
        if (current.signal.aborted) { await response.body.cancel(); return; }
        reader = response.body.getReader();
        current.signal.addEventListener('abort', () => { void reader?.cancel().catch(() => {}); }, { once: true });
        status = 'connected';
        failures = 0;
        invalidateAll();
        wakeAll();
        const decoder = new TextDecoder();
        let buffer = '';
        while (!current.signal.aborted) {
          const { value, done } = await reader.read();
          if (current.signal.aborted) break;
          if (done) throw new Error('Event stream ended');
          buffer += decoder.decode(value, { stream: true });
          // Normalize complete CRLFs without losing split CRLF chunk boundaries.
          buffer = buffer.replace(/\r\n/g, '\n');
          if (buffer.length > 1048576) throw new Error('Event frame too large');
          let end: number;
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            event(buffer.slice(0, end));
            buffer = buffer.slice(end + 2);
          }
        }
      } catch {
        if (controller === current && !current.signal.aborted) status = 'unavailable';
      } finally {
        clearTimeout(handshake);
        await reader?.cancel().catch(() => {});
        if (controller === current) {
          controller = undefined;
          if (!closed && watches.size) {
            status = 'unavailable';
            wakeAll();
            retry = setTimeout(() => { retry = undefined; start(); }, Math.min(retryMs * 2 ** failures++, 30000));
          }
        }
      }
    })();
  }
  function stop() {
    const old = controller;
    controller = undefined;
    old?.abort();
    if (retry) clearTimeout(retry);
    retry = undefined;
    status = 'idle';
  }
  function remove(w: Watch) { if (w.pending) clearTimeout(w.pending); if (w.publish) clearTimeout(w.publish); wake(w); }
  const sweep = setInterval(() => {
    for (const [id, w] of watches) if (!w.active && Date.now() - w.touched > idleMs) { watches.delete(id); remove(w); }
    if (!watches.size) stop();
  }, Math.min(idleMs, 5000));
  sweep.unref();
  return {
    configure(value: Connection) {
      stop();
      generation = randomUUID();
      connection = value;
      for (const w of watches.values()) remove(w);
      watches.clear();
    },
    async updates(sessions: Session[], cursor?: string, signal?: AbortSignal) {
      if (closed || !connection) return { changed: false, cursor: null, mode: 'polling', streamStatus: closed ? 'closed' : 'unconfigured', messages: [], statuses: [] };
      const normalized = [...new Map(sessions.map(s => [key(s), { id: s.id, directory: s.directory }])).values()].sort((a, b) => key(a).localeCompare(key(b)));
      const id = createHash('sha256').update(JSON.stringify(normalized)).digest('hex').slice(0, 24);
      let w = watches.get(id);
      if (!w) {
        if (watches.size >= 16) return { changed: false, cursor: null, mode: 'polling', streamStatus: 'capacity', messages: [], statuses: [] };
        w = { sessions: normalized, touched: Date.now(), active: 0, revision: 0, dirty: new Set(normalized.map(key)), snapshot: { messages: [], statuses: [] }, fetching: false, ready: false, listeners: new Set(), live: new Map() };
        for (const existing of watches.values()) for (const [id, live] of existing.live) {
          if (w.live.size < 100 && normalized.some(s => s.id === live.sessionId && s.directory === live.directory)) w.live.set(id, { ...live, blocks: new Map(live.blocks) });
        }
        watches.set(id, w);
      }
      const watch = w;
      const epoch = generation;
      const currentCursor = () => `${epoch}:${id}:${watch.revision}`;
      watch.touched = Date.now();
      if (watch.active >= 4) return { changed: false, cursor: null, mode: 'polling', streamStatus: 'capacity', messages: [], statuses: [] };
      watch.active++;
      start();
      schedule(watch);
      try {
        await new Promise<void>(resolve => {
          const finish = () => { clearTimeout(timer); watch.listeners.delete(check); signal?.removeEventListener('abort', finish); resolve(); };
          const check = () => {
            if (closed || epoch !== generation || signal?.aborted || status === 'unavailable' || (status === 'connected' && watch.ready && cursor !== currentCursor())) finish();
          };
          const timer = setTimeout(finish, pollMs);
          watch.listeners.add(check);
          signal?.addEventListener('abort', finish, { once: true });
          check();
        });
        const reset = epoch !== generation;
        const connected = !reset && !closed && status === 'connected';
        const changed = connected && watch.ready && cursor !== currentCursor();
        return { cursor: reset ? null : currentCursor(), changed, mode: connected ? 'events' : 'polling', streamStatus: reset ? 'configuration-changed' : closed ? 'closed' : status, ...(reset ? { reset: true } : {}), ...(changed ? rendered(watch) : { messages: [], statuses: [] }) };
      } finally { watch.active--; watch.touched = Date.now(); }
    },
    close() {
      closed = true;
      stop();
      clearInterval(sweep);
      for (const w of watches.values()) remove(w);
      watches.clear();
    },
  };
}
