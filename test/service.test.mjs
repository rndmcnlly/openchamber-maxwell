import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMaxwellService } from '../service/main.ts';

async function fixture(t, transport, extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'maxwell-service-'));
  const configFile = join(dir, 'connection.json');
  const server = await createMaxwellService({ token: 'fixture-secret', configFile, fetch: transport, ...extra });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  async function request(path, body, token = 'fixture-secret') {
    const result = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: result.status, body: await result.json() };
  }
  return { request, configFile, server };
}
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

test('all routes including health authenticate; configuration is explicit and redacted', async t => {
  const { request, configFile } = await fixture(t, async () => json({ version: '2.test' }));
  assert.equal((await request('/health', undefined, 'wrong')).status, 401);
  assert.equal((await request('/health')).body.ok, true);
  assert.equal((await request('/connection')).body.configured, false);
  assert.equal((await request('/connection', { endpoint: 'http://example.com', token: 'secret' })).status, 400);
  const configured = await request('/connection', { endpoint: 'http://127.0.0.1:1234', token: 'secret' });
  assert.equal(configured.body.connected, true);
  assert.ok(!JSON.stringify(configured.body).includes('secret'));
  assert.equal(JSON.parse(await readFile(configFile, 'utf8')).token, 'secret');
});

test('selected history uses V2 envelopes, preserves mutable messages, isolates failures', async t => {
  const seen = [];
  const { request } = await fixture(t, async (url, init) => {
    seen.push([url, init]);
    if (url.pathname === '/api/info') return json({});
    if (url.pathname.includes('broken')) return new Response('', { status: 404 });
    return json({ data: [
      { id: 'm2', type: 'assistant', time: { created: 200 }, content: [{ type: 'reasoning', text: 'hidden' }, { type: 'text', text: 'answer' }] },
      { id: 'm1', type: 'user', time: { created: 100 }, text: 'question' },
    ], cursor: { next: 'older' } });
  });
  await request('/connection', { endpoint: 'http://127.0.0.1:1234', token: 'explicit' });
  const result = await request('/messages', { sessions: [{ id: 'selected', directory: '/project a' }, { id: 'broken', directory: '/b' }], after: 999 });
  assert.deepEqual(result.body.messages.map(m => m.text), ['question', 'answer']);
  assert.equal(result.body.statuses[1].status, 'error');
  assert.equal(seen[1][0].searchParams.get('directory'), '/project a');
  assert.equal(seen[1][1].headers.authorization, 'Bearer explicit');
});

test('addressed sends serialize duplicate ids, reject conflicts, and retain uncertainty across restart', async t => {
  let sends = 0;
  const transport = async (url, init) => {
    if (url.pathname === '/api/info') return json({});
    if (init.method === 'GET') return json({ data: { id: 'target' } });
    sends++;
    assert.equal(url.pathname, '/api/session/target/prompt');
    assert.equal(url.searchParams.get('directory'), '/project');
    assert.deepEqual(JSON.parse(init.body), { text: 'hello' });
    throw new Error('Lost reply after possible delivery');
  };
  const { request, configFile } = await fixture(t, transport);
  await request('/connection', { endpoint: 'http://127.0.0.1:1234' });
  const body = { requestId: 'stable-id', sessionId: 'target', directory: '/project', text: 'hello' };
  const responses = await Promise.all([request('/dispatch', body), request('/dispatch', body)]);
  assert.deepEqual(responses.map(r => r.body.status), ['uncertain', 'uncertain']);
  assert.equal(sends, 1);
  assert.equal((await request('/dispatch', { ...body, text: 'changed' })).status, 409);
  const restarted = await createMaxwellService({ token: 'test', configFile, fetch: transport });
  await new Promise(resolve => restarted.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => restarted.close(resolve)));
  const repeated = await fetch(`http://127.0.0.1:${restarted.address().port}/dispatch`, { method: 'POST', headers: { authorization: 'Bearer test' }, body: JSON.stringify(body) });
  assert.equal((await repeated.json()).status, 'uncertain');
  assert.equal(sends, 1);
});

test('successful dispatch reports accepted, not completed', async t => {
  const { request } = await fixture(t, async (url, init) => init.method === 'POST' ? json({ data: { id: 'inbox-1' } }) : json({ data: { id: 'target' } }));
  await request('/connection', { endpoint: 'http://127.0.0.1:1234' });
  const result = await request('/dispatch', { requestId: 'success', sessionId: 'target', directory: '/project', text: 'hello' });
  assert.equal(result.body.status, 'accepted');
  assert.equal(result.body.inboxId, 'inbox-1');
});

test('stop validates and interrupts only the addressed provider session', async t => {
  const seen = [];
  let interrupted = true;
  const { request } = await fixture(t, async (url, init) => {
    if (url.pathname === '/api/info') return json({});
    seen.push({ url, init });
    assert.equal(url.searchParams.get('directory'), '/project a');
    assert.equal(init.headers.authorization, 'Bearer explicit');
    if (init.method === 'GET') return json({ data: { id: 'target', location: { directory: '/project a' } } });
    assert.equal(url.pathname, '/api/session/target/interrupt');
    assert.equal(init.method, 'POST');
    assert.equal(init.body, undefined);
    assert.equal(url.searchParams.has('resume'), false);
    return json({ interrupted });
  });
  await request('/connection', { endpoint: 'http://127.0.0.1:1234', token: 'explicit' });
  const target = { sessionId: 'target', directory: '/project a' };
  assert.deepEqual((await request('/stop', target)).body, { ...target, status: 'stopped' });
  interrupted = false;
  assert.deepEqual((await request('/stop', target)).body, { ...target, status: 'idle' });
  assert.deepEqual(seen.map(s => s.url.pathname), ['/api/session/target', '/api/session/target/interrupt', '/api/session/target', '/api/session/target/interrupt']);
});

test('stop rejects invalid, unauthorized, unavailable, and mismatched targets without interruption', async t => {
  let session = { id: 'other', location: { directory: '/project' } };
  let upstreamStatus = 200;
  const calls = [];
  const { request } = await fixture(t, async (url, init) => {
    if (url.pathname === '/api/info') return json({});
    calls.push([url.pathname, init.method]);
    return upstreamStatus === 200 ? json({ data: session }) : new Response(null, { status: upstreamStatus });
  });
  const target = { sessionId: 'target', directory: '/project' };
  assert.equal((await request('/stop', target)).status, 409);
  await request('/connection', { endpoint: 'http://127.0.0.1:1234' });
  assert.equal((await request('/stop', target, 'wrong')).status, 401);
  assert.equal((await request('/stop', {})).status, 400);
  assert.equal((await request('/stop', { sessionId: 'target' })).status, 400);
  assert.equal(calls.length, 0);
  assert.equal((await request('/stop', target)).status, 502);
  session = { id: 'target', location: { directory: '/different' } };
  assert.equal((await request('/stop', target)).status, 409);
  for (const status of [401, 403, 404, 500]) {
    upstreamStatus = status;
    assert.equal((await request('/stop', target)).status, [401, 403].includes(status) ? 401 : 502);
  }
  assert.ok(calls.every(([path, method]) => path === '/api/session/target' && method === 'GET'));
});

test('stop handles explicit 204 but rejects malformed JSON and never retries uncertain interruption', async t => {
  let mode = 'no-content';
  let interrupts = 0;
  const { request } = await fixture(t, async (url, init) => {
    if (url.pathname === '/api/info') return json({});
    if (init.method === 'GET') return mode === 'invalid-session' ? new Response(null, { status: 204 }) : json({ data: { id: 'target' } });
    interrupts++;
    if (mode === 'no-content') return new Response(null, { status: 204 });
    if (mode === 'lost') throw new Error('Possibly interrupted before reply was lost');
    if (mode === 'invalid-shape') return json({ ok: true });
    return new Response(mode === 'empty' ? '' : 'not JSON');
  });
  await request('/connection', { endpoint: 'http://127.0.0.1:1234' });
  const target = { sessionId: 'target', directory: '/project' };
  assert.deepEqual((await request('/stop', target)).body, { ...target, status: 'stop-requested' });
  for (mode of ['empty', 'malformed', 'invalid-shape', 'lost']) {
    const before = interrupts;
    assert.equal((await request('/stop', target)).status, 502);
    assert.equal(interrupts, before + 1);
  }
  mode = 'invalid-session';
  const before = interrupts;
  const result = await request('/stop', target);
  assert.equal(result.status, 502);
  assert.equal(result.body.error, 'Upstream did not return JSON');
  assert.equal(interrupts, before);
});

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  for (let n = 0; n < 200; n++) { if (check()) return; await delay(5); }
  assert.fail('Timed out waiting for synthetic transport');
}
function eventTransport() {
  const streams = [];
  const reads = [];
  const requests = [];
  let text = 'Hel';
  let streamError;
  const fetch = async (url, init) => {
    requests.push({ url, init });
    if (url.pathname === '/api/info') return json({});
    if (url.pathname === '/api/event') {
      if (streamError) return new Response(null, { status: streamError });
      const stream = { url, init, cancelled: false };
      const body = new ReadableStream({ start(c) { stream.controller = c; }, cancel() { stream.cancelled = true; } });
      streams.push(stream);
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    }
    if (url.pathname.endsWith('/interrupt')) return json({ interrupted: true });
    if (url.pathname.endsWith('/message')) {
      reads.push(url);
      const sessionId = url.pathname.split('/')[3];
      return json({ data: [{ id: `message-${sessionId}`, type: 'assistant', time: { created: 1 }, content: [{ type: 'text', text: sessionId === 'selected' ? text : `Only ${sessionId}` }] }] });
    }
    return json({ data: { id: 'selected', location: { directory: '/project' } } });
  };
  const native = (type, fields = {}, sessionID = 'selected', directory = '/project', stream = streams.at(-1)) => {
    const data = { id: 'synthetic-event', created: 1, type, ...(directory === null ? {} : { location: { directory } }), data: { sessionID, ...fields } };
    // Deliberately split CRLF between chunks, as a proxy may do.
    const frame = `data: ${JSON.stringify(data)}\r\n\r\n`;
    const split = frame.indexOf('\r') + 1;
    stream.controller.enqueue(new TextEncoder().encode(frame.slice(0, split)));
    stream.controller.enqueue(new TextEncoder().encode(frame.slice(split)));
  };
  const send = (sessionID = 'selected', directory = '/project', stream = streams.at(-1)) => native('session.tool.success', { assistantMessageID: 'message-selected' }, sessionID, directory, stream);
  return { fetch, streams, reads, requests, send, native, text: value => { text = value; }, error: value => { streamError = value; } };
}
const updatesTiming = { pollMs: 80, coalesceMs: 5, idleMs: 150, reconnectMs: 25 };
const selection = { sessions: [{ id: 'selected', directory: '/project' }] };

test('real native text deltas grow selected snapshots while authoritative history stays empty', async t => {
  const upstream = eventTransport();
  upstream.text('');
  const { request } = await fixture(t, upstream.fetch, { updatesTiming });
  await request('/connection', { endpoint: 'http://127.0.0.1:1234', token: 'stream-token' });
  const first = (await request('/updates', selection)).body;
  assert.equal(first.mode, 'events');
  assert.equal(first.changed, true);
  assert.equal(first.messages[0].text, '');
  assert.equal(upstream.streams.length, 1);
  assert.equal(upstream.streams[0].init.headers.authorization, 'Bearer stream-token');
  assert.equal(upstream.streams[0].init.headers.accept, 'text/event-stream');
  assert.equal(upstream.streams[0].url.search, '');
  const second = request('/updates', { ...selection, cursor: first.cursor });
  const sameSubscriber = request('/updates', { ...selection, cursor: first.cursor });
  await delay(5);
  const identity = { assistantMessageID: 'message-selected' };
  upstream.native('session.step.started', { ...identity, started: 1, agent: 'build', model: {} });
  upstream.native('session.text.started', { ...identity, ordinal: 0 });
  upstream.native('session.text.delta', { ...identity, ordinal: 0, delta: 'H' });
  upstream.native('session.text.delta', { ...identity, ordinal: 0, delta: 'el' });
  const results = await Promise.all([second, sameSubscriber]);
  for (const result of results) {
    assert.equal(result.body.changed, true);
    assert.equal(result.body.messages[0].id, first.messages[0].id);
    assert.equal(result.body.messages[0].text, 'Hel');
    assert.notEqual(result.body.cursor, first.cursor);
  }
  assert.equal(upstream.reads.length, 2);
  assert.equal(upstream.streams.length, 1);
  const growing = request('/updates', { ...selection, cursor: results[0].body.cursor });
  upstream.native('session.text.delta', { ...identity, ordinal: 0, delta: 'lo ' });
  upstream.native('session.text.delta', { ...identity, ordinal: 0, delta: 'world' });
  const growth = (await growing).body;
  assert.equal(growth.messages[0].text, 'Hello world');
  assert.equal(upstream.reads.length, 2, 'ephemeral deltas do not poll empty history');
  // A stale authoritative read cannot erase the already published live text.
  const stale = request('/updates', { ...selection, cursor: growth.cursor });
  upstream.send();
  const retained = (await stale).body;
  assert.equal(retained.messages[0].text, 'Hello world');
  // Completion commits full text. Later authoritative changes prove retirement.
  upstream.text('Hello world');
  upstream.native('session.text.ended', { ...identity, ordinal: 0, text: 'Hello world' });
  upstream.native('session.step.ended', { ...identity, finish: 'stop' });
  await delay(20);
  const committed = (await request('/updates', selection)).body;
  assert.equal(committed.messages[0].text, 'Hello world');
  upstream.text('Authoritative replacement');
  const reconciled = request('/updates', { ...selection, cursor: committed.cursor });
  upstream.send();
  assert.equal((await reconciled).body.messages[0].text, 'Authoritative replacement');
});

test('updates isolate selections and directories, time out without history polling, then clean up idle SSE', async t => {
  const upstream = eventTransport();
  const { request } = await fixture(t, upstream.fetch, { updatesTiming });
  await request('/connection', { endpoint: 'http://127.0.0.1:1234' });
  const first = (await request('/updates', selection)).body;
  const anotherSelection = { sessions: [{ id: 'other', directory: '/elsewhere' }] };
  const other = (await request('/updates', { ...anotherSelection, cursor: first.cursor })).body;
  assert.deepEqual(other.messages.map(m => m.sessionId), ['other']);
  const reads = upstream.reads.length;
  const pending = request('/updates', { ...selection, cursor: first.cursor });
  upstream.send('unselected');
  upstream.send('selected', '/wrong-directory');
  const timeout = (await pending).body;
  assert.equal(timeout.mode, 'events');
  assert.equal(timeout.changed, false);
  assert.deepEqual(timeout.messages, []);
  assert.equal(upstream.reads.length, reads);
  await until(() => upstream.streams[0].cancelled);
  assert.equal(upstream.streams.length, 1);
});

test('stream failures expose polling fallback and reconnect with a fresh selected snapshot', async t => {
  const upstream = eventTransport();
  const { request } = await fixture(t, upstream.fetch, { updatesTiming: { ...updatesTiming, idleMs: 1000 } });
  await request('/connection', { endpoint: 'http://127.0.0.1:1234' });
  const first = (await request('/updates', selection)).body;
  const pending = request('/updates', { ...selection, cursor: first.cursor });
  await delay(5);
  upstream.streams[0].controller.error(new Error('Synthetic connection loss'));
  const failure = (await pending).body;
  assert.equal(failure.mode, 'polling');
  assert.equal(failure.streamStatus, 'unavailable');
  assert.equal(failure.changed, false);
  upstream.text('Changed while disconnected');
  await until(() => upstream.streams.length === 2);
  const recovered = (await request('/updates', { ...selection, cursor: first.cursor })).body;
  assert.equal(recovered.mode, 'events');
  assert.equal(recovered.messages[0].text, 'Changed while disconnected');
  assert.notEqual(recovered.cursor, first.cursor);
});

test('configuration changes wake long polls and stop stays responsive', async t => {
  const upstream = eventTransport();
  const { request, server } = await fixture(t, upstream.fetch, { updatesTiming });
  await request('/connection', { endpoint: 'http://127.0.0.1:1234', token: 'old-token' });
  const first = (await request('/updates', selection)).body;
  const pending = request('/updates', { ...selection, cursor: first.cursor });
  const stopped = await request('/stop', { sessionId: 'selected', directory: '/project' });
  assert.equal(stopped.body.status, 'stopped');
  await request('/connection', { endpoint: 'http://127.0.0.1:4321', token: 'new-token' });
  const reset = (await pending).body;
  assert.equal(reset.reset, true);
  assert.equal(reset.cursor, null);
  assert.equal(reset.streamStatus, 'configuration-changed');
  assert.deepEqual(reset.messages, []);
  await until(() => upstream.streams[0].cancelled);
  const next = (await request('/updates', { ...selection, cursor: first.cursor })).body;
  assert.equal(next.changed, true);
  assert.equal(upstream.streams[1].url.port, '4321');
  assert.equal(upstream.streams[1].init.headers.authorization, 'Bearer new-token');
  const last = request('/updates', { ...selection, cursor: next.cursor });
  await delay(5);
  await new Promise(resolve => server.close(resolve));
  assert.equal((await last).body.streamStatus, 'closed');
  assert.equal(upstream.streams[1].cancelled, true);
});

test('updates authenticate and validate before subscribing; invalid upstream streams explicitly fall back', async t => {
  const upstream = eventTransport();
  const { request } = await fixture(t, upstream.fetch, { updatesTiming });
  await request('/connection', { endpoint: 'http://127.0.0.1:1234' });
  assert.equal((await request('/updates', selection, 'wrong')).status, 401);
  assert.equal((await request('/updates', { sessions: [{ id: 'x' }] })).status, 400);
  assert.equal((await request('/updates', { ...selection, cursor: 12 })).status, 400);
  assert.equal((await request('/updates', { sessions: Array(25).fill(selection.sessions[0]) })).status, 400);
  assert.equal(upstream.streams.length, 0);
  upstream.error(401);
  const fallback = (await request('/updates', selection)).body;
  assert.equal(fallback.mode, 'polling');
  assert.equal(fallback.streamStatus, 'unavailable');
  assert.deepEqual(fallback.messages, []);
  const snapshot = (await request('/messages', selection)).body;
  assert.equal(snapshot.messages[0].text, 'Hel');
});

test('a late old-provider snapshot cannot enter the replacement connection or selection', async t => {
  const upstream = eventTransport();
  let release;
  const { request } = await fixture(t, async (url, init) => {
    if (url.port === '1234' && url.pathname.endsWith('/message')) return await new Promise(resolve => { release = resolve; });
    return await upstream.fetch(url, init);
  }, { updatesTiming: { ...updatesTiming, pollMs: 300 } });
  await request('/connection', { endpoint: 'http://127.0.0.1:1234' });
  const old = request('/updates', selection);
  await until(() => release !== undefined);
  await request('/connection', { endpoint: 'http://127.0.0.1:4321' });
  assert.equal((await old).body.reset, true);
  const current = (await request('/updates', selection)).body;
  assert.equal(current.messages[0].text, 'Hel');
  release(json({ data: [{ id: 'old-provider-message', type: 'assistant', time: { created: 1 }, content: [{ type: 'text', text: 'old provider content' }] }] }));
  const unchanged = (await request('/updates', { ...selection, cursor: current.cursor })).body;
  assert.equal(unchanged.changed, false);
  assert.deepEqual(unchanged.messages, []);
});

test('malformed event frames fail closed and dispose their source instead of forwarding event data', async t => {
  const upstream = eventTransport();
  const { request } = await fixture(t, upstream.fetch, { updatesTiming });
  await request('/connection', { endpoint: 'http://127.0.0.1:1234' });
  const first = (await request('/updates', selection)).body;
  const pending = request('/updates', { ...selection, cursor: first.cursor });
  await delay(5);
  upstream.streams[0].controller.enqueue(new TextEncoder().encode('data: not JSON\n\n'));
  const result = (await pending).body;
  assert.equal(result.mode, 'polling');
  assert.equal(result.streamStatus, 'unavailable');
  assert.deepEqual(result.messages, []);
  await until(() => upstream.streams[0].cancelled);
});

test('native text blocks preserve order and do not expose reasoning or location-less content', async t => {
  const upstream = eventTransport();
  upstream.text('');
  const { request } = await fixture(t, upstream.fetch, { updatesTiming });
  await request('/connection', { endpoint: 'http://127.0.0.1:1234' });
  const first = (await request('/updates', selection)).body;
  const identity = { assistantMessageID: 'message-selected' };
  upstream.native('session.step.started', { ...identity, started: 1 });
  upstream.native('session.text.started', { ...identity, ordinal: 0 });
  upstream.native('session.text.delta', { ...identity, ordinal: 0, delta: 'First' });
  upstream.native('session.reasoning.delta', { ...identity, ordinal: 1, delta: 'never display reasoning' });
  upstream.native('session.text.started', { ...identity, ordinal: 2 });
  upstream.native('session.text.delta', { ...identity, ordinal: 2, delta: 'Second' });
  const visible = (await request('/updates', { ...selection, cursor: first.cursor })).body;
  assert.equal(visible.messages[0].text, 'First\nSecond');
  await delay(15);
  const settled = (await request('/updates', selection)).body;
  const pending = request('/updates', { ...selection, cursor: settled.cursor });
  upstream.native('session.text.delta', { ...identity, ordinal: 2, delta: 'wrong location' }, 'selected', null);
  upstream.native('session.text.delta', { ...identity, ordinal: 2, delta: 'other session' }, 'unselected');
  assert.equal((await pending).body.changed, false);
});

test('reconnection preserves a known live prefix without concatenating an unseen-gap tail', async t => {
  const upstream = eventTransport();
  upstream.text('');
  const { request } = await fixture(t, upstream.fetch, { updatesTiming: { ...updatesTiming, idleMs: 1000 } });
  await request('/connection', { endpoint: 'http://127.0.0.1:1234' });
  const first = (await request('/updates', selection)).body;
  const identity = { assistantMessageID: 'message-selected' };
  upstream.native('session.step.started', { ...identity, started: 1 });
  upstream.native('session.text.started', { ...identity, ordinal: 0 });
  upstream.native('session.text.delta', { ...identity, ordinal: 0, delta: 'Known prefix' });
  const live = (await request('/updates', { ...selection, cursor: first.cursor })).body;
  assert.equal(live.messages[0].text, 'Known prefix');
  upstream.streams[0].controller.error(new Error('Synthetic disconnect during a text block'));
  await until(() => upstream.streams.length === 2);
  const restored = (await request('/updates', { ...selection, cursor: live.cursor })).body;
  assert.equal(restored.messages[0].text, 'Known prefix');
  upstream.native('session.text.delta', { ...identity, ordinal: 0, delta: ' tail without missing middle' });
  await delay(15);
  const held = (await request('/updates', selection)).body;
  assert.equal(held.messages[0].text, 'Known prefix');
  upstream.text('Known prefix, repaired middle and tail');
  upstream.native('session.text.ended', { ...identity, ordinal: 0, text: 'Known prefix, repaired middle and tail' });
  upstream.native('session.step.ended', { ...identity, finish: 'stop' });
  const repaired = (await request('/updates', { ...selection, cursor: held.cursor })).body;
  assert.equal(repaired.messages[0].text, 'Known prefix, repaired middle and tail');
});
