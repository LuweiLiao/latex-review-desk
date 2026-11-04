import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Compiler, expandArgs, recipeSteps } from '../server/compile.js';

const node = process.execPath;

function cfgFor(root, extra = {}) {
  return {
    projectRoot: root,
    mainTex: 'master.tex',
    pdf: '示例论文.pdf',
    tools: [
      { name: 'a', command: node, args: ['-e', "console.log('A ' + process.argv.slice(1).join(' '))", '%DOC%', '%JOBNAME%'] },
      { name: 'b', command: node, args: ['-e', "console.log('B'); require('fs').writeFileSync('b.txt', 'ok')"] },
      { name: 'fail', command: node, args: ['-e', "console.log('./content/ch3.tex:12: Undefined control sequence'); process.exit(1)"] },
      { name: 'slow', command: node, args: ['-e', 'setTimeout(() => {}, 20000)'] },
    ],
    recipes: [
      { name: 'a->b', tools: ['a', 'b'] },
      { name: 'a->fail->b', tools: ['a', 'fail', 'b'] },
      { name: 'slow', tools: ['slow', 'b'] },
    ],
    ...extra,
  };
}

const done = (c) => new Promise((r) => c.once('done', r));

test('占位符展开', () => {
  const cfg = cfgFor('.');
  assert.deepEqual(expandArgs(['-jobname=%JOBNAME%', '%DOCFILE%', '%DOC%'], cfg), ['-jobname=示例论文', 'master.tex', 'master']);
  assert.equal(recipeSteps(cfg, 'a->b').length, 2);
  assert.throws(() => recipeSteps(cfg, '没有'), /没有编译配方/);
});

test('按配方依次执行，全部成功', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trc-'));
  const c = new Compiler(cfgFor(root));
  assert.equal(c.start('a->b'), true);
  assert.equal(c.start('a->b'), false, '运行中不能再启动');
  const st = await done(c);
  assert.equal(st.ok, true);
  assert.equal(st.step, 2);
  assert.ok(st.tail.some((l) => l === 'A master 示例论文'));
  assert.ok(fs.existsSync(path.join(root, 'b.txt')));
});

test('中间一步失败就停下，并解析出错行', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trc-'));
  const c = new Compiler(cfgFor(root));
  c.start('a->fail->b');
  const st = await done(c);
  assert.equal(st.ok, false);
  assert.match(st.message, /fail 退出码 1/);
  assert.deepEqual(st.errors[0], { file: 'content/ch3.tex', line: 12, message: 'Undefined control sequence' });
  assert.ok(!fs.existsSync(path.join(root, 'b.txt')));
});

test('嵌套主文件从所在目录编译，输出与错误路径仍对应项目文件树', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trc-nested-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'nested'));
  const cfg = cfgFor(root, { mainTex: 'nested/main.tex', pdf: 'nested/main.pdf' });
  assert.deepEqual(expandArgs(['%DOCFILE%', '%DOC%', '%JOBNAME%'], cfg), ['main.tex', 'main', 'main']);
  const compiler = new Compiler(cfg);
  compiler.start('a->b');
  assert.equal((await done(compiler)).ok, true);
  assert.ok(fs.existsSync(path.join(root, 'nested', 'b.txt')));
  compiler.start('a->fail->b');
  assert.equal((await done(compiler)).errors[0].file, 'nested/content/ch3.tex');
});

test('终止编译', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trc-'));
  const c = new Compiler(cfgFor(root));
  c.start('slow');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(c.stop(), true);
  const st = await done(c);
  assert.equal(st.ok, false);
  assert.equal(st.message, '已终止');
  assert.ok(!fs.existsSync(path.join(root, 'b.txt')));
});
