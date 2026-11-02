// 左侧只读源码视图
import { EditorState, StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, highlightActiveLine, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap } from '@codemirror/commands';
import { StreamLanguage, defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { api, $, OPEN } from './util.js';
import { state, emit, markedItems } from './state.js';

const setMarks = StateEffect.define();
const setFlash = StateEffect.define();

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
let current = null; // { path, mtime }
const scrollPos = new Map();

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
      keymap.of([...defaultKeymap, ...searchKeymap]),
      StreamLanguage.define(stex),
      syntaxHighlighting(defaultHighlightStyle),
      EditorView.lineWrapping,
      EditorState.readOnly.of(true),
      marksField,
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

export async function openFile(path, { keepScroll = false } = {}) {
  if (!path) return;
  if (current) scrollPos.set(current.path, view.scrollDOM.scrollTop);
  const data = await api('GET', `/api/file?path=${encodeURIComponent(path)}`);
  const same = current?.path === path;
  const top = keepScroll && same ? view.scrollDOM.scrollTop : scrollPos.get(path) ?? 0;
  current = { path, mtime: data.mtime };
  view.setState(makeState(data.text));
  $('#fileSelect').value = path;
  refreshMarks();
  requestAnimationFrame(() => { view.scrollDOM.scrollTop = top; });
}

export function currentFile() { return current?.path; }

export async function reloadIfChanged(changed) {
  if (current && changed.includes(current.path)) await openFile(current.path, { keepScroll: true });
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
  view.dispatch({ effects: setMarks.of(Decoration.set(ranges, true)) });
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
