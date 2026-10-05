// test/pan1213.gate.test.ts
// ΠΑΝ 修复潮执法册（工单 ΠΑΝ-12/13/14）：键盘/拖拽侧门封堵 + ActionKind 闭集。
//   ΠΑΝ-12 ActionKind 扩员：press_hotkey/drag_mouse/scroll_page 纳入
//          assertActionAllowed —— 黑名单和弦（复用 system.hotkeyPolicy 纯函数）、
//          enter 在危险上下文（context_description 自述通道 → 审批域）、
//          ctrl+v 粘贴面（敏感焦点 ⇒ sensitive-input，type 臂的键盘孪生）。
//   ΠΑΝ-13 drag_mouse 补防：闸门接入（判定事实源单一化）+ 双钥公证锁
//          （落点 OCR/白盒取证重审）+ beginAttempt 派发预留与步终结算闭环。
//   ΠΑΝ-14 装配执法：ACTION_KIND_UNIVERSE 闭集完整性锁定 —— 新增 kind 漏判
//          （宇宙常量/分派表/联合类型三者任一失同步）即红。
// 零回归律锚：click/type 两臂旧行为在本册复测（既有 Δ/Ρ 册继续全量执法）。
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import type { Config } from '../src/config.ts';
import { system } from '../src/system.ts';
import { approval, resetApproval, setConfirmCodeChannel, type ConfirmCodeDelivery } from '../src/approval.ts';
import { focusTracker } from '../src/focusTracker.ts';
import {
  assertActionAllowed, ACTION_KIND_UNIVERSE, type ActionKind, type ActionGateDecision,
} from '../src/tools/actionGate.ts';
import { createDragMouseTool } from '../src/tools/dragMouse.ts';
import { createPressHotkeyTool } from '../src/tools/pressHotkey.ts';
import { notaryEvidence } from '../src/tools/clickMouse.ts';

// ─── 公共脚手架 ───

type Executable = { execute: (a: unknown) => Promise<string> };

/** W6R fail-closed：带外码采集 + 携码授予（无码 grant 已废除） */
const oobSink: ConfirmCodeDelivery[] = [];
function armOob(): void {
  oobSink.length = 0;
  setConfirmCodeChannel(d => { oobSink.push({ ...d }); });
}
function grantOob(token: string): boolean {
  const hit = oobSink.find(d => d.token === token);
  return approval.grantDetailed(token, true, hit ? { confirmCode: hit.confirmCode } : {}).ok;
}

const sysOriginals = {
  getScreenSize: system.getScreenSize.bind(system),
  dragMouse: system.dragMouse.bind(system),
  pressHotkey: system.pressHotkey.bind(system),
};
let drags = 0;
let presses = 0;

function installFakeSystem(): void {
  drags = presses = 0;
  system.getScreenSize = async () => ({ width: 1920, height: 1080 });
  system.dragMouse = async () => { drags++; };
  system.pressHotkey = async () => { presses++; };
}

beforeEach(() => {
  resetApproval();
  focusTracker.clear();
  installFakeSystem();
});

afterEach(() => {
  system.getScreenSize = sysOriginals.getScreenSize;
  system.dragMouse = sysOriginals.dragMouse;
  system.pressHotkey = sysOriginals.pressHotkey;
  focusTracker.clear();
});

// 与 epochDelta.perimeter 的 dragCfg 同族（闸门开、验证/公证锁关 —— 离线确定性）
const dragCfg = {
  enableApprovalGate: true,
  dangerPatterns: 'send,发送,delete,删除,pay,支付',
  enableRiskGate: true,
  riskPatterns: '',
  maxTextLength: 1000,
  focusMaxAgeMs: 60_000,
  enableNotarizationLock: false,
  notarySemanticHandshake: true,
  verifyActions: false,
  dryRun: false,
  adaptiveSettle: false,
  actionSettleMs: 1,
  noopSimilarityThreshold: 0.97,
  regionVerifyRadius: 0.15,
} as unknown as Config;

// 与 Config 缺省同值的黑名单（ΠΑΝ-12 hotkey 臂的执法词表）
const HOTKEY_BL = 'alt+f4,meta,meta+l,meta+r,meta+d,win,cmd+q,ctrl+alt+delete';
const hotkeyCfg = {
  enableApprovalGate: true,
  dangerPatterns: 'send,发送,delete,删除,pay,支付',
  enableRiskGate: true,
  riskPatterns: '',
  maxTextLength: 1000,
  focusMaxAgeMs: 60_000,
  hotkeyBlacklist: HOTKEY_BL,
} as unknown as Config;

// ═══ ΠΑΝ-14：闭集完整性执法 ═══

test('ΠΑΝ-14①: ACTION_KIND_UNIVERSE 闭集锁定 —— 五个物理写通道全数在场，增删即红', () => {
  assert.deepEqual(
    [...ACTION_KIND_UNIVERSE],
    ['click_mouse', 'type_text', 'press_hotkey', 'drag_mouse', 'scroll_page'],
    '闭集宇宙 = 全部物理写通道（新增通道须同步本常量、联合类型与分派表）',
  );
  // 冻结执法：运行时篡改静默失败（不抛），成员不可改写
  assert.ok(Object.isFrozen(ACTION_KIND_UNIVERSE), '宇宙常量必须 frozen');
});

test('ΠΑΝ-14②: 联合类型/宇宙常量/分派表三者同源（源码立法文本锁定 —— 漏判即红）', () => {
  const src = readFileSync(new URL('../src/tools/actionGate.ts', import.meta.url), 'utf8');
  // ① ActionKind 联合类型成员 = 宇宙常量成员（新 kind 只加一边 ⇒ 失同步即红）
  const m = src.match(/export type ActionKind = ([^;]+);/);
  assert.ok(m, 'ActionKind 联合类型定义必须可定位');
  const members = m[1].split('|').map(s => s.trim().replace(/^'|'$/g, ''));
  assert.deepEqual(members, [...ACTION_KIND_UNIVERSE], '联合类型与宇宙常量一一对应');
  // ② 分派表（映射类型）每个宇宙成员显式占位 —— 缺键在编译期红，此处钉源码形状
  const hm = src.match(/const ACTION_KIND_HANDLERS[^{]*\{([\s\S]*?)\n\};/);
  assert.ok(hm, 'ACTION_KIND_HANDLERS 分派表必须可定位');
  for (const k of ACTION_KIND_UNIVERSE) {
    assert.ok(new RegExp(`^\\s*${k}:\\s`, 'm').test(hm[1]), `分派表缺 ${k} 的显式占位（新增 kind 漏判）`);
  }
});

test('ΠΑΝ-14③: 每个宇宙成员可判定（不抛、出决策）；未登记 kind ⇒ fail-closed 结构化拒绝', () => {
  const samples: Record<string, Record<string, unknown>> = {
    click_mouse: { target_description: '菜单' },
    type_text: { text: 'hello' },
    press_hotkey: { keys: ['ctrl', 'c'] },
    drag_mouse: { target_description: '窗口滑块' },
    scroll_page: { direction: 'down', amount: 3 },
  };
  for (const k of ACTION_KIND_UNIVERSE) {
    const d = assertActionAllowed(k as ActionKind, samples[k], {});
    assert.equal(typeof d.allowed, 'boolean', `${k} 必须出决策（绝不抛）`);
    assert.equal(d.allowed, true, `${k} 的良性样本放行`);
    assert.equal(d.dangerous, false, `${k} 的良性样本不危险`);
  }
  // 未登记 kind：扩员前的病灶是静默落进 type 臂 —— 现为结构化 fail-closed
  const d = assertActionAllowed('move_mouse' as unknown as ActionKind, { x: 0.5 }, {});
  assert.equal(d.allowed, false);
  assert.equal(d.reason, 'unknown-action-kind');
  assert.equal(d.requiresApproval, false);
});

// ═══ ΠΑΝ-12：hotkey 臂执法 ═══

test('ΠΑΝ-12①: 黑名单和弦被拦（alt+f4 / 重复键折叠 alt+alt+f4 / 含 meta 单键）—— 令牌不可解', () => {
  const d1 = assertActionAllowed('press_hotkey', { keys: ['alt', 'f4'] }, hotkeyCfg);
  assert.equal(d1.allowed, false);
  assert.equal(d1.reason, 'blacklisted-hotkey');
  assert.equal(d1.requiresApproval, false, 'OS 壳层和弦令牌不可解');

  // 重复修饰键不改变和弦语义（['alt','alt','f4'] 与 ['alt','f4'] 同一和弦）
  const d2 = assertActionAllowed('press_hotkey', { keys: ['alt', 'alt', 'f4'] }, hotkeyCfg);
  assert.equal(d2.allowed, false, '重复键折叠：alt+alt+f4 同样命中 alt+f4 黑名单');
  assert.equal(d2.reason, 'blacklisted-hotkey');

  // 单键条目 'meta'：任何含 meta 的和弦都拒（system.hotkeyPolicy 同律）
  const d3 = assertActionAllowed('press_hotkey', { keys: ['ctrl', 'shift', 'meta'] }, hotkeyCfg);
  assert.equal(d3.reason, 'blacklisted-hotkey');

  // ctrl+alt+delete 整体和弦条目
  const d4 = assertActionAllowed('press_hotkey', { keys: ['delete', 'ctrl', 'alt'] }, hotkeyCfg);
  assert.equal(d4.reason, 'blacklisted-hotkey', '排序无关的整体和弦比对');
});

test('ΠΑΝ-12①b: 黑名单 CSV 缺席 ⇒ 闸门不重复执法（事实源仍是 system 层 P1-3 —— 零回归）', () => {
  // 无 config（p1-fixes 语境）：alt+f4 由 system 层拦截，闸门放行交由旧路径
  const d = assertActionAllowed('press_hotkey', { keys: ['alt', 'f4'] });
  assert.equal(d.allowed, true, '无 config ⇒ 闸门对黑名单缺席不执法（完全旧路径）');
  // 显式空串 = 部署明示不设防（与 hotkeyBlacklistHit 空串语义同律）
  const d2 = assertActionAllowed('press_hotkey', { keys: ['alt', 'f4'] }, { hotkeyBlacklist: '' });
  assert.equal(d2.allowed, true);
});

test('ΠΑΝ-12②: enter 在危险上下文被拦（无令牌/伪令牌归因分叉）；持已授予令牌放行', () => {
  // 攻击形态（C1-5 H5 ①）：点开危险对话框后 press_hotkey(['enter']) 激活确认
  const d = assertActionAllowed('press_hotkey',
    { keys: ['enter'], context_description: '确认删除订单对话框的默认按钮' }, hotkeyCfg);
  assert.equal(d.allowed, false);
  assert.equal(d.reason, 'irreversible-action');
  assert.equal(d.requiresApproval, true, '审批域：一枚已授予令牌可解封');
  assert.equal(d.dangerous, true);
  assert.equal(d.dangerSignalChannel, 'context_description', '信号通道归因（hotkey 自述通道）');

  const fake = assertActionAllowed('press_hotkey',
    { keys: ['enter'], context_description: '删除 对话框', approval_token: 'APR-FAKE' }, hotkeyCfg);
  assert.equal(fake.reason, 'token-not-granted-or-expired');

  // 持已授予令牌 ⇒ 放行且保持 dangerous=true（下游一次性消费据此挂钩）
  armOob();
  const pa = approval.request('enter 确认删除订单');
  assert.equal(grantOob(pa.token), true);
  const ok = assertActionAllowed('press_hotkey',
    { keys: ['enter'], context_description: '确认删除订单', approval_token: pa.token }, hotkeyCfg);
  assert.equal(ok.allowed, true);
  assert.equal(ok.dangerous, true);
  assert.equal(ok.requiresApproval, true);

  // 无害上下文（普通输入框回车）不受扰 —— 回归
  const benign = assertActionAllowed('press_hotkey', { keys: ['enter'], context_description: '搜索框' }, hotkeyCfg);
  assert.equal(benign.allowed, true);
  assert.equal(benign.dangerous, false);
});

test('ΠΑΝ-12③: ctrl+v 粘贴面 —— 敏感焦点上凭据粘贴被拦（type 臂的键盘孪生）', () => {
  // 攻击形态（C1-5 H5 ②）：点击密码框后（focus 已标敏感）ctrl+v 粘剪贴板
  focusTracker.set(0.5, 0.5, true); // 点击密码框后的焦点登记（clickMouse 同律）
  const d = assertActionAllowed('press_hotkey', { keys: ['ctrl', 'v'] }, hotkeyCfg);
  assert.equal(d.allowed, false);
  assert.equal(d.reason, 'sensitive-input');
  assert.equal(d.requiresApproval, false, '凭据面令牌不可解（交还用户）');
  // cmd 别名同属粘贴面：默认黑名单里 'meta' 单键条目更先拦（cmd 折叠为 meta ——
  // 任何含 OS 壳层修饰键的粘贴和弦都先吃黑名单）；收窄黑名单后 cmd+v 落到粘贴臂
  const narrowed = { ...hotkeyCfg, hotkeyBlacklist: 'alt+f4' } as unknown as Config;
  assert.equal(
    assertActionAllowed('press_hotkey', { keys: ['cmd', 'v'] }, narrowed).reason,
    'sensitive-input',
    'cmd+v 在无 meta 单键条目的黑名单下落到粘贴面执法',
  );
  assert.equal(
    assertActionAllowed('press_hotkey', { keys: ['cmd', 'v'] }, hotkeyCfg).reason,
    'blacklisted-hotkey',
    '默认黑名单：cmd 是 meta 的别名 —— 含 OS 壳层修饰键的和弦先吃黑名单',
  );

  // 非敏感焦点上的常规粘贴不受扰 —— 回归
  focusTracker.clear();
  const benign = assertActionAllowed('press_hotkey', { keys: ['ctrl', 'v'] }, hotkeyCfg);
  assert.equal(benign.allowed, true, '普通粘贴照常（只拦敏感焦点上的凭据粘贴面）');
});

test('ΠΑΝ-12③b: 审批闸门关闭 ⇒ 危险上下文 enter 不拦（危险词语义只属审批域 —— 回归）', () => {
  const d = assertActionAllowed('press_hotkey',
    { keys: ['enter'], context_description: '删除 对话框' }, { ...hotkeyCfg, enableApprovalGate: false });
  assert.equal(d.allowed, true);
  assert.equal(d.dangerous, false);
});

// ═══ ΠΑΝ-12/13：drag 臂执法（闸门级） ═══

test('ΠΑΝ-13①: drag 闸门 —— 危险目的地被拦 / 可选描述通道放行 / 持令牌放行', () => {
  // 危险目的地（无令牌）⇒ 审批域拒绝（归因与 click 同律）
  const d = assertActionAllowed('drag_mouse', { target_description: '把 report.doc 拖到删除区' }, dragCfg);
  assert.equal(d.allowed, false);
  assert.equal(d.reason, 'irreversible-action');
  assert.equal(d.requiresApproval, true);
  assert.equal(d.dangerSignalChannel, 'target_description');

  armOob();
  const pa = approval.request('拖到删除区');
  grantOob(pa.token);
  const ok = assertActionAllowed('drag_mouse', { target_description: '拖到删除区', approval_token: pa.token }, dragCfg);
  assert.equal(ok.allowed, true);
  assert.equal(ok.dangerous, true);

  // 无描述（可选通道）：滑块/窗口拖拽不设 undescribed 硬前置（Δ#6 立法保持）
  const plain = assertActionAllowed('drag_mouse', {}, dragCfg);
  assert.equal(plain.allowed, true);
  assert.equal(plain.dangerous, false);
  // 无害描述同律
  assert.equal(assertActionAllowed('drag_mouse', { target_description: 'resize the window slider' }, dragCfg).allowed, true);
});

test('ΠΑΝ-13②: drag 公证锁 —— 落点实读见危险 ⇒ 拦（自述无害不再够用）；谎报 ⇒ notary-mismatch', () => {
  const lockCfg = { ...dragCfg, enableNotarizationLock: true } as Partial<typeof dragCfg>;
  // 模型自述无害，但落点 OCR 实读「删除」⇒ fail-heavy 四通道执法（ocr_label 归因）
  const d = assertActionAllowed('drag_mouse',
    { target_description: '移动文件到文件夹' }, lockCfg, { ocrLabel: '删除 回收站区域', structuralName: null });
  assert.equal(d.allowed, false);
  assert.equal(d.reason, 'irreversible-action');
  assert.equal(d.dangerSignalChannel, 'ocr_label', '危险来自屏幕实读（注入谎报目的地的根除点）');
  assert.equal(d.notarization, 'engaged');

  // 实读与自述不符 ⇒ notary-mismatch（要求按屏幕实读文字重述）
  const mm = assertActionAllowed('drag_mouse',
    { target_description: '折叠菜单' }, lockCfg, { ocrLabel: 'recycle bin drop zone', structuralName: null });
  assert.equal(mm.allowed, false);
  assert.equal(mm.reason, 'notary-mismatch');

  // 无描述 + 落点实读危险 ⇒ 仍拦（fail-heavy 先于可选通道松弛）
  const blind = assertActionAllowed('drag_mouse', {}, lockCfg, { ocrLabel: '删除', structuralName: null });
  assert.equal(blind.allowed, false);
  assert.equal(blind.reason, 'irreversible-action');

  // 总开关关 ⇒ 完全旧路径（evidence 一律无视，键不入场）
  const off = assertActionAllowed('drag_mouse',
    { target_description: '移动文件' }, dragCfg, { ocrLabel: '删除', structuralName: null });
  assert.equal(off.allowed, true);
  assert.equal(off.notarization, undefined, '锁关 ⇒ notarization 键不入场');
});

// ═══ click/type 旧行为回归（零回归律 —— 判定逐字节复测） ═══

test('ΠΑΝ-12R: click/type 两臂旧行为回归（扩员不触碰既有判定语义）', () => {
  // click：危险无令牌 / 伪令牌 / 未描述 / 良性
  assert.equal(assertActionAllowed('click_mouse', { target_description: '发送按钮' }, dragCfg).reason, 'irreversible-action');
  assert.equal(assertActionAllowed('click_mouse', { target_description: '支付', approval_token: 'APR-X' }, dragCfg).reason, 'token-not-granted-or-expired');
  assert.equal(assertActionAllowed('click_mouse', { x: 0.5, y: 0.5 }, dragCfg).reason, 'undescribed-click');
  assert.equal(assertActionAllowed('click_mouse', { target_description: '菜单按钮' }, dragCfg).allowed, true);
  // J-14：expected_text 第二信号通道
  assert.equal(assertActionAllowed('click_mouse', { target_description: '按钮', expected_text: '发送成功' }, dragCfg).reason, 'irreversible-action');
  // type：超长 / 风险词 / 良性
  assert.equal(assertActionAllowed('type_text', { text: 'x'.repeat(1001) }, { maxTextLength: 1000 }).reason, 'text-too-long');
  assert.equal(assertActionAllowed('type_text', { text: 'my password is hunter2' }, dragCfg).reason, 'sensitive-input');
  assert.equal(assertActionAllowed('type_text', { text: 'hello world' }, dragCfg).allowed, true);
});

// ═══ ΠΑΝ-13：dragMouse 工具面（预留-结算闭环） ═══

test('ΠΑΝ-13③: 危险拖拽工具面被拦（闸门前置，物理派发 = 0）+ 持令牌放行且步终焚毁', async () => {
  const tool = createDragMouseTool(dragCfg);
  const blocked = JSON.parse(await (tool as Executable).execute({
    startX: 0.1, startY: 0.1, endX: 0.5, endY: 0.5, target_description: '把 report.doc 拖到删除区',
  }));
  assert.equal(blocked.status, 'ACTION_REQUIRED');
  assert.equal(blocked.state_anchor.reason, 'irreversible-action');
  assert.equal(drags, 0, '物理拖拽未派发');

  // 验证关闭（effect=null）⇒ 维持旧方言：派发即消费 + token_consumed_on_dispatch 锚点
  armOob();
  const pa = approval.request('drag report.doc onto the delete zone');
  grantOob(pa.token);
  const ok = JSON.parse(await (tool as Executable).execute({
    startX: 0.1, startY: 0.1, endX: 0.5, endY: 0.5, target_description: '拖到删除区', approval_token: pa.token,
  }));
  assert.equal(ok.status, 'SUCCESS');
  assert.equal(drags, 1);
  assert.equal(ok.state_anchor.approval_gate.token_consumed_on_dispatch, true, '验证缺席 ⇒ 旧方言锚点逐字节保持');
  assert.equal(ok.state_anchor.acceptance.verdict, 'unverified-dispatch-consumed');
  assert.equal(approval.validate(pa.token), false, '一次性令牌律：步终焚毁');
});

test('ΠΑΝ-13④: 预留-结算闭环 —— 在途互斥 / 派发异常释放令牌 / 同令牌重试恰一次', async () => {
  const tool = createDragMouseTool(dragCfg);
  armOob();
  const pa = approval.request('拖到删除区（闭环测试）');
  grantOob(pa.token);

  // ① 在途互斥：另一回合已持预留（并发双花窗口）⇒ 派发前结构化拒绝
  assert.equal(approval.beginAttempt(pa.token), true, '模拟另一在途回合占用预留');
  const inFlight = JSON.parse(await (tool as Executable).execute({
    startX: 0.1, startY: 0.1, endX: 0.5, endY: 0.5, target_description: '拖到删除区', approval_token: pa.token,
  }));
  assert.equal(inFlight.status, 'ACTION_REQUIRED');
  assert.equal(inFlight.state_anchor.reason, 'attempt-in-flight-or-budget-exhausted');
  assert.equal(drags, 0, '并发的第二回合在落到物理世界之前即被拒（恰一次派发）');
  assert.equal(approval.validate(pa.token), true, '互斥拒绝不烧令牌');
  approval.attemptFailed(pa.token, 'test-release'); // 释放模拟预留

  // ② 派发异常 ⇒ attemptFailed 结算（只释放预留不重复计数），令牌保留（B-3 语义）
  system.dragMouse = async () => { throw new Error('io exploded'); };
  const failed = await (tool as Executable).execute({
    startX: 0.1, startY: 0.1, endX: 0.5, endY: 0.5, target_description: '拖到删除区', approval_token: pa.token,
  });
  assert.match(failed, /^\[Error\]: Drag operation failed/, '异常方言逐字节保持');
  assert.equal(approval.validate(pa.token), true, '异常回合令牌保留供同授权内重试');
  system.dragMouse = async () => { drags++; };

  // ③ 同令牌重试 ⇒ 派发成功 + 步终焚毁（闭环收口）
  const retry = JSON.parse(await (tool as Executable).execute({
    startX: 0.1, startY: 0.1, endX: 0.5, endY: 0.5, target_description: '拖到删除区', approval_token: pa.token,
  }));
  assert.equal(retry.status, 'SUCCESS');
  assert.equal(drags, 1, '重试恰一次物理派发');
  assert.equal(approval.validate(pa.token), false, '重试成功后令牌焚毁');
});

test('ΠΑΝ-13⑤: 拖进敏感面 ⇒ 终点焦点标敏感（后续粘贴面热键被拦 —— 侧门串联封堵）', async () => {
  const tool = createDragMouseTool(dragCfg);
  // 「拖进密码框」不是危险词（不拦拖拽），但终点焦点必须带敏感旗
  const out = JSON.parse(await (tool as Executable).execute({
    startX: 0.2, startY: 0.2, endX: 0.4, endY: 0.4, target_description: '拖动句柄到 密码 输入框内',
  }));
  assert.equal(out.status, 'SUCCESS');
  assert.equal(focusTracker.isSensitive(60_000), true, '终点焦点已标敏感（L12 收口）');
  // 串联执法：随后在敏感焦点上 ctrl+v ⇒ 被键盘闸门拦截
  const hot = createPressHotkeyTool(hotkeyCfg);
  const paste = JSON.parse(await (hot as Executable).execute({ keys: ['ctrl', 'v'] }));
  assert.equal(paste.status, 'ACTION_REQUIRED');
  assert.equal(paste.state_anchor.reason, 'sensitive-input');
  assert.equal(presses, 0, '粘贴未派发');
});

test('ΠΑΝ-13⑥: dragMouse 公证接线 —— 落点 OCR 实读危险 ⇒ ACTION_REQUIRED（notarization 锚在场）', async () => {
  const lockCfg = { ...dragCfg, enableNotarizationLock: true, enableOcr: true } as unknown as Config;
  const tool = createDragMouseTool(lockCfg);
  // 注入假 OCR 取证（notaryEvidence 是可注入缝 —— 生产经同一函数引用转发）
  const origRead = notaryEvidence.readOcrLabel;
  let ocrCalls = 0;
  notaryEvidence.readOcrLabel = async () => { ocrCalls++; return '删除 回收站区域'; };
  try {
    const blocked = JSON.parse(await (tool as Executable).execute({
      startX: 0.1, startY: 0.1, endX: 0.5, endY: 0.5, target_description: '移动文件到文件夹',
    }));
    assert.equal(blocked.status, 'ACTION_REQUIRED');
    assert.equal(blocked.state_anchor.reason, 'irreversible-action');
    assert.equal(blocked.state_anchor.danger_signal, 'ocr_label', '危险来自落点屏幕实读');
    assert.equal(blocked.state_anchor.notarization.verdict, 'engaged');
    assert.equal(ocrCalls, 1, '落点取证恰一次');
    assert.equal(drags, 0, '物理拖拽未派发');
  } finally {
    notaryEvidence.readOcrLabel = origRead;
  }
});

// ═══ ΠΑΝ-12：pressHotkey 工具面 ═══

test('ΠΑΝ-12④: press_hotkey 工具面 —— enter 危险上下文被拦；持令牌放行且随派发消费', async () => {
  const tool = createPressHotkeyTool(hotkeyCfg);
  const blocked = JSON.parse(await (tool as Executable).execute({
    keys: ['enter'], context_description: '确认删除订单对话框的默认按钮',
  }));
  assert.equal(blocked.status, 'ACTION_REQUIRED');
  assert.equal(blocked.state_anchor.reason, 'irreversible-action');
  assert.equal(presses, 0, '物理键击未派发');

  armOob();
  const pa = approval.request('enter 确认删除订单');
  grantOob(pa.token);
  const ok = JSON.parse(await (tool as Executable).execute({
    keys: ['enter'], context_description: '确认删除订单', approval_token: pa.token,
  }));
  assert.equal(ok.status, 'SUCCESS');
  assert.equal(presses, 1);
  assert.equal(approval.validate(pa.token), false, '一次性令牌律：危险热键派发即消费');
});

test('ΠΑΝ-12⑤: press_hotkey 工具面 —— 黑名单和弦前置结构化拒绝（config 在场语境）；良性热键零回归', async () => {
  const tool = createPressHotkeyTool(hotkeyCfg);
  const blocked = JSON.parse(await (tool as Executable).execute({ keys: ['alt', 'f4'] }));
  assert.equal(blocked.status, 'ACTION_REQUIRED');
  assert.equal(blocked.state_anchor.reason, 'blacklisted-hotkey');
  assert.equal(presses, 0);

  // 良性热键（config 在场）照常派发 —— 回归
  const ok = JSON.parse(await (tool as Executable).execute({ keys: ['ctrl', 'c'] }));
  assert.equal(ok.status, 'SUCCESS');
  assert.equal(presses, 1);

  // 零参装配（无 config）保持完全旧路径 —— 良性派发照常
  const bare = createPressHotkeyTool();
  const bareOk = JSON.parse(await (bare as Executable).execute({ keys: ['ctrl', 'shift', 'tab'] }));
  assert.equal(bareOk.status, 'SUCCESS');
  assert.equal(presses, 2);
});

// ═══ 判定形状辅助（本册用 ActionGateDecision 类型锚） ═══

test('ΠΑΝ-12⑥: 决策类型锚 —— 全部新拒因入 ActionGateReason 值域（编译期已锚，此处钉行为）', () => {
  const cases: Array<[ActionKind, Record<string, unknown>, ActionGateDecision]> = [
    ['press_hotkey', { keys: ['alt', 'f4'] }, assertActionAllowed('press_hotkey', { keys: ['alt', 'f4'] }, hotkeyCfg)],
    ['press_hotkey', { keys: ['enter'], context_description: '删除' }, assertActionAllowed('press_hotkey', { keys: ['enter'], context_description: '删除' }, hotkeyCfg)],
    ['press_hotkey', { keys: ['ctrl', 'v'] }, assertActionAllowed('press_hotkey', { keys: ['ctrl', 'v'] }, hotkeyCfg)],
  ];
  focusTracker.set(0.5, 0.5, true); // 供 ctrl+v 臂
  const reasons = new Set(cases.map(c => c[2].reason));
  assert.ok(reasons.has('blacklisted-hotkey'));
  assert.ok(reasons.has('irreversible-action'));
  assert.ok(assertActionAllowed('press_hotkey', { keys: ['ctrl', 'v'] }, hotkeyCfg).reason === 'sensitive-input');
  focusTracker.clear();
});
