import { sandboxLog } from '../sandbox/log.js';
/** D-6 事件面（events.ts 浇筑时收口；编排器先经 log + 事件常量占位，零直接调用） */
export const EVT_PIPELINE_RUN_END = 'pipeline/run-end';
export const EVT_PIPELINE_ATTEMPT = 'pipeline/attempt';
export const EVT_PIPELINE_GROUNDING = 'pipeline/grounding-request';
/** 网格分区铸造（'g{col}x{row}' —— 坐标同一性，跨轮稳定） */
// exempt(ΝΩ-41 BC-5)：与 knowledge/stations.ts 同体有意双份（orchestration 与 knowledge 互不 import 的器官边界律，行为由 D-6 同一性测试锁定）—— 知情申报
export function gridRegions(grid) {
    const regions = [];
    for (let col = 0; col < grid.cols; col++) {
        for (let row = 0; row < grid.rows; row++) {
            regions.push({
                id: `g${col}x${row}`,
                x: col / grid.cols, y: row / grid.rows,
                width: 1 / grid.cols, height: 1 / grid.rows,
            });
        }
    }
    return regions;
}
/** 尝试超时包裹（ΝΩ-8 重铸）：attemptTimeoutMs 越限 ⇒ fallback（杀一刀，不杀流水线）。
 *  与旧 Promise.race+fallback 的唯一差别在「止损」：超时/外部取消时主动 abort ——
 *  旧实现超时后原工位 promise 继续无后果飞行，迟到的真实点击仍会落地
 *  （computer-use 的不可逆世界污染）；现在 abort 沿 ExecutionOrder.signal 直达
 *  HTTP 层断流。工位不消费 signal 时行为与旧路径一致（abort 无监听者 = no-op），
 *  race/fallback/违约捕获语义逐字节保持。
 *  工厂化签名（make 而非既成 promise）是止损的前提：signal 必须在工位调用铸造时
 *  就在手 —— promise 既成之后再给信号，链接已无从注入。
 *  泛型无约束 —— 同时包裹 DecisionOutput 与 ExecutionResult 两形态。
 * @param make 工位调用铸造器（signal = 本尝试止损信号，编排器注入 ExecutionOrder）
 * @param external 外部终止信号（run 级取消）：与内部超时组合 —— 任一触发即 abort
 *  （组合语义对齐 httpClient.ts microFetch：已 abort ⇒ 立即触发；监听 once + finally 拆除，
 *   长命外部 signal 上不留残听）。abort 只发信号不解决竞速 —— 工位 promise 的归宿
 *   仍由竞速裁决（abort 感知的工位快速失败，无感的等内层超时兜底） */
export async function withAttemptTimeout(make, timeoutMs, fallback, external) {
    const ctrl = new AbortController();
    let onExternal;
    if (external) {
        if (external.aborted)
            ctrl.abort();
        else {
            onExternal = () => ctrl.abort();
            external.addEventListener('abort', onExternal, { once: true });
        }
    }
    let timer;
    try {
        return await Promise.race([
            make(ctrl.signal),
            new Promise(resolve => {
                // 顺序即裁决确定性：先 resolve(fallback) 再 abort —— abort 监听器同步派发，
                // 直接监听 signal 的工位 promise 可能同刻交出真实值；fallback 先落定 ⇒
                // 超时归因恒定（工位的迟到归宿被 race 忽略，abort 只负责链路断流）
                timer = setTimeout(() => { resolve(fallback); ctrl.abort(); }, timeoutMs);
            }),
        ]);
    }
    catch {
        return fallback; // 工位违约抛错（含工厂同步抛）⇒ 结构化捕获（纵深防御）
    }
    finally {
        if (timer)
            clearTimeout(timer);
        if (external && onExternal)
            external.removeEventListener('abort', onExternal);
    }
}
/** 沙箱链入账（复用 D-5 账本，D-6 链段 kind 前缀 'pipeline-' —— 与宿主账本分链）。
 *  P1-5：'pipeline-*' 已收编入 SandboxLogKind 显式契约 —— 类型逃逸（as any）消灭。 */
export async function logPipeline(kind, data) {
    await sandboxLog.append(kind, data);
}
/** 每 run 的 L3 花钱批准预算（风险加固）：决策工位可反复要 grounding（桩纪元
 *  无记账），恒批准 = L3 失控循环的绿色通道 —— 超预算即诚实拒绝终局） */
export const MAX_GROUNDING_APPROVALS_PER_RUN = 3;
// ─── ΝΩ-26（编排调度四修）：帧复用 / 脏区判定 / 消耗探针的共用面 ───
/** ΝΩ-26：分区补丁复用窗口（ms）。超过此窗龄的缓存补丁一律疑脏重扫 ——
 *  复用是有界信任而非无限信任（世界可以自己动，capturedAt 只申报陈旧度，
 *  窗口保证陈旧度有上界）。缺省值与 L1/L2 适配器帧缓存 TTL（1500ms）同源：
 *  适配器帧还在 ⇒ 补丁复用零成本；帧过期 ⇒ 重扫恰好拿到新帧。 */
export const SCENE_REUSE_TTL_MS = 1500;
/** ΝΩ-26：分区内容指纹（dhash 方言）。管线层无像素字节（注意力隔离 ——
 *  像素永不进编排），指纹以 ScenePatch 元素面为源：role/name/state + rect
 *  定点 3 位（≈0.1% 屏宽，坐标微抖不敏感）的确定性摘要。与 perceptualHash
 *  的图像 dhash 同职同语义：内容未变 ⇒ 指纹未变 ⇒ 复用旧补丁（capturedAt
 *  如实申报数据年龄 —— 诚实方言）。 */
export function sceneDhash(patch) {
    const els = patch.elements
        .map(e => `${e.role}|${e.name}|${e.state ?? ''}` +
        `|${e.rect.x.toFixed(3)},${e.rect.y.toFixed(3)},${e.rect.width.toFixed(3)},${e.rect.height.toFixed(3)}`)
        .join(';');
    return `${patch.funnelDepth}#${patch.elements.length}#${els}`;
}
/** ΝΩ-26：工位消耗探针的安全读数（O 纪元 #8 方言，自 finalReport 下沉共用）：
 *  探针缺席 / 抛错 / 域外 ⇒ 0（未计量 ≠ 未消耗 —— 扣减制只认自报数，
 *  绝不猜测）。 */
export function readUsageProbe(p) {
    try {
        const v = p?.();
        return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0;
    }
    catch {
        return 0;
    }
}
