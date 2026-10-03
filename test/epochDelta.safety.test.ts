// test/epochDelta.safety.test.ts
// Δ 纪元（全库跃迁）安全核心执法：
//   审计#1（高危）：重放/技能执行（replayOne：replay_actions / run_skill /
//                   orchestrator 技能回退）直调 system 层，绕过工具层的审批与
//                   风险闸门 —— 修复后与 live 工具共用 actionGate.assertActionAllowed。
//   审计#2（高危）：clickMouse 的 validate（只查不烧）与验收式消费
//                   （consume/attemptFailed）之间的双花窗口 —— 修复后派发前经
//                   approval.beginAttempt 原子预留（attempts +1、在途互斥、
//                   超限焚毁），单次点击全链路 attempts 恰 +1。
import { test, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Config } from '../src/config.ts';
import { stopBackend } from '../src/physicalBackend.ts';
import { system } from '../src/system.ts';
import { approval, resetApproval } from '../src/approval.ts';
import { journal } from '../src/journal.ts';
import { skillLibrary } from '../src/skillLibrary.ts';
import { createClickMouseTool } from '../src/tools/clickMouse.ts';
import { createTypeTextTool } from '../src/tools/typeText.ts';
import { createReplayActionsTool, replayOne } from '../src/tools/replayActions.ts';
import { createRunSkillTool } from '../src/tools/skillTools.ts';
import { SAFETY_GATE_BLOCK } from '../src/tools/actionGate.ts';

// ─── 假 system：物理派发计数器（拦截断言的事实源）───

const originals = {
  getScreenSize: system.getScreenSize.bind(system),
  clickMouse: system.clickMouse.bind(system),
  typeText: system.typeText.bind(system),
};
let clicks = 0;
let typed = 0;
let sizeCalls = 0;

function installFakeSystem(): void {
  clicks = typed = sizeCalls = 0;
  system.getScreenSize = async () => { sizeCalls++; return { width: 1920, height: 1080 }; };
  system.clickMouse = async () => { clicks++; };
  system.typeText = async () => { typed++; };
}

beforeEach(() => {
  resetApproval();
  journal.reset();
  skillLibrary.reset();
  installFakeSystem();
});

afterEach(() => {
  system.getScreenSize = originals.getScreenSize;
  system.clickMouse = originals.clickMouse;
  system.typeText = originals.typeText;
});

// run_skill 的 Y-7 终态指纹走 captureProcessed ⇒ 懒拉起 D-5 物理服务（生产设计：
// 服务存活到插件卸载）。测试进程没有卸载钩子 —— 不显式关停则子进程占住事件循环，
// node --test 永不退出（与 src/index.ts 卸载序同律：物理微服务优雅关停）
after(async () => {
  await stopBackend();
});

/** click 工具测试配置：验证/探针/OCR 全关（聚焦闸门与预留时序，不碰 D-5 后端） */
const clickCfg = {
  enableApprovalGate: true,
  dangerPatterns: 'send,发送,delete,删除,pay,支付',
  enableRiskGate: true,
  riskPatterns: '',
  maxTextLength: 1000,
  focusMaxAgeMs: 60_000,
  verifyActions: false,
  dryRun: false,
  enableInteractivityProbe: false,
  intentVerify: false,
  enableOcr: false,
  autoRemember: false,
  adaptiveSettle: false,
  actionSettleMs: 1,
  noopSimilarityThreshold: 0.97,
  regionVerifyRadius: 0.15,
  physicsRules: '',
  replayMaxSteps: 100,
  enableJournal: true,
} as unknown as Config;

type Executable = { execute: (a: unknown) => Promise<string> };

async function runJson(tool: unknown, args: unknown): Promise<any> {
  const out = await (tool as Executable).execute(args);
  return JSON.parse(out);
}

// ─── ① 审计#1：危险步重放被拦截（假 system 计数 = 0）───

test('Δ-1: journal 危险步（发送/支付）重放被前置拦截 —— 物理派发计数 = 0', async () => {
  const cfg = { enableApprovalGate: true, dangerPatterns: 'send,发送,pay,支付' };
  // 无令牌：irreversible-action
  const clickLine = await replayOne(
    { tool: 'click_mouse', args: { x: 0.5, y: 0.5, target_description: '发送按钮' } }, cfg);
  assert.match(clickLine, /^FAILED:/, '走 replayActions 现有失败形态');
  assert.ok(clickLine.includes(SAFETY_GATE_BLOCK), '携带稳定拦截标记');
  assert.match(clickLine, /重放被安全闸门拦截/, '锚点写明拦截事实');
  assert.ok(clickLine.includes('irreversible-action'), '拒绝归因正确');
  assert.equal(clicks, 0, '物理点击未派发');
  assert.equal(sizeCalls, 0, '闸门前置：连屏幕尺寸都未读');
  // 伪造/未授予令牌：token-not-granted-or-expired（与工具层同律）
  const payLine = await replayOne(
    { tool: 'click_mouse', args: { x: 0.5, y: 0.5, target_description: '支付 now', approval_token: 'APR-FAKE' } }, cfg);
  assert.ok(payLine.includes('token-not-granted-or-expired'));
  assert.equal(clicks, 0);
  // J-14 跨通道法则在重放层同样生效：expected_text 第二信号通道
  const viaText = await replayOne(
    { tool: 'click_mouse', args: { x: 0.5, y: 0.5, target_description: '按钮', expected_text: '发送成功' } }, cfg);
  assert.ok(viaText.includes(SAFETY_GATE_BLOCK));
  assert.equal(clicks, 0);
});

test('Δ-1b: 凭据输入重放被拦截（风险闸门不豁免重放通道）', async () => {
  const line = await replayOne(
    { tool: 'type_text', args: { text: 'my password is hunter2' } },
    { enableRiskGate: true, riskPatterns: '' });
  assert.match(line, /^FAILED:/);
  assert.ok(line.includes(SAFETY_GATE_BLOCK));
  assert.ok(line.includes('sensitive-input'));
  assert.equal(typed, 0, '物理键入未派发');
  // 超长文本（前哨长度防御同律）
  const long = await replayOne(
    { tool: 'type_text', args: { text: 'x'.repeat(1001) } }, { maxTextLength: 1000 });
  assert.ok(long.includes('text-too-long'));
  assert.equal(typed, 0);
});

test('Δ-1c: replay_actions 工具面 —— 危险步 fail-fast 中止，锚点声明安全闸门', async () => {
  await journal.append({
    ts: 1, tool: 'click_mouse',
    args: { x: 0.5, y: 0.5, target_description: '发送订单' }, status: 'SUCCESS',
  });
  const out = await runJson(createReplayActionsTool(clickCfg), { confirm: true });
  assert.equal(out.status, 'PARTIAL_FAILURE', 'fail-fast：宏中止（与 Y-6 死步即停同律）');
  assert.ok(String(out.state_anchor.gate).includes('pre-dispatch safety gate'), '锚点声明拦截闸门');
  assert.ok(out.execution_log.includes('重放被安全闸门拦截'));
  assert.equal(out.state_anchor.diverged_at_step, 0, '第 0 步即被拦截');
  assert.equal(clicks, 0);
});

test('Δ-1d: run_skill 技能含危险步 ⇒ 计为失败步、不派发', async () => {
  const skill = skillLibrary.induce('发送周报邮件', [
    { tool: 'click_mouse', args: { x: 0.5, y: 0.5, target_description: '发送按钮' } },
  ]);
  assert.ok(skill, '技能铸成');
  const out = await runJson(createRunSkillTool(clickCfg), { id: skill.id, confirm: true });
  assert.equal(out.status, 'PARTIAL_FAILURE');
  assert.equal(out.state_anchor.steps_failed, 1, 'FAILED 前缀计入失败步（现有形态）');
  assert.ok(out.execution_log.includes('重放被安全闸门拦截'));
  assert.equal(clicks, 0);
});

// ─── ② 回归：无危险词重放照常 ───

test('Δ-2: 无危险词/非敏感步重放照常执行（回归）', async () => {
  const line1 = await replayOne(
    { tool: 'click_mouse', args: { x: 0.25, y: 0.25, target_description: '菜单按钮' } },
    { enableApprovalGate: true, dangerPatterns: 'send,发送' });
  assert.equal(line1, 'clicked', '安全点击照常派发');
  assert.equal(clicks, 1);
  const line2 = await replayOne({ tool: 'type_text', args: { text: 'hello world' } }, {});
  assert.equal(line2, 'typed', '普通文本照常键入');
  assert.equal(typed, 1);
  // replay_actions 工具面完整回归：安全步走完即 SUCCESS（Y-6 门控不受扰）
  await journal.append({
    ts: 2, tool: 'click_mouse',
    args: { x: 0.25, y: 0.25, target_description: '菜单按钮' }, status: 'SUCCESS',
  });
  const out = await runJson(createReplayActionsTool(clickCfg), { confirm: true });
  assert.equal(out.status, 'SUCCESS');
  assert.equal(out.state_anchor.replayed_steps, 1);
  assert.equal(clicks, 2, '日志步真实派发');
});

// ─── ③ 审计#2：并发双 click 同令牌恰一次派发 ───

test('Δ-3: 并发双 click 同令牌恰一次派发（双花窗口闭合）', async () => {
  const tool = createClickMouseTool(clickCfg);
  const pa = approval.request('click 发送 to submit the report');
  assert.equal(approval.grant(pa.token, true), true);

  // 同步路障：两个 execute 都已通过 validate（只查不烧）、都在等待屏幕尺寸 ——
  // 精确复刻审计#2 的窗口（validate 与派发之间的多个 await）
  let release!: (s: { width: number; height: number }) => void;
  const barrier = new Promise<{ width: number; height: number }>(r => { release = r; });
  let barrierCalls = 0;
  system.getScreenSize = async () => { barrierCalls++; return barrier; };

  const args = { x: 0.5, y: 0.5, target_description: '发送', approval_token: pa.token };
  const p1 = (tool as Executable).execute(args);
  const p2 = (tool as Executable).execute(args);
  for (let i = 0; i < 50; i++) await Promise.resolve(); // 双双抵达路障
  assert.equal(barrierCalls, 2, '两个并发回合都已越过 validate（旧实现在此双花）');
  release({ width: 1920, height: 1080 });

  const [r1, r2] = await Promise.all([p1, p2]);
  const a1 = JSON.parse(r1);
  const a2 = JSON.parse(r2);
  assert.equal(clicks, 1, '物理点击恰派发一次');
  const statuses = [a1.status, a2.status].sort();
  assert.deepEqual(statuses, ['ACTION_REQUIRED', 'SUCCESS'], '一个回合派发成功，另一回合被拒');
  const denied = a1.status === 'ACTION_REQUIRED' ? a1 : a2;
  assert.equal(denied.state_anchor.reason, 'attempt-in-flight-or-budget-exhausted');
  const ok = a1.status === 'SUCCESS' ? a1 : a2;
  assert.equal(
    ok.state_anchor.acceptance.verdict, 'unverified-dispatch-consumed',
    'V 纪元方言保持：验证关闭 ⇒ 派发即消费',
  );
  assert.equal(approval.validate(pa.token), false, '兑现后令牌焚毁（用后即焚不变）');
});

// ─── ④ 审计#2：令牌耗尽路径的 attempts 计数语义 ───

test('Δ-4a: 计数时序 —— beginAttempt 预留 + attemptFailed 结算，单次点击 attempts 恰 +1', () => {
  const pa = approval.request('click 支付', { maxAttempts: 2, ttlMs: 60_000 });
  approval.grant(pa.token, true);
  // 第 1 次点击：预留 +1 → 验收失败结算（不再 ++）
  assert.equal(approval.beginAttempt(pa.token), true);
  assert.equal(approval.status(pa.token).attempts, 1, '派发预留即计数');
  const r1 = approval.attemptFailed(pa.token, 'no-effect');
  assert.equal(r1.valid, true);
  assert.equal(approval.status(pa.token).attempts, 1, '全链路恰 +1（结算不重复计数）');
  assert.equal(r1.remainingAttempts, 1);
  // 第 2 次点击：在途互斥 ⇒ 并发预留被拒；结算后可再预留
  assert.equal(approval.beginAttempt(pa.token), true);
  assert.equal(approval.beginAttempt(pa.token), false, '在途回合未结算：并发预留被拒');
  approval.attemptFailed(pa.token, 'no-effect');
  assert.equal(approval.status(pa.token).attempts, 2, '第 2 次点击仍恰 +1');
  assert.equal(approval.status(pa.token).remainingAttempts, 0);
  // 第 3 次预留：attempts 将越过 maxAttempts=2 ⇒ 派发前焚毁
  assert.equal(approval.beginAttempt(pa.token), false, '预算耗尽在派发前执法');
  assert.equal(approval.validate(pa.token), false, '焚毁后不可再放行');
  assert.equal(approval.status(pa.token).present, false);
});

test('Δ-4b: 工具面在途预留拒绝 + 结算后同令牌重试（B-3 异常重试语义保持）', async () => {
  const tool = createClickMouseTool(clickCfg);
  const pa = approval.request('click 发送');
  approval.grant(pa.token, true);
  // 另一回合已持在途预留：本回合在派发前被拒（不双花）
  assert.equal(approval.beginAttempt(pa.token), true);
  const denied = await runJson(tool, { x: 0.5, y: 0.5, target_description: '发送', approval_token: pa.token });
  assert.equal(denied.status, 'ACTION_REQUIRED');
  assert.equal(denied.state_anchor.reason, 'attempt-in-flight-or-budget-exhausted');
  assert.equal(clicks, 0, '无预留不得派发');
  // 在途回合按验收失败结算：令牌保留（V 纪元：未生效尝试不消耗同意）
  approval.attemptFailed(pa.token, 'no-effect');
  assert.equal(approval.status(pa.token).attempts, 1, '被拒回合未派发 ⇒ 不计数；在途结算后 attempts=1');
  // 同令牌重试：预留 → 派发 → 验证关闭方言（派发即消费）→ 用后即焚
  const ok = await runJson(tool, { x: 0.5, y: 0.5, target_description: '发送', approval_token: pa.token });
  assert.equal(ok.status, 'SUCCESS');
  assert.equal(clicks, 1);
  assert.equal(ok.state_anchor.acceptance.verdict, 'unverified-dispatch-consumed');
  assert.equal(approval.status(pa.token).present, false, '派发即消费：令牌焚毁（用后即焚）');
  assert.equal(approval.validate(pa.token), false);
  // 焚毁后再试：审批域拒绝（与双花无关的老路径）
  const after = await runJson(tool, { x: 0.5, y: 0.5, target_description: '发送', approval_token: pa.token });
  assert.equal(after.status, 'ACTION_REQUIRED');
  assert.equal(after.state_anchor.reason, 'token-not-granted-or-expired');
  assert.equal(clicks, 1, '焚毁令牌不再派发');
});

// ─── 闸门抽取的语义等价性（live 工具面回归锚）───

test('Δ-5: click 闸门等价 —— J-14 跨通道 / 归因 / 闸门关闭豁免 / O 纪元 schema 必填', async () => {
  const tool = createClickMouseTool(clickCfg);
  // J-14：描述无害但 expected_text 携带危险语义 ⇒ 拦截并归因第二通道
  const out = await runJson(tool, {
    x: 0.5, y: 0.5, target_description: 'submit area', expected_text: '点击后出现 发送订单 确认',
  });
  assert.equal(out.status, 'ACTION_REQUIRED');
  assert.equal(out.state_anchor.danger_signal, 'expected_text', '归因到第二信号通道');
  assert.equal(out.state_anchor.reason, 'irreversible-action');
  assert.equal(clicks, 0);
  // 令牌在场但未授予：归因 token-not-granted-or-expired（请求≠同意）
  const out2 = await runJson(tool, { x: 0.5, y: 0.5, target_description: 'Send 按钮', approval_token: 'APR-FAKE' });
  assert.equal(out2.state_anchor.reason, 'token-not-granted-or-expired');
  // O 纪元（#18）：target_description schema 必填 —— 协议层硬前置不因抽取而弱化
  await assert.rejects(
    (tool as Executable).execute({ x: 0.5, y: 0.5 }),
    /missing required property "target_description"/,
  );
  // 非 schema 调用方（重放层）的 N 纪元运行时硬前置：双通道全沉默 ⇒ 拒绝
  const legacy = await replayOne({ tool: 'click_mouse', args: { x: 0.5, y: 0.5 } }, { dangerPatterns: 'send' });
  assert.ok(legacy.includes('undescribed-click'), '审批闸门无法审判无名目标');
  // 闸门关闭 ⇒ 危险词不再拦截（语义只属审批域），且无需令牌即派发
  const off = createClickMouseTool({ ...clickCfg, enableApprovalGate: false });
  const out4 = await runJson(off, { x: 0.3, y: 0.3, target_description: 'Send' });
  assert.equal(out4.status, 'SUCCESS');
  assert.equal(out4.state_anchor.approval_gate, 'gate-disabled');
  assert.equal(clicks, 1);
});

test('Δ-6: type_text 闸门等价 —— 敏感文本拦截不回显 / 超长拒绝 / 正常放行', async () => {
  const tool = createTypeTextTool(clickCfg);
  const blocked = await runJson(tool, { text: '验证码 123456 请查收' });
  assert.equal(blocked.status, 'ACTION_REQUIRED');
  assert.equal(blocked.state_anchor.typed_content, '[REDACTED]', '绝不回显敏感内容');
  assert.equal(typed, 0);
  const tooLong = await (tool as Executable).execute({ text: 'x'.repeat(1001) });
  assert.match(tooLong, /^\[Error\]: Text too long\. Maximum length is 1000 characters\.$/);
  assert.equal(typed, 0);
  const ok = await runJson(tool, { text: 'hello world' });
  assert.equal(ok.status, 'SUCCESS');
  assert.equal(typed, 1);
});
