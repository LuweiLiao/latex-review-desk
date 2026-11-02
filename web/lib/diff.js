// 中文友好的词级 diff：Intl.Segmenter 分词，LaTeX 命令整体算一个词，再做 LCS。
// 浏览器和 node 测试共用。

const seg = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('zh', { granularity: 'word' }) : null;

export function tokenize(s) {
  const out = [];
  const re = /\\[a-zA-Z]+\*?|\\.|\$+|\s+|[^\\$\s]+/g;
  let m;
  while ((m = re.exec(s))) {
    const t = m[0];
    if (t[0] === '\\' || t[0] === '$' || /^\s/.test(t) || !seg) { out.push(t); continue; }
    for (const p of seg.segment(t)) out.push(p.segment);
  }
  return out;
}

// 返回 [{op: 'eq'|'del'|'ins', text}]
export function diffWords(a, b) {
  if (a === b) return a ? [{ op: 'eq', text: a }] : [];
  const A = tokenize(a), B = tokenize(b);
  let p = 0;
  while (p < A.length && p < B.length && A[p] === B[p]) p++;
  let sa = A.length, sb = B.length;
  while (sa > p && sb > p && A[sa - 1] === B[sb - 1]) { sa--; sb--; }
  const midA = A.slice(p, sa), midB = B.slice(p, sb);
  const ops = [];
  if (p) ops.push({ op: 'eq', text: A.slice(0, p).join('') });
  ops.push(...lcsOps(midA, midB));
  if (sa < A.length) ops.push({ op: 'eq', text: A.slice(sa).join('') });
  return merge(ops);
}

function lcsOps(A, B) {
  const n = A.length, m = B.length;
  if (!n && !m) return [];
  if (!n) return [{ op: 'ins', text: B.join('') }];
  if (!m) return [{ op: 'del', text: A.join('') }];
  if (n * m > 4_000_000) return [{ op: 'del', text: A.join('') }, { op: 'ins', text: B.join('') }];
  const w = m + 1;
  const L = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      L[i * w + j] = A[i] === B[j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { ops.push({ op: 'eq', text: A[i] }); i++; j++; }
    else if (L[(i + 1) * w + j] >= L[i * w + j + 1]) ops.push({ op: 'del', text: A[i++] });
    else ops.push({ op: 'ins', text: B[j++] });
  }
  while (i < n) ops.push({ op: 'del', text: A[i++] });
  while (j < m) ops.push({ op: 'ins', text: B[j++] });
  return cleanup(ops);
}

// 夹在两段改动之间的单个短词（如“的”“，”）并入改动，读起来不那么碎
function cleanup(ops) {
  const out = [];
  for (let k = 0; k < ops.length; k++) {
    const o = ops[k];
    const prev = out[out.length - 1], next = ops[k + 1];
    if (o.op === 'eq' && o.text.length <= 1 && prev && prev.op !== 'eq' && next && next.op !== 'eq') {
      out.push({ op: 'del', text: o.text }, { op: 'ins', text: o.text });
      continue;
    }
    out.push(o);
  }
  return out;
}

function merge(ops) {
  // 先把相邻的 del/ins 各自归并，再合并同类
  const out = [];
  let dels = '', inss = '';
  const flush = () => {
    if (dels) out.push({ op: 'del', text: dels });
    if (inss) out.push({ op: 'ins', text: inss });
    dels = inss = '';
  };
  for (const o of ops) {
    if (!o.text) continue;
    if (o.op === 'del') dels += o.text;
    else if (o.op === 'ins') inss += o.text;
    else {
      flush();
      const last = out[out.length - 1];
      if (last?.op === 'eq') last.text += o.text;
      else out.push({ ...o });
    }
  }
  flush();
  return out;
}

// 把一组修改（相对 before 的区间）套到 before 上，得到 after
export function applyEdits(before, edits) {
  let out = before;
  for (const e of [...edits].sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.replacement + out.slice(e.end);
  return out;
}
