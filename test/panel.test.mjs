import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { browserHarness } from './browser-harness.mjs';

let harness;
before(async () => { harness = await browserHarness(); });
after(async () => { await harness?.close(); });

async function settled(page) {
  await expect(page.locator('#route')).toHaveAttribute('data-state', 'settled', { timeout: 4000 });
}

async function selectSources(page) {
  // Source controls may live in a disclosure rather than the main reading view.
  const control = page.locator('[data-session="fixture-ops"]');
  if (!await control.isVisible()) {
    const opener = page.getByRole('button', { name: /sources|sessions/i }).first();
    if (await opener.count()) await opener.click();
  }
  await control.click();
  await page.locator('[data-session="fixture-course"]').click();
  const close = page.getByRole('button', { name: /close sources|close sessions/i });
  if (await close.count()) await close.click();
}

test('Enter defaults to continuity; numbered choices select explicit overrides without sending', async () => {
  const page = await harness.page();
  try {
    await selectSources(page);
    const draft = page.locator('#draft');
    await draft.fill('Sensitive ops deployment');
    await draft.press('Enter');
    assert.equal(await page.evaluate(() => window.__fixture.sent.length), 0);
    await settled(page);
    await draft.press('Enter');
    assert.equal(await page.evaluate(() => window.__fixture.sent.length), 0, 'no previous destination');
    await draft.press('Control+1');
    assert.equal(await page.evaluate(() => window.__fixture.sent.length), 0, 'numbered shortcut selects, never sends');
    await draft.press('Enter');
    await expect.poll(() => page.evaluate(() => window.__fixture.sent.length)).toBe(1);
    await expect(draft).toHaveValue('');
    await draft.fill('Sensitive ops followup');
    await settled(page);
    await draft.press('Enter');
    await expect.poll(() => page.evaluate(() => window.__fixture.sent.length)).toBe(2);
    await expect(draft).toHaveValue('');
    await draft.fill('Course webpage syllabus');
    await draft.press('Enter');
    assert.equal(await page.evaluate(() => window.__fixture.sent.length), 2, 'fresh draft must be reevaluated');
    await settled(page);
    await draft.press('Enter');
    assert.equal(await page.evaluate(() => window.__fixture.sent.length), 2, 'new route does not agree with previous destination');
    await draft.press('Control+1');
    assert.equal(await page.evaluate(() => window.__fixture.sent.length), 2, 'override selects without sending');
    await draft.press('Enter');
    await expect.poll(() => page.evaluate(() => window.__fixture.sent.length)).toBe(3);
    const sent = await page.evaluate(() => window.__fixture.sent);
    assert.deepEqual(sent.map(s => [s.sessionId, s.text]), [
      ['fixture-ops', 'Sensitive ops deployment'], ['fixture-ops', 'Sensitive ops followup'], ['fixture-ops', 'Course webpage syllabus'],
    ]);
  } finally { await page.close(); }
});

test('in-flight sends do not duplicate or erase a newer draft', async () => {
  const page = await harness.page({ delay: 500 });
  try {
    await selectSources(page);
    const draft = page.locator('#draft');
    await draft.fill('Sensitive ops deployment');
    await settled(page);
    await draft.press('Control+1');
    await draft.press('Enter');
    await draft.press('Enter');
    await draft.fill('Course webpage next thought');
    await draft.press('Control+2');
    await expect.poll(() => page.evaluate(() => window.__fixture.sent.length)).toBe(1);
    await expect(page.locator('#status')).toContainText(/accepted|sent/i, { timeout: 4000 });
    await expect(draft).toHaveValue('Course webpage next thought');
    await expect(page.locator('#send')).toContainText('Course webpage');
    await expect(page.locator('#send')).toBeEnabled();
  } finally { await page.close(); }
});

test('uncertain delivery retains the draft and cannot be blindly resent', async () => {
  const page = await harness.page({ outcome: 'uncertain' });
  try {
    await selectSources(page);
    const draft = page.locator('#draft');
    await draft.fill('Sensitive ops deployment');
    await settled(page);
    await draft.press('Control+1');
    await draft.press('Enter');
    await expect(page.locator('#status')).toContainText(/uncertain|unknown|verify|inspect/i);
    await expect(draft).toHaveValue('Sensitive ops deployment');
    await draft.press('Control+1');
    await draft.press('Enter');
    const sent = await page.evaluate(() => window.__fixture.sent);
    assert.ok(sent.length === 1 || sent.every(s => s.requestId === sent[0].requestId), 'same unresolved send cannot get a new identity');
  } finally { await page.close(); }
});

test('unconfigured live connection is not reported connected', async () => {
  const page = await harness.page({ connected: false });
  try {
    await expect(page.locator('body')).toContainText(/unconfigured|not configured|unavailable|configure/i);
    assert.equal(await page.evaluate(() => window.__fixture.sent.length), 0);
  } finally { await page.close(); }
});

test('explicit send targets the recommendation; Stop response targets only that session', async () => {
  const page = await harness.page();
  try {
    await selectSources(page);
    await page.locator('#draft').fill('Course webpage next edit');
    await settled(page);
    await expect(page.locator('#send')).toBeDisabled();
    await page.locator('#draft').press('Control+2');
    await page.locator('#send').click();
    await expect.poll(() => page.evaluate(() => window.__fixture.sent.length)).toBe(1);
    assert.equal(await page.evaluate(() => window.__fixture.sent[0].sessionId), 'fixture-course');
    await page.getByRole('button', { name: /stop response/i }).first().click();
    await expect.poll(() => page.evaluate(() => window.__fixture.stopped.length)).toBe(1);
    assert.deepEqual(await page.evaluate(() => window.__fixture.stopped[0]), { sessionId: 'fixture-course', directory: '/fixture/studio' });
  } finally { await page.close(); }
});

test('human selection survives edits and can override an unavailable router', async () => {
  const page = await harness.page();
  try {
    await selectSources(page);
    await page.evaluate(() => { window.__fixture.recommendationUnavailable = true; });
    const draft = page.locator('#draft');
    await draft.fill('A deliberately ambiguous draft');
    await draft.press('Control+2');
    await draft.fill('The revised draft still belongs to my explicitly selected conversation.');
    await expect(page.locator('#send')).toBeEnabled();
    assert.equal(await page.evaluate(() => window.__fixture.sent.length), 0);
    await draft.press('Enter');
    await expect.poll(() => page.evaluate(() => window.__fixture.sent.length)).toBe(1);
    assert.equal(await page.evaluate(() => window.__fixture.sent[0].sessionId), 'fixture-course');
    await expect(draft).toHaveValue('');
    await draft.fill('A fresh draft has no inherited human selection');
    await draft.press('Enter');
    assert.equal(await page.evaluate(() => window.__fixture.sent.length), 1);
  } finally { await page.close(); }
});

test('composer keeps the previous recipient during disagreement and Reply here selects below the conversation', async () => {
  const page=await harness.page();
  try {
    await selectSources(page);
    const draft=page.locator('#draft');
    await draft.fill('Ops deployment');
    await draft.press('Control+1');
    await draft.press('Enter');
    await expect(draft).toHaveValue('');
    await draft.fill('Course webpage syllabus');
    await settled(page);
    await expect(page.locator('#send')).toContainText('Sensitive ops');
    await expect(page.locator('#send')).toBeDisabled();
    await expect(page.locator('.composer')).toContainText('This draft refers to the course webpage');
    assert.equal(await page.evaluate(()=>window.__fixture.sent.length),1);
    const reply=page.locator('.run').filter({hasText:'Synthetic course exchange.'}).getByRole('button',{name:'Reply here in Course webpage',exact:true});
    await expect(reply).toBeVisible();
    assert.equal(await reply.evaluate(el=>!!el.closest('.run-head')),false);
    await reply.click();
    await expect(page.locator('#send')).toContainText('Course webpage');
    await expect(page.locator('#send')).toBeEnabled();
    assert.equal(await page.evaluate(()=>window.__fixture.sent.length),1,'Reply here only selects');
  } finally {await page.close();}
});

test('abort recovery never arms Enter, but explicit human selection still overrides', async () => {
  const page=await harness.page();
  try {
    await selectSources(page);
    const draft=page.locator('#draft');
    await draft.fill('Course webpage');
    await draft.press('Control+2');
    await draft.press('Enter');
    await expect(draft).toHaveValue('');
    await page.evaluate(()=>{window.__fixture.routingOverride={sessionId:null,outcome:'abort',recovery:{action:'reroute',sessionId:'fixture-course'}};});
    await draft.fill('A synthetic draft that needs review');
    await settled(page);
    await expect(page.locator('#route-advice')).toBeVisible();
    await expect(page.locator('#send')).toBeDisabled();
    await draft.press('Enter');
    assert.equal(await page.evaluate(()=>window.__fixture.sent.length),1,'recovery is not primary agreement even when it names last recipient');
    await draft.press('Control+1');
    await expect(page.locator('#send')).toBeEnabled();
    await draft.press('Enter');
    await expect.poll(()=>page.evaluate(()=>window.__fixture.sent.length)).toBe(2);
    assert.equal(await page.evaluate(()=>window.__fixture.sent[1].sessionId),'fixture-ops');
  } finally {await page.close();}
});

test('management proposes an aside and waits for explicit creation', async () => {
  const page = await harness.page();
  try {
    await selectSources(page);
    await page.keyboard.press('Control+k');
    await page.locator('#manageText').fill('Start an independent synthetic aside.');
    await page.locator('#manageForm button[type="submit"]').click();
    await page.getByRole('button', { name: 'Review aside', exact: true }).click();
    assert.equal(await page.evaluate(() => window.__fixture.creates.length), 0);
    await expect(page.locator('#asideTitle')).toHaveValue('Synthetic aside');
    await expect(page.locator('#asideText')).toHaveValue('A synthetic initial message.');
    await page.locator('#asideGo').click();
    await expect.poll(() => page.evaluate(() => window.__fixture.creates.length)).toBe(1);
    const created = await page.evaluate(() => window.__fixture.creates[0]);
    assert.equal(created.projectId, 'fixture-project');
    assert.equal(created.text, 'A synthetic initial message.');
    assert.equal(created.navigation, 'preserve');
  } finally { await page.close(); }
});

test('Ask Maxwell retains follow-ups privately and can start a fresh conversation', async () => {
  const page = await harness.page();
  try {
    await page.keyboard.press('Control+k');
    await page.locator('#manageText').fill('What tools do you have available?');
    await page.locator('#manageForm button[type="submit"]').click();
    await expect(page.locator('#manageResults')).toContainText('propose an aside');
    await expect(page.locator('#manageResults')).toContainText('propose an aside');
    assert.equal(await page.evaluate(() => window.__fixture.creates.length), 0);
    assert.equal(await page.evaluate(() => window.__fixture.sent.length), 0);
    await page.locator('#manageText').fill('Explain those tools again');
    await page.locator('#manageForm button[type="submit"]').click();
    await expect.poll(() => page.evaluate(() => window.__fixture.lastManagement.conversation.length)).toBe(2);
    const turns=await page.evaluate(() => window.__fixture.lastManagement.conversation);
    assert.equal(turns[0].text,'What tools do you have available?');
    assert.equal(turns[1].role,'assistant');
    await expect(page.getByRole('button',{name:'New conversation',exact:true})).toBeEnabled();
    await page.getByRole('button',{name:'New conversation',exact:true}).click();
    await expect(page.locator('#manageResults')).not.toContainText('What tools do you have available?');
    await page.locator('#manageText').fill('What tools now?');
    await page.locator('#manageForm button[type="submit"]').click();
    await expect.poll(() => page.evaluate(() => window.__fixture.lastManagement.conversation.length)).toBe(0);
  } finally { await page.close(); }
});

test('guidance proposals require review and conflicts preserve edited text', async () => {
  const page=await harness.page();
  try {
    await page.keyboard.press('Control+k');
    await page.locator('#manageText').fill('Remember this guidance');
    await page.locator('#manageForm button[type="submit"]').click();
    await page.getByRole('button',{name:'Review guidance',exact:true}).click();
    assert.equal(await page.evaluate(()=>window.__fixture.guidance.revision),0);
    await page.locator('#guidanceSave').click();
    await expect(page.locator('#guidanceStatus')).toContainText('Guidance saved');
    await page.locator('#guidanceText').fill('My unsaved guidance');
    await page.evaluate(()=>{window.__fixture.guidance={revision:2,text:'A concurrent update'};});
    await page.locator('#guidanceSave').click();
    await expect(page.locator('#guidanceStatus')).toContainText('edits are preserved');
    await expect(page.locator('#guidanceText')).toHaveValue('My unsaved guidance');
    assert.equal(await page.evaluate(()=>window.__fixture.sent.length),0);
    await page.locator('#guidanceReload').click();
    await expect(page.locator('#guidanceText')).toHaveValue('A concurrent update');
  } finally {await page.close();}
});

test('continuous session runs render safe Markdown and native session links', async () => {
  const page = await harness.page();
  try {
    await page.evaluate(() => {
      const state = window.__fixture;
      state.messages = [
        { ...state.messages[0], text: '**Operations**\n\n- One\n- Two\n\n<img src="x" onerror="window.__unsafe=true"><script>window.__unsafe=true</script>' },
        { ...state.messages[0], id: 'fixture-m3', role: 'user', text: 'Continue this run.', createdAt: 1500 },
        state.messages[1],
      ];
      state.bump();
    });
    await selectSources(page);
    await expect(page.locator('#feed .run')).toHaveCount(2);
    await expect(page.locator('#feed .run').first().locator('.msg')).toHaveCount(2);
    await expect(page.locator('#feed strong').first()).toHaveText('Operations');
    await expect(page.locator('#feed li')).toHaveCount(2);
    await expect(page.locator('#feed script, #feed [onerror]')).toHaveCount(0);
    const link = page.locator('#feed .session-link').first();
    await expect(link).toHaveAttribute('href', 'openchamber://session/fixture-ops?dir=%2Ffixture%2Fstudio');
    await link.click();
    assert.deepEqual(await page.evaluate(() => window.__fixture.opened), ['fixture-ops']);
  } finally { await page.close(); }
});

test('streamed snapshots extend an existing assistant message without duplication', async () => {
  const page = await harness.page();
  try {
    await selectSources(page);
    await expect(page.locator('#feed')).toContainText('Synthetic ops exchange.');
    await page.evaluate(() => { window.__fixture.messages[0].text = '**Streaming** first portion'; window.__fixture.bump(); });
    await expect(page.locator('#feed')).toContainText('Streaming first portion');
    await page.evaluate(() => { window.__fixture.messages[0].text += ', then the next portion.'; window.__fixture.bump(); });
    await expect(page.locator('#feed')).toContainText('then the next portion.');
    await expect(page.locator('#feed .msg')).toHaveCount(2);
  } finally { await page.close(); }
});
