// Run only against a separately started, configured DSH Web validation profile.
import {chromium} from 'playwright';
import {readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const log=await readFile(process.env.CHEM_DSH_LOG||'test-results/complete-edit-live-runtime.log','utf8'),url=log.match(/dsh web:\s*(https?:\/\/[^\s]+)/)?.[1];
if(!url)throw new Error('DSH launch URL unavailable');
const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1500,height:1100}}),errors=[],evidence=[];let f;
page.on('pageerror',e=>errors.push(e.message));
const graph=()=>f.evaluate(()=>window.chemP0.fingerprint());
async function saved(){await f.waitForFunction(()=>document.querySelector('[data-save-status]')?.textContent==='已保存'&&!document.querySelector('.chem-busy'));}
async function select(id){const p=await f.evaluate(id=>window.chemP0.atomPoint(id),id),r=await page.locator('iframe[title="分子编辑器"]').boundingBox();await page.mouse.click(r.x+p.x,r.y+p.y);}
async function load(smiles){const rev=await f.evaluate(()=>window.chemP0.revision());await f.locator('.chem-import-menu > summary').click();await f.getByLabel('导入 SMILES',{exact:true}).fill(smiles);await f.getByRole('button',{name:'载入',exact:true}).click();await f.waitForFunction(rev=>window.chemP0.revision()>rev,rev);await saved();}
async function submit(text){await saved();const old=await f.locator('[data-annotation-id]').getAttribute('data-annotation-id').catch(()=>null);await f.getByLabel('对选区的批注').fill(text);await f.getByRole('button',{name:'交给 Agent',exact:true}).click();await f.waitForFunction(old=>{const a=document.querySelector('[data-annotation-id]');return a?.getAttribute('data-annotation-id')!==old&&['proposed','failed','needs_clarification'].includes(a?.getAttribute('data-annotation-status'));},old,{timeout:240000});}
async function applyUndo(instruction,before,check){
  await f.locator('[data-preview-id]').waitFor({timeout:5000});assert.deepEqual(await graph(),before);
  const id=await f.locator('[data-preview-id]').getAttribute('data-preview-id');
  await page.screenshot({path:`test-results/complete-edit-real-${evidence.length+1}-preview.png`});
  await f.getByRole('button',{name:'应用修改',exact:true}).click();await f.locator('[data-annotation-status="applied"]').waitFor();await saved();const after=await graph();check(after);
  await f.getByRole('button',{name:'撤销',exact:true}).click();await saved();assert.deepEqual(await graph(),before);
  evidence.push({instruction,annotationId:id,previewRetainedOriginal:true,correctTopology:true,appliedAndSaved:true,oneStepUndo:true});
}
try {
  await page.goto(url,{waitUntil:'domcontentloaded'});for(let i=0;i<2;i++)await page.getByRole('button',{name:'继续',exact:true}).waitFor({timeout:3000}).then(()=>page.getByRole('button',{name:'继续',exact:true}).click()).catch(()=>{});
  await page.getByText('新会话',{exact:true}).last().click();await page.locator('[contenteditable="true"]').waitFor();await page.locator('[contenteditable="true"]').fill('本会话验证分子批注的完整计划和聊天续接。请只回复“准备好了”，不要调用工具。');await page.getByRole('button',{name:'发送消息',exact:true}).click();await page.getByText('准备好了',{exact:true}).last().waitFor({timeout:180000});
  await page.getByRole('button',{name:'打开分子工作区',exact:true}).click();await page.locator('iframe[title="分子编辑器"]').waitFor();f=await(await page.locator('iframe[title="分子编辑器"]').elementHandle()).contentFrame();await f.waitForFunction(()=>!!window.chemP0&&!document.querySelector('.chem-busy'));await saved();await f.getByRole('button',{name:'显示操作区',exact:true}).click();
  await load('CCCO');let before=await graph();await select(before.atoms[0][0]);console.log('LIVE phenyl attachment');await submit('在这里添加一个苯环');await applyUndo('在这里添加一个苯环',before,after=>{assert.equal(after.atoms.length,before.atoms.length+6);assert.equal(after.bonds.filter(([,b])=>b.type===4).length,6);assert.deepEqual(after.atoms.slice(0,before.atoms.length),before.atoms);});
  await select(before.atoms[0][0]);console.log('LIVE methyl replacement');await submit('把甲基换为一个苯环');await applyUndo('把甲基换为一个苯环',before,after=>{assert.equal(after.atoms.length,before.atoms.length-1+6);assert.equal(after.bonds.filter(([,b])=>b.type===4).length,6);assert.deepEqual(after.atoms.slice(0,3).map(([,a])=>a),before.atoms.slice(1).map(([,a])=>a));});
  await load('COC');before=await graph();await select(before.atoms[1][0]);console.log('LIVE complete O-to-C then phenyl plan');await submit('把o换为碳原子，然后外接一个苯环');await f.locator('.chem-plan-complete').waitFor({timeout:5000});await applyUndo('把o换为碳原子，然后外接一个苯环',before,after=>{assert.equal(after.atoms.length,9);assert.equal(after.atoms[1][1].label,'C');assert.equal(after.bonds.filter(([,b])=>b.type===4).length,6);});
  await load('CCCO');before=await graph();const anchor=before.atoms[0][0];await select(anchor);console.log('LIVE ambiguous propane request');await submit('在此位置的原子上加一个丙烷');await f.locator('[data-annotation-status="needs_clarification"]').waitFor({timeout:5000});const id=await f.locator('[data-annotation-id]').getAttribute('data-annotation-id');assert.deepEqual(await graph(),before);
  await select(before.atoms.at(-1)[0]);await page.getByRole('button',{name:'DSH 助手',exact:true}).click();await page.locator('.chem-host-assistant [contenteditable="true"]').fill('三个碳的碳链');await page.locator('.chem-host-assistant').getByRole('button',{name:'发送消息',exact:true}).click();console.log('LIVE actual chat clarification sent');await f.locator('[data-preview-id]').waitFor({timeout:240000});assert.equal(await f.locator('[data-preview-id]').getAttribute('data-preview-id'),id);await page.getByRole('button',{name:'收起 DSH 助手',exact:true}).click();
  await applyUndo('丙烷要求在聊天补充三个碳的碳链',before,after=>{assert.equal(after.atoms.length,before.atoms.length+3);assert.equal(after.bonds[before.bonds.length][1].begin,anchor);});
  assert.deepEqual(errors,[]);await writeFile('test-results/complete-edit-real-agent.json',JSON.stringify({date:new Date().toISOString(),runtime:'official DSH Web',evidence,browserErrors:errors},null,2));console.log('ALL-PASS: real DSH Agent phenyl attach/replace, complete batch and actual chat continuation');
} catch(e){await page.screenshot({path:'test-results/complete-edit-real-agent-failure.png'});console.log('LIVE failure:',String(e.message).replace(/https?:\/\/\S+/g,'[URL]'));throw new Error('Complete-edit real Agent verification failed; see the local screenshot and runtime log.');}finally{await browser.close();}
