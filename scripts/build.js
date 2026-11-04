// 打包前端（CodeMirror + pdf.js），并把 pdf.js 的 worker、字体、CMap 复制到 web/vendor
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pdfjs = path.join(root, 'node_modules', 'pdfjs-dist');
const vendor = path.join(root, 'web', 'vendor', 'pdfjs');

fs.rmSync(vendor, { recursive: true, force: true });
fs.mkdirSync(vendor, { recursive: true });
fs.copyFileSync(path.join(pdfjs, 'LICENSE'), path.join(vendor, 'LICENSE'));
fs.copyFileSync(path.join(pdfjs, 'build', 'pdf.worker.min.mjs'), path.join(vendor, 'pdf.worker.min.mjs'));
for (const d of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) fs.cpSync(path.join(pdfjs, d), path.join(vendor, d), { recursive: true });
fs.cpSync(path.join(pdfjs, 'web', 'images'), path.join(vendor, 'images'), { recursive: true });
fs.copyFileSync(path.join(pdfjs, 'web', 'pdf_viewer.css'), path.join(vendor, 'pdf_viewer.css'));

await build({
  entryPoints: [path.join(root, 'web', 'src', 'main.js')],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  outfile: path.join(root, 'web', 'dist', 'app.js'),
  sourcemap: !process.argv.includes('--minify'),
  minify: process.argv.includes('--minify'),
  logLevel: 'info',
});
