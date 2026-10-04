// test/no3fixes.test.ts
// ΝΩ-3（P1×2）：
//   ① Planner 通道流式看门狗 —— resolvePlannerChat 的裸 for await 无 AbortSignal
//      无墙钟上限，挂起流可永久冻结 start_complex_task；修复 = planner.ts 的
//      collectStreamWithWatchdog（idle 30s 无进展检测 + totalBudget 总预算）+
//      orchestrator 计划相位预算包裹（timeBudget 10% 派生，合计上限，归因
//      planner-budget）+ listModels 路由超时（awaitWithTimeout）。
//   ② 双图像投递通道互斥 —— 附件服务在场 ⇒ 滑窗注入闸门关闭（单源投递立法：
//      新宿主走附件，旧宿主走滑窗）。
//   ③ contextManager.lastImageRecord 尾部反向扫（零分配）行为等价。
//   ④ planTasks 括号深度解析：尾噪声含 ']' 时提前截断（旧 lastIndexOf 必炸）。
// 全离线：假钟/假流/假 chat —— 零宿主耦合、零网络、零真实长等待。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  collectStreamWithWatchdog,
  awaitWithTimeout,
  extractJsonArraySpan,
  planTasks,
  PLANNER_STREAM_IDLE_MS,
  type ChatFn,
} from '../src/planner.ts';
import {
  runOrchestrator,
  PLANNER_BUDGET_FRACTION,
  type ActorFn,
} from '../src/orchestrator.ts';
import { setImageDeliveryStore, imageDeliveryAvailable } from '../src/imageDelivery.ts';
import { contextManager } from '../src/contextManager.ts';

// ─── 测试基建：假钟 + 手控流（emit/fail 由测试驱赶 —— chunk 到达时机完全确定）───

/** 假钟：now 读取 + 看门狗计时器武装/按 advance 触发（零真实等待） */
function fakeClock() {
  let t = 0;
  const armed: Array<{ at: number; resolve: () => void; cancelled: boolean }> = [];
  return {
    now: () => t,
    armTimer: (ms: number) => {
      const rec = { at: t + ms, resolve: () => {}, cancelled: false };
      const promise = new Promise<undefined>(res => { rec.resolve = () => res(undefined); });
      armed.push(rec);
      return { promise, cancel: () => { rec.cancelled = true; } };
    },
    advance: (ms: number) => {
      t += ms;
      for (const rec of armed) {
        if (!rec.cancelled && rec.at <= t) { rec.cancelled = true; rec.resolve(); }
      }
    },
  };
}

/** 手控异步流：next() 挂起直到 emit/fail —— 「永不吐 chunk 的挂死流」由此铸造 */
function manualStream(): {
  stream: AsyncIterable<unknown>;
  emit: (value: unknown) => void;
  fail: (err: Error) => void;
} {
  let settleNext: ((r: IteratorResult<unknown>) => void) | null = null;
  let rejectNext: ((e: unknown) => void) | null = null;
  const next = () => new Promise<IteratorResult<unknown>>((resolve, reject) => {
    settleNext = resolve;
    rejectNext = reject;
  });
  return {
    stream: {
      [Symbol.asyncIterator]: () => ({
        next,
        return: () => Promise.resolve({ done: true, value: undefined }),
      }),
    },
    emit: value => { const s = settleNext; settleNext = rejectNext = null; s?.({ value, done: false }); },
    fail: err => { const r = rejectNext; settleNext = rejectNext = null; r?.(err); },
  };
}

/** 微任务排空（数轮 setImmediate —— race/收尾链完全落定） */
async function drain(): Promise<void> {
  for (let i = 0; i < 4; i++) await new Promise(r => setImmediate(r));
}

// ─── ΝΩ-3①②③：流看门狗（idle / 总预算 / 快乐路径 / 流错误同路）───

test('ΝΩ-3①: 挂死流（永不吐 chunk）⇒ 30s 假钟后失败归因 stream-idle；迟到拒绝静音', async () => {
  assert.equal(PLANNER_STREAM_IDLE_MS, 30_000, 'idle 窗常量锁：30s（可配置常量）');
  const clk = fakeClock();
  const ms = manualStream();
  const p = collectStreamWithWatchdog(ms.stream, { now: clk.now, armTimer: clk.armTimer });
  await drain();
  clk.advance(PLANNER_STREAM_IDLE_MS + 1); // 假钟过 idle 窗 ⇒ 看门狗武装的计时器触发
  const out = await p;
  assert.equal(out.ok, false, '看门狗触发 ⇒ 非静默成功');
  assert.equal(out.failure, 'stream-idle', '诚实失败归因 stream-idle（无进展检测）');
  assert.match(out.detail, /30000/, '细节携带 idle 窗口事实');
  assert.equal(out.text, '', '失败产出不带聚合文本');
  // 迟到拒绝静音：看门狗离场后流才报错 —— 若未静音，Node 对 unhandledRejection
  // 默认 throw，本测试进程直接崩（这是行为断言，不是风格断言）
  ms.fail(new Error('late boom'));
  await drain();
});

test('ΝΩ-3②: 总预算（totalBudgetMs）超限 ⇒ 失败归因 planner-budget（有进展也拦）', async () => {
  const clk = fakeClock();
  const ms = manualStream();
  const p = collectStreamWithWatchdog(ms.stream, {
    now: clk.now, armTimer: clk.armTimer, totalBudgetMs: 100,
  });
  await drain();
  ms.emit({ type: 'text-delta', text: 'partial' }); // 流活着（有 chunk = 有进展）
  await drain();
  clk.advance(150); // 但总预算 100ms 耗尽 ⇒ 总闸先于 idle 窗归因
  const out = await p;
  assert.equal(out.ok, false);
  assert.equal(out.failure, 'planner-budget', '总时长上限归因 planner-budget');
  assert.match(out.detail, /100/);
});

test('ΝΩ-3③: 快乐路径 —— 默认计时器/真钟下聚合语义与旧 for-await 逐字节一致', async () => {
  async function* okStream(): AsyncGenerator<any> {
    yield { type: 'text-delta', text: '[{"id":1,' };
    yield { type: 'reasoning-delta', text: 'thinking[' };
    yield { type: 'text-delta', text: '"action":"a"}]' };
  }
  const out = await collectStreamWithWatchdog(okStream());
  assert.equal(out.ok, true);
  assert.equal(out.text, '[{"id":1,"action":"a"}]', 'text-delta 全量聚合');
  assert.equal(out.reasoningTail, 'thinking[', 'reasoning 尾部记账');
  assert.equal(out.failure, null);
});

test('ΝΩ-3③b: 流自身抛错 ⇒ 原样上抛（与 for-await 同路，路由级 catch 收编）', async () => {
  async function* badStream(): AsyncGenerator<any> {
    yield { type: 'text-delta', text: 'x' };
    throw new Error('net down');
  }
  await assert.rejects(() => collectStreamWithWatchdog(badStream()), /net down/);
  // 非异步可迭代物：与 for-await 的 TypeError 同路（防御面）
  await assert.rejects(() => collectStreamWithWatchdog({}), /not async-iterable/);
});

// ─── ΝΩ-3(c)：awaitWithTimeout（listModels 路由超时包裹的纯函数面）───

test('ΝΩ-3④: awaitWithTimeout —— 快值直通 / 挂起超时落 null / 拒绝落 null / 非 thenable 直通', async () => {
  assert.equal(await awaitWithTimeout(Promise.resolve(7), 1000), 7, '预算内落定直通');
  assert.equal(await awaitWithTimeout(new Promise<never>(() => {}), 15), null, '超时 ⇒ null 诚实降级（绝不抛）');
  assert.equal(await awaitWithTimeout(Promise.reject(new Error('x')), 1000), null, '拒绝 ⇒ null（被包面失败 = 不可用）');
  assert.equal(await awaitWithTimeout(undefined, 1000), null, '缺席（?. 产物）⇒ null');
  assert.equal(await awaitWithTimeout('raw' as never, 1000), 'raw', '非 thenable 直通');
});

// ─── ΝΩ-3⑤⑥⑦：orchestrator 计划相位预算包裹（planner-budget 归因）───

test('ΝΩ-3⑤: 首规划挂死 + plannerBudgetMs ⇒ [Planner] planner-budget 响亮失败，Actor 零调用', async () => {
  const actorCalls: string[] = [];
  const actor: ActorFn = async t => { actorCalls.push(t); return '[SUCCESS]'; };
  const hang: ChatFn = () => new Promise(() => {}); // 挂死 chat：旧裸 await = 永久冻结
  const t0 = Date.now();
  const report = await runOrchestrator('no3-hang', actor, hang, undefined, { plannerBudgetMs: 25 });
  const dt = Date.now() - t0;
  assert.ok(dt < 4000, `预算门快速收场（实测 ${dt}ms）—— 修复前这里永不返回`);
  assert.ok(report.startsWith('[Planner]'), '[Planner] 前缀（空计划守卫同族报告面）');
  assert.ok(report.includes('planner-budget'), '失败归因 planner-budget');
  assert.equal(actorCalls.length, 0, '计划未成 ⇒ 零执行');
});

test('ΝΩ-3⑥: Σ-4 重规划同受计划相位合计预算约束 ⇒ 超限落回原 fail-fast', async () => {
  let chatCalls = 0;
  const chat: ChatFn = async () => {
    chatCalls++;
    return chatCalls === 1
      ? Promise.resolve(JSON.stringify([{ id: 1, action: 'r1', deps: [] }]))
      : new Promise<string>(() => {}); // 重规划挂死
  };
  const actorCalls: string[] = [];
  const actor: ActorFn = async t => { actorCalls.push(t); return '[FAILED] boom'; };
  const report = await runOrchestrator('no3-replan', actor, chat, undefined, { plannerBudgetMs: 60 });
  assert.equal(chatCalls, 2, '重规划确已发起（首规划 + 一次自愈尝试）');
  assert.ok(report.includes('Task #1 (r1): [FAILED] boom'), '失败轨迹原样保留');
  assert.ok(!report.includes('[Replan]'), '预算超限 ⇒ 不追加 [Replan] 行（fail-fast 同空计划路径）');
  const lines = report.split('\n');
  assert.match(lines[lines.length - 1]!, /Task #1 \(r1\): \[FAILED\] boom$/, '终局 = 失败任务行（原 fail-fast 形状）');
});

test('ΝΩ-3⑦: 派生预算下限钳 + 快速 chat ⇒ 零误杀（零回归锚）', async () => {
  assert.equal(PLANNER_BUDGET_FRACTION, 0.1, '派生分数常量锁：timeBudget 的 10%');
  const chat: ChatFn = async () => JSON.stringify([{ id: 1, action: 'k1', deps: [] }]);
  const actor: ActorFn = async () => '[SUCCESS] ok';
  // timeBudget 60s ⇒ 派生 max(5s, 6s) = 6s：即时 chat 远未触闸
  const report = await runOrchestrator('no3-fast', actor, chat, 60_000);
  assert.match(report, /Task #1 \(k1\): \[SUCCESS\] ok/, '正常路径不受预算包裹影响');
  assert.ok(!report.includes('planner-budget'), '无假阳性归因');
  // chat 缺席（既有语义，sigma-③ 同锚）：无预算误触
  const noChat = await runOrchestrator('no3-nochat', actor, undefined, 60_000);
  assert.equal(noChat, '[Planner] 未能生成任务计划（检查 llm 服务与提示词），任务未执行。');
});

// ─── ΝΩ-3⑧：双图像投递通道互斥（附件在场 ⇒ 滑窗零注入）───

test('ΝΩ-3⑧: 附件在场 ⇒ 滑窗注入闸门关闭（探测面功能断言 + 接线立法源码取证）', () => {
  const before = imageDeliveryAvailable();
  assert.equal(before, false, '本进程缺省未注入附件服务（w3incremental 同锚）');
  // 功能面：在场性探测随附件注入翻转（imageDelivery 既有只读探测，单源复用）
  setImageDeliveryStore({ saveImage: async () => ({ attachmentId: 'att-1', mediaType: 'image/jpeg', bytes: 1 }) } as never);
  try {
    assert.equal(imageDeliveryAvailable(), true, '附件在场 ⇒ 单源 = 附件通道（滑窗必须让位）');
  } finally {
    setImageDeliveryStore(null); // 恢复进程缺省，不污染其他测试
  }
  assert.equal(imageDeliveryAvailable(), false, '附件缺席 ⇒ 旧宿主走滑窗旧路');
  // 接线取证（w5wire 源级断言先例）：守卫在注入动作之前 + 立法注释双文件在场
  const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  const handlerStart = src.indexOf('onLlmPreRequest(ctx, (payload) => {');
  const pushIdx = src.indexOf('payload.messages.push', handlerStart);
  assert.ok(handlerStart >= 0 && pushIdx > handlerStart, '滑窗注入挂载点在场');
  const guardBlock = src.slice(handlerStart, pushIdx);
  assert.ok(guardBlock.includes('imageDeliveryAvailable()'), '注入 push 之前先探测附件在场性（在场 ⇒ 零注入）');
  // 立法名句（法言：新宿主走附件，旧宿主走滑窗）双文件在场
  const LAW = '新宿主走附件，旧宿主走滑窗';
  assert.ok(src.includes(LAW), '立法注释在场（index.ts）');
  const hooks = readFileSync(new URL('../src/guards/hooks.ts', import.meta.url), 'utf8');
  assert.ok(hooks.includes(LAW), '立法注释在场（guards/hooks.ts）');
  // 看门狗接线取证：流循环与 listModels 路由已换装
  assert.ok(src.includes('await collectStreamWithWatchdog(llm.stream('), 'Planner 流循环由看门狗驱动');
  assert.ok(src.includes('awaitWithTimeout(llm.listModels?.(pid)'), 'listModels 路由包超时');
});

// ─── ΝΩ-3⑨：lastImageRecord 尾部反向扫（零分配）行为等价 ───

test('ΝΩ-3⑨: lastImageRecord 行为等价 —— 空窗 undefined / 降级记录跳过 / 最新在窗图命中', async () => {
  contextManager.reset();
  assert.equal(contextManager.lastImageRecord(), undefined, '空窗 ⇒ undefined');
  contextManager.configure(1, 10_000_000, false, 0, false); // 窗口宽 1 ⇒ 次帧驱逐首帧
  await contextManager.addScreenshot('a', '0'.repeat(64));
  await contextManager.addScreenshot('b', '1'.repeat(64)); // 首帧驱逐（base64 置空 = 降级）
  const last = contextManager.lastImageRecord();
  assert.equal(last?.hash, '1'.repeat(64), '降级记录跳过 ⇒ 最新在窗图命中（与旧 reverse().find 等价）');
  assert.equal(last?.base64, 'b');
  assert.equal(contextManager.imageCount(), 1, '窗口内仅 1 张（驱逐已发生）');
  contextManager.reset();
  assert.equal(contextManager.lastImageRecord(), undefined, 'reset 后归零');
});

// ─── ΝΩ-3(d)：planTasks 括号深度解析（尾噪声提前截断 + 既有方言等价）───

test('ΝΩ-3⑩: 括号深度解析 —— 尾噪声含 ] 提前截断；围栏/纯数组/无数组/截断全方言等价', async () => {
  // 尾噪声含 ']'：旧 first'['..last']' 会把噪声圈进切片令 JSON.parse 必炸 ⇒ []
  const noisy = await planTasks('x', async () =>
    '[{"id":1,"action":"open-notepad","deps":[]}] 附注：第 3] 步需人工确认');
  assert.equal(noisy.length, 1, '深度计数在数组真闭处截断尾噪声（旧法此输入必 []）');
  assert.equal(noisy[0]?.action, 'open-notepad');
  // 字符串内括号豁免（inString/转义跟踪）
  const brackets = await planTasks('x', async () => '[{"id":1,"action":"打开 [设置] 面板","deps":[]}]');
  assert.equal(brackets[0]?.action, '打开 [设置] 面板', '字符串内 [ ] 不干扰深度计数');
  // 既有方言等价（零回归锚）
  assert.equal((await planTasks('x', async () => '```json\n[{"id":1,"action":"f","deps":[]}]\n```')).length, 1, '围栏剥离等价');
  assert.equal((await planTasks('x', async () => '[{"id":1,"action":"g","deps":[]}]')).length, 1, '纯数组等价');
  assert.equal((await planTasks('x', async () => '抱歉，无法规划。')).length, 0, '无数组 ⇒ []（旧 no-array 路径）');
  assert.equal((await planTasks('x', async () => '[{"id":1,"action":"unclosed')).length, 0, '截断输出 ⇒ []（未闭 ⇒ null）');
  // 纯函数面：span 定位（嵌套深度回到 0 的首个 ']'）
  assert.deepEqual(extractJsonArraySpan('xx [1,[2]] yy'), { start: 3, end: 9 });
  assert.equal(extractJsonArraySpan('no array here'), null, '无数组 ⇒ null');
  assert.equal(extractJsonArraySpan(''), null, '空文本 ⇒ null');
  assert.doesNotThrow(() => extractJsonArraySpan('{"note":"use [b]"}'),
    '字符串先于数组的病态文本不抛（span 可落串内 —— 调用方 parse 失败诚实落 []，与旧法同归宿）');
});
