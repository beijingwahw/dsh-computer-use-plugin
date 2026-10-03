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
import { kernelRegistry } from './kernel/registry';
import type { IntentExpectation, PhysicsVerdict } from './intent';
import { getEnabledPhysicsRules } from './intent';

export const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

async function sharpAvailable(): Promise<boolean> {
  try { const { getSharp } = await import('./_legacyDeps'); await getSharp(); return true; } catch { return false; }
}

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

export interface SettleOptions {
  adaptive: boolean;
  settleMs: number;
  threshold: number;
  /** 区域验证半径（归一化屏幕比例）；0 = 禁用区域验证 */
  regionRadius: number;
  /** C-1：物理规则启用清单（空 = 全部）；来自 config.physicsRules */
  physicsRules?: string;
  /**
   * W4-8 L4 声学证据注入端口：动作 settle 后查询最近 ~2s 回环窗口的
   * **非语义**音频事件（python_service/dsh_physical/audio.py 产出；
   * null = 无事件/通道不可用）。缺席 = 现状逐字节不变（兼容铁律）；
   * 在场 = 门控证据（语义与法条见下方 W4-8 立法块）。防御式：端口抛错
   * 视为证据缺席，绝不毒化判决主链。
   */
  audioEvidence?: () => AudioEvent | null;
  /**
   * W5-3（L3 跨机互证）远程世界变化谓词端口：向对端 peer 取证「A 的动作
   * 效果是否出现在 B 屏」。provider 负责取 B 的前后帧差分（frame_diff +
   * region dhash，visualDiff 方言）并按 expectedRegionHint 裁剪；返回
   * null = 证据缺席（peer 离线/超时/通道不可用 —— 诚实缺席，不误判）。
   * 缺席 = 现状逐字节不变（兼容铁律）；在场 = 只在**视觉阳性**（detected=
   * true 且无退化注记）时被询问（法条见下方 W5-3 立法块）。防御式：端口
   * 抛错视为证据缺席，绝不毒化判决主链。
   */
  remoteEvidence?: (peer: string, expectedRegionHint: RemoteRegion | null) => Promise<RemoteChange | null>;
  /** W5-3：取证的对端清单（缺省/空 ⇒ 端口不被询问 —— remote 键缺席）；上界 REMOTE_PEERS_MAX */
  remotePeers?: readonly string[];
  /** W5-3：期望远程变化区域（归一化坐标 —— visualDiff 方言；缺省 null ⇒ 严格不互证） */
  remoteRegionHint?: RemoteRegion | null;
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

// ─── W5-3（L3 跨机互证）远程世界变化谓词：A 的动作效果必须出现在 B 屏 ───
//
// 法条（与 W4-8 声学通道对称立法 —— 音频补强视觉阴性，远程互证核对视觉阳性）：
//   · 视觉阳性门控：只有本屏给出确定性阳性判决（detected=true 且无退化注记）
//     时才向对端取证 —— 本屏无效果却去 B 屏找「对应变化」是伪证题；视觉
//     阴性/未验证（unverifiable，Δ-7 同律）都不触发互证。
//   · 判决只旁路：corroborated/unverified 是旁路车道的事实报告，绝不改写
//     detected/scale/intent 等任何既有判决字段 —— 互证是证据增益，不是第二审判。
//   · 谓词严格（立法常量 REMOTE_EVIDENCE_OVERLAP_MIN）：无期望区域（no-hint）
//     ⇒ 严格不互证（说不出效果该出现在哪，就无权说「对上了」）；判据 =
//     对端 frame_diff 变化区域与期望区域的交叠覆盖率（交集面积/期望面积）
//     ≥ 0.25；无变化区域/证据缺席 ⇒ 诚实 unverified，绝不臆造 corroborated。
//   · 防御式：端口抛错/载荷形状非法 ⇒ 证据缺席（unverified），绝不抛、
//     绝不毒化判决主链；取证 peer 数上界 REMOTE_PEERS_MAX=4（旁路不透支）。

/** W5-3：归一化矩形（visualDiff 方言 —— DiffRegion.bbox_normalized 同构） */
export interface RemoteRegion {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** W5-3：对端一次取证的证据载荷（provider 产出：B 屏前后帧差分 + 区域指纹） */
export interface RemoteChange {
  /** 对端稳定帧全屏 dhash（hex；审计面 —— 不参与交叠判决） */
  screen: string;
  /** 对端期望区域 dhash（与 frame_diff 并列的第二证据；null = 未取到） */
  region?: string | null;
  /** 对端屏 frame_diff 变化区域清单（归一化坐标，visualDiff 方言，只读复用） */
  regions: RemoteRegion[];
}

/** W5-3：互证谓词阈值（立法常量 —— 交叠覆盖率下限；改此值 = 修法，须过 w5cross 断言） */
export const REMOTE_EVIDENCE_OVERLAP_MIN = 0.25 as const;

/** W5-3：单动作取证 peer 数上界（旁路义务不透支主路预算） */
export const REMOTE_PEERS_MAX = 4 as const;

/** W5-3：互证判决（corroborated = 对端屏在期望区域看到变化；unverified = 诚实缺席/不达阈） */
export type RemoteCorroborateVerdict = 'corroborated' | 'unverified';

/** W5-3：互证判决报告（overlap = 最优交叠覆盖率，4 位小数确定性） */
export interface RemoteJudgement {
  verdict: RemoteCorroborateVerdict;
  overlap: number;
  reason?: string;
}

/** W5-3 防御式净化：归一化矩形形状/值域不合法或退化（x1≤x0 等）⇒ null */
function sanitizeRemoteRegion(r: unknown): RemoteRegion | null {
  try {
    if (!r || typeof r !== 'object') return null;
    const o = r as { x0?: unknown; y0?: unknown; x1?: unknown; y1?: unknown };
    if (![o.x0, o.y0, o.x1, o.y1].every(v => typeof v === 'number' && Number.isFinite(v))) return null;
    const c = (v: number): number => Math.max(0, Math.min(1, v));
    const x0 = c(o.x0 as number), y0 = c(o.y0 as number), x1 = c(o.x1 as number), y1 = c(o.y1 as number);
    if (!(x1 > x0 && y1 > y0)) return null; // 退化框：零面积 ⇒ 无判决资格
    return { x0, y0, x1, y1 };
  } catch {
    return null;
  }
}

/** W5-3 防御式净化：RemoteChange 载荷形状不合法 ⇒ null（证据缺席）；regions 内坏框静默剔除 */
function sanitizeRemoteChange(c: unknown): RemoteChange | null {
  try {
    if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
    const o = c as { screen?: unknown; region?: unknown; regions?: unknown };
    const regions = Array.isArray(o.regions)
      ? o.regions.map(sanitizeRemoteRegion).filter((r): r is RemoteRegion => r !== null)
      : [];
    return {
      screen: typeof o.screen === 'string' ? o.screen : '',
      region: typeof o.region === 'string' ? o.region : null,
      regions,
    };
  } catch {
    return null;
  }
}

/**
 * W5-3：跨机互证谓词（纯函数、确定性、绝不抛）——「A 的动作效果必须出现在
 * B 屏」的判决核心：
 *   · 证据缺席（change=null）⇒ unverified 'absent'（peer 离线/超时/载荷坏）；
 *   · 无期望区域（hint=null/非法）⇒ unverified 'no-hint'（严格：说不出该出现
 *     在哪，就无权互证）；
 *   · 无有效变化区域 ⇒ unverified 'no-change-regions'（B 屏没变 —— 诚实
 *     缺席而非反驳：region 证据链断在哪环都不臆造）；
 *   · 判据：max over regions of（区域∩期望）/（期望面积）≥ REMOTE_EVIDENCE_
 *     OVERLAP_MIN ⇒ corroborated；否则 unverified 'overlap-below-min'
 *     （overlap 照报最优值 —— 证据保留）。
 */
export function judgeRemoteChange(
  hint: RemoteRegion | null,
  change: RemoteChange | null,
): RemoteJudgement {
  const un = (reason: string): RemoteJudgement => ({ verdict: 'unverified', overlap: 0, reason });
  try {
    if (change === null) return un('absent');
    const h = sanitizeRemoteRegion(hint);
    if (h === null) return un('no-hint');
    if (change.regions.length === 0) return un('no-change-regions');
    const hArea = (h.x1 - h.x0) * (h.y1 - h.y0);
    if (!(hArea > 0)) return un('no-hint');
    let best = 0;
    for (const r of change.regions) {
      const iw = Math.min(h.x1, r.x1) - Math.max(h.x0, r.x0);
      const ih = Math.min(h.y1, r.y1) - Math.max(h.y0, r.y0);
      if (iw > 0 && ih > 0) best = Math.max(best, (iw * ih) / hArea);
    }
    const overlap = Math.round(best * 10000) / 10000;
    return overlap >= REMOTE_EVIDENCE_OVERLAP_MIN
      ? { verdict: 'corroborated', overlap }
      : { verdict: 'unverified', overlap, reason: 'overlap-below-min' };
  } catch {
    return un('absent');
  }
}

// ─── W4-8 L4 声学证据通道（有节制的破戒）：非语义物理证据，恒低于视觉 ───
//
// 破戒范围（创新提案 L4）：系统音频只作**非语义**物理证据 —— 五类声学纹理
// 事件（通知叮声/错误提示/成功提示/按键音/静默），由物理层
// python_service/dsh_physical/audio.py（WASAPI 回环 + 阈值级联分类）产出。
// 绝不做语音识别/说话人识别/内容转录：声学**纹理**是证据，声学**内容**不是。
//
// 法条一（视觉优先律，立法为常量 AUDIO_VISUAL_PRIORITY）：
//   音频证据的证明力恒低于视觉。视觉通道给出确定性判决时（detected=true
//   的阳性，或 detected=false 且无指纹退化的阴性），音频**一律不改判** ——
//   最多作为 audioEvent 附注被记录；视觉阳性在场时连门控判决（audioGated）
//   都不产出。音频可以补强视觉的阴性，绝无权推翻视觉的阳性。
// 法条二（置信封顶，立法为常量 AUDIO_EVIDENCE_CONFIDENCE_CAP）：
//   音频单通道升级的效果判决，置信度硬上限 0.5 —— 恒低于任何视觉确定性
//   证据（1.0）。封顶是立法不是调参：改此值 = 修法，须过 w4audio 封顶断言。
//
// 门控语义（仅视觉阴性时计算 audioGated）：
//   · success_chime ⇒ no_effect 升级 probable_effect（置信 ≤ 法条二封顶）；
//   · error_beep   ⇒ 触发复核（recheck）—— 判决不动，要求再看一眼；
//   · notification_ding / key_click / silence ⇒ 只记录，不参与判决。
//   视觉「未验证」（unverifiable，指纹退化）不是视觉阴性 —— 音频不得在
//   视觉缺席处制造确定性（Δ-7 同律：证据不可用 ≠ 无变化）。

/** W4-8：五类非语义音频事件（与 audio.py 的 EVENT_KINDS 字面镜像） */
export type AudioEventKind =
  | 'notification_ding'
  | 'error_beep'
  | 'success_chime'
  | 'key_click'
  | 'silence';

/** W4-8：音频事件（audio.py 输出契约 {event, confidence, ts} 的 TS 镜像） */
export interface AudioEvent {
  event: AudioEventKind;
  /** python 端分类置信（0..1）—— 未经封顶的原始探测器置信 */
  confidence: number;
  /** unix ms（audio.py 检出时刻） */
  ts: number;
}

/** 法条一（W4-8 视觉优先律）：音频证据恒低权于视觉 —— 立法文本见上方注释块 */
export const AUDIO_VISUAL_PRIORITY = true as const;
/** 法条二（W4-8 置信封顶）：音频单通道效果判决的置信硬上限（0.5 < 视觉 1.0） */
export const AUDIO_EVIDENCE_CONFIDENCE_CAP = 0.5 as const;

/** W4-8：门控音频判决种类（probable_effect = 阴性升级；recheck = 触发复核） */
export type AudioGatedVerdict = 'probable_effect' | 'recheck';

/** W4-8 防御式净化：注入方给的 AudioEvent 形状/值域不合法 ⇒ 视为缺席（null）。
 *  证据通道的垃圾输入绝不进入判决链（防御式绝不抛的外延）。 */
function sanitizeAudioEvent(ev: unknown): AudioEvent | null {
  if (!ev || typeof ev !== 'object') return null;
  const e = ev as { event?: unknown; confidence?: unknown; ts?: unknown };
  const kinds: readonly unknown[] = ['notification_ding', 'error_beep', 'success_chime', 'key_click', 'silence'];
  if (typeof e.event !== 'string' || !kinds.includes(e.event)) return null;
  const confidence = typeof e.confidence === 'number' && Number.isFinite(e.confidence)
    ? Math.max(0, Math.min(1, e.confidence))
    : 0;
  const ts = typeof e.ts === 'number' && Number.isFinite(e.ts) ? e.ts : Date.now();
  return { event: e.event as AudioEventKind, confidence, ts };
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

  // 纪元 Ξ（Ξ-D 生产接线）：轮询节奏读内核注册表 —— verify.pollMs（缺省 150）
  // 与 verify.settleFactor（缺省 4，maxWaitMs = settleMs × 此值）。min 护栏
  // Math.max(1,…)：0 轮询间隔会退化成忙等、0 倍率会把等待窗直接清零 ——
  // 区间之外的病值就地夹正，未注册 ⇒ 回声字面量，逐字节不变。
  const pollMs = Math.max(1, kernelRegistry.getOrDefault('verify.pollMs', 150));
  const settleFactor = Math.max(1, kernelRegistry.getOrDefault('verify.settleFactor', 4));

  if (useLegacyBuffers) {
    if (opts.adaptive) {
      const stable = await waitForStableFrame(pollMs, opts.settleMs * settleFactor);
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
      const stable = await waitForStableHash(pollMs, opts.settleMs * settleFactor);
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

  // Δ-7 派生保守律：EffectReport 的 null（指纹退化）**不得**上浮为
  // CombinedEffect.detected —— quantumSense.recordEffect 的调用方契约
  // （src/quantumSense.ts:119-127）由类型系统（纯 boolean）与测试
  // （undefined 直通锁）双重锁死，null 不是合法载体。故 unknown ⇒ 保守 false
  //（绝不当变化采信：不写地标、不焚毁审批令牌、不虚报成功），并携带
  // unverifiable 注记让消费方可区分「未验证」与「判定无变化」。
  const detected = screen.effect_detected === true || region?.effect_detected === true;
  const scale: CombinedEffect['scale'] = screen.effect_detected === true
    ? 'page-level'
    : region?.effect_detected === true ? 'element-level' : 'none';
  // 注记只在「保守 false」时在场：detected=true 时退化通道已被另一通道的
  // 硬证据顶替（无歧义）；detected=false 且有通道为 null 时，false 是降级
  // 保守值而非测量结论 —— 不注记就会与真「无变化」混淆
  const unverifiableParts: string[] = [];
  if (!detected) {
    if (screen.effect_detected === null) unverifiableParts.push(`screen:${screen.unverifiable}`);
    if (region?.effect_detected === null) unverifiableParts.push(`region:${region.unverifiable}`);
  }
  const unverifiable = unverifiableParts.length > 0 ? unverifiableParts.join(';') : undefined;

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
  // 纪元 Ξ（Ξ-D 生产接线）：佐证门读内核注册表 —— verify.phashGate（缺省 0.9，
  // 双读点同键同步）。未注册 ⇒ getOrDefault 回声字面量，逐字节不变。
  const phashGate = kernelRegistry.getOrDefault('verify.phashGate', 0.9);
  let phashCorroborates: boolean | undefined;
  if (afterPhash && before.phash) {
    try {
      const { similarity } = await import('./perceptualHash');
      const pb = normalizeHash(before.phash);
      const pa = normalizeHash(afterPhash);
      // Δ-7 同律：任一侧 pHash 全零（平坦帧 —— 63 个 AC 系数无离散度，中位阈值
      // 产出零信息指纹）时比对是边界假信号 —— 佐证诚实缺席，绝不当同判采信
      if (!/^0+$/.test(pb) && !/^0+$/.test(pa)) {
        phashCorroborates = (similarity(pb, pa) < phashGate) === detected;
      }
    } catch { phashCorroborates = undefined; }
  } else if (useLegacyBuffers && before.buffer) {
    try {
      const { dualSimilarity } = await import('./perceptualHash');
      const dual = await dualSimilarity(before.buffer, afterBuf);
      phashCorroborates = (dual.phash < phashGate) === detected;
    } catch { phashCorroborates = undefined; }
  }

  // ── W4-8 L4 声学证据（门控旁路）：防御式绝不抛 —— 端口故障 = 证据缺席 ──
  // 端口缺席（opts.audioEvidence 未注入）⇒ 本块整体短路，返回体逐字节不变。
  let audio: AudioEvent | null = null;
  if (opts.audioEvidence) {
    try {
      audio = sanitizeAudioEvent(opts.audioEvidence());
    } catch { audio = null; } // 防御式：证据通道的故障绝不毒化判决主链
  }
  let audioGated: CombinedEffect['audioGated'];
  if (audio && AUDIO_VISUAL_PRIORITY) {
    // 门控前提（法条一）：视觉阴性 = detected=false 且无退化注记。
    //   视觉阳性 ⇒ 音频静默（连门控判决都不产出 —— audioEvent 仍附注）；
    //   视觉未验证（unverifiable）⇒ 不升级（Δ-7 同律：证据不可用 ≠ 无变化）。
    const visualNegative = detected === false && !unverifiable;
    if (visualNegative) {
      if (audio.event === 'success_chime') {
        audioGated = {
          verdict: 'probable_effect',
          event: audio.event,
          // 法条二（置信封顶）：音频单通道升级的置信硬上限 —— 立法不是调参
          confidence: Math.min(audio.confidence, AUDIO_EVIDENCE_CONFIDENCE_CAP),
        };
      } else if (audio.event === 'error_beep') {
        audioGated = {
          verdict: 'recheck',
          event: audio.event,
          confidence: Math.min(audio.confidence, AUDIO_EVIDENCE_CONFIDENCE_CAP),
        };
      }
      // 其余事件（notification_ding / key_click / silence）：只记录不判决
    }
  }

  // ── W5-3（L3 跨机互证）：远程世界变化谓词（旁路义务 —— 失败不毒化判决）──
  // 门控（法条）：视觉阳性（detected=true 且无退化注记）+ 端口在场 + peers
  // 非空，三者齐备才取证 —— 与 W4-8 声学通道的「视觉阴性门控」对称立法。
  // 端口缺席/门控不中 ⇒ 本块整体短路，返回体逐字节不变（兼容铁律）。
  let remote: CombinedEffect['remote'];
  if (typeof opts.remoteEvidence === 'function' && Array.isArray(opts.remotePeers) &&
    opts.remotePeers.length > 0 && detected === true && !unverifiable) {
    const hint = sanitizeRemoteRegion(opts.remoteRegionHint) ?? null; // 非法 hint = 未声明 ⇒ 严格 no-hint
    const perPeer: Array<{ peer: string } & RemoteJudgement> = [];
    for (const rawPeer of opts.remotePeers.slice(0, REMOTE_PEERS_MAX)) {
      if (typeof rawPeer !== 'string' || rawPeer === '') {
        perPeer.push({ peer: '', verdict: 'unverified', overlap: 0, reason: 'bad-peer' });
        continue;
      }
      let change: RemoteChange | null = null;
      let portError = false;
      try {
        change = await opts.remoteEvidence(rawPeer, hint);
      } catch {
        portError = true; // 防御式：证据通道的故障绝不毒化判决主链
      }
      if (portError) {
        perPeer.push({ peer: rawPeer, verdict: 'unverified', overlap: 0, reason: 'port-error' });
        continue;
      }
      const j = judgeRemoteChange(hint, sanitizeRemoteChange(change));
      perPeer.push({ peer: rawPeer, ...j });
    }
    remote = {
      hint,
      perPeer,
      corroborated: perPeer.filter(p => p.verdict === 'corroborated').length,
      unverified: perPeer.filter(p => p.verdict !== 'corroborated').length,
    };
  }

  return {
    detected, screen, region, scale,
    afterBuffer: afterBuf, afterHash: afterScreen, oscillation,
    intent, phashCorroborates, unverifiable, afterFrameId,
    // W4-8：端口缺席 ⇒ 两键均不落（逐字节不变）；在场 ⇒ audioEvent 恒附
    //（null = 已查询无事件/事件形状非法），audioGated 仅门控命中时在场。
    ...(opts.audioEvidence ? { audioEvent: audio, ...(audioGated ? { audioGated } : {}) } : {}),
    // W5-3：门控不中 ⇒ remote 键整体缺席（逐字节不变）；门控命中 ⇒ 旁路互证
    // 报告（只读证据 —— 不改写任何视觉判决字段）。
    ...(remote ? { remote } : {}),
  };
}

/** 兼容旧签名：立即取全屏对比（不等待） */
export async function verifyEffect(before: string, noopThreshold: number): Promise<EffectReport> {
  const cap = await backend.captureProcessed({ metaOnly: true, wantHashes: true });
  return reportEffect(before, cap.dhash ? normalizeHash(cap.dhash) : '', noopThreshold);
}
