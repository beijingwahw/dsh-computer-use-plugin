// test/uiMemory.test.ts
// 场景式 UI 记忆：去重强化 / 召回排序 / 按 ID 取回（记忆预验的地基）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uiMemory, tokenize, overlapCoefficient } from '../src/uiMemory.ts';

test('tokenize: latin + CJK 单字 + CJK 二元组', () => {
  const t = tokenize('GitHub 搜索');
  assert.ok(t.includes('github'));
  assert.ok(t.includes('搜'));
  assert.ok(t.includes('搜索')); // bigram
});

test('overlapCoefficient: 空集安全 / 交集归一', () => {
  assert.equal(overlapCoefficient([], ['a']), 0);
  assert.equal(overlapCoefficient(['a', 'b'], ['a']), 1); // /min(2,1)
  assert.equal(overlapCoefficient(['a'], ['a', 'b']), 1);
});

test('remember: 同描述同位置强化而非新建；邻近位置不合并', () => {
  uiMemory.reset();
  const a = uiMemory.remember('Submit button', 0.5, 0.5);
  const b = uiMemory.remember('Submit button', 0.505, 0.498); // 距离 < 0.02 → 合并
  assert.equal(b.id, a.id);
  assert.equal(b.successCount, 2);

  const c = uiMemory.remember('Submit button', 0.7, 0.5); // 距离远 → 新条目
  assert.notEqual(c.id, a.id);
  assert.equal(uiMemory.size, 2);
});

test('recall: 文本命中排序 + 阈值过滤', () => {
  uiMemory.reset();
  uiMemory.remember('GitHub 搜索框', 0.5, 0.1);
  uiMemory.remember('browser refresh button', 0.9, 0.05);
  const hits = uiMemory.recall('GitHub 搜索');
  assert.ok(hits.length >= 1);
  assert.ok(hits[0].description.includes('GitHub'));
  assert.ok(hits.every(h => h.score > 0.05));
});

test('get: 按 ID 精确取回（记忆预验依赖）', () => {
  uiMemory.reset();
  const lm = uiMemory.remember('close button', 0.95, 0.04);
  assert.equal(uiMemory.get(lm.id)?.description, 'close button');
  assert.equal(uiMemory.get(99999), undefined);
});

test('dump/restore: 认知快照往返无损（ID 发号器进度保留）', () => {
  uiMemory.reset();
  uiMemory.remember('menu', 0.1, 0.1);
  const last = uiMemory.remember('settings', 0.2, 0.2);
  const dump = uiMemory.dump();
  uiMemory.reset();
  assert.equal(uiMemory.size, 0);
  uiMemory.restore(dump);
  assert.equal(uiMemory.size, 2);
  assert.equal(uiMemory.get(last.id)?.description, 'settings');
  const next = uiMemory.remember('new item', 0.3, 0.3);
  assert.equal(next.id, last.id + 1); // 发号器不回退 → ID 永不冲突
});
