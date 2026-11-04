import test from 'node:test';
import assert from 'node:assert/strict';
import { formulaBoxes, isMathFont, isMathChar } from '../web/lib/mathbox.js';
import { normalizeText, projectSource } from '../web/lib/text.js';

// 造一个文字块：x、y、w 是页面比例，h 默认一行字高
const T = (str, x, y, w, font = 'ABCDEF+SimSun', h = 0.014) => ({ str, font, x, y, w, h });

test('认得常见数学字体', () => {
  for (const f of ['JUMONQ+NewTXMI', 'LZJBUE+NewTXMI7', 'OMPTCM+NewTXBMI', 'XFSWIW+txsys', 'CCJMLO+txexs', 'RMXNMS+txmiaX', 'AAAAAA+LMMathItalic10-Regular', 'CMMI10', 'CMSY7', 'BBBBBB+LatinModernMath-Regular', 'XITSMath', 'MSBM10'])
    assert.ok(isMathFont(f), f);
  for (const f of ['ABCDEF+SimSun', 'TeXGyreTermesX-Regular', 'LMRoman10-Regular', 'Times-Roman']) assert.ok(!isMathFont(f), f);
  assert.ok(isMathChar('𝐶') && isMathChar('θ') && isMathChar('∈') && !isMathChar('C') && !isMathChar('中'));
});

test('行内公式：一行正文里夹的公式各成一框，前后文对', () => {
  const items = [
    T('其中，', 0.13, 0.11, 0.05),
    T('𝐶', 0.183, 0.11, 0.012, 'X+NewTXMI'), T('𝜉', 0.196, 0.116, 0.006, 'X+NewTXMI7', 0.01),
    T('为阻尼系数，', 0.21, 0.11, 0.1),
    T('𝑥', 0.312, 0.11, 0.008, 'X+NewTXMI'),
    T('为状态量。', 0.322, 0.11, 0.08),
  ];
  const boxes = formulaBoxes(items);
  assert.equal(boxes.length, 2);
  assert.ok(boxes.every((b) => b.kind === 'inline'));
  assert.deepEqual(boxes[0].items, [1, 2]);
  assert.equal(boxes[0].before, '其中，');
  assert.ok(boxes[0].after.startsWith('为阻尼系数'));
  assert.ok(boxes[1].before.endsWith('为阻尼系数，') && boxes[1].after === '为状态量。');
});

test('正文里的式号引用不算公式', () => {
  const items = [T('由式', 0.13, 0.2, 0.03), T('(2.22)', 0.16, 0.2, 0.04, 'X+TeXGyreTermesX-Regular'), T('可知，', 0.2, 0.2, 0.05)];
  assert.equal(formulaBoxes(items).length, 0);
});

test('独立公式：多块拼成一个框，编号并进来，矩阵里的数字也算', () => {
  const items = [
    T('定义矩阵', 0.13, 0.10, 0.08),
    T('𝑺', 0.39, 0.20, 0.01, 'X+NewTXBMI'), T('=', 0.41, 0.20, 0.01, 'X+txsys'),
    T('', 0.433, 0.185, 0.006, 'X+txexs'), T('', 0.433, 0.222, 0.006, 'X+txexs'),
    T('0', 0.44, 0.19, 0.009, 'X+TeXGyreTermesX-Bold'), T('1', 0.45, 0.215, 0.009, 'X+TeXGyreTermesX-Regular'),
    T('', 0.475, 0.185, 0.006, 'X+txexs'), T('', 0.475, 0.222, 0.006, 'X+txexs'),
    T(',', 0.486, 0.20, 0.004, 'X+TeXGyreTermesX-Regular'),
    T('𝜃', 0.53, 0.20, 0.008, 'X+NewTXMI'), T('=', 0.55, 0.20, 0.01, 'X+txsys'), T('𝒒', 0.57, 0.20, 0.009, 'X+NewTXBMI'),
    T('(2.73)', 0.815, 0.20, 0.043, 'X+TeXGyreTermesX-Regular'),
    T('将上式代入', 0.13, 0.25, 0.1),
  ];
  const boxes = formulaBoxes(items);
  assert.equal(boxes.length, 1);
  const [b] = boxes;
  assert.equal(b.kind, 'display');
  assert.ok(b.items.includes(5) && b.items.includes(6), '矩阵里的数字');
  assert.ok(b.items.includes(13), '公式编号');
  assert.ok(b.fx < 0.39 && b.fx + b.fw > 0.858);
  assert.equal(b.before, '定义矩阵');
  assert.equal(b.after, '将上式代入');
});

test('Latin Modern 的公式（xelatex 默认字体）也认得', () => {
  const items = [
    T('式中，', 0.13, 0.3, 0.05, 'A+FandolSong-Regular'),
    T('𝑥', 0.18, 0.3, 0.008, 'B+LatinModernMath-Regular'),
    T('为状态量', 0.19, 0.3, 0.07, 'A+FandolSong-Regular'),
    T('𝑥', 0.45, 0.24, 0.008, 'B+LatinModernMath-Regular'), T('=', 0.46, 0.24, 0.01, 'B+LatinModernMath-Regular'), T('𝐴𝑥', 0.475, 0.24, 0.02, 'B+LatinModernMath-Regular'),
    T('(1)', 0.85, 0.24, 0.02, 'C+LMRoman10-Regular'),
  ];
  const boxes = formulaBoxes(items);
  assert.deepEqual(boxes.map((b) => b.kind), ['display', 'inline']);
  assert.ok(boxes[0].items.includes(6));
});

test('数学斜体字母、希腊字母命令和源码能对上', () => {
  assert.equal(normalizeText('𝐶𝜉为系数'), 'cξ为系数');
  assert.equal(projectSource('$C_\\xi$为系数').chars, 'cξ为系数');
  assert.equal(projectSource('\\varphi 与 \\phi').chars, projectSource('\\phi与\\phi').chars);
  assert.equal(normalizeText('Δ𝑙'), projectSource('\\Delta l').chars);
});
