import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { DocumentStore } from './host/document-store';
import { registerV1Tools } from './host/tools/v1';
import { registerDraftTools } from './host/tools/v2';
import { registerHostBridge } from './host/bridge';
export { fragments, resolveFragment } from './fragments';
export { fragmentInputs, fragmentIds, fragmentCatalog, fragmentName, fragmentList, dynamicFragments, resolveFragmentSpec, parseFragmentSpec } from './chemistry/fragment-spec';
export { executePatch, normalizePatch, verifyMolecularPatch } from './molecular-patch';
export { requestedEdits, verifyEditIntent } from './edit-intent';
export { executeDraft, verifyDraftCandidate } from './chemistry/draft';
import { AnnotationService } from './host/annotation-service';
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
    if (event.type === 'user/message') annotations.userMessage(session.id,event.data).catch(() => {});
    if (event.type === 'turn/end') annotations.turnEnded(session.id).catch(() => {});
  });
  registerV1Tools(ctx, annotations);
  registerDraftTools(ctx, annotations);
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
  registerHostBridge(ctx, { annotations, store, snapshots, directoryFor, ready, token, isDisposed: () => disposed, origin: () => origin });
}
