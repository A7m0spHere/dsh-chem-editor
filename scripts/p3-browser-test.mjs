import { chromium } from 'playwright';
import assert from 'node:assert/strict';
const browser = await chromium.launch({channel:'chrome',headless:true});
const page = await browser.newPage({viewport:{width:1060,height:1100}}), errors=[];
page.on('pageerror',e=>errors.push(e.message)); let f;
const fingerprint = () => f.evaluate(()=>window.chemP0.fingerprint());
async function saved(){await f.waitForFunction(()=>document.querySelector('[data-save-status]')?.textContent==='已保存'&&!document.querySelector('.chem-busy'));}
async function load(smiles){const rev=await f.evaluate(()=>window.chemP0.revision());await f.locator('.chem-import-menu > summary').click();await f.getByLabel('导入 SMILES',{exact:true}).fill(smiles);await f.getByRole('button',{name:'载入',exact:true}).click();await f.waitForFunction(rev=>window.chemP0.revision()>rev,rev);await saved();}
async function point(id){const p=await f.evaluate(id=>window.chemP0.atomPoint(id),id),r=await page.locator('iframe').boundingBox();return{x:p.x+r.x,y:p.y+r.y};}
async function select(id){const p=await point(id);await page.mouse.click(p.x,p.y);}
async function bond(id){const b=(await fingerprint()).bonds.find(([n])=>n===id)[1],a=await point(b.begin),c=await point(b.end);await page.mouse.click((a.x+c.x)/2,(a.y+c.y)/2);}
async function propose(text,laterTarget){await saved();const previous=await f.locator('[data-annotation-id]').getAttribute('data-annotation-id').catch(()=>null);await f.getByLabel('对选区的批注').fill(text);await f.getByRole('button',{name:'交给 Agent',exact:true}).click();if(laterTarget!==undefined)await select(laterTarget);await f.waitForFunction(previous=>{const el=document.querySelector('[data-annotation-id]');return el?.getAttribute('data-annotation-id')!==previous && (document.querySelector('[data-preview-id]')||el?.getAttribute('data-annotation-status')==='failed');},previous,{timeout:40000});await f.locator('[data-preview-id]').waitFor({timeout:15000});}
async function apply(){await f.getByRole('button',{name:'应用修改',exact:true}).click();await f.locator('[data-annotation-status="applied"]').waitFor();await saved();}
async function undo(){await f.getByRole('button',{name:'撤销',exact:true}).click();await saved();}
try {
  await page.goto('http://127.0.0.1:3099/session-b');await page.locator('iframe').waitFor();f=await(await page.locator('iframe').elementHandle()).contentFrame();await f.waitForFunction(()=>!!window.chemP0&&!document.querySelector('.chem-busy'));await saved();
  await load('CCNC(=O)CC(C)(C)CO');let original=await fingerprint();await bond(original.bonds[0][0]);await propose('改成双键');assert.deepEqual(await fingerprint(),original);await apply();
  let after=await fingerprint();assert.equal(after.bonds[0][1].type,2);assert.deepEqual(after.atoms,original.atoms);await undo();assert.deepEqual(await fingerprint(),original);
  console.log('PASS P3 actual bond selection, amide/branch graph, preview, one-step undo');
  for(const fragment of ['OH','CH3','NH2','F','Cl']) {
    await select(original.atoms[0][0]);await propose('添加 '+fragment, original.atoms.at(-1)[0]);assert.deepEqual(await fingerprint(),original);await apply();
    after=await fingerprint();assert.equal(after.atoms.length,original.atoms.length+1);assert.equal(after.bonds.length,original.bonds.length+1);assert.equal(after.bonds.at(-1)[1].begin,original.atoms[0][0]);
    assert.deepEqual(after.atoms.slice(0,original.atoms.length),original.atoms);await undo();assert.deepEqual(await fingerprint(),original);
  }
  console.log('PASS all five whitelist fragments, fixed attachment, preserved canvas and repeated undo');
  await f.getByRole('button',{name:'含手性多环示例',exact:true}).click();await f.waitForFunction(()=>window.chemP0.ketcher.editor.struct().atoms.size===21);await saved();original=await fingerprint();await select(original.atoms[0][0]);await propose('添加 OH');await apply();after=await fingerprint();assert.deepEqual(after.atoms.slice(0,original.atoms.length),original.atoms);assert.deepEqual(after.bonds.slice(0,original.bonds.length),original.bonds);await undo();assert.deepEqual(await fingerprint(),original);
  console.log('PASS chiral polycycle untouched atom/bond stereo preservation');
  await load('CCCCO');original=await fingerprint();await select(original.atoms[2][0]);await propose('删除选区');await f.locator('.chem-preview').getByText(/断开 2 根边界键/).waitFor();await apply();after=await fingerprint();assert.equal(after.atoms.length,4);assert.equal(after.bonds.length,2);await undo();assert.deepEqual(await fingerprint(),original);
  await bond(original.bonds[1][0]);await propose('删除选区');await apply();assert.equal((await fingerprint()).atoms.length,5);assert.equal((await fingerprint()).bonds.length,3);await undo();assert.deepEqual(await fingerprint(),original);
  console.log('PASS internal atom deletion, two boundary cuts, bond-only deletion and disconnected components');
  await load('CCCO');const short=await fingerprint();await select(short.atoms[1][0]);await propose('删除选区');await apply();assert.equal((await fingerprint()).atoms.length,3);await undo();assert.deepEqual(await fingerprint(),short);
  await load('CCCCO');original=await fingerprint();
  console.log('PASS deletion creates an isolated atom with an omitted empty bond array');
  // Drag a real rectangular selection over the rightmost two atoms.
  const points=await Promise.all(original.atoms.map(([id])=>point(id)));const ordered=points.map((p,i)=>({...p,id:original.atoms[i][0]})).sort((a,b)=>a.x-b.x);const region=ordered.slice(-2), left=(ordered.at(-3).x+region[0].x)/2;
  await page.mouse.move(left,Math.min(...region.map(p=>p.y))-18);await page.mouse.down();await page.mouse.move(Math.max(...region.map(p=>p.x))+18,Math.max(...region.map(p=>p.y))+18,{steps:14});await page.mouse.up();
  const selection=await f.evaluate(()=>window.chemP0.ketcher.editor.selection());assert.equal(selection.atoms.length,2);await propose('删除选区');await apply();assert.equal((await fingerprint()).atoms.length,3);await undo();assert.deepEqual(await fingerprint(),original);
  console.log('PASS actual box selection and region deletion');
  await select(original.atoms[0][0]);await propose('添加 OH');await page.request.get('http://127.0.0.1:3099/test/fail-next-apply');await f.getByRole('button',{name:'应用修改',exact:true}).click();await f.getByText('模拟保存失败，原文件保持。',{exact:true}).waitFor();assert.deepEqual(await fingerprint(),original);await apply();assert.equal((await fingerprint()).atoms.length,6);await undo();assert.deepEqual(await fingerprint(),original);
  console.log('PASS rejected commit restores canvas/history; retry attaches once');
  await select(original.atoms[0][0]);await f.getByRole('button',{name:'替换选中原子',exact:true}).click();await saved();const manual=await fingerprint();await select(manual.atoms[0][0]);await propose('添加 CH3');await apply();await undo();assert.deepEqual(await fingerprint(),manual);await undo();assert.deepEqual(await fingerprint(),original);
  console.log('PASS consecutive manual and AI history');
  await load('CC(C)(C)C');original=await fingerprint();await select(original.atoms[1][0]);await f.getByLabel('对选区的批注').fill('添加 OH');await f.getByRole('button',{name:'交给 Agent',exact:true}).click();await f.locator('[data-annotation-status="failed"]').waitFor({timeout:40000});assert.deepEqual(await fingerprint(),original);
  console.log('PASS saturated carbon rejects invalid valence before application');
  await load('CC');original=await fingerprint();await bond(original.bonds[0][0]);await propose('改成三键');await apply();assert.equal((await fingerprint()).bonds[0][1].type,3);await undo();assert.deepEqual(await fingerprint(),original);
  await select(original.atoms[0][0]);await page.keyboard.press('Control+a');assert.equal((await f.evaluate(()=>window.chemP0.ketcher.editor.selection())).atoms.length,2);await propose('删除选区');await apply();assert.equal((await fingerprint()).atoms.length,0);await undo();assert.deepEqual(await fingerprint(),original);
  console.log('PASS triple bond and whole molecule deletion/undo');
  await f.getByRole('button',{name:'苯',exact:true}).click();await f.waitForFunction(()=>window.chemP0.ketcher.editor.struct().atoms.size===6);await saved();original=await fingerprint();await bond(original.bonds[0][0]);await f.getByLabel('对选区的批注').fill('改成双键');await f.getByRole('button',{name:'交给 Agent',exact:true}).click();await f.locator('[data-annotation-status="failed"]').waitFor({timeout:40000});assert.deepEqual(await fingerprint(),original);
  console.log('PASS aromatic Kekule bond refuses local bond-order modification');
  await f.getByLabel('界面语言').selectOption('en');await f.locator('.chem-shortcuts > summary').click();await f.getByRole('button',{name:'Add OH',exact:true}).waitFor();await f.getByLabel('Annotation for the selection').waitFor();assert.deepEqual(errors,[]);await page.screenshot({path:'test-results/p3-browser.png'});
  console.log('ALL-PASS: P3 browser acceptance');
} catch(e){await page.screenshot({path:'test-results/p3-failure.png'});console.log('AGENT CALLS',await(await page.request.get('http://127.0.0.1:3099/test/agent-calls')).json());if(f)console.log('P3 DIAGNOSTIC',(await f.locator('body').innerText()).slice(-2800));throw e;}
finally{await browser.close();}
