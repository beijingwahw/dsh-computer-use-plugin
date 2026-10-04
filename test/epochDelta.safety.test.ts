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
import { approval, resetApproval, setConfirmCodeChannel, type ConfirmCodeDelivery } from '../src/approval.ts';
import { journal } from '../src/journal.ts';
import { skillLibrary } from '../src/skillLibrary.ts';
import { setFreshnessPort, resetFreshnessProbe } from '../src/popupDetector.ts';
import { createClickMouseTool } from '../src/tools/clickMouse.ts';
import { createTypeTextTool } from '../src/tools/typeText.ts';
// ΝΩ-5：replayOneTraced 的预留结算面（步终世界判决 → consume/attemptFailed）
import { createReplayActionsTool, replayOne, settleReservedApproval } from '../src/tools/replayActions.ts';
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

/** W6R fail-closed：带外码采集 + 携码授予（无码 grant 已废除 —— 授予面一律走此助手）。
 *  armOob 在每次 request 前调用（码在铸造时刻投递）；多令牌按 token 对号。 */
const oobSink: ConfirmCodeDelivery[] = [];
function armOob(): void {
  setConfirmCodeChannel(d => { oobSink.push({ ...d }); });
}
function grantOob(token: string): boolean {
  const hit = oobSink.find(d => d.token === token);
  return approval.grantDetailed(token, true, hit ? { confirmCode: hit.confirmCode } : {}).ok;
}

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

/** click 工具测试配置：验证/探针/OCR 全关（聚焦闸门与预留时序，不碰 D-5 后端）。
 *  W6R：verifyActions=false 已不再单独构成「危险令牌派发即消费」的旁路 —— 本册
 *  聚焦双花窗口/计数时序，显式插入逃生门（allowUnverifiedDangerous=true 两把
 *  钥匙齐备）以保持旧方言；双钥匙执法的新回归见文末 W6R 组。 */
const clickCfg = {
  enableApprovalGate: true,
  dangerPatterns: 'send,发送,delete,删除,pay,支付',
  enableRiskGate: true,
  riskPatterns: '',
  maxTextLength: 1000,
  focusMaxAgeMs: 60_000,
  verifyActions: false,
  allowUnverifiedDangerous: true,
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
  armOob(); // W6R：授予须带外码
  const pa = approval.request('click 发送 to submit the report');
  assert.equal(grantOob(pa.token), true);

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
  armOob(); // W6R：授予须带外码
  const pa = approval.request('click 支付', { maxAttempts: 2, ttlMs: 60_000 });
  grantOob(pa.token);
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
  armOob(); // W6R：授予须带外码
  const pa = approval.request('click 发送');
  grantOob(pa.token);
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

// ─── ⑤ W6R（安全收口）：验证总开关旁路 + 探针 fail-open 的双重逃生门执法 ───

test('W6R-A: verifyActions=false 单独关闭 ⇒ 危险令牌派发被拒（双钥匙：还须 allowUnverifiedDangerous=true）', async () => {
  // 新鲜度探针 fresh（越过探针 fail-closed，聚焦验证旁路执法本身）
  setFreshnessPort({ groundingHash: () => 'a'.repeat(64), captureCurrentHash: async () => 'a'.repeat(64) });
  try {
    const tool = createClickMouseTool({ ...clickCfg, allowUnverifiedDangerous: false });
    armOob(); // W6R：授予须带外码
    const pa = approval.request('click 发送');
    assert.equal(grantOob(pa.token), true);
    const out = await runJson(tool, { x: 0.5, y: 0.5, target_description: '发送', approval_token: pa.token });
    assert.equal(out.status, 'ACTION_REQUIRED', '验证不可用 ⇒ 拒绝派发（不再静默走派发即焚）');
    assert.equal(out.state_anchor.reason, 'effect-verification-required');
    assert.match(out.next_step, /verifyActions=true/, '出路一：重开验证');
    assert.match(out.next_step, /allowUnverifiedDangerous=true/, '出路二：显式逃生门');
    assert.equal(clicks, 0, '物理零派发');
    assert.equal(approval.validate(pa.token), true, '令牌未烧（阻断在预留之前）');
    assert.equal(approval.status(pa.token).attempts, 0);
    // 非 dangerous 动作不受双钥匙约束：verifyActions=false 的原语义（benign 验证可关）保持
    const benign = await runJson(tool, { x: 0.3, y: 0.3, target_description: '菜单按钮' });
    assert.equal(benign.status, 'SUCCESS', 'benign 动作照常派发（无误杀）');
    assert.equal(benign.state_anchor.effect, 'verification-off', '非令牌动作维持 verifyActions 原语义');
    assert.equal(clicks, 1);
  } finally {
    resetFreshnessProbe();
  }
});

test('W6R-B: 新鲜度探针缺席 ⇒ 危险令牌派发被拒（fail-closed）；逃生门 ⇒ 恢复旧方言 + degraded 观测', async () => {
  resetFreshnessProbe(); // 端口缺席（默认态：组合根接线前/离线测试）
  const tool = createClickMouseTool({ ...clickCfg, allowUnverifiedDangerous: false });
  armOob();
  const pa = approval.request('click 支付');
  assert.equal(grantOob(pa.token), true);
  const out = await runJson(tool, { x: 0.5, y: 0.5, target_description: '支付', approval_token: pa.token });
  assert.equal(out.status, 'ACTION_REQUIRED', '探针缺席 ⇒ 拒绝派发（fail-closed，不再降级放行）');
  assert.equal(out.state_anchor.reason, 'freshness-probe-unavailable');
  assert.equal(out.state_anchor.freshness_probe.note, 'probe-port-absent', '缺席原因如实随锚点');
  assert.match(out.next_step, /RETRY/, '出路一：重试（先 take_screenshot 铸接地指纹）');
  assert.match(out.next_step, /allowUnverifiedDangerous=true/, '出路三：显式逃生门');
  assert.equal(clicks, 0, '物理零派发');
  assert.equal(approval.validate(pa.token), true, '令牌未烧');
  assert.ok(
    journal.list(false).some(e => e.tool === 'GUARD_BLOCKED' && e.args?.guard === 'freshness-probe'
      && String(e.args?.reason).includes('probe-unavailable')),
    'fail-closed 拦截以 GUARD 方言入防篡改链',
  );

  // 逃生门（两把钥匙齐备）：探针缺席恢复 degraded 放行 + 验证旁路旧方言（派发即消费）
  const escaped = createClickMouseTool(clickCfg); // allowUnverifiedDangerous: true
  const ok = await runJson(escaped, { x: 0.5, y: 0.5, target_description: '支付', approval_token: pa.token });
  assert.equal(ok.status, 'SUCCESS', '逃生门 ⇒ 探针缺席降级放行（旧行为）');
  assert.equal(clicks, 1);
  assert.equal(ok.state_anchor.freshness.verdict, 'degraded', '降级不静默 —— 锚点观测');
  assert.equal(ok.state_anchor.acceptance.verdict, 'unverified-dispatch-consumed', '旧方言：派发即消费');
  assert.equal(approval.validate(pa.token), false, '用后即焚');
});

// ─── ⑥ ΝΩ-5：审批协议执行侧对齐 —— replayOne 预留-结算闭环 + run_skill 令牌通道 ───

test('ΝΩ-5-E: replay_actions 危险步成功 ⇒ 步终 consume 验收式（令牌不再永久 in-flight）', async () => {
  armOob(); // W6R：授予须带外码
  const pa = approval.request('重放：点击 发送订单 提交');
  assert.equal(grantOob(pa.token), true);
  await journal.append({
    ts: 1, tool: 'click_mouse',
    args: { x: 0.5, y: 0.5, target_description: '发送订单', approval_token: pa.token }, status: 'SUCCESS',
  });
  const out = await runJson(createReplayActionsTool(clickCfg), { confirm: true });
  assert.equal(out.status, 'SUCCESS', '危险步带有效令牌重放照常执行');
  assert.ok(String(out.state_anchor.detail).includes('clicked'), '步回执为动作方言');
  assert.equal(clicks, 1, '物理派发恰一次');
  // 旧缺陷（审批悬账）：beginAttempt 预留后无人结算 ⇒ 令牌永久 in-flight，
  // 同令牌重放被在途互斥结构性拒绝。新法：成功 ⇒ consume（世界已承接效果）。
  assert.equal(approval.validate(pa.token), false, '步终 consume：令牌焚毁（一次同意一次世界验证）');
  assert.equal(approval.status(pa.token).present, false);
});

test('ΝΩ-5-F: replay_actions 危险步派发异常 ⇒ FAILED 步结算 attemptFailed（令牌保留可重试，预留不悬账）', async () => {
  armOob();
  const pa = approval.request('重放：点击 支付 now');
  assert.equal(grantOob(pa.token), true);
  await journal.append({
    ts: 2, tool: 'click_mouse',
    args: { x: 0.5, y: 0.5, target_description: '支付 now', approval_token: pa.token }, status: 'SUCCESS',
  });
  system.clickMouse = async () => { clicks++; throw new Error('dispatch boom'); };
  const out = await runJson(createReplayActionsTool(clickCfg), { confirm: true });
  assert.equal(out.status, 'PARTIAL_FAILURE', '派发失败即停（fail-fast 保持）');
  assert.equal(out.state_anchor.gate, 'step dispatch failure (system-layer exception) — 该步未执行即失败');
  // 异常结算：attemptFailed 释放预留 + 计数恰 +1，令牌保留（B-3 异常重试语义）
  assert.equal(approval.validate(pa.token), true, '令牌保留（未生效尝试不消耗同意）');
  assert.equal(approval.status(pa.token).attempts, 1, '预留 + 结算恰 +1（不重复计数）');
  assert.equal(approval.beginAttempt(pa.token), true, '预留已释放 —— 同令牌可再预留（不悬账）');
  settleReservedApproval(pa.token, true, 'test-teardown'); // 归还簿记语义
});

test('ΝΩ-5-G: settleReservedApproval 世界判决两臂 —— 死步/失败 ⇒ attemptFailed 续期；成功 ⇒ consume', async () => {
  armOob();
  const pa = approval.request('结算单元：删除全部');
  assert.equal(grantOob(pa.token), true);
  // 死步臂（dead-step / FAILED 共用 failed=true）：预留 → 结算 ⇒ 续期
  assert.equal(approval.beginAttempt(pa.token), true);
  settleReservedApproval(pa.token, true, 'dead-step');
  assert.equal(approval.validate(pa.token), true, '死步 ⇒ 令牌保留');
  assert.equal(approval.status(pa.token).attempts, 1, '恰 +1');
  // 成功臂：预留 → 结算 ⇒ consume 焚毁
  assert.equal(approval.beginAttempt(pa.token), true);
  settleReservedApproval(pa.token, false, 'replay-step-verified');
  assert.equal(approval.validate(pa.token), false, '成功 ⇒ 验收式消费（焚毁）');
  // 无预留 ⇒ no-op（绝不抛）
  settleReservedApproval(undefined, true, 'no-op');
});

test('ΝΩ-5-H: replayOne 字符串方言面（index.ts 宏派发接线）就地结算 —— 预留不悬账', async () => {
  armOob();
  const pa = approval.request('宏派发：发送周报');
  assert.equal(grantOob(pa.token), true);
  const line = await replayOne(
    { tool: 'click_mouse', args: { x: 0.5, y: 0.5, target_description: '发送周报', approval_token: pa.token } },
    clickCfg);
  assert.equal(line, 'clicked');
  assert.equal(approval.validate(pa.token), false, '字符串面无步终观测 ⇒ 包装层就地 consume（保守近似）');
  // 失败臂：派发异常 ⇒ 包装层 attemptFailed（令牌保留）
  armOob();
  const pb = approval.request('宏派发失败臂：支付');
  assert.equal(grantOob(pb.token), true);
  system.clickMouse = async () => { clicks++; throw new Error('boom'); };
  const failed = await replayOne(
    { tool: 'click_mouse', args: { x: 0.5, y: 0.5, target_description: '支付', approval_token: pb.token } },
    clickCfg);
  assert.match(failed, /^FAILED:/);
  assert.equal(approval.validate(pb.token), true, '失败 ⇒ attemptFailed 续期（不悬账、不焚毁）');
});

test('ΝΩ-5-I: run_skill 带新令牌跑危险步成功（旧令牌覆盖）；无令牌 ⇒ 诚实拒绝', async () => {
  // 技能录制时携带旧令牌（一次性 + TTL ⇒ 重放时刻必失效 —— 旧缺陷：结构性永远失败）
  const skill = skillLibrary.induce('发送订单流程', [
    { tool: 'click_mouse', args: { x: 0.5, y: 0.5, target_description: '发送订单', approval_token: 'APR-STALE-RECORDED' } },
  ]);
  assert.ok(skill, '技能铸成');
  // ① 无 approval_token 参数：steps 里的旧令牌必失效 ⇒ 危险步诚实拒绝、零派发
  const denied = await runJson(createRunSkillTool(clickCfg), { id: skill.id, confirm: true });
  assert.equal(denied.status, 'PARTIAL_FAILURE');
  assert.equal(denied.state_anchor.steps_failed, 1);
  assert.ok(denied.execution_log.includes('token-not-granted-or-expired'), '拒绝归因：旧令牌失效');
  assert.equal(clicks, 0, '诚实拒绝：物理零派发');
  // ② 带新铸已授予令牌：覆盖危险步令牌槽 ⇒ 过闸派发 + 步终 consume
  armOob();
  const pa = approval.request('重放技能「发送订单流程」的危险步');
  assert.equal(grantOob(pa.token), true);
  const ok = await runJson(createRunSkillTool(clickCfg), { id: skill.id, confirm: true, approval_token: pa.token });
  assert.equal(ok.state_anchor.steps_failed, 0, '危险步带新令牌照常执行');
  assert.ok(ok.execution_log.includes('clicked'), '步回执为动作方言');
  assert.equal(clicks, 1);
  assert.equal(approval.validate(pa.token), false, '步终 consume：新令牌验收式焚毁（不悬账）');
});
