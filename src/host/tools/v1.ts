import { operations, singleOperations, elements, rejectionCodes, bondTypes, batchLimits } from '../../contracts/operations';
import { fragmentInputs } from '../../chemistry/fragments';
import type { AnnotationService } from '../annotation-service';

export function registerV1Tools(ctx: any, annotations: AnnotationService) {
  const toolSession = (exec: any) => {
    const id = exec?.agent?.session?.id;
    if (typeof id !== 'string' || !id) throw new Error('chem-editor: caller session is required');
    return id;
  };
  const output = (fields: Record<string, any>) => ({ schema: { type: 'object', properties: fields, required: Object.keys(fields), additionalProperties: false }, render: (_args: any, value: any) => [{ type: 'text', text: JSON.stringify(value) }] });
  const editProperties={operation:{type:'string',enum:singleOperations},targetAtom:{type:'integer'},targetBond:{type:'integer'},bondType:{type:'integer',enum:bondTypes},fragment:{type:'string',enum:fragmentInputs},element:{type:'string',enum:elements},reason:{type:'string'}};
  ctx.tools.register({
    name: 'chem_get_context', description: 'Read the frozen molecular atom/bond/box selection for a user annotation in this calling session. IDs belong only to this frozen snapshot. Use before chem_propose_edit; never edit molecule files directly.',
    parameters: { type: 'object', properties: { annotationId: { type: 'string' }, fullGraph: { type: 'boolean' } }, required: ['annotationId'], additionalProperties: false },
    output: output({ annotationId: { type: 'string' }, status: { type: 'string' }, context: { type: 'string' } }),
    isConcurrencySafe: () => true,
    async execute(args: any, exec: any) { exec.signal?.throwIfAborted(); return annotations.context(toolSession(exec), args.annotationId, args.fullGraph === true); },
  });
  ctx.tools.register({
    name: 'chem_propose_edit', description: 'Propose a complete local edit on the frozen selection. Single operations: replace_atom targetAtom/element; change_bond targetBond/bondType; attach_fragment targetAtom/fragment; replace_fragment fragment (entire connected selection, exactly one non-stereo single-bond exit); delete_selection. For compound requests use operation=batch, edits=[all requested steps] (2-8). All steps are validated/applied/undone together. Targets refer only to original frozen IDs. Never substitute another group or submit an unapproved partial edit. No arbitrary graphs/SMILES. The human applies the preview.',
    parameters: { type: 'object', properties: { ...editProperties, annotationId: { type: 'string' }, operation: { type: 'string', enum: operations }, edits:{type:'array',minItems:batchLimits.min,maxItems:batchLimits.max,items:{type:'object',properties:editProperties,required:['operation'],additionalProperties:false}}, targetAtom: { type: 'integer', description: 'For attachment use context.attachmentAtom. Never guess an anchor.' }, fragment: { type: 'string', enum: fragmentInputs, description: 'ID/alias from fragmentTemplates. propyl means n-propyl; phenyl/苯环 means a phenyl group.' } }, required: ['annotationId', 'operation', 'reason'], additionalProperties: false },
    output: output({ annotationId: { type: 'string' }, status: { type: 'string' }, summary: { type: 'string' } }),
    async execute(args: any, exec: any) { return annotations.propose(toolSession(exec), args, exec.signal); },
  });
  ctx.tools.register({
    name:'chem_continue_edit',description:'Continue a needs_clarification/failed annotation after an actual user reply. Read chem_get_context first and copy latestUserReply exactly into userReply. Cannot invent user consent, change the frozen selection, reuse applied/cancelled/stale annotations, or bypass preview.',
    parameters:{type:'object',properties:{annotationId:{type:'string'},userReply:{type:'string',minLength:1,maxLength:1000}},required:['annotationId','userReply'],additionalProperties:false},
    output:output({annotationId:{type:'string'},status:{type:'string'},summary:{type:'string'}}),isConcurrencySafe:()=>false,
    async execute(args:any,exec:any){exec.signal?.throwIfAborted();return annotations.continueEdit(toolSession(exec),args,exec.signal);},
  });
  ctx.tools.register({
    name: 'chem_reject_edit', description: 'Finish an annotation without changing the molecule when the requested operation is unsupported or needs clarification. Persist the concrete reason and actionable next step in the molecular panel. Read chem_get_context first; do not reject an existing preview.',
    parameters: { type: 'object', properties: { annotationId: { type: 'string' }, code: { type: 'string', enum: rejectionCodes }, reason: { type: 'string', minLength: 1, maxLength: 800 } }, required: ['annotationId', 'code', 'reason'], additionalProperties: false },
    output: output({ annotationId: { type: 'string' }, status: { type: 'string' }, summary: { type: 'string' } }),
    isConcurrencySafe: () => false,
    async execute(args: any, exec: any) { exec.signal?.throwIfAborted(); return annotations.reject(toolSession(exec), args); },
  });
}
