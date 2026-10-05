import { createServer } from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import { apply } from '../lib/index.js';
const base = resolve(tmpdir()); const directory = await mkdtemp(join(base, 'dsh-chem-browser-'));
const routes = new Map(), disposers = [];
const tools = new Map(), agentCalls = [], listeners = new Map();
const prompt = async request => {
  setTimeout(async () => {
    const exec = { agent: { session: { id: request.sessionId } }, signal: new AbortController().signal };
    try {
      listeners.get('session/event')?.({id:request.sessionId},{type:'user/message',data:{source:{rpcId:request.requestId}}});
      agentCalls.push({ tool: 'chem_get_context', annotationId: request.requestId });
      const context = await tools.get('chem_get_context').execute({ annotationId: request.requestId }, exec);
      const data = JSON.parse(context.context);
      if (data.instruction.includes('仅解释')) return;
      const element = data.instruction.includes('F') ? 'F' : 'N';
      let args = { operation: 'replace_atom', targetAtom: data.selectedAtom?.id, element };
      if (data.instruction.includes('添加')) args = { operation: 'attach_fragment', targetAtom: data.selectedAtom.id, fragment: data.instruction.match(/OH|CH3|NH2|Cl|F/)[0] };
      if (data.instruction.includes('双键') || data.instruction.includes('三键')) args = { operation: 'change_bond', targetBond: data.selection.bonds[0], bondType: data.instruction.includes('三键') ? 3 : 2 };
      if (data.instruction.includes('删除')) args = { operation: 'delete_selection' };
      agentCalls.push({ tool: 'chem_propose_edit', annotationId: request.requestId, ...args });
      await tools.get('chem_propose_edit').execute({ annotationId: request.requestId, ...args, reason: '根据冻结选区执行单原子元素替换。' }, exec);
    } catch (e) { agentCalls.push({ error: e.message }); } finally { listeners.get('session/event')?.({id:request.sessionId},{type:'turn/end'}); }
  }, 400);
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
  for (const script of ['scripts/browser-test.mjs', 'scripts/p1-browser-test.mjs', 'scripts/p2-browser-test.mjs', 'scripts/p3-browser-test.mjs'].filter(s => !process.env.CHEM_TEST_STAGE || process.env.CHEM_TEST_STAGE.split(',').some(stage=>s.includes(stage)))) {
    const code = await new Promise((resolve, reject) => { const child = spawn(process.execPath, [script], { stdio: 'inherit', windowsHide: true }); child.once('error', reject); child.once('exit', resolve); });
    if (code !== 0) throw new Error(`${script} failed (${code})`);
  }
} finally {
  server.closeAllConnections(); await new Promise(r => server.close(r)); for (const d of disposers.reverse()) await d();
  if (!resolve(directory).startsWith(base + sep)) throw new Error('Unsafe test cleanup'); await rm(directory, { recursive: true, force: true });
}
