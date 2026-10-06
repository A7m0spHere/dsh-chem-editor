import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import {AnnotationService,DocumentStore,executePatch,requestedEdits,verifyEditIntent} from '../lib/index.js';

async function fixture(run) {
  const base=resolve(tmpdir()),dir=await mkdtemp(join(base,'chem-flow-')),store=new DocumentStore(),prompts=[];
  const service=new AnnotationService({store,directoryFor:async()=>dir,prompt:async request=>{prompts.push(request);return {accepted:true};}});
  const raw={root:{nodes:[{$ref:'mol0'}]},mol0:{type:'molecule',atoms:[{label:'C',location:[0,0,0],isotope:13},{label:'O',location:[1,0,0]},{label:'C',location:[1.5,.8660254,0]}],bonds:[{type:1,atoms:[0,1]},{type:1,atoms:[1,2]}]}};
  const ket=JSON.stringify(raw),document={schemaVersion:1,documentId:'flow-document',revision:1,ket,title:'批注流程',language:'zh-CN'};
  const snapshot={documentId:document.documentId,revision:1,instanceId:'flow-frame',ket,rawKet:ket,atoms:[{id:37,element:'C'},{id:99,element:'O'},{id:123,element:'C'}],bonds:[{id:81,begin:37,end:99,type:1,stereo:0},{id:82,begin:99,end:123,type:1,stereo:0}],selection:{atoms:[99],bonds:[]},attachmentAtom:99,atomAddresses:{37:{molecule:'mol0',index:0},99:{molecule:'mol0',index:1},123:{molecule:'mol0',index:2}},bondAddresses:{81:{molecule:'mol0',index:0},82:{molecule:'mol0',index:1}}};
  try {
    const saved=await store.save(dir,'session-a',document,null),signal=new AbortController().signal;
    const create=async instruction=>{const id=randomUUID();await service.create('session-a',{submissionId:id,instruction,snapshot,baseToken:saved.token},signal);await service.presented('session-a',id);return id;};
    const validate=async(id,pending)=>{for(let i=0;i<100&&(await service.detail('session-a',id)).status!=='validating';i++)await new Promise(r=>setTimeout(r,5));const a=await service.detail('session-a',id),candidate=executePatch(a.frozen,a.patch).ket;await service.validation('session-a',{annotationId:id,instanceId:snapshot.instanceId,valid:true,candidateKet:candidate});await pending;return candidate;};
    await run({service,store,dir,document,snapshot,saved,signal,create,validate,prompts});
  } finally {await service.drain();if(!resolve(dir).startsWith(base+sep))throw new Error('Unsafe cleanup');await rm(dir,{recursive:true,force:true});}
}
test('intent contract rejects methyl as propyl and partial composite plans, while distinguishing replacement from addition',()=>{
  assert.throws(()=>verifyEditIntent('添加丙基',{operation:'attach_fragment',fragment:'CH3'}),e=>e.code==='intent_mismatch');
  const text='把o换为碳原子，然后外接一个苯环',first={operation:'replace_atom',element:'C'};
  assert.throws(()=>verifyEditIntent(text,first),e=>e.code==='incomplete_edit');
  assert.deepEqual(requestedEdits(text),[{operation:'replace_atom',element:'C'},{operation:'attach_fragment',fragment:'phenyl'}]);
  verifyEditIntent(text,{operation:'batch',edits:[first,{operation:'attach_fragment',fragment:'phenyl'}]});
  assert.throws(()=>verifyEditIntent('把甲基换为一个苯环',{operation:'attach_fragment',fragment:'phenyl'}),e=>e.code==='intent_mismatch');
  verifyEditIntent(text,first,'只把氧换成碳');
  assert.throws(()=>requestedEdits('添加 C3H7'),e=>e.code==='ambiguous_fragment');
  assert.throws(()=>requestedEdits('加一个丙烷','强行支持'),e=>e.code==='clarification_required');
  verifyEditIntent('加一个丙烷',{operation:'attach_fragment',fragment:'n-propyl'},'三个碳的碳链');
  assert.throws(()=>requestedEdits('替换为氟苯'),e=>e.code==='clarification_required');
  assert.throws(()=>requestedEdits('添加正丙基或者异丙基'),e=>e.code==='clarification_required');
  assert.throws(()=>requestedEdits('先给这里改个C，然后外接苯环'),e=>e.code==='clarification_required');
  assert.throws(()=>verifyEditIntent('把O变为C，然后添加苯环',{operation:'attach_fragment',fragment:'phenyl'}),e=>e.code==='incomplete_edit');
  assert.deepEqual(requestedEdits('Change to a double bond'),[{operation:'change_bond',bondType:2}]);
  assert.deepEqual(requestedEdits('Replace O with carbon, then attach Phenyl'),[{operation:'replace_atom',element:'C'},{operation:'attach_fragment',fragment:'phenyl'}]);
});
test('partial proposal never gets a preview; the complete two-step plan commits once',async()=>fixture(async({service,store,dir,document,snapshot,saved,signal,create,validate})=>{
  const id=await create('把o换为碳原子，然后外接一个苯环');
  await assert.rejects(service.propose('session-a',{annotationId:id,operation:'replace_atom',targetAtom:99,element:'C'},signal),e=>e.code==='incomplete_edit');
  assert.equal((await service.detail('session-a',id)).patch,undefined);assert.equal((await store.read(dir,'session-a')).token,saved.token);
  const args={annotationId:id,operation:'batch',edits:[{operation:'replace_atom',targetAtom:99,element:'C'},{operation:'attach_fragment',targetAtom:99,fragment:'phenyl'}],reason:'完整完成换碳和接苯环'};
  const candidate=await validate(id,service.propose('session-a',args,signal));
  const command={annotationId:id,instanceId:snapshot.instanceId,document:{...document,revision:2,ket:candidate}},applied=await service.commit('session-a',command),retry=await service.commit('session-a',command);
  assert.equal(applied.token,retry.token);assert.equal(JSON.parse(retry.document.ket).mol0.atoms.length,9);
  await assert.rejects(service.continueEdit('session-a',{annotationId:id,userReply:'添加甲基'},signal,true),e=>e.code==='annotation_inactive');
}));
test('clarification survives turn end and only an actual user reply can resume the frozen selection',async()=>fixture(async({service,snapshot,signal,create,validate,store,dir,saved})=>{
  const id=await create('加一个丙烷');await service.reject('session-a',{annotationId:id,code:'clarification_required',reason:'要连接的丙基还是独立丙烷？请补充。'});await service.turnEnded('session-a');
  assert.equal((await service.detail('session-a',id)).status,'needs_clarification');
  await assert.rejects(service.continueEdit('session-a',{annotationId:id,userReply:'添加甲基'}),e=>e.code==='unverified_clarification');
  await service.userMessage('session-a',{source:{kind:'user',rpcId:'reply-real'},content:[{type:'text',text:'三个碳的碳链'}]});
  await assert.rejects(service.continueEdit('session-a',{annotationId:id,userReply:'添加甲基'}),e=>e.code==='unverified_clarification');
  service.updateFrame('session-a',{...snapshot,selection:{atoms:[123],bonds:[]},attachmentAtom:123});
  await service.continueEdit('session-a',{annotationId:id,userReply:'三个碳的碳链'});
  assert.equal(JSON.parse((await service.context('session-a',id)).context).attachmentAtom,99);
  await assert.rejects(service.propose('session-a',{annotationId:id,operation:'attach_fragment',targetAtom:99,fragment:'CH3'},signal),e=>e.code==='intent_mismatch');
  await validate(id,service.propose('session-a',{annotationId:id,operation:'attach_fragment',targetAtom:99,fragment:'丙基'},signal));
  assert.equal((await store.read(dir,'session-a')).token,saved.token);
}));
test('panel continuation enqueues once; cancelled and stale annotations cannot resume',async()=>fixture(async({service,store,dir,document,snapshot,saved,signal,create,prompts})=>{
  const id=await create('添加 C3H7');await service.reject('session-a',{annotationId:id,code:'ambiguous_fragment',reason:'请明确异构体'});
  await assert.rejects(service.continueEdit('session-a',{annotationId:id,userReply:'正丙基',instanceId:'other-frame'},signal,true),e=>e.code==='wrong_editor');
  await service.continueEdit('session-a',{annotationId:id,userReply:'正丙基',instanceId:snapshot.instanceId},signal,true);assert.equal(prompts.length,2);
  await assert.rejects(service.continueEdit('session-a',{annotationId:id,userReply:'正丙基'},signal,true),e=>e.code==='annotation_inactive');
  await service.cancel('session-a',id);await assert.rejects(service.continueEdit('session-a',{annotationId:id,userReply:'正丙基'},signal,true),e=>e.code==='annotation_inactive');
  await service.userMessage('session-a',{source:{kind:'user',rpcId:'reply-before-new-annotation'},content:[{type:'text',text:'正丙基'}]});
  const id2=await create('添加 C3H7');await service.reject('session-a',{annotationId:id2,code:'ambiguous_fragment',reason:'请明确异构体'});
  await assert.rejects(service.continueEdit('session-a',{annotationId:id2,userReply:'正丙基'},signal),e=>e.code==='unverified_clarification');
  await store.save(dir,'session-a',{...document,revision:2,title:'结构已变'},saved.token);
  await assert.rejects(service.continueEdit('session-a',{annotationId:id2,userReply:'正丙基',instanceId:snapshot.instanceId},signal,true),e=>e.code==='stale_annotation');
}));
