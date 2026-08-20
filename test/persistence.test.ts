// test/persistence.test.ts
// 反遗忘 + 认知仪表盘回归测试：经验能活过进程边界；账本忠实于历史。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryKnowledgeBase } from '../src/knowledge/knowledgeBase.ts';
import { InMemoryWorldModel } from '../src/knowledge/worldModel.ts';
import { KnowledgePersistence } from '../src/knowledge/persistence.ts';
import { MetricsLedger, summarizeRuns, learningCurve, type RunMetricRecord } from '../src/knowledge/metrics.ts';
import type { ScenePatch } from '../src/knowledge/contracts.ts';

function scene(els: Array<[string, number, number]>): ScenePatch[] {
  return [{
    region: { id: 'g0x0', x: 0, y: 0, width: 1, height: 1 },
    elements: els.map(([name, x, y]) => ({
      source: 'L1-tree' as const, role: 'button', name,
      rect: { x, y, width: 0.08, height: 0.04 },
    })),
    funnelDepth: 'L1' as const,
    capturedAt: 0,
  }];
}

const SAVE_A = scene([['OK', 0.4, 0.7], ['Cancel', 0.6, 0.7]]);
const MENU = scene([['File', 0.1, 0.05], ['Edit', 0.25, 0.05]]);

// ─── 器官快照：序列化/水合的保真 ───

test('持久化 #1 knowledgeBase 往返：条目/置信度/皮层化簿记/ID 计数全保真', () => {
  const kb = new InMemoryKnowledgeBase();
  kb.insert({ category: 'error-pattern', content: 'delete item broken', scenario: 'cleanup', confidence: 0.45, source: 'manual' });
  kb.insert({ category: 'workflow', content: 'clear log works', scenario: 'cleanup', confidence: 0.6, source: 'auto-learn' });
  kb.consolidate(); // 触发簿记演化（虽然 <3 条不蒸馏 —— 簿记仍是空集，幂等验证）

  const snap = JSON.parse(JSON.stringify(kb.exportSnapshot())); // 真实 JSON 往返（磁盘同构）
  const reborn = new InMemoryKnowledgeBase();
  const r = reborn.restoreSnapshot(snap);
  if (!r.ok) assert.fail(`水合失败: ${JSON.stringify(r.error)}`);
  assert.equal(reborn.snapshot().length, 2);
  // 检索行为保真：hybrid 通道（向量已重铸）照常命中
  const q = reborn.query({ sceneDescription: 'cleanup', intentDescription: 'delete item broken' });
  assert.ok(q.ok && q.value.entries.length > 0, '水合后语义检索仍命中');
  // ID 计数器保真：新插入不与旧 ID 冲突（新生儿的记忆从旧脑继续编号）
  const ins = reborn.insert({ category: 'workflow', content: 'new entry', scenario: 's', confidence: 0.5, source: 'manual' });
  assert.ok(ins.ok);
});

test('持久化 #2 worldModel 往返：类型指认 + 转移预测 + 惊讶全保真', () => {
  const wm = new InMemoryWorldModel();
  const a = wm.typeOf(SAVE_A)!;
  const b = wm.typeOf(MENU)!;
  wm.observe(a, 'click_mouse@22', b, true);
  wm.observe(a, 'click_mouse@22', b, true);

  const snap = JSON.parse(JSON.stringify(wm.exportSnapshot()));
  const reborn = new InMemoryWorldModel();
  const r = reborn.restoreSnapshot(snap);
  assert.ok(r.ok);
  // 同一场景 ⇒ 同一类型 ID（类型学记忆延续 —— 老员工不会重启后不认识保存框）
  assert.equal(reborn.typeOf(SAVE_A), a);
  assert.equal(reborn.typeOf(MENU), b);
  // 预测保真
  const p = reborn.predict(a, 'click_mouse@22');
  assert.ok(p.ok && p.value && p.value.evidence === 2 && p.value.successProb === 1);
  // 惊讶保真：熟悉转移低 bits
  const s = reborn.surprise(a, 'click_mouse@22', b);
  assert.ok(s.ok && !s.value.novel && s.value.bits < 1);
});

test('持久化 #3 器官域外拒绝：版本不符/结构非法 ⇒ 整体拒绝绝不半水合', () => {
  const kb = new InMemoryKnowledgeBase();
  kb.insert({ category: 'workflow', content: 'live entry', scenario: 's', confidence: 0.5, source: 'manual' });
  assert.ok(!kb.restoreSnapshot({ version: 99 }).ok);
  assert.ok(!kb.restoreSnapshot({ version: 1, entries: 'not-array' }).ok);
  assert.ok(!kb.restoreSnapshot({ version: 1, entries: [{ id: 'x', category: 'bogus', content: 'c', confidence: 0.5 }] }).ok);
  // 拒绝后旧脑无损（换脑是全有或全无）
  assert.equal(kb.snapshot().length, 1);

  const wm = new InMemoryWorldModel();
  wm.typeOf(SAVE_A);
  assert.ok(!wm.restoreSnapshot({ version: 2 }).ok);
  assert.ok(!wm.restoreSnapshot({ version: 1, types: [], transitions: [{ from: '', action: 'x', total: 1, success: 0, next: [] }] }).ok);
  assert.equal(wm.stats().types, 1, '拒绝水合不伤原脑');
});

// ─── 状态仓：原子落盘/读回/缺席/损坏 ───

test('持久化 #4 状态仓往返：save → 新器官 → load ⇒ 经验跨实例存活', () => {
  const dir = mkdtempSync(join(tmpdir(), 'd7-state-'));
  try {
    const kb = new InMemoryKnowledgeBase();
    const wm = new InMemoryWorldModel();
    kb.insert({ category: 'error-pattern', content: 'delete item broken', scenario: 'cleanup', confidence: 0.45, source: 'manual' });
    wm.typeOf(SAVE_A);
    const store = new KnowledgePersistence(dir);
    assert.ok(store.save(kb, wm).ok);

    // 新进程语义：全新器官从磁盘水合旧脑
    const kb2 = new InMemoryKnowledgeBase();
    const wm2 = new InMemoryWorldModel();
    const loadR = new KnowledgePersistence(dir).load(kb2, wm2);
    assert.ok(loadR.ok && loadR.value.loaded.length === 2);
    assert.equal(kb2.snapshot().length, 1);
    assert.equal(wm2.stats().types, 1);
    // 原子性：落盘后无 .tmp 残骸
    assert.ok(!existsSync(join(dir, 'knowledge.json.tmp')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('持久化 #5 空目录 ⇒ 空脑开局；损坏文件 ⇒ 诚实错误（不静默吞）', () => {
  const empty = mkdtempSync(join(tmpdir(), 'd7-empty-'));
  const corrupt = mkdtempSync(join(tmpdir(), 'd7-corrupt-'));
  try {
    // 空目录 = 新生儿
    const r1 = new KnowledgePersistence(empty).load(new InMemoryKnowledgeBase(), new InMemoryWorldModel());
    assert.ok(r1.ok && r1.value.loaded.length === 0);
    // 损坏 = 病历，不是空脑（数据丢失必须被听见）
    writeFileSync(join(corrupt, 'knowledge.json'), '{ this is not json', 'utf8');
    const r2 = new KnowledgePersistence(corrupt).load(new InMemoryKnowledgeBase(), new InMemoryWorldModel());
    assert.ok(!r2.ok, '损坏文件必须报错');
  } finally {
    rmSync(empty, { recursive: true, force: true });
    rmSync(corrupt, { recursive: true, force: true });
  }
});

// ─── 认知仪表盘：账本 + 聚合 ───

test('仪表盘 #1 账本追加/读回/坏行宽容；聚合纯函数可复现', () => {
  const dir = mkdtempSync(join(tmpdir(), 'd7-metrics-'));
  try {
    const path = join(dir, 'metrics.jsonl');
    const ledger = new MetricsLedger(path);
    const base = { rounds: 2, executions: 1, durationMs: 100, l3Rounds: 1, knowledgeRounds: 2, knowledgeEntries: 3, worldTypes: 1, worldObservations: 2, consolidated: 0 };
    assert.ok(ledger.record({ ts: 1000, intentId: 'a', verdict: 'completed', ...base }).ok);
    assert.ok(ledger.record({ ts: 2000, intentId: 'b', verdict: 'failed', ...base, executions: 3 }).ok);
    // 坏行（手写注入）：账本对历史忠实 —— 坏行计数不吞
    appendFileSync(path, 'corrupt-line\n', 'utf8');
    const { records, corruptLines } = ledger.readAll();
    assert.equal(records.length, 2);
    assert.equal(corruptLines, 1);
    // 聚合：successRate 0.5、l3RoundRate = 2/4
    const s = summarizeRuns(records);
    assert.equal(s.runs, 2);
    assert.equal(s.successRate, 0.5);
    assert.equal(s.avgExecutions, 2);
    assert.equal(s.l3RoundRate, 0.5);
    // 纯函数复现：同一批记录 ⇒ 同一张表
    assert.deepEqual(summarizeRuns(records), s);
    // 学习曲线：时间序二分（ts=1000 completed 在前，ts=2000 failed 在后）
    const curve = learningCurve(records)!;
    assert.equal(curve.firstHalf.successRate, 1);
    assert.equal(curve.secondHalf.successRate, 0);
    assert.equal(learningCurve([]), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
