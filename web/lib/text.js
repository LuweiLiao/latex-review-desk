// 文字比对：PDF 文本层和 LaTeX 源码都“投影”成只含文字和数字的串再比。浏览器和服务端共用。
export const KEEP = /[\p{L}\p{N}]/u;

export function normalizeText(s) {
  let out = '';
  for (const ch of s) if (KEEP.test(ch)) out += ch.toLowerCase();
  return out;
}

// 这些命令的参数在 PDF 里不会原样出现
const SKIP_ARG = new Set([
  'cite', 'citep', 'citet', 'upcite', 'parencite', 'ref', 'eqref', 'autoref', 'cref', 'Cref', 'label',
  'includegraphics', 'input', 'include', 'bibliography', 'bibliographystyle', 'usepackage', 'begin', 'end',
  'vspace', 'hspace', 'setlength', 'url', 'href', 'color', 'textcolor',
]);

// 返回 { chars, map }，map[i] 为 chars[i] 在源码中的 offset
export function projectSource(text, from = 0, to = text.length) {
  let chars = '';
  const map = [];
  let i = from;
  while (i < to) {
    const c = text[i];
    if (c === '%' && text[i - 1] !== '\\') {
      const nl = text.indexOf('\n', i);
      i = nl === -1 ? to : nl;
      continue;
    }
    if (c === '\\') {
      const m = /^\\([a-zA-Z]+)\*?/.exec(text.slice(i, i + 40));
      if (m) {
        i += m[0].length;
        if (SKIP_ARG.has(m[1])) {
          while (text[i] === ' ') i++;
          if (text[i] === '[') { const e = text.indexOf(']', i); if (e !== -1) i = e + 1; }
          if (text[i] === '{') i = skipBraced(text, i);
        }
        continue;
      }
      i += 2;
      continue;
    }
    const cp = text.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    if (KEEP.test(ch)) { chars += ch.toLowerCase(); map.push(i); }
    i += ch.length;
  }
  return { chars, map };
}

function skipBraced(text, i) {
  let depth = 0;
  for (let j = i; j < text.length; j++) {
    if (text[j] === '\\') { j++; continue; }
    if (text[j] === '{') depth++;
    else if (text[j] === '}' && --depth === 0) return j + 1;
  }
  return text.length;
}

// 在 hay 里找 needle（两者都是投影串）。公式、引用让中间对不上时用首尾各一截定位。
// 返回 [start, end, exact] 或 null
export function findSpan(hay, needle) {
  if (needle.length < 2) return null;
  const i = hay.indexOf(needle);
  if (i !== -1) return [i, i + needle.length, true];
  for (const k of [16, 10, 6, 4]) {
    if (needle.length < k * 2) continue;
    const head = needle.slice(0, k), tail = needle.slice(-k);
    let best = null;
    for (let h = hay.indexOf(head); h !== -1; h = hay.indexOf(head, h + 1)) {
      const t = hay.indexOf(tail, h + k);
      if (t === -1) break;
      const len = t + k - h;
      if (len > needle.length * 2.5 + 40) continue;
      if (!best || Math.abs(len - needle.length) < Math.abs(best[1] - best[0] - needle.length)) best = [h, t + k];
    }
    if (best) return [best[0], best[1], false];
  }
  for (const k of [12, 8, 5]) {
    if (needle.length < k) continue;
    const h = hay.indexOf(needle.slice(0, k));
    if (h !== -1) return [h, Math.min(hay.length, h + needle.length), false];
  }
  return null;
}
