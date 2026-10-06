// Shared deterministic executor. The model chooses an operation, never a replacement graph.
import { fragments, resolveFragment, fragmentList, fragmentName } from './fragments';
import { fragmentPositions } from './fragment-layout';
export { fragments } from './fragments';
export const singleOperations = ['replace_atom', 'change_bond', 'attach_fragment', 'replace_fragment', 'delete_selection'];
export const operations = [...singleOperations, 'batch'];
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
function normalizeSingle(s: any, args: any) {
  const op = args.operation || 'replace_atom', atoms = s.selection.atoms, bonds = s.selection.bonds;
  if (!singleOperations.includes(op)) fail('invalid_patch', '不支持此修改操作。');
  const patch: any = { operation: op, reason: String(args.reason || '').slice(0, 800) };
  if (op === 'replace_atom' || op === 'attach_fragment') {
    if (op === 'replace_atom' && (atoms.length !== 1 || bonds.length || args.targetAtom !== atoms[0])) fail('out_of_selection', '改元素需要单独选择一个原子，请重新选择后提交。');
    if (op === 'attach_fragment') {
      const anchor = s.attachmentAtom ?? (atoms.length === 1 ? atoms[0] : undefined);
      if (anchor === undefined) fail('connection_point_required', '添加基团需要明确连接点，请在批注区选择一个连接原子后重新提交。');
      if (!atoms.includes(anchor) || args.targetAtom !== anchor) fail('out_of_selection', '连接点必须是批注提交时指定的选区内原子，请使用冻结的连接点。');
    }
    patch.targetAtom = args.targetAtom;
    if (op === 'replace_atom') {
      patch.fromElement = s.atoms.find((a: any) => a.id === atoms[0]).element;
      if (!['C','N','O','S','P','F','Cl','Br','I'].includes(args.element) || args.element === patch.fromElement) fail('out_of_selection', '请选择另一种支持的元素。');
      patch.element = args.element;
    } else {
      if (args.fragment === 'C3H7') fail('ambiguous_fragment', 'C3H7 无法区分正丙基与异丙基，请明确基团名称后重新提交。');
      const fragment = resolveFragment(args.fragment);
      if (!fragment) fail('unsupported_fragment', `暂不支持这个基团。当前支持 ${fragmentList()}，请修改要求后重新提交。`);
      patch.fragment = fragment;
    }
  } else if (op === 'replace_fragment') {
    if (!atoms.length) fail('invalid_selection', '请选择要替换的末端原子或片段。');
    const selected = new Set(atoms), boundary = s.bonds.filter((b: any) => selected.has(b.begin) !== selected.has(b.end));
    if (boundary.length !== 1 || boundary[0].type !== 1 || boundary[0].stereo) fail('unsupported_boundary', '片段替换只支持一个普通单键出口，请选择末端原子或片段；多出口和立体连接需要另行处理。');
    if (bonds.some((id: number) => { const b=s.bonds.find((b: any)=>b.id===id); return !b || !selected.has(b.begin) && !selected.has(b.end); })) fail('out_of_selection', '选中的键必须属于要替换的片段或其唯一边界。');
    const reached = new Set([atoms[0]]);
    for (let previous=0; previous!==reached.size;) { previous=reached.size; for (const b of s.bonds) if (selected.has(b.begin) && selected.has(b.end) && (reached.has(b.begin)||reached.has(b.end))) { reached.add(b.begin); reached.add(b.end); } }
    if (reached.size !== atoms.length) fail('invalid_selection', '要替换的片段必须连通，请重新选择。');
    if (args.fragment === 'C3H7') fail('ambiguous_fragment', '请明确替换为正丙基还是异丙基。');
    const fragment = resolveFragment(args.fragment);
    if (!fragment) fail('unsupported_fragment', `暂不支持这个替换片段。当前支持 ${fragmentList()}。`);
    patch.fragment=fragment; patch.atoms=[...atoms]; patch.bonds=[...bonds];
    patch.targetAtom=selected.has(boundary[0].begin)?boundary[0].end:boundary[0].begin;
    patch.connectionBond=boundary[0].id;
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
export function normalizePatch(s: any, args: any): any {
  if (args.operation !== 'batch') return normalizeSingle(s,args);
  if (!s.atomAddresses || !s.bondAddresses) fail('invalid_selection', '复合修改需要完整冻结映射，请重新选择并提交批注。');
  if (!Array.isArray(args.edits) || args.edits.length < 2 || args.edits.length > 8) fail('invalid_patch', '复合修改必须包含 2 至 8 个操作，一次完整提交。');
  let current=s; const edits:any[]=[], boundaries:number[]=[];
  for (const edit of args.edits) {
    const patch=normalizeSingle(current,edit), result=executeSingle(current,patch);
    edits.push(patch); boundaries.push(...result.boundaryBonds); current=nextSnapshot(current,result.ket,patch);
  }
  return {operation:'batch',edits,reason:String(args.reason||'').slice(0,800),boundaryBonds:[...new Set(boundaries)]};
}
export function executePatch(s: any, patch: any): any {
  if (patch.operation !== 'batch') return executeSingle(s,patch);
  let current=s; const touched=new Set<string>(), boundaryBonds=new Set<number>();
  for (const edit of patch.edits) {
    const result=executeSingle(current,edit); result.hydrogenPositions.forEach((p:string)=>touched.add(p));result.boundaryBonds.forEach((id:number)=>boundaryBonds.add(id));
    current=nextSnapshot(current,result.ket,edit);
  }
  return {ket:current.rawKet,hydrogenPositions:[...touched],boundaryBonds:[...boundaryBonds]};
}
// Internal mapping for a single frozen-version transaction. New atoms are never
// implicitly selected; removed targets cannot be reused by a later step.
function nextSnapshot(s: any, ket: string, patch: any) {
  const before=JSON.parse(s.rawKet),after=JSON.parse(ket),removed=new Set(['delete_selection','replace_fragment'].includes(patch.operation)?patch.atoms:[]);
  const oldAtoms=new Map(s.atoms.filter((a:any)=>!removed.has(a.id)).map((a:any)=>{const p=s.atomAddresses?.[a.id]||s.targetAddress;return [position(before[p.molecule].atoms[p.index]),a.id];}));
  let atomId=Math.max(-1,...s.atoms.map((a:any)=>a.id))+1,bondId=Math.max(-1,...s.bonds.map((b:any)=>b.id))+1;
  const atoms:any[]=[],bonds:any[]=[],atomAddresses:any={},bondAddresses:any={},seen=new Set<string>();
  const oldBonds=new Map(s.bonds.filter((b:any)=>!removed.has(b.begin)&&!removed.has(b.end)).map((b:any)=>[`${b.begin}:${b.end}`,b.id]));
  for(const [molecule,m] of Object.entries(after) as any[]) if(m?.type==='molecule') {
    const ids=m.atoms.map((a:any,index:number)=>{const p=position(a);if(seen.has(p))fail('ambiguous_coordinates','存在重叠原子，无法执行复合修改，请先调整布局。');seen.add(p);const id=oldAtoms.get(p)??atomId++;atomAddresses[id]={molecule,index};atoms.push({id,element:a.label,charge:a.charge,isotope:a.isotope,implicitHydrogens:a.implicitHCount});return id;});
    (m.bonds||[]).forEach((b:any,index:number)=>{const begin=ids[b.atoms[0]],end=ids[b.atoms[1]],id=oldBonds.get(`${begin}:${end}`)??bondId++;bondAddresses[id]={molecule,index};bonds.push({id,begin,end,type:b.type,stereo:b.stereo||0});});
  }
  const selection={atoms:s.selection.atoms.filter((id:number)=>Object.hasOwn(atomAddresses,id)),bonds:s.selection.bonds.filter((id:number)=>Object.hasOwn(bondAddresses,id))};
  return {...s,rawKet:ket,ket,atoms,bonds,atomAddresses,bondAddresses,selection,attachmentAtom:selection.atoms.includes(s.attachmentAtom)?s.attachmentAtom:undefined,targetAddress:selection.atoms.length===1?atomAddresses[selection.atoms[0]]:undefined,aromaticBonds:bonds.filter(b=>b.type===4||(s.aromaticBonds||[]).includes(b.id)).map(b=>b.id)};
}
function executeSingle(s: any, patch: any) {
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
    if (['delete_selection','replace_fragment'].includes(patch.operation) && s.bonds.some((b: any) => (aromatic.has(b.id)||b.type===4) && (selectedAtoms.has(b.begin) || selectedAtoms.has(b.end) || selectedBonds.has(b.id)))) fail('protected_aromatic', '删除或替换会断开原有芳香体系，请手工处理芳香环。');
    if (patch.operation === 'attach_fragment') changedIds.add(patch.targetAtom);
    if (patch.operation === 'change_bond') { const b = s.bonds.find((b: any) => b.id === patch.targetBond); changedIds.add(b.begin); changedIds.add(b.end); }
    if (['delete_selection','replace_fragment'].includes(patch.operation)) for (const b of s.bonds) if (selectedAtoms.has(b.begin) || selectedAtoms.has(b.end) || selectedBonds.has(b.id)) {
      if (!selectedAtoms.has(b.begin)) changedIds.add(b.begin);
      if (!selectedAtoms.has(b.end)) changedIds.add(b.end);
      if (selectedAtoms.has(b.begin) !== selectedAtoms.has(b.end)) boundaryBonds.push(b.id);
    }
    for (const id of changedIds) {
      const a = atomOf(id), adjacent = s.bonds.filter((b: any) => b.begin === id || b.end === id);
      if (a.stereoLabel || a.stereoGroup || a.cip || adjacent.some((b: any) => b.stereo || (!['attach_fragment','replace_fragment'].includes(patch.operation) && b.type === 4))) fail('protected_stereo', '操作会改变芳香体系或邻接立体中心，请手工处理这处结构。');
      touched.add(position(a)); delete a.implicitHCount;
    }
    if (patch.operation === 'change_bond') {
      const address = s.bondAddresses[patch.targetBond], b = data[address.molecule].bonds[address.index];
      if (![1,2,3].includes(b.type) || b.stereo) fail('protected_stereo', '只支持普通非立体单键、双键和三键。');
      b.type = patch.bondType;
    } else if (patch.operation === 'attach_fragment') {
      const m = moleculeOf(patch.targetAtom), anchor = addressOf(patch.targetAtom).index;
      const template = fragments[patch.fragment as keyof typeof fragments];
      const points = fragmentPositions(data, addressOf(patch.targetAtom).molecule, anchor, patch.fragment), offset = m.atoms.length;
      m.bonds.push({ type: template.bondType, atoms: [anchor, offset + template.attachment] });
      for (const b of template.bonds) m.bonds.push({ type: b.type, atoms: b.atoms.map(i => offset + i) });
      template.atoms.forEach((a, i) => { const added = { label: a.label, location: points[i], implicitHCount: a.hydrogen }; m.atoms.push(added); touched.add(position(added)); });
    } else if (patch.operation === 'delete_selection' || patch.operation === 'replace_fragment') {
      const connection = patch.operation === 'replace_fragment' ? structuredClone(data[s.bondAddresses[patch.connectionBond].molecule].bonds[s.bondAddresses[patch.connectionBond].index]) : null;
      let replacementAnchor=-1;
      for (const [key,m] of Object.entries(data) as any[]) if (Array.isArray(m?.atoms)) {
        const removed = new Set<number>([...selectedAtoms].map((id: any) => addressOf(id)).filter(a => a.molecule === key).map(a => a.index));
        const removedBonds = new Set<number>([...selectedBonds].map((id: any) => s.bondAddresses[id]).filter((a: any) => a.molecule === key).map((a: any) => a.index));
        const map = new Map<number,number>(); const atoms = m.atoms.filter((_: any,i: number) => { if (removed.has(i)) return false; map.set(i,map.size); return true; });
        if(patch.operation==='replace_fragment' && key===addressOf(patch.targetAtom).molecule) replacementAnchor=map.get(addressOf(patch.targetAtom).index)!;
        m.bonds = m.bonds.filter((b: any,i: number) => !removedBonds.has(i) && !b.atoms.some((n: number) => removed.has(n))).map((b: any) => ({...b, atoms: b.atoms.map((n: number) => map.get(n))})); m.atoms = atoms;
        if (!atoms.length) { delete data[key]; data.root.nodes = data.root.nodes.filter((n: any) => n.$ref !== key); }
      }
      if(patch.operation==='replace_fragment') {
        const key=addressOf(patch.targetAtom).molecule,m=data[key],template=fragments[patch.fragment],points=fragmentPositions(data,key,replacementAnchor,patch.fragment),offset=m.atoms.length;
        const originalAnchor=addressOf(patch.targetAtom).index;
        connection.atoms=connection.atoms.map((i:number)=>i===originalAnchor?replacementAnchor:offset+template.attachment);
        m.bonds.push(connection,...template.bonds.map(b=>({type:b.type,atoms:b.atoms.map(i=>offset+i)})));
        template.atoms.forEach((a,i)=>{const added={label:a.label,location:points[i],implicitHCount:a.hydrogen};m.atoms.push(added);touched.add(position(added));});
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
  if(p.operation==='batch')return `${language==='en'?'Complete edit':'完整修改'}：${p.edits.map((edit:any,i:number)=>`${i+1}. ${patchSummary(edit,language)}`).join('；')}`;
  if(p.operation==='replace_fragment')return language==='en'?`Replace ${p.atoms.length} selected atoms with ${fragmentName(p.fragment,language)}; reconnect bond #${p.connectionBond}`:`将选区 ${p.atoms.length} 个原子替换为${fragmentName(p.fragment)}；重接边界键 #${p.connectionBond}`;
  if (language === 'en') {
    if (p.operation === 'replace_atom') return `${p.fromElement} → ${p.element}`;
    if (p.operation === 'change_bond') return `Bond #${p.targetBond}: ${p.fromBondType} → ${p.bondType}`;
    if (p.operation === 'attach_fragment') return `Add ${fragmentName(p.fragment, language)} to atom #${p.targetAtom} (single bond)`;
    return `Delete ${p.atoms.length} atoms and ${p.bonds.length} selected bonds; cut ${p.boundaryBonds.length} boundary bonds${p.boundaryBonds.length ? ': ' + p.boundaryBonds.map((id: number) => '#' + id).join(', ') : ''}`;
  }
  if (p.operation === 'replace_atom') return `${p.fromElement} → ${p.element}`;
  if (p.operation === 'change_bond') return `键 #${p.targetBond}：${p.fromBondType} → ${p.bondType}`;
  if (p.operation === 'attach_fragment') return `原子 #${p.targetAtom} 添加 ${fragmentName(p.fragment, language)}（单键连接）`;
  return `删除 ${p.atoms.length} 个原子、${p.bonds.length} 根选中键；断开 ${p.boundaryBonds.length} 根边界键${p.boundaryBonds.length ? '：' + p.boundaryBonds.map((id: number) => '#' + id).join('、') : ''}`;
}
