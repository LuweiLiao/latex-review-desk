import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { browserCommand, launchEnvironment, parseCli, waitForServer } from '../bin/latex-review-desk.js';

test('CLI parses project paths with spaces and rejects ambiguous or invalid options', () => {
  assert.deepEqual(parseCli(['paper project', '--no-open', '--port', '4399']), { project: 'paper project', 'no-open': true, port: '4399' });
  assert.equal(parseCli(['--project', 'paper']).project, 'paper');
  assert.throws(() => parseCli(['a', 'b']), /one project/);
  assert.throws(() => parseCli(['a', '--project', 'b']), /one project/);
  for (const port of ['0', '65536', 'abc', '43.5']) assert.throws(() => parseCli(['--port', port]), /Port/);
  assert.throws(() => parseCli(['--unknown']));
});

test('CLI env overrides are absolute and explicit config retains its project selection', () => {
  const cwd = path.resolve('test-launch');
  const env = launchEnvironment(parseCli(['paper', '--config', 'desk.json', '--data-dir', 'state', '--port', '4329', '--main', 'master.tex', '--pdf', 'output.pdf']), { cwd, env: {} });
  assert.equal(env.THESIS_REVIEW_PROJECT, path.join(cwd, 'paper'));
  assert.equal(env.THESIS_REVIEW_OPEN_PROJECT, '1');
  assert.equal(env.THESIS_REVIEW_CONFIG, path.join(cwd, 'desk.json'));
  assert.equal(env.THESIS_REVIEW_DATA_DIR, path.join(cwd, 'state'));
  assert.equal(env.THESIS_REVIEW_PORT, '4329');
  assert.equal(env.THESIS_REVIEW_MAIN_TEX, 'master.tex');
  assert.equal(env.THESIS_REVIEW_PDF, 'output.pdf');
  const explicit = launchEnvironment(parseCli(['--config', 'desk.json']), { cwd, env: {} });
  assert.equal(explicit.THESIS_REVIEW_PROJECT, undefined);
  assert.equal(explicit.THESIS_REVIEW_DATA_DIR, undefined);
  assert.equal(launchEnvironment(parseCli([]), { cwd, env: {} }).THESIS_REVIEW_PROJECT, cwd);
  assert.equal(launchEnvironment(parseCli([]), { cwd, env: {} }).THESIS_REVIEW_OPEN_PROJECT, '0');
  const inherited = launchEnvironment(parseCli([]), { cwd, env: { THESIS_REVIEW_PROJECT: 'other', THESIS_REVIEW_DATA_DIR: '/existing' } });
  assert.equal(inherited.THESIS_REVIEW_PROJECT, path.join(cwd, 'other'));
  assert.equal(inherited.THESIS_REVIEW_DATA_DIR, '/existing');
});

test('browser commands pass URL as an argument on each supported platform', () => {
  const url = 'http://127.0.0.1:4317/';
  assert.deepEqual(browserCommand(url, 'win32'), ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]);
  assert.deepEqual(browserCommand(url, 'darwin'), ['open', [url]]);
  assert.deepEqual(browserCommand(url, 'linux'), ['xdg-open', [url]]);
});

test('browser readiness stops if the server child exited', async () => {
  assert.equal(await waitForServer('http://127.0.0.1:1/', { exitCode: 1, signalCode: null }), false);
});

test('executable help/version work without loading a project or building frontend', () => {
  const cli = fileURLToPath(new URL('../bin/latex-review-desk.js', import.meta.url));
  const env = { ...process.env, THESIS_REVIEW_CONFIG: path.join(path.dirname(cli), 'missing.json') };
  const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8', env, windowsHide: true });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: latex-review-desk/);
  const version = spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8', env, windowsHide: true });
  assert.equal(version.status, 0);
  assert.match(version.stdout, /^\d+\.\d+\.\d+/);
});
