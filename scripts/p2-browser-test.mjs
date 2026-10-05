import { chromium } from 'playwright';
import assert from 'node:assert/strict';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1060, height: 1000 } });
const errors = []; page.on('pageerror', e => errors.push(e.message));
let f;
async function saved() { await f.waitForFunction(() => document.querySelector('[data-save-status]')?.textContent === '已保存'); }
async function select(id) { const point = await f.evaluate(id => window.chemP0.atomPoint(id), id); await page.mouse.click(point.x, point.y + (await page.locator('iframe').boundingBox()).y); }
async function loadBenzene() { await f.getByRole('button', { name: '苯', exact: true }).click(); await f.waitForFunction(() => !document.querySelector('.chem-busy') && window.chemP0.ketcher.editor.struct().atoms.size === 6); await saved(); }
try {
  await page.goto('http://127.0.0.1:3099/session-a', { waitUntil: 'domcontentloaded' });
  await page.locator('iframe').waitFor(); f = await (await page.locator('iframe').elementHandle()).contentFrame();
  await f.waitForFunction(() => !!window.chemP0 && !document.querySelector('.chem-busy')); await saved(); await loadBenzene();
  const original = await f.evaluate(() => window.chemP0.fingerprint());
  await select(1);
  await f.getByLabel('对选区的批注').fill('把选中的 C 换成 N');
  await f.getByRole('button', { name: '交给 Agent', exact: true }).click();
  await f.locator('[data-annotation-status="queued"],[data-annotation-status="validating"],[data-annotation-status="proposed"]').waitFor();
  await select(3);
  await f.locator('[data-preview-id]').waitFor({ timeout: 40000 });
  assert.deepEqual(await f.evaluate(() => window.chemP0.fingerprint()), original, 'preview must retain the original molecule');
  await f.getByRole('button', { name: '应用修改', exact: true }).click(); await saved();
  await f.locator('[data-annotation-status="applied"]').waitFor();
  const expected = structuredClone(original); expected.atoms.find(([id]) => id === 1)[1].label = 'N';
  assert.deepEqual(await f.evaluate(() => window.chemP0.fingerprint()), expected, 'apply must change the frozen atom, not the later selected atom');
  await f.getByRole('button', { name: '撤销', exact: true }).click(); await saved();
  assert.deepEqual(await f.evaluate(() => window.chemP0.fingerprint()), original);
  console.log('PASS P2 frozen target, validated two-structure preview, apply, autosave and undo');

  await select(2); await f.getByLabel('对选区的批注').fill('换成 N'); await f.getByRole('button', { name: '交给 Agent', exact: true }).click();
  await f.locator('[data-preview-id]').waitFor({ timeout: 40000 });
  await f.getByRole('button', { name: '取消批注', exact: true }).first().click();
  await f.locator('[data-annotation-status="cancelled"]').waitFor(); assert.deepEqual(await f.evaluate(() => window.chemP0.fingerprint()), original);
  console.log('PASS cancel preserves original molecule');

  await select(1); await f.getByLabel('对选区的批注').fill('替换为 F'); await f.getByRole('button', { name: '交给 Agent', exact: true }).click();
  await f.locator('[data-annotation-status="failed"]').waitFor({ timeout: 40000 });
  assert.deepEqual(await f.evaluate(() => window.chemP0.fingerprint()), original);
  assert.equal(await f.locator('[data-preview-id]').count(), 0);
  console.log('PASS invalid valence cannot reach apply');

  await select(1); await f.getByLabel('对选区的批注').fill('换成 N'); await f.getByRole('button', { name: '交给 Agent', exact: true }).click();
  await f.locator('[data-preview-id]').waitFor({ timeout: 40000 });
  await f.getByRole('button', { name: '阿司匹林', exact: true }).click(); await saved();
  await f.locator('[data-annotation-status="stale"]').waitFor(); assert.equal(await f.getByRole('button', { name: '应用修改', exact: true }).count(), 0);
  const calls = await (await page.request.get('http://127.0.0.1:3099/test/agent-calls')).json();
  assert.ok(calls.some(c => c.tool === 'chem_get_context')); assert.ok(calls.some(c => c.tool === 'chem_propose_edit'));
  assert.deepEqual(errors, []); await page.screenshot({ path: 'test-results/p2-batch.png' });
  console.log('ALL-PASS: P2 UI/tool bridge acceptance (deterministic model fixture)');
} catch (e) {
  await page.screenshot({ path: 'test-results/p2-failure.png' });
  if (f) {
    console.log('P2 DIAGNOSTIC', (await f.locator('body').innerText()).slice(-2200));
    const id = await f.locator('[data-preview-id]').first().getAttribute('data-preview-id').catch(() => null);
    if (id) {
      const response = await page.evaluate(async id => (await (await fetch('/api/chem-editor/annotation-detail', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'debug', method: 'chem-editor/annotation-detail', payload: { sessionId: 'session-a', annotationId: id } }) })).json()).result, id);
      const before = JSON.parse(response.value.frozen.rawKet), after = JSON.parse(await f.evaluate(() => window.chemP0.ketcher.getKet()));
      const diffs = []; function compare(a,b,path='$') { if (typeof a === 'number' && typeof b === 'number' && Math.abs(a-b)<0.00001 || JSON.stringify(a) === JSON.stringify(b)) return; if (a && b && typeof a==='object' && typeof b==='object') { for (const key of new Set([...Object.keys(a),...Object.keys(b)])) compare(a[key],b[key],path+'.'+key); } else diffs.push([path,a,b]); }
      compare(before,after); console.log('KET DIFF',diffs.slice(0,15));
    }
  }
  throw e;
}
finally { await browser.close(); }
