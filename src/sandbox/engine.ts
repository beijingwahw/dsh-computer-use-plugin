// src/sandbox/engine.ts
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
} from './events';
import { MuscleMemoryStore } from './memory';
import { VirtualScreen, asVirtualWidget } from './virtualScreen';
import { sandboxLog, REHEARSAL_FP_FORMAT } from './log';
import {
  createDefaultIdGenerator, muscleReliability, resolveConsolidation,
  type ActionChain, type HostReplayOutcome, type IdGenerator,
  type RehearsalOutcome, type RehearsalStepResult, type RehearsalVerdict,
  type Result, type SandboxAction, type SandboxConfig, type SandboxEngine,
  type SandboxSnapshot, type VerificationLayer, type VirtualWidget,
} from './types';

/** Laplace 中性先验 = (0+1)/(0+2) —— 数学中性值，非部署调优魔法数字 */
const DEFAULT_MIN_RELIABILITY = 0.5;
/** 场景同屏门限（对齐 skillLibrary.match 场景加成门限 0.9 —— 算法结构常量） */
const DEFAULT_SCENE_SIMILARITY = 0.9;
/** 重放令牌 TTL（对齐宿主 approval 的 120s 方言） */
const REPLAY_TOKEN_TTL_MS = 120_000;
/** 判决缓存容量上限（无界 Map = 缓慢泄漏 —— 对齐 orchestration/index boundedSet 先例） */
const VERDICT_CACHE_MAX = 256;
/** 重放令牌容量上限（铸造时驱逐最旧未决令牌 —— 过期未确认的令牌不许无界滞留） */
const REPLAY_TOKENS_MAX = 64;
/** 待配对排练结果容量（chainId → 最近 outcome；医生判决迟到时的配对面） */
const PENDING_OUTCOMES_MAX = 32;

/** 64 位指纹相似度（perceptualHash.similarity/hammingDistance 同构式本地复刻：
 *  D-5 只需纯字符串距离，不拖入 sharp 图像二进制运行时依赖） */
function fpSimilarity(a: string, b: string): number {
  if (a.length !== b.length) return 0;
  let dist = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) dist++;
  return 1 - dist / 64;
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
  private readonly memory = new MuscleMemoryStore();
  /** 宿主观察缓存（TRUST IS A FINGERPRINT 的镜像源头；嗅探缺席 = null = 保守拒绝） */
  private hostFingerprint: string | null = null;
  /** D-4 判决缓存（subject=chainId → 最新回执；重放时刻的复核源） */
  private verdictCache = new Map<string, DoctorVerdictPayload>();
  private replayTokens = new Map<string, ReplayToken>();
  /** 最近排练结果（chainId → outcome，容量执法 FIFO —— 判决迟到时的配对面） */
  private pendingOutcomes = new Map<string, import('./types').RehearsalOutcome>();
  private readonly ctx: Context | null;

  // 显式字段赋值（非参数属性）：Node strip-only 运行时契约 —— 现世源码同方言
  constructor(ctx: Context | null) {
    this.ctx = ctx;
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
    if (errors.length > 0) {
      throw new Error(`[SandboxEngine] invalid configuration:\n  - ${errors.join('\n  - ')}`);
    }
    this.cfg = { ...config };
    this.idGen = config.idGenerator ?? createDefaultIdGenerator();
    this.memory.configure(config.memoryPath ?? '');
    this.memory.load();
  }

  /** 宿主观察登记（index.ts 的 onHostToolPost 嗅探后喂数据；实现类公开面） */
  noteHostObservation(fingerprint: string | null): void {
    if (fingerprint === null) {
      this.hostFingerprint = null;
      return;
    }
    if (/^[01]{64}$/.test(fingerprint)) {
      this.hostFingerprint = fingerprint;
    }
  }

  /** D-4 判决登记（onDoctorVerdict 接线后喂数据；双闸门与重放复核的缓存源）。
   *  容量执法：超上限 FIFO 驱逐最旧条目（Map 迭代序 = 插入序） */
  noteDoctorVerdict(p: DoctorVerdictPayload): void {
    this.verdictCache.delete(p.subject); // 重置插入位：更新即最新
    this.verdictCache.set(p.subject, p);
    while (this.verdictCache.size > VERDICT_CACHE_MAX) {
      const oldest = this.verdictCache.keys().next().value;
      if (oldest === undefined) break;
      this.verdictCache.delete(oldest);
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
      entrySceneFingerprint: chain.entrySceneFingerprint,
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
    // 门禁三：重放时刻医生复核（固化时的 approved 前提之上，最新否决即刻拦截）
    const latest = this.verdictCache.get(entry.chainId);
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
    const minSim = this.cfg.entrySceneMinSimilarity ?? DEFAULT_SCENE_SIMILARITY;
    if (!entry.entrySceneFingerprint || !this.hostFingerprint ||
        fpSimilarity(entry.entrySceneFingerprint, this.hostFingerprint) < minSim) {
      await sandboxLog.append('host-replay-gate', {
        entryId, gate: 'fingerprint-mismatch',
        entryHasFp: !!entry.entrySceneFingerprint, hostObserved: !!this.hostFingerprint,
      });
      return gate('host state does not match rehearsal entry scene (stale rehearsal is a lie)');
    }

    // （令牌已在门禁二验证通过时即刻消费 —— 用后即焚，无双花窗口）

    // 宿主执行器未接线（开发者预览）⇒ 诚实 failed（对齐现世 orchestrator Actor 未接线先例：
    // 诚实失败优于虚假成功）。未来纪元：此处经宿主管线逐动作执行并收集 journalRefs。
    const outcome: HostReplayOutcome = {
      muscleMemoryId: entryId,
      verdict: 'failed',
      journalRefs: [],
      divergences: [{
        stepIndex: -1,
        kind: 'effect-missing',
        sandboxSaid: `authorized (${entry.steps.length} steps, reliability ${rel.toFixed(3)})`,
        hostDid: 'no host executor wired (developer preview)',
      }],
      reliabilityAfter: muscleReliability(entry),
      reportPath: this.persistReport(`replay-${entryId}-${createdAt}.json`, {
        gate: 'passed', executor: 'not-wired', entryId, createdAt,
      }),
      createdAt,
    };
    await sandboxLog.append('host-replay-end', {
      entryId, verdict: outcome.verdict, divergences: outcome.divergences.length,
    });
    if (this.ctx) {
      emitHostReplayEnd(this.ctx, {
        muscleMemoryId: entryId, verdict: outcome.verdict,
        divergenceCount: outcome.divergences.length,
        reportPath: outcome.reportPath, endedAt: createdAt,
      });
    }
    return outcome;
  }

  verifyLog(): Result<{ ok: boolean; length: number; brokenAt: number | null }> {
    return { ok: true, value: sandboxLog.verify() };
  }

  reset(): void {
    // 持久化资产已在 ctx.effect 清理函数先行落盘（对齐主插件卸载时序）
    this.memory.reset();
    this.replayTokens.clear();
    this.verdictCache.clear();
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
