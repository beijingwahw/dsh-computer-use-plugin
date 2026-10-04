import { sandboxLog } from '../sandbox/log.js';
/** D-6 事件面（events.ts 浇筑时收口；编排器先经 log + 事件常量占位，零直接调用） */
export const EVT_PIPELINE_RUN_END = 'pipeline/run-end';
export const EVT_PIPELINE_ATTEMPT = 'pipeline/attempt';
export const EVT_PIPELINE_GROUNDING = 'pipeline/grounding-request';
/** 网格分区铸造（'g{col}x{row}' —— 坐标同一性，跨轮稳定） */
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
/** 尝试超时包裹：attemptTimeoutMs 越限 ⇒ fallback（杀一刀，不杀流水线）。
 *  泛型无约束 —— 同时包裹 DecisionOutput 与 ExecutionResult 两形态 */
export async function withAttemptTimeout(p, timeoutMs, fallback) {
    let timer;
    try {
        return await Promise.race([
            p,
            new Promise(resolve => {
                timer = setTimeout(() => resolve(fallback), timeoutMs);
            }),
        ]);
    }
    catch {
        return fallback; // 工位违约抛错 ⇒ 结构化捕获（纵深防御）
    }
    finally {
        if (timer)
            clearTimeout(timer);
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
