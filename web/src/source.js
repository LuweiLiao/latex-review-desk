// 左侧源码编辑器：可以直接改，停手 1 秒自动保存（Ctrl+S 立即保存）
import { Annotation, EditorState, StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, highlightActiveLine, keymap, lineNumbers } from '@codemirror/view';
import { changeSpans } from '../lib/diff.js';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { StreamLanguage, defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { api, $, h, OPEN, setBeforeWrite, toast } from './util.js';
import { state, emit, markedItems } from './state.js';

const setMarks = StateEffect.define();
const setFlash = StateEffect.define();
const setChanges = StateEffect.define();

// 已写入、还没确认的修改：改了的字标黄
const changesField = StateField.define({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) if (e.is(setChanges)) deco = e.value;
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// 只删不补的地方放一个小黄点，悬停看删了什么
class DelMark extends WidgetType {
  constructor(text, id) { super(); this.text = text; this.id = id; }
  eq(o) { return o.text === this.text && o.id === this.id; }
  toDOM() {
    const el = document.createElement('span');
    el.className = 'cm-chg-del';
    el.title = `删去：${this.text}`;
    el.dataset.id = this.id;
    return el;
  }
}

const marksField = StateField.define({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) if (e.is(setMarks)) deco = e.value;
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const flashField = StateField.define({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) if (e.is(setFlash)) deco = e.value;
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

let view;
let selecting = false; // 本次鼠标按下是否从源码区开始
let current = null; // { path, hash }
// 每个文件的阅读位置：{ top: 视口顶部那一行的文档位置, cursor }
const POS_KEY = 'srcPos';
const posAll = () => { try { return JSON.parse(localStorage.getItem(POS_KEY) || '{}'); } catch { return {}; } };
function rememberPos() {
  if (!current || !view) return;
  const top = view.lineBlockAtHeight(view.scrollDOM.scrollTop).from;
  const all = posAll();
  all[current.path] = { top, cursor: view.state.selection.main.head };
  localStorage.setItem(POS_KEY, JSON.stringify(all));
}
let posTimer = null;
const rememberSoon = () => { clearTimeout(posTimer); posTimer = setTimeout(rememberPos, 300); };

// ---- 保存 ----
// 用户改了文字 -> edits 加一；保存成功时记下当时的 edits，相等就是“已保存”
const remote = Annotation.define(); // 服务端推来的内容，不算用户改动
let edits = 0, savedAt = 0, saveTimer = null, saving = null, conflict = null;

const isDirty = () => edits !== savedAt;

function setStatus() {
  const el = $('#saveStatus');
  if (!el) return;
  if (conflict) { el.textContent = '有冲突'; el.className = 'save-status err'; return; }
  if (saving) { el.textContent = '保存中…'; el.className = 'save-status'; return; }
  if (isDirty()) { el.textContent = '未保存'; el.className = 'save-status dirty'; return; }
  el.textContent = current ? '已保存' : '';
  el.className = 'save-status ok';
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => save(), 1000);
}

// 立即保存；正在保存时等它完，再看还有没有新改动
export async function save(force = false) {
  clearTimeout(saveTimer);
  if (saving) await saving;
  if (!current || (!isDirty() && !force) || (conflict && !force)) return;
  const path = current.path, at = edits, text = view.state.doc.toString();
  saving = (async () => {
    try {
      const res = await fetch('/api/file', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path, text, baseHash: current.hash, force }) });
      const data = await res.json();
      if (current?.path !== path) return;
      if (res.status === 409) { showConflict(data); return; }
      if (!res.ok) throw new Error(data.error || res.statusText);
      current.hash = data.hash;
      savedAt = at;
      conflict = null;
      $('#conflictBar').hidden = true;
    } catch (e) {
      toast(`保存失败：${e.message}`, true);
    }
  })();
  setStatus();
  await saving;
  saving = null;
  setStatus();
  if (isDirty() && !conflict) scheduleSave();
}

// 磁盘上的文件在网页改动期间被别处改了：让用户选留哪一份
function showConflict(disk) {
  conflict = disk;
  const bar = $('#conflictBar');
  bar.replaceChildren(
    h('span', {}, '这个文件刚被别处改过（其他编辑器保存，或接受了修改方案），和你在这里没保存的改动冲突。'),
    h('button', { class: 'btn small', onclick: () => { applyRemote(disk.text); current.hash = disk.hash; savedAt = edits; conflict = null; bar.hidden = true; setStatus(); } }, '用磁盘上的版本'),
    h('button', { class: 'btn small danger', onclick: () => { conflict = null; bar.hidden = true; save(true); } }, '用我这里的版本覆盖'),
  );
  bar.hidden = false;
  setStatus();
}

// 换成新内容，只改有差别的那一段，光标和滚动位置不动
function applyRemote(text) {
  const old = view.state.doc.toString();
  if (old === text) return;
  let a = 0;
  const max = Math.min(old.length, text.length);
  while (a < max && old.charCodeAt(a) === text.charCodeAt(a)) a++;
  let b = 0;
  while (b < max - a && old.charCodeAt(old.length - 1 - b) === text.charCodeAt(text.length - 1 - b)) b++;
  view.dispatch({ changes: { from: a, to: old.length - b, insert: text.slice(a, text.length - b) }, annotations: remote.of(true) });
}

const trackCursor = EditorView.updateListener.of((u) => { if (u.selectionSet) rememberSoon(); });

const trackEdits = EditorView.updateListener.of((u) => {
  if (!u.docChanged || u.transactions.every((t) => t.annotation(remote))) return;
  edits++;
  setStatus();
  scheduleSave();
  emit('hide-quick-menu');
});

export function initSource() {
  view = new EditorView({
    parent: $('#editor'),
    state: makeState(''),
  });

  // 鼠标拖选结束时 CodeMirror 在 document 上处理 mouseup，这里也在 document 上听
  document.addEventListener('mouseup', (ev) => {
    if (ev.ctrlKey || ev.metaKey || !selecting) return;
    selecting = false;
    setTimeout(() => {
      const sel = view.state.selection.main;
      if (sel.empty || !current) return;
      const quote = view.state.sliceDoc(sel.from, sel.to);
      if (!quote.trim()) return;
      const c = view.coordsAtPos(sel.head) || { left: ev.clientX, bottom: ev.clientY };
      emit('selection', {
        x: c.left, y: c.bottom + 6,
        quote,
        anchor: { source: 'source', file: current.path, from: sel.from, to: sel.to, quote },
      });
    }, 0);
  });

  $('#fileSelect').addEventListener('change', (e) => openFile(e.target.value));
  setBeforeWrite(() => save());
  view.scrollDOM.addEventListener('scroll', rememberSoon, { passive: true });
  window.addEventListener('pagehide', rememberPos);
  window.addEventListener('beforeunload', (ev) => { if (isDirty() || conflict) { ev.preventDefault(); ev.returnValue = ''; } });
  $('#toPdfBtn').addEventListener('click', () => {
    if (!current) return;
    const head = view.state.selection.main.head;
    emit('sync-to-pdf', { file: current.path, line: view.state.doc.lineAt(head).number, snippet: snippetAt(view, head) });
  });
  $('#polishChapterBtn').addEventListener('click', () => {
    if (!current) return;
    const r = $('#polishChapterBtn').getBoundingClientRect();
    emit('selection', { x: r.left, y: r.bottom + 6, quote: `整章：${current.path}`, polish: true, perParagraph: true, anchor: { source: 'source', file: current.path, whole: true } });
  });
}

// Ctrl+点击：跳到 PDF；点到批注高亮：选中对应卡片。
// 要用 domEventHandlers 注册，CodeMirror 自己处理 mousedown 后外层监听收不到。
const clickHandlers = EditorView.domEventHandlers({
  mousedown(ev, v) {
    if (!current) return false;
    selecting = ev.button === 0 && !ev.ctrlKey && !ev.metaKey;
    if (ev.ctrlKey || ev.metaKey) {
      const pos = v.posAtCoords({ x: ev.clientX, y: ev.clientY });
      if (pos == null) return false;
      emit('sync-to-pdf', { file: current.path, line: v.state.doc.lineAt(pos).number, snippet: snippetAt(v, pos) });
      return true;
    }
    const mark = ev.target.closest?.('[data-id]');
    if (mark) setTimeout(() => { if (v.state.selection.main.empty) emit('select-item', { id: mark.dataset.id, from: 'source' }); }, 0);
    return false;
  },
});

// 点击处附近的一小段源码，用来在 PDF 里按文字定位（中文段落常常一整段只占一行）
function snippetAt(v, pos) {
  const line = v.state.doc.lineAt(pos);
  const a = Math.max(line.from, pos - 12), b = Math.min(line.to, pos + 40);
  return v.state.sliceDoc(a, b);
}

function makeState(doc) {
  return EditorState.create({
    doc,
    extensions: [
      lineNumbers(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      history(),
      keymap.of([
        { key: 'Mod-s', preventDefault: true, run: () => { emit('save-and-compile'); return true; } },
        indentWithTab,
        ...defaultKeymap, ...historyKeymap, ...searchKeymap,
      ]),
      StreamLanguage.define(stex),
      syntaxHighlighting(defaultHighlightStyle),
      EditorView.lineWrapping,
      trackEdits,
      trackCursor,
      marksField,
      changesField,
      flashField,
      clickHandlers,
    ],
  });
}

export function fillFileSelect() {
  const sel = $('#fileSelect');
  const keep = sel.value;
  sel.replaceChildren(...state.files.map((f) => new Option(f.replace(/^content\//, ''), f)));
  if (keep && state.files.includes(keep)) sel.value = keep;
}

export async function openFile(path) {
  if (!path) return;
  if (current?.path === path) return;
  if (current) {
    await save();
    if (conflict) { $('#fileSelect').value = current.path; return toast('先处理当前文件的保存冲突', true); }
    rememberPos();
  }
  const data = await api('GET', `/api/file?path=${encodeURIComponent(path)}`);
  const saved = posAll()[path];
  current = { path, hash: data.hash };
  edits = savedAt = 0;
  conflict = null;
  $('#conflictBar').hidden = true;
  view.setState(makeState(data.text));
  setStatus();
  $('#fileSelect').value = path;
  refreshMarks();
  localStorage.setItem('lastFile', path);
  if (saved) {
    const len = view.state.doc.length;
    view.dispatch({ selection: { anchor: Math.min(saved.cursor ?? 0, len) } });
    requestAnimationFrame(() => {
      const at = Math.min(saved.top ?? 0, len);
      view.scrollDOM.scrollTop = view.lineBlockAt(at).top;
    });
  }
  state.openFile = path;
  emit('file-opened', path);
}

export function currentFile() { return current?.path; }

// 文件在磁盘上变了（接受了方案、撤销、别的编辑器保存、自己刚保存）
export async function reloadIfChanged(changed) {
  if (!current || !changed.includes(current.path)) return;
  if (saving) await saving;
  const path = current.path;
  const data = await api('GET', `/api/file?path=${encodeURIComponent(path)}`);
  if (current?.path !== path || data.hash === current.hash) return; // 是自己刚存的
  if (isDirty()) return showConflict(data);
  applyRemote(data.text);
  current.hash = data.hash;
  refreshMarks();
}

// 在当前文件里找每条请求的原文位置
function rangeOf(it) {
  const doc = view.state.doc;
  const text = doc.toString();
  const q = it.anchor.quote;
  if (!q) return null;
  const target = doc.line(Math.min(Math.max(it.anchor.lineStart, 1), doc.lines)).from;
  let best = -1, bestD = Infinity;
  for (let i = text.indexOf(q); i !== -1; i = text.indexOf(q, i + 1)) {
    const d = Math.abs(i - target);
    if (d < bestD) { best = i; bestD = d; }
    if (i > target) break;
  }
  return best === -1 ? null : [best, best + q.length];
}

function changeDecos() {
  const text = view.state.doc.toString();
  const out = [];
  for (const c of state.changes || []) {
    if (c.file !== current?.path) continue;
    let base = c.from;
    if (text.slice(base, base + c.replacement.length) !== c.replacement) {
      if (!c.replacement) continue;
      // 之后前文又改过，位置挪了：找离原位置最近的同样文字
      let best = -1, bd = Infinity;
      for (let i = text.indexOf(c.replacement); i !== -1; i = text.indexOf(c.replacement, i + 1)) {
        const d = Math.abs(i - c.from);
        if (d < bd) { bd = d; best = i; }
      }
      if (best === -1) continue;
      base = best;
    }
    const { ins, del } = changeSpans(c.original, c.replacement);
    for (const s of ins) out.push(Decoration.mark({ class: 'cm-chg', attributes: { 'data-id': c.itemId, title: s.old ? `原文：${s.old}` : '新增' } }).range(base + s.from, base + s.to));
    for (const d of del) out.push(Decoration.widget({ widget: new DelMark(d.text, c.itemId), side: 1 }).range(Math.min(base + d.at, text.length)));
  }
  return Decoration.set(out, true);
}

export function refreshMarks() {
  if (!current) return;
  const ranges = [];
  for (const it of markedItems(OPEN)) {
    if (it.anchor.file !== current.path) continue;
    const r = rangeOf(it);
    if (!r) continue;
    const cls = it.id === state.activeId ? `cm-mark active st-${it.status}` : 'cm-mark other';
    ranges.push(Decoration.mark({ class: cls, attributes: { 'data-id': it.id, title: it.comment || `润色：${it.skill}` } }).range(r[0], r[1]));
  }
  ranges.sort((a, b) => a.from - b.from);
  view.dispatch({ effects: [setMarks.of(Decoration.set(ranges, true)), setChanges.of(changeDecos())] });
}

export async function revealItem(it) {
  if (current?.path !== it.anchor.file) await openFile(it.anchor.file);
  const r = rangeOf(it);
  if (r) {
    view.dispatch({ effects: [EditorView.scrollIntoView(r[0], { y: 'center' })] });
    flash(r[0], r[1]);
  } else revealLine(it.anchor.lineStart);
}

// 跳到源码的某个区间（双击 PDF 时用）
export async function revealRange(file, from, to) {
  if (file && current?.path !== file) await openFile(file);
  const len = view.state.doc.length;
  from = Math.min(from, len); to = Math.min(Math.max(to, from), len);
  view.dispatch({ selection: { anchor: from }, effects: EditorView.scrollIntoView(from, { y: 'center' }) });
  flash(from, to);
}

export async function revealLine(line, file) {
  if (file && current?.path !== file) await openFile(file);
  const doc = view.state.doc;
  const l = doc.line(Math.min(Math.max(line, 1), doc.lines));
  view.dispatch({ selection: { anchor: l.from }, effects: EditorView.scrollIntoView(l.from, { y: 'center' }) });
  flash(l.from, l.to);
}

function flash(from, to) {
  if (to <= from) return;
  view.dispatch({ effects: setFlash.of(Decoration.set([Decoration.mark({ class: 'cm-flash' }).range(from, to)])) });
  setTimeout(() => view.dispatch({ effects: setFlash.of(Decoration.none) }), 1700);
}
