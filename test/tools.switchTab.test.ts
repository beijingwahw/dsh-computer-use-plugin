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
//   · ΝΩ-31 闭环验证：前后帧行指纹对照 —— 变化 ⇒ SUCCESS+证据；未变 ⇒ 注记
//     （不判 FAIL）；证据缺席（后端不在场 —— 生产门 healthSnapshot）⇒ 降级为
//     旧形状。取证走 _setTabHashCaptureForTest 注入缝：零 adapter、零 python
//     spawn（观察旁路不触发懒启动是生产门的立法语义，这里同律离线）。
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { system } from '../src/system.ts';
import * as backend from '../src/physicalBackend.ts';
import {
  switchTabTool,
  judgeTabSwitch,
  TAB_SWITCH_STABLE_DISTANCE,
  _setTabHashCaptureForTest,
} from '../src/tools/switchTab.ts';

type Exec = (a: unknown) => Promise<string>;
const exec = (t: unknown): Exec => (t as unknown as { execute: Exec }).execute;

/** system 键鼠 monkey-patch（system 是可变对象字面量 —— 恢复器还原原样） */
function patchPressHotkey(fn: (keys: string[]) => Promise<void>): () => void {
  const host = system as unknown as Record<string, unknown>;
  const saved = host.pressHotkey;
  host.pressHotkey = fn;
  return () => { host.pressHotkey = saved; };
}

afterEach(() => {
  _setTabHashCaptureForTest(null);
  backend._setAdapterForTests(null);
});

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

// ═══ ΝΩ-31：闭环验证（前后帧行指纹对照）═══

/** 纯函数判决表：指纹缺席 ⇒ null；距离 ≤ 阈 ⇒ false；> 阈 ⇒ true（阈上/阈下边界钉死） */
test('ΝΩ-31 judgeTabSwitch: 纯函数 —— 缺席 null / 阈下未变 / 阈上变化', () => {
  assert.equal(judgeTabSwitch(null, '00000000'), null, '前帧缺席 ⇒ 证据缺席');
  assert.equal(judgeTabSwitch('00000000', null), null, '后帧缺席 ⇒ 证据缺席');
  assert.equal(judgeTabSwitch('', '00000000'), null, '空指纹 ⇒ 证据缺席');
  const before = '0'.repeat(64);
  const flip = (n: number) => '0'.repeat(64 - n) + '1'.repeat(n);
  assert.equal(judgeTabSwitch(before, flip(TAB_SWITCH_STABLE_DISTANCE)), false, `距离 ${TAB_SWITCH_STABLE_DISTANCE} = 阈 ⇒ 未变`);
  assert.equal(judgeTabSwitch(before, flip(TAB_SWITCH_STABLE_DISTANCE + 1)), true, `距离 ${TAB_SWITCH_STABLE_DISTANCE + 1} > 阈 ⇒ 变化`);
  // hex 方言指纹（服务端域）与位串同判
  const hexA = '0'.repeat(16);
  const hexB = 'f'.repeat(16);
  assert.equal(judgeTabSwitch(hexA, hexA), false, 'hex 同指纹 ⇒ 未变');
  assert.equal(judgeTabSwitch(hexA, hexB), true, 'hex 全翻 ⇒ 变化');
});

/** 假指纹序列注入：captureTabHash 按序回放（ΝΩ-31 测试缝 —— 零 adapter 零 spawn） */
function injectHashSequence(hashes: string[]): void {
  let i = 0;
  _setTabHashCaptureForTest(async () => hashes[Math.min(i++, hashes.length - 1)] ?? null);
}

test('ΝΩ-31 switch_tab: 指纹变化 ⇒ SUCCESS + tab_switch_evidence.screen_changed=true + 指引落地', async () => {
  injectHashSequence(['0'.repeat(64), '0'.repeat(40) + '1'.repeat(24)]); // 距离 24 > 阈
  const chords: string[][] = [];
  const restore = patchPressHotkey(async (keys) => { chords.push([...keys]); });
  try {
    const out = JSON.parse(await exec(switchTabTool)({ direction: 'next' }));
    assert.equal(out.status, 'SUCCESS');
    assert.deepEqual(out.state_anchor.tab_switch_evidence, { screen_changed: true });
    assert.match(out.next_step, /CHANGED after the switch/);
    assert.match(out.next_step, /take_screenshot/);
    assert.deepEqual(chords, [['ctrl', 'tab']]);
  } finally {
    restore();
  }
});

test('ΝΩ-31 switch_tab: 指纹未变 ⇒ 注记不判 FAIL（可能视觉无差/无焦点），提示 switch_window 确认', async () => {
  injectHashSequence(['0'.repeat(64), '0'.repeat(64)]); // 距离 0 ≤ 阈
  const restore = patchPressHotkey(async () => { /* 假世界：按键即生效 */ });
  try {
    const out = JSON.parse(await exec(switchTabTool)({ direction: 'previous' }));
    assert.equal(out.status, 'SUCCESS', '未变是注记不是失败（诚实三态）');
    assert.deepEqual(out.state_anchor.tab_switch_evidence, { screen_changed: false });
    assert.match(out.next_step, /did NOT change after the switch/);
    assert.match(out.next_step, /switch_window/);
    assert.match(out.next_step, /take_screenshot/);
  } finally {
    restore();
  }
});

test('ΝΩ-31 switch_tab: 取证缺席（后端不在场 —— 生产门）⇒ 降级为旧形状（state_anchor 逐字节）', async () => {
  // 不注入指纹缝：healthSnapshot 为 null（无真实后端）⇒ 生产门放行降级路径
  assert.equal(backend.healthSnapshot(), null, '前提：离线环境无后端健康快照');
  const restore = patchPressHotkey(async () => { /* noop */ });
  try {
    const out = JSON.parse(await exec(switchTabTool)({ direction: 'next' }));
    assert.equal(out.status, 'SUCCESS');
    assert.deepEqual(out.state_anchor, { direction: 'next', shortcut: 'ctrl+tab' }, '降级红律：无证据 = 旧形状');
    assert.match(out.next_step, /verify the new tab content/);
  } finally {
    restore();
  }
});

test('ΝΩ-31 switch_tab: 指纹缝抛错 ⇒ 证据缺席降级（取证旁路故障不炸切换）', async () => {
  _setTabHashCaptureForTest(async () => { throw new Error('probe down'); });
  const restore = patchPressHotkey(async () => { /* noop */ });
  try {
    const out = JSON.parse(await exec(switchTabTool)({ direction: 'next' }));
    assert.equal(out.status, 'SUCCESS');
    assert.deepEqual(out.state_anchor, { direction: 'next', shortcut: 'ctrl+tab' }, '探针故障 = 诚实降级');
  } finally {
    restore();
  }
});
