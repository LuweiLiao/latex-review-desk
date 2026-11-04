import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TOOL_NAMES = ['pdflatex', 'xelatex', 'lualatex', 'latexmk', 'bibtex', 'biber', 'synctex', 'miktex'];
const CACHE_MS = 60_000;
let cached;
const compileCache = new Map();

export function userDirectories({ projectRoot = process.cwd(), env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const configBase = platform === 'win32' ? (env.APPDATA || paths.join(home, 'AppData', 'Roaming'))
    : platform === 'darwin' ? paths.join(home, 'Library', 'Application Support')
      : (env.XDG_CONFIG_HOME || paths.join(home, '.config'));
  const dataBase = platform === 'win32' ? (env.LOCALAPPDATA || paths.join(home, 'AppData', 'Local'))
    : platform === 'darwin' ? paths.join(home, 'Library', 'Application Support')
      : (env.XDG_DATA_HOME || paths.join(home, '.local', 'share'));
  const configDir = env.THESIS_REVIEW_CONFIG_DIR || paths.join(configBase, 'latex-review-desk');
  const dataRoot = paths.join(dataBase, 'latex-review-desk');
  const resolved = paths.resolve(projectRoot);
  const key = createHash('sha256').update(platform === 'win32' ? resolved.toLowerCase() : resolved).digest('hex').slice(0, 16);
  return { configDir, dataRoot, dataDir: env.THESIS_REVIEW_DATA_DIR || paths.join(dataRoot, 'projects', key) };
}

export function findExecutable(name, { env = process.env, platform = process.platform } = {}) {
  const windows = platform === 'win32';
  const paths = windows ? path.win32 : path.posix;
  const search = env.PATH ?? env.Path ?? env.path ?? '';
  // TeX tools are native executables; avoid invoking command scripts through a shell.
  const extensions = windows ? ['.exe', '.com', ''] : [''];
  const dirs = paths.isAbsolute(name) ? [''] : search.split(windows ? ';' : ':').filter(Boolean);
  for (const dir of dirs) {
    for (const ext of paths.extname(name) ? [''] : extensions) {
      const candidate = dir ? paths.join(dir.replace(/^"|"$/g, ''), name + ext) : name + ext;
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        fs.accessSync(candidate, windows ? fs.constants.F_OK : fs.constants.X_OK);
        return paths.resolve(candidate);
      } catch { /* Continue through PATH. */ }
    }
  }
  return null;
}

function run(command, args, { env = process.env, cwd, timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    execFile(command, args, { env, cwd, windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: !error, output: `${stdout || ''}${stderr || ''}`.trim(), error: error?.message || null, timedOut: Boolean(error?.killed) });
    });
  });
}

export function createEnvironmentDetector({ find = findExecutable, execute = run, now = Date.now, cacheMs = CACHE_MS } = {}) {
  let cache;
  return function detect({ refresh = false, env = process.env } = {}) {
    const key = JSON.stringify([env.PATH, env.Path, env.path, env.PATHEXT]);
    if (!refresh && cache && cache.key === key && now() - cache.time < cacheMs) return cache.promise;
    const promise = Promise.all(TOOL_NAMES.map(async (name) => {
      const executable = find(name, { env });
      if (!executable) return [name, { available: false, path: null, version: null, error: 'Not found on PATH' }];
      const result = await execute(executable, [name === 'latexmk' ? '-v' : '--version'], { env });
      const lines = result.output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const version = lines.find((line) => /(?:TeX|MiKTeX|Latexmk|biber|bibtex|synctex)/i.test(line)) || lines[0] || null;
      return [name, { available: true, path: executable, version, error: result.ok ? null : result.error }];
    })).then((entries) => {
      const tools = Object.fromEntries(entries);
      const distributions = [];
      for (const tool of Object.values(tools)) {
        const live = /TeX Live\s+([^\s)]+)/i.exec(tool.version || '');
        const miktex = /MiKTeX(?:[- ]|\s+)([\d.]+)/i.exec(tool.version || '');
        for (const item of [live && { name: 'TeX Live', version: live[1] }, miktex && { name: 'MiKTeX', version: miktex[1] }].filter(Boolean)) {
          if (!distributions.some((d) => d.name === item.name && d.version === item.version)) distributions.push(item);
        }
      }
      return { platform: process.platform, checkedAt: new Date(now()).toISOString(), distributions, tools };
    });
    cache = { key, time: now(), promise };
    return promise;
  };
}

export function detectEnvironment(options = {}) {
  cached ??= createEnvironmentDetector();
  return cached(options);
}

export async function checkMinimalCompile({ engine = 'pdflatex', environment, env = process.env, timeoutMs = 30_000, execute = run } = {}) {
  if (!['pdflatex', 'xelatex', 'lualatex'].includes(engine)) throw new Error(`Unsupported TeX engine: ${engine}`);
  const detected = environment || await detectEnvironment({ env });
  const tool = detected.tools[engine];
  if (!tool?.path) return { ok: false, engine, message: `${engine} not found on PATH`, log: '', durationMs: 0 };
  const started = Date.now();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'latex-review-desk-check-'));
  try {
    fs.writeFileSync(path.join(dir, 'check.tex'), '\\documentclass{article}\n\\begin{document}\nLaTeX review desk environment check.\n\\end{document}\n');
    const args = ['-no-shell-escape', '-interaction=nonstopmode', '-halt-on-error', '-file-line-error', '-synctex=1', 'check.tex'];
    const result = await execute(tool.path, args, { cwd: dir, env, timeoutMs });
    const pdf = path.join(dir, 'check.pdf');
    const pdfOk = fs.existsSync(pdf) && fs.readFileSync(pdf).subarray(0, 5).toString() === '%PDF-';
    const synctex = fs.existsSync(path.join(dir, 'check.synctex.gz'));
    const ok = result.ok && pdfOk && synctex;
    return { ok, engine, message: ok ? 'Minimal document compiled with PDF and SyncTeX output' : result.timedOut ? 'Compile check timed out' : result.error || 'Compile did not produce PDF and SyncTeX output', log: result.output.slice(-16000), durationMs: Date.now() - started };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export async function checkEnvironment({ engine, refresh = false, env = process.env } = {}) {
  const environment = await detectEnvironment({ refresh, env });
  engine ||= ['pdflatex', 'xelatex', 'lualatex'].find((name) => environment.tools[name].available) || 'pdflatex';
  const key = JSON.stringify([engine, environment.tools[engine]?.path, env.PATH, env.Path, env.path]);
  let entry = compileCache.get(key);
  if (refresh || !entry || Date.now() - entry.time >= CACHE_MS) {
    entry = { time: Date.now(), promise: checkMinimalCompile({ engine, environment, env }) };
    compileCache.set(key, entry);
  }
  return { ...environment, compile: await entry.promise };
}
