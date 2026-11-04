import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import express from 'express';
import { APP_ROOT, loadConfig } from './config.js';
import { Projects } from './projects.js';
import { ProjectRuntime } from './runtime.js';
import { AiSettings, testConnection } from './ai/index.js';
import { detectEnvironment, checkEnvironment } from './environment.js';
import { listSkills } from './skills.js';
import { backward, forward } from './synctex.js';
import { locateFormula } from './formula.js';
import { locatePdfSelection } from './anchors.js';
import { lineStarts, offsetToLine } from './texfiles.js';

const FORMATS = {
  openai: { provider: 'openai', apiFormat: 'chat' },
  'openai-responses': { provider: 'openai', apiFormat: 'responses' },
  anthropic: { provider: 'anthropic', apiFormat: 'messages' },
  gemini: { provider: 'gemini', apiFormat: 'generateContent' },
};
const aiInput = (body = {}) => ({ ...body, ...(FORMATS[body.format] || {}) });
const aiPublic = (value) => ({ ...value, format: value.provider === 'openai' ? value.apiFormat === 'responses' ? 'openai-responses' : 'openai' : value.provider });

export function createApp(cfg = loadConfig()) {
  const app = express();
  const projects = new Projects(cfg, { registryDir: path.join(cfg.configDir, 'projects') });
  const settings = new AiSettings(cfg.configDir, cfg.ai || {});
  const contexts = new Map();
  const clients = new Set();
  const broadcast = (projectId, event, data) => {
    const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of clients) if (client.projectId === projectId) client.res.write(message);
  };
  const selectedId = (req) => req.get('X-Project-Id') || req.query.projectId || req.query.project || projects.activeProjectId;
  const context = (id) => {
    if (!id) throw new Error('请先添加一个 LaTeX 论文文件夹');
    if (!contexts.has(id)) contexts.set(id, new ProjectRuntime(id, projects.config(id), settings, broadcast));
    return contexts.get(id);
  };
  const scoped = (fn) => (req, res) => fn(req, res, context(selectedId(req)));
  const emptyState = () => ({
    projectId: null, projectRoot: null, pdfName: null, files: [], fileTitles: {}, items: [], jobs: [], changes: [], dirty: [],
    pdf: null, compile: {}, agent: { state: 'offline' }, recipes: { names: [], default: '' },
    defaultSkill: cfg.defaultSkill, favoriteSkills: cfg.favoriteSkills,
    ai: { state: 'unconfigured', configured: !!(settings.get().model && settings.get().apiKey), enabled: settings.get().enabled, busy: 0 },
  });
  const stateFor = (id) => ({
    ...(id ? context(id).state() : emptyState()),
    project: id ? projects.get(id) : null, projects: projects.list(),
  });
  const closeContext = async (id) => { const ctx = contexts.get(id); if (ctx) { await ctx.close(); contexts.delete(id); } };

  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const hosts = new Set([`127.0.0.1:${req.socket.localPort}`, `localhost:${req.socket.localPort}`]);
    if (!hosts.has(req.headers.host)) return res.status(403).send('forbidden host');
    if (req.method !== 'GET' && req.headers.origin && !hosts.has(req.headers.origin.replace(/^http:\/\//, ''))) return res.status(403).send('forbidden origin');
    next();
  });
  app.use(express.json({ limit: '256mb' }));
  app.use(express.static(path.join(APP_ROOT, 'web'), { index: 'index.html' }));

  app.get('/api/projects', (req, res) => res.json({ projects: projects.list(), activeProjectId: projects.activeProjectId, activeProject: projects.activeProjectId ? projects.get(projects.activeProjectId) : null }));
  app.post('/api/projects', (req, res) => res.json(projects.register(req.body)));
  app.post('/api/projects/import', (req, res) => res.json(projects.import(req.body)));
  app.get('/api/projects/:id/tree', (req, res) => res.json(projects.tree(req.params.id)));
  app.post('/api/projects/:id/activate', (req, res) => {
    const project = projects.setActive(req.params.id);
    res.json({ project, state: stateFor(project.id) });
  });
  app.patch('/api/projects/:id', async (req, res) => {
    const project = projects.update(req.params.id, req.body);
    await closeContext(project.id);
    res.json(project);
  });
  app.get('/api/folders', (req, res) => {
    const directory = path.resolve(String(req.query.path || os.homedir()));
    const folders = fs.readdirSync(directory, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => ({ name: e.name, path: path.join(directory, e.name) }));
    if (process.platform === 'win32' && path.parse(directory).root === directory) {
      for (let n = 65; n <= 90; n++) {
        const drive = `${String.fromCharCode(n)}:\\`;
        if (drive !== directory && fs.existsSync(drive)) folders.push({ name: drive, path: drive });
      }
    }
    res.json({ path: directory, parent: path.dirname(directory), folders });
  });
  app.get('/api/ai/config', (req, res) => res.json(aiPublic(settings.public())));
  app.put('/api/ai/config', (req, res) => res.json(aiPublic(settings.update(aiInput(req.body)))));
  app.post('/api/ai/test', async (req, res) => res.json(await testConnection(settings.forRequest(aiInput(req.body)))));
  app.get('/api/ai/status', (req, res) => res.json(selectedId(req) ? context(selectedId(req)).ai.status() : emptyState().ai));
  app.post('/api/ai/retry/:id', scoped((req, res, ctx) => res.json(ctx.ai.retry(req.params.id))));
  app.post('/api/ai/cancel/:id', scoped((req, res, ctx) => res.json(ctx.ai.cancel(req.params.id))));
  app.get('/api/environment', async (req, res) => res.json(await detectEnvironment({ refresh: req.query.refresh === '1' })));
  app.post('/api/environment/check', async (req, res) => res.json(await checkEnvironment(req.body || {})));
  app.get('/api/state', (req, res) => res.json(stateFor(selectedId(req))));
  app.get('/api/skills', (req, res) => res.json(listSkills(selectedId(req) ? context(selectedId(req)).cfg : cfg).map(({ name, description, dir }) => ({ name, description, dir }))));
  app.get('/api/files', scoped((req, res, ctx) => res.json(ctx.files.list())));
  app.get('/api/file', scoped((req, res, ctx) => {
    const f = ctx.files.read(String(req.query.path));
    res.json({ path: f.rel, text: f.text, mtime: f.mtimeMs, hash: f.hash });
  }));
  app.put('/api/file', scoped((req, res, ctx) => {
    const { path: file, text, baseHash, force } = req.body || {};
    if (typeof text !== 'string') throw new Error('缺少 text');
    const result = ctx.files.save(String(file), text, baseHash, !!force);
    res.status(result.conflict ? 409 : 200).json(result);
  }));
  app.get('/pdf', scoped((req, res, ctx) => { res.setHeader('Cache-Control', 'no-cache'); res.sendFile(ctx.pdfPath, { acceptRanges: true, lastModified: true, etag: true }); }));
  app.get('/api/synctex/forward', scoped(async (req, res, ctx) => {
    const { rel } = ctx.files.resolve(String(req.query.file));
    res.json(await forward(ctx.cfg, rel, Number(req.query.line) || 1));
  }));
  app.get('/api/synctex/backward', scoped(async (req, res, ctx) => res.json(await backward(ctx.cfg, Number(req.query.page), Number(req.query.x), Number(req.query.y)))));
  app.post('/api/locate', scoped((req, res, ctx) => {
    const { rel } = ctx.files.resolve(String(req.body.file));
    const { text } = ctx.files.read(rel);
    const r = locatePdfSelection(text, String(req.body.text || ''), Number(req.body.line) || 1);
    res.json(r ? { file: rel, line: offsetToLine(lineStarts(text), r.start), from: r.start, to: r.end } : null);
  }));
  app.post('/api/formula', scoped((req, res, ctx) => res.json(locateFormula(ctx.files, req.body || {}))));
  app.get('/api/items', scoped((req, res, ctx) => res.json(ctx.review.list())));
  app.post('/api/items', scoped(async (req, res, ctx) => res.json(await ctx.review.create(req.body))));
  app.patch('/api/items/:id', scoped((req, res, ctx) => res.json(ctx.review.update(req.params.id, req.body))));
  app.delete('/api/items/:id', scoped((req, res, ctx) => { ctx.review.remove(req.params.id); res.json({ ok: true }); }));
  app.get('/api/items/:id/hunks', scoped((req, res, ctx) => res.json(ctx.review.hunks(req.params.id))));
  app.post('/api/items/:id/requeue', scoped((req, res, ctx) => res.json(ctx.review.requeue(req.params.id, req.body?.message || '', req.body?.skill))));
  app.post('/api/items/:id/note', scoped((req, res, ctx) => res.json(ctx.review.note(req.params.id, req.body?.message || ''))));
  app.post('/api/items/:id/accept', scoped((req, res, ctx) => res.json(ctx.review.accept(req.params.id, req.body || {}))));
  app.post('/api/items/:id/reject', scoped((req, res, ctx) => res.json(ctx.review.reject(req.params.id, req.body?.reason || ''))));
  app.get('/api/changes', scoped((req, res, ctx) => res.json(ctx.review.changes())));
  app.post('/api/changes/confirm', scoped((req, res, ctx) => res.json(ctx.review.confirmChanges(Array.isArray(req.body?.ids) ? req.body.ids : null))));
  app.post('/api/items/:id/restore', scoped((req, res, ctx) => res.json(ctx.review.restore(req.params.id))));
  app.post('/api/items/:id/undo', scoped((req, res, ctx) => res.json(ctx.review.undo(req.params.id))));
  app.get('/api/jobs', scoped((req, res, ctx) => res.json(ctx.jobs.views())));
  app.post('/api/jobs/preview', scoped(async (req, res, ctx) => res.json(await ctx.jobs.preview(req.body))));
  app.post('/api/jobs', scoped(async (req, res, ctx) => res.json(await (req.body?.type === 'formula' ? ctx.jobs.createFormula(req.body) : ctx.jobs.create(req.body)))));
  app.post('/api/jobs/:id/pause', scoped((req, res, ctx) => res.json(ctx.jobs.pause(req.params.id))));
  app.post('/api/jobs/:id/resume', scoped((req, res, ctx) => res.json(ctx.jobs.resume(req.params.id))));
  app.post('/api/jobs/:id/cancel', scoped((req, res, ctx) => res.json(ctx.jobs.cancel(req.params.id))));
  app.delete('/api/jobs/:id', scoped((req, res, ctx) => { ctx.jobs.remove(req.params.id); res.json({ ok: true }); }));
  app.post('/api/compile', scoped((req, res, ctx) => res.json({ started: ctx.compiler.start(req.body?.recipe || undefined), compile: ctx.compileView() })));
  app.post('/api/compile/stop', scoped((req, res, ctx) => res.json({ stopped: ctx.compiler.stop() })));
  app.get('/events', (req, res) => {
    const id = selectedId(req);
    if (id) context(id);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    const client = { projectId: id, res };
    clients.add(client);
    req.on('close', () => clients.delete(client));
  });
  app.use((req, res, next) => req.path === '/mcp' ? context(selectedId(req)).mcp(req, res, next) : next());
  const ping = setInterval(() => { for (const client of clients) client.res.write(': ping\n\n'); }, 25000);
  ping.unref();
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    res.status(err.status || 400).json({ error: err.message || String(err) });
  });
  app.locals.desk = { projects, settings, contexts, stateFor, context };
  app.locals.close = async () => {
    clearInterval(ping);
    for (const client of clients) client.res.end();
    await Promise.all([...contexts.values()].map((ctx) => ctx.close()));
    contexts.clear();
  };
  return app;
}

export function startServer(cfg = loadConfig()) {
  const app = createApp(cfg);
  const server = app.listen(cfg.port, '127.0.0.1', () => {
    console.log(`论文审阅台：http://127.0.0.1:${server.address().port}/`);
    console.log(`配置目录：${cfg.configDir}`);
    console.log(`论文目录：${cfg.projectRoot || '请在网页添加论文'}`);
  });
  server.on('close', () => app.locals.close());
  server.on('error', (error) => { console.error(error.message); app.locals.close(); process.exitCode = 1; });
  return { app, server };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { app, server } = startServer();
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) process.on(signal, () => {
    app.locals.close().then(() => server.close());
  });
}
