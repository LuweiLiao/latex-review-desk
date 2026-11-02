import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function expandHome(p) {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

export function loadConfig(file = process.env.THESIS_REVIEW_CONFIG) {
  const candidates = file ? [file] : [path.join(APP_ROOT, 'config.json'), path.join(APP_ROOT, 'config.example.json')];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error('找不到 config.json，请从 config.example.json 复制一份');
  const raw = JSON.parse(fs.readFileSync(found, 'utf8'));
  const cfg = {
    port: 4317,
    sourceDirs: ['content'],
    extraSources: [],
    skillDirs: ['~/.claude/skills'],
    defaultSkill: '',
    claimTimeoutMin: 30,
    waitTimeoutSec: 240,
    dataDir: path.join(APP_ROOT, 'data'),
    ...raw,
  };
  // 旧配置只有单条 compile 命令时，转成一个配方
  if (!cfg.recipes && cfg.compile) {
    cfg.tools = [{ name: cfg.compile.command, command: cfg.compile.command, args: cfg.compile.args }];
    cfg.recipes = [{ name: cfg.compile.command, tools: [cfg.compile.command] }];
  }
  cfg.tools ??= [];
  cfg.recipes ??= [];
  cfg.favoriteSkills ??= [];
  cfg.configFile = found;
  // 相对路径按工具目录解析，从哪里启动都一样
  const abs = (p) => path.resolve(APP_ROOT, expandHome(p));
  cfg.projectRoot = abs(cfg.projectRoot);
  cfg.skillDirs = cfg.skillDirs.map(abs);
  cfg.dataDir = abs(cfg.dataDir);
  return cfg;
}
