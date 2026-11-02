// 论文源文件的读写。内部统一用 \n 换行、去掉 BOM，写回时恢复文件原来的换行风格。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export class TexFiles {
  constructor(cfg) {
    this.cfg = cfg;
    this.root = cfg.projectRoot;
    this.cache = new Map(); // rel -> { mtimeMs, text, eol, bom }
  }

  // 只允许访问 sourceDirs / extraSources 里的 .tex 文件
  resolve(rel) {
    if (typeof rel !== 'string' || !rel) throw new Error('缺少文件路径');
    const norm = rel.replace(/\\/g, '/').replace(/^\.\//, '');
    const abs = path.resolve(this.root, norm);
    const relBack = path.relative(this.root, abs).replace(/\\/g, '/');
    if (relBack.startsWith('..') || path.isAbsolute(relBack)) throw new Error(`路径越界：${rel}`);
    if (!relBack.endsWith('.tex')) throw new Error(`只允许 .tex 文件：${rel}`);
    const allowed =
      this.cfg.extraSources.includes(relBack) ||
      this.cfg.sourceDirs.some((d) => relBack.startsWith(d.replace(/\/$/, '') + '/'));
    if (!allowed) throw new Error(`不在允许的源码目录里：${rel}`);
    return { rel: relBack, abs };
  }

  list() {
    const out = [];
    for (const d of this.cfg.sourceDirs) {
      const dir = path.join(this.root, d);
      if (!fs.existsSync(dir)) continue;
      const walk = (sub) => {
        for (const ent of fs.readdirSync(path.join(dir, sub), { withFileTypes: true })) {
          const relSub = sub ? `${sub}/${ent.name}` : ent.name;
          if (ent.isDirectory()) walk(relSub);
          else if (ent.name.endsWith('.tex')) out.push(`${d.replace(/\/$/, '')}/${relSub}`);
        }
      };
      walk('');
    }
    for (const f of this.cfg.extraSources) if (fs.existsSync(path.join(this.root, f))) out.push(f);
    return out.sort(fileOrder);
  }

  read(rel) {
    const { rel: r, abs } = this.resolve(rel);
    const st = fs.statSync(abs);
    const hit = this.cache.get(r);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit;
    let raw = fs.readFileSync(abs, 'utf8');
    const bom = raw.charCodeAt(0) === 0xfeff;
    if (bom) raw = raw.slice(1);
    const eol = raw.includes('\r\n') ? '\r\n' : '\n';
    const text = raw.replace(/\r\n/g, '\n');
    const entry = { rel: r, mtimeMs: st.mtimeMs, size: st.size, text, eol, bom, hash: hashText(text) };
    this.cache.set(r, entry);
    return entry;
  }

  write(rel, text) {
    const { rel: r, abs } = this.resolve(rel);
    const cur = this.read(r);
    let out = text.replace(/\r\n/g, '\n');
    if (cur.eol === '\r\n') out = out.replace(/\n/g, '\r\n');
    if (cur.bom) out = String.fromCharCode(0xfeff) + out;
    const tmp = abs + '.thesis-review.tmp';
    fs.writeFileSync(tmp, out, 'utf8');
    fs.renameSync(tmp, abs);
    this.cache.delete(r);
    return this.read(r);
  }

  // 网页编辑器保存：baseHash 是网页打开（或上次保存）时的版本。
  // 磁盘上的内容已经变了（别的编辑器保存、接受了方案）就不覆盖，返回 conflict。
  save(rel, text, baseHash, force = false) {
    const cur = this.read(rel);
    const incoming = String(text).replace(/\r\n/g, '\n');
    if (!force && baseHash && cur.hash !== baseHash && cur.text !== incoming) {
      return { conflict: true, hash: cur.hash, text: cur.text };
    }
    if (cur.text === incoming) return { conflict: false, hash: cur.hash, unchanged: true };
    const next = this.write(rel, incoming);
    return { conflict: false, hash: next.hash };
  }

  invalidate(rel) {
    if (rel) this.cache.delete(rel);
    else this.cache.clear();
  }
}

// 章节文件按 chapter 序号排，其余放后面
function fileOrder(a, b) {
  const rank = (f) => {
    const m = /chapter(\d+)/.exec(f);
    if (m) return 100 + Number(m[1]);
    if (/abstract/.test(f)) return 10;
    if (/abbr/.test(f)) return 20;
    if (/master|global/.test(f)) return 900;
    return 500;
  };
  return rank(a) - rank(b) || a.localeCompare(b);
}

export function hashText(text) {
  return crypto.createHash('sha1').update(text).digest('hex').slice(0, 16);
}

// ---- 文本坐标工具（offset 都基于 \n 换行的文本） ----

export function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

export function offsetToLine(starts, off) {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= off) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1; // 1 起
}

export function lineToOffset(starts, line) {
  const i = Math.min(Math.max(line, 1), starts.length) - 1;
  return starts[i];
}

export function findAll(text, needle) {
  const out = [];
  if (!needle) return out;
  let i = text.indexOf(needle);
  while (i !== -1) {
    out.push(i);
    i = text.indexOf(needle, i + 1);
  }
  return out;
}

export function nearest(offsets, target) {
  let best = -1, bestD = Infinity;
  for (const o of offsets) {
    const d = Math.abs(o - target);
    if (d < bestD) { best = o; bestD = d; }
  }
  return best;
}

// 所在的章节标题，形如 “第3章标题 · 3.2节标题”
const HEADING = /\\(chapter|section|subsection|subsubsection)\*?\s*(?:\[[^\]]*\])?\s*\{/g;
const LEVEL = { chapter: 0, section: 1, subsection: 2, subsubsection: 3 };

export function headings(text) {
  const out = [];
  HEADING.lastIndex = 0;
  let m;
  while ((m = HEADING.exec(text))) {
    // 跳过被 % 注释掉的
    const ls = text.lastIndexOf('\n', m.index) + 1;
    if (/(^|[^\\])%/.test(text.slice(ls, m.index))) continue;
    const title = readBraced(text, m.index + m[0].length - 1);
    out.push({ level: LEVEL[m[1]], kind: m[1], offset: m.index, title: cleanTitle(title) });
  }
  return out;
}

export function sectionAt(text, off) {
  const chain = [];
  for (const h of headings(text)) {
    if (h.offset > off) break;
    chain.length = Math.min(chain.length, h.level);
    chain[h.level] = h.title;
  }
  return chain.filter(Boolean).slice(-2).join(' · ');
}

function readBraced(text, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < text.length && i < openIdx + 400; i++) {
    const c = text[i];
    if (c === '\\') { i++; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return text.slice(openIdx + 1, i);
  }
  return text.slice(openIdx + 1, openIdx + 80);
}

function cleanTitle(t) {
  return t.replace(/\\[a-zA-Z]+\*?(\[[^\]]*\])?/g, '').replace(/[{}$]/g, '').replace(/\s+/g, ' ').trim();
}

// 取包含 [s, e) 的自然段（以空行分隔），太长就退到前后几行
export function paragraphRange(text, s, e, maxLen = 6000) {
  const blank = /\n[ \t]*\n/g;
  let ps = 0, pe = text.length;
  let m;
  blank.lastIndex = 0;
  while ((m = blank.exec(text))) {
    const end = m.index + m[0].length;
    if (end <= s) ps = end;
    else if (m.index >= e) { pe = m.index; break; }
  }
  if (pe - ps > maxLen) {
    ps = Math.max(ps, text.lastIndexOf('\n', Math.max(0, s - 1)) + 1);
    const nl = text.indexOf('\n', e);
    pe = Math.min(pe, nl === -1 ? text.length : nl);
  }
  return [ps, pe];
}
