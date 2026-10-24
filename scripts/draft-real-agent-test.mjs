// Requires an isolated, configured official DSH Web profile. No URL/token output.
import { chromium } from 'playwright';
import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const log=await readFile(process.env.CHEM_DSH_LOG||'test-results/a1-live-runtime.log','utf8'),url=log.match(/dsh web:\s*(https?:\/\/[^\s]+)/)?.[1];
if(!url)throw new Error('Isolated DSH launch URL unavailable');
const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1500,height:1100}}),errors=[];let f;
page.on('pageerror',error=>errors.push(error.message));
const graph=()=>f.evaluate(()=>window.chemP0.fingerprint());
async function saved(){await f.waitForFunction(()=>document.querySelector('[data-save-status]')?.textContent==='已保存'&&!document.querySelector('.chem-busy'));}
try{
  await page.goto(url,{waitUntil:'domcontentloaded'});
  for(let i=0;i<2;i++)await page.getByRole('button',{name:'继续',exact:true}).waitFor({timeout:3000}).then(()=>page.getByRole('button',{name:'继续',exact:true}).click()).catch(()=>{});
  await page.getByText('新会话',{exact:true}).last().click();await page.locator('[contenteditable="true"]').waitFor();
  await page.locator('[contenteditable="true"]').fill('本会话验证分子编辑草稿和新建原子引用。请只回复“准备好了”，不要调用工具。');await page.getByRole('button',{name:'发送消息',exact:true}).click();await page.getByText('准备好了',{exact:true}).last().waitFor({timeout:180000});
  await page.getByRole('button',{name:'打开分子工作区',exact:true}).click();await page.locator('iframe[title="分子编辑器"]').waitFor();f=await(await page.locator('iframe[title="分子编辑器"]').elementHandle()).contentFrame();
  await f.waitForFunction(()=>!!window.chemP0&&!document.querySelector('.chem-busy'));await saved();await f.getByRole('button',{name:'显示操作区',exact:true}).click();
  const revision=await f.evaluate(()=>window.chemP0.revision());await f.locator('.chem-import-menu > summary').click();await f.getByLabel('导入 SMILES',{exact:true}).fill('CC');await f.getByRole('button',{name:'载入',exact:true}).click();await f.waitForFunction(revision=>window.chemP0.revision()>revision,revision);await saved();
  const before=await graph(),point=await f.evaluate(id=>window.chemP0.atomPoint(id),before.atoms[0][0]),rect=await page.locator('iframe[title="分子编辑器"]').boundingBox();await page.mouse.click(rect.x+point.x,rect.y+point.y);
  const instruction='在选中的原子添加丙基，然后把新建片段末端原子改为 O';
  await f.getByLabel('草稿模式',{exact:true}).check();await f.getByLabel('对选区的批注').fill(instruction);await f.getByRole('button',{name:'交给 Agent',exact:true}).click();console.log('LIVE A1 draft submitted; waiting for real model tools.');
  await f.locator('[data-preview-id]').waitFor({timeout:240000});assert.deepEqual(await graph(),before);await f.locator('.chem-plan-complete').waitFor();
  const annotationId=await f.locator('[data-preview-id]').getAttribute('data-preview-id');await page.screenshot({path:'test-results/a1-real-agent-preview.png'});
  await f.getByRole('button',{name:'应用修改',exact:true}).click();await f.locator('[data-annotation-status="applied"]').waitFor();await saved();
  const after=await graph();assert.equal(after.atoms.length,before.atoms.length+3);assert.equal(after.atoms.at(-1)[1].label,'O');assert.deepEqual(after.atoms.slice(0,before.atoms.length),before.atoms);
  await f.getByRole('button',{name:'撤销',exact:true}).click();await saved();assert.deepEqual(await graph(),before);assert.deepEqual(errors,[]);
  await writeFile('test-results/a1-real-agent.json',JSON.stringify({date:new Date().toISOString(),runtime:'official DSH Web',instruction,annotationId,previewRetainedOriginal:true,newTerminalO:true,appliedAndSaved:true,oneStepUndo:true,browserErrors:errors},null,2));
  console.log('ALL-PASS: real DSH Agent A1 draft, new terminal atom, preview, save and one-step undo');
}catch(error){await page.screenshot({path:'test-results/a1-real-agent-failure.png'});console.log('A1 live verification failed:',String(error.message).replace(/https?:\/\/\S+/g,'[URL]'));throw new Error('A1 real Agent verification failed; see local screenshot/log.');}finally{await browser.close();}
