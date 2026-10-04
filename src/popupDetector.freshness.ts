// src/popupDetector.freshness.ts
// W6-2（doctor smell.over-engineering 清偿）：自 popupDetector.ts 低风险分区提取
// （>500 行拆分信号）—— W2-2（S3）派发前接地新鲜度探针整体搬迁，导入面不变
// （popupDetector.ts 以 export * 再分发，既有消费方零改动）。
//
// ─── W2-2（S3）：派发前接地新鲜度探针（grounding freshness probe） ───
//
// 问题：危险点击（审批域）的坐标来自**接地时刻**的截图 —— 从截图到派发之间
// 隔着审批人机往返（分钟级），屏幕可能已发生相变（弹窗关闭/页面跳转/对话框
// 弹出）。对不可逆动作派发一组对着旧世界定位的坐标，是 stale-grounding 事故
// 的标准形态。
//
// 探针形态：派发前（approval.beginAttempt 之前）抓一帧低分辨率快图（经注入
// 端口 —— 生产默认端口 = D-5 metaOnly 服务端往返 + contextManager 的最近
// 截图指纹；测试注入假端口），与接地时截图的感知哈希（dHash）比对：
//   similarity ≥ 阈值 ⇒ fresh（放行派发）；
//   similarity < 阈值 ⇒ drifted（阻断本次派发 —— 返回「需重新截图定位」的
//     结构化结果供上层重感知；令牌未被烧：阻断在 beginAttempt/预留之前）；
//   端口缺席 / 取帧失败 / 指纹缺席 ⇒ degraded（放行 + 注记 —— fail-open）。
//
// fail-open 论证（与 S4 WAL 的 fail-closed 刻意不对称）：
//   · 本探针是**叠加防御**（defense in depth）—— 危险点击已过审批域令牌核验、
//     Ρ 纪元双钥公证（落点 OCR 实读 + 白盒控件名）、Β 纪元反驳法院，事后还有
//     V 纪元验收式消费兜底。叠加层失败时阻断全部危险点击，等于把增强层的
//     故障下沉为整个危险动作面的可用性故障 —— 风险收益倒挂。
//   · S4 审计则相反：审计是**不可抵赖性的地基**，没有审计行的动作从制度上
//     不该存在 —— 那是契约违反，必须 fail-closed。
//   · 降级不静默：degraded 判决随工具结果 state_anchor 透明化（模型/用户/
//     遥测可见），观测义务与可用性并存。
//   · 端口缺席是默认态（组合根接线前 / 离线测试），缺省放行保证既有行为
//     零回归（与 notaryEvidence「通道在场才收紧」同律）。
import { normalizeHash, similarity } from './perceptualHash';

/** W2-2（S3）：新鲜度探针注入端口 —— grounding 指纹源 + 当前快图源。
 *  null（未安装）⇒ 探针缺席 ⇒ degraded 放行。 */
export interface GroundingFreshnessPort {
  /** 接地指纹：最近一次 grounding 截图的 dHash（位串 / 服务端 hex 皆可 ——
   *  比较前经 normalizeHash 统一）。缺席 ⇒ degraded（无从比对）。 */
  groundingHash(): string | null | undefined;
  /** 当前低分辨率快图指纹（一次 metaOnly 采集，零叠加层零孵化）。
   *  失败/缺席 ⇒ degraded。绝不被要求重试 —— 探针是单发旁路。 */
  captureCurrentHash(): Promise<string | null | undefined>;
}

let freshnessPort: GroundingFreshnessPort | null = null;

/** 安装/卸载新鲜度探针端口（null 卸载 ⇒ 探针缺席降级）。 */
export function setFreshnessPort(port: GroundingFreshnessPort | null): void {
  freshnessPort = port;
}

/** 探针端口是否在场（测试与可观测性） */
export function freshnessPortInstalled(): boolean {
  return freshnessPort !== null;
}

/** W2-2（S3）：探针判决 */
export interface FreshnessVerdict {
  verdict: 'fresh' | 'drifted' | 'degraded';
  /** 双指相似度 0~100（drifted/fresh 在场；degraded 缺席 —— 诚实） */
  similarity_pct?: number;
  /** 判决阈值（0~100，透明化 —— 模型可理解阻断依据） */
  threshold_pct: number;
  /** degraded 的诚实注记（probe-port-absent / grounding-fingerprint-absent / ...） */
  note?: string;
}

/**
 * 漂移阈值：算法形状字面量。dHash 64 位下 0.85 ≈ 容忍 ~9.6 位翻转 ——
 * 光标移动/闪烁/滚动条微动的常见噪声（≤3-4 位）充分放行，而菜单开合/对话框
 * 弹出/页面跳变（通常 >15 位）稳定拦截；与 from_memory_id 预验的 0.85 同律
 * （同一「外观还像吗」问题的同一容差带）。
 */
export const GROUNDING_FRESHNESS_THRESHOLD = 0.85;

/** W2-2（S3）：派发前接地新鲜度探针（单发、绝不抛 —— 任何失败 ⇒ degraded）。 */
export async function probeGroundingFreshness(
  threshold: number = GROUNDING_FRESHNESS_THRESHOLD,
): Promise<FreshnessVerdict> {
  const tp = Math.round(threshold * 1000) / 10;
  try {
    if (!freshnessPort) return { verdict: 'degraded', threshold_pct: tp, note: 'probe-port-absent' };
    const grounding = freshnessPort.groundingHash();
    if (!grounding) {
      return { verdict: 'degraded', threshold_pct: tp, note: 'grounding-fingerprint-absent' };
    }
    const current = await freshnessPort.captureCurrentHash();
    if (!current) {
      return { verdict: 'degraded', threshold_pct: tp, note: 'current-capture-unavailable' };
    }
    const sim = similarity(normalizeHash(grounding), normalizeHash(current));
    const pct = Math.round(sim * 1000) / 10;
    return sim >= threshold
      ? { verdict: 'fresh', similarity_pct: pct, threshold_pct: tp }
      : { verdict: 'drifted', similarity_pct: pct, threshold_pct: tp };
  } catch (e: any) {
    // 旁路宪法：探针自身故障 = 通道缺席（fail-open + 观测），绝不炸派发主流程
    return { verdict: 'degraded', threshold_pct: tp, note: `probe-error:${String(e?.message ?? e).slice(0, 80)}` };
  }
}

/** 测试隔离缝：卸载探针端口（恢复缺省降级面） */
export function resetFreshnessProbe(): void {
  freshnessPort = null;
}

/**
 * 生产默认端口工厂（组合根接线用 —— `setFreshnessPort(defaultFreshnessPort())`）：
 *   groundingHash = contextManager 最近截图指纹（take_screenshot 落锚的 dHash，
 *                   即模型定位坐标时所依据的那一帧）；
 *   captureCurrentHash = physicalBackend metaOnly 采集（服务端一次低清往返，
 *                   零叠加层、零孵化 —— 与 D-5 在场判定同律：后端缺席 ⇒ 抛出
 *                   ⇒ 被探针捕获为 degraded，绝不触发服务孵化）。
 * 惰性动态导入：模块加载图零变化（popupDetector 的既有消费方不背新边）。
 */
export function defaultFreshnessPort(): GroundingFreshnessPort {
  // 惰性解析 contextManager 单例：端口创建时启动解析（promise 缓存后零开销），
  // 解析完成前的 groundingHash 调用诚实缺席（null ⇒ degraded，不阻塞派发）
  let cmRef: { lastImageRecord(): { hash?: string } | undefined } | null = null;
  void import('./contextManager')
    .then(m => { cmRef = m.contextManager as unknown as typeof cmRef; })
    .catch(() => { /* 模块缺席 ⇒ 探针诚实降级 */ });
  return {
    groundingHash(): string | null | undefined {
      try {
        return cmRef?.lastImageRecord()?.hash ?? null;
      } catch {
        return null;
      }
    },
    async captureCurrentHash(): Promise<string | null> {
      const backend = await import('./physicalBackend');
      const cap = await backend.captureProcessed({ metaOnly: true });
      return cap.dhash ?? null;
    },
  };
}
