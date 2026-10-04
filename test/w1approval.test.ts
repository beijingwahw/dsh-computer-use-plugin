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
