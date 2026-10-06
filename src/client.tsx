import React from 'react';
export const inject = ['slots', 'connection', 'layout', 'sidebarRight', 'sidebarRightTabs'];
const ID = 'dsh-chem-editor';
const h = React.createElement;
type Draft = { document: any; generation: number; token: string | null };
type WorkspaceCarry = { drafts: Map<string, Draft>; pending: Map<string, Promise<unknown>> };
function Icon() { return h('svg', { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 }, h('path', { d: 'M12 2 21 7v10l-9 5-9-5V7l9-5ZM12 6l5 3v6l-5 3-5-3V9l5-3Z' })); }
function Body({ useTabInfo, sessionId, connection, guards, carry, workspaceMode = false }: any) {
  const tab = useTabInfo ? useTabInfo().tab : { id: 'workspace' };
  const frame = React.useRef<HTMLIFrameElement>(null);
  const [url, setUrl] = React.useState('');
  const [error, setError] = React.useState('');
  const [status, setStatus] = React.useState('正在准备编辑器…');
  const boot = React.useRef<any>();
  const dirty = React.useRef(false);
  const working = React.useRef(false);
  const loading = React.useRef(false);
  const epoch = React.useRef(crypto.randomUUID());
  const serial = React.useRef(Promise.resolve());
  const conflict = React.useRef(false);
  const language = () => { try { return localStorage.getItem('chem-editor.language.v1') || 'zh-CN'; } catch { return 'zh-CN'; } };
  function send(value: any) { if (url) frame.current?.contentWindow?.postMessage({ channel: ID, ...value }, new URL(url).origin); }
  async function bootstrap(reload = false) {
    loading.current = true;
    try {
      await carry.pending.get(sessionId)?.catch(() => {});
      const r = await connection.rpc.call('/api', 'chem-editor/bootstrap', { sessionId });
      if (!r.ok) throw new Error(r.error.message);
      boot.current = r.value; epoch.current = crypto.randomUUID(); conflict.current = false; setError('');
      if (reload) carry.drafts.delete(sessionId);
      else {
        const draft = carry.drafts.get(sessionId);
        if (draft) boot.current = { ...r.value, document: draft.document, token: draft.token, recovering: true };
      }
      if (!url) {
        const editorUrl = new URL(r.value.url);
        if (workspaceMode) editorUrl.searchParams.set('workspace', '1');
        setUrl(editorUrl.href);
      }
      else if (reload) send({ type: 'initialize', epoch: epoch.current, document: r.value.document, path: r.value.path, language: language() });
    } catch (e: any) { setError(e.message); } finally { loading.current = false; }
  }
  React.useEffect(() => { bootstrap(); }, [sessionId, connection]);
  React.useEffect(() => {
    const key = `${sessionId}/${tab.id}`;
    guards.set(key, () => {
      if (dirty.current || working.current) {
        send({ type: 'save-now' });
        setError('正在保存或还有未保存的修改，请保存完成后再关闭。');
        throw new Error('chem-editor: unsaved changes');
      }
    });
    return () => { guards.delete(key); };
  }, [guards, sessionId, tab.id, url]);
  React.useEffect(() => {
    if (!url) return;
    const origin = new URL(url).origin;
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow || e.origin !== origin || e.data?.channel !== ID) return;
      const m = e.data;
      if (m.type === 'ready' && boot.current) {
        send({ type: 'initialize', epoch: epoch.current, document: boot.current.document, path: boot.current.path, language: boot.current.recovering ? boot.current.document.language : language(), recovering: boot.current.recovering });
        return;
      }
      if (m.epoch !== epoch.current) return;
      if (m.type === 'command' && ['annotate', 'continue-annotation', 'annotation-detail', 'preview', 'apply', 'cancel'].includes(m.method)) {
        const captured = epoch.current;
        serial.current = serial.current.catch(() => {}).then(async () => {
          if (captured !== epoch.current) return;
          try {
            const payload = { ...m.payload, sessionId, instanceId: captured, ...(m.method === 'annotate' ? { baseToken: boot.current.token } : {}) };
            const r = await connection.rpc.call('/api', `chem-editor/${m.method}`, payload);
            if (!r.ok) throw r.error;
            if (m.method === 'apply') { boot.current.document = r.value.document; boot.current.token = r.value.token; conflict.current = false; }
            send({ type: 'command-result', epoch: captured, requestId: m.requestId, value: r.value });
          } catch (err: any) { send({ type: 'command-result', epoch: captured, requestId: m.requestId, error: { code: err.code, message: err.message || '批注操作失败。' } }); }
        });
        return;
      }
      if (m.type === 'dirty') {
        dirty.current = true; setStatus('有未保存的修改');
        if (m.document) carry.drafts.set(sessionId, { document: m.document, generation: m.generation, token: boot.current.token });
        return;
      }
      if (m.type === 'working') { working.current = m.busy === true; return; }
      if (m.type === 'reload') { if (!working.current && !loading.current) serial.current.finally(() => bootstrap(true)); return; }
      if (m.type === 'snapshot') {
        if (m.persist) { dirty.current = true; setStatus('正在保存…'); }
        const capturedEpoch = epoch.current;
        serial.current = serial.current.catch(() => {}).then(async () => {
          if (capturedEpoch !== epoch.current || conflict.current) return;
          try {
            const s = await connection.rpc.call('/api', 'chem-editor/snapshot', { sessionId, snapshot: m.snapshot });
            if (!s.ok) throw s.error;
            if (!m.persist) return;
            const r = await connection.rpc.call('/api', 'chem-editor/save', { sessionId, document: m.document, baseToken: boot.current.token });
            if (!r.ok) throw r.error;
            boot.current.token = r.value.token; boot.current.document = r.value.document;
            const draft = carry.drafts.get(sessionId);
            if (draft?.generation === m.generation) carry.drafts.delete(sessionId);
            else if (draft) draft.token = r.value.token;
            send({ type: 'saved', epoch: capturedEpoch, sequence: m.sequence, generation: m.generation, savedAt: r.value.document.savedAt, path: r.value.path });
            try { localStorage.setItem('chem-editor.language.v1', m.document.language); } catch {}
          } catch (err: any) {
            if (err.code === 'save_conflict') conflict.current = true;
            setError(err.message || '保存失败，请重试。');
            send({ type: 'save-error', epoch: capturedEpoch, sequence: m.sequence, code: err.code, message: err.message });
          }
        });
      }
      if (m.type === 'clean') { dirty.current = false; setError(''); setStatus(`已保存 · ${new Date(boot.current.document.savedAt).toLocaleTimeString('zh-CN')}`); }
    };
    window.addEventListener('message', onMessage);
    let reading = false;
    const poll = async () => {
      if (reading || !boot.current) return; reading = true;
      try { const r = await connection.rpc.call('/api', 'chem-editor/annotations', { sessionId }); if (r.ok) send({ type: 'annotations', epoch: epoch.current, records: r.value }); }
      catch { /* The editor retains its current batch while the carrier reconnects. */ }
      finally { reading = false; }
    };
    const timer = setInterval(poll, 900); poll();
    return () => {
      clearInterval(timer); window.removeEventListener('message', onMessage);
      const closingEpoch = epoch.current;
      // Main-panel navigation can unmount without invoking the explicit close guard.
      // Finish queued writes, then save the latest synchronous draft before detach.
      const closing = serial.current.catch(() => {}).then(async () => {
        const draft: Draft | undefined = carry.drafts.get(sessionId);
        if (!draft || conflict.current) return;
        const r = await connection.rpc.call('/api', 'chem-editor/save', { sessionId, document: draft.document, baseToken: boot.current.token });
        if (!r.ok) throw r.error;
        if (carry.drafts.get(sessionId) === draft) carry.drafts.delete(sessionId);
        try { localStorage.setItem('chem-editor.language.v1', draft.document.language); } catch {}
      }).finally(() => connection.rpc.call('/api', 'chem-editor/detach', { sessionId, instanceId: closingEpoch }).catch(() => {}));
      carry.pending.set(sessionId, closing);
      closing.finally(() => { if (carry.pending.get(sessionId) === closing) carry.pending.delete(sessionId); }).catch(() => {});
    };
  }, [url, connection, sessionId]);
  return h('div', { style: { height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }, 'data-chem-editor': true },
    !url || error ? h('div', { style: { padding: '8px 14px', fontSize: 12, color: error ? '#b33434' : 'var(--dsw-alias-label-secondary)', display: 'flex', justifyContent: 'space-between' } },
      h('span', null, error || status), error && !url ? h('button', { onClick: () => bootstrap() }, '重试') : null) : null,
    url ? h('iframe', { ref: frame, title: '分子编辑器', src: url, allow: 'fullscreen', allowFullScreen: true, style: { border: 0, width: '100%', flex: 1, minHeight: 0 } }) : null);
}
const workspaceCss = `
.chem-host-workspace{height:100%;min-height:0;display:flex;flex-direction:column;container-type:inline-size;background:var(--dsw-specific-ground,#fff);color:var(--dsw-alias-label-primary,#253044)}
.chem-host-heading{display:flex;align-items:center;gap:10px;padding:8px 14px;flex:none;border-bottom:1px solid var(--dsw-alias-border-l1,#e5e9f0)}
.chem-host-heading strong{font-size:14px}.chem-host-heading span{font-size:12px;color:var(--dsw-alias-label-secondary,#687487);margin-right:auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chem-host-workspace :is(.chem-host-heading,.chem-host-assistant-heading)>button{font:inherit;font-size:12px;padding:5px 9px;border:1px solid var(--dsw-alias-border-l1,#dce1e9);border-radius:6px;background:transparent;color:inherit;cursor:pointer;white-space:nowrap}
.chem-host-workspace :is(.chem-host-heading,.chem-host-assistant-heading)>button:hover{background:var(--dsw-alias-interactive-bg-hover,#f1f5fb)}.chem-host-workspace :is(.chem-host-heading,.chem-host-assistant-heading)>button:focus-visible{outline:2px solid #477ce3;outline-offset:2px}
.chem-host-content{flex:1;min-height:0;min-width:0;position:relative;display:grid;grid-template-columns:minmax(0,1fr)}
.chem-host-content[data-assistant-open=true]{grid-template-columns:minmax(0,1fr) minmax(300px,min(32%,380px))}
.chem-host-editor{min-height:0;min-width:0;overflow:hidden}
.chem-host-assistant{min-height:0;min-width:0;display:flex;flex-direction:column;overflow:hidden;border-left:1px solid var(--dsw-alias-border-l1,#e5e9f0);background:var(--dsw-specific-ground,#fff)}
.chem-host-assistant[hidden]{display:none}.chem-host-assistant-heading{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 12px;flex:none;border-bottom:1px solid var(--dsw-alias-border-l1,#e5e9f0);font-size:13px}
.chem-host-assistant [data-composer-seat]{margin-top:auto}
@container(max-width:900px){.chem-host-content[data-assistant-open=true]{grid-template-columns:minmax(0,1fr)}.chem-host-assistant{position:absolute;inset:0 0 0 auto;width:min(380px,100%);z-index:60;box-shadow:-8px 0 24px #25304422}.chem-host-heading{flex-wrap:wrap;padding:7px 10px}}
`;
function WorkspaceSession({ sessionId, connection, guards, carry, layout, renderFactorySlot, useSessions }: any) {
  const [assistantOpen, setAssistantOpen] = React.useState(false);
  const title = useSessions((s: any) => s.byId[sessionId]?.title);
  if (!sessionId) return h('div', { style: { padding: 24 } }, '请先选择一个 DSH 会话，再打开分子工作区。');
  const leave = () => {
    try { guards.get(`${sessionId}/workspace`)?.(); layout.selectPanel(null); }
    catch { /* The editor displays the save status and keeps this workspace open. */ }
  };
  return h('div', { className: 'chem-host-workspace', 'data-chem-workspace': true },
    h('style', null, workspaceCss),
    h('header', { className: 'chem-host-heading' }, h(Icon), h('strong', null, '分子工作区'), h('span', { title }, title || '当前会话'),
      h('button', { 'aria-expanded': assistantOpen, onClick: () => setAssistantOpen(v => !v) }, assistantOpen ? '收起 DSH 助手' : 'DSH 助手'),
      h('button', { onClick: leave }, '返回 DSH 聊天')),
    h('div', { className: 'chem-host-content', 'data-assistant-open': assistantOpen },
      h('div', { className: 'chem-host-editor' }, h(Body, { key: sessionId, sessionId, connection, guards, carry, workspaceMode: true })),
      h('aside', { className: 'chem-host-assistant', hidden: !assistantOpen, 'aria-label': 'DSH 助手' },
        h('div', { className: 'chem-host-assistant-heading' }, h('strong', null, 'DSH 助手'), h('button', { onClick: () => setAssistantOpen(false) }, '收起助手')),
        renderFactorySlot('conversation.content', { variant: 'embedded', phase: 'active', hero: false }))));
}
function Workspace({ renderSlot }: any) { return renderSlot('chem.workspace.session', {}); }
export function apply(ctx: any) {
  const guards = new Map();
  const carry: WorkspaceCarry = { drafts: new Map(), pending: new Map() };
  const definition = { id: ID, kind: 'chem-editor', title: () => '分子工作区', keepMounted: true,
    guide: [{ id: 'chem-editor', title: () => '分子工作区', description: () => '以分子画布为主，DSH 助手按需展开' }] };
  ctx.effect(() => ctx.sidebarRightTabs.register(definition));
  ctx.effect(() => ctx.sidebarRight.registerCloseHandler('chem-editor', (sessionId: string, tab: any) => guards.get(`${sessionId}/${tab.id}`)?.()));
  ctx.slots.inject('main', function* () {
    yield ctx.slots.register({ name: 'main', key: ID, children: { 'chem.workspace.session': { kind: 'single', scope: 'session-maybe' } } }, Workspace);
    yield ctx.slots.register({ name: 'chem.workspace.session', inject: () => ({ connection: ctx.connection, guards, carry, layout: ctx.layout }) }, WorkspaceSession);
  });
  function Open() { return h('button', { title: '打开分子工作区', onClick: () => ctx.layout.selectPanel(ID), style: { border: 0, background: 'transparent', color: 'inherit', cursor: 'pointer', padding: '4px 6px', display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12 }, 'aria-label': '打开分子工作区' }, h(Icon), '分子'); }
  function SidebarEntry() { return h('div', { style: { padding: 20 } }, h('p', null, '分子画布已移到主工作区，DSH 助手可按需展开。'), h(Open)); }
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: ID }, SidebarEntry));
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: ID, order: 15, label: '分子工作区' }, Icon));
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({ name: 'conversation.session.header.actions', id: ID, order: 10 }, Open));
}
