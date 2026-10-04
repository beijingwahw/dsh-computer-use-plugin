// src/autonomy/runtime.deps.ts
// W8-B2（doctor smell.over-engineering 清偿 · D-F2 千行文件群）：自 runtime.ts
// 低风险分区提取 —— RuntimeDeps 依赖注入契约（离线测试的生命线；缺省走真实
// 管线）。逐字节搬迁（W8-B2 新增 verifyTaskId 注入位，见下）；runtime.ts 以
// 再导出保持导入面不变。
import type { GlmClient } from '../vlm/glmClient';
import type { GroundedElement } from '../vlm/grounding';
import type { WorldSnapshot } from './worldSnapshot';
import type { ExecFocusSource } from '../focusTracker';
import type { ExecWorldProbe } from '../physicalExecution/execProbe';
import type { LedgerVerdict } from '../visualDiff';
import type { IncrementalDelivery } from '../imageDelivery';
import type { W1ExecTuning } from './runtime.tuning';
import type { RuntimeWord } from './runtime.types';

/**
 * 运行时全部外部依赖（离线测试的生命线；缺省走真实管线）。
 * lastSnapshotRef 是感知/执行共享的「最新快照槽」：perceive 每次写入，
 * execute 读取作为变化判决的 before 帧 —— buildAutonomyStack 会就地补挂。
 */
export interface RuntimeDeps {
  /** 干净截屏供给（缺省 backend.captureCleanPng 全屏 PNG） */
  capture?: () => Promise<Buffer>;
  /** 图像尺寸探测（缺省 sharp metadata） */
  imageSize?: (buf: Buffer) => Promise<{ width: number; height: number }>;
  /** 感知指纹（缺省 perceptualHash.dhash 64 位串；失败 ⇒ null ⇒ 快照记降级） */
  dhashOf?: (buf: Buffer) => Promise<string | null>;
  /** 词级 OCR（缺省 textReader.readText：归一化 bbox → 像素换算，confidence/100） */
  readWords?: (buf: Buffer) => Promise<RuntimeWord[]>;
  /** 云脑元素接地（缺省：注入 client 或 isGlmConfigured() 时 groundElements，否则 []） */
  groundVlm?: (buf: Buffer, question?: string) => Promise<GroundedElement[]>;
  /** 词级 OCR 语言（缺省 'eng'；透传 textReader.readText） */
  ocrLang?: string;
  /** 云脑 client（ask_vlm 问答与 grounding 的注入位；测试假件由此进） */
  client?: GlmClient;
  /**
   * W8-B2（verifyGate 预算消费面终态接线）：grounding 复核预算的任务作用域键 ——
   * 缺省云脑接地面（makeDefaultGroundVlm）调 groundElements 时透传为
   * opts.verifyTaskId。跑环任务传 `pilot:<token>`（与 tools/autonomousRun.ts
   * runPilotLoop 起点的 resetVerifyGateBudget(`pilot:<token>`) 同键闭环 ——
   * use/reset 同一账本：任务内 8 次复核封顶防雪崩、并发任务互不侵占）。
   * 缺席/空串 ⇒ 不传键 ⇒ 共用 grounding 模块缺省账本（历史行为，逐字节一致）。
   * 只辖制缺省接地面；注入 groundVlm 的调用方自带预算主权（本键不越权）。
   */
  verifyTaskId?: string;
  /** 注入时钟（缺省 Date.now） */
  now?: () => number;
  /** 注入睡眠（缺省 setTimeout 真睡；测试零等待） */
  sleep?: (ms: number) => Promise<void>;
  /** 感知/执行共享的最新快照槽（perceive 写 / execute 读；缺席则执行验证自取 before 帧） */
  lastSnapshotRef?: { current: WorldSnapshot | null };
  /**
   * W1-1（A2/A3/A5）：执行层世界探针 —— ROI 指纹/帧差分/UIA 预检/光标形态/行亮度
   * 的注入位。缺席 ⇒ 四项新能力全部诚实降级，行为与接线前逐字节一致。
   * 生产接线：`probe: createExecWorldProbe(adapter)`（集成阶段统一接）。
   */
  probe?: ExecWorldProbe;
  /**
   * W1-1（A3）：焦点源（外推焦点 + 点击落点登记）。缺省禁用（哨兵远点、零全局
   * 副作用）；生产接线用 focusTracker 的 `createExecFocusSource()`。
   */
  focus?: ExecFocusSource;
  /** W1-1：执行层节奏/阈值覆盖（测试与调参；不接 config —— 集成阶段统一接） */
  w1?: Partial<W1ExecTuning>;
  /**
   * ΑΩ-R12（drag 执行面落地）：拖拽派发端口 —— 像素四元组（起点/终点，屏幕
   * 像素坐标 —— 与 system.clickMouse 的 px/py 同域）。接线层（index.ts 的
   * buildAutonomyStack）把根层 system.dragMouse 的四拍时序适配注入；autonomy
   * 器官本体不 import system —— 经 deps 注入破环。缺席 ⇒ drag 动作防御式
   * 降级 no_effect + 诚实注记（绝不凭空移动鼠标）。失败收敛 {ok:false, error}
   *（绝不抛 —— 运行层铁律由端口收口）。
   */
  drag?: (startX: number, startY: number, endX: number, endY: number) => Promise<{ ok: boolean; error?: string }>;
  /**
   * W4-1（A1）：宏执行注入面 —— 排练门禁场景与宏链预算的覆盖位。
   * 缺席 ⇒ 场景取感知快照元素（lastSnapshotRef）、预算取 MACRO_DEFAULT_BUDGET。
   */
  macro?: {
    /** 排练场景供给（缺省 anchors —— 快照元素归一化铸造） */
    scene?: () => ReadonlyArray<{ label: string; bbox: { x0: number; y0: number; x1: number; y1: number } }> | undefined;
    /** 宏链预算覆盖（maxSteps/timeoutMs —— 与 macroExecutor.MacroExecutionBudget 同构） */
    budget?: { maxSteps?: number; timeoutMs?: number };
  };
  /**
   * W4-1（顺带接线）：增量账本观察面 —— perceive 每帧把账本判决与投递结果
   * 写入此槽（总闸 incrementalEncodingEnabled 缺省关 ⇒ 本面零写入，零回归）。
   * 生产消费方：宿主编码层经此取 LedgerVerdict/IncrementalDelivery 决定
   * 「这一帧该作为关键帧/补丁/滚动条带投递给模型」。
   */
  incrementalObserver?: { current: { verdict: LedgerVerdict; delivery: IncrementalDelivery | null } | null };
}
