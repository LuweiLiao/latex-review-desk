// 调用 TeX Live 自带的 synctex 命令行。坐标单位是 PDF 点（bp），原点在页面左上角，v 是基线。
import { execFile } from 'node:child_process';
import path from 'node:path';

let gbk = null;
try { gbk = new TextDecoder('gbk'); } catch { /* 没有 GBK 解码器时退回 utf8 */ }

function run(cfg, args) {
  return new Promise((resolve, reject) => {
    execFile('synctex', args, { cwd: cfg.projectRoot, encoding: 'buffer', timeout: 15000, windowsHide: true }, (err, stdout) => {
      if (err && !stdout?.length) return reject(err);
      const buf = stdout || Buffer.alloc(0);
      let s = buf.toString('utf8');
      if (s.includes('�') && gbk) s = gbk.decode(buf);
      resolve(s);
    });
  });
}

function blocks(out) {
  const body = out.split('SyncTeX result begin')[1]?.split('SyncTeX result end')[0] || '';
  const res = [];
  let cur = null;
  for (const line of body.split(/\r?\n/)) {
    const m = /^(\w+):(.*)$/.exec(line);
    if (!m) continue;
    const [, k, v] = m;
    if (k === 'Output' || (k === 'Page' && cur && 'Page' in cur)) {
      if (cur && Object.keys(cur).length) res.push(cur);
      cur = {};
      if (k === 'Output') continue;
    }
    cur ??= {};
    cur[k] = v;
  }
  if (cur && Object.keys(cur).length) res.push(cur);
  return res;
}

// 源码行 -> PDF 上的若干个框
export async function forward(cfg, file, line, col = 0) {
  const out = await run(cfg, ['view', '-i', `${line}:${col}:${file}`, '-o', cfg.pdf]);
  const seen = new Set();
  const boxes = [];
  for (const b of blocks(out)) {
    if (!b.Page) continue;
    const box = { page: +b.Page, h: +b.h, v: +b.v, W: +b.W, H: +b.H, x: +b.x, y: +b.y };
    const key = `${box.page}:${box.h.toFixed(1)}:${box.v.toFixed(1)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    boxes.push(box);
  }
  return boxes;
}

// PDF 上一点 -> 源码文件和行
export async function backward(cfg, page, x, y) {
  const out = await run(cfg, ['edit', '-o', `${page}:${x.toFixed(2)}:${y.toFixed(2)}:${cfg.pdf}`]);
  const b = blocks(out).find((r) => r.Input);
  if (!b) return null;
  const abs = path.resolve(cfg.projectRoot, b.Input);
  const rel = path.relative(cfg.projectRoot, abs).replace(/\\/g, '/');
  return { file: rel, line: Math.max(1, +b.Line), column: +b.Column };
}
