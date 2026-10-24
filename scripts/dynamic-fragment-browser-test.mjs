// A2 acceptance: dynamic fragments (cyano/acetyl/benzyl) attach and replace
// through the real editor, Ketcher staging, Indigo validation, host replay,
// single apply and one-step undo. Raw-SMILES specs go through the same chain.
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1400,height:1100}}),errors=[];
page.on('pageerror',e=>errors.push(e.message));let f;
const graph=()=>f.evaluate(()=>window.chemP0.fingerprint());
const bondTypes=()=>f.evaluate(()=>[...window.chemP0.ketcher.editor.struct().bonds.values()].map(b=>b.type));
async function saved(){await f.waitForFunction(()=>document.querySelector('[data-save-status]')?.textContent==='已保存'&&!document.querySelector('.chem-busy'));}
async function select(id){const p=await f.evaluate(id=>window.chemP0.atomPoint(id),id),r=await page.locator('iframe').boundingBox();await page.mouse.click(r.x+p.x,r.y+p.y);}
async function importSmiles(smiles){const revision=await f.evaluate(()=>window.chemP0.revision());await f.locator('.chem-import-menu > summary').click();await f.getByLabel('导入 SMILES',{exact:true}).fill(smiles);await f.getByRole('button',{name:'载入',exact:true}).click();await f.waitForFunction(revision=>window.chemP0.revision()>revision,revision);await saved();}
async function annotate(instruction,{draft=false}={}){
  await saved();
  if(draft)await f.getByLabel('草稿模式',{exact:true}).check();else await f.getByLabel('草稿模式',{exact:true}).uncheck();
  await f.getByLabel('对选区的批注').fill(instruction);
  await f.getByRole('button',{name:'交给 Agent',exact:true}).click();
  try { await f.locator('[data-preview-id]').waitFor({timeout:45000}); }
  catch (error) {
    const calls=await (await page.request.get('http://127.0.0.1:3099/test/agent-calls')).json();
    const status=await f.locator('[data-annotation-status]').last().getAttribute('data-annotation-status').catch(()=>null);
    console.error('ANNOTATION-DEBUG',JSON.stringify({instruction,lastCalls:calls.slice(-3),status}));
    throw error;
  }
}
async function applyAndUndo(label,before,after){
  assert.deepEqual(await graph(),before,'canvas unchanged while '+label+' preview pending');
  await f.getByRole('button',{name:'应用修改',exact:true}).click();
  await f.locator('[data-annotation-status="applied"]').waitFor();await saved();
  const result=await graph();
  await after(result);
  await f.getByRole('button',{name:'撤销',exact:true}).click();await saved();
  assert.deepEqual(await graph(),before,'one-step undo restores the canvas after '+label);
  console.log('PASS '+label);
}
try {
  await page.goto('http://127.0.0.1:3099/session-a');await page.locator('iframe').waitFor();f=await(await page.locator('iframe').elementHandle()).contentFrame();
  await f.waitForFunction(()=>!!window.chemP0&&!document.querySelector('.chem-busy'));await saved();await f.getByRole('button',{name:'显示操作区',exact:true}).click();

  // Importing on a canvas restored from an earlier suite can leave the view
  // off-center; a pending recenter between freeze and staging is (correctly)
  // rejected by coordinate verification. Reload once so the imported molecule
  // renders through the standard saved-document path before annotating.
  await importSmiles('CCO');
  await page.goto('http://127.0.0.1:3099/session-a');await page.locator('iframe').waitFor();f=await(await page.locator('iframe').elementHandle()).contentFrame();
  await f.waitForFunction(()=>!!window.chemP0&&!document.querySelector('.chem-busy'));await saved();await f.getByRole('button',{name:'显示操作区',exact:true}).click();
  {
    const before=await graph();
    await select(before.atoms[0][0]);
    await annotate('添加氰基');
    await applyAndUndo('named cyano attach on real Indigo',before,async after=>{
      assert.equal(after.atoms.length,5,'ethanol+cyano atoms');
      assert.deepEqual((await bondTypes()).slice().sort(),[1,1,1,3],'two new bonds including C#N triple');
      assert.deepEqual(after.atoms.slice(0,3),before.atoms,'ethanol survivors untouched');
    });
  }

  {
    const before=await graph();
    await select(before.atoms[0][0]);
    await annotate('添加 SMILES: [*]C(C)=O');
    await applyAndUndo('raw SMILES acetyl spec with [*] marker',before,async after=>{
      assert.equal(after.atoms.length,6,'ethanol+acetyl atoms');
      assert.equal((await bondTypes()).filter(t=>t===2).length,1,'carbonyl double bond');
      assert.deepEqual(after.atoms.slice(0,3),before.atoms,'ethanol survivors untouched');
    });
  }

  {
    const before=await graph();
    await select(before.atoms[0][0]);
    await annotate('添加乙酰基',{draft:true});
    await applyAndUndo('v2 draft dynamic acetyl attach',before,async after=>{
      assert.equal(after.atoms.length,6,'ethanol+acetyl atoms');
      assert.equal((await bondTypes()).filter(t=>t===2).length,1,'carbonyl double bond');
      assert.deepEqual(after.atoms.slice(0,3),before.atoms,'ethanol survivors untouched');
    });
  }

  await importSmiles('CCC');
  {
    const before=await graph();
    await select(before.atoms.at(-1)[0]);
    await annotate('替换为苄基');
    await applyAndUndo('terminal benzyl replacement with aromatic ring',before,async after=>{
      assert.equal(after.atoms.length,9,'propane minus terminal C plus benzyl');
      assert.equal((await bondTypes()).filter(t=>t===4).length,6,'aromatic ring preserved as type 4');
      assert.deepEqual(after.atoms.slice(0,2),before.atoms.slice(0,2),'surviving chain untouched');
    });
  }

  assert.deepEqual(errors,[]);
  await mkdir('test-results',{recursive:true});await page.screenshot({path:'test-results/dynamic-fragment-browser.png'});
  console.log('ALL-PASS: A2 dynamic fragments — named cyano, raw-SMILES acetyl, v2 draft acetyl, benzyl replacement');
}catch(error){await page.screenshot({path:'test-results/dynamic-fragment-failure.png'});throw error;}finally{await browser.close();}
