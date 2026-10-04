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
    assert.equal(v.kind, 'accept', `A 第 ${i + 1} 调用放行`);
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

// ═── W6R-A9：轨迹级滑动窗口检测（参数微调式死循环）══════════════════

/** 驱动一次完整动作（pre + 成功 post —— 微调循环的每次尝试都"成功返回"，
 *  原样重试检测（同签判等）对微调序列天然失明，正好隔离轨迹级检测） */
async function act(ctx: any, name: string, args: unknown, sessionId: string): Promise<any> {
  const e = exec(name, args, sessionId);
  const v = await drivePre(ctx, e);
  if (v.kind === 'accept') await drivePost(ctx, e, OK_RESULT);
  return v;
}

test('W6R-1: 参数微调循环 —— 同工具近参数 5/8 窗口触发轨迹级拦截', async () => {
  const { registerRepeatActionGuard } = await import('../src/guards/repeatActionGuard.ts');
  const ctx = fakeCtx();
  registerRepeatActionGuard(ctx);

  // 每次挪 ~0.01-0.02（> 签名网格 0.001 ⇒ 逐次异签，原样重试检测全部放行；
  // 全部落在粗网格同一桶 [0.475, 0.525] 内 ⇒ 轨迹尺度近参数）
  // —— 正是量化盲区的攻击形状
  const xs = [0.50, 0.52, 0.51, 0.49, 0.52];
  for (let i = 0; i < xs.length; i++) {
    const v = await act(ctx, 'click_mouse', { x: xs[i], y: 0.5 }, 'w6r-loop');
    if (i < 4) {
      assert.equal(v.kind, 'accept', `第 ${i + 1} 次近参数调用放行（${xs[i]}，窗口内 ${i + 1} < 5）`);
    } else {
      assert.equal(v.kind, 'deny', '第 5 次近参数调用被轨迹级拦截（5/8 ≥ 阈值）');
      assert.match(String(v.reason), /Loop detected/, '轨迹级拦截文案');
      assert.match(String(v.reason), /micro-adjusted/, '指明微调重试本质');
    }
  }
});

test('W6R-2: 合法近参数尝试不误杀 —— 4 次以内近参数与交替双目标全放行', async () => {
  const { registerRepeatActionGuard } = await import('../src/guards/repeatActionGuard.ts');
  const ctx = fakeCtx();
  registerRepeatActionGuard(ctx);

  // 4 次近参数微调（失败重试的合理上限，全落同一粗桶）—— 全放行（宁漏勿杀：4 < 5）
  for (const x of [0.50, 0.52, 0.51, 0.49]) {
    const v = await act(ctx, 'click_mouse', { x, y: 0.5 }, 'w6r-legit');
    assert.equal(v.kind, 'accept', `近参数 ${x} 放行`);
  }
  // 交替双目标（各占半窗，均 < 5）—— 全放行
  for (const x of [0.9, 0.5, 0.9, 0.5, 0.9, 0.5, 0.9, 0.5]) {
    const v = await act(ctx, 'click_mouse', { x, y: 0.5 }, 'w6r-alt');
    assert.equal(v.kind, 'accept', `交替目标 ${x} 放行`);
  }
  // 跨控件位移（> 轨迹网格 0.05 ⇒ 异桶）不计入近参数账
  for (const x of [0.5, 0.8, 0.5, 0.8, 0.5, 0.8, 0.5, 0.8]) {
    const v = await act(ctx, 'type_text', { x, y: 0.5 }, 'w6r-far');
    assert.equal(v.kind, 'accept', `远参数 ${x} 放行`);
  }
});

test('W6R-3: 轨迹环跨会话隔离 + 被拦调用保持粘性', async () => {
  const { registerRepeatActionGuard } = await import('../src/guards/repeatActionGuard.ts');
  const ctx = fakeCtx();
  registerRepeatActionGuard(ctx);

  // 会话 A 填满轨迹环（第 5 次被拦）
  for (const x of [0.50, 0.52, 0.51, 0.49]) {
    await act(ctx, 'click_mouse', { x, y: 0.5 }, 'w6r-A');
  }
  const blocked = await act(ctx, 'click_mouse', { x: 0.52, y: 0.5 }, 'w6r-A');
  assert.equal(blocked.kind, 'deny', 'A 的第 5 次近参数被拦');

  // 会话 B 同形状调用 —— 全新轨迹环，放行（跨会话不误杀）
  for (const x of [0.50, 0.52, 0.51]) {
    const v = await act(ctx, 'click_mouse', { x, y: 0.5 }, 'w6r-B');
    assert.equal(v.kind, 'accept', 'B 的新环独立计数');
  }

  // 会话 A：被拦后继续微调重试 —— 被拦调用也入环（粘性），立即再拦
  const sticky = await act(ctx, 'click_mouse', { x: 0.505, y: 0.5 }, 'w6r-A');
  assert.equal(sticky.kind, 'deny', '被拦后的持续微调仍被拦（循环意图持续计数）');
  assert.match(String(sticky.reason), /Loop detected/);
});

test('W6R-4: 原样重试语义保持 —— 微调与原样混合时同签检测不被轨迹规则取代', async () => {
  const { registerRepeatActionGuard } = await import('../src/guards/repeatActionGuard.ts');
  const ctx = fakeCtx();
  registerRepeatActionGuard(ctx);

  // 失败后原样重试（旧语义）：第 2 次同签即拦 —— 拦截文案仍是原样重试档
  const e1 = exec('switch_window', { titleKeyword: 'ZZZ' }, 'w6r-idle');
  await drivePre(ctx, e1);
  await drivePost(ctx, e1, FAILED_RESULT);
  const v = await drivePre(ctx, exec('switch_window', { titleKeyword: 'ZZZ' }, 'w6r-idle'));
  assert.equal(v.kind, 'deny');
  assert.match(String(v.reason), /Repeated identical action/, '原样重试文案保持（W6R 不改旧档语义）');
});

// ═── D-D11（半格悬崖修复）：桶判等之上叠加叶级真数值距离比较 ══════════

test('D-D11-1: 0.50↔0.53 交替微调 —— 旧桶判等逃逸（异桶），新叶级距离第 5 次拦截', async () => {
  const { registerRepeatActionGuard } = await import('../src/guards/repeatActionGuard.ts');
  const ctx = fakeCtx();
  registerRepeatActionGuard(ctx);

  // 悬崖证据（原子）：0.50 与 0.53 在 0.05 网格量化后分属两桶
  // （round(0.50×20)=10 → 0.5；round(0.53×20)=11 → 0.55）—— 旧实现纯桶判等
  // 对这对值永不同桶：交替序列每桶各计数，窗口内各 ≤4 永达不到阈值 ⇒ 逃逸。
  const quant = (x: number) => Math.round(x * 20) / 20;
  assert.notEqual(quant(0.53), quant(0.50), '悬崖复现：0.53 与 0.50 异桶（旧实现的逃逸面）');

  // 新实现：|0.53−0.50| = 0.03 ≤ TRAJECTORY_NEAR_EPS(0.05) ⇒ 近参数 ——
  // 交替序列连成同一条近参数轨迹，第 5 次（窗口内计数 5 ≥ 阈值）被拦。
  const xs = [0.50, 0.53, 0.50, 0.53, 0.50];
  for (let i = 0; i < xs.length; i++) {
    const v = await act(ctx, 'click_mouse', { x: xs[i], y: 0.5 }, 'd-d11-cliff');
    if (i < 4) {
      assert.equal(v.kind, 'accept', `第 ${i + 1} 次交替微调放行（${xs[i]}，计数 ${i + 1} < 5）`);
    } else {
      assert.equal(v.kind, 'deny', '第 5 次被拦 —— 叶级距离 0.03 ≤ 0.05，半格悬崖带归案');
      assert.match(String(v.reason), /Loop detected/, '轨迹级拦截文案');
    }
  }
});

test('D-D11-2: 不误杀面 —— 跨控件位移 / 换文本 / 换键形不计入近参数', async () => {
  const { registerRepeatActionGuard } = await import('../src/guards/repeatActionGuard.ts');
  const ctx = fakeCtx();
  registerRepeatActionGuard(ctx);

  // 跨控件位移（|0.8−0.5| = 0.3 > 0.05 ⇒ 异桶且超阈）—— 8 连交替全放行
  for (let i = 0; i < 8; i++) {
    const x = i % 2 === 0 ? 0.5 : 0.8;
    const v = await act(ctx, 'click_mouse', { x, y: 0.5 }, 'd-d11-far');
    assert.equal(v.kind, 'accept', `跨控件位移 ${x} 放行（正常换目标不误杀）`);
  }
  // 换文本：数值叶全同但字符串叶不同 —— 距离宽容只给同名数值叶
  for (let i = 0; i < 8; i++) {
    const v = await act(ctx, 'type_text', { text: i % 2 === 0 ? 'foo' : 'bar', x: 0.5 }, 'd-d11-text');
    assert.equal(v.kind, 'accept', '字符串叶差异 ⇒ 非近参数（真换目标）');
  }
  // 换键形：多一个数值叶 —— 骨架不同 ⇒ 非近参数
  for (let i = 0; i < 8; i++) {
    const args = i % 2 === 0 ? { x: 0.5 } : { x: 0.5, y: 0.5 };
    const v = await act(ctx, 'click_mouse', args, 'd-d11-shape');
    assert.equal(v.kind, 'accept', '键形差异 ⇒ 非近参数');
  }
});

test('D-D11-3: 阈值立法在源 —— TRAJECTORY_NEAR_EPS = 1/TRAJECTORY_GRID（桶宽 0.05）', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../src/guards/repeatActionGuard.ts', import.meta.url), 'utf8');
  assert.ok(src.includes('const TRAJECTORY_GRID = 20'), '轨迹网格 0.05 在场（W6R-A9 立法保持，epochT 锚点）');
  assert.ok(src.includes('const TRAJECTORY_NEAR_EPS = 1 / TRAJECTORY_GRID'), '叶级近参数阈立法在源（= 桶宽，单一常量语义）');
  assert.ok(src.includes('function isNearParam'), '桶判等 ∪ 叶级距离判等的执法函数在场');
});

// ═── ΑΩ-R24：popupGuard 弹窗态的会话隔离（Y6 立法补全）══════════════

test('R24-1: 弹窗态跨会话隔离 —— 会话 A 的弹窗不得拦会话 B 的动作', async () => {
  const { registerPopupGuard, updatePopupState, resetPopupState, TACTICAL_PAUSE } =
    await import('../src/guards/popupGuard.ts');
  resetPopupState();
  const ctx = fakeCtx();
  registerPopupGuard(ctx);

  // 会话 A 传感器上报弹窗 ⇒ A 的动作被拦（会话内联动语义保持），话术逐字不变
  updatePopupState(true, 'r24-A');
  const blockedA = await drivePre(ctx, exec('click_mouse', { x: 0.5, y: 0.5 }, 'r24-A'));
  assert.equal(blockedA.kind, 'deny', 'A 自己的弹窗仍拦 A');
  assert.equal(blockedA.reason, TACTICAL_PAUSE, '拦截话术逐字不变（TACTICAL_PAUSE 单一事实源）');

  // 会话 B：同一管线时刻 —— B 的动作放行（旧单例在此被 A 的弹窗态误拦）
  const passB = await drivePre(ctx, exec('click_mouse', { x: 0.5, y: 0.5 }, 'r24-B'));
  assert.equal(passB.kind, 'accept', 'B 不被 A 的弹窗态误拦（工单主诉修复面）');

  // B 的传感器上报无弹窗 ⇒ 不得清除 A 的弹窗态（写隔离，互不污染）
  updatePopupState(false, 'r24-B');
  const stillBlockedA = await drivePre(ctx, exec('type_text', { text: 'x' }, 'r24-A'));
  assert.equal(stillBlockedA.kind, 'deny', 'B 的无弹窗上报不清 A 的态');

  // 白名单不变：传感器与处理器在弹窗活跃期照常工作
  assert.equal((await drivePre(ctx, exec('take_screenshot', {}, 'r24-A'))).kind, 'accept', '传感器白名单不变');
  assert.equal((await drivePre(ctx, exec('dismiss_popup', {}, 'r24-A'))).kind, 'accept', '处理器白名单不变');
});

test('R24-2: 旧调用面零回归 —— 无 sessionId 的写/读落在 default 单例键（拦截语义保持）', async () => {
  const { registerPopupGuard, updatePopupState, getPopupState, resetPopupState } =
    await import('../src/guards/popupGuard.ts');
  resetPopupState();
  const ctx = fakeCtx();
  registerPopupGuard(ctx);

  // 旧写法（无 sessionId）+ 旧表面（exec 无 agent.id）：拦 / 放行语义与旧单例一致
  updatePopupState(true);
  assert.equal(getPopupState(), true, '无参读 = 全局最新读数（旧单例语义）');
  const noAgent = { name: 'click_mouse', arguments: { x: 0.5, y: 0.5 } };
  assert.equal((await drivePre(ctx, noAgent)).kind, 'deny', '旧表面拦截语义保持');

  updatePopupState(false);
  assert.equal((await drivePre(ctx, noAgent)).kind, 'accept', '复位后放行（旧语义）');
});

test('R24-3: 无会话读者桥 —— 带会话写入对无参 getPopupState() 仍可见（canary/interactivity 语义不变）', async () => {
  const { updatePopupState, getPopupState, resetPopupState } =
    await import('../src/guards/popupGuard.ts');
  resetPopupState();

  updatePopupState(true, 'r24-sess');
  assert.equal(getPopupState(), true, '旧单例 = 全局最新读数：会话写入镜像到 default');
  assert.equal(getPopupState('r24-sess'), true, '会话键自身可读');
  assert.equal(getPopupState('r24-other'), false, '其他会话键隔离（新会话全新开始）');
});

test('R24-4: 陈旧会话清理 —— 10 分钟无更新的活跃弹窗态读取时过期物理清除', async () => {
  const { updatePopupState, getPopupState, resetPopupState, popupSessionCount } =
    await import('../src/guards/popupGuard.ts');
  resetPopupState();
  const origNow = Date.now;
  let clock = 1_000_000;
  Date.now = () => clock;
  try {
    updatePopupState(true, 'r24-stale');
    const sizeFresh = popupSessionCount();
    assert.equal(getPopupState('r24-stale'), true, '新鲜读：弹窗态在场');

    clock += 10 * 60 * 1000 + 1; // 超过 POPUP_STALE_MS（10 分钟）1ms
    assert.equal(getPopupState('r24-stale'), false, '陈旧读：视为无弹窗（弹窗态短命，不无限拦）');
    assert.ok(popupSessionCount() < sizeFresh, '过期即物理清除（非仅读时屏蔽）');

    clock = 1_000_000; // 回拨时钟 —— 已清除的态不得复活（防僵尸拦截）
    assert.equal(getPopupState('r24-stale'), false, '清除后回拨时钟不复活');
  } finally {
    Date.now = origNow;
  }
});

test('R24-5: LRU 容量 —— 会话键封顶 32，满逐最旧；default 基础设施键免逐', async () => {
  const { updatePopupState, getPopupState, popupSessionCount, resetPopupState } =
    await import('../src/guards/popupGuard.ts');
  resetPopupState();

  updatePopupState(true, 'r24-first'); // 最旧会话键（将最先被逐）
  for (let i = 0; i < 32; i++) updatePopupState(true, `r24-lru-${i}`); // 灌满 32
  assert.equal(popupSessionCount(), 33, '32 会话键 + default（免逐的基础设施键）');
  assert.equal(getPopupState('r24-first'), false, '最旧会话键被逐出（LRU 满逐最旧）');
  assert.equal(getPopupState('r24-lru-0'), true, '界内最旧会话键仍在');
  assert.equal(getPopupState('r24-lru-31'), true, '最新会话键仍在');
  assert.equal(getPopupState(), true, 'default 全局视图不受逐出影响');
});
