import { randomUUID, createHash } from 'node:crypto';
import { readFile, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DocumentError, DocumentStore } from './document-store';
import { selectionAddresses, normalizePatch, verifyMolecularPatch, patchSummary, operations, fragments } from './molecular-patch';

export const elements = ['C', 'N', 'O', 'S', 'P', 'F', 'Cl', 'Br', 'I'];
const active = new Set(['submitting', 'queued', 'validating', 'proposed']);
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
export function verifyPatch(before: string, after: string, address: any, element: string) {
  let a: any, b: any;
  try { a = JSON.parse(before); b = JSON.parse(after); } catch { throw new DocumentError('invalid_patch', '候选结构格式不正确。'); }
  function normalizeDisplay(data: any) {
    if (data.root) { data.root.connections ??= []; data.root.templates ??= []; }
    for (const molecule of Object.values(data) as any[]) {
      if (Array.isArray(molecule?.atoms)) for (const atom of molecule.atoms) delete atom.selected;
      if (Array.isArray(molecule?.bonds)) for (const bond of molecule.bonds) delete bond.selected;
    }
  }
  normalizeDisplay(a); normalizeDisplay(b);
  const original = a[address?.molecule]?.atoms?.[address?.index];
  const target = b[address?.molecule]?.atoms?.[address?.index];
  if (!original || !target || !elements.includes(element)) throw new DocumentError('invalid_patch', '候选结构没有对应的目标原子。');
  original.label = element;
  // Only the target's element and its generated implicit-hydrogen count may change.
  delete original.implicitHCount; delete target.implicitHCount;
  function compare(x: any, y: any): boolean {
    if (typeof x === 'number') return typeof y === 'number' && Math.abs(x - y) <= 0.00001;
    if (x === null || typeof x !== 'object') return x === y;
    if (!y || typeof y !== 'object' || Array.isArray(x) !== Array.isArray(y)) return false;
    const keys = Object.keys(x).sort(); return JSON.stringify(keys) === JSON.stringify(Object.keys(y).sort()) && keys.every(k => compare(x[k], y[k]));
  }
  if (!compare(a, b)) throw new DocumentError('out_of_selection', '候选修改影响了选区以外的结构，已拒绝。');
}

export class AnnotationService {
  private queues = new Map<string, Promise<any>>();
  private waiters = new Map<string, () => void>();
  private frames = new Map<string, any>();
  readonly processId = randomUUID();
  private stopped = false;
  private watched = new Set<string>();
  watches(sessionId: string) { return this.watched.has(sessionId); }
  constructor(private deps: { store: DocumentStore; directoryFor: (id: string) => Promise<string>; prompt: (request: any, signal: AbortSignal) => Promise<any> }) {}
  updateFrame(sessionId: string, snapshot: any) { if (typeof snapshot.instanceId === 'string') this.frames.set(`${sessionId}/${snapshot.instanceId}`, snapshot); }
  private async path(sessionId: string) { return this.deps.store.path(await this.deps.directoryFor(sessionId), sessionId).replace(/\.json$/, '.annotations.json'); }
  private async read(sessionId: string) {
    let records: any[] = [];
    try {
      const data = JSON.parse(await readFile(await this.path(sessionId), 'utf8'));
      if (data.schemaVersion !== 1 || data.sessionId !== sessionId || !Array.isArray(data.records)) throw new Error('invalid journal');
      records = data.records;
      for (const a of records) if (!a || typeof a.id !== 'string' || a.sessionId !== sessionId || !a.frozen || typeof a.frozen.ket !== 'string' || typeof a.instruction !== 'string') throw new Error('invalid annotation');
    } catch (e: any) { if (e.code !== 'ENOENT') throw new DocumentError('annotation_corrupt', '批注存档无法读取，原文件保持。'); }
    const saved = await this.deps.store.read(await this.deps.directoryFor(sessionId), sessionId);
    for (const a of records) if (active.has(a.status) && a.processId !== this.processId) {
      a.status = saved.document?.lastAppliedAnnotationId === a.id ? 'applied' : 'stale';
      a.message = a.status === 'applied' ? '修改已保存。' : '编辑器已重新启动，请重新选择并提交批注。';
    }
    return records;
  }
  private async write(sessionId: string, records: any[]) {
    const file = await this.path(sessionId), temp = `${file}.${randomUUID()}.tmp`;
    await mkdir(dirname(file), { recursive: true });
    try {
      const handle = await open(temp, 'wx');
      try { await handle.writeFile(JSON.stringify({ schemaVersion: 1, sessionId, records: records.slice(-20) }, null, 2) + '\n'); await handle.sync(); } finally { await handle.close(); }
      await rename(temp, file);
    } finally { await unlink(temp).catch(() => {}); }
  }
  private transaction<T>(sessionId: string, fn: (records: any[]) => Promise<T>): Promise<T> {
    const previous = this.queues.get(sessionId) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(async () => fn(await this.read(sessionId)));
    this.queues.set(sessionId, result); result.finally(() => { if (this.queues.get(sessionId) === result) this.queues.delete(sessionId); }).catch(() => {}); return result;
  }
  private find(records: any[], id: string) { const a = records.find(x => x.id === id); if (!a) throw new DocumentError('annotation_not_found', '此会话中没有这条批注。'); return a; }
  private async current(a: any) {
    const saved = await this.deps.store.read(await this.deps.directoryFor(a.sessionId), a.sessionId);
    const frame = this.frames.get(`${a.sessionId}/${a.frozen.instanceId}`);
    if (!saved.document || saved.document.documentId !== a.frozen.documentId || saved.document.revision !== a.frozen.revision || saved.token !== a.baseToken || !frame || frame.revision !== a.frozen.revision || hash(frame.rawKet || '') !== hash(a.frozen.rawKet)) throw new DocumentError('stale_annotation', '结构或文档已经变化，请重新选择并提交批注。');
    return saved;
  }
  private projection(a: any) { const { frozen, candidateKet, baseToken, processId, ...rest } = a; return { ...rest, target: frozen.target, documentId: frozen.documentId, baseRevision: frozen.revision, instanceId: frozen.instanceId }; }
  async list(sessionId: string) { return this.transaction(sessionId, async records => {
    let expired = false;
    for (const a of records) if (active.has(a.status)) { try { await this.current(a); } catch (e: any) { a.status = 'stale'; a.message = e.message; expired = true; this.waiters.get(a.id)?.(); } }
    for (const a of records) if (['submitting', 'queued', 'validating'].includes(a.status) && Date.now() - Date.parse(a.createdAt) > 7 * 60_000) { a.status = 'failed'; a.message = '等待 Agent 超时，请查看聊天后重新提交。'; expired = true; }
    if (expired) await this.write(sessionId, records);
    return records.map(a => this.projection(a));
  }); }
  async presented(sessionId: string, id: string) { return this.transaction(sessionId, async records => { const a = records.find(a => a.id === id); if (a && active.has(a.status)) { a.presented = true; await this.write(sessionId, records); } }); }
  async turnEnded(sessionId: string) { return this.transaction(sessionId, async records => { let changed = false; for (const a of records) if (a.presented && ['submitting', 'queued'].includes(a.status)) { a.status = 'failed'; a.message = 'Agent 未生成修改预览，请查看聊天后重试。'; changed = true; } if (changed) await this.write(sessionId, records); }); }
  async create(sessionId: string, payload: any, signal: AbortSignal) {
    this.watched.add(sessionId);
    const id = payload.submissionId;
    if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{10,80}$/.test(id) || typeof payload.instruction !== 'string' || !payload.instruction.trim() || payload.instruction.length > 1000) throw new DocumentError('invalid_annotation', '请输入有效批注（不超过 1000 字）。');
    const a = await this.transaction(sessionId, async records => {
      const repeated = records.find(a => a.id === id); if (repeated) { if (repeated.instruction !== payload.instruction.trim()) throw new DocumentError('request_conflict', '批注请求标识已被使用。'); return repeated; }
      if (records.some(a => active.has(a.status))) throw new DocumentError('annotation_busy', '请先完成或取消当前批注。');
      const s = payload.snapshot, targetId = s?.selection?.atoms?.[0];
      const target = s?.atoms?.find((a: any) => a.id === targetId);
      if (!s?.selection || !Array.isArray(s.selection.atoms) || !Array.isArray(s.selection.bonds) || !(s.selection.atoms.length || s.selection.bonds.length) || typeof s.rawKet !== 'string' || s.rawKet.length > 2_000_000 || typeof s.instanceId !== 'string') throw new DocumentError('invalid_selection', '请选择普通原子、键或局部片段。');
      const saved = await this.deps.store.read(await this.deps.directoryFor(sessionId), sessionId);
      if (!saved.document || saved.token !== payload.baseToken || saved.document.documentId !== s.documentId || saved.document.revision !== s.revision) throw new DocumentError('stale_annotation', '请等待结构保存完成后重新提交批注。');
      selectionAddresses(s);
      this.updateFrame(sessionId, s);
      const created = { id, sessionId, processId: this.processId, instruction: payload.instruction.trim(), status: 'submitting', createdAt: new Date().toISOString(), baseToken: saved.token, frozen: structuredClone({ ...s, target }), message: '正在提交给 Agent…' };
      records.push(created); await this.write(sessionId, records); return created;
    });
    if (a.status === 'submitting') {
      try {
        const content = `用户从分子画布提交了一条局部编辑批注。\n批注 ID：${id}\n用户要求：${a.instruction}\n先调用 chem_get_context 核对冻结选区，再调用 chem_propose_edit。operation 支持 replace_atom（targetAtom、element）、change_bond（targetBond、bondType=1/2/3）、attach_fragment（targetAtom、fragment=OH/CH3/NH2/F/Cl）、delete_selection（删除整个冻结选区，不另传目标）。每次只生成一个操作并提供简短 reason。添加和替换含义不同；要求有歧义时先澄清。\n不要用文件工具、shell、完整 SMILES 或鼠标改分子，不要自动应用。预览通过后告诉用户在分子面板点击“应用修改”。不支持的操作请说明，不要猜测。`;
        await this.deps.prompt({ sessionId, requestId: id, content: [{ type: 'text', text: content }], mode: 'followup', clientTimeZone: 'Asia/Shanghai' }, signal);
        await this.transaction(sessionId, async records => { const live = this.find(records, id); if (live.status === 'submitting') { live.status = 'queued'; live.message = 'Agent 正在处理批注…'; await this.write(sessionId, records); } });
      } catch (e: any) { await this.transaction(sessionId, async records => { const live = this.find(records, id); if (live.status === 'submitting') { live.status = 'failed'; live.message = `提交失败：${e.message}`; await this.write(sessionId, records); } }); throw e; }
    }
    return this.projection(a);
  }
  async context(sessionId: string, id: string, full = false) {
    return this.transaction(sessionId, async records => {
      const a = this.find(records, id); if (!active.has(a.status)) throw new DocumentError('annotation_inactive', '批注已结束或失效，请不要继续生成修改。');
      await this.current(a);
      const selected = new Set(a.frozen.selection.atoms), selectedBonds = new Set(a.frozen.selection.bonds);
      for (const b of a.frozen.bonds) if (selectedBonds.has(b.id)) { selected.add(b.begin); selected.add(b.end); }
      const bonds = a.frozen.bonds.filter((b: any) => selected.has(b.begin) || selected.has(b.end));
      const neighborhood = new Set([...selected, ...bonds.flatMap((b: any) => [b.begin, b.end])]);
      return { annotationId: id, status: a.status, context: JSON.stringify({ documentId: a.frozen.documentId, baseRevision: a.frozen.revision, instruction: a.instruction, selectedAtom: a.frozen.target, selection: a.frozen.selection, boundaryBonds: bonds.filter((b: any) => selected.has(b.begin) !== selected.has(b.end)), atoms: full ? a.frozen.atoms : a.frozen.atoms.filter((x: any) => neighborhood.has(x.id)), bonds: full ? a.frozen.bonds : bonds, atomCount: a.frozen.atoms.length, allowedOperations: operations, allowedElements: elements, allowedFragments: Object.keys(fragments), allowedBondTypes: [1,2,3] }) };
    });
  }
  async propose(sessionId: string, args: any, signal: AbortSignal) {
    await this.transaction(sessionId, async records => {
      const a = this.find(records, args.annotationId);
      if (a.status === 'proposed' && JSON.stringify(a.patch) === JSON.stringify(normalizePatch(a.frozen, args))) return;
      if (!['queued', 'submitting'].includes(a.status)) throw new DocumentError('annotation_inactive', '这条批注已有方案或已结束。');
      await this.current(a);
      a.patch = normalizePatch(a.frozen, args);
      a.status = 'validating'; a.message = '正在检查候选结构…'; await this.write(sessionId, records);
    });
    const deadline = Date.now() + 25000;
    try { while (Date.now() < deadline) {
      if (this.stopped) throw new Error('批注服务已卸载。');
      signal?.throwIfAborted();
      const a = await this.transaction(sessionId, async records => this.find(records, args.annotationId));
      if (a.status === 'proposed') return { annotationId: a.id, status: 'preview_ready', summary: `${patchSummary(a.patch)}。等待用户应用。` };
      if (a.status !== 'validating') throw new DocumentError('preview_rejected', a.message);
      await new Promise<void>(resolve => { const done = () => { clearTimeout(timer); this.waiters.delete(a.id); resolve(); }; const timer = setTimeout(done, 500); this.waiters.set(a.id, done); });
    }
    throw new DocumentError('editor_unavailable', '编辑器没有完成预览验证；请打开对应分子面板并重新提交批注。');
    } catch (e: any) {
      if (!this.stopped) await this.transaction(sessionId, async records => { const a = this.find(records, args.annotationId); if (a.status === 'validating') { a.status = signal?.aborted ? 'cancelled' : 'failed'; a.message = e.message; await this.write(sessionId, records); } });
      throw e;
    }
  }
  async validation(sessionId: string, payload: any) {
    return this.transaction(sessionId, async records => {
      const a = this.find(records, payload.annotationId);
      if (a.status !== 'validating' || payload.instanceId !== a.frozen.instanceId) throw new DocumentError('stale_annotation', '候选预览已经失效。');
      try {
        await this.current(a);
        if (!payload.valid) throw new DocumentError('chemical_invalid', String(payload.message || '结构检查未通过。').slice(0, 800));
        if (a.patch.operation === 'replace_atom') verifyPatch(a.frozen.rawKet, payload.candidateKet, a.frozen.targetAddress, a.patch.element); else verifyMolecularPatch(a.frozen, a.patch, payload.candidateKet);
        a.candidateKet = payload.candidateKet; a.status = 'proposed'; a.message = '预览已通过检查，等待你应用。';
      } catch (e: any) { a.status = e.code === 'stale_annotation' ? 'stale' : 'failed'; a.message = e.message; }
      await this.write(sessionId, records); this.waiters.get(a.id)?.(); return this.projection(a);
    });
  }
  async commit(sessionId: string, payload: any) {
    return this.transaction(sessionId, async records => {
      const a = this.find(records, payload.annotationId), directory = await this.deps.directoryFor(sessionId);
      const saved = await this.deps.store.read(directory, sessionId);
      if (saved.document?.lastAppliedAnnotationId === a.id) { a.status = 'applied'; a.message = '修改已保存。'; await this.write(sessionId, records); return saved; }
      if (a.status !== 'proposed' || payload.instanceId !== a.frozen.instanceId) throw new DocumentError('annotation_inactive', '此批注不可应用。');
      await this.current(a);
      if (payload.document.documentId !== a.frozen.documentId || payload.document.revision !== a.frozen.revision + 1) throw new DocumentError('stale_annotation', '应用版本不匹配。');
      if (a.patch.operation === 'replace_atom') verifyPatch(a.frozen.rawKet, payload.document.ket, a.frozen.targetAddress, a.patch.element); else verifyMolecularPatch(a.frozen, a.patch, payload.document.ket);
      const result = await this.deps.store.save(directory, sessionId, { ...payload.document, lastAppliedAnnotationId: a.id }, a.baseToken);
      a.status = 'applied'; a.message = '修改已保存，可撤销。'; a.appliedAt = new Date().toISOString();
      // The receipt in the atomic document write recovers this state if the journal write fails.
      await this.write(sessionId, records).catch(() => {}); this.waiters.get(a.id)?.(); return result;
    });
  }
  async cancel(sessionId: string, id: string, instanceId?: string) {
    return this.transaction(sessionId, async records => { const a = this.find(records, id); if (instanceId && instanceId !== a.frozen.instanceId) throw new DocumentError('wrong_editor', '请在提交批注的编辑器取消。'); if (active.has(a.status)) { a.status = 'cancelled'; a.message = '已取消，原结构保持。'; await this.write(sessionId, records); } this.waiters.get(id)?.(); return this.projection(a); });
  }
  async detail(sessionId: string, id: string) { return this.transaction(sessionId, async records => structuredClone(this.find(records, id))); }
  async detach(sessionId: string, instanceId: string) {
    this.frames.delete(`${sessionId}/${instanceId}`);
    return this.transaction(sessionId, async records => { for (const a of records) if (a.frozen.instanceId === instanceId && active.has(a.status)) { a.status = 'stale'; a.message = '编辑器已关闭，请重新选择并提交批注。'; this.waiters.get(a.id)?.(); } await this.write(sessionId, records); });
  }
  async drain() { this.stopped = true; for (const wake of this.waiters.values()) wake(); await Promise.allSettled([...this.queues.values()]); }
}
