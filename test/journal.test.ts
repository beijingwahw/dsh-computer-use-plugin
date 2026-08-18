// test/journal.test.ts
// 哈希链审计：正常链完整 / 单点篡改被定位 / 恢复后续链不断。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { journal } from '../src/journal.ts';

beforeEach(() => journal.reset());

test('append 封链：verify 全绿', async () => {
  await journal.append({ ts: 1, tool: 'click_mouse', args: { x: 0.5, y: 0.5 }, status: 'SUCCESS' });
  await journal.append({ ts: 2, tool: 'type_text', args: { text: 'hi' }, status: 'SUCCESS' });
  await journal.append({ ts: 3, tool: 'click_mouse', args: { x: 0.1, y: 0.1 }, status: 'FAILED' });
  const v = journal.verify();
  assert.equal(v.ok, true);
  assert.equal(v.length, 3);
});

test('篡改检测：改一条历史记录 ⇒ 链在断点报 警', async () => {
  await journal.append({ ts: 1, tool: 'click_mouse', args: { x: 0.5 }, status: 'SUCCESS' });
  await journal.append({ ts: 2, tool: 'type_text', args: { text: 'original' }, status: 'SUCCESS' });
  await journal.append({ ts: 3, tool: 'scroll_page', args: {}, status: 'SUCCESS' });

  // 模拟事后篡改：改写第 2 条的参数（绕过 append 直接动内存）
  const all = (journal as any).entries as any[];
  all[1].args.text = 'TAMPERED';

  const v = journal.verify();
  assert.equal(v.ok, false);
  assert.equal(v.brokenAt, 1); // 精确定位第一个断点
});

test('恢复续链：restoreChain 后继续 append，verify 仍全绿', async () => {
  await journal.append({ ts: 1, tool: 'click_mouse', args: {}, status: 'SUCCESS' });
  const entries = journal.list(false);
  const tip = journal.tip;

  journal.reset(); // 模拟崩溃重启
  journal.restoreChain(entries, tip);
  await journal.append({ ts: 2, tool: 'press_hotkey', args: { keys: ['enter'] }, status: 'SUCCESS' });

  const v = journal.verify();
  assert.equal(v.ok, true); // 恢复后追加不断链
  assert.equal(v.length, 2);
});
