import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { createApp } from '../server/index.js';
import { loadConfig } from '../server/config.js';

const SOURCE = '\\documentclass{article}\n\\begin{document}\nThis controller improves the tracking performance.\n\\end{document}\n';
async function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-http-'));
  const cfg = loadConfig(null, { THESIS_REVIEW_CONFIG_DIR: path.join(root, 'config'), THESIS_REVIEW_DATA_DIR: path.join(root, 'data') });
  cfg.port = 0;
  const app = createApp(cfg);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { await app.locals.close(); await new Promise((done) => server.close(done)); fs.rmSync(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, project) => {
    const response = await fetch(base + url, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(project ? { 'X-Project-Id': project } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const value = await response.json();
    assert.ok(response.ok, JSON.stringify(value));
    return value;
  };
  const add = async (name, source = SOURCE) => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'main.tex'), source);
    return call('POST', '/api/projects', { projectRoot: dir, name });
  };
  return { root, app, base, call, add };
}

test('HTTP starts without a project and returns bundled polishing rules', async (t) => {
  const { call } = await setup(t);
  const state = await call('GET', '/api/state');
  assert.equal(state.project, null);
  assert.deepEqual(state.files, []);
  assert.ok((await call('GET', '/api/skills')).some((x) => x.name === 'basic-polish'));
  const config = await call('GET', '/api/ai/config');
  assert.equal(config.hasApiKey, false);
  assert.equal(config.format, 'openai');
});

test('HTTP project contexts isolate identical names, state, and writes after global selection changes', async (t) => {
  const { call, add } = await setup(t);
  const a = await add('paper-a');
  const b = await add('paper-b', SOURCE.replace('tracking', 'position'));
  const file = await call('GET', '/api/file?path=main.tex', undefined, a.id);
  await call('PUT', '/api/file', { path: 'main.tex', text: file.text.replace('tracking', 'trajectory'), baseHash: file.hash }, a.id);
  await call('POST', `/api/projects/${b.id}/activate`, {});
  const [sa, sb] = await Promise.all([call('GET', '/api/state', undefined, a.id), call('GET', '/api/state', undefined, b.id)]);
  assert.equal(sa.projectId, a.id); assert.equal(sb.projectId, b.id);
  assert.match((await call('GET', '/api/file?path=main.tex', undefined, a.id)).text, /trajectory/);
  assert.match((await call('GET', '/api/file?path=main.tex', undefined, b.id)).text, /position/);
  const text = 'This controller improves the trajectory performance.';
  await call('POST', '/api/items', { kind: 'comment', comment: 'Review this sentence', anchor: { source: 'source', file: 'main.tex', from: file.text.indexOf('This'), to: file.text.indexOf('This') + text.length, quote: text } }, a.id);
  assert.equal((await call('GET', '/api/items', undefined, a.id)).length, 1);
  assert.equal((await call('GET', '/api/items', undefined, b.id)).length, 0);
});

test('HTTP directory import keeps binary assets and exposes project config updates', async (t) => {
  const { root, call } = await setup(t);
  const project = await call('POST', '/api/projects/import', { name: 'copy', files: [
    { path: 'main.tex', content: Buffer.from(SOURCE).toString('base64'), encoding: 'base64' },
    { path: 'fig/image.bin', content: 'AP8NgA==', encoding: 'base64' },
  ] });
  assert.ok(project.projectRoot.startsWith(root));
  assert.deepEqual(fs.readFileSync(path.join(project.projectRoot, 'fig/image.bin')), Buffer.from([0, 255, 13, 128]));
  const updated = await call('PATCH', `/api/projects/${project.id}`, { writingRules: 'Use plain control-engineering terms.', name: 'renamed' });
  assert.equal(updated.name, 'renamed');
  assert.equal(updated.writingRules, 'Use plain control-engineering terms.');
  assert.ok((await call('GET', `/api/projects/${project.id}/tree`)).children.some((x) => x.name === 'fig'));
});

test('HTTP settings map four API formats without returning secrets', async (t) => {
  const { call } = await setup(t);
  for (const format of ['openai', 'openai-responses', 'anthropic', 'gemini']) {
    const saved = await call('PUT', '/api/ai/config', { format, apiKey: 'test-secret', model: 'mock-model', enabled: false });
    assert.equal(saved.format, format);
    assert.equal(saved.hasApiKey, true);
    assert.equal('apiKey' in saved, false);
    assert.ok(!JSON.stringify(saved).includes('test-secret'));
    const kept = await call('PUT', '/api/ai/config', { apiKey: '' });
    assert.equal(kept.hasApiKey, true);
  }
});

test('HTTP direct API proposal stays off disk until acceptance and supports undo', async (t) => {
  const { call, add } = await setup(t);
  const mock = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    assert.match(body.messages[1].content, /This controller/);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ model: 'mock-model', choices: [{ message: { content: JSON.stringify({ action: 'proposal', edits: [{ original: 'improves the tracking performance', replacement: 'improves tracking performance' }], rationale: 'Remove redundant words.', fidelity: 'Preserve technical meaning.', summary: 'Concise wording' }) }, finish_reason: 'stop' }] }));
  });
  mock.listen(0, '127.0.0.1'); await once(mock, 'listening');
  t.after(() => new Promise((done) => mock.close(done)));
  const project = await add('api-paper');
  await call('PUT', '/api/ai/config', { format: 'openai', baseUrl: `http://127.0.0.1:${mock.address().port}/v1`, apiKey: 'test', model: 'mock-model', enabled: true });
  const quote = 'This controller improves the tracking performance.';
  const item = await call('POST', '/api/items', { kind: 'polish', anchor: { source: 'source', file: 'main.tex', from: SOURCE.indexOf(quote), to: SOURCE.indexOf(quote) + quote.length, quote } }, project.id);
  let final;
  for (let i = 0; i < 100; i++) {
    final = (await call('GET', '/api/items', undefined, project.id)).find((x) => x.id === item.id);
    if (final.status === 'proposed' || final.ai?.state === 'error') break;
    await new Promise((done) => setTimeout(done, 10));
  }
  assert.equal(final.status, 'proposed', JSON.stringify(final.ai));
  assert.equal(fs.readFileSync(path.join(project.projectRoot, 'main.tex'), 'utf8'), SOURCE);
  await call('POST', `/api/items/${item.id}/accept`, {}, project.id);
  assert.match(fs.readFileSync(path.join(project.projectRoot, 'main.tex'), 'utf8'), /improves tracking performance/);
  await call('POST', `/api/items/${item.id}/undo`, {}, project.id);
  assert.equal(fs.readFileSync(path.join(project.projectRoot, 'main.tex'), 'utf8'), SOURCE);
});
