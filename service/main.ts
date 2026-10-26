import { createServer } from 'node:http';
import { timingSafeEqual, createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createTinfoilRouter, RouterError } from './tinfoil.ts';
import { createUpdates } from './updates.ts';
import { createGuidanceStore } from './guidance.ts';

type Connection = { endpoint: string; token?: string };
class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
const required = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > 100000) throw new ApiError(400, `Invalid ${name}`);
  return value;
};
export function validateConnection(value: any): Connection {
  let url: URL;
  try { url = new URL(required(value?.endpoint, 'endpoint')); } catch { throw new ApiError(400, 'Invalid endpoint'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new ApiError(400, 'Endpoint must be an HTTP(S) origin without credentials or a path');
  if (url.protocol !== 'https:' && !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)) throw new ApiError(400, 'Non-loopback connections require HTTPS');
  if (value.token !== undefined && (typeof value.token !== 'string' || /[\r\n]/.test(value.token))) throw new ApiError(400, 'Invalid token');
  return { endpoint: url.origin, ...(value.token ? { token: value.token } : {}) };
}

// Never import host environment credentials. Only explicitly supplied connection
// configuration grants this adapter access to the host's broad session API.
export async function createMaxwellService(options: { token: string; configFile: string; fetch?: typeof fetch; updatesTiming?: Parameters<typeof createUpdates>[0]['timing'] }) {
  if (!options.token) throw new Error('Service bearer token is required');
  const transport = options.fetch ?? fetch;
  let connection: Connection | undefined;
  let configurationError = false;
  try { connection = validateConnection(JSON.parse(await readFile(options.configFile, 'utf8'))); }
  catch (error: any) { configurationError = error.code !== 'ENOENT'; }
  const ledgerFile = `${options.configFile}.dispatch.json`;
  let ledger: Record<string, any> = Object.create(null);
  try { ledger = Object.assign(Object.create(null), JSON.parse(await readFile(ledgerFile, 'utf8'))); }
  catch (error: any) { if (error.code !== 'ENOENT') throw new Error('Dispatch ledger cannot be read safely'); }
  // A crash with a pending entry is uncertain, not an invitation to resend.
  for (const entry of Object.values(ledger)) if (entry.outcome.status === 'pending') entry.outcome.status = 'uncertain';
  async function persist(path: string, data: any) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temp = `${path}.tmp`;
    await writeFile(temp, JSON.stringify(data), { mode: 0o600 });
    await rename(temp, path);
  }
  async function upstream(path: string, directory?: string, body?: any, request: { method?: 'POST'; allowNoContent?: boolean; connection?: Connection; signal?: AbortSignal } = {}) {
    const targetConnection = request.connection ?? connection;
    if (!targetConnection) throw new ApiError(409, 'Configure an OpenChamber endpoint first');
    const url = new URL(path, targetConnection.endpoint);
    if (directory) url.searchParams.set('directory', directory);
    let response: Response;
    try {
      response = await transport(url, {
        method: request.method ?? (body === undefined ? 'GET' : 'POST'), redirect: 'error',
        headers: { accept: 'application/json', ...(targetConnection.token ? { authorization: `Bearer ${targetConnection.token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: request.signal ?? AbortSignal.timeout(15000),
      });
    } catch { throw new ApiError(502, 'Upstream connection failed'); }
    if (!response.ok) throw new ApiError(response.status === 401 || response.status === 403 ? 401 : 502, `Upstream HTTP ${response.status}`);
    if (response.status === 204 && request.allowNoContent) return undefined;
    try { return await response.json(); } catch { throw new ApiError(502, 'Upstream did not return JSON'); }
  }
  function selectedSessions(body: any): { id: string; directory: string }[] {
    if (!Array.isArray(body?.sessions) || body.sessions.length > 24) throw new ApiError(400, 'Select at most 24 sessions');
    return body.sessions.map((session: any) => ({ id: required(session?.id, 'session id'), directory: required(session?.directory, 'directory') }));
  }
  async function messages(sessions: { id: string; directory: string }[], target = connection, signal?: AbortSignal) {
    const results = await Promise.all(sessions.map(async ({ id: sessionId, directory }) => {
      try {
        const payload = await upstream(`/api/session/${encodeURIComponent(sessionId)}/message?limit=100&order=desc`, directory, undefined, { connection: target, signal });
        if (!Array.isArray(payload.data)) throw new ApiError(502, 'Unexpected messages response');
        const messages = payload.data.filter((m: any) => ['user', 'assistant'].includes(m.type)).map((m: any) => ({
          id: m.id, sessionId, directory, role: m.type,
          text: m.type === 'user' ? m.text : (m.content ?? []).filter((p: any) => p.type === 'text').map((p: any) => p.text).join('\n'),
          createdAt: m.time.created,
        }));
        return { messages, status: { sessionId, directory, status: 'ok', truncated: payload.data.length >= 100 && Boolean(payload.cursor?.next) } };
      } catch (error: any) { return { messages: [], status: { sessionId, directory, status: 'error', error: error.message } }; }
    }));
    return { messages: results.flatMap(r => r.messages).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)), statuses: results.map(r => r.status) };
  }
  const updates = createUpdates({ fetch: transport, history: messages, timing: options.updatesTiming });
  if (connection) updates.configure(connection);
  let dispatchQueue = Promise.resolve();
  const guidance = createGuidanceStore(`${options.configFile}.guidance.json`);
  await guidance.get(); // Fail closed on corrupt private state, without logging it.
  const router = await createTinfoilRouter({
    configFile: `${options.configFile}.router.json`,
    guidance: guidance.get,
    history: async sessions => {
      const snapshot: any = await route('POST', '/messages', { sessions });
      if (snapshot.statuses.some((s: any) => s.status !== 'ok')) throw new RouterError(502, 'Selected-session context unavailable');
      return snapshot.messages;
    },
  });
  async function dispatch(body: any) {
    const requestId = required(body.requestId, 'requestId');
    if (!/^[a-zA-Z0-9_-]{1,160}$/.test(requestId)) throw new ApiError(400, 'Invalid requestId');
    const sessionId = required(body.sessionId, 'sessionId');
    const directory = required(body.directory, 'directory');
    const text = required(body.text, 'text');
    const fingerprint = createHash('sha256').update(JSON.stringify([connection?.endpoint, sessionId, directory, text])).digest('hex');
    if (ledger[requestId]) {
      if (ledger[requestId].fingerprint !== fingerprint) throw new ApiError(409, 'requestId already used for another destination or text');
      return ledger[requestId].outcome;
    }
    // Verify the addressed destination before marking an attempted delivery.
    const session = await upstream(`/api/session/${encodeURIComponent(sessionId)}`, directory);
    if (session.data?.id !== sessionId) throw new ApiError(502, 'Unexpected session response');
    const outcome: any = { requestId, sessionId, directory, status: 'pending' };
    ledger[requestId] = { fingerprint, outcome };
    await persist(ledgerFile, ledger);
    try {
      const result = await upstream(`/api/session/${encodeURIComponent(sessionId)}/prompt`, directory, { text });
      outcome.status = 'accepted';
      outcome.inboxId = result.data?.id;
      router.invalidateContext();
    } catch (error: any) {
      // Even a server error may follow a committed send. Do not blindly retry.
      outcome.status = 'uncertain';
      outcome.error = error.message;
    }
    await persist(ledgerFile, ledger);
    return outcome;
  }
  async function route(method: string, path: string, body: any, signal?: AbortSignal) {
    if (method === 'GET' && path === '/health') return { ok: true };
    if (path === '/guidance' && method === 'GET') return await guidance.get();
    if (path === '/guidance' && (method === 'PUT' || method === 'POST')) {
      const saved = await guidance.put(body);
      router.invalidateContext();
      return saved;
    }
    if (path === '/router' && method === 'GET') return await router.status();
    if (path === '/router' && method === 'POST') { await router.configure(body); return await router.status(); }
    if (path === '/recommend' && method === 'POST') return await router.recommend(body);
    if (path === '/manage' && method === 'POST') return await router.manage(body);
    if (path === '/explain-route' && method === 'POST') return await router.explain(body);
    if (path === '/updates' && method === 'POST') {
      const sessions = selectedSessions(body);
      if (body.cursor !== undefined && body.cursor !== null && (typeof body.cursor !== 'string' || body.cursor.length > 256)) throw new ApiError(400, 'Invalid cursor');
      if (!sessions.length) return { cursor: null, changed: false, mode: 'events', streamStatus: 'idle', messages: [], statuses: [] };
      return await updates.updates(sessions, body.cursor ?? undefined, signal);
    }
    if (path === '/stop' && method === 'POST') {
      const sessionId = required(body?.sessionId, 'sessionId');
      const directory = required(body?.directory, 'directory');
      // Pin the configured provider across validation and interruption. Stop must
      // not wait for the outgoing dispatch queue or follow a host UI selection.
      const targetConnection = connection;
      const sessionPath = `/api/session/${encodeURIComponent(sessionId)}`;
      const session = await upstream(sessionPath, directory, undefined, { connection: targetConnection });
      if (session.data?.id !== sessionId) throw new ApiError(502, 'Unexpected session response');
      if (session.data.location?.directory !== undefined && session.data.location.directory !== directory) throw new ApiError(409, 'Session directory does not match requested destination');
      // V2 session.interrupt has no request body. Do not resume queued work.
      // Interruption is not an undo of delivered messages or tool side effects.
      const result = await upstream(`${sessionPath}/interrupt`, directory, undefined, { method: 'POST', allowNoContent: true, connection: targetConnection });
      router.invalidateContext();
      if (result === undefined) return { sessionId, directory, status: 'stop-requested' };
      if (typeof result?.interrupted !== 'boolean') throw new ApiError(502, 'Unexpected interrupt response');
      return { sessionId, directory, status: result.interrupted ? 'stopped' : 'idle' };
    }
    if (path === '/connection' && method === 'POST') {
      const candidate = validateConnection(body);
      const work = dispatchQueue.then(async () => {
        await persist(options.configFile, candidate);
        connection = candidate;
        updates.configure(candidate);
        router.invalidateContext();
        configurationError = false;
      });
      dispatchQueue = work.then(() => undefined, () => undefined);
      await work;
    }
    if (path === '/connection' && ['GET', 'POST'].includes(method)) {
      if (!connection) return { configured: false, connected: false, status: configurationError ? 'invalid-configuration' : 'unconfigured' };
      try {
        const info = await upstream('/api/info');
        return { configured: true, connected: true, status: 'connected', endpoint: connection.endpoint, authenticated: Boolean(connection.token), api: 'opencode-v2', version: info.data?.version ?? info.version };
      } catch (error: any) { return { configured: true, connected: false, status: 'unavailable', endpoint: connection.endpoint, error: error.message }; }
    }
    if (method === 'POST' && path === '/messages') {
      // `after` deliberately does not discard earlier mutable assistant messages.
      // The Page upserts by (sessionId,id); polling returns a bounded snapshot.
      return await messages(selectedSessions(body));
    }
    if (method === 'POST' && path === '/dispatch') {
      const work = dispatchQueue.then(() => dispatch(body));
      dispatchQueue = work.then(() => undefined, () => undefined);
      return await work;
    }
    throw new ApiError(404, 'Not found');
  }
  const server = createServer(async (req, res) => {
    const cancelled = new AbortController();
    res.on('close', () => cancelled.abort());
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
    const supplied = Buffer.from(req.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${options.token}`);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { res.writeHead(401).end('{"error":"Unauthorized"}'); return; }
    try {
      let raw = '';
      for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 262144) throw new ApiError(413, 'Body too large'); }
      let body;
      try { body = raw ? JSON.parse(raw) : undefined; } catch { throw new ApiError(400, 'Invalid JSON'); }
      const result = await route(req.method ?? 'GET', new URL(req.url ?? '/', 'http://localhost').pathname, body, cancelled.signal);
      res.end(JSON.stringify(result));
    } catch (error: any) {
      res.statusCode = error instanceof ApiError || error instanceof RouterError ? error.status : 500;
      res.end(JSON.stringify({ error: error instanceof ApiError || error instanceof RouterError ? error.message : 'Internal service error' }));
    }
  });
  // close() otherwise waits for long polls before emitting 'close'. Wake them at
  // shutdown entry, not only after the HTTP server has drained.
  const close = server.close.bind(server);
  server.close = (...args: Parameters<typeof server.close>) => { updates.close(); return close(...args); };
  server.once('close', () => updates.close());
  return server;
}

if (process.env.OPENCHAMBER_SERVICE_PORT) {
  const port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid service port');
  const configFile = process.env.MAXWELL_CONNECTION_FILE ?? resolve(dirname(process.argv[1]), '../.local/connection.json');
  createMaxwellService({ token: process.env.OPENCHAMBER_SERVICE_TOKEN ?? '', configFile }).then(server => {
    server.listen(port, '127.0.0.1');
    for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => server.close(() => process.exit(0)));
  }).catch(() => { console.error('Maxwell service could not initialize'); process.exitCode = 1; });
}
