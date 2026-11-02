// 右侧 PDF 视图（pdf.js），批注高亮、选区、和源码双向跳转
import './pdfjs-global.js';
import { EventBus, PDFLinkService, PDFViewer } from 'pdfjs-dist/web/pdf_viewer.mjs';
import { api, $, OPEN } from './util.js';
import { KEEP, findSpan, projectSource } from '../lib/text.js';
import { state, emit, markedItems } from './state.js';

const pdfjsLib = globalThis.pdfjsLib;
pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';

let viewer, eventBus, linkService, doc = null, loadingTask = null;
const boxCache = new Map(); // key -> [{page, fx, fy, fw, fh}]

export function initPdf() {
  const container = $('#pdfContainer');
  eventBus = new EventBus();
  linkService = new PDFLinkService({ eventBus });
  viewer = new PDFViewer({ container, viewer: $('#pdfViewer'), eventBus, linkService, textLayerMode: 1, removePageBorders: true });
  linkService.setViewer(viewer);

  eventBus.on('pagesinit', () => {
    viewer.currentScaleValue = localStorage.getItem('pdfScale') || 'page-width';
  });
  eventBus.on('scalechanging', ({ scale }) => {
    $('#zoomLabel').textContent = `${Math.round(scale * 100)}%`;
  });
  eventBus.on('pagechanging', ({ pageNumber }) => { $('#pageInput').value = pageNumber; });
  eventBus.on('pagerendered', ({ pageNumber }) => drawPage(pageNumber));
  eventBus.on('textlayerrendered', ({ pageNumber }) => drawPage(pageNumber));

  const setScale = (v) => { viewer.currentScaleValue = v; localStorage.setItem('pdfScale', String(v)); };
  $('#zoomIn').onclick = () => setScale(Math.min(4, viewer.currentScale * 1.15));
  $('#zoomOut').onclick = () => setScale(Math.max(0.3, viewer.currentScale / 1.15));
  $('#zoomFit').onclick = () => setScale('page-width');
  $('#pageInput').onchange = (e) => { viewer.currentPageNumber = Math.max(1, Math.min(doc?.numPages || 1, +e.target.value)); };
  $('#showMarks').checked = localStorage.getItem('showAllMarks') === '1';
  $('#showMarks').onchange = (e) => { localStorage.setItem('showAllMarks', e.target.checked ? '1' : '0'); emit('marks-changed'); };

  container.addEventListener('mouseup', (ev) => {
    if (ev.detail >= 2) return; // 双击留给跳转
    setTimeout(() => captureSelection(ev), 10);
  });
  container.addEventListener('dblclick', (ev) => {
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
  if (!state.pdf) return;
  const keep = doc ? { page: viewer.currentPageNumber, scale: viewer.currentScaleValue, top: $('#pdfContainer').scrollTop } : null;
  const url = `/pdf?v=${Math.round(state.pdf.mtime)}`;
  const oldTask = loadingTask;
  const task = pdfjsLib.getDocument({
    url,
    cMapUrl: '/vendor/pdfjs/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: '/vendor/pdfjs/standard_fonts/',
    wasmUrl: '/vendor/pdfjs/wasm/',
    iccUrl: '/vendor/pdfjs/iccs/',
  });
  loadingTask = task;
  const newDoc = await task.promise;
  if (loadingTask !== task) { task.destroy(); return; } // 又来了更新的版本
  doc = newDoc;
  boxCache.clear();
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
          if (!KEEP.test(ch)) return;
          chars += ch.toLowerCase();
          map.push({ page: n, box, k, len: all.length });
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
async function guessPage(file, lines, fallback) {
  const pages = [];
  const all = await Promise.all(lines.map((l) => api('GET', `/api/synctex/forward?file=${encodeURIComponent(file)}&line=${l}`).catch(() => [])));
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
  if (!doc) return [];
  const needleFull = projectSource(sourceSnippet).chars;
  if (needleFull.length < 2) return [];
  const center = await guessPage(file, lines, fallbackPage);
  if (!center) return [];
  const pages = [];
  for (let n = Math.max(1, center - 1); n <= Math.min(doc.numPages, center + 2); n++) pages.push(n);
  const parts = await Promise.all(pages.map(pageText));
  const chars = parts.map((p) => p.chars).join('');
  const map = parts.flatMap((p) => p.map);
  // 长段落只用首尾各一截定位，中间按顺序连起来
  let r;
  if (needleFull.length > 400) {
    const h = findSpan(chars, needleFull.slice(0, 120));
    const t = h && findSpan(chars.slice(h[1]), needleFull.slice(-120));
    r = h && t ? [h[0], h[1] + t[1]] : h;
  } else r = findSpan(chars, needleFull);
  if (!r) return [];
  return spanRects(map, r[0], r[1]);
}

function linesOf(it) {
  const { lineStart: a, lineEnd: b } = it.anchor;
  return [...new Set([a, Math.round((a + b) / 2), b, Math.min(b, a + 1)])];
}

async function boxesFor(it) {
  // 选区矩形只在同一版 PDF 上有效，编译后重新按文字找
  if (it.anchor.rects?.length && it.anchor.pdfMtime && state.pdf && Math.abs(it.anchor.pdfMtime - state.pdf.mtime) < 1) return it.anchor.rects;
  const key = `${it.id}:${it.anchor.file}:${it.anchor.lineStart}:${it.anchor.quote.length}:${state.pdf?.mtime}`;
  if (!boxCache.has(key)) boxCache.set(key, locate(it.anchor.file, linesOf(it), it.anchor.quote, it.anchor.page).catch(() => []));
  return boxCache.get(key);
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

const drawGen = new Map();

async function drawPage(n) {
  const pv = pageView(n);
  if (!pv?.div) return;
  const layer = hlLayer(pv);
  const items = markedItems(OPEN);
  const gen = (drawGen.get(n) || 0) + 1;
  drawGen.set(n, gen);
  const near = items.filter((it) => !it.anchor.page || Math.abs(it.anchor.page - n) <= 3);
  const boxes = await Promise.all(near.map((it) => boxesFor(it)));
  if (drawGen.get(n) !== gen) return;
  const parts = [];
  near.forEach((it, i) => { for (const r of boxes[i]) if (r.page === n) parts.push({ it, r }); });
  layer.replaceChildren(...parts.map(({ it, r }) => {
    const d = document.createElement('div');
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

// ---- 跳转 ----

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
