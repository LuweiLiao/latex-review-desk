// 从 PDF 文本层的文字块里找出公式，给每个公式一个框（像 WPS 的内嵌公式）。
// 纯函数，浏览器和 node 测试共用。坐标都是页面比例 0..1，y 向下，y 为文字框上沿。

// 数学字体：newtx、txfonts、Computer/Latin Modern、AMS、STIX/XITS、Cambria Math 等
const MATH_FONT = /newtxmi|newtxbmi|^tx(sy|sys|ex|exs|mia|miax|sym|syb)|^(cm|lm)(mi|sy|ex|bsy|mib)|^lmmath|^lmroman\d*-?italic.*math|^msam|^msbm|^eufm|^rsfs|^mathdesign|stixmath|xitsmath|cambria\s*math|latinmodern-?math|texgyre\w*-?math|^fira-?math|^asana|^libertinusmath|^esint|^wasy|^stmary|mathpi|symbol$/i;

export function isMathFont(fontName) {
  const name = String(fontName || '').replace(/^[A-Z]+\+/, ''); // 去掉子集前缀 ABCDEF+
  return MATH_FONT.test(name);
}

// 只会出现在公式里的字：数学字母区、希腊字母、运算符和箭头、私用区（大括号等拼接件）
const MATH_CHAR = /[\u{1D400}-\u{1D7FF}\u0391-\u03A9\u03B1-\u03C9\u03D1\u03D5\u03D6\u03F0\u03F1\u03F5\u2200-\u22FF\u2190-\u21FF\u27C0-\u27EF\u2A00-\u2AFF\u2300-\u23FF\u2032-\u2037\u00B1\u00D7\u00F7\uE000-\uF8FF]/u;

export function isMathChar(ch) {
  return MATH_CHAR.test(ch);
}

// 正文：中文和全角标点
const TEXT = /[\u3000-\u303F\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF\u2018-\u201F\u2026]/u;
// 公式编号 (2.75)、(3-1)、(A.2)
const EQ_NO = /^\s*[(（]\s*[A-Z]?\d+([.\-–]\d+)*[a-z]?\s*[)）]\s*$/;

function kindOf(it) {
  const s = it.str;
  // 先看字体：求和号在 txexs 里是 "’"，按字判断会当成正文
  if (isMathFont(it.font)) return s.trim() || s === '' ? 'math' : 'space';
  if (TEXT.test(s)) return 'text';
  if (!s.trim()) return 'space';
  return [...s].some(isMathChar) ? 'math' : 'weak'; // weak：西文、数字、括号，挨着公式才算公式
}

const PAD = { inline: [0.0025, 0.002], display: [0.006, 0.004] };

function bbox(list) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const it of list) {
    x0 = Math.min(x0, it.x); y0 = Math.min(y0, it.y);
    x1 = Math.max(x1, it.x + it.w); y1 = Math.max(y1, it.y + it.h);
  }
  return { x0, y0, x1, y1 };
}

// 正文行：按中文文字块的竖直范围合并
function textBands(items) {
  const spans = items.filter((it) => it.kind === 'text').map((it) => [it.y, it.y + it.h]).sort((a, b) => a[0] - b[0]);
  const bands = [];
  for (const [a, b] of spans) {
    const l = bands[bands.length - 1];
    if (l && a < l[1] - 0.002) l[1] = Math.max(l[1], b);
    else bands.push([a, b]);
  }
  return bands;
}

const bandOf = (bands, it) => {
  const c = it.y + it.h / 2;
  return bands.findIndex(([a, b]) => c >= a - 0.001 && c <= b + 0.001);
};

/**
 * items: [{ str, font, x, y, w, h }]
 * 返回 [{ kind: 'inline'|'display', fx, fy, fw, fh, items: [下标], before, after }]
 */
export function formulaBoxes(items) {
  const all = items.map((it, i) => ({ ...it, i, kind: kindOf(it) }));
  const bands = textBands(all);
  for (const it of all) it.band = bandOf(bands, it);

  // 1) 正文行里的行内公式：同一行里从左到右，正文字或大空隙把公式隔开
  const inline = [];
  bands.forEach((band, bi) => {
    const row = all.filter((it) => it.band === bi).sort((a, b) => a.x - b.x);
    const em = Math.max(0.008, ...row.filter((it) => it.kind === 'text').map((it) => it.h * 0.7));
    let cur = [];
    const flush = () => {
      while (cur.length && cur[cur.length - 1].kind === 'weak' && /^[,.;:，。；：]+$/.test(cur[cur.length - 1].str.trim())) cur.pop();
      if (cur.some((it) => it.kind === 'math')) inline.push(cur);
      cur = [];
    };
    for (const it of row) {
      if (it.kind === 'space') continue;
      if (it.kind === 'text') { flush(); continue; }
      const last = cur[cur.length - 1];
      if (last && it.x - (last.x + last.w) > em * 1.2) flush();
      cur.push(it);
    }
    flush();
  });
  // 行内公式里的公式编号式引用（"式(2.22)"）不算
  const inl = inline.filter((g) => !(g.length === 1 && EQ_NO.test(g[0].str)));

  // 2) 不在正文行里的：独立公式，挨得近的拼成一块
  const loose = all.filter((it) => it.band === -1 && (it.kind === 'math' || (it.kind === 'weak' && !EQ_NO.test(it.str))));
  const parent = loose.map((_, k) => k);
  const find = (k) => (parent[k] === k ? k : (parent[k] = find(parent[k])));
  const GX = 0.02, GY = 0.012;
  for (let a = 0; a < loose.length; a++) {
    for (let b = a + 1; b < loose.length; b++) {
      const p = loose[a], q = loose[b];
      if (p.x - GX > q.x + q.w || q.x - GX > p.x + p.w) continue;
      if (p.y - GY > q.y + q.h || q.y - GY > p.y + p.h) continue;
      parent[find(a)] = find(b);
    }
  }
  const groups = new Map();
  loose.forEach((it, k) => { const r = find(k); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(it); });
  let display = [...groups.values()].filter((g) => g.some((it) => it.kind === 'math'));
  display = mergeDisplay(display, bands);

  // 独立公式和贴着它的行内公式（公式里夹了中文）合成一块
  const merged = [];
  for (const g of inl) {
    const b = bbox(g);
    // 要真的叠在一起，只是上下挨着（大括号伸到正文行边上）不算
    const hit = display.find((d) => { const e = bbox(d); return e.x0 < b.x1 && b.x0 < e.x1 && Math.min(e.y1, b.y1) - Math.max(e.y0, b.y0) > (b.y1 - b.y0) * 0.3; });
    if (hit) hit.push(...g);
    else merged.push(g);
  }

  // 公式编号并进同一高度的独立公式
  const used = new Set();
  for (const it of all) {
    if (it.band !== -1 || !EQ_NO.test(it.str)) continue;
    const c = it.y + it.h / 2;
    let best = null, bestD = Infinity;
    for (const d of display) {
      const e = bbox(d);
      if (c < e.y0 - 0.004 || c > e.y1 + 0.004 || it.x < e.x0) continue;
      const dist = it.x - e.x1;
      if (dist < bestD) { best = d; bestD = dist; }
    }
    if (best && !used.has(it.i)) { best.push(it); used.add(it.i); }
  }

  const out = [];
  const make = (g, kind) => {
    const b = bbox(g);
    const [px, py] = PAD[kind];
    out.push({ kind, fx: b.x0 - px, fy: b.y0 - py, fw: b.x1 - b.x0 + 2 * px, fh: b.y1 - b.y0 + 2 * py, items: g.map((it) => it.i).sort((a, c) => a - c), ...context(all, bands, g, kind) });
  };
  merged.forEach((g) => make(g, 'inline'));
  display.forEach((g) => make(g, 'display'));
  return out.sort((a, b) => a.fy - b.fy || a.fx - b.fx);
}

// 独立公式的碎块再合并：框有重叠（矩阵里的小块），或同一高度左右挨着（“S = [..], θ = ..”）
function mergeDisplay(groups, bands) {
  const textBetween = (a, b) => bands.some(([y0, y1]) => y0 > a - 0.002 && y1 < b + 0.002);
  let list = groups.map((g) => ({ g, b: bbox(g) }));
  for (let changed = true; changed;) {
    changed = false;
    for (let a = 0; a < list.length && !changed; a++) {
      for (let c = a + 1; c < list.length && !changed; c++) {
        const p = list[a].b, q = list[c].b;
        const overlapX = Math.min(p.x1, q.x1) - Math.max(p.x0, q.x0);
        const overlapY = Math.min(p.y1, q.y1) - Math.max(p.y0, q.y0);
        const minH = Math.min(p.y1 - p.y0, q.y1 - q.y0);
        const stacked = overlapX > 0 && overlapY > minH * 0.3;
        // 同一高度：align 里 “=” 前后、公式和编号之间可以隔得很远
        const sideBySide = overlapY > minH * 0.5 && overlapX > -0.15;
        // 多行公式（align）：上下两行挨着、中间没有正文
        const gapY = Math.max(p.y0, q.y0) - Math.min(p.y1, q.y1);
        const rows = overlapX > 0 && gapY < 0.02 && !textBetween(Math.min(p.y1, q.y1), Math.max(p.y0, q.y0));
        if (stacked || sideBySide || rows) {
          const g = [...list[a].g, ...list[c].g];
          list.splice(c, 1);
          list[a] = { g, b: bbox(g) };
          changed = true;
        }
      }
    }
  }
  return list.map((x) => x.g);
}

// 公式前后的正文（给源码定位用）
function context(all, bands, g, kind) {
  const ids = new Set(g.map((it) => it.i));
  const words = (list) => list.filter((it) => !ids.has(it.i) && (it.kind === 'text' || it.kind === 'weak')).sort((a, b) => a.y - b.y || a.x - b.x).map((it) => it.str).join('');
  const b = bbox(g);
  let before = '', after = '';
  if (kind === 'inline') {
    const bi = g[0].band;
    const row = all.filter((it) => it.band === bi);
    // 按文字块中心比：重音符号（ˆ、˙）的框常和前一个字叠在一起
    before = words(row.filter((it) => it.x + it.w / 2 < b.x0));
    after = words(row.filter((it) => it.x + it.w / 2 > b.x1));
    if (before.length < 4 && bi > 0) before = words(all.filter((it) => it.band === bi - 1)) + before;
    if (after.length < 4 && bi + 1 < bands.length) after += words(all.filter((it) => it.band === bi + 1));
  } else {
    const above = bands.map((x, k) => [x, k]).filter(([x]) => x[1] <= b.y0 + 0.002).pop();
    const below = bands.map((x, k) => [x, k]).find(([x]) => x[0] >= b.y1 - 0.002);
    if (above) before = words(all.filter((it) => it.band === above[1]));
    if (below) after = words(all.filter((it) => it.band === below[1]));
  }
  return { before: before.slice(-30), after: after.slice(0, 30) };
}
