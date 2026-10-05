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
  assert.throws(()=>normalizePatch(s,{operation:'attach_fragment',targetAtom:10,fragment:'C=O'}),e=>e.code==='invalid_patch');
  assert.throws(()=>normalizePatch(s,{operation:'attach_fragment',targetAtom:13,fragment:'OH'}),e=>e.code==='out_of_selection');
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
