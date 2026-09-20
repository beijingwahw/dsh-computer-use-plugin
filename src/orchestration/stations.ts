// src/orchestration/stations.ts
// D-6 三工位默认骨架 —— 「收编者，不是重造者」的代码化：
//   Vision 工位    收编 D-3 白盒源协议（WhiteboxProvider 方言）+ textReader OCR —— 经适配器注入
//   Decision 工位  收编 planner 方言（ChatFn 依赖注入）—— 流水线唯一大模型调用点
//   Execution 工位 咬合 D-5 SandboxEngine（预演）与宿主动作工具面 —— 经适配器注入
// 本文件零二进制依赖（sharp/tesseract 不进 import 域——沙箱环境可验证）；
// 真机部署时适配器在 index.ts 接线，本骨架对 L1/L2/L3 诚实降级。
//
// 异常诚实分层契约（立法全文见 sandbox/types.ts 头部）：
//   工位构造器 = 加载层（throw 合法：拒绝带病上线）；
//   perceive/decide/execute = 运行层（永不抛错：结构化降级）。
import type {
  AttentionEnvelope, AtomicAction, DecisionContext, DecisionOutput, ExecutionOrder,
  ExecutionResult, FailureFeedback, PerceptionRequest, ScenePatch, UIElement,
  VisionStation, DecisionStation, ExecutionStation, RegionSpec,
} from './contracts';
import type { SandboxAction } from '../sandbox/types';
import { SANDBOX_ACTION_KINDS } from '../sandbox/types';

// ─── L1/L2/L3 源协议：三级漏斗的适配器接口（收编 D-3 WhiteboxProvider 方言）───

/** L1 结构化源（<1ms 预算域）：无障碍树 / DOM。
 *  坐标归一化责任在适配器（宿主树给像素坐标 —— 与 UIElement.rect 归一化域对齐）。
 *  返回 [] = 诚实空集；**故障请抛错**（J 纪元修正）—— 工位 safeExtract 会捕获
 *  并归因为 fault 补丁。旧契约"永不抛错"使工位永远看不见故障（两种空不可区分）。 */
export interface StructuredSource {
  readonly name: string;
  /** 同步就绪判定（状态机跃迁判据不引入异步 —— quantumSense 方言） */
  isReady(): boolean;
  /** 提取区域内元素（中心落区即入区 —— 与 L2 detect 同律；region 缺省 = 全屏） */
  extract(region?: RegionSpec): Promise<Array<Pick<UIElement, 'role' | 'name' | 'state' | 'rect'>>>;
}

/** L2 传统视觉源（<50ms 预算域）：OCR / 目标检测。
 *  输入 = 区域归一化坐标，输出 = 区域内文字/控件元素（坐标已归一化）。
 *  返回 [] = 诚实空集；故障请抛错（同 L1 —— 工位 safeDetect 记 fault）。 */
export interface TraditionalVisionSource {
  readonly name: string;
  isReady(): boolean;
  detect(region: RegionSpec): Promise<Array<Pick<UIElement, 'role' | 'name' | 'rect'>>>;
}

/** L3 语义源（花钱层）：多模态大模型。只在 ceiling='L3' 时可被调用 ——
 *  花钱权治理：PerceptionRequest.funnelCeiling 是唯一闸门，工位无权自启。 */
export interface SemanticSource {
  readonly name: string;
  /** 就绪 = 可用（不存在同步态；缺席即不可兜底） */
  isReady(): boolean;
  /** 语义判断：针对区域的自然语言问题 → 元素集（问题来自 NeedGrounding.question） */
  ground(region: RegionSpec, question: string): Promise<Array<Pick<UIElement, 'role' | 'name' | 'rect'>>>;
}

/** 宿主执行通道：ExecutionStation 与宿主管线的适配器接口（四重门禁后的真实执行） */
export interface HostExecutor {
  /** 单动作执行 + 效果验证。永不抛错：失败入返回值（effectDetected=false / failure 在场） */
  execute(action: SandboxAction): Promise<Omit<ExecutionResult, 'seq' | 'rehearsed'>>;
}

/** D-5 沙箱引擎的工位侧最小视图（dsh-stubs 模式：只声明实际使用的表面） */
export interface SandboxStationView {
  rehearse(chain: { id: string; actions: SandboxAction[]; origin: 'cognition' | 'manual' }): Promise<{
    verdict: 'passed' | 'failed' | 'degraded' | 'aborted';
    reportPath: string;
  }>;
}

/** 决策工位的大模型通道（planner ChatFn 方言：注入而非绑定） */
export type DecideChatFn = (prompt: string) => Promise<string>;

// ─── Vision 工位：三级漏斗（骨架）───

export interface VisionStationOpts {
  structured: StructuredSource | null;   // L1（null = 源缺席，诚实跳过）
  traditional: TraditionalVisionSource | null; // L2
  semantic: SemanticSource | null;       // L3（ceiling 闸门 + 审计）
}

/**
 * 视觉感知工位默认实现 —— “我只描述，不判断”。
 * 三级漏斗纪律（蓝图铁律）：L1 命中 ⇒ 绝不启动 L2；L2 命中 ⇒ 绝不启动 L3；
 * L3 仅当 ceiling='L3'（中枢授权）才可用 —— 无授权而启动 = 越权花钱，工位无此代码路径。
 * Never-reject 契约：perceive 流永不 reject —— 故障化作 fault 空补丁。
 * 骨架诚实声明：流式分区间产出为最小实现（逐区 for-await 产出，无跨区并发）——
 * 真正的阶段重叠（扫描区 N 时决策消费区 N-1）由 pipeline.ts 的消费侧并行达成，
 * 工位侧只需保证 AsyncIterable 语义正确（骨架不伪造并发，诚实标注）。
 */
export class DefaultVisionStation implements VisionStation {
  private readonly opts: VisionStationOpts;

  // 显式字段赋值（非参数属性）：Node strip-only 运行时契约 —— 现世源码同方言
  constructor(opts: VisionStationOpts) {
    this.opts = opts;
  }

  async *perceive(env: AttentionEnvelope<'vision', PerceptionRequest>): AsyncIterable<ScenePatch> {
    const req = env.payload;
    // deadlineMs 是时长（pipeline 传 config.perceptionDeadlineMs）—— 先换算为绝对
    // 时刻再与 Date.now() 比较；直接比较会让任何正时长立即「超时」（漏斗全灭）
    const deadlineAt = req.deadlineMs === undefined ? Number.POSITIVE_INFINITY : Date.now() + req.deadlineMs;
    // 契约兜底（contracts.ts 立法）：空分区 = 默认全屏网格（1×1 单区）
    const regions = req.regions.length > 0
      ? req.regions
      : [{ id: 'g0x0', x: 0, y: 0, width: 1, height: 1 }];

    for (const region of regions) {
      if (Date.now() > deadlineAt) {
        // 超时是 fault（≠ 真空）：归因到授权漏斗深度 —— 丢弃 detail 会让超时
        // 补丁与真空不可区分（「两种空两种决策」契约被自己的超时路径打破）
        yield this.emptyPatch(region, req.funnelCeiling, 'perception deadline exceeded');
        continue;
      }
      // J 纪元修正：L1/L2 源故障改为「记 fault + 降层继续」。
      // 旧实现 fault 分支 `continue` 直接跳到下一个分区 —— 当前分区的
      // L2/L3 被跳过，与注释宣称的「降 L2 继续」矛盾；a11y 持续故障时
      // L2/OCR 永远不被尝试，区域补丁只带 L1 fault。
      let degradedFault: { source: 'L1' | 'L2'; detail: string } | undefined;
      // L1：结构化层（<1ms 预算域）
      if (this.opts.structured?.isReady()) {
        const { els, fault } = await this.safeExtract(region, this.opts.structured);
        if (els.length > 0) {
          yield this.patch(region, els, 'L1');
          continue; // 漏斗短路：L1 命中，绝不启动 L2
        }
        if (fault) degradedFault = { source: 'L1', detail: fault };
      }
      // L2：传统视觉层（<50ms 预算域）
      if (this.opts.traditional?.isReady()) {
        const { els, fault } = await this.safeDetect(region, this.opts.traditional);
        if (els.length > 0) {
          yield this.patch(region, els, 'L2');
          continue; // 漏斗短路：L2 命中，绝不启动 L3
        }
        if (fault) degradedFault = degradedFault ?? { source: 'L2', detail: fault };
      }
      // L3：语义层 —— 仅当中枢授权（ceiling='L3'）。工位无权自启（架构保证）
      if (req.funnelCeiling === 'L3' && this.opts.semantic?.isReady() && req.l3Reason) {
        const { els, fault } = await this.safeGround(region, this.opts.semantic, req.l3Reason);
        if (els.length > 0) {
          yield this.patch(region, els, 'L3');
          continue;
        }
        yield this.emptyPatch(region, 'L3', fault ?? 'semantic grounding returned no elements');
        continue;
      }
      // 三层皆空：诚实空补丁。fault 在场 = 源缺席/失败 ≠ 真空（决策工位两种空两种决策）
      yield degradedFault
        ? this.emptyPatch(region, degradedFault.source, degradedFault.detail)
        : this.emptyPatch(
            region,
            req.funnelCeiling === 'L3' ? 'L3' : 'L2',
            this.funnelFaultDetail(),
          );
    }
  }

  /** 源缺席/全失败的归因文案（诚实：说明哪层缺席，而非笼统 failed） */
  private funnelFaultDetail(): string {
    const l1 = this.opts.structured?.isReady() ? 'ready' : 'absent';
    const l2 = this.opts.traditional?.isReady() ? 'ready' : 'absent';
    return `all funnel layers empty (L1:${l1}, L2:${l2})`;
  }

  private patch(region: RegionSpec, els: Array<Pick<UIElement, 'role' | 'name' | 'state' | 'rect'>>, layer: 'L1' | 'L2' | 'L3'): ScenePatch {
    return {
      region,
      elements: els.map(e => ({
        source: layer === 'L1' ? 'L1-tree' : layer === 'L2' ? 'L2-ocr' : 'L3-vlm',
        role: e.role, name: e.name, state: e.state, rect: e.rect,
      })),
      funnelDepth: layer,
      capturedAt: Date.now(),
    };
  }

  private emptyPatch(region: RegionSpec, source: 'L1' | 'L2' | 'L3' | undefined, detail: string): ScenePatch {
    return {
      region, elements: [], funnelDepth: 'empty',
      fault: source ? { source, detail } : undefined,
      capturedAt: Date.now(),
    };
  }

  // 三源安全包装：源失败（契约违约抛错）⇒ 捕获为空集 + fault 归因 —— Never-reject 的上游防线。
  // 修复记录：早期实现把 fault 伪装成伪元素返回 —— 违反「fault 归因」契约
  // （失败空 ≠ 真空，两种空两种决策），已改为显式 fault 通道。
  private async safeExtract(region: RegionSpec, src: StructuredSource): Promise<{ els: Array<Pick<UIElement, 'role' | 'name' | 'state' | 'rect'>>; fault?: string }> {
    try { return { els: await src.extract(region) }; } catch (e: any) {
      return { els: [], fault: `L1 source fault: ${e?.message ?? 'extract failed'}` };
    }
  }
  private async safeDetect(region: RegionSpec, src: TraditionalVisionSource): Promise<{ els: Array<Pick<UIElement, 'role' | 'name' | 'state' | 'rect'>>; fault?: string }> {
    try { return { els: await src.detect(region) }; } catch (e: any) {
      return { els: [], fault: `L2 source fault: ${e?.message ?? 'detect failed'}` };
    }
  }
  private async safeGround(region: RegionSpec, src: SemanticSource, q: string): Promise<{ els: Array<Pick<UIElement, 'role' | 'name' | 'state' | 'rect'>>; fault?: string }> {
    try { return { els: await src.ground(region, q) }; } catch (e: any) {
      return { els: [], fault: `L3 source fault: ${e?.message ?? 'ground failed'}` };
    }
  }
}

// ─── Decision 工位：唯一的大脑（骨架）───

export interface DecisionStationOpts {
  /** 唯一大模型通道（P0-5：null = 通道缺席 —— decide 恒回 NeedGrounding 诚实降级。
   *  通道缺席是可降级状态而非异常：伪造必炸闭包（`() => { throw }`）是异常不诚实） */
  chat: DecideChatFn | null;
  /** 决策 prompt 模板（≤ 上下文预算；缺省 = 工位内置最小模板） */
  promptTemplate?: (ctx: DecisionContext, retryCtx?: FailureFeedback) => string;
}

/**
 * 决策规划工位默认实现 —— “唯一的大脑，唯一的花钱处”。
 * 输入信封：intent + ScenePatch[]（无截图字节 —— 像素永不进大脑）。
 * 输出契约：AtomicAction | NeedGrounding（JSON 判别收窄；解析失败 ⇒ NeedGrounding 诚实回退，
 * 绝不抛错毒化流水线 —— 重试语境由编排器管理）。
 */
export class DefaultDecisionStation implements DecisionStation {
  private readonly opts: DecisionStationOpts;

  // 显式字段赋值（非参数属性）：Node strip-only 运行时契约
  constructor(opts: DecisionStationOpts) {
    this.opts = opts;
  }

  /** 决策上下文 → 紧凑 prompt（Token 纪律：结构化元素表 ≤N 行，绝不内嵌散文背景） */
  buildPrompt(ctx: DecisionContext, retryCtx?: FailureFeedback): string {
    if (this.opts.promptTemplate) return this.opts.promptTemplate(ctx, retryCtx);
    const scene = ctx.scene
      .map(p => `[${p.region.id}] ${p.funnelDepth}: ` +
        p.elements.map(e => `${e.role}(${e.name})@${e.rect.x.toFixed(2)},${e.rect.y.toFixed(2)}`).join(' '))
      .join('\n');
    const retry = retryCtx ? `\nLAST FAILURE [seq ${retryCtx.seq}] ${retryCtx.kind}: ${retryCtx.detail}` : '';
    return `GOAL: ${ctx.intent.goal}\nCRITERIA: ${ctx.intent.successCriteria ?? '(none)'}\nSCENE:\n${scene}${retry}\n` +
      'OUTPUT (strict JSON): {"kind":"action","action":{...},"rationale":"..."} or ' +
      '{"kind":"need-grounding","regionId":"...","question":"..."}';
  }

  async decide(
    env: AttentionEnvelope<'decision', DecisionContext>,
    retryCtx?: FailureFeedback,
  ): Promise<DecisionOutput> {
    // P0-5：通道缺席 ⇒ NeedGrounding 诚实回退（信息缺口的最广义形态），绝不抛错
    if (!this.opts.chat) {
      return { kind: 'need-grounding', question: 'decision channel absent (cognition service not wired)' };
    }
    const prompt = this.buildPrompt(env.payload, retryCtx);
    let raw: string;
    try {
      raw = await this.opts.chat(prompt);
    } catch (e: any) {
      // 大模型通道故障：NeedGrounding 诚实回退（通道故障 = 信息缺口的最广义形态）
      return { kind: 'need-grounding', question: `decision channel fault: ${e?.message ?? 'unknown'}` };
    }
    return this.parse(raw);
  }

  /** 输出解析：JSON 判别收窄；任何解析失败 ⇒ NeedGrounding（运行层永不抛错） */
  private parse(raw: string): DecisionOutput {
    try {
      const m = JSON.stringify(JSON.parse(raw.trim())); // 语法校验
      const obj = JSON.parse(m) as any;
      if (obj?.kind === 'need-grounding' && typeof obj.question === 'string') {
        return { kind: 'need-grounding', regionId: obj.regionId, question: obj.question.slice(0, 120) };
      }
      if (obj?.kind === 'action' && obj.action && typeof obj.action.kind === 'string') {
        // 解析边界执法（动作词汇表唯一）：未知 kind / 畸形 args 在此拒绝 ——
        // 否则模型输出经 as 断言直通宿主执行器，失败被误归因为 host-error
        if (!SANDBOX_ACTION_KINDS.has(obj.action.kind) ||
            (obj.action.args !== undefined && (typeof obj.action.args !== 'object' || obj.action.args === null || Array.isArray(obj.action.args)))) {
          return { kind: 'need-grounding', question: `decision action rejected (kind '${obj.action.kind}' outside vocabulary or malformed args)` };
        }
        const a = obj.action as SandboxAction;
        return { ...a, rationale: String(obj.rationale ?? '').slice(0, 120) } as AtomicAction;
      }
    } catch { /* fallthrough to honest fallback */ }
    return { kind: 'need-grounding', question: 'decision output unparseable (non-JSON or missing discriminator)' };
  }
}

// ─── Execution 工位：零模型肌肉（骨架）───

export interface ExecutionStationOpts {
  sandbox: SandboxStationView | null;   // D-5 预演通道（null = 沙箱缺席，rehearseBeforeExecute 失效）
  host: HostExecutor | null;            // 宿主执行通道（null = 开发者预览，诚实失败）
  rehearseBeforeExecute: boolean;       // config 联动（DRILL, THEN DELIVER）
}

/**
 * 执行工位默认实现 —— “零模型肌肉”：AtomicAction 进，ExecutionResult 出。
 * 不思考为什么，不修正参数，不重试。D-5 预演优先（rehearseBeforeExecute）：
 * 预演 degraded/failed ⇒ gate-rejected 诚实上报（让大脑换方案，不让沙箱说谎）。
 * 本工位 tokenBudget 恒 0（信封类型层执法 —— 但工位仍如实计量，报告用）。
 */
export class DefaultExecutionStation implements ExecutionStation {
  private readonly opts: ExecutionStationOpts;

  // 显式字段赋值（非参数属性）：Node strip-only 运行时契约
  constructor(opts: ExecutionStationOpts) {
    this.opts = opts;
  }

  async execute(env: AttentionEnvelope<'execution', ExecutionOrder>): Promise<ExecutionResult> {
    const { seq, action, intentRef } = env.payload;
    const startAt = Date.now();
    const base = { seq, latencyMs: 0, rehearsed: false, rehearsalChainId: undefined as string | undefined };

    // D-5 预演闸门（DRILL, THEN DELIVER —— 沙箱是彩排，宿主是首演）
    if (this.opts.rehearseBeforeExecute && this.opts.sandbox) {
      // J 纪元修正：chain id 编入 intentRef —— 全库 doctor verdict 的 subject
      // 即 chainId；旧 id `chain-exec-${seq}` 在并发 run 下必然撞号，回执无法
      // 精确配对。链 id 经 ExecutionResult.rehearsalChainId 回流 AttemptRecord，
      // 供 D-4 判决补写按 subject 精确匹配。
      const chainId = `chain-exec-${intentRef ? `${intentRef}-` : ''}${seq}`;
      try {
        const o = await this.opts.sandbox.rehearse({
          id: chainId, actions: [action], origin: 'manual',
        });
        if (o.verdict === 'failed' || o.verdict === 'aborted') {
          // 排练**硬失败/中止**（有明确反证据或预算耗尽）⇒ 拒绝交付
          return {
            ...base, latencyMs: Date.now() - startAt,
            effectDetected: null,
            rehearsalChainId: chainId,
            failure: {
              kind: o.verdict === 'aborted' ? 'timeout' : 'sandbox-degraded',
              detail: `sandbox rehearsal ${o.verdict} (${o.reportPath})`,
            },
          };
        }
        // J 纪元修正：degraded = 排练跑完但验证层缺席（模拟器纪元常态，
        // D-5 引擎本纪元 verdict 恒 degraded —— 虚拟屏未实现是声明的留白）。
        // 「无证据」阻断**记忆固化**（D-5 侧 freeze-for-review），但不应阻断
        // 宿主执行 —— 旧实现 `verdict !== 'passed'` 一刀切，默认配置
        // （rehearseBeforeExecute=true 且 D-5 服务在场）下每个动作都死在
        // 预演闸门，流水线恒 failed。诚实形态：排练无法验证时照常交付，
        // 效果验证交宿主 settleAndVerify，rehearsed 不冒领（仅 passed 置真）。
        if (o.verdict === 'passed') base.rehearsed = true;
        base.rehearsalChainId = chainId;
      } catch {
        // 预演通道故障 = 不可判 ⇒ 诚实降级继续（沙箱缺席不是宿主的错）——
        // rehearsed 标记缺席，效果验证交宿主 settleAndVerify
      }
    }

    // 宿主执行（通道缺席 = 开发者预览：诚实失败优于虚假成功 —— orchestrator Actor 未接线先例）
    if (!this.opts.host) {
      return {
        ...base, latencyMs: Date.now() - startAt, effectDetected: null,
        failure: { kind: 'host-error', detail: 'no host executor wired (developer preview)' },
      };
    }
    try {
      const r = await this.opts.host.execute(action);
      return { ...base, ...r, latencyMs: Date.now() - startAt, rehearsed: base.rehearsed };
    } catch (e: any) {
      return {
        ...base, latencyMs: Date.now() - startAt, effectDetected: null,
        failure: { kind: 'host-error', detail: `host executor threw (contract breach): ${e?.message ?? 'unknown'}` },
      };
    }
  }
}
