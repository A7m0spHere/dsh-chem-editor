// Unified fragment resolution: fixed templates and strict dynamic SMILES specs
// both normalize to one ParsedFragment graph. The parser is deliberately strict
// because the A2 Indigo probe showed the engine leniently accepts garbage
// (e.g. "XyZ") and drops dummy-atom labels, so attachment identity and element
// validation must never depend on an engine round-trip.
import { fragments } from './fragments';
import { fragmentLimits, type FragmentSpec, type ParsedFragment, type ParsedFragmentAtom, type ParsedFragmentBond } from '../contracts/fragment';

const fail = (code: string, message: string): never => { throw Object.assign(new Error(message), { code }); };
const organic = ['Cl', 'Br', 'C', 'N', 'O', 'S', 'P', 'F', 'I'];
const aromaticSet = new Set(['c', 'n', 'o', 's']);
const bracketElements = new Set(['Cl', 'Br', 'Si', 'C', 'N', 'O', 'S', 'P', 'F', 'I', 'B']);
const valenceOf = (label: string, charge: number): number | undefined => ({
  C: charge === 0 ? 4 : charge === 1 || charge === -1 ? 3 : undefined,
  N: charge === 0 ? 3 : charge === 1 ? 4 : charge === -1 ? 2 : undefined,
  O: charge === 0 ? 2 : charge === 1 ? 3 : charge === -1 ? 1 : undefined,
  S: charge === 0 ? 2 : charge === 1 ? 3 : charge === -1 ? 1 : undefined,
  P: charge === 0 ? 3 : undefined, B: charge === 0 ? 3 : undefined, Si: charge === 0 ? 4 : undefined,
  F: charge === 0 ? 1 : undefined, Cl: charge === 0 ? 1 : undefined, Br: charge === 0 ? 1 : undefined, I: charge === 0 ? 1 : undefined,
}[label]);

type RawAtom = { label: string; charge: number; isotope: number; explicitH: number; aromatic: boolean; dummy: boolean };
type RawBond = { atoms: [number, number]; type: 1 | 2 | 3 | 4 };

function parseSmiles(text: string) {
  const atoms: RawAtom[] = [], bonds: RawBond[] = [], closures = new Map<string, { atom: number; bond: number | null }>();
  const connect = (a: number, b: number, explicit: number | null) => {
    if (a === b) fail('invalid_fragment', '片段中存在自环。');
    const type = (explicit ?? (atoms[a].aromatic && atoms[b].aromatic ? 4 : 1)) as 1 | 2 | 3 | 4;
    if (type === 4 && (!atoms[a].aromatic || !atoms[b].aromatic)) fail('invalid_fragment', '芳香键只能连接两个芳香原子。');
    bonds.push({ atoms: [a, b], type });
  };
  let i = 0, previous = -1, pending: number | null = null;
  const stack: { previous: number }[] = [];
  const readAtom = (): number => {
    const atom: RawAtom = { label: '', charge: 0, isotope: 0, explicitH: 0, aromatic: false, dummy: false };
    if (text[i] === '[') {
      const end = text.indexOf(']', i); if (end < 0) fail('invalid_fragment', '括号原子缺少右括号。');
      let body = text.slice(i + 1, end);
      let isotope = body.match(/^\d+/); if (isotope) { atom.isotope = Number(isotope[0]); body = body.slice(isotope[0].length); }
      const symbol = body.match(/^\*(:\d+)?|^Si|^Cl|^Br|^[A-Z][a-z]?|^[cnops]/);
      if (!symbol) fail('invalid_fragment', '无法识别的原子符号。');
      if (symbol[0].startsWith('*')) atom.dummy = true;
      else { atom.aromatic = aromaticSet.has(symbol[0]); atom.label = atom.aromatic ? symbol[0].toUpperCase() : symbol[0]; }
      body = body.slice(symbol[0].length);
      if (!atom.dummy && !bracketElements.has(atom.label)) fail('unsupported_fragment', `片段原子 ${atom.label || '?'} 不在支持的白名单内。`);
      const hydrogens = body.match(/^H(\d*)/); if (hydrogens) { atom.explicitH = hydrogens[1] ? Number(hydrogens[1]) : 1; body = body.slice(hydrogens[0].length); }
      const charge = body.match(/^(\+{1,2}|-{1,2}|\+\d+|-\d+)/); if (charge) { atom.charge = charge[0].startsWith('+') ? (charge[0].length === 1 ? 1 : Number(charge[0].slice(1)) || 2) : (charge[0].length === 1 ? -1 : -Number(charge[0].slice(1)) || -2); body = body.slice(charge[0].length); }
      if (body) fail('invalid_fragment', `括号原子包含无法解析的内容“${body}”。`);
      i = end + 1;
    } else {
      const symbol = organic.find(name => text.startsWith(name, i)) || (aromaticSet.has(text[i]) ? text[i] : undefined);
      if (!symbol) fail('invalid_fragment', `无法识别的片段字符“${text[i]}”。`);
      atom.label = symbol.toUpperCase(); atom.aromatic = aromaticSet.has(symbol);
      i += symbol.length;
    }
    atoms.push(atom);
    const index = atoms.length - 1;
    if (previous >= 0) connect(previous, index, pending);
    pending = null;
    return index;
  };
  while (i < text.length) {
    const ch = text[i];
    if (ch === '(') { if (previous < 0) fail('invalid_fragment', '分支不能出现在片段开头。'); stack.push({ previous }); i++; continue; }
    if (ch === ')') { const frame = stack.pop(); if (!frame) fail('invalid_fragment', '多余的右括号。'); previous = frame.previous; i++; continue; }
    if (ch === '.') fail('unsupported_fragment', '片段必须连通，不接受多个组分的 SMILES。');
    if (ch === '%') fail('unsupported_fragment', '暂不支持两位数环标记。');
    if (/[0-9]/.test(ch)) {
      if (previous < 0) fail('invalid_fragment', '环标记不能出现在片段开头。');
      const open = closures.get(ch);
      if (open) { connect(previous, open.atom, pending ?? open.bond); if (pending !== null && open.bond !== null && pending !== open.bond) fail('invalid_fragment', '环两侧声明了不同的键级。'); closures.delete(ch); }
      else closures.set(ch, { atom: previous, bond: pending });
      pending = null; i++; continue;
    }
    if (ch === '-' || ch === '=' || ch === '#') { if (pending !== null) fail('invalid_fragment', '连续的键符号。'); pending = ch === '-' ? 1 : ch === '=' ? 2 : 3; i++; continue; }
    if (ch === '[' || organic.some(name => text.startsWith(name, i)) || aromaticSet.has(ch)) {
      const before = previous; previous = readAtom();
      if (before < 0 && stack.length) fail('invalid_fragment', '分支必须以原子开头。');
      continue;
    }
    fail('invalid_fragment', `无法识别的片段字符“${ch}”。`);
  }
  if (stack.length || pending !== null) fail('invalid_fragment', '片段表达式不完整。');
  if (closures.size) fail('invalid_fragment', '存在未闭合的环标记。');
  return { atoms, bonds };
}

const hashText = (text: string): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 0x01000193) >>> 0; }
  return hash.toString(16).padStart(8, '0');
};

export function parseSmilesFragment(smiles: string, connection?: { atom: number; bondType?: 1 | 2 | 3 }): ParsedFragment {
  const { atoms: rawAtoms, bonds: rawBonds } = parseSmiles(smiles);
  const dummies = rawAtoms.map((a, i) => ({ a, i })).filter(({ a }) => a.dummy);
  if (dummies.length > 1) fail('ambiguous_fragment', '一个片段只能有一个 [*] 连接点。');
  let attachment = -1, attachmentBondType: 1 | 2 | 3 = 1;
  const dropped = new Set<number>();
  if (dummies.length) {
    const dummy = dummies[0].i;
    const incident = rawBonds.map((b, index) => ({ b, index })).filter(({ b }) => b.atoms.includes(dummy));
    if (incident.length !== 1) fail('invalid_fragment', '[*] 连接点必须有且只有一个键。');
    const bond = incident[0].b;
    if (bond.type === 4) fail('invalid_fragment', '连接键不能是芳香键。');
    attachment = bond.atoms[0] === dummy ? bond.atoms[1] : bond.atoms[0];
    attachmentBondType = bond.type as 1 | 2 | 3;
    dropped.add(dummy);
    if (connection && connection.atom !== attachment) fail('ambiguous_fragment', '显式 connection 与 [*] 连接点不一致。');
    if (connection && connection.bondType !== undefined && connection.bondType !== attachmentBondType) fail('ambiguous_fragment', '显式 connection 键级与 [*] 连接键不一致。');
  } else if (connection) {
    if (!Number.isInteger(connection.atom) || connection.atom < 0 || connection.atom >= rawAtoms.length) fail('invalid_fragment', `connection.atom 超出片段原子范围（0–${rawAtoms.length - 1}）。`);
    attachment = connection.atom;
    attachmentBondType = connection.bondType ?? 1;
  } else fail('connection_point_required', '片段 SMILES 必须带 [*] 连接点，或显式声明 connection（原子序号与键级）。');
  const remap = new Map<number, number>();
  const atoms: ParsedFragmentAtom[] = [];
  const rawOf: RawAtom[] = [];
  rawAtoms.forEach((atom, index) => { if (!dropped.has(index)) { remap.set(index, atoms.length); rawOf.push(atom); atoms.push({ label: atom.label, charge: atom.charge, isotope: atom.isotope, hydrogen: 0, point: [0, 0] }); } });
  const bonds: ParsedFragmentBond[] = [];
  for (const bond of rawBonds) if (!dropped.has(bond.atoms[0]) && !dropped.has(bond.atoms[1])) bonds.push({ atoms: [remap.get(bond.atoms[0])!, remap.get(bond.atoms[1])!], type: bond.type });
  if (!atoms.length) fail('invalid_fragment', '片段没有实际原子。');
  if (atoms.length > fragmentLimits.atoms) fail('fragment_budget', `片段最多 ${fragmentLimits.atoms} 个原子。`);
  const attachmentIndex = remap.get(attachment)!;
  // Connectivity plus single-ring budget, computed on the real graph.
  const adjacency = atoms.map(() => [] as number[]);
  for (const bond of bonds) { adjacency[bond.atoms[0]].push(bond.atoms[1]); adjacency[bond.atoms[1]].push(bond.atoms[0]); }
  const seen = new Set([attachmentIndex]), queue = [attachmentIndex];
  while (queue.length) for (const next of adjacency[queue.shift()!]) if (!seen.has(next)) { seen.add(next); queue.push(next); }
  if (seen.size !== atoms.length) fail('unsupported_fragment', '片段必须连通，不接受断开的组分。');
  const cycles = bonds.length - atoms.length + 1;
  if (cycles > fragmentLimits.rings) fail('unsupported_fragment', '暂不支持多环或螺环片段。');
  const aromaticAtoms = new Set<number>();
  rawAtoms.forEach((atom, index) => { if (atom.aromatic && !dropped.has(index)) aromaticAtoms.add(remap.get(index)!); });
  const aromaticBondsOf = (index: number) => adjacency[index].filter(other => bonds.some(b => b.type === 4 && b.atoms.includes(index) && b.atoms.includes(other))).length;
  for (const index of aromaticAtoms) if (aromaticBondsOf(index) < 2) fail('invalid_fragment', '芳香原子必须位于芳香环内。');
  let ring: number[] | undefined;
  if (cycles === 1) {
    const degree = adjacency.map(list => list.length);
    let changed = true;
    const removed = new Set<number>();
    while (changed) { changed = false; for (let index = 0; index < atoms.length; index++) if (!removed.has(index) && degree[index] <= 1) { removed.add(index); for (const other of adjacency[index]) degree[other]--; changed = true; } }
    ring = atoms.map((_, index) => index).filter(index => !removed.has(index));
    if (ring.length < 3 || ring.length > fragmentLimits.ringAtoms) fail('fragment_budget', `环大小必须在 3–${fragmentLimits.ringAtoms} 之间。`);
  }
  // Implicit hydrogens from standard valence; aromatic bonds count as 1.5 each.
  // The attachment atom spends valence on the connection bond to the target
  // molecule, exactly like the hand-written fixed templates.
  for (let index = 0; index < atoms.length; index++) {
    const atom = atoms[index], raw = rawOf[index];
    const valence = valenceOf(atom.label, atom.charge);
    if (valence === undefined) fail('unsupported_fragment', `不支持 ${atom.label}${atom.charge > 0 ? '+' + atom.charge : atom.charge < 0 ? atom.charge : ''} 形式的片段原子。`);
    const orderOf = (other: number) => { const bond = bonds.find(b => b.atoms.includes(index) && b.atoms.includes(other))!; return bond.type === 4 ? 1.5 : bond.type; };
    const order = adjacency[index].reduce((sum, other) => sum + orderOf(other), 0) + (index === attachmentIndex ? attachmentBondType : 0);
    const implicit = valence - raw.explicitH - order;
    if (implicit < 0 || !Number.isInteger(implicit)) fail('invalid_fragment', `片段中 ${atom.label} 的价态超限，无法确定氢原子数。`);
    atom.hydrogen = implicit + raw.explicitH;
  }
  const points = layoutFragment(atoms, bonds, adjacency, attachmentIndex, ring);
  atoms.forEach((atom, index) => { atom.point = points[index]; });
  return {
    atoms, bonds, attachment: attachmentIndex, attachmentBondType,
    source: smiles, contentHash: hashText(JSON.stringify([atoms.map(a => [a.label, a.charge, a.isotope, a.hydrogen]), bonds, attachmentIndex])),
  };
}

// Relative 2D layout with unit bond length; fragmentPositions rotates the whole
// graph when attaching, so only the relative geometry has to be reasonable.
const RING = Math.PI / 180;
function layoutFragment(atoms: ParsedFragmentAtom[], bonds: ParsedFragmentBond[], adjacency: number[][], attachment: number, ring?: number[]): [number, number][] {
  const points: ([number, number] | null)[] = atoms.map(() => null);
  const collide = (point: [number, number]) => points.some(other => other && Math.hypot(other[0] - point[0], other[1] - point[1]) < 0.4);
  const ringSet = new Set(ring ?? []);
  if (ring) {
    const n = ring.length, radius = 1 / (2 * Math.sin(Math.PI / n));
    ring.forEach((index, k) => { const angle = -Math.PI / 2 + k * 2 * Math.PI / n; points[index] = [radius * Math.cos(angle), radius * Math.sin(angle)]; });
    // Ring atoms sit on the polygon; trees hang radially outward.
    for (const index of ring) {
      const [x, y] = points[index]!;
      place(index, Math.atan2(y, x), 0, -1);
    }
  } else { points[attachment] = [0, 0]; place(attachment, 60 * RING, 0, -1); }
  function place(index: number, inDirection: number, depth: number, parent: number) {
    const children = adjacency[index].filter(next => next !== parent && !points[next] && !ringSet.has(next));
    const own = points[index] ?? (() => fail('fragment_layout', '片段布局失败，请减少分支密度。'))();
    children.forEach((child, k) => {
      // Continuation keeps the zigzag; extra children sit 120° apart on the
      // forward side (i-propyl geometry), never pointing back at the anchor.
      const direction = k === 0 ? (depth % 2 === 0 ? inDirection : inDirection - 60 * RING) : inDirection + 120 * RING * (k % 2 === 1 ? -1 : 1);
      let candidate: [number, number] = [own[0] + Math.cos(direction), own[1] + Math.sin(direction)];
      if (collide(candidate) && k > 0) {
        const flip = inDirection + 120 * RING * (k % 2 === 1 ? 1 : -1);
        candidate = [own[0] + Math.cos(flip), own[1] + Math.sin(flip)];
      }
      if (collide(candidate)) fail('fragment_layout', '片段布局失败：分支过密或环过小，请减少分支。');
      points[child] = candidate;
      place(child, direction, depth + 1, index);
    });
  }
  const attachmentPoint = points[attachment]!;
  return points.map(point => [point![0] - attachmentPoint[0] + 1, point![1] - attachmentPoint[1]] as [number, number]);
}

// Named dynamic groups share identity rules with the fixed table: canonical id,
// aliases, and a [*] attachment marker inside the SMILES itself.
export const dynamicFragments: Record<string, { name: string; englishName: string; aliases: string[]; smiles: string }> = {
  cyano: { name: '氰基', englishName: 'cyano', aliases: ['氰基', 'cyano'], smiles: '[*]C#N' },
  acetyl: { name: '乙酰基', englishName: 'acetyl', aliases: ['乙酰基', '乙酰', 'acetyl'], smiles: '[*]C(C)=O' },
  benzyl: { name: '苄基', englishName: 'benzyl', aliases: ['苄基', '苯甲基', 'benzyl', 'Bn'], smiles: '[*]Cc1ccccc1' },
};
const dynamicEntry = (value: string) => Object.entries(dynamicFragments).find(([id, entry]) => value.toLowerCase() === id.toLowerCase() || entry.aliases.some(alias => alias.toLowerCase() === value.toLowerCase()));
const smilesLike = (value: string) => /[=#$*[\]()0-9]/.test(value) || /^[A-Za-z]{1,2}$/.test(value);
export { smilesLike };

export function resolveFragmentSpec(input: unknown): { spec: FragmentSpec; canonical: string } | undefined {
  if (typeof input !== 'string' || !input.trim()) return undefined;
  const value = input.trim();
  const template = Object.keys(fragments).find(id => id.toLowerCase() === value.toLowerCase() || fragments[id].aliases.some(alias => alias.toLowerCase() === value.toLowerCase()));
  if (template) return { spec: { kind: 'template', id: template }, canonical: template };
  const dynamic = dynamicEntry(value);
  if (dynamic) return { spec: { kind: 'smiles', smiles: dynamic[1].smiles }, canonical: dynamic[0] };
  if (smilesLike(value)) return { spec: { kind: 'smiles', smiles: value }, canonical: value };
  return undefined;
}

export function parseFragmentSpec(spec: FragmentSpec): ParsedFragment {
  if (spec.kind === 'template') {
    const entry = fragments[spec.id];
    if (!entry) fail('unsupported_fragment', `未知固定片段 ${spec.id}。`);
    const atoms: ParsedFragmentAtom[] = entry.atoms.map(atom => ({ label: atom.label, charge: 0, isotope: 0, hydrogen: atom.hydrogen, point: atom.point }));
    return { atoms, bonds: entry.bonds, attachment: entry.attachment, attachmentBondType: entry.bondType, source: spec.id,
      contentHash: hashText(JSON.stringify([entry.atoms, entry.bonds, entry.attachment])) };
  }
  return parseSmilesFragment(spec.smiles, spec.connection);
}

// Merged accessors replace the template-only lists for tools, prompts and UI.
export const fragmentInputs = [...new Set([...Object.keys(fragments).flatMap(id => [id, ...fragments[id].aliases]), ...Object.entries(dynamicFragments).flatMap(([id, entry]) => [id, ...entry.aliases])])];
export const fragmentIds = [...Object.keys(fragments), ...Object.keys(dynamicFragments)];
export const fragmentName = (id: string, language = 'zh-CN') => {
  if (fragments[id]) return (language === 'en' ? fragments[id].englishName : fragments[id].name) || id;
  if (dynamicFragments[id]) return language === 'en' ? dynamicFragments[id].englishName : dynamicFragments[id].name;
  return id;
};
export const fragmentList = (language = 'zh-CN') => fragmentInputs.filter(name => fragments[name] || dynamicFragments[name]).map(id => fragmentName(id, language)).join(language === 'en' ? ', ' : '、');
export const fragmentCatalog = () => [
  ...Object.entries(fragments).map(([id, f]) => ({ id, name: fragmentName(id), englishName: fragmentName(id, 'en'), aliases: f.aliases, atomCount: f.atoms.length, attachment: f.attachment, bondType: f.bondType })),
  ...Object.entries(dynamicFragments).map(([id, f]) => ({ id, name: f.name, englishName: f.englishName, aliases: f.aliases, smiles: f.smiles, attachment: 'marked by [*] in smiles' })),
];
