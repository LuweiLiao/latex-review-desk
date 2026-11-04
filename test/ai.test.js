import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { AiSettings, AI_DEFAULTS, generateText, testConnection, buildPrompt, parseResult } from '../server/ai/index.js';

const prompt = { system: '系统说明', user: '请求内容' };
const config = (patch = {}) => ({ ...AI_DEFAULTS, apiKey: 'mock-secret', model: 'custom-model', ...patch });

async function server(t, handler) {
  const requests = [];
  const srv = http.createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    requests.push({ url: req.url, headers: req.headers, body: JSON.parse(body) });
    const answer = await handler(requests.at(-1), res);
    if (answer !== undefined && !res.writableEnded) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer));
    }
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  t.after(() => { srv.closeAllConnections(); srv.close(); });
  return { baseUrl: `http://127.0.0.1:${srv.address().port}/custom/v1`, requests };
}

for (const format of ['chat', 'responses', 'messages', 'generateContent']) {
  test(`AI HTTP native format: ${format}`, async (t) => {
    let reply = JSON.stringify({ action: 'reply', message: '无需修改。' });
    const mock = await server(t, () => ({
      chat: { model: 'served-model', choices: [{ finish_reason: 'stop', message: { content: reply } }] },
      responses: { model: 'served-model', status: 'completed', output: [{ type: 'reasoning', summary: [] }, { type: 'message', content: [{ type: 'output_text', text: reply }] }] },
      messages: { model: 'served-model', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: reply }] },
      generateContent: { modelVersion: 'served-model', candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'hidden', thought: true }, { text: reply }] } }] },
    })[format]);
    const provider = format === 'messages' ? 'anthropic' : format === 'generateContent' ? 'gemini' : 'openai';
    const settings = config({ provider, apiFormat: format, baseUrl: mock.baseUrl });
    const result = await generateText(settings, prompt);
    assert.equal(result.text, reply);
    assert.equal(result.model, 'served-model');
    const payload = { kind: 'polish', file: 'content/a.tex', quote: '原文句子。' };
    assert.equal(parseResult(result.text, payload).action, 'reply');
    const req = mock.requests[0];
    const suffix = { chat: '/chat/completions', responses: '/responses', messages: '/messages', generateContent: '/models/custom-model:generateContent' }[format];
    assert.equal(req.url, '/custom/v1' + suffix);
    assert.equal(req.headers['content-type'], 'application/json');
    if (provider === 'openai') {
      assert.equal(req.headers.authorization, 'Bearer mock-secret');
      assert.equal(req.body.model, 'custom-model');
      if (format === 'responses') {
        assert.equal(req.body.instructions, prompt.system);
        assert.equal(req.body.input[0].content, prompt.user);
        assert.equal(req.body.max_output_tokens, settings.maxTokens);
      } else {
        assert.deepEqual(req.body.messages, [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }]);
        assert.equal(req.body.max_completion_tokens, settings.maxTokens);
      }
    } else if (provider === 'anthropic') {
      assert.equal(req.headers['x-api-key'], 'mock-secret');
      assert.equal(req.headers['anthropic-version'], '2026-10-21');
      assert.equal(req.body.system, prompt.system);
      assert.equal(req.body.max_tokens, settings.maxTokens);
      assert.deepEqual(req.body.messages, [{ role: 'user', content: prompt.user }]);
    } else {
      assert.equal(req.headers['x-goog-api-key'], 'mock-secret');
      assert.equal(req.body.systemInstruction.parts[0].text, prompt.system);
      assert.equal(req.body.contents[0].parts[0].text, prompt.user);
      assert.equal(req.body.generationConfig.maxOutputTokens, settings.maxTokens);
      assert.equal(req.body.messages, undefined);
    }
    const tested = await testConnection(settings);
    assert.equal(tested.ok, true);
    assert.equal(tested.model, 'served-model');
    assert.ok(tested.latencyMs >= 0);
    assert.ok(!JSON.stringify(tested).includes('mock-secret'));
    reply = JSON.stringify({ action: 'proposal', edits: [{ original: payload.quote, replacement: '修改后的句子。' }] });
    assert.equal(parseResult((await generateText(settings, prompt)).text, payload).edits[0].replacement, '修改后的句子。');
  });
}

test('AI settings persist locally and redact keys on every public update', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-ai-settings-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const settings = new AiSettings(root);
  let changes = 0;
  settings.on('changed', () => changes++);
  const pub = settings.update({ apiKey: 'secret-original', model: 'user-model', madeUp: 'ignore' });
  assert.equal(pub.hasApiKey, true);
  assert.equal(pub.apiKey, undefined);
  assert.equal(pub.madeUp, undefined);
  assert.equal(pub.enabled, true);
  settings.update({ apiKey: '', model: 'other-model' });
  assert.equal(settings.get().apiKey, 'secret-original');
  assert.equal(new AiSettings(root).get().apiKey, 'secret-original');
  assert.equal(new AiSettings(root).get().model, 'other-model');
  assert.equal(settings.forRequest({ model: 'test-model' }).model, 'test-model');
  assert.equal(settings.get().model, 'other-model');
  settings.update({ provider: 'gemini' });
  assert.equal(settings.public().apiFormat, 'generateContent');
  assert.match(settings.public().baseUrl, /v1beta$/);
  assert.equal(settings.update({ clearApiKey: true }).hasApiKey, false);
  assert.equal(new AiSettings(root).get().apiKey, '');
  assert.equal(changes, 4);
  assert.throws(() => settings.update({ provider: 'invalid' }), /服务商/);
});

test('AI errors, non-JSON responses, refusal/truncation and cancellation', async (t) => {
  let mode = 'http';
  const mock = await server(t, (_req, res) => {
    if (mode === 'http') { res.writeHead(401); res.end(JSON.stringify({ error: { message: 'invalid mock-secret' } })); }
    else if (mode === 'html') { res.writeHead(502); res.end('<html>bad gateway</html>'); }
    else if (mode === 'cut') return { choices: [{ finish_reason: 'length', message: { content: '{"action":' } }] };
    else if (mode === 'empty') return { choices: [{ message: { refusal: 'blocked' } }] };
    else if (mode === 'hold') return undefined;
  });
  const cfg = config({ baseUrl: mock.baseUrl });
  await assert.rejects(generateText(cfg, prompt), (error) => /401/.test(error.message) && !error.message.includes('mock-secret'));
  mode = 'html';
  await assert.rejects(generateText(cfg, prompt), /非 JSON/);
  mode = 'cut';
  await assert.rejects(generateText(cfg, prompt), /length/);
  mode = 'empty';
  await assert.rejects(generateText(cfg, prompt), /没有返回文本/);
  mode = 'hold';
  await assert.rejects(generateText({ ...cfg, timeoutMs: 30 }, prompt), (error) => error.name === 'TimeoutError');
  const controller = new AbortController();
  const result = generateText(cfg, prompt, { signal: controller.signal });
  controller.abort();
  await assert.rejects(result, (error) => error.name === 'AbortError');
});

test('AI prompt includes skill, project rules, quote/context, thread and rejected history', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-ai-prompt-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'content'));
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '禁止自造词');
  fs.writeFileSync(path.join(root, 'content/AGENTS.md'), '沿用钢丝绳减振器');
  const cfg = { projectRoot: root, writingRules: '遵循项目术语', skillDirs: [path.resolve('skills')] };
  const payload = { kind: 'polish', file: 'content/ch4.tex', skill: { name: 'basic-polish' }, quote: '$x$ 保持稳定。', context: '前后段落', thread: [{ role: 'user', text: '不要扩大结论' }], previousProposals: [{ verdict: 'redo', feedback: '保留条件' }], instructions: '本段润色' };
  const result = buildPrompt(cfg, payload);
  assert.match(result.system, /禁止自造词/);
  assert.match(result.system, /钢丝绳减振器/);
  assert.match(result.system, /遵循项目术语/);
  assert.match(result.system, /基础论文润色/);
  assert.match(result.system, /控制科学与工程/);
  assert.deepEqual(JSON.parse(result.user), payload);
});

test('AI result parser distinguishes proposal, no-change and formula verdict', () => {
  const payload = { kind: 'polish', file: 'content/ch4.tex', quote: '原句。其他句。', quoteFound: true };
  const result = parseResult(JSON.stringify({ action: 'proposal', edits: [{ original: '原句。', replacement: '改句。' }], summary: '精简' }), payload);
  assert.equal(result.edits[0].file, payload.file);
  assert.equal(result.edits[0].replacement, '改句。');
  assert.equal(parseResult('```json\n{"action":"reply","message":"无需修改。"}\n```', payload).action, 'reply');
  assert.equal(parseResult('{"action":"reply","message":"公式正确。","verdict":"pass"}', { ...payload, kind: 'formula' }).verdict, 'pass');
  assert.throws(() => parseResult('{"action":"reply","message":"正确"}', { ...payload, kind: 'formula' }), /verdict/);
  assert.throws(() => parseResult('not json', payload), /JSON/);
  assert.throws(() => parseResult('{"action":"proposal","edits":[]}', payload), /edits/);
  assert.throws(() => parseResult('{"action":"proposal","edits":[{"original":"别处","replacement":"新句"}]}', payload), /quote/);
  assert.throws(() => parseResult('{"action":"proposal","edits":[{"original":"原句。","replacement":"原句。"}]}', payload), /相同/);
});
