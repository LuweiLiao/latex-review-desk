import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { checkEnvironment, checkMinimalCompile, createEnvironmentDetector, findExecutable, userDirectories } from '../server/environment.js';

test('user config is global and project state directories are stable and distinct', () => {
  const options = { platform: 'linux', home: '/home/alice', env: {} };
  const a = userDirectories({ ...options, projectRoot: '/projects/a' });
  const b = userDirectories({ ...options, projectRoot: '/projects/b' });
  assert.equal(a.configDir, '/home/alice/.config/latex-review-desk');
  assert.equal(a.configDir, b.configDir);
  assert.equal(a.dataRoot, '/home/alice/.local/share/latex-review-desk');
  assert.notEqual(a.dataDir, b.dataDir);
  assert.deepEqual(a, userDirectories({ ...options, projectRoot: '/projects/a' }));
  const win = { platform: 'win32', home: 'C:\\Users\\Alice', env: { APPDATA: 'C:\\Roaming', LOCALAPPDATA: 'C:\\Local' } };
  assert.equal(userDirectories({ ...win, projectRoot: 'D:\\Paper' }).configDir, 'C:\\Roaming\\latex-review-desk');
  assert.equal(userDirectories({ ...win, projectRoot: 'D:\\Paper' }).dataDir, userDirectories({ ...win, projectRoot: 'd:\\paper' }).dataDir);
  assert.equal(userDirectories({ ...options, env: { XDG_CONFIG_HOME: '/cfg', XDG_DATA_HOME: '/data' } }).dataRoot, '/data/latex-review-desk');
  assert.equal(userDirectories({ ...options, env: { THESIS_REVIEW_CONFIG_DIR: '/custom', THESIS_REVIEW_DATA_DIR: '/state' } }).dataDir, '/state');
  assert.equal(userDirectories({ platform: 'darwin', home: '/Users/alice', env: {} }).configDir, '/Users/alice/Library/Application Support/latex-review-desk');
});

test('executable lookup ignores directories and uses the supplied PATH', () => {
  const name = path.basename(process.execPath);
  assert.equal(findExecutable(name, { env: { PATH: path.dirname(process.execPath) } }), process.execPath);
  assert.equal(findExecutable('not-a-tex-tool', { env: { PATH: '' } }), null);
});

test('detection shares in-flight calls, caches, refreshes, and identifies both distributions', async () => {
  let calls = 0;
  let time = 0;
  const detect = createEnvironmentDetector({
    now: () => time,
    find: (name) => ['pdflatex', 'xelatex', 'synctex'].includes(name) ? `/bin/${name}` : null,
    execute: async (command) => {
      calls++;
      return { ok: true, output: command.endsWith('pdflatex') ? 'pdfTeX (TeX Live 2025)' : command.endsWith('xelatex') ? 'MiKTeX-XeTeX 4.10 (MiKTeX 24.1)' : 'SyncTeX version 1.5' };
    },
  });
  const promise = detect({ env: { PATH: '/tex' } });
  assert.equal(promise, detect({ env: { PATH: '/tex' } }));
  const result = await promise;
  assert.equal(calls, 3);
  assert.deepEqual(result.distributions, [{ name: 'TeX Live', version: '2025' }, { name: 'MiKTeX', version: '24.1' }]);
  assert.equal(result.tools.biber.available, false);
  assert.equal(result.tools.synctex.path, '/bin/synctex');
  await detect({ env: { PATH: '/tex' }, refresh: true });
  assert.equal(calls, 6);
  time += 60_001;
  await detect({ env: { PATH: '/tex' } });
  assert.equal(calls, 9);
  await detect({ env: { PATH: '/other' } });
  assert.equal(calls, 12);
});

test('detected executable reports a version failure separately from availability', async () => {
  const detect = createEnvironmentDetector({ find: () => '/tex/tool', execute: async () => ({ ok: false, output: '', error: 'version timeout' }) });
  const report = await detect();
  assert.equal(report.tools.pdflatex.available, true);
  assert.equal(report.tools.pdflatex.error, 'version timeout');
});

test('minimal compile uses only a generated temporary document and removes artifacts', async () => {
  let temporary;
  const result = await checkMinimalCompile({
    environment: { tools: { pdflatex: { path: '/tex/pdflatex' } } },
    execute: async (command, args, options) => {
      temporary = options.cwd;
      assert.equal(path.dirname(temporary), os.tmpdir());
      assert.equal(command, '/tex/pdflatex');
      assert.equal(args.at(-1), 'check.tex');
      assert.match(fs.readFileSync(path.join(temporary, 'check.tex'), 'utf8'), /LaTeX review desk environment check/);
      fs.writeFileSync(path.join(temporary, 'check.pdf'), '%PDF-1.5\ntest');
      fs.writeFileSync(path.join(temporary, 'check.synctex.gz'), 'test');
      return { ok: true, output: 'compiled' };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(temporary), false);
});

test('minimal compile reports timeout, missing tools, and missing SyncTeX output', async () => {
  const environment = { tools: { pdflatex: { path: '/tex/pdflatex' } } };
  let temporary;
  const timeout = await checkMinimalCompile({ environment, execute: async (_command, _args, options) => {
    temporary = options.cwd;
    return { ok: false, output: 'stalled', timedOut: true };
  } });
  assert.equal(timeout.ok, false);
  assert.match(timeout.message, /timed out/);
  assert.equal(fs.existsSync(temporary), false);
  const missing = await checkMinimalCompile({ environment: { tools: {} } });
  assert.equal(missing.ok, false);
  const incomplete = await checkMinimalCompile({ environment, execute: async (_command, _args, { cwd }) => {
    fs.writeFileSync(path.join(cwd, 'check.pdf'), '%PDF-1.5');
    return { ok: true, output: '' };
  } });
  assert.equal(incomplete.ok, false);
  await assert.rejects(checkMinimalCompile({ engine: 'latexmk' }), /Unsupported TeX engine/);
});

test('minimal compile removes its directory even if the runner throws', async () => {
  let temporary;
  await assert.rejects(checkMinimalCompile({ environment: { tools: { pdflatex: { path: '/tex/pdflatex' } } }, execute: async (_command, _args, { cwd }) => {
    temporary = cwd;
    throw new Error('runner failed');
  } }), /runner failed/);
  assert.equal(fs.existsSync(temporary), false);
});

test('environment compile checks share cached results and support explicit refresh', async () => {
  const env = { PATH: '' };
  const first = await checkEnvironment({ env });
  const second = await checkEnvironment({ env });
  assert.equal(first.compile.engine, 'pdflatex');
  assert.equal(first.compile.ok, false);
  assert.equal(first.compile, second.compile);
  const refreshed = await checkEnvironment({ env, refresh: true });
  assert.notEqual(first.compile, refreshed.compile);
});
