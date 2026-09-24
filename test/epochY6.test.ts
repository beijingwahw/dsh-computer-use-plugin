// test/epochY6.test.ts
// Y6 纪元验证：防死循环守卫的会话隔离（跨会话记忆残留的真机战果回归）。
import { test } from 'node:test';
import assert from 'node:assert/strict';

interface RegisteredHandler {
  event: string;
  handler: (exec: any, result: any, next: () => Promise<any>) => Promise<any>;
}

function fakeCtx() {
  const handlers: RegisteredHandler[] = [];
  return {
    handlers,
    on(event: string, handler: any) { handlers.push({ event, handler }); return () => {}; },
  } as any;
}

/** rc.6 形状的 exec：arguments + agent.id（会话身份） */
function exec(name: string, args: unknown, sessionId: string): any {
  return { name, arguments: args, agent: { id: sessionId }, token: {}, rootCallId: 'c1' };
}

const FAILED_RESULT = { isError: false, value: '{\n  "status": "FAILED",\n  "state_anchor": {}\n}' };
const OK_RESULT = { isError: false, value: '{\n  "status": "SUCCESS",\n  "state_anchor": {}\n}' };

async function drivePre(ctx: any, e: any): Promise<any> {
  const h = ctx.handlers.find((r: RegisteredHandler) => r.event === 'tools/pre-execute')!;
  return h.handler(e, async () => ({ kind: 'accept' }));
}

async function drivePost(ctx: any, e: any, result: any): Promise<any> {
  const h = ctx.handlers.find((r: RegisteredHandler) => r.event === 'tools/post-execute')!;
  return h.handler(e, result, async () => result);
}

test('Y6-1: 跨会话记忆隔离 —— 会话 A 的失败签名不得拦截会话 B 的首次同签名调用', async () => {
  const { registerRepeatActionGuard } = await import('../src/guards/repeatActionGuard.ts');
  const ctx = fakeCtx();
  registerRepeatActionGuard(ctx);

  const args = { titleKeyword: 'ZZZ-NOT-EXIST-XYZ' };

  // 会话 A：switch_window 失败（post 记录 noEffect）
  await drivePre(ctx, exec('switch_window', args, 'session-A'));
  await drivePost(ctx, exec('switch_window', args, 'session-A'), FAILED_RESULT);

  // 会话 B：同签名首次调用 —— 必须放行（旧实现在这里被 A 的残留记忆拦截）
  const verdict = await drivePre(ctx, exec('switch_window', args, 'session-B'));
  assert.equal(verdict.kind, 'accept', '新会话首次同签名调用放行');

  // 会话 B：失败后立即原样重试 —— 会话内防死循环语义保持
  await drivePost(ctx, exec('switch_window', args, 'session-B'), FAILED_RESULT);
  const blocked = await drivePre(ctx, exec('switch_window', args, 'session-B'));
  assert.equal(blocked.kind, 'deny', '同会话内失败后原样重试仍被拦截');
  assert.match(String(blocked.reason), /Repeated identical action/, '拦截文案正确');
});

test('Y6-2: 会话 A 的状态不被会话 B 的动作污染（失败记忆按会话独立）', async () => {
  const { registerRepeatActionGuard } = await import('../src/guards/repeatActionGuard.ts');
  const ctx = fakeCtx();
  registerRepeatActionGuard(ctx);

  const args = { keys: ['alt', 'f4'] };

  // A：alt+f4 失败
  await drivePre(ctx, exec('press_hotkey', args, 'session-A'));
  await drivePost(ctx, exec('press_hotkey', args, 'session-A'), FAILED_RESULT);

  // B：穿插一次成功（不得清掉 A 的失败记忆 —— 旧实现共享变量会被此污染）
  await drivePre(ctx, exec('press_hotkey', args, 'session-B'));
  await drivePost(ctx, exec('press_hotkey', args, 'session-B'), OK_RESULT);

  // A：再次 alt+f4 —— A 自己的失败记忆仍在，应拦截
  const verdictA = await drivePre(ctx, exec('press_hotkey', args, 'session-A'));
  assert.equal(verdictA.kind, 'deny', 'A 的失败记忆不被 B 的成功覆盖');

  // B：再次 alt+f4 —— B 上次成功，无 noEffect 标记，首次重试放行（计数语义）
  const verdictB = await drivePre(ctx, exec('press_hotkey', args, 'session-B'));
  assert.equal(verdictB.kind, 'accept', 'B 的语义独立（上次成功 ⇒ 重试放行）');
});

test('Y6-3: 无会话标识的旧表面退化为 _anon（与旧行为一致的防死循环）', async () => {
  const { registerRepeatActionGuard } = await import('../src/guards/repeatActionGuard.ts');
  const ctx = fakeCtx();
  registerRepeatActionGuard(ctx);

  const e = { name: 'click_mouse', arguments: { x: 0.5, y: 0.5 } }; // 无 agent.id
  await drivePre(ctx, e);
  await drivePost(ctx, e, FAILED_RESULT);
  const blocked = await drivePre(ctx, e);
  assert.equal(blocked.kind, 'deny', '旧表面（无 sessionId）防死循环语义保持');
});

test('Y6-4: hooks 归一化 —— exec.agent.id 透传为 ToolCall.sessionId', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../src/guards/hooks.ts', import.meta.url), 'utf8');
  assert.ok(src.includes('exec?.agent?.id'), '从 rc.6 exec 提取会话身份');
  assert.ok(src.includes('sessionId?: string'), 'ToolCall 携带可选 sessionId');
});

test('Y6-5: 熔断器跨会话隔离 —— 会话 A 的连续失败不熔断会话 B 的首个调用', async () => {
  const { registerCircuitBreakerGuard } = await import('../src/guards/circuitBreakerGuard.ts');
  const ctx = fakeCtx();
  registerCircuitBreakerGuard(ctx, 3);

  // 会话 A：3 连败（达到熔断阈值）
  for (let i = 0; i < 3; i++) {
    const e = exec('click_mouse', { x: 0.4, y: 0.4 }, 'session-A');
    const v = await drivePre(ctx, e);
    assert.equal(v.kind, 'accept', `A 第 ${i + 1} 次调用放行`);
    await drivePost(ctx, e, FAILED_RESULT);
  }
  // A 的第 4 次调用被熔断（会话内语义保持）
  const tripped = await drivePre(ctx, exec('click_mouse', { x: 0.4, y: 0.4 }, 'session-A'));
  assert.equal(tripped.kind, 'deny', 'A 内部熔断触发');
  assert.match(String(tripped.reason), /Circuit Breaker/);

  // 会话 B：全新开始 —— 首个调用必须放行（旧实现在此被 A 的 3 连败误熔断）
  const fresh = await drivePre(ctx, exec('click_mouse', { x: 0.4, y: 0.4 }, 'session-B'));
  assert.equal(fresh.kind, 'accept', '新会话不被旧会话的失败计数熔断');
});
