import { api, $, h, toast, guard, short } from './util.js';
import { state, on, emit } from './state.js';
import { initSource, fillFileSelect, openFile, refreshMarks, revealItem, revealLine, revealRange, reloadIfChanged, currentFile, save } from './source.js';
import { initPdf, loadPdf, redrawAll, revealItemInPdf, syncToPdf } from './pdfview.js';
import { initSidebar, renderSidebar, scrollCardIntoView } from './sidebar.js';
import { initMenu } from './menu.js';
import { initReview, renderReview, startEdit } from './review.js';
import { renderJobs } from './jobs.js';

function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  $('#readView').hidden = mode !== 'read';
  $('#reviewView').hidden = mode !== 'review';
  if (mode === 'review') renderReview();
}

function renderAgent() {
  const a = state.agent;
  const el = $('#agentStatus');
  const label = { waiting: 'agent 在线 · 等待中', busy: `agent 处理中${a.busy ? ` · ${a.busy} 条` : ''}`, offline: 'agent 离线' }[a.state];
  el.textContent = label;
  el.className = `pill ${a.state}`;
  el.title = a.lastSeen ? `最近一次联系：${new Date(a.lastSeen).toLocaleTimeString()}` : '还没有 agent 连接过。在 Claude Code 里运行 /thesis-review-agent';
}

function renderCompile() {
  const c = state.compile;
  const el = $('#compileStatus');
  $('#compileBtn').disabled = !!c.running;
  $('#recipeSelect').disabled = !!c.running;
  $('#stopBtn').hidden = !c.running;
  if (c.running) {
    const step = c.steps?.length > 1 ? ` ${c.step}/${c.steps.length} ${c.steps[c.step - 1] || ''}` : '';
    el.textContent = `编译中${step}…`;
    el.className = 'pill clickable run';
    return;
  }
  if (c.ok === true) { el.textContent = `${c.recipe ? c.recipe + ' ' : ''}编译成功 ${new Date(c.finishedAt).toLocaleTimeString()}`; el.className = 'pill clickable ok'; return; }
  if (c.ok === false) { el.textContent = `编译出错${c.errors?.length ? ` · ${c.errors.length} 处` : ''}`; el.className = 'pill clickable err'; return; }
  el.textContent = state.pdf ? `PDF ${new Date(state.pdf.mtime).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : '没有 PDF';
  el.className = 'pill clickable';
}

function renderDirty() {
  const n = state.dirty.length;
  const el = $('#dirtyBanner');
  el.hidden = !n;
  el.textContent = n ? `${n} 个源文件比 PDF 新，重新编译后 PDF 才会更新` : '';
  el.title = state.dirty.join('\n');
}

function renderCounts() {
  const n = state.items.filter((it) => it.status === 'proposed').length;
  $('#proposalCount').textContent = n || '';
  document.title = `${n ? `(${n}) ` : ''}论文审阅台`;
}

function renderItems() {
  renderSidebar();
  refreshMarks();
  redrawAll();
  renderCounts();
  if (state.mode === 'review') renderReview();
}

function showCompileLog() {
  const c = state.compile;
  const body = $('#modal .modal-body');
  body.replaceChildren(
    h('h3', {}, `编译日志${c.recipe ? ' · ' + c.recipe : ''}`),
    c.message && h('p', {}, c.message),
    ...(c.errors || []).map((e) => h('div', { class: 'err-row', onclick: () => { $('#modal').hidden = true; setMode('read'); revealLine(e.line, e.file.replace(/^\.\//, '')); } }, `${e.file}:${e.line}  ${e.message}`)),
    h('pre', {}, (c.tail || []).join('\n') || '还没有编译过'),
  );
  $('#modal').hidden = false;
}

// 状态变化提示：新方案、agent 回复
function notifyChanges(prev, next) {
  const old = new Map(prev.map((it) => [it.id, it]));
  for (const it of next) {
    const o = old.get(it.id);
    if (!o || o.status === it.status && o.thread.length === it.thread.length) continue;
    if (it.status === 'proposed' && o.status !== 'proposed') toast(`${it.id} 有新的修改方案：${short(it.proposal?.summary || it.comment || it.anchor.quote, 40)}`);
    else if (it.thread.length > o.thread.length && it.thread.at(-1).role === 'agent') toast(`${it.id} agent 回复：${short(it.thread.at(-1).text, 60)}`);
  }
}

function connect() {
  const es = new EventSource('/events');
  es.addEventListener('items', (e) => {
    const next = JSON.parse(e.data);
    notifyChanges(state.items, next);
    state.items = next;
    renderItems();
  });
  es.addEventListener('jobs', (e) => { state.jobs = JSON.parse(e.data); renderJobs(); });
  es.addEventListener('agent', (e) => { state.agent = JSON.parse(e.data); renderAgent(); });
  es.addEventListener('compile', (e) => { state.compile = JSON.parse(e.data); renderCompile(); });
  es.addEventListener('compile-progress', (e) => { $('#compileStatus').title = JSON.parse(e.data); });
  es.addEventListener('pdf', (e) => {
    const pdf = JSON.parse(e.data);
    if (pdf && pdf.mtime !== state.pdf?.mtime) { state.pdf = pdf; loadPdf().then(redrawAll).catch((err) => toast(`PDF 加载失败：${err.message}`, true)); }
    renderCompile();
  });
  es.addEventListener('files', (e) => {
    const { changed, dirty } = JSON.parse(e.data);
    state.dirty = dirty;
    renderDirty();
    if (changed.length) reloadIfChanged(changed);
  });
  es.onopen = () => api('GET', '/api/state').then(applyState).catch(() => {});
}

function applyState(s) {
  state.items = s.items;
  state.files = s.files;
  state.fileTitles = s.fileTitles || {};
  state.agent = s.agent;
  state.compile = s.compile;
  state.dirty = s.dirty;
  state.defaultSkill = s.defaultSkill;
  state.favoriteSkills = s.favoriteSkills || [];
  state.jobs = s.jobs || [];
  renderJobs();
  fillRecipes(s.recipes);
  const pdfChanged = s.pdf?.mtime !== state.pdf?.mtime;
  state.pdf = s.pdf;
  fillFileSelect();
  renderAgent(); renderCompile(); renderDirty(); renderItems();
  return pdfChanged;
}

function fillRecipes(r) {
  const sel = $('#recipeSelect');
  if (!r || sel.options.length) return;
  const saved = localStorage.getItem('recipe');
  sel.replaceChildren(...r.names.map((n) => new Option(`配方: ${n}`, n)));
  sel.value = r.names.includes(saved) ? saved : r.default;
}

function initSplitter() {
  const view = $('#readView');
  const saved = localStorage.getItem('split');
  if (saved) view.style.setProperty('--split', saved);
  const sp = $('#splitter');
  sp.addEventListener('mousedown', (ev) => {
    ev.preventDefault();
    sp.classList.add('drag');
    const rect = view.getBoundingClientRect();
    const move = (e) => {
      const pct = Math.min(80, Math.max(15, ((e.clientX - rect.left) / rect.width) * 100));
      view.style.setProperty('--split', `${pct}%`);
    };
    const up = () => {
      sp.classList.remove('drag');
      localStorage.setItem('split', view.style.getPropertyValue('--split'));
      removeEventListener('mousemove', move);
      removeEventListener('mouseup', up);
    };
    addEventListener('mousemove', move);
    addEventListener('mouseup', up);
  });
}

async function selectItem({ id, from }) {
  const it = state.items.find((x) => x.id === id);
  if (!it) return;
  state.activeId = id;
  document.querySelectorAll('.card, .pcard').forEach((c) => c.classList.toggle('active', c.dataset.id === id));
  if (from === 'review') setMode('read');
  if (from !== 'source') await revealItem(it).catch(() => {});
  refreshMarks();
  redrawAll();
  if (from !== 'create') revealItemInPdf(it);
  scrollCardIntoView(id);
}

async function main() {
  initSource();
  initPdf();
  initSidebar();
  initMenu();
  initReview();
  initSplitter();

  document.querySelectorAll('.tabs button').forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));
  const compile = async (fromKey = false) => {
    const r = await api('POST', '/api/compile', { recipe: $('#recipeSelect').value });
    if (!r.started) toast(fromKey ? '已保存；上一次编译还没结束，结束后再按 Ctrl+S' : '已经在编译了');
  };
  $('#compileBtn').onclick = guard(() => compile());
  // Ctrl+S：先保存左侧源码，再按顶部选的配方编译（编辑器外按也一样）
  on('save-and-compile', guard(async () => { await save(); await compile(true); }));
  document.addEventListener('keydown', (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && !ev.shiftKey && !ev.altKey && ev.key.toLowerCase() === 's') {
      if (ev.target.closest?.('.cm-editor')) return; // 编辑器里的由 CodeMirror 的快捷键处理
      ev.preventDefault();
      emit('save-and-compile');
    }
  });
  $('#stopBtn').onclick = guard(() => api('POST', '/api/compile/stop'));
  $('#recipeSelect').onchange = (e) => localStorage.setItem('recipe', e.target.value);
  $('#compileStatus').onclick = showCompileLog;
  $('#modal .modal-close').onclick = () => { $('#modal').hidden = true; };
  $('#modal').onclick = (e) => { if (e.target.id === 'modal') $('#modal').hidden = true; };

  on('select-item', selectItem);
  on('file-opened', () => { renderSidebar(); renderJobs(); });
  on('chapter-filter', () => renderJobs());
  on('marks-changed', () => { refreshMarks(); redrawAll(); });
  // Esc：取消选中，高亮全部撤掉
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape' || !state.activeId || !$('#selMenu').hidden) return;
    state.activeId = null;
    document.querySelectorAll('.card.active, .pcard.active').forEach((c) => c.classList.remove('active'));
    refreshMarks(); redrawAll();
  });
  on('open-review', (id) => {
    state.activeId = id;
    setMode('review');
    setTimeout(() => document.querySelector(`.pcard[data-id="${id}"]`)?.scrollIntoView({ block: 'start' }), 300);
  });
  on('edit-proposal', (id) => { state.activeId = id; state.mode = 'review'; document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.mode === 'review')); $('#readView').hidden = true; $('#reviewView').hidden = false; startEdit(id); });
  on('sync-to-pdf', guard(({ file, line, snippet }) => syncToPdf(file, line, snippet)));
  on('sync-to-source', guard(async ({ file, line, from, to }) => {
    if (!state.files.includes(file)) return toast(`对应源码在 ${file}，不在可浏览范围内`);
    if (from != null) await revealRange(file, from, to);
    else await revealLine(line, file);
  }));

  const s = await api('GET', '/api/state');
  applyState(s);
  state.skills = await api('GET', '/api/skills');
  const first = state.files.find((f) => /chapter1/.test(f)) || state.files[0];
  await openFile(localStorage.getItem('lastFile') && state.files.includes(localStorage.getItem('lastFile')) ? localStorage.getItem('lastFile') : first);
  $('#fileSelect').addEventListener('change', () => localStorage.setItem('lastFile', currentFile()));
  await loadPdf().catch((e) => toast(`PDF 加载失败：${e.message}`, true));
  connect();
}

main().catch((e) => { console.error(e); toast(e.message, true); });
