// src/actionVerifier.stable.ts
// W6-2（doctor smell.over-engineering 清偿）：自 actionVerifier.ts 低风险分区提取
// （>500 行拆分信号）—— CombinedEffect 结果类型与稳定帧轮询（waitForStableHash/
// waitForStableFrame）整体搬迁。行为零变化；actionVerifier.ts 以再导出保持导入面不变。
import type { EffectReport, RemoteRegion, RemoteJudgement } from './actionVerifier';
// ΠΑΝ-127（D-F5 清偿）：sleep 改自零出边叶导入（原借桶 actionVerifier.ts 构成
// value 二环；桶面同名符号仍经再分发可用）。
import { sleep } from './actionVerifier.shared';
import * as backend from './physicalBackend';
import { normalizeHash, hammingDistance, dhash } from './perceptualHash';
import { kernelRegistry } from './kernel/registry';
import { system } from './system';
import type { AudioEvent, AudioEventKind, AudioGatedVerdict } from './actionVerifier.channels';


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
  /**
   * Δ-7：双尺度皆指纹退化时的降级注记（'screen:zero;region:length' 形）。
   * 此时 detected 是**保守 false**（见 settleAndVerify 注记）—— 消费方据此
   * 可把「未验证」与「判定无变化」区分开（提示模型截图细看，而非定罪盲点）。
   */
  unverifiable?: string;
  /** D-5 路径：稳定帧帧环 id（语义核对/物理规则/弹窗传感的服务端引用锚） */
  afterFrameId?: number | null;
  /**
   * W4-8 L4 声学证据：观察到的非语义音频事件（**端口在场时**才落键；
   * null = 已查询无事件）。这是 failureMemory 签名维度的只读证据源 ——
   * 消费方（failureMemory.record 的 actionSignature 语境）自行取用，
   * 本引擎绝不在此改写任何视觉判决字段。
   */
  audioEvent?: AudioEvent | null;
  /**
   * W5-3（L3 跨机互证）远程取证报告：**仅 remoteEvidence 端口在场、remotePeers
   * 非空、且本动作视觉阳性**时落键（其余情形键整体缺席 —— 逐字节兼容）。
   * 这是「A 的动作效果必须出现在 B 屏」的旁路互证车道：corroborated 计数
   * 不改写 detected/scale 等任何视觉判决字段（消费方自行决定采纳程度），
   * unverified 是诚实缺席 —— peer 离线/超时/无期望区域都只降格，绝不误判。
   */
  remote?: {
    /** 本次取证使用的期望区域（归一化；null = 未声明 —— 严格不互证） */
    hint: RemoteRegion | null;
    perPeer: Array<{ peer: string } & RemoteJudgement>;
    corroborated: number;
    unverified: number;
  };
  /**
   * W4-8 门控音频判决：**仅视觉阴性**（detected=false 且无退化注记）时计算
   * —— success_chime ⇒ probable_effect（no_effect 升级，置信 ≤ 法条二封顶）；
   * error_beep ⇒ recheck（触发复核，判决不动）。视觉阳性在场时此键缺席
   * （法条一：音频无权稀释/顶替视觉确定性证据）。detected 主字段恒为纯视觉
   * 判决（quantumSense.recordEffect 的 boolean 契约锁死）—— 升级只活在
   * 本旁路车道，消费方自行决定是否把 no_effect 改称 probable_effect。
   */
  audioGated?: { verdict: AudioGatedVerdict; event: AudioEventKind; confidence: number };
}

/** 轮询直到屏幕稳定：服务端指纹轮询（meta_only —— 不编码不传图）。
 *  纪元 Ξ（Ξ-D 生产接线）：稳定判距读内核注册表 —— verify.stableGap（缺省 1：
 *  汉明距离 ≤ 此值视为同帧）。未注册 ⇒ getOrDefault 回声字面量，逐字节不变。 */
export async function waitForStableHash(
  pollMs: number,
  maxWaitMs: number,
): Promise<{ hash: string; frameId: number | null }> {
  const stableGap = kernelRegistry.getOrDefault('verify.stableGap', 1);
  const start = Date.now();
  let prev = await backend.captureProcessed({ metaOnly: true, wantHashes: true });
  let prevHash = prev.dhash ? normalizeHash(prev.dhash) : '';
  let prevFrameId = prev.frameId ?? null;
  while (Date.now() - start < maxWaitMs) {
    await sleep(pollMs);
    const cur = await backend.captureProcessed({ metaOnly: true, wantHashes: true });
    const hash = cur.dhash ? normalizeHash(cur.dhash) : '';
    if (hash && hammingDistance(prevHash, hash) <= stableGap) {
      return { hash, frameId: cur.frameId ?? null };
    }
    prevHash = hash;
    prevFrameId = cur.frameId ?? null; // 超时返回 (hash, frameId) 必须同帧 —— 指纹与帧环 id 配对错位会误导下游锚定
  }
  return { hash: prevHash, frameId: prevFrameId };
}

/** legacy 路径：buffer 轮询（sharp 可用且显式保留 buffer 时）。stableGap 同键同缺省。 */
export async function waitForStableFrame(
  pollMs: number,
  maxWaitMs: number,
): Promise<{ buffer: Buffer; hash: string }> {
  const stableGap = kernelRegistry.getOrDefault('verify.stableGap', 1);
  const start = Date.now();
  let prevBuf = await system.captureScreen();
  let prevHash = await dhash(prevBuf);
  while (Date.now() - start < maxWaitMs) {
    await sleep(pollMs);
    const buf = await system.captureScreen();
    const hash = await dhash(buf);
    if (hammingDistance(prevHash, hash) <= stableGap) return { buffer: buf, hash };
    prevBuf = buf;
    prevHash = hash;
  }
  return { buffer: prevBuf, hash: prevHash };
}

