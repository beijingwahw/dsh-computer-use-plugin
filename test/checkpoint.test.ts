// test/checkpoint.test.ts
// 认知快照：原子写 / 全子系统往返 / 崩溃重启语义（恢复后续链不断）。
// ΝΩ-22 增补：分段序列化缓存（journal 指纹未变 ⇒ 零重序列化）。
// ΝΩ-45 增补：flushJournal 接入（collect 前的磁盘一致性）+ 启动三腿并行假钟。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  saveCheckpoint, loadCheckpoint, checkpointSectionStats, resetCheckpointSectionCache,
} from '../src/checkpoint.ts';
import { uiMemory } from '../src/uiMemory.ts';
import { failureMemory } from '../src/failureMemory.ts';
import { skillLibrary } from '../src/skillLibrary.ts';
import { telemetry } from '../src/telemetry.ts';
import { journal, flushJournal, journalDiskStats } from '../src/journal.ts';
// ΝΩ-45：启动三腿并行编排器（apply 的同一缝 —— 测试注入慢初始化器 + 假钟）。
// index.ts 静态图已在测试装载器验证可导入（Λ-4 动态桶立法），此处零新增回路。
import { runStartupLegs } from '../src/index.ts';

let dir: string;
const dirs: string[] = [];
beforeEach(() => {
  uiMemory.reset();
  failureMemory.reset();
  skillLibrary.reset();
  telemetry.reset();
  journal.reset();
  resetCheckpointSectionCache(); // ΝΩ-22：分段缓存观测每用例归零
  dir = mkdtempSync(path.join(tmpdir(), 'ckpt-'));
  dirs.push(dir); // 每用例一个目录 —— 退出时须逐个回收（只留最后一个 = 泄漏）
});

test('全认知态快照 → 清空 → 恢复：五子系统无损往返', async () => {
  // 播种认知态
  uiMemory.remember('GitHub 搜索框', 0.5, 0.08);
  failureMemory.record('open settings', 'click_mouse(0.9,0.05)', 'no change');
  skillLibrary.induce('open github and search', [
    { tool: 'press_hotkey', args: { keys: ['ctrl', 'l'] } },
    { tool: 'type_text', args: { text: 'github.com' } },
  ]);
  await journal.append({ ts: Date.now(), tool: 'click_mouse', args: { x: 0.5 }, status: 'SUCCESS' });
  telemetry.observe('click_mouse', 'SUCCESS', 90);

  const file = path.join(dir, 'cp.json');
  const saved = saveCheckpoint(file);
  assert.equal(saved.ok, true);
  assert.equal(existsSync(file), true);

  // 模拟崩溃：全部清零
  uiMemory.reset(); failureMemory.reset(); skillLibrary.reset(); telemetry.reset(); journal.reset();
  assert.equal(uiMemory.size, 0);

  // 恢复
  const { restored, report } = loadCheckpoint(file);
  assert.equal(restored, true);
  assert.ok(report.every(r => r.endsWith(': OK')), report.join('; '));
  assert.equal(uiMemory.size, 1);
  assert.equal(failureMemory.size, 1);
  assert.equal(skillLibrary.list().length, 1);
  assert.equal(telemetry.snapshot().global.calls, 1);

  // 恢复后日志链可续（崩溃恢复的核心承诺）
  await journal.append({ ts: Date.now() + 1, tool: 'type_text', args: { text: 'hi' }, status: 'SUCCESS' });
  assert.equal(journal.verify().ok, true);
  assert.equal(journal.list().length, 2);
});

test('未配置路径 / 文件不存在：安全降级不抛异常', () => {
  assert.equal(saveCheckpoint('').ok, false);
  const miss = loadCheckpoint(path.join(dir, 'nonexistent.json'));
  assert.equal(miss.restored, false);
});

test('版本不匹配的旧档：拒绝恢复并报告原因', async () => {
  const { writeFileSync } = await import('node:fs');
  const file = path.join(dir, 'future.json');
  writeFileSync(file, JSON.stringify({ version: 999, savedAt: Date.now() }));
  const r = loadCheckpoint(file);
  assert.equal(r.restored, false);
  assert.ok(r.report[0].includes('version mismatch'));
});

// ─── ΝΩ-22（热路径 IO 放大③）：分段序列化缓存执法册 ───

test('ΝΩ-22 分段缓存：journal 指纹未变 ⇒ 零重序列化；日志变更 ⇒ 全量重算；两档语义等价', async () => {
  uiMemory.remember('GitHub 搜索框', 0.5, 0.08);
  await journal.append({ ts: 1_000, tool: 'click_mouse', args: { x: 0.5 }, status: 'SUCCESS' });
  const file = path.join(dir, 'cp.json');
  assert.equal(saveCheckpoint(file).ok, true);
  const first = JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>;
  const stats1 = checkpointSectionStats();
  assert.equal(stats1['journal'], 1, '首存：journal 段序列化一次');
  // 二次保存：journal 未变（count:tip:base 指纹命中）⇒ 零重序列化
  assert.equal(saveCheckpoint(file).ok, true);
  const stats2 = checkpointSectionStats();
  assert.equal(stats2['journal'], 1, '指纹未变零重序列化（复用上次整段文本）');
  // 语义等价：缓存命中的段与首存逐字段等价（缓存只加速，不改内容）
  const second = JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>;
  assert.deepEqual(second.journal, first.journal, 'journal 段复用文本与首存逐字段等价');
  assert.deepEqual(second.uiMemory, first.uiMemory, '未变段（uiMemory 内容指纹命中）逐字段等价');
  // 对照：selfModel 段携带逐次 collect 翻转的 settledAt ⇒ 内容指纹捕获变更、
  // 重算入档（内容哈希指纹不吞任何真实变更）
  assert.equal(stats2['selfModel'], 2, '内容变化的段照常重算');
  // 日志追加（tip 翻转）⇒ journal 段全量重算
  await journal.append({ ts: 2_000, tool: 'type_text', args: { text: 'hi' }, status: 'SUCCESS' });
  assert.equal(saveCheckpoint(file).ok, true);
  const stats3 = checkpointSectionStats();
  assert.equal(stats3['journal'], 2, '指纹变更 ⇒ 该段全量重算');
  const third = JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>;
  assert.equal(third.journal.entries.length, 2, '新日志入档（缓存不吐旧段）');
  // 防御式：恢复路径整体失效缓存（恢复会替换子系统内容 —— 键失效路径）
  loadCheckpoint(file);
  assert.equal(checkpointSectionStats()['journal'], undefined, 'loadCheckpoint 后缓存归零');
});

test('ΝΩ-22 分段缓存防御：其他段内容变化仍被内容指纹捕获（缓存不吞变更）', async () => {
  uiMemory.remember('GitHub 搜索框', 0.5, 0.08);
  const file = path.join(dir, 'cp2.json');
  saveCheckpoint(file);
  // 变更非日志段内容（uiMemory 新增记忆）⇒ 内容指纹失配 ⇒ 重算入档
  uiMemory.remember('设置面板', 0.9, 0.05);
  saveCheckpoint(file);
  const cp = JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>;
  assert.equal(cp.uiMemory.landmarks.length, 2, '非日志段变更不被缓存吞掉');
});

// ─── ΝΩ-45：flushJournal 接入（checkpoint collect 前的磁盘一致性） ───

test('ΝΩ-45 flush 接入: 冲刷后磁盘 JSONL 与内存链/快照同源一致（collect 前清账语义）', async () => {
  const jpath = path.join(dir, 'j.jsonl');
  try {
    journal.configure(true, jpath, 1000);
    await journal.append({ ts: 1_000, tool: 'click_mouse', args: { x: 0.5 }, status: 'SUCCESS' });
    await journal.append({ ts: 2_000, tool: 'type_text', args: { text: 'hi' }, status: 'SUCCESS' });
    assert.equal(journalDiskStats().buffered, 2, '组提交窗口内（磁盘尚未见链）');
    assert.equal(flushJournal(), 2, '显式冲刷 API：两行清账');
    const disk = readFileSync(jpath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    const mem = journal.list(false);
    assert.equal(disk.length, mem.length, '行数一致');
    assert.deepEqual(disk.map(e => e.hash), mem.map(e => e.hash), '磁盘行序 = 链序（J 纪元不变量）');
    // 冲刷之后 saveCheckpoint（collect 读内存链）⇒ 快照与磁盘取证副本同源一致
    // （生产接线位：index.ts 卸载链在 saveCheckpoint 与 journal.reset 之前冲）
    const file = path.join(dir, 'cp.json');
    assert.equal(saveCheckpoint(file).ok, true);
    const cp = JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>;
    assert.deepEqual(
      cp.journal.entries.map((e: any) => e.hash),
      disk.map(e => e.hash),
      '快照段哈希序列 = 磁盘行哈希序列（collect 前清账的兑现）',
    );
    // 幂等面：空缓冲冲刷返回 0、不造文件
    assert.equal(flushJournal(), 0);
  } finally {
    journal.configure(true, '', 1000); // 还原无盘缺省（后续用例零磁盘噪声）
  }
});

// ─── ΝΩ-45：启动三腿并行墙钟（注入慢初始化器 + 假钟断言 < 串线和） ───

test('ΝΩ-45 启动并行: 慢初始化器假钟 —— 三腿墙钟 = max(腿) 且严格 < 串线和；错误隔离与顺序版同', async () => {
  // 假钟：只被腿完成事件推动（无真实睡等 —— 确定性零抖动）
  let t = 0;
  const clock = { now: () => t };
  const starts: number[] = [];
  const slow = (cost: number, tag: string) => async () => {
    const start = clock.now(); // 唤起即记起点（串行版下一条会看到前一条的完成时刻）
    starts.push(start);
    await Promise.resolve(); // 微任务让出（并行腿的交错点）
    if (t < start + cost) t = start + cost; // 完成时刻 = max(当前, 起点+成本)
    return tag;
  };
  const [a, b, c] = await runStartupLegs({
    environment: slow(100, 'env'),
    toolBarrel: slow(120, 'tools'),
    restores: () => 'restore', // 持久化 restore 族的现实形态：同步腿立即完成
  });
  assert.deepEqual([a, b, c], ['env', 'tools', 'restore'], '三腿结果按位归还');
  assert.deepEqual(starts, [0, 0], '两条异步腿都在 t=0 唤起（无串行等待 —— 并行性实证）');
  assert.equal(t, 120, '墙钟 = max(腿)（100 | 120 | 0 的最大者）');
  assert.ok(t < 100 + 120, '墙钟严格小于串线和 220');
  // 错误隔离：任一腿 rejection ⇒ 整体 rejection（Promise.all 首拒 —— 顺序版首抛同语义）
  await assert.rejects(
    () => runStartupLegs({
      environment: async () => { throw new Error('shaper boom'); },
      toolBarrel: slow(50, 'tools'),
      restores: () => { throw new Error('restore boom'); },
    }),
    /boom/,
    '首拒传播 ⇒ apply 整体失败（错误隔离与顺序执行同源）',
  );
});

// 清理全部临时目录（测试自洁 —— 世界级标准：测试不留垃圾）
process.on('exit', () => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });
