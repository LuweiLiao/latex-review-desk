// 把 PDF 上选中的文字对回 LaTeX 源码。
// PDF 文本层里没有命令、注释，公式也变了样，所以两边都“投影”成只含文字和数字的字符串再比，
// 投影串里每个字符记住它在源码里的位置。
import { lineStarts, offsetToLine, lineToOffset } from './texfiles.js';
import { findSpan, normalizeText, projectSource } from '../web/lib/text.js';

export { normalizeText, projectSource };

// 在源码的 [from, to) 里找选中的 PDF 文本，返回源码 offset 区间
export function matchInRange(text, pdfText, from, to) {
  const { chars, map } = projectSource(text, from, to);
  const r = findSpan(chars, normalizeText(pdfText));
  if (!r) return null;
  return { start: map[r[0]], end: endOf(text, map[r[1] - 1]), exact: r[2] };
}

function endOf(text, off) {
  // 一个“字符”可能是代理对
  const cp = text.codePointAt(off);
  return off + (cp > 0xffff ? 2 : 1);
}

// 以 synctex 给的行为中心，逐步放大窗口查找
export function locatePdfSelection(text, pdfText, hintLine) {
  const starts = lineStarts(text);
  const windows = hintLine ? [3, 12, 40, 150] : [];
  for (const w of windows) {
    const from = lineToOffset(starts, hintLine - w);
    const to = hintLine + w + 1 > starts.length ? text.length : lineToOffset(starts, hintLine + w + 1);
    const r = matchInRange(text, pdfText, from, to);
    if (r) return r;
  }
  const r = matchInRange(text, pdfText, 0, text.length);
  return r;
}

// 已保存的锚点在当前文本中的位置：原文还在就返回最靠近旧行号的那处
export function relocate(text, quote, oldLine) {
  if (!quote) return null;
  const starts = lineStarts(text);
  const target = lineToOffset(starts, oldLine || 1);
  let best = -1, bestD = Infinity;
  for (let i = text.indexOf(quote); i !== -1; i = text.indexOf(quote, i + 1)) {
    const d = Math.abs(i - target);
    if (d < bestD) { best = i; bestD = d; }
  }
  if (best === -1) return null;
  return {
    start: best,
    end: best + quote.length,
    lineStart: offsetToLine(starts, best),
    lineEnd: offsetToLine(starts, best + quote.length),
  };
}
