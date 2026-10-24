import { normalizePatch, executePatch, selectionAddresses, verifyCandidateKet } from './molecular-patch';
import { verifyEditIntent } from './edit-intent';
import { atomRef, bondRef, draftLimits, type DraftOperation, type DraftStep, type DraftResult } from '../contracts/draft';
import type { SelectionSnapshot } from '../contracts/molecule';

const fail = (code: string, message: string): never => { throw Object.assign(new Error(message), { code }); };

export function executeDraft(base: SelectionSnapshot, steps: DraftStep[]): DraftResult {
  selectionAddresses(base);
  if (!base.atomAddresses || !base.bondAddresses) fail('invalid_selection', '草稿需要完整冻结映射。');
  let current: any = structuredClone(base);
  const allowedAtoms = new Set(base.selection.atoms), allowedBonds = new Set(base.selection.bonds);
  const patches: any[] = [], hydrogenPositions = new Set<string>(), createdAtoms: number[] = [], createdBonds: number[] = [];
  const resolveRef = (ref: unknown, atom: boolean) => {
    const objects = atom ? current.atoms : current.bonds;
    const id = objects.find((item: any) => (atom ? atomRef(item.id) : bondRef(item.id)) === ref)?.id;
    if (id === undefined) fail('missing_target', '目标引用不存在或已被删除，请读取当前草稿。');
    if (!(atom ? allowedAtoms : allowedBonds).has(id)) fail('out_of_selection', '不能扩大冻结选区；只可编辑原选区与本草稿新建对象。');
    return id as number;
  };
  for (const step of steps) {
    const edit = step.edit;
    let atoms: number[] = [], bonds: number[] = [], targetAtom: number | undefined, targetBond: number | undefined;
    if (['replace_atom', 'attach_fragment'].includes(edit.operation)) {
      targetAtom = resolveRef(edit.targetAtom, true); atoms = [targetAtom];
      if (edit.operation === 'attach_fragment' && base.atoms.some(a => a.id === targetAtom) && targetAtom !== (base.attachmentAtom ?? (base.selection.atoms.length === 1 ? base.selection.atoms[0] : undefined))) fail('connection_point_required', '原有原子添加仍需使用冻结连接点。');
    } else if (edit.operation === 'change_bond') { targetBond = resolveRef(edit.targetBond, false); bonds = [targetBond]; }
    else if (['delete_selection', 'replace_fragment'].includes(edit.operation)) {
      atoms = (edit.atomRefs || []).map(ref => resolveRef(ref, true)); bonds = (edit.bondRefs || []).map(ref => resolveRef(ref, false));
      if (new Set(atoms).size !== atoms.length || new Set(bonds).size !== bonds.length) fail('invalid_selection', '不能重复引用删除或替换的目标。');
    }
    current = { ...current, selection: { atoms, bonds }, attachmentAtom: targetAtom, nextAtomId: step.nextAtomId, nextBondId: step.nextBondId };
    const patch = normalizePatch(current, { ...edit, targetAtom, targetBond });
    // Bounded A1 target contract for the new terminal atom; other language work
    // remains in the v1 complete-intent checker until A3.
    const result = executePatch(current, patch), next = result.snapshot;
    const addedAtoms = next.atoms.filter((a: any) => !current.atoms.some((old: any) => old.id === a.id)).map((a: any) => a.id);
    const addedBonds = next.bonds.filter((b: any) => !current.bonds.some((old: any) => old.id === b.id)).map((b: any) => b.id);
    addedAtoms.forEach((id: number) => { allowedAtoms.add(id); createdAtoms.push(id); });
    addedBonds.forEach((id: number) => { allowedBonds.add(id); createdBonds.push(id); });
    patches.push(patch); result.hydrogenPositions.forEach((p: string) => hydrogenPositions.add(p)); current = next;
    if (current.atoms.length > draftLimits.atoms) fail('draft_budget', '草稿原子数达到运行预算。');
  }
  current.nextAtomId ??= Math.max(-1, ...current.atoms.map((a: any) => a.id)) + 1;
  current.nextBondId ??= Math.max(-1, ...current.bonds.map((b: any) => b.id)) + 1;
  return { snapshot: current, patches, hydrogenPositions: [...hydrogenPositions], createdAtoms, createdBonds };
}

export function verifyDraftIntent(base: SelectionSnapshot, steps: DraftStep[], instruction: string, clarification?: string) {
  const result = executeDraft(base, steps);
  verifyEditIntent(instruction, { operation: 'batch', edits: result.patches }, clarification);
  const text = clarification || instruction;
  if (/(?:新建|新加|新生成|新片段|新.*末端)/.test(text) && /末端/.test(text)) {
    const index = result.patches.findIndex((patch, i) => i > 0 && patch.operation === 'replace_atom');
    if (index < 0) fail('intent_mismatch', '要求编辑新片段末端，但计划没有对应修改。');
    const before = executeDraft(base, steps.slice(0, index)).snapshot, target = result.patches[index].targetAtom;
    if (base.atoms.some(a => a.id === target) || before.bonds.filter(b => b.begin === target || b.end === target).length !== 1) fail('intent_mismatch', '要求的目标是新片段末端，不能替换原原子或内部原子。');
  }
}

export function verifyDraftCandidate(base: SelectionSnapshot, steps: DraftStep[], candidateKet: string) {
  const result = executeDraft(base, steps);
  verifyCandidateKet(result.snapshot.rawKet, candidateKet, result.hydrogenPositions);
}

export function draftContext(result: DraftResult, base: SelectionSnapshot) {
  const selected = new Set(base.selection.atoms), selectedBonds = new Set(base.selection.bonds);
  return {
    atoms: result.snapshot.atoms.map(atom => ({ ...atom, ref: atomRef(atom.id), created: result.createdAtoms.includes(atom.id), editable: selected.has(atom.id) || result.createdAtoms.includes(atom.id), neighbors: result.snapshot.bonds.filter(b => b.begin === atom.id || b.end === atom.id).map(b => atomRef(b.begin === atom.id ? b.end : b.begin)) })),
    bonds: result.snapshot.bonds.map(bond => ({ ...bond, ref: bondRef(bond.id), beginRef: atomRef(bond.begin), endRef: atomRef(bond.end), editable: selectedBonds.has(bond.id) || result.createdBonds.includes(bond.id) })),
  };
}
