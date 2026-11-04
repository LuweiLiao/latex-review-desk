import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { test } from 'node:test';
import { createApp } from '../server/index.js';

test('AI REST config redacts saved keys and tests all four formats through temporary HTTP endpoints', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-ai-rest-'));
  const requests = [];
  const provider = http.createServer(async (req, res) => {
    let raw = '';
    for await (const data of req) raw += data;
    requests.push({ url: req.url, headers: req.headers, body: JSON.parse(raw) });
    const content = req.url.endsWith('/responses') ? { output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }] }
      : req.url.endsWith('/messages') ? { content: [{ type: 'text', text: 'OK' }] }
        : req.url.endsWith(':generateContent') ? { candidates: [{ content: { parts: [{ text: 'OK' }] } }] }
          : { choices: [{ message: { content: 'OK' } }] };
    res.end(JSON.stringify({ model: 'served-test-model', ...content }));
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const cfg = { projectRoot: null, configDir: path.join(root, 'config'), dataDir: path.join(root, 'data'), sourceDirs: [], extraSources: [], skillDirs: [path.resolve('skills')], defaultSkill: 'basic-polish', favoriteSkills: [], tools: [], recipes: [] };
  const app = createApp(cfg);
  const desk = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => desk.once('listening', resolve));
  t.after(async () => {
    await app.locals.close();
    desk.closeAllConnections(); desk.close();
    provider.closeAllConnections(); provider.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${desk.address().port}`;
  const request = async (method, route, data) => {
    const response = await fetch(url + route, { method, headers: { 'content-type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    return result;
  };
  for (const format of ['openai', 'openai-responses', 'anthropic', 'gemini']) {
    const saved = await request('PUT', '/api/ai/config', { format, baseUrl: `http://127.0.0.1:${provider.address().port}/custom`, model: 'saved-model', apiKey: 'rest-secret' });
    assert.equal(saved.format, format);
    assert.equal(saved.hasApiKey, true);
    assert.equal(saved.apiKey, undefined);
    assert.ok(!JSON.stringify(await request('GET', '/api/ai/config')).includes('rest-secret'));
    const tested = await request('POST', '/api/ai/test', { model: 'temporary-test-model', apiKey: '' });
    assert.equal(tested.ok, true);
    assert.equal((await request('GET', '/api/ai/config')).model, 'saved-model');
    const last = requests.at(-1);
    if (format === 'gemini') {
      assert.equal(last.url, '/custom/models/temporary-test-model:generateContent');
      assert.equal(last.headers['x-goog-api-key'], 'rest-secret');
    } else {
      assert.equal(last.body.model, 'temporary-test-model');
      assert.equal(last.headers[format === 'anthropic' ? 'x-api-key' : 'authorization'], format === 'anthropic' ? 'rest-secret' : 'Bearer rest-secret');
    }
  }
  assert.ok(!JSON.stringify(await request('GET', '/api/state')).includes('rest-secret'));
});
