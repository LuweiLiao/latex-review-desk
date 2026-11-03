import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { APP_ROOT, loadConfig } from './config.js';
import { Compiler } from './compile.js';
import { Review } from './core.js';
import { Jobs } from './jobs.js';
import { mountMcp } from './mcp.js';
import { listSkills } from './skills.js';
import { Store } from './store.js';
import { backward, forward } from './synctex.js';
import { locateFormula } from './formula.js';
import { locatePdfSelection } from './anchors.js';
import { lineStarts, offsetToLine } from './texfiles.js';
import { TexFiles } from './texfiles.js';

// 进程退出时留一行记录，方便查服务为什么停了
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) process.on(sig, () => { console.error(`[${new Date().toISOString()}] 收到 ${sig}，退出`); process.exit(0); });
process.on('exit', (code) => console.error(`[${new Date().toISOString()}] 进程退出 code=${code}`));
process.on('uncaughtException', (e) => { console.error(`[${new Date().toISOString()}] 未捕获异常`, e); process.exit(1); });

const cfg = loadConfig();
const files = new TexFiles(cfg);
const store = new Store(cfg.dataDir);
const review = new Review(cfg, files, store);
const compiler = new Compiler(cfg);
const jobs = new Jobs(cfg, files, store, review);
const pdfPath = path.join(cfg.projectRoot, cfg.pdf);

const app = express();
app.disable('x-powered-by');

// 只接受本机访问，挡住 DNS rebinding 和其他网页的跨站请求
const okHosts = new Set([`127.0.0.1:${cfg.port}`, `localhost:${cfg.port}`]);
const okOrigins = new Set([...okHosts].map((h) => `http://${h}`));
app.use((req, res, next) => {
  if (!okHosts.has(req.headers.host)) return res.status(403).send('forbidden host');
  const origin = req.headers.origin;
  if (req.method !== 'GET' && origin && !okOrigins.has(origin)) return res.status(403).send('forbidden origin');
  next();
});
app.use(express.json({ limit: '5mb' }));

mountMcp(app, cfg, review);

app.use(express.static(path.join(APP_ROOT, 'web'), { index: 'index.html' }));

// ---- 状态 ----

function pdfInfo() {
  try { const st = fs.statSync(pdfPath); return { mtime: st.mtimeMs, size: st.size }; } catch { return null; }
}

function dirtyFiles() {
  const pdf = pdfInfo();
  if (!pdf) return [];
  return files.list().filter((f) => {
    try { return fs.statSync(path.join(cfg.projectRoot, f)).mtimeMs > pdf.mtime + 1000; } catch { return false; }
  });
}

function compileView() {
  const { tail, ...rest } = compiler.state;
  return { ...rest, tail: tail.slice(-40) };
}

app.get('/api/state', (req, res) => {
  res.json({
    projectRoot: cfg.projectRoot,
    pdfName: cfg.pdf,
    defaultSkill: cfg.defaultSkill,
    favoriteSkills: cfg.favoriteSkills,
    recipes: compiler.recipes(),
    files: files.list(),
    fileTitles: files.titles(),
    items: review.list(),
    agent: review.agentStatus(),
    compile: compileView(),
    pdf: pdfInfo(),
    dirty: dirtyFiles(),
    jobs: jobs.views(),
    changes: review.changes(),
  });
});

app.get('/api/files', (req, res) => res.json(files.list()));

app.get('/api/file', (req, res) => {
  const f = files.read(String(req.query.path));
  res.json({ path: f.rel, text: f.text, mtime: f.mtimeMs, hash: f.hash });
});

// 网页编辑器保存（自动保存 / Ctrl+S）
app.put('/api/file', (req, res) => {
  const { path: p, text, baseHash, force } = req.body || {};
  if (typeof text !== 'string') throw new Error('缺少 text');
  const r = files.save(String(p), text, baseHash, !!force);
  res.status(r.conflict ? 409 : 200).json(r);
});

app.get('/api/skills', (req, res) => res.json(listSkills(cfg).map(({ name, description, dir }) => ({ name, description, dir }))));

app.get('/pdf', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(pdfPath, { acceptRanges: true, lastModified: true, etag: true });
});

app.get('/api/synctex/forward', async (req, res) => {
  const { rel } = files.resolve(String(req.query.file));
  res.json(await forward(cfg, rel, Number(req.query.line) || 1));
});

app.get('/api/synctex/backward', async (req, res) => {
  res.json(await backward(cfg, Number(req.query.page), Number(req.query.x), Number(req.query.y)));
});

// PDF 上点到的文字 -> 源码里的准确位置（在 synctex 给的行附近找）
app.post('/api/locate', (req, res) => {
  const { rel } = files.resolve(String(req.body.file));
  const { text } = files.read(rel);
  const r = locatePdfSelection(text, String(req.body.text || ''), Number(req.body.line) || 1);
  if (!r) return res.json(null);
  const ls = lineStarts(text);
  res.json({ file: rel, line: offsetToLine(ls, r.start), from: r.start, to: r.end });
});

// PDF 上点到的公式 -> 源码里那一段公式
app.post('/api/formula', (req, res) => res.json(locateFormula(files, req.body || {})));

// ---- 请求 ----

app.get('/api/items', (req, res) => res.json(review.list()));
app.post('/api/items', async (req, res) => res.json(await review.create(req.body)));
app.patch('/api/items/:id', (req, res) => res.json(review.update(req.params.id, req.body)));
app.delete('/api/items/:id', (req, res) => { review.remove(req.params.id); res.json({ ok: true }); });
app.get('/api/items/:id/hunks', (req, res) => res.json(review.hunks(req.params.id)));
app.post('/api/items/:id/requeue', (req, res) => res.json(review.requeue(req.params.id, req.body?.message || '', req.body?.skill)));
app.post('/api/items/:id/note', (req, res) => res.json(review.note(req.params.id, req.body?.message || '')));
app.post('/api/items/:id/accept', (req, res) => res.json(review.accept(req.params.id, req.body || {})));
app.post('/api/items/:id/reject', (req, res) => res.json(review.reject(req.params.id, req.body?.reason || '')));
app.get('/api/changes', (req, res) => res.json(review.changes()));
app.post('/api/changes/confirm', (req, res) => res.json(review.confirmChanges(Array.isArray(req.body?.ids) ? req.body.ids : null)));
app.post('/api/items/:id/restore', (req, res) => res.json(review.restore(req.params.id)));
app.post('/api/items/:id/undo', (req, res) => res.json(review.undo(req.params.id)));

// ---- 逐段润色 ----

app.get('/api/jobs', (req, res) => res.json(jobs.views()));
app.post('/api/jobs/preview', async (req, res) => res.json(await jobs.preview(req.body)));
app.post('/api/jobs', async (req, res) => res.json(await (req.body?.type === 'formula' ? jobs.createFormula(req.body) : jobs.create(req.body))));
app.post('/api/jobs/:id/pause', (req, res) => res.json(jobs.pause(req.params.id)));
app.post('/api/jobs/:id/resume', (req, res) => res.json(jobs.resume(req.params.id)));
app.post('/api/jobs/:id/cancel', (req, res) => res.json(jobs.cancel(req.params.id)));
app.delete('/api/jobs/:id', (req, res) => { jobs.remove(req.params.id); res.json({ ok: true }); });

app.post('/api/compile', (req, res) => res.json({ started: compiler.start(req.body?.recipe || undefined), compile: compileView() }));
app.post('/api/compile/stop', (req, res) => res.json({ stopped: compiler.stop() }));

// ---- 推送 ----

const clients = new Set();
app.get('/events', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write('retry: 2000\n\n');
  clients.add(res);
  req.on('close', () => clients.delete(res));
});
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) c.write(msg);
}
setInterval(() => { for (const c of clients) c.write(': ping\n\n'); broadcast('agent', review.agentStatus()); }, 25_000).unref();

let itemsTimer = null;
const pushItems = () => { clearTimeout(itemsTimer); itemsTimer = setTimeout(() => { broadcast('items', review.list()); broadcast('changes', review.changes()); }, 50); };
review.on('changed', pushItems);
let jobsTimer = null;
const pushJobs = () => { clearTimeout(jobsTimer); jobsTimer = setTimeout(() => broadcast('jobs', jobs.views()), 80); };
jobs.on('changed', pushJobs);
review.on('changed', pushJobs);
jobs.tick();
review.on('agent', (s) => broadcast('agent', s));
compiler.on('state', () => broadcast('compile', compileView()));
compiler.on('progress', (line) => broadcast('compile-progress', line));
compiler.on('done', () => { broadcast('pdf', pdfInfo()); broadcast('files', { changed: [], dirty: dirtyFiles() }); });

// 源码改动（网页接受修改、外部编辑器保存都算）
const changed = new Set();
let fileTimer = null;
function onSourceChange(rel) {
  files.invalidate(rel);
  changed.add(rel);
  clearTimeout(fileTimer);
  fileTimer = setTimeout(() => {
    broadcast('files', { changed: [...changed], dirty: dirtyFiles() });
    changed.clear();
    pushItems();
  }, 300);
}
for (const d of cfg.sourceDirs) {
  const dir = path.join(cfg.projectRoot, d);
  if (!fs.existsSync(dir)) continue;
  fs.watch(dir, { recursive: true }, (ev, name) => {
    if (name && String(name).endsWith('.tex')) onSourceChange(`${d}/${String(name).replace(/\\/g, '/')}`);
  });
}

// PDF 被外部编译更新时，等文件稳定后再通知网页重新加载
let pdfTimer = null, lastPdf = JSON.stringify(pdfInfo());
fs.watch(cfg.projectRoot, (ev, name) => {
  if (!name) return;
  const n = String(name);
  if (cfg.extraSources.includes(n)) onSourceChange(n);
  if (n !== cfg.pdf || compiler.state.running) return;
  clearTimeout(pdfTimer);
  const check = (prev) => {
    pdfTimer = setTimeout(() => {
      const cur = JSON.stringify(pdfInfo());
      if (cur !== prev) return check(cur);
      if (cur !== lastPdf) { lastPdf = cur; broadcast('pdf', pdfInfo()); broadcast('files', { changed: [], dirty: dirtyFiles() }); }
    }, 1200);
  };
  check(JSON.stringify(pdfInfo()));
});

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  res.status(400).json({ error: err.message || String(err) });
});

app.listen(cfg.port, '127.0.0.1', () => {
  console.log(`论文审阅台：http://127.0.0.1:${cfg.port}/`);
  console.log(`MCP：        http://127.0.0.1:${cfg.port}/mcp`);
  console.log(`论文目录：   ${cfg.projectRoot}`);
  console.log(`配置文件：   ${cfg.configFile}`);
});
