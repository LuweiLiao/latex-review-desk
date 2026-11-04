import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { Compiler } from './compile.js';
import { Review } from './core.js';
import { Jobs } from './jobs.js';
import { mountMcp } from './mcp.js';
import { Store } from './store.js';
import { TexFiles } from './texfiles.js';
import { AiExecutor } from './ai/index.js';

// Each project owns its files, state, compiler, listeners and API requests.
export class ProjectRuntime {
  constructor(id, cfg, settings, broadcast) {
    this.id = id;
    this.cfg = cfg;
    this.files = new TexFiles(cfg);
    this.store = new Store(cfg.dataDir);
    this.review = new Review(cfg, this.files, this.store);
    this.compiler = new Compiler(cfg);
    this.jobs = new Jobs(cfg, this.files, this.store, this.review);
    this.ai = new AiExecutor({ cfg, review: this.review, jobs: this.jobs, settings });
    this.mcp = express.Router();
    mountMcp(this.mcp, cfg, this.review);
    this.pdfPath = path.join(cfg.projectRoot, cfg.pdf || 'main.pdf');
    this.watchers = [];
    this.timers = new Set();
    this.closed = false;
    const send = (event, data) => { if (!this.closed) broadcast(id, event, data); };
    this.review.on('changed', () => { send('items', this.review.list()); send('changes', this.review.changes()); send('jobs', this.jobs.views()); });
    this.jobs.on('changed', () => send('jobs', this.jobs.views()));
    this.review.on('agent', (s) => send('agent', s));
    this.ai.on('changed', (s) => send('ai', s));
    this.compiler.on('state', () => send('compile', this.compileView()));
    this.compiler.on('progress', (s) => send('compile-progress', s));
    this.compiler.on('done', () => { send('pdf', this.pdfInfo()); send('files', { changed: [], dirty: this.dirtyFiles() }); });
    this.sourceChanged = (rel) => { this.files.invalidate(rel); send('files', { changed: [rel], dirty: this.dirtyFiles() }); send('items', this.review.list()); };
    const watch = (directory, options, fn) => {
      if (!fs.existsSync(directory)) return;
      const watcher = fs.watch(directory, options, fn);
      watcher.on('error', (error) => send('watch-error', { message: error.message }));
      this.watchers.push(watcher);
    };
    for (const dir of cfg.sourceDirs) watch(path.join(cfg.projectRoot, dir), { recursive: true }, (ev, name) => {
      if (name && String(name).endsWith('.tex')) this.sourceChanged(`${dir}/${String(name).replace(/\\/g, '/')}`);
    });
    let pdfTimer;
    watch(cfg.projectRoot, {}, (ev, name) => {
      if (!name) return;
      const rel = String(name);
      if (cfg.extraSources.includes(rel)) this.sourceChanged(rel);
      if (rel !== cfg.pdf || this.compiler.state.running) return;
      clearTimeout(pdfTimer);
      this.timers.delete(pdfTimer);
      pdfTimer = setTimeout(() => { this.timers.delete(pdfTimer); send('pdf', this.pdfInfo()); }, 1200);
      this.timers.add(pdfTimer);
    });
    this.jobs.tick();
    this.ai.start();
  }

  pdfInfo() { try { const s = fs.statSync(this.pdfPath); return s.isFile() ? { mtime: s.mtimeMs, size: s.size } : null; } catch { return null; } }
  dirtyFiles() {
    const pdf = this.pdfInfo();
    if (!pdf) return [];
    return this.files.list().filter((file) => { try { return fs.statSync(path.join(this.cfg.projectRoot, file)).mtimeMs > pdf.mtime + 1000; } catch { return false; } });
  }
  compileView() { const { tail, ...rest } = this.compiler.state; return { ...rest, tail: tail.slice(-40) }; }
  state() {
    return {
      projectId: this.id, projectRoot: this.cfg.projectRoot, pdfName: this.cfg.pdf,
      defaultSkill: this.cfg.defaultSkill, favoriteSkills: this.cfg.favoriteSkills,
      recipes: this.compiler.recipes(), files: this.files.list(), fileTitles: this.files.titles(),
      items: this.review.list(), agent: this.review.agentStatus(), compile: this.compileView(),
      pdf: this.pdfInfo(), dirty: this.dirtyFiles(), jobs: this.jobs.views(), changes: this.review.changes(), ai: this.ai.status(),
    };
  }
  async close() {
    this.closed = true;
    this.compiler.stop();
    clearInterval(this.review.timer);
    for (const watcher of this.watchers) watcher.close();
    for (const timer of this.timers) clearTimeout(timer);
    await this.ai.stop();
  }
}
