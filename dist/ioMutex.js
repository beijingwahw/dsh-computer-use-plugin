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
// 新不变量：超时只杀「这一次调用」的返回值（调用者收到 [TIMEOUT] 错误），
// 绝不毒化队列（tail 同时放行，后续 IO 照常入队执行）—— 与 orchestrator 的
// "timeout kills one attempt, not the pipeline" 同律（orchestration/index.ts）。
// 超时后底层 fn 仍在跑（Promise 不可真取消）—— 其终局被链尾吞掉，不产生
// unhandled rejection，也不再影响任何后续调用的结果。
import { Config } from './config.js';
/** config.ioTimeoutMs 缺省镜像：schema 不可载时的诚实降级值（宪章第一条：依赖缺席不炸宿主） */
const FALLBACK_IO_TIMEOUT_MS = 15000;
/** 模块级缺省超时：单一事实源是 config schema 声明的 ioTimeoutMs 缺省（P1-1 立法） */
let ioTimeoutDefaultMs = (() => {
    try {
        const v = Config({}).ioTimeoutMs;
        return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : FALLBACK_IO_TIMEOUT_MS;
    }
    catch {
        return FALLBACK_IO_TIMEOUT_MS; // schema 调用失败：降级为镜像值，绝不阻断模块装载
    }
})();
/**
 * 运行时改写缺省超时（部署配置接线面）：宿主把 cordis.yml 的 ioTimeoutMs 值
 * 灌入此处后，全部不传参的 serialize 调用即刻生效。0 = 无限等（旧行为）。
 */
export function configureIoTimeout(ms) {
    ioTimeoutDefaultMs = typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 ? ms : 0;
}
/** 缺省超时当前值（测试/遥测观测面） */
export function getIoTimeoutDefault() {
    return ioTimeoutDefaultMs;
}
/** P1-1 超时标记：与 orchestrator 的 '[TIMEOUT]' 方言逐字一致（resultContract 消费方按 includes 判定） */
export const IO_TIMEOUT_MARKER = '[TIMEOUT]';
/**
 * P1-1 超时错误：仅承载「这一次 IO 没能在预算内落定」的事实。
 * message 以 [TIMEOUT] 开头 —— 工具层 catch 后把 error.message 透传进 toolErr，
 * 即自动获得项目现有超时方言（无需逐工具改造）。
 */
export class IoTimeoutError extends Error {
    constructor(timeoutMs) {
        super(`${IO_TIMEOUT_MARKER} ioMutex physical IO did not settle within ${timeoutMs}ms ` +
            `(config.ioTimeoutMs) — this call is aborted, the queue is released for subsequent IO`);
        this.name = 'IoTimeoutError';
    }
}
/** 工具层/调用方的程序化判别：这次失败是不是 IO 排队超时（区别于底层真实错误） */
export function isIoTimeoutError(e) {
    return e instanceof IoTimeoutError ||
        (e instanceof Error && e.message.startsWith(IO_TIMEOUT_MARKER));
}
/** 超时参数裁决：显式传参优先（0/负/NaN = 无限等，与 config.ioTimeoutMs=0 语义同）；
 *  缺省走模块缺省值（configureIoTimeout 可运行时改写）。返回 0 = 旧行为（无限等） */
function resolveIoTimeout(timeoutMs) {
    if (timeoutMs !== undefined) {
        return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 0;
    }
    return ioTimeoutDefaultMs > 0 ? ioTimeoutDefaultMs : 0;
}
let tail = Promise.resolve();
/**
 * 全局 IO 互斥：fn 排入唯一串行队列，按到达序执行。
 * 对单会话调用者是直通（无并发时零额外延迟，仅一次微任务跳转）；
 * 对多心智并发调用者是坍缩点（后来者等待先至者完成物理动作）。
 *
 * P1-1 可选超时（timeoutMs）：
 *  - 不传 = 用缺省配置值（config.ioTimeoutMs 声明的缺省；可经 configureIoTimeout 改写）；
 *  - 0 / 负 / NaN = 无限等待（P1-1 之前的旧行为，逐字保留）；
 *  - >0 = 排队+执行总预算。超时 ⇒ 本调用以 IoTimeoutError（[TIMEOUT] 方言）收场，
 *    队列照常放行后续 IO（挂死者不再永久堵塞全局躯体）。
 * 现有调用方全部一元调用 —— 签名向后兼容，零改动即继承缺省超时保护。
 */
export function serialize(fn, timeoutMs) {
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
    let timer;
    const clock = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new IoTimeoutError(tmo)), tmo);
    });
    // 实际终局先到 ⇒ 撤时钟（悬空计时器会拖住事件循环，宿主卸载/测试退出被 15s 押后）
    settle.then(() => { if (timer !== undefined)
        clearTimeout(timer); });
    // 链尾：实际终局或超时，任一先到即放行后续 IO —— 「超时杀一次调用，不杀队列」
    tail = Promise.race([settle, clock.then(() => undefined, () => undefined)]);
    // 调用方视角：先到者胜（真实值或 [TIMEOUT] 错误）
    return Promise.race([run, clock]);
}
