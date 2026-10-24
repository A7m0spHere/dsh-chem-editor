import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFragmentSpec, resolveFragmentSpec, dynamicFragments, requestedEdits, normalizePatch, executePatch, verifyMolecularPatch } from '../lib/index.js';

const raw = {root:{nodes:[{$ref:'mol0'}]},mol0:{type:'molecule',atoms:[{label:'C',location:[0,0,0]},{label:'C',location:[1,0,0]}],bonds:[{type:1,atoms:[0,1]}]}};
function snapshot(selection={atoms:[10],bonds:[]},data=raw) {
  return {rawKet:JSON.stringify(data),selection, attachmentAtom:10, atoms:data.mol0.atoms.map((a,i)=>({id:10+i,element:a.label})), bonds:data.mol0.bonds.map((b,i)=>({id:90+i,begin:10+b.atoms[0],end:10+b.atoms[1],type:b.type,stereo:0})), atomAddresses:Object.fromEntries(data.mol0.atoms.map((_,i)=>[10+i,{molecule:'mol0',index:i}])),bondAddresses:Object.fromEntries(data.mol0.bonds.map((_,i)=>[90+i,{molecule:'mol0',index:i}]))};
}
const parse = smiles => parseFragmentSpec(resolveFragmentSpec(smiles).spec);

test('named dynamic groups parse to explicit graphs with [*] attachment and correct hydrogens',()=>{
  const cyano=parse(dynamicFragments.cyano.smiles);
  assert.deepEqual(cyano.atoms.map(a=>[a.label,a.hydrogen]),[['C',0],['N',0]]);
  assert.equal(cyano.attachment,0); assert.equal(cyano.attachmentBondType,1);
  assert.deepEqual(cyano.bonds,[{atoms:[0,1],type:3}]);
  const acetyl=parse(dynamicFragments.acetyl.smiles);
  assert.equal(acetyl.atoms.length,3); assert.equal(acetyl.atoms[0].hydrogen,0);
  assert.deepEqual(acetyl.bonds.map(b=>b.type).sort(),[1,2]);
  const benzyl=parse(dynamicFragments.benzyl.smiles);
  assert.equal(benzyl.atoms.length,7);
  assert.equal(benzyl.atoms[0].label,'C'); assert.equal(benzyl.atoms[0].hydrogen,2);
  assert.equal(benzyl.bonds.filter(b=>b.type===4).length,6);
  assert.equal(benzyl.attachment,0);
});

test('dynamic fragments carry relative 2D layout with unit bonds and no overlaps',()=>{
  for (const id of Object.keys(dynamicFragments)) {
    const fragment=parse(dynamicFragments[id].smiles);
    for (const atom of fragment.atoms) { assert.ok(atom.point.every(Number.isFinite),`${id} finite points`); }
    for (const bond of fragment.bonds) {
      const [a,b]=bond.atoms.map(i=>fragment.atoms[i].point);
      const length=Math.hypot(a[0]-b[0],a[1]-b[1]);
      assert.ok(Math.abs(length-1)<0.02,`${id} bond length ${length}`);
    }
    for (let i=0;i<fragment.atoms.length;i++) for (let j=i+1;j<fragment.atoms.length;j++) {
      const a=fragment.atoms[i].point,b=fragment.atoms[j].point;
      assert.ok(Math.hypot(a[0]-b[0],a[1]-b[1])>0.4,`${id} atoms ${i},${j} overlap`);
    }
  }
});

test('bracket attributes survive: charge, isotope and explicit hydrogens',()=>{
  const nitro=parse('[*][N+](=O)[O-]');
  assert.deepEqual(nitro.atoms.map(a=>[a.label,a.charge]),[['N',1],['O',0],['O',-1]]);
  assert.equal(nitro.atoms[0].hydrogen,0);
  const labelled=parse('[*][13CH2]C');
  assert.equal(labelled.atoms[0].isotope,13); assert.equal(labelled.atoms[0].hydrogen,2);
  const template=parseFragmentSpec({kind:'template',id:'phenyl'});
  assert.equal(template.atoms.length,6); assert.equal(template.attachmentBondType,1);
});

test('the parser stays strict where the engine probe showed leniency',()=>{
  const direct=(smiles,connection)=>parseFragmentSpec({kind:'smiles',smiles,connection});
  const rejects=[
    ['XyZ','invalid_fragment|unsupported_fragment'],
    ['[*]CC.CC','unsupported_fragment'],
    ['[*]C1CC','invalid_fragment'],
    ['C#N','connection_point_required'],
    ['[*]C%12','unsupported_fragment'],
    ['[*]c','invalid_fragment'],
    ['[*]C(C)(C)(C)C(C)(C)(C)C(C)(C)(C)C(C)(C)(C)C','fragment_budget|invalid_fragment'],
  ];
  for (const [smiles,codes] of rejects) assert.throws(()=>direct(smiles),e=>codes.split('|').includes(e.code),smiles);
  assert.equal(resolveFragmentSpec('XyZ'),undefined);
  assert.throws(()=>direct('[*][Na+]'),e=>e.code==='unsupported_fragment');
  assert.throws(()=>direct('[*]C#N',{atom:2,bondType:1}),e=>e.code==='ambiguous_fragment','N is not the [*] neighbor (C at index 1)');
  assert.deepEqual(direct('[*][C]').atoms.map(a=>[a.label,a.hydrogen]),[['C',3]],'bracket methyl is valid');
  assert.equal(resolveFragmentSpec('硝基'),undefined,'unknown Chinese names are not silently SMILES-parsed');
});

test('attach/replace execute dynamic fragments and preserve every survivor attribute',()=>{
  const s=snapshot();
  const attach=normalizePatch(s,{operation:'attach_fragment',targetAtom:10,fragment:'cyano'});
  const applied=executePatch(s,attach),data=JSON.parse(applied.ket);
  assert.equal(data.mol0.atoms.length,4);
  assert.deepEqual(data.mol0.atoms.slice(0,2),raw.mol0.atoms);
  assert.deepEqual(data.mol0.bonds.find(b=>b.type===1&&b.atoms.includes(2)).atoms,[0,2]);
  assert.equal(data.mol0.bonds.at(-1).type,3);
  verifyMolecularPatch(s,attach,applied.ket);
  const smiles=normalizePatch(s,{operation:'attach_fragment',targetAtom:10,fragment:'C(C)=O',fragmentConnection:{atom:0,bondType:1}});
  assert.equal(smiles.fragment,'C(C)=O');
  const acetyl=executePatch(s,smiles),ket=JSON.parse(acetyl.ket);
  assert.equal(ket.mol0.atoms.length,5); assert.equal(ket.mol0.bonds.filter(b=>b.type===2).length,1);
  const replaceSnapshot=snapshot({atoms:[11],bonds:[]});
  const replace=normalizePatch(replaceSnapshot,{operation:'replace_fragment',fragment:'benzyl'});
  const benzyl=executePatch(replaceSnapshot,replace),graph=JSON.parse(benzyl.ket);
  assert.equal(graph.mol0.atoms.length,8);
  assert.equal(graph.mol0.bonds.filter(b=>b.type===4).length,6);
  assert.deepEqual(graph.mol0.atoms[0],raw.mol0.atoms[0]);
});

test('intent resolution recognizes the dynamic group names in natural instructions',()=>{
  assert.deepEqual(requestedEdits('给选区添加氰基'),[{operation:'attach_fragment',fragment:'cyano'}]);
  assert.deepEqual(requestedEdits('外接乙酰基'),[{operation:'attach_fragment',fragment:'acetyl'}]);
  assert.deepEqual(requestedEdits('替换为苄基'),[{operation:'replace_fragment',fragment:'benzyl'}]);
});
