import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { userDirectories } from './environment.js';

export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function expandHome(p) {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

export function loadConfig(file = process.env.THESIS_REVIEW_CONFIG, env = process.env) {
  const cli = !!(env.THESIS_REVIEW_CONFIG_DIR || env.THESIS_REVIEW_PROJECT);
  const user = userDirectories({ env, projectRoot: env.THESIS_REVIEW_PROJECT || process.cwd() });
  const candidates = file ? [path.resolve(file)] : [cli ? path.join(user.configDir, 'config.json') : path.join(APP_ROOT, 'config.json')];
  const found = candidates.find((p) => fs.existsSync(p));
  if (file && !found) throw new Error(`找不到配置文件：${file}`);
  const raw = found ? JSON.parse(fs.readFileSync(found, 'utf8').replace(/^\uFEFF/, '')) : {};
  const base = found ? path.dirname(found) : process.cwd();
  const abs = (p) => path.resolve(base, expandHome(p));
  const root = env.THESIS_REVIEW_PROJECT ? path.resolve(expandHome(env.THESIS_REVIEW_PROJECT)) : raw.projectRoot ? abs(raw.projectRoot) : null;
  const dirs = userDirectories({ env, projectRoot: root || process.cwd() });
  const sample = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'config.example.json'), 'utf8'));
  const cfg = {
    port: 4317,
    projectRoot: root, mainTex: 'main.tex', pdf: 'main.pdf',
    sourceDirs: [],
    extraSources: [],
    skillDirs: ['~/.claude/skills', '~/.codex/skills'],
    defaultSkill: 'basic-polish',
    formulaSkill: 'thesis-formula-review', // 公式审核用的 skill，找不到就只按请求里的说明审
    claimTimeoutMin: 30,
    waitTimeoutSec: 240,
    tools: sample.tools, recipes: sample.recipes, defaultRecipe: sample.defaultRecipe,
    favoriteSkills: ['basic-polish'],
    ...raw,
    projectRoot: root,
    configDir: env.THESIS_REVIEW_CONFIG_DIR ? path.resolve(env.THESIS_REVIEW_CONFIG_DIR) : dirs.configDir,
    dataDir: env.THESIS_REVIEW_DATA_DIR ? path.resolve(env.THESIS_REVIEW_DATA_DIR) : raw.dataDir ? abs(raw.dataDir) : found && path.dirname(found) === APP_ROOT ? path.join(APP_ROOT, 'data') : dirs.dataDir,
    dataRoot: dirs.dataRoot,
    openProjectOnStart: env.THESIS_REVIEW_OPEN_PROJECT !== undefined ? env.THESIS_REVIEW_OPEN_PROJECT === '1' : !!env.THESIS_REVIEW_PROJECT,
  };
  if (env.THESIS_REVIEW_PORT) cfg.port = Number(env.THESIS_REVIEW_PORT);
  if (env.THESIS_REVIEW_MAIN_TEX) cfg.mainTex = env.THESIS_REVIEW_MAIN_TEX;
  if (env.THESIS_REVIEW_PDF) cfg.pdf = env.THESIS_REVIEW_PDF;
  else if (!raw.pdf || env.THESIS_REVIEW_MAIN_TEX) cfg.pdf = cfg.mainTex.replace(/\.tex$/i, '.pdf');
  cfg.startupOverrides = {
    ...(env.THESIS_REVIEW_MAIN_TEX ? { mainTex: cfg.mainTex, pdf: cfg.pdf } : {}),
    ...(env.THESIS_REVIEW_PDF ? { pdf: cfg.pdf } : {}),
  };
  // 旧配置只有单条 compile 命令时，转成一个配方
  if (!raw.recipes && cfg.compile) {
    cfg.tools = [{ name: cfg.compile.command, command: cfg.compile.command, args: cfg.compile.args }];
    cfg.recipes = [{ name: cfg.compile.command, tools: [cfg.compile.command] }];
    cfg.defaultRecipe = cfg.compile.command;
  }
  cfg.tools ??= [];
  cfg.recipes ??= [];
  cfg.favoriteSkills ??= [];
  cfg.configFile = found || null;
  cfg.skillDirs = [...new Set([path.join(APP_ROOT, 'skills'), ...cfg.skillDirs.map(abs)])];
  if (!cfg.skillDirs.some((dir) => fs.existsSync(path.join(dir, cfg.defaultSkill, 'SKILL.md')))) cfg.defaultSkill = 'basic-polish';
  cfg.favoriteSkills = [...new Set([cfg.defaultSkill, ...cfg.favoriteSkills])];
  if (root && fs.existsSync(root) && raw.sourceDirs === undefined && raw.extraSources === undefined) {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory() && !['.git', 'node_modules'].includes(entry.name)) cfg.sourceDirs.push(entry.name);
      else if (entry.isFile() && entry.name.endsWith('.tex')) cfg.extraSources.push(entry.name);
    }
    if (!raw.mainTex && !env.THESIS_REVIEW_MAIN_TEX) {
      const docs = cfg.extraSources.filter((f) => /\\documentclass\s*(?:\[[^\]]*\]\s*)?\{/.test(fs.readFileSync(path.join(root, f), 'utf8')));
      cfg.mainTex = docs.find((f) => /^(main|master|thesis)\.tex$/i.test(f)) || docs[0] || 'main.tex';
      if (!raw.pdf && !env.THESIS_REVIEW_PDF) cfg.pdf = cfg.mainTex.replace(/\.tex$/i, '.pdf');
    }
  }
  return cfg;
}
