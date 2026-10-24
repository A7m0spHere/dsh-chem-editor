import { hostMethods } from '../contracts/bridge';
import type { AnnotationService } from './annotation-service';
import type { DocumentStore } from './document-store';

type BridgeDependencies = {
  annotations: AnnotationService; store: DocumentStore; snapshots: Map<string, any>;
  directoryFor: (sessionId: string) => Promise<string>; ready: Promise<void>;
  isDisposed: () => boolean; origin: () => string; token: string;
};
export function registerHostBridge(ctx: any, deps: BridgeDependencies) {
  const { annotations, store, snapshots, directoryFor, ready, token } = deps;
  for (const method of hostMethods) {
    ctx.connection.fetch.register({ path: `/api/${method}`, methods: ['POST'], requestBody: 'buffered', async fetch(request: Request) {
      let m: any;
      try { m = await request.json(); } catch { return new Response('Invalid JSON', { status: 400 }); }
      if (m?.type !== 'client-request' || m.method !== method || typeof m.rpcId !== 'string') return new Response('Invalid RPC', { status: 400 });
      let result: any;
      try {
        await ready;
        if (deps.isDisposed()) throw new Error('插件正在退出。');
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
        else if (method.endsWith('/continue-annotation')) result = {ok:true,value:await annotations.continueEdit(sessionId,m.payload,request.signal,true)};
        else if (method.endsWith('/annotations')) result = { ok: true, value: await annotations.list(sessionId) };
        else if (method.endsWith('/annotation-detail')) result = { ok: true, value: await annotations.detail(sessionId, m.payload.annotationId) };
        else if (method.endsWith('/preview')) result = { ok: true, value: await annotations.validation(sessionId, m.payload) };
        else if (method.endsWith('/apply')) result = { ok: true, value: await annotations.commit(sessionId, m.payload) };
        else if (method.endsWith('/cancel')) result = { ok: true, value: await annotations.cancel(sessionId, m.payload.annotationId) };
        else if (method.endsWith('/detach')) { await annotations.detach(sessionId, m.payload.instanceId); result = { ok: true, value: {} }; }
        else result = { ok: true, value: { url: `${deps.origin()}/${token}/index.html?managed=1`, snapshot: snapshots.get(sessionId) ?? null, ...(await store.read(directory, sessionId)), annotations: await annotations.list(sessionId), version: '0.1.0' } };
      } catch (e: any) { result = { ok: false, error: { code: e.code || 'chem-editor/error', message: e.message, details: {} } }; }
      return Response.json({ type: 'server-response', rpcId: m.rpcId, result });
    } });
  }
}
