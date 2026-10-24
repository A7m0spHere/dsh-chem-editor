import { fromAtomsAttrs, fromNewCanvas, Coordinates, KetcherAsyncEvents, KetSerializer } from 'ketcher-core';
import { executePatch, verifyMolecularPatch } from '../../chemistry/molecular-patch';
import { checkCandidate } from '../indigo/validation';
import { executeDraft, verifyDraftCandidate } from '../../chemistry/draft';
import type { Selection, SelectionSnapshot } from '../../contracts/molecule';

type SnapshotContext = { documentId: string; revision: number; instanceId: string; selection: Selection; attachmentAtom: number | null; isCurrent: () => boolean };

const propsOf = (obj: any) => Object.fromEntries(Object.entries(obj).filter(([k, v]) => !['implicitH', 'implicitHCount', 'neighbors', 'badConn', 'valence', 'hasImplicitH'].includes(k) && typeof v !== 'function'));
export function fingerprint(struct: any) {
  const atoms: any[] = [], bonds: any[] = [];
  struct.atoms.forEach((a: any, id: number) => atoms.push([id, propsOf(a)]));
  struct.bonds.forEach((b: any, id: number) => bonds.push([id, { ...b }]));
  return { atoms, bonds };
}
export function contentFingerprint(struct: any) {
  // Serialize document content, including text and drawing objects, rather than
  // comparing transient renderer fields such as bond lengths and hitboxes.
  const data = JSON.parse(new KetSerializer().serializeMicromolecules(struct));
  const molecules = Object.values(data).filter((v: any) => Array.isArray(v?.atoms)) as any[];
  const origin = molecules[0]?.atoms[0]?.location || [0, 0, 0];
  for (const molecule of molecules) for (const atom of molecule.atoms) if (atom.location) atom.location = atom.location.map((n: number, i: number) => Math.round((n - (origin[i] || 0)) * 100000) / 100000);
  return JSON.stringify(data);
}
export async function captureSnapshot(current: any, context: SnapshotContext, withTarget = false): Promise<SelectionSnapshot> {
    const base = context.revision, frozenSelection = structuredClone(context.selection);
    const frozenAttachment = context.attachmentAtom;
    const ket = await current.getKet();
    if (!context.isCurrent()) throw new Error('结构正在变化，请重新选择。');
    const struct = current.editor.struct(), atoms: any[] = [], bonds: any[] = [];
    struct.atoms.forEach((a: any, id: number) => atoms.push({ id, element: a.label, charge: a.charge, isotope: a.isotope, implicitHydrogens: a.implicitH }));
    struct.bonds.forEach((b: any, id: number) => bonds.push({ id, begin: b.begin, end: b.end, type: b.type, stereo: b.stereo }));
    const serializer = new KetSerializer(), rawKet = serializer.serializeMicromolecules(struct);
    let targetAddress: any, atomAddresses: any, bondAddresses: any, aromaticBonds: number[] = [];
    if (withTarget) {
      const s = frozenSelection;
      if (!(s.atoms.length || s.bonds.length) || struct.sgroups.size || struct.rgroups.size) throw new Error('请选择普通原子、键或框选局部片段。');
      // AAM tagging is applied to a clone only, never to the user's molecule.
      const clone = struct.clone(); clone.atoms.forEach((a: any,id: number) => { a.aam = id + 1; });
      const tagged = JSON.parse(serializer.serializeMicromolecules(clone)), original = JSON.parse(rawKet);
      atomAddresses = {}; bondAddresses = {};
      for (const [molecule, data] of Object.entries(tagged) as any) if (Array.isArray(data?.atoms)) data.atoms.forEach((a: any,index: number) => { atomAddresses[a.mapping - 1] = { molecule, index }; });
      for (const b of bonds) {
        const begin = atomAddresses[b.begin], end = atomAddresses[b.end];
        const index = original[begin.molecule]?.bonds?.findIndex((x: any) => x.atoms[0] === begin.index && x.atoms[1] === end.index);
        if (begin.molecule !== end.molecule || index < 0) throw new Error('无法映射所选键，请重新选择。');
        bondAddresses[b.id] = {molecule: begin.molecule,index};
      }
      if (s.atoms.length === 1) targetAddress = atomAddresses[s.atoms[0]];
      // Indigo identifies aromatic bonds even when Ketcher renders Kekulé bonds.
      // Map by preserved coordinates instead of assuming exported IDs are stable.
      const aromatic = await current.indigo.aromatize(struct.clone());
      aromatic.bonds.forEach((b: any) => {
        if (b.type !== 4) return;
        const a = aromatic.atoms.get(b.begin).pp, c = aromatic.atoms.get(b.end).pp;
        const match = bonds.find((v: any) => {
          const p = struct.atoms.get(v.begin).pp, q = struct.atoms.get(v.end).pp;
          const near = (x: any,y: any) => Math.hypot(x.x-y.x,x.y-y.y) < 0.00001;
          return near(a,p) && near(c,q) || near(a,q) && near(c,p);
        });
        if (!match) throw new Error('无法映射芳香键，请重新选择。'); aromaticBonds.push(match.id);
      });
      if (!context.isCurrent()) throw new Error('结构正在变化，请重新选择。');
    }
    return { documentId: context.documentId, revision: base, ket, rawKet, atoms, bonds, selection: frozenSelection, instanceId: context.instanceId, ...(frozenAttachment !== null ? { attachmentAtom: frozenAttachment } : {}), ...(atomAddresses ? { atomAddresses, bondAddresses, targetAddress, aromaticBonds } : {}) };
  }
export function loadMolecule(instance: any, text: string) {
    // In 3.7.0 setMolecule resolves before runAsyncAction has filled the canvas.
    // Wait for that editor instance's completion event instead of its early promise.
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timeout); instance.eventBus.removeListener(KetcherAsyncEvents.SUCCESS, success); instance.eventBus.removeListener(KetcherAsyncEvents.FAILURE, failure); };
      const success = () => { cleanup(); resolve(); };
      const failure = () => { cleanup(); reject(new Error('结构载入失败，请检查分子格式。')); };
      const timeout = setTimeout(() => { cleanup(); reject(new Error('载入超时，请重新打开编辑器后重试。')); }, 30000);
      instance.eventBus.once(KetcherAsyncEvents.SUCCESS, success); instance.eventBus.once(KetcherAsyncEvents.FAILURE, failure);
      instance.setMolecule(text).catch((e: Error) => { cleanup(); reject(e); });
    });
  }

export const rawKetOf = (current: any): string => new KetSerializer().serializeMicromolecules(current.editor.struct());

export async function prepareCandidate(current: any, frozen: SelectionSnapshot, patch: any) {
  const serializer = new KetSerializer();
  const candidate = patch.operation === 'replace_atom' ? current.editor.struct().clone() : serializer.deserializeToStruct(patch.operation === 'draft' ? executeDraft(frozen, patch.edits).snapshot.rawKet : executePatch(frozen, patch).ket);
  if (patch.operation === 'replace_atom') candidate.atoms.get(patch.targetAtom).label = patch.element;
  const { existingStereo } = await checkCandidate(current.indigo, candidate, current.editor.struct());
  const candidateKet = serializer.serializeMicromolecules(candidate);
  if (patch.operation === 'draft') verifyDraftCandidate(frozen, patch.edits, candidateKet);
  else if (patch.operation !== 'replace_atom') verifyMolecularPatch(frozen, patch, candidateKet);
  const before = await current.generateImage(frozen.rawKet, { outputFormat: 'svg' });
  const after = await current.generateImage(candidateKet, { outputFormat: 'svg' });
  return { candidateKet, existingStereo, before, after };
}

export function rollbackAction(current: any, action: any) {
  action.perform(current.editor.render.ctab); current.editor.update(true);
}

export function stageElement(current: any, id: number, element: string, message = '修改会影响其他结构属性，已拒绝。') {
  const before = fingerprint(current.editor.struct());
  const action = fromAtomsAttrs(current.editor.render.ctab, id, { label: element }, false);
  try {
    const expected = structuredClone(before);
    expected.atoms.find(([aid]: any) => aid === id)[1].label = element;
    if (JSON.stringify(fingerprint(current.editor.struct())) !== JSON.stringify(expected)) throw new Error(message);
    return action;
  } catch (error) { rollbackAction(current, action); throw error; }
}

export function stagePatch(current: any, frozen: SelectionSnapshot, patch: any, candidateKet: string) {
  if (patch.operation === 'replace_atom') return stageElement(current, patch.targetAtom, patch.element);
  const action = fromNewCanvas(current.editor.render.ctab, new KetSerializer().deserializeToStruct(candidateKet));
  try {
    if (patch.operation === 'draft') verifyDraftCandidate(frozen, patch.edits, rawKetOf(current));
    else verifyMolecularPatch(frozen, patch, rawKetOf(current));
    return action;
  }
  catch (error) { rollbackAction(current, action); throw error; }
}

export async function checkElement(current: any, id: number, element: string) {
  const struct = current.editor.struct();
  if (struct.sgroups.size || struct.rgroups.size) throw new Error('暂不支持 S-group / R-group 内的替换。');
  const candidate = struct.clone(); candidate.atoms.get(id).label = element;
  await checkCandidate(current.indigo, candidate);
}

export function atomPoint(instance: any, id: number) {
  const p = Coordinates.modelToView(instance.editor.struct().atoms.get(id).pp);
  const r = instance.editor.render.clientArea.getBoundingClientRect(), v = instance.editor.render.viewBox;
  return { x: r.x + p.x - v.minX, y: r.y + p.y - v.minY };
}
