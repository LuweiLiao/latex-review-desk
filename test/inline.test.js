// 侧栏“撤掉部分修改”：按改动块重建要写入的文字
import assert from 'node:assert/strict';
import { test } from 'node:test';

globalThis.document ??= { createElement: () => ({ append() {}, setAttribute() {}, addEventListener() {} }) };
const { replacementsWithout, countChunks } = await import('../web/src/inline.js');

const before = '2）在理论研究层面，系统将多旋翼平台—柔性吊绳构成整体。';
const original = '系统将多旋翼平台—柔性吊绳';
const replacement = '系统的多旋翼平台和柔性吊绳';
const start = before.indexOf(original);
const hunks = [{ file: 'a.tex', before, edits: [{ idx: 0, start, end: start + original.length, original, replacement }] }];

test('不撤掉时就是原方案', () => {
  assert.equal(countChunks(hunks), 2);
  assert.equal(replacementsWithout(hunks, new Set())[0], replacement);
});

test('撤掉“将→的”，保留“—→和”', () => {
  assert.equal(replacementsWithout(hunks, new Set(['0:0']))[0], '系统将多旋翼平台和柔性吊绳');
});

test('全部撤掉等于原文', () => {
  assert.equal(replacementsWithout(hunks, new Set(['0:0', '0:1']))[0], original);
});
