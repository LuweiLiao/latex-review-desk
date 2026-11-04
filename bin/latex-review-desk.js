#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { checkEnvironment, detectEnvironment, userDirectories } from '../server/environment.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const HELP = `Usage: latex-review-desk [project] [options]

  --project <dir>       LaTeX project directory (default: current directory)
  --config <file>       Configuration file
  --config-dir <dir>    User configuration directory
  --data-dir <dir>      Review data directory
  --port <number>       Local HTTP port (default: 4317)
  --main <file>         Main TeX file (default: main.tex)
  --pdf <file>          Output PDF file
  --no-open            Do not open the browser
  --diagnose           Print cached TeX environment diagnostics as JSON and exit
  --check-compile       Check a generated document in a temporary directory
  --engine <name>       Diagnostic engine: pdflatex, xelatex, lualatex
  --refresh            Refresh environment detection
  -h, --help           Show this help
  -v, --version        Show package version
`;

export function parseCli(argv) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    project: { type: 'string' }, config: { type: 'string' }, 'config-dir': { type: 'string' }, 'data-dir': { type: 'string' },
    port: { type: 'string' }, main: { type: 'string' }, pdf: { type: 'string' }, 'no-open': { type: 'boolean' },
    diagnose: { type: 'boolean' }, 'check-compile': { type: 'boolean' }, engine: { type: 'string' }, refresh: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
  } });
  if (positionals.length > 1 || (positionals.length && values.project)) throw new Error('Specify one project directory');
  if (values.port !== undefined && (!/^\d+$/.test(values.port) || +values.port < 1 || +values.port > 65535)) throw new Error('Port must be between 1 and 65535');
  return { ...values, project: values.project || positionals[0] };
}

export function launchEnvironment(options, { env = process.env, cwd = process.cwd() } = {}) {
  const next = { ...env };
  const absolute = (value) => path.resolve(cwd, value);
  if (options.project) next.THESIS_REVIEW_OPEN_PROJECT = '1';
  else next.THESIS_REVIEW_OPEN_PROJECT ??= next.THESIS_REVIEW_PROJECT ? '1' : '0';
  if (options.config) next.THESIS_REVIEW_CONFIG = absolute(options.config);
  if (options.project || !next.THESIS_REVIEW_CONFIG) next.THESIS_REVIEW_PROJECT = absolute(options.project || next.THESIS_REVIEW_PROJECT || '.');
  if (options['config-dir']) next.THESIS_REVIEW_CONFIG_DIR = absolute(options['config-dir']);
  next.THESIS_REVIEW_CONFIG_DIR ||= userDirectories({ env: next }).configDir;
  if (options['data-dir']) next.THESIS_REVIEW_DATA_DIR = absolute(options['data-dir']);
  for (const [option, key] of [['port', 'PORT'], ['main', 'MAIN_TEX'], ['pdf', 'PDF']]) {
    if (options[option] !== undefined) next[`THESIS_REVIEW_${key}`] = options[option];
  }
  return next;
}

export function browserCommand(url, platform = process.platform) {
  if (platform === 'win32') return ['rundll32.exe', ['url.dll,FileProtocolHandler', url]];
  if (platform === 'darwin') return ['open', [url]];
  return ['xdg-open', [url]];
}

export function openBrowser(url) {
  const [command, args] = browserCommand(url);
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', (error) => console.error(`Browser could not open: ${error.message}. Open ${url}`));
  child.unref();
}

export async function waitForServer(url, child, timeoutMs = 15_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (child.exitCode !== null || child.signalCode !== null) return false;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (response.ok) return true;
    } catch { /* The child has not started listening yet. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseCli(argv);
  if (options.help) return console.log(HELP);
  if (options.version) return console.log(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version);
  if (options.diagnose || options['check-compile']) {
    const report = options['check-compile'] ? await checkEnvironment({ engine: options.engine, refresh: options.refresh }) : await detectEnvironment({ refresh: options.refresh });
    console.log(JSON.stringify(report, null, 2));
    if (report.compile && !report.compile.ok) process.exitCode = 1;
    return;
  }
  const env = launchEnvironment(options);
  const { loadConfig } = await import('../server/config.js');
  Object.assign(process.env, env);
  const cfg = loadConfig();
  const child = spawn(process.execPath, [path.join(root, 'server', 'index.js')], { env, stdio: ['inherit', 'pipe', 'inherit'], windowsHide: true });
  const url = `http://127.0.0.1:${cfg.port}/`;
  let output = '', opening = false;
  child.stdout.on('data', (chunk) => {
    process.stdout.write(chunk);
    output = (output + chunk.toString()).slice(-4096);
    // Wait for this child's listening announcement before probing the port.
    if (!options['no-open'] && !opening && output.includes(url)) {
      opening = true;
      waitForServer(`${url}api/state`, child).then((ready) => { if (ready) openBrowser(url); });
    }
  });
  const terminate = () => { if (child.exitCode === null) child.kill('SIGTERM'); };
  process.once('SIGINT', terminate);
  process.once('SIGTERM', terminate);
  child.once('error', (error) => { console.error(error.message); process.exitCode = 1; });
  child.once('exit', (code, signal) => {
    process.removeListener('SIGINT', terminate);
    process.removeListener('SIGTERM', terminate);
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
