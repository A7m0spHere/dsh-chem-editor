import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1060, height: 950 }, acceptDownloads: true });
const errors = [];
const page = await context.newPage();
context.on('page', p => p.on('pageerror', e => errors.push(e.message)));
page.on('pageerror', e => errors.push(e.message));
async function editor(p) {
  await p.locator('iframe').waitFor();
  const element = await p.locator('iframe').elementHandle(); const f = await element.contentFrame();
  await f.waitForFunction(() => window.chemP0?.ketcher.editor.struct().atoms.size > 0 && !document.querySelector('.chem-busy'));
  return f;
}
async function saved(f) { await f.waitForFunction(() => /^(已保存|Saved)$/.test(document.querySelector('[data-save-status]')?.textContent || '')); }
const identity = f => f.evaluate(() => window.chemP0.ketcher.getInchi());
const workspaceDocument = async sessionId => {
  const r = await page.evaluate(async sessionId => (await (await fetch('/api/chem-editor/bootstrap', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', method: 'chem-editor/bootstrap', rpcId: 'test-read', payload: { sessionId } }) })).json()).result, sessionId);
  assert.equal(r.ok, true); return r.value;
};
try {
  await page.goto('http://127.0.0.1:3099/session-a', { waitUntil: 'domcontentloaded' });
  let f = await editor(page); await saved(f);
  await f.getByRole('button', { name: '阿司匹林', exact: true }).click();
  await f.waitForFunction(() => window.chemP0.ketcher.editor.struct().atoms.size === 13 && !document.querySelector('.chem-busy'));
  const aspirin = await identity(f);
  await f.getByLabel('文档名称').fill('P1 中文持久化测试');
  await page.getByRole('button', { name: '关闭面板' }).click();
  assert.equal(await page.locator('iframe').count(), 1, 'unsaved close must retain the editor');
  await saved(f);
  const a = await workspaceDocument('session-a');
  assert.equal(a.document.title, 'P1 中文持久化测试');
  assert.ok(a.path.includes('.chem-editor'));
  const file = JSON.parse(await readFile(a.path, 'utf8'));
  assert.equal(file.title, 'P1 中文持久化测试'); assert.equal(file.sessionId, 'session-a');
  await page.getByRole('button', { name: '关闭面板' }).click();
  assert.equal(await page.locator('iframe').count(), 0);
  await page.getByRole('button', { name: '重开面板' }).click();
  f = await editor(page); assert.equal(await identity(f), aspirin); await saved(f);
  assert.equal(await f.getByLabel('文档名称').inputValue(), 'P1 中文持久化测试');
  assert.equal(await f.locator('[data-testid="select-rectangle"]:visible').getAttribute('title'), '矩形选择 (Shift+Tab)');
  await page.reload({ waitUntil: 'domcontentloaded' }); f = await editor(page); assert.equal(await identity(f), aspirin); await saved(f);
  assert.deepEqual(await f.evaluate(() => window.chemP0.ketcher.editor.selection()), null, 'restore must clear revision-local atom IDs');
  console.log('PASS durable workspace file, unsaved-close guard, close/reopen and reload');

  const b = await context.newPage(); await b.goto('http://127.0.0.1:3099/session-b', { waitUntil: 'domcontentloaded' });
  const fb = await editor(b); await saved(fb);
  assert.notEqual(await identity(fb), aspirin);
  await fb.getByRole('button', { name: '含手性多环示例', exact: true }).click();
  await fb.waitForFunction(() => window.chemP0.ketcher.editor.struct().atoms.size > 20 && !document.querySelector('.chem-busy')); await saved(fb);
  assert.equal(await identity(f), aspirin); assert.notEqual((await workspaceDocument('session-b')).path, a.path);
  console.log('PASS session isolation with different molecules');

  await f.locator('.chem-heading select').selectOption('en'); await saved(f);
  await f.waitForFunction(() => document.documentElement.lang === 'en');
  assert.match(await f.locator('[data-testid="select-rectangle"]:visible').getAttribute('title'), /Rectangle Selection/);
  assert.equal(await identity(f), aspirin);
  await f.locator('.chem-heading select').selectOption('zh-CN'); await saved(f);
  await f.locator('[title^="设置"]:visible').click();
  await f.getByText('常规', { exact: true }).waitFor();
  await f.getByRole('button', { name: '取消', exact: true }).last().click();
  await f.locator('[data-testid="save-file-button"]:visible').click();
  await f.getByText('导出结构', { exact: true }).waitFor();
  await f.getByRole('button', { name: '取消', exact: true }).last().click();
  assert.equal(await identity(f), aspirin);
  console.log('PASS Chinese tooltips/dialogs and live English switch without structure loss');

  await f.locator('.chem-actions summary').click();
  const projectDownload = page.waitForEvent('download'); await f.getByRole('button', { name: '项目文档', exact: true }).click();
  const download = await projectDownload; await download.saveAs('test-results/p1-project.chem.json');
  const project = JSON.parse(await readFile('test-results/p1-project.chem.json', 'utf8'));
  assert.equal(project.title, 'P1 中文持久化测试'); assert.equal(project.schemaVersion, 1); assert.equal(project.language, 'zh-CN');
  const svgDownload = page.waitForEvent('download'); await f.getByRole('button', { name: 'SVG', exact: true }).click();
  const svg = await svgDownload; await svg.saveAs('test-results/p1-export.svg');
  assert.match(await readFile('test-results/p1-export.svg', 'utf8'), /<svg[\s>]/);
  await f.locator('.chem-import input[type="file"]').setInputFiles('test-results/p1-project.chem.json');
  await f.waitForFunction(() => !document.querySelector('.chem-busy')); await saved(f); assert.equal(await identity(f), aspirin);
  console.log('PASS portable project export/import and SVG export');

  const beforeFailure = await workspaceDocument('session-a');
  await page.evaluate(() => fetch('/test/fail-next-save'));
  await f.getByLabel('文档名称').fill('尚未保存的名字');
  await f.getByRole('alert').filter({ hasText: '模拟保存失败' }).waitFor();
  assert.equal((await workspaceDocument('session-a')).document.title, beforeFailure.document.title);
  await f.getByRole('button', { name: '立即保存', exact: true }).click(); await saved(f);
  assert.equal((await workspaceDocument('session-a')).document.title, '尚未保存的名字');
  console.log('PASS failed save retains disk and canvas, explicit retry succeeds');

  const beforeOther = await workspaceDocument('session-a');
  const other = await context.newPage(); await other.goto('http://127.0.0.1:3099/session-a', { waitUntil: 'domcontentloaded' });
  const fo = await editor(other); await saved(fo);
  assert.equal((await workspaceDocument('session-a')).token, beforeOther.token, 'opening another window must not rewrite the document');
  await f.getByLabel('文档名称').fill('窗口 A 最新版本'); await saved(f);
  await fo.getByLabel('文档名称').fill('窗口 B 过期版本');
  await fo.getByRole('alert').filter({ hasText: '其他窗口或外部程序已修改文档' }).waitFor();
  assert.equal((await workspaceDocument('session-a')).document.title, '窗口 A 最新版本');
  other.on('dialog', dialog => dialog.accept());
  await fo.getByRole('button', { name: '重新载入已保存版本', exact: true }).click();
  await fo.waitForFunction(() => document.querySelector('.chem-document input')?.value === '窗口 A 最新版本'); await saved(fo);
  assert.deepEqual(errors, []);
  await other.screenshot({ path: 'test-results/p1-chinese.png' });
  console.log('PASS stale-window conflict and reload of saved document');
  console.log('ALL-PASS: P1 persistence and Chinese UI acceptance');
} catch (e) {
  await page.screenshot({ path: 'test-results/p1-failure.png' });
  const current = page.frames().find(f => f.url().includes('managed=1'));
  if (current) console.log('DIAGNOSTIC', (await current.locator('body').innerText()).slice(-4000));
  throw e;
} finally { await browser.close(); }
