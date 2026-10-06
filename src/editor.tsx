import React from 'react';
import { createRoot } from 'react-dom/client';
import { Editor } from 'ketcher-react';
import { StandaloneStructServiceProvider } from 'ketcher-standalone';
import { fromAtomsAttrs, fromNewCanvas, Coordinates, KetcherAsyncEvents, KetSerializer } from 'ketcher-core';
import 'ketcher-react/dist/index.css';
import './editor.css';
import { executePatch, verifyMolecularPatch, patchSummary } from './molecular-patch';
import { fragments, fragmentName, fragmentList } from './fragments';
import { samples } from './samples';
import { localizeEditor } from './localization';

const provider = new StandaloneStructServiceProvider();
const elementChoices = ['C', 'N', 'O', 'S', 'P', 'F', 'Cl', 'Br', 'I'];
const propsOf = (obj: any) => Object.fromEntries(Object.entries(obj).filter(([k, v]) => !['implicitH', 'implicitHCount', 'neighbors', 'badConn', 'valence', 'hasImplicitH'].includes(k) && typeof v !== 'function'));
function fingerprint(struct: any) {
  const atoms: any[] = [], bonds: any[] = [];
  struct.atoms.forEach((a: any, id: number) => atoms.push([id, propsOf(a)]));
  struct.bonds.forEach((b: any, id: number) => bonds.push([id, { ...b }]));
  return { atoms, bonds };
}
function contentFingerprint(struct: any) {
  // Serialize document content, including text and drawing objects, rather than
  // comparing transient renderer fields such as bond lengths and hitboxes.
  const data = JSON.parse(new KetSerializer().serializeMicromolecules(struct));
  const molecules = Object.values(data).filter((v: any) => Array.isArray(v?.atoms)) as any[];
  const origin = molecules[0]?.atoms[0]?.location || [0, 0, 0];
  for (const molecule of molecules) for (const atom of molecule.atoms) if (atom.location) atom.location = atom.location.map((n: number, i: number) => Math.round((n - (origin[i] || 0)) * 100000) / 100000);
  return JSON.stringify(data);
}
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
  const requests = React.useRef(new Map<string, any>());
  const previewUrls = React.useRef<string[]>([]);
  function command(method: string, payload: any) {
    if (!managed.current) return Promise.reject(new Error('请在 DSH 分子面板使用批注。'));
    const requestId = crypto.randomUUID();
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => { requests.current.delete(requestId); reject(new Error('批注通信超时，请查看聊天和当前批注状态。')); }, 45000);
      requests.current.set(requestId, { resolve, reject, timer }); post({ type: 'command', method, payload, requestId });
    });
  }
  function clearPreview() { previewRef.current = null; setPreview(null); for (const url of previewUrls.current) URL.revokeObjectURL(url); previewUrls.current = []; }
  async function captureSnapshot(withTarget = false) {
    const base = revision.current, edit = generation.current, frozenSelection = structuredClone(selectedRef.current);
    const frozenAttachment = attachmentRef.current;
    const ket = await k.current.getKet();
    if (base !== revision.current || edit !== generation.current) throw new Error('结构正在变化，请重新选择。');
    const struct = k.current.editor.struct(), atoms: any[] = [], bonds: any[] = [];
    struct.atoms.forEach((a: any, id: number) => atoms.push({ id, element: a.label, charge: a.charge, isotope: a.isotope, implicitHydrogens: a.implicitH }));
    struct.bonds.forEach((b: any, id: number) => bonds.push({ id, begin: b.begin, end: b.end, type: b.type, stereo: b.stereo }));
    const serializer = new KetSerializer(), rawKet = serializer.serializeMicromolecules(struct);
    let targetAddress: any, atomAddresses: any, bondAddresses: any, aromaticBonds: number[] = [];
    if (withTarget) {
      const s = frozenSelection;
      if (!(s.atoms.length || s.bonds.length) || struct.sgroups.size || struct.rgroups.size) throw new Error('请选择普通原子、键或框选局部片段。');
      // AAM tagging is applied to a clone only, never to the user's molecule.
      const clone = struct.clone(); clone.atoms.forEach((a: any,id: number) => { a.aam = id + 1; });
      const tagged = JSON.parse(serializer.serializeMicromolecules(clone)), original = JSON.parse(rawKet);
      atomAddresses = {}; bondAddresses = {};
      for (const [molecule, data] of Object.entries(tagged) as any) if (Array.isArray(data?.atoms)) data.atoms.forEach((a: any,index: number) => { atomAddresses[a.mapping - 1] = { molecule, index }; });
      for (const b of bonds) {
        const begin = atomAddresses[b.begin], end = atomAddresses[b.end];
        const index = original[begin.molecule]?.bonds?.findIndex((x: any) => x.atoms[0] === begin.index && x.atoms[1] === end.index);
        if (begin.molecule !== end.molecule || index < 0) throw new Error('无法映射所选键，请重新选择。');
        bondAddresses[b.id] = {molecule: begin.molecule,index};
      }
      if (s.atoms.length === 1) targetAddress = atomAddresses[s.atoms[0]];
      // Indigo identifies aromatic bonds even when Ketcher renders Kekulé bonds.
      // Map by preserved coordinates instead of assuming exported IDs are stable.
      const aromatic = await k.current.indigo.aromatize(struct.clone());
      aromatic.bonds.forEach((b: any) => {
        if (b.type !== 4) return;
        const a = aromatic.atoms.get(b.begin).pp, c = aromatic.atoms.get(b.end).pp;
        const match = bonds.find((v: any) => {
          const p = struct.atoms.get(v.begin).pp, q = struct.atoms.get(v.end).pp;
          const near = (x: any,y: any) => Math.hypot(x.x-y.x,x.y-y.y) < 0.00001;
          return near(a,p) && near(c,q) || near(a,q) && near(c,p);
        });
        if (!match) throw new Error('无法映射芳香键，请重新选择。'); aromaticBonds.push(match.id);
      });
      if (base !== revision.current || edit !== generation.current) throw new Error('结构正在变化，请重新选择。');
    }
    return { documentId: documentId.current, revision: base, ket, rawKet, atoms, bonds, selection: frozenSelection, instanceId: epoch.current, ...(frozenAttachment !== null ? { attachmentAtom: frozenAttachment } : {}), ...(atomAddresses ? { atomAddresses, bondAddresses, targetAddress, aromaticBonds } : {}) };
  }
  async function submitAnnotation() {
    setAnnotationBusy(true); setError('');
    try {
      if (dirty.current || saveConflict) throw new Error('请等待保存完成后提交批注。');
      const snapshot = await captureSnapshot(true);
      const result = await command('annotate', { submissionId: crypto.randomUUID(), instruction, snapshot });
      setAnnotations(previous => [...previous.filter(a => a.id !== result.id), result]); setNotice('批注已发送给当前会话的 Agent，请等待预览。');
    } catch (e: any) { setError(e.message); }
    finally { setAnnotationBusy(false); }
  }
  async function preparePreview(record: any) {
    if (previewing.current === record.id || previewRef.current?.id === record.id) return;
    previewing.current = record.id; setBusy(true);
    try {
      const a = await command('annotation-detail', { annotationId: record.id });
      const current = k.current, raw = new KetSerializer().serializeMicromolecules(current.editor.struct());
      if (a.frozen.instanceId !== epoch.current || a.frozen.documentId !== documentId.current || a.frozen.revision !== revision.current || raw !== a.frozen.rawKet) throw new Error('结构已经变化，此批注不能应用。');
      const serializer = new KetSerializer();
      const candidate = a.patch.operation === 'replace_atom' ? current.editor.struct().clone() : serializer.deserializeToStruct(executePatch(a.frozen, a.patch).ket);
      if (a.patch.operation === 'replace_atom') candidate.atoms.get(a.patch.targetAtom).label = a.patch.element;
      const checks = await current.indigo.check(candidate, { types: ['valence', 'query', 'pseudoatoms', 'radicals', 'stereo'] });
      const originalChecks = await current.indigo.check(current.editor.struct(), { types: ['stereo'] });
      // A pre-existing diagnostic is retained visibly, rather than preventing an
      // unrelated edit or silently changing the original stereo configuration.
      const existingStereo = checks.stereo && checks.stereo === originalChecks.stereo ? checks.stereo : '';
      if (existingStereo) delete checks.stereo;
      if (Object.values(checks).some(v => typeof v === 'string' && v.trim())) throw new Error(`结构检查未通过：${JSON.stringify(checks)}`);
      const candidateKet = serializer.serializeMicromolecules(candidate);
      if (a.patch.operation !== 'replace_atom') verifyMolecularPatch(a.frozen, a.patch, candidateKet);
      const before = await current.generateImage(a.frozen.rawKet, { outputFormat: 'svg' });
      const after = await current.generateImage(candidateKet, { outputFormat: 'svg' });
      if (revision.current !== a.frozen.revision || new KetSerializer().serializeMicromolecules(current.editor.struct()) !== a.frozen.rawKet) throw new Error('生成预览期间结构已经变化。');
      clearPreview();
      const urls = [URL.createObjectURL(before), URL.createObjectURL(after)]; previewUrls.current = urls;
      const prepared = { ...a, candidateKet, urls, existingStereo }; previewRef.current = prepared; setPreview(prepared);
      if (record.status === 'validating') await command('preview', { annotationId: a.id, valid: true, candidateKet });
    } catch (e: any) {
      setError(e.message);
      if (record.status === 'validating') await command('preview', { annotationId: record.id, valid: false, message: e.message }).catch(() => {});
    } finally { previewing.current = ''; setBusy(false); }
  }
  async function applyPreview() {
    const a = previewRef.current; if (!a) return;
    setBusy(true); setError('');
    let action: any;
    try {
      const current = k.current;
      if (revision.current !== a.frozen.revision || new KetSerializer().serializeMicromolecules(current.editor.struct()) !== a.frozen.rawKet) throw new Error('此预览已过期，请重新提交批注。');
      restoring.current = true;
      if (a.patch.operation === 'replace_atom') {
        const before = fingerprint(current.editor.struct());
        action = fromAtomsAttrs(current.editor.render.ctab, a.patch.targetAtom, { label: a.patch.element }, false);
        const expected = structuredClone(before); expected.atoms.find(([id]: any) => id === a.patch.targetAtom)[1].label = a.patch.element;
        if (JSON.stringify(fingerprint(current.editor.struct())) !== JSON.stringify(expected)) throw new Error('修改会影响其他结构属性，已拒绝。');
      } else {
        action = fromNewCanvas(current.editor.render.ctab, new KetSerializer().deserializeToStruct(a.candidateKet));
        verifyMolecularPatch(a.frozen, a.patch, new KetSerializer().serializeMicromolecules(current.editor.struct()));
      }
      const ket = await current.getKet();
      const result = await command('apply', { annotationId: a.id, document: { schemaVersion: 1, documentId: documentId.current, revision: a.frozen.revision + 1, title: titleRef.current, language: languageRef.current, ket } });
      current.editor.update(action); action = null;
      revision.current = result.document.revision; setVersion(revision.current); lastContent.current = contentFingerprint(current.editor.struct());
      receipt.current = a.id; dirty.current = false; setSaveStatus('已保存'); setSaveError(''); setSavePath(result.path); post({ type: 'clean' });
      current.editor.selection(a.patch.operation === 'replace_atom' ? { atoms: [a.patch.targetAtom] } : { atoms: [], bonds: [] }); setNotice('修改已应用并保存，可撤销。'); clearPreview();
    } catch (e: any) { if (action) { action.perform(k.current.editor.render.ctab); k.current.editor.update(true); } setError(e.message); }
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
  function loadMolecule(text: string) {
    // In 3.7.0 setMolecule resolves before runAsyncAction has filled the canvas.
    // Wait for that editor instance's completion event instead of its early promise.
    return new Promise<void>((resolve, reject) => {
      const instance = k.current;
      const cleanup = () => { clearTimeout(timeout); instance.eventBus.removeListener(KetcherAsyncEvents.SUCCESS, success); instance.eventBus.removeListener(KetcherAsyncEvents.FAILURE, failure); };
      const success = () => { cleanup(); resolve(); };
      const failure = () => { cleanup(); reject(new Error('结构载入失败，请检查分子格式。')); };
      const timeout = setTimeout(() => { cleanup(); reject(new Error('载入超时，请重新打开编辑器后重试。')); }, 30000);
      instance.eventBus.once(KetcherAsyncEvents.SUCCESS, success); instance.eventBus.once(KetcherAsyncEvents.FAILURE, failure);
      instance.setMolecule(text).catch((e: Error) => { cleanup(); reject(e); });
    });
  }
  function post(value: any) { if (managed.current) parent.postMessage({ channel: 'dsh-chem-editor', epoch: epoch.current, ...value }, '*'); }
  function documentOf(ket: string) {
    return { schemaVersion: 1, documentId: documentId.current, revision: revision.current, ket, title: titleRef.current, language: languageRef.current, ...(receipt.current ? { lastAppliedAnnotationId: receipt.current } : {}) };
  }
  function markDirty() {
    generation.current += 1; dirty.current = true; setSaveStatus('有未保存的修改');
    // Keep a synchronous draft in the carrier, independently of the debounced export.
    post({ type: 'dirty', generation: generation.current, document: documentOf(new KetSerializer().serializeMicromolecules(k.current.editor.struct())) });
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
      if (struct.sgroups.size || struct.rgroups.size) throw new Error('暂不支持 S-group / R-group 内的替换。');
      const candidate = struct.clone(); candidate.atoms.get(id).label = element;
      const checks = await current.indigo.check(candidate, { types: ['valence', 'query', 'pseudoatoms', 'radicals'] });
      if (Object.values(checks).some(v => typeof v === 'string' && v.trim())) throw new Error(`结构检查未通过：${JSON.stringify(checks)}`);
      if (revision.current !== base) throw new Error('检查期间结构已变化，请重新选择。');
      const before = fingerprint(struct);
      const old = atom.label;
      // Ketcher's builder performs the operations and returns their inverse.
      const action = fromAtomsAttrs(current.editor.render.ctab, id, { label: element }, false);
      const after = fingerprint(current.editor.struct());
      const expected = structuredClone(before);
      expected.atoms.find(([aid]: any) => aid === id)[1].label = element;
      // Atom lists may be cleared by the official element action; these are excluded above by rejecting query structures.
      if (JSON.stringify(after) !== JSON.stringify(expected)) {
        action.perform(current.editor.render.ctab); current.editor.update(true);
        throw new Error('修改会影响其他结构属性，已还原。请选择普通原子。');
      }
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
      if (event.source !== parent || event.data?.channel !== 'dsh-chem-editor') return;
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
        const request = requests.current.get(m.requestId);
        if (request) { clearTimeout(request.timer); requests.current.delete(m.requestId); m.error ? request.reject(Object.assign(new Error(m.error.message), { code: m.error.code })) : request.resolve(m.value); }
      }
      if (m.type === 'annotations') {
        setAnnotations(m.records);
        const active = m.records.find((a: any) => ['validating', 'proposed'].includes(a.status) && a.instanceId === epoch.current && a.documentId === documentId.current);
        if (active && active.baseRevision === revision.current) preparePreview(active);
        if (previewRef.current && !m.records.some((a: any) => a.id === previewRef.current.id && ['validating', 'proposed'].includes(a.status))) clearPreview();
      }
      if (m.type === 'saved' && m.sequence === sequence.current && m.generation === generation.current) {
        dirty.current = false; setSaveStatus('已保存'); setSaveError(''); setSavePath(m.path || ''); post({ type: 'clean' });
      }
      if (m.type === 'save-error') { setSaveStatus('保存失败'); setSaveError(m.message || '保存失败，请重试。'); setSaveConflict(m.code === 'save_conflict'); }
      if (m.type === 'save-now') await publish(true);
    };
    window.addEventListener('message', onMessage);
    return () => { clearTimeout(publishTimer.current); dispose.current?.(); localization.current?.dispose(); clearPreview(); for (const r of requests.current.values()) { clearTimeout(r.timer); r.reject(new Error('编辑器已关闭。')); } requests.current.clear(); window.removeEventListener('message', onMessage); };
  }, []);
  React.useEffect(() => { localization.current?.setLanguage(language); document.documentElement.lang = language; }, [language]);
  React.useEffect(() => { post({ type: 'working', busy }); }, [busy]);
  const init = React.useCallback(async (instance: any) => {
    k.current = instance;
    (window as any).ketcher = instance;
    // Explicit diagnostic surface: exposes this editor only, never DSH credentials.
    (window as any).chemP0 = { ketcher: instance, fingerprint: () => fingerprint(instance.editor.struct()), revision: () => revision.current,
      atomPoint: (id: number) => { const p = Coordinates.modelToView(instance.editor.struct().atoms.get(id).pp); const r = instance.editor.render.clientArea.getBoundingClientRect(); const v = instance.editor.render.viewBox; return { x: r.x + p.x - v.minX, y: r.y + p.y - v.minY }; } };
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
  const pendingAnnotation = annotations.some(a => ['submitting', 'queued', 'validating', 'proposed', 'needs_clarification'].includes(a.status));
  const resumable = currentAnnotation&&['failed','needs_clarification'].includes(currentAnnotation.status)&&currentAnnotation.instanceId===epoch.current&&currentAnnotation.baseRevision===revision.current;
  const attachmentSelection = resumable?currentAnnotation.selection:selected;
  const processingAnnotation=annotations.some(a=>['submitting','queued','validating','proposed'].includes(a.status));
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
        {Object.keys(fragments).map(id => <button key={id} disabled={!ready || busy || pendingAnnotation} onClick={() => setInstruction(`添加 ${fragmentName(id)}`)}>{language === 'en' ? `Add ${fragmentName(id, language)}` : `添加 ${fragmentName(id)}`}</button>)}
        {['改成双键', '删除选区'].map(text => <button key={text} disabled={!ready || busy || pendingAnnotation} onClick={() => setInstruction(text)}>{text}</button>)}
      </div></details></div>
      {attachmentSelection.atoms.length > 1 ? <div className="chem-attachment"><label htmlFor="attachment-atom">添加基团的连接原子</label><select id="attachment-atom" value={attachmentAtom ?? ''} disabled={!ready || busy || annotationBusy || processingAnnotation} onChange={e => { const id = e.target.value === '' ? null : Number(e.target.value); attachmentRef.current = id; setAttachmentAtom(id); }}><option value="">请选择连接原子</option>{attachmentSelection.atoms.map((id:number) => <option key={id} value={id}>{attachmentSelection.labels?.find((a:any)=>a.id===id)?.element||''} #{id}</option>)}</select><small>添加基团前指定一个连接点；删除和改键不需要。</small></div> : null}
      <div className="chem-note-row"><textarea id="annotation" maxLength={1000} rows={2} value={instruction} onChange={e => setInstruction(e.target.value)} placeholder="例如：添加正丙基、改成双键、删除选区" /><button disabled={!ready || busy || annotationBusy || pendingAnnotation || !(selected.atoms.length || selected.bonds.length) || dirty.current || !managed.current || !instruction.trim()} onClick={submitAnnotation}>交给 Agent</button></div>
      <small>{language === 'en' ? `Groups: ${fragmentList(language)}. Select one attachment atom; propyl means n-propyl. Preview before applying.` : `可添加 ${fragmentList()}。添加时指定一个连接原子；“丙基”默认正丙基。应用前会显示预览。`}</small>
      {currentAnnotation ? <div className={`chem-note-status${['failed', 'stale'].includes(currentAnnotation.status) ? ' chem-error' : ''}`} role="status" aria-live="polite" data-annotation-id={currentAnnotation.id} data-annotation-status={currentAnnotation.status} data-annotation-error={currentAnnotation.errorCode}><span>{currentAnnotation.message}</span>{['submitting', 'queued', 'validating', 'proposed','needs_clarification'].includes(currentAnnotation.status) ? <button disabled={busy} onClick={() => cancelAnnotation(currentAnnotation.id)}>取消批注</button> : null}</div> : null}
      {resumable ? <div className="chem-clarification"><label htmlFor="clarification">补充修改要求</label><small>可在 DSH 聊天中补充，或在这里继续。仍使用原批注的冻结选区。</small><div className="chem-note-row"><textarea id="clarification" maxLength={1000} rows={2} value={clarification} onChange={e=>setClarification(e.target.value)} /><button disabled={busy||annotationBusy||dirty.current||saveConflict||!clarification.trim()} onClick={()=>continueAnnotation(currentAnnotation)}>继续批注</button></div></div> : null}
      {preview && currentAnnotation?.status === 'proposed' ? <div className="chem-preview" data-preview-id={preview.id}><div><strong>{patchSummary(preview.patch, language)}</strong><span>冻结结构 v{preview.frozen.revision}</span></div><p>{preview.patch.reason}</p>{preview.patch.operation==='batch'?<p className="chem-plan-complete">{language==='en'?`All ${preview.patch.edits.length} steps will be applied and undone together.`:`全部 ${preview.patch.edits.length} 步一起应用，一步撤销。`}</p>:null}{preview.existingStereo ? <p>原结构已有立体提示（保持原状）：{preview.existingStereo}</p> : null}<div className="chem-preview-grid"><figure><img src={preview.urls[0]} alt="修改前结构" /><figcaption>修改前</figcaption></figure><figure><img src={preview.urls[1]} alt="修改后预览" /><figcaption>修改后预览</figcaption></figure></div><button className="chem-primary" disabled={busy || saveConflict} onClick={applyPreview}>应用修改</button><button disabled={busy} onClick={() => cancelAnnotation(preview.id)}>取消批注</button></div> : null}
    </section></div></div>
  </main>;
}
createRoot(document.getElementById('root')!).render(<App />);
