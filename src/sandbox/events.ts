// src/sandbox/events.ts
// D-5 事件表面单点收口（hooks.ts 方言：as-any 集中于此，换 DSH 版本只改一处）。
// 事件载荷铁律：Skinny 载荷 + 落盘句柄 —— 事件只传信号与定位锚，
// 报告全文走 reportPath（Token 纪律）。
// 产权：sandbox/* 四事件名与载荷归 D-5 发射主权；
//      cognition/plan-ready 事件名与联合方言载荷契约归 D-1 主权（cognitionEvents.ts
//      唯一事实源，P0-3 收敛）—— 本文件仅消费侧再导出（依赖倒置：ActionChain 的
//      D-5 主权类型经 cognitionEvents 的 chain 臂进入联合方言）。
import type { Context } from '@deepseek-ai/cordis';
import type { DoctorVerdictPayload } from '../doctorEvents';
import { DOCTOR_VERDICT_EVENT } from '../doctorEvents';
// P0-3：事件名与载荷联合方言收敛 D-1 单源（cognitionEvents.ts 唯一事实源），
// 本文件只做消费侧再导出 —— 依赖方向对齐 doctorEvents 先例（D-5 import D-4 契约）。
import { COGNITION_PLAN_READY_EVENT } from '../cognitionEvents';
import type { CognitionPlanReadyPayload } from '../cognitionEvents';
import type {
  HostReplayOutcome, MuscleMemoryEntry, RehearsalVerdict, Score,
} from './types';

/** D-5 发射事件名注册表（as const 防拼写漂移） */
export const SANDBOX_EVENTS = {
  rehearsalBegin: 'sandbox/rehearsal-begin',
  rehearsalEnd: 'sandbox/rehearsal-end',
  memoryConsolidated: 'sandbox/memory-consolidated',
  hostReplayEnd: 'sandbox/host-replay-end',
} as const;

/** D-1 发射、D-5 消费 —— 事件名与载荷契约归 D-1 主权（cognitionEvents.ts 单源再导出） */
export { COGNITION_PLAN_READY_EVENT };
export type { CognitionPlanReadyPayload };

// ─── D-5 发射的载荷契约 ───

export interface RehearsalBeginPayload {
  chainId: string;
  snapshotId: string;
  startedAt: number;
}

export interface RehearsalEndPayload {
  chainId: string;
  snapshotId: string;
  verdict: RehearsalVerdict;
  /** makeScore 铸造；D-4 翻译的原始输入 */
  score: Score;
  /** doctor/verdict 回执的关联锚（逐字对应） */
  chainTip: string;
  /** 全量证据落盘句柄 */
  reportPath: string;
  endedAt: number;
}

export interface MemoryConsolidatedPayload {
  entryId: string;
  trigger: string;
  /** 0-1 域裸 number（Reliability brand 按先例暂缓：隐患现形再扩展） */
  reliability: number;
  rehearsalPassCount: number;
}

export interface HostReplayEndPayload {
  muscleMemoryId: string;
  /** 索引访问 —— 单一事实源，绝不复写联合类型 */
  verdict: HostReplayOutcome['verdict'];
  divergenceCount: number;
  reportPath: string;
  endedAt: number;
}

/** D-1 计划就绪载荷 —— 联合方言契约见 cognitionEvents.ts（P0-3 单源收敛）；
 *  D-5 只消费 chain 臂（排练投喂需求），intent 双方言臂是 D-6/D-7 主权 */

// ─── 类型化挂载 / 发射表面 ───
// emit 经集中 as-any：宿主 stub 未声明 emit（与 hooks.ts 对 on 的处理同方言）；
// 一切表面永不抛错 —— 发射失败是旁路义务，不阻断主流程。

export function emitRehearsalBegin(ctx: Context, p: RehearsalBeginPayload): void {
  (ctx as any).emit(SANDBOX_EVENTS.rehearsalBegin, p);
}

export function emitRehearsalEnd(ctx: Context, p: RehearsalEndPayload): void {
  (ctx as any).emit(SANDBOX_EVENTS.rehearsalEnd, p);
}

export function emitMemoryConsolidated(ctx: Context, p: MemoryConsolidatedPayload): void {
  (ctx as any).emit(SANDBOX_EVENTS.memoryConsolidated, p);
}

export function emitHostReplayEnd(ctx: Context, p: HostReplayEndPayload): void {
  (ctx as any).emit(SANDBOX_EVENTS.hostReplayEnd, p);
}

export function onCognitionPlanReady(
  ctx: Context,
  handler: (p: CognitionPlanReadyPayload) => void,
): void {
  (ctx as any).on(COGNITION_PLAN_READY_EVENT, handler);
}
// 联合方言消费纪律：handler 收到的是三方言联合 —— 消费方必须自行收窄
// （D-5 只认 'chain' in payload 的链臂；intent 臂属 D-6/D-7 主权，D-5 绝不排练意图）。

export function onDoctorVerdict(
  ctx: Context,
  handler: (p: DoctorVerdictPayload) => void,
): void {
  (ctx as any).on(DOCTOR_VERDICT_EVENT, handler);
}

// ─── 宿主观察嗅探（TRUST IS A FINGERPRINT 的镜像源头）───
// D-5 监听宿主管线 post-execute，尽力嗅探结果 JSON 中的屏指纹字段。
// 嗅探缺席 ⇒ 快照诚实降级（screenDhash=''）—— 无证据 = 门禁拒绝，保守方向。

/** 宿主工具结果中可接受的指纹字段名（按宿主锚点方言增补，收口于此） */
const FINGERPRINT_KEYS = ['scene_fingerprint', 'screen_dhash', 'dhash', 'scene_hash'] as const;

/** 从任意宿主工具结果中嗅探 64 位指纹串；缺席返回 null（诚实，不伪造） */
export function sniffFingerprint(result: unknown): string | null {
  if (typeof result !== 'string') return null;
  // 宿主工具结果可能是 JSON 字符串或前缀协议文本 —— 只对 JSON 路径嗅探
  const trimmed = result.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, any>;
    const anchor = typeof parsed.state_anchor === 'object' && parsed.state_anchor !== null
      ? parsed.state_anchor
      : parsed;
    for (const key of FINGERPRINT_KEYS) {
      const v = anchor[key];
      if (typeof v === 'string' && /^[01]{64}$/.test(v)) return v;
    }
    return null;
  } catch {
    return null;
  }
}

/** 供 engine 注册宿主观察缓存时使用的事件表面（复用 hooks 的 ToolCall 方言） */
export interface HostToolPostCall {
  name: string;
  args: Record<string, any>;
}

export function onHostToolPost(
  ctx: Context,
  handler: (call: HostToolPostCall, result: any) => void,
): void {
  (ctx as any).on('tools/post-execute', (call: HostToolPostCall, result: any, next: (v: any) => any) => {
    handler(call, result);
    return next(result); // 纯观察，原样透传（waterfall 礼仪）
  });
}

export type { MuscleMemoryEntry };
