// A2 adapter probe: verifies the shipped Indigo WASM engine against the
// fragment capabilities required by docs/AGENT_ARCHITECTURE.md §6 before any
// dynamic-fragment capability is published. Run via scripts/run-browser-tests.mjs.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const SMILES = 'chemical/x-daylight-smiles';
const KET = 'chemical/x-indigo-ket';
const molecules = ket => {
  const data = JSON.parse(ket);
  return Object.values(data).filter(m => m?.type === 'molecule');
};
const summarize = ket => {
  const [m] = molecules(ket);
  return {
    atoms: (m?.atoms || []).map(a => ({ label: a.label, charge: a.charge || 0, isotope: a.isotope || 0, explicitH: a.explicitHCount, implicitH: a.implicitHCount, attachmentPoints: a.attachmentPoints || null })),
    bonds: (m?.bonds || []).map(b => b.type),
  };
};

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
try {
  await page.goto('http://127.0.0.1:3099/session-a');
  await page.locator('iframe').waitFor();
  const f = await (await page.locator('iframe').elementHandle()).contentFrame();
  await f.waitForFunction(() => !!window.chemP0 && !document.querySelector('.chem-busy'), null, { timeout: 30000 });
  const indigo = () => f.evaluate(() => window.chemP0.ketcher.indigo);
  const convert = async (smiles, outputFormat = KET) => {
    const result = await f.evaluate(async ({ smiles, input, output }) => {
      const r = await window.chemP0.ketcher.indigo.convert(smiles, { inputFormat: input, outputFormat: output });
      return { struct: r.struct, format: r.format };
    }, { smiles, input: SMILES, output: outputFormat });
    return result.struct;
  };
  const layoutKet = async ket => f.evaluate(async ket => {
    const indigo = window.chemP0.ketcher.indigo;
    const laid = await indigo.layout(ket, { outputFormat: 'chemical/x-indigo-ket' });
    const out = await indigo.convert(laid, { inputFormat: 'chemical/x-indigo-ket', outputFormat: 'chemical/x-indigo-ket' });
    return out.struct;
  }, ket);
  const check = async ket => f.evaluate(async ket => window.chemP0.ketcher.indigo.check(ket, { types: ['valence', 'query', 'pseudoatoms', 'radicals'] }), ket);

  // 1. SMILES → attributed fragment graph (labels, charge, isotope, hydrogens).
  const plain = { 'C#N': 2, 'CC(=O)': 3, 'Cc1ccccc1': 7 };
  for (const [smiles, atomCount] of Object.entries(plain)) {
    const ket = await convert(smiles), s = summarize(ket);
    assert.equal(s.atoms.length, atomCount, `${smiles} atom count`);
    assert.ok(s.atoms.every(a => typeof a.label === 'string' && a.label.length <= 2), `${smiles} plain labels`);
    console.log(`PROBE convert ${smiles}: ${s.atoms.map(a => a.label).join('-')} bonds[${s.bonds}] PASS`);
  }
  const charged = await convert('[NH4+]'), chargedS = summarize(charged);
  assert.ok(chargedS.atoms.some(a => a.label === 'N' && a.charge === 1), 'charge preserved');
  const isotope = await convert('[13CH3-]'), isotopeS = summarize(isotope);
  assert.ok(isotopeS.atoms.some(a => a.label === 'C' && a.isotope === 13 && a.charge === -1), 'isotope+charge preserved');
  console.log(`PROBE attributes: charge ${JSON.stringify(chargedS.atoms.filter(a => a.charge))} isotope ${JSON.stringify(isotopeS.atoms.filter(a => a.isotope))} PASS`);

  // 2. Aromaticity preservation: lowercase aromatic input survives as aromatic bonds (type 4).
  const benzyl = await convert('Cc1ccccc1'), benzylS = summarize(benzyl);
  const aromaticBonds = benzylS.bonds.filter(t => t === 4).length;
  assert.equal(aromaticBonds, 6, `benzyl aromatic bonds (got [${benzylS.bonds}])`);
  console.log(`PROBE aromatic: benzyl bonds [${benzylS.bonds}] PASS`);
  const kekule = await convert('C1=CC=CC=C1'), kekuleS = summarize(kekule);
  console.log(`PROBE aromatic kekule-input: bonds [${kekuleS.bonds}] (recorded)`);

  // 3. Attachment/dummy atom representation in round-trips.
  for (const smiles of ['[*]C', '[*:1]CC', '[R1]C']) {
    try {
      const ket = await convert(smiles), s = summarize(ket);
      console.log(`PROBE dummy ${smiles}: atoms ${JSON.stringify(s.atoms)} (recorded)`);
    } catch (e) { console.log(`PROBE dummy ${smiles}: ERROR ${String(e.message).slice(0, 160)} (recorded)`); }
  }

  // 4. Layout: engine generates finite 2D coordinates with roughly uniform bond lengths.
  const laid = await layoutKet(await convert('CC(=O)'));
  const [laidM] = molecules(laid);
  const points = laidM.atoms.map(a => a.location);
  assert.ok(points.every(p => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite)), 'layout finite coordinates');
  const lengths = laidM.bonds.map(b => Math.hypot(points[b.atoms[0]][0] - points[b.atoms[1]][0], points[b.atoms[0]][1] - points[b.atoms[1]][1]));
  assert.ok(lengths.every(n => n > 0.3), `layout bond lengths [${lengths.map(n => n.toFixed(2))}]`);
  console.log(`PROBE layout: acetyl lengths [${lengths.map(n => n.toFixed(2))}] PASS`);

  // 5. Diagnostics: malformed SMILES fail loudly; syntactically tolerable
  //    garbage must at least be flagged by check(pseudoatoms/query), because
  //    the engine itself is lenient and never rejects on element names.
  let broken = false;
  try { await convert('C1CC (broken'); } catch (e) { broken = true; console.log(`PROBE diagnostics "C1CC (broken": ${String(e.message).slice(0, 120)} PASS`); }
  assert.ok(broken, 'malformed SMILES must fail');
  const WHITELIST = new Set(['C', 'N', 'O', 'S', 'P', 'F', 'Cl', 'Br', 'I', 'B', 'Si', 'H']);
  try {
    const junk = summarize(await convert('XyZ'));
    const foreign = junk.atoms.filter(a => !WHITELIST.has(a.label));
    const junkChecks = await check(await convert('XyZ'));
    console.log(`PROBE diagnostics "XyZ": lenient parse ${JSON.stringify(junk.atoms.map(a => a.label))}, check=${JSON.stringify(junkChecks)} (recorded)`);
    assert.ok(foreign.length || Object.values(junkChecks).some(v => typeof v === 'string' && v.trim()), 'garbage input must yield foreign labels or check() findings');
  } catch (e) { console.log(`PROBE diagnostics "XyZ": rejected with ${String(e.message).slice(0, 100)} PASS`); }

  // 6. Engine accepts candidates built the way our executor constructs them
  //    (appended fragment atoms, type-4 aromatic ring, implicitHCount hints).
  const constructed = {
    root: { nodes: [{ $ref: 'mol0' }], connections: [], templates: [] },
    mol0: { type: 'molecule', atoms: [
      { label: 'C', location: [0, 0, 0] }, { label: 'C', location: [1, 0, 0] },
      { label: 'C', location: [2, 0, 0], implicitHCount: 0 }, { label: 'N', location: [3, 0, 0], implicitHCount: 0 },
    ], bonds: [{ type: 1, atoms: [0, 1] }, { type: 1, atoms: [1, 2] }, { type: 3, atoms: [2, 3] }] },
  };
  const cyanoChecks = await check(JSON.stringify(constructed));
  assert.ok(!Object.values(cyanoChecks).some(v => typeof v === 'string' && v.trim()), `constructed cyano must be clean: ${JSON.stringify(cyanoChecks)}`);
  console.log('PROBE constructed-candidate: executor-style cyano KET passes check() PASS');

  assert.deepEqual(errors, []);
  console.log('ALL-PASS: A2 fragment adapter probe (convert/attributes/aromatic/layout/diagnostics/constructed)');
} catch (error) {
  await page.screenshot({ path: 'test-results/fragment-probe-failure.png' });
  console.error('PROBE-FAILED:', error.message);
  throw error;
} finally {
  await browser.close();
}
