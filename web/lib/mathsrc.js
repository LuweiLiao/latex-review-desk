// 源码里的公式段，以及“PDF 上点到的公式”对应源码里的哪一段。浏览器和服务端共用。
import { normalizeText, projectSource } from './text.js';

const DISPLAY_ENV = /^(equation|align|gather|multline|flalign|alignat|eqnarray|displaymath|math|dmath)\*?$/;

/** 返回 [{ kind: 'inline'|'display', from, to }]，按位置排序；独立公式取整个环境（含 \begin..\end） */
export function mathSegments(text) {
  const out = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '%') { const e = text.indexOf('\n', i); i = e === -1 ? n : e; continue; }
    if (c === '\\') {
      const env = /^\\begin\s*\{([a-zA-Z]+\*?)\}/.exec(text.slice(i, i + 40));
      if (env && DISPLAY_ENV.test(env[1])) {
        const name = env[1].replace('*', '\\*');
        const re = new RegExp(`\\\\end\\s*\\{${name}\\}`, 'g');
        re.lastIndex = i + env[0].length;
        const m = re.exec(text);
        const to = m ? m.index + m[0].length : n;
        out.push({ kind: env[1] === 'math' ? 'inline' : 'display', from: i, to });
        i = to;
        continue;
      }
      const d = text[i + 1];
      if (d === '[' || d === '(') {
        const close = d === '[' ? '\\]' : '\\)';
        const e = findClose(text, i + 2, close);
        out.push({ kind: d === '[' ? 'display' : 'inline', from: i, to: e });
        i = e;
        continue;
      }
      i += 2; // \$、\% 等转义
      continue;
    }
    if (c === '$') {
      const dbl = text[i + 1] === '$';
      const e = findClose(text, i + (dbl ? 2 : 1), dbl ? '$$' : '$');
      out.push({ kind: dbl ? 'display' : 'inline', from: i, to: e });
      i = e;
      continue;
    }
    i++;
  }
  return out;
}

// 找收尾符号，跳过转义；找不到就到段落结束（空行）为止
function findClose(text, i, close) {
  for (let j = i; j < text.length; j++) {
    const c = text[j];
    if (c === '\\') {
      if (close[0] === '\\' && text.startsWith(close, j)) return j + close.length;
      j++; // 转义的下一个字不算
      continue;
    }
    if (c === '%') { const e = text.indexOf('\n', j); if (e === -1) return text.length; j = e; continue; }
    if (close[0] === '$' && text.startsWith(close, j)) return j + close.length;
    // 行内 $ 没配对：到空行为止，不吞掉后面的段落
    if (close === '$' && c === '\n' && /^\n[ \t]*\n/.test(text.slice(j, j + 40))) return j;
  }
  return text.length;
}

function lineAt(text, off) {
  let line = 1;
  for (let k = 0; k < off && k < text.length; k++) if (text.charCodeAt(k) === 10) line++;
  return line;
}

// 比前后文只看文字：PDF 里的编号、引用数字和源码对不上，去掉数字
const letters = (s) => s.replace(/\p{N}/gu, '');

function commonSuffix(a, b) {
  let k = 0;
  while (k < a.length && k < b.length && a[a.length - 1 - k] === b[b.length - 1 - k]) k++;
  return k;
}
function commonPrefix(a, b) {
  let k = 0;
  while (k < a.length && k < b.length && a[k] === b[k]) k++;
  return k;
}

/**
 * PDF 上点到的公式 -> 源码里的那一段。
 * hint: { line（synctex 给的行）, kind, before, after（PDF 上公式前后的字） }
 * 返回 { from, to, quote, kind, line } 或 null
 */
export function resolveFormula(text, { line = 1, kind, before = '', after = '' } = {}, segs = mathSegments(text)) {
  const W = 15;
  const cand = segs.map((s) => ({ ...s, l0: lineAt(text, s.from), l1: lineAt(text, s.to) }))
    .filter((s) => s.l1 >= line - W && s.l0 <= line + W);
  if (!cand.length) return null;
  const pb = letters(normalizeText(before)).slice(-16);
  const pa = letters(normalizeText(after)).slice(0, 16);
  let best = null;
  for (const s of cand) {
    // 前后文：把别的公式挖掉再投影，只剩正文
    const ctxB = letters(plain(text, segs, Math.max(0, s.from - 400), s.from)).slice(-16);
    const ctxA = letters(plain(text, segs, s.to, Math.min(text.length, s.to + 400))).slice(0, 16);
    const dist = line >= s.l0 && line <= s.l1 ? 0 : Math.min(Math.abs(line - s.l0), Math.abs(line - s.l1));
    const score = Math.min(8, commonSuffix(pb, ctxB)) + Math.min(8, commonPrefix(pa, ctxA)) + (kind && s.kind === kind ? 3 : 0) - dist * 0.3;
    if (!best || score > best.score) best = { s, score };
  }
  const s = best.s;
  return { from: s.from, to: s.to, quote: text.slice(s.from, s.to), kind: s.kind, line: s.l0 };
}

// [a, b) 里去掉公式后的正文投影
function plain(text, segs, a, b) {
  let out = '', pos = a;
  for (const s of segs) {
    if (s.to <= a || s.from >= b) continue;
    if (s.from > pos) out += projectSource(text, pos, s.from).chars;
    pos = Math.max(pos, s.to);
  }
  if (pos < b) out += projectSource(text, pos, b).chars;
  return out;
}
