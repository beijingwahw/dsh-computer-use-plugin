// src/orchestration/pipeline.ts
// D-6 流水线编排器 —— PipelineOrchestrator 实现（契约见 contracts.ts §9）。
// 四大主权（全部收口于本文件）：
//   1. 信封铸造权：三工位信封的唯一构造者（注意力隔离的物理执法点）
//   2. region.id 铸造权：网格分区 'g{col}x{row}' / 自定义分区 'c{n}'（contracts 身份方案）
//   3. 失败路由：cancelled 不入重试（路由铁律）；七态 verdict 每态独立终止路径
//   4. 时间治理：attempt（杀一刀）/ perception（产 fault 补丁）/ intent（杀流水线）三层
//      ΝΩ-8：attempt 层从被动 race 升级为止损 abort —— ExecutionOrder.signal
//      随指令单下发，超时/外部取消沿执行链断流，消灭「超时后幽灵动作落地」
// 与器官咬合（事件总线，零直接调用）：
//   D-5 沙箱 —— 执行工位经 SandboxStationView 预演；账本复用 sandboxLog（独立 D-6 链段）
//   D-4 医生 —— 发射 sandbox/rehearsal-end 等价事件后订阅 doctor/verdict 回执（AttemptRecord）
//   D-1 认知 —— intents 由 index.ts 经事件/服务注入（本文件只认 IntentPayload 契约）
// 异常诚实分层契约（D-7 修正案对齐 / P0-1）：configure = 运行层可重配方法（Result 降级，
//   严禁 throw）；wire = 加载层（throw 合法，由 apply 收口）；run = 永不抛错。
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { ActionChain } from '../sandbox/types';
import type {
  AtomicAction, ConfigError, DecisionContext, DecisionOutput, ExecutionOrder, ExecutionResult,
  FailureFeedback, IntentPayload, PipelineConfig, PipelineOrchestrator, PipelineReport,
  PipelineVerdict, RegionSpec, Result, ScenePatch, AttemptRecord, AttentionEnvelope,
  PerceptionRequest, DecisionStation, ExecutionStation, VisionStation,
} from './contracts';
import { sandboxLog } from '../sandbox/log';
import { createDefaultIdGenerator, type IdGenerator } from '../sandbox/types';

// W6-2（doctor smell.over-engineering 清偿）：事件常量/工位接口/网格铸造/超时包裹/
// 沙箱链入账/grounding 预算已分区提取至 pipeline.helpers.ts（行为零变化）；导入面不变。
// ΝΩ-26（编排调度四修）：帧复用窗口 / 分区内容指纹（dhash）/ 消耗探针读数
// 同源于 helpers —— 脏区跳过与 tokenBudget 扣减制的共用面。
import {
  EVT_PIPELINE_RUN_END, EVT_PIPELINE_ATTEMPT, EVT_PIPELINE_GROUNDING, MAX_GROUNDING_APPROVALS_PER_RUN,
  gridRegions, withAttemptTimeout, logPipeline,
  SCENE_REUSE_TTL_MS, sceneDhash, readUsageProbe,
  FUNNEL_RANK, L3_EVIDENCE_TTL_MS,
} from './pipeline.helpers';
import type { PipelineStations } from './pipeline.helpers';
export type { PipelineStations } from './pipeline.helpers';

// ─── ΠΑΝ-118（F2-3 移交项②）：planner chain 臂 → 流水线决策语境 ───
//
// 病灶（F2-3 报告第七节 2 + C2-3 H2-1 的消费侧残余）：planner 自 ΠΑΝ-40a 起可
// 铸 chain 臂（mintChainPlanReady → cognition/plan-ready 事件，D-5 沙箱只认
// chain 臂排练），但 D-6 流水线侧没有任何接收面 —— plan-ready 的 chain 方言到
// 达 D-6 的 normalizeIntent 时被折叠成一句 prose goal（「execute N-step action
// chain (click→type→…)」），决策工位拿到的是规划结论的**摘要**而非规划本身，
// 只能靠 LLM 从 prose 重新规划，planner 已铸的链（含逐步 expect 校验锚）在
// 决策语境里不可见。
//
// 修法（本文件单点接线）：run() 增可选 planReadyChain（实现层签名扩展 ——
// 契约接口 PipelineOrchestrator.run 的 opts 形状不变，方法双变兼容），防御
// 解码后经 DecisionContext 的开放扩展（契约层基形不变、字段纯增量）注入
// 决策语境。调用方接线（orchestration/index.ts 的事件臂把 normalizeIntent
// 保留的链传入 run）归 D-6 入口文件领地 —— 本接线先把消费面立起来并钉死
// 执法测试；缺席 ⇒ 决策语境与接线前逐字节同形（零回归律）。

/** ΠΑΝ-118：DecisionContext 的开放扩展 —— plan-ready chain 臂的决策语境入口。
 *  契约层 DecisionContext 基形分毫不动（contracts 属主权文件）；本扩展是纯
 *  增量可选字段，任何只认基形的决策工位照常工作（结构子类型）。 */
export interface PlanReadyDecisionContext extends DecisionContext {
  /** D-1 planner 铸就的动作链（cognition/plan-ready 的 CognitionChainPayload.chain
   *  方言 —— mintChainPlanReady 的产物）。在场 ⇒ 决策工位可直接消费规划器的
   *  链（逐步派发 + expect 锚），而不是从 prose goal 重新规划。 */
  planReadyChain?: ActionChain;
}

/**
 * ΠΑΝ-118：plan-ready chain 臂的防御解码（纯函数、绝不抛、毒链不入场）。
 * 形状闸（与 planner.mintChainPlanReady 的毒证拦截同向）：id 非空字符串 +
 * actions 非空数组 + 每步 kind 为非空字符串（SandboxActionKind 词表执法在
 * 派发层 actionGate —— 此处只挡「不是链」的垃圾）。垃圾 ⇒ undefined（诚实
 * 缺席，绝不半截接线）。两路入口同过此闸：opts.planReadyChain（显式）与
 * intent 运行时随行的 chain 字段（事件载荷直挂方言 —— opts 优先）。
 */
export function decodePlanReadyChain(raw: unknown): ActionChain | undefined {
  try {
    if (!raw || typeof raw !== 'object') return undefined;
    const chain = raw as Partial<ActionChain> & { actions?: unknown };
    if (typeof chain.id !== 'string' || chain.id === '') return undefined;
    if (!Array.isArray(chain.actions) || chain.actions.length === 0) return undefined;
    const kindsOk = chain.actions.every(
      a => !!a && typeof a === 'object' && typeof (a as { kind?: unknown }).kind === 'string' &&
        (a as { kind: string }).kind !== '',
    );
    return kindsOk ? (chain as ActionChain) : undefined;
  } catch {
    return undefined; // 陷阱属性等：毒链不入场（防御式，绝不抛）
  }
}



export class PipelineOrchestratorImpl implements PipelineOrchestrator {
  private cfg: PipelineConfig | null = null;
  private idGen: IdGenerator = createDefaultIdGenerator();
  private stations: PipelineStations | null = null;
  private reportDir = '';
  private reportCounter = 0; // 报告文件名防碰撞序号（同 intent 同毫秒不互相覆盖）
  /** ΝΩ-26（四修之四）：终局回收钩子（index.ts 注入 reconcileVerdicts）——
   *  在 persistReport 之前对内存报告做 D-4 判决回收，报告一次成稿（盘上/内存
   *  同一副面孔）。缺席 = 无回收面（直连测试的旧路径）。 */
  private reconcileReport: ((report: PipelineReport) => void) | null = null;

  /**
   * 运行层可重配方法（P0-1：《异常诚实分层契约》D-7 修正案对齐）—— Result 降级，严禁 throw。
   * 域外拒绝（对齐 makeScore 哲学），首个违约 field 精确定位；
   * 加载门（Result !ok ⇒ throw）收口于插件入口 apply。
   */
  configure(config: PipelineConfig): Result<void, ConfigError> {
    if (!config || typeof config !== 'object') {
      return { ok: false, error: { field: 'config', reason: 'config must be an object' } };
    }
    const errors: ConfigError[] = [];
    if (!Number.isInteger(config.maxDecisionRetries) || config.maxDecisionRetries < 0) {
      errors.push({ field: 'maxDecisionRetries', reason: `must be a non-negative integer, got ${config.maxDecisionRetries}` });
    }
    if (!config.regionGrid || !Number.isInteger(config.regionGrid.cols) || config.regionGrid.cols < 1 ||
        !Number.isInteger(config.regionGrid.rows) || config.regionGrid.rows < 1) {
      errors.push({ field: 'regionGrid', reason: `cols/rows must be integers >= 1, got ${JSON.stringify(config.regionGrid)}` });
    }
    const b = config.stationTokenBudgets;
    if (!b || !Number.isFinite(b.vision) || b.vision < 0 || !Number.isFinite(b.decision) || b.decision < 0 ||
        !Number.isFinite(b.execution) || b.execution !== 0) {
      errors.push({ field: 'stationTokenBudgets', reason: `vision/decision must be >= 0 and execution must be exactly 0 (zero-model muscle), got ${JSON.stringify(b)}` });
    }
    if (!Number.isFinite(config.attemptTimeoutMs) || config.attemptTimeoutMs <= 0) {
      errors.push({ field: 'attemptTimeoutMs', reason: `must be a positive finite number, got ${config.attemptTimeoutMs}` });
    }
    if (!Number.isFinite(config.perceptionDeadlineMs) || config.perceptionDeadlineMs <= 0) {
      errors.push({ field: 'perceptionDeadlineMs', reason: `must be a positive finite number, got ${config.perceptionDeadlineMs}` });
    }
    if (typeof config.consumePlanReady !== 'boolean') {
      errors.push({ field: 'consumePlanReady', reason: `must be a boolean (P1-3 arbitration switch), got ${JSON.stringify(config.consumePlanReady)}` });
    }
    if (errors.length > 0) {
      return { ok: false, error: errors[0] }; // 首错即返 —— field 精确定位
    }
    // J 纪元修正：嵌套对象（regionGrid / stationTokenBudgets）深拷贝 ——
    // 旧实现浅拷贝共享引用，外部在 configure 后突变配置对象会穿透进编排器。
    this.cfg = {
      ...config,
      regionGrid: { ...config.regionGrid! },
      stationTokenBudgets: { ...config.stationTokenBudgets! },
    };
    return { ok: true, value: undefined };
  }

  /** 工位注入（index.ts 接线；构造器加载层方言 —— 站点缺席即拒绝出生） */
  wire(
    stations: PipelineStations,
    opts?: { idGenerator?: IdGenerator; reportDir?: string; reconcileReport?: (report: PipelineReport) => void },
  ): void {
    if (!this.cfg) throw new Error('[PipelineOrchestrator] configure() must precede wire()');
    if (!stations.vision || !stations.decision || !stations.execution) {
      throw new Error('[PipelineOrchestrator] all three stations are required');
    }
    this.stations = stations;
    if (opts?.idGenerator) this.idGen = opts.idGenerator;
    this.reportDir = opts?.reportDir ?? '';
    this.reconcileReport = opts?.reconcileReport ?? null;
  }

  /** 运行层入口（契约第二条：永不抛错）。try 包裹整环 —— 任何意外 = verdict='failed' 落盘。
   *  ΠΑΝ-118（F2-3 移交项②）：opts.planReadyChain = planner 的 chain 臂载荷
   *  （cognition/plan-ready 的 chain 方言）—— 在场且过 decodePlanReadyChain 形状闸
   *  ⇒ 注入决策语境（决策工位可直接消费规划器的链）；缺席/毒链 ⇒ 决策语境与
   *  接线前逐字节同形（零回归）。契约接口的 opts 形状不变（实现层可选扩展，
   *  方法双变兼容）。 */
  async run(
    intent: IntentPayload,
    opts?: { snapshotId?: string; signal?: AbortSignal; planReadyChain?: ActionChain },
  ): Promise<PipelineReport> {
    const startedAt = Date.now();
    if (!this.cfg || !this.stations) {
      return this.finalReport(intent, 'failed', 'orchestrator not configured/wired', [], startedAt);
    }
    // ΝΩ-8：run 级外部终止信号（造物主取消/宿主关停）—— 防御性收窄
    // （garbage 输入按缺席处理，同 httpClient microFetch 的 instanceof 方言）
    const runSignal = opts?.signal instanceof AbortSignal ? opts.signal : undefined;
    const cfg = this.cfg;
    const stations = this.stations;
    const attempts: AttemptRecord[] = [];
    const tokenUsage = { vision: 0, decision: 0, execution: 0 };

    // ΠΑΝ-118：plan-ready chain 臂解码（run 级一次性）—— opts 显式载荷优先，
    // intent 运行时随行的 chain 字段（事件载荷直挂方言）次之；两路同过形状闸。
    // 在场 ⇒ 宿主事件面广播消费留痕（sandboxLog 的 pipeline-* 段是封闭联合且
    // log.ts 非本工单领地 —— 入账面留待该件扩 kind；事件总线面先立，宿主可
    // 订阅审计）+ 决策语境携带（下方 DecisionContext 构造处）。
    const planReadyChain = decodePlanReadyChain(opts?.planReadyChain) ??
      decodePlanReadyChain((intent as unknown as { chain?: unknown }).chain);
    if (planReadyChain !== undefined) {
      stations.emit?.('pipeline/plan-ready-chain', {
        intentRef: intent.id, chainId: planReadyChain.id, steps: planReadyChain.actions.length,
      });
    }

    // ── ΝΩ-26（四修之一）：L1 帧缓存的管线侧孪生 —— 脏区跳过账本 ──
    // sceneCache：上轮 fault-free 分区补丁（复用候选；capturedAt 即陈旧度申报）。
    // dirtyRegions：疑脏分区集（我们动过世界的落区 / 反馈指认的过时区 / L3 批准区）
    // —— 只有因果上有理由怀疑的分区才重扫，其余在复用窗口内免扫。
    const sceneCache = new Map<string, ScenePatch>();
    const dirtyRegions = new Set<string>();

    // ── ΝΩ-26（四修之三）：tokenBudget 扣减制 ──
    // 余额 = 配置预算 − 工位自报消耗（usageMeter 探针是累计读数 ⇒ 每 run 快照
    // 基线取差值；探针缺席 ⇒ 消耗 0 ⇒ 余额 = 配置预算 —— 未计量不猜测，旧路径
    // 逐字节保持）。余额不足 ⇒ 强制降级：vision 降 L2（L3 花钱权冻结）、
    // decision 入 need-grounding（不再调用工位烧无计量 token）。
    const meter = stations.usageMeter;
    const meterBase = {
      vision: readUsageProbe(meter?.vision),
      decision: readUsageProbe(meter?.decision),
      execution: readUsageProbe(meter?.execution),
    };
    const remainingTokens = (st: 'vision' | 'decision'): number =>
      Math.max(0, cfg.stationTokenBudgets[st] - Math.max(0, readUsageProbe(meter?.[st]) - meterBase[st]));

    try {
      let scene: ScenePatch[] = [];
      let retryCount = 0;
      let seq = 0;
      let feedback: FailureFeedback | undefined;
      let verdict: PipelineVerdict | null = null;
      let groundingApprovals = 0; // L3 花钱批准计数（失控循环保险丝）

      // ── 主循环：感知 → 决策 → 执行 → 验收（异步流水线，每 tick 步边界检查时钟）──
      for (let round = 0; round < 1000; round++) {
        // intent 层时钟：预算耗尽 ⇒ verdict='timeout'（部分轨迹保留）
        if (intent.budgetMs !== undefined && Date.now() - startedAt > intent.budgetMs) {
          verdict = 'timeout';
          break;
        }
        // ΝΩ-8：外部终止已在场 ⇒ 直达 aborted —— 取消后继续烧感知/决策是无意义开销
        //（cancelled 路由铁律的前移执法：终止的回声不进入任何后续工位）
        if (runSignal?.aborted) {
          verdict = 'aborted';
          break;
        }

        // ── 感知（信封铸造权：视觉工位只拿 PerceptionRequest，拿不到 intent）──
        // ΝΩ-26：反馈指认的过时区入疑脏集（点击落空区的旧视野作废）
        if (feedback?.staleRegionId) dirtyRegions.add(feedback.staleRegionId);
        const regions = this.regionsFor(scene);
        // ΝΩ-26（脏区跳过）：上轮 fault-free、未被动作/反馈/L3 批准污染、且窗龄
        // 内的分区复用缓存补丁（capturedAt 原样随行 —— 陈旧度是申报出来的，不是
        // 藏起来的）；疑脏分区才进感知请求。首轮缓存空 ⇒ 全请求（零回归）。
        const nowMs = Date.now();
        const requestRegions: RegionSpec[] = [];
        const reusedPatches: ScenePatch[] = [];
        for (const region of regions) {
          const cached = sceneCache.get(region.id);
          if (cached && !cached.fault && !dirtyRegions.has(region.id) &&
              nowMs - cached.capturedAt <= SCENE_REUSE_TTL_MS) {
            reusedPatches.push(cached);
          } else {
            requestRegions.push(region);
          }
        }
        // dhash 复用律（诚实方言的核心）：被重扫的分区若内容指纹未变且缓存
        // fault-free ⇒ 交还旧补丁 —— capturedAt 继续申报真实的数据年龄（「这区
        // 自 t0 起未变」是真话）；指纹已变/无缓存/缓存带 fault ⇒ 采纳新补丁入账。
        // ΠΑΝ-62（L3 结果覆写修复）：dhash 含 funnelDepth ⇒ 批准重扫产出的 L3
        // 补丁与后续 L1/L2 重扫补丁指纹必不相同，旧实现直接采纳新补丁 ⇒ 花钱
        // 买的 L3 语义证据在下一轮感知被覆写，决策工位永远看不到它要的答案
        //（NeedGrounding → 批准 → L3 重扫 → 覆写 → 再次 NeedGrounding → 烧完
        //  熔断预算）。证据位阶规则：同区缓存位阶**严格高于**新扫补丁且在
        // L3_EVIDENCE_TTL_MS 时效窗内 ⇒ 缓存胜出（L3 优先于 L1/L2，除非时效
        // 过期）；窗外世界的新鲜 L1/L2 如实接管 —— capturedAt 全程如实申报
        // 陈旧度，位阶提升绝不等于谎报新鲜。
        const mergePatch = (fresh: ScenePatch): ScenePatch => {
          const cached = sceneCache.get(fresh.region.id);
          if (cached && !cached.fault && sceneDhash(cached) === sceneDhash(fresh)) return cached;
          if (cached && !cached.fault &&
              FUNNEL_RANK[cached.funnelDepth] > FUNNEL_RANK[fresh.funnelDepth] &&
              Date.now() - cached.capturedAt <= L3_EVIDENCE_TTL_MS) {
            return cached; // ΠΑΝ-62：位阶更高且未过时效 —— L3 证据存活到决策工位
          }
          sceneCache.set(fresh.region.id, fresh);
          return fresh;
        };
        scene = reusedPatches;
        if (requestRegions.length > 0) {
          const perceiveEnv: AttentionEnvelope<'vision', PerceptionRequest> = {
            station: 'vision',
            payload: {
              intentRef: intent.id,
              regions: requestRegions,
              funnelCeiling: 'L2', // 缺省授权 L2；L3 仅经 NeedGrounding → 本中枢显式批准
              deadlineMs: cfg.perceptionDeadlineMs,
            },
            tokenBudget: remainingTokens('vision'), // ΝΩ-26：扣减制 —— 余额随自报消耗递减
          };
          tokenUsage.vision += perceiveEnv.tokenBudget;
          try {
            for await (const patch of stations.vision.perceive(perceiveEnv)) {
              scene.push(mergePatch(patch));
              // 阶段重叠的骨架实现：视觉每产出一区即入场景池（决策在循环尾消费全部；
              // 真重叠纪元由 pipeline 消费侧并行 —— 骨架诚实标注，不伪造并发）
            }
          } catch (e: any) {
            // Never-reject 违约的纵深防御：意外拒绝 ⇒ fault 补丁 + 违约记录入链
            scene.push({
              region: requestRegions[0] ?? regions[0] ?? { id: 'c0', x: 0, y: 0, width: 1, height: 1 },
              elements: [], funnelDepth: 'empty',
              fault: { source: 'L1', detail: `vision station contract breach (rejected stream): ${e?.message ?? 'unknown'}` },
              capturedAt: Date.now(),
            });
            await logPipeline('pipeline-vision-breach', { intentRef: intent.id, detail: e?.message });
          }
        }
        // requestRegions 为空 = 全部分区复用 ⇒ 视觉工位本轮零调用、零预算授予
        //（脏区跳过的省钱面；PerceptionRequest.regions=[] 契约上是全屏网格，
        //  绝不能拿空数组当「无事可做」—— 直接跳过整次感知才是诚实形态）。
        // ΠΑΝ-67：脏区用后清除 —— 疑脏标记在本轮感知已被消费（重扫已发生，
        // 新鲜度改由 capturedAt 申报）。旧实现全 run 从不清 ⇒ 每个动作落区
        // 永久疑脏，多步任务很快 4 区全脏 ⇒ 脏区跳过退化为「每轮全量重扫」，
        // ΝΩ-26 的省钱面在真实任务中静默失效。本轮之后的动作落区/反馈指认
        // 会重新入集（clear 只清已消费的历史疑脏，不吞并后续因果指认）。
        dirtyRegions.clear();

        // ── 决策（信封铸造权：决策工位只拿 intent + ScenePatch，无截图字节）──
        // ΠΑΝ-118：plan-ready chain 臂注入决策语境 —— planner 已铸的链对决策
        // 工位可见（消费与否是工位策略；语境缺席 ⇒ 与接线前逐字节同形）。
        const decisionCtx: PlanReadyDecisionContext = {
          intent, scene,
          ...(planReadyChain !== undefined ? { planReadyChain } : {}),
        };
        let output: DecisionOutput;
        // ΠΑΝ-63（烧钱循环修复）：标记本次 need-grounding 是否为预算耗尽的
        // **强制降级**（决策工位未被调用、无人消费重扫结果）——与决策工位
        // 主动申报的信息缺口严格分治（后者有消费方，前者没有）。
        let forcedByBudget = false;
        // ΝΩ-26（四修之三）：决策余额耗尽 ⇒ 强制降级 —— 不再调用工位（无计量
        // 烧钱是预算制的反面），need-grounding 的 question 即诚实降级注记
        //（沿 NeedGrounding 路由进 L3 授权链 ⇒ 入审计账本；批准预算熔断后
        //  诚实 escalated 终局，绝不谎称任务失败）。
        const decisionRemaining = remainingTokens('decision');
        if (decisionRemaining <= 0) {
          forcedByBudget = true;
          output = {
            kind: 'need-grounding',
            question: 'decision token budget exhausted — forced degradation (decision station not called)',
          };
        } else {
          forcedByBudget = false;
          const decisionEnv: AttentionEnvelope<'decision', DecisionContext> = {
            station: 'decision',
            payload: decisionCtx,
            tokenBudget: decisionRemaining, // ΝΩ-26：扣减制 —— 余额随自报消耗递减
          };
          tokenUsage.decision += decisionEnv.tokenBudget;
          output = await withAttemptTimeout(
            // ΝΩ-8：D-6 决策方言无 signal 通道（decide 契约未开口子）—— 工厂不吃信号，
            // 外部取消仍经 abort 联动到下一工位；决策超时语义与旧路径逐字节一致
            () => stations.decision.decide(decisionEnv, feedback),
            cfg.attemptTimeoutMs,
            { kind: 'need-grounding', question: `decision attempt timeout after ${cfg.attemptTimeoutMs}ms` },
            runSignal,
          );
        }

        // NeedGrounding 路由：L3 花钱权裁决（中枢主权 —— 视觉工位无权自启）
        if ('kind' in output && output.kind === 'need-grounding') {
          // ΠΑΝ-63（烧钱循环修复）：预算耗尽的强制 need-grounding **不带
          // regionId 时拒绝新批准**（只消费既有场景证据）—— 此刻决策工位
          // 已不被调用，批准全网格 L3 重扫是给无人消费的结果烧钱：旧实现
          // 走 approveGrounding(undefined) = 批准全网格 × 每区一次 VLM，
          // 循环至 3 次熔断（最多 3 轮 × 4 区 = 12 次 grounding 调用全浪费）。
          // 正确语义：预算耗尽 + 无 region ⇒ 直接诚实终局 escalated（裁决权
          // 上交，绝不借重扫伪装推进）。
          if (forcedByBudget && !output.regionId) {
            verdict = 'escalated';
            await logPipeline('pipeline-grounding-denied', {
              intentRef: intent.id,
              reason: 'decision token budget exhausted — forced need-grounding carries no regionId and has no consumer; new grounding approval denied (burned-money loop guard)',
            });
            break;
          }
          // 批准预算（风险加固）：恒批准是 L3 失控循环的绿色通道 ——
          // 决策工位反复要 grounding 时按预算熔断。
          // J 纪元升级（'escalated' 兑现语义）：这不是普通失败 —— 决策层持续
          // 索要超出预算的 L3 帮助，流水线自身已无法推进，把裁决权**上交**
          //（D-4 复核 / 人类介入），而非谎称"任务失败"。七态枚举从此无死态。
          if (groundingApprovals >= MAX_GROUNDING_APPROVALS_PER_RUN) {
            verdict = 'escalated';
            await logPipeline('pipeline-grounding-denied', {
              intentRef: intent.id,
              reason: `grounding approval budget (${MAX_GROUNDING_APPROVALS_PER_RUN}) exhausted — decision layer keeps requesting L3 help; escalating`,
            });
            break;
          }
          groundingApprovals += 1;
          const approved = await this.approveGrounding(
            intent.id, output.regionId, output.question, scene, remainingTokens('vision'),
          );
          if (approved.approved) {
            // ΝΩ-26：L3 批准区入疑脏集 —— 决策已宣告该区语义不足，缓存补丁作废
            for (const r of approved.regions) dirtyRegions.add(r.id);
            await logPipeline('pipeline-grounding', {
              intentRef: intent.id, regionId: output.regionId, regions: approved.regions.length,
              question: output.question, ceiling: approved.ceiling,
            });
            stations.emit?.(EVT_PIPELINE_GROUNDING, { intentRef: intent.id, question: output.question });
            // 重扫获批分区，ceiling 由裁决给出 + l3Reason 回执 —— 下轮循环执行。
            // J 纪元修正：L3 结果**并入**既有场景（获批分区替换，其余分区保留）——
            // 旧实现 scene = [] 后只填 L3 补丁，下轮 regionsFor 恒返回 [目标区]，
            // 决策从此只见屏幕一角且永不回全屏网格。
            const merged = scene.filter(p => !approved.regions.some(r => r.id === p.region.id));
            const ceilingDowngraded = approved.ceiling === 'L2';
            const perceiveL3: AttentionEnvelope<'vision', PerceptionRequest> = {
              station: 'vision',
              payload: {
                intentRef: intent.id,
                regions: approved.regions,
                funnelCeiling: approved.ceiling,
                // ΝΩ-26：视觉余额耗尽的降格注记随授权依据入链（诚实方言 ——
                // 补丁的漏斗深度会如实停在 L2，归因在这里先说清为什么）
                l3Reason: ceilingDowngraded
                  ? `${output.question} [degraded: vision token budget exhausted — L3 denied, L2 rescan]`.slice(0, 120)
                  : output.question,
                deadlineMs: cfg.perceptionDeadlineMs,
              },
              tokenBudget: remainingTokens('vision'), // ΝΩ-26：扣减制余额
            };
            tokenUsage.vision += perceiveL3.tokenBudget;
            try {
              for await (const patch of stations.vision.perceive(perceiveL3)) merged.push(mergePatch(patch));
            } catch (e: any) {
              // Never-reject 纵深防御：保留旧分区继续（决策下轮再要兜底）—— 违约仍须入链可审计
              await logPipeline('pipeline-vision-breach', { intentRef: intent.id, detail: `L3 rescan rejected stream: ${e?.message ?? 'unknown'}` });
            }
            scene = merged;
            feedback = undefined;
            continue;
          }
          // 不予批准（预算耗尽或无 L3 源）⇒ 诚实终局
          verdict = 'failed';
          await logPipeline('pipeline-grounding-denied', { intentRef: intent.id, reason: approved.reason });
          break;
        }

        // ── 执行（信封铸造权：ExecutionOrder 剥离 rationale —— 执行工位物理上看不见）──
        const action = output as AtomicAction;
        seq += 1;
        const order: ExecutionOrder = { seq, intentRef: intent.id, action: { kind: action.kind, args: action.args, expect: action.expect } };

        // ΝΩ-8：止损信号随指令单下发 —— attemptTimeoutMs 越限/外部取消即 abort，
        // 沿执行链直达 HTTP 层断流（microFetch 组合超时 → Python 断连即中断）。
        // 旧实现超时后原 execute promise 继续飞行：迟到的真实点击仍会落地
        // （不可逆世界污染）；工位不消费 signal 时该字段是无害数据（旧路径）。
        let result: ExecutionResult = await withAttemptTimeout(
          (signal) => stations.execution.execute({
            station: 'execution',
            payload: { ...order, signal },
            tokenBudget: 0, // 零模型肌肉的类型层执法
          }),
          cfg.attemptTimeoutMs,
          { seq, effectDetected: null, latencyMs: cfg.attemptTimeoutMs, rehearsed: false,
            failure: { kind: 'timeout-aborted', detail: `execution attempt timeout after ${cfg.attemptTimeoutMs}ms (abort signal fired)` } },
          runSignal,
        );

        const record: AttemptRecord = { seq, attempt: retryCount + 1, action, result, feedback };
        attempts.push(record);
        // ΝΩ-26：动作落点区入疑脏集 —— 我们动过世界，该区旧视野作废（下轮必重扫；
        // 坐标缺席的动作无法定位 ⇒ 交给 1500ms 复用窗口兜底有界陈旧）。与
        // guessStaleRegion 同一落区几何（反馈指认与脏区判定不漂移）。
        const touchedRegion = this.guessStaleRegion(action, scene);
        if (touchedRegion) dirtyRegions.add(touchedRegion);
        await logPipeline('pipeline-attempt', {
          intentRef: intent.id, seq, attempt: record.attempt,
          kind: action.kind, effectDetected: result.effectDetected,
          failure: result.failure?.kind ?? null,
        });
        stations.emit?.(EVT_PIPELINE_ATTEMPT, { intentRef: intent.id, seq, verdict: result.effectDetected });

        // ── 失败路由（路由铁律：cancelled 直达终局，绝不入重试循环）──
        if (result.failure) {
          const { kind, detail } = result.failure;
          // ΝΩ-8：外部取消的回声 —— run 级 signal 已 abort 后的失败不论工位归因
          // （timeout/host-error/…）都是终止的回声而非世界回击 ⇒ 直达 aborted，
          // 绝不入重试（给已终止的尝试做重规划是无意义烧钱）
          if (runSignal?.aborted) {
            verdict = 'aborted';
            break;
          }
          if (kind === 'cancelled') {
            verdict = 'aborted';
            break;
          }
          if (retryCount >= cfg.maxDecisionRetries) {
            verdict = 'failed';
            feedback = { seq, kind: kind as FailureFeedback['kind'], detail };
            break;
          }
          // 重试：反馈回决策工位（staleRegionId 推断 —— 点击落空 ⇒ 该区视觉过时）
          retryCount += 1;
          feedback = {
            seq,
            kind: kind as FailureFeedback['kind'],
            detail,
            staleRegionId: kind === 'host-error' ? this.guessStaleRegion(action, scene) : undefined,
          };
          await logPipeline('pipeline-retry', { intentRef: intent.id, seq, retryCount, kind });
          continue;
        }

        // ── 验收：effectDetected 硬证据（D-4 事件回执异步到达 —— AttemptRecord.doctorVerdict
        //    由 index.ts 的 onDoctorVerdict 补写；此处只记硬证据）──
        if (result.effectDetected === true) {
          // 唯一硬证据已满足即完成（successCriteria 的多步判据链由决策工位语义
          // 承载 —— 骨架最小实现：单步达成即完成）
          verdict = 'completed';
          break;
        }
        if (result.effectDetected === null) {
          // 验证层缺席：动作已执行但无效果证据。不能无反馈地 continue ——
          // 决策工位看到同样的场景会重发同一动作，宿主重复执行至 1000 轮防爆环。
          // 计入重试预算 + 反馈告知「已执行但未验证」；熔断后诚实 degraded 终局
          verdict = 'degraded';
          if (retryCount >= cfg.maxDecisionRetries) {
            feedback = { seq, kind: 'host-error', detail: 'verification layer absent — effect unknown' };
            break;
          }
          retryCount += 1;
          feedback = {
            seq, kind: 'host-error',
            detail: 'verification layer absent — previous action executed but effect unknown; check the fresh scene before repeating it',
          };
          continue;
        }
        // effectDetected === false：世界回击 ⇒ 走失败反馈重试
        if (retryCount >= cfg.maxDecisionRetries) {
          verdict = 'failed';
          feedback = { seq, kind: 'host-error', detail: 'effect not detected (world pushback)' };
          break;
        }
        retryCount += 1;
        feedback = {
          seq, kind: 'host-error', detail: 'effect not detected (world pushback)',
          staleRegionId: this.guessStaleRegion(action, scene),
        };
        continue;
      }

      if (verdict === null) {
        verdict = attempts.some(a => a.result.effectDetected === null) ? 'degraded' : 'failed';
        // 1000 轮防爆环：诚实归因
        if (attempts.length > 0 && attempts.every(a => a.result.effectDetected === true)) {
          verdict = 'completed';
        }
      }
      if (verdict === 'degraded' && attempts.some(a => a.result.effectDetected === true)) {
        // 部分硬证据 + 部分缺席：判据链完整则完成，否则保持 degraded（诚实降级）
        const all = attempts.filter(a => a.result.effectDetected !== null);
        if (all.length > 0 && all.every(a => a.result.effectDetected === true)) verdict = 'completed';
      }

      const reason = this.terminalReasonFor(verdict, feedback);
      return this.finalReport(intent, verdict, reason, attempts, startedAt, tokenUsage, opts?.snapshotId);
    } catch (e: any) {
      // 运行层兜底：任何意外 ⇒ 结构化 failed（契约第二条 —— 永不抛错）
      const reason = `internal pipeline fault: ${e?.message ?? 'unknown'}`;
      await logPipeline('pipeline-internal-fault', { intentRef: intent.id, detail: reason });
      return this.finalReport(intent, 'failed', reason, attempts, startedAt, tokenUsage, opts?.snapshotId);
    }
  }

  verifyLog(): Result<{ ok: boolean; length: number; brokenAt: number | null }> {
    return { ok: true, value: sandboxLog.verify() };
  }

  reset(): void {
    sandboxLog.reset();
  }

  // ─── 私有主权域 ───

  /** 分区铸造：首轮 = 全屏网格；后续 = 既有分区（坐标同一性跨轮稳定） */
  private regionsFor(scene: ScenePatch[]): RegionSpec[] {
    const cfg = this.cfg!;
    if (scene.length > 0) {
      return scene.map(p => p.region);
    }
    return gridRegions(cfg.regionGrid);
  }

  /** L3 花钱权裁决（J 纪元修正：兑现注释承诺的裁决逻辑，取代恒批准 + 静默回退）。
   *  裁决规则：
   *    - regionId 在场且在当前场景中存在、且该分区 funnelDepth 未达 L3 ⇒ 批准重扫该区；
   *    - regionId 在场但不在场景/网格中（模型幻觉 id）⇒ 拒绝并归因；
   *    - regionId 缺席（「整屏语义不足」）⇒ 批准**全网格** L3 重扫 ——
   *      旧实现静默回退 full[0]（左上象限），“整屏不足”却只重扫 1/4 屏。
   *  ΝΩ-26（四修之三）：视觉余额耗尽 ⇒ 批准仍在但 ceiling 降格 'L2'（L3 是唯一
   *  烧 token 的视觉层 —— L1/L2 是本地肌肉；降格注记进 ruling 审计，绝不静默）。 */
  private async approveGrounding(
    intentRef: string, regionId: string | undefined, question: string, scene: ScenePatch[],
    visionRemaining: number,
  ): Promise<{ approved: boolean; regions: RegionSpec[]; ceiling: 'L2' | 'L3'; reason?: string }> {
    const full = gridRegions(this.cfg!.regionGrid);
    const ceiling: 'L2' | 'L3' = visionRemaining > 0 ? 'L3' : 'L2';
    const downgradeNote = ceiling === 'L2' ? ' — L3 downgraded to L2 (vision token budget exhausted)' : '';
    if (regionId) {
      const patch = scene.find(p => p.region.id === regionId) ?? undefined;
      const gridRegion = full.find(r => r.id === regionId);
      if (!patch && !gridRegion) {
        await logPipeline('pipeline-grounding-review', { intentRef, regionId, question, ruling: 'denied: unknown region id' });
        return { approved: false, regions: [], ceiling: 'L2', reason: `regionId '${regionId}' not in current scene or grid (hallucinated id?)` };
      }
      if (patch && patch.funnelDepth === 'L3') {
        await logPipeline('pipeline-grounding-review', { intentRef, regionId, question, ruling: 'denied: already at L3' });
        return { approved: false, regions: [], ceiling: 'L2', reason: `region '${regionId}' already scanned at L3 — re-spend denied` };
      }
      const target = patch?.region ?? gridRegion!;
      await logPipeline('pipeline-grounding-review', { intentRef, regionId: target.id, question, ruling: `approved: single region${downgradeNote}` });
      return { approved: true, regions: [target], ceiling };
    }
    await logPipeline('pipeline-grounding-review', { intentRef, regionId: null, question, ruling: `approved: full grid${downgradeNote}` });
    return { approved: true, regions: full, ceiling };
  }

  /** 点击落空时的过时区推断（FailureFeedback.staleRegionId 的启发式铸造） */
  private guessStaleRegion(action: AtomicAction, scene: ScenePatch[]): string | undefined {
    const x = Number(action.args?.x ?? NaN);
    const y = Number(action.args?.y ?? NaN);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
    for (const p of scene) {
      const r = p.region;
      if (x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height) return r.id;
    }
    return undefined;
  }

  private terminalReasonFor(verdict: PipelineVerdict, feedback?: FailureFeedback): string {
    if (feedback) return `${verdict}: ${feedback.kind} at seq ${feedback.seq} — ${feedback.detail}`.slice(0, 120);
    switch (verdict) {
      case 'completed': return 'goal achieved (hard evidence: effectDetected=true)';
      case 'degraded': return 'completed with absent verification layers';
      case 'escalated': return 'grounding budget exhausted — decision layer keeps requesting L3 help; escalated upward';
      case 'timeout': return 'intent budget exhausted';
      case 'aborted': return 'cancelled by external signal';
      default: return `${verdict} (no further progress possible)`;
    }
  }

  private finalReport(
    intent: IntentPayload,
    verdict: PipelineVerdict,
    terminalReason: string,
    attempts: AttemptRecord[],
    startedAt: number,
    budgetsGranted?: { vision: number; decision: number; execution: number },
    snapshotId?: string,
  ): PipelineReport {
    const chainTip = sandboxLog.tip;
    const usage = budgetsGranted ?? { vision: 0, decision: 0, execution: 0 };
    // O 纪元（#8）：实际消耗计量 —— 工位自报探针（缺席 ⇒ 0 = 未计量，非未消耗）
    const tokenUsageReported = {
      vision: readUsageProbe(this.stations?.usageMeter?.vision),
      decision: readUsageProbe(this.stations?.usageMeter?.decision),
      execution: readUsageProbe(this.stations?.usageMeter?.execution),
    };
    const report: PipelineReport = {
      intentRef: intent.id,
      verdict,
      terminalReason: terminalReason.slice(0, 120),
      attempts,
      tokenBudgetsGranted: usage,
      tokenUsageReported,
      chainTip,
      reportPath: '', // 落盘后回填（一次成稿 —— 见下方 ΝΩ-26 内联回收）
    };
    // ΝΩ-26（四修之四）：D-4 判决回收内联于落盘**之前** —— 报告一次成稿，盘上/
    // 内存同一副面孔。旧序：persistReport 先写盘、reconcileVerdicts 在 run 返回
    // 后才改内存 verdict ⇒ 盘上终局停旧（两副面孔）。回收面故障 ⇒ 吞掉
    //（旁路义务绝不毒化终局报告 —— 防御式）。
    if (this.reconcileReport) {
      try { this.reconcileReport(report); } catch { /* 回收面故障 = 旁路义务 */ }
    }
    report.reportPath = this.persistReport(intent.id, report, { snapshotId, startedAt });
    void logPipeline('pipeline-run-end', {
      intentRef: intent.id, verdict: report.verdict, attempts: attempts.length, chainTip: report.chainTip,
    });
    this.stations?.emit?.(EVT_PIPELINE_RUN_END, {
      intentRef: intent.id, verdict: report.verdict, attempts: attempts.length, reportPath: report.reportPath,
    });
    return report;
  }

  /** 结构化落盘（Token 纪律：对话流只回句柄；失败降级 'in-memory' 并 warn）。
   *  文件名带进程内序号（风险加固）：同 intent 同毫秒的并发报告不互相覆盖。
   *  ΝΩ-26：入参改为报告本体（post-reconcile 状态）—— 写盘的是回收后的
   *  终局 verdict/terminalReason/attempts，与内存报告同源同刻。 */
  private persistReport(
    intentId: string,
    report: PipelineReport,
    extra: { snapshotId?: string; startedAt: number },
  ): string {
    if (!this.reportDir) return 'in-memory';
    try {
      mkdirSync(this.reportDir, { recursive: true });
      this.reportCounter += 1;
      const full = join(this.reportDir, `pipeline-${intentId}-${Date.now()}-${this.reportCounter}.json`);
      writeFileSync(full, JSON.stringify({
        intentId,
        verdict: report.verdict,
        terminalReason: report.terminalReason,
        attempts: report.attempts,
        tokenBudgetsGranted: report.tokenBudgetsGranted,
        tokenUsageReported: report.tokenUsageReported,
        chainTip: report.chainTip,
        snapshotId: extra.snapshotId,
        startedAt: extra.startedAt,
      }, null, 2), 'utf8');
      return full;
    } catch (e: any) {
      console.warn(`[Pipeline] report persist failed: ${e.message}`);
      return 'in-memory';
    }
  }
}
