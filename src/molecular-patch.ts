// Shared deterministic executor. The model chooses an operation, never a replacement graph.
export const fragments = { OH: { label: 'O', hydrogen: 1 }, CH3: { label: 'C', hydrogen: 3 }, NH2: { label: 'N', hydrogen: 2 }, F: { label: 'F', hydrogen: 0 }, Cl: { label: 'Cl', hydrogen: 0 } };
export const operations = ['replace_atom', 'change_bond', 'attach_fragment', 'delete_selection'];
const fail = (code: string, message: string): never => { throw Object.assign(new Error(message), { code }); };
const position = (a: any) => JSON.stringify((a.location || []).map((n: number) => Math.round(n * 100000) / 100000));
const same = (a: any, b: any): boolean => {
  if (typeof a === 'number') return typeof b === 'number' && Math.abs(a - b) < 0.00001;
  if (!a || typeof a !== 'object') return a === b;
  if (!b || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a).sort(); return JSON.stringify(keys) === JSON.stringify(Object.keys(b).sort()) && keys.every(k => same(a[k], b[k]));
};
export function selectionAddresses(s: any) {
  const addresses = s.atomAddresses || (s.targetAddress ? { [s.selection.atoms[0]]: s.targetAddress } : {});
  const raw = JSON.parse(s.rawKet);
  for (const id of s.selection.atoms) {
    const a = addresses[id], atom = raw[a?.molecule]?.atoms?.[a?.index];
    if (!atom || atom.label !== s.atoms.find((x: any) => x.id === id)?.element) fail('invalid_selection', '所选原子与冻结结构不一致。');
  }
  for (const id of s.selection.bonds) {
    const a = s.bondAddresses?.[id], bond = raw[a?.molecule]?.bonds?.[a?.index], source = s.bonds.find((b: any) => b.id === id);
    const begin = addresses[source?.begin], end = addresses[source?.end];
    if (!bond || !begin || !end || begin.molecule !== a.molecule || end.molecule !== a.molecule || bond.atoms[0] !== begin.index || bond.atoms[1] !== end.index || bond.type !== source.type) fail('invalid_selection', '所选键与冻结结构不一致。');
  }
  if (s.atomAddresses) {
    const molecular = Object.values(raw).filter((m: any) => m?.type === 'molecule') as any[];
    if (molecular.reduce((n,m) => n + m.atoms.length,0) !== s.atoms.length || molecular.reduce((n,m) => n + (m.bonds?.length || 0),0) !== s.bonds.length) fail('invalid_selection', '冻结图结构数量不一致。');
    const unique = new Set<string>();
    for (const a of s.atoms) {
      const addr = addresses[a.id], stored = raw[addr?.molecule]?.atoms?.[addr?.index], key = JSON.stringify(addr);
      if (!stored || stored.label !== a.element || unique.has(key)) fail('invalid_selection', '冻结原子映射不一致。'); unique.add(key);
    }
    const uniqueBonds = new Set<string>();
    for (const b of s.bonds) {
      const addr = s.bondAddresses?.[b.id], stored = raw[addr?.molecule]?.bonds?.[addr?.index], begin = addresses[b.begin], end = addresses[b.end], key = JSON.stringify(addr);
      if (!stored || uniqueBonds.has(key) || begin?.molecule !== addr.molecule || end?.molecule !== addr.molecule || stored.atoms[0] !== begin.index || stored.atoms[1] !== end.index || stored.type !== b.type || (stored.stereo || 0) !== (b.stereo || 0)) fail('invalid_selection', '冻结键映射不一致。'); uniqueBonds.add(key);
    }
  }
  return addresses;
}
export function normalizePatch(s: any, args: any) {
  const op = args.operation || 'replace_atom', atoms = s.selection.atoms, bonds = s.selection.bonds;
  if (!operations.includes(op)) fail('invalid_patch', '不支持此修改操作。');
  const patch: any = { operation: op, reason: String(args.reason || '').slice(0, 800) };
  if (op === 'replace_atom' || op === 'attach_fragment') {
    if (atoms.length !== 1 || bonds.length || args.targetAtom !== atoms[0]) fail('out_of_selection', '请明确选择一个连接或替换原子。');
    patch.targetAtom = atoms[0];
    if (op === 'replace_atom') {
      patch.fromElement = s.atoms.find((a: any) => a.id === atoms[0]).element;
      if (!['C','N','O','S','P','F','Cl','Br','I'].includes(args.element) || args.element === patch.fromElement) fail('out_of_selection', '请选择另一种支持的元素。');
      patch.element = args.element;
    } else {
      if (!Object.hasOwn(fragments, args.fragment)) fail('invalid_patch', '基团只支持 OH、CH3、NH2、F、Cl。');
      patch.fragment = args.fragment;
    }
  } else if (op === 'change_bond') {
    if (bonds.length !== 1 || args.targetBond !== bonds[0] || ![1,2,3].includes(args.bondType)) fail('out_of_selection', '请明确选择一根键及键级 1、2 或 3。');
    const b = s.bonds.find((b: any) => b.id === bonds[0]);
    if (atoms.some((id: number) => id !== b.begin && id !== b.end)) fail('out_of_selection', '改键选区只能包含该键及两个端点。');
    if (b.type === args.bondType) fail('invalid_patch', '键级没有变化。');
    patch.targetBond = bonds[0]; patch.fromBondType = b.type; patch.bondType = args.bondType;
  } else {
    if (!atoms.length && !bonds.length) fail('invalid_selection', '请选择要删除的原子或键。');
    patch.atoms = [...atoms]; patch.bonds = [...bonds];
  }
  // Compute and validate boundary/stereo restrictions before asking the editor to preview.
  const result = executePatch(s, patch); patch.boundaryBonds = result.boundaryBonds;
  return patch;
}
export function executePatch(s: any, patch: any) {
  const data = JSON.parse(s.rawKet), addresses = selectionAddresses(s), touched = new Set<string>(), boundaryBonds: number[] = [];
  for (const m of Object.values(data) as any[]) if (m?.type === 'molecule') m.bonds ??= [];
  const selectedAtoms = new Set(s.selection.atoms), selectedBonds = new Set(s.selection.bonds);
  const addressOf = (id: number) => addresses[id] || fail('invalid_selection', '缺少原子映射，请重新选择。');
  const moleculeOf = (id: number) => data[addressOf(id).molecule];
  const atomOf = (id: number) => moleculeOf(id).atoms[addressOf(id).index];
  if (patch.operation === 'replace_atom') {
    atomOf(patch.targetAtom).label = patch.element; touched.add(position(atomOf(patch.targetAtom)));
  } else {
    // Ordinary molecular nodes only. Reject unsupported objects instead of dropping them.
    if (data.root.connections?.length || data.root.templates?.length) fail('unsupported_structure', 'AI 局部拓扑编辑暂不支持反应或模板连接。');
    for (const m of Object.values(data) as any[]) if (m?.type === 'molecule') {
      if (Object.keys(m).some(k => !['type','atoms','bonds','stereoFlagPosition'].includes(k)) || m.atoms.some((a: any) => a.queryProperties || a.rgroupLabel || a.attachmentPoints || a.alias || a.radical || !/^(C|N|O|S|P|F|Cl|Br|I|H|B|Si)$/.test(a.label))) fail('unsupported_structure', 'AI 拓扑编辑仅支持普通小分子，查询原子、S-group、R-group 和特殊模板需手工处理。');
    }
    const changedIds = new Set<number>();
    const aromatic = new Set(s.aromaticBonds || []);
    if (patch.operation === 'change_bond' && aromatic.has(patch.targetBond)) fail('protected_aromatic', '不能局部修改芳香环的键级，请手工处理芳香体系。');
    if (patch.operation === 'delete_selection' && s.bonds.some((b: any) => aromatic.has(b.id) && (selectedAtoms.has(b.begin) || selectedAtoms.has(b.end) || selectedBonds.has(b.id)))) fail('protected_aromatic', '删除会断开芳香体系，请手工处理芳香环。');
    if (patch.operation === 'attach_fragment') changedIds.add(patch.targetAtom);
    if (patch.operation === 'change_bond') { const b = s.bonds.find((b: any) => b.id === patch.targetBond); changedIds.add(b.begin); changedIds.add(b.end); }
    if (patch.operation === 'delete_selection') for (const b of s.bonds) if (selectedAtoms.has(b.begin) || selectedAtoms.has(b.end) || selectedBonds.has(b.id)) {
      if (!selectedAtoms.has(b.begin)) changedIds.add(b.begin);
      if (!selectedAtoms.has(b.end)) changedIds.add(b.end);
      if (selectedAtoms.has(b.begin) !== selectedAtoms.has(b.end)) boundaryBonds.push(b.id);
    }
    for (const id of changedIds) {
      const a = atomOf(id), adjacent = s.bonds.filter((b: any) => b.begin === id || b.end === id);
      if (a.stereoLabel || a.stereoGroup || a.cip || adjacent.some((b: any) => b.stereo || (patch.operation !== 'attach_fragment' && b.type === 4))) fail('protected_stereo', '操作会改变芳香体系或邻接立体中心，请手工处理这处结构。');
      touched.add(position(a)); delete a.implicitHCount;
    }
    if (patch.operation === 'change_bond') {
      const address = s.bondAddresses[patch.targetBond], b = data[address.molecule].bonds[address.index];
      if (![1,2,3].includes(b.type) || b.stereo) fail('protected_stereo', '只支持普通非立体单键、双键和三键。');
      b.type = patch.bondType;
    } else if (patch.operation === 'attach_fragment') {
      const m = moleculeOf(patch.targetAtom), anchor = addressOf(patch.targetAtom).index, p = m.atoms[anchor].location;
      const template = fragments[patch.fragment as keyof typeof fragments];
      if (!Array.isArray(p) || p.length !== 3) fail('invalid_patch', '连接点缺少二维坐标。');
      const lengths = m.bonds.map((b: any) => Math.hypot(m.atoms[b.atoms[0]].location[0]-m.atoms[b.atoms[1]].location[0], m.atoms[b.atoms[0]].location[1]-m.atoms[b.atoms[1]].location[1])).filter((n: number) => n > 0.1);
      lengths.sort((a: number,b: number) => a-b); const length = lengths[Math.floor(lengths.length/2)] || 1;
      let point: number[] = [], best = -Infinity;
      for (let i = 0; i < 24; i++) {
        const t = Math.PI*2*i/24, v = [p[0]+length*Math.cos(t), p[1]+length*Math.sin(t), p[2]];
        const gap = Math.min(...m.atoms.filter((_: any,j: number) => j !== anchor).map((a: any) => Math.hypot(a.location[0]-v[0],a.location[1]-v[1])), length*2);
        if (gap > best) { best = gap; point = v; }
      }
      if (best < length*0.45) fail('crowded_attachment', '连接点周围没有合适的位置，请调整布局后重试。');
      m.bonds.push({ type: 1, atoms: [anchor, m.atoms.length] });
      m.atoms.push({ label: template.label, location: point, implicitHCount: template.hydrogen }); touched.add(position(m.atoms.at(-1)));
    } else if (patch.operation === 'delete_selection') {
      for (const [key,m] of Object.entries(data) as any[]) if (Array.isArray(m?.atoms)) {
        const removed = new Set<number>([...selectedAtoms].map((id: any) => addressOf(id)).filter(a => a.molecule === key).map(a => a.index));
        const removedBonds = new Set<number>([...selectedBonds].map((id: any) => s.bondAddresses[id]).filter((a: any) => a.molecule === key).map((a: any) => a.index));
        const map = new Map<number,number>(); const atoms = m.atoms.filter((_: any,i: number) => { if (removed.has(i)) return false; map.set(i,map.size); return true; });
        m.bonds = m.bonds.filter((b: any,i: number) => !removedBonds.has(i) && !b.atoms.some((n: number) => removed.has(n))).map((b: any) => ({...b, atoms: b.atoms.map((n: number) => map.get(n))})); m.atoms = atoms;
        if (!atoms.length) { delete data[key]; data.root.nodes = data.root.nodes.filter((n: any) => n.$ref !== key); }
      }
    }
  }
  return { ket: JSON.stringify(data), boundaryBonds, hydrogenPositions: [...touched] };
}
// Canonical graph comparison permits Ketcher's component renumbering after deletion,
// but preserves every surviving atom attribute, coordinate, and directed bond attribute.
function canonical(text: string, hydrogenPositions: string[]) {
  const data = JSON.parse(text), ignoreH = new Set(hydrogenPositions), atoms: any[] = [], bonds: any[] = [];
  const molecular = new Set(Object.keys(data).filter(k => data[k]?.type === 'molecule'));
  for (const key of molecular) {
    const m = data[key], ids = m.atoms.map((a: any) => position(a));
    if (Object.keys(m).some(k => !['type','atoms','bonds','stereoFlagPosition'].includes(k))) fail('out_of_selection', '候选结构改变了分子元数据。');
    for (const a of m.atoms) { delete a.selected; if (ignoreH.has(position(a))) delete a.implicitHCount; atoms.push(a); }
    for (const b of m.bonds || []) { delete b.selected; bonds.push({...b, atoms: b.atoms.map((n: number) => ids[n])}); }
    delete data[key];
  }
  const positions = atoms.map(position); if (new Set(positions).size !== positions.length) fail('ambiguous_coordinates', '存在重叠原子，无法可靠核对局部修改；请先调整布局。');
  data.root.nodes = data.root.nodes.filter((n: any) => !molecular.has(n.$ref));
  data.root.connections ??= []; data.root.templates ??= [];
  atoms.sort((a,b) => position(a).localeCompare(position(b))); bonds.sort((a,b) => JSON.stringify(a.atoms).localeCompare(JSON.stringify(b.atoms)));
  return {data,atoms,bonds};
}
export function verifyMolecularPatch(s: any, patch: any, after: string) {
  const expected = executePatch(s, patch);
  if (!same(canonical(expected.ket, expected.hydrogenPositions), canonical(after, expected.hydrogenPositions))) fail('out_of_selection', '候选修改影响了许可范围之外的结构或二维坐标，已拒绝。');
}
export function patchSummary(p: any, language = 'zh-CN') {
  if (language === 'en') {
    if (p.operation === 'replace_atom') return `${p.fromElement} → ${p.element}`;
    if (p.operation === 'change_bond') return `Bond #${p.targetBond}: ${p.fromBondType} → ${p.bondType}`;
    if (p.operation === 'attach_fragment') return `Add ${p.fragment} to atom #${p.targetAtom} (single bond)`;
    return `Delete ${p.atoms.length} atoms and ${p.bonds.length} selected bonds; cut ${p.boundaryBonds.length} boundary bonds${p.boundaryBonds.length ? ': ' + p.boundaryBonds.map((id: number) => '#' + id).join(', ') : ''}`;
  }
  if (p.operation === 'replace_atom') return `${p.fromElement} → ${p.element}`;
  if (p.operation === 'change_bond') return `键 #${p.targetBond}：${p.fromBondType} → ${p.bondType}`;
  if (p.operation === 'attach_fragment') return `原子 #${p.targetAtom} 添加 ${p.fragment}（单键连接）`;
  return `删除 ${p.atoms.length} 个原子、${p.bonds.length} 根选中键；断开 ${p.boundaryBonds.length} 根边界键${p.boundaryBonds.length ? '：' + p.boundaryBonds.map((id: number) => '#' + id).join('、') : ''}`;
}
