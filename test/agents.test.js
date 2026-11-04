import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { AiSettings } from '../server/ai/settings.js';

test('multiple agents keep separate keys/models and route each review kind', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lrd-agents-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const settings = new AiSettings(dir);
  settings.update({ apiKey: 'first-secret', model: 'first-model' });
  const second = settings.addAgent({ name: '公式审核', provider: 'anthropic', apiKey: 'second-secret', model: 'second-model', systemPrompt: '检查符号定义。' });
  settings.update({ assignments: { formula: second.id } });
  assert.equal(settings.getFor('polish').apiKey, 'first-secret');
  assert.equal(settings.getFor('formula').model, 'second-model');
  assert.equal(settings.getFor('formula').systemPrompt, '检查符号定义。');
  assert.equal(JSON.stringify(settings.public()).includes('secret'), false);
  settings.updateAgent(second.id, { apiKey: '', model: 'second-edited' });
  assert.equal(settings.getFor('formula').apiKey, 'second-secret');
  const reopened = new AiSettings(dir);
  assert.equal(reopened.getFor('formula').model, 'second-edited');
  assert.equal(reopened.getFor('polish').model, 'first-model');
  reopened.update({ activeAgentId: second.id });
  assert.equal(reopened.get().model, 'second-edited');
  reopened.removeAgent(second.id);
  assert.equal(reopened.getFor('formula').model, 'first-model');
});

test('a legacy single API configuration becomes the default agent without losing credentials', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lrd-agent-legacy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'ai-settings.json'), JSON.stringify({ provider: 'gemini', model: 'old-model', apiKey: 'old-key' }));
  const settings = new AiSettings(dir);
  assert.equal(settings.public().agents.length, 1);
  assert.equal(settings.getFor('comment').apiKey, 'old-key');
  assert.equal(settings.get().apiFormat, 'generateContent');
});
