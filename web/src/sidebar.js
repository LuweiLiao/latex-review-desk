// 右侧批注列表：待确认的方案直接在卡片里显示修订对照，可就地接受、驳回、重做
import { api, $, h, guard, toast, timeAgo, short, STATUS, OPEN } from './util.js';
import { state, emit, on } from './state.js';
import { diffWords } from '../lib/diff.js';
import { itemAnchor, pageOffset, pdfReady } from './pdfview.js';
import { cachedHunks, compareDiff, countChunks, hunksOf, inlineDiff, replacementsWithout } from './inline.js';
import { skillSelect } from './menu.js';
import { byPosition } from './review.js';

const openBoxes = new Map(); // 正在填写的回复框：id -> 文本，重绘时保留

export function initSidebar() {
  // “全部”已去掉，旧的记录按“未完成”处理
  const sf = localStorage.getItem('statusFilter');
  $('#statusFilter').value = sf && sf !== 'all' ? sf : 'open';
  if (!$('#statusFilter').value) $('#statusFilter').value = 'open';
  $('#sortOrder').value = localStorage.getItem('sortOrder') || 'pos';
  $('#statusFilter').onchange = (e) => { localStorage.setItem('statusFilter', e.target.value); renderSidebar(); };
  $('#sortOrder').onchange = (e) => { localStorage.setItem('sortOrder', e.target.value); renderSidebar(); };
  $('#chapterFilter').onchange = (e) => { localStorage.setItem('chapterFilter', e.target.value); renderSidebar(); emit('chapter-filter'); };
  initResize();
  initRail();
}

function initResize() {
  const side = $('#sidebar');
  const saved = localStorage.getItem('sideWidth');
  if (saved) side.style.width = saved;
  $('#sideSplitter').addEventListener('mousedown', (ev) => {
    ev.preventDefault();
    $('#sideSplitter').classList.add('drag');
    const move = (e) => { side.style.width = `${Math.min(innerWidth * 0.6, Math.max(280, innerWidth - e.clientX))}px`; };
    const up = () => {
      $('#sideSplitter').classList.remove('drag');
      localStorage.setItem('sideWidth', side.style.width);
      removeEventListener('mousemove', move);
      removeEventListener('mouseup', up);
    };
    addEventListener('mousemove', move);
    addEventListener('mouseup', up);
  });
}

// 当前按章筛选到的文件；null 表示全部章节
export function scopeFile() {
  const v = localStorage.getItem('chapterFilter') || 'follow';
  if (v === 'all') return null;
  if (v === 'follow') return state.openFile;
  return state.files.includes(v) ? v : state.openFile;
}

const chapterName = (f) => state.fileTitles[f] || f.replace(/^.*\//, '');

function fillChapterFilter() {
  const sel = $('#chapterFilter');
  const v = localStorage.getItem('chapterFilter') || 'follow';
  const proposed = (f) => state.items.filter((it) => it.status === 'proposed' && (!f || it.anchor.file === f)).length;
  const open = (f) => state.items.filter((it) => OPEN.has(it.status) && it.anchor.file === f).length;
  const label = (f) => { const p = proposed(f), o = open(f); return `${chapterName(f)}${p ? `（待确认 ${p}）` : o ? `（${o}）` : ''}`; };
  const opts = [
    new Option(state.openFile ? `跟随左侧：${label(state.openFile)}` : '跟随左侧当前章', 'follow'),
    new Option(`全部章节${proposed() ? `（待确认 ${proposed()}）` : ''}`, 'all'),
    ...state.files.filter((f) => state.items.some((it) => it.anchor.file === f) || /chapter/.test(f)).map((f) => new Option(label(f), f)),
  ];
  sel.replaceChildren(...opts);
  sel.value = [...sel.options].some((o) => o.value === v) ? v : 'follow';
}

function visible() {
  const f = $('#statusFilter').value;
  const scope = scopeFile();
  const unfinished = (it) => ['pending', 'claimed', 'proposed'].includes(it.status) || (it.status === 'replied' && !it.job);
  let list = state.items.filter((it) => !scope || it.anchor.file === scope).filter((it) => (f === 'open' ? unfinished(it) : it.status === f || (f === 'pending' && it.status === 'claimed')));
  if ($('#sortOrder').value === 'time') list = list.sort((a, b) => b.updatedAt - a.updatedAt);
  else list = list.sort(byPosition);
  return list;
}

export function renderSidebar() {
  fillChapterFilter();
  updateNav();
  const list = visible();
  const box = $('#itemList');
  const scope = scopeFile();
  const n = state.items.filter((it) => it.status === 'proposed' && (!scope || it.anchor.file === scope)).length;
  const total = state.items.filter((it) => it.status === 'proposed').length;
  $('#sideTitle').textContent = n ? `注释 · ${n} 条待确认${scope && total > n ? `（全部 ${total}）` : ''}` : total ? `注释 · 其他章 ${total} 条待确认` : '注释';
  if (!railMode()) { box.classList.remove('rail-mode'); ro?.disconnect(); railNodes = []; }
  if (!list.length) {
    box.classList.remove('rail-mode');
    const others = scope && state.items.some((it) => it.anchor.file !== scope && OPEN.has(it.status));
    box.replaceChildren(h('div', { class: 'empty' }, !state.items.length ? '在 PDF 或源码里选中文字，\n点“批注”或选一个 skill 润色。' : others ? `${chapterName(scope)}没有符合筛选的注释。\n其他章节的可以在上方切到“全部章节”。` : '这个筛选下没有条目'));
    return;
  }
  if (railMode()) { renderRail(list, box); return; }
  const top = box.scrollTop;
  const nodes = [];
  let last = null;
  for (const it of list) {
    // 全部章节、按位置排序时，每章前面加一个章名
    if (!scope && $('#sortOrder').value === 'pos' && it.anchor.file !== last) {
      last = it.anchor.file;
      nodes.push(h('div', { class: 'chapter-head' }, chapterName(last)));
    }
    nodes.push(card(it));
  }
  box.replaceChildren(...nodes);
  box.scrollTop = top;
}

function card(it, inRail = false) {
  const head = h('div', { class: 'card-head' },
    h('span', { class: `tag ${it.status}` }, STATUS[it.status]),
    it.stale && h('span', { class: 'tag stale' }, '原文已改'),
    it.conflict && !it.stale && h('span', { class: 'tag stale' }, '方案冲突'),
    it.anchor.approximate && h('span', { class: 'tag approx', title: 'PDF 选区没能逐字对上源码，引用的是附近的源码' }, '近似'),
    it.kind === 'polish' && h('span', { class: 'tag skill' }, it.skill),
    it.job && h('span', { class: 'tag job-tag', title: `逐段润色 ${it.job.id}` }, `第 ${it.job.index}/${it.job.total} 段`),
    duplicatesOf(it).length > 0 && h('span', { class: 'tag stale', title: '同一段落还有其他未完成的请求，保留一条即可' }, `与 ${duplicatesOf(it).join('、')} 重复`),
    h('span', {}, [it.anchor.page ? `第 ${it.anchor.page} 页` : '', it.anchor.section].filter(Boolean).join(' · ')),
  );
  if (inRail) head.append(h('span', { class: 'spacer' }), h('button', { class: 'btn link', title: '收起（Esc）', onclick: () => emit('clear-active') }, '收起'));
  const hasProposal0 = (it.status === 'proposed' || it.status === 'accepted') && it.proposal;
  if (hasProposal0) head.append(...[!inRail && h('span', { class: 'spacer' }), h('button', {
    class: 'btn link mode-toggle',
    title: '切换左右对照 / 单栏修订',
    onclick: () => { localStorage.setItem('sideDiffMode', diffMode() === 'inline' ? 'compare' : 'inline'); renderSidebar(); },
  }, diffMode() === 'inline' ? '对照' : '修订')].filter(Boolean));
  const hasProposal = (it.status === 'proposed' || it.status === 'accepted') && it.proposal;
  // 只显示最近一轮（上次发回重做之后）的对话，旧的“无需修改”之类不再挂着
  // 已有方案时，方案之前 agent 说的话（如旧的“无需修改”）也不再显示
  const since = it.requeuedAt || 0;
  const propAt = it.status === 'proposed' || it.status === 'accepted' ? it.proposal?.createdAt || 0 : 0;
  const userMsgs = it.thread.filter((m) => m.at >= since && !(m.role === 'agent' && m.at < propAt) && !(m.role === 'user' && /^改用 skill：/.test(m.text)));
  const thread = userMsgs.slice(-3).map((m) => h('div', { class: `msg ${m.role}` }, h('span', { class: 'who' }, m.role === 'agent' ? 'agent：' : '我：'), m.text));
  const el = h('div', {
    class: `card${it.id === state.activeId ? ' active' : ''}${hasProposal ? ' has-diff' : ''}`,
    'data-id': it.id,
    onclick: (ev) => { if (!ev.target.closest('button, textarea, select, details, a')) emit('select-item', { id: it.id, from: 'sidebar' }); },
  },
    head,
    // 有方案时修订对照里已经包含原文，不再重复显示引用
    !hasProposal && h('div', { class: 'quote' }, it.anchor.pdfText || it.anchor.quote),
    it.comment && h('div', { class: 'comment' }, h('span', { class: 'who' }, '意见：'), it.comment),
    hasProposal && diffSlot(it),
    hasProposal && notes(it),
    thread.length > 0 && h('div', { class: 'thread' }, thread),
    h('div', { class: 'card-actions' }, ...actions(it)),
  );
  el.title = `${it.id} · ${it.anchor.file}:${it.anchor.lineStart} · ${timeAgo(it.updatedAt)}`;
  if (openBoxes.has(it.id)) setTimeout(() => replyBox(it, openBoxes.get(it.id)), 0);
  return el;
}

// 默认左右对照，可切到单栏修订；选择记在本地
const diffMode = () => localStorage.getItem('sideDiffMode') || 'compare';
const render = (hk, opts) => (diffMode() === 'inline' ? inlineDiff(hk, opts) : compareDiff(hk, opts));

// 待确认方案里被撤掉的改动块：id -> { key, set }，方案更新后自动作废
const rejectedChunks = new Map();
function rejectedOf(it) {
  const key = `${it.updatedAt}`;
  let r = rejectedChunks.get(it.id);
  if (!r || r.key !== key) { r = { key, set: new Set() }; rejectedChunks.set(it.id, r); }
  return r.set;
}

const OPEN_ST = new Set(['pending', 'claimed', 'proposed', 'replied']);
// 同一文件、行范围重叠的其他未完成请求
function duplicatesOf(it) {
  if (!OPEN_ST.has(it.status)) return [];
  const a = it.anchor;
  return state.items
    .filter((o) => o.id !== it.id && OPEN_ST.has(o.status) && o.anchor.file === a.file && o.anchor.lineStart <= a.lineEnd && a.lineStart <= o.anchor.lineEnd && sameText(o.anchor.quote, a.quote))
    .map((o) => o.id);
}

// 一条的原文包含另一条（首尾空白不计）才算重复，同一行里的两句不同的话不算
function sameText(x, y) {
  x = x.trim(); y = y.trim();
  return x.includes(y) || y.includes(x);
}

function diffSlot(it) {
  const slot = h('div', { class: 'diff-slot' });
  const editable = it.status === 'proposed' && !it.conflict && !it.stale;
  const off = rejectedOf(it);
  const draw = (hk) => {
    const opts = editable ? { rejected: off, onToggle: (id) => { off.has(id) ? off.delete(id) : off.add(id); draw(hk); } } : {};
    const n = countChunks(hk);
    const tip = editable && n > 1 && h('div', { class: 'chunk-tip' },
      off.size ? `已撤掉 ${off.size}/${n} 处修改，接受时这些地方保留原文 ` : '点修改处可以单独撤掉、保留原文',
      off.size > 0 && h('button', { class: 'btn link', onclick: (ev) => { ev.stopPropagation(); off.clear(); draw(hk); } }, '全部恢复'));
    slot.replaceChildren(...[render(hk, opts), tip].filter(Boolean));
    if ((it.conflict || it.stale) && it.status === 'proposed')
      slot.prepend(h('div', { class: 'warn-box small' }, '原文在提方案后又改过，不能直接写入，可以发回重做。'));
    const btn = document.querySelector(`.card[data-id="${it.id}"] .accept-btn`);
    if (btn) btn.textContent = off.size ? '接受其余修改' : '接受';
  };
  const hit = cachedHunks(it);
  if (hit) draw(hit);
  else {
    slot.append(h('div', { class: 'loading' }, '载入对照…'));
    hunksOf(it).then(draw).catch((e) => slot.replaceChildren(h('div', { class: 'warn-box' }, e.message)));
  }
  return slot;
}

// 接受：有撤掉的改动块时，只写入其余部分
async function acceptItem(it) {
  const off = rejectedOf(it);
  if (!off.size) {
    await api('POST', `/api/items/${it.id}/accept`, {});
    return toast(`${it.id} 已写入论文源码`);
  }
  const hunks = await hunksOf(it);
  const repl = replacementsWithout(hunks, off);
  const include = it.proposal.edits.map((e, i) => i).filter((i) => i in repl && repl[i] !== it.proposal.edits[i].original);
  if (!include.length) return toast('所有修改都撤掉了，原文不变。不需要这条方案的话点“驳回”', true);
  await api('POST', `/api/items/${it.id}/accept`, { include, replacements: Object.fromEntries(include.map((i) => [i, repl[i]])) });
  rejectedChunks.delete(it.id);
  toast(`${it.id} 已写入（撤掉了 ${off.size} 处修改）`);
}

function notes(it) {
  const p = it.proposal;
  if (!p.rationale && !p.fidelity) return null;
  return h('details', { class: 'why' },
    h('summary', {}, p.summary ? `方案：${p.summary}` : '理由与保真复核'),
    p.rationale && h('div', {}, h('b', {}, '理由与收益：'), p.rationale),
    p.fidelity && h('div', {}, h('b', {}, '保真复核：'), p.fidelity),
    it.history?.length > 0 && h('div', { class: 'muted' }, `之前有 ${it.history.length} 版被驳回或重做`),
  );
}

function actions(it) {
  const b = (label, fn, cls = 'btn small') => h('button', { class: cls, onclick: guard(fn) }, label);
  const out = [];
  if (it.status === 'proposed') {
    const blocked = it.conflict || it.stale;
    const accept = b(rejectedOf(it).size ? '接受其余修改' : '接受', () => acceptItem(it), 'btn small primary accept-btn');
    if (blocked) accept.disabled = true;
    out.push(accept,
      b('编辑', () => emit('edit-proposal', it.id)),
      b('驳回', async () => { const r = prompt('驳回这条方案？可以写一句原因（可不填）：', ''); if (r !== null) await api('POST', `/api/items/${it.id}/reject`, { reason: r }); }),
      b('重做', () => replyBox(it)),
      b('大图对照', () => emit('open-review', it.id), 'btn small link'));
  }
  if (it.status === 'accepted' && !it.confirmedAt) out.push(b('确认', () => api('POST', '/api/changes/confirm', { ids: [it.id] }), 'btn small chg-small'));
  if (it.status === 'accepted') out.push(b('撤销写入', async () => { if (confirm('把这条修改从论文里撤销？')) { await api('POST', `/api/items/${it.id}/undo`); toast('已撤销'); } }));
  if (it.status === 'replied') out.push(b('回复', () => replyBox(it)), b('关闭', () => api('POST', `/api/items/${it.id}/reject`, {})));
  if (it.status === 'rejected' && it.proposal) out.push(b('恢复方案', async () => { await api('POST', `/api/items/${it.id}/restore`); toast(`${it.id} 已恢复为待确认`); }, 'btn small primary'));
  if (it.status === 'rejected') out.push(b('重新处理', () => replyBox(it)));
  if (it.status !== 'accepted' && it.status !== 'claimed')
    out.push(b('删除', async () => { if (confirm('删除这条批注？')) await api('DELETE', `/api/items/${it.id}`); }, 'btn small danger'));
  return out;
}

// 回复 / 重做：可以写意见、换 skill
function replyBox(it, text = '') {
  const el = document.querySelector(`.card[data-id="${it.id}"] .card-actions`);
  if (!el || el.parentElement.querySelector('.reply-box')) return;
  const ta = h('textarea', { placeholder: '哪里不满意、想怎么改（可不填，只换 skill 也行）', oninput: () => openBoxes.set(it.id, ta.value) });
  ta.value = text;
  openBoxes.set(it.id, text);
  const sel = it.kind === 'polish' || it.status !== 'replied' ? skillSelect(it.skill || localStorage.getItem('lastSkill') || state.defaultSkill) : null;
  const close = () => { openBoxes.delete(it.id); box.remove(); };
  const box = h('div', { class: 'reply-box' },
    sel && h('label', { class: 'muted' }, '用 skill：'), sel, ta,
    h('div', { class: 'card-actions' },
      h('button', { class: 'btn small primary', onclick: guard(async () => {
        const skill = sel?.value;
        if (!ta.value.trim() && (!skill || skill === it.skill) && it.status !== 'rejected') return toast('写一句意见，或换一个 skill');
        if (skill) localStorage.setItem('lastSkill', skill);
        openBoxes.delete(it.id);
        await api('POST', `/api/items/${it.id}/requeue`, { message: ta.value, skill });
        toast('已发回 agent 重做');
      }) }, '发回重做'),
      it.status === 'replied' && h('button', { class: 'btn small', onclick: guard(async () => { if (ta.value.trim()) { openBoxes.delete(it.id); await api('POST', `/api/items/${it.id}/note`, { message: ta.value }); } }) }, '仅记录'),
      h('button', { class: 'btn small', onclick: close }, '取消'),
    ));
  el.after(box);
  ta.focus();
}

export function scrollCardIntoView(id) {
  if ($('#itemList').classList.contains('rail-mode')) return; // 贴边模式下卡片跟着 PDF 走
  document.querySelector(`.card[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest' });
}

// ---- 贴边卡片 ----
// 按位置排序、在阅读页、PDF 已加载时：每条注释是一张小卡片，贴在 PDF 上对应文字的高度，跟着 PDF 滚动。
// 点哪张就在原位展开成完整卡片（修改前 / 修改后对照），其余卡片上下让开。
export const railMode = () => $('#sortOrder').value === 'pos' && state.mode === 'read' && pdfReady();

const anchors = new Map(); // 位置缓存：key -> { page, fy } | null
let railNodes = [];
let ro = null;
let layoutQueued = false;

function anchorOf(it) {
  const k = `${it.id}:${it.anchor.lineStart}:${it.anchor.quote.length}:${state.pdf?.mtime}`;
  if (!anchors.has(k)) {
    // 先按记下的页码放在页中间，找到准确位置后再挪过去
    anchors.set(k, it.anchor.page ? { page: it.anchor.page, fy: 0.5 } : null);
    itemAnchor(it).then((a) => { if (a) { anchors.set(k, a); scheduleLayout(); } }).catch(() => {});
  }
  return anchors.get(k);
}

function renderRail(list, box) {
  box.classList.add('rail-mode');
  ro?.disconnect();
  ro = new ResizeObserver(() => scheduleLayout());
  const rail = h('div', { class: 'rail' });
  railNodes = list.map((it) => {
    const el = it.id === state.activeId ? card(it, true) : miniCard(it);
    el.classList.add('rail-card');
    rail.append(el);
    ro.observe(el);
    return { it, el };
  });
  box.replaceChildren(rail);
  layoutRail(true);
}

function scheduleLayout() {
  if (layoutQueued) return;
  layoutQueued = true;
  requestAnimationFrame(() => { layoutQueued = false; layoutRail(); });
}

// 卡片按对应文字的高度排；挤在一起时往下让，展开的那张固定在原位，前面的往上让
function layoutRail(first = false) {
  if (!$('#itemList').classList.contains('rail-mode')) return;
  const GAP = 6;
  const rows = [];
  railNodes.forEach(({ it, el }, i) => {
    const a = anchorOf(it);
    const y = a && pageOffset(a.page, a.fy);
    if (y == null) { el.style.display = 'none'; return; }
    el.style.display = '';
    rows.push({ el, y, h: el.offsetHeight, i, active: it.id === state.activeId });
  });
  rows.sort((a, b) => a.y - b.y || a.i - b.i);
  const k = rows.findIndex((r) => r.active);
  if (k === -1) {
    let bottom = -Infinity;
    for (const r of rows) { r.top = Math.max(r.y, bottom + GAP); bottom = r.top + r.h; }
  } else {
    rows[k].top = rows[k].y;
    for (let j = k + 1; j < rows.length; j++) rows[j].top = Math.max(rows[j].y, rows[j - 1].top + rows[j - 1].h + GAP);
    for (let j = k - 1; j >= 0; j--) rows[j].top = Math.min(rows[j].y, rows[j + 1].top - rows[j].h - GAP);
  }
  for (const r of rows) {
    r.el.style.transition = first ? 'none' : '';
    r.el.style.top = `${r.top}px`;
  }
  translateRail();
}

// 卡片栏自己可以滚（右边有滚动条），和 PDF 双向同步：
// 卡片层高度和 PDF 内容一样，卡片栏的 scrollTop 始终等于 PDF 的 scrollTop
let ignoreBox = 0, ignorePdf = 0; // 程序同步引起的滚动事件，在这个时间之前的忽略

function translateRail() {
  const box = $('#itemList');
  const rail = box.querySelector('.rail');
  if (!rail) return;
  const c = $('#pdfContainer');
  // 卡片的 top 用 PDF 内容坐标；两个滚动区的上沿不一样高，用 rail 的 top 补上
  rail.style.top = `${c.getBoundingClientRect().top - box.getBoundingClientRect().top}px`;
  rail.style.height = `${c.scrollHeight}px`;
  if (Math.abs(box.scrollTop - c.scrollTop) > 1) {
    ignoreBox = performance.now() + 120;
    box.scrollTop = c.scrollTop;
  }
}

function initRail() {
  const box = $('#itemList');
  on('pdf-scroll', () => {
    if (!box.classList.contains('rail-mode') || performance.now() < ignorePdf) return;
    translateRail();
  });
  // 拖卡片栏的滚动条、在卡片栏上滚滚轮：PDF 跟着滚
  box.addEventListener('scroll', () => {
    if (!box.classList.contains('rail-mode') || performance.now() < ignoreBox) return;
    const c = $('#pdfContainer');
    if (Math.abs(c.scrollTop - box.scrollTop) > 1) {
      ignorePdf = performance.now() + 120;
      c.scrollTop = box.scrollTop;
    }
  }, { passive: true });
  on('pdf-layout', () => { if (box.classList.contains('rail-mode')) scheduleLayout(); });
  addEventListener('resize', () => scheduleLayout());
  new ResizeObserver(() => translateRail()).observe($('#jobBar'));
  $('#prevItem').onclick = () => stepItem(-1);
  $('#nextItem').onclick = () => stepItem(1);
}

// 上一处 / 下一处：按当前筛选和章节，沿论文中出现的顺序走
function stepItem(dir) {
  const list = visible().sort(byPosition);
  if (!list.length) return toast('这个筛选下没有注释');
  let i = list.findIndex((it) => it.id === state.activeId);
  if (i === -1) {
    // 没有选中时，从当前看到的位置往前 / 往后找
    const c = $('#pdfContainer');
    const mid = c.scrollTop + c.clientHeight * 0.3;
    const ys = list.map((it) => { const a = anchorOf(it); return a ? pageOffset(a.page, a.fy) : null; });
    if (dir > 0) i = ys.findIndex((y) => y != null && y > mid);
    else for (let j = ys.length - 1; j >= 0; j--) if (ys[j] != null && ys[j] < mid) { i = j; break; }
    if (i === -1) i = dir > 0 ? 0 : list.length - 1;
  } else {
    i += dir;
    // 到头就绕回另一头
    if (i >= list.length) { i = 0; toast('已回到第一处'); }
    else if (i < 0) { i = list.length - 1; toast('已到最后一处'); }
  }
  emit('select-item', { id: list[i].id, from: 'nav' });
}

function updateNav() {
  const list = visible();
  const i = list.sort(byPosition).findIndex((it) => it.id === state.activeId);
  $('#navPos').textContent = list.length ? `${i === -1 ? '–' : i + 1}/${list.length}` : '';
  $('#prevItem').disabled = $('#nextItem').disabled = !list.length;
}

// 小卡片：状态、skill、改了哪几个字，✓ 接受 / ✗ 驳回
function miniCard(it) {
  const b = (label, title, fn, cls) => h('button', { class: `icon-btn ${cls}`, title, onclick: guard(async (ev) => { ev.stopPropagation(); await fn(); }) }, label);
  const acts = [];
  if (it.status === 'proposed' && !it.conflict && !it.stale) acts.push(b('✓', rejectedOf(it).size ? '接受其余修改' : '接受并写入', () => acceptItem(it), 'ok'));
  if (it.status === 'proposed') acts.push(b('✗', '驳回', async () => { const r = prompt('驳回这条方案？可以写一句原因（可不填）：', ''); if (r !== null) await api('POST', `/api/items/${it.id}/reject`, { reason: r }); }, 'no'));
  if (it.status === 'replied') acts.push(b('✓', '知道了，关闭', () => api('POST', `/api/items/${it.id}/reject`, {}), 'ok'));
  return h('div', { class: `mcard st-${it.status}`, 'data-id': it.id, title: it.proposal?.summary || '', onclick: () => emit('select-item', { id: it.id, from: 'sidebar' }) },
    h('div', { class: 'mcard-head' },
      h('span', { class: `tag ${it.status}` }, STATUS[it.status]),
      (it.stale || it.conflict) && h('span', { class: 'tag stale' }, it.stale ? '原文已改' : '冲突'),
      it.kind === 'polish' ? h('span', { class: 'tag skill' }, it.skill) : h('span', { class: 'tag' }, '批注'),
      it.job && h('span', { class: 'muted' }, `${it.job.index}/${it.job.total}`),
      h('span', { class: 'spacer' }),
      ...acts),
    h('div', { class: 'mcard-text' }, ...miniText(it)));
}

function miniText(it) {
  if ((it.status === 'proposed' || it.status === 'accepted') && it.proposal) {
    // 像 Overleaf 那样只列改动：删的红色删除线、加的绿色
    const out = [];
    let n = 0;
    for (const e of it.proposal.edits) {
      if (e.skipped) continue;
      const ops = diffWords(e.original, e.replacement).filter((o) => o.op !== 'eq');
      for (let i = 0; i < ops.length && n < 5; i++) {
        out.push(h(ops[i].op, {}, short(ops[i].text, 18)));
        if (!(ops[i].op === 'del' && ops[i + 1]?.op === 'ins')) { out.push(' '); n++; }
      }
      if (n >= 5) break;
    }
    return out.length ? out : [it.proposal.summary || ''];
  }
  if (it.status === 'replied') {
    const m = [...it.thread].reverse().find((x) => x.role === 'agent');
    return [m ? `agent：${m.text}` : ''];
  }
  if (it.comment) return [`意见：${it.comment}`];
  return [short(it.anchor.pdfText || it.anchor.quote, 60)];
}
