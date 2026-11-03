import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Review } from '../server/core.js';
import { Jobs } from '../server/jobs.js';
import { splitParagraphs } from '../server/paragraphs.js';
import { Store } from '../server/store.js';
import { TexFiles } from '../server/texfiles.js';

const SRC = [
  '\\section{引言}',
  '\\label{sec:x}',
  '第一段正文，介绍研究背景与意义，内容足够长。',
  '第一段的第二行，仍然属于同一段。',
  '',
  '第二段正文，说明本章的主要工作内容。',
  '\\begin{equation}',
  '  x = y + z',
  '  \\label{eq:a}',
  '\\end{equation}',
  '式中，x 为状态量，y 为输入量，z 为扰动量。',
  '',
  '\\begin{figure}[H]',
  '  \\centering',
  '  \\caption{一张图的标题文字很长很长很长}',
  '\\end{figure}',
  '% 注释掉的一段文字不应被处理，即使它很长很长',
  '短句。',
  '',
  '\\[ a = b \\]',
  '第四段正文：公式后面接着写的文字内容。',
].join('\n');

test('拆段：跳过标题、公式、图表、注释和过短的行', () => {
  const segs = splitParagraphs(SRC).map((s) => SRC.slice(s.start, s.end));
  assert.deepEqual(segs, [
    '第一段正文，介绍研究背景与意义，内容足够长。\n第一段的第二行，仍然属于同一段。',
    '第二段正文，说明本章的主要工作内容。',
    '式中，x 为状态量，y 为输入量，z 为扰动量。',
    '第四段正文：公式后面接着写的文字内容。',
  ]);
});

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trj-'));
  fs.mkdirSync(path.join(root, 'content'));
  fs.writeFileSync(path.join(root, 'content', 'a.tex'), SRC);
  const skills = path.join(root, 'skills', 'humanizer-zh');
  fs.mkdirSync(skills, { recursive: true });
  fs.writeFileSync(path.join(skills, 'SKILL.md'), '---\nname: humanizer-zh\ndescription: x\n---\n');
  const cfg = {
    projectRoot: root, pdf: 'none.pdf', sourceDirs: ['content'], extraSources: [], skillDirs: [path.join(root, 'skills')],
    defaultSkill: 'humanizer-zh', claimTimeoutMin: 30, waitTimeoutSec: 5, dataDir: path.join(root, 'data'),
  };
  const files = new TexFiles(cfg);
  const store = new Store(cfg.dataDir);
  const review = new Review(cfg, files, store);
  const jobs = new Jobs(cfg, files, store, review);
  return { review, jobs, root };
}

const settle = (jobs) => jobs.tick();

test('逐段任务：一次只放一段，交了方案再放下一段，全部交完算完成', async () => {
  const { review, jobs } = setup();
  const j = await jobs.create({ anchor: { source: 'source', file: 'content/a.tex', whole: true }, skill: 'humanizer-zh', concurrency: 1 });
  assert.equal(j.total, 4);
  assert.equal(review.items.length, 1, '只放出第一段');
  assert.equal(review.items[0].job.index, 1);

  const [r1] = review.claim(3);
  assert.match(r1.instructions, /第 1\/4 段/);
  assert.match(r1.quote, /^第一段正文/);
  await settle(jobs);
  assert.equal(review.items.length, 1, '处理中时不放下一段');

  review.submit(r1.id, { edits: [{ original: '内容足够长', replacement: '内容充分' }] });
  await settle(jobs);
  assert.equal(review.items.length, 2, '交了方案后放出第二段');

  // 第二段用 reply 说明无需修改，也算处理完
  const [r2] = review.claim(3);
  review.reply(r2.id, '无需修改');
  await settle(jobs);
  assert.equal(review.items.length, 3);

  // 暂停后不再放新段
  jobs.pause(j.id);
  const [r3] = review.claim(3);
  review.reply(r3.id, '无需修改');
  await settle(jobs);
  assert.equal(review.items.length, 3);
  jobs.resume(j.id);
  await settle(jobs);
  assert.equal(review.items.length, 4);

  const [r4] = review.claim(3);
  review.submit(r4.id, { edits: [{ original: '公式后面接着写的', replacement: '公式之后的' }] });
  await settle(jobs);
  const v = jobs.views()[0];
  assert.equal(v.status, 'done');
  assert.equal(v.counts.proposed, 2);
  assert.equal(v.counts.replied, 2);
});

test('并发 2 段；取消时撤回还没领取的段', async () => {
  const { review, jobs } = setup();
  const j = await jobs.create({ anchor: { source: 'source', file: 'content/a.tex', whole: true }, concurrency: 2 });
  assert.equal(review.items.length, 2);
  review.claim(1); // 只领走第一段
  jobs.cancel(j.id);
  await settle(jobs);
  assert.equal(review.items.length, 1, '没领取的第二段被撤回');
  assert.equal(review.items[0].status, 'claimed', '已在处理的保留');
  assert.equal(jobs.views()[0].status, 'cancelled');
});

test('选区内没有正文时报错', async () => {
  const { jobs } = setup();
  const text = SRC;
  const q = '\\begin{equation}\n  x = y + z';
  const from = text.indexOf(q);
  await assert.rejects(jobs.create({ anchor: { source: 'source', file: 'content/a.tex', from, to: from + q.length, quote: q } }), /没有可润色的正文段/);
});

test('逐段任务：某段已有未完成的请求时沿用它，不重复建', async () => {
  const { review, jobs } = setup();
  const q = '第二段正文，说明本章的主要工作内容。';
  const from = SRC.indexOf(q);
  const old = await review.create({ kind: 'polish', skill: 'humanizer-zh', anchor: { source: 'source', file: 'content/a.tex', from, to: from + q.length, quote: q } });
  review.claim(1); // 第一条（手动建的）被领走
  const j = await jobs.create({ anchor: { source: 'source', file: 'content/a.tex', whole: true }, concurrency: 3 });
  const forSecond = review.items.filter((it) => it.anchor.quote.includes('第二段正文'));
  assert.equal(forSecond.length, 1, '第二段只有一条请求');
  assert.equal(forSecond[0].id, old.id);
  assert.equal(jobs.views()[0].counts.claimed, 1, '沿用的请求计入任务进度');
  assert.equal(j.total, 4);
});

test('公式审核：一个独立公式一条请求，只有公式 agent 领得到，回复要带结论', async () => {
  const { review, jobs } = setup();
  const p = await jobs.preview({ type: 'formula', anchor: { source: 'source', file: 'content/a.tex', whole: true } });
  assert.equal(p.count, 2, 'equation 和 \[..\] 两个');
  const j = await jobs.createFormula({ anchor: { source: 'source', file: 'content/a.tex', whole: true } });
  assert.equal(j.type, 'formula');
  assert.equal(review.items.length, 1);
  assert.equal(review.items[0].kind, 'formula');
  assert.ok(review.items[0].anchor.quote.startsWith('\\begin{equation}') && review.items[0].anchor.quote.endsWith('\\end{equation}'));

  // 批注 / 润色 agent 默认领不到公式审核
  assert.equal(review.claim(3).length, 0);
  const [f1] = review.claim(3, ['formula']);
  assert.match(f1.instructions, /公式审核/);
  assert.match(f1.instructions, /第 1\/2 个公式/);
  assert.throws(() => review.reply(f1.id, '没问题'), /verdict/);
  review.reply(f1.id, '符号均已定义', 'pass');
  await settle(jobs);
  assert.equal(review.items.length, 2, '审完一个放下一个');

  const [f2] = review.claim(3, ['formula']);
  review.submit(f2.id, { edits: [{ original: '\\[ a = b \\]', replacement: '\\[ a = b . \\]' }], rationale: '公式末尾缺标点' });
  await settle(jobs);
  const v = jobs.view(jobs.find(j.id));
  assert.equal(v.status, 'done');
  assert.deepEqual([v.counts.pass, v.counts.issue], [1, 1]);
  assert.equal(review.find(f2.id).verdict, 'issue');

  // 两类 agent 的在线状态分开记
  const st = review.agentStatus();
  assert.ok(st.formula.lastSeen > 0);
  assert.equal(st.lastSeen, 0, '批注 agent 没来过');
});
