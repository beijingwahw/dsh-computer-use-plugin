// test/interactivityProbe.test.ts
// Z 纪元（Z-1 世界行动引擎）：三通道判决矩阵 + 几何先验 —— 纯函数锁死。
// 世界行动律的可判部分在此回归：每一格证据 → verdict。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fuseVerdict, uiaVerdict, classifyWordShape } from '../src/interactivityProbe.ts';
import type { OcrWord } from '../src/textReader.ts';

const T = 0.985; // 默认重绘阈值

function word(x0: number, x1: number, y0 = 0.4, y1 = 0.42): OcrWord {
  return {
    text: 'x', confidence: 90,
    bbox_normalized: { x0, y0, x1, y1 },
    center_normalized: { x: (x0 + x1) / 2, y: (y0 + y1) / 2 },
  };
}

test('Z-1a: hand 光标 ⇒ control（OS 亲口承认的可点击热区）', () => {
  assert.equal(fuseVerdict('hand', 1.0, T).verdict, 'control');       // 无重绘也判
  assert.equal(fuseVerdict('hand', 0.9, T).verdict, 'control');       // 双证更自信
  assert.ok(fuseVerdict('hand', 0.9, T).confidence > fuseVerdict('hand', 1.0, T).confidence);
});

test('Z-1b: ibeam 光标 ⇒ text（正文/聊天消息，不是入口）', () => {
  assert.equal(fuseVerdict('ibeam', 1.0, T).verdict, 'text');
  assert.equal(fuseVerdict('ibeam', 0.9, T).verdict, 'text');         // 重绘不改判决
});

test('Z-1c: arrow/custom + 悬停重绘 ⇒ control（原生按钮的唯一旁证）', () => {
  assert.equal(fuseVerdict('arrow', 0.92, T).verdict, 'control');
  assert.equal(fuseVerdict('custom', 0.92, T).verdict, 'control');
});

test('Z-1d: arrow/custom 无重绘 ⇒ inconclusive（诚实弃权，不谎报）', () => {
  assert.equal(fuseVerdict('arrow', 1.0, T).verdict, 'inconclusive');
  assert.equal(fuseVerdict('custom', 1.0, T).verdict, 'inconclusive');
});

test('Z-1e: 光标通道缺席（unsupported/error/hidden/wait）⇒ 单靠重绘，降置信', () => {
  const r = fuseVerdict('unsupported', 0.92, T);
  assert.equal(r.verdict, 'control');
  assert.ok(r.confidence < fuseVerdict('arrow', 0.92, T).confidence); // 旁证弱一等
  assert.equal(fuseVerdict('unsupported', null, T).verdict, 'inconclusive'); // 指纹也缺席
});

test('Z-1f: resize/wait 等无判决力形态 ⇒ 永不误判为 text', () => {
  for (const k of ['resize', 'wait', 'busy', 'cross', 'unavailable']) {
    assert.equal(fuseVerdict(k, 1.0, T).verdict, 'inconclusive');
  }
});

test('Z-1g: 几何先验 —— 宽行=正文，紧凑短标签=控件候选，中间=模糊', () => {
  assert.equal(classifyWordShape(word(0.05, 0.75)), 'content-like');            // 聊天整行
  assert.equal(classifyWordShape(word(0.10, 0.98, 0.30, 0.42)), 'content-like'); // 多行段落块
  assert.equal(classifyWordShape(word(0.40, 0.48)), 'control-like');             // 「登录」级短标签
  assert.equal(classifyWordShape(word(0.20, 0.40)), 'ambiguous');                // 中等宽度
});

test('Z-1h: UIA 通道判决 —— control/text 有判决，unknown/unavailable 弃权', () => {
  assert.deepEqual(uiaVerdict('control'), { verdict: 'control', confidence: 0.97 });
  assert.deepEqual(uiaVerdict('text'), { verdict: 'text', confidence: 0.93 });
  assert.equal(uiaVerdict('unknown'), null);       // Pane/Custom → 交回悬停双通道
  assert.equal(uiaVerdict('unavailable'), null);   // 库缺席/门控关闭 → 通道缺席
  assert.equal(uiaVerdict('anything-else'), null); // 异常值不冒充判决
});

test('Z-1i: 通道优先级 —— UIA 判决置信高于悬停通道的一切结论', () => {
  const uia = uiaVerdict('control')!;
  const bestHover = fuseVerdict('hand', 0.9, T);       // 悬停通道最强证据
  assert.ok(uia.confidence > bestHover.confidence);    // 结构层官方登记 > 行为证据
  const uiaText = uiaVerdict('text')!;
  const hoverText = fuseVerdict('ibeam', 1.0, T);
  assert.ok(uiaText.confidence > hoverText.confidence);
});
