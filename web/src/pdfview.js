import { prefs } from './storage.js';
// 右侧 PDF 视图（pdf.js），批注高亮、选区、和源码双向跳转
import './pdfjs-global.js';
import { EventBus, PDFLinkService, PDFViewer } from 'pdfjs-dist/web/pdf_viewer.mjs';
import { api, $, OPEN, toast, projectUrl } from './util.js';
import { KEEP, findSpan, foldChar, projectSource } from '../lib/text.js';
import { formulaBoxes } from '../lib/mathbox.js';
import { changeSpans } from '../lib/diff.js';
import { state, emit, markedItems } from './state.js';

const pdfjsLib = globalThis.pdfjsLib;
pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';

let viewer, eventBus, linkService, doc = null, loadingTask = null;
let restored = false, posReady = false; // 刷新后是否已恢复上次位置
const boxCache = new Map(); // key -> [{page, fx, fy, fw, fh}]
let showFormulas = true; // 公式框常显；关掉后只在鼠标移上去时显示

export function initPdf() {
  showFormulas = prefs.getItem('formulaBoxes') !== '0';
  const container = $('#pdfContainer');
  eventBus = new EventBus();
  linkService = new PDFLinkService({ eventBus });
  viewer = new PDFViewer({ container, viewer: $('#pdfViewer'), eventBus, linkService, textLayerMode: 1, removePageBorders: true });
  linkService.setViewer(viewer);

  eventBus.on('pagesinit', () => {
    viewer.currentScaleValue = prefs.getItem('pdfScale') || 'page-width';
    if (!restored) {
      restored = true;
      // 刷新网页：回到上次看到的页和页内位置
      try {
        const p = JSON.parse(prefs.getItem('pdfPos') || 'null');
        if (p?.page && p.page <= doc.numPages) requestAnimationFrame(() => scrollToPage(p.page, p.frac || 0));
      } catch { /* 记录坏了就从头看 */ }
    }
    posReady = true;
  });
  // 滚动时记下当前页和页内位置
  let posTimer = null;
  container.addEventListener('scroll', () => {
    emit('pdf-scroll');
    if (!posReady) return;
    clearTimeout(posTimer);
    posTimer = setTimeout(() => {
      const pv = pageView(viewer.currentPageNumber);
      if (!pv?.div) return;
      const frac = (container.scrollTop - pv.div.offsetTop) / Math.max(1, pv.div.clientHeight);
      prefs.setItem('pdfPos', JSON.stringify({ page: viewer.currentPageNumber, frac: Math.max(0, Math.min(1, frac)) }));
    }, 300);
  }, { passive: true });
  eventBus.on('scalechanging', ({ scale }) => {
    $('#zoomLabel').textContent = `${Math.round(scale * 100)}%`;
    requestAnimationFrame(() => emit('pdf-layout'));
  });
  eventBus.on('pagesinit', () => requestAnimationFrame(() => emit('pdf-layout')));
  eventBus.on('pagechanging', ({ pageNumber }) => { $('#pageInput').value = pageNumber; });
  eventBus.on('pagerendered', ({ pageNumber }) => { drawPage(pageNumber); drawFormulas(pageNumber); });
  eventBus.on('textlayerrendered', ({ pageNumber }) => drawPage(pageNumber));

  const setScale = (v) => { viewer.currentScaleValue = v; prefs.setItem('pdfScale', String(v)); };
  $('#zoomIn').onclick = () => setScale(Math.min(4, viewer.currentScale * 1.15));
  $('#zoomOut').onclick = () => setScale(Math.max(0.3, viewer.currentScale / 1.15));
  $('#zoomFit').onclick = () => setScale('page-width');

  // Ctrl+滚轮 / 触摸板双指捏合：以鼠标所在位置为中心缩放；不按 Ctrl 的滚轮照常翻页
  let saveTimer = null;
  container.addEventListener('wheel', (ev) => {
    if (!(ev.ctrlKey || ev.metaKey) || !doc) return;
    ev.preventDefault(); // 不让浏览器缩放整个网页
    const dy = ev.deltaMode === 1 ? ev.deltaY * 40 : ev.deltaY; // 按行滚动的鼠标换算成像素
    const cur = viewer.currentScale;
    // 鼠标滚一格（120）约 15%，和 +/- 按钮一致；触摸板捏合的小步长会更细
    const target = Math.min(4, Math.max(0.3, cur * Math.exp(-dy * 0.0012)));
    if (Math.abs(target - cur) < 0.001) return;
    // 记下鼠标下那一点在第几页、页内什么比例的位置
    const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.page');
    const pv = pageView(el ? +el.dataset.pageNumber : viewer.currentPageNumber);
    const r0 = pv?.div.getBoundingClientRect();
    const fx = r0 ? (ev.clientX - r0.left) / r0.width : 0, fy = r0 ? (ev.clientY - r0.top) / r0.height : 0;
    viewer.currentScale = target;
    // 缩放后把这一点挪回鼠标下
    if (r0) {
      const r1 = pv.div.getBoundingClientRect();
      container.scrollTop += r1.top + fy * r1.height - ev.clientY;
      container.scrollLeft += r1.left + fx * r1.width - ev.clientX;
    }
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => prefs.setItem('pdfScale', String(viewer.currentScale)), 300);
  }, { passive: false });
  $('#pageInput').onchange = (e) => { viewer.currentPageNumber = Math.max(1, Math.min(doc?.numPages || 1, +e.target.value)); };
  $('#showMarks').checked = prefs.getItem('showAllMarks') === '1';
  $('#showMarks').onchange = (e) => { prefs.setItem('showAllMarks', e.target.checked ? '1' : '0'); emit('marks-changed'); };

  $('#showFormulas').checked = showFormulas;
  $('#showFormulas').onchange = (e) => setFormulaBoxes(e.target.checked);

  container.addEventListener('mouseup', (ev) => {
    if (ev.detail >= 2) return; // 双击留给跳转
    setTimeout(() => captureSelection(ev), 10);
  });

  // 公式框不接鼠标（不挡拖选文字），悬停和单击按坐标判断
  let hoverRaf = 0, hoverEl = null;
  container.addEventListener('mousemove', (ev) => {
    if (ev.buttons || hoverRaf) return;
    hoverRaf = requestAnimationFrame(() => {
      hoverRaf = 0;
      const f = formulaAt(ev.clientX, ev.clientY);
      const el = f ? f.layer.children[f.index] : null;
      if (el === hoverEl) return;
      hoverEl?.classList.remove('hover');
      el?.classList.add('hover');
      hoverEl = el;
      container.classList.toggle('on-formula', !!el);
    });
  });
  let clickTimer = null;
  container.addEventListener('click', (ev) => {
    if (ev.button !== 0 || ev.detail !== 1 || ev.ctrlKey || ev.metaKey || ev.shiftKey) return;
    if (!window.getSelection()?.isCollapsed) return; // 拖选文字不算点公式
    const f = formulaAt(ev.clientX, ev.clientY);
    if (!f) { if (selectedFormula) selectFormula(null); return; }
    clearTimeout(clickTimer);
    clickTimer = setTimeout(() => pickFormula(f, ev.clientX, ev.clientY), 230); // 等一下，双击就不算单击
  });
  container.addEventListener('dblclick', (ev) => {
    clearTimeout(clickTimer);
    const hit = pointOnPage(ev.clientX, ev.clientY);
    if (!hit) return;
    window.getSelection()?.removeAllRanges();
    emit('hide-menu');
    const text = textAround(ev.clientX, ev.clientY);
    api('GET', `/api/synctex/backward?page=${hit.page}&x=${hit.x}&y=${hit.y}`)
      .then(async (r) => {
        if (!r) return;
        // synctex 只给到行，再按双击处的文字在附近找准位置
        const loc = text ? await api('POST', '/api/locate', { file: r.file, line: r.line, text }).catch(() => null) : null;
        emit('sync-to-source', loc ? { ...r, ...loc } : r);
      })
      .catch(() => {});
  });
}

export async function loadPdf() {
  if (!state.pdf) {
    $('#pdfViewer').replaceChildren();
    $('#pageCount').textContent = '0';
    $('#zoomLabel').textContent = '暂无 PDF';
    return;
  }
  const keep = doc ? { page: viewer.currentPageNumber, scale: viewer.currentScaleValue, top: $('#pdfContainer').scrollTop } : null;
  const url = projectUrl(`/pdf?v=${Math.round(state.pdf.mtime)}`);
  const oldTask = loadingTask;
  const task = pdfjsLib.getDocument({
    url,
    cMapUrl: '/vendor/pdfjs/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: '/vendor/pdfjs/standard_fonts/',
    wasmUrl: '/vendor/pdfjs/wasm/',
    fontExtraProperties: true, // 要字体名来认公式
    iccUrl: '/vendor/pdfjs/iccs/',
  });
  loadingTask = task;
  const newDoc = await task.promise;
  if (loadingTask !== task) { task.destroy(); return; } // 又来了更新的版本
  doc = newDoc;
  boxCache.clear();
  changeCache.clear();
  formulaCache.clear();
  selectedFormula = null;
  viewer.setDocument(doc);
  linkService.setDocument(doc);
  $('#pageCount').textContent = doc.numPages;
  if (keep) {
    eventBus.on('pagesinit', function restore() {
      eventBus.off('pagesinit', restore);
      viewer.currentScaleValue = keep.scale;
      requestAnimationFrame(() => { $('#pdfContainer').scrollTop = keep.top; });
    });
  }
  // 新文档换上去之后再释放旧的（v6 的文档对象没有 destroy，要通过加载任务释放）
  oldTask?.destroy();
}

// 双击处前后的一小段文字（文本层里的字）
function textAround(cx, cy) {
  const pos = document.caretPositionFromPoint?.(cx, cy);
  const node = pos?.offsetNode;
  if (!node || node.nodeType !== 3 || !node.parentElement?.closest('.textLayer')) {
    const el = document.elementFromPoint(cx, cy);
    return el?.closest('.textLayer') ? (el.textContent || '').slice(0, 30) : '';
  }
  const o = pos.offset;
  let t = node.textContent.slice(Math.max(0, o - 8), o + 16);
  let n = node.parentElement;
  while (t.length < 14 && (n = n.nextElementSibling)) t += n.textContent;
  return t;
}

// ---- 坐标换算 ----

function pageView(n) { return viewer?.getPageView(n - 1); }

// 页面内容区（不含边框）的屏幕矩形
function pageBox(pv) {
  return (pv.textLayer?.div || pv.canvas || pv.div).getBoundingClientRect();
}

function pointOnPage(cx, cy) {
  const el = document.elementFromPoint(cx, cy)?.closest('.page');
  if (!el) return null;
  const n = +el.dataset.pageNumber;
  const pv = pageView(n);
  const b = pv.div.getBoundingClientRect();
  const [px, py] = pv.viewport.convertToPdfPoint(cx - b.left - pv.div.clientLeft, cy - b.top - pv.div.clientTop);
  const [, , , ph] = pv.pdfPage.view;
  return { page: n, x: px, y: ph - py };
}

// synctex 框（bp，左上原点，v 为基线）-> 页面比例坐标
function boxToFrac(pv, b) {
  const [x0, y0, x1, y1] = pv.pdfPage.view;
  const pw = x1 - x0, ph = y1 - y0;
  const top = Math.max(0, b.v - b.H), bottom = b.v + Math.max(2, b.H * 0.25);
  return { page: b.page, fx: b.h / pw, fy: top / ph, fw: b.W / pw, fh: (bottom - top) / ph };
}

// ---- 选区 ----

function captureSelection(ev) {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return;
  const text = sel.toString();
  if (!text.trim()) return;
  const range = sel.getRangeAt(0);
  const startEl = (range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement)?.closest('.page');
  if (!startEl || !$('#pdfContainer').contains(startEl)) return;
  const page = +startEl.dataset.pageNumber;
  const pv = pageView(page);
  const pb = pageBox(pv);
  const rects = [...range.getClientRects()]
    .filter((r) => r.width > 1 && r.height > 1 && r.top >= pb.top - 2 && r.bottom <= pb.bottom + 2)
    .map((r) => ({ page, fx: (r.left - pb.left) / pb.width, fy: (r.top - pb.top) / pb.height, fw: r.width / pb.width, fh: r.height / pb.height }));
  const first = range.getClientRects()[0];
  const point = first ? pointOnPage(first.left + 2, first.top + first.height / 2) : null;
  const last = [...range.getClientRects()].pop();
  emit('selection', {
    x: last ? last.right : ev.clientX,
    y: (last ? last.bottom : ev.clientY) + 6,
    quote: text,
    anchor: { source: 'pdf', page, text, rects: mergeRects(rects), point: point ? { x: point.x, y: point.y } : null, pdfMtime: state.pdf?.mtime },
  });
}

function mergeRects(rects) {
  // 同一行的碎片合并
  const out = [];
  for (const r of rects.sort((a, b) => a.fy - b.fy || a.fx - b.fx)) {
    const l = out[out.length - 1];
    if (l && Math.abs(l.fy - r.fy) < 0.004 && r.fx <= l.fx + l.fw + 0.01) {
      const right = Math.max(l.fx + l.fw, r.fx + r.fw);
      l.fw = right - l.fx;
      l.fh = Math.max(l.fh, r.fh);
    } else out.push({ ...r });
  }
  return out.slice(0, 40);
}

// ---- 高亮 ----

// 原文在 PDF 上的位置：synctex 只用来估页码，真正的框按 PDF 文本层里找到的文字来画。
// synctex 对图表环境之后的行会返回整页的框（如第 1 章第 38 行），直接画会糊满一页。

const textCache = new Map(); // `${mtime}:${page}` -> Promise<{ chars, map }>

function pageText(n) {
  const key = `${state.pdf?.mtime}:${n}`;
  if (!textCache.has(key)) {
    textCache.set(key, (async () => {
      const page = await doc.getPage(n);
      const [x0, y0, x1, y1] = page.view;
      const tc = await page.getTextContent();
      let chars = '';
      const map = []; // 每个投影字符 -> 它所在文本块的屏幕位置（页面比例）
      for (const item of tc.items) {
        if (!item.str) continue;
        const [a, b, , d, e, f] = item.transform;
        const fontH = Math.hypot(b, d) || item.height || 10;
        const box = { fx: (e - x0) / (x1 - x0), fy: (y1 - f - fontH * 0.85) / (y1 - y0), fw: item.width / (x1 - x0), fh: (fontH * 1.15) / (y1 - y0) };
        const all = [...item.str];
        all.forEach((ch, k) => {
          for (const f of foldChar(ch)) {
            if (!KEEP.test(f)) continue;
            chars += f;
            map.push({ page: n, box, k, len: all.length });
          }
        });
      }
      return { chars, map };
    })());
  }
  return textCache.get(key);
}

// 一个文本块里第 [k0, k1] 个字符对应的矩形（按字符数平均分宽度）
function subRect({ page, box, len }, k0, k1) {
  const w = box.fw / len;
  return { page, fx: box.fx + w * k0, fy: box.fy, fw: w * (k1 - k0 + 1), fh: box.fh };
}

function spanRects(map, a, b) {
  const out = [];
  let cur = null;
  for (let i = a; i < b; i++) {
    const m = map[i];
    if (cur && cur.m.box === m.box && m.k >= cur.k1) cur.k1 = m.k;
    else { if (cur) out.push(subRect(cur.m, cur.k0, cur.k1)); cur = { m, k0: m.k, k1: m.k }; }
  }
  if (cur) out.push(subRect(cur.m, cur.k0, cur.k1));
  return mergeLines(out);
}

function mergeLines(rects) {
  const out = [];
  for (const r of rects) {
    const l = out[out.length - 1];
    if (l && l.page === r.page && Math.abs(l.fy - r.fy) < 0.006 && r.fx <= l.fx + l.fw + 0.02) {
      const right = Math.max(l.fx + l.fw, r.fx + r.fw);
      l.fx = Math.min(l.fx, r.fx);
      l.fw = right - l.fx;
      l.fh = Math.max(l.fh, r.fh);
    } else out.push({ ...r });
  }
  return out;
}

// 估页码：取若干行的 synctex 结果的中位数；单行返回的框太多（整页兜底）就不信它
let running = 0;
const waiting = [];
function limited(fn) {
  return new Promise((resolve, reject) => {
    const run = () => {
      running++;
      fn().then(resolve, reject).finally(() => { running--; waiting.shift()?.(); });
    };
    running < 4 ? run() : waiting.push(run);
  });
}

async function guessPage(file, lines, fallback) {
  const pages = [];
  const all = await Promise.all(lines.map((l) => limited(() => api('GET', `/api/synctex/forward?file=${encodeURIComponent(file)}&line=${l}`)).catch(() => [])));
  for (const bs of all) {
    if (!bs.length || bs.length > 12) continue;
    pages.push(...bs.filter((b) => b.W > 0 && b.H > 0).map((b) => b.page));
  }
  if (!pages.length) return fallback || null;
  pages.sort((a, b) => a - b);
  return pages[pages.length >> 1];
}

// 在 page-1 .. page+2 的文字里找 needle（源码片段），返回矩形
async function locate(file, lines, sourceSnippet, fallbackPage) {
  const s = await locateSpan(file, lines, sourceSnippet, fallbackPage);
  return s ? spanRects(s.map, s.r[0], s.r[1]) : [];
}

// 返回 { map, r: [起, 止], exact }；exact 时投影串第 k 个字对应 PDF 上第 r[0]+k 个字
async function locateSpan(file, lines, sourceSnippet, fallbackPage) {
  if (!doc) return null;
  const needle = projectSource(sourceSnippet).chars;
  if (needle.length < 2) return null;
  if (fallbackPage) {
    const quick = await searchAround(needle, fallbackPage);
    if (quick?.exact) return quick;
  }
  const center = await guessPage(file, lines, fallbackPage);
  return center ? searchAround(needle, center) : null;
}

// 在 center-1 .. center+2 页的文字里找 needle（投影串）
async function searchAround(needle, center) {
  const pages = [];
  for (let n = Math.max(1, center - 1); n <= Math.min(doc.numPages, center + 2); n++) pages.push(n);
  const parts = await Promise.all(pages.map(pageText));
  const chars = parts.map((x) => x.chars).join('');
  const map = parts.flatMap((x) => x.map);
  // 长段落只用首尾各一截定位，中间按顺序连起来
  let r;
  if (needle.length > 400) {
    const h = findSpan(chars, needle.slice(0, 120));
    const t = h && findSpan(chars.slice(h[1]), needle.slice(-120));
    r = h && t ? [h[0], h[1] + t[1], false] : h && [h[0], h[1], false];
  } else r = findSpan(chars, needle);
  if (!r) return null;
  return { map, r, exact: !!r[2] };
}

// 一处已写入修改在 PDF 上的框：只框新增 / 改写的字；对不上逐字时框整句
const changeCache = new Map();
function changeRects(c) {
  const key = `${c.id}:${c.from}:${c.replacement.length}:${state.pdf?.mtime}`;
  if (!changeCache.has(key)) changeCache.set(key, (async () => {
    if (!c.replacement.trim()) return [];
    const s = await locateSpan(c.file, [...new Set([c.lineStart, c.lineEnd])], c.replacement, null);
    if (!s) return [];
    if (!s.exact) return spanRects(s.map, s.r[0], s.r[1]);
    const proj = projectSource(c.replacement);
    const out = [];
    changeSpans(c.original, c.replacement).ins.forEach((span, g) => {
      let k0 = -1, k1 = -1;
      proj.map.forEach((off, k) => { if (off >= span.from && off < span.to) { if (k0 < 0) k0 = k; k1 = k; } });
      if (k0 >= 0) out.push(...spanRects(s.map, s.r[0] + k0, s.r[0] + k1 + 1).map((r) => ({ ...r, g }))); // g：第几处改动
    });
    return out;
  })().catch(() => []));
  return changeCache.get(key);
}

function linesOf(it) {
  const { lineStart: a, lineEnd: b } = it.anchor;
  return [...new Set([a, Math.round((a + b) / 2), b, Math.min(b, a + 1)])];
}

async function boxesFor(it) {
  // 选区矩形只在同一版 PDF 上有效，编译后重新按文字找
  if (it.anchor.rects?.length && it.anchor.pdfMtime && state.pdf && Math.abs(it.anchor.pdfMtime - state.pdf.mtime) < 1) return it.anchor.rects;
  const key = `${it.id}:${it.anchor.file}:${it.anchor.lineStart}:${it.anchor.quote.length}:${state.pdf?.mtime}`;
  if (!boxCache.has(key)) boxCache.set(key, (it.kind === 'formula' ? formulaRects(it) : locate(it.anchor.file, linesOf(it), it.anchor.quote, it.anchor.page)).catch(() => []));
  return boxCache.get(key);
}

// 公式审核的条目：用 synctex 找到页和高度，取那里的独立公式框（公式文字和源码对不上，不能按文字找）
async function formulaRects(it) {
  const { lineStart: a, lineEnd: b } = it.anchor;
  const lines = [...new Set([Math.min(b, a + 1), Math.round((a + b) / 2), Math.max(a, b - 1)])];
  const all = await Promise.all(lines.map((l) => limited(() => api('GET', `/api/synctex/forward?file=${encodeURIComponent(it.anchor.file)}&line=${l}`)).catch(() => [])));
  const hits = all.filter((bs) => bs.length && bs.length <= 12).flat().filter((x) => x.W > 0 && x.H > 0);
  if (!hits.length) return [];
  const page = hits.map((x) => x.page).sort((m, n) => m - n)[hits.length >> 1];
  const pdfPage = await doc.getPage(page);
  const ys = hits.filter((x) => x.page === page).map((x) => boxToFrac({ pdfPage }, x));
  const top = Math.min(...ys.map((r) => r.fy)), bot = Math.max(...ys.map((r) => r.fy + r.fh));
  const boxes = (await formulasOf(page)).filter((f) => f.kind === 'display');
  let best = null, bestScore = -Infinity;
  for (const f of boxes) {
    const overlap = Math.min(bot, f.fy + f.fh) - Math.max(top, f.fy);
    const score = overlap > 0 ? overlap : -Math.abs((f.fy + f.fh / 2) - (top + bot) / 2);
    if (score > bestScore) { best = f; bestScore = score; }
  }
  if (!best || bestScore < -0.05) return ys.map((r) => ({ ...r, page }));
  return [{ page, fx: best.fx, fy: best.fy, fw: best.fw, fh: best.fh }];
}

function hlLayer(pv) {
  let layer = pv.div.querySelector('.hl-layer:not(.flash-layer)');
  if (!layer) {
    layer = document.createElement('div');
    layer.className = 'hl-layer';
    pv.div.append(layer);
  }
  return layer;
}

// ---- 公式框 ----
// 按字体和字认出公式，在网页上画框（不改 PDF）。字体名要等页面画过、字体加载后才拿得到。

const formulaCache = new Map(); // `${mtime}:${page}` -> Promise<boxes>
let selectedFormula = null; // { page, index }

function formulasOf(n) {
  const key = `${state.pdf?.mtime}:${n}`;
  if (!formulaCache.has(key)) {
    const job = (async () => {
      const page = await doc.getPage(n);
      const [x0, y0, x1, y1] = page.view;
      const tc = await page.getTextContent();
      let missing = 0;
      const items = tc.items.filter((it) => typeof it.str === 'string').map((it) => {
        const [, b, , d, e, f] = it.transform;
        const fh = Math.hypot(b, d) || it.height || 10;
        let font = '';
        if (page.commonObjs.has(it.fontName)) font = page.commonObjs.get(it.fontName)?.name || '';
        else missing++;
        return { str: it.str, font, x: (e - x0) / (x1 - x0), y: (y1 - f - fh * 0.85) / (y1 - y0), w: it.width / (x1 - x0), h: (fh * 1.15) / (y1 - y0) };
      });
      if (missing) formulaCache.delete(key); // 字体还没加载完，下次重算
      return formulaBoxes(items).map((b) => ({ ...b, page: n }));
    })().catch(() => []);
    formulaCache.set(key, job);
  }
  return formulaCache.get(key);
}

async function drawFormulas(n) {
  const pv = pageView(n);
  if (!pv?.div || !doc) return;
  const boxes = await formulasOf(n);
  if (!pv.div.isConnected) return;
  let layer = pv.div.querySelector('.fx-layer');
  if (!layer) {
    layer = document.createElement('div');
    layer.className = 'fx-layer';
    pv.div.append(layer);
  }
  layer.classList.toggle('hover-only', !showFormulas);
  layer.boxes = boxes;
  layer.replaceChildren(...boxes.map((b, i) => {
    const d = document.createElement('div');
    d.className = `fbox ${b.kind}${selectedFormula?.page === n && selectedFormula.index === i ? ' selected' : ''}`;
    Object.assign(d.style, { left: `${b.fx * 100}%`, top: `${b.fy * 100}%`, width: `${b.fw * 100}%`, height: `${b.fh * 100}%` });
    return d;
  }));
}

export function setFormulaBoxes(on) {
  showFormulas = !!on;
  prefs.setItem('formulaBoxes', on ? '1' : '0');
  document.querySelectorAll('.fx-layer').forEach((l) => l.classList.toggle('hover-only', !showFormulas));
}

// 鼠标下的公式（重叠时取最小的框）
function formulaAt(cx, cy) {
  const pageEl = document.elementFromPoint(cx, cy)?.closest('.page');
  const layer = pageEl?.querySelector('.fx-layer');
  if (!layer?.boxes?.length) return null;
  const r = layer.getBoundingClientRect();
  const fx = (cx - r.left) / r.width, fy = (cy - r.top) / r.height;
  let best = -1;
  layer.boxes.forEach((b, i) => {
    if (fx < b.fx || fx > b.fx + b.fw || fy < b.fy || fy > b.fy + b.fh) return;
    if (best < 0 || b.fw * b.fh < layer.boxes[best].fw * layer.boxes[best].fh) best = i;
  });
  return best < 0 ? null : { page: +pageEl.dataset.pageNumber, index: best, box: layer.boxes[best], layer };
}

function selectFormula(f) {
  document.querySelectorAll('.fbox.selected').forEach((el) => el.classList.remove('selected'));
  selectedFormula = f ? { page: f.page, index: f.index } : null;
  if (f) pageView(f.page)?.div.querySelector('.fx-layer')?.children[f.index]?.classList.add('selected');
}

// 单击公式：找到源码里那一段，左侧选中，弹出批注 / 润色菜单
async function pickFormula(f, cx, cy) {
  selectFormula(f);
  const pv = pageView(f.page);
  const [x0, y0, x1, y1] = pv.pdfPage.view;
  const b = f.box;
  const x = (b.fx + b.fw / 2) * (x1 - x0), y = (b.fy + b.fh / 2) * (y1 - y0);
  const r = await api('GET', `/api/synctex/backward?page=${f.page}&x=${x}&y=${y}`).catch(() => null);
  const loc = r && await api('POST', '/api/formula', { file: r.file, line: r.line, kind: b.kind, before: b.before, after: b.after }).catch(() => null);
  if (!loc) return toast('没找到这个公式对应的源码');
  emit('sync-to-source', { file: loc.file, line: loc.line, from: loc.from, to: loc.to });
  const rect = pv.div.querySelector('.fx-layer')?.children[f.index]?.getBoundingClientRect();
  emit('selection', {
    x: rect ? rect.left : cx, y: (rect ? rect.bottom : cy) + 6,
    quote: loc.quote, formula: true,
    anchor: { source: 'source', file: loc.file, from: loc.from, to: loc.to, quote: loc.quote },
  });
}

// 高亮里的公式：首尾两块高亮之间（按阅读顺序）的公式框，或和高亮叠在一起的，一起框上
// 中心在同一行就比左右，否则比上下（都用中心，公式框比正文高，用上沿比会错）
const readOrder = (a, b) => {
  const dy = a.fy + a.fh / 2 - (b.fy + b.fh / 2);
  return Math.abs(dy) < Math.max(a.fh, b.fh) * 0.4 ? a.fx - b.fx : dy;
};

function formulasWithin(rects, formulas, n, morePrev, moreNext) {
  const on = rects.filter((r) => r.page === n);
  if (!on.length && !(morePrev && moreNext)) return [];
  const sorted = [...on].sort(readOrder);
  const first = sorted[0], last = sorted[sorted.length - 1];
  const overlaps = (f) => on.some((r) => f.fx < r.fx + r.fw && r.fx < f.fx + f.fw && f.fy < r.fy + r.fh && r.fy < f.fy + f.fh);
  return formulas.filter((f) => {
    if (overlaps(f)) return true;
    const c = { fx: f.fx + f.fw / 2, fy: f.fy + f.fh / 2, fh: 0.001 };
    const afterFirst = morePrev || !first || readOrder(first, c) < 0;
    const beforeLast = moreNext || !last || readOrder(c, last) < 0;
    return on.length > 1 || morePrev || moreNext ? afterFirst && beforeLast : false;
  }).map((f) => ({ page: n, fx: f.fx, fy: f.fy, fw: f.fw, fh: f.fh }));
}

function withFormulas(rects, formulas, n) {
  const pages = rects.map((r) => r.page);
  return formulasWithin(rects, formulas, n, pages.some((p) => p < n), pages.some((p) => p > n));
}

const drawGen = new Map();

async function drawPage(n) {
  const pv = pageView(n);
  if (!pv?.div) return;
  const layer = hlLayer(pv);
  const items = markedItems(OPEN);
  const gen = (drawGen.get(n) || 0) + 1;
  drawGen.set(n, gen);
  const near = items.filter((it) => !it.anchor.page || Math.abs(it.anchor.page - n) <= 3);
  const [boxes, chg, formulas] = await Promise.all([Promise.all(near.map((it) => boxesFor(it))), Promise.all((state.changes || []).map(changeRects)), formulasOf(n)]);
  if (drawGen.get(n) !== gen) return;
  const parts = [];
  (state.changes || []).forEach((c, i) => {
    for (const r of chg[i]) if (r.page === n) parts.push({ chg: c, r });
    // 每处改动单独看，免得把两处改动之间没改的公式也标黄
    const groups = new Map();
    for (const r of chg[i]) { const k = r.g ?? -1; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
    for (const rs of groups.values()) for (const r of withFormulas(rs, formulas, n)) parts.push({ chg: c, r });
  });
  near.forEach((it, i) => {
    for (const r of boxes[i]) if (r.page === n) parts.push({ it, r });
    if (it.kind !== 'formula') for (const r of withFormulas(boxes[i], formulas, n)) parts.push({ it, r });
  });
  layer.replaceChildren(...parts.map(({ it, chg: c, r }) => {
    const d = document.createElement('div');
    if (c) {
      d.className = 'hl chg';
      Object.assign(d.style, { left: `${r.fx * 100}%`, top: `${r.fy * 100}%`, width: `${r.fw * 100}%`, height: `${r.fh * 100}%` });
      return d;
    }
    d.className = it.id === state.activeId ? `hl active st-${it.status}` : `hl other`;
    Object.assign(d.style, { left: `${r.fx * 100}%`, top: `${r.fy * 100}%`, width: `${r.fw * 100}%`, height: `${r.fh * 100}%` });
    return d;
  }));
}

export function redrawAll() {
  if (!viewer || !doc) return;
  for (let i = 1; i <= doc.numPages; i++) {
    const pv = pageView(i);
    if (pv?.div?.querySelector('canvas, .canvasWrapper')) drawPage(i);
  }
}

// ---- 给注释栏的卡片对齐用 ----

export const pdfReady = () => !!doc;

// 某页某处（页内比例 fy）在 PDF 内容里的纵向位置（像素，随缩放变化，所以每次现算）
export function pageOffset(page, fy) {
  const pv = pageView(page);
  if (!pv?.div) return null;
  return pv.div.offsetTop + pv.div.clientTop + fy * pv.div.clientHeight;
}

// 一条批注在 PDF 上的位置：{ page, fy }，找不到返回 null
export async function itemAnchor(it) {
  const rs = await boxesFor(it);
  if (!rs.length) return null;
  const r = rs.reduce((m, x) => (x.page < m.page || (x.page === m.page && x.fy < m.fy) ? x : m));
  return { page: r.page, fy: r.fy };
}

// ---- 跳转 ----

// 精确滚到某页的某个位置（frac：页内从上往下的比例）
function scrollToPage(page, frac) {
  const pv = pageView(page);
  if (!pv?.div) return;
  $('#pdfContainer').scrollTop = pv.div.offsetTop + frac * pv.div.clientHeight;
}

function scrollToFrac(page, fy, fx = 0) {
  const pv = pageView(page);
  if (!pv) return;
  const container = $('#pdfContainer');
  const top = pv.div.offsetTop + pv.div.clientTop + fy * (pv.div.clientHeight) - container.clientHeight * 0.3;
  container.scrollTo({ top: Math.max(0, top), behavior: 'auto' });
}

function flashRect(r) {
  const pv = pageView(r.page);
  if (!pv?.div) return;
  const d = document.createElement('div');
  d.className = 'hl flash';
  Object.assign(d.style, { left: `${r.fx * 100}%`, top: `${r.fy * 100}%`, width: `${Math.max(r.fw, 0.02) * 100}%`, height: `${r.fh * 100}%` });
  let fl = pv.div.querySelector('.flash-layer');
  if (!fl) { fl = document.createElement('div'); fl.className = 'hl-layer flash-layer'; pv.div.append(fl); }
  fl.append(d);
  setTimeout(() => d.remove(), 2000);
}

export async function revealItemInPdf(it) {
  if (!doc) return;
  const rs = await boxesFor(it);
  if (rs.length) { scrollToFrac(rs[0].page, rs[0].fy); rs.slice(0, 6).forEach(flashRect); }
  else if (it.anchor.page) viewer.currentPageNumber = it.anchor.page;
}

export async function syncToPdf(file, line, snippet = '') {
  if (!doc) return;
  // 先按文字找；找不到再退回 synctex 的框（框太多说明是整页兜底，只翻到那一页）
  let rs = snippet ? await locate(file, [line], snippet, null) : [];
  if (!rs.length) {
    const bs = await api('GET', `/api/synctex/forward?file=${encodeURIComponent(file)}&line=${line}`);
    if (!bs.length) return;
    if (bs.length > 12) { viewer.currentPageNumber = bs[0].page; return; }
    const byNum = new Map(await Promise.all([...new Set(bs.map((b) => b.page))].map((n) => doc.getPage(n).then((pg) => [n, pg]))));
    rs = bs.filter((b) => b.W > 0 && b.H > 0).map((b) => boxToFrac({ pdfPage: byNum.get(b.page) }, b));
  }
  if (!rs.length) return;
  scrollToFrac(rs[0].page, rs[0].fy);
  rs.slice(0, 6).forEach(flashRect);
}
