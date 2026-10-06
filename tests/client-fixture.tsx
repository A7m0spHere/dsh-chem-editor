import React from 'react';
import { createRoot } from 'react-dom/client';
const h = React.createElement;
let Body: any;
let inject: any;
let Open: any;
let selectPanel: (id: string | null) => void;
const closeHandlers = new Map();
const sessionId = location.pathname.slice(1) || 'session-a';
const connection = { rpc: { async call(channel: string, method: string, payload: any) {
  const response = await fetch(`${channel}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload }) });
  const result = (await response.json()).result;
  if (result.ok === false && (!result.error || typeof result.error.code !== 'string' || typeof result.error.message !== 'string' || !result.error.details || typeof result.error.details !== 'object')) throw new Error('Invalid DSH failure envelope');
  return result;
} } };
const ctx = { connection, layout: { selectPanel: (id: string | null) => selectPanel?.(id) }, effect: (fn: any) => fn(), slots: { inject: (name: string, fn: any) => { const result = fn(); if (result?.[Symbol.iterator]) for (const ignored of result) {} }, register: (def: any, component: any) => { if (def.name === 'chem.workspace.session') { Body = component; inject = def.inject; } if (def.name === 'conversation.session.header.actions') Open = component; } }, sidebarRightTabs: { register: () => () => {} }, sidebarRight: { registerCloseHandler: (kind: string, handler: any) => { closeHandlers.set(kind, handler); return () => closeHandlers.delete(kind); }, openTab: () => {} } };
(window as any).__ModuleLoader__ = { load: ({ factory }: any) => { factory((name: string) => { if (name === 'react') return React; throw new Error(name); }).apply(ctx); createRoot(document.getElementById('root')!).render(h(Shell)); } };
function Shell() {
  const [open, setOpen] = React.useState(true);
  const [generation, setGeneration] = React.useState(0);
  const [error, setError] = React.useState('');
  const [panel, setPanel] = React.useState<string | null>('dsh-chem-editor');
  selectPanel = setPanel;
  const info = { tab: { id: 'workspace' } };
  return h('div', { style: { height: '100vh', display: 'flex', flexDirection: 'column' } },
    h('nav', null, sessionId, h('button', { onClick: () => { try { closeHandlers.get('chem-editor')?.(sessionId, info.tab); setOpen(false); setError(''); } catch (e: any) { setError(e.message); } } }, '关闭面板'), h('button', { onClick: () => { setGeneration(v => v + 1); setOpen(true); } }, '重开面板'), h('button', { onClick: () => setPanel(null) }, '切到其他页面'), h('span', { 'data-guard-error': true }, error)),
    h('div', { style: { flex: 1, minHeight: 0 } }, open && panel ? h(Body, { key: generation, sessionId, useSessions: (selector: any) => selector({ byId: { [sessionId]: { title: sessionId } } }), renderFactorySlot: (name: string, props: any) => {
      if (name !== 'conversation.content' || props.variant !== 'embedded') throw new Error('Unexpected conversation factory contract');
      // A fixture stands in for native DSH chat; Agent edits use the host RPC fixture.
      return h('div', { 'data-native-conversation-fixture': true, style: { flex: 1, minHeight: 0, padding: 12 } }, h('p', null, `DSH 会话 ${sessionId}`), h('textarea', { 'aria-label': 'DSH 助手草稿', defaultValue: '' }));
    }, ...inject() }) : open ? h('div', { 'data-dsh-chat': true }, 'DSH 聊天', h(Open)) : null));
}
const script = document.createElement('script'); script.src = '/client.js'; document.body.appendChild(script);
