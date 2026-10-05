import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { DocumentStore } from './document-store';
import { operations, fragments } from './molecular-patch';
export { executePatch, normalizePatch, verifyMolecularPatch } from './molecular-patch';
import { AnnotationService, elements } from './annotation-service';
export { DocumentStore, DocumentError } from './document-store';
export { AnnotationService, verifyPatch } from './annotation-service';

export const name = 'chem-editor';
export const inject = ['connection', 'sessionController', 'tools'];
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const mime = { 'index.html': 'text/html; charset=utf-8', 'editor.js': 'text/javascript; charset=utf-8', 'editor.css': 'text/css; charset=utf-8' };

export function apply(ctx: any) {
  const token = randomBytes(18).toString('hex');
  const snapshots = new Map<string, any>();
  const store = new DocumentStore();
  const directories = new Map<string, string>();
  let disposed = false;
  async function directoryFor(sessionId: string) {
    if (directories.has(sessionId)) return directories.get(sessionId)!;
    const response = await ctx.sessionController.list({});
    if (!Array.isArray(response?.items)) throw new Error('当前 DSH 会话列表接口不兼容。');
    const session = response.items.find((s: any) => s.sessionId === sessionId);
    if (!session) throw new Error('会话不存在，请重新打开当前会话。');
    const directory = session.cwd && isAbsolute(session.cwd) ? join(session.cwd, '.chem-editor') : join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'chem-editor', 'documents');
    directories.set(sessionId, directory); return directory;
  }
  const annotations = new AnnotationService({ store, directoryFor, prompt: (request, signal) => ctx.sessionController.prompt(request, signal) });
  ctx.on?.('session/event', (session: any, event: any) => {
    if (typeof session?.id !== 'string' || !annotations.watches(session.id)) return;
    if (event.type === 'user/message' && typeof event.data?.source?.rpcId === 'string') annotations.presented(session.id, event.data.source.rpcId).catch(() => {});
    if (event.type === 'turn/end') annotations.turnEnded(session.id).catch(() => {});
  });
  const toolSession = (exec: any) => {
    const id = exec?.agent?.session?.id;
    if (typeof id !== 'string' || !id) throw new Error('chem-editor: caller session is required');
    return id;
  };
  const output = (fields: Record<string, any>) => ({ schema: { type: 'object', properties: fields, required: Object.keys(fields), additionalProperties: false }, render: (_args: any, value: any) => [{ type: 'text', text: JSON.stringify(value) }] });
  ctx.tools.register({
    name: 'chem_get_context', description: 'Read the frozen molecular atom/bond/box selection for a user annotation in this calling session. IDs belong only to this frozen snapshot. Use before chem_propose_edit; never edit molecule files directly.',
    parameters: { type: 'object', properties: { annotationId: { type: 'string' }, fullGraph: { type: 'boolean' } }, required: ['annotationId'], additionalProperties: false },
    output: output({ annotationId: { type: 'string' }, status: { type: 'string' }, context: { type: 'string' } }),
    isConcurrencySafe: () => true,
    async execute(args: any, exec: any) { exec.signal?.throwIfAborted(); return annotations.context(toolSession(exec), args.annotationId, args.fullGraph === true); },
  });
  ctx.tools.register({
    name: 'chem_propose_edit', description: 'Propose one deterministic local operation on the frozen selection. replace_atom: targetAtom/element; change_bond: targetBond/bondType 1,2,3; attach_fragment: targetAtom/fragment whitelist (single attachment and single bond); delete_selection: remove the entire frozen selection and incident boundary bonds. No arbitrary graphs or SMILES. Chemical/stereo validation is required; the human applies/cancels the preview. Clarify ambiguous requests.',
    parameters: { type: 'object', properties: { annotationId: { type: 'string' }, operation: { type: 'string', enum: operations }, targetAtom: { type: 'integer' }, targetBond: { type: 'integer' }, bondType: { type: 'integer', enum: [1,2,3] }, fragment: { type: 'string', enum: Object.keys(fragments) }, element: { type: 'string', enum: elements }, reason: { type: 'string' } }, required: ['annotationId', 'operation', 'reason'], additionalProperties: false },
    output: output({ annotationId: { type: 'string' }, status: { type: 'string' }, summary: { type: 'string' } }),
    async execute(args: any, exec: any) { return annotations.propose(toolSession(exec), args, exec.signal); },
  });
  let origin = '';
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const file = url.pathname.startsWith(`/${token}/`) ? url.pathname.slice(token.length + 2) : '';
    if (!Object.hasOwn(mime, file) || !['GET', 'HEAD'].includes(req.method || '')) { res.writeHead(404); res.end(); return; }
    try {
      const data = await readFile(join(root, 'dist', file));
      res.writeHead(200, { 'content-type': mime[file], 'content-length': data.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch { res.writeHead(500); res.end('Editor build unavailable'); }
  });
  const ready = new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { origin = `http://127.0.0.1:${(server.address() as any).port}`; resolve(); });
  });
  ready.catch(e => ctx.logger?.('chem-editor')?.error(e.message));
  ctx.effect(() => async () => { disposed = true; await annotations.drain(); await store.drain(); snapshots.clear(); directories.clear(); server.close(); server.closeAllConnections(); }, 'chem-editor static server');
  for (const method of ['chem-editor/bootstrap', 'chem-editor/snapshot', 'chem-editor/save', 'chem-editor/annotate', 'chem-editor/annotations', 'chem-editor/annotation-detail', 'chem-editor/preview', 'chem-editor/apply', 'chem-editor/cancel', 'chem-editor/detach']) {
    ctx.connection.fetch.register({ path: `/api/${method}`, methods: ['POST'], requestBody: 'buffered', async fetch(request: Request) {
      let m: any;
      try { m = await request.json(); } catch { return new Response('Invalid JSON', { status: 400 }); }
      if (m?.type !== 'client-request' || m.method !== method || typeof m.rpcId !== 'string') return new Response('Invalid RPC', { status: 400 });
      let result: any;
      try {
        await ready;
        if (disposed) throw new Error('插件正在退出。');
        const sessionId = m.payload?.sessionId;
        if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 200) throw new Error('Invalid session');
        const directory = await directoryFor(sessionId);
        if (method.endsWith('/snapshot')) {
          const s = m.payload.snapshot;
          if (!Number.isSafeInteger(s?.revision) || !Array.isArray(s?.atoms) || !Array.isArray(s?.bonds) || s.atoms.length > 10000 || typeof s?.ket !== 'string' || s.ket.length > 2_000_000) throw new Error('Invalid snapshot');
          snapshots.set(sessionId, { ...s, receivedAt: Date.now() });
          annotations.updateFrame(sessionId, s);
          result = { ok: true, value: { revision: s.revision, atomCount: s.atoms.length, receivedAt: snapshots.get(sessionId).receivedAt } };
        } else if (method.endsWith('/save')) {
          if (m.payload.baseToken !== null && typeof m.payload.baseToken !== 'string') throw new Error('Invalid version token');
          const saved = await store.save(directory, sessionId, m.payload.document, m.payload.baseToken);
          result = { ok: true, value: saved };
        } else if (method.endsWith('/annotate')) result = { ok: true, value: await annotations.create(sessionId, m.payload, request.signal) };
        else if (method.endsWith('/annotations')) result = { ok: true, value: await annotations.list(sessionId) };
        else if (method.endsWith('/annotation-detail')) result = { ok: true, value: await annotations.detail(sessionId, m.payload.annotationId) };
        else if (method.endsWith('/preview')) result = { ok: true, value: await annotations.validation(sessionId, m.payload) };
        else if (method.endsWith('/apply')) result = { ok: true, value: await annotations.commit(sessionId, m.payload) };
        else if (method.endsWith('/cancel')) result = { ok: true, value: await annotations.cancel(sessionId, m.payload.annotationId) };
        else if (method.endsWith('/detach')) { await annotations.detach(sessionId, m.payload.instanceId); result = { ok: true, value: {} }; }
        else result = { ok: true, value: { url: `${origin}/${token}/index.html?managed=1`, snapshot: snapshots.get(sessionId) ?? null, ...(await store.read(directory, sessionId)), annotations: await annotations.list(sessionId), version: '0.1.0' } };
      } catch (e: any) { result = { ok: false, error: { code: e.code || 'chem-editor/error', message: e.message, details: {} } }; }
      return Response.json({ type: 'server-response', rpcId: m.rpcId, result });
    } });
  }
}
