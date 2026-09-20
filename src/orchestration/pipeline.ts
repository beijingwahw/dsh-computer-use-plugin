// src/orchestration/pipeline.ts
// D-6 流水线编排器 —— PipelineOrchestrator 实现（契约见 contracts.ts §9）。
// 四大主权（全部收口于本文件）：
//   1. 信封铸造权：三工位信封的唯一构造者（注意力隔离的物理执法点）
//   2. region.id 铸造权：网格分区 'g{col}x{row}' / 自定义分区 'c{n}'（contracts 身份方案）
//   3. 失败路由：cancelled 不入重试（路由铁律）；七态 verdict 每态独立终止路径
//   4. 时间治理：attempt（杀一刀）/ perception（产 fault 补丁）/ intent（杀流水线）三层
// 与器官咬合（事件总线，零直接调用）：
//   D-5 沙箱 —— 执行工位经 SandboxStationView 预演；账本复用 sandboxLog（独立 D-6 链段）
//   D-4 医生 —— 发射 sandbox/rehearsal-end 等价事件后订阅 doctor/verdict 回执（AttemptRecord）
//   D-1 认知 —— intents 由 index.ts 经事件/服务注入（本文件只认 IntentPayload 契约）
// 异常诚实分层契约（D-7 修正案对齐 / P0-1）：configure = 运行层可重配方法（Result 降级，
//   严禁 throw）；wire = 加载层（throw 合法，由 apply 收口）；run = 永不抛错。
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type {
  AtomicAction, ConfigError, DecisionContext, DecisionOutput, ExecutionOrder, ExecutionResult,
  FailureFeedback, IntentPayload, PipelineConfig, PipelineOrchestrator, PipelineReport,
  PipelineVerdict, RegionSpec, Result, ScenePatch, AttemptRecord, AttentionEnvelope,
  PerceptionRequest, DecisionStation, ExecutionStation, VisionStation,
} from './contracts';
import { sandboxLog } from '../sandbox/log';
import { createDefaultIdGenerator, type IdGenerator } from '../sandbox/types';

/** D-6 事件面（events.ts 浇筑时收口；编排器先经 log + 事件常量占位，零直接调用） */
const EVT_PIPELINE_RUN_END = 'pipeline/run-end';
const EVT_PIPELINE_ATTEMPT = 'pipeline/attempt';
const EVT_PIPELINE_GROUNDING = 'pipeline/grounding-request';

export interface PipelineStations {
  vision: VisionStation;
  decision: DecisionStation;
  execution: ExecutionStation;
  /** 事件发射面（index.ts 注入 ctx；null = 无宿主事件面 —— 开发者预览） */
  emit?: (event: string, payload: Record<string, unknown>) => void;
}

/** 网格分区铸造（'g{col}x{row}' —— 坐标同一性，跨轮稳定） */
function gridRegions(grid: { cols: number; rows: number }): RegionSpec[] {
  const regions: RegionSpec[] = [];
  for (let col = 0; col < grid.cols; col++) {
    for (let row = 0; row < grid.rows; row++) {
      regions.push({
        id: `g${col}x${row}`,
        x: col / grid.cols, y: row / grid.rows,
        width: 1 / grid.cols, height: 1 / grid.rows,
      });
    }
  }
  return regions;
}

/** 尝试超时包裹：attemptTimeoutMs 越限 ⇒ fallback（杀一刀，不杀流水线）。
 *  泛型无约束 —— 同时包裹 DecisionOutput 与 ExecutionResult 两形态 */
async function withAttemptTimeout<T>(
  p: Promise<T>, timeoutMs: number, fallback: T,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>(resolve => {
        timer = setTimeout(() => resolve(fallback), timeoutMs);
      }),
    ]);
  } catch {
    return fallback; // 工位违约抛错 ⇒ 结构化捕获（纵深防御）
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 沙箱链入账（复用 D-5 账本，D-6 链段 kind 前缀 'pipeline-' —— 与宿主账本分链）。
 *  P1-5：'pipeline-*' 已收编入 SandboxLogKind 显式契约 —— 类型逃逸（as any）消灭。 */
async function logPipeline(kind: 'pipeline-attempt' | 'pipeline-retry' | 'pipeline-grounding' |
  'pipeline-grounding-denied' | 'pipeline-grounding-review' | 'pipeline-vision-breach' |
  'pipeline-internal-fault' | 'pipeline-run-end', data: Record<string, unknown>): Promise<void> {
  await sandboxLog.append(kind, data);
}

/** 每 run 的 L3 花钱批准预算（风险加固）：决策工位可反复要 grounding（桩纪元
 *  无记账），恒批准 = L3 失控循环的绿色通道 —— 超预算即诚实拒绝终局） */
const MAX_GROUNDING_APPROVALS_PER_RUN = 3;

export class PipelineOrchestratorImpl implements PipelineOrchestrator {
  private cfg: PipelineConfig | null = null;
  private idGen: IdGenerator = createDefaultIdGenerator();
  private stations: PipelineStations | null = null;
  private customRegionCounter = 0;
  private reportDir = '';
  private reportCounter = 0; // 报告文件名防碰撞序号（同 intent 同毫秒不互相覆盖）

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
  wire(stations: PipelineStations, opts?: { idGenerator?: IdGenerator; reportDir?: string }): void {
    if (!this.cfg) throw new Error('[PipelineOrchestrator] configure() must precede wire()');
    if (!stations.vision || !stations.decision || !stations.execution) {
      throw new Error('[PipelineOrchestrator] all three stations are required');
    }
    this.stations = stations;
    if (opts?.idGenerator) this.idGen = opts.idGenerator;
    this.reportDir = opts?.reportDir ?? '';
  }

  /** 运行层入口（契约第二条：永不抛错）。try 包裹整环 —— 任何意外 = verdict='failed' 落盘 */
  async run(intent: IntentPayload, opts?: { snapshotId?: string }): Promise<PipelineReport> {
    const startedAt = Date.now();
    if (!this.cfg || !this.stations) {
      return this.finalReport(intent, 'failed', 'orchestrator not configured/wired', [], startedAt);
    }
    const cfg = this.cfg;
    const stations = this.stations;
    const attempts: AttemptRecord[] = [];
    const tokenUsage = { vision: 0, decision: 0, execution: 0 };

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

        // ── 感知（信封铸造权：视觉工位只拿 PerceptionRequest，拿不到 intent）──
        const regions = this.regionsFor(scene);
        const perceiveEnv: AttentionEnvelope<'vision', PerceptionRequest> = {
          station: 'vision',
          payload: {
            intentRef: intent.id,
            regions,
            funnelCeiling: 'L2', // 缺省授权 L2；L3 仅经 NeedGrounding → 本中枢显式批准
            deadlineMs: cfg.perceptionDeadlineMs,
          },
          tokenBudget: cfg.stationTokenBudgets.vision,
        };
        tokenUsage.vision += perceiveEnv.tokenBudget;
        scene = [];
        try {
          for await (const patch of stations.vision.perceive(perceiveEnv)) {
            scene.push(patch);
            // 阶段重叠的骨架实现：视觉每产出一区即入场景池（决策在循环尾消费全部；
            // 真重叠纪元由 pipeline 消费侧并行 —— 骨架诚实标注，不伪造并发）
          }
        } catch (e: any) {
          // Never-reject 违约的纵深防御：意外拒绝 ⇒ fault 补丁 + 违约记录入链
          scene.push({
            region: regions[0] ?? { id: 'c0', x: 0, y: 0, width: 1, height: 1 },
            elements: [], funnelDepth: 'empty',
            fault: { source: 'L1', detail: `vision station contract breach (rejected stream): ${e?.message ?? 'unknown'}` },
            capturedAt: Date.now(),
          });
          await logPipeline('pipeline-vision-breach', { intentRef: intent.id, detail: e?.message });
        }

        // ── 决策（信封铸造权：决策工位只拿 intent + ScenePatch，无截图字节）──
        const decisionCtx: DecisionContext = { intent, scene };
        const decisionEnv: AttentionEnvelope<'decision', DecisionContext> = {
          station: 'decision',
          payload: decisionCtx,
          tokenBudget: cfg.stationTokenBudgets.decision,
        };
        tokenUsage.decision += decisionEnv.tokenBudget;

        let output: DecisionOutput;
        output = await withAttemptTimeout(
          stations.decision.decide(decisionEnv, feedback),
          cfg.attemptTimeoutMs,
          { kind: 'need-grounding', question: `decision attempt timeout after ${cfg.attemptTimeoutMs}ms` },
        );

        // NeedGrounding 路由：L3 花钱权裁决（中枢主权 —— 视觉工位无权自启）
        if ('kind' in output && output.kind === 'need-grounding') {
          // 批准预算（风险加固）：恒批准是 L3 失控循环的绿色通道 ——
          // 决策工位反复要 grounding 时按预算熔断。
          // J 纪元升级（'escalated' 兑现语义）：这不是普通失败 —— 决策层持续
          // 索要超出预算的 L3 帮助，流水线自身已无法推进，把裁决权**上交**
          // （D-4 复核 / 人类介入），而非谎称"任务失败"。七态枚举从此无死态。
          if (groundingApprovals >= MAX_GROUNDING_APPROVALS_PER_RUN) {
            verdict = 'escalated';
            await logPipeline('pipeline-grounding-denied', {
              intentRef: intent.id,
              reason: `grounding approval budget (${MAX_GROUNDING_APPROVALS_PER_RUN}) exhausted — decision layer keeps requesting L3 help; escalating`,
            });
            break;
          }
          groundingApprovals += 1;
          const approved = await this.approveGrounding(intent.id, output.regionId, output.question, scene);
          if (approved.approved) {
            await logPipeline('pipeline-grounding', { intentRef: intent.id, regionId: output.regionId, regions: approved.regions.length, question: output.question });
            stations.emit?.(EVT_PIPELINE_GROUNDING, { intentRef: intent.id, question: output.question });
            // 重扫获批分区，ceiling='L3' + l3Reason 回执 —— 下轮循环执行。
            // J 纪元修正：L3 结果**并入**既有场景（获批分区替换，其余分区保留）——
            // 旧实现 scene = [] 后只填 L3 补丁，下轮 regionsFor 恒返回 [目标区]，
            // 决策从此只见屏幕一角且永不回全屏网格。
            const merged = scene.filter(p => !approved.regions.some(r => r.id === p.region.id));
            const perceiveL3: AttentionEnvelope<'vision', PerceptionRequest> = {
              station: 'vision',
              payload: {
                intentRef: intent.id,
                regions: approved.regions,
                funnelCeiling: 'L3',
                l3Reason: output.question,
                deadlineMs: cfg.perceptionDeadlineMs,
              },
              tokenBudget: cfg.stationTokenBudgets.vision,
            };
            tokenUsage.vision += perceiveL3.tokenBudget;
            try {
              for await (const patch of stations.vision.perceive(perceiveL3)) merged.push(patch);
            } catch { /* Never-reject 纵深防御：保留旧分区继续（决策下轮再要兜底） */ }
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
        const execEnv: AttentionEnvelope<'execution', ExecutionOrder> = {
          station: 'execution',
          payload: order,
          tokenBudget: 0, // 零模型肌肉的类型层执法
        };

        let result: ExecutionResult = await withAttemptTimeout(
          stations.execution.execute(execEnv),
          cfg.attemptTimeoutMs,
          { seq, effectDetected: null, latencyMs: cfg.attemptTimeoutMs, rehearsed: false,
            failure: { kind: 'timeout', detail: `execution attempt timeout after ${cfg.attemptTimeoutMs}ms` } },
        );

        const record: AttemptRecord = { seq, attempt: retryCount + 1, action, result, feedback };
        attempts.push(record);
        await logPipeline('pipeline-attempt', {
          intentRef: intent.id, seq, attempt: record.attempt,
          kind: action.kind, effectDetected: result.effectDetected,
          failure: result.failure?.kind ?? null,
        });
        stations.emit?.(EVT_PIPELINE_ATTEMPT, { intentRef: intent.id, seq, verdict: result.effectDetected });

        // ── 失败路由（路由铁律：cancelled 直达终局，绝不入重试循环）──
        if (result.failure) {
          const { kind, detail } = result.failure;
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
    this.customRegionCounter = 0;
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
   *      旧实现静默回退 full[0]（左上象限），“整屏不足”却只重扫 1/4 屏。 */
  private async approveGrounding(
    intentRef: string, regionId: string | undefined, question: string, scene: ScenePatch[],
  ): Promise<{ approved: boolean; regions: RegionSpec[]; reason?: string }> {
    const full = gridRegions(this.cfg!.regionGrid);
    if (regionId) {
      const patch = scene.find(p => p.region.id === regionId) ?? undefined;
      const gridRegion = full.find(r => r.id === regionId);
      if (!patch && !gridRegion) {
        await logPipeline('pipeline-grounding-review', { intentRef, regionId, question, ruling: 'denied: unknown region id' });
        return { approved: false, regions: [], reason: `regionId '${regionId}' not in current scene or grid (hallucinated id?)` };
      }
      if (patch && patch.funnelDepth === 'L3') {
        await logPipeline('pipeline-grounding-review', { intentRef, regionId, question, ruling: 'denied: already at L3' });
        return { approved: false, regions: [], reason: `region '${regionId}' already scanned at L3 — re-spend denied` };
      }
      const target = patch?.region ?? gridRegion!;
      await logPipeline('pipeline-grounding-review', { intentRef, regionId: target.id, question, ruling: 'approved: single region' });
      return { approved: true, regions: [target] };
    }
    await logPipeline('pipeline-grounding-review', { intentRef, regionId: null, question, ruling: 'approved: full grid' });
    return { approved: true, regions: full };
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
    // J 纪元修正：落盘报告补齐 terminalReason / chainTip / 授予预算 ——
    // 旧实现只写 {intentId, verdict, attempts, snapshotId, startedAt}，
    // 磁盘报告缺终局归因与审计锚，与内存报告两副面孔。
    const reportPath = this.persistReport(intent.id, verdict, {
      attempts, snapshotId, startedAt,
      terminalReason: terminalReason.slice(0, 120),
      chainTip,
      tokenBudgetsGranted: usage,
    });
    const report: PipelineReport = {
      intentRef: intent.id,
      verdict,
      terminalReason: terminalReason.slice(0, 120),
      attempts,
      tokenBudgetsGranted: usage,
      chainTip,
      reportPath,
    };
    void logPipeline('pipeline-run-end', {
      intentRef: intent.id, verdict, attempts: attempts.length, chainTip: report.chainTip,
    });
    this.stations?.emit?.(EVT_PIPELINE_RUN_END, {
      intentRef: intent.id, verdict, attempts: attempts.length, reportPath: report.reportPath,
    });
    return report;
  }

  /** 结构化落盘（Token 纪律：对话流只回句柄；失败降级 'in-memory' 并 warn）。
   *  文件名带进程内序号（风险加固）：同 intent 同毫秒的并发报告不互相覆盖。 */
  private persistReport(intentId: string, verdict: string, extra: Record<string, unknown>): string {
    if (!this.reportDir) return 'in-memory';
    try {
      mkdirSync(this.reportDir, { recursive: true });
      this.reportCounter += 1;
      const full = join(this.reportDir, `pipeline-${intentId}-${Date.now()}-${this.reportCounter}.json`);
      writeFileSync(full, JSON.stringify({ intentId, verdict, ...extra }, null, 2), 'utf8');
      return full;
    } catch (e: any) {
      console.warn(`[Pipeline] report persist failed: ${e.message}`);
      return 'in-memory';
    }
  }
}
