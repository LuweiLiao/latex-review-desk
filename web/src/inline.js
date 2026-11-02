// 侧栏里的对照视图。每处修改按词级 diff 拆成若干“改动块”（连续的删和增），
// 待确认的方案可以点改动块把它撤掉（保留原文），接受时只写入没撤掉的部分。
import { diffWords } from '../lib/diff.js';
import { api, h } from './util.js';

const cache = new Map(); // id -> { key, hunks }
const keyOf = (it) => `${it.updatedAt}:${it.status}`;

export function cachedHunks(it) {
  const hit = cache.get(it.id);
  return hit?.key === keyOf(it) ? hit.hunks : null;
}

export async function hunksOf(it) {
  const hit = cachedHunks(it);
  if (hit) return hit;
  const hunks = await api('GET', `/api/items/${it.id}/hunks`);
  cache.set(it.id, { key: keyOf(it), hunks });
  return hunks;
}

// 一个 hunk -> [{ op: 'eq', text } | { op: 'chg', id, del, ins }]
function chunksOf(hk) {
  const out = [];
  let cur = 0;
  for (const e of [...hk.edits].sort((a, b) => a.start - b.start)) {
    if (e.start > cur) out.push({ op: 'eq', text: hk.before.slice(cur, e.start) });
    let k = 0, chg = null;
    for (const o of diffWords(e.original, e.replacement)) {
      if (o.op === 'eq') { chg = null; out.push({ op: 'eq', text: o.text }); continue; }
      if (!chg) { chg = { op: 'chg', id: `${e.idx}:${k++}`, idx: e.idx, del: '', ins: '' }; out.push(chg); }
      chg[o.op] += o.text;
    }
    cur = e.end;
  }
  if (cur < hk.before.length) out.push({ op: 'eq', text: hk.before.slice(cur) });
  return out;
}

// 撤掉部分改动块后，每处修改实际要写入的文字：{ idx: replacement }
export function replacementsWithout(hunks, rejected) {
  const out = {};
  for (const hk of hunks) {
    if (hk.missing) continue;
    for (const e of hk.edits) {
      // 按块重建：没撤掉的取新文字，撤掉的取原文字
      let t = '';
      let k = 0, inChg = false, del = '', ins = '';
      const flush = () => { if (!inChg) return; t += rejected.has(`${e.idx}:${k}`) ? del : ins; k++; inChg = false; del = ins = ''; };
      for (const o of diffWords(e.original, e.replacement)) {
        if (o.op === 'eq') { flush(); t += o.text; continue; }
        inChg = true;
        if (o.op === 'del') del += o.text; else ins += o.text;
      }
      flush();
      out[e.idx] = t;
    }
  }
  return out;
}

export function countChunks(hunks) {
  return hunks.reduce((n, hk) => n + (hk.missing ? 0 : chunksOf(hk).filter((c) => c.op === 'chg').length), 0);
}

function trimEq(t, first, last, ctx) {
  if (first && last) return t;
  if (first) return t.length > ctx ? '…' + t.slice(-ctx) : t;
  if (last) return t.length > ctx ? t.slice(0, ctx) + '…' : t;
  return t.length > ctx * 2 + 6 ? `${t.slice(0, ctx)} … ${t.slice(-ctx)}` : t;
}

// opts.rejected: Set 撤掉的块；opts.onToggle(id)：点改动块时调用（不给则不可点）
function pieces(hk, opts, ctx) {
  const list = chunksOf(hk);
  return list.map((c, i) => {
    if (c.op === 'eq') return { eq: trimEq(c.text, i === 0, i === list.length - 1, ctx) };
    return { ...c, off: opts.rejected?.has(c.id) };
  });
}

function attrsOf(c, opts) {
  const attrs = { class: c.off ? 'kept' : '', 'data-chunk': c.id };
  if (opts.onToggle) {
    attrs.class += ' toggle';
    attrs.title = c.off ? '已撤掉这处修改（保留原文），点击恢复' : '点击撤掉这处修改，保留原文';
    attrs.onclick = (ev) => { ev.stopPropagation(); opts.onToggle(c.id); };
  }
  return attrs;
}

// 撤掉的块：显示原文（纯新增没有原文，留一个小标记）
function keptEl(c, opts) {
  return h('span', attrsOf(c, opts), c.del || '⊘');
}

// side: 'L' 修改前 / 'R' 修改后
function chgEl(c, opts, side) {
  // 撤掉的纯新增：修改前一侧本来就没有字，只在修改后一侧留标记
  if (c.off) return !c.del && side === 'L' ? null : keptEl(c, opts);
  const text = side === 'L' ? c.del : c.ins;
  return text ? h(side === 'L' ? 'del' : 'ins', attrsOf(c, opts), text) : null;
}

// 修改前 / 修改后 左右对照（侧栏窄时上下排）
export function compareDiff(hunks, opts = {}, ctx = 60) {
  const box = h('div', { class: 'cdiff' });
  for (const hk of hunks) {
    if (hk.missing) {
      box.append(h('div', { class: 'idiff-hunk missing' }, '原文已不在文件里：', h('del', {}, hk.before.slice(0, 120))));
      continue;
    }
    const L = h('div', { class: 'cdiff-cell' }), R = h('div', { class: 'cdiff-cell' });
    for (const p of pieces(hk, opts, ctx)) {
      if ('eq' in p) { L.append(p.eq); R.append(p.eq); continue; }
      const l = chgEl(p, opts, 'L');
      if (l) L.append(l);
      const r = chgEl(p, opts, 'R');
      if (r) R.append(r);
    }
    box.append(h('div', { class: 'cdiff-row' },
      h('div', { class: 'cdiff-col' }, h('div', { class: 'cdiff-head' }, '修改前'), L),
      h('div', { class: 'cdiff-col' }, h('div', { class: 'cdiff-head' }, '修改后'), R)));
  }
  return box;
}

export function inlineDiff(hunks, opts = {}, ctx = 36) {
  const box = h('div', { class: 'idiff' });
  for (const hk of hunks) {
    if (hk.missing) {
      box.append(h('div', { class: 'idiff-hunk missing' }, '原文已不在文件里：', h('del', {}, hk.before.slice(0, 120))));
      continue;
    }
    const p = h('div', { class: 'idiff-hunk' });
    for (const x of pieces(hk, opts, ctx)) {
      if ('eq' in x) { p.append(x.eq); continue; }
      if (x.off) { p.append(keptEl(x, opts)); continue; }
      const d = chgEl(x, opts, 'L'), i = chgEl(x, opts, 'R');
      if (d) p.append(d);
      if (i) p.append(i);
    }
    box.append(p);
  }
  return box;
}
