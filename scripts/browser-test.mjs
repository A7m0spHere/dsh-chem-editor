import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1000, height: 850 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await mkdir('test-results', { recursive: true });
const selection = () => page.evaluate(() => window.chemP0.ketcher.editor.selection());
const fingerprint = () => page.evaluate(() => window.chemP0.fingerprint());
const waitIdle = () => page.waitForFunction(() => !document.querySelector('.chem-busy'));
const clickAtom = async (id) => {
  const point = await page.evaluate(id => window.chemP0.atomPoint(id), id);
  await page.mouse.click(point.x, point.y);
  assert.deepEqual((await selection()).atoms, [id], 'mouse selection must identify the intended atom');
};
try {
  await page.goto('http://127.0.0.1:3099', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.chemP0?.ketcher.editor.struct().atoms.size === 6);
  await waitIdle();
  const original = await fingerprint();
  await clickAtom(1);
  await page.getByRole('button', { name: '替换选中原子', exact: true }).click();
  await waitIdle();
  await page.getByRole('status').filter({ hasText: 'C → N' }).waitFor();
  const expected = structuredClone(original); expected.atoms.find(([id]) => id === 1)[1].label = 'N';
  assert.deepEqual(await fingerprint(), expected, 'only the selected atom element may change');
  const inchi = await page.evaluate(async () => {
    const k = window.chemP0.ketcher;
    return [await k.getInchi(), (await k.indigo.convert('n1ccccc1', { outputFormat: 'chemical/x-inchi' })).struct];
  });
  assert.equal(inchi[0], inchi[1], 'benzene replacement must produce pyridine');
  await page.screenshot({ path: 'test-results/pyridine.png' });
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  assert.deepEqual(await fingerprint(), original, 'undo must restore the original molecule');
  await page.getByRole('button', { name: '重做', exact: true }).click();
  assert.deepEqual(await fingerprint(), expected, 'redo must restore the replacement');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await clickAtom(1);
  await page.locator('.chem-actions select').selectOption('F');
  await page.getByRole('button', { name: '替换选中原子', exact: true }).click();
  await waitIdle();
  await page.getByRole('alert').filter({ hasText: '结构检查未通过' }).waitFor();
  assert.deepEqual(await fingerprint(), original, 'invalid valence must leave all structure data unchanged');
  console.log('PASS mouse selection, pyridine identity, undo/redo, invalid valence rollback');

  await page.getByRole('button', { name: '含手性多环示例', exact: true }).click();
  await waitIdle();
  const complex = await fingerprint();
  assert.ok(complex.atoms.length > 20);
  assert.ok(complex.bonds.some(([, b]) => b.stereo !== 0), 'fixture must include stereobonds');
  const id = await page.evaluate(() => {
    let target;
    window.chemP0.ketcher.editor.struct().atoms.forEach((a, id) => { if (a.label === 'C' && a.implicitH === 1 && a.neighbors.length === 2 && target === undefined) target = id; });
    return target;
  });
  assert.ok(Number.isInteger(id));
  await clickAtom(id);
  await page.locator('.chem-actions select').selectOption('N');
  await page.getByRole('button', { name: '替换选中原子', exact: true }).click();
  await waitIdle();
  await page.getByRole('status').filter({ hasText: 'C → N' }).waitFor();
  const complexExpected = structuredClone(complex); complexExpected.atoms.find(([aid]) => aid === id)[1].label = 'N';
  assert.deepEqual(await fingerprint(), complexExpected, 'complex molecule must retain every other atom, bond and stereochemical property');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  assert.deepEqual(await fingerprint(), complex);
  const ket = await page.evaluate(() => window.chemP0.ketcher.getKet());
  await page.evaluate(ket => window.chemP0.ketcher.setMolecule(ket), ket);
  const reloaded = JSON.parse(await page.evaluate(() => window.chemP0.ketcher.getKet()));
  function compareKet(a, b, path = 'KET') {
    if (typeof a === 'number') { assert.ok(Math.abs(a - b) < 0.00001, `${path}: numeric difference outside layout tolerance`); return; }
    if (a && typeof a === 'object') { assert.deepEqual(Object.keys(a), Object.keys(b), `${path}: fields`); for (const key of Object.keys(a)) compareKet(a[key], b[key], `${path}.${key}`); return; }
    assert.equal(a, b, path);
  }
  compareKet(reloaded, JSON.parse(ket));
  await page.screenshot({ path: 'test-results/chiral.png' });
  console.log('PASS chiral complex molecule preservation, undo and KET roundtrip');

  await page.getByRole('button', { name: '苯', exact: true }).click(); await waitIdle();
  // Exercise ordinary manual edits followed by P0 replacement and two undos.
  await page.getByRole('button', { name: 'C', exact: true }).click();
  await page.mouse.click(350, 340);
  await page.waitForFunction(() => window.chemP0.ketcher.editor.struct().atoms.size === 7);
  await page.locator('button[data-testid="select-rectangle"]:visible').click();
  await clickAtom(1);
  await page.getByRole('button', { name: '替换选中原子', exact: true }).click(); await waitIdle();
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  assert.equal(await page.evaluate(() => window.chemP0.ketcher.editor.struct().atoms.size), 7);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  assert.equal(await page.evaluate(() => window.chemP0.ketcher.editor.struct().atoms.size), 6);
  assert.deepEqual(errors, [], 'no browser runtime errors');
  console.log('ALL-PASS: P0 browser acceptance');
} finally { await browser.close(); }
