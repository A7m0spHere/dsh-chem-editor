import { readFile, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export class DocumentError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
export function validateDocument(value: any) {
  if (!value || value.schemaVersion !== 1 || typeof value.documentId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(value.documentId) || !Number.isSafeInteger(value.revision) || value.revision < 0 || typeof value.ket !== 'string' || value.ket.length > 2_000_000 || typeof value.title !== 'string' || value.title.length > 120 || !['zh-CN', 'en'].includes(value.language)) throw new DocumentError('invalid_document', '分子文档格式不正确。');
  try { const ket = JSON.parse(value.ket); if (!ket || !ket.root || !Array.isArray(ket.root.nodes)) throw new Error(); }
  catch { throw new DocumentError('invalid_document', '文档中的 KET 结构不正确。'); }
  if (value.lastAppliedAnnotationId !== undefined && (typeof value.lastAppliedAnnotationId !== 'string' || !/^[a-zA-Z0-9-]{10,80}$/.test(value.lastAppliedAnnotationId))) throw new DocumentError('invalid_document', '应用回执格式不正确。');
  return { schemaVersion: 1, documentId: value.documentId, revision: value.revision, ket: value.ket, title: value.title, language: value.language, ...(value.lastAppliedAnnotationId ? { lastAppliedAnnotationId: value.lastAppliedAnnotationId } : {}) };
}
const digest = (text: string) => createHash('sha256').update(text).digest('hex');

export class DocumentStore {
  private queues = new Map<string, Promise<any>>();
  constructor(private beforeReplace?: (path: string) => Promise<void>) {}
  path(directory: string, sessionId: string) { return join(directory, `${digest(sessionId)}.json`); }
  async read(directory: string, sessionId: string) {
    const path = this.path(directory, sessionId);
    let text: string;
    try { text = await readFile(path, 'utf8'); }
    catch (e: any) { if (e.code === 'ENOENT') return { document: null, token: null, path }; throw new DocumentError('storage_unavailable', `无法读取分子文档：${e.message}`); }
    try {
      const record = JSON.parse(text);
      const document = validateDocument(record);
      if (record.sessionId !== sessionId || !Number.isSafeInteger(record.savedVersion) || record.savedVersion < 1 || typeof record.savedAt !== 'string') throw new Error();
      return { document: { ...document, savedVersion: record.savedVersion, savedAt: record.savedAt }, token: digest(text), path };
    } catch { throw new DocumentError('document_corrupt', `已保存的分子文档损坏，未覆盖原文件：${path}`); }
  }
  save(directory: string, sessionId: string, value: any, baseToken: string | null) {
    const path = this.path(directory, sessionId);
    const previous = this.queues.get(path) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(async () => {
      const existing = await this.read(directory, sessionId);
      const document = validateDocument({ ...value, lastAppliedAnnotationId: value.lastAppliedAnnotationId ?? existing.document?.lastAppliedAnnotationId });
      if (baseToken !== existing.token) throw new DocumentError('save_conflict', '其他窗口或外部程序已修改文档。请先导出当前结构，或重新载入已保存版本。');
      if (existing.document && JSON.stringify(validateDocument(existing.document)) === JSON.stringify(document)) return existing;
      const record = { ...document, sessionId, savedVersion: (existing.document?.savedVersion ?? 0) + 1, savedAt: new Date().toISOString() };
      const text = JSON.stringify(record, null, 2) + '\n';
      const temporary = `${path}.${randomUUID()}.tmp`;
      await mkdir(dirname(path), { recursive: true });
      try {
        const handle = await open(temporary, 'wx');
        try { await handle.writeFile(text, 'utf8'); await handle.sync(); } finally { await handle.close(); }
        await this.beforeReplace?.(path);
        // Recheck external writes after flushing the candidate, before replacement.
        if ((await this.read(directory, sessionId)).token !== baseToken) throw new DocumentError('save_conflict', '保存期间文档发生变化，未覆盖其他修改。');
        await rename(temporary, path);
      } catch (e: any) {
        if (e instanceof DocumentError) throw e;
        throw new DocumentError('storage_unavailable', `保存失败，原文件保持：${e.message}`);
      } finally { await unlink(temporary).catch(() => {}); }
      return { document: record, token: digest(text), path };
    });
    this.queues.set(path, current);
    current.finally(() => { if (this.queues.get(path) === current) this.queues.delete(path); }).catch(() => {});
    return current;
  }
  async drain() { await Promise.allSettled([...this.queues.values()]); }
}
