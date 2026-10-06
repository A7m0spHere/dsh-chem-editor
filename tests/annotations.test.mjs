import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AnnotationService, DocumentStore, verifyPatch, executePatch, fragmentCatalog } from '../lib/index.js';
const ket = JSON.stringify({ root: { nodes: [{ $ref: 'mol0' }] }, mol0: { type: 'molecule', atoms: [{ label: 'C', location: [0, 0, 0] }, { label: 'C', location: [1, 0, 0] }], bonds: [{ type: 1, atoms: [0, 1] }] } });
test('annotations freeze targets, reject foreign/stale edits, cancel and commit once', async () => {
  const base = resolve(tmpdir()), dir = await mkdtemp(join(base, 'chem-annotations-'));
  const store = new DocumentStore(); const prompts = [];
  const service = new AnnotationService({ store, directoryFor: async () => dir, prompt: async request => { prompts.push(request); return { accepted: true }; } });
  const document = { schemaVersion: 1, documentId: 'document-test', revision: 1, ket, title: '测试', language: 'zh-CN' };
  const snapshot = { documentId: document.documentId, revision: 1, instanceId: 'frame-test', ket, rawKet: ket, atoms: [{ id: 37, element: 'C' }, { id: 99, element: 'C' }], bonds: [{ id: 81, begin: 37, end: 99, type: 1, stereo: 0 }], selection: { atoms: [37], bonds: [] }, targetAddress: { molecule: 'mol0', index: 0 } };
  try {
    const saved = await store.save(dir, 'session-a', document, null);
    const id = randomUUID(), input = { submissionId: id, instruction: '换成 N', snapshot, baseToken: saved.token };
    await service.create('session-a', input, new AbortController().signal);
    await service.create('session-a', input, new AbortController().signal); assert.equal(prompts.length, 1, 'same request must not enqueue another model turn');
    await assert.rejects(service.context('session-b', id), e => e.code === 'annotation_not_found');
    const context = JSON.parse((await service.context('session-a', id)).context); assert.equal(context.selectedAtom.id, 37);
    assert.deepEqual(context.fragmentTemplates,fragmentCatalog());
    assert.equal(context.attachmentAtom,37);
    assert.ok(prompts[0].content[0].text.includes('正丙基'));
    service.updateFrame('session-a', { ...snapshot, selection: { atoms: [99], bonds: [] } });
    assert.equal(JSON.parse((await service.context('session-a', id)).context).selectedAtom.id, 37, 'later selection must not retarget the annotation');
    await assert.rejects(service.propose('session-a', { annotationId: id, targetAtom: 99, element: 'N' }, new AbortController().signal), e => e.code === 'out_of_selection');
    const pending = service.propose('session-a', { annotationId: id, targetAtom: 37, element: 'N', reason: '元素替换' }, new AbortController().signal);
    for (let i = 0; i < 50 && (await service.detail('session-a', id)).status !== 'validating'; i++) await new Promise(r => setTimeout(r, 10));
    const candidate = JSON.parse(ket); candidate.mol0.atoms[0].label = 'N';
    await service.validation('session-a', { annotationId: id, instanceId: 'frame-test', valid: true, candidateKet: JSON.stringify(candidate) });
    assert.equal((await pending).status, 'preview_ready');
    assert.equal((await store.read(dir, 'session-a')).document.ket, ket, 'a proposal must not alter the document');
    const malicious = structuredClone(candidate); malicious.mol0.atoms[1].label = 'O';
    assert.throws(() => verifyPatch(ket, JSON.stringify(malicious), snapshot.targetAddress, 'N'), e => e.code === 'out_of_selection');
    const displayOnly = structuredClone(candidate); displayOnly.root.connections = []; displayOnly.root.templates = []; displayOnly.mol0.atoms[1].selected = true;
    assert.doesNotThrow(() => verifyPatch(ket, JSON.stringify(displayOnly), snapshot.targetAddress, 'N'));
    const extraConnection = structuredClone(displayOnly); extraConnection.root.connections = [{ atom: 1 }];
    assert.throws(() => verifyPatch(ket, JSON.stringify(extraConnection), snapshot.targetAddress, 'N'), e => e.code === 'out_of_selection');
    const command = { annotationId: id, instanceId: 'frame-test', document: { ...document, revision: 2, ket: JSON.stringify(candidate) } };
    const applied = await service.commit('session-a', command);
    const repeated = await service.commit('session-a', command); assert.equal(repeated.token, applied.token);
    assert.equal(applied.document.lastAppliedAnnotationId, id); assert.equal(applied.document.savedVersion, 2);
    assert.equal((await service.list('session-a'))[0].status, 'applied');
    const raw = await readFile(applied.path, 'utf8'); assert.ok(raw.includes(id));

    const id2 = randomUUID(); const nextSnapshot = { ...snapshot, revision: 2, ket: JSON.stringify(candidate), rawKet: JSON.stringify(candidate), atoms: [{ id: 37, element: 'N' }, { id: 99, element: 'C' }] };
    await service.create('session-a', { ...input, submissionId: id2, instruction: '换回 C', baseToken: applied.token, snapshot: nextSnapshot }, new AbortController().signal);
    await service.cancel('session-a', id2); await assert.rejects(service.context('session-a', id2), e => e.code === 'annotation_inactive');
    assert.equal((await store.read(dir, 'session-a')).token, applied.token);
    const id3 = randomUUID(); await service.create('session-a', { ...input, submissionId: id3, instruction: '换回 C', baseToken: applied.token, snapshot: nextSnapshot }, new AbortController().signal);
    await store.save(dir, 'session-a', { ...applied.document, revision: 3, title: '其他修改' }, applied.token);
    assert.equal((await service.list('session-a')).find(a => a.id === id3).status, 'stale');
    await assert.rejects(service.propose('session-a', { annotationId: id3, targetAtom: 37, element: 'C' }, new AbortController().signal), e => e.code === 'annotation_inactive');
  } finally { await service.drain(); if (!resolve(dir).startsWith(base + sep)) throw new Error('Unsafe cleanup'); await rm(dir, { recursive: true, force: true }); }
});
test('fragment proposals and commits are idempotent; forged candidates cannot alter an unselected isotope', async () => {
  const base = resolve(tmpdir()), dir = await mkdtemp(join(base, 'chem-fragment-'));
  const store = new DocumentStore(), service = new AnnotationService({store,directoryFor:async()=>dir,prompt:async()=>({accepted:true})});
  const data = JSON.parse(ket); data.mol0.atoms[1].isotope = 13;
  const document = {schemaVersion:1,documentId:'fragment-test',revision:1,ket:JSON.stringify(data),title:'片段',language:'zh-CN'};
  const snapshot = {documentId:document.documentId,revision:1,instanceId:'frame-fragment',ket:document.ket,rawKet:document.ket,atoms:[{id:37,element:'C'},{id:99,element:'C'}],bonds:[{id:81,begin:37,end:99,type:1,stereo:0}],selection:{atoms:[37],bonds:[]},atomAddresses:{37:{molecule:'mol0',index:0},99:{molecule:'mol0',index:1}},bondAddresses:{81:{molecule:'mol0',index:0}}};
  try {
    const saved=await store.save(dir,'session-a',document,null),id=randomUUID(),signal=new AbortController().signal;
    await service.create('session-a',{submissionId:id,instruction:'添加 OH',snapshot,baseToken:saved.token},signal);
    const args={annotationId:id,operation:'attach_fragment',targetAtom:37,fragment:'OH',reason:'单键连接'},pending=service.propose('session-a',args,signal);
    for(let i=0;i<50&&(await service.detail('session-a',id)).status!=='validating';i++)await new Promise(r=>setTimeout(r,10));
    const detail=await service.detail('session-a',id),candidate=executePatch(detail.frozen,detail.patch).ket;
    await service.validation('session-a',{annotationId:id,instanceId:snapshot.instanceId,valid:true,candidateKet:candidate});await pending;
    assert.equal((await service.propose('session-a',args,signal)).status,'preview_ready');
    const forged=JSON.parse(candidate);delete forged.mol0.atoms[1].isotope;
    const command={annotationId:id,instanceId:snapshot.instanceId,document:{...document,revision:2,ket:JSON.stringify(forged)}};
    await assert.rejects(service.commit('session-a',command),e=>e.code==='out_of_selection');assert.equal((await store.read(dir,'session-a')).token,saved.token);
    command.document.ket=candidate;const applied=await service.commit('session-a',command),retry=await service.commit('session-a',command);
    assert.equal(applied.token,retry.token);assert.equal(JSON.parse(applied.document.ket).mol0.atoms.length,3);assert.equal(applied.document.savedVersion,2);
  } finally {await service.drain();if(!resolve(dir).startsWith(base+sep))throw new Error('Unsafe cleanup');await rm(dir,{recursive:true,force:true});}
});

test('region propyl anchor is frozen; recoverable proposal errors clear and repeated commits add the chain only once', async () => {
  const base=resolve(tmpdir()),dir=await mkdtemp(join(base,'chem-propyl-'));
  const store=new DocumentStore(),service=new AnnotationService({store,directoryFor:async()=>dir,prompt:async()=>({accepted:true})});
  const document={schemaVersion:1,documentId:'propyl-test',revision:1,ket,title:'丙基',language:'zh-CN'};
  const snapshot={documentId:document.documentId,revision:1,instanceId:'frame-propyl',ket,rawKet:ket,atoms:[{id:37,element:'C'},{id:99,element:'C'}],bonds:[{id:81,begin:37,end:99,type:1,stereo:0}],selection:{atoms:[37,99],bonds:[81]},attachmentAtom:99,atomAddresses:{37:{molecule:'mol0',index:0},99:{molecule:'mol0',index:1}},bondAddresses:{81:{molecule:'mol0',index:0}}};
  try {
    const saved=await store.save(dir,'session-a',document,null),id=randomUUID(),signal=new AbortController().signal;
    await service.create('session-a',{submissionId:id,instruction:'添加丙基',snapshot,baseToken:saved.token},signal);
    await service.presented('session-a',id);
    service.updateFrame('session-a',{...snapshot,selection:{atoms:[37],bonds:[]},attachmentAtom:37});
    assert.equal(JSON.parse((await service.context('session-a',id)).context).attachmentAtom,99);
    await assert.rejects(service.propose('session-a',{annotationId:id,operation:'attach_fragment',targetAtom:37,fragment:'丙基'},signal),e=>e.code==='out_of_selection');
    const args={annotationId:id,operation:'attach_fragment',targetAtom:99,fragment:'丙基',reason:'添加正丙基'},pending=service.propose('session-a',args,signal);
    for(let i=0;i<50&&(await service.detail('session-a',id)).status!=='validating';i++)await new Promise(r=>setTimeout(r,10));
    const detail=await service.detail('session-a',id),candidate=executePatch(detail.frozen,detail.patch).ket;
    assert.equal(detail.lastProposalError,undefined);assert.equal(detail.patch.fragment,'n-propyl');
    assert.deepEqual(JSON.parse(candidate).mol0.bonds.slice(1).map(b=>b.atoms),[[1,2],[2,3],[3,4]]);
    await service.validation('session-a',{annotationId:id,instanceId:snapshot.instanceId,valid:true,candidateKet:candidate});await pending;
    await assert.rejects(service.reject('session-a',{annotationId:id,code:'clarification_required',reason:'不应取消已有预览'}),e=>e.code==='annotation_inactive');
    await service.turnEnded('session-a');assert.equal((await service.detail('session-a',id)).status,'proposed');
    const command={annotationId:id,instanceId:snapshot.instanceId,document:{...document,revision:2,ket:candidate}};
    const applied=await service.commit('session-a',command),retry=await service.commit('session-a',command);
    assert.equal(applied.token,retry.token);assert.equal(JSON.parse(retry.document.ket).mol0.atoms.length,5);
  } finally {await service.drain();if(!resolve(dir).startsWith(base+sep))throw new Error('Unsafe cleanup');await rm(dir,{recursive:true,force:true});}
});

test('proposal and Agent rejection reasons persist in the panel after turn end without changing the saved document', async () => {
  const base=resolve(tmpdir()),dir=await mkdtemp(join(base,'chem-rejection-'));
  const store=new DocumentStore(),service=new AnnotationService({store,directoryFor:async()=>dir,prompt:async()=>({accepted:true})});
  const document={schemaVersion:1,documentId:'rejection-test',revision:1,ket,title:'拒绝反馈',language:'zh-CN'};
  const snapshot={documentId:document.documentId,revision:1,instanceId:'frame-reject',ket,rawKet:ket,atoms:[{id:37,element:'C'},{id:99,element:'C'}],bonds:[{id:81,begin:37,end:99,type:1,stereo:0}],selection:{atoms:[37],bonds:[]},atomAddresses:{37:{molecule:'mol0',index:0},99:{molecule:'mol0',index:1}},bondAddresses:{81:{molecule:'mol0',index:0}}};
  try {
    const saved=await store.save(dir,'session-a',document,null),signal=new AbortController().signal;
    const create=async instruction=>{const id=randomUUID();await service.create('session-a',{submissionId:id,instruction,snapshot,baseToken:saved.token},signal);await service.presented('session-a',id);return id;};
    const id=await create('添加苄基');
    await assert.rejects(service.propose('session-a',{annotationId:id,operation:'attach_fragment',targetAtom:37,fragment:'benzyl'},signal),e=>e.code==='unsupported_fragment');
    await service.turnEnded('session-a');
    let record=(await service.list('session-a')).find(a=>a.id===id);
    assert.equal(record.status,'failed');assert.equal(record.errorCode,'unsupported_fragment');assert.match(record.message,/当前支持.*正丙基/);
    const id2=await create('添加 C3H7');
    await assert.rejects(service.reject('session-b',{annotationId:id2,code:'ambiguous_fragment',reason:'请明确异构体'}),e=>e.code==='annotation_not_found');
    await assert.rejects(service.reject('session-a',{annotationId:id2,code:'unknown',reason:'失败'}),e=>e.code==='invalid_rejection');
    await service.reject('session-a',{annotationId:id2,code:'ambiguous_fragment',reason:'请明确要正丙基还是异丙基，再重新提交。'});
    await service.turnEnded('session-a');record=(await service.list('session-a')).find(a=>a.id===id2);
    assert.equal(record.errorCode,'ambiguous_fragment');assert.equal(record.message,'请明确要正丙基还是异丙基，再重新提交。');
    assert.equal((await store.read(dir,'session-a')).token,saved.token);
  } finally {await service.drain();if(!resolve(dir).startsWith(base+sep))throw new Error('Unsafe cleanup');await rm(dir,{recursive:true,force:true});}
});
