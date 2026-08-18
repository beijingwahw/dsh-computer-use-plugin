// src/ioMutex.ts
// D-1 物理躯体公理的唯一代码落点：鼠标键盘全系统唯一 —— 动作类 IO 全局串行化。
// 「一台躯体，多重心智」：子代理在认知层并发，触碰物理 IO 时在此量子坍缩为排队。
// 单会话调用者完全透明（Promise 链透传）；失败不毒化队列（后续调用照常）。
// 独立成零依赖小模块：可被任意测试环境直接导入验证，不拖带 nut-js 原生库。
let tail = Promise.resolve();
/**
 * 全局 IO 互斥：fn 排入唯一串行队列，按到达序执行。
 * 对单会话调用者是直通（无并发时零额外延迟，仅一次微任务跳转）；
 * 对多心智并发调用者是坍缩点（后来者等待先至者完成物理动作）。
 */
export function serialize(fn) {
    const run = tail.then(fn, fn); // 前序失败也放行本序（失败不毒化队列）
    tail = run.then(() => undefined, () => undefined); // 链尾吞错：只传递给本序调用者
    return run;
}
