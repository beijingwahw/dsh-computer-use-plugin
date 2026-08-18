// test/checkpoint.test.ts
// 认知快照：原子写 / 全子系统往返 / 崩溃重启语义（恢复后续链不断）。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { saveCheckpoint, loadCheckpoint } from '../src/checkpoint.ts';
import { uiMemory } from '../src/uiMemory.ts';
import { failureMemory } from '../src/failureMemory.ts';
import { skillLibrary } from '../src/skillLibrary.ts';
import { telemetry } from '../src/telemetry.ts';
import { journal } from '../src/journal.ts';

let dir: string;
beforeEach(() => {
  uiMemory.reset();
  failureMemory.reset();
  skillLibrary.reset();
  telemetry.reset();
  journal.reset();
  dir = mkdtempSync(path.join(tmpdir(), 'ckpt-'));
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

// 清理临时目录（测试自洁 —— 世界级标准：测试不留垃圾）
process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
