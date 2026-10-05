import React from 'react';
export const inject = ['slots', 'connection', 'sidebarRight', 'sidebarRightTabs'];
const ID = 'dsh-chem-editor';
const h = React.createElement;
function Icon() { return h('svg', { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 }, h('path', { d: 'M12 2 21 7v10l-9 5-9-5V7l9-5ZM12 6l5 3v6l-5 3-5-3V9l5-3Z' })); }
function Body({ useTabInfo, sessionId, connection, guards }: any) {
  const { tab } = useTabInfo();
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
      const r = await connection.rpc.call('/api', 'chem-editor/bootstrap', { sessionId });
      if (!r.ok) throw new Error(r.error.message);
      boot.current = r.value; epoch.current = crypto.randomUUID(); conflict.current = false; setError('');
      if (!url) setUrl(r.value.url);
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
        send({ type: 'initialize', epoch: epoch.current, document: boot.current.document, path: boot.current.path, language: language() });
        return;
      }
      if (m.epoch !== epoch.current) return;
      if (m.type === 'command' && ['annotate', 'annotation-detail', 'preview', 'apply', 'cancel'].includes(m.method)) {
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
      if (m.type === 'dirty') { dirty.current = true; setStatus('有未保存的修改'); return; }
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
    return () => { clearInterval(timer); window.removeEventListener('message', onMessage); connection.rpc.call('/api', 'chem-editor/detach', { sessionId, instanceId: epoch.current }).catch(() => {}); };
  }, [url, connection, sessionId]);
  return h('div', { style: { height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }, 'data-chem-editor': true },
    h('div', { style: { padding: '8px 14px', fontSize: 12, color: error ? '#b33434' : 'var(--dsw-alias-label-secondary)', display: 'flex', justifyContent: 'space-between' } },
      h('span', null, error || status), error && !url ? h('button', { onClick: () => bootstrap() }, '重试') : null),
    url ? h('iframe', { ref: frame, title: '分子编辑器', src: url, style: { border: 0, width: '100%', flex: 1, minHeight: 0 } }) : null);
}
export function apply(ctx: any) {
  const guards = new Map();
  const definition = { id: ID, kind: 'chem-editor', title: () => '分子编辑器', keepMounted: true,
    guide: [{ id: 'chem-editor', title: () => '分子编辑器', description: () => '编辑分子、自动保存、中文界面' }] };
  ctx.effect(() => ctx.sidebarRightTabs.register(definition));
  ctx.effect(() => ctx.sidebarRight.registerCloseHandler('chem-editor', (sessionId: string, tab: any) => guards.get(`${sessionId}/${tab.id}`)?.()));
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: ID, inject: () => ({ connection: ctx.connection, guards }) }, Body));
  function Open() { return h('button', { title: '打开分子编辑器', onClick: () => ctx.sidebarRight.openTab('chem-editor'), style: { border: 0, background: 'transparent', color: 'inherit', cursor: 'pointer', padding: '4px 6px', display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12 }, 'aria-label': '打开分子编辑器' }, h(Icon), '分子'); }
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({ name: 'conversation.session.header.actions', id: ID, order: 10 }, Open));
}
