// test/w1approval.test.ts
// W1-2（审批协议升级）执法测试：S2 带外人证确认码 + H1 批注式审批。
//
// S2 安全核心铁律：
//   · 码只经带外通道投给人类 —— 工具结果文本与模型可见数据结构中**绝无码**
//     （模型无法伪造「用户已同意」的人证）；
//   · CSPRNG 铸造（6 位十进制、zerosafe、拒绝采样无偏）；
//   · 恒定时间比较 —— 错码拒绝不泄露哪一位错（不同错码的失败输出逐字节同形）；
//   · 错误码区分「码错误」与「令牌无效」；错码尝试封顶焚毁（防暴力枚举）；
//   · W6R fail-closed：带外通道缺席/投递失败 ⇒ 令牌记 degraded 且 grant 一律
//     拒绝（reason='confirm-channel-absent'）—— 旧「无码降级 grant」是
//     fail-open（屏幕注入文本可驱动 request→grant→click 全链自批），已废除。
// H1 批注铁律：
//   · grant 可携 note ⇒ 结构化 amendment patch 铸入 PendingApproval
//     （目标描述差异 + 动作形状修正），执行侧读取 API 可消费；
//   · 示范事件增 amended 标注，批注内容随事件对蒸馏下游可见（最强负示范）。
// 全部用例离线确定性：码从带外 sink 采集（正是生产中人类的视角），
// 时钟不前拨、不依赖 CSPRNG 具体取值（只断言格式与行为）。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  approval, approvalBudget, resetApproval, setDemonstrationObserver, setConfirmCodeChannel,
  setDispatchEscrowHook, escrowBlockOf, approvalQueue, computeTargetDigest, targetRejectionOf,
  type DemonstrationEvent, type ConfirmCodeDelivery,
} from '../src/approval.ts';
import { skillLibrary } from '../src/skillLibrary.ts';
import {
  createRequestApprovalTool, createGrantApprovalTool,
} from '../src/tools/approvalTools.ts';
import {
  armOutOfBandConfirmChannel, wireDoctorVerdictChannel, APPROVAL_CONFIRM_CODE_EVENT,
} from '../src/doctorChannel.ts';
import type { Config } from '../src/config.ts';
import type { Context } from '@deepseek-ai/cordis';

beforeEach(() => {
  resetApproval(); // W-1 隔离缝：簿记/桶/观察者/带外通道（W1-2）一并归零
  skillLibrary.reset();
  skillLibrary.configure(true, '', 50); // 内存库（零落盘 —— 测试离线确定性）
});

/** 武装采集型带外 sink（生产中人类的视角：只有这里看得见码） */
function armCapture(): { deliveries: ConfirmCodeDelivery[] } {
  const deliveries: ConfirmCodeDelivery[] = [];
  setConfirmCodeChannel(d => {
    deliveries.push({ ...d });
  });
  return { deliveries };
}

/** 与真码不同的确定性错码（用于错码路径 —— 不猜真码） */
function wrongCodeOf(code: string): string {
  return code === '000000' ? '000001' : '000000';
}

/** 工具执行面便捷转换 */
type Exec = (args: unknown) => Promise<string>;
function exec(t: unknown): Exec {
  return (t as unknown as { execute: (a: unknown) => Promise<string> }).execute.bind(t);
}

// ─── S2：带外人证通道 ───

test('S2-1: 带外码成功路径 —— 码经带外投递、簿记只留哈希、携码才可授予', () => {
  const { deliveries } = armCapture();
  const pa = approval.request('send the invoice to Alice');

  assert.equal(deliveries.length, 1, '恰好一次带外投递');
  const d = deliveries[0];
  assert.equal(d.token, pa.token, '投递载荷携带令牌（人类可对号）');
  assert.equal(d.description, 'send the invoice to Alice');
  assert.match(d.confirmCode, /^[0-9]{6}$/, '6 位十进制码（zerosafe 格式面）');
  assert.ok(d.expiresAt > Date.now(), '投递载荷携带时效');

  assert.ok(pa.confirmCodeHash !== undefined, '簿记在场（只留 sha256）');
  assert.match(pa.confirmCodeHash!, /^[0-9a-f]{64}$/, '簿记是 sha256（明文不驻留）');
  assert.notEqual(pa.degraded, true, '带码审批不降级');
  assert.ok(!JSON.stringify(pa).includes(d.confirmCode), 'PendingApproval 序列化无明文码');

  const st = approval.status(pa.token);
  assert.equal(st.confirmCodeRequired, true, 'status 透明化：带码审批');
  assert.equal(st.degraded, false);

  // 无码不得授予 —— 布尔旧签名与详细通道同律（模型侧无从绕过）
  assert.equal(approval.grant(pa.token, true), false, '旧布尔 grant 无码拒绝');
  assert.deepEqual(approval.grantDetailed(pa.token, true), { ok: false, reason: 'confirm-code-required' });

  // 携码授予 ⇒ 生命周期照常
  assert.deepEqual(approval.grantDetailed(pa.token, true, { confirmCode: d.confirmCode }), { ok: true });
  assert.equal(approval.validate(pa.token), true);
  assert.equal(approval.consume(pa.token), true, '验收式消费照常');
});

test('S2-2: 错码拒绝 —— 不泄露哪位错（不同错码的失败完全同形）、不烧同意预算', () => {
  const { deliveries } = armCapture();
  const pa = approval.request('delete the record');
  const code = deliveries[0].confirmCode;

  const budgetBefore = approvalBudget();
  const r1 = approval.grantDetailed(pa.token, true, { confirmCode: wrongCodeOf(code) });
  assert.deepEqual(r1, { ok: false, reason: 'confirm-code-mismatch' }, '错码拒绝');
  assert.equal(approvalBudget(), budgetBefore, '错码不烧 Y-10 同意预算（码校验在前）');
  assert.equal(approval.validate(pa.token), false, '错码后仍未授予');

  // 错一次后携真码仍可授予（人类手误容错）
  assert.deepEqual(approval.grantDetailed(pa.token, true, { confirmCode: code }), { ok: true });
  assert.equal(approval.validate(pa.token), true, '正确码后授予');
  assert.equal(approvalBudget(), budgetBefore - 1, '真码授予恰消耗一枚桶令牌');
});

test('S2-3: 错码封顶 —— 达到上限焚毁令牌（防暴力枚举），真码也救不回', () => {
  const { deliveries } = armCapture();
  const pa = approval.request('transfer funds');
  const code = deliveries[0].confirmCode;
  const wrong = wrongCodeOf(code);

  for (let i = 0; i < 4; i++) {
    assert.deepEqual(approval.grantDetailed(pa.token, true, { confirmCode: wrong }),
      { ok: false, reason: 'confirm-code-mismatch' }, `第 ${i + 1} 次错码：mismatch（未到封顶）`);
  }
  assert.deepEqual(approval.grantDetailed(pa.token, true, { confirmCode: wrong }),
    { ok: false, reason: 'code-attempts-exhausted' }, '第 5 次错码：封顶焚毁');
  assert.deepEqual(approval.grantDetailed(pa.token, true, { confirmCode: code }),
    { ok: false, reason: 'invalid-token' }, '焚毁后真码也无效（错误码=令牌无效，非码错误）');
});

test('S2-4: W6R fail-closed —— 通道缺席 ⇒ degraded 标记 + grant 一律拒绝（无码同意已废除）', () => {
  // 不武装任何通道（beforeEach 的 resetApproval 已卸载）—— 通道缺席是事实面
  const pa = approval.request('send email to Bob');
  assert.equal(pa.confirmCodeHash, undefined, '无码（投递未发生）');
  assert.equal(pa.degraded, true, '降级标记在场（诚实簿记）');
  // 安全核心：grant 双面（布尔旧签名与详细通道）都必须拒绝 —— fail-closed
  assert.equal(approval.grant(pa.token, true), false, '旧布尔 grant 拒绝（无码同意已废除）');
  assert.deepEqual(approval.grantDetailed(pa.token, true), { ok: false, reason: 'confirm-channel-absent' });
  assert.equal(approval.validate(pa.token), false, '不可授予 ⇒ 不可过闸门');
  const st = approval.status(pa.token);
  assert.equal(st.confirmCodeRequired, false);
  assert.equal(st.degraded, true, 'status 透明化：降级');
  assert.equal(approval.consume(pa.token), false, '不可授予 ⇒ 不可消费');
  // 携码也无法救回 degraded 令牌（人证缺席期间的「同意」无法追认）
  const pb = approval.request('send email to Carol');
  assert.deepEqual(approval.grantDetailed(pb.token, true, { confirmCode: '123456' }),
    { ok: false, reason: 'confirm-channel-absent' }, '携码也拒绝（degraded 令牌无码可校验）');
  // 拒绝路径（grant=false）不需要人证 —— 任何时刻喊停都合法（保守方向）
  assert.equal(approval.grant(pb.token, false), true, '否决恒可行（拒绝不烧人证）');
});

test('S2-5: W6R fail-closed —— 带外通道故障（返回 false / 抛出）⇒ 拒绝，绝不炸铸造', () => {
  setConfirmCodeChannel(() => false); // 显式投递失败
  const pa = approval.request('pay the bill');
  assert.equal(pa.confirmCodeHash, undefined, '投递失败 ⇒ 无码');
  assert.equal(pa.degraded, true);
  assert.equal(approval.grant(pa.token, true), false, '投递失败 ⇒ grant 拒绝（fail-closed）');
  assert.deepEqual(approval.grantDetailed(pa.token, true), { ok: false, reason: 'confirm-channel-absent' });

  setConfirmCodeChannel(() => { throw new Error('notification daemon exploded'); });
  const pb = approval.request('pay again');
  assert.equal(pb.degraded, true, 'sink 抛出 ⇒ 通道缺席语义（铸造主流程不炸）');
  assert.equal(approval.grant(pb.token, true), false, 'sink 抛出 ⇒ grant 同样拒绝');
});

test('S2-6: 码不泄露给模型 —— 工具结果文本与模型可见数据结构中绝无码', async () => {
  const cfg = { enableApprovalGate: true, enableDemonstrations: true } as unknown as Config;
  const reqTool = createRequestApprovalTool(cfg);
  const grantTool = createGrantApprovalTool(cfg);

  const { deliveries } = armCapture();
  const reqRaw = await exec(reqTool)({ description: 'wire the payment to vendor X' });
  const reqOut = JSON.parse(reqRaw);
  assert.equal(reqOut.status, 'PENDING_USER_CONSENT');
  assert.equal(reqOut.state_anchor.confirm_code_required, true, '码要求透明化（布尔事实）');
  assert.equal(reqOut.state_anchor.confirm_channel, 'out-of-band');
  const code = deliveries[0].confirmCode;

  // 安全核心断言：模型可见的返回文本与解析后结构中都无码
  assert.ok(!reqRaw.includes(code), '工具结果原文无码');
  assert.ok(!JSON.stringify(reqOut).includes(code), '模型可见数据结构无码');
  assert.ok(!JSON.stringify(reqOut).includes(deliveries[0].token + code), '无码拼接泄漏');

  // 错码的失败输出同样无码（也不给任何位提示）
  const gWrong = await exec(grantTool)({
    token: reqOut.state_anchor.token, grant: true, confirm_code: wrongCodeOf(code),
  });
  assert.equal(JSON.parse(gWrong).state_anchor.reason, 'confirm-code-mismatch');
  assert.ok(!gWrong.includes(code), '错码失败输出无真码');

  // 不同错码的失败输出逐字节同形 —— 不泄露哪一位更接近（枚举侧信道封死）
  const gWrong2 = await exec(grantTool)({
    token: reqOut.state_anchor.token, grant: true, confirm_code: wrongCodeOf(code) === '000000' ? '999999' : '000000',
  });
  assert.equal(gWrong, gWrong2, '两个不同错码的失败输出完全一致（恒定时间的输出面投影）');

  // 携码授予成功（用户交回的码经模型转递 —— 模型只是邮差，不是签名人）
  const gOk = JSON.parse(await exec(grantTool)({
    token: reqOut.state_anchor.token, grant: true, confirm_code: code,
  }));
  assert.equal(gOk.status, 'GRANTED');
  assert.ok(!JSON.stringify(gOk).includes(code), '成功输出同样无码');
});

test('S2-7: 错误码区分 —— 「码错误」≠「令牌无效」；工具面无码降级默认', async () => {
  const { deliveries } = armCapture();
  const pa = approval.request('submit the order');
  const r1 = approval.grantDetailed(pa.token, true, { confirmCode: wrongCodeOf(deliveries[0].confirmCode) });
  const r2 = approval.grantDetailed('APR-NEVER-MINTED', true, { confirmCode: '123456' });
  assert.notEqual(r1.ok ? '' : r1.reason, r2.ok ? '' : r2.reason, '两类失败成因可区分');

  // 工具面：通道缺席（默认）⇒ W6R fail-closed：诚实标记通道缺席 + grant 拒绝
  // （旧方言的「无码 GRANTED」是 fail-open，已废除）
  resetApproval(); // 卸载通道 ⇒ 恢复通道缺席的默认面
  const cfg = { enableApprovalGate: true, enableDemonstrations: false } as unknown as Config;
  const reqTool = createRequestApprovalTool(cfg);
  const grantTool = createGrantApprovalTool(cfg);
  const reqOut = JSON.parse(await exec(reqTool)({ description: 'send the report' }));
  assert.equal(reqOut.state_anchor.confirm_code_required, false, '通道缺席：无码要求');
  assert.equal(reqOut.state_anchor.confirm_channel, 'out-of-band-absent', '通道缺席诚实标记');
  assert.match(reqOut.next_step, /宿主 UI/, '指引：请用户通过宿主 UI 操作');
  const g = JSON.parse(await exec(grantTool)({ token: reqOut.state_anchor.token, grant: true }));
  assert.equal(g.status, 'FAILED', '通道缺席 ⇒ grant 拒绝（fail-closed，无码同意已废除）');
  assert.equal(g.state_anchor.reason, 'confirm-channel-absent');
  assert.match(g.next_step, /带外确认通道缺席，无法完成人工确认，请用户通过宿主 UI 操作/);

  // 伪令牌 ⇒ invalid-token 方言（非码错误）
  const gFake = JSON.parse(await exec(grantTool)({ token: 'APR-FAKE', grant: true, confirm_code: '123456' }));
  assert.equal(gFake.status, 'FAILED');
  assert.equal(gFake.state_anchor.reason, 'invalid-token');
});

test('S2-8: W6R doctorChannel 挂点 —— 明文码只走事件总线；console 脱敏；无总线 ⇒ fail-closed', () => {
  // 采集型假 ctx（事件总线面）
  const events: Array<{ event: string; payload: unknown }> = [];
  const fakeCtx = {
    on: (_e: string, _h: unknown) => { /* 仅接线，不触发回执 */ },
    emit: (event: string, payload: unknown) => { events.push({ event, payload }); },
  } as unknown as Context;

  // 组合根既有接线点：wireDoctorVerdictChannel 顺带武装带外通道（W1-2 挂点）。
  // 控制台采集须覆盖「接线 + request 铸造投递」全程（OOB 回执在 request 时刻打印）。
  const origLog = console.log;
  const lines: string[] = [];
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
  let pa: ReturnType<typeof approval.request> | null = null;
  try {
    wireDoctorVerdictChannel(fakeCtx, {} as Config);
    pa = approval.request('delete production data');
  } finally {
    console.log = origLog;
  }
  assert.ok(pa, '接线与铸造绝不抛');
  assert.equal(pa.confirmCodeHash !== undefined, true, '组合根接线后 ⇒ 带码审批（事件总线投递成功）');

  // W6R 铁律①：控制台回执**脱敏** —— 绝不含明文码（宿主可能把 console 日志
  // 回传进模型上下文，明文码进 console = 对模型可见）
  const consoleHit = lines.find(l => l.includes('[Approval OOB]'));
  assert.ok(consoleHit, '控制台带外回执在场');
  const busPayload = events.find(e => e.event === APPROVAL_CONFIRM_CODE_EVENT)!.payload as {
    confirmCode: string; token: string;
  };
  assert.match(busPayload.confirmCode, /^[0-9]{6}$/, '总线载荷携带 6 位码（唯一携码面）');
  assert.equal(busPayload.token, pa.token);
  assert.ok(!consoleHit!.includes(busPayload.confirmCode), 'W6R：console 回执绝不含明文码');
  assert.match(consoleHit!, /确认码已投递\(6位\)/, 'console 只打脱敏事实（"确认码已投递(6位)"）');
  // 脱敏回执也不含码的任何子串拼接（对号信息只有 token 与时效）
  assert.ok(!JSON.stringify(lines).includes(busPayload.confirmCode), '全程 console 输出无明文码');

  // W6R 铁律②：无事件总线（ctx 缺席）⇒ 投递失败 ⇒ degraded（fail-closed）
  armOutOfBandConfirmChannel(); // 无 ctx：唯一携码通道缺席
  const pNoBus = approval.request('no bus op');
  assert.equal(pNoBus.degraded, true, '无总线 ⇒ degraded（grant 将被拒 —— fail-closed）');
  assert.equal(approval.grant(pNoBus.token, true), false);

  // 直接武装面（幂等）：armOutOfBandConfirmChannel 可独立调用
  armOutOfBandConfirmChannel(fakeCtx);
  const pb = approval.request('second op');
  assert.equal(pb.confirmCodeHash !== undefined, true, '幂等武装后依旧带码');

  // 错码封顶防枚举的端到端复核
  for (let i = 0; i < 5; i++) {
    approval.grantDetailed(pb.token, true, { confirmCode: wrongCodeOf(busPayload.confirmCode) });
  }
  assert.equal(approval.validate(pb.token), false, '封顶焚毁');
});

// ─── H1：批注式审批 ───

test('H1-1: 批注铸入与读取 —— amendment patch 结构完整、执行侧合并幂等', () => {
  const { deliveries } = armCapture(); // W6R：批注用例同样走带码审批（无码 grant 已废除）
  const pa = approval.request('click the Send button', {
    actionShape: { tool: 'click_mouse', x: 0.5, y: 0.5, target_description: 'Send button' },
  });
  assert.equal(approval.amendmentOf(pa.token), null, '批注缺席 ⇒ null（诚实）');

  const NOTE = '同意，但点右下角的小发送按钮，别点工具栏那个';
  assert.deepEqual(approval.grantDetailed(pa.token, true, { note: NOTE, confirmCode: deliveries[0].confirmCode }), { ok: true });

  const am = approval.amendmentOf(pa.token);
  assert.ok(am, '批注铸入在场');
  assert.equal(am!.note, NOTE, '批注原文');
  assert.deepEqual(am!.targetDescriptionDelta,
    { original: 'click the Send button', corrected: NOTE }, '目标描述差异：模型自述 → 用户修正');
  assert.equal(am!.actionShapeCorrection.target_description, NOTE, '动作形状修正 patch');
  assert.ok(am!.amendedAt <= Date.now(), '铸入时刻');

  // 执行侧消费点 API：派发前读 patch 修正计划（字段级覆盖、其余保留）
  const plan = approval.applyAmendment(pa.token, {
    tool: 'click_mouse', x: 0.62, y: 0.81, target_description: 'Send button',
  });
  assert.equal(plan.tool, 'click_mouse', '未修正字段保留');
  assert.equal(plan.x, 0.62);
  assert.equal(plan.y, 0.81);
  assert.equal(plan.target_description, NOTE, '目标描述被批注修正');

  // 无批注令牌 ⇒ 原样返回（幂等 no-op）
  const pb = approval.request('plain op');
  const pbCode = deliveries.find(d => d.token === pb.token)!.confirmCode;
  approval.grantDetailed(pb.token, true, { confirmCode: pbCode });
  const untouched = approval.applyAmendment(pb.token, { tool: 'click_mouse', target_description: 'x' });
  assert.deepEqual(untouched, { tool: 'click_mouse', target_description: 'x' });

  // 批注预算：超长截断到 200（Token 纪律）
  const pc = approval.request('long note op');
  approval.grantDetailed(pc.token, true, { note: 'x'.repeat(500), confirmCode: deliveries[deliveries.length - 1].confirmCode });
  assert.equal(approval.amendmentOf(pc.token)!.note.length, 200, '批注截 200');
});

test('H1-2: amended 示范事件 —— 消费/否决两类事件都带 amended 标注与批注内容', () => {
  const events: DemonstrationEvent[] = [];
  setDemonstrationObserver(ev => { events.push(ev); skillLibrary.learnFromDemonstration(ev); });
  const { deliveries } = armCapture(); // W6R：授予走带码审批（拒绝路径无需人证）

  // 正示范 + 批注（用户背书的是「修正后的计划」）
  const pa = approval.request('send the email', {
    actionShape: { tool: 'click_mouse', x: 0.5, y: 0.5, target_description: '发送' },
  });
  approval.grantDetailed(pa.token, true, { note: '改用右下角的小发送', confirmCode: deliveries[0].confirmCode });
  approval.consume(pa.token);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'approval-consumed');
  assert.equal(events[0].amended, true, 'amended 标注在场');
  assert.equal(events[0].amendment!.note, '改用右下角的小发送', '批注内容对蒸馏下游可见');
  assert.deepEqual(events[0].amendment!.targetDescriptionDelta,
    { original: 'send the email', corrected: '改用右下角的小发送' });

  // 负示范 + 批注（否决理由 = 最强负示范）
  const pb = approval.request('delete all temp files', {
    actionShape: { tool: 'click_mouse', x: 0.7, y: 0.7, target_description: 'Delete all' },
  });
  approval.grantDetailed(pb.token, false, { note: '不要全删，只删昨天的' });
  assert.equal(events.length, 2);
  assert.equal(events[1].kind, 'approval-denied');
  assert.equal(events[1].amended, true, '拒绝路径同样带 amended');
  assert.equal(events[1].amendment!.note, '不要全删，只删昨天的');

  // 无批注的事件不带 amended（诚实缺席，非 false 噪声）
  const pc = approval.request('no note op', { actionShape: { tool: 'click_mouse', x: 0.1, y: 0.1 } });
  approval.grant(pc.token, false);
  assert.equal(events.length, 3);
  assert.equal(events[3 - 1].amended, undefined, '无批注 ⇒ amended 缺席');

  // 蒸馏下游（技能库）照常消费事件 —— 教育旁路零回归
  assert.ok(skillLibrary.demonstrationStats().avoided >= 1, '负示范照常入回避注记');
});

test('H1-3: 工具面批注 —— GRANTED 回显结构化 amendment；REVOKED 回显批注', async () => {
  const cfg = { enableApprovalGate: true, enableDemonstrations: true } as unknown as Config;
  const reqTool = createRequestApprovalTool(cfg);
  const grantTool = createGrantApprovalTool(cfg);
  const { deliveries } = armCapture(); // W6R：授予走带码审批（无码 grant 已废除）

  const reqOut = JSON.parse(await exec(reqTool)({ description: 'click 发送 to submit' }));
  const NOTE = 'yes but click the small Send at bottom-right';
  const g = JSON.parse(await exec(grantTool)({
    token: reqOut.state_anchor.token, grant: true, note: NOTE, confirm_code: deliveries[0].confirmCode,
  }));
  assert.equal(g.status, 'GRANTED');
  assert.equal(g.state_anchor.amended, true, 'state_anchor 带 amended 标注');
  assert.equal(g.amendment.target_description_correction, NOTE, '修正后的目标描述');
  assert.equal(g.amendment.original_description, 'click 发送 to submit', '原始描述（差异两面）');
  assert.match(g.amendment.instruction, /AMENDED/, '执行指令：照修正后的计划执行');

  // 薄记与工具回显一致（执行侧读的是同一份 patch）
  assert.equal(approval.amendmentOf(reqOut.state_anchor.token)!.note, NOTE);

  // 拒绝 + 批注
  const req2 = JSON.parse(await exec(reqTool)({ description: 'delete everything' }));
  const r = JSON.parse(await exec(grantTool)({
    token: req2.state_anchor.token, grant: false, note: '绝对不要删',
  }));
  assert.equal(r.status, 'REVOKED');
  assert.equal(r.state_anchor.amended, true, '拒绝路径回显批注');
  assert.equal(r.state_anchor.amendment_note, '绝对不要删');
});

// ─── 铸造格式面（离线确定性 —— 只断言格式，不断言 CSPRNG 取值） ───

test('S2-9: 码格式 —— 多次铸造均为 6 位十进制（zerosafe 格式面）', () => {
  const { deliveries } = armCapture();
  for (let i = 0; i < 10; i++) approval.request(`format probe ${i}`);
  assert.equal(deliveries.length, 10);
  for (const d of deliveries) assert.match(d.confirmCode, /^[0-9]{6}$/, '6 位十进制');
  // 每次投递都携带独立时效与令牌（人类可对号入座）
  assert.ok(new Set(deliveries.map(d => d.token)).size === 10, '一令牌一投递');
});

// ─── 隔离缝 ───

test('W1-2 隔离缝：resetApproval 卸载带外通道（恢复通道缺席的 fail-closed 默认）', () => {
  armCapture();
  const pa = approval.request('armed op');
  assert.equal(pa.confirmCodeHash !== undefined, true);
  resetApproval();
  const pb = approval.request('post-reset op');
  assert.equal(pb.degraded, true, 'reset 后恢复通道缺席默认（测试确定性基线 —— W6R：该令牌不可 grant）');
  assert.equal(approval.grant(pb.token, true), false, 'fail-closed 基线：无通道即无同意');
});

// ═══ ΠΑΝ-5：能力限缩令牌（macaroon 式 caveat —— 目标绑定铸造 + 兑换时强制比对） ═══

/** 携码授予一枚（可选绑定的）令牌 —— ΠΑΝ-5 用例的标准前置 */
function grantedPa(description: string, opts?: Parameters<typeof approval.request>[1]): string {
  const { deliveries } = armCapture();
  const pa = approval.request(description, opts);
  const g = approval.grantDetailed(pa.token, true, { confirmCode: deliveries[0].confirmCode });
  assert.equal(g.ok, true, JSON.stringify(g));
  return pa.token;
}

test('ΠΑΝ-5a: 绑定令牌兑换三闸 —— 无提示拒绝 / 提示不匹配拒绝 / 匹配放行（fail-closed）', () => {
  const token = grantedPa('click 发送 to submit the report', {
    target: { tool: 'click_mouse', x: 0.5, y: 0.5, target_description: '发送' },
  });
  assert.equal(approval.status(token).targetBound, true, '绑定透明化（status 只在绑定时增键）');

  // 无提示：能力已限缩的令牌不允许「无凭据兑现」（未升级工具在绑定令牌上 fail-closed）
  assert.deepEqual(approval.validateDetailed(token), { ok: false, reason: 'target-hint-required' });
  assert.equal(approval.validate(token), false, '布尔投影同律');

  // 提示不匹配：持 A 令牌点 B 目标 —— 批判报告 C1-5 H1 的洞在此闭合
  assert.deepEqual(
    approval.validateDetailed(token, { tool: 'click_mouse', x: 0.5, y: 0.5, target_description: '删除' }),
    { ok: false, reason: 'target-mismatch' },
    '目标描述不同 ⇒ 拒绝（旧实现：任何命中危险词的点击都放行）');
  assert.deepEqual(
    approval.validateDetailed(token, { tool: 'click_mouse', x: 0.51, y: 0.5, target_description: '发送' }),
    { ok: false, reason: 'target-mismatch' },
    '坐标漂出量化带 ⇒ 拒绝');

  // 匹配放行（坐标在千分位量化带内 = 同一目标）
  assert.deepEqual(
    approval.validateDetailed(token, { tool: 'click_mouse', x: 0.5004, y: 0.5, target_description: '发送' }),
    { ok: true }, '0.5004 量化到 0.500 ⇒ 匹配（抖动容忍带）');

  // 透明化：最近一次绑定拒绝可供派发层组装指引（与 escrowBlockOf 同形态）
  approval.validateDetailed(token, { tool: 'click_mouse', x: 0.9, y: 0.9, target_description: '别处' });
  const rej = targetRejectionOf();
  assert.ok(rej, '绑定拒绝有透明化记录');
  assert.equal(rej!.token, token);
  assert.equal(rej!.reason, 'target-mismatch');
  assert.match(rej!.expectedPrefix, /^[0-9a-f]{8}$/, '期望摘要只出前 8 位（脱敏纪律）');
  assert.match(rej!.receivedPrefix, /^[0-9a-f]{8}$/, '提示摘要只出前 8 位');
});

test('ΠΑΝ-5b: beginAttempt / consume 携 targetHint —— 拒绝先于一切簿记变异、不焚毁', () => {
  const token = grantedPa('click 删除 to remove report.docx', {
    target: { tool: 'click_mouse', x: 0.3, y: 0.7, target_description: '删除 report.docx' },
  });

  // beginAttempt 无提示 ⇒ 拒绝且零簿记副作用（attempts/inFlight 不动）
  assert.equal(approval.beginAttempt(token), false);
  assert.equal(approval.status(token).attempts, 0, '拒绝不烧尝试预算');
  // 提示不匹配 ⇒ 同律拒绝
  assert.equal(approval.beginAttempt(token, { target: { tool: 'click_mouse', x: 0.3, y: 0.7, target_description: '别的东西' } }), false);
  assert.equal(approval.status(token).attempts, 0, 'mismatch 拒绝同样不烧预算');
  // 匹配 ⇒ 正常预留（escrow/target 语义正交）
  assert.equal(approval.beginAttempt(token, { target: { tool: 'click_mouse', x: 0.3, y: 0.7, target_description: '删除 report.docx' } }), true);
  assert.equal(approval.status(token).attempts, 1);
  approval.attemptFailed(token, 'no-effect'); // 结算预留（V 纪元重试通道保持）

  // consume 不匹配 ⇒ false 且**不焚毁**（不匹配 ≠ 验收通过；合法持有者可携正确提示再来）
  assert.equal(approval.consume(token, { tool: 'click_mouse', x: 0.3, y: 0.7, target_description: '删除 别的' }), false);
  assert.equal(approval.status(token).present, true, 'mismatch 消费不焚毁令牌');
  // consume 匹配 ⇒ 验收式消费照常（用后即焚）
  assert.equal(approval.consume(token, { tool: 'click_mouse', x: 0.3, y: 0.7, target_description: '删除 report.docx' }), true);
  assert.equal(approval.status(token).present, false);
});

test('ΠΑΝ-5c: 兼容律 —— 未携带绑定的令牌对 targetHint 缺席/在场均零行为', () => {
  const token = grantedPa('plain irreversible op'); // 既有铸造路径：无 target
  assert.equal(approval.status(token).targetBound, undefined, '未绑定 ⇒ 键缺席');
  assert.equal(approval.validate(token), true, '无提示照常（既有调用方）');
  assert.equal(approval.validate(token, { tool: 'click_mouse', x: 0.9, y: 0.9, target_description: '随便' }), true,
    '未绑定令牌的提示只是被忽略（不因「提示与令牌无关」而拒绝 —— 绑定只在铸造时铸入）');
  assert.equal(approval.beginAttempt(token, { target: { tool: 'drag_mouse', x: 0.1, y: 0.1 } }), true, 'opts.target 对未绑定令牌零行为');
  assert.equal(approval.consume(token), true);
});

test('ΠΑΝ-5d: mintBoundToken 严格面 —— 垃圾 target 结构化拒绝（绝不静默铸造无绑定全能力令牌）', () => {
  const bad = approval.mintBoundToken('op', { target: { tool: '', x: 0.5 } as { tool: string } });
  assert.deepEqual(bad, { ok: false, reason: 'invalid-target' }, '空 tool = 无可绑定的能力边界');
  const bad2 = approval.mintBoundToken('op', { target: 42 as unknown as { tool: string } });
  assert.deepEqual(bad2, { ok: false, reason: 'invalid-target' }, '非对象 target 防御式拒绝');

  const { deliveries } = armCapture();
  const ok = approval.mintBoundToken('send the invoice', {
    target: { tool: 'click_mouse', x: 0.5, y: 0.5, target_description: '发送' },
  });
  assert.equal(ok.ok, true);
  if (!ok.ok) return;
  assert.equal(ok.pa.confirmCodeHash !== undefined, true, '带外码照常铸造');
  assert.equal(approval.status(ok.pa.token).targetBound, true, '绑定在场');
  assert.equal(approval.grantDetailed(ok.pa.token, true, { confirmCode: deliveries[0].confirmCode }).ok, true);
  assert.equal(approval.validate(ok.pa.token, { tool: 'click_mouse', x: 0.5, y: 0.5, target_description: '发送' }), true);
});

test('ΠΑΝ-5e: 摘要纯函数 —— 确定性/域分隔/粒度（type_text 为长度桶级 —— 隐私铁律的代价）', () => {
  const a = computeTargetDigest({ tool: 'click_mouse', x: 0.5, y: 0.5, target_description: '发送' });
  const b = computeTargetDigest({ tool: 'click_mouse', x: 0.5, y: 0.5, target_description: '发送' });
  assert.equal(a, b, '同输入同摘要（确定性）');
  assert.match(a!, /^[0-9a-f]{64}$/, 'sha256 hex');
  assert.notEqual(a, computeTargetDigest({ tool: 'click_mouse', x: 0.5, y: 0.5, target_description: '删除' }), '描述参与摘要');
  assert.notEqual(a, computeTargetDigest({ tool: 'drag_mouse', x: 0.5, y: 0.5, target_description: '发送' }), '动作参与摘要');
  assert.equal(computeTargetDigest({ tool: '' }), undefined, '无身份 ⇒ 诚实拒绝绑定');
  assert.equal(computeTargetDigest(42 as unknown as { tool: string }), undefined, '垃圾输入防御式');
  // type_text：文本绝不入档 ⇒ 绑定粒度 = 长度桶级（同桶文本互相匹配 —— 已知取舍，
  // 文档明示；隐私铁律优先于绑定精度）
  const t1 = computeTargetDigest({ tool: 'type_text', text: 'hello world' });
  const t2 = computeTargetDigest({ tool: 'type_text', text: 'hi!!' });
  assert.equal(t1, t2, '同长度桶（short）⇒ 同摘要 —— 桶级粒度是文档化的语义');
  assert.notEqual(t1, computeTargetDigest({ tool: 'type_text', text: 'x'.repeat(100) }), '跨桶 ⇒ 不同摘要');
});

// ═══ ΠΑΝ-6：双通道双花封堵（ledger 侧 —— 窗口乙：队列已批 ⇒ 交互面不得再武装） ═══

/** 暂存一枚令牌（stagingTimeoutMs=0 ⇒ 立即入队）并返回其 token 与条目 id */
function stagedOne(description: string): { token: string; id: string } {
  const pa = approval.request(description, {
    actionShape: { tool: 'click_mouse', x: 0.5, y: 0.5, target_description: description },
  });
  const r = approvalQueue.stageAction({ token: pa.token, description, stagingTimeoutMs: 0 });
  assert.equal(r.ok, true, JSON.stringify(r));
  if (!r.ok) throw new Error('unreachable');
  return { token: pa.token, id: r.entry.id };
}

test('ΠΑΝ-6a: 窗口乙封堵 —— adjudicate 已批 ⇒ 同意属队列续跑面，交互 grant 结构化拒绝且不烧预算', () => {
  const { deliveries } = armCapture();
  approvalQueue.arm({ stagingTimeoutMs: 0 });
  const { token, id } = stagedOne('click 发送 to submit the report');
  const code = deliveries.find(d => d.token === token)!.confirmCode;

  // 队列裁决面先行兑付在途（ΠΑΝ-1 后 adjudicate 携码 —— 与 grantDetailed 同一人证标准）
  assert.equal(approvalQueue.adjudicate([id], true, undefined, code).results[0].outcome, 'granted');
  assert.equal(approvalBudget(), 2, '裁决已计一枚 Y-10');

  // 窗口乙：同一份同意（同 token 在途）不得再经交互面武装第二条通道
  const budget = approvalBudget();
  assert.deepEqual(approval.grantDetailed(token, true, { confirmCode: code }),
    { ok: false, reason: 'queue-granted-already' }, '一次同意恰好一次物理兑现');
  assert.equal(approvalBudget(), budget, '结构性拒绝不烧 Y-10（与 W6R 同律）');
  assert.equal(approval.validate(token), false, '交互通道未武装');

  // 队列通道完好：takeGranted 照常铸执行令牌（该同意的唯一兑现通道）
  const taken = approvalQueue.takeGranted();
  assert.ok(taken, '队列面兑付不受影响');
  assert.equal(approval.validate(taken!.executionToken), true);
  assert.equal(approval.consume(taken!.executionToken), true);
  assert.equal(approvalQueue.takeGranted(), null, '恰一次');
});

test('ΠΑΝ-6b: 窗口甲（队列侧 ΠΑΝ-4 absorbed）与 ledger 侧兼容 —— 交互 grant 是唯一执行载体', () => {
  const { deliveries } = armCapture();
  approvalQueue.arm({ stagingTimeoutMs: 0 });
  const { token, id } = stagedOne('delete the old draft');
  const code = deliveries.find(d => d.token === token)!.confirmCode;

  // 交互 grant 先落：传播把条目置 absorbed 终态（队列面执法），交互令牌本尊照常可用
  assert.deepEqual(approval.grantDetailed(token, true, { confirmCode: code }), { ok: true });
  assert.equal(approvalQueue.dumpQueue().find(e => e.id === id)!.decision!.verdict, 'absorbed');
  assert.equal(approvalQueue.takeGranted(), null, '队列侧不再铸第二枚执行令牌');
  assert.equal(approval.validate(token), true, 'ledger 侧不退役交互令牌（两方向不叠加成死锁）');
  assert.equal(approval.beginAttempt(token), true);
  assert.equal(approval.consume(token), true, '恰一次物理兑现（交互通道）');
});

test('ΠΑΝ-6c: 否决恒可行 —— 队列已批后用户交互喊停仍合法（保守方向：任何时刻喊停）', () => {
  const { deliveries } = armCapture();
  approvalQueue.arm({ stagingTimeoutMs: 0 });
  const { token, id } = stagedOne('ship the crate');
  const code = deliveries.find(d => d.token === token)!.confirmCode;
  assert.equal(approvalQueue.adjudicate([id], true, undefined, code).results[0].outcome, 'granted');
  // 窗口乙拒绝的是「武装第二通道」，不是用户否决 —— 拒绝路径不受影响
  assert.deepEqual(approval.grantDetailed(token, false), { ok: true }, 'veto 恒可');
  assert.equal(approval.validate(token), false);
});

// ═══ ΠΑΝ-7：非字符串 token —— 防御式结构化拒绝（绝不抛） ═══

test('ΠΑΝ-7a: 主账本全公开面对非字符串 token 一律结构化拒绝，绝不抛 TypeError', () => {
  armCapture();
  const junk: unknown[] = [42, 3.14, {}, Symbol('tok'), true, null, undefined, ['APR-X'], { toString: 1 }];
  // 测试侧安全展示器（String(垃圾) 自身可能抛 —— 与被测面无关）
  const show = (v: unknown): string => {
    try { return typeof v === 'symbol' ? v.toString() : JSON.stringify(v) ?? String(typeof v); }
    catch { return `<${typeof v}>`; }
  };
  for (const t of junk) {
    const tk = t as unknown as string;
    try {
      assert.deepEqual(approval.grantDetailed(tk, true, { confirmCode: '123456' }), { ok: false, reason: 'invalid-token' }, `grantDetailed(${show(t)})`);
      assert.equal(approval.grant(tk, true), false, `grant(${show(t)})`);
      assert.equal(approval.validate(tk), false, `validate(${show(t)})`);
      assert.deepEqual(approval.validateDetailed(tk), { ok: false, reason: 'invalid-token' }, `validateDetailed(${show(t)})`);
      assert.equal(approval.beginAttempt(tk), false, `beginAttempt(${show(t)})`);
      assert.equal(approval.consume(tk), false, `consume(${show(t)})`);
      const af = approval.attemptFailed(tk, 'no-effect');
      assert.equal(af.valid, false, `attemptFailed(${show(t)})`);
      approval.revoke(tk); // 无返回值 —— 不抛即执法
      assert.deepEqual(approval.status(tk), { present: false, granted: false, expired: false }, `status(${show(t)})`);
      assert.equal(approval.amendmentOf(tk), null, `amendmentOf(${show(t)})`);
      assert.equal(approval.reversibilityOf(tk), null, `reversibilityOf(${show(t)})`);
      assert.equal(approval.dispatchLaneOf(tk), null, `dispatchLaneOf(${show(t)})`);
    } catch (e) {
      assert.fail(`非字符串 token ${show(t)} 使主账本抛出：${e instanceof Error ? e.message : show(e)}`);
    }
  }
});

test('ΠΑΝ-7b: 非字符串 note 防御 —— 否决/批注路径绝不抛（castAmendmentFor 收口）', () => {
  armCapture();
  const pa = approval.request('delete temp files');
  // 旧实现：note.slice(0,200) 对数字抛 TypeError —— 违「运行层绝不抛」宪
  assert.doesNotThrow(() => {
    assert.deepEqual(approval.grantDetailed(pa.token, false, { note: 42 as unknown as string }), { ok: true });
  }, '否决 + 非字符串批注不抛');
  // 非字符串 description 的铸造面同样收口
  assert.doesNotThrow(() => {
    const pb = approval.request(42 as unknown as string);
    assert.equal(typeof pb.description, 'string', 'description 防御式字符串化');
  });
});

// ═══ ΠΑΝ-8：bypass 面反向验证 —— 不可逆携带 × 闸门已武装 ⇒ 裸派发 fail-closed ═══

test('ΠΑΝ-8a: 托管闸门已武装 + irreversible 携带 + 裸 beginAttempt ⇒ 拒绝（M6 死闸门复活）', () => {
  setDispatchEscrowHook(() => ({ ok: true })); // 模拟 reversalEscrow.arm 注册的闸门（已武装）
  try {
    const token = grantedPa('pay the invoice', {
      reversibility: { level: 'irreversible', semantics: 'payment', source: 'builtin' },
    });
    // 旧实现：escrow opts 缺席 ⇒ 闸门零行为放行 —— 全部生产调用点都不携 opts，
    // 前置闸门沦为纯配置摆设。ΠΑΝ-8：闸门已武装的部署里不可逆动作绝无裸派发。
    assert.equal(approval.beginAttempt(token), false, '不可逆携带 + 闸门在装 + 裸调用 ⇒ fail-closed');
    const block = escrowBlockOf();
    assert.ok(block);
    assert.equal(block!.reason, 'plan-required');
    assert.match(block!.detail ?? '', /ΠΑΝ-8/);
    assert.equal(approval.status(token).attempts, 0, '拒绝不烧尝试预算');
    assert.equal(approval.status(token).present, true, '拒绝不毁令牌');
    // 携合规预案（hook 认可）⇒ 照常预留
    assert.equal(approval.beginAttempt(token, { escrow: { planId: 'ESC-ANY' } }), true, '携预案的调用不受影响');
    assert.equal(approval.status(token).attempts, 1);
  } finally {
    setDispatchEscrowHook(null);
  }
});

test('ΠΑΝ-8b: 兼容律 —— 闸门未武装（缺省部署）或非 irreversible 携带 ⇒ 裸派发行为逐位不变', () => {
  // 缺省部署：闸门未注册 —— irreversible 携带也照常（配置没承诺托管保护）
  const t1 = grantedPa('send it now', { reversibility: { level: 'irreversible', semantics: 'send-message', source: 'builtin' } });
  assert.equal(approval.beginAttempt(t1), true, '闸门未武装 ⇒ 零行为（既有测试与部署的事实源）');
  approval.attemptFailed(t1, 'no-effect');
  // 闸门武装 + compensable 携带 ⇒ 裸派发照常（ΠΑΝ-8 只针对 irreversible）
  setDispatchEscrowHook(() => ({ ok: true }));
  try {
    const t2 = grantedPa('delete report.docx', { reversibility: { level: 'compensable', semantics: 'file-delete', source: 'builtin' } });
    assert.equal(approval.beginAttempt(t2), true, 'compensable 携带不触发 requirePlan（W7-D2 全链路回归锚）');
  } finally {
    setDispatchEscrowHook(null);
  }
});

test('ΠΑΝ-8c: 示范事件载荷拷贝 —— 观察者改写不毒化审批簿记（旁路面只读契约）', () => {
  armCapture();
  const pa = approval.request('send the email', {
    actionShape: { tool: 'click_mouse', x: 0.5, y: 0.5, target_description: '发送' },
  });
  setDemonstrationObserver(ev => {
    if (ev.actionShape) ev.actionShape.x = 0.999; // 恶意/故障观察者原地改写
    if (ev.amendment) { ev.amendment.note = 'tampered'; ev.amendment.actionShapeCorrection.x = 0.123; }
  });
  // 先铸批注再否决（负示范路径携带 amendment —— 两类可变载荷都经手观察者）
  assert.equal(approval.grantDetailed(pa.token, false, { note: '不要发' }).ok, true);
  assert.notEqual(pa.actionShape?.x, 0.999, '内部 actionShape 未被观察者毒化（拷贝出栈）');
  assert.equal(pa.amendment?.note, '不要发', '内部 amendment 未被毒化');

  // amendmentOf 读取面同样返回拷贝（C1-1 L3 同族修复）：改写返回值不落账
  const { deliveries } = armCapture();
  const pb = approval.request('op with amendment', {
    actionShape: { tool: 'click_mouse', x: 0.5, y: 0.5, target_description: '发送' },
  });
  assert.equal(approval.grantDetailed(pb.token, true, { note: '改点右下角', confirmCode: deliveries[0].confirmCode }).ok, true);
  const am = approval.amendmentOf(pb.token)!;
  am.note = 'TAMPERED';
  am.actionShapeCorrection.x = 0.999;
  assert.equal(approval.amendmentOf(pb.token)!.note, '改点右下角', '读取面返回拷贝 —— 外部改写不毒化账本');
  assert.equal(approval.amendmentOf(pb.token)!.actionShapeCorrection.x, undefined, '字段级拷贝同律');
});
