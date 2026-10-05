// test/tel3.fix.test.ts
// ΤΕΛΟΣ 纪元 工单 ΤΕΛ-3：激活能力限缩令牌的生产铸造面 + 消费点全景复核。
//
// 执法铁律（本册全量覆盖）：
//   · ΤΕΛ-3a 生产铸造绑定：request_approval 携 target ⇒ 铸出的令牌携 targetDigest
//     （macaroon 式 caveat），绑定令牌对不匹配目标 fail-closed 拒绝（拒绝先于
//     簿记变异、不焚毁令牌），匹配目标闭环兑现；
//   · ΤΕΛ-3b 全消费点 inventory：validate/beginAttempt/consume 三面全部携带
//     targetHint（行为级：重放路径兑换闭环；源级：其余工具的接线金丝雀）；
//   · ΤΕΛ-3c 兼容律：不携 target 的铸造路径输出面逐字节保持旧形态（键集锁定），
//     绑定是 opt-in 升级面 —— 未绑定令牌对 hint 免疫（既有行为零变化）。
// 全部用例离线确定性：码从带外 sink 采集、物理派发经假 system 拦截。
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  approval, resetApproval, setConfirmCodeChannel, computeTargetDigest, targetRejectionOf,
  type ConfirmCodeDelivery,
} from '../src/approval.ts';
import { boundTargetOf } from '../src/approval.security.ts';
import { createRequestApprovalTool, createGrantApprovalTool } from '../src/tools/approvalTools.ts';
import { consumeApprovalWithHint } from '../src/tools/clickMouse.ts';
import { replayOneTraced, settleReservedApproval } from '../src/tools/replayActions.ts';
import { SAFETY_GATE_BLOCK } from '../src/tools/actionGate.ts';
import { system } from '../src/system.ts';
import type { Config } from '../src/config.ts';

const here = dirname(fileURLToPath(import.meta.url));
const src = (p: string): string => readFileSync(join(here, '..', 'src', 'tools', p), 'utf8');

// ─── 带外码采集（生产中人类的视角 —— 模型只见 sha256 簿记） ───
const deliveries: ConfirmCodeDelivery[] = [];
function armChannel(): void {
  deliveries.length = 0;
  setConfirmCodeChannel(d => { deliveries.push({ ...d }); });
}
function codeOf(token: string): string {
  return deliveries.find(d => d.token === token)?.confirmCode ?? '';
}

/** 工具执行面便捷转换（w1approval 同律） */
type Exec = (args: unknown) => Promise<string>;
function exec(t: unknown): Exec {
  return (t as unknown as { execute: (a: unknown) => Promise<string> }).execute.bind(t);
}

const cfg = {
  enableApprovalGate: true, enableDemonstrations: false,
  approvalTokenTtlMs: 600_000, approvalMaxAttempts: 5,
} as unknown as Config;

// ─── 假 system：物理派发计数器（重放路径行为级断言的事实源） ───
const originals = {
  getScreenSize: system.getScreenSize.bind(system),
  clickMouse: system.clickMouse.bind(system),
};
let clicks = 0;
function installFakeSystem(): void {
  clicks = 0;
  system.getScreenSize = async () => ({ width: 1920, height: 1080 });
  system.clickMouse = async () => { clicks++; };
}

beforeEach(() => {
  resetApproval(); // 令牌/桶/观察者/带外通道/绑定簿记一并归零
  installFakeSystem();
});
afterEach(() => {
  system.getScreenSize = originals.getScreenSize;
  system.clickMouse = originals.clickMouse;
});

// ═══ ΤΕΛ-3a①：生产铸造绑定闭环（坐标级 click_mouse 方言） ═══

test('ΤΕΛ-3a①: request_approval 携 target ⇒ 令牌携 targetDigest；不匹配 fail-closed 拒绝；匹配闭环兑现', async () => {
  armChannel();
  const reqTool = createRequestApprovalTool(cfg);
  const grantTool = createGrantApprovalTool(cfg);

  // 铸造：模型声明「这次同意买的是什么」（tool + 坐标域 + 目标描述）
  const target = { tool: 'click_mouse', x: 0.42, y: 0.61, target_description: '发送按钮' };
  const reqRaw = await exec(reqTool)({ description: 'click 发送 to submit the email', target });
  const reqOut = JSON.parse(reqRaw);
  assert.equal(reqOut.status, 'PENDING_USER_CONSENT');
  // 绑定事实透明化：state_anchor.target_binding.bound=true；指引声明强制比对
  assert.equal(reqOut.state_anchor.target_binding.bound, true, '铸造面如实申报绑定成立');
  assert.match(reqOut.next_step, /TARGET-BOUND/, '铸造面指引：兑换必须携同一形状');
  const token = reqOut.state_anchor.token as string;

  // ΤΕΛ-3a 核心：铸出的令牌真携 targetDigest（与声明形状的规范化摘要逐字节一致）
  assert.equal(boundTargetOf(token), computeTargetDigest(target), '令牌簿记携带声明目标的规范化摘要');
  assert.equal(approval.status(token).targetBound, true, 'status 面同样申报 targetBound');

  // 授予（用户交码）⇒ 授予回执对绑定令牌如实标注（未绑定路径零新键见 ΤΕΛ-3c①）
  const gRaw = await exec(grantTool)({ token, grant: true, confirm_code: codeOf(token) });
  const gOut = JSON.parse(gRaw);
  assert.equal(gOut.status, 'GRANTED');
  assert.equal(gOut.state_anchor.target_bound, true, '授予回执申报 target_bound');
  assert.match(gOut.next_step, /TARGET-BOUND/);

  // 执法：不匹配目标 fail-closed 拒绝（validate/beginAttempt/consume 三面）
  const drifted = { ...target, x: 0.9 };
  assert.equal(approval.validate(token, drifted), false, '错坐标 ⇒ validate 拒绝');
  const rej = targetRejectionOf();
  assert.ok(rej && rej.token === token, '拒绝透明化在册');
  if (rej) assert.equal(rej.reason, 'target-mismatch', '拒绝成因 = target-mismatch');
  assert.equal(approval.beginAttempt(token, { target: drifted }), false, '错坐标 ⇒ 预留拒绝');
  assert.equal(consumeApprovalWithHint(token, drifted), false, '错坐标 ⇒ 消费拒绝');
  assert.equal(approval.status(token).present, true, '不匹配不焚毁（合法持有者可再来）');

  // 兑换闭环：匹配目标（千分位抖动带内）⇒ 预留 + 验收式消费成功 + 一次性焚毁
  const jittered = { ...target, x: 0.4204, y: 0.6096 }; // 量化到 1/1000 后与声明同桶
  assert.equal(approval.beginAttempt(token, { target: jittered }), true, '抖动带内 ⇒ 预留成功');
  assert.equal(consumeApprovalWithHint(token, jittered), true, '匹配 ⇒ 验收消费成功');
  assert.equal(approval.status(token).present, false, '兑现后焚毁（一次同意恰一次兑现）');
});

// ═══ ΤΕΛ-3a②：描述级绑定（click_element 方言）—— ID 寻址的绑定粒度 ═══

test('ΤΕΛ-3a②: 描述级 target（click_element 方言）铸造绑定 + 元素名匹配兑现', async () => {
  armChannel();
  const reqTool = createRequestApprovalTool(cfg);
  const out = JSON.parse(await exec(reqTool)({
    description: 'click the 归档 button',
    target: { tool: 'click_element', target_description: '归档' },
  }));
  assert.equal(out.state_anchor.target_binding.bound, true);
  const token = out.state_anchor.token as string;
  assert.equal(
    boundTargetOf(token),
    computeTargetDigest({ tool: 'click_element', target_description: '归档' }),
    '描述级绑定：摘要只含 tool+目标描述（坐标缺席不参与）',
  );
  assert.equal(approval.grantDetailed(token, true, { confirmCode: codeOf(token) }).ok, true);
  // 与 clickElement 消费点同形状（tool:'click_element' + 元素名）⇒ 兑换通过
  assert.equal(
    consumeApprovalWithHint(token, { tool: 'click_element', target_description: '归档' }),
    true, '同方言描述 ⇒ 兑换成功',
  );
  // 异方言（click_mouse 同描述）⇒ 摘要不同 ⇒ fail-closed（tool 是能力身份的一部分）
  const req2 = JSON.parse(await exec(reqTool)({
    description: 'click the 归档 button again',
    target: { tool: 'click_mouse', target_description: '归档' },
  }));
  const t2 = req2.state_anchor.token as string;
  approval.grantDetailed(t2, true, { confirmCode: codeOf(t2) });
  assert.equal(
    consumeApprovalWithHint(t2, { tool: 'click_element', target_description: '归档' }),
    false, '跨工具方言 ⇒ 拒绝（同意买的是 click_mouse，不是 click_element）',
  );
});

// ═══ ΤΕΛ-3a③：垃圾 target 防御式（绝不抛 + 诚实申报绑定缺席） ═══

test('ΤΕΛ-3a③: target 为垃圾形态 ⇒ 不抛、令牌按未绑定铸造、输出面如实申报成因', async () => {
  armChannel();
  const reqTool = createRequestApprovalTool(cfg);
  // 对象形语义垃圾（类型合法但无可绑定身份）⇒ execute 内防御式解析：
  // 绑定缺席 + 成因申报（request 宽容面 + 输出面诚实申报，绝不静默降级）
  for (const bad of [{ target_description: 'tool 缺席' }, { tool: '   ' }]) {
    const out = JSON.parse(await exec(reqTool)({ description: 'pay the bill', target: bad }));
    assert.equal(out.status, 'PENDING_USER_CONSENT', `垃圾形态 ${JSON.stringify(bad)} 不炸铸造主流程`);
    assert.equal(out.state_anchor.target_binding.bound, false, '绑定未成立如实申报');
    assert.match(out.state_anchor.target_binding.reason, /invalid-target-shape/, '成因可归因');
    const token = out.state_anchor.token as string;
    assert.equal(boundTargetOf(token), undefined, '簿记无绑定（不铸「看似绑定实则空」的摘要）');
  }
  // 非对象形/嵌套字段类型错 ⇒ dsh-tools schema 边界结构化拒绝（框架
  // fail-closed，与 description 传错类型同一方言 —— 不经 execute，绝不静默放行）
  for (const bad of ['not-an-object', 42, ['array'], { tool: 42, x: 'NaN' }]) {
    await assert.rejects(
      exec(reqTool)({ description: 'pay the bill', target: bad }),
      /invalid arguments/,
      `非对象形态/字段类型错 ${JSON.stringify(bad)} 在框架边界被拒`,
    );
  }
});

// ═══ ΤΕΛ-3c①：兼容律 —— 无 target 的铸造路径输出面逐字节保持旧形态 ═══

test('ΤΕΛ-3c①: 不携 target ⇒ 输出键集与旧形态完全一致（绑定是 opt-in 升级面）', async () => {
  armChannel();
  const reqTool = createRequestApprovalTool(cfg);
  const grantTool = createGrantApprovalTool(cfg);
  const raw = await exec(reqTool)({ description: 'send the report' });
  // 键集锁定：state_anchor 恰含旧七键（token/action/expires_in_seconds/retry_budget/
  // confirm_code_required/confirm_channel/staging）—— 绑定面零渗漏
  const out = JSON.parse(raw);
  assert.deepEqual(
    Object.keys(out.state_anchor).sort(),
    ['action', 'confirm_channel', 'confirm_code_required', 'expires_in_seconds',
      'retry_budget', 'staging', 'token'].sort(),
    '无 target 调用的 state_anchor 键集与接线前逐字节一致',
  );
  assert.ok(!raw.includes('target_binding') && !raw.includes('target_bound') && !raw.includes('TARGET-BOUND'),
    '旧形态文本面零新词');
  const token = out.state_anchor.token as string;
  assert.equal(boundTargetOf(token), undefined, '未绑定（兼容面）');

  // 授予回执同样零新键（target_bound 只对绑定令牌入键）
  const gRaw = await exec(grantTool)({ token, grant: true, confirm_code: codeOf(token) });
  const gOut = JSON.parse(gRaw);
  assert.deepEqual(Object.keys(gOut.state_anchor).sort(), ['granted', 'token'].sort());
  assert.ok(!gRaw.includes('target_bound') && !gRaw.includes('TARGET-BOUND'));

  // 未绑定令牌对 hint 免疫：无 hint 裸消费成功（ΠΑΝ-5 兼容律的运行面证据）
  assert.equal(approval.consume(token), true, '裸 consume 照常成功（未绑定 ⇒ hint 免疫）');
  assert.equal(approval.status(token).present, false, '消费后焚毁（旧语义）');
});

// ═══ ΤΕΛ-3c②：settleReservedApproval 旧签名向后兼容（未绑定令牌零行为） ═══

test('ΤΕΛ-3c②: settleReservedApproval 三参旧签名照常工作（hint 可选 —— 未绑定令牌免疫）', async () => {
  armChannel();
  const pa = approval.request('delete the file');
  approval.grantDetailed(pa.token, true, { confirmCode: codeOf(pa.token) });
  assert.equal(approval.beginAttempt(pa.token), true, '无 opts 的 beginAttempt 照常（旧签名）');
  settleReservedApproval(pa.token, false, 'replay-step-verified'); // 三参旧形态
  assert.equal(approval.status(pa.token).present, false, '旧签名结算照常焚毁');
});

// ═══ ΤΕΛ-3b①：重放路径兑换闭环（行为级 —— 预留/结算双端 hint 接线的执法证据） ═══

test('ΤΕΛ-3b①: 绑定令牌的危险重放步 —— 匹配形状贯通预留+结算；不匹配在闸门 fail-closed', async () => {
  armChannel();
  const gate = { dangerPatterns: 'delete,删除', enableNotarizationLock: false };

  // 绑定令牌：与重放步参数同一形状（tool/x/y/描述 —— replayTargetHintOf 方言）
  const pa = approval.request('删除归档文件', {
    target: { tool: 'click_mouse', x: 0.5, y: 0.5, target_description: '删除' },
  });
  approval.grantDetailed(pa.token, true, { confirmCode: codeOf(pa.token) });

  // 匹配：闸门（ΠΑΝ-114 validate 携 hint）+ beginAttempt（ΤΕΛ-3b 预留面携 hint）
  // + 步终结算 consume（ΤΕΛ-3b 携 hint）全链贯通 —— clicks=1 证明物理派发发生
  const ok = await replayOneTraced({
    tool: 'click_mouse',
    args: { x: 0.5, y: 0.5, target_description: '删除', approval_token: pa.token },
  }, gate);
  assert.equal(ok.line, 'clicked', '绑定令牌 + 匹配形状 ⇒ 重放贯通（预留未被 target-hint-required 拒绝）');
  assert.equal(clicks, 1, '物理派发恰一次');
  assert.deepEqual(
    ok.reservedTargetHint,
    { tool: 'click_mouse', x: 0.5, y: 0.5, target_description: '删除' },
    '预留形状随结果携带（结算 consume 的比对凭据）',
  );
  settleReservedApproval(pa.token, false, 'replay-step-verified', ok.reservedTargetHint);
  assert.equal(approval.status(pa.token).present, false, '绑定令牌以匹配形状验收式兑现（闭环）');

  // 不匹配：绑定到另一坐标 ⇒ 闸门 validate（同标准 hint）先行拒绝 —— fail-closed
  const pb = approval.request('删除另一处文件', {
    target: { tool: 'click_mouse', x: 0.9, y: 0.1, target_description: '删除' },
  });
  approval.grantDetailed(pb.token, true, { confirmCode: codeOf(pb.token) });
  const blocked = await replayOneTraced({
    tool: 'click_mouse',
    args: { x: 0.5, y: 0.5, target_description: '删除', approval_token: pb.token },
  }, gate);
  assert.ok(blocked.line.includes(SAFETY_GATE_BLOCK), '不匹配目标 ⇒ 重放被安全闸门拦截');
  assert.equal(blocked.reservedApprovalToken, undefined, '拦截先于预留（未派发）');
  assert.equal(approval.status(pb.token).present, true, '令牌未焚毁（fail-closed 不等于惩罚持有者）');
});

// ═══ ΤΕΛ-3b②：全消费点 inventory（源级金丝雀 —— 接线的完备性执法） ═══
//
// grep 全部令牌消费点（consume/validate/beginAttempt 调用方）后的登记簿：
//   · clickMouse   consume×2（坐标级）+ beginAttempt（坐标级 target）      —— 已接（ΠΑΝ-36，保持）
//   · actionGate   validate×2（targetHintOf 与 consume 同标准）             —— 已接（ΠΑΝ-114，保持）
//   · pressHotkey  consume（描述级 {tool,context_description}）             —— 已接（ΠΑΝ-12，保持）
//   · dragMouse    consume×2（描述级）+ beginAttempt                        —— 本波补齐 beginAttempt
//   · clickElement beginAttempt + consume×2（描述级 click_element 方言）    —— 本波补齐全三处
//   · replayActions/skillTools beginAttempt + 步终结算 consume              —— 本波补齐全链
//   · guards/canaryLogic validate —— 让位探针（在场性探测，非兑现点；绑定令牌
//     ⇒ validate false ⇒ 金丝雀照常试演，fail-closed 方向；guards/ 非本工单领地，报告申报）
test('ΤΕΛ-3b②: 全消费点 inventory —— 每一处兑换面都携 targetHint（源级金丝雀）', () => {
  const approvalTools = src('approvalTools.ts');
  const clickMouse = src('clickMouse.ts');
  const dragMouse = src('dragMouse.ts');
  const clickElement = src('clickElement.ts');
  const pressHotkey = src('pressHotkey.ts');
  const replayActions = src('replayActions.ts');
  const skillTools = src('skillTools.ts');
  const actionGate = src('actionGate.ts');

  // ΤΕΛ-3a 生产铸造面：target 透传 approval.request 的 opts.target
  assert.match(approvalTools, /\.\.\.\(mintTarget !== undefined \? \{ target: mintTarget \} : \{\}\)/,
    'request_approval 把模型声明透传到 request 的 opts.target');

  // clickMouse（已接保持）：consume 坐标级 ×2 + beginAttempt 坐标级
  assert.equal((clickMouse.match(/consumeApprovalWithHint\(approval_token, \{ tool: 'click_mouse', x, y/g) ?? []).length, 2,
    'clickMouse 两处验收消费均为坐标级 hint');
  assert.match(clickMouse, /beginAttempt\(approval_token, \{[\s\S]*?target: \{\s*\n\s*tool: 'click_mouse', x, y/,
    'clickMouse 派发预留携坐标级 target');

  // dragMouse（本波补齐）：beginAttempt 携与消费点同形状的描述级 target
  assert.match(dragMouse, /beginAttempt\(approval_token, \{\s*\n\s*target: \{ tool: 'drag_mouse', target_description: effTarget \},\s*\n\s*\}\)\)/,
    'dragMouse 派发预留携描述级 target（与 consume 同形状）');
  assert.equal((dragMouse.match(/consumeApprovalWithHint\(approval_token, \{ tool: 'drag_mouse', target_description: effTarget \}\)/g) ?? []).length, 2,
    'dragMouse 两处验收消费保持描述级 hint');

  // clickElement（本波补齐）：beginAttempt + consume×3 全部描述级 click_element 方言
  assert.match(clickElement, /beginAttempt\(approval_token, \{\s*\n\s*target: \{ tool: 'click_element', target_description: effTargetName \},\s*\n\s*\}\)\)/,
    'clickElement 派发预留携描述级 target');
  assert.equal((clickElement.match(/consumeApprovalWithHint\(approval_token, \{ tool: 'click_element', target_description: effTargetName \}\)/g) ?? []).length, 2,
    'clickElement 两处验收消费统一落点 + 描述级 hint');

  // pressHotkey（已接保持）：consume 描述级
  assert.match(pressHotkey, /consumeApprovalWithHint\(approval_token, \{ tool: 'press_hotkey', target_description: context_description \}\)/,
    'pressHotkey 验收消费保持描述级 hint');

  // replayActions（本波补齐）：beginAttempt 携 hint + 结算 consume 携 hint
  assert.match(replayActions, /approval\.beginAttempt\(String\(a\.approval_token\), \{ target: hint \}\)/,
    '重放步派发预留携 targetHint');
  assert.match(replayActions, /approval\.consume\(token, hint\)/,
    '步终结算 consume 携 hint（绑定令牌的比对凭据）');
  assert.match(replayActions, /outcome\.reservedTargetHint/, '步循环结算透传预留形状');
  assert.match(skillTools, /outcome\.reservedTargetHint/, 'run_skill 结算透传预留形状');

  // actionGate（ΠΑΝ-114 已接保持）：validate 两处携 targetHintOf
  assert.equal((actionGate.match(/approval\.validate\(approval_token, (targetHintOf\(kind, a\)|hotkeyHint)\)/g) ?? []).length, 2,
    '闸门两处 validate 携与 consume 同标准的 hint');

  // 完备性执法：src/tools 下不存在裸 consume/beginAttempt（无第二参的兑换面）。
  // 判据：每个调用点的实参表都含第二参（`, {` / `, hint`）—— 带 opts 的调用数
  // 必须等于总调用数（String(a.approval_token) 内嵌括号不干扰：语句内无分号）。
  for (const f of ['clickMouse.ts', 'dragMouse.ts', 'clickElement.ts', 'pressHotkey.ts', 'replayActions.ts']) {
    const text = src(f);
    const totalConsume = (text.match(/approval\.consume\(/g) ?? []).length;
    const armedConsume = (text.match(/approval\.consume\([^;]*?,/g) ?? []).length;
    assert.equal(armedConsume, totalConsume, `${f} 的 approval.consume 全部携比对凭据（无裸调用）`);
    const totalBegin = (text.match(/approval\.beginAttempt\(/g) ?? []).length;
    const armedBegin = (text.match(/approval\.beginAttempt\([^;]*?,\s*\{/g) ?? []).length;
    assert.equal(armedBegin, totalBegin, `${f} 的 approval.beginAttempt 全部携比对凭据（无裸调用）`);
  }
});
