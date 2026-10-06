import { createServer } from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import { apply, requestedEdits } from '../lib/index.js';
const base = resolve(tmpdir()); const directory = await mkdtemp(join(base, 'dsh-chem-browser-'));
const routes = new Map(), disposers = [];
const tools = new Map(), agentCalls = [], listeners = new Map();
async function runAgent(sessionId,annotationId) {
    const exec = { agent: { session: { id: sessionId } }, signal: new AbortController().signal };
    try {
      agentCalls.push({ tool: 'chem_get_context', annotationId });
      const context = await tools.get('chem_get_context').execute({ annotationId }, exec);
      const data = JSON.parse(context.context);
      if (data.instruction.includes('仅解释')) return;
      let expected;
      try {if(data.instruction.includes('苄基'))throw Object.assign(new Error('暂不支持苄基，请明确其他修改要求。'),{code:'unsupported_fragment'});expected=requestedEdits(data.instruction,data.clarification);} catch(e){await tools.get('chem_reject_edit').execute({annotationId,code:e.code||'clarification_required',reason:e.message},exec);return;}
      if(expected.some(e=>e.operation==='attach_fragment')&&data.attachmentAtom===null){
        await tools.get('chem_reject_edit').execute({annotationId,code:'connection_point_required',reason:'请在批注区选择一个连接原子后继续。'},exec);return;
      }
      const edits=expected.map(e=>({...e,...(['replace_atom','attach_fragment'].includes(e.operation)?{targetAtom:data.attachmentAtom}:{}),...(e.operation==='change_bond'?{targetBond:data.selection.bonds[0]}:{})}));
      const args=edits.length===1||data.instruction.startsWith('测试不完整计划：')?edits[0]:{operation:'batch',edits};
      agentCalls.push({ tool: 'chem_propose_edit', annotationId, ...args });
      await tools.get('chem_propose_edit').execute({ annotationId, ...args, reason: '完整执行用户要求，使用冻结选区。' }, exec);
    } catch (e) { agentCalls.push({ error: e.message }); } finally { listeners.get('session/event')?.({id:sessionId},{type:'turn/end'}); }
}
const prompt = async request => {
  const annotationId=request.content?.[0]?.text?.match(/批注 ID：([a-zA-Z0-9-]+)/)?.[1]||request.requestId;
  setTimeout(()=>{
    listeners.get('session/event')?.({id:request.sessionId},{type:'user/message',data:{source:{kind:'user',rpcId:request.requestId}}});
    runAgent(request.sessionId,annotationId);
  },400);
  return { accepted: true };
};
apply({ on: (event,callback) => listeners.set(event,callback), tools: { register: spec => { tools.set(spec.name, spec); return () => tools.delete(spec.name); } }, sessionController: { list: async () => ({ items: ['session-a', 'session-b'].map(sessionId => ({ sessionId, cwd: join(directory, sessionId) })) }), prompt }, connection: { fetch: { register: route => routes.set(route.path, route) } }, effect: fn => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); } });
const fixture = (await build({ entryPoints: ['tests/client-fixture.tsx'], bundle: true, platform: 'browser', format: 'iife', write: false, define: { 'process.env.NODE_ENV': '"production"' } })).outputFiles[0].text;
let failNextSave = false, failNextApply = false;
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path === '/test/fail-next-save') { failNextSave = true; res.end('ok'); return; }
    if (path === '/test/fail-next-apply') { failNextApply = true; res.end('ok'); return; }
    if (path === '/test/agent-calls') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(agentCalls)); return; }
    if(path==='/test/chat-reply'){
      const buffers=[];for await(const b of req)buffers.push(b);const {sessionId,annotationId,userReply}=JSON.parse(Buffer.concat(buffers));
      const exec={agent:{session:{id:sessionId}},signal:new AbortController().signal};
      listeners.get('session/event')?.({id:sessionId},{type:'user/message',data:{source:{kind:'user',rpcId:'fixture-reply-'+Date.now()},content:[{type:'text',text:userReply}]}});
      await tools.get('chem_get_context').execute({annotationId},exec);
      agentCalls.push({tool:'chem_continue_edit',annotationId,userReply});
      await tools.get('chem_continue_edit').execute({annotationId,userReply},exec);
      await runAgent(sessionId,annotationId);res.end('ok');return;
    }
    if (routes.has(path)) {
      const buffers = []; for await (const chunk of req) buffers.push(chunk);
      let response;
      if ((failNextSave && path.endsWith('/save')) || (failNextApply && path.endsWith('/apply'))) { failNextSave = false; failNextApply = false; const m = JSON.parse(Buffer.concat(buffers)); response = Response.json({ type: 'server-response', rpcId: m.rpcId, result: { ok: false, error: { code: 'storage_unavailable', message: '模拟保存失败，原文件保持。', details: {} } } }); }
      else response = await routes.get(path).fetch(new Request(`http://localhost${path}`, { method: req.method, headers: { 'content-type': 'application/json' }, body: Buffer.concat(buffers) }));
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer())); return;
    }
    if (path === '/session-a' || path === '/session-b') { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><html><body style="margin:0"><div id="root"></div><script src="/fixture.js"></script></body></html>'); return; }
    if (path === '/fixture.js') { res.setHeader('content-type', 'text/javascript'); res.end(fixture); return; }
    if (path === '/client.js') { res.setHeader('content-type', 'text/javascript'); res.end(await readFile('lib/client.js')); return; }
    const file = path.slice(1) || 'index.html';
    const types = { 'index.html': 'text/html', 'editor.js': 'text/javascript', 'editor.css': 'text/css' };
    if (!(file in types)) { res.writeHead(404); res.end(); return; }
    res.setHeader('content-type', types[file]); res.end(await readFile(`dist/${file}`));
  } catch (e) { res.writeHead(500); res.end(e.message); }
});
await new Promise(r => server.listen(3099, '127.0.0.1', r));
try {
  for (const script of ['scripts/browser-test.mjs', 'scripts/p1-browser-test.mjs', 'scripts/p2-browser-test.mjs', 'scripts/p3-browser-test.mjs', 'scripts/edit-flow-browser-test.mjs', 'scripts/layout-browser-test.mjs'].filter(s => !process.env.CHEM_TEST_STAGE || process.env.CHEM_TEST_STAGE.split(',').some(stage=>s.includes(stage)))) {
    const code = await new Promise((resolve, reject) => { const child = spawn(process.execPath, [script], { stdio: 'inherit', windowsHide: true }); child.once('error', reject); child.once('exit', resolve); });
    if (code !== 0) throw new Error(`${script} failed (${code})`);
  }
} finally {
  server.closeAllConnections(); await new Promise(r => server.close(r)); for (const d of disposers.reverse()) await d();
  if (!resolve(directory).startsWith(base + sep)) throw new Error('Unsafe test cleanup'); await rm(directory, { recursive: true, force: true });
}
