// src/orchestration/pipeline.helpers.ts
// W6-2（doctor smell.over-engineering 清偿）：自 pipeline.ts 低风险分区提取
// （>500 行拆分信号）—— 事件常量 / 工位接口 / 网格分区铸造 / 尝试超时包裹 /
// 沙箱链入账 / grounding 预算常量整体搬迁。行为零变化；pipeline.ts 导入消费，
// 导入面不变（PipelineStations 等公开类型经 pipeline.ts 再分发）。
import type { RegionSpec, VisionStation, DecisionStation, ExecutionStation } from './contracts';
import { sandboxLog } from '../sandbox/log';

/** D-6 事件面（events.ts 浇筑时收口；编排器先经 log + 事件常量占位，零直接调用） */
export const EVT_PIPELINE_RUN_END = 'pipeline/run-end';
export const EVT_PIPELINE_ATTEMPT = 'pipeline/attempt';
export const EVT_PIPELINE_GROUNDING = 'pipeline/grounding-request';

export interface PipelineStations {
  vision: VisionStation;
  decision: DecisionStation;
  execution: ExecutionStation;
  /** 事件发射面（index.ts 注入 ctx；null = 无宿主事件面 —— 开发者预览） */
  emit?: (event: string, payload: Record<string, unknown>) => void;
  /**
   * O 纪元（#8）：工位消耗计量探针 —— 谁计量？**工位自报**（只有工位知道
   * 自己烧了什么）。接线方（index.ts）包装工位通道铸造探针；finalReport 读取。
   * 探针缺席 ⇒ 该工位报告 0（未计量 ≠ 未消耗 —— 报告字段命名 Reported 如实）。
   * 决策工位缺省探针：chat 包装器累计 (prompt+response chars)/4 的估计。
   */
  usageMeter?: {
    vision?: () => number;
    decision?: () => number;
    execution?: () => number;
  };
}

/** 网格分区铸造（'g{col}x{row}' —— 坐标同一性，跨轮稳定） */
export function gridRegions(grid: { cols: number; rows: number }): RegionSpec[] {
  const regions: RegionSpec[] = [];
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
export async function withAttemptTimeout<T>(
  p: Promise<T>, timeoutMs: number, fallback: T,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>(resolve => {
        timer = setTimeout(() => resolve(fallback), timeoutMs);
      }),
    ]);
  } catch {
    return fallback; // 工位违约抛错 ⇒ 结构化捕获（纵深防御）
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 沙箱链入账（复用 D-5 账本，D-6 链段 kind 前缀 'pipeline-' —— 与宿主账本分链）。
 *  P1-5：'pipeline-*' 已收编入 SandboxLogKind 显式契约 —— 类型逃逸（as any）消灭。 */
export async function logPipeline(kind: 'pipeline-attempt' | 'pipeline-retry' | 'pipeline-grounding' |
  'pipeline-grounding-denied' | 'pipeline-grounding-review' | 'pipeline-vision-breach' |
  'pipeline-internal-fault' | 'pipeline-run-end', data: Record<string, unknown>): Promise<void> {
  await sandboxLog.append(kind, data);
}

/** 每 run 的 L3 花钱批准预算（风险加固）：决策工位可反复要 grounding（桩纪元
 *  无记账），恒批准 = L3 失控循环的绿色通道 —— 超预算即诚实拒绝终局） */
export const MAX_GROUNDING_APPROVALS_PER_RUN = 3;
