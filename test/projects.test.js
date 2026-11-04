import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Compiler, recipeSteps } from '../server/compile.js';
import { Review } from '../server/core.js';
import { Jobs } from '../server/jobs.js';
import { Projects } from '../server/projects.js';
import { Store } from '../server/store.js';
import { TexFiles } from '../server/texfiles.js';

const DOCUMENT = '\\documentclass{article}\n\\begin{document}\n正文\n\\end{document}\n';
const CHAPTER = '控制器根据状态误差计算控制输入。\n\n\\begin{equation}\n u = -Kx\n\\end{equation}\n';

function write(root, file, content) {
  const absolute = path.join(root, file);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
}

function setup(t, { legacy = true } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-projects-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const original = path.join(temp, 'original');
  write(original, 'main.tex', DOCUMENT);
  write(original, 'chapters/deep/chapter.tex', CHAPTER);
  const cfg = {
    projectRoot: legacy ? original : null, mainTex: 'main.tex', pdf: 'custom.pdf',
    sourceDirs: ['chapters'], extraSources: ['main.tex'], dataDir: path.join(temp, 'legacy-state'),
    skillDirs: [], defaultSkill: '', formulaSkill: '', writingRules: '按控制科学与工程习惯用词。',
    favoriteSkills: [], claimTimeoutMin: 30, waitTimeoutSec: 5,
    tools: [{ name: 'latexmk', command: 'latexmk', args: ['%DOCFILE%'] }],
    recipes: [{ name: 'draft', tools: ['latexmk'] }], defaultRecipe: 'draft',
    configFile: path.join(temp, 'legacy-config.json'),
  };
  const options = { registryDir: path.join(temp, 'registry') };
  return { temp, original, cfg, options, projects: new Projects(cfg, options) };
}

test('legacy registration preserves original configuration, review state and source files', (t) => {
  const { original, cfg, options, projects } = setup(t);
  const store = new Store(cfg.dataDir);
  store.data.items.push({ id: 'R0001', status: 'pending' });
  store.save();
  assert.deepEqual(projects.config('default'), cfg);
  assert.equal(projects.get('default').projectRoot, original);
  assert.equal(projects.register({ projectRoot: original }).id, 'default');
  assert.equal(projects.list().length, 1);
  assert.deepEqual(fs.readdirSync(original).sort(), ['chapters', 'main.tex']);
  const reopened = new Projects(cfg, options);
  assert.deepEqual(new Store(reopened.config('default').dataDir).data.items, store.data.items);
  assert.equal(reopened.activeProjectId, 'default');
});

test('same filenames in two local projects keep file edits, Review, Jobs and Compiler state independent', async (t) => {
  const { temp, projects } = setup(t);
  const roots = ['one', 'two'].map((name) => path.join(temp, name));
  for (const root of roots) {
    write(root, 'main.tex', DOCUMENT);
    write(root, 'chapters/deep/chapter.tex', CHAPTER);
  }
  const entries = roots.map((projectRoot) => projects.register({ projectRoot }));
  assert.notEqual(entries[0].id, entries[1].id);
  assert.notEqual(entries[0].dataDir, entries[1].dataDir);
  const runtimes = entries.map((entry) => {
    const cfg = projects.config(entry.id);
    const files = new TexFiles(cfg);
    const store = new Store(cfg.dataDir);
    const review = new Review(cfg, files, store);
    t.after(() => clearInterval(review.timer));
    return { cfg, files, store, review, jobs: new Jobs(cfg, files, store, review), compiler: new Compiler(cfg) };
  });
  const [a, b] = runtimes;
  assert.deepEqual(a.files.list().sort(), ['chapters/deep/chapter.tex', 'main.tex']);
  assert.deepEqual(b.files.list().sort(), a.files.list().sort());
  const itemA = await a.review.create({ kind: 'comment', comment: '项目甲', anchor: { source: 'source', file: 'main.tex', whole: true, page: 1 } });
  const itemB = await b.review.create({ kind: 'comment', comment: '项目乙', anchor: { source: 'source', file: 'main.tex', whole: true, page: 1 } });
  assert.equal(itemA.id, itemB.id, 'each state has its own sequence');
  const job = await a.jobs.createFormula({ whole: true, comment: '只审核项目甲' });
  assert.equal(a.jobs.views().length, 1);
  assert.equal(b.jobs.views().length, 0);
  assert.equal(a.jobs.find(job.id).comment, '只审核项目甲');
  a.review.claim(1);
  assert.equal(a.review.find(itemA.id).status, 'claimed');
  assert.equal(b.review.find(itemB.id).status, 'pending');
  assert.equal(new Store(b.cfg.dataDir).data.items[0].comment, '项目乙');
  assert.equal(new Store(a.cfg.dataDir).data.jobs.length, 1);
  assert.equal(new Store(b.cfg.dataDir).data.jobs.length, 0);
  a.files.save('main.tex', DOCUMENT.replace('正文', '项目甲正文'), a.files.read('main.tex').hash);
  assert.equal(fs.readFileSync(path.join(roots[1], 'main.tex'), 'utf8'), DOCUMENT);
  assert.notEqual(a.compiler.state, b.compiler.state);
  a.compiler.state.tail.push('project one only');
  assert.deepEqual(b.compiler.state.tail, []);
  assert.equal(recipeSteps(a.cfg, 'draft')[0].args[0], 'main.tex');
});

test('directory import preserves relative paths and binary bytes, with edits confined to the copy', (t) => {
  const { projects, original } = setup(t);
  const binary = Buffer.from([0, 255, 128, 10, 13, 32]);
  const project = projects.import({
    name: '导入论文', files: [
      { path: '论文/main.tex', content: DOCUMENT },
      { path: '论文/chapters/deep/chapter.tex', content: CHAPTER },
      { path: '论文/figures/结构图.png', content: binary.toString('base64'), encoding: 'base64' },
      { path: '论文/references.bib', content: '@article{sample,title={Sample}}' },
    ],
  });
  assert.equal(project.mode, 'import');
  assert.equal(project.mainTex, '论文/main.tex');
  assert.equal(project.pdf, '论文/main.pdf');
  assert.deepEqual(fs.readFileSync(path.join(project.projectRoot, '论文/figures/结构图.png')), binary);
  const files = new TexFiles(projects.config(project.id));
  assert.deepEqual(new Set(files.list()), new Set(['论文/main.tex', '论文/chapters/deep/chapter.tex']));
  files.save('论文/main.tex', '只修改副本。', files.read('论文/main.tex').hash);
  assert.equal(fs.readFileSync(path.join(original, 'main.tex'), 'utf8'), DOCUMENT);
  assert.notEqual(project.projectRoot, original);
  assert.equal(fs.existsSync(path.join(project.projectRoot, '论文/references.bib')), true);
});

test('mainTex detection uses document commands, ignores comments, and supports nested candidates and explicit choice', (t) => {
  const { temp, projects } = setup(t);
  const root = path.join(temp, 'candidates');
  write(root, 'main.tex', '% \\documentclass{article}\n% \\begin{document}\n\\input{chapters/ch1}');
  write(root, 'paper/demo/master.tex', DOCUMENT);
  write(root, 'alternate.tex', '\\documentclass\n[12pt]\n{book}\n');
  write(root, 'chapters/ch1.tex', CHAPTER);
  const project = projects.register({ projectRoot: root });
  assert.deepEqual(project.mainTexCandidates, ['paper/demo/master.tex', 'alternate.tex']);
  assert.equal(project.mainTex, 'paper/demo/master.tex');
  const cfg = projects.config(project.id);
  assert.deepEqual(new Set(new TexFiles(cfg).list()), new Set([
    'main.tex', 'paper/demo/master.tex', 'alternate.tex', 'chapters/ch1.tex',
  ]));
  const updated = projects.update(project.id, { mainTex: 'alternate.tex' });
  assert.equal(updated.mainTex, 'alternate.tex');
  assert.equal(updated.pdf, 'alternate.pdf');
  assert.throws(() => projects.update(project.id, { mainTex: '../main.tex' }), /越界/);
});

test('tree includes nested assets and empty directories and excludes registry/state internals', (t) => {
  const { temp, projects } = setup(t);
  const root = path.join(temp, 'tree');
  write(root, 'main.tex', DOCUMENT);
  write(root, 'figures/schema.svg', '<svg/>');
  write(root, '.git/config', 'internal');
  fs.mkdirSync(path.join(root, 'empty'), { recursive: true });
  const project = projects.register({ projectRoot: root });
  const tree = projects.tree(project.id);
  assert.equal(tree.path, '');
  assert.equal(tree.type, 'directory');
  assert.deepEqual(tree.children.map((entry) => entry.name), ['empty', 'figures', 'main.tex']);
  assert.deepEqual(tree.children[0].children, []);
  assert.deepEqual(tree.children[1].children[0], { name: 'schema.svg', path: 'figures/schema.svg', type: 'file', size: 6 });
  const underProject = new Projects({ ...projects.config(project.id), dataDir: path.join(root, 'state') });
  assert.equal(underProject.tree('default').children.some((entry) => entry.name === 'state'), false);
});

test('per-project settings and active selection survive reopen without changing other project settings', (t) => {
  const { temp, projects, cfg, options } = setup(t);
  const root = path.join(temp, 'settings');
  write(root, 'main.tex', DOCUMENT);
  const project = projects.register({ projectRoot: root });
  projects.update(project.id, { name: '已改名', pdf: 'output.pdf', writingRules: '使用平常自然的词语。', defaultRecipe: 'draft' });
  projects.setActive(project.id);
  const reopened = new Projects(cfg, options);
  assert.equal(reopened.activeProjectId, project.id);
  assert.equal(reopened.get(project.id).name, '已改名');
  assert.equal(reopened.config(project.id).writingRules, '使用平常自然的词语。');
  assert.equal(reopened.config(project.id).pdf, 'output.pdf');
  assert.equal(reopened.config('default').pdf, 'custom.pdf');
  assert.equal(reopened.config('default').writingRules, cfg.writingRules);
  const copy = reopened.config(project.id);
  copy.tools[0].args.push('unpersisted');
  assert.deepEqual(reopened.config(project.id).tools[0].args, ['%DOCFILE%']);
});

test('an empty registry can start without a project and becomes active on first import', (t) => {
  const { projects, cfg, options } = setup(t, { legacy: false });
  assert.deepEqual(projects.list(), []);
  assert.equal(projects.activeProjectId, null);
  const project = projects.import({ files: [{ path: 'chapter.tex', content: CHAPTER }] });
  assert.equal(project.mainTex, '');
  assert.deepEqual(project.mainTexCandidates, []);
  assert.equal(projects.activeProjectId, project.id);
  assert.equal(new Projects(cfg, options).activeProjectId, project.id);
});

test('import cannot write files outside its project root', (t) => {
  const { projects } = setup(t);
  const initial = projects.list().length;
  for (const file of ['../outside.tex', '..\\outside.tex', 'C:\\outside.tex', '/outside.tex']) {
    assert.throws(() => projects.import({ files: [{ path: file, content: DOCUMENT }] }), /越界/);
  }
  assert.equal(projects.list().length, initial);
});
