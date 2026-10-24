import { randomUUID, createHash } from 'node:crypto';
import { readFile, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DocumentError, DocumentStore } from './document-store';
import { selectionAddresses, normalizePatch, verifyMolecularPatch, patchSummary, operations } from '../chemistry/molecular-patch';
import { fragmentCatalog, fragmentIds } from '../chemistry/fragment-spec';
import { verifyEditIntent } from '../chemistry/edit-intent';

import { elements, rejectionCodes, bondTypes } from '../contracts/operations';
export { elements, rejectionCodes } from '../contracts/operations';
import { buildAnnotationPrompt } from './prompt';
import { EditSessionService } from './edit-session-service';
import { verifyDraftCandidate } from '../chemistry/draft';
const active = new Set(['submitting', 'queued', 'draft_ready', 'validating', 'proposed', 'needs_clarification']);
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
  private drafts = new EditSessionService();
  private queues = new Map<string, Promise<any>>();
  private waiters = new Map<string, () => void>();
  private frames = new Map<string, any>();
  readonly processId = randomUUID();
  private stopped = false;
  private watched = new Set<string>();
  private replies = new Map<string, {rpcId: string; text: string}>();
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
  private projection(a: any) { const { frozen, candidateKet, baseToken, processId, ...rest } = a; return { ...rest, target: frozen.target, selection:frozen.selection, documentId: frozen.documentId, baseRevision: frozen.revision, instanceId: frozen.instanceId }; }
  async list(sessionId: string) { return this.transaction(sessionId, async records => {
    let expired = false;
    for (const a of records) if (active.has(a.status)) { try { await this.current(a); } catch (e: any) { a.status = 'stale'; a.message = e.message; expired = true; this.waiters.get(a.id)?.(); } }
    for (const a of records) if (['submitting', 'queued', 'validating'].includes(a.status) && Date.now() - Date.parse(a.updatedAt||a.createdAt) > 7 * 60_000) { a.status = 'failed'; a.message = '等待 Agent 超时，可补充要求继续此批注。'; expired = true; }
    if (expired) await this.write(sessionId, records);
    return records.map(a => this.projection(a));
  }); }
  async presented(sessionId: string, id: string) { return this.transaction(sessionId, async records => { const a = records.find(a => a.id === id); if (a && active.has(a.status)) { a.presented = true; await this.write(sessionId, records); } }); }
  async userMessage(sessionId: string, data: any) {
    return this.transaction(sessionId, async records => {
      const id=data?.source?.rpcId,a=records.find(a=>a.id===id||a.turnRequestId===id);
      if(a&&active.has(a.status)){a.presented=true;await this.write(sessionId,records);return;}
      if(a)return;
      if(data?.source?.kind!=='user'||typeof id!=='string'||!Array.isArray(data.content))return;
      const text=data.content.filter((b:any)=>b.type==='text').map((b:any)=>b.text||'').join('\n').trim();
      if(text&&text.length<=2000)this.replies.set(sessionId,{rpcId:id,text});
    });
  }
  async turnEnded(sessionId: string) { return this.transaction(sessionId, async records => { let changed = false; for (const a of records) if (a.presented && ['submitting', 'queued'].includes(a.status)) { a.status = 'failed'; a.errorCode = a.lastProposalError?.code || 'no_proposal'; a.message = a.lastProposalError?.message || 'Agent 未生成修改预览，请查看聊天中的说明，补充要求后重新提交。'; changed = true; } if (changed) await this.write(sessionId, records); }); }
  async create(sessionId: string, payload: any, signal: AbortSignal) {
    this.watched.add(sessionId);
    const id = payload.submissionId;
    if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{10,80}$/.test(id) || typeof payload.instruction !== 'string' || !payload.instruction.trim() || payload.instruction.length > 1000) throw new DocumentError('invalid_annotation', '请输入有效批注（不超过 1000 字）。');
    const a = await this.transaction(sessionId, async records => {
      const repeated = records.find(a => a.id === id); if (repeated) { if (repeated.instruction !== payload.instruction.trim()) throw new DocumentError('request_conflict', '批注请求标识已被使用。'); return repeated; }
      if (records.some(a => active.has(a.status))) throw new DocumentError('annotation_busy', '请先完成或取消当前批注。');
      const s = payload.snapshot, targetId = s?.attachmentAtom ?? (s?.selection?.atoms?.length === 1 ? s.selection.atoms[0] : undefined);
      if (payload.protocolVersion !== undefined && ![1, 2].includes(payload.protocolVersion)) throw new DocumentError('invalid_protocol', '不支持此批注协议。');
      const target = s?.atoms?.find((a: any) => a.id === targetId);
      if (!s?.selection || !Array.isArray(s.selection.atoms) || !Array.isArray(s.selection.bonds) || !(s.selection.atoms.length || s.selection.bonds.length) || typeof s.rawKet !== 'string' || s.rawKet.length > 2_000_000 || typeof s.instanceId !== 'string') throw new DocumentError('invalid_selection', '请选择普通原子、键或局部片段。');
      const saved = await this.deps.store.read(await this.deps.directoryFor(sessionId), sessionId);
      if (!saved.document || saved.token !== payload.baseToken || saved.document.documentId !== s.documentId || saved.document.revision !== s.revision) throw new DocumentError('stale_annotation', '请等待结构保存完成后重新提交批注。');
      selectionAddresses(s);
      if (s.attachmentAtom !== undefined && (!Number.isSafeInteger(s.attachmentAtom) || !s.selection.atoms.includes(s.attachmentAtom))) throw new DocumentError('invalid_selection', '连接点必须位于本次冻结选区内。');
      this.updateFrame(sessionId, s);
      const created = { id, sessionId, processId: this.processId, protocolVersion: payload.protocolVersion ?? 1, instruction: payload.instruction.trim(), status: 'submitting', createdAt: new Date().toISOString(), baseToken: saved.token, frozen: structuredClone({ ...s, target }), message: '正在提交给 Agent…' };
      records.push(created); await this.write(sessionId, records); this.replies.delete(sessionId); return created;
    });
    if (a.status === 'submitting') await this.enqueue(sessionId,a,signal);
    return this.projection(a);
  }
  private async enqueue(sessionId:string,a:any,signal:AbortSignal) {
    const id=a.id;
    try {
      const content = buildAnnotationPrompt(a);
      await this.deps.prompt({sessionId,requestId:a.turnRequestId||id,content:[{type:'text',text:content}],mode:'followup',clientTimeZone:'Asia/Shanghai'},signal);
      await this.transaction(sessionId,async records=>{const live=this.find(records,id);if(live.status==='submitting'){live.status='queued';live.message='Agent 正在处理批注…';await this.write(sessionId,records);}});
    } catch(e:any){await this.transaction(sessionId,async records=>{const live=this.find(records,id);if(live.status==='submitting'){live.status='failed';live.message=`提交失败：${e.message}`;await this.write(sessionId,records);}});throw e;}
  }
  async context(sessionId: string, id: string, full = false) {
    return this.transaction(sessionId, async records => {
      const a = this.find(records, id); if (!active.has(a.status)&&a.status!=='failed') throw new DocumentError('annotation_inactive', '批注已应用、取消或失效，请重新选择，不要复用旧目标。');
      await this.current(a);
      const selected = new Set(a.frozen.selection.atoms), selectedBonds = new Set(a.frozen.selection.bonds);
      for (const b of a.frozen.bonds) if (selectedBonds.has(b.id)) { selected.add(b.begin); selected.add(b.end); }
      const bonds = a.frozen.bonds.filter((b: any) => selected.has(b.begin) || selected.has(b.end));
      const neighborhood = new Set([...selected, ...bonds.flatMap((b: any) => [b.begin, b.end])]);
      return { annotationId: id, status: a.status, context: JSON.stringify({ protocolVersion: a.protocolVersion ?? 1, draft: this.drafts.has(id) ? this.drafts.view(id,a.frozen) : null, previewVersion:a.previewVersion??null, documentId: a.frozen.documentId, baseRevision: a.frozen.revision, instruction: a.instruction, clarification: a.clarification ?? null, latestUserReply: this.replies.get(sessionId)?.text ?? null, canContinue: ['failed','needs_clarification'].includes(a.status), continuationRule: '补充后先调用 chem_continue_edit，userReply 必须照抄 latestUserReply；已应用/取消/过期批注不能继续。', selectedAtom: a.frozen.target, attachmentAtom: a.frozen.target?.id ?? null, attachmentCandidates: a.frozen.selection.atoms, selection: a.frozen.selection, boundaryBonds: bonds.filter((b: any) => selected.has(b.begin) !== selected.has(b.end)), atoms: full ? a.frozen.atoms : a.frozen.atoms.filter((x: any) => neighborhood.has(x.id)), bonds: full ? a.frozen.bonds : bonds, atomCount: a.frozen.atoms.length, allowedOperations: operations, allowedElements: elements, allowedFragments: fragmentIds, fragmentTemplates: fragmentCatalog(), fragmentNaming: '丙基/propyl 默认正丙基；C3H7 需澄清正丙基或异丙基。固定表之外的基团用带 [*] 连接点的片段 SMILES（如 [*]C#N 氰基），或不带 [*] 时必须用 fragmentConnection 声明原子序号（0 起）与键级。', completePlanRule: '必须覆盖整条要求，复合修改用 batch.edits（2 至 8 步），不支持时暂停并澄清；不能擅自提交替代基团或前半部分。', allowedBondTypes: bondTypes }) };
    });
  }
  async propose(sessionId: string, args: any, signal: AbortSignal) {
    await this.transaction(sessionId, async records => {
      const a = this.find(records, args.annotationId);
      if(a.protocolVersion===2)throw new DocumentError('wrong_protocol','草稿批注请使用 chem_begin_edit/chem_edit_draft/chem_validate_draft/chem_propose_draft。');
      if (a.status === 'proposed' && JSON.stringify(a.patch) === JSON.stringify(normalizePatch(a.frozen, args))) return;
      if (!['queued', 'submitting'].includes(a.status)) throw new DocumentError('annotation_inactive', '这条批注已有方案或已结束。');
      try {
        await this.current(a);
        a.patch = normalizePatch(a.frozen, args);
        verifyEditIntent(a.instruction,a.patch,a.clarification);
        delete a.lastProposalError; delete a.errorCode;
      } catch (e: any) {
        delete a.patch;
        a.lastProposalError = { code: e.code || 'invalid_patch', message: e.message };
        a.message = e.message;
        if (e.code === 'stale_annotation') { a.status = 'stale'; a.errorCode = e.code; }
        await this.write(sessionId, records); throw e;
      }
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
  async draftCommand(sessionId: string, action: string, args: any, signal?: AbortSignal) {
    const reply = (a: any, context: any) => ({ annotationId: a.id, status: a.status, context: JSON.stringify(context) });
    const started = await this.transaction(sessionId, async records => {
      const a = this.find(records, args.annotationId);
      if (a.protocolVersion !== 2) throw new DocumentError('wrong_protocol', '请在面板选择草稿模式后提交批注，不能混用 v1/v2。');
      if (!['submitting', 'queued', 'draft_ready', 'validating', 'proposed'].includes(a.status)) throw new DocumentError('annotation_inactive', '这条批注已经结束或需真实用户补充，不能继续草稿。');
      await this.current(a);
      if (action === 'begin') {
        const existed = this.drafts.has(a.id), view = this.drafts.begin(a.id, a.frozen);
        if (!existed) { a.status = 'draft_ready'; a.message = 'Agent 正在编辑草稿，原画布保持不变。'; await this.write(sessionId, records); }
        return { response: reply(a, view) };
      }
      if (action === 'edit') {
        const previous = this.drafts.view(a.id, a.frozen).draftRevision;
        try {
          const view = this.drafts.edit(a.id, a.frozen, args);
          if (this.drafts.view(a.id, a.frozen).draftRevision !== previous) {
            a.status = 'draft_ready'; a.message = `草稿 v${view.draftRevision} 已更新，尚未应用。`;
            a.previewVersion = (a.previewVersion || 0) + 1;
            delete a.patch; delete a.candidateKet; delete a.draftValidation; delete a.lastDraftError;
            await this.write(sessionId, records);
          }
          return { response: reply(a, view) };
        } catch (error: any) {
          a.lastDraftError = { code: error.code || 'invalid_patch', message: error.message };
          await this.write(sessionId, records); throw error;
        }
      }
      if (!['validate', 'propose'].includes(action)) throw new DocumentError('invalid_request', '不支持此草稿命令。');
      this.drafts.assertVersion(a.id, args.editSessionId, args.expectedDraftRevision);
      if (a.status === 'validating') throw new DocumentError('draft_busy', '草稿正在检查，请等待结果或提交修正操作使旧检查失效。');
      if (action === 'propose') {
        this.drafts.requireValidated(a.id); this.drafts.checkIntent(a.id, a.frozen, a.instruction, a.clarification);
        if (typeof args.reason !== 'string' || !args.reason.trim() || args.reason.length > 800) throw new DocumentError('invalid_request', '请说明完整修改结果。');
      }
      a.previewVersion = (a.previewVersion || 0) + 1;
      a.patch = this.drafts.plan(a.id, a.previewVersion, args.reason || '草稿结构检查');
      a.draftValidation = { id: randomUUID(), revision: a.patch.draftRevision, kind: action === 'propose' ? 'propose' : 'check' };
      a.status = 'validating'; a.message = '正在检查草稿结构…'; delete a.candidateKet;
      await this.write(sessionId, records);
      return { validationId: a.draftValidation.id };
    });
    if (started.response) return started.response;
    try {
      const deadline = Date.now() + 25000;
      while (Date.now() < deadline) {
        signal?.throwIfAborted(); if (this.stopped) throw new DocumentError('editor_unavailable', '插件已卸载。');
        const response = await this.transaction(sessionId, async records => {
          const a = this.find(records, args.annotationId);
          if (a.draftValidation?.id !== started.validationId) throw new DocumentError('stale_proposal', '草稿已修订，旧检查失效。');
          if (!['validating', 'draft_ready', 'proposed'].includes(a.status)) throw new DocumentError('annotation_inactive', a.message);
          return a.status === 'validating' ? null : reply(a, this.drafts.view(a.id, a.frozen));
        });
        if (response) return response;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new DocumentError('editor_unavailable', '编辑器未完成草稿检查，请保持原分子工作区打开。');
    } catch (error: any) {
      if (!this.stopped) await this.transaction(sessionId, async records => {
        const a = this.find(records, args.annotationId);
        if (a.status === 'validating' && a.draftValidation?.id === started.validationId) {
          this.drafts.validated(a.id, a.patch.draftRevision, false, error.message); a.status = 'draft_ready'; a.message = error.message;
          await this.write(sessionId, records);
        }
      });
      throw error;
    }
  }
  async reject(sessionId: string, args: any) {
    if (!rejectionCodes.includes(args.code) || typeof args.reason !== 'string' || !args.reason.trim() || args.reason.length > 800) throw new DocumentError('invalid_rejection', '请提供具体的无法修改原因和下一步（不超过 800 字）。');
    return this.transaction(sessionId, async records => {
      const a = this.find(records, args.annotationId);
      if (!['queued', 'submitting', ...(a.protocolVersion===2?['draft_ready']:[])].includes(a.status)) throw new DocumentError('annotation_inactive', '这条批注已有预览或已结束。');
      await this.current(a);
      a.status = ['clarification_required','ambiguous_fragment','connection_point_required'].includes(args.code)?'needs_clarification':'failed'; a.errorCode = args.code; a.message = args.reason.trim();
      await this.write(sessionId, records);
      return { annotationId: a.id, status: a.status, summary: a.message };
    });
  }
  async continueEdit(sessionId: string,args: any,signal?: AbortSignal,fromPanel=false) {
    const a=await this.transaction(sessionId,async records=>{
      const a=this.find(records,args.annotationId);
      if(!['needs_clarification','failed'].includes(a.status))throw new DocumentError('annotation_inactive','只能继续待补充或失败的批注，已应用、取消或已有预览的批注不能复用。');
      if(fromPanel&&args.instanceId!==a.frozen.instanceId)throw new DocumentError('wrong_editor','请在原批注的编辑器补充要求。');
      await this.current(a);
      if(typeof args.userReply!=='string'||!args.userReply.trim()||args.userReply.length>1000)throw new DocumentError('invalid_clarification','请补充具体修改要求（不超过 1000 字）。');
      const reply=this.replies.get(sessionId);
      if(!fromPanel&&(!reply||reply.text!==args.userReply.trim()))throw new DocumentError('unverified_clarification','补充内容必须与当前聊天中实际收到的用户消息一致，不能由 Agent 改写目标。');
      if(fromPanel&&args.attachmentAtom!==undefined){if(!a.frozen.selection.atoms.includes(args.attachmentAtom))throw new DocumentError('out_of_selection','连接点必须位于原批注的冻结选区内。');a.frozen.attachmentAtom=args.attachmentAtom;a.frozen.target=a.frozen.atoms.find((x:any)=>x.id===args.attachmentAtom);}
      this.drafts.discard(a.id); delete a.draftValidation; a.previewVersion=(a.previewVersion||0)+1;
      a.clarification=args.userReply.trim();a.status=fromPanel?'submitting':'queued';a.presented=!fromPanel;a.updatedAt=new Date().toISOString();
      a.message='已收到补充，正在重新生成完整修改预览…';a.turnRequestId=fromPanel?randomUUID():reply!.rpcId;
      delete a.patch;delete a.candidateKet;delete a.lastProposalError;delete a.errorCode;this.replies.delete(sessionId);
      await this.write(sessionId,records);return a;
    });
    if(fromPanel)await this.enqueue(sessionId,a,signal!);
    return {annotationId:a.id,status:a.status,summary:a.message};
  }
  async validation(sessionId: string, payload: any) {
    return this.transaction(sessionId, async records => {
      const a = this.find(records, payload.annotationId);
      if (a.status !== 'validating' || payload.instanceId !== a.frozen.instanceId) throw new DocumentError('stale_annotation', '候选预览已经失效。');
      if(a.protocolVersion===2) {
        const job=a.draftValidation;
        if(!job||payload.previewVersion!==a.previewVersion||payload.validationId!==job.id||payload.draftRevision!==job.revision)throw new DocumentError('stale_proposal','过期校验不能覆盖新草稿。');
        try {
          await this.current(a);
          if(!payload.valid)throw new DocumentError('chemical_invalid',String(payload.message||'结构检查未通过。').slice(0,800));
          verifyDraftCandidate(a.frozen,a.patch.edits,payload.candidateKet);
          this.drafts.validated(a.id,job.revision,true,'化学和修改范围检查通过。');
          a.candidateKet=payload.candidateKet;a.status=job.kind==='propose'?'proposed':'draft_ready';a.message=job.kind==='propose'?'草稿预览已通过检查，等待你应用。':'草稿检查通过，可继续修订或提交完整预览。';
        } catch(e:any) {
          if(e.code==='stale_annotation'){a.status='stale';this.drafts.discard(a.id);}
          else {this.drafts.validated(a.id,job.revision,false,e.message);a.status='draft_ready';}
          a.message=e.message;delete a.candidateKet;
        }
        await this.write(sessionId,records);return this.projection(a);
      }
      try {
        await this.current(a);
        if (!payload.valid) throw new DocumentError('chemical_invalid', String(payload.message || '结构检查未通过。').slice(0, 800));
        if (a.patch.operation === 'replace_atom') verifyPatch(a.frozen.rawKet, payload.candidateKet, a.frozen.targetAddress, a.patch.element); else verifyMolecularPatch(a.frozen, a.patch, payload.candidateKet);
        a.candidateKet = payload.candidateKet; a.status = 'proposed'; a.message = '预览已通过检查，等待你应用。';
      } catch (e: any) { a.status = e.code === 'stale_annotation' ? 'stale' : 'failed'; a.errorCode = e.code || 'preview_rejected'; a.message = e.message; }
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
      if(a.protocolVersion===2){
        if(payload.previewVersion!==a.previewVersion||payload.draftRevision!==a.patch.draftRevision)throw new DocumentError('stale_proposal','应用的预览版本已经失效。');
        this.drafts.requireValidated(a.id);this.drafts.checkIntent(a.id,a.frozen,a.instruction,a.clarification);
        verifyDraftCandidate(a.frozen,a.patch.edits,payload.document.ket);
      } else if (a.patch.operation === 'replace_atom') verifyPatch(a.frozen.rawKet, payload.document.ket, a.frozen.targetAddress, a.patch.element); else verifyMolecularPatch(a.frozen, a.patch, payload.document.ket);
      const result = await this.deps.store.save(directory, sessionId, { ...payload.document, lastAppliedAnnotationId: a.id }, a.baseToken);
      this.drafts.discard(a.id);
      a.status = 'applied'; a.message = '修改已保存，可撤销。'; a.appliedAt = new Date().toISOString();
      // The receipt in the atomic document write recovers this state if the journal write fails.
      await this.write(sessionId, records).catch(() => {}); this.waiters.get(a.id)?.(); return result;
    });
  }
  async cancel(sessionId: string, id: string, instanceId?: string) {
    return this.transaction(sessionId, async records => { const a = this.find(records, id); if (instanceId && instanceId !== a.frozen.instanceId) throw new DocumentError('wrong_editor', '请在提交批注的编辑器取消。'); if (active.has(a.status)) { this.drafts.discard(a.id); a.status = 'cancelled'; a.message = '已取消，原结构保持。'; await this.write(sessionId, records); } this.waiters.get(id)?.(); return this.projection(a); });
  }
  async detail(sessionId: string, id: string) { return this.transaction(sessionId, async records => structuredClone(this.find(records, id))); }
  async detach(sessionId: string, instanceId: string) {
    this.frames.delete(`${sessionId}/${instanceId}`);
    return this.transaction(sessionId, async records => { for (const a of records) if (a.frozen.instanceId === instanceId && active.has(a.status)) { this.drafts.discard(a.id); a.status = 'stale'; a.message = '编辑器已关闭，请重新选择并提交批注。'; this.waiters.get(a.id)?.(); } await this.write(sessionId, records); });
  }
  async drain() { this.stopped = true; this.drafts.clear(); for (const wake of this.waiters.values()) wake(); await Promise.allSettled([...this.queues.values()]); }
}
