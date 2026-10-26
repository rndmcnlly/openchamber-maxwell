import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGuidanceStore } from '../service/guidance.ts';
import { createMaxwellService } from '../service/main.ts';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'maxwell-guidance-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
test('guidance persists private atomic revisions across restart and concurrent writers', async t => {
  const dir = await fixture(t), path = join(dir, 'connection.json.guidance.json');
  const store = createGuidanceStore(path);
  assert.deepEqual(await store.get(), { revision: 0, text: '' });
  assert.deepEqual(await store.put({ revision: 0, text: 'Synthetic: Garden is ses_garden; Book is ses_book.' }), { revision: 1, text: 'Synthetic: Garden is ses_garden; Book is ses_book.' });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const restarted = createGuidanceStore(path);
  assert.deepEqual(await restarted.get(), await store.get());
  await assert.rejects(restarted.put({ revision: 0, text: 'overwrite' }), e => e.status === 409);
  const outcomes = await Promise.allSettled([store.put({ revision: 1, text: 'first' }), restarted.put({ revision: 1, text: 'second' })]);
  assert.equal(outcomes.filter(o => o.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find(o => o.status === 'rejected').reason.status, 409);
  assert.equal((await restarted.get()).revision, 2);
  assert.deepEqual(await readdir(dir), ['connection.json.guidance.json']);
  for (const invalid of [{ revision: 2, text: 'x'.repeat(16001) }, { revision: -1, text: '' }, { revision: 2.5, text: '' }, { revision: 2, text: '', path: '/elsewhere' }]) {
    await assert.rejects(store.put(invalid), e => e.status === 400);
  }
  assert.deepEqual(await store.put({ revision: 2, text: '' }), { revision: 3, text: '' });
});

test('authenticated guidance endpoints never add guidance to provider dispatch or ledger', async t => {
  const dir = await fixture(t), configFile = join(dir, 'connection.json');
  const sent = [];
  const server = await createMaxwellService({ token: 'fixture', configFile, fetch: async (url, init) => {
    if (init.body) sent.push(JSON.parse(init.body));
    return Response.json({ data: { id: 'garden' } });
  } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const request = async (path, method = 'GET', body, token = 'fixture') => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method, headers: { authorization: `Bearer ${token}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await request('/guidance', 'GET', undefined, 'wrong')).status, 401);
  assert.equal((await request('/guidance', 'PUT', { revision: 0, text: 'wrong' }, 'wrong')).status, 401);
  assert.deepEqual((await request('/guidance')).body, { revision: 0, text: '' });
  const saved = await request('/guidance', 'PUT', { revision: 0, text: 'PRIVATE_SYNTHETIC_GUIDANCE' });
  assert.deepEqual(saved, { status: 200, body: { revision: 1, text: 'PRIVATE_SYNTHETIC_GUIDANCE' } });
  assert.equal((await request('/guidance', 'POST', { revision: 0, text: 'stale' })).status, 409);
  await request('/connection', 'POST', { endpoint: 'http://127.0.0.1:1234' });
  assert.equal((await request('/dispatch', 'POST', { requestId: 'guidance-test', sessionId: 'garden', directory: '/fixture', text: 'hello', guidance: 'ignored' })).body.status, 'accepted');
  assert.deepEqual(sent, [{ text: 'hello' }]);
  assert.ok(!(await readFile(`${configFile}.dispatch.json`, 'utf8')).includes('GUIDANCE'));
  const restarted = await createMaxwellService({ token: 'restart', configFile });
  await new Promise(resolve => restarted.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => restarted.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${restarted.address().port}/guidance`, { headers: { authorization: 'Bearer restart' } });
  assert.deepEqual(await response.json(), saved.body);
});
