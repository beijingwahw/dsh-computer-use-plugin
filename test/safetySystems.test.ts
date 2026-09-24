// test/safetySystems.test.ts
// 安全与自愈子系统：一次性审批令牌 / 失败记忆 / 振荡检测 / 风险词闸门。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { approval, resetApproval } from '../src/approval.ts';
import { failureMemory } from '../src/failureMemory.ts';
import { oscillationTracker } from '../src/oscillationTracker.ts';
import { matchesRiskPatterns, matchesDangerPatterns, parseRiskPatterns } from '../src/riskGate.ts';

beforeEach(() => {
  failureMemory.reset();
  oscillationTracker.reset();
  // V 纪元：审批簿记（含 Y-10 同意速率桶）随用例归零 —— grant 是全文件共享的
  // 有限资源，不重置则第 4 个用到 grant 的用例会被限流误伤
  resetApproval();
});

// ─── 一次性审批令牌 ───

test('approval: 令牌一次性（用后即焚；J 纪元：须先 grant）', () => {
  const pa = approval.request('send email to Alice');
  assert.ok(pa.token.startsWith('APR-'));
  assert.equal(approval.validate(pa.token), false, '未授予的令牌不可放行（请求≠同意）');
  approval.grant(pa.token, true);
  assert.equal(approval.consume(pa.token), true);  // 第一次：有效
  assert.equal(approval.consume(pa.token), false); // 第二次：已焚毁
});

test('approval: revoke 立即作废；伪造令牌一律拒绝', () => {
  const pa = approval.request('delete database');
  approval.revoke(pa.token);
  assert.equal(approval.consume(pa.token), false);
  assert.equal(approval.consume('APR-FAKE1234'), false);
  assert.equal(approval.consume(''), false);
});

// ─── V 纪元：验收式消费（一次确认覆盖整个任务） ───
// 场景回归：发一封邮件被问三次 yes —— 点击落错窗口（无效果）也烧令牌。
// 新语义：未生效的尝试不消耗同意，令牌保留可重试；验收通过才焚毁。

test('approval V: 验收失败保留令牌（同一次同意内免二次确认地重试）', () => {
  const pa = approval.request('click 发送 to submit the email');
  approval.grant(pa.token, true);
  // 第一次点击落错窗口：世界没有变化 —— 令牌必须还在
  const r1 = approval.attemptFailed(pa.token, 'no-effect');
  assert.equal(r1.valid, true, '未生效的尝试不得消耗用户的同意');
  assert.ok(r1.remainingAttempts >= 1);
  assert.equal(approval.validate(pa.token), true, '令牌仍可放行重试');
  // 第二次仍未生效：继续保留
  const r2 = approval.attemptFailed(pa.token, 'no-effect');
  assert.equal(r2.valid, true);
  assert.equal(approval.validate(pa.token), true);
  // 第三次点击验收通过（世界出现预期变化）：焚毁
  assert.equal(approval.consume(pa.token), true);
  assert.equal(approval.validate(pa.token), false, '验收通过后用后即焚');
});

test('approval V: 重试预算耗尽 ⇒ 焚毁并要求重新审批', () => {
  const pa = approval.request('click Send', { maxAttempts: 2 });
  approval.grant(pa.token, true);
  assert.equal(approval.attemptFailed(pa.token, 'no-effect').valid, true);
  assert.equal(approval.attemptFailed(pa.token, 'no-effect').valid, true); // 第 2 次 = 上限
  const r3 = approval.attemptFailed(pa.token, 'no-effect');                // 第 3 次：超限
  assert.equal(r3.valid, false, '超限尝试后令牌焚毁');
  assert.equal(approval.validate(pa.token), false);
  assert.equal(approval.consume(pa.token), false);
});

test('approval V: 验收失败续期 TTL，但不可越过生命周期硬顶', () => {
  const pa = approval.request('click 支付', { ttlMs: 60_000 }); // 硬顶 = 180s
  approval.grant(pa.token, true);
  const before = pa.expiresAt;
  approval.attemptFailed(pa.token, 'no-effect');
  assert.ok(pa.expiresAt >= before, '失败重试续期：有效期不缩短');
  // 反复失败直至硬顶：续期被 cap 住，令牌最终过期焚毁
  for (let i = 0; i < 10; i++) approval.attemptFailed(pa.token, 'no-effect');
  assert.ok(pa.expiresAt <= pa.lifetimeCapAt + 1, '续期不越生命周期硬顶');
});

test('approval V: 未授予的令牌 attemptFailed 不放行', () => {
  const pa = approval.request('click 删除');
  const r = approval.attemptFailed(pa.token, 'no-effect');
  assert.equal(r.valid, false, '请求≠同意：未 grant 的令牌不可借重试通道续命');
  assert.equal(approval.validate(pa.token), false);
});

test('approval V: TTL / 重试预算可由部署配置注入（缺省 10min × 5 次）', () => {
  const pa = approval.request('click 提交订单');
  assert.ok(pa.ttlMs >= 600_000 - 5_000, '缺省 TTL 覆盖整个任务窗口（≈10min）');
  assert.equal(pa.maxAttempts, 5);
  const custom = approval.request('x', { ttlMs: 2_000, maxAttempts: 1 });
  assert.equal(custom.ttlMs, 2_000);
  assert.equal(custom.maxAttempts, 1);
});

test('approval V: status 暴露剩余重试预算（锚点透明化）', () => {
  const pa = approval.request('click 发送');
  approval.grant(pa.token, true);
  let st = approval.status(pa.token);
  assert.equal(st.remainingAttempts, 5);
  approval.attemptFailed(pa.token, 'no-effect');
  st = approval.status(pa.token);
  assert.equal(st.attempts, 1);
  assert.equal(st.remainingAttempts, 4);
});

// ─── 失败记忆（Anti-Skill） ───

test('failureMemory: 同查询同路径 5 分钟内去重', () => {
  failureMemory.record('open settings', 'click_mouse(x=0.9)', 'no effect');
  failureMemory.record('open settings', 'click_mouse(x=0.9)', 'no effect');
  assert.equal(failureMemory.size, 1);

  failureMemory.record('open settings', 'press_hotkey(tab)', 'popup blocked');
  assert.equal(failureMemory.size, 2);
});

test('failureMemory: match 按文本重合召回已知死路', () => {
  failureMemory.record('open settings panel', 'click_mouse(x=0.9,y=0.05)', 'no visual change');
  const hits = failureMemory.match('how to open settings');
  assert.ok(hits.length >= 1);
  assert.ok(hits[0].approach.includes('click_mouse'));
});

// ─── 振荡检测 ───

test('oscillationTracker: 同指纹重复出现 ⇒ 告警一次后清环', () => {
  const h = '1111000011110000';
  let alarm: string | null = null;
  for (let i = 0; i < 3; i++) alarm = oscillationTracker.observe(h);
  assert.ok(alarm?.includes('OSCILLATION'), '第三次同指纹应告警');
  // 告警后清环：再观察一次同指纹不应立即再响
  assert.equal(oscillationTracker.observe(h), null);
});

test('oscillationTracker: 变化序列不误报（K 纪元：互异 = 距离 > 容差）', () => {
  for (let i = 0; i < 8; i++) {
    const alarm = oscillationTracker.observe('0'.repeat(i * 8) + '1'.repeat(64 - i * 8));
    assert.equal(alarm, null);
  }
});

// ─── 风险/危险词闸门 ───

test('riskGate: 凭据词中英命中，正常文本放行', () => {
  const csv = 'password,密码,otp';
  assert.equal(matchesRiskPatterns('Please enter password here', csv), true);
  assert.equal(matchesRiskPatterns('输入密码后登录', csv), true);
  assert.equal(matchesRiskPatterns('search for cats', csv), false);
  assert.equal(matchesRiskPatterns('', csv), false); // 空文本安全
  assert.deepEqual(parseRiskPatterns(' a , b ,,, c '), ['a', 'b', 'c']);
});

test('dangerGate: 不可逆词触发审批需求', () => {
  assert.equal(matchesDangerPatterns('click 发送 button', ''), true);
  assert.equal(matchesDangerPatterns('click the Send button', ''), true);
  assert.equal(matchesDangerPatterns('click Cancel button', ''), false);
});
