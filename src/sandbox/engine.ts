// src/sandbox/engine.ts
// W6-2 结构性保留（doctor smell.over-engineering 登记）：D-5 确定性沙箱引擎单职责 —— 动作解释/帧缓存/回归判定围绕同一引擎态高度内聚，强拆将拆散状态机不变量。
// D-5 沙箱执行引擎 —— 契约实现。
// 灵魂三条反射的代码化：
//   THE HOST IS SACRED    → replayOnHost 四重门禁（令牌/医生/可靠度/指纹），缺证即拒
//   DRILL, THEN DELIVER   → 排练簿记全量入链，对话流只见紧凑数字（报告落盘走句柄）
//   TRUST IS A FINGERPRINT→ 放行仅当宿主最新观察指纹与排练入口同屏；无证据 = 拒绝
// 本纪元诚实声明：虚拟屏模拟器是架构留白（蓝图 #5 裁决划出契约）——
// 像素/语义验证层缺席 ⇒ 排练 verdict 恒 'degraded' ⇒ 双闸门恒 freeze/discard ⇒
// 记忆库等待模拟器纪元。引擎绝不伪造 passed（"完美的评分若来自未执行的验证层，
// 那是谎言，不是健康"）。门禁/账本/记忆/召回/事件全部真实可用。
// 异常诚实分层契约（D-6 轮立法）：
//   第一条（加载层）configure 校验失败 throw —— 拒绝带病上线，与宿主同生命周期哲学；
//   第二条（运行层）一切运行时方法永不抛错，Result/verdict 降级 —— 数据流不可击穿。
import { mkdirSync, writeFileSync } from 'fs';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'path';
import type { Context } from '@deepseek-ai/cordis';
import type { DoctorVerdictPayload } from '../doctorEvents';
import { makeScore } from '../doctorEvents';
import {
  emitHostReplayEnd, emitMemoryConsolidated, emitRehearsalBegin, emitRehearsalEnd,
  isBinaryFingerprint,
} from './events';
// ΝΩ-1（第五门接线）：步级安全扫描直接引入 tools/actionGate 的唯一事实源 ——
// 与宿主 replayActions.replayOneTraced 同一判定函数（重放不豁免安全闸）。
// 破环审计：actionGate 的导入闭包 = {riskGate, fuzzy, approval.*, focusTracker}，
// 无一 import 沙箱面 ⇒ 无环（engine 既有 '../doctorEvents' 根层先例同律）。
// ΠΑΝ-42：闭集宇宙 ACTION_KIND_UNIVERSE 同源引入（click/type/hotkey/drag/
// scroll 五通道全覆盖 —— 与 F1 波 ActionKind 扩员对齐，只 import 常量零环）。
import { assertActionAllowed, SAFETY_GATE_BLOCK, ACTION_KIND_UNIVERSE, type ActionKind } from '../tools/actionGate';
import { MuscleMemoryStore, sharedMuscleMemoryStore } from './memory';
import { VirtualScreen, asVirtualWidget } from './virtualScreen';
import { sandboxLog, REHEARSAL_FP_FORMAT } from './log';
import {
  createDefaultIdGenerator, fpSimilarity, muscleReliability, resolveConsolidation,
  type ActionChain, type FpComparison, type HostChainEffectVerdict,
  type HostExecutor, type HostExecutorStepResult,
  type HostReplayDivergence, type HostReplayOutcome, type IdGenerator,
  type RehearsalOutcome, type RehearsalStepResult, type RehearsalVerdict,
  type Result, type SandboxAction, type SandboxConfig, type SandboxEngine,
  type SandboxSnapshot, type VerificationLayer, type VirtualWidget,
} from './types';

// ΠΑΝ-41：指纹相似度唯一事实源已收编契约层（types.fpSimilarity —— 位宽鲁棒：
// 按实际比对长度归一，128 位等宽串不再产出负数）。此处再导出维持引擎既有的
// 公开导入面（epochChi 等测试自 engine 导入 fpSimilarity —— 单源，非克隆）。
export { fpSimilarity };
export type { FpComparison };

/** Laplace 中性先验 = (0+1)/(0+2) —— 数学中性值，非部署调优魔法数字 */
const DEFAULT_MIN_RELIABILITY = 0.5;
/** 场景同屏门限（对齐 skillLibrary.match 场景加成门限 0.9 —— 算法结构常量） */
const DEFAULT_SCENE_SIMILARITY = 0.9;
/** 重放令牌 TTL（对齐宿主 approval 的 120s 方言） */
const REPLAY_TOKEN_TTL_MS = 120_000;
/** 判决缓存容量上限（无界 Map = 缓慢泄漏 —— 对齐 orchestration/index boundedSet 先例） */
const VERDICT_CACHE_MAX = 256;
// ΤΕΛ-13（D-G16 留案 M3 否决钉住立法）：rejected 判决的钉面容量。主缓存
// VERDICT_CACHE_MAX 是「全部判决」的滚动窗，approved/needs_review 的驱逐无害
// （它们不拦截任何门）；唯 rejected 驱逐 = 安全否决权失忆 —— 门3 latest===
// undefined 即放行（C2-3 M3 的病灶）。钉面只收 rejected（远稀于全量），
// 4× 主缓存容量让「普通流量挤出否决」需要 1024 条**其他 rejected 判决**——
// 工程上不可达的噪声水位；仍是有界（无界 Map = 缓慢泄漏，本库既有立法），
// 真到上限的逐出必入链告警（noteDoctorVerdict 内）—— 否决失忆是安全事件，
// 绝不静默。
const VETO_PIN_MAX = 1024;
/** 重放令牌容量上限（铸造时驱逐最旧未决令牌 —— 过期未确认的令牌不许无界滞留） */
const REPLAY_TOKENS_MAX = 64;
/** 待配对排练结果容量（chainId → 最近 outcome；医生判决迟到时的配对面） */
const PENDING_OUTCOMES_MAX = 32;

/** ΠΑΝ-42：步级安全扫描的闭集宇宙（单源自 tools/actionGate.ACTION_KIND_
 *  UNIVERSE —— click/type/hotkey/drag/scroll 五物理写通道；绝不复制第二份词表） */
const GATE_SCANNED_KINDS: ReadonlySet<string> = new Set<string>(ACTION_KIND_UNIVERSE);

/** ΠΑΝ-40e：步的不可逆性判据 —— actionGate 判定为审批域（dangerous/
 *  requiresApproval）或命中不可逆拒因（危险词无令牌 / 凭据语义 / 黑名单和弦 /
 *  公证不符）的步。判定器崩溃 ⇒ 不可逆（fail-closed：不可判定按危险处理）。
 *  词表外 kind（switch_tab 等）不在审批语义面 ⇒ 可逆（导航可 undo）。 */
const IRREVERSIBLE_GATE_REASONS: ReadonlySet<string> = new Set([
  'irreversible-action', 'token-not-granted-or-expired', 'sensitive-input',
  'blacklisted-hotkey', 'notary-mismatch',
]);

function stepIrreversible(step: SandboxAction, hotkeyBlacklistCsv?: string): boolean {
  if (!step || !GATE_SCANNED_KINDS.has(step.kind)) return false;
  try {
    // 类型收窄注记：GATE_SCANNED_KINDS.has 已在运行时把 kind 收进闸门闭集
    //（SandboxActionKind ⊋ ActionKind —— switch_tab 等词表外 kind 上面已让渡）。
    const d = assertActionAllowed(
      step.kind as ActionKind, step.args,
      // ΠΑΝ-42：黑名单透传在场 ⇒ 不可逆性判定把黑名单和弦计入（fail-closed 方向）
      hotkeyBlacklistCsv !== undefined ? { hotkeyBlacklist: hotkeyBlacklistCsv } : undefined,
    );
    return d.dangerous === true || d.requiresApproval === true
      || (d.reason !== undefined && IRREVERSIBLE_GATE_REASONS.has(d.reason));
  } catch {
    return true; // fail-closed：判定器崩溃 = 不可逆
  }
}

/** 验证层典范序（铸造点排序依据：验证栈自底向上，序即语义） */
const LAYER_ORDER: ReadonlyArray<VerificationLayer> =
  ['L1-pixel', 'L2-diff', 'L3-semantic', 'L4-expectation'];

/** 两阶段重放令牌（B-3 语义自持实现：D-5 与宿主插件生命周期隔离，不共享单例） */
interface ReplayToken {
  token: string;
  entryId: string;
  expiresAt: number;
}

/** 虚拟簿记：沙箱世界模型的最小诚实形态（状态转移簿记，不伪造像素演化） */
interface VirtualBookkeeping {
  cursor: { x: number; y: number };
  focus?: { x: number; y: number; sensitive: boolean; capturedAt: number };
  typedChars: number;
}

export class SandboxEngineImpl implements SandboxEngine {
  private cfg: SandboxConfig = {};
  private idGen: IdGenerator = createDefaultIdGenerator();
  // ΠΑΝ-41（双账本合一）：引擎记账与宏排练门禁（macroRehearsal.sharedMacro
  // RehearsalGate 缺省注入）统一走 memory.ts 的 sharedMuscleMemoryStore ——
  // 此前的私有 `new MuscleMemoryStore()` 与共享实例互不可见：宏排练登记
  // （生产真实发生的唯一写入路径，skillTools run_skill）引擎 recall/replay
  // 永远看不到，引擎 recordHostReplay 也永远记不到宏条目头上；memory.ts 与
  // macroRehearsal.ts 注释宣称的「同账本、跨会话存活」是虚假陈述。构造接受
  // 显式注入独立实例（离线测试隔离 —— MacroRehearsalGate 同律）。
  private readonly memory: MuscleMemoryStore;
  /** 宿主观察缓存（TRUST IS A FINGERPRINT 的镜像源头；嗅探缺席 = null = 保守拒绝） */
  private hostFingerprint: string | null = null;
  /** D-4 判决缓存（subject=chainId → 最新回执；重放时刻的复核源） */
  private verdictCache = new Map<string, DoctorVerdictPayload>();
  // ΤΕΛ-13（D-G16 留案 M3）：否决钉面 —— subject → 最新 rejected 判决。
  // 独立于 256-FIFO 主缓存：普通判决的滚动驱逐不再连带挤出安全否决
  // （钉面只受自身容量约束 + 逐出入链告警）。同 subject 的更新判决按
  // 「最新否决即刻拦截 / 最新批准即刻放行」既有语义换钉（新 rejected 换旧
  // rejected；新 approved/needs_review 解钉 —— 被复核推翻的否决不永生）。
  private pinnedVetoes = new Map<string, DoctorVerdictPayload>();
  private replayTokens = new Map<string, ReplayToken>();
  /** 最近排练结果（chainId → outcome，容量执法 FIFO —— 判决迟到时的配对面） */
  private pendingOutcomes = new Map<string, import('./types').RehearsalOutcome>();
  private readonly ctx: Context | null;
  /** ΑΩ-R19：宿主执行器端口（结构注入 —— 缺席 = 既有诚实 failed 语义零回归；
   *  注入主权在 index.ts apply 装配层，engine 零根层 import） */
  private hostExecutor: HostExecutor | null = null;

  // 显式字段赋值（非参数属性）：Node strip-only 运行时契约 —— 现世源码同方言
  constructor(ctx: Context | null, store?: MuscleMemoryStore) {
    this.ctx = ctx;
    // ΠΑΝ-41：缺省 = 共享持久实例（与宏排练门禁同一账本）；显式注入优先（测试隔离）
    this.memory = store ?? sharedMuscleMemoryStore;
  }

  /** 加载层方法（《异常诚实分层契约》第一条）：校验失败 throw —— 拒绝带病上线 */
  configure(config: SandboxConfig): void {
    const errors: string[] = [];
    const rel = config.hostReplayMinReliability;
    if (rel !== undefined && (!Number.isFinite(rel) || rel < 0 || rel > 1)) {
      errors.push(`hostReplayMinReliability must be in [0,1], got ${rel}`);
    }
    const sim = config.entrySceneMinSimilarity;
    if (sim !== undefined && (!Number.isFinite(sim) || sim < 0 || sim > 1)) {
      errors.push(`entrySceneMinSimilarity must be in [0,1], got ${sim}`);
    }
    // ΑΩ-R19：执行接线开关的加载层执法（类型伪装的开关 = 带病配置，拒绝上线）
    if (config.enableHostReplayExecution !== undefined
      && typeof config.enableHostReplayExecution !== 'boolean') {
      errors.push(`enableHostReplayExecution must be a boolean, got ${typeof config.enableHostReplayExecution}`);
    }
    // ΠΑΝ-42：热键黑名单透传面的加载层执法（类型伪装 = 带病配置）
    if (config.hotkeyBlacklistCsv !== undefined && typeof config.hotkeyBlacklistCsv !== 'string') {
      errors.push(`hotkeyBlacklistCsv must be a string (CSV), got ${typeof config.hotkeyBlacklistCsv}`);
    }
    if (errors.length > 0) {
      throw new Error(`[SandboxEngine] invalid configuration:\n  - ${errors.join('\n  - ')}`);
    }
    this.cfg = { ...config };
    this.idGen = config.idGenerator ?? createDefaultIdGenerator();
    // ΠΑΝ-41：configure 现在武装的是**共享**账本（此前 sharedMuscleMemoryStore
    // 全库无人 configure ⇒ macroRehearsal 的 save() 走「无路径旁路 true」静默
    // no-op，「排练通过即刻落盘（崩溃安全）」实为空转）。引擎 configure =
    // 共享账本的唯一持久化武装点：memoryPath 在场 ⇒ 引擎与宏门禁的登记/回写
    // 全部真实落盘；load() 防御恢复（崩溃/重启后跨会话召回 —— 单条畸形不连坐）。
    this.memory.configure(config.memoryPath ?? '');
    this.memory.load();
  }

  /** 宿主观察登记（index.ts 的 onHostToolPost 嗅探后喂数据；实现类公开面）。
   *  ΝΩ-1：摄取位宽放宽为 [01]{32,256}（events.isBinaryFingerprint 单源）——
   *  ΑΩ-R19 修了比对侧（fpSimilarity 不等宽前缀比对）却把摄取侧留在 64 位，
   *  truncatedTo 分支因此永不可达。128 位宿主指纹从此可入缓存，与比对侧协同。 */
  noteHostObservation(fingerprint: string | null): void {
    if (fingerprint === null) {
      this.hostFingerprint = null;
      return;
    }
    if (isBinaryFingerprint(fingerprint)) {
      this.hostFingerprint = fingerprint;
    }
  }

  /** D-4 判决登记（onDoctorVerdict 接线后喂数据；双闸门与重放复核的缓存源）。
   *  容量执法：超上限 FIFO 驱逐最旧条目（Map 迭代序 = 插入序）。
   *  ΤΕΛ-13（D-G16 留案 M3 否决钉住）：rejected 判决同时钉入钉面 —— 主缓存
   *  被普通流量挤出后门3 仍可复核到否决（安全否决权不失忆）；非 rejected 的
   *  新判决到达 ⇒ 解钉（最新判决语义分毫不变）。钉面自身超容量 ⇒ 逐出最旧
   *  并入链告警 —— 否决失忆绝不静默（C2-3 M3 的「驱逐无任何告警注记」半面
   *  同步闭合）。 */
  noteDoctorVerdict(p: DoctorVerdictPayload): void {
    this.verdictCache.delete(p.subject); // 重置插入位：更新即最新
    this.verdictCache.set(p.subject, p);
    while (this.verdictCache.size > VERDICT_CACHE_MAX) {
      const oldest = this.verdictCache.keys().next().value;
      if (oldest === undefined) break;
      this.verdictCache.delete(oldest);
    }
    // ΤΕΛ-13（M3）：钉面执法 —— 主缓存驱逐 rejected 不再等于否决失忆
    if (p.verdict === 'rejected') {
      this.pinnedVetoes.delete(p.subject); // 重置插入位：换钉即最新
      this.pinnedVetoes.set(p.subject, p);
      while (this.pinnedVetoes.size > VETO_PIN_MAX) {
        const oldestPinned = this.pinnedVetoes.keys().next().value;
        if (oldestPinned === undefined) break;
        this.pinnedVetoes.delete(oldestPinned);
        // 告警入链（fire-and-forget 同 consolidate 既有方言）：被逐出的否决
        // 所属链此后走门3 主缓存复核（缺席 = 放行）—— 该事实对审计可见。
        void sandboxLog.append('veto-pin-evicted', {
          subject: oldestPinned,
          pinnedSize: this.pinnedVetoes.size, cap: VETO_PIN_MAX,
          note: 'rejected verdict dropped from veto pin map (capacity) — chain re-verdict required to re-arm the veto',
        });
      }
    } else {
      // 最新判决不再否决 ⇒ 解钉：approved/needs_review 复核推翻旧否决，
      // 门3 回到主缓存语义（钉面不持有被推翻的否决 —— 换钉律的单调半边）
      this.pinnedVetoes.delete(p.subject);
    }
  }

  /** D-1 计划接收（onCognitionPlanReady 接线后的排练触发点） */
  async receivePlan(chain: ActionChain): Promise<RehearsalOutcome> {
    return this.rehearse({ ...chain, origin: 'cognition' });
  }

  async createSnapshot(): Promise<Result<SandboxSnapshot>> {
    const snap: SandboxSnapshot = {
      id: this.idGen.next('snap'),
      createdAt: Date.now(),
      screenDhash: this.hostFingerprint ?? '',
      focus: undefined,
      cursor: undefined,
      chainTip: sandboxLog.tip,
      whiteboxAvailable: false, // 白盒源（D-3）接入是模拟器纪元主权；诚实 false
    };
    await sandboxLog.append('snapshot-created', {
      snapshotId: snap.id,
      mirrorSource: this.hostFingerprint ? 'host-observation' : 'absent-degraded',
    });
    return { ok: true, value: snap };
  }

  async rehearse(chain: ActionChain, opts?: { snapshotId?: string }): Promise<RehearsalOutcome> {
    const startedAt = Date.now();
    if (!chain || !Array.isArray(chain.actions) || chain.actions.length === 0) {
      return this.finishRehearsal(chain?.id ?? 'chain-invalid', opts?.snapshotId ?? 'snap-none', {
        verdict: 'failed', steps: [], failedAtIndex: null, layers: [],
        totalLatencyMs: 0, budgetMs: chain?.budgetMs, startedAt,
        note: 'invalid chain: actions must be a non-empty array',
      });
    }

    const snapResult = await this.createSnapshot();
    const snapshotId = opts?.snapshotId ?? (snapResult.ok ? snapResult.value.id : 'snap-none');

    // Χ 纪元（重放证词）：取证场景 = asVirtualWidget 铸造后的规范形 —— 与
    // VirtualScreen 内部世界逐位同源（原始场景里的畸形控件/超长名在链上记录的
    // 就是世界真正收下的形状；重演侧同一构造函数再铸，世界形状必然一致）。
    const forensicScene: VirtualWidget[] = chain.virtualScene
      ? chain.virtualScene.map(asVirtualWidget).filter((w): w is VirtualWidget => w !== null)
      : [];

    await sandboxLog.append('rehearsal-begin', {
      chainId: chain.id, snapshotId, actions: chain.actions.length,
      // ── Χ（纯增量可选字段）：格式标记 + 入口场景（重演的世界源；
      //    全畸形场景 ⇒ 世界为空 ⇒ 不记场景 —— 无世界即无可重放，诚实）──
      fpFormat: REHEARSAL_FP_FORMAT,
      ...(forensicScene.length > 0 ? { scene: forensicScene } : {}),
    });
    if (this.ctx) emitRehearsalBegin(this.ctx, { chainId: chain.id, snapshotId, startedAt });

    const book: VirtualBookkeeping = { cursor: { x: 0.5, y: 0.5 }, typedChars: 0 };
    const screen = chain.virtualScene ? new VirtualScreen(chain.virtualScene) : null;
    const steps: RehearsalStepResult[] = [];
    const activeLayers = new Set<VerificationLayer>();
    const t0 = Date.now();
    let failedAtIndex: number | null = null;
    let aborted = false;

    try {
      for (let i = 0; i < chain.actions.length; i++) {
        const action = chain.actions[i];
        const stepStart = Date.now();
        // 预算感知：步边界检查时钟（优雅中止而非失控）
        if (chain.budgetMs !== undefined && Date.now() - t0 > chain.budgetMs) {
          aborted = true;
          failedAtIndex = i;
          await sandboxLog.append('rehearsal-step', {
            chainId: chain.id, index: i, budgetExceeded: true, elapsedMs: Date.now() - t0,
          });
          break;
        }

        this.applyBookkeeping(book, action);
        const latencyMs = Date.now() - stepStart;

        // K 纪元（留白兑现）：虚拟屏在场 ⇒ 逐步产出真证据（L1 命中测试 /
        // L4 期望对照）；缺席 ⇒ 既有诚实降级（null ≠ false）零回归。
        const evidence = screen ? screen.applyAction(action) : null;
        if (evidence) {
          for (const l of evidence.layers) activeLayers.add(l);
          // K 纪元：世界回击（effectDetected=false / 期望违例）记入失败位
          if ((evidence.effectDetected === false || evidence.expectationMet === false) && failedAtIndex === null) failedAtIndex = i;
        }
        steps.push({
          index: i,
          action,
          effectDetected: evidence ? evidence.effectDetected : null,
          expectationMet: evidence ? evidence.expectationMet : null,
          latencyMs,
          note: evidence ? evidence.note
            : action.expect
              ? 'expect declared but no virtual scene — verification unavailable (honest null)'
              : 'no virtual scene — verification unavailable (honest null)',
        });
        // Χ（纯增量可选字段）：完整动作 + 该步后屏状态指纹 —— 重放章的链上权威
        // 记录。指纹域零时钟零熵（latency/ts 不进指纹）—— 同动作链必同指纹序列。
        const screenFp = screenStateFingerprint(screen);
        const stepData: Record<string, any> = {
          chainId: chain.id, index: i, kind: action.kind, latencyMs,
          effectDetected: evidence ? evidence.effectDetected : null,
          expectationMet: evidence ? evidence.expectationMet : null,
          virtualFocus: book.focus ? `${book.focus.x},${book.focus.y}` : null,
          fpFormat: REHEARSAL_FP_FORMAT,
          action,
        };
        if (screenFp !== null) stepData.screenFingerprint = screenFp;
        await sandboxLog.append('rehearsal-step', stepData);
      }
    } catch (e: any) {
      // 异常诚实：内部异常 ⇒ degraded（不吞不抛）
      return this.finishRehearsal(chain.id, snapshotId, {
        verdict: 'degraded', steps, failedAtIndex, layers: [...activeLayers],
        totalLatencyMs: Date.now() - t0, budgetMs: chain.budgetMs, startedAt,
        note: `internal error during rehearsal: ${e?.message ?? 'unknown'}`,
      });
    }

    const totalLatencyMs = Date.now() - t0;
    // K 纪元：任何反证（L1 落空 / L4 期望违例）⇒ failed —— "变了但不是预期的变化"
    // 与宿主 intentBetrayed 同律：期望背叛即失败，不因像素有变化而豁免。
    const verdict: RehearsalVerdict = aborted
      ? 'aborted'
      : steps.some(s => s.effectDetected === false || s.expectationMet === false)
        ? 'failed'
        : activeLayers.size === 0
          ? 'degraded' // 零生效验证层 ⇒ 诚实 degraded（无场景的既有语义）
          : 'passed'; // K 纪元可达：虚拟场景产出证据且无反证（期望违例已计入 false）

    return this.finishRehearsal(chain.id, snapshotId, {
      verdict, steps, failedAtIndex, layers: [...activeLayers],
      totalLatencyMs, budgetMs: chain.budgetMs, startedAt,
      // ΠΑΝ-40d（指纹生产侧铸造）：链自带入口指纹优先（manual/planner 供源）；
      // 缺席 ⇒ 铸造排练时刻的宿主最新观察（TRUST IS A FINGERPRINT 的镜像源）。
      // 此前该字段全库无生产赋值点 ⇒ 即便条目入库，门 4B 仍恒拒（空 entryFp ⇒
      // cmp=null）。铸造只在世界证据在场时发生 —— hostFingerprint 为 null（嗅探
      // 缺席）⇒ 保持 undefined（诚实缺席，门 4B 按 ΠΑΝ-40e 语义分道），绝不伪造。
      entrySceneFingerprint: chain.entrySceneFingerprint ?? this.hostFingerprint ?? undefined,
      note: aborted ? `budget exceeded at step ${failedAtIndex}` : undefined,
    });
  }

  /** 簿记转移：焦点/光标/输入记账（沙箱世界模型的最小诚实形态） */
  private applyBookkeeping(book: VirtualBookkeeping, action: SandboxAction): void {
    const num = (v: any): number | null =>
      typeof v === 'number' && Number.isFinite(v) ? v : null;
    switch (action.kind) {
      case 'click_mouse': {
        const x = num(action.args?.x) ?? book.cursor.x;
        const y = num(action.args?.y) ?? book.cursor.y;
        book.cursor = { x, y };
        book.focus = {
          x, y,
          sensitive: typeof action.args?.target_description === 'string' &&
            /password|密码|验证码|otp|2fa|token|api[_ -]?key/i.test(action.args.target_description),
          capturedAt: Date.now(),
        };
        break;
      }
      case 'drag_mouse': {
        const ex = num(action.args?.endX);
        const ey = num(action.args?.endY);
        if (ex !== null && ey !== null) book.cursor = { x: ex, y: ey };
        break;
      }
      case 'type_text': {
        const text = typeof action.args?.text === 'string' ? action.args.text : '';
        book.typedChars += text.length;
        break;
      }
      default:
        break; // scroll/hotkey/switch/dismiss/noop：无焦点/光标转移
    }
  }

  /** 排练收尾：评分铸造（零证据零分）+ 落盘 + 入链 + 事件。永不抛错 */
  private async finishRehearsal(
    chainId: string,
    snapshotId: string,
    r: {
      verdict: RehearsalVerdict;
      steps: RehearsalStepResult[];
      failedAtIndex: number | null;
      layers: VerificationLayer[];
      totalLatencyMs: number;
      budgetMs?: number;
      startedAt: number;
      entrySceneFingerprint?: string;
      note?: string;
    },
  ): Promise<RehearsalOutcome> {
    // 铸造点：去重 + 典范序（集合语义，Array 载体 —— 三渡 JSON 边界）
    const present = new Set(r.layers);
    const layers = LAYER_ORDER.filter(l => present.has(l));
    // 评分铁律：未执行的验证层不得计入评分 —— 零生效层 = 零分（没有证据就没有分数）
    const rawScore = layers.length === 0
      ? 0
      : Math.round((layers.length / LAYER_ORDER.length) * 100);
    // rawScore 恒在 [0,100]（layers ⊆ LAYER_ORDER）⇒ makeScore 恒成功；
    // 兜底走 0 分重铸而非 as-any 走私无品牌值（唯一铸造点纪律）
    const score = makeScore(rawScore) ?? makeScore(0)!;

    const createdAt = Date.now();
    const report = {
      chainId, snapshotId, verdict: r.verdict, score: rawScore,
      steps: r.steps, failedAtIndex: r.failedAtIndex,
      verificationLayers: layers, totalLatencyMs: r.totalLatencyMs,
      budgetMs: r.budgetMs, note: r.note, createdAt,
    };
    const reportPath = this.persistReport(`rehearsal-${chainId}-${createdAt}.json`, report);

    const outcome: RehearsalOutcome = {
      chainId, snapshotId, verdict: r.verdict, steps: r.steps,
      failedAtIndex: r.failedAtIndex, score, verificationLayers: layers,
      totalLatencyMs: r.totalLatencyMs, budgetMs: r.budgetMs,
      chainTip: sandboxLog.tip, reportPath, createdAt,
      entrySceneFingerprint: r.entrySceneFingerprint,
    };
    // 待配对面登记：医生判决（subject=chainId）迟到时由此配对走双闸门固化
    this.pendingOutcomes.delete(chainId);
    this.pendingOutcomes.set(chainId, outcome);
    while (this.pendingOutcomes.size > PENDING_OUTCOMES_MAX) {
      const oldest = this.pendingOutcomes.keys().next().value;
      if (oldest === undefined) break;
      this.pendingOutcomes.delete(oldest);
    }
    await sandboxLog.append('rehearsal-end', {
      chainId, verdict: r.verdict, score: rawScore,
      totalLatencyMs: r.totalLatencyMs, steps: r.steps.length, reportPath,
    });
    if (this.ctx) {
      emitRehearsalEnd(this.ctx, {
        chainId, snapshotId, verdict: r.verdict, score,
        chainTip: outcome.chainTip, reportPath, endedAt: createdAt,
      });
    }
    return outcome;
  }

  /** 结构化落盘（Token 纪律：对话流只回句柄；失败降级 'in-memory' 并 warn） */
  private persistReport(fileName: string, report: unknown): string {
    if (!this.cfg.reportDir) return 'in-memory';
    try {
      mkdirSync(this.cfg.reportDir, { recursive: true });
      const full = join(this.cfg.reportDir, fileName);
      writeFileSync(full, JSON.stringify(report, null, 2), 'utf8');
      return full;
    } catch (e: any) {
      console.warn(`[SandboxEngine] report persist failed: ${e.message}`);
      return 'in-memory';
    }
  }

  consolidate(
    outcome: RehearsalOutcome,
    doctorVerdict?: import('../doctorEvents').DoctorVerdict,
  ): Result<import('./types').MuscleMemoryEntry | null> {
    const doctor = doctorVerdict ?? 'needs_review'; // 缺省保守：无医生回执即待审
    const decision = resolveConsolidation(outcome.verdict, doctor);
    void sandboxLog.append('consolidation', {
      chainId: outcome.chainId, decision, doctorVerdict: doctor, rehearsal: outcome.verdict,
    });
    if (decision !== 'consolidate') {
      // discard：判决入链为失败养分；freeze：登记待审（裁决权属造物主，绝不自动固化）
      return { ok: true, value: null };
    }
    const trigger = `chain ${outcome.chainId} (${outcome.steps.length} steps, verdict=${outcome.verdict})`;
    const entry = this.memory.consolidate(
      this.idGen, trigger, outcome.chainId, outcome.steps.map(s => s.action),
      outcome.entrySceneFingerprint, // K 纪元：真实链指纹（同屏加成从此可命中）
    );
    // ΠΑΝ-41（崩溃安全落盘）：固化即刻持久化 —— 登记寿命不再依赖卸载钩子
    // （进程崩溃时卸载钩子不运行）。共享账本已由 configure 武装持久路径 ⇒
    // 此 save 真实落盘（此前引擎持私有库 + 共享库无人 configure，两侧 save
    // 均为静默 no-op）。save 永不抛：失败 warn 旁路（持久化是资产不是命脉）。
    this.memory.save();
    const reliability = muscleReliability(entry);
    void sandboxLog.append('consolidation', { entryId: entry.id, reliability, reinforced: entry.rehearsalPassCount });
    if (this.ctx) {
      emitMemoryConsolidated(this.ctx, {
        entryId: entry.id, trigger: entry.trigger,
        reliability, rehearsalPassCount: entry.rehearsalPassCount,
      });
    }
    return { ok: true, value: entry };
  }

  recallMuscleMemory(query: string): Result<import('./types').MuscleMemoryEntry[]> {
    const hits = this.memory.recall({
      text: query,
      currentSceneFingerprint: this.hostFingerprint ?? undefined,
    });
    void sandboxLog.append('recall', { query: query.slice(0, 120), hits: hits.length });
    return { ok: true, value: hits.map(h => h.entry) };
  }

  /**
   * 双闸门自动配对（index.ts 的 onDoctorVerdict 接线调用）：判决到达时与最近
   * 同链排练结果配对走 consolidate —— 排练 passed + 医生 approved ⇒ 固化入库。
   * 链无排练记录 / 判决先于排练到达 ⇒ no-op（诚实缺席，不伪造配对）。
   * 这是肌肉记忆写入路径的唯一自动化入口（此前 consolidate 无人调用，
   * recall/replay 工具因库恒空而永不命中）。
   */
  tryConsolidate(verdict: DoctorVerdictPayload): Result<import('./types').MuscleMemoryEntry | null> {
    const outcome = this.pendingOutcomes.get(verdict.subject);
    if (!outcome) return { ok: true, value: null };
    this.pendingOutcomes.delete(verdict.subject);
    return this.consolidate(outcome, verdict.verdict);
  }

  /** 肌肉记忆落盘（卸载时序：必须在 reset 之前调用 —— 否则内存态归零后无可存） */
  persistMemory(): boolean {
    return this.memory.save();
  }

  /**
   * 阶段零：铸造重放令牌（B-3 两阶段审批的入口；实现类公开面）。
   * validate 不消费（门禁检查可重复）；consume 用后即焚（replayOnHost 内部）。
   * 顺带清扫：过期未确认的令牌与超量滞留的旧令牌在铸造时驱逐（否则永久泄漏）。
   */
  requestReplayToken(entryId: string): string {
    const now = Date.now();
    for (const [t, tok] of this.replayTokens) {
      if (now > tok.expiresAt) this.replayTokens.delete(t);
    }
    while (this.replayTokens.size >= REPLAY_TOKENS_MAX) {
      const oldest = this.replayTokens.keys().next().value;
      if (oldest === undefined) break;
      this.replayTokens.delete(oldest);
    }
    // P1-2（地基速修）：重放令牌换 CSPRNG —— 对齐宿主 approval.newToken 的铸法与
    // 它对可预测伪随机数的批评（"可预测且 8 字符 base36 空间在高频下可碰撞"）。
    // 令牌门禁的是宿主物理重放（THE HOST IS SACRED 的第二道门），预测性随机数
    // 等于把门禁钥匙铸成了明文；8 字节熵（16 位 hex）与 APR- 同一强度口径。
    const token = 'SBX-' + randomBytes(8).toString('hex').toUpperCase();
    this.replayTokens.set(token, {
      token, entryId, expiresAt: now + REPLAY_TOKEN_TTL_MS,
    });
    return token;
  }

  /**
   * ΑΩ-R19：宿主执行器端口注入（结构注入）。运行层方法：形状非法不 throw ——
   * 静默视为未接线（注入一个不是可调用 executeAction 的对象 = 没接线，诚实降级）。
   */
  wireHostExecutor(executor: HostExecutor | null): void {
    this.hostExecutor = executor !== null
      && typeof (executor as HostExecutor | null)?.executeAction === 'function'
      ? executor
      : null;
  }

  /**
   * ΝΩ-1 第五门原语：步级安全扫描（纯扫描、永不抛、不派发）。
   * ΠΑΝ-42（覆盖面扩员）：扫描种类自「click/type 双臂」扩为 actionGate 的完整
   * 闭集宇宙（ACTION_KIND_UNIVERSE 单源 import：click_mouse/type_text/
   * press_hotkey/drag_mouse/scroll_page —— 与 F1 波 ActionKind 扩员对齐）。
   * 此前热键/拖拽步不在扫描面内：`[无害 type_text, press_hotkey alt+f4]` 链会
   * 先执行第一步、在热键步被 system 层黑名单抛错才停 = 部分执行已经发生，
   * 「危险步在链中段也绝不产生部分执行」的注释承诺不成立。其余种类
   * （switch_tab/switch_window/dismiss_popup/noop）不在审批/风险语义面内，
   * 与宿主重放同口径（switch_tab 的 ctrl+tab 和弦不在黑名单、无自述通道）。
   * 返回首犯步（index + kind + 拒因）；全过 ⇒ null。判定器崩溃 ⇒ 首犯步 +
   * 'gate-threw'（fail-closed：不可判定的步按危险处理，绝不放行）。
   */
  private scanStepsForSafety(
    steps: ReadonlyArray<SandboxAction>,
  ): { stepIndex: number; kind: string; reason: string } | null {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (!step || !GATE_SCANNED_KINDS.has(step.kind)) continue;
      try {
        // 类型收窄注记：同 stepIrreversible —— 运行时闭集成员（词表外 kind 上面已让渡）。
        // ΠΑΝ-42：黑名单 CSV 透传在场 ⇒ 扫描对黑名单和弦前置结构化拒绝。
        const d = assertActionAllowed(
          step.kind as ActionKind, step.args,
          this.cfg.hotkeyBlacklistCsv !== undefined
            ? { hotkeyBlacklist: this.cfg.hotkeyBlacklistCsv }
            : undefined,
        );
        if (!d.allowed) {
          return { stepIndex: i, kind: step.kind, reason: String(d.reason ?? 'unknown') };
        }
      } catch (e: any) {
        return { stepIndex: i, kind: step.kind, reason: `gate-threw:${e?.message ?? 'unknown'}` };
      }
    }
    return null;
  }

  async replayOnHost(entryId: string, opts: { confirmToken: string }): Promise<HostReplayOutcome> {
    const createdAt = Date.now();
    const gate = (reason: string): HostReplayOutcome => ({
      muscleMemoryId: entryId, verdict: 'failed', journalRefs: [], divergences: [],
      reliabilityAfter: 0, reportPath: this.persistReport(
        `replay-${entryId}-${createdAt}.json`, { gate: 'rejected', reason, createdAt }),
      createdAt,
    });

    // 门禁一：条目在场（THE HOST IS SACRED —— 未知记忆绝不放行）
    const entry = this.memory.get(entryId);
    if (!entry) {
      await sandboxLog.append('host-replay-gate', { entryId, gate: 'entry-missing' });
      return gate('entry not found');
    }
    // 门禁二：两阶段令牌（validate 语义：不消费可重查；过期/错绑即拒）。
    // 验证通过即刻消费（用后即焚）—— 消费推迟到全部门禁之后会留下双花窗口：
    // 并发的第二次调用在门禁三/四的 await 间隙同样通过验证
    const token = this.replayTokens.get(opts.confirmToken);
    if (!token || token.entryId !== entryId || Date.now() > token.expiresAt) {
      await sandboxLog.append('host-replay-gate', { entryId, gate: 'token-invalid' });
      return gate('invalid or expired confirm token');
    }
    this.replayTokens.delete(opts.confirmToken);
    // 门禁三：重放时刻医生复核（固化时的 approved 前提之上，最新否决即刻拦截）。
    // ΤΕΛ-13（D-G16 留案 M3）：复核源升级为「钉面优先，主缓存兜底」—— 主缓存
    // 256-FIFO 被普通流量挤出后，rejected 判决仍在钉面在场（旧病灶：latest===
    // undefined 即放行 —— 安全否决权以可失忆缓存为唯一事实源）。钉面语义 =
    // 该 subject 的最新判决是 rejected（换钉/解钉在 noteDoctorVerdict 执法），
    // 故钉面命中即拦截；未命中回主缓存既有语义（approved/needs_review 不拦）。
    const latest = this.pinnedVetoes.get(entry.chainId)
      ?? this.verdictCache.get(entry.chainId);
    if (latest && latest.verdict === 'rejected') {
      await sandboxLog.append('host-replay-gate', { entryId, gate: 'doctor-rejected' });
      return gate(`doctor rejected chain ${entry.chainId}: ${latest.rationale ?? 'no rationale'}`);
    }
    // 门禁四A：置信度达标（可靠度 = 宿主重放导出值；阈值缺省 = Laplace 中性先验）
    const minRel = this.cfg.hostReplayMinReliability ?? DEFAULT_MIN_RELIABILITY;
    const rel = muscleReliability(entry);
    if (rel < minRel) {
      await sandboxLog.append('host-replay-gate', { entryId, gate: 'reliability', rel, minRel });
      return gate(`reliability ${rel.toFixed(3)} below threshold ${minRel}`);
    }
    // 门禁四B：TRUST IS A FINGERPRINT —— 宿主最新观察与排练入口同屏方可放行
    // ΑΩ-R19：比对位宽鲁棒（等宽全量 / 不等宽前缀 + truncated 注记入链 ——
    // 拒绝理由可见降级证据，而非静默 0 黑箱）
    // ΠΑΝ-40e（指纹缺席分道语义）：旧语义「任一侧指纹缺席 ⇒ 恒拒」与 ΠΑΝ-40c
    // 之前的嗅探恒空叠加成死门（结构上永不放行）。新语义按可逆性分道：
    //   · 条目含不可逆步（审批域/凭据/黑名单 —— stepIrreversible）⇒ 指纹缺席
    //     仍拒（fail-closed：无同屏证据绝不放行不可逆宏 —— 指纹门的价值排序
    //     高于可用性）；
    //   · 全可逆步 ⇒ 降级放行并在链/report 标注 fingerprintLane=
    //     'degraded-reversible'（诚实降级 ≠ 假装验证过 —— 世界可被后续观察纠正）。
    // 两侧指纹均在场 ⇒ 既有相似度闸（≥ minSim）零回归。
    const minSim = this.cfg.entrySceneMinSimilarity ?? DEFAULT_SCENE_SIMILARITY;
    const entryFp: string = entry.entrySceneFingerprint ?? '';
    const hostFp: string = this.hostFingerprint ?? '';
    const cmp = entryFp.length > 0 && hostFp.length > 0 ? fpSimilarity(entryFp, hostFp) : null;
    /** ΠΑΝ-40e 降级车道注记（可逆宏指纹缺席放行时携带入 report；否则 undefined） */
    let fingerprintLane: string | undefined;
    if (cmp) {
      if (cmp.similarity < minSim) {
        await sandboxLog.append('host-replay-gate', {
          entryId, gate: 'fingerprint-mismatch',
          entryHasFp: entryFp.length > 0, hostObserved: hostFp.length > 0,
          similarity: Math.round(cmp.similarity * 1000) / 1000, minSim,
          ...(cmp.truncatedTo !== undefined
            ? { truncatedToBits: cmp.truncatedTo, entryBits: entryFp.length, hostBits: hostFp.length }
            : {}),
        });
        return gate('host state does not match rehearsal entry scene (stale rehearsal is a lie)');
      }
    } else {
      // 指纹证据缺席（入口指纹未铸 / 宿主观察未嗅探到）
      const hasIrreversible = entry.steps.some(s => stepIrreversible(s, this.cfg.hotkeyBlacklistCsv));
      if (hasIrreversible) {
        await sandboxLog.append('host-replay-gate', {
          entryId, gate: 'fingerprint-absent-irreversible',
          entryHasFp: entryFp.length > 0, hostObserved: hostFp.length > 0,
          note: 'fail-closed: fingerprint evidence absent for irreversible step(s)',
        });
        return gate('fingerprint evidence absent (entry scene not fingerprinted or host '
          + 'observation unavailable) — irreversible steps never replay without scene match (fail-closed)');
      }
      fingerprintLane = 'degraded-reversible';
      await sandboxLog.append('host-replay-gate', {
        entryId, gate: 'fingerprint-degraded-reversible',
        entryHasFp: entryFp.length > 0, hostObserved: hostFp.length > 0,
        note: 'honest degradation: all steps reversible; replay allowed without scene fingerprint',
      });
    }

    // 门禁五（ΝΩ-1 步级安全扫描门）：重放不豁免安全闸 —— entry.steps 逐条过
    // assertActionAllowed（与宿主 replayOneTraced 同一事实源：危险词 ⇒ 需宿主侧
    // 已授予的 approval 令牌，步参数经 args.approval_token 携带；无令牌/未描述/
    // 敏感输入等拒绝并归因到首犯步）。扫描先于任何派发 —— 危险步在链中段也绝不
    // 产生部分执行。判定器自身异常 ⇒ 按危险处理拒绝（fail-closed，运行层铁律：
    // 收敛为拒绝理由，绝不抛）。四门既有语义不变（本门只在其全过之后新增）。
    const safety = this.scanStepsForSafety(entry.steps);
    if (safety !== null) {
      await sandboxLog.append('host-replay-gate', {
        entryId, gate: 'safety-scan',
        stepIndex: safety.stepIndex, kind: safety.kind, reason: safety.reason,
      });
      return gate(
        `[${SAFETY_GATE_BLOCK}] step ${safety.stepIndex} (${safety.kind}) blocked by safety gate: ` +
        `${safety.reason} — replayed muscle-memory steps pass through the SAME approval/risk gates ` +
        'as live tool calls; carry a granted approval_token in step args for dangerous targets',
      );
    }

    // （令牌已在门禁二验证通过时即刻消费 —— 用后即焚，无双花窗口）

    // ΑΩ-R19：四门全过后的岔口 —— 执行器缺席 ⇒ 既有诚实 failed（对齐现世
    // orchestrator Actor 未接线先例：诚实失败优于虚假成功），逐字节零回归。
    if (!this.hostExecutor) {
      return this.settleHostReplay(entryId, createdAt, 'failed', [{
        stepIndex: -1,
        kind: 'effect-missing',
        sandboxSaid: `authorized (${entry.steps.length} steps, reliability ${rel.toFixed(3)})`,
        hostDid: 'no host executor wired (developer preview)',
      }], muscleReliability(entry), {
        gate: 'passed', executor: 'not-wired', entryId, createdAt,
        ...(fingerprintLane !== undefined ? { fingerprintLane } : {}),
      });
    }

    // 执行器在场 ⇒ 真派发：逐步执行（首败即停 —— 部分执行是事实，后续步绝不
    // 盲跑）；结局如实入 divergence 与可靠度计数（宿主重放计数是唯一可信源，
    // 成功与否都记 —— 失败也是校准）。
    const divergences: HostReplayDivergence[] = [];
    let executed = 0;
    let dispatchFailed = false;
    for (let i = 0; i < entry.steps.length; i++) {
      const step = entry.steps[i];
      let r: HostExecutorStepResult;
      try {
        r = await this.hostExecutor.executeAction(step);
      } catch (e: any) {
        // 端口契约本就永不抛 —— 双保险：执行器实现违约也不击穿数据流
        r = { ok: false, note: `executor threw: ${e?.message ?? 'unknown'}` };
      }
      if (!r || r.ok !== true) {
        divergences.push({
          stepIndex: i,
          kind: 'effect-missing',
          sandboxSaid: `step ${i} (${step.kind}) should land on the host`,
          hostDid: r && typeof r.note === 'string' && r.note ? r.note : 'unattributed step failure',
        });
        dispatchFailed = true;
        break;
      }
      executed++;
    }
    // ── ΠΑΝ-42（效果验证门）：派发完成 ≠ 世界承接。可靠度回写从「派发完成」
    // 升级为「效果验证」—— 全部步派发成功后，经执行器的可选链级验证端口
    // （装配层适配 actionVerifier 的终帧 dHash 路径：before 取自首物理步前、
    // settleAndVerify 产双尺度效果判决）复核世界确有变化。诚实分层：
    //   · verified=true ⇒ confirmed（效果与派发双证）；
    //   · verified=false ⇒ 'diverged' + effect-missing divergence（打偏/遮挡/
    //     输入落空不再虚增 hostSuccessCount —— 门 4A 从此度量任务可靠度）；
    //   · null（端口缺席/取证失败/全非物理链）⇒ 派发基线 confirmed，report
    //     如实标注 reliabilityBasis='dispatch'（诚实降级，绝不虚报已验证）。
    // 端口调用永不抛：实现违约收敛为缺席（双保险层，端口契约同律）。
    let effectBasis: 'effect-verified' | 'dispatch' = 'dispatch';
    if (!dispatchFailed && typeof this.hostExecutor.verifyChainEffect === 'function') {
      let verdict: HostChainEffectVerdict | null = null;
      try {
        verdict = await this.hostExecutor.verifyChainEffect({ steps: entry.steps });
      } catch {
        verdict = null; // 验证面故障 = 缺席（诚实降级，不虚报也不误杀）
      }
      if (verdict === null) {
        effectBasis = 'dispatch';
      } else if (verdict.verified === true) {
        effectBasis = 'effect-verified';
      } else {
        effectBasis = 'dispatch';
        divergences.push({
          stepIndex: Math.max(0, executed - 1),
          kind: 'effect-missing',
          sandboxSaid: `dispatched ${executed}/${entry.steps.length} step(s) — the world should reflect the chain`,
          hostDid: typeof verdict.note === 'string' && verdict.note
            ? verdict.note : 'effect verifier refuted the world impact (no screen change observed)',
        });
      }
    }
    const replayOk = divergences.length === 0;
    const updatedEntry = this.memory.recordHostReplay(entryId, replayOk);
    const finalVerdict: HostReplayOutcome['verdict'] = replayOk
      ? 'confirmed'
      : dispatchFailed ? 'failed' : 'diverged';
    return this.settleHostReplay(
      entryId, createdAt, finalVerdict, divergences,
      muscleReliability(updatedEntry ?? entry),
      {
        gate: 'passed', executor: 'wired', entryId, executed, steps: entry.steps.length,
        effectBasis, divergences, createdAt,
        ...(fingerprintLane !== undefined ? { fingerprintLane } : {}),
        // journalRefs 诚实空注记：宿主动作面不回 journal 哈希 —— 伪造引用即伪造
        // 因果链成员籍，宁可空且如实说明。ΝΩ-1：每次派发已在装配层适配器内经
        // journal.appendMarker 提交 SANDBOX_HOST_REPLAY 存证行（三态脱敏）——
        // 链上轨迹在宿主账本侧，引用哈希仍不可得（appendMarker 无回执）。
        journalRefs: 'host action surface exposes no journal hashes (honest empty; '
          + 'per-dispatch SANDBOX_HOST_REPLAY markers submitted via appendMarker)',
      },
    );
  }

  /** 重放收尾：战报铸造 + 落盘 + 入链 + 事件（not-wired 与真派发共用 ——
   *  两路的观测面形状逐字节同构）。运行层方法：永不抛 */
  private async settleHostReplay(
    entryId: string,
    createdAt: number,
    verdict: HostReplayOutcome['verdict'],
    divergences: HostReplayDivergence[],
    reliabilityAfter: number,
    reportData: Record<string, unknown>,
  ): Promise<HostReplayOutcome> {
    const outcome: HostReplayOutcome = {
      muscleMemoryId: entryId,
      verdict,
      journalRefs: [],
      divergences,
      reliabilityAfter,
      reportPath: this.persistReport(`replay-${entryId}-${createdAt}.json`, reportData),
      createdAt,
    };
    await sandboxLog.append('host-replay-end', {
      entryId, verdict: outcome.verdict, divergences: divergences.length,
    });
    if (this.ctx) {
      emitHostReplayEnd(this.ctx, {
        muscleMemoryId: entryId, verdict: outcome.verdict,
        divergenceCount: divergences.length,
        reportPath: outcome.reportPath, endedAt: createdAt,
      });
    }
    return outcome;
  }

  verifyLog(): Result<{ ok: boolean; length: number; brokenAt: number | null }> {
    return { ok: true, value: sandboxLog.verify() };
  }

  reset(): void {
    // 持久化资产已在 ctx.effect 清理函数先行落盘（对齐主插件卸载时序）。
    // ΠΑΝ-41：归零的是共享账本的内存态（与 MacroRehearsalGate.reset 同律 ——
    // 落盘资产由卸载时序/固化即存先行持久化，configure+load 下一会话恢复）。
    this.memory.reset();
    this.replayTokens.clear();
    this.verdictCache.clear();
    this.pinnedVetoes.clear(); // ΤΕΛ-13（M3）：钉面随引擎归零（进程内生命周期语义）
    this.pendingOutcomes.clear();
    this.hostFingerprint = null;
    sandboxLog.reset();
  }
}

// ── Χ 纪元（沙箱重放证词）：确定性重放面 —— 纯增量模块级导出，主路径零触碰 ──
// Π 公证了「行为史未被篡改」；Χ 公证「行为史可复现」：对确定性沙箱段（排练链），
// 同动作链重入虚拟屏，屏状态指纹序列与链上权威记录逐位一致 ⇒ 复现性成立。
// 这是 agent 行为的重放性证明；真机段保持诚实 n/a（世界不可复现 —— notary 侧裁决）。

/** 屏指纹探针网格密度（每轴 8 格）。指纹 = 公开观测面的确定性采样摘要：
 *  widgetAt（命中测试 —— 控件树拓扑/几何/弹窗消亡）× sceneOcr（重叠网格，
 *  半径 1/8 ⇒ 区域并集覆盖全屏，任意正宽度控件的缓冲文本必被读到）。
 *  virtualScreen 的内部态（焦点指针/滚动偏移）私有 —— 探测面即契约观测面：
 *  指纹是世界的校验和而非全态快照，但它是世界的**确定**函数 —— 记录路径与
 *  重放路径共用本函数，逐位可比性由此成立。 */
const FP_GRID = 8;
const FP_HEADER = 'dsh-chi-screenstate-v1';

/** 虚拟屏状态指纹：sha256(探针序列的稳定序列化)。永不抛；无世界（排练无场景）
 *  ⇒ null（诚实缺席 —— 与「世界为空」的合法态区分：空世界也摘要）。 */
function screenStateFingerprint(screen: VirtualScreen | null): string | null {
  if (!screen) return null;
  const probes: string[] = [];
  for (let gy = 0; gy < FP_GRID; gy++) {
    for (let gx = 0; gx < FP_GRID; gx++) {
      const x = (gx + 0.5) / FP_GRID;
      const y = (gy + 0.5) / FP_GRID;
      const hit = screen.widgetAt(x, y);
      probes.push(JSON.stringify([
        hit ? hit.role : null,
        hit ? hit.name : null,
        hit ? [hit.rect.x, hit.rect.y, hit.rect.width, hit.rect.height] : null,
        screen.sceneOcr(x, y, 1 / FP_GRID),
      ]));
    }
  }
  return createHash('sha256').update(FP_HEADER + '\n' + probes.join('\n'), 'utf8').digest('hex');
}

/** 确定性重放注入面（全注入 —— 确定性测试） */
export interface DeterministicReplayOptions {
  /** 重演的虚拟场景（rehearsal-begin 链上记录的取证场景；经 VirtualScreen 同一
   *  构造路径防御性铸造 —— asVirtualWidget 规范形上再铸是幂等的，世界形状一致） */
  scene?: unknown;
  /** 注入时钟（缺省 Date.now；只盖重演簿记时间戳 —— 不进指纹域） */
  now?: () => number;
  /** 注入随机源（缺省缺席）。诚实声明：虚拟屏世界零熵 —— 本重放零消费（确定性
   *  是本纪元的立命之本，任何熵消费都是重放性的破坏）；注入面在场供接口完备。 */
  rng?: () => number;
}

/** 确定性重放结果：指纹序列 + 重演裁决 */
export interface DeterministicReplayResult {
  /** 每步后的屏状态指纹（与 rehearse 落链的 screenFingerprint 出自同一函数 —— 逐位可比） */
  fingerprints: string[];
  /** 重演裁决（与 rehearse 同律：反证 ⇒ failed；零生效层 ⇒ degraded；否则 passed） */
  verdict: 'passed' | 'failed' | 'degraded';
  /** 生效验证层（典范序铸造 —— 与 RehearsalOutcome.verificationLayers 同方言） */
  layers: VerificationLayer[];
  /** 重演簿记时间戳（注入时钟源；不在指纹域内） */
  replayedAt: number;
  note: string;
}

/**
 * 确定性重放（Χ 纪元执法原语）：重入虚拟屏执行动作链，逐步产出屏状态指纹序列。
 * 纯函数语义：不落账本、不写报告、不发事件、永不抛 —— 与 rehearse 主路径完全
 * 隔离（rehearse 照旧记账，replay 只重演）。无场景 ⇒ 零证词诚实降级（degraded +
 * 空 fingerprint 序列），绝不伪造空世界的指纹。
 */
export function deterministicReplay(
  actions: ReadonlyArray<SandboxAction>,
  opts: DeterministicReplayOptions = {},
): DeterministicReplayResult {
  const now = opts.now ?? Date.now;
  void opts.rng; // 世界零熵：注入面在场但零消费（见接口注释）
  const screen = new VirtualScreen(opts.scene);
  if (screen.isEmpty) {
    return {
      fingerprints: [], verdict: 'degraded', layers: [], replayedAt: now(),
      note: 'no virtual scene — replay has no world to re-enter (honest absence, not a failure)',
    };
  }
  const layers = new Set<VerificationLayer>();
  let counterEvidence = false;
  const fingerprints: string[] = [];
  for (const action of actions) {
    if (!action || typeof action.kind !== 'string') {
      // 畸形动作（伪造账本可注入任意 JSON —— 类型层拦不住运行时谎言）：无状态
      // 转移可应用 ⇒ 世界不变，照常摘要 —— 诚实缺席而非抛错（运行层铁律）
      fingerprints.push(screenStateFingerprint(screen)!);
      continue;
    }
    const evidence = screen.applyAction(action);
    for (const l of evidence.layers) layers.add(l);
    if (evidence.effectDetected === false || evidence.expectationMet === false) counterEvidence = true;
    fingerprints.push(screenStateFingerprint(screen)!); // 世界非空 ⇒ 摘要恒非 null
  }
  return {
    fingerprints,
    verdict: counterEvidence ? 'failed' : layers.size === 0 ? 'degraded' : 'passed',
    layers: LAYER_ORDER.filter(l => layers.has(l)),
    replayedAt: now(),
    note: `re-entered the virtual screen over ${actions.length} action(s) — `
      + `${fingerprints.length} post-step screen fingerprint(s) minted (zero entropy consumed)`,
  };
}
