// test/r51.recoveryChord.test.ts
// R5-1 回归执法册（两件修复的钉子）：
//   ① 恢复键误撞不可逆闸校正（actionGate.isRecoveryChord + judgeHotkeyFace ③ 豁免）
//      —— AGON 批2 T8 双败实证（hist seq279）：press_hotkey delete 的
//      context_description 自述「删除选中内容」命中 dangerPatterns ⇒ 被
//      irreversible-action 拦截；ctrl+z 自述含「清空/删除」同拦。修复：撤销/重做
//      和弦与裸编辑删除键是「制造可逆性」的动作，不进 ③ 危险上下文分类
//      （① 黑名单与 ② 敏感粘贴面前置且不受影响；enter 激活危险默认钮主通道保持）。
//   ② 无人值守审批止损（driveCore.approvalFold / approvalDeadlockDecision）
//      —— 审批请求（ACTION_REQUIRED / PENDING_USER_CONSENT）N ms 无应答 ⇒
//      驱动器 cancel 止损（R4-1 修复建议 C 驱动器侧落地）。
// 纯函数面：零 IO / 零网络 / 零时钟（时间由调用方注入）。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertActionAllowed, isRecoveryChord,
} from '../src/tools/actionGate.ts';
import type { Config } from '../src/config.ts';

const load = (p: string): Promise<any> => import(p);
const benchUrl = (f: string): string => new URL(`../bench/${f}`, import.meta.url).href;
const drive = await load(benchUrl('driveCore.mjs'));

// 与 pan1213 同款 hotkey 判定配置（含 delete/删除 危险词 + 系统黑名单）
const HOTKEY_BL = 'alt+f4,meta,meta+l,meta+r,meta+d,win,cmd+q,ctrl+alt+delete,ctrl+shift+esc,alt+space';
const hotkeyCfg = {
  enableApprovalGate: true,
  dangerPatterns: 'send,发送,delete,删除,remove,移除,pay,支付,清空,reset,重置',
  enableRiskGate: true,
  riskPatterns: '',
  maxTextLength: 1000,
  focusMaxAgeMs: 60_000,
  hotkeyBlacklist: HOTKEY_BL,
} as unknown as Config;

// ═══ ① 恢复键和弦豁免 ═══

test('R5-1a: isRecoveryChord —— undo/redo 族与裸编辑删除键为真；其余为假', () => {
  // undo/redo 家族（ctrl 家族修饰 ± shift）
  for (const chord of [['ctrl', 'z'], ['z', 'ctrl'], ['ctrl', 'shift', 'z'], ['ctrl', 'y'], ['cmd', 'z'], ['cmd', 'shift', 'z'], ['meta', 'y']]) {
    assert.equal(isRecoveryChord(chord as string[]), true, `${chord.join('+')} ⇒ 恢复和弦`);
  }
  // 裸编辑删除键（编辑器撤销栈可补偿；Explorer 裸 delete 进回收站）
  assert.equal(isRecoveryChord(['delete']), true);
  assert.equal(isRecoveryChord(['backspace']), true);
  // 非豁免面
  assert.equal(isRecoveryChord(['shift', 'delete']), false, 'shift+delete=永久删除,不豁免');
  assert.equal(isRecoveryChord(['ctrl', 'alt', 'z']), false, 'alt 在场 ⇒ 应用层宏语义不可枚举,保守旧路径');
  assert.equal(isRecoveryChord(['enter']), false, '激活键永不豁免(ΠΑΝ-12③ 主通道)');
  assert.equal(isRecoveryChord(['z']), false, '裸字母 z 非恢复和弦');
  assert.equal(isRecoveryChord(['ctrl']), false, '纯修饰键长按无恢复语义');
  assert.equal(isRecoveryChord(['ctrl', 'a']), false);
  assert.equal(isRecoveryChord([]), false);
  // 归一化防御：大小写/空白/脏值
  assert.equal(isRecoveryChord(['Ctrl', ' Z ']), true);
  assert.equal(isRecoveryChord([undefined, 'ctrl', 'z'] as unknown as string[]), true);
});

test('R5-1b: T8 双败签名复刻 —— delete/ctrl+z 危险自述不再误撞不可逆闸', () => {
  // T8 hist seq279 的原样签名：keys=['delete']，context_description 含「删除选中内容」
  const d = assertActionAllowed('press_hotkey',
    { keys: ['delete'], context_description: '记事本第3行：删除选中内容' }, hotkeyCfg);
  assert.equal(d.allowed, true, '裸 delete = 编辑器文本键（撤销栈可补偿）—— 放行');
  assert.equal(d.dangerous, false);

  // ctrl+z 自述含「清空/删除」字样（R1 轮 seq163/168 实证形态）：撤销=最可逆动作
  const z = assertActionAllowed('press_hotkey',
    { keys: ['ctrl', 'z'], context_description: '撤销刚才的清空删除误操作' }, hotkeyCfg);
  assert.equal(z.allowed, true);
  assert.equal(z.dangerous, false);

  // redo 家族同律
  const redo = assertActionAllowed('press_hotkey',
    { keys: ['ctrl', 'shift', 'z'], context_description: '重做被撤销的删除' }, hotkeyCfg);
  assert.equal(redo.allowed, true);

  // backspace 裸键同律
  const bs = assertActionAllowed('press_hotkey',
    { keys: ['backspace'], context_description: '删除光标前一个字符' }, hotkeyCfg);
  assert.equal(bs.allowed, true);
});

test('R5-1c: 非豁免面零回归 —— 激活键/修饰删除键/alt 和弦的危险执法原样', () => {
  // enter 激活危险默认钮（ΠΑΝ-12③ 设计意图）保持拦截
  const enter = assertActionAllowed('press_hotkey',
    { keys: ['enter'], context_description: '确认删除订单对话框的默认按钮' }, hotkeyCfg);
  assert.equal(enter.allowed, false);
  assert.equal(enter.reason, 'irreversible-action');
  assert.equal(enter.dangerSignalChannel, 'context_description');

  // shift+delete（永久删除变体）带危险自述仍拦
  const perm = assertActionAllowed('press_hotkey',
    { keys: ['shift', 'delete'], context_description: '删除所选文件' }, hotkeyCfg);
  assert.equal(perm.allowed, false);
  assert.equal(perm.reason, 'irreversible-action');

  // ctrl+alt+z（alt 在场）不豁免 —— 危险自述照拦
  const altChord = assertActionAllowed('press_hotkey',
    { keys: ['ctrl', 'alt', 'z'], context_description: '删除全部' }, hotkeyCfg);
  assert.equal(altChord.allowed, false);
  assert.equal(altChord.reason, 'irreversible-action');

  // 黑名单前置不受豁免影响（ctrl+alt+delete 整体和弦）
  const cad = assertActionAllowed('press_hotkey', { keys: ['ctrl', 'alt', 'delete'] }, hotkeyCfg);
  assert.equal(cad.reason, 'blacklisted-hotkey');

  // 无害自述的 enter 照旧放行（回归）
  const benign = assertActionAllowed('press_hotkey', { keys: ['enter'], context_description: '搜索框' }, hotkeyCfg);
  assert.equal(benign.allowed, true);
});

// ═══ ② 无人值守审批止损（driveCore 纯函数） ═══

test('R5-1d: approvalFold —— 请求立起 pending、连环请求不重置时钟、grant/操作员消息解封', () => {
  const needle = '[评估纪律] 本任务是 computer-use 实战考核';
  // T8 形态：press_hotkey result 带 ACTION_REQUIRED → request_approval result 带 PENDING_USER_CONSENT
  const s1 = drive.approvalFold(drive.approvalWatchInit(), [
    { kind: 'call', seq: 51, name: 'press_hotkey' },
    { kind: 'result', seq: 52, text: '{"status":"ACTION_REQUIRED","state_anchor":{"reason":"irreversible-action"}}' },
  ], { promptNeedle: needle, nowMs: 1000 });
  assert.equal(s1.pendingSinceMs, 1000, '闸门拦截 ⇒ 立起 pending');
  assert.equal(s1.requests, 1);

  // 连环请求（request_approval 又 PENDING）不重置时钟
  const s2 = drive.approvalFold(s1, [
    { kind: 'call', seq: 53, name: 'request_approval' },
    { kind: 'result', seq: 54, text: '{"status":"PENDING_USER_CONSENT","state_anchor":{"token":"APR-X"}}' },
  ], { promptNeedle: needle, nowMs: 5000 });
  assert.equal(s2.pendingSinceMs, 1000, '最早未解请求起算（连环不续命）');
  assert.equal(s2.requests, 2);

  // grant_approval 的 result（任何结果）⇒ 解封；再发请求重新立起（时钟重启）
  const s3 = drive.approvalFold(s2, [
    { kind: 'call', seq: 55, name: 'grant_approval' },
    { kind: 'result', seq: 56, text: '{"error":"code-attempts-exhausted"}' },
  ], { promptNeedle: needle, nowMs: 6000 });
  assert.equal(s3.pendingSinceMs, null, 'grant 尝试 ⇒ 解封');
  assert.equal(s3.lastResolution, 'grant_approval');
  assert.equal(s3.responses, 1);
  const s4 = drive.approvalFold(s3, [
    { kind: 'call', seq: 57, name: 'request_approval' },
    { kind: 'result', seq: 58, text: '{"status":"PENDING_USER_CONSENT"}' },
  ], { promptNeedle: needle, nowMs: 9000 });
  assert.equal(s4.pendingSinceMs, 9000, '合法二次请求 ⇒ 时钟重启');

  // 操作员消息（非 prompt、非宿主机制注入）⇒ 解封（有人值守失活）
  const s5 = drive.approvalFold(s4, [
    { kind: 'user', seq: 59, text: '用户已亲自完成，继续' },
  ], { promptNeedle: needle, nowMs: 12000 });
  assert.equal(s5.pendingSinceMs, null);
  assert.equal(s5.lastResolution, 'operator-message');

  // 驱动 prompt 本体 / 宿主机制注入不视为操作员应答
  const s6 = drive.approvalFold(drive.approvalFold(drive.approvalWatchInit(), [
    { kind: 'result', seq: 61, text: 'ACTION_REQUIRED' },
  ], { promptNeedle: needle, nowMs: 100 }), [
    { kind: 'user', seq: 62, text: needle + '……' },
    { kind: 'user', seq: 63, text: 'current runtime context. …' },
    { kind: 'user', seq: 64, text: '<system-reminder>…' },
  ], { promptNeedle: needle, nowMs: 200 });
  assert.equal(s6.pendingSinceMs, 100, 'prompt 本体与宿主注入不解封');

  // 无审批标记的普通 result 不误立 pending
  const s7 = drive.approvalFold(drive.approvalWatchInit(), [
    { kind: 'call', seq: 71, name: 'take_screenshot' },
    { kind: 'result', seq: 72, text: '{"ok":true}' },
  ], { promptNeedle: needle, nowMs: 300 });
  assert.equal(s7.pendingSinceMs, null);
  assert.equal(s7.requests, 0);
});

test('R5-1e: approvalDeadlockDecision —— 0=关；无 pending 不触发；持续 ≥ 超时即 exceeded', () => {
  assert.equal(drive.approvalDeadlockDecision({ timeoutMs: 0, pendingSinceMs: 100, nowMs: 1e9 }).enabled, false, '0=关（缺省零回归）');
  for (const off of [-1, Number.NaN, Infinity]) {
    assert.equal(drive.approvalDeadlockDecision({ timeoutMs: off, pendingSinceMs: 100, nowMs: 1e9 }).enabled, false, `${off} ⇒ 关`);
  }
  const on = drive.approvalDeadlockDecision({ timeoutMs: 60000, pendingSinceMs: null, nowMs: 1e9 });
  assert.deepEqual({ enabled: on.enabled, exceeded: on.exceeded }, { enabled: true, exceeded: false }, '无 pending 不触发');
  const d59 = drive.approvalDeadlockDecision({ timeoutMs: 60000, pendingSinceMs: 0, nowMs: 59999 });
  assert.equal(d59.exceeded, false, '59.999s < 60s');
  const d60 = drive.approvalDeadlockDecision({ timeoutMs: 60000, pendingSinceMs: 0, nowMs: 60000 });
  assert.equal(d60.exceeded, true, '60s ≥ 60s ⇒ 止损');
  assert.equal(d60.pendingMs, 60000);
  // 扫描节拍常量钉死（与焦点保卫缺省同量级）
  assert.equal(drive.APPROVAL_SCAN_INTERVAL_MS, 9000);
});

test('R5-1f: 端到端语义 —— T8 双败时序在 60s 窗口内必触发止损', () => {
  const needle = '[评估纪律] 本任务';
  let s = drive.approvalWatchInit();
  // T8 第二轮抽象：编辑畸形 → delete 拦截（t=0s）→ 绕行（截图/尝试）→ 请求审批（t=30s）→ 无人应答
  const chunks: Array<[Array<{ kind: string; seq: number; name?: string; text?: string }>, number]> = [
    [[{ kind: 'call', seq: 1, name: 'press_hotkey' },
      { kind: 'result', seq: 2, text: 'ACTION_REQUIRED irreversible-action' }], 0],
    [[{ kind: 'call', seq: 3, name: 'take_screenshot' },
      { kind: 'result', seq: 4, text: '{"ok":true}' }], 9000],
    [[{ kind: 'call', seq: 5, name: 'request_approval' },
      { kind: 'result', seq: 6, text: 'PENDING_USER_CONSENT' }], 30000],
    [[{ kind: 'assistant', seq: 7, text: '等待用户回复确认码…' }], 45000],
    [[{ kind: 'assistant', seq: 8, text: '仍在等待' }], 61000],
  ];
  for (const [rows, now] of chunks) s = drive.approvalFold(s, rows, { promptNeedle: needle, nowMs: now });
  assert.equal(s.pendingSinceMs, 0, 'pending 自最早未解请求（连环请求不重置）');
  assert.equal(drive.approvalDeadlockDecision({ timeoutMs: 60000, pendingSinceMs: s.pendingSinceMs, nowMs: 61000 }).exceeded, true,
    't=61s ⇒ 超过 60s 窗口 ⇒ cancel 止损');
});
