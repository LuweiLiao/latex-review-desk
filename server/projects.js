import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SETTINGS = [
  'mainTex', 'pdf', 'sourceDirs', 'extraSources', 'skillDirs', 'defaultSkill',
  'favoriteSkills', 'formulaSkill', 'tools', 'recipes', 'defaultRecipe',
  'claimTimeoutMin', 'waitTimeoutSec', 'writingRules',
];
const clone = (value) => structuredClone(value);
const slash = (value) => value.replace(/\\/g, '/');
const sameRoot = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

function settings(input = {}) {
  return Object.fromEntries(SETTINGS.filter((key) => input[key] !== undefined).map((key) => [key, clone(input[key])]));
}

function relativeFile(root, input) {
  if (typeof input !== 'string' || !input) throw new Error('缺少文件路径');
  const normalized = slash(input);
  const absolute = path.resolve(root, normalized);
  const relative = slash(path.relative(root, absolute));
  if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative) || /^[a-z]:/i.test(normalized)) {
    throw new Error(`路径越界：${input}`);
  }
  return { absolute, relative };
}

function withoutComments(text) {
  return text.split(/\r?\n/).map((line) => {
    for (let i = 0; i < line.length; i++) {
      if (line[i] !== '%') continue;
      let backslashes = 0;
      for (let j = i - 1; j >= 0 && line[j] === '\\'; j--) backslashes++;
      if (backslashes % 2 === 0) return line.slice(0, i);
    }
    return line;
  }).join('\n');
}

function mainOrder(a, b) {
  const rank = (file) => {
    const name = path.posix.basename(file).toLowerCase();
    const preferred = ['main.tex', 'master.tex', 'thesis.tex', 'dissertation.tex'].indexOf(name);
    return [preferred < 0 ? 4 : preferred, file.split('/').length];
  };
  const ar = rank(a), br = rank(b);
  return ar[0] - br[0] || ar[1] - br[1] || a.localeCompare(b);
}

// Registry owns project metadata/configuration, not Review/Jobs/Compiler instances.
// All methods are synchronous. Returned objects are copies and safe to serialize.
export class Projects {
  constructor(baseConfig, { registryDir = path.join(baseConfig.dataDir, 'projects') } = {}) {
    this.baseConfig = clone(baseConfig);
    this.registryDir = path.resolve(registryDir);
    this.registryFile = path.join(this.registryDir, 'projects.json');
    fs.mkdirSync(this.registryDir, { recursive: true });
    const saved = fs.existsSync(this.registryFile)
      ? JSON.parse(fs.readFileSync(this.registryFile, 'utf8'))
      : { projects: [] };
    this.records = saved.projects;
    this.activeProjectId = saved.activeProjectId || this.records[0]?.id || null;
    if (baseConfig.projectRoot) {
      const cfg = clone(baseConfig);
      cfg.projectRoot = path.resolve(cfg.projectRoot);
      cfg.dataDir = path.resolve(cfg.dataDir);
      let existing = this.records.find((p) => sameRoot(p.config.projectRoot, cfg.projectRoot));
      const added = !existing;
      if (!existing) {
        existing = {
          id: this.records.length ? crypto.randomUUID() : 'default', name: path.basename(cfg.projectRoot), mode: 'local',
          createdAt: new Date().toISOString(), config: cfg,
        };
        this.records.unshift(existing);
      }
      Object.assign(existing.config, settings(baseConfig.startupOverrides));
      if (added || baseConfig.openProjectOnStart || !this.activeProjectId) this.activeProjectId = existing.id;
      this.#save();
    }
  }

  #find(id) {
    const record = this.records.find((p) => p.id === id);
    if (!record) throw new Error(`找不到项目：${id}`);
    return record;
  }

  #save() {
    const temp = this.registryFile + '.tmp';
    fs.writeFileSync(temp, JSON.stringify({ activeProjectId: this.activeProjectId, projects: this.records }, null, 2), 'utf8');
    fs.renameSync(temp, this.registryFile);
  }

  #scan(record) {
    const root = record.config.projectRoot;
    const excluded = [this.registryDir, record.config.dataDir].map((dir) => path.resolve(dir));
    const texFiles = [];
    const walk = (directory, relative = '') => {
      const children = [];
      if (!fs.existsSync(directory)) return children;
      const entries = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
        Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
      for (const entry of entries) {
        const absolute = path.join(directory, entry.name);
        const rel = relative ? `${relative}/${entry.name}` : entry.name;
        if (excluded.some((dir) => sameRoot(absolute, dir))) continue;
        if (entry.isDirectory()) {
          if (entry.name === '.git' || entry.name === 'node_modules') continue;
          children.push({ name: entry.name, path: rel, type: 'directory', children: walk(absolute, rel) });
        } else if (entry.isFile()) {
          const stat = fs.statSync(absolute);
          children.push({ name: entry.name, path: rel, type: 'file', size: stat.size });
          if (/\.tex$/i.test(rel)) texFiles.push(rel);
        }
      }
      return children;
    };
    const tree = { name: path.basename(root), path: '', type: 'directory', children: walk(root) };
    const candidates = texFiles.filter((file) => {
      const text = withoutComments(fs.readFileSync(path.join(root, file), 'utf8'));
      return /\\documentclass\s*(?:\[[^\]]*\]\s*)?\{/.test(text) || /\\begin\s*\{document\}/.test(text);
    }).sort(mainOrder);
    return { tree, texFiles: texFiles.sort(), candidates };
  }

  #view(record) {
    return {
      id: record.id, name: record.name, mode: record.mode, createdAt: record.createdAt,
      projectRoot: record.config.projectRoot, dataDir: record.config.dataDir,
      mainTex: record.config.mainTex || '', pdf: record.config.pdf || '',
      defaultRecipe: record.config.defaultRecipe || '', writingRules: record.config.writingRules || '',
      mainTexCandidates: this.#scan(record).candidates,
    };
  }

  // list/get expose metadata; config returns the full existing service config shape.
  list() { return this.records.map((record) => this.#view(record)); }
  get(id) { return this.#view(this.#find(id)); }
  config(id) { return clone(this.#find(id).config); }
  tree(id) { return this.#scan(this.#find(id)).tree; }

  setActive(id) {
    const record = this.#find(id);
    this.activeProjectId = id;
    this.#save();
    return this.#view(record);
  }

  #create({ id, projectRoot, name, mode, ...input }) {
    const dataDir = path.join(this.registryDir, id, 'data');
    const config = {
      ...clone(this.baseConfig), ...settings(input.config), ...settings(input),
      projectRoot, dataDir, configFile: path.join(this.registryDir, id, 'config.json'),
    };
    const record = { id, name: name || path.basename(projectRoot), mode, createdAt: new Date().toISOString(), config };
    const { texFiles, candidates } = this.#scan(record);
    const explicit = { ...settings(input.config), ...settings(input) };
    config.mainTex = explicit.mainTex !== undefined ? this.#mainTex(record, explicit.mainTex) : candidates[0] || '';
    config.pdf = explicit.pdf ?? config.mainTex.replace(/\.tex$/i, '.pdf');
    config.sourceDirs = explicit.sourceDirs ?? [...new Set(texFiles.filter((file) => file.includes('/')).map((file) => file.split('/')[0]))];
    config.extraSources = explicit.extraSources ?? texFiles.filter((file) => !file.includes('/'));
    fs.mkdirSync(dataDir, { recursive: true });
    this.records.push(record);
    this.activeProjectId ||= id;
    this.#save();
    return this.#view(record);
  }

  #mainTex(record, file) {
    if (file === '') return '';
    const { absolute, relative } = relativeFile(record.config.projectRoot, file);
    if (!/\.tex$/i.test(relative) || !fs.statSync(absolute).isFile()) throw new Error(`主文件必须是 .tex 文件：${file}`);
    return relative;
  }

  // Register edits the original folder. Registering the same root returns its entry.
  register({ projectRoot, ...input }) {
    if (typeof projectRoot !== 'string' || !projectRoot) throw new Error('缺少项目目录');
    const root = fs.realpathSync(path.resolve(projectRoot));
    if (!fs.statSync(root).isDirectory()) throw new Error('项目路径必须是目录');
    const existing = this.records.find((record) => sameRoot(record.config.projectRoot, root));
    if (existing) return this.#view(existing);
    return this.#create({ ...input, id: crypto.randomUUID(), projectRoot: root, mode: 'local' });
  }

  // Import accepts directory-upload entries, preserving their relative paths and bytes.
  // content is UTF-8 text by default, or a base64 string when encoding === 'base64'.
  import({ files, ...input }) {
    if (!Array.isArray(files) || !files.length) throw new Error('没有导入文件');
    const id = crypto.randomUUID();
    const root = path.join(this.registryDir, id, 'source');
    const entries = files.map((file) => {
      const resolved = relativeFile(root, file.path);
      if (typeof file.content !== 'string' && !Buffer.isBuffer(file.content)) throw new Error(`缺少文件内容：${file.path}`);
      return { ...resolved, content: Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf8') };
    });
    for (const entry of entries) {
      fs.mkdirSync(path.dirname(entry.absolute), { recursive: true });
      fs.writeFileSync(entry.absolute, entry.content);
    }
    return this.#create({ ...input, id, projectRoot: root, mode: 'import' });
  }

  // Update project settings in the registry, leaving source and state paths fixed.
  update(id, patch = {}) {
    const record = this.#find(id);
    const next = { ...settings(patch.config), ...settings(patch) };
    if (next.mainTex !== undefined) {
      next.mainTex = this.#mainTex(record, next.mainTex);
      if (next.pdf === undefined && record.config.pdf === record.config.mainTex?.replace(/\.tex$/i, '.pdf')) {
        next.pdf = next.mainTex.replace(/\.tex$/i, '.pdf');
      }
    }
    if (patch.name !== undefined) record.name = patch.name;
    Object.assign(record.config, next);
    this.#save();
    return this.#view(record);
  }
}
