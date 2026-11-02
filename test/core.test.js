import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { locatePdfSelection, normalizeText, relocate } from '../server/anchors.js';
import { Review } from '../server/core.js';
import { Store } from '../server/store.js';
import { TexFiles, paragraphRange, sectionAt } from '../server/texfiles.js';
import { applyEdits, diffWords } from '../web/lib/diff.js';

const SRC = [
  '\\chapter{吊车控制}',
  '\\section{问题描述}',
  '小车通过绳索吊起重物，摆动会影响定位精度\\cite{li2020}。',
  '本文采用 PID 方法，令 $\\tau_T=0.06$s 为时间常数。',
  '',
  '% 这一段被注释了',
  '第二段文字，摆动会影响定位精度。',
  '',
].join('\r\n');

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-'));
  fs.mkdirSync(path.join(root, 'content'));
  fs.writeFileSync(path.join(root, 'content', 'ch3.tex'), SRC);
  const cfg = {
    projectRoot: root, pdf: 'none.pdf', sourceDirs: ['content'], extraSources: [], skillDirs: [],
    defaultSkill: '', claimTimeoutMin: 30, waitTimeoutSec: 5, dataDir: path.join(root, 'data'),
  };
  const files = new TexFiles(cfg);
  const review = new Review(cfg, files, new Store(cfg.dataDir));
  const raw = () => fs.readFileSync(path.join(root, 'content', 'ch3.tex'), 'utf8');
  return { root, cfg, files, review, raw };
}

test('路径限制在源码目录内', () => {
  const { files } = setup();
  assert.throws(() => files.resolve('../x.tex'), /越界/);
  assert.throws(() => files.resolve('content/a.txt'), /只允许/);
  assert.equal(files.resolve('content\\ch3.tex').rel, 'content/ch3.tex');
});

test('章节标题和自然段', () => {
  const text = SRC.replace(/\r\n/g, '\n');
  const off = text.indexOf('本文采用');
  assert.equal(sectionAt(text, off), '吊车控制 · 问题描述');
  const [s, e] = paragraphRange(text, off, off + 4);
  assert.ok(text.slice(s, e).startsWith('\\chapter'));
  assert.ok(text.slice(s, e).endsWith('时间常数。'));
});

test('PDF 选中文字对回源码（跳过 \\cite、公式）', () => {
  const text = SRC.replace(/\r\n/g, '\n');
  // PDF 里 \cite 变成 [12]，公式变成 τT = 0.06
  const r = locatePdfSelection(text, '定位精度[12]。 本文采用 PID 方法，令 τT = 0.06s 为时间常数', 3);
  assert.ok(r);
  const q = text.slice(r.start, r.end);
  assert.ok(q.startsWith('定位精度'), q);
  assert.ok(q.endsWith('时间常数'), q);
  // 注释里的文字不应被匹配
  assert.equal(normalizeText('A，b 1'), 'ab1');
});

test('relocate 取离旧行号最近的那处', () => {
  const text = SRC.replace(/\r\n/g, '\n');
  const loc = relocate(text, '摆动会影响定位精度', 7);
  assert.equal(loc.lineStart, 7);
  assert.equal(relocate(text, '不存在', 1), null);
});

test('完整流程：创建、领取、提交、接受、撤销，保留 CRLF', async () => {
  const { review, raw } = setup();
  const text = SRC.replace(/\r\n/g, '\n');
  const quote = '令 $\\tau_T=0.06$s 为时间常数。';
  const from = text.indexOf(quote);
  const it = await review.create({ kind: 'comment', comment: '不要这样写', anchor: { source: 'source', file: 'content/ch3.tex', from, to: from + quote.length, quote } });
  assert.equal(it.status, 'pending');
  assert.equal(it.anchor.lineStart, 4);
  assert.equal(it.anchor.section, '吊车控制 · 问题描述');

  const got = await review.wait({ max: 3, timeoutMs: 1000 });
  assert.equal(got.length, 1);
  assert.equal(got[0].quote, quote);
  assert.match(got[0].context, /4\| 本文采用/);
  assert.equal(review.find(it.id).status, 'claimed');

  assert.throws(() => review.submit(it.id, { edits: [{ original: '不存在的原文', replacement: 'x' }] }), /找不到/);
  // 原文出现两次时取离锚点最近的
  review.submit(it.id, { edits: [{ original: '令 $\\tau_T=0.06$s 为时间常数。', replacement: '取时间常数 $\\tau_T$。' }], rationale: 'r', fidelity: 'f' });
  assert.equal(review.find(it.id).status, 'proposed');

  const hunks = review.hunks(it.id);
  assert.equal(hunks.length, 1);
  assert.equal(applyEdits(hunks[0].before, hunks[0].edits).includes('取时间常数 $\\tau_T$。'), true);

  review.accept(it.id);
  assert.ok(raw().includes('取时间常数 $\\tau_T$。\r\n'));
  assert.ok(!raw().replace(/\r\n/g, '').includes('\n'), '应保持 CRLF');
  assert.equal(review.find(it.id).status, 'accepted');
  // 已接受时对照视图仍能还原改前
  const h2 = review.hunks(it.id);
  assert.ok(h2[0].before.includes(quote));

  review.undo(it.id);
  assert.equal(raw(), SRC);
  assert.equal(review.find(it.id).status, 'proposed');
});

test('原文被外部改动后：标记原文已改，接受报冲突且不写入', async () => {
  const { review, raw, root } = setup();
  const text = SRC.replace(/\r\n/g, '\n');
  const quote = '第二段文字';
  const from = text.indexOf(quote);
  const it = await review.create({ kind: 'polish', skill: '', comment: '', anchor: { source: 'source', file: 'content/ch3.tex', from, to: from + quote.length, quote } });
  review.claim();
  review.submit(it.id, { edits: [{ original: '第二段文字，', replacement: '第二段，' }] });
  fs.writeFileSync(path.join(root, 'content', 'ch3.tex'), SRC.replace('第二段文字', '第2段'));
  review.files.invalidate();
  const v = review.list()[0];
  assert.equal(v.stale, true);
  assert.equal(v.conflict, true);
  const before = raw();
  assert.throws(() => review.accept(it.id), /原文已改/);
  assert.equal(raw(), before);
});

test('多处修改只接受部分、并改写其中一处', async () => {
  const { review, raw } = setup();
  const text = SRC.replace(/\r\n/g, '\n');
  const quote = '小车通过绳索吊起重物';
  const from = text.indexOf(quote);
  const it = await review.create({ kind: 'polish', anchor: { source: 'source', file: 'content/ch3.tex', from, to: from + quote.length, quote } });
  review.claim();
  review.submit(it.id, {
    edits: [
      { original: '小车通过绳索吊起重物', replacement: '小车用绳索吊起重物' },
      { original: '本文采用 PID 方法', replacement: '本文用 PID' },
    ],
  });
  assert.throws(() => review.submit(it.id, { edits: [{ original: '摆动会影响定位精度', replacement: 'x' }, { original: '影响定位', replacement: 'y' }] }), /重叠/);
  review.accept(it.id, { include: [1], replacements: { 1: '本文选用 PID 方法' } });
  assert.ok(raw().includes('本文选用 PID 方法'));
  assert.ok(raw().includes('小车通过绳索吊起重物'));
  review.undo(it.id);
  assert.equal(raw(), SRC);
});

test('wait 在新请求到来时立即返回', async () => {
  const { review } = setup();
  const t0 = Date.now();
  const p = review.wait({ timeoutMs: 5000 });
  setTimeout(() => {
    const text = SRC.replace(/\r\n/g, '\n');
    const q = '第二段文字';
    const from = text.indexOf(q);
    review.create({ kind: 'comment', comment: 'x', anchor: { source: 'source', file: 'content/ch3.tex', from, to: from + q.length, quote: q } });
  }, 100);
  const got = await p;
  assert.equal(got.length, 1);
  assert.ok(Date.now() - t0 < 3000);
});

test('中文词级 diff', () => {
  const ops = diffWords('校园食堂餐盘剩余可能与份量有关', '校园食堂的餐盘剩余可能同时与份量有关');
  const ins = ops.filter((o) => o.op === 'ins').map((o) => o.text).join('');
  assert.ok(ins.includes('的'));
  assert.ok(ins.includes('同时'));
  assert.equal(ops.filter((o) => o.op !== 'ins').map((o) => o.text).join(''), '校园食堂餐盘剩余可能与份量有关');
  assert.equal(ops.filter((o) => o.op !== 'del').map((o) => o.text).join(''), '校园食堂的餐盘剩余可能同时与份量有关');
});

test('误点驳回后可以恢复方案', async () => {
  const { review } = setup();
  const text = SRC.replace(/\r\n/g, '\n');
  const q = '第二段文字';
  const from = text.indexOf(q);
  const it = await review.create({ kind: 'polish', anchor: { source: 'source', file: 'content/ch3.tex', from, to: from + q.length, quote: q } });
  review.claim();
  review.submit(it.id, { edits: [{ original: '第二段文字，', replacement: '第二段，' }] });
  review.reject(it.id);
  assert.throws(() => review.accept(it.id), /已被驳回/);
  review.restore(it.id);
  assert.equal(review.find(it.id).status, 'proposed');
  assert.equal(review.find(it.id).history.length, 0);
  review.accept(it.id);
  assert.equal(review.find(it.id).status, 'accepted');
});

test('网页编辑器保存：版本对得上才写，被别处改过时报冲突', () => {
  const { files, raw, root } = setup();
  const f = files.read('content/ch3.tex');
  const edited = f.text.replace('第二段文字', '第二段正文');
  const r1 = files.save('content/ch3.tex', edited, f.hash);
  assert.equal(r1.conflict, false);
  assert.ok(raw().includes('第二段正文'));
  assert.ok(raw().includes('\r\n'), '保留 CRLF');
  // 外部编辑器改了文件，网页还拿着旧版本号保存 -> 冲突，不覆盖
  fs.writeFileSync(path.join(root, 'content', 'ch3.tex'), raw().replace('第二段正文', '外部改动'));
  files.invalidate();
  const r2 = files.save('content/ch3.tex', edited.replace('吊车', '起重'), r1.hash);
  assert.equal(r2.conflict, true);
  assert.ok(r2.text.includes('外部改动'));
  assert.ok(raw().includes('外部改动'), '冲突时不写入');
  // 强制覆盖
  const r3 = files.save('content/ch3.tex', edited, r1.hash, true);
  assert.equal(r3.conflict, false);
  assert.ok(raw().includes('第二段正文'));
});
