// src/actionVerifier.ts
// 行为效果验证引擎（突破一）+ 第二轮创新：自适应稳定等待。
// 固定 sleep 的问题：动画/加载中取指纹，把「还在动」误判为「产生了效果」。
// 自适应策略：轮询整屏指纹，直到连续两次几乎相同（屏幕稳定）或超时 —— 验证窗口
// 自动对齐 UI 的真实节奏，快页面不等 400ms，慢页面等到 settleMs*4。
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

/** 纯对比：给定前后指纹生成报告 */
export function reportEffect(before: string, after: string, noopThreshold: number): EffectReport {
  const distance = hammingDistance(before, after);
  const sim = similarity(before, after);
  return {
    effect_detected: sim < noopThreshold,
    similarity_pct: Math.round(sim * 1000) / 10,
    distance,
  };
}

/** 轮询直到屏幕稳定（相邻两次指纹距离<=1），超时返回最新指纹 */
export async function waitForStableScreen(pollMs: number, maxWaitMs: number): Promise<string> {
  const start = Date.now();
  let prev = await captureStateHash();
  while (Date.now() - start < maxWaitMs) {
    await sleep(pollMs);
    const cur = await captureStateHash();
    if (hammingDistance(prev, cur) <= 1) return cur;
    prev = cur;
  }
  return prev;
}

export interface SettleOptions {
  adaptive: boolean;
  settleMs: number;
  threshold: number;
}

/** 动作后统一入口：adaptive 轮询至稳定；fixed 原固定等待。返回效果报告 */
export async function settleAndReport(before: string, opts: SettleOptions): Promise<EffectReport> {
  if (!opts.adaptive) {
    await sleep(opts.settleMs);
    return reportEffect(before, await captureStateHash(), opts.threshold);
  }
  const after = await waitForStableScreen(150, opts.settleMs * 4);
  return reportEffect(before, after, opts.threshold);
}

/** 兼容旧签名：立即对比（不再内部等待） */
export async function verifyEffect(before: string, noopThreshold: number): Promise<EffectReport> {
  return reportEffect(before, await captureStateHash(), noopThreshold);
}
