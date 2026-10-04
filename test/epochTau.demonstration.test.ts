// test/epochTau.demonstration.test.ts
// Τ 纪元（干预即教育）：审批事件蒸馏的执法测试。
// 人机交互研究的经典事实：用户干预（拒绝/手动接手）是最贵的监督信号，业界 agent
// 全部把它扔掉。Τ 把审批事件变成教育事件：
//   验收式消费成功 = 特权正示范（用户亲自背书且世界验证成功 —— 强化技能信任）；
//   用户拒绝      = 负示范（这条路用户不让走 —— 喂回避记忆）。
// 铁律执法：隐私（Τ-3 —— type_text 只记工具名+长度桶，tokenId 只出哈希前 8 位）、
// 旁路（Τ-4 —— 教育失败绝不炸审批主流程）、零回归（Τ-5 —— 生命周期语义逐字段一致）。
// 预算注记：Y-10 同意速率桶容量 3（10min 回填），每个用例的 grant(true) ≤ 3 次。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  approval, resetApproval, setDemonstrationObserver, configureDemonstrations,
  setConfirmCodeChannel, type DemonstrationEvent, type ConfirmCodeDelivery,
} from '../src/approval.ts';
import { skillLibrary } from '../src/skillLibrary.ts';
import {
  createRequestApprovalTool, createGrantApprovalTool,
} from '../src/tools/approvalTools.ts';
import type { Config } from '../src/config.ts';

beforeEach(() => {
  resetApproval(); // 含 Τ 观察者面归零（observer=null、开关回默认 true）
  skillLibrary.reset();
  skillLibrary.configure(true, '', 50); // 内存库（零落盘 —— 测试离线确定性）
});

/** W6R fail-closed：带外码采集 sink —— 授予须携码（无码 grant 已废除；
 *  采集 sink 正是生产中人类读码的视角）。 */
const oobSink: ConfirmCodeDelivery[] = [];
function armOob(): void {
  oobSink.length = 0;
  setConfirmCodeChannel(d => { oobSink.push({ ...d }); });
}
function oobCodeOf(token: string): string | undefined {
  return oobSink.find(d => d.token === token)?.confirmCode;
}
/** 携码授予（对旧 approval.grant(token, true) 的等价替换面） */
function grantOob(token: string): boolean {
  return approval.grantDetailed(token, true, { confirmCode: oobCodeOf(token) }).ok;
}

/** 观察者工厂：既收集事件（断言面）又喂技能库蒸馏（对齐生产接线 ——
 *  approvalTools.wireDemonstrationEducation 的观察者正是「采集+喂库」一体）。 */
function collect(): { events: DemonstrationEvent[]; fn: (ev: DemonstrationEvent) => void } {
  const events: DemonstrationEvent[] = [];
  return {
    events,
    fn: ev => {
      events.push(ev);
      skillLibrary.learnFromDemonstration(ev);
    },
  };
}

// ─── Τ-1 正示范：验收式消费成功 = 用户背书 + 世界验证 ───

test('Τ-1a: consume 成功 ⇒ approval-consumed；匹配技能可靠度 +β 且来源注记在册', () => {
  const skill = skillLibrary.induce('click 发送 submit the email', [
    { tool: 'click_mouse', args: { x: 0.62, y: 0.2 } },
  ])!;
  const before = skillLibrary.match('click 发送 submit the email', undefined, 3);
  assert.equal(before.length, 1, '前置：技能可被匹配');

  const { events, fn } = collect();
  setDemonstrationObserver(fn);
  armOob(); // W6R：授予须带外码
  const pa = approval.request('click 发送 to submit the email', {
    actionShape: { tool: 'click_mouse', x: 0.6204, y: 0.2, target_description: '发送 button' },
    sceneFingerprint: 'f'.repeat(64),
  });
  assert.equal(grantOob(pa.token), true, '主流程：授予');
  assert.equal(approval.consume(pa.token), true, '主流程：验收式消费成功');

  assert.equal(events.length, 1, '旁路：恰好一次正示范事件（拒绝/失败路径均不发射）');
  const ev = events[0];
  assert.equal(ev.kind, 'approval-consumed');
  assert.equal(ev.actionShape?.tool, 'click_mouse', '动作形状携带工具名');
  assert.equal(ev.actionShape?.x, 0.62, '归一化坐标（千分位量化后）');
  assert.equal(ev.actionShape?.target_description, '发送 button', '目标描述随行');
  assert.equal(ev.sceneFingerprint, 'f'.repeat(64), '铸造时快照的屏幕指纹随行');
  assert.match(ev.tokenId, /^[0-9a-f]{8}$/, 'tokenId 只出 sha256 前 8 位');

  const after = skillLibrary.get(skill.id)!;
  assert.ok(Math.abs((after.demoBonus ?? 0) - 0.15) < 1e-9,
    '可靠度 +β 特权加成（用户背书+世界验证的双重证据，等级高于自动归纳）');
  assert.equal(after.demoEndorsed, 1, '来源注记在册（正示范计数）');
  assert.equal(skillLibrary.demonstrationStats().reinforced, 1, '蒸馏统计如实入账');

  const hits = skillLibrary.match('click 发送 submit the email', undefined, 3);
  assert.ok(hits[0].score > before[0].score, 'match 可靠度通道消费加成：分数上移');
  assert.ok(Math.abs((hits[0] as any).demo_bonus - 0.15) < 1e-9, '透明面：demo_bonus 可见');
});

test('Τ-1b: 无匹配技能 ⇒ 不伪造新技能（单例不足以成技），仅计数', () => {
  const { events, fn } = collect();
  setDemonstrationObserver(fn);
  armOob(); // W6R：授予须带外码
  const pa = approval.request('pay the invoice', {
    actionShape: { tool: 'drag_mouse', x: 0.1, y: 0.9, target_description: 'drag to trash' },
  });
  grantOob(pa.token);
  approval.consume(pa.token);

  assert.equal(events.length, 1);
  assert.equal(skillLibrary.list().length, 0, '空库不新建技能（诚实 —— 单例不足以成技）');
  assert.equal(skillLibrary.demonstrationStats().unmatched, 1, '仅计数');
  assert.equal(skillLibrary.demonstrationStats().reinforced, 0, '无技能被强化');
});

// ─── Τ-2 负示范：用户拒绝 = 这条路用户不让走 ───

test('Τ-2a: grant(false) ⇒ approval-denied；匹配技能降可靠度 + denied 标记；回避入册且 match 降序', () => {
  const denied = skillLibrary.induce('click 删除 delete the record', [
    { tool: 'click_mouse', args: { x: 0.3, y: 0.3 } },
  ])!;
  const other = skillLibrary.induce('click 删除 delete the record via menu', [
    { tool: 'click_mouse', args: { x: 0.7, y: 0.7 } },
  ])!;
  for (let i = 0; i < 8; i++) skillLibrary.recordOutcome(denied.id, true); // 9/9 ⇒ 否决前必排第一
  const before = skillLibrary.match('delete the record', undefined, 5);
  assert.equal(before[0].id, denied.id, '前置：高可靠技能排第一');

  const { events, fn } = collect();
  setDemonstrationObserver(fn);
  const pa = approval.request('delete the record', {
    // target_description 刻意不与其余技能描述词面重合（'wipe it'）—— 负示范经
    // 签名通道（同工具+坐标近邻）命中目标技能，文本通道不误伤无辜
    actionShape: { tool: 'click_mouse', x: 0.3, y: 0.3, target_description: 'wipe it' },
  });
  assert.equal(approval.grant(pa.token, false), true, '主流程：拒绝路径返回 true 且作废');

  assert.equal(events.length, 1, '旁路：恰好一次负示范事件');
  assert.equal(events[0].kind, 'approval-denied');
  const s = skillLibrary.get(denied.id)!;
  assert.ok(Math.abs((s.demoBonus ?? 0) + 0.15) < 1e-9, '可靠度 −β（用户否决）');
  assert.equal(s.demoDenied, 1, 'denied 标记在册');

  const shapes = skillLibrary.deniedShapes();
  assert.equal(shapes.length, 1, '回避注记入册');
  assert.equal(shapes[0].tool, 'click_mouse');
  assert.equal(shapes[0].x, 0.3, '回避形状保留归一化坐标');

  const after = skillLibrary.match('delete the record', undefined, 5);
  assert.equal(after[0].id, other.id, 'match 排序降序：用户不让走的路排后面');
  const deniedIdx = after.findIndex(h => h.id === denied.id);
  assert.ok(deniedIdx > 0, `被否决技能降档（位置 ${deniedIdx} > 0）`);
  assert.equal((after[deniedIdx] as any).demo_denied, true, '透明面：denied 标记可见');
});

test('Τ-2b: 生产接线 —— grant_approval 拒绝路径附 education 注记（既有字段不变）', async () => {
  const cfg = { enableApprovalGate: true, enableDemonstrations: true } as unknown as Config;
  const reqTool = createRequestApprovalTool(cfg);   // 装配即接线（观察者→技能库蒸馏）
  const grantTool = createGrantApprovalTool(cfg);
  const exec = (t: unknown) => (t as unknown as { execute: (a: unknown) => Promise<string> }).execute;
  armOob(); // W6R：授予（grant=true）须带外码；拒绝路径无需人证

  const reqOut = JSON.parse(await exec(reqTool)({ description: 'delete the temp folder' }));
  assert.equal(reqOut.status, 'PENDING_USER_CONSENT', '既有字段不变');
  const out = JSON.parse(await exec(grantTool)({ token: reqOut.state_anchor.token, grant: false }));
  assert.equal(out.status, 'REVOKED', '既有字段不变');
  assert.ok(out.state_anchor && out.next_step, '既有字段（state_anchor/next_step）不变');
  assert.match(out.education_note, /已教育：回避 1 条/, '透明性：教育注记在场');
  assert.equal(skillLibrary.deniedShapes().length, 1, '生产路径：拒绝形状入回避注记');

  // 对照一：grant(true) 的注记是诚实的前瞻披露（此刻教育尚未发生，绝不冒充计数）
  const req2 = JSON.parse(await exec(reqTool)({ description: 'send the report' }));
  const g2 = JSON.parse(await exec(grantTool)({
    token: req2.state_anchor.token, grant: true, confirm_code: oobCodeOf(req2.state_anchor.token),
  }));
  assert.equal(g2.status, 'GRANTED', '既有字段不变');
  assert.match(g2.education_note, /待验收/, '授予时刻：教育待验收（诚实）');

  // 对照二：enableDemonstrations 关 ⇒ 零行为（无注记、无学习、无回避入册）
  const cfgOff = { enableApprovalGate: true, enableDemonstrations: false } as unknown as Config;
  const reqOff = createRequestApprovalTool(cfgOff);
  const grantOff = createGrantApprovalTool(cfgOff);
  const r3 = JSON.parse(await exec(reqOff)({ description: 'erase everything' }));
  const g3 = JSON.parse(await exec(grantOff)({ token: r3.state_anchor.token, grant: false }));
  assert.equal(g3.status, 'REVOKED');
  assert.equal(g3.education_note, undefined, '关闭时无教育注记（零行为）');
  assert.equal(skillLibrary.deniedShapes().length, 1, '关闭时回避清单不再增长');
});

// ─── Τ-3 隐私铁律：示范记录绝不含文本内容；tokenId 只出哈希前缀 ───

test('Τ-3: type_text 示范只含工具名+长度桶；tokenId 截断 8 位；蒸馏面二次脱敏', () => {
  const { events, fn } = collect();
  setDemonstrationObserver(fn);
  armOob(); // W6R：授予须带外码
  const SECRET = 'Hunter2-Secret-密码';
  const pa = approval.request('type the password', {
    actionShape: {
      tool: 'type_text', text: SECRET, x: 0.5, y: 0.5,
      target_description: 'password field',
    },
  });
  grantOob(pa.token);
  approval.consume(pa.token);

  assert.equal(events.length, 1);
  const ev = events[0];
  const json = JSON.stringify(ev);
  assert.ok(!json.includes('Hunter2') && !json.includes('Secret') && !json.includes('密码'),
    '示范记录绝不含文本内容');
  assert.ok(!json.includes('password field'), 'type_text 类连目标描述也不带（最保守脱敏）');
  assert.equal(ev.actionShape?.tool, 'type_text', '只记工具名');
  assert.equal(ev.actionShape?.text_length_bucket, 'medium', '与长度桶（17 字 ⇒ medium）');
  assert.equal(ev.actionShape?.x, undefined, '坐标不带（type_text 唯二保留：工具名+长度桶）');
  assert.ok(!json.includes(pa.token), '完整令牌不出审批模块');
  assert.match(ev.tokenId, /^[0-9a-f]{8}$/, 'tokenId 只出 sha256 前 8 位');
  assert.ok(!JSON.stringify(pa).includes('Hunter2'), 'PendingApproval 簿记在铸造点即脱敏');

  // 拒绝路径同律：denied 的 type_text 形状也不含内容
  const pb = approval.request('type it again', {
    actionShape: { tool: 'type_text', text: 'Hunter2-again', target_description: 'same field' },
  });
  approval.grant(pb.token, false);
  assert.equal(events.length, 2);
  assert.ok(!JSON.stringify(events[1]).includes('Hunter2'), '负示范同样脱敏');

  // 蒸馏面二次脱敏：直调调用方绕过铸造点喂生形状，learnFromDemonstration 仍不落内容
  skillLibrary.learnFromDemonstration({
    kind: 'approval-denied', tokenId: 'abcd1234',
    actionShape: { tool: 'type_text', text: 'RAW-SECRET', target_description: 'x' } as never,
  });
  const deniedJson = JSON.stringify(skillLibrary.deniedShapes());
  assert.ok(!deniedJson.includes('RAW-SECRET'), '蒸馏面防御性二次脱敏（LRU 清单不含原文）');
  assert.ok(deniedJson.includes('type_text'), '清单保留工具名（回避仍然可用）');
});

// ─── Τ-4 开关与旁路：教育失败绝不炸审批主流程 ───

test('Τ-4: 观察者 throw ⇒ 主流程照常；关闭 ⇒ 观察者零调用；缺席 ⇒ 零行为', () => {
  let calls = 0;
  setDemonstrationObserver(() => { calls += 1; throw new Error('education pipeline exploded'); });
  armOob(); // W6R：授予须带外码
  const pa = approval.request('send it', { actionShape: { tool: 'click_mouse', x: 0.5, y: 0.5 } });
  assert.equal(grantOob(pa.token), true, '旁路异常不炸 grant');
  assert.equal(approval.consume(pa.token), true, '旁路异常不炸 consume（返回值不受影响）');
  assert.equal(calls, 1, 'throw 也算一次调用（异常被吞 —— 旁路义务）');
  const pb = approval.request('send it again', { actionShape: { tool: 'click_mouse', x: 0.5, y: 0.5 } });
  assert.equal(approval.grant(pb.token, false), true, '旁路异常不炸拒绝路径');
  assert.equal(calls, 2);

  // 开关关闭 ⇒ 正/负示范全部静默（零行为）
  configureDemonstrations(false);
  let zero = 0;
  setDemonstrationObserver(() => { zero += 1; });
  const pc = approval.request('pay now', { actionShape: { tool: 'click_mouse', x: 0.5, y: 0.5 } });
  grantOob(pc.token);
  approval.consume(pc.token);
  const pd = approval.request('pay later', { actionShape: { tool: 'click_mouse', x: 0.5, y: 0.5 } });
  approval.grant(pd.token, false);
  assert.equal(zero, 0, 'enableDemonstrations 关 ⇒ 观察者零调用');

  // 观察者缺席（null）⇒ 零行为，主流程照常
  setDemonstrationObserver(null);
  const pe = approval.request('pay never', { actionShape: { tool: 'click_mouse', x: 0.5, y: 0.5 } });
  grantOob(pe.token);
  assert.equal(approval.consume(pe.token), true, '无观察者：消费照常成功');
});

// ─── Τ-5 既有语义零回归：教育在环时，生命周期逐字段与旧版一致 ───

test('Τ-5a: 请求≠同意 + 验收失败保留/续期/超限焚毁（失败路径零示范事件）', () => {
  const { events, fn } = collect();
  setDemonstrationObserver(fn); // 教育全程在环：任何回归都会炸主流程或漏事件
  armOob(); // W6R：授予须带外码
  const pa = approval.request('send email to Alice', { ttlMs: 60_000, maxAttempts: 2 });
  assert.ok(pa.token.startsWith('APR-'));
  assert.equal(approval.validate(pa.token), false, '请求 ≠ 同意（J-1：未授予不放行）');
  assert.equal(approval.consume(pa.token), false, '未授予不得被消费');

  // V 序列（新令牌 —— 上面的拒绝性消费已焚毁 pa，这正是「用后即焚」的语义）
  const pv = approval.request('send email to Alice (retry)', { ttlMs: 60_000, maxAttempts: 2 });
  assert.equal(grantOob(pv.token), true);
  const r1 = approval.attemptFailed(pv.token, 'no-effect');
  assert.equal(r1.valid, true, '未生效的尝试不消耗同意');
  assert.equal(r1.remainingAttempts, 1, '剩余预算 = 1');
  assert.ok(r1.reArmedMs > 0, '续期窗口在');
  assert.equal(approval.validate(pv.token), true, '令牌保留可重试');
  const r2 = approval.attemptFailed(pv.token, 'no-effect');
  assert.equal(r2.valid, true, '第 2 次 = 上限，仍保留');
  const r3 = approval.attemptFailed(pv.token, 'no-effect');
  assert.deepEqual(r3, { valid: false, remainingAttempts: 0, reArmedMs: 0, reason: 'no-effect' },
    '超限焚毁（逐字段一致）');
  assert.equal(approval.validate(pv.token), false);
  assert.equal(approval.consume(pv.token), false, '焚毁后不得消费');
  assert.equal(events.length, 0, '失败路径零示范事件（教育只在两个语义点发射）');
});

test('Τ-5b: consume 恰一次 + beginAttempt 预留/结算时序（双花封堵不回归）', () => {
  const { events, fn } = collect();
  setDemonstrationObserver(fn);
  armOob(); // W6R：授予须带外码
  const pb = approval.request('click Send', { actionShape: { tool: 'click_mouse', x: 0.5, y: 0.5 } });
  grantOob(pb.token);
  assert.equal(approval.consume(pb.token), true, '第一次：有效');
  assert.equal(approval.consume(pb.token), false, '第二次：已焚毁');

  const pc = approval.request('submit order', { maxAttempts: 3, actionShape: { tool: 'click_mouse', x: 0.5, y: 0.5 } });
  grantOob(pc.token);
  assert.equal(approval.beginAttempt(pc.token), true, '派发前预留成功');
  assert.equal(approval.beginAttempt(pc.token), false, '在途预留未结算：并发双花拒绝');
  const rf = approval.attemptFailed(pc.token, 'no-effect');
  assert.equal(rf.valid, true);
  assert.equal(rf.remainingAttempts, 2, 'beginAttempt 已计数，attemptFailed 只结算不重复 ++');
  assert.equal(approval.beginAttempt(pc.token), true, '结算后可再预留');
  assert.equal(approval.consume(pc.token), true, '验收通过：焚毁');
  assert.equal(events.length, 2, '恰两次正示范事件（两次消费成功，别处零发射）');
});

test('Τ-5c: 拒绝路径 + status 面 + TTL 过期（拒绝恰一次事件，过期消费零事件）', () => {
  const { events, fn } = collect();
  setDemonstrationObserver(fn);
  armOob(); // W6R：授予须带外码
  const pd = approval.request('format disk');
  assert.equal(approval.grant(pd.token, false), true, 'grant(false) 返回 true（在场即作废）');
  assert.equal(approval.validate(pd.token), false, '立即作废');

  const pe = approval.request('click 发送');
  grantOob(pe.token);
  assert.deepEqual(approval.status('APR-NONSENSE'), { present: false, granted: false, expired: false },
    '缺席令牌的 status 逐字段一致');
  let st = approval.status(pe.token);
  assert.equal(st.present, true);
  assert.equal(st.remainingAttempts, 5, '缺省预算 5');
  approval.attemptFailed(pe.token, 'no-effect');
  st = approval.status(pe.token);
  assert.equal(st.attempts, 1);
  assert.equal(st.remainingAttempts, 4);

  const pf = approval.request('expire me', { ttlMs: 2_000 });
  grantOob(pf.token);
  const origNow = Date.now;
  try {
    Date.now = () => origNow() + 3_000; // 时钟前拨 —— 不真睡
    assert.equal(approval.validate(pf.token), false, 'TTL 过期不放行');
    assert.equal(approval.consume(pf.token), false, '过期消费拒绝（且焚毁僵尸令牌）');
  } finally {
    Date.now = origNow;
  }
  assert.equal(approval.validate(pf.token), false);
  assert.equal(events.length, 1, '恰一次负示范事件（拒绝）；过期消费不发射');
  assert.equal(events[0].kind, 'approval-denied');
});
