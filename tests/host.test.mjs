import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, fragments, fragmentInputs } from '../lib/index.js';
test('host bridge serves only editor assets, isolates sessions, and disposes', async () => {
  const routes = new Map(), disposers = [], tools = new Map();
  const ctx = { tools: { register: spec => { tools.set(spec.name,spec); return () => {}; } }, sessionController: { list: async () => ({ items: [{ sessionId: 'session-a', cwd: process.cwd() }, { sessionId: 'session-b', cwd: process.cwd() }] }) }, connection: { fetch: { register: route => { routes.set(route.path, route); } } }, effect: fn => { const d = fn(); if (typeof d === 'function') disposers.push(d); } };
  apply(ctx);
  const call = async (method, payload) => {
    const response = await routes.get(`/api/chem-editor/${method}`).fetch(new Request(`http://localhost/api/chem-editor/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'test-request', method: `chem-editor/${method}`, payload }) }));
    return (await response.json()).result;
  };
  try {
    assert.deepEqual(tools.get('chem_propose_edit').parameters.properties.fragment.enum,fragmentInputs);
    for(const id of Object.keys(fragments))assert.ok(fragmentInputs.includes(id));
    for(const alias of ['丙基','正丙基','异丙基','乙基'])assert.ok(fragmentInputs.includes(alias));
    assert.ok(tools.has('chem_reject_edit'));
    const a = await call('bootstrap', { sessionId: 'session-a' });
    assert.equal(a.ok, true);
    assert.equal((await fetch(a.value.url)).status, 200);
    assert.equal((await fetch(new URL('../package.json', a.value.url))).status, 404);
    assert.equal((await fetch(a.value.url, { method: 'POST' })).status, 404);
    const snapshot = { revision: 4, documentId: 'document-a', atoms: [{ id: 12, element: 'N' }], bonds: [], ket: '{}', selection: { atoms: [12], bonds: [] } };
    const posted = await call('snapshot', { sessionId: 'session-a', snapshot });
    assert.equal(posted.value.atomCount, 1);
    assert.deepEqual((await call('bootstrap', { sessionId: 'session-a' })).value.snapshot.selection.atoms, [12]);
    assert.equal((await call('bootstrap', { sessionId: 'session-b' })).value.snapshot, null);
    assert.equal((await call('snapshot', { sessionId: 'session-a', snapshot: { revision: 'bad' } })).ok, false);
  } finally { for (const d of disposers.reverse()) await d(); }
});
