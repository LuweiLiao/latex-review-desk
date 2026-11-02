// “修改方案”页：修改前 / 修改后对照，接受、编辑后接受、驳回、带意见重做、撤销
import { applyEdits, diffWords } from '../lib/diff.js';
import { api, $, h, guard, toast, STATUS } from './util.js';
import { state, emit } from './state.js';
import { skillSelect } from './menu.js';
import { hunksOf } from './inline.js';

const editing = new Set();

export function initReview() {
  $('#acceptAllBtn').onclick = guard(async () => {
    const list = state.items.filter((it) => it.status === 'proposed' && !it.conflict && !it.stale);
    if (!list.length) return toast('没有可以直接接受的方案');
    if (!confirm(`接受 ${list.length} 条方案并写入论文？`)) return;
    let ok = 0;
    for (const it of list) {
      try { await api('POST', `/api/items/${it.id}/accept`, {}); ok++; } catch (e) { toast(`${it.id}：${e.message}`, true); }
    }
    toast(`已写入 ${ok} 条`);
  });
}

// 按论文中出现的先后：文件顺序，再按行号
export function byPosition(a, b) {
  const order = new Map(state.files.map((f, i) => [f, i]));
  return (order.get(a.anchor.file) ?? 99) - (order.get(b.anchor.file) ?? 99) || a.anchor.lineStart - b.anchor.lineStart;
}

let renderSeq = 0;
export async function renderReview() {
  const seq = ++renderSeq;
  const proposed = state.items.filter((it) => it.status === 'proposed').sort(byPosition);
  const accepted = state.items.filter((it) => it.status === 'accepted').sort((a, b) => b.acceptedAt - a.acceptedAt).slice(0, 30);
  $('#reviewSummary').textContent = `待确认 ${proposed.length} 条 · 最近已接受 ${accepted.length} 条`;
  $('#acceptAllBtn').disabled = !proposed.some((it) => !it.conflict && !it.stale);
  const cards = [];
  for (const it of [...proposed, ...accepted]) {
    if (editing.has(it.id) && it.status !== 'proposed') { editing.delete(it.id); toast(`${it.id} 已${it.status === 'rejected' ? '被驳回' : '不是待确认状态'}，编辑已关闭`, true); }
    if (editing.has(it.id)) {
      const old = document.querySelector(`.pcard[data-id="${it.id}"]`);
      if (old) { cards.push(old); continue; }
    }
    cards.push(await pcard(it));
    if (seq !== renderSeq) return;
  }
  const box = $('#reviewList');
  const top = box.scrollTop;
  box.replaceChildren(...(cards.length ? cards : [h('div', { class: 'empty' }, '还没有修改方案。\nagent 处理完批注或润色请求后会出现在这里。')]));
  box.scrollTop = top;
}

function diffCells(before, after) {
  const L = h('td', { class: 'tex' }), R = h('td', { class: 'tex' });
  for (const o of diffWords(before, after)) {
    if (o.op === 'eq') { L.append(o.text); R.append(o.text); }
    else if (o.op === 'del') L.append(h('del', {}, o.text));
    else R.append(h('ins', {}, o.text));
  }
  return [L, R];
}

function hunkTable(hunks, pick = null) {
  const rows = hunks.map((hk) => {
    const edits = hk.edits
      .filter((e) => !pick || pick.include.has(e.idx))
      .map((e) => ({ ...e, replacement: pick?.text.get(e.idx) ?? e.replacement }));
    const after = applyEdits(hk.before, edits);
    const [L, R] = diffCells(hk.before, after);
    return [
      h('tr', {}, h('td', { colspan: 2, class: 'fileline' }, hk.missing ? `${hk.file} · 原文已不在文件里` : `${hk.file}:${hk.lineStart}`)),
      h('tr', {}, L, R),
    ];
  });
  return h('table', { class: 'cmp' },
    h('thead', {}, h('tr', {}, h('th', {}, '修改前 完整段落'), h('th', {}, '修改后 完整段落'))),
    h('tbody', {}, rows.flat()));
}

async function pcard(it) {
  const hunks = await hunksOf(it).catch((e) => { toast(e.message, true); return []; });
  const p = it.proposal || {};
  const title = [it.anchor.page ? `P${String(it.anchor.page).padStart(3, '0')}` : it.id, it.anchor.section || it.anchor.file].join(' • ');
  const card = h('div', { class: `pcard${it.id === state.activeId ? ' active' : ''}`, 'data-id': it.id });
  const tableSlot = h('div', {}, hunkTable(hunks));
  card.append(...[
    h('h3', {}, title),
    h('div', { class: 'sub' },
      h('span', { class: `tag ${it.status}` }, STATUS[it.status]),
      it.kind === 'polish' ? h('span', { class: 'tag skill' }, it.skill) : h('span', { class: 'tag' }, '批注'),
      h('span', {}, `${it.anchor.file}:${it.anchor.lineStart}`),
      h('button', { class: 'btn link', onclick: () => emit('select-item', { id: it.id, from: 'review' }) }, '在原文中定位'),
    ),
    it.comment && h('div', { class: 'req' }, h('b', {}, '我的意见：'), it.comment),
    (it.conflict || it.stale) && it.status === 'proposed' && h('div', { class: 'warn-box' }, '原文在提出方案后又被改动过，找不到要替换的文字。可以“带意见重做”让 agent 按新原文重新给方案。'),
    tableSlot,
    p.rationale && h('div', { class: 'note-box' }, h('b', {}, '理由与收益：'), p.rationale),
    p.fidelity && h('div', { class: 'note-box' }, h('b', {}, '保真复核：'), p.fidelity),
    it.history?.length > 0 && h('div', { class: 'history' }, `之前有 ${it.history.length} 版方案被驳回或重做：` + it.history.map((x) => x.feedback || x.reason || '无说明').join('；')),
  ].filter(Boolean));
  const actions = h('div', { class: 'pactions' });
  card.append(actions);

  const b = (label, fn, cls = 'btn') => h('button', { class: cls, onclick: guard(fn) }, label);
  if (it.status === 'proposed') {
    actions.append(
      b('接受并写入', async () => { await api('POST', `/api/items/${it.id}/accept`, {}); toast('已写入论文源码'); }, 'btn primary'),
      b('编辑后接受', () => openEditor(it, card, tableSlot, hunks)),
      b('驳回', async () => { const r = prompt('驳回原因（可不填）：', ''); if (r !== null) await api('POST', `/api/items/${it.id}/reject`, { reason: r }); }),
      b('带意见重做 / 换 skill', () => redoBox(it, card)),
    );
  } else if (it.status === 'accepted') {
    actions.append(b('撤销写入', async () => { if (confirm('把这条修改从论文里撤销？')) { await api('POST', `/api/items/${it.id}/undo`); toast('已撤销'); } }));
  }
  return card;
}

function redoBox(it, card) {
  if (card.querySelector('.redo-box')) return;
  editing.add(it.id);
  const sel = skillSelect(it.skill || localStorage.getItem('lastSkill') || state.defaultSkill);
  const ta = h('textarea', { placeholder: '哪里不满意（可不填，只换 skill 也行）' });
  const done = () => { editing.delete(it.id); renderReview(); };
  const box = h('div', { class: 'redo-box' },
    h('label', {}, '用这个 skill 重做：'), sel, ta,
    h('div', { class: 'pactions' },
      h('button', { class: 'btn primary', onclick: guard(async () => {
        if (!ta.value.trim() && sel.value === it.skill) return toast('写一句意见，或换一个 skill');
        localStorage.setItem('lastSkill', sel.value);
        await api('POST', `/api/items/${it.id}/requeue`, { message: ta.value, skill: sel.value });
        toast(`已发回重做（${sel.value}）`);
        done();
      }) }, '发回重做'),
      h('button', { class: 'btn', onclick: done }, '取消'),
    ));
  card.querySelector('.pactions').replaceWith(box);
  ta.focus();
}

function openEditor(it, card, tableSlot, hunks) {
  editing.add(it.id);
  const pick = { include: new Set(it.proposal.edits.map((_, i) => i)), text: new Map() };
  const refresh = () => tableSlot.replaceChildren(hunkTable(hunks, pick));
  const rows = it.proposal.edits.map((e, idx) => {
    if (e.skipped) return null;
    const cb = h('input', { type: 'checkbox', checked: true, onchange: () => { cb.checked ? pick.include.add(idx) : pick.include.delete(idx); refresh(); } });
    const ta = h('textarea', { oninput: () => { pick.text.set(idx, ta.value); refresh(); } });
    ta.value = e.replacement;
    return h('div', { class: 'edit-row' },
      h('label', {}, cb, ` 第 ${idx + 1} 处`),
      h('div', { class: 'orig' }, e.original),
      ta);
  });
  const done = () => { editing.delete(it.id); renderReview(); };
  const box = h('div', { class: 'edit-list' }, rows,
    h('div', { class: 'pactions' },
      h('button', { class: 'btn primary', onclick: guard(async () => {
        const replacements = Object.fromEntries(pick.text);
        await api('POST', `/api/items/${it.id}/accept`, { include: [...pick.include], replacements });
        toast('已按修改后的版本写入');
        done();
      }) }, '写入选中的修改'),
      h('button', { class: 'btn', onclick: done }, '取消编辑'),
    ));
  card.querySelector('.pactions').replaceWith(box);
}

// 侧栏“编辑”：切到修改方案页并打开这条的编辑器
export async function startEdit(id) {
  await renderReview();
  const card = document.querySelector(`.pcard[data-id="${id}"]`);
  if (!card) return;
  card.scrollIntoView({ block: 'start' });
  [...card.querySelectorAll('button')].find((b) => b.textContent === '编辑后接受')?.click();
}
