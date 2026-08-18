// src/actionVerifier.ts
// 突破一：行为效果验证引擎（act-then-verify）。
// 在动作前后各取一次整屏 dHash，对比相似度：
//   相似度 > 阈值（默认 0.97）⇒ 画面几乎没变 ⇒ 极可能是「盲点」（点空了）
//   相似度显著下降 ⇒ UI 真实发生了变化 ⇒ 动作生效
// 判定结果写进状态锚点的 effect_detected，模型第一次能「感知自己是否点中了」。
import { system } from './system';
import { dhash, hammingDistance, similarity } from './perceptualHash';

export const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

export interface EffectReport {
  effect_detected: boolean;  // true = 画面发生真实变化
  similarity_pct: number;    // 前后相似度（越高越可能没点中）
  distance: number;          // 汉明距离原始值
}

/** 取当前整屏状态指纹 */
export async function captureStateHash(): Promise<string> {
  const buf = await system.captureScreen();
  return dhash(buf);
}

/** 动作执行后调用：与 before 指纹对比，判定效果 */
export async function verifyEffect(before: string, noopThreshold: number): Promise<EffectReport> {
  const after = await captureStateHash();
  const distance = hammingDistance(before, after);
  const sim = similarity(before, after);
  return {
    effect_detected: sim < noopThreshold, // 相似度过高 ⇒ 疑似无效操作
    similarity_pct: Math.round(sim * 1000) / 10,
    distance,
  };
}
