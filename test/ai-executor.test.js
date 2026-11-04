import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { test } from 'node:test';
import { Review } from '../server/core.js';
import { Jobs } from '../server/jobs.js';
import { Store } from '../server/store.js';
import { TexFiles } from '../server/texfiles.js';
import { AiSettings, AiExecutor } from '../server/ai/index.js';

const SRC = '\\section{控制设计}\n第一段介绍控制对象，并说明系统受到的外部扰动。\n\n第二段介绍控制方法，并说明闭环系统的稳定性条件。\n\n第三段介绍实验结果，并说明跟踪误差的变化。\n';
const noChange = { action: 'reply', message: '无需修改，表述清楚。' };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate) {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('等待执行器状态超时');
    await sleep(5);
  }
}

async function setup(t, handler = () => noChange, { configured = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-ai-executor-'));
  fs.mkdirSync(path.join(root, 'content'));
  const source = path.join(root, 'content/a.tex');
  fs.writeFileSync(source, SRC);
  const requests = [];
  const srv = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const input = JSON.parse(body.messages[1].content);
    requests.push({ body, payload: input, res });
    const result = await handler(input, res, requests.length);
    if (result !== undefined && !res.destroyed && !res.writableEnded) res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }] }));
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const cfg = { projectRoot: root, dataDir: path.join(root, 'data'), pdf: 'none.pdf', sourceDirs: ['content'], extraSources: [], skillDirs: [path.resolve('skills')], defaultSkill: 'basic-polish', claimTimeoutMin: 30, writingRules: '保持闭环稳定性条件。' };
  const files = new TexFiles(cfg);
  const store = new Store(cfg.dataDir);
  const review = new Review(cfg, files, store);
  const jobs = new Jobs(cfg, files, store, review);
  const settings = new AiSettings(path.join(root, 'global-settings'));
  const baseUrl = `http://127.0.0.1:${srv.address().port}/v1`;
  if (configured) settings.update({ model: 'mock-model', apiKey: 'mock-key', baseUrl });
  const executor = new AiExecutor({ cfg, review, jobs, settings });
  t.after(async () => {
    await executor.stop();
    clearInterval(review.timer);
    srv.closeAllConnections();
    srv.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const create = (quote = '第一段介绍控制对象，并说明系统受到的外部扰动。', extra = {}) => review.create({ kind: 'polish', anchor: { source: 'source', file: 'content/a.tex', from: SRC.indexOf(quote), to: SRC.indexOf(quote) + quote.length, quote }, ...extra });
  const raw = () => fs.readFileSync(source, 'utf8');
  return { root, cfg, files, review, jobs, settings, executor, requests, create, raw, baseUrl };
}

test('AI executor dispatches automatically and leaves acceptance/rejection/undo to Review', async (t) => {
  const s = await setup(t, (payload) => ({ action: 'proposal', edits: [{ original: payload.quote, replacement: payload.quote.replace('并说明', '说明') }], summary: '删去重复连接词', rationale: '使句子简洁。', fidelity: '保留控制对象和外部扰动。' }));
  s.executor.start();
  const item = await s.create();
  await until(() => s.review.find(item.id).status === 'proposed');
  assert.equal(s.raw(), SRC);
  assert.equal(s.review.find(item.id).ai.state, 'done');
  assert.match(s.requests[0].body.messages[0].content, /保持闭环稳定性条件/);
  s.review.accept(item.id);
  assert.notEqual(s.raw(), SRC);
  s.review.undo(item.id);
  assert.equal(s.raw(), SRC);
  s.review.reject(item.id, '保留原文');
  assert.equal(s.review.find(item.id).status, 'rejected');
  assert.equal(s.raw(), SRC);
  s.review.requeue(item.id, '保留条件，再改一次');
  await until(() => s.requests.length === 2 && s.review.find(item.id).status === 'proposed');
  assert.match(JSON.stringify(s.requests[1].payload.thread), /保留条件/);
  assert.ok(s.requests[1].payload.previousProposals.length);
});

test('AI executor drains sequential Jobs using proposals and no-change replies without a monitor', async (t) => {
  const s = await setup(t, (payload) => payload.job.index === 1 ? { action: 'proposal', edits: [{ original: '并说明', replacement: '说明' }] } : noChange);
  s.executor.start();
  const job = await s.jobs.create({ anchor: { source: 'source', file: 'content/a.tex', whole: true }, concurrency: 1 });
  await until(() => s.jobs.find(job.id).status === 'done');
  assert.equal(s.requests.length, 3);
  assert.deepEqual(s.requests.map((r) => r.payload.job.index), [1, 2, 3]);
  assert.deepEqual(s.review.items.map((it) => it.status), ['proposed', 'replied', 'replied']);
  assert.equal(s.raw(), SRC);
  assert.equal(s.jobs.view(s.jobs.find(job.id)).counts.proposed, 1);
});

test('AI executor errors are visible, release claims and wait for explicit retry', async (t) => {
  let fail = true;
  const s = await setup(t, (_payload, res) => {
    if (fail) { res.writeHead(429); res.end(JSON.stringify({ error: { message: 'quota mock-key' } })); return undefined; }
    return noChange;
  });
  s.executor.start();
  const item = await s.create();
  await until(() => s.review.find(item.id).ai?.state === 'error' && s.executor.status().busy === 0);
  assert.equal(s.review.find(item.id).status, 'pending');
  assert.equal(s.executor.status().state, 'error');
  assert.match(s.executor.status().lastError, /429/);
  assert.ok(!JSON.stringify(s.executor.status()).includes('mock-key'));
  s.executor.kick();
  s.review.emit('changed');
  await sleep(40);
  assert.equal(s.requests.length, 1);
  fail = false;
  s.executor.retry(item.id);
  await until(() => s.review.find(item.id).status === 'replied');
  assert.equal(s.requests.length, 2);
  assert.equal(s.raw(), SRC);
});

test('AI executor explicit cancellation and stop abort HTTP requests and release only their claims', async (t) => {
  let hold = true;
  const s = await setup(t, () => hold ? undefined : noChange);
  s.executor.start();
  const item = await s.create();
  await until(() => s.requests.length === 1);
  s.executor.cancel(item.id);
  await until(() => s.executor.status().busy === 0);
  assert.equal(s.review.find(item.id).status, 'pending');
  assert.equal(s.review.find(item.id).ai.state, 'cancelled');
  s.executor.kick();
  await sleep(30);
  assert.equal(s.requests.length, 1);
  hold = false;
  s.executor.retry(item.id);
  await until(() => s.review.find(item.id).status === 'replied');
  hold = true;
  const next = await s.create('第二段介绍控制方法，并说明闭环系统的稳定性条件。');
  await until(() => s.requests.length === 3);
  await s.executor.stop();
  assert.equal(s.review.find(next.id).status, 'pending');
  s.review.emit('pending');
  await sleep(30);
  assert.equal(s.requests.length, 3);
  assert.equal(s.executor.status().running, false);
});

test('AI executor excludes paused jobs and resumes automatically', async (t) => {
  let hold = true;
  const s = await setup(t, () => hold ? undefined : noChange);
  const job = await s.jobs.create({ anchor: { source: 'source', file: 'content/a.tex', whole: true }, concurrency: 1 });
  s.jobs.pause(job.id);
  s.executor.start();
  await sleep(30);
  assert.equal(s.requests.length, 0);
  s.jobs.resume(job.id);
  await until(() => s.requests.length === 1);
  s.jobs.pause(job.id);
  await until(() => s.executor.status().busy === 0);
  assert.equal(s.review.items[0].status, 'pending');
  hold = false;
  s.jobs.resume(job.id);
  await until(() => s.jobs.find(job.id).status === 'done');
  assert.equal(s.requests.length, 4);
  assert.equal(s.raw(), SRC);
});

test('AI executor starts pending work on global settings changes and ignores another claimant', async (t) => {
  const s = await setup(t, () => noChange, { configured: false });
  const external = await s.create();
  s.review.claimIds([external.id]);
  const item = await s.create('第二段介绍控制方法，并说明闭环系统的稳定性条件。');
  s.executor.start();
  assert.equal(s.executor.status().state, 'unconfigured');
  s.settings.update({ model: 'mock-model', apiKey: 'mock-key', baseUrl: s.baseUrl });
  await until(() => s.review.find(item.id).status === 'replied');
  assert.equal(s.review.find(external.id).status, 'claimed');
  assert.equal(s.requests.length, 1);
});

test('AI executor cancels in-flight work when its Job is cancelled', async (t) => {
  const s = await setup(t, () => undefined);
  const job = await s.jobs.create({ anchor: { source: 'source', file: 'content/a.tex', whole: true }, concurrency: 1 });
  s.executor.start();
  await until(() => s.requests.length === 1);
  s.jobs.cancel(job.id);
  await until(() => s.executor.status().busy === 0);
  s.executor.kick();
  await sleep(30);
  assert.equal(s.requests.length, 1);
  assert.equal(s.jobs.find(job.id).status, 'cancelled');
  assert.equal(s.review.items[0].proposal, null);
  assert.equal(s.raw(), SRC);
});

test('AI executor discards an old response when a request is requeued during HTTP execution', async (t) => {
  const s = await setup(t, (_payload, _res, count) => count === 1 ? undefined : noChange);
  s.executor.start();
  const item = await s.create();
  await until(() => s.requests.length === 1);
  s.review.requeue(item.id, '保留技术条件，重新处理');
  await until(() => s.review.find(item.id).status === 'replied');
  assert.equal(s.requests.length, 2);
  assert.match(JSON.stringify(s.requests[1].payload.thread), /保留技术条件/);
  assert.equal(s.review.find(item.id).thread.filter((x) => x.role === 'agent').length, 1);
  assert.equal(s.raw(), SRC);
});

test('AI executor respects concurrency and handles native formula verdicts', async (t) => {
  let release;
  const ready = new Promise((resolve) => { release = resolve; });
  const s = await setup(t, async (payload) => {
    await ready;
    return payload.kind === 'formula' ? { action: 'reply', message: '公式符号一致。', verdict: 'pass' } : noChange;
  });
  s.settings.update({ concurrency: 2 });
  await s.create();
  await s.create('第二段介绍控制方法，并说明闭环系统的稳定性条件。');
  const formula = await s.create('第三段介绍实验结果，并说明跟踪误差的变化。', { kind: 'formula', skill: '' });
  s.executor.start();
  await until(() => s.requests.length === 2);
  assert.equal(s.executor.status().busy, 2);
  assert.equal(s.review.items.filter((x) => x.status === 'pending').length, 1);
  release();
  await until(() => s.review.items.every((x) => x.status === 'replied'));
  assert.equal(s.requests.length, 3);
  assert.equal(s.review.find(formula.id).verdict, 'pass');
});

test('AI executor preserves failed requests across reconstruction and requeue permits another attempt', async (t) => {
  let fail = true;
  const s = await setup(t, (_payload, res) => {
    if (fail) { res.writeHead(503); res.end(JSON.stringify({ error: { message: '暂不可用' } })); return undefined; }
    return noChange;
  });
  s.executor.start();
  const item = await s.create();
  await until(() => s.review.find(item.id).ai?.state === 'error' && !s.executor.status().busy);
  await s.executor.stop();
  const replacement = new AiExecutor({ cfg: s.cfg, review: s.review, jobs: s.jobs, settings: s.settings });
  t.after(() => replacement.stop());
  replacement.start();
  await sleep(30);
  assert.equal(s.requests.length, 1);
  fail = false;
  s.review.requeue(item.id, '重试此段');
  await until(() => s.review.find(item.id).status === 'replied');
  assert.equal(s.requests.length, 2);
});
