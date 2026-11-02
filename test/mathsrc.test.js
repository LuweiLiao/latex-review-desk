import test from 'node:test';
import assert from 'node:assert/strict';
import { mathSegments, resolveFormula } from '../web/lib/mathsrc.js';

const SRC = [
  '系统的状态方程写为', //                         1
  '\\begin{equation}', //                          2
  '  \\dot{x} = A x + B u , \\label{eq:state}', // 3
  '\\end{equation}', //                            4
  '式中，$x$ 为状态量，$u$ 为控制输入，价格写作 \\$5。% 注释里的 $y$ 不算', // 5
  '再看 \\(z\\) 与 $$a+b$$ 以及', //               6
  '\\[ c = d \\]', //                              7
  '\\begin{align*}', //                            8
  '  e &= f \\\\', //                              9
  '  g &= h', //                                   10
  '\\end{align*}', //                              11
  '最后，$i$ 为第 $i$ 个。', //                    12
].join('\n');

const quotes = (segs) => segs.map((s) => SRC.slice(s.from, s.to));

test('找出各种写法的公式，跳过 \\$ 和注释', () => {
  const segs = mathSegments(SRC);
  assert.deepEqual(quotes(segs), [
    '\\begin{equation}\n  \\dot{x} = A x + B u , \\label{eq:state}\n\\end{equation}',
    '$x$', '$u$', '\\(z\\)', '$$a+b$$', '\\[ c = d \\]',
    '\\begin{align*}\n  e &= f \\\\\n  g &= h\n\\end{align*}',
    '$i$', '$i$',
  ]);
  assert.deepEqual(segs.map((s) => s.kind), ['display', 'inline', 'inline', 'inline', 'display', 'display', 'display', 'inline', 'inline']);
});

test('没配对的 $ 不吞掉下一段', () => {
  const t = '价格 $5 很贵。\n\n下一段 $y$ 正常。';
  assert.deepEqual(mathSegments(t).map((s) => t.slice(s.from, s.to)).pop(), '$y$');
});

test('按前后文选中同一行里对的那个公式', () => {
  const x = resolveFormula(SRC, { line: 5, kind: 'inline', before: '式中，', after: '为状态量，' });
  assert.equal(x.quote, '$x$');
  const u = resolveFormula(SRC, { line: 5, kind: 'inline', before: '为状态量，', after: '为控制输入，' });
  assert.equal(u.quote, '$u$');
  const second = resolveFormula(SRC, { line: 12, kind: 'inline', before: '最后，为第', after: '个。' });
  assert.equal(second.from, SRC.lastIndexOf('$i$'));
  const first = resolveFormula(SRC, { line: 12, kind: 'inline', before: '最后，', after: '为第个。' });
  assert.equal(first.from, SRC.indexOf('$i$'));
});

test('独立公式取整个环境，行号是环境开头', () => {
  const r = resolveFormula(SRC, { line: 3, kind: 'display', before: '系统的状态方程写为', after: '式中，为状态量' });
  assert.ok(r.quote.startsWith('\\begin{equation}') && r.quote.endsWith('\\end{equation}'));
  assert.equal(r.line, 2);
  const a = resolveFormula(SRC, { line: 9, kind: 'display', before: '', after: '最后，' });
  assert.ok(a.quote.startsWith('\\begin{align*}'));
});

test('附近没有公式时返回 null', () => {
  assert.equal(resolveFormula('只有正文。\n'.repeat(40) + '$x$', { line: 1 }), null);
});
