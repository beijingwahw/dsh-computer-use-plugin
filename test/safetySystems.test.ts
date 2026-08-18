// test/safetySystems.test.ts
// 安全与自愈子系统：一次性审批令牌 / 失败记忆 / 振荡检测 / 风险词闸门。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { approval } from '../src/approval.ts';
import { failureMemory } from '../src/failureMemory.ts';
import { oscillationTracker } from '../src/oscillationTracker.ts';
import { matchesRiskPatterns, matchesDangerPatterns, parseRiskPatterns } from '../src/riskGate.ts';

beforeEach(() => {
  failureMemory.reset();
  oscillationTracker.reset();
});

// ─── 一次性审批令牌 ───

test('approval: 令牌一次性（用后即焚）', () => {
  const pa = approval.request('send email to Alice');
  assert.ok(pa.token.startsWith('APR-'));
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

test('oscillationTracker: 变化序列不误报', () => {
  for (let i = 0; i < 10; i++) {
    const alarm = oscillationTracker.observe('h'.repeat(16) + i);
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
