import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AnnotationService, DocumentStore, executeDraft, verifyDraftCandidate } from '../lib/index.js';

async function fixture(run) {
  const parent=resolve(tmpdir()),dir=await mkdtemp(join(parent,'chem-draft-')),store=new DocumentStore();
  const service=new AnnotationService({store,directoryFor:async()=>dir,prompt:async()=>({accepted:true})});
  const raw={root:{nodes:[{$ref:'mol0'}]},mol0:{type:'molecule',atoms:[{label:'C',location:[0,0,0],isotope:13},{label:'C',location:[1,0,0]}],bonds:[{type:1,atoms:[0,1]}]}};
  const ket=JSON.stringify(raw),document={schemaVersion:1,documentId:'draft-document',revision:1,ket,title:'草稿',language:'zh-CN'};
  const snapshot={...document,instanceId:'draft-frame',rawKet:ket,atoms:[{id:10,element:'C'},{id:99,element:'C'}],bonds:[{id:42,begin:10,end:99,type:1}],selection:{atoms:[99],bonds:[]},attachmentAtom:99,atomAddresses:{10:{molecule:'mol0',index:0},99:{molecule:'mol0',index:1}},bondAddresses:{42:{molecule:'mol0',index:0}}};
  try {
    const saved=await store.save(dir,'session-a',document,null),signal=new AbortController().signal,id=randomUUID();
    await service.create('session-a',{submissionId:id,instruction:'添加丙基，然后把新建片段末端原子改为 O',snapshot,baseToken:saved.token,protocolVersion:2},signal);
    let view=JSON.parse((await service.draftCommand('session-a','begin',{annotationId:id},signal)).context);
    const edit=async(edits,extra={})=>{const args={annotationId:id,editSessionId:view.editSessionId,expectedDraftRevision:view.draftRevision,requestId:randomUUID(),edits,...extra};const response=await service.draftCommand('session-a','edit',args,signal);view=JSON.parse(response.context);return {args,view};};
    const refresh=async()=>view=JSON.parse((await service.context('session-a',id)).context).draft;
    const check=async(action='validate',valid=true)=>{
      const pending=service.draftCommand('session-a',action,{annotationId:id,editSessionId:view.editSessionId,expectedDraftRevision:view.draftRevision,reason:'完整草稿'},signal);
      pending.catch(()=>{});
      let a;for(let i=0;i<100;i++){a=await service.detail('session-a',id);if(a.status==='validating')break;await new Promise(r=>setTimeout(r,5));}
      assert.equal(a.status,'validating');const candidateKet=executeDraft(a.frozen,a.patch.edits).snapshot.rawKet;
      const receipt={annotationId:id,instanceId:snapshot.instanceId,previewVersion:a.previewVersion,draftRevision:a.patch.draftRevision,validationId:a.draftValidation.id};
      await service.validation('session-a',{...receipt,valid,candidateKet,message:valid?undefined:'Bad valence on new atom'});
      const response=await pending;view=JSON.parse(response.context);return {candidateKet,receipt,response};
    };
    await run({service,store,dir,document,snapshot,saved,signal,id,edit,refresh,check,getView:()=>view});
  } finally {await service.drain();if(!resolve(dir).startsWith(parent+sep))throw new Error('Unsafe cleanup');await rm(dir,{recursive:true,force:true});}
}
const terminal=view=>view.atoms.find(a=>a.created&&a.neighbors.length===1).ref;
test('new references survive later operations; atomic failures, duplicate requests, conflicts and scope are enforced',()=>fixture(async({service,id,edit,refresh,getView,signal})=>{
  const first=await edit([{operation:'attach_fragment',targetAtom:'a:99',fragment:'n-propyl'}]);
  assert.equal(first.view.atoms.filter(a=>a.created).length,3);
  const ref=terminal(first.view);
  await service.draftCommand('session-a','edit',first.args,signal);assert.equal((await refresh()).draftRevision,1);
  await assert.rejects(service.draftCommand('session-a','edit',{...first.args,edits:[{operation:'attach_fragment',targetAtom:'a:99',fragment:'CH3'}]},signal),e=>e.code==='request_conflict');
  await assert.rejects(edit([{operation:'replace_atom',targetAtom:ref,element:'N'},{operation:'replace_atom',targetAtom:'a:10',element:'O'}]),e=>e.code==='out_of_selection');
  assert.equal((await refresh()).draftRevision,1);assert.equal(getView().atoms.find(a=>a.ref===ref).element,'C');
  await assert.rejects(edit([{operation:'replace_atom',targetAtom:ref,element:'O'}],{expectedDraftRevision:0}),e=>e.code==='draft_conflict');
  await edit([{operation:'replace_atom',targetAtom:ref,element:'O'}]);assert.equal(getView().atoms.find(a=>a.ref===ref).element,'O');
}));
test('complete validated draft commits once; edits invalidate old proposals and forged candidates are refused',()=>fixture(async({service,store,dir,document,saved,id,edit,refresh,check,getView,signal})=>{
  await edit([{operation:'attach_fragment',targetAtom:'a:99',fragment:'n-propyl'}]);
  await check();await assert.rejects(service.draftCommand('session-a','propose',{annotationId:id,editSessionId:getView().editSessionId,expectedDraftRevision:getView().draftRevision,reason:'只做第一步'},signal),e=>e.code==='incomplete_edit');
  await edit([{operation:'replace_atom',targetAtom:terminal(getView()),element:'O'}]);await check();const old=await check('propose');
  const ref=terminal(getView());await edit([{operation:'replace_atom',targetAtom:ref,element:'O'}],{rewindToStep:1});
  await assert.rejects(service.commit('session-a',{...old.receipt,document:{...document,revision:2,ket:old.candidateKet}}),e=>e.code==='annotation_inactive');
  assert.equal((await store.read(dir,'session-a')).token,saved.token);
  await check();const final=await check('propose'),forged=JSON.parse(final.candidateKet);forged.mol0.atoms[0].isotope=12;
  await assert.rejects(service.commit('session-a',{...final.receipt,document:{...document,revision:2,ket:JSON.stringify(forged)}}),e=>e.code==='out_of_selection');
  const applied=await service.commit('session-a',{...final.receipt,document:{...document,revision:2,ket:final.candidateKet}});
  assert.equal((await service.commit('session-a',{...final.receipt,document:{...document,revision:2,ket:final.candidateKet}})).token,applied.token);
  await assert.rejects(service.draftCommand('session-a','begin',{annotationId:id},signal),e=>e.code==='annotation_inactive');
}));
test('validation failures remain repairable; deleted refs are never recycled and cancellation ends the draft',()=>fixture(async({service,id,edit,refresh,check,getView,signal})=>{
  await edit([{operation:'attach_fragment',targetAtom:'a:99',fragment:'n-propyl'}]);const ref=terminal(getView());
  await edit([{operation:'replace_atom',targetAtom:ref,element:'N'}]);await check('validate',false);
  assert.equal(getView().validation.valid,false);assert.equal((await service.detail('session-a',id)).status,'draft_ready');
  await edit([{operation:'replace_atom',targetAtom:ref,element:'O'}],{rewindToStep:1});await check();assert.equal(getView().validation.valid,true);
  await edit([{operation:'delete_selection',atomRefs:[ref]}]);
  await assert.rejects(edit([{operation:'replace_atom',targetAtom:ref,element:'N'}]),e=>e.code==='missing_target');await refresh();
  await edit([{operation:'attach_fragment',targetAtom:'a:99',fragment:'CH3'}]);assert.ok(!getView().atoms.some(a=>a.ref===ref));
  await service.cancel('session-a',id);await assert.rejects(service.draftCommand('session-a','begin',{annotationId:id},signal),e=>e.code==='annotation_inactive');
}));
test('explicit identity mapping handles equal coordinates and survives deleting an earlier array entry',()=>{
  const raw={root:{nodes:[{$ref:'mol0'}]},mol0:{type:'molecule',atoms:[{label:'C',location:[0,0,0]},{label:'C',location:[0,0,0]},{label:'N',location:[2,0,0]}],bonds:[{type:1,atoms:[0,1]},{type:1,atoms:[1,2]}]}};
  const base={rawKet:JSON.stringify(raw),selection:{atoms:[10,11],bonds:[]},atoms:[{id:10,element:'C'},{id:11,element:'C'},{id:12,element:'N'}],bonds:[{id:90,begin:10,end:11,type:1},{id:91,begin:11,end:12,type:1}],atomAddresses:{10:{molecule:'mol0',index:0},11:{molecule:'mol0',index:1},12:{molecule:'mol0',index:2}},bondAddresses:{90:{molecule:'mol0',index:0},91:{molecule:'mol0',index:1}}};
  const result=executeDraft(base,[{edit:{operation:'delete_selection',atomRefs:['a:10']},nextAtomId:13,nextBondId:92},{edit:{operation:'replace_atom',targetAtom:'a:11',element:'O'},nextAtomId:13,nextBondId:92}]);
  assert.deepEqual(result.snapshot.atomAddresses[11],{molecule:'mol0',index:0});assert.equal(result.snapshot.atoms.find(a=>a.id===11).element,'O');assert.equal(result.snapshot.bonds[0].id,91);
  // Final comparison still refuses genuinely overlapping surviving coordinates;
  // identity mapping itself no longer uses them.
  assert.throws(()=>verifyDraftCandidate(base,[],JSON.stringify(raw)),e=>e.code==='ambiguous_coordinates');
});
