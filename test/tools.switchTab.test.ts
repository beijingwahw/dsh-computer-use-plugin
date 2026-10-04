// test/tools.switchTab.test.ts
// W6R-B7 补强：src/tools/switchTab.ts 工具层直测（此前零直接覆盖）。
// 修复史锚点：原版两 bug（defineTool 未导入、direction 参数被解析后丢弃）——
// 本文件锁死「方向真正参与按键组合」的契约。
// 全离线确定性：
//   · 参数校验：direction 必填、枚举字面量（next/previous）；
//   · 正常路径：patchSystem 捕获 system.pressHotkey 的和弦（先例 w1exec.test.ts）；
//   · 全链路径：_setAdapterForTests 假 adapter —— 工具 → system.pressHotkey
//     （黑名单执法 + ioMutex serialize）→ backend.pressHotkey 真实链路；
//   · 故障路径：pressHotkey 抛错 → 诚实 FAILED + 浏览器焦点指引。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { system } from '../src/system.ts';
import * as backend from '../src/physicalBackend.ts';
import { switchTabTool } from '../src/tools/switchTab.ts';

type Exec = (a: unknown) => Promise<string>;
const exec = (t: unknown): Exec => (t as unknown as { execute: Exec }).execute;

/** system 键鼠 monkey-patch（system 是可变对象字面量 —— 恢复器还原原样） */
function patchPressHotkey(fn: (keys: string[]) => Promise<void>): () => void {
  const host = system as unknown as Record<string, unknown>;
  const saved = host.pressHotkey;
  host.pressHotkey = fn;
  return () => { host.pressHotkey = saved; };
}

test('switch_tab: direction 缺席在协议层被拒（required）', async () => {
  await assert.rejects(exec(switchTabTool)({}), (e: Error) => e.constructor.name.includes('ToolArgsError'));
});

test('switch_tab: 非法 direction —— 结构化 FAILED + 重试指引', async () => {
  const out = JSON.parse(await exec(switchTabTool)({ direction: 'sideways' }));
  assert.equal(out.status, 'FAILED');
  assert.equal(out.action, 'Tab switch validation failed.');
  assert.equal(out.state_anchor.error, 'Invalid direction.');
  assert.match(out.next_step, /direction "next" or "previous"/);
});

test('switch_tab: 枚举字面量区分大小写（"NEXT" 拒绝）', async () => {
  const out = JSON.parse(await exec(switchTabTool)({ direction: 'NEXT' }));
  assert.equal(out.status, 'FAILED');
});

test('switch_tab: next → ctrl+tab 和弦（direction 不再被丢弃）', async () => {
  const chords: string[][] = [];
  const restore = patchPressHotkey(async (keys) => { chords.push([...keys]); });
  try {
    const out = JSON.parse(await exec(switchTabTool)({ direction: 'next' }));
    assert.equal(out.status, 'SUCCESS');
    assert.equal(out.action, 'Switched to the next tab.');
    assert.deepEqual(out.state_anchor, { direction: 'next', shortcut: 'ctrl+tab' });
    assert.match(out.next_step, /take_screenshot/);
    assert.deepEqual(chords, [['ctrl', 'tab']]);
  } finally {
    restore();
  }
});

test('switch_tab: previous → ctrl+shift+tab 和弦', async () => {
  const chords: string[][] = [];
  const restore = patchPressHotkey(async (keys) => { chords.push([...keys]); });
  try {
    const out = JSON.parse(await exec(switchTabTool)({ direction: 'previous' }));
    assert.equal(out.status, 'SUCCESS');
    assert.equal(out.action, 'Switched to the previous tab.');
    assert.deepEqual(out.state_anchor, { direction: 'previous', shortcut: 'ctrl+shift+tab' });
    assert.deepEqual(chords, [['ctrl', 'shift', 'tab']]);
  } finally {
    restore();
  }
});

test('switch_tab: pressHotkey 抛错 —— 诚实 FAILED + 浏览器焦点提示', async () => {
  const restore = patchPressHotkey(async () => { throw new Error('[SYSTEM_HOTKEY_BLOCKED] 拦截'); });
  try {
    const out = JSON.parse(await exec(switchTabTool)({ direction: 'next' }));
    assert.equal(out.status, 'FAILED');
    assert.equal(out.action, 'Tab switch (next) failed.');
    assert.equal(out.state_anchor.error, '[SYSTEM_HOTKEY_BLOCKED] 拦截');
    assert.match(out.next_step, /browser may not be focused/);
  } finally {
    restore();
  }
});

test('switch_tab: 全链（不 patch system）—— ctrl+tab 过黑名单经 serialize 直达 backend', async () => {
  const seen: Array<{ keys: string[]; dryRun: boolean }> = [];
  backend._setAdapterForTests({
    pressHotkey: async (args: { keys: string[]; dryRun?: boolean }) => {
      seen.push({ keys: [...args.keys], dryRun: args.dryRun === true });
      return { ok: true as const, value: { pressed: args.keys } };
    },
  } as never);
  try {
    const out = JSON.parse(await exec(switchTabTool)({ direction: 'previous' }));
    assert.equal(out.status, 'SUCCESS');
    // ctrl+shift+tab 不在系统级热键黑名单（alt+f4/meta/...）—— 默认放行
    assert.deepEqual(seen.map(s => s.keys), [['ctrl', 'shift', 'tab']], '和弦原样到达物理后端');
    assert.ok(seen.every(s => !s.dryRun), '非 dry-run：真实派发');
  } finally {
    backend._setAdapterForTests(null);
  }
});

test('switch_tab: output.render 返回文本块（B-4 锚点字符串直通）', () => {
  const tool = switchTabTool as unknown as {
    output: { render: (a: unknown, v: string) => Array<{ type: string; text: string }> };
  };
  const blocks = tool.output.render({}, 'hello');
  assert.deepEqual(blocks, [{ type: 'text', text: 'hello' }]);
});
