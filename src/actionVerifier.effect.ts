// src/actionVerifier.effect.ts
// W6-2（doctor smell.over-engineering 清偿）：自 actionVerifier.ts 低风险分区提取 ——
// EffectReport 三态报告类型与 reportEffect 纯对比函数（指纹退化 Δ-7 诚实降级）。
// 纯函数零外部依赖，行为零变化；actionVerifier.ts 以再导出保持导入面不变。
import { normalizeHash, hammingDistance, similarity } from './perceptualHash';


export interface EffectReport {
  /**
   * true = 发生真实变化；false = 判定无变化；null = 指纹退化（空/全零/长度
   * 不等），**无法判定**（Δ-7 诚实降级）。退化指纹的比对结果是边界假信号：
   * 空/全零对任意指纹会产出 sim=0 或 sim=1 的极端值，旧实现把它当真判决 ——
   * 「证据不可用」被伪报成「检测到变化/无变化」。消费方对 null 应视为未验证
   * （绝不当变化采信，也无需当盲点定罪）。
   */
  effect_detected: boolean | null;
  similarity_pct: number;    // 前后相似度（越高越可能没点中；退化指纹时为无效测量值）
  distance: number;          // 汉明距离原始值（退化指纹时为无效测量值）
  /** 指纹退化原因（effect_detected=null 时在场）：absent | zero | length */
  unverifiable?: 'absent' | 'zero' | 'length';
}

/** 纯对比：给定前后指纹生成报告。
 *  Δ-7 指纹退化三态（诚实降级，防边界假信号）：
 *    ① absent —— 任一侧指纹为空（服务端未返回 dhash 时 captureBefore 以 '' 占位）
 *    ② zero   —— 归一化后全零（hexToBits 对损坏 hex 的回退值；与真·无梯度平面帧
 *      的 dHash 不可区分 —— 全零指纹信息量为零，任意两张平面帧都判 sim=1）
 *    ③ length —— 归一化后长度不等（异构指纹不可比；hammingDistance 取 max(len)
 *      把 sim 压到 0，旧实现据此虚报 effect_detected=true 假阳性）
 *  任一态 ⇒ effect_detected=null（无法判定）+ unverifiable 原因；distance/
 *  similarity_pct 照报原始测量值（证据保留），但其判决资格已被 null 否决。 */
export function reportEffect(before: string, after: string, noopThreshold: number): EffectReport {
  const nb = normalizeHash(before);
  const na = normalizeHash(after);
  // 归一化域判退化：'' 经 hexToBits 回退为全零（BigInt('0x') 抛错 → '0'.repeat(64)），
  // 故 absent 检查必须在归一化**前**的原始串上做；zero/length 检查在归一化后做
  const unverifiable: EffectReport['unverifiable'] =
    before === '' || after === '' ? 'absent'
      : (/^0+$/.test(nb) || /^0+$/.test(na)) ? 'zero'
        : nb.length !== na.length ? 'length'
          : undefined;
  const distance = hammingDistance(nb, na);
  const sim = similarity(nb, na);
  if (unverifiable) {
    return {
      effect_detected: null,
      similarity_pct: Math.round(sim * 1000) / 10,
      distance,
      unverifiable,
    };
  }
  return {
    effect_detected: sim < noopThreshold,
    similarity_pct: Math.round(sim * 1000) / 10,
    distance,
  };
}
