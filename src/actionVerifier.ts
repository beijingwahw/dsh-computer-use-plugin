// src/actionVerifier.ts
// 行为效果验证引擎。三轮演进：
//   R1 盲点检测（全屏 dHash 前后对比）
//   R2 自适应稳定等待（轮询至屏幕稳定，动画期不误判）
//   R3 双尺度验证（全屏 + 区域指纹）+ 焦点区域放大局部变化
// 判定矩阵：全屏变化 = 页面级效果；仅区域变化 = 元素级效果（光标出现/文字输入）；
// 两者皆未变 = 疑似无效操作（盲点）。
//
// 本轮接线（真机修复）：指纹计算迁至 D-5 服务端（Python PIL）—— Node 端零
// 原生图像依赖。captureBefore/settleAndVerify 的「截屏→本地 dhash」链改为
// 「服务端一次往返：干净帧 dhash + 区域 dhash + 帧环 id」。sharp 可用时保留
// 旧 buffer 路径供物理规则直接消费（DSH_FORCE_LEGACY_SYSTEM=1 或开发仓）。
import { system } from './system';
import * as backend from './physicalBackend';
import { dhash, regionDhash, hammingDistance, similarity, normalizeHash } from './perceptualHash';
import { oscillationTracker } from './oscillationTracker';
import type { IntentExpectation, PhysicsVerdict } from './intent';
import { getEnabledPhysicsRules } from './intent';

export const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

async function sharpAvailable(): Promise<boolean> {
  try { const { getSharp } = await import('./_legacyDeps'); await getSharp(); return true; } catch { return false; }
}

export interface EffectReport {
  effect_detected: boolean;  // true = 发生真实变化
  similarity_pct: number;    // 前后相似度（越高越可能没点中）
  distance: number;          // 汉明距离原始值
}

export interface SettleOptions {
  adaptive: boolean;
  settleMs: number;
  threshold: number;
  /** 区域验证半径（归一化屏幕比例）；0 = 禁用区域验证 */
  regionRadius: number;
  /** C-1：物理规则启用清单（空 = 全部）；来自 config.physicsRules */
  physicsRules?: string;
}

/** 动作前状态：全屏指纹 + 可选的区域指纹（同一帧截屏，区域由 focus 决定） */
export interface BeforeState {
  screen: string;
  /** 干净帧 pHash（Q-2 频谱第二指纹 —— 佐证判决；D-5 服务端返回） */
  phash?: string | null;
  region: string | null;
  focus: { x: number; y: number } | null;
  /** C-1：动作前帧 buffer（物理规则需要前后两帧对比；无验证需求时不保留引用）
   *  仅 sharp 可用时存在（legacy/开发路径）；D-5 路径用 frameId 服务端消费 */
  buffer?: Buffer;
  /** D-5 路径：动作前帧环 id（frame_stats/frame_rowmeans 的引用锚） */
  frameId?: number | null;
}

/** 动作前快照：服务端一次往返取全屏/区域指纹（+ 帧环 id 供物理规则消费） */
export async function captureBefore(
  focus?: { x: number; y: number } | null,
  regionRadius = 0,
  keepBuffer = false,
): Promise<BeforeState> {
  const wantBuf = keepBuffer && await sharpAvailable();
  const r = await backend.captureProcessed({
    format: 'jpeg', quality: 60, maxWidth: 1440,
    wantHashes: true,
    wantRegionHash: focus && regionRadius > 0 ? { x: focus.x, y: focus.y, r: regionRadius } : undefined,
    keepFrame: keepBuffer, // 物理规则需要前后帧 —— 前帧入环
    ...(wantBuf ? {} : { metaOnly: true }),
  });
  const screen = r.dhash ? normalizeHash(r.dhash) : '';
  const region = r.regionDhash ? normalizeHash(r.regionDhash) : null;
  return {
    screen, phash: r.phash ?? null, region,
    focus: focus ?? null,
    buffer: wantBuf && r.buffer ? r.buffer : undefined,
    frameId: r.frameId ?? null,
  };
}

/** 纯对比：给定前后指纹生成报告 */
export function reportEffect(before: string, after: string, noopThreshold: number): EffectReport {
  const distance = hammingDistance(normalizeHash(before), normalizeHash(after));
  const sim = similarity(normalizeHash(before), normalizeHash(after));
  return {
    effect_detected: sim < noopThreshold,
    similarity_pct: Math.round(sim * 1000) / 10,
    distance,
  };
}

export interface CombinedEffect {
  detected: boolean;               // 全屏 OR 区域任一检测到变化
  screen: EffectReport;
  region: EffectReport | null;     // 无焦点/禁用时为 null
  scale: 'page-level' | 'element-level' | 'none';
  afterBuffer: Buffer;             // 稳定后的帧（供语义核对等下游消费；D-5 路径可能为空 buffer）
  afterHash: string;               // 稳定帧指纹（振荡检测已在此消费）
  oscillation: string | null;      // 振荡告警（屏幕状态在动作间反复回归旧值）
  /** C-1 意图裁决：期望 kind + 物理规则是否找到证据（未声明期望时 undefined） */
  intent?: { expected: string; satisfied: boolean; evidence: string };
  /**
   * Q 纪元（Q-2 感知层）：pHash 频谱佐证 —— DCT 低频指纹对 detected 判决的
   * 独立第二意见（null = sharp 缺席/计算降级，诚实缺席；true/false = 频谱域
   * 同判/异议）。两指纹失效模式近似正交：异议时锚点可提示模型细看。
   */
  phashCorroborates?: boolean;
  /** D-5 路径：稳定帧帧环 id（语义核对/物理规则/弹窗传感的服务端引用锚） */
  afterFrameId?: number | null;
}

/** 轮询直到屏幕稳定：服务端指纹轮询（meta_only —— 不编码不传图） */
export async function waitForStableHash(
  pollMs: number,
  maxWaitMs: number,
): Promise<{ hash: string; frameId: number | null }> {
  const start = Date.now();
  let prev = await backend.captureProcessed({ metaOnly: true, wantHashes: true });
  let prevHash = prev.dhash ? normalizeHash(prev.dhash) : '';
  while (Date.now() - start < maxWaitMs) {
    await sleep(pollMs);
    const cur = await backend.captureProcessed({ metaOnly: true, wantHashes: true });
    const hash = cur.dhash ? normalizeHash(cur.dhash) : '';
    if (hash && hammingDistance(prevHash, hash) <= 1) {
      return { hash, frameId: cur.frameId ?? null };
    }
    prevHash = hash;
  }
  return { hash: prevHash, frameId: prev.frameId ?? null };
}

/** legacy 路径：buffer 轮询（sharp 可用且显式保留 buffer 时） */
export async function waitForStableFrame(
  pollMs: number,
  maxWaitMs: number,
): Promise<{ buffer: Buffer; hash: string }> {
  const start = Date.now();
  let prevBuf = await system.captureScreen();
  let prevHash = await dhash(prevBuf);
  while (Date.now() - start < maxWaitMs) {
    await sleep(pollMs);
    const buf = await system.captureScreen();
    const hash = await dhash(buf);
    if (hammingDistance(prevHash, hash) <= 1) return { buffer: buf, hash };
    prevBuf = buf;
    prevHash = hash;
  }
  return { buffer: prevBuf, hash: prevHash };
}

/**
 * 动作后统一入口：自适应等待稳定帧，然后双尺度对比。
 * 决策矩阵：全屏变 = page-level；仅区域变 = element-level；都没变 = none（盲点）。
 * C-1：传入 expectation 时，物理规则引擎在双尺度之后追加意图裁决（L2 证据阶梯）。
 *   物理规则命中 ⇒ intent.satisfied 为裁决结论（可与 detected 分歧 —— 变了但不是预期的变化）；
 *   规则不适用/未启用 ⇒ intent 标注 not-applicable，行为回退纯双尺度（零回归）。
 */
export async function settleAndVerify(
  before: BeforeState,
  opts: SettleOptions,
  expectation?: IntentExpectation | null,
): Promise<CombinedEffect> {
  const useLegacyBuffers = !!(before.buffer && await sharpAvailable());

  let afterScreen = '';
  let afterRegion: string | null = null;
  let afterBuf: Buffer = Buffer.alloc(0);
  let afterFrameId: number | null = null;
  let afterPhash: string | null = null;

  if (useLegacyBuffers) {
    if (opts.adaptive) {
      const stable = await waitForStableFrame(150, opts.settleMs * 4);
      afterBuf = stable.buffer;
      afterScreen = stable.hash;
    } else {
      await sleep(opts.settleMs);
      afterBuf = await system.captureScreen();
      afterScreen = await dhash(afterBuf);
    }
    if (before.region && before.focus && opts.regionRadius > 0) {
      afterRegion = await regionDhash(afterBuf, before.focus.x, before.focus.y, opts.regionRadius);
    }
  } else {
    // D-5 路径：服务端一次往返 = 稳定轮询(meta_only) + 终帧(指纹+区域+帧环)
    if (opts.adaptive) {
      const stable = await waitForStableHash(150, opts.settleMs * 4);
      afterScreen = stable.hash;
      afterFrameId = stable.frameId;
    } else {
      await sleep(opts.settleMs);
    }
    const finalCap = await backend.captureProcessed({
      format: 'jpeg', quality: 60, maxWidth: 1440,
      wantHashes: true,
      wantRegionHash: before.region && before.focus && opts.regionRadius > 0
        ? { x: before.focus.x, y: before.focus.y, r: opts.regionRadius } : undefined,
      keepFrame: !!expectation,
    });
    if (finalCap.dhash) afterScreen = normalizeHash(finalCap.dhash);
    afterPhash = finalCap.phash;
    afterRegion = finalCap.regionDhash ? normalizeHash(finalCap.regionDhash) : afterRegion;
    afterFrameId = finalCap.frameId ?? afterFrameId;
    afterBuf = finalCap.buffer ?? Buffer.alloc(0);
  }

  const screen = reportEffect(before.screen, afterScreen, opts.threshold);
  let region: EffectReport | null = null;
  if (before.region && afterRegion) {
    region = reportEffect(before.region, afterRegion, opts.threshold);
  }

  const detected = screen.effect_detected || (region?.effect_detected ?? false);
  const scale: CombinedEffect['scale'] = screen.effect_detected
    ? 'page-level'
    : region?.effect_detected ? 'element-level' : 'none';

  // 振荡检测（第六轮）：稳定帧指纹顺手入环，零额外截图
  const oscillation = oscillationTracker.observe(afterScreen);

  // ── C-1 意图裁决（L2 物理证据）：带着预期找证据，而非盲目找不同 ──
  let intent: CombinedEffect['intent'];
  if (expectation && (before.buffer || before.frameId)) {
    const rules = getEnabledPhysicsRules(opts.physicsRules ?? '');
    const rule = rules.get(expectation.kind);
    if (rule) {
      let verdict: PhysicsVerdict;
      try {
        verdict = await rule.check({
          beforeBuf: before.buffer ?? Buffer.alloc(0),
          afterBuf,
          beforeFrameId: before.frameId ?? null,
          afterFrameId,
          focus: before.focus,
          regionRadius: opts.regionRadius,
        });
      } catch (e: any) {
        verdict = { satisfied: false, evidence: `physics rule error: ${e.message}`, notApplicable: true };
      }
      intent = {
        expected: expectation.kind,
        satisfied: verdict.satisfied,
        evidence: verdict.notApplicable
          ? `rule not applicable (${verdict.evidence}); fell back to dual-scale verdict`
          : verdict.evidence,
      };
    } else {
      // 语义/委托类期望或规则被 config 裁剪：不裁决，交给 L0/L1/L3 既有通道
      intent = {
        expected: expectation.kind,
        satisfied: detected,
        evidence: 'no physics rule for this kind; verdict delegated to dual-scale detection',
      };
    }
  }

  // ── Q 纪元（Q-2）：pHash 频谱佐证（旁路义务 —— 失败不毒化判决，诚实缺席）──
  // 语义：前后 pHash 相似度 < 0.9 = 频谱域看到变化；与 dHash 的 detected 同判 ⇒ true
  let phashCorroborates: boolean | undefined;
  if (afterPhash) {
    try {
      const { similarity } = await import('./perceptualHash');
      const pSim = similarity(normalizeHash(before.phash ?? ''), normalizeHash(afterPhash));
      phashCorroborates = (pSim < 0.9) === detected;
    } catch { phashCorroborates = undefined; }
  } else if (useLegacyBuffers && before.buffer) {
    try {
      const { dualSimilarity } = await import('./perceptualHash');
      const dual = await dualSimilarity(before.buffer, afterBuf);
      phashCorroborates = (dual.phash < 0.9) === detected;
    } catch { phashCorroborates = undefined; }
  }

  return {
    detected, screen, region, scale,
    afterBuffer: afterBuf, afterHash: afterScreen, oscillation,
    intent, phashCorroborates, afterFrameId,
  };
}

/** 兼容旧签名：立即取全屏对比（不等待） */
export async function verifyEffect(before: string, noopThreshold: number): Promise<EffectReport> {
  const cap = await backend.captureProcessed({ metaOnly: true, wantHashes: true });
  return reportEffect(before, cap.dhash ? normalizeHash(cap.dhash) : '', noopThreshold);
}
