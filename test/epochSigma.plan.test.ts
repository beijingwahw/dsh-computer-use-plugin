// test/epochSigma.plan.test.ts
// Σ 纪元（Σ-4 计划自愈）：runOrchestrator 的 fail-fast 短路前先给一次
// 带失败上下文的重规划机会（闭包守卫 replannedOnce：一次性）。
// 全离线注入：假 chat 按调用次数分派（首次 planTasks / 二次重规划），
// 假 actor 按调用序返回成败 —— 零宿主耦合，零网络。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runOrchestrator, type ActorFn, type ChatFn } from '../src/orchestrator.ts';

// ─── Σ-4① 首败自愈：[Replan] 接管，两组子任务都执行，终局报告无未解决 [FAILED] ───

test('Σ-4①: 第 1 个子任务失败 ⇒ 带上下文重规划一次，新计划接管，报告自愈成功', async () => {
  const actorCalls: string[] = [];
  let chatCalls = 0;
  const chat: ChatFn = async (_sys, user) => {
    chatCalls++;
    if (chatCalls === 1) {
      return JSON.stringify([
        { id: 1, action: 'open-app', deps: [] },
        { id: 2, action: 'navigate', deps: [1] },
        { id: 3, action: 'click-result', deps: [2] },
      ]);
    }
    // 重规划调用：提示词必须携带完整失败上下文（用户原话 + 失败子任务 + 截断结果）
    assert.ok(user.includes('sigma-task-one'), '用户需求随行');
    assert.ok(user.includes('以下子任务已失败，请重新规划剩余步骤避开失败路径'), '重规划指令标记');
    assert.ok(user.includes('open-app'), '失败子任务 action 在场');
    assert.ok(user.includes('[FAILED] popup blocked'), '失败结果（500 字截断）在场');
    return JSON.stringify([
      { id: 1, action: 'retry-via-menu', deps: [] },
      { id: 2, action: 'click-result', deps: [1] },
    ]);
  };
  const actor: ActorFn = async (task) => {
    actorCalls.push(task);
    return actorCalls.length === 1 ? '[FAILED] popup blocked' : `[SUCCESS] done:${task}`;
  };

  const report = await runOrchestrator('sigma-task-one', actor, chat);

  assert.equal(chatCalls, 2, '首次 planTasks + 一次（且仅一次）重规划');
  assert.deepEqual(actorCalls, ['open-app', 'retry-via-menu', 'click-result'],
    '两组子任务都被执行 —— 旧队列剩余（navigate）被新计划整体替换');
  assert.ok(!report.includes('[FAILED]'), '自愈成功 ⇒ 终局报告无未解决 [FAILED]');
  assert.ok(!report.includes('[TIMEOUT]'), '无超时标记');
  assert.ok(report.includes('[Replan] 子任务失败，已重规划（剩余 2 步）'), '[Replan] 审计行在场');
  assert.ok(report.includes('[RECOVERED] popup blocked'), '失败事实留痕（标记改写为 [RECOVERED]，非抹除轨迹）');
  // SubTask.id 冲突防御：新计划 id 从既有最大 id（3）续编 ⇒ #4/#5，轨迹不撞号
  assert.ok(report.includes('Task #4 (retry-via-menu): [SUCCESS] done:retry-via-menu'), '新计划首步续编 #4');
  assert.ok(report.includes('Task #5 (click-result): [SUCCESS] done:click-result'), '新计划次步续编 #5');
  assert.ok(!report.includes('Task #2 (navigate)'), '旧队列剩余任务未执行（已成功/已失败轨迹保留，未执行者消失）');
});

// ─── Σ-4② 只愈一次：重规划后再次失败 ⇒ 原 fail-fast 语义一字不变 ───

test('Σ-4②: 重规划后再次失败 ⇒ 闭包守卫闭闸，原 fail-fast（warn + break）', async () => {
  const actorCalls: string[] = [];
  let chatCalls = 0;
  const chat: ChatFn = async () => {
    chatCalls++;
    return chatCalls === 1
      ? JSON.stringify([
        { id: 1, action: 'a1', deps: [] },
        { id: 2, action: 'a2', deps: [1] },
      ])
      : JSON.stringify([
        { id: 1, action: 'r1', deps: [] },
        { id: 2, action: 'r2', deps: [1] },
      ]);
  };
  const actor: ActorFn = async (task) => {
    actorCalls.push(task);
    return '[FAILED] broken-again';
  };

  const report = await runOrchestrator('sigma-task-two', actor, chat);

  assert.deepEqual(actorCalls, ['a1', 'r1'],
    'a2 未执行（首败自愈）；r2 未执行（再败 fail-fast 短路）');
  assert.equal(chatCalls, 2, '第二次失败不再重规划 —— replannedOnce 闭闸');
  assert.ok(report.includes('[Replan] 子任务失败，已重规划（剩余 2 步）'), '首败已愈（留审计行）');
  // 再败语义 = 旧 fail-fast：[FAILED] 原样保留（无 [RECOVERED] 改写），且为最后一行
  const lines = report.split('\n');
  assert.equal(lines.filter(l => l.includes('[FAILED]')).length, 1, '再败轨迹 [FAILED] 原样');
  assert.match(lines[lines.length - 1]!, /Task #3 \(r1\): \[FAILED\] broken-again$/,
    '终局 = 失败任务行（原 fail-fast 短路形状；新计划 id 从原最大 2 续编为 3）');
});

// ─── Σ-4③ chat 缺席 ⇒ 原行为一字不变 ───

test('Σ-4③: chat 缺席 ⇒ 原行为：[Planner] 空计划守卫响亮失败，Actor 零调用', async () => {
  const actorCalls: string[] = [];
  const actor: ActorFn = async (t) => { actorCalls.push(t); return '[SUCCESS]'; };

  const report = await runOrchestrator('sigma-task-three', actor, undefined);

  // 旧行为：planTasks 无 chat 返回 [] ⇒ 空计划守卫早退（自愈分支不可达 —— 无 chat 即无重规划）
  assert.equal(report, '[Planner] 未能生成任务计划（检查 llm 服务与提示词），任务未执行。');
  assert.equal(actorCalls.length, 0, '零执行');
});

// ─── Σ-4④ 重规划返回空计划 ⇒ 落回原 fail-fast（诚实） ───

test('Σ-4④: 重规划返回空计划（无 JSON 数组）⇒ fail-fast，无 [Replan] 行', async () => {
  const actorCalls: string[] = [];
  let chatCalls = 0;
  const chat: ChatFn = async () => {
    chatCalls++;
    return chatCalls === 1
      ? JSON.stringify([
        { id: 1, action: 's1', deps: [] },
        { id: 2, action: 's2', deps: [1] },
      ])
      : '抱歉，我无法重新规划。'; // 容错解析得 [] —— 空计划
  };
  const actor: ActorFn = async (t) => {
    actorCalls.push(t);
    return actorCalls.length === 1 ? '[FAILED] no window' : '[SUCCESS]';
  };

  const report = await runOrchestrator('sigma-task-four', actor, chat);

  assert.deepEqual(actorCalls, ['s1'], 's2 未执行');
  assert.equal(chatCalls, 2, '自愈尝试确实发起过一次');
  assert.ok(report.includes('[FAILED] no window'), '失败原样保留（未愈 ⇒ 无 [RECOVERED] 改写）');
  assert.ok(!report.includes('[Replan]'), '空计划 ⇒ 不追加 [Replan] 审计行');
  assert.ok(!report.includes('[SUCCESS]'), '短路后无后续执行');
});

// ─── Σ-4⑤ 成功路径零重规划 ───

test('Σ-4⑤: 全程成功 ⇒ 零重规划（chat 调用计数 = 1，即仅首次 planTasks）', async () => {
  let chatCalls = 0;
  const chat: ChatFn = async () => {
    chatCalls++;
    return JSON.stringify([
      { id: 1, action: 'k1', deps: [] },
      { id: 2, action: 'k2', deps: [1] },
    ]);
  };
  const actorCalls: string[] = [];
  const actor: ActorFn = async (t) => { actorCalls.push(t); return '[SUCCESS] ok'; };

  const report = await runOrchestrator('sigma-task-five', actor, chat);

  assert.equal(chatCalls, 1, '成功路径不触发重规划');
  assert.deepEqual(actorCalls, ['k1', 'k2'], '拓扑序全执行');
  assert.ok(!report.includes('[Replan]') && !report.includes('[FAILED]') && !report.includes('[TIMEOUT]'),
    '纯净成功报告');
  assert.match(report, /Task #1 \(k1\): \[SUCCESS\] ok\nTask #2 \(k2\): \[SUCCESS\] ok/, '返回串格式不变（join 行序）');
});

// ─── Σ-4⑥ 重规划计划拓扑有环 ⇒ 拒绝接管，落回 fail-fast（诚实） ───

test('Σ-4⑥: 重规划计划含依赖环 ⇒ 拒绝执行，fail-fast 短路', async () => {
  const actorCalls: string[] = [];
  let chatCalls = 0;
  const chat: ChatFn = async () => {
    chatCalls++;
    return chatCalls === 1
      ? JSON.stringify([
        { id: 1, action: 'p1', deps: [] },
        { id: 2, action: 'p2', deps: [1] },
      ])
      : JSON.stringify([
        { id: 1, action: 'c1', deps: [2] },
        { id: 2, action: 'c2', deps: [1] },
      ]); // 2→1→2 环
  };
  const actor: ActorFn = async (t) => {
    actorCalls.push(t);
    return actorCalls.length === 1 ? '[FAILED] dead path' : '[SUCCESS]';
  };

  const report = await runOrchestrator('sigma-task-six', actor, chat);

  assert.deepEqual(actorCalls, ['p1'], '环形新计划零执行');
  assert.ok(report.includes('[FAILED] dead path'), '失败原样保留');
  assert.ok(!report.includes('[Replan]'), '环形计划不接管 ⇒ 无 [Replan] 行');
});

// ─── Σ-4⑦ 预算不因自愈豁免：重排队列仍受同一 timeBudget 约束 ───

test('Σ-4⑦: 自愈后重排队列仍受同一 timeBudget 约束（[TIMEOUT] 预算语义不变）', async () => {
  let chatCalls = 0;
  const chat: ChatFn = async () => {
    chatCalls++;
    return chatCalls === 1
      ? JSON.stringify([
        { id: 1, action: 'b1', deps: [] },
        { id: 2, action: 'b2', deps: [1] },
      ])
      : JSON.stringify([
        { id: 1, action: 'br1', deps: [] },
        { id: 2, action: 'br2', deps: [1] },
      ]);
  };
  const actorCalls: string[] = [];
  const actor: ActorFn = async (t) => {
    actorCalls.push(t);
    await new Promise(r => setTimeout(r, 40)); // 首步耗时 ⇒ 预算（25ms）在重排边界耗尽
    return '[FAILED] slow-path';
  };

  const report = await runOrchestrator('sigma-task-seven', actor, chat, 25);

  assert.deepEqual(actorCalls, ['b1'], '重排队列首步前预算熔断 —— br1 未执行');
  assert.ok(report.includes('[Replan] 子任务失败，已重规划（剩余 2 步）'), '自愈已发生（队列确已重排）');
  assert.ok(report.includes('[TIMEOUT] Time budget of 0s exhausted'), '预算检查语义不变（同一起点时钟）');
  assert.ok(/task\(s\) skipped\./.test(report), '跳过计数在场');
});
