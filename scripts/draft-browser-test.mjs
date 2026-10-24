import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1400,height:1100}}),errors=[];
page.on('pageerror',e=>errors.push(e.message));let f;
const graph=()=>f.evaluate(()=>window.chemP0.fingerprint());
async function saved(){await f.waitForFunction(()=>document.querySelector('[data-save-status]')?.textContent==='已保存'&&!document.querySelector('.chem-busy'));}
async function select(id){const p=await f.evaluate(id=>window.chemP0.atomPoint(id),id),r=await page.locator('iframe').boundingBox();await page.mouse.click(r.x+p.x,r.y+p.y);}
async function submit(instruction){await saved();await f.getByLabel('草稿模式',{exact:true}).check();await f.getByLabel('对选区的批注').fill(instruction);await f.getByRole('button',{name:'交给 Agent',exact:true}).click();await f.locator('[data-preview-id]').waitFor({timeout:45000});}
try {
  await page.goto('http://127.0.0.1:3099/session-a');await page.locator('iframe').waitFor();f=await(await page.locator('iframe').elementHandle()).contentFrame();
  await f.waitForFunction(()=>!!window.chemP0&&!document.querySelector('.chem-busy'));await saved();await f.getByRole('button',{name:'显示操作区',exact:true}).click();
  const revision=await f.evaluate(()=>window.chemP0.revision());await f.locator('.chem-import-menu > summary').click();await f.getByLabel('导入 SMILES',{exact:true}).fill('CC');await f.getByRole('button',{name:'载入',exact:true}).click();await f.waitForFunction(revision=>window.chemP0.revision()>revision,revision);await saved();
  for(const instruction of ['添加丙基，然后把新建片段末端原子改为 O','测试草稿修正：添加丙基，然后把新建片段末端原子改为 O']){
    const before=await graph();await select(before.atoms[0][0]);await submit(instruction);assert.deepEqual(await graph(),before);
    await f.locator('.chem-plan-complete').waitFor();
    if(instruction.startsWith('测试')){
      const calls=await (await page.request.get('http://127.0.0.1:3099/test/agent-calls')).json();assert.ok(calls.some(call=>call.tool==='chem_edit_draft'&&call.rewindToStep===1));
    }
    await page.request.get('http://127.0.0.1:3099/test/fail-next-apply');await f.getByRole('button',{name:'应用修改',exact:true}).click();await f.getByText('模拟保存失败，原文件保持。',{exact:true}).waitFor();assert.deepEqual(await graph(),before);
    await f.getByRole('button',{name:'应用修改',exact:true}).click();await f.locator('[data-annotation-status="applied"]').waitFor();await saved();
    const after=await graph();assert.equal(after.atoms.length,before.atoms.length+3);assert.equal(after.atoms.at(-1)[1].label,'O');
    assert.deepEqual(after.atoms.slice(0,before.atoms.length),before.atoms);
    await f.getByRole('button',{name:'撤销',exact:true}).click();await saved();assert.deepEqual(await graph(),before);
    console.log('PASS draft '+(instruction.startsWith('测试')?'chemical failure, repair, ':'new terminal reference, ')+'preserved canvas, save rollback, apply and one-step undo');
  }
  assert.deepEqual(errors,[]);await mkdir('test-results',{recursive:true});await page.screenshot({path:'test-results/draft-browser.png'});
  console.log('ALL-PASS: A1 edit drafts, stable new atom references, chemistry repair and one-step history');
}catch(error){await page.screenshot({path:'test-results/draft-browser-failure.png'});throw error;}finally{await browser.close();}
