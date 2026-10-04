// src/notary/replayWitness.ts
// D-G5（W8 第 2 批）：重放轨迹见证的铸证便捷面 —— DEBTS「replayOne 重放层不
// 采集公证证据」的清偿件。见证数据面（ReplayStepWitness/ReplayTrajectoryWitness）
// 住在 primitives（锚记录数据面同册）；本册持有：
//   · replayStepFingerprint —— 步指纹铸造（journal 链哈希优先，缺席走 canonical 摘要）；
//   · anchorReplayTrajectoryOn —— 把见证铸进 notary 锚的便捷面（结构性目标端口，
//     Notary 单例天然满足；测试假件只须实现同名两面）。
// 运行铁律（与 notary 同源）：公共面永不抛 —— 公证是旁路仪式，缺席/失败 = 诚实
// 降级返回（status:'degraded' + reason），绝不炸调用方（重放绝不因公证阻断）。
import { canonical, sha256Hex, errText } from './primitives';
import type { AnchorRecord, ReplayTrajectoryWitness } from './primitives';

/** 铸证注入面（anchorOnce 的结构子集 + 便捷面自身的注入缝 —— 测试确定性） */
export interface ReplayAnchorOptions {
  /** 覆盖单例端点（'' = 本地时间锚零网络；undefined = 用单例配置） */
  endpoint?: string;
  /** 注入时钟（缺省 Date.now） */
  now?: () => number;
  /** 注入 fetch（缺省 Node 全局 fetch —— 仅 rfc3161 路径触网） */
  fetchImpl?: typeof fetch;
  /** 注入 CSPRNG（nonce 确定性测试缝） */
  random?: (n: number) => Uint8Array;
  /** rfc3161 超时毫秒（缺省 5000） */
  timeoutMs?: number;
}

/**
 * 铸证目标端口（结构性）：Notary 单例天然满足（isConfigured/anchorOnce 同名），
 * 测试假件只须实现同面 —— 「假 notary 锚捕获摘要」的执法缝。
 */
export interface NotaryTarget {
  /** 宿主是否已装配公证账本（未装配 ⇒ 诚实降级，不铸锚） */
  isConfigured(): boolean;
  /** 铸锚面（见证经 witness 入哈希域与时间戳摘要域） */
  anchorOnce(opts: ReplayAnchorOptions & { witness?: ReplayTrajectoryWitness }): Promise<AnchorRecord | null>;
  /** 最近一次内部故障（降级取证；可选 —— 缺席面容忍） */
  readonly lastError?: string | null;
}

/** 铸证结局（诚实两态 + 事实字段；绝不抛） */
export type ReplayAnchorResult =
  | {
    status: 'anchored';
    /** 承载见证的锚哈希（防篡改指纹 —— 复核入口） */
    anchorHash: string;
    /** 时间背书源（local = 本地钟零网络；rfc3161 = 第三方回执） */
    timestampSource: 'local' | 'rfc3161';
    /** 锚定时刻 journal 条数 */
    seq: number;
  }
  | {
    status: 'degraded';
    /** 降级归因（如实申报，绝不掩盖） */
    reason: string;
  };

/**
 * 步指纹铸造（纯函数，永不抛）：journal 链哈希优先（在册行为步的既有防篡改
 * 身份 —— 复用绝不复制）；链哈希缺席（未入链的步骤面）⇒ canonical({tool,args})
 * 的 sha256。全量身份留在锚上（Token 纪律由消费方注记面自理）。
 */
export function replayStepFingerprint(entry: {
  tool?: unknown;
  args?: unknown;
  hash?: unknown;
} | null | undefined): string {
  try {
    if (!entry || typeof entry !== 'object') return '';
    if (typeof entry.hash === 'string' && entry.hash !== '') return entry.hash;
    const tool = typeof entry.tool === 'string' ? entry.tool : String(entry.tool ?? '');
    return sha256Hex(canonical({ tool, args: entry.args ?? {} }));
  } catch {
    return ''; // 指纹铸造绝不抛（空串 = 指纹缺席，见证如实携空）
  }
}

/**
 * 把回放轨迹见证铸进 notary 锚（便捷面，永不抛）：
 *   · 目标缺席/坏形状 ⇒ degraded 'notary-target-absent'；
 *   · 宿主未装配公证账本（isConfigured 假 —— 未走 index.ts 接线的嵌入面）⇒
 *     degraded 'notary-not-configured'（公证缺席的诚实降级，绝不静默伪锚）；
 *   · anchorOnce 返回 null / 抛错 ⇒ degraded（归因带 lastError，绝不掩盖）；
 *   · 成功 ⇒ anchored（anchorHash/timestampSource/seq 事实字段）。
 * endpoint 空 = 本地时间锚零网络（既有纪律保持）；rfc3161 失败自动回退 local
 * 并在锚上留注记（anchorOnce 既有语义，此处零重复）。
 */
export async function anchorReplayTrajectoryOn(
  target: NotaryTarget | null | undefined,
  witness: ReplayTrajectoryWitness,
  opts: ReplayAnchorOptions = {},
): Promise<ReplayAnchorResult> {
  try {
    if (!target || typeof target.anchorOnce !== 'function') {
      return { status: 'degraded', reason: 'notary-target-absent（铸证目标缺席 —— 公证旁路零行为）' };
    }
    if (typeof target.isConfigured === 'function' && !target.isConfigured()) {
      return {
        status: 'degraded',
        reason: 'notary-not-configured（宿主未装配公证账本 —— 公证缺席，回放证据不入锚链，诚实降级不阻断）',
      };
    }
    const anchor = await target.anchorOnce({ witness, ...opts });
    if (!anchor) {
      const lastError = typeof target.lastError === 'string' && target.lastError !== '' ? `（${target.lastError}）` : '';
      return { status: 'degraded', reason: `anchor-mint-failed（铸锚失败${lastError} —— 公证旁路绝不阻断回放）` };
    }
    return {
      status: 'anchored',
      anchorHash: anchor.hash,
      timestampSource: anchor.timestamp.source,
      seq: anchor.seq,
    };
  } catch (e) {
    return { status: 'degraded', reason: `anchor-crashed（${errText(e)} —— 公证旁路绝不阻断回放）` };
  }
}
