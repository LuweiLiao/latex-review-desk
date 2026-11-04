// 把一段源码拆成“正文段”：以空行、标题、\label、公式/图表环境为界，只留连续的正文行。
// 返回 [{ start, end }]（offset 基于 \n 换行的文本，首尾空白已去掉）
import { normalizeText } from './anchors.js';

// 整行是这些命令时，不算正文，并且把前后断开
const STRUCT = /^\\(chapter|section|subsection|subsubsection|paragraph|label|caption|includegraphics|centering|vspace|hspace|newpage|clearpage|cleardoublepage|bibliography|bibliographystyle|input|include|appendix|backmatter|mainmatter|frontmatter|maketitle|tableofcontents|noindent\s*$|par\s*$|hline|toprule|midrule|bottomrule)\b/;
// 这些环境整块跳过
const SKIP_ENV = /^(equation|align|gather|multline|eqnarray|flalign|alignat|split|cases|figure|table|tabular|tabularx|longtable|subfigure|algorithm|algorithmic|lstlisting|verbatim|minted|tikzpicture|thebibliography|displaymath|math)\*?$/;

export function splitParagraphs(text, from = 0, to = text.length, minChars = 15) {
  // A main document also contains a preamble; only its document body is prose.
  const body = /^[ \t]*\\begin\s*\{document\}/m.exec(text);
  if (body) from = Math.max(from, body.index + body[0].length);
  const segs = [];
  let cur = null; // { start, end }
  const close = () => {
    if (cur && normalizeText(text.slice(cur.start, cur.end)).length >= minChars) segs.push(trim(text, cur));
    cur = null;
  };
  let skipDepth = 0; // 在要跳过的环境里的嵌套层数
  let inDisplay = false; // \[ ... \]
  let pos = from;
  while (pos < to) {
    let nl = text.indexOf('\n', pos);
    if (nl === -1 || nl > to) nl = to;
    const raw = text.slice(pos, nl);
    const line = raw.replace(/(^|[^\\])%.*$/, '$1').trim();
    const lineStart = pos, lineEnd = nl;
    pos = nl + 1;

    if (inDisplay) { if (line.includes('\\]')) inDisplay = false; continue; }
    if (skipDepth > 0) {
      for (const m of line.matchAll(/\\(begin|end)\{([^}]+)\}/g)) {
        if (!SKIP_ENV.test(m[2])) continue;
        skipDepth += m[1] === 'begin' ? 1 : -1;
      }
      continue;
    }
    const begin = /^\\begin\{([^}]+)\}/.exec(line);
    if (begin && SKIP_ENV.test(begin[1])) {
      close();
      // 同一行里就结束的（如 \begin{equation} x \end{equation}）不进入跳过状态
      if (!new RegExp(`\\\\end\\{${begin[1].replace('*', '\\*')}\\}`).test(line)) skipDepth = 1;
      continue;
    }
    if (line.startsWith('\\[')) { close(); if (!line.includes('\\]')) inDisplay = true; continue; }
    if (!line || STRUCT.test(line) || /^\\(begin|end)\{/.test(line)) { close(); continue; }
    // \item 每项自成一段
    if (/^\\item\b/.test(line)) close();
    if (!cur) cur = { start: lineStart, end: lineEnd };
    else cur.end = lineEnd;
  }
  close();
  return segs;
}

function trim(text, { start, end }) {
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;
  return { start, end };
}
