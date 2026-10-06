import test from 'node:test';
import assert from 'node:assert/strict';
import { executePatch, normalizePatch, verifyMolecularPatch } from '../lib/index.js';
const raw = {root:{nodes:[{$ref:'mol0'}]},mol0:{type:'molecule',atoms:[{label:'C',location:[0,0,0],isotope:13},{label:'C',location:[1,0,0]},{label:'N',location:[2,0,0],charge:1},{label:'O',location:[3,0,0]}],bonds:[{type:1,atoms:[0,1]},{type:1,atoms:[1,2]},{type:1,atoms:[2,3]}]}};
function snapshot(selection={atoms:[10],bonds:[]},data=raw) {
  return {rawKet:JSON.stringify(data),selection, atoms:data.mol0.atoms.map((a,i)=>({id:10+i,element:a.label})), bonds:data.mol0.bonds.map((b,i)=>({id:90+i,begin:10+b.atoms[0],end:10+b.atoms[1],type:b.type,stereo:b.stereo||0})), atomAddresses:Object.fromEntries(data.mol0.atoms.map((_,i)=>[10+i,{molecule:'mol0',index:i}])),bondAddresses:Object.fromEntries(data.mol0.bonds.map((_,i)=>[90+i,{molecule:'mol0',index:i}]))};
}
test('whitelist fragments have one explicit single-bond attachment; survivors retain isotope, charge and coordinates',()=>{
  const s=snapshot();
  for(const fragment of ['OH','CH3','NH2','F','Cl']) {
    const p=normalizePatch(s,{operation:'attach_fragment',targetAtom:10,fragment}), result=executePatch(s,p), data=JSON.parse(result.ket);
    assert.deepEqual(data.mol0.atoms.slice(0,4),raw.mol0.atoms);
    assert.deepEqual(data.mol0.bonds.at(-1),{type:1,atoms:[0,4]}); assert.equal(data.mol0.atoms.length,5);
    verifyMolecularPatch(s,p,result.ket);
    data.mol0.atoms[2].charge=0; assert.throws(()=>verifyMolecularPatch(s,p,JSON.stringify(data)),e=>e.code==='out_of_selection');
  }
  assert.throws(()=>normalizePatch(s,{operation:'attach_fragment',targetAtom:10,fragment:'C=O'}),e=>e.code==='unsupported_fragment');
  assert.throws(()=>normalizePatch(s,{operation:'attach_fragment',targetAtom:13,fragment:'OH'}),e=>e.code==='out_of_selection');
});
test('ethyl and both propyl isomers add the correct complete graph without changing survivors',()=>{
  const s=snapshot();
  for (const [fragment, hydrogens, edges] of [
    ['乙基',[2,3],[[0,4],[4,5]]],
    ['丙基',[2,2,3],[[0,4],[4,5],[5,6]]],
    ['异丙基',[1,3,3],[[0,4],[4,5],[4,6]]],
  ]) {
    const p=normalizePatch(s,{operation:'attach_fragment',targetAtom:10,fragment}),result=executePatch(s,p),data=JSON.parse(result.ket);
    assert.deepEqual(data.mol0.atoms.slice(0,4),raw.mol0.atoms);
    assert.deepEqual(data.mol0.bonds.slice(0,3),raw.mol0.bonds);
    assert.deepEqual(data.mol0.atoms.slice(4).map(a=>[a.label,a.implicitHCount]),hydrogens.map(h=>['C',h]));
    assert.deepEqual(data.mol0.bonds.slice(3),edges.map(atoms=>({type:1,atoms})));
    verifyMolecularPatch(s,p,result.ket);
    if(fragment==='丙基') { const forged=structuredClone(data);forged.mol0.bonds.at(-1).atoms=[4,6];assert.throws(()=>verifyMolecularPatch(s,p,JSON.stringify(forged)),e=>e.code==='out_of_selection'); }
    data.mol0.atoms[1].location[0]+=.1;
    assert.throws(()=>verifyMolecularPatch(s,p,JSON.stringify(data)),e=>e.code==='out_of_selection');
  }
  assert.equal(normalizePatch(s,{operation:'attach_fragment',targetAtom:10,fragment:'propyl'}).fragment,'n-propyl');
  assert.throws(()=>normalizePatch(s,{operation:'attach_fragment',targetAtom:10,fragment:'C3H7'}),e=>e.code==='ambiguous_fragment');
});
test('region attachment requires the frozen anchor, even with selected bonds; element replacement remains single-atom',()=>{
  const s=snapshot({atoms:[10,11],bonds:[90]});
  assert.throws(()=>normalizePatch(s,{operation:'attach_fragment',targetAtom:10,fragment:'丙基'}),e=>e.code==='connection_point_required');
  s.attachmentAtom=11;
  const p=normalizePatch(s,{operation:'attach_fragment',targetAtom:11,fragment:'正丙基'});
  assert.deepEqual(JSON.parse(executePatch(s,p).ket).mol0.bonds[3].atoms,[1,4]);
  assert.throws(()=>normalizePatch(s,{operation:'attach_fragment',targetAtom:10,fragment:'正丙基'}),e=>e.code==='out_of_selection');
  assert.throws(()=>normalizePatch(s,{operation:'replace_atom',targetAtom:11,element:'O'}),e=>e.code==='out_of_selection');
});
test('fragment layout accounts for disconnected components and refuses a fully crowded anchor',()=>{
  const data=structuredClone(raw);
  data.mol1={type:'molecule',atoms:Array.from({length:48},(_,i)=>({label:'C',location:[Math.cos(i*Math.PI/24),Math.sin(i*Math.PI/24),0]})),bonds:[]};
  data.root.nodes.push({$ref:'mol1'});
  const s=snapshot();s.rawKet=JSON.stringify(data);
  data.mol1.atoms.forEach((a,i)=>{s.atoms.push({id:100+i,element:a.label});s.atomAddresses[100+i]={molecule:'mol1',index:i};});
  assert.throws(()=>normalizePatch(s,{operation:'attach_fragment',targetAtom:10,fragment:'正丙基'}),e=>e.code==='crowded_attachment');
  assert.deepEqual(JSON.parse(s.rawKet),data);
});
test('bond changes preserve directed endpoints and all other bonds; delete declares all boundary cuts and supports component renumbering',()=>{
  const s=snapshot({atoms:[],bonds:[91]}), p=normalizePatch(s,{operation:'change_bond',targetBond:91,bondType:2}), changed=executePatch(s,p);
  assert.equal(JSON.parse(changed.ket).mol0.bonds[1].type,2); verifyMolecularPatch(s,p,changed.ket);
  const d=snapshot({atoms:[11],bonds:[]}), patch=normalizePatch(d,{operation:'delete_selection'}), result=executePatch(d,patch);
  assert.deepEqual(patch.boundaryBonds,[90,91]); assert.equal(JSON.parse(result.ket).mol0.atoms.length,3);
  const split=JSON.parse(result.ket); const tail=split.mol0.atoms.splice(1); split.mol1={type:'molecule',atoms:tail,bonds:[{type:1,atoms:[0,1]}]}; delete split.mol0.bonds; split.root.nodes.push({$ref:'mol1'});
  verifyMolecularPatch(d,patch,JSON.stringify(split));
  split.mol1.atoms[0].location[0]+=0.1; assert.throws(()=>verifyMolecularPatch(d,patch,JSON.stringify(split)),e=>e.code==='out_of_selection');
});
test('stereo, aromatic and unsupported structures fail before proposal instead of losing metadata',()=>{
  for(const modified of [d=>d.mol0.bonds[0].stereo=1,d=>d.mol0.atoms[0].stereoLabel='abs',d=>d.mol0.sgroups=[{type:'SUP',atoms:[0]}]]) {
    const data=structuredClone(raw);modified(data); const s=snapshot(undefined,data);
    assert.throws(()=>normalizePatch(s,{operation:'attach_fragment',targetAtom:10,fragment:'OH'}));
  }
  const data=structuredClone(raw);data.mol0.bonds[2].stereo=1;
  const s=snapshot({atoms:[10],bonds:[]},data),p=normalizePatch(s,{operation:'attach_fragment',targetAtom:10,fragment:'OH'});
  verifyMolecularPatch(s,p,executePatch(s,p).ket);
});

test('Kekule aromatic ring edits are protected and entire selections can be deleted',()=>{
  const s=snapshot({atoms:[],bonds:[90]}); s.aromaticBonds=[90];
  assert.throws(()=>normalizePatch(s,{operation:'change_bond',targetBond:90,bondType:2}),e=>e.code==='protected_aromatic');
  const all=snapshot({atoms:[10,11,12,13],bonds:[90,91,92]}),p=normalizePatch(all,{operation:'delete_selection'});
  const result=executePatch(all,p);assert.deepEqual(JSON.parse(result.ket).root.nodes,[]);verifyMolecularPatch(all,p,result.ket);
});

test('phenyl attachment and terminal replacement preserve all surviving attributes and the single boundary direction',()=>{
  const s=snapshot(),attach=normalizePatch(s,{operation:'attach_fragment',targetAtom:10,fragment:'苯环'}),added=JSON.parse(executePatch(s,attach).ket);
  assert.deepEqual(added.mol0.atoms.slice(0,4),raw.mol0.atoms);assert.equal(added.mol0.atoms.length,10);
  assert.equal(added.mol0.bonds.filter(b=>b.type===4).length,6);assert.equal(added.mol0.bonds.length,10);
  assert.deepEqual(added.mol0.atoms.slice(4).map(a=>a.implicitHCount),[0,1,1,1,1,1]);
  verifyMolecularPatch(s,attach,JSON.stringify(added));
  const replacement=normalizePatch(s,{operation:'replace_fragment',fragment:'苯基'}),result=executePatch(s,replacement),replaced=JSON.parse(result.ket);
  assert.deepEqual(replaced.mol0.atoms.slice(0,3),raw.mol0.atoms.slice(1));
  assert.equal(replaced.mol0.atoms.length,9);assert.equal(replaced.mol0.bonds.length,9);
  // Original bond 0 went from selected C to surviving C; the replacement retains that direction.
  assert.deepEqual(replaced.mol0.bonds[2],{type:1,atoms:[3,0]});verifyMolecularPatch(s,replacement,result.ket);
  replaced.mol0.atoms[1].charge=0;assert.throws(()=>verifyMolecularPatch(s,replacement,JSON.stringify(replaced)),e=>e.code==='out_of_selection');
});
test('replacement refuses multiple exits and compound edits fail atomically if a later target was removed',()=>{
  assert.throws(()=>normalizePatch(snapshot({atoms:[11],bonds:[]}),{operation:'replace_fragment',fragment:'苯环'}),e=>e.code==='unsupported_boundary');
  const s=snapshot({atoms:[13],bonds:[]}),before=s.rawKet;
  assert.throws(()=>normalizePatch(s,{operation:'batch',edits:[{operation:'delete_selection'},{operation:'attach_fragment',targetAtom:13,fragment:'CH3'}]}),e=>e.code==='connection_point_required');
  assert.equal(s.rawKet,before);
});
test('replace element then attach phenyl is one verified complete graph with original frozen IDs',()=>{
  const s=snapshot({atoms:[13],bonds:[]}),p=normalizePatch(s,{operation:'batch',edits:[{operation:'replace_atom',targetAtom:13,element:'C'},{operation:'attach_fragment',targetAtom:13,fragment:'phenyl'}]}),result=executePatch(s,p),data=JSON.parse(result.ket);
  assert.deepEqual(data.mol0.atoms.slice(0,3),raw.mol0.atoms.slice(0,3));assert.equal(data.mol0.atoms[3].label,'C');
  assert.equal(data.mol0.atoms.length,10);assert.equal(data.mol0.bonds.length,10);assert.deepEqual(data.mol0.bonds[3].atoms,[3,4]);
  verifyMolecularPatch(s,p,result.ket);
  const onlyFirst=executePatch(s,p.edits[0]).ket;assert.throws(()=>verifyMolecularPatch(s,p,onlyFirst),e=>e.code==='out_of_selection');
});
