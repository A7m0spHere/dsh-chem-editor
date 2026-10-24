import React from 'react';
import { createRoot } from 'react-dom/client';
import { Editor } from 'ketcher-react';
import { createStructServiceProvider } from './adapters/indigo/provider';
import { captureSnapshot as captureKetcherSnapshot, loadMolecule as loadKetcherMolecule, fingerprint, contentFingerprint, rawKetOf, prepareCandidate, stagePatch, stageElement, rollbackAction, checkElement, atomPoint } from './adapters/ketcher';
import { elements } from './contracts/operations';
import { editorChannel } from './contracts/bridge';
import { EditorCommandBridge } from './client/editor-bridge';
import 'ketcher-react/dist/index.css';
import './editor.css';
import { patchSummary } from './chemistry/molecular-patch';
import { fragmentName, fragmentList, fragmentCatalog } from './chemistry/fragment-spec';
import { samples } from './samples';
import { localizeEditor } from './localization';

const provider = createStructServiceProvider();
const elementChoices = elements;
function App() {
  const k = React.useRef<any>();
  const revision = React.useRef(0);
  const [ready, setReady] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [selected, setSelected] = React.useState<any>({ atoms: [], bonds: [] });
  const [version, setVersion] = React.useState(0);
  const [element, setElement] = React.useState('N');
  const [input, setInput] = React.useState('c1ccccc1');
  const [error, setError] = React.useState('');
  const [notice, setNotice] = React.useState('点击画布上的一个原子，再选择元素并替换。');
  const [bridge, setBridge] = React.useState('');
  const [title, setTitle] = React.useState('苯');
  const titleRef = React.useRef('苯');
  const [language, setLanguage] = React.useState('zh-CN');
  const languageRef = React.useRef('zh-CN');
  const [saveStatus, setSaveStatus] = React.useState('正在恢复分子…');
  const [savePath, setSavePath] = React.useState('');
  const [saveConflict, setSaveConflict] = React.useState(false);
  const [saveError, setSaveError] = React.useState('');
  const managed = React.useRef(new URLSearchParams(location.search).get('managed') === '1');
  const epoch = React.useRef('');
  const initialized = React.useRef(false);
  const restoring = React.useRef(false);
  const sequence = React.useRef(0);
  const generation = React.useRef(0);
  const dirty = React.useRef(false);
  const lastContent = React.useRef('');
  const localization = React.useRef<any>();
  const documentId = React.useRef(crypto.randomUUID());
  const publishTimer = React.useRef<any>();
  const dispose = React.useRef<() => void>();
  const selectedRef = React.useRef<any>({ atoms: [], bonds: [] });
  const attachmentRef = React.useRef<number | null>(null);
  const [attachmentAtom, setAttachmentAtom] = React.useState<number | null>(null);
  const [instruction, setInstruction] = React.useState('把选中的碳原子替换为氮原子');
  const [draftMode, setDraftMode] = React.useState(false);
  const [clarification, setClarification] = React.useState('');
  const [annotations, setAnnotations] = React.useState<any[]>([]);
  const [annotationBusy, setAnnotationBusy] = React.useState(false);
  const [preview, setPreview] = React.useState<any>(null);
  const workspace = React.useRef<HTMLDivElement>(null);
  const primaryMode = new URLSearchParams(location.search).get('workspace') === '1';
  const [focused, setFocused] = React.useState(primaryMode);
  const [fullscreen, setFullscreen] = React.useState(false);
  const [wide, setWide] = React.useState(false);
  const [toolsSize, setToolsSize] = React.useState({ height: 0, width: 0 });
  React.useEffect(() => {
    const media = matchMedia('(min-width: 960px)');
    const resize = () => setWide(media.matches);
    const changed = () => setFullscreen(!!document.fullscreenElement);
    resize(); media.addEventListener('change', resize);
    document.addEventListener('fullscreenchange', changed);
    return () => { media.removeEventListener('change', resize); document.removeEventListener('fullscreenchange', changed); };
  }, []);
  React.useEffect(() => { if (preview) setFocused(false); }, [preview]);
  React.useEffect(() => { if (primaryMode && (selected.atoms.length || selected.bonds.length)) setFocused(false); }, [primaryMode, selected]);
  React.useEffect(() => {
    if (!primaryMode || !ready || !k.current) return;
    const editor = k.current.editor;
    let timer: ReturnType<typeof setTimeout>;
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!editor.struct().atoms.size) return;
        editor.render.update();
        // Fit the viewport, without moving atoms or adding an undo operation.
        editor.centerViewportAccordingToStruct();
      }, 300);
    });
    observer.observe(editor.render.clientArea);
    return () => { clearTimeout(timer); observer.disconnect(); };
  }, [primaryMode, ready]);
  function resizeTools(size: number) {
    const rect = workspace.current?.getBoundingClientRect();
    if (!rect) return;
    const length = wide ? rect.width : rect.height;
    const bounded = Math.max(Math.min(wide ? 260 : 140, length * .45), Math.min(size, length * .55));
    setToolsSize(previous => ({ ...previous, [wide ? 'width' : 'height']: bounded }));
  }
  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.querySelector<HTMLElement>('.chem-app')?.requestFullscreen();
    } catch { setError('无法进入全屏，请使用专注绘图或拖宽右侧面板。'); }
  }
  const previewRef = React.useRef<any>(null);
  const previewing = React.useRef('');
  const receipt = React.useRef<string | undefined>();
  const commands = React.useRef(new EditorCommandBridge(value => post(value)));
  const previewUrls = React.useRef<string[]>([]);
  function command(method: string, payload: any) {
    if (!managed.current) return Promise.reject(new Error('请在 DSH 分子面板使用批注。'));
    return commands.current.command(method, payload);
  }
  function clearPreview() { previewRef.current = null; setPreview(null); for (const url of previewUrls.current) URL.revokeObjectURL(url); previewUrls.current = []; }
  function captureSnapshot(withTarget = false) {
    const base = revision.current, edit = generation.current;
    return captureKetcherSnapshot(k.current, { documentId: documentId.current, revision: base, instanceId: epoch.current, selection: selectedRef.current, attachmentAtom: attachmentRef.current, isCurrent: () => base === revision.current && edit === generation.current }, withTarget);
  }
  async function submitAnnotation() {
    setAnnotationBusy(true); setError('');
    try {
      if (dirty.current || saveConflict) throw new Error('请等待保存完成后提交批注。');
      const snapshot = await captureSnapshot(true);
      const result = await command('annotate', { submissionId: crypto.randomUUID(), instruction, snapshot, protocolVersion: draftMode ? 2 : 1 });
      setAnnotations(previous => [...previous.filter(a => a.id !== result.id), result]); setNotice('批注已发送给当前会话的 Agent，请等待预览。');
    } catch (e: any) { setError(e.message); }
    finally { setAnnotationBusy(false); }
  }
  async function preparePreview(record: any) {
    const key = `${record.id}:${record.previewVersion || 0}`;
    if (previewing.current === key || previewRef.current?.id === record.id && previewRef.current?.previewVersion === record.previewVersion) return;
    previewing.current = key; setBusy(true);
    try {
      const a = await command('annotation-detail', { annotationId: record.id });
      const current = k.current, raw = rawKetOf(current);
      if (a.frozen.instanceId !== epoch.current || a.frozen.documentId !== documentId.current || a.frozen.revision !== revision.current || raw !== a.frozen.rawKet) throw new Error('结构已经变化，此批注不能应用。');
      const { candidateKet, existingStereo, before, after } = await prepareCandidate(current, a.frozen, a.patch);
      if (revision.current !== a.frozen.revision || rawKetOf(current) !== a.frozen.rawKet) throw new Error('生成预览期间结构已经变化。');
      if (a.protocolVersion === 2 && record.status === 'validating') {
        const verified = await command('preview', { annotationId: a.id, valid: true, candidateKet, ...draftReceipt(a) });
        setError('');
        if (verified.status !== 'proposed') return;
      }
      clearPreview();
      const urls = [URL.createObjectURL(before), URL.createObjectURL(after)]; previewUrls.current = urls;
      const prepared = { ...a, candidateKet, urls, existingStereo }; previewRef.current = prepared; setPreview(prepared);
      if (a.protocolVersion !== 2 && record.status === 'validating') await command('preview', { annotationId: a.id, valid: true, candidateKet });
    } catch (e: any) {
      setError(e.message);
      if (record.status === 'validating') await command('preview', { annotationId: record.id, valid: false, message: e.message, ...draftReceipt(record) }).catch(() => {});
    } finally { if (previewing.current === key) { previewing.current = ''; setBusy(false); } }
  }
  function draftReceipt(record: any) {
    return record.protocolVersion === 2 ? { previewVersion: record.previewVersion, validationId: record.draftValidation?.id, draftRevision: record.patch?.draftRevision } : {};
  }
  async function applyPreview() {
    const a = previewRef.current; if (!a) return;
    setBusy(true); setError('');
    let action: any;
    try {
      const current = k.current;
      if (revision.current !== a.frozen.revision || rawKetOf(current) !== a.frozen.rawKet) throw new Error('此预览已过期，请重新提交批注。');
      restoring.current = true;
      action = stagePatch(current, a.frozen, a.patch, a.candidateKet);
      const ket = await current.getKet();
      const result = await command('apply', { annotationId: a.id, ...draftReceipt(a), document: { schemaVersion: 1, documentId: documentId.current, revision: a.frozen.revision + 1, title: titleRef.current, language: languageRef.current, ket } });
      current.editor.update(action); action = null;
      revision.current = result.document.revision; setVersion(revision.current); lastContent.current = contentFingerprint(current.editor.struct());
      receipt.current = a.id; dirty.current = false; setSaveStatus('已保存'); setSaveError(''); setSavePath(result.path); post({ type: 'clean' });
      current.editor.selection(a.patch.operation === 'replace_atom' ? { atoms: [a.patch.targetAtom] } : { atoms: [], bonds: [] }); setNotice('修改已应用并保存，可撤销。'); clearPreview();
    } catch (e: any) { if (action) rollbackAction(k.current, action); setError(e.message); }
    finally { restoring.current = false; setBusy(false); selectionChanged(); await publish(); }
  }
  async function cancelAnnotation(id: string) { try { await command('cancel', { annotationId: id }); clearPreview(); setNotice('批注已取消，原结构保持。'); } catch (e: any) { setError(e.message); } }
  async function continueAnnotation(record:any) {
    setAnnotationBusy(true);setError('');
    try {
      const anchor=attachmentRef.current;
      await command('continue-annotation',{annotationId:record.id,userReply:clarification,...(anchor!==null&&record.selection.atoms.includes(anchor)?{attachmentAtom:anchor}:{})});
      setClarification('');setNotice('已发送补充要求，仍使用原批注的连接位置。');
    } catch(e:any){setError(e.message);}finally{setAnnotationBusy(false);}
  }
  function loadMolecule(text: string) { return loadKetcherMolecule(k.current, text); }
  function post(value: any) { if (managed.current) parent.postMessage({ channel: editorChannel, epoch: epoch.current, ...value }, '*'); }
  function documentOf(ket: string) {
    return { schemaVersion: 1, documentId: documentId.current, revision: revision.current, ket, title: titleRef.current, language: languageRef.current, ...(receipt.current ? { lastAppliedAnnotationId: receipt.current } : {}) };
  }
  function markDirty() {
    generation.current += 1; dirty.current = true; setSaveStatus('有未保存的修改');
    // Keep a synchronous draft in the carrier, independently of the debounced export.
    post({ type: 'dirty', generation: generation.current, document: documentOf(rawKetOf(k.current)) });
  }
  function metadata(nextTitle = titleRef.current, nextLanguage = languageRef.current) {
    titleRef.current = nextTitle; setTitle(nextTitle); languageRef.current = nextLanguage; setLanguage(nextLanguage);
    markDirty(); clearTimeout(publishTimer.current); publishTimer.current = setTimeout(() => publish().catch(e => setError(e.message)), 400);
  }
  async function publish(force = false) {
    if (!k.current || !initialized.current || restoring.current) return;
    const base = revision.current, edit = generation.current;
    const snapshot = await captureSnapshot();
    if (base !== revision.current || edit !== generation.current) return;
    const document = documentOf(snapshot.ket);
    const number = ++sequence.current;
    const persist = force || dirty.current;
    post({ type: 'snapshot', snapshot, document, persist, sequence: number, generation: edit });
    if (managed.current && persist) setSaveStatus('正在保存…');
    else if (!managed.current) setSaveStatus('未连接 DSH');
    setBridge(`${snapshot.atoms.length} 个原子 · ${snapshot.bonds.length} 根键`);
  }
  function changed() {
    if (restoring.current || !initialized.current) return;
    const current = contentFingerprint(k.current.editor.struct());
    if (current === lastContent.current) return;
    clearPreview();
    lastContent.current = current;
    revision.current += 1; setVersion(revision.current); selectionChanged();
    markDirty();
    clearTimeout(publishTimer.current);
    publishTimer.current = setTimeout(() => publish().catch(e => setError(e.message)), 300);
  }
  function selectionChanged(value?: any) {
    if (restoring.current) return value;
    const s = k.current?.editor.selection() || {};
    const struct = k.current?.editor.struct();
    const next = { atoms: [...(s.atoms || [])], bonds: [...(s.bonds || [])],
      labels: (s.atoms || []).map((id: number) => ({ id, element: struct?.atoms.get(id)?.label })) };
    const sameAtoms = next.atoms.length === selectedRef.current.atoms.length && next.atoms.every(id => selectedRef.current.atoms.includes(id));
    const anchor = next.atoms.length === 1 ? next.atoms[0] : sameAtoms && next.atoms.includes(attachmentRef.current) ? attachmentRef.current : null;
    attachmentRef.current = anchor; setAttachmentAtom(anchor);
    selectedRef.current = next; setSelected(next);
    clearTimeout(publishTimer.current);
    publishTimer.current = setTimeout(() => publish().catch(e => setError(e.message)), 120);
    return value;
  }
  async function load(text: string, name = '结构') {
    setBusy(true); setError('');
    try {
      let structure = text;
      if (text.trim().startsWith('{')) {
        const data = JSON.parse(text);
        if (data.schemaVersion === 1 && typeof data.ket === 'string') { structure = data.ket; name = typeof data.title === 'string' ? data.title.slice(0, 120) : name; }
      }
      await loadMolecule(structure); k.current.editor.selection(null); metadata(name);
      setNotice(`已载入${name}。选择工具已就绪，请点击一个原子。`); selectionChanged();
    }
    catch (e: any) { setError(`载入失败：${e.message}`); }
    finally { setBusy(false); }
  }
  async function replace() {
    const current = k.current;
    const s = current.editor.selection() || {};
    if (s.atoms?.length !== 1 || (s.bonds?.length || 0) !== 0) { setError('每次替换一个原子，请单击一个原子。'); return; }
    const id = s.atoms[0], base = revision.current;
    const struct = current.editor.struct();
    const atom = struct.atoms.get(id);
    if (!atom) { setError('选区已失效，请重新选择。'); return; }
    if (atom.label === element) { setNotice('所选原子已经是这个元素。'); return; }
    setBusy(true); setError('');
    try {
      await checkElement(current, id, element);
      if (revision.current !== base) throw new Error('检查期间结构已变化，请重新选择。');
      const old = atom.label;
      const action = stageElement(current, id, element, '修改会影响其他结构属性，已还原。请选择普通原子。');
      current.editor.update(action);
      current.editor.selection({ atoms: [id] });
      selectionChanged();
      setNotice(`原子 #${id}：${old} → ${element}。其余原子、键及立体属性保持；可撤销。`);
      await publish();
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }
  async function exportFile(format: 'ket' | 'mol' | 'smiles' | 'project' | 'svg') {
    setError('');
    try {
      const ket = await k.current.getKet();
      const project = { schemaVersion: 1, documentId: documentId.current, revision: revision.current, title: titleRef.current, language: languageRef.current, ket };
      const text = format === 'ket' ? ket : format === 'mol' ? await k.current.getMolfile('v3000') : format === 'project' ? JSON.stringify(project, null, 2) : format === 'svg' ? await k.current.generateImage(ket, { outputFormat: 'svg' }) : await k.current.getSmiles();
      const url = URL.createObjectURL(text instanceof Blob ? text : new Blob([text], { type: 'text/plain' }));
      const link = document.createElement('a'); link.href = url; link.download = `${titleRef.current.replace(/[<>:"/\\|?*]/g, '_') || 'molecule'}-v${revision.current}.${format === 'smiles' ? 'smi' : format === 'project' ? 'chem.json' : format}`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000); setNotice('结构已导出。');
    } catch (e: any) { setError(e.message); }
  }
  React.useEffect(() => {
    localization.current = localizeEditor(document.body, languageRef.current);
    const onMessage = async (event: MessageEvent) => {
      if (event.source !== parent || event.data?.channel !== editorChannel) return;
      const m = event.data;
      if (m.type === 'initialize' && k.current) {
        if (m.epoch === epoch.current) return;
        epoch.current = m.epoch; initialized.current = false; restoring.current = true; setBusy(true); dirty.current = false; sequence.current = 0; generation.current = 0; setSaveConflict(false);
        clearPreview(); receipt.current = m.document?.lastAppliedAnnotationId;
        const doc = m.document;
        try {
          await loadMolecule(doc?.ket || samples.benzene.smiles);
          k.current.editor.clearHistory(); k.current.editor.selection(null);
          documentId.current = doc?.documentId || crypto.randomUUID(); revision.current = doc?.revision || 0; setVersion(revision.current);
          lastContent.current = contentFingerprint(k.current.editor.struct());
          titleRef.current = doc?.title || '苯'; setTitle(titleRef.current);
          languageRef.current = ['en', 'zh-CN'].includes(m.language) ? m.language : doc?.language || 'zh-CN'; setLanguage(languageRef.current);
          initialized.current = true;
          setNotice(doc ? `已恢复「${titleRef.current}」。` : '点击画布上的一个原子，再选择元素并替换。');
          setSaveStatus(doc ? '已保存' : '有未保存的修改'); setError(''); setSaveError('');
          setSavePath(m.path || '');
          if (m.recovering || !doc || doc.language !== languageRef.current) markDirty();
          else post({ type: 'clean' });
        } catch (e: any) { setError(`恢复失败，未覆盖存档：${e.message}`); }
        finally { restoring.current = false; setBusy(false); setReady(initialized.current); selectionChanged(); await publish(); }
        return;
      }
      if (m.epoch !== epoch.current) return;
      if (m.type === 'command-result') {
        commands.current.receive(m);
      }
      if (m.type === 'annotations') {
        setAnnotations(m.records);
        const active = m.records.find((a: any) => ['validating', 'proposed'].includes(a.status) && a.instanceId === epoch.current && a.documentId === documentId.current);
        if (active && active.baseRevision === revision.current) preparePreview(active);
        if (previewRef.current && !m.records.some((a: any) => a.id === previewRef.current.id && a.previewVersion === previewRef.current.previewVersion && ['validating', 'proposed'].includes(a.status))) clearPreview();
      }
      if (m.type === 'saved' && m.sequence === sequence.current && m.generation === generation.current) {
        dirty.current = false; setSaveStatus('已保存'); setSaveError(''); setSavePath(m.path || ''); post({ type: 'clean' });
      }
      if (m.type === 'save-error') { setSaveStatus('保存失败'); setSaveError(m.message || '保存失败，请重试。'); setSaveConflict(m.code === 'save_conflict'); }
      if (m.type === 'save-now') await publish(true);
    };
    window.addEventListener('message', onMessage);
    return () => { clearTimeout(publishTimer.current); dispose.current?.(); localization.current?.dispose(); clearPreview(); commands.current.dispose(); window.removeEventListener('message', onMessage); };
  }, []);
  React.useEffect(() => { localization.current?.setLanguage(language); document.documentElement.lang = language; }, [language]);
  React.useEffect(() => { post({ type: 'working', busy }); }, [busy]);
  const init = React.useCallback(async (instance: any) => {
    k.current = instance;
    (window as any).ketcher = instance;
    // Explicit diagnostic surface: exposes this editor only, never DSH credentials.
    (window as any).chemP0 = { ketcher: instance, fingerprint: () => fingerprint(instance.editor.struct()), revision: () => revision.current,
      atomPoint: (id: number) => atomPoint(instance, id) };
    const change = () => changed();
    const selection = (v: any) => selectionChanged(v);
    const subscription = instance.editor.subscribe('change', change);
    instance.editor.event.selectionChange.add(selection);
    dispose.current = () => { instance.editor.unsubscribe('change', subscription); instance.editor.event.selectionChange.remove(selection); delete (window as any).chemP0; };
    if (managed.current) post({ type: 'ready' });
    else { initialized.current = true; setReady(true); await load(samples.benzene.smiles, '苯'); }
  }, []);
  const buttons = React.useMemo(() => ({ miew: { hidden: true }, recognize: { hidden: true }, about: { hidden: true }, help: { hidden: true }, fullscreen: { hidden: true } }), []);
  const currentAnnotation = [...annotations].reverse().find(a => a.documentId === documentId.current);
  const pendingAnnotation = annotations.some(a => ['submitting', 'queued', 'draft_ready', 'validating', 'proposed', 'needs_clarification'].includes(a.status));
  const resumable = currentAnnotation&&['failed','needs_clarification'].includes(currentAnnotation.status)&&currentAnnotation.instanceId===epoch.current&&currentAnnotation.baseRevision===revision.current;
  const attachmentSelection = resumable?currentAnnotation.selection:selected;
  const processingAnnotation=annotations.some(a=>['submitting','queued','draft_ready','validating','proposed'].includes(a.status));
  const toolsLength = wide ? (toolsSize.width || 320) : (toolsSize.height || (innerHeight <= 650 ? 220 : 230));
  const workspaceLength = wide ? (workspace.current?.clientWidth || innerWidth) : (workspace.current?.clientHeight || innerHeight);
  return <main className={`chem-app${primaryMode ? ' chem-main-mode' : ''}${focused ? ' chem-focused' : ''}`}>
    <header className="chem-header"><div className="chem-heading"><div><strong>分子编辑器</strong><span className="chem-badge" title={bridge}>v0.1</span></div><div className="chem-view-actions"><button aria-pressed={focused} onClick={() => setFocused(value => !value)}>{focused ? '显示操作区' : '专注绘图'}</button><button onClick={toggleFullscreen}>{fullscreen ? '退出全屏' : '全屏编辑'}</button><select aria-label="界面语言" value={language} onChange={e => metadata(titleRef.current, e.target.value)} disabled={!ready || busy}><option value="zh-CN">简体中文</option><option value="en">English</option></select></div></div>{focused && (error || saveError) ? <p className="chem-error" role="alert">{error || saveError}</p> : null}</header>
    <section className="chem-document"><label>文档名称 <input aria-label="文档名称" maxLength={120} value={title} onChange={e => metadata(e.target.value)} disabled={!ready || busy} /></label><span className={saveStatus === '保存失败' ? 'chem-error' : ''} title={savePath} data-save-status>{saveStatus}</span></section>
    <section className="chem-import" aria-label="载入结构"><details className="chem-import-menu"><summary>导入 / 打开</summary><div className="chem-import-panel"><label htmlFor="smiles">导入 SMILES</label><div className="chem-input-row"><input id="smiles" value={input} onChange={e => setInput(e.target.value)} placeholder="粘贴 SMILES" /><button disabled={!ready || busy || !input.trim()} onClick={async e => { const menu = e.currentTarget.closest('details'); await load(input.trim()); if (menu) menu.open = false; }}>载入</button><label className="chem-file">打开 MOL / KET<input type="file" accept=".mol,.ket,.json,.sdf,.smi,.smiles" disabled={!ready || busy} onChange={async e => { const menu = e.currentTarget.closest('details'); const file = e.target.files?.[0]; if (file) await load(await file.text(), file.name); e.target.value = ''; if (menu) menu.open = false; }} /></label></div></div></details>
      <div className="chem-samples"><span>示例</span> {Object.entries(samples).map(([key, sample]) => <button key={key} disabled={!ready || busy} onClick={() => { setInput(sample.smiles); load(sample.smiles, sample.name); }}>{sample.name}</button>)}</div></section>
    <div ref={workspace} className="chem-workspace" style={{ ...(toolsSize.height ? { '--chem-tools-height': `${toolsSize.height}px` } : {}), ...(toolsSize.width ? { '--chem-tools-width': `${toolsSize.width}px` } : {}) } as React.CSSProperties}>
    <div className={`chem-canvas ${busy ? 'chem-busy' : ''}`}><Editor staticResourcesUrl="." structServiceProvider={provider} onInit={init} disableMacromoleculesEditor buttons={buttons} errorHandler={message => setError(message)} /></div>
    <div className="chem-divider" role="separator" aria-label="调整操作区大小" aria-orientation={wide ? 'vertical' : 'horizontal'} aria-valuenow={Math.min(55, Math.round(toolsLength / workspaceLength * 100))} aria-valuemin={0} aria-valuemax={55} tabIndex={0} onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); e.currentTarget.focus(); }} onPointerMove={e => { if (!e.currentTarget.hasPointerCapture(e.pointerId)) return; const rect = workspace.current!.getBoundingClientRect(); resizeTools(wide ? rect.right - e.clientX : rect.bottom - e.clientY); }} onPointerUp={e => { if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); }} onKeyDown={e => { const key = wide ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown']; if (!key.includes(e.key)) return; e.preventDefault(); const rect = workspace.current!.querySelector('.chem-footer')!.getBoundingClientRect(); resizeTools((wide ? rect.width : rect.height) + (e.key === key[0] ? 24 : -24)); }} />
    <div className="chem-footer"><section className="chem-selection" aria-label="选区操作"><div className="chem-selection-info"><strong>{selected.labels?.length ? selected.labels.map((a: any) => `${a.element} #${a.id}`).join('、') : selected.bonds.length ? `已选 ${selected.bonds.length} 根键` : '尚未选择原子'}</strong><span>结构 v{version}</span></div>
      <div className="chem-actions"><label>替换为 <select value={element} onChange={e => setElement(e.target.value)} disabled={busy}>{elementChoices.map(v => <option key={v}>{v}</option>)}</select></label><button className="chem-primary" disabled={!ready || busy || selected.atoms.length !== 1 || selected.bonds.length !== 0} onClick={replace}>替换选中原子</button><button disabled={!ready || busy} onClick={() => { k.current.editor.undo(); selectionChanged(); setNotice('已撤销一步。'); }}>撤销</button><button disabled={!ready || busy} onClick={() => { k.current.editor.redo(); selectionChanged(); setNotice('已重做一步。'); }}>重做</button><details><summary>导出</summary><div>{(['project', 'ket', 'mol', 'smiles', 'svg'] as const).map(v => <button key={v} disabled={!ready || busy} onClick={() => exportFile(v)}>{v === 'project' ? '项目文档' : v.toUpperCase()}</button>)}</div></details><details className="chem-document-actions"><summary>保存与恢复</summary><div><button disabled={!ready || busy || !managed.current || saveConflict} onClick={() => publish(true)}>立即保存</button><button disabled={!ready || busy || !managed.current} onClick={() => { if (!dirty.current || confirm('重新载入将替换当前未保存的画布，请先导出需要保留的结构。是否继续？')) post({ type: 'reload' }); }}>重新载入已保存版本</button></div></details></div>
      <p className={error || saveError ? 'chem-error' : 'chem-notice'} role={error || saveError ? 'alert' : 'status'}>{busy ? '正在处理结构…' : error || saveError || notice}</p></section>
    <section className="chem-annotation" aria-label="Agent 批注">
      <div className="chem-annotation-heading"><label htmlFor="annotation">对选区的批注</label><details className="chem-shortcuts"><summary>快捷批注</summary><div className="chem-actions" aria-label="批注快捷填入">
        {fragmentCatalog().map(({ id }) => <button key={id} disabled={!ready || busy || pendingAnnotation} onClick={() => setInstruction(`添加 ${fragmentName(id)}`)}>{language === 'en' ? `Add ${fragmentName(id, language)}` : `添加 ${fragmentName(id)}`}</button>)}
        {['改成双键', '删除选区'].map(text => <button key={text} disabled={!ready || busy || pendingAnnotation} onClick={() => setInstruction(text)}>{text}</button>)}
      </div></details></div>
      {attachmentSelection.atoms.length > 1 ? <div className="chem-attachment"><label htmlFor="attachment-atom">添加基团的连接原子</label><select id="attachment-atom" value={attachmentAtom ?? ''} disabled={!ready || busy || annotationBusy || processingAnnotation} onChange={e => { const id = e.target.value === '' ? null : Number(e.target.value); attachmentRef.current = id; setAttachmentAtom(id); }}><option value="">请选择连接原子</option>{attachmentSelection.atoms.map((id:number) => <option key={id} value={id}>{attachmentSelection.labels?.find((a:any)=>a.id===id)?.element||''} #{id}</option>)}</select><small>添加基团前指定一个连接点；删除和改键不需要。</small></div> : null}
      <div className="chem-note-row"><textarea id="annotation" maxLength={1000} rows={2} value={instruction} onChange={e => setInstruction(e.target.value)} placeholder="例如：添加正丙基、改成双键、删除选区" /><button disabled={!ready || busy || annotationBusy || pendingAnnotation || !(selected.atoms.length || selected.bonds.length) || dirty.current || !managed.current || !instruction.trim()} onClick={submitAnnotation}>交给 Agent</button></div>
      <label><input type="checkbox" aria-label="草稿模式" checked={draftMode} disabled={pendingAnnotation || annotationBusy} onChange={e=>setDraftMode(e.target.checked)} />{language==='en'?'Draft mode (continue editing newly created fragments)':'草稿模式（连续编辑新建片段）'}</label>
      <small>{language === 'en' ? `Groups: ${fragmentList(language)}. Select one attachment atom; propyl means n-propyl. Preview before applying.` : `可添加 ${fragmentList()}。添加时指定一个连接原子；“丙基”默认正丙基。应用前会显示预览。`}</small>
      {currentAnnotation ? <div className={`chem-note-status${['failed', 'stale'].includes(currentAnnotation.status) ? ' chem-error' : ''}`} role="status" aria-live="polite" data-annotation-id={currentAnnotation.id} data-annotation-status={currentAnnotation.status} data-annotation-error={currentAnnotation.errorCode}><span>{currentAnnotation.message}</span>{['submitting', 'queued', 'draft_ready', 'validating', 'proposed','needs_clarification'].includes(currentAnnotation.status) ? <button disabled={busy} onClick={() => cancelAnnotation(currentAnnotation.id)}>取消批注</button> : null}</div> : null}
      {resumable ? <div className="chem-clarification"><label htmlFor="clarification">补充修改要求</label><small>可在 DSH 聊天中补充，或在这里继续。仍使用原批注的冻结选区。</small><div className="chem-note-row"><textarea id="clarification" maxLength={1000} rows={2} value={clarification} onChange={e=>setClarification(e.target.value)} /><button disabled={busy||annotationBusy||dirty.current||saveConflict||!clarification.trim()} onClick={()=>continueAnnotation(currentAnnotation)}>继续批注</button></div></div> : null}
      {preview && currentAnnotation?.status === 'proposed' ? <div className="chem-preview" data-preview-id={preview.id} data-preview-version={preview.previewVersion}><div><strong>{patchSummary(preview.patch, language)}</strong><span>冻结结构 v{preview.frozen.revision}</span></div><p>{preview.patch.reason}</p>{['batch','draft'].includes(preview.patch.operation)?<p className="chem-plan-complete">{language==='en'?`All ${preview.patch.edits.length} steps will be applied and undone together.`:`全部 ${preview.patch.edits.length} 步一起应用，一步撤销。`}</p>:null}{preview.existingStereo ? <p>原结构已有立体提示（保持原状）：{preview.existingStereo}</p> : null}<div className="chem-preview-grid"><figure><img src={preview.urls[0]} alt="修改前结构" /><figcaption>修改前</figcaption></figure><figure><img src={preview.urls[1]} alt="修改后预览" /><figcaption>修改后预览</figcaption></figure></div><button className="chem-primary" disabled={busy || saveConflict} onClick={applyPreview}>应用修改</button><button disabled={busy} onClick={() => cancelAnnotation(preview.id)}>取消批注</button></div> : null}
    </section></div></div>
  </main>;
}
createRoot(document.getElementById('root')!).render(<App />);
