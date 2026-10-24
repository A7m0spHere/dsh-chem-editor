import type { AnnotationService } from '../annotation-service';
import { singleOperations, elements, bondTypes } from '../../contracts/operations';
import { draftLimits } from '../../contracts/draft';
import { fragmentInputs } from '../../chemistry/fragment-spec';

export function registerDraftTools(ctx: any, annotations: AnnotationService) {
  const properties = {
    annotationId: { type: 'string' }, editSessionId: { type: 'string' }, expectedDraftRevision: { type: 'integer', minimum: 0 },
  };
  const fragmentParameter = { type: 'string', description: `Fragment id/alias (${fragmentInputs.filter(name => !/[\s]/.test(name)).slice(0, 40).join(', ')}…), or fragment SMILES with an explicit [*] attachment, or SMILES plus fragmentConnection.` };
  const edit = { type: 'object', properties: { operation: { type: 'string', enum: singleOperations }, targetAtom: { type: 'string', description: 'Exact a: reference from the current draft; no numeric indices.' }, targetBond: { type: 'string' }, atomRefs: { type: 'array', items: { type: 'string' } }, bondRefs: { type: 'array', items: { type: 'string' } }, element: { type: 'string', enum: elements }, fragment: fragmentParameter, fragmentConnection: { type: 'object', properties: { atom: { type: 'integer', minimum: 0 }, bondType: { type: 'integer', enum: bondTypes } }, required: ['atom', 'bondType'], additionalProperties: false }, bondType: { type: 'integer', enum: bondTypes }, reason: { type: 'string' } }, required: ['operation'], additionalProperties: false };
  for (const [name, action, description, parameters] of [
    ['chem_begin_edit', 'begin', 'Begin/read a protocolVersion=2 draft from this annotation. The original canvas stays unchanged. Read chem_get_context first. Returns stable atom/bond refs including newly created objects; never widen the original scope.', { type: 'object', properties: { annotationId: properties.annotationId }, required: ['annotationId'], additionalProperties: false }],
    ['chem_edit_draft', 'edit', 'Edit the molecular draft with existing operations. Read returned refs and neighbors before targeting newly created atoms. A group is atomic. requestId retries never duplicate work. To repair an earlier operation use rewindToStep (keep that many earlier steps) and submit the corrected suffix. Errors preserve draft content; no automatic application.', { type: 'object', properties: { ...properties, requestId: { type: 'string' }, rewindToStep: { type: 'integer', minimum: 0 }, edits: { type: 'array', minItems: 1, maxItems: draftLimits.operationsPerCall, items: edit } }, required: ['annotationId', 'editSessionId', 'expectedDraftRevision', 'requestId', 'edits'], additionalProperties: false }],
    ['chem_validate_draft', 'validate', 'Validate current draft through the actual editor/Indigo, without presenting or applying it. Invalid chemistry returns diagnostics; repair the draft, then validate again. Binds the report to expectedDraftRevision.', { type: 'object', properties, required: Object.keys(properties), additionalProperties: false }],
    ['chem_propose_draft', 'propose', 'Present one preview of the validated complete draft. Checks every requested operation and the new-terminal target when specified. Incomplete/substituted plans are rejected. Revisions invalidate old previews; the user applies once and undoes once.', { type: 'object', properties: { ...properties, reason: { type: 'string', minLength: 1, maxLength: 800 } }, required: [...Object.keys(properties), 'reason'], additionalProperties: false }],
  ] as const) {
    ctx.tools.register({ name, description, parameters, isConcurrencySafe: () => false,
      output: { schema: { type: 'object', properties: { annotationId: { type: 'string' }, status: { type: 'string' }, context: { type: 'string' } }, required: ['annotationId', 'status', 'context'], additionalProperties: false }, render: (_args: any, value: any) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute(args: any, exec: any) {
        const sessionId = exec?.agent?.session?.id;
        if (typeof sessionId !== 'string' || !sessionId) throw new Error('chem-editor: caller session is required');
        exec.signal?.throwIfAborted(); return annotations.draftCommand(sessionId, action, args, exec.signal);
      },
    });
  }
}
