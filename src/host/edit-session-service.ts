import { randomUUID } from 'node:crypto';
import { executeDraft, draftContext, verifyDraftIntent } from '../chemistry/draft';
import { draftLimits, type DraftStep, type DraftPlan } from '../contracts/draft';
import type { SelectionSnapshot } from '../contracts/molecule';
import { DocumentError } from './document-store';

const stable = (value: any): string => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
type Journal = {
  id: string; steps: DraftStep[]; revision: number; nextAtomId: number; nextBondId: number;
  receipts: Map<string, { hash: string; value?: any; error?: { code: string; message: string } }>;
  validation?: { revision: number; valid: boolean; message: string };
};

// Only draft content and receipts live here. AnnotationService owns lifecycle,
// caller/revision checks, serialization and all document commits.
export class EditSessionService {
  private journals = new Map<string, Journal>();
  begin(annotationId: string, base: SelectionSnapshot) {
    if (!this.journals.has(annotationId)) {
      executeDraft(base, []);
      this.journals.set(annotationId, { id: randomUUID(), steps: [], revision: 0, nextAtomId: Math.max(-1, ...base.atoms.map(a => a.id)) + 1, nextBondId: Math.max(-1, ...base.bonds.map(b => b.id)) + 1, receipts: new Map() });
    }
    return this.view(annotationId, base);
  }
  private get(annotationId: string, id?: string) {
    const journal = this.journals.get(annotationId);
    if (!journal || id !== undefined && journal.id !== id) throw new DocumentError('wrong_edit_session', '草稿会话不存在或引用不属于这条批注，请重新读取上下文。');
    return journal;
  }
  assertVersion(annotationId: string, id: string, revision: number) {
    if (typeof id !== 'string' || !id) throw new DocumentError('wrong_edit_session', '缺少草稿会话引用。');
    const journal = this.get(annotationId, id);
    if (!Number.isSafeInteger(revision) || journal.revision !== revision) throw new DocumentError('draft_conflict', '草稿版本已变化，请读取当前版本后重试。');
    return journal;
  }
  view(annotationId: string, base: SelectionSnapshot) {
    const journal = this.get(annotationId), result = executeDraft(base, journal.steps);
    return { protocolVersion: 2, editSessionId: journal.id, draftRevision: journal.revision, stepCount: journal.steps.length, limits: draftLimits, validation: journal.validation ?? null, ...draftContext(result, base) };
  }
  edit(annotationId: string, base: SelectionSnapshot, args: any) {
    if (typeof args.editSessionId !== 'string' || !args.editSessionId) throw new DocumentError('wrong_edit_session', '缺少草稿会话引用。');
    const journal = this.get(annotationId, args.editSessionId);
    if (typeof args.requestId !== 'string' || !args.requestId || args.requestId.length > 160) throw new DocumentError('invalid_request', '草稿操作需要唯一 requestId。');
    const hash = stable(args), prior = journal.receipts.get(args.requestId);
    if (prior) {
      if (prior.hash !== hash) throw new DocumentError('request_conflict', '同一 requestId 不能用于不同操作。');
      if (prior.error) throw new DocumentError(prior.error.code, prior.error.message);
      return structuredClone(prior.value);
    }
    this.assertVersion(annotationId, args.editSessionId, args.expectedDraftRevision);
    if (journal.receipts.size >= draftLimits.requests) throw new DocumentError('draft_budget', '草稿调用达到运行预算，请取消后重新提交。');
    try {
      if (!Array.isArray(args.edits) || !args.edits.length || args.edits.length > draftLimits.operationsPerCall) throw new DocumentError('invalid_patch', '一次草稿调用需包含 1 至 8 个操作。');
      const rewind = args.rewindToStep ?? journal.steps.length;
      if (!Number.isSafeInteger(rewind) || rewind < 0 || rewind > journal.steps.length) throw new DocumentError('invalid_rewind', '回退位置必须是当前已有步骤的位置。');
      if (rewind + args.edits.length > draftLimits.totalSteps) throw new DocumentError('draft_budget', '草稿步骤达到运行预算，不能截断用户要求。');
      const steps = structuredClone(journal.steps.slice(0, rewind));
      let nextAtomId = journal.nextAtomId, nextBondId = journal.nextBondId;
      for (const edit of args.edits) {
        steps.push({ edit: structuredClone(edit), nextAtomId, nextBondId });
        const result = executeDraft(base, steps);
        nextAtomId = Math.max(nextAtomId, result.snapshot.nextAtomId); nextBondId = Math.max(nextBondId, result.snapshot.nextBondId);
      }
      journal.steps = steps; journal.nextAtomId = nextAtomId; journal.nextBondId = nextBondId; journal.revision++; delete journal.validation;
      const value = this.view(annotationId, base);
      journal.receipts.set(args.requestId, { hash, value: structuredClone(value) });
      return value;
    } catch (error: any) {
      journal.receipts.set(args.requestId, { hash, error: { code: error.code || 'invalid_patch', message: error.message } });
      throw error;
    }
  }
  plan(annotationId: string, previewVersion: number, reason: string): DraftPlan {
    const journal = this.get(annotationId);
    return { operation: 'draft', protocolVersion: 2, edits: structuredClone(journal.steps), reason, draftRevision: journal.revision, previewVersion };
  }
  checkIntent(annotationId: string, base: SelectionSnapshot, instruction: string, clarification?: string) {
    verifyDraftIntent(base, this.get(annotationId).steps, instruction, clarification);
  }
  validated(annotationId: string, revision: number, valid: boolean, message: string) {
    const journal = this.get(annotationId);
    if (journal.revision !== revision) throw new DocumentError('draft_conflict', '过期的化学检查不能覆盖新草稿。');
    journal.validation = { revision, valid, message };
  }
  requireValidated(annotationId: string) {
    const journal = this.get(annotationId);
    if (!journal.validation?.valid || journal.validation.revision !== journal.revision) throw new DocumentError('draft_unvalidated', '请先调用 chem_validate_draft 检查当前完整草稿。');
  }
  has(annotationId: string) { return this.journals.has(annotationId); }
  discard(annotationId: string) { this.journals.delete(annotationId); }
  clear() { this.journals.clear(); }
}
