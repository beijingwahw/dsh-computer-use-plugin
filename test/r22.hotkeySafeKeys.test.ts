// test/r22.hotkeySafeKeys.test.ts
// R2-2（热键安全面收口 · R1-8 冒烟遗留①的根因修复册）：
//   根因：press_hotkey 的键名白名单（schema 枚举 HOTKEY_WHITELIST_KEYS 及其
//   system._getKey fallbackMap 镜像）只含字母 a/c/v/z——ctrl+s 在**协议层**即被
//   ToolArgsError 拒绝（黑名单与 ΠΑΝ-12 闸门均无辜：ctrl+s 不命中任何黑名单条目，
//   闸门只拦黑名单和弦/敏感焦点 ctrl+v/危险上下文）。一切"ctrl+s 保存"类套件
//   话术被迫走菜单旁路（R1-8 attempt5-9 的主要成本源）。
//   修法：白名单收口为全字母表 + 导航键（与 python _KEY_MAP 既有立法同步）；
//   黑名单语义不动——本册执法验证危险和弦执法**不因扩员弱化**（fail-closed）。
// 全离线确定性：mock system.pressHotkey 计数派发；黑名单 throw 面用真实
// system.pressHotkey（黑名单检查先于任何后端调用，离线可测）。
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import type { Config } from '../src/config.ts';
import { system } from '../src/system.ts';
import { focusTracker } from '../src/focusTracker.ts';
import {
  hotkeyBlacklistHit, getHotkeyBlacklistCsv, isHotkeyBlacklistError,
} from '../src/system.hotkeyPolicy.ts';
import { assertActionAllowed } from '../src/tools/actionGate.ts';
import { createPressHotkeyTool, HOTKEY_WHITELIST_KEYS } from '../src/tools/pressHotkey.ts';

// ─── 公共脚手架（pan1213 同法）───

type Executable = { execute: (a: unknown) => Promise<string> };

const sysOriginal = system.pressHotkey.bind(system);
let presses = 0;

function installFakeSystem(): void {
  presses = 0;
  (system as { pressHotkey: unknown }).pressHotkey = async () => { presses++; };
}

beforeEach(() => {
  focusTracker.clear();
  installFakeSystem();
});

afterEach(() => {
  (system as { pressHotkey: unknown }).pressHotkey = sysOriginal;
  focusTracker.clear();
});

// 与 Config 缺省同值的黑名单 + ΠΑΝ-10 补全键（执法词表不因白名单扩员而变）
const hotkeyCfg = {
  enableApprovalGate: true,
  dangerPatterns: 'send,发送,delete,删除,pay,支付',
  enableRiskGate: true,
  riskPatterns: '',
  maxTextLength: 1000,
  focusMaxAgeMs: 60_000,
  hotkeyBlacklist: getHotkeyBlacklistCsv(),
} as unknown as Config;

// ═══ ① 最小复现（R1-8 冒烟症状）：ctrl+s 畅通 ═══

test('R2-2①: 复现修复——press_hotkey ctrl+s 过协议层并真实派发（修复前：ToolArgsError，s 不在枚举）', async () => {
  const tool = createPressHotkeyTool(hotkeyCfg) as Executable;
  const r = JSON.parse(await tool.execute({ keys: ['ctrl', 's'] }));
  assert.equal(r.status, 'SUCCESS', `ctrl+s 必须放行（实测 ${JSON.stringify(r).slice(0, 200)}）`);
  assert.equal(presses, 1, '物理键击恰好派发一次');
  // 零参装配（无 config 的完全旧路径）同样放行
  const bare = JSON.parse(await (createPressHotkeyTool() as Executable).execute({ keys: ['ctrl', 's'] }));
  assert.equal(bare.status, 'SUCCESS');
  assert.equal(presses, 2);
});

// ═══ ② 安全键矩阵：应用内编辑/导航和弦全放行（闸门 + 工具面）═══

test('R2-2②: 安全键矩阵放行——ctrl+s/z/a/c/v + 导航键 + 套件编辑主路径和弦', async () => {
  const safeChords: readonly string[][] = [
    ['ctrl', 's'], ['ctrl', 'z'], ['ctrl', 'a'], ['ctrl', 'c'], ['ctrl', 'v'],
    ['ctrl', 'home'], ['ctrl', 'end'], ['shift', 'end'], ['shift', 'home'],
    ['ctrl', 'l'], ['ctrl', 't'], ['ctrl', 'f'], ['ctrl', 'o'],
    ['down'], ['up'], ['left'], ['right'], ['pageup'], ['pagedown'],
    ['s'], ['enter'],
  ];
  for (const chord of safeChords) {
    // 判定面（ΠΑΝ-12 闸门，config 在场）
    const gate = assertActionAllowed('press_hotkey', { keys: chord }, hotkeyCfg);
    assert.ok(gate.allowed, `安全和弦 ${chord.join('+')} 必须过闸（实测 ${JSON.stringify(gate)}）`);
    // 工具面（含协议层枚举校验）
    const r = JSON.parse(await (createPressHotkeyTool(hotkeyCfg) as Executable).execute({ keys: chord }));
    assert.equal(r.status, 'SUCCESS', `安全和弦 ${chord.join('+')} 必须派发`);
  }
  assert.equal(presses, safeChords.length, '全部安全和弦各派发一次');
});

// ═══ ③ 黑名单执法回归（fail-closed：扩员绝不弱化真危险键）═══

test('R2-2③: 黑名单和弦仍被拦——纯函数/闸门/工具面/系统层四层一致', async () => {
  // 枚举可表达的危险和弦（键名全在白名单内 ⇒ 拦截责任落在黑名单执法链；
  // meta/win 形态在层0（协议层枚举排除）与末尾 system 层直调面覆盖）
  const dangerChords: readonly string[][] = [
    ['alt', 'f4'], ['cmd', 'q'],
    ['ctrl', 'alt', 'delete'], ['ctrl', 'shift', 'esc'], ['alt', 'space'],
    ['alt', 'alt', 'f4'], ['f4', 'alt', 'f4'],
  ];
  const csv = getHotkeyBlacklistCsv();
  for (const chord of dangerChords) {
    // 层1：纯函数（生效缺省 CSV 含 ΠΑΝ-10 补全）
    assert.ok(hotkeyBlacklistHit(chord, csv) !== null, `${chord.join('+')} 必须命中黑名单`);
    // 层2：ΠΑΝ-12 闸门（结构化拒绝，令牌不可解）
    const gate = assertActionAllowed('press_hotkey', { keys: chord }, hotkeyCfg);
    assert.ok(!gate.allowed && gate.reason === 'blacklisted-hotkey', `${chord.join('+')} 闸门必须拒`);
    // 层3：工具面（ACTION_REQUIRED + 零派发）
    const r = JSON.parse(await (createPressHotkeyTool(hotkeyCfg) as Executable).execute({ keys: chord }));
    assert.equal(r.status, 'ACTION_REQUIRED', `${chord.join('+')} 工具面必须拒`);
    assert.equal(r.state_anchor.reason, 'blacklisted-hotkey');
  }
  assert.equal(presses, 0, '危险和弦零物理派发');
  // 层4：system 层 P1-3 执法（真实 pressHotkey —— 黑名单检查先于任何后端调用）
  (system as { pressHotkey: unknown }).pressHotkey = sysOriginal;
  await assert.rejects(
    system.pressHotkey(['alt', 'f4']),
    (e: Error) => isHotkeyBlacklistError(e),
    'system 层黑名单拦截标记 [SYSTEM_HOTKEY_BLOCKED] 必须在场',
  );
  // 层0（第一道防线）：OS 壳层键名（meta/win）根本不在 schema 枚举里 ——
  // 协议层 ToolArgsError，模型无法把它们带进任何和弦
  await assert.rejects(
    (createPressHotkeyTool(hotkeyCfg) as Executable).execute({ keys: ['meta'] }),
    (e: Error) => e.constructor.name.includes('ToolArgsError'),
    'meta 键名必须在协议层被枚举排除',
  );
  await assert.rejects(
    (createPressHotkeyTool(hotkeyCfg) as Executable).execute({ keys: ['win', 'r'] }),
    (e: Error) => e.constructor.name.includes('ToolArgsError'),
    'win 键名必须在协议层被枚举排除',
  );
  // 系统层对别名形态仍独立执法（绕过工具直调 system 的调用方面）
  await assert.rejects(
    system.pressHotkey(['win', 'r']),
    (e: Error) => isHotkeyBlacklistError(e),
    'system 层必须拦 win+r（黑名单单键条目 win/meta）',
  );
});

// ═══ ④ ΠΑΝ-12 敏感焦点 ctrl+v 拦截保持（键盘孪生臂零回归）═══

test('R2-2④: 敏感焦点上的 ctrl+v 仍被拦（sensitive-input）；净焦点照常放行', async () => {
  focusTracker.set(0.5, 0.5, true);
  const blocked = assertActionAllowed('press_hotkey', { keys: ['ctrl', 'v'] }, hotkeyCfg);
  assert.ok(!blocked.allowed && blocked.reason === 'sensitive-input');
  const r = JSON.parse(await (createPressHotkeyTool(hotkeyCfg) as Executable).execute({ keys: ['ctrl', 'v'] }));
  assert.equal(r.status, 'ACTION_REQUIRED');
  assert.equal(r.state_anchor.reason, 'sensitive-input');
  assert.equal(presses, 0, '敏感焦点粘贴零派发');
  focusTracker.clear();
  const okGate = assertActionAllowed('press_hotkey', { keys: ['ctrl', 'v'] }, hotkeyCfg);
  assert.ok(okGate.allowed, '净焦点 ctrl+v 必须放行');
});

// ═══ ⑤ 三层镜像同步金丝雀（TS 白名单 ↔ system fallbackMap ↔ python _KEY_MAP）═══

test('R2-2⑤: 白名单键集完备性——全字母表 + 导航键；OS 壳层别名绝不入列', () => {
  const set = new Set(HOTKEY_WHITELIST_KEYS);
  for (const l of 'abcdefghijklmnopqrstuvwxyz') {
    assert.ok(set.has(l), `字母 ${l} 必须在白名单（全字母表立法）`);
  }
  for (const k of ['home', 'end', 'pageup', 'pagedown', 'up', 'down', 'left', 'right']) {
    assert.ok(set.has(k), `导航键 ${k} 必须在白名单`);
  }
  // fail-closed 方向：OS 壳层键名不入白名单（第一道防线是枚举排除，
  // 第二道是黑名单 —— meta 别名族全被 hotkeyPolicy 归一为 meta 后拒绝）
  for (const k of ['win', 'meta', 'super', 'printscreen', 'insert', 'capslock']) {
    assert.ok(!set.has(k), `OS 壳层/无需求键 ${k} 不得进白名单`);
  }
});

test('R2-2⑥: python _KEY_MAP 覆盖面金丝雀（跨语言双向同步——python 缺键此处红）', () => {
  const py = readFileSync(
    new URL('../python_service/dsh_physical/input.py', import.meta.url), 'utf8',
  );
  const m = py.match(/_KEY_MAP: dict\[str, str\] = \{([\s\S]*?)\n\}/);
  assert.ok(m, 'input.py 的 _KEY_MAP 块必须可定位');
  const block = m[1];
  // 字母表由 chr range 推导覆盖（"a".."z"），其余键须有字面条目
  assert.ok(/range\(ord\("a"\), ord\("z"\) \+ 1\)/.test(block), '全字母表推导行在场');
  for (const k of HOTKEY_WHITELIST_KEYS) {
    if (/^[a-z]$/.test(k)) continue; // 字母由 range 行覆盖
    assert.ok(
      new RegExp(`"${k}"\\s*:`).test(block),
      `python _KEY_MAP 缺白名单键 ${k} 的映射（跨语言镜像漂移）`,
    );
  }
});
