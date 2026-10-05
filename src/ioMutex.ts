// src/ioMutex.ts
// D-1 物理躯体公理的唯一代码落点：鼠标键盘全系统唯一 —— 动作类 IO 全局串行化。
// 「一台躯体，多重心智」：子代理在认知层并发，触碰物理 IO 时在此量子坍缩为排队。
// 单会话调用者完全透明（Promise 链透传）；失败不毒化队列（后续调用照常）。
// 独立成零原生依赖小模块：可被任意测试环境直接导入验证，不拖带 nut-js 原生库
//（P1-1 起引入的唯一依赖是本插件自家的 config schema —— 纯 JS，随宿主必在）。
//
// ─── P1-1（地基速修）：排队/执行超时 ───
// 旧不变量的漏洞：一次挂死的物理调用（底层服务假死/驱动卡顿）让 tail 永不前进，
// 全系统所有后续 IO 永久排队 —— 单点故障变成躯体级瘫痪。
// P1-1 立法：超时只杀「这一次调用」的返回值（调用者收到 [TIMEOUT] 错误），
// 绝不毒化队列（后续 IO 照常入队执行）—— 与 orchestrator 的
// "timeout kills one attempt, not the pipeline" 同律（orchestration/index.ts）。
//
// ─── ΠΑΝ-33（超时语义修正：上报超时 ≠ 放行队列）───
// P1-1 的「链尾放行」在时钟先到时把 tail 前滚到超时点，下一个 serialize 的
// fn 立即开跑 —— 而超时的底层 fn（真实键鼠派发）仍在执行：挂死的服务调用
// 恢复后与后续 IO 并发，两次物理动作可交错落到同一躯体，D-1「一台躯体」
// 公理在超时路径失效（批判 C1-2 H4）。修正后的执法不变量：
//   · 超时只对**调用方**上报 IoTimeoutError（回执形状逐字不变：[TIMEOUT]
//     前缀 + 预算事实 —— resultContract/isIoTimeoutError 消费方零改动）；
//   · 队列 tail 恒等待**真实终局**（settle 吞错镜像已有）—— 挂死调用真正
//     落定之前，后续 IO 在队尾物理排队，串行公理不因超时而破；
//   · 可选取消传播：调用方可挂 cancel 端口（如触发底层 AbortController），
//     超时即尽力中止挂死调用（端口缺席/炸裂 ⇒ 只等待 settle，防御式不抛）。

import { Config } from './config';

/** config.ioTimeoutMs 缺省镜像：schema 不可载时的诚实降级值（宪章第一条：依赖缺席不炸宿主） */
const FALLBACK_IO_TIMEOUT_MS = 15000;

/**
 * config schema 的规范化调用面：schemastery 运行时本就可调用（宿主装载配置的
 * 同款路径 —— 传空对象即取全部声明缺省），只是项目内 TS 类型未暴露调用签名。
 * 单点收敛的窄函数断言（唯一铸造点纪律，不做 as-any 走私）。
 */
type SchemaDefaults = (input?: Record<string, unknown>) => { ioTimeoutMs?: unknown };

/** 模块级缺省超时：单一事实源是 config schema 声明的 ioTimeoutMs 缺省（P1-1 立法） */
let ioTimeoutDefaultMs: number = (() => {
  try {
    const v = (Config as unknown as SchemaDefaults)({}).ioTimeoutMs;
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : FALLBACK_IO_TIMEOUT_MS;
  } catch {
    return FALLBACK_IO_TIMEOUT_MS; // schema 调用失败：降级为镜像值，绝不阻断模块装载
  }
})();

/**
 * 运行时改写缺省超时（部署配置接线面）：宿主把 cordis.yml 的 ioTimeoutMs 值
 * 灌入此处后，全部不传参的 serialize 调用即刻生效。0 = 无限等（旧行为）。
 */
export function configureIoTimeout(ms: number): void {
  ioTimeoutDefaultMs = typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 ? ms : 0;
}

/** 缺省超时当前值（测试/遥测观测面） */
export function getIoTimeoutDefault(): number {
  return ioTimeoutDefaultMs;
}

/** P1-1 超时标记：与 orchestrator 的 '[TIMEOUT]' 方言逐字一致（resultContract 消费方按 includes 判定） */
export const IO_TIMEOUT_MARKER = '[TIMEOUT]';

/**
 * P1-1 超时错误：仅承载「这一次 IO 没能在预算内落定」的事实。
 * message 以 [TIMEOUT] 开头 —— 工具层 catch 后把 error.message 透传进 toolErr，
 * 即自动获得项目现有超时方言（无需逐工具改造）。
 * ΠΑΝ-33：文案只陈述「本调用已出局 + 队列保持严格串行」的事实 —— 回执形状
 * （[TIMEOUT] 前缀 + 预算数字）不变，语义描述随队列执法修正。
 */
export class IoTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(
      `${IO_TIMEOUT_MARKER} ioMutex physical IO did not settle within ${timeoutMs}ms ` +
      `(config.ioTimeoutMs) — this call is aborted for its caller; the physical queue ` +
      `keeps strict serialization until the hung call truly settles`,
    );
    this.name = 'IoTimeoutError';
  }
}

/** 工具层/调用方的程序化判别：这次失败是不是 IO 排队超时（区别于底层真实错误） */
export function isIoTimeoutError(e: unknown): boolean {
  return e instanceof IoTimeoutError ||
    (e instanceof Error && e.message.startsWith(IO_TIMEOUT_MARKER));
}

/** 超时参数裁决：显式传参优先（0/负/NaN = 无限等，与 config.ioTimeoutMs=0 语义同）；
 *  缺省走模块缺省值（configureIoTimeout 可运行时改写）。返回 0 = 旧行为（无限等） */
function resolveIoTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs !== undefined) {
    return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 0;
  }
  return ioTimeoutDefaultMs > 0 ? ioTimeoutDefaultMs : 0;
}

let tail: Promise<unknown> = Promise.resolve();

/**
 * 全局 IO 互斥：fn 排入唯一串行队列，按到达序执行。
 * 对单会话调用者是直通（无并发时零额外延迟，仅一次微任务跳转）；
 * 对多心智并发调用者是坍缩点（后来者等待先至者完成物理动作）。
 *
 * P1-1 可选超时（timeoutMs）：
 *  - 不传 = 用缺省配置值（config.ioTimeoutMs 声明的缺省；可经 configureIoTimeout 改写）；
 *  - 0 / 负 / NaN = 无限等待（P1-1 之前的旧行为，逐字保留）；
 *  - >0 = 排队+执行总预算。超时 ⇒ 本调用以 IoTimeoutError（[TIMEOUT] 方言）收场。
 *
 * ΠΑΝ-33 超时执法（上报超时 ≠ 放行队列）：
 *  - 队列 tail 恒等待**真实终局**——超时的挂死调用真正落定前，后续 IO 保持
 *    物理排队（D-1 串行公理在超时路径同样成立；旧实现的 race 放行让下一 IO
 *    与仍挂死的 fn 并发，破坏唯一躯体不变量）；
 *  - cancel 端口（可选第三参）：超时即调用一次，用于中止底层挂死调用（如
 *    AbortController.abort）；缺席/抛错 ⇒ 防御吞掉，只等待真实 settle；
 *  - 超时调用方的迟来终局被 settle 吞错镜像吸收（无 unhandled rejection），
 *    也不再影响任何后续调用的结果。
 * 现有调用方全部一元/二元调用 —— 签名向后兼容，零改动即继承缺省超时保护。
 */
export function serialize<T>(fn: () => Promise<T>, timeoutMs?: number, cancel?: () => void): Promise<T> {
  const tmo = resolveIoTimeout(timeoutMs);

  // 旧行为直通（无超时）：链结构与 P1-1 之前逐字一致 —— 0 配置 = 零行为变化
  if (tmo <= 0) {
    const run = tail.then(fn, fn); // 前序失败也放行本序（失败不毒化队列）
    tail = run.then(() => undefined, () => undefined); // 链尾吞错：只传递给本序调用者
    return run;
  }

  const run = tail.then(fn, fn); // 前序失败也放行本序（失败不毒化队列）
  // 实际终局的吞错镜像：超时后 run 的迟来终局在此吸收（防 unhandled rejection）
  const settle = run.then(() => undefined, () => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clock = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new IoTimeoutError(tmo)), tmo);
  });
  // 实际终局先到 ⇒ 撤时钟（悬空计时器会拖住事件循环，宿主卸载/测试退出被 15s 押后）
  settle.then(() => { if (timer !== undefined) clearTimeout(timer); });
  // ΠΑΝ-33：队列尾只认真实终局 —— 超时上报给调用方，tail 不前滚（挂死的
  // 物理动作恢复前，下一位仍在队尾等待；「杀一次调用」不升级为「破一次互斥」）
  tail = settle;
  // ΠΑΝ-33：取消传播 —— 端口在场则超时即尽力中止底层调用（缺席/炸裂 ⇒ 只等待
  // settle，防御式不抛；clock 的拒绝在此被吞，不产生 unhandled rejection）
  clock.catch(() => {
    try { cancel?.(); } catch { /* 取消端口炸裂不毒化队列 */ }
  });
  // 调用方视角：先到者胜（真实值或 [TIMEOUT] 错误）—— 回执形状不变
  return Promise.race([run, clock]);
}
