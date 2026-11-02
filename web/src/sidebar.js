// 右侧批注列表：待确认的方案直接在卡片里显示修订对照，可就地接受、驳回、重做
import { api, $, h, guard, toast, timeAgo, STATUS, OPEN } from './util.js';
import { state, emit } from './state.js';
import { cachedHunks, compareDiff, countChunks, hunksOf, inlineDiff, replacementsWithout } from './inline.js';
import { skillSelect } from './menu.js';
import { byPosition } from './review.js';

const openBoxes = new Map(); // 正在填写的回复框：id -> 文本，重绘时保留

export function initSidebar() {
  $('#statusFilter').value = localStorage.getItem('statusFilter') || 'open';
  $('#sortOrder').value = localStorage.getItem('sortOrder') || 'pos';
  $('#statusFilter').onchange = (e) => { localStorage.setItem('statusFilter', e.target.value); renderSidebar(); };
  $('#sortOrder').onchange = (e) => { localStorage.setItem('sortOrder', e.target.value); renderSidebar(); };
  $('#chapterFilter').onchange = (e) => { localStorage.setItem('chapterFilter', e.target.value); renderSidebar(); emit('chapter-filter'); };
  initResize();
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
  let list = state.items.filter((it) => !scope || it.anchor.file === scope).filter((it) => f === 'all' || (f === 'open' ? OPEN.has(it.status) : it.status === f || (f === 'pending' && it.status === 'claimed')));
  if ($('#sortOrder').value === 'time') list = list.sort((a, b) => b.updatedAt - a.updatedAt);
  else list = list.sort(byPosition);
  return list;
}

export function renderSidebar() {
  fillChapterFilter();
  const list = visible();
  const box = $('#itemList');
  const scope = scopeFile();
  const n = state.items.filter((it) => it.status === 'proposed' && (!scope || it.anchor.file === scope)).length;
  const total = state.items.filter((it) => it.status === 'proposed').length;
  $('#sideTitle').textContent = n ? `注释 · ${n} 条待确认${scope && total > n ? `（全部 ${total}）` : ''}` : total ? `注释 · 其他章 ${total} 条待确认` : '注释';
  if (!list.length) {
    const others = scope && state.items.some((it) => it.anchor.file !== scope && OPEN.has(it.status));
    box.replaceChildren(h('div', { class: 'empty' }, !state.items.length ? '在 PDF 或源码里选中文字，\n点“批注”或选一个 skill 润色。' : others ? `${chapterName(scope)}没有符合筛选的注释。\n其他章节的可以在上方切到“全部章节”。` : '这个筛选下没有条目'));
    return;
  }
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

function card(it) {
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
  const hasProposal0 = (it.status === 'proposed' || it.status === 'accepted') && it.proposal;
  if (hasProposal0) head.append(h('span', { class: 'spacer' }), h('button', {
    class: 'btn link mode-toggle',
    title: '切换左右对照 / 单栏修订',
    onclick: () => { localStorage.setItem('sideDiffMode', diffMode() === 'inline' ? 'compare' : 'inline'); renderSidebar(); },
  }, diffMode() === 'inline' ? '对照' : '修订'));
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
  document.querySelector(`.card[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest' });
}
