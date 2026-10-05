import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, sep } from 'node:path';
import { DocumentStore } from '../lib/index.js';
const value = (title = '苯', revision = 1) => ({ schemaVersion: 1, documentId: 'test-document', title, revision, language: 'zh-CN', ket: JSON.stringify({ root: { nodes: [{ $ref: 'mol0' }] }, mol0: { type: 'molecule', atoms: [{ label: 'C', location: [0, 0, 0] }], bonds: [] } }) });
test('durable storage: restart, session isolation, CAS, failed replace and corrupt recovery', async () => {
  const base = resolve(tmpdir()); const directory = await mkdtemp(join(base, 'dsh-chem-store-'));
  try {
    const store = new DocumentStore();
    const first = await store.save(directory, 'a', value(), null);
    const restarted = new DocumentStore();
    assert.equal((await restarted.read(directory, 'a')).document.title, '苯');
    assert.equal((await restarted.read(directory, 'b')).document, null);
    assert.equal((await store.save(directory, 'a', value(), first.token)).token, first.token);
    const concurrent = await Promise.allSettled([store.save(directory, 'a', value('A', 2), first.token), store.save(directory, 'a', value('B', 2), first.token)]);
    assert.equal(concurrent.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(concurrent.find(r => r.status === 'rejected').reason.code, 'save_conflict');
    const saved = await store.read(directory, 'a');
    const bytes = await readFile(saved.path, 'utf8');
    const broken = new DocumentStore(async () => { throw new Error('simulated disk failure'); });
    await assert.rejects(broken.save(directory, 'a', value('will fail', 3), saved.token), e => e.code === 'storage_unavailable');
    assert.equal(await readFile(saved.path, 'utf8'), bytes);
    assert.ok((await readdir(directory)).every(name => !name.endsWith('.tmp')));
    await writeFile(saved.path, '{broken');
    await assert.rejects(store.read(directory, 'a'), e => e.code === 'document_corrupt');
    await assert.rejects(store.save(directory, 'a', value('must not overwrite'), null), e => e.code === 'document_corrupt');
    assert.equal(await readFile(saved.path, 'utf8'), '{broken');
  } finally { if (!resolve(directory).startsWith(base + sep)) throw new Error('Unsafe test cleanup'); await rm(directory, { recursive: true, force: true }); }
});
