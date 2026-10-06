import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await mkdir('test-results', { recursive: true });
let frame;
const box = selector => frame.locator(selector).boundingBox();
const fingerprint = () => frame.evaluate(() => window.chemP0.fingerprint());
async function assertFits() {
  await frame.waitForFunction(() => {
    const k = window.chemP0.ketcher, rect = k.editor.render.clientArea.getBoundingClientRect();
    return [...k.editor.struct().atoms.keys()].every(id => {
      const p = window.chemP0.atomPoint(id);
      return p.x >= rect.left && p.x <= rect.right && p.y >= rect.top && p.y <= rect.bottom;
    });
  }, {}, { timeout: 5000 });
  const layout = await frame.evaluate(() => ({
    width: innerWidth, height: innerHeight,
    overflow: document.documentElement.scrollWidth > innerWidth,
    canvas: document.querySelector('.chem-canvas').getBoundingClientRect().toJSON(),
    tools: document.querySelector('.chem-footer').getBoundingClientRect().toJSON(),
  }));
  assert.equal(layout.overflow, false, 'the panel must not overflow horizontally');
  assert.ok(layout.canvas.height >= 200, 'the drawing area must retain useful height');
  assert.ok(layout.canvas.bottom <= layout.height + 1);
  assert.ok(layout.tools.bottom <= layout.height + 1, 'tools must scroll inside the panel');
  for (const group of await frame.locator('[data-testid="top-toolbar"]:visible > div:visible').all()) {
    const bounds = await group.boundingBox();
    const carrier = await page.locator('iframe').boundingBox();
    assert.ok(bounds.x + bounds.width <= carrier.x + layout.width + 1, 'toolbar groups must remain reachable in narrow panels');
  }
  return layout;
}
try {
  await page.goto('http://127.0.0.1:3099/session-b');
  await page.locator('iframe').waitFor();
  frame = await (await page.locator('iframe').elementHandle()).contentFrame();
  await frame.waitForFunction(() => window.chemP0?.ketcher.editor.struct().atoms.size > 0 && document.querySelector('[data-save-status]')?.textContent === '已保存');
  await frame.getByRole('button', { name: '苯', exact: true }).click();
  await frame.waitForFunction(() => window.ketcher.editor.struct().atoms.size === 6 && !document.querySelector('.chem-busy'));
  await frame.evaluate(() => { window.layoutInstance = window.ketcher; });
  let original = await fingerprint();
  const primary = await assertFits();
  assert.ok(primary.canvas.width > 1200 && primary.canvas.height > 700, 'the canvas must open as the main workspace');
  assert.equal(await frame.locator('.chem-footer').isVisible(), false, 'auxiliary editing controls start collapsed');
  await page.screenshot({ path: 'test-results/layout-primary.png' });
  await page.getByRole('button', { name: 'DSH 助手', exact: true }).click();
  await page.getByLabel('DSH 助手草稿').fill('保留助手草稿');
  assert.ok((await box('.chem-canvas')).width > primary.canvas.width * .65, 'the canvas must retain most of the workspace beside the assistant');
  await page.getByRole('button', { name: '收起 DSH 助手', exact: true }).click();
  await page.getByRole('button', { name: 'DSH 助手', exact: true }).click();
  assert.equal(await page.getByLabel('DSH 助手草稿').inputValue(), '保留助手草稿');
  await page.screenshot({ path: 'test-results/layout-assistant.png' });
  await page.getByRole('button', { name: '收起 DSH 助手', exact: true }).click();
  assert.equal(await frame.evaluate(() => window.ketcher === window.layoutInstance), true);
  assert.deepEqual(await fingerprint(), original, 'opening native chat must retain the molecular document');
  await page.setViewportSize({ width: 480, height: 800 });
  await frame.getByRole('button', { name: '显示操作区', exact: true }).click();
  const layout = await assertFits();
  await page.screenshot({ path: 'test-results/layout-sidebar.png' });

  await frame.locator('.chem-import-menu > summary').click();
  assert.equal((await box('.chem-canvas')).height, layout.canvas.height, 'opening import must not shrink the editor');
  await frame.getByLabel('导入 SMILES', { exact: true }).fill('CCO');
  await frame.getByRole('button', { name: '载入', exact: true }).click();
  await frame.waitForFunction(() => window.ketcher.editor.struct().atoms.size === 3 && !document.querySelector('.chem-import-menu').open);
  await frame.getByRole('button', { name: '苯', exact: true }).click();
  await frame.waitForFunction(() => window.ketcher.editor.struct().atoms.size === 6 && !document.querySelector('.chem-busy'));
  original = await fingerprint();

  const point = await frame.evaluate(() => window.chemP0.atomPoint(1));
  const iframe = await page.locator('iframe').boundingBox();
  await page.mouse.click(point.x + iframe.x, point.y + iframe.y);
  assert.deepEqual(await frame.evaluate(() => window.ketcher.editor.selection().atoms), [1]);
  const divider = await box('.chem-divider');
  await page.mouse.move(divider.x + divider.width / 2, divider.y + divider.height / 2);
  await page.mouse.down();
  await page.mouse.move(divider.x + divider.width / 2, divider.y + 65, { steps: 8 });
  await page.mouse.up();
  assert.ok((await box('.chem-canvas')).height > layout.canvas.height + 40);
  const dragged = (await box('.chem-canvas')).height;
  await frame.getByRole('separator', { name: '调整操作区大小' }).press('ArrowUp');
  assert.ok((await box('.chem-canvas')).height < dragged - 15, 'keyboard resizing must enlarge the tools track');
  assert.deepEqual(await fingerprint(), original);
  assert.deepEqual(await frame.evaluate(() => window.ketcher.editor.selection().atoms), [1]);

  await frame.getByRole('button', { name: '专注绘图', exact: true }).click();
  assert.ok((await box('.chem-canvas')).height > layout.canvas.height + 200);
  assert.equal(await frame.locator('.chem-footer').isVisible(), false);
  await frame.getByRole('button', { name: '显示操作区', exact: true }).click();
  assert.equal(await frame.evaluate(() => window.ketcher === window.layoutInstance), true, 'layout changes must retain the editor instance');
  await frame.getByRole('button', { name: '替换选中原子', exact: true }).click();
  await frame.waitForFunction(() => window.ketcher.editor.struct().atoms.get(1).label === 'N' && !document.querySelector('.chem-busy'));
  await frame.getByRole('button', { name: '撤销', exact: true }).click();
  assert.deepEqual(await fingerprint(), original, 'undo must work after resizing and focus changes');
  console.log('PASS primary canvas, auxiliary DSH chat and draft, import overlay, pointer/keyboard resizing, retained selection and undo');

  await page.setViewportSize({ width: 360, height: 640 });
  await assertFits();
  const narrowWidth = (await box('.chem-canvas')).width;
  await page.getByRole('button', { name: 'DSH 助手', exact: true }).click();
  assert.equal((await box('.chem-canvas')).width, narrowWidth, 'the narrow auxiliary drawer must not squeeze the canvas');
  await page.getByRole('button', { name: '收起 DSH 助手', exact: true }).click();
  await page.screenshot({ path: 'test-results/layout-narrow.png' });
  await page.setViewportSize({ width: 1280, height: 900 });
  const wide = await assertFits();
  assert.ok(wide.tools.x >= wide.canvas.right, 'wide screens must place tools alongside the canvas');
  const split = await box('.chem-divider');
  await page.mouse.move(split.x + split.width / 2, split.y + 100);
  await page.mouse.down();
  await page.mouse.move(split.x - 70, split.y + 100, { steps: 8 });
  await page.mouse.up();
  assert.ok((await box('.chem-footer')).width > wide.tools.width + 50);
  await page.screenshot({ path: 'test-results/layout-wide.png' });

  await frame.getByRole('button', { name: '全屏编辑', exact: true }).click();
  await frame.waitForFunction(() => document.fullscreenElement?.classList.contains('chem-app'));
  await frame.getByRole('button', { name: '退出全屏', exact: true }).click();
  await frame.waitForFunction(() => !document.fullscreenElement);
  assert.deepEqual(await fingerprint(), original);
  assert.equal(await frame.evaluate(() => window.ketcher === window.layoutInstance), true);
  await frame.waitForFunction(() => document.querySelector('[data-save-status]')?.textContent === '已保存');
  const target = await frame.evaluate(() => window.chemP0.atomPoint(1));
  const carrier = await page.locator('iframe').boundingBox();
  await page.mouse.click(target.x + carrier.x, target.y + carrier.y);
  await frame.getByLabel('对选区的批注').fill('把选中的 C 换成 N');
  await frame.getByRole('button', { name: '交给 Agent', exact: true }).click();
  await frame.getByRole('button', { name: '专注绘图', exact: true }).click();
  await frame.locator('[data-preview-id]').waitFor({ timeout: 40000 });
  assert.equal(await frame.locator('.chem-footer').isVisible(), true, 'incoming previews must reveal the tools');
  assert.deepEqual(await fingerprint(), original, 'preview must retain the original molecule');
  await frame.getByRole('button', { name: '取消批注', exact: true }).last().click();
  await frame.waitForFunction(() => document.querySelector('[data-save-status]')?.textContent === '已保存');
  const identity = await frame.evaluate(() => window.ketcher.getInchi());
  await frame.getByLabel('文档名称').fill('分子主工作区验证');
  await page.getByRole('button', { name: '返回 DSH 聊天', exact: true }).click();
  assert.equal(await page.locator('iframe').count(), 1, 'returning to chat must retain unsaved edits and trigger a save');
  await frame.waitForFunction(() => document.querySelector('[data-save-status]')?.textContent === '已保存');
  await page.getByRole('button', { name: '返回 DSH 聊天', exact: true }).click();
  await page.locator('[data-dsh-chat]').waitFor();
  await page.getByRole('button', { name: '打开分子工作区', exact: true }).click();
  const restored = await (await page.locator('iframe').elementHandle()).contentFrame();
  await restored.waitForFunction(() => window.chemP0?.ketcher.editor.struct().atoms.size === 6 && !document.querySelector('.chem-busy'));
  assert.equal(await restored.evaluate(() => window.ketcher.getInchi()), identity);
  await restored.getByLabel('文档名称').fill('快速导航保留草稿');
  await restored.getByRole('button', { name: 'N', exact: true }).click();
  const editPoint = await restored.evaluate(() => window.chemP0.atomPoint(0));
  const editCarrier = await page.locator('iframe').boundingBox();
  await page.mouse.click(editPoint.x + editCarrier.x, editPoint.y + editCarrier.y);
  await restored.waitForFunction(() => window.ketcher.editor.struct().atoms.get(0).label === 'N');
  await page.getByRole('button', { name: '切到其他页面', exact: true }).click();
  await page.getByRole('button', { name: '打开分子工作区', exact: true }).click();
  const afterNavigation = await (await page.locator('iframe').elementHandle()).contentFrame();
  await afterNavigation.waitForFunction(() => window.chemP0?.ketcher.editor.struct().atoms.size === 6 && !document.querySelector('.chem-busy'));
  assert.equal(await afterNavigation.getByLabel('文档名称').inputValue(), '快速导航保留草稿', 'global navigation before autosave must retain the latest draft');
  const [actualIdentity, pyridineIdentity] = await afterNavigation.evaluate(async () => [await window.ketcher.getInchi(), (await window.ketcher.indigo.convert('n1ccccc1', { outputFormat: 'chemical/x-inchi' })).struct]);
  assert.equal(actualIdentity, pyridineIdentity, 'departure must also preserve the latest molecular edit');
  await afterNavigation.waitForFunction(() => document.querySelector('[data-save-status]')?.textContent === '已保存');
  await page.request.get('http://127.0.0.1:3099/test/fail-next-save');
  await afterNavigation.getByLabel('文档名称').fill('补存失败后恢复草稿');
  await page.getByRole('button', { name: '切到其他页面', exact: true }).click();
  await page.getByRole('button', { name: '打开分子工作区', exact: true }).click();
  const recovered = await (await page.locator('iframe').elementHandle()).contentFrame();
  await recovered.waitForFunction(() => document.querySelector('[data-save-status]')?.textContent === '已保存' && !document.querySelector('.chem-busy'));
  assert.equal(await recovered.getByLabel('文档名称').inputValue(), '补存失败后恢复草稿', 'a failed departure save must recover the draft on reentry');
  assert.deepEqual(errors, []);
  console.log('ALL-PASS: primary molecular workspace, auxiliary DSH chat, responsive tools and iframe fullscreen');
} catch (error) {
  await page.screenshot({ path: 'test-results/layout-failure.png' });
  throw error;
} finally {
  await browser.close();
}
