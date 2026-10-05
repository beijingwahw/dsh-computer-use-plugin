// src/sandbox/types.ts
// D-5 沙箱执行引擎 —— 契约层终版（六轮评审收敛，唯一事实源）。
// 产权铁律：跨器官类型一律 import，绝不定义 ——
//   D-4 事件契约来自 ../doctorEvents；现世接口契约自 ../doctorTypes 透传；
//   本文件只拥有 D-5 主权类型（ActionChain / MuscleMemoryEntry / RehearsalOutcome / …）。
// 异常诚实分层契约（D-6 轮正式立法，本文件遵守全部条文）：
//   第一条（加载层）configure/apply/Schema 校验 —— throw 合法且是唯一诚实形态：
//     拒绝带病上线；与宿主 cordis Schema 校验同生命周期哲学。
//   第二条（运行层）诊断/执行/重放/验收 —— 禁止 throw，一律 Result/verdict 降级；
//     运行时数据流神圣不可击穿。
//   第三条（判据）方法被调用时是否存在需要保护的数据流 —— 加载期无数据流，
//     throw 不伤害任何东西；运行期有数据流，throw 会击穿流水线。
//   第四条（对称性）模拟成功是债，模拟降级同罪（simulated rescue 同罪）：
//     坏配置 + configure 静默降级 = 用降级伪装成功。
import { randomUUID } from 'crypto';
import type { QualityDoctor } from '../doctorTypes';
import type { DoctorVerdict, Score } from '../doctorEvents';

export type { DoctorVerdict, Score, DoctorVerdictPayload } from '../doctorEvents';
export type { QualityDoctor };

// ─── 0. 统一结果协议（对齐 D-2 shaper.apply 的 ok/reason 方言）───

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string; degraded: boolean };

// ─── 1. 沙箱动作（宿主 ACTION_TOOLS 的镜像超集）───

export type SandboxActionKind =
  | 'click_mouse' | 'type_text' | 'scroll_page' | 'press_hotkey'
  | 'drag_mouse' | 'switch_tab' | 'switch_window' | 'dismiss_popup' | 'noop';

/** 动作词汇表运行时集合（类型的唯一运行时镜像 —— 解析边界执法用，
 *  防 LLM 输出的未知 kind 经 as 断言混入执行域） */
export const SANDBOX_ACTION_KINDS: ReadonlySet<string> = new Set<SandboxActionKind>([
  'click_mouse', 'type_text', 'scroll_page', 'press_hotkey',
  'drag_mouse', 'switch_tab', 'switch_window', 'dismiss_popup', 'noop',
]);

/** 预期效果 scale 词表运行时集合（ΑΩ-R19：与 SANDBOX_ACTION_KINDS 同方言 ——
 *  解析边界执法的唯一事实源，防入参校验器复制第二份词表） */
export const EXPECTED_EFFECT_SCALES: ReadonlySet<string> = new Set<string>([
  'page-level', 'element-level', 'text-level',
]);

/** 预期效果声明（对齐宿主四层验证栈的 L4 预期锚定层） */
export interface ExpectedEffect {
  scale: 'page-level' | 'element-level' | 'text-level';
  /** L3 语义预期 */
  expectedText?: string;
  /** 自然语言预期（供因果链法官比对 thought） */
  sceneHint?: string;
}

/**
 * K 纪元（留白兑现）：虚拟屏控件 —— 排练验证层的确定性世界。
 * 生产来源：规划期 UI 树提取（getUiTree / extractInteractiveElements 产物映射）；
 * 排练对**真实控件几何**做命中测试，而非虚构世界。
 */
export interface VirtualWidget {
  role: string;
  name: string;
  rect: { x: number; y: number; width: number; height: number };
  acceptsText?: boolean;
  /** 可滚动容器（列表/页面）：scroll_page 证据的前提（K 纪元补全） */
  scrollable?: boolean;
  /** 模态弹窗：press_hotkey ['esc'] 的可关闭对象（K 纪元补全） */
  popup?: boolean;
  /** ΝΩ-30：堆叠序（z 轴，高者在上）。缺省 0；asVirtualWidget 对 popup 类铸
   *  更高层。命中测试自顶向下（最高 z 先判命中）—— 被遮挡控件不可点。 */
  z?: number;
}

export interface SandboxAction {
  kind: SandboxActionKind;
  /** 与宿主工具参数 schema 同构（归一化坐标等） */
  args: Record<string, any>;
  /** 缺省 = 仅 L1 像素验证（诚实降级，不假装 L4） */
  expect?: ExpectedEffect;
}

// ─── 2. 动作链：预演的最小单位 ───

export interface ActionChain {
  /** 经 IdGenerator 铸造（格式主权在生成器，注释不承载规范） */
  id: string;
  actions: SandboxAction[];
  /** 入口场景 dHash（同屏召回加成的对偶） */
  entrySceneFingerprint?: string;
  /** 预算感知：超时优雅中止而非失控 */
  budgetMs?: number;
  /** 链来源：D-1 规划 / 造物主手书 */
  origin: 'cognition' | 'manual';
  /** K 纪元：排练虚拟场景（可选）。在场 ⇒ 排练对控件几何产出 L1/L4 真证据；
   *  缺席 ⇒ 既有 degraded 语义零回归。 */
  virtualScene?: VirtualWidget[];
}

// ─── 3. 肌肉记忆：沙箱预演的固化产物（skillLibrary 的沙箱对偶器官）───

export interface MuscleMemoryEntry {
  /** 经 IdGenerator 铸造 */
  id: string;
  /** 触发描述（自然语言召回的 query 源） */
  trigger: string;
  chainId: string;
  /** 冻结副本：链演化不污染已固化记忆。类型层 ReadonlyArray 禁 push/splice/重排；
   *  运行时真实执法点在 consolidate 唯一铸造处深冻（JSON round-trip 后类型层与
   *  冻结全部蒸发，restore 后必须重冻）—— 类型拦编译期，冻结拦运行时，文档拦人心。 */
  readonly steps: ReadonlyArray<SandboxAction>;
  entrySceneFingerprint?: string;
  rehearsalPassCount: number;
  /** 宿主重放次数 —— 唯一可信可靠度源 */
  hostReplayCount: number;
  /** 可靠度 = muscleReliability(entry)，0-1 域（与 Score 0-100 类型层隔离） */
  hostSuccessCount: number;
  lastRehearsedAt: number;
  lastHostReplayedAt: number;
  origin: 'rehearsal' | 'host-replay' | 'manual';
}

/**
 * 肌肉记忆可靠度 —— 唯一公式落点（锚定 skillLibrary.ts:182 既有事实）：
 *   reliability = (hostSuccessCount + 1) / (hostReplayCount + 2)   // 加一 Laplace，二值结局
 * 零重放条目 = 1/2 谨慎起步（对齐合成技能先验哲学："谨慎起步，用一次校准一次"）。
 * 计数是唯一事实源，可靠度永远是导出值 —— 消费方禁止自行重算。
 */
export function muscleReliability(
  e: Pick<MuscleMemoryEntry, 'hostSuccessCount' | 'hostReplayCount'>,
): number {
  return (e.hostSuccessCount + 1) / (e.hostReplayCount + 2);
}

// ─── 4. 沙箱快照：镜像世界的存档点 ───

export interface SandboxSnapshot {
  /** 经 IdGenerator 铸造 */
  id: string;
  createdAt: number;
  /** 宿主屏指纹的镜像（来源：事件总线缓存的最近宿主观察；嗅探缺席时为空串 ——
   *  诚实降级，快照自证「镜像源头缺席」，下游指纹门禁据此拒绝放行） */
  screenDhash: string;
  /** 宿主 FocusPoint 的镜像方言（x/y/sensitive/at）；elementType 见下 */
  focus?: {
    x: number;
    y: number;
    sensitive: boolean;
    capturedAt: number;
    /** 白盒源（D-3 UiExtractor）就绪时供给的开集词汇（如 'input'）；纯视觉模式缺席 ——
     *  宿主 FocusPoint 本无此维，闭集枚举 = 为纯视觉架构伪造 UI 树分类学 */
    elementType?: string;
  };
  cursor?: { x: number; y: number };
  /** 铸造时刻的沙箱因果链尖端 */
  chainTip: string;
  /** 白盒源就绪态：缺席 = 纯视觉黑盒预演，诚实标注 */
  whiteboxAvailable: boolean;
}

// ─── 5. 预演结果：一次彩排的完整判决书 ───

export type RehearsalVerdict = 'passed' | 'failed' | 'degraded' | 'aborted';

export interface RehearsalStepResult {
  index: number;
  action: SandboxAction;
  /** null = 该层验证不可用（诚实降级，非 false） */
  effectDetected: boolean | null;
  effectScale?: 'page-level' | 'element-level';
  /** L3 OCR 核对（OCR 缺席时 undefined） */
  semanticMatch?: boolean;
  /** L4 预期锚定（未声明 expect 时 null） */
  expectationMet: boolean | null;
  latencyMs: number;
  /** 一步一证词（分歧、降级原因） */
  note?: string;
}

/** 验证层标识：L1→L4 典范序（验证栈自底向上，序即语义） */
export type VerificationLayer = 'L1-pixel' | 'L2-diff' | 'L3-semantic' | 'L4-expectation';

export interface RehearsalOutcome {
  chainId: string;
  snapshotId: string;
  verdict: RehearsalVerdict;
  steps: RehearsalStepResult[];
  /** fail-fast 断点（对齐 orchestrator 协议） */
  failedAtIndex: number | null;
  /** 引擎唯一计算出口处经 makeScore 铸造；未执行的验证层不得计入评分 */
  score: Score;
  /** 集合语义：铸造点强制去重 + L1→L4 典范序。载体保持 Array：
   *  本字段三渡 JSON 边界（报告落盘/checkpoint/append-only 链），Set 静默序列化为 {} */
  readonly verificationLayers: ReadonlyArray<VerificationLayer>;
  /** Σ steps.latencyMs + 调度开销 */
  totalLatencyMs: number;
  /** 回显 chain.budgetMs（存在时）—— 判定超预算无需回查链：totalLatencyMs > budgetMs */
  budgetMs?: number;
  /** 防篡改审计随行（doctor/verdict 回执的关联锚） */
  chainTip: string;
  /** Token 纪律：对话流只回句柄，全量证据走落盘报告 */
  reportPath: string;
  /** K 纪元：固化入口指纹的真实来源（此前恒 undefined —— passed 不可达） */
  entrySceneFingerprint?: string;
  createdAt: number;
}

/** 集合语义查询面（铸造点保证去重与典范序，此处只做成员判定） */
export function hasVerificationLayer(o: RehearsalOutcome, layer: VerificationLayer): boolean {
  return o.verificationLayers.includes(layer);
}

// ─── 6. 宿主重放：首演的战报 ───

export interface HostReplayDivergence {
  stepIndex: number;
  kind: 'effect-missing' | 'effect-unexpected' | 'semantic-mismatch' | 'latency-anomaly';
  /** 沙箱预演证词（摘要） */
  sandboxSaid: string;
  /** 宿主实录（摘要） */
  hostDid: string;
}

export interface HostReplayOutcome {
  muscleMemoryId: string;
  verdict: 'confirmed' | 'diverged' | 'failed';
  /** 宿主 journal 条目哈希（重放轨迹入宿主因果链 —— 复用既有哈希链） */
  journalRefs: string[];
  /** 空 = 沙箱世界模型与宿主完全一致 */
  divergences: HostReplayDivergence[];
  /** = muscleReliability(回写后的 entry) —— 0-1 域，与 Score 品牌隔离 */
  reliabilityAfter: number;
  reportPath: string;
  createdAt: number;
}

// ─── 6.5 宿主执行器端口（ΑΩ-R19：replayOnHost 四门全过后的物理派发面）───

/** 单步派发结果：ok=false = 该步未落到物理世界（如实在 note 归因） */
export interface HostExecutorStepResult {
  ok: boolean;
  /** 紧凑归因短语（Token 纪律：对话流只见紧凑数字，短语进 divergence/report） */
  note: string;
}

// ── ΠΑΝ-42：链级效果验证端口（可靠度从「派发完成」升级为「效果验证」）──
// 病灶（C2-3 M1）：HostExecutorStepResult 只证「派发返回」，replayOnHost 以
// divergences.length===0 判 confirmed 并 recordHostReplay(true) —— 打偏/遮挡/
// 输入落空等「派发成功但零效果」链条持续抬高 hostSuccessCount ⇒ muscleReliability
// 虚高，门 4A 度量的是派发可靠度而非任务可靠度。修法：端口扩一个**可选**链级
// 验证方法（装配层适配器复用 actionVerifier 的终帧 dHash 路径实现）；引擎在
// 全部步派发完毕后调用。诚实分层：返回 null = 验证面缺席（适配器取证失败/
// 全非物理链）⇒ 引擎回落派发基线并**如实标注**，绝不虚报「已验证效果」。
/** 链级效果验证裁决：verified = 世界确有该链的效果证据；note = 紧凑归因 */
export interface HostChainEffectVerdict {
  verified: boolean;
  note: string;
}

/**
 * 宿主执行器端口 —— 结构注入（engine 不 import 根层模块，破环纪律；装配主权
 * 在 sandbox/index.ts apply 装配层）。端口契约与《异常诚实分层契约》第二条同律：
 * executeAction 永不抛错 —— 一切异常/非法参数语义收敛为 ok:false + note 归因。
 * 动作方言与 SandboxAction 逐字同构（归一化坐标 [0,1]² 直通，零换算零漂移）。
 */
export interface HostExecutor {
  /** 派发单步沙箱动作到宿主物理面（调用方按 entry.steps 顺序逐步调用） */
  executeAction(action: SandboxAction): Promise<HostExecutorStepResult>;
  /** ΠΑΝ-42：链级效果验证（可选 —— 缺席 = 验证面缺席，引擎诚实降级为派发基线）。
   *  全部步派发完毕后由引擎调用一次；实现永不抛（故障收敛为 null 诚实缺席）。 */
  verifyChainEffect?(input: {
    steps: ReadonlyArray<SandboxAction>;
  }): Promise<HostChainEffectVerdict | null>;
}

// ─── 6.6 指纹相似度单一纯函数（ΠΑΝ-41：双源收编）───
// 病灶（C2-3 M6）：memory.fingerprintSimilarity（等宽才比 + 除数硬编码 64）与
// engine.fpSimilarity（位宽鲁棒）双源漂移 —— 128 位等宽串在召回侧算出负数、
// dist≤6 时虚高过 0.9 闸；重放门禁侧却正常。同库两处实现、两种语义，正是
// 注释里反复立法反对的「方言克隆」。修法：位宽鲁棒版收编进契约层（本文件）
// 作唯一事实源，memory（召回侧同屏加成）与 engine（门 4B 同屏判定）统一消费。
/** 指纹比对结果（ΑΩ-R19：相似度 + 位宽注记） */
export interface FpComparison {
  /** 0-1 域相似度（比对长度上的汉明距离归一） */
  similarity: number;
  /** 截断位宽注记：两侧位宽不等时的公共前缀长度（诚实降级 —— 宿主指纹格式
   *  演进（64→128 位等）不再静默全拒；undefined = 等宽全量比对） */
  truncatedTo?: number;
}

/**
 * 指纹相似度（perceptualHash.similarity/hammingDistance 同构式本地复刻：
 * D-5 只需纯字符串距离，不拖入 sharp 图像二进制运行时依赖）。
 * ΑΩ-R19/ΠΑΝ-41 位宽鲁棒：等宽 ⇒ 按实际位宽逐位比对（除数为长度而非硬编码
 * 64 —— 对现行 64 位串数值逐字节不变；128 位串不再产出负数）；不等宽 ⇒ 按
 * 较短侧前缀比对并注记 truncatedTo（诚实降级优于静默 0 —— 格式演进静默全拒
 * = 把升级伪装成全局失配）；空串（0 位证据）仍 0。纯函数、永不抛。
 */
export function fpSimilarity(a: string, b: string): FpComparison {
  if (a.length === 0 || b.length === 0) return { similarity: 0 };
  const n = Math.min(a.length, b.length);
  let dist = 0;
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) dist++;
  return {
    similarity: 1 - dist / n,
    ...(a.length !== b.length ? { truncatedTo: n } : {}),
  };
}

// ─── 7. 双闸门矩阵：D-5 自审 × D-4 外审，两权威正交，绝不合并枚举 ───

export type ConsolidationDecision = 'consolidate' | 'discard' | 'freeze-for-review';

/**
 * 纯函数，永不抛错。passed × rejected 是合法且高价值的报警态：
 * 预演「达成了效果」但链触犯创世铁律（如点击成功但目标命中敏感字段）。
 * 闸一：医生否决权 universal；闸二：自知之明；
 * 闸三：证据不足（degraded）时医生的 approved 亦无效 —— 未执行的验证层之上无完美分；
 * 闸四：医生终审。
 */
export function resolveConsolidation(
  rehearsal: RehearsalVerdict,
  doctor: DoctorVerdict,
): ConsolidationDecision {
  if (doctor === 'rejected') return 'discard';
  if (rehearsal === 'failed' || rehearsal === 'aborted') return 'discard';
  if (rehearsal === 'degraded') return 'freeze-for-review';
  return doctor === 'approved' ? 'consolidate' : 'freeze-for-review';
}

// ─── 8. D-4 消费侧最小视图（dsh-stubs 模式：仅声明实际使用的表面）───
// diagnose/heal 不在此列：事件总线铁律下 D-5 绝不直接调用，诊断由 D-4 订阅
// sandbox/rehearsal-end 后自主触发（includeChainAudit: true），判决经事件回执。

export interface SandboxDoctorView {
  /** Token 纪律：只持句柄不读全文 */
  reportPath(): string | null;
  memory(): Readonly<{ totalDiagnoses: number; lastReport: { score: number } | null }>;
}

// ─── 9. ID 生成契约（并发安全 + 跨会话不撞号）───

export type SandboxIdKind = 'chain' | 'snap' | 'muscle' | 'intent'; // intent = D-6 意图（持久审计实体）

/**
 * ID 生成器契约：同步、纯函数、永不抛错（构造器内可用）。
 * 四分量各防一种失效模式：
 *   kind   类型自述（取证肉眼可辨）
 *   ts36   时间局部性 + 字典序可排序
 *   seq36  同毫秒并发（单调计数，事件环内无竞态）
 *   nonce8 跨进程重启撞号（肌肉记忆活得比会话长 —— 重载后撞号 = 覆盖 = 数据丢失）
 */
export interface IdGenerator {
  next(kind: SandboxIdKind): string;
}

/** 生命周期铁律：counter 与 BOOT_NONCE 是模块寿命级状态，engine.reset() 无权触碰 */
const BOOT_NONCE = randomUUID().slice(0, 8);
let counter = 0;

/** 默认实现（契约文件内的唯一例外：纯基础设施零业务逻辑，对齐 makeScore 先例） */
export function createDefaultIdGenerator(): IdGenerator {
  return {
    next: kind => `${kind}-${Date.now().toString(36)}-${(counter++).toString(36)}-${BOOT_NONCE}`,
  };
}

// ─── 10. 引擎门面：D-5 的全部对外表面 ───

/**
 * D-5 配置消费接口 —— 字段来源分层：
 *   cordis.yml → Schema（浇筑纪元落 src/sandbox/config 层，对齐主插件 config.ts 方言）→ apply(ctx, config)
 *   测试注入（如 idGenerator 确定性生成）在此直接传入
 * 本接口只声明引擎消费的类型面；魔法数字一律不落代码常量（config-driven 铁律）。
 * 按实际使用面增补（快照容量/记忆持久化路径/预算默认值…）—— 现阶段留白即契约。
 */
export interface SandboxConfig {
  /** 缺省 = createDefaultIdGenerator() */
  idGenerator?: IdGenerator;
  /** 肌肉记忆持久化路径（配置后跨会话存活；缺省 = 仅内存，卸载即逝 —— 诚实声明） */
  memoryPath?: string;
  /** 排练报告落盘目录（Token 纪律的结构化落点；缺省 = 不落盘，reportPath 报告 'in-memory'） */
  reportDir?: string;
  /** 宿主重放放行的最低可靠度阈值（0-1 域；THE HOST IS SACRED 的置信度闸门） */
  hostReplayMinReliability?: number;
  /** 入口指纹同屏判定阈值（TRUST IS A FINGERPRINT：宿主观察 vs 排练入口的相似度下限） */
  entrySceneMinSimilarity?: number;
  /** ΑΩ-R19：宿主重放执行接线开关。缺省关闭 = 既有开发者预览语义零回归
   *  （四门全过仍诚实 failed "no host executor wired"）；true ⇒ apply 装配层把
   *  根层 physicalBackend 动作面适配为 HostExecutor 注入（四门全过 ⇒ 真派发，
   *  派发失败/装配失败仍诚实 failed 归因）。 */
  enableHostReplayExecution?: boolean;
  /** ΠΑΝ-42：热键黑名单 CSV（Config.hotkeyBlacklist 的结构子集 —— 装配层透传）。
   *  在场 ⇒ 步级安全扫描对黑名单和弦**前置**结构化拒绝（链中段黑名单步在
   *  任何派发之前被拦 —— 「危险步绝不部分执行」对热键面成立）；缺席 ⇒ 扫描
   *  不重复执法黑名单（事实源仍是 system.pressHotkey 派发时刻 —— P1-3 立法，
   *  DEFAULT_ACTION_GATE_CONFIG 同注）。缺省缺席 = 零回归。 */
  hotkeyBlacklistCsv?: string;
}

export interface SandboxEngine {
  /** 加载层方法（《异常诚实分层契约》第一条）：校验失败 throw —— 拒绝带病上线 */
  configure(config: SandboxConfig): void;

  /** 铸造快照：镜像世界存档点。宿主观察缓存缺席 ⇒ screenDhash='' 的降级快照而非谎言 */
  createSnapshot(): Promise<Result<SandboxSnapshot>>;

  /**
   * 沙箱预演：逐动作虚拟执行 + 四层验证栈裁决。
   * 验证层缺席的步骤 effectDetected=null（诚实降级）；预算在步边界检查，
   * 超限 ⇒ verdict='aborted' + 部分轨迹。任何内部异常 ⇒ verdict='degraded'。
   */
  rehearse(chain: ActionChain, opts?: { snapshotId?: string }): Promise<RehearsalOutcome>;

  /**
   * 固化肌肉记忆：双闸门（resolveConsolidation）裁决。
   * consolidate ⇒ 冻结副本入库（同签名步骤序列去重强化，不堆孤儿卡）；
   * discard ⇒ 返回 null（判决与 rationale 仍入沙箱因果链作失败养分）；
   * freeze-for-review ⇒ 返回 null 并登记待审（B-3 式人工闸门，裁决权属造物主）。
   */
  consolidate(outcome: RehearsalOutcome, doctorVerdict?: DoctorVerdict): Result<MuscleMemoryEntry | null>;

  /** 肌肉记忆召回：文本重合 + 可靠度 + 入口场景同屏加成 + 新近度（先验，非保证） */
  recallMuscleMemory(query: string): Result<MuscleMemoryEntry[]>;

  /**
   * 宿主重放：唯一出口。四重门禁（两阶段令牌 / 医生 approved / 可靠度阈值 /
   * 入口指纹匹配）任一失败 ⇒ verdict='failed' + 拒绝原因落盘。
   * 门禁全过后按接线分岔（ΑΩ-R19）：执行器未注入（缺省）⇒ 诚实 failed 并如实
   * 记载（对齐现世 orchestrator Actor 未接线先例 —— 诚实失败优于虚假成功）；
   * 已注入（apply 装配层经 enableHostReplayExecution 开关）⇒ 逐动作真派发，
   * 首败即停 + 结局如实入 divergence 与可靠度计数。
   */
  replayOnHost(entryId: string, opts: { confirmToken: string }): Promise<HostReplayOutcome>;

  /** ΑΩ-R19：宿主执行器端口注入（结构注入 —— null = 拔线，回到未接线语义）。
   *  运行层方法：注入物形状非法不 throw，静默视为未接线（诚实降级）。 */
  wireHostExecutor(executor: HostExecutor | null): void;

  /** 可观测性：沙箱会话日志审计（append-only 哈希链，verify 语义对齐 journal） */
  verifyLog(): Result<{ ok: boolean; length: number; brokenAt: number | null }>;

  /** 生命周期归零：卸载时清空内存态（持久化资产已在 ctx.effect 清理函数先行落盘） */
  reset(): void;
}
