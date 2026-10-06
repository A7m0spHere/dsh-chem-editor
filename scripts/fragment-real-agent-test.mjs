// Requires a separately started, configured DSH Web profile. Auth URLs stay in ignored logs.
import { chromium } from 'playwright';
import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const log = await readFile(process.env.CHEM_DSH_LOG || 'test-results/propyl-live-runtime.log', 'utf8');
const url = log.match(/dsh web:\s*(https?:\/\/[^\s]+)/)?.[1];
if (!url) throw new Error('DSH launch URL unavailable');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
const errors = [], evidence = []; let frame;
page.on('pageerror', e => errors.push(e.message));
const fingerprint = () => frame.evaluate(() => window.chemP0.fingerprint());
async function saved() { await frame.waitForFunction(() => document.querySelector('[data-save-status]')?.textContent === '已保存' && !document.querySelector('.chem-busy')); }
async function select(id) {
  const p = await frame.evaluate(id => window.chemP0.atomPoint(id), id), r = await page.locator('iframe[title="分子编辑器"]').boundingBox();
  await page.mouse.click(r.x + p.x, r.y + p.y);
}
async function submit(instruction) {
  await saved();
  const previous = await frame.locator('[data-annotation-id]').getAttribute('data-annotation-id').catch(() => null);
  await frame.getByLabel('对选区的批注').fill(instruction);
  await frame.getByRole('button', { name: '交给 Agent', exact: true }).click();
  await frame.waitForFunction(previous => {
    const el = document.querySelector('[data-annotation-id]');
    return el?.getAttribute('data-annotation-id') !== previous && ['proposed', 'failed'].includes(el?.getAttribute('data-annotation-status'));
  }, previous, { timeout: 240000 });
}
try {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  for (let i = 0; i < 2; i++) await page.getByRole('button', { name: '继续', exact: true }).waitFor({ timeout: 3000 }).then(() => page.getByRole('button', { name: '继续', exact: true }).click()).catch(() => {});
  await page.getByText('新会话', { exact: true }).last().click();
  await page.locator('[contenteditable="true"]').waitFor();
  await page.locator('[contenteditable="true"]').fill('本会话用于分子编辑器丙基验证。请只回复“准备好了”，不要调用工具。');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.getByText('准备好了', { exact: true }).last().waitFor({ timeout: 180000 });
  await page.getByRole('button', { name: '打开分子工作区', exact: true }).click();
  await page.locator('iframe[title="分子编辑器"]').waitFor();
  frame = await (await page.locator('iframe[title="分子编辑器"]').elementHandle()).contentFrame();
  await frame.waitForFunction(() => !!window.chemP0 && !document.querySelector('.chem-busy')); await saved();
  await frame.getByRole('button', { name: '显示操作区', exact: true }).click();
  await frame.locator('.chem-import-menu > summary').click();
  await frame.getByLabel('导入 SMILES', { exact: true }).fill('CCCO');
  await frame.getByRole('button', { name: '载入', exact: true }).click();
  await frame.waitForFunction(() => window.chemP0.ketcher.editor.struct().atoms.size === 4); await saved();
  for (const [instruction, name, branched] of [['加一个丙基', '正丙基', false], ['添加异丙基', '异丙基', true]]) {
    const before = await fingerprint(), anchor = before.atoms[0][0]; await select(anchor);
    console.log('LIVE submitted', name); await submit(instruction);
    await frame.locator('[data-preview-id]').waitFor({ timeout: 5000 });
    await frame.locator('.chem-preview').getByText(new RegExp(`添加 ${name}`)).waitFor();
    assert.deepEqual(await fingerprint(), before);
    const id = await frame.locator('[data-preview-id]').getAttribute('data-preview-id');
    await page.screenshot({ path: `test-results/propyl-real-${branched ? 'iso' : 'normal'}-preview.png` });
    await frame.getByRole('button', { name: '应用修改', exact: true }).click();
    await frame.locator('[data-annotation-status="applied"]').waitFor(); await saved();
    const after = await fingerprint(), ids = after.atoms.slice(before.atoms.length).map(([id]) => id);
    assert.equal(ids.length, 3); assert.deepEqual(after.atoms.slice(0, before.atoms.length), before.atoms);
    assert.deepEqual(after.bonds.slice(before.bonds.length).map(([, b]) => [b.begin, b.end]), [[anchor, ids[0]], [ids[0], ids[1]], [branched ? ids[0] : ids[1], ids[2]]]);
    await frame.getByRole('button', { name: '撤销', exact: true }).click(); await saved(); assert.deepEqual(await fingerprint(), before);
    evidence.push({ instruction, fragment: name, annotationId: id, previewRetainedOriginal: true, correctTopology: true, appliedAndSaved: true, oneStepUndo: true });
  }
  const before = await fingerprint(); await select(before.atoms[0][0]); await submit('添加苄基');
  await frame.locator('[data-annotation-error="unsupported_fragment"]').waitFor(); assert.deepEqual(await fingerprint(), before);
  evidence.push({ instruction: '添加苄基', failureReasonInPanel: true, unchangedCanvas: true });
  assert.deepEqual(errors, []);
  await writeFile('test-results/propyl-real-agent.json', JSON.stringify({ date: new Date().toISOString(), runtime: 'official DSH Web', evidence, browserErrors: errors }, null, 2));
  console.log('ALL-PASS: real DSH Agent propyl/isopropyl preview/apply/save/undo and rejection feedback');
} catch (e) {
  await page.screenshot({ path: 'test-results/propyl-real-agent-failure.png' });
  console.log('LIVE failure:', String(e.message).replace(/https?:\/\/\S+/g, '[URL]'));
  throw new Error('Real DSH Agent verification failed; see the local screenshot and runtime log.');
} finally { await browser.close(); }
