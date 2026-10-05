import React from 'react';
import { createRoot } from 'react-dom/client';
const h = React.createElement;
let Body: any;
let inject: any;
const closeHandlers = new Map();
const sessionId = location.pathname.slice(1) || 'session-a';
const connection = { rpc: { async call(channel: string, method: string, payload: any) {
  const response = await fetch(`${channel}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload }) });
  const result = (await response.json()).result;
  if (result.ok === false && (!result.error || typeof result.error.code !== 'string' || typeof result.error.message !== 'string' || !result.error.details || typeof result.error.details !== 'object')) throw new Error('Invalid DSH failure envelope');
  return result;
} } };
const ctx = { connection, effect: (fn: any) => fn(), slots: { inject: (name: string, fn: any) => fn(), register: (def: any, component: any) => { if (def.name === 'sidebar.right.pane.tab') { Body = component; inject = def.inject; } } }, sidebarRightTabs: { register: () => () => {} }, sidebarRight: { registerCloseHandler: (kind: string, handler: any) => { closeHandlers.set(kind, handler); return () => closeHandlers.delete(kind); }, openTab: () => {} } };
(window as any).__ModuleLoader__ = { load: ({ factory }: any) => { factory((name: string) => { if (name === 'react') return React; throw new Error(name); }).apply(ctx); createRoot(document.getElementById('root')!).render(h(Shell)); } };
function Shell() {
  const [open, setOpen] = React.useState(true);
  const [generation, setGeneration] = React.useState(0);
  const [error, setError] = React.useState('');
  const info = { tab: { id: `tab-${sessionId}` } };
  return h('div', { style: { height: '100vh', display: 'flex', flexDirection: 'column' } },
    h('nav', null, sessionId, h('button', { onClick: () => { try { closeHandlers.get('chem-editor')?.(sessionId, info.tab); setOpen(false); setError(''); } catch (e: any) { setError(e.message); } } }, '关闭面板'), h('button', { onClick: () => { setGeneration(v => v + 1); setOpen(true); } }, '重开面板'), h('span', { 'data-guard-error': true }, error)),
    h('div', { style: { flex: 1, minHeight: 0 } }, open ? h(Body, { key: generation, useTabInfo: () => info, sessionId, ...inject() }) : null));
}
const script = document.createElement('script'); script.src = '/client.js'; document.body.appendChild(script);
