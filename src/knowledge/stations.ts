// src/knowledge/stations.ts
// D-7 三工位桩（Stub）—— 绝对专注的物理载体：
//   视觉工位只描述不判断；决策工位是唯一大脑（唯一花钱处）；执行工位是零模型肌肉。
// 零侵入红线：本文件不含真 OCR / 真坐标控制 / 真大模型调用 ——
//   真机源经适配器端口（Port）注入，端口缺席 = 诚实降级（fault 补丁 / NeedGrounding /
//   host-error），绝不伪造成功。桩纪元的失败是有结构的失败。
// 异常诚实分层契约：构造器 = 加载层（throw 合法）；运行方法 = 永不抛错，结构化降级。
import type {
  AttentionEnvelope, AtomicAction, DecisionContext, ExecutionResult, FailureFeedback,
  NeedGrounding, PerceptionRequest, ScenePatch,
  VisionStation, DecisionStation, ExecutionStation,
} from './contracts';
import type { RegionSpec } from '../orchestration/contracts';

// ─── 适配器端口（真机源的唯一注入口 —— index.ts 接线，本文件零二进制依赖）───

/** 视觉真机源端口：屏幕 → ScenePatch[]（坐标归一化责任在适配器） */
export interface SceneSourcePort {
  /** 源标识（审计用；探测侧可缺席 —— name 缺席不构成端口非法） */
  readonly name?: string;
  perceive(req: PerceptionRequest): Promise<ScenePatch[]>;
}

/** 决策工位的大模型通道（planner ChatFn 方言：注入而非绑定） */
export type DecisionChatFn = (prompt: string) => Promise<string>;

/** 宿主执行端口：AtomicAction → 执行回执（action 由工位内联回显，端口不重复携带） */
export interface HostExecutePort {
  /** 端口标识（审计用；探测侧可缺席 —— name 缺席不构成端口非法） */
  readonly name?: string;
  execute(action: AtomicAction): Promise<Omit<ExecutionResult, 'action' | 'durationMs'>>;
}

// ─── 网格分区铸造（'g{col}x{row}' —— D-6 坐标同一性方案复刻，跨轮稳定）───

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

/** 故障补丁铸造：扫描失败 ≠ 真空（两种空，两种决策 —— 对齐 D-6 ScenePatch.fault 契约） */
function faultPatches(grid: { cols: number; rows: number }, detail: string): ScenePatch[] {
  const capturedAt = Date.now();
  return gridRegions(grid).map(region => ({
    region,
    elements: [],
    funnelDepth: 'empty' as const,
    fault: { source: 'L1' as const, detail },
    capturedAt,
  }));
}

// ─── Vision 工位桩：「我只描述，不判断」───

export interface StubVisionStationOpts {
  /** 真机源（null = 桩纪元：全分区 fault 补丁，诚实降级） */
  source: SceneSourcePort | null;
}

// ─── 能力回退场景源（P1-4 适配器落地）：插件自身视觉能力 → SceneSourcePort ───

/** 能力场景源供给口（真机由 system.getScreenSize / system.captureScreen 注入） */
export interface CapabilitySceneOpts {
  screenSize: () => Promise<{ width: number; height: number }>;
  capture: () => Promise<Buffer>;
  /** OCR 语言（缺省 'eng'） */
  lang?: string;
}

/**
 * 能力回退场景源（P1-4）：'dsh.vision.station' 外部服务缺席时，用插件自身
 * 视觉能力顶上 —— L1 无障碍树优先（uiExtractor 纯 JS 静态引入），
 * L1 不可用/为空 ⇒ L2 全屏 OCR（textReader 惰性动态引入 —— 原生依赖隔离，
 * 沙箱环境零污染）分派到网格分区。双缺席 ⇒ 抛错（工位 catch 转 fault 补丁
 * —— 「看不见」是 fault，不是真空）。
 * 元素 rect 归一化域 = 全屏（像素 ÷ 屏幕尺寸 —— 归一化责任在适配器）。
 */
export async function createCapabilitySceneSource(opts: CapabilitySceneOpts): Promise<SceneSourcePort> {
  const { extractInteractiveElements, hasAccessibilityProvider } = await import('../uiExtractor');

  async function l1Elements(): Promise<Array<{ role: string; name: string; rect: ScenePatch['elements'][number]['rect'] }>> {
    if (!hasAccessibilityProvider()) return [];
    try {
      const [els, size] = await Promise.all([extractInteractiveElements(), opts.screenSize()]);
      return els.map(e => ({
        role: e.role,
        name: e.name,
        rect: {
          x: e.rect.x / size.width, y: e.rect.y / size.height,
          width: e.rect.width / size.width, height: e.rect.height / size.height,
        },
      }));
    } catch {
      return []; // provider 违约 ⇒ 空集（降 L2，绝不毒化）
    }
  }

  async function l2Elements(): Promise<Array<{ role: string; name: string; rect: ScenePatch['elements'][number]['rect'] }>> {
    try {
      const { readText } = await import('../textReader');
      const buffer = await opts.capture();
      const ocr = await readText(buffer, opts.lang ?? 'eng');
      return ocr.words.map(w => ({
        role: 'text',
        name: w.text.slice(0, 20), // D-3 LABEL_MAX 先例
        rect: {
          x: w.bbox_normalized.x0, y: w.bbox_normalized.y0,
          width: w.bbox_normalized.x1 - w.bbox_normalized.x0,
          height: w.bbox_normalized.y1 - w.bbox_normalized.y0,
        },
      }));
    } catch {
      return []; // OCR/截屏故障 ⇒ 空集（双缺席 ⇒ 抛错转 fault）
    }
  }

  return {
    name: 'capability-scene(L1-a11y>L2-ocr)',
    async perceive(req: PerceptionRequest): Promise<ScenePatch[]> {
      let els = await l1Elements();
      let depth: 'L1' | 'L2' = 'L1';
      if (els.length === 0) {
        els = await l2Elements();
        depth = 'L2';
      }
      if (els.length === 0) {
        throw new Error('no vision capability available (a11y provider absent + OCR/capture failed)');
      }
      // 网格分派（元素中心落区即入区 —— 'g{col}x{row}' 坐标同一性方言）
      const { cols, rows } = req.grid;
      const capturedAt = Date.now();
      const patches: ScenePatch[] = [];
      for (let col = 0; col < cols; col++) {
        for (let row = 0; row < rows; row++) {
          const region: RegionSpec = {
            id: `g${col}x${row}`,
            x: col / cols, y: row / rows, width: 1 / cols, height: 1 / rows,
          };
          const inRegion = els.filter(e =>
            e.rect.x + e.rect.width / 2 >= region.x &&
            e.rect.x + e.rect.width / 2 <= region.x + region.width &&
            e.rect.y + e.rect.height / 2 >= region.y &&
            e.rect.y + e.rect.height / 2 <= region.y + region.height,
          );
          patches.push({
            region,
            elements: inRegion.map(e => ({ source: depth === 'L1' ? 'L1-tree' : 'L2-ocr', ...e })),
            funnelDepth: inRegion.length > 0 ? depth : 'empty',
            capturedAt,
          });
        }
      }
      return patches;
    },
  };
}

/**
 * 视觉感知工位桩。forceL3 是语义授权标志 —— 桩纪元无 L3 通道，授权只被记录
 * 不被消费（诚实：无代码路径假装跑了大模型）。信封 tokenBudget 仅 L3 可动用，
 * 桩纪元恒不消耗。
 */
export class StubVisionStation implements VisionStation {
  private readonly opts: StubVisionStationOpts;

  // 显式字段赋值（非参数属性）：Node strip-only 运行时契约 —— 现世源码同方言
  constructor(opts: StubVisionStationOpts) {
    this.opts = opts;
  }

  async perceive(env: AttentionEnvelope<'vision', PerceptionRequest>): Promise<ScenePatch[]> {
    const req = env.payload;
    if (!this.opts.source) {
      return faultPatches(req.grid, 'no scene source wired (stub era — honest degradation)');
    }
    try {
      const patches = await this.opts.source.perceive(req);
      return Array.isArray(patches) ? patches : [];
    } catch (e: unknown) {
      // 端口契约违约（抛错）⇒ fault 补丁归因，绝不毒化流水线
      const msg = e instanceof Error ? e.message : String(e);
      return faultPatches(req.grid, `scene source fault: ${msg}`);
    }
  }
}

// ─── Decision 工位桩：「唯一的大脑，唯一的花钱处」───

export interface StubDecisionStationOpts {
  /** 大模型通道（null = 桩纪元：恒回 NeedGrounding，诚实降级不伪造决策） */
  chat: DecisionChatFn | null;
}

/**
 * 决策规划工位桩。输入信封 = DecisionContext（intent + scene + 隐知识注入 ≤300 字符）。
 * 输出契约：AtomicAction | NeedGrounding（D-7 方言：reason/focus 判别，无 kind 字段）。
 * 通道故障 / 解析失败 ⇒ NeedGrounding 诚实回退 —— 绝不抛错毒化流水线。
 */
export class StubDecisionStation implements DecisionStation {
  private readonly opts: StubDecisionStationOpts;

  constructor(opts: StubDecisionStationOpts) {
    this.opts = opts;
  }

  /** 决策上下文 → 紧凑 prompt（Token 纪律：结构化场景表 + 隐知识摘要，零散文背景） */
  buildPrompt(ctx: DecisionContext, retryCtx?: FailureFeedback): string {
    const scene = ctx.scene
      .map(p => `[${p.region.id}] ${p.funnelDepth}: ` +
        p.elements.map(e => `${e.role}(${e.name})@${e.rect.x.toFixed(2)},${e.rect.y.toFixed(2)}`).join(' '))
      .join('\n');
    const knowledge = ctx.knowledgeContext
      ? `\nTACIT KNOWLEDGE (conf ${ctx.knowledgeContext.maxConfidence.toFixed(2)}): ${ctx.knowledgeContext.summary}`
      : '';
    const retry = retryCtx ? `\nLAST FAILURE (retry ${retryCtx.retryCount}): ${retryCtx.reason}` : '';
    const prev = ctx.previousResults?.length
      ? `\nPREVIOUS RESULTS: ${ctx.previousResults.map(r => `${r.action.kind}=${r.status}`).join(', ')}`
      : '';
    return `GOAL: ${ctx.intent.description}${knowledge}${prev}${retry}\nSCENE:\n${scene}\n` +
      'OUTPUT (strict JSON): {"type":"action","action":{"kind":"click_mouse|type_text|...","args":{...}},"rationale":"..."} ' +
      'or {"type":"need-grounding","reason":"...","focus":"..."}';
  }

  async decide(
    env: AttentionEnvelope<'decision', DecisionContext>,
    retryCtx?: FailureFeedback,
  ): Promise<AtomicAction | NeedGrounding> {
    if (!this.opts.chat) {
      return { reason: 'no decision channel wired (stub era — honest degradation)', focus: 'full-scene' };
    }
    let raw: string;
    try {
      raw = await this.opts.chat(this.buildPrompt(env.payload, retryCtx));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return { reason: `decision channel fault: ${msg}`, focus: 'full-scene' };
    }
    return this.parse(raw);
  }

  /** 输出解析：JSON 判别收窄；任何失败 ⇒ NeedGrounding（运行层永不抛错） */
  private parse(raw: string): AtomicAction | NeedGrounding {
    try {
      const obj = JSON.parse(raw.trim()) as Record<string, unknown>;
      if (obj?.type === 'need-grounding' && typeof obj.reason === 'string') {
        return { reason: obj.reason.slice(0, 120), focus: String(obj.focus ?? 'full-scene').slice(0, 120) };
      }
      if (obj?.type === 'action' && obj.action && typeof (obj.action as any).kind === 'string') {
        const action = obj.action as AtomicAction;
        return { ...action, rationale: String(obj.rationale ?? '').slice(0, 120) };
      }
    } catch { /* fallthrough：诚实回退 */ }
    return { reason: 'decision output unparseable (non-JSON or missing discriminator)', focus: 'full-scene' };
  }
}

// ─── Execution 工位桩：「零模型肌肉」───

export interface StubExecutionStationOpts {
  /** 宿主执行端口（null = 桩纪元：host-error 诚实失败，绝不伪造 success） */
  host: HostExecutePort | null;
}

/**
 * 执行工位桩。不思考为什么，不修正参数，不重试 —— AtomicAction 进，ExecutionResult 出。
 * action 内联回显（D-7 方言）：Outcome 打包无需二次查表。
 */
export class StubExecutionStation implements ExecutionStation {
  private readonly opts: StubExecutionStationOpts;

  constructor(opts: StubExecutionStationOpts) {
    this.opts = opts;
  }

  async execute(env: AttentionEnvelope<'execution', AtomicAction>): Promise<ExecutionResult> {
    const action = env.payload;
    const startedAt = Date.now();
    if (!this.opts.host) {
      return {
        action,
        status: 'failure',
        durationMs: Date.now() - startedAt,
        failure: { kind: 'host-error', detail: 'no host executor wired (stub era — honest degradation)' },
      };
    }
    try {
      const r = await this.opts.host.execute(action);
      return { action, ...r, durationMs: Date.now() - startedAt };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        action,
        status: 'failure',
        durationMs: Date.now() - startedAt,
        failure: { kind: 'host-error', detail: `host executor threw (contract breach): ${msg}` },
      };
    }
  }
}
