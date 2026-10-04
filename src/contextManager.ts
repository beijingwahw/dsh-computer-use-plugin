// src/contextManager.ts
// 上下文滑动窗口 —— 原项目质量最高的模块，核心逻辑原样保留：
//   有界记忆（N 张图）+ 无限历史（文字降级）+ 保序时间线 + 收缩全透明。
// 融合修复：media_type 不再硬编码 png，从 data URL 前缀解析真实类型；
//           新增 configure()/reset() 以符合 DSH 配置与生命周期规范。
// 创世纪：
//   B-6 遗像摘要 —— 驱逐前对旧图 OCR 中央区域，降级文本保留画面语义
//        （「墓志铭」→「遗像」：模型记得照片里有什么，而非只记得拍过照）。
//   B-7 体积硬预算 —— 张数之外新增累计 KB 上限，Token 溢出从概率事件变结构不可能。
//        双谓词共用同一不变量恢复循环：图片数超标 OR 体积超标，都驱逐最旧图。
// C-4 认知焦点引擎：
//   注意力机制 —— 显著度权重（类型×任务相关×新近度）驱动驱逐顺序，核心目标钉扎永生；
//   潜意识层 —— 被驱逐记录压缩为 (指纹, 要旨) 元组入有界池，场景重现时「灵光一闪」。
// W1-9（P1 任务驱动注视）：任务锚点缓存与注入面 —— 记录上一轮任务目标锚点
//   （grounding 命中/点击目标的 bbox），下次编码经 suggestFoveaCenter 组装三路
//   候选（锚点 + visualDiff 质心 + 光标）交 gazeRouter 加权，产出的归一化注视
//   中心直供 encodeForVlm 的 foveaCenter。参数式注入面：不读 config、不读注册表。
// W8-A5（DEBTS D-C3 增量编码消费方）：驱逐摘要改用增量编码产物 —— 开关
//   configureIncremental 缺省关；开 ⇒ 每帧入窗时经内部 ScreenStateLedger（或
//   调用方显式投喂 recordIncrementalDelta）铸帧间增量判决随记录入窗，驱逐时
//   增量几何（codec 补丁锚点/滚动向量/静默判决）以有界文本随墓志铭存活
//   （省 token + 保信息：图片走了，变化留下）。关 ⇒ 记录形状与驱逐文本与
//   现状逐字节一致（回归锁）。参数式开关：不读 config、不读注册表 —— 部署
//   决策（DEBTS D-C3「宿主编码层取投递产物」）降维成拨本开关。
import { journal } from './journal';
import { embed, cosine, type SparseVector } from './semanticHash';
import { hammingDistance, similarity } from './perceptualHash';
import { kernelRegistry } from './kernel/registry';
// W1-9：gazeRouter 纯函数（vlm/codec 无反向依赖 —— 依赖方向 context → vlm 单向）
import { gazeRouter, estimateVlmTokens, type GazeCandidate, type GazeDecision } from './vlm/codec';
// W8-A5：视觉状态账本（增量判决的生产机 —— visualDiff 不反向依赖本模块，无环）
import { ScreenStateLedger } from './visualDiff';

// W6-2（doctor smell.over-engineering 清偿）：记录类型与纯小函数已分区提取至
// contextManager.records.ts（行为零变化）；导入面不变 —— 再分发。
import {
  clampUnit, SURPRISE_BIT_FLOOR, approxKb,
  DEFAULT_INCREMENTAL_SUMMARY_CHARS, MIN_INCREMENTAL_SUMMARY_CHARS,
  cleanIncrementalDelta, incrementalEvictionSummary,
  type TaskAnchor, type ScreenshotRecord, type IncrementalDelta,
} from './contextManager.records';
export type { TaskAnchor, ScreenshotRecord, IncrementalDelta } from './contextManager.records';

/** C-4 潜意识元组：被驱逐记录的有损压缩残响。纯文本 + 硬容量，Token 消耗恒定 */
// W6-2：本接口按 epochS S-6「立法在源」锁定留守本文件。
export interface SubconsciousTrace {
  /** 驱逐时的整屏 dHash —— 既视感（déjà-vu）匹配键 */
  sceneHash: string;
  /** ≤legacySummaryMaxChars 的遗像文本（B-6 OCR 已产出，零额外成本） */
  gist: string;
  createdAt: number;
  /** S 纪元（S-6）：pHash 第二指纹（缺席 = sharp 不可用时的单指回忆） */
  scenePhash?: string;
}



class ContextManager {
  private history: ScreenshotRecord[] = [];
  private maxImageCount: number;
  private maxImageKb: number;              // B-7：累计体积硬预算
  private legacySummary: boolean;          // B-6：驱逐时是否生成遗像摘要
  private legacySummaryMaxChars: number;   // B-6：摘要字符预算
  private enableOcr: boolean;              // B-6：OCR 总开关（textReader 同源配置）
  // ── C-4 认知焦点引擎 ──
  private salienceFocus = true;            // 注意力开关（关 = 纯 FIFO，行为回归 B 世代）
  private pinBudget = 1;                   // 钉扎名额上限（防全钉扎击穿双预算）
  private subconscious: SubconsciousTrace[] = [];
  /** S-6：最近一帧的 pHash（既视感双指复核的第二指） */
  private lastPhash: string | null = null; // 潜意识池（有界双端队列）
  private subconsciousCapacity = 32;       // 池容量：32 × ≤200 字符 ≈ 6KB 封顶
  private subconsciousMatchDistance = 6;   // 既视感触发阈值（dHash 汉明距离）
  private taskQueryCache: { text: string; vec: SparseVector } | null = null; // 任务向量缓存
  // ── W1-9（P1 任务驱动注视）──
  /** 上一轮任务锚点（null = 无锚点 —— suggestFoveaCenter 自然少一路候选） */
  private taskAnchor: TaskAnchor | null = null;
  // ── W8-A5（DEBTS D-C3 增量编码消费方）──
  /** 增量消费总开关（缺省 false —— 关 = 本节全部行为缺席，驱逐文本与现状逐字节一致） */
  private incrementalEnabled = false;
  /** 驱逐摘要增补段字符预算（缺省 480 —— 容得下单条三系锚点；墓志铭从段的量级） */
  private incrementalSummaryMaxChars = DEFAULT_INCREMENTAL_SUMMARY_CHARS;
  /** 内部视觉状态账本（开启后首帧懒建 —— 差分判决的生产机；reset 归零） */
  private incrementalLedger: ScreenStateLedger | null = null;
  /** 显式投喂的待入账判决（单槽 —— 下一次 addScreenshot 消费，压过内部账本） */
  private pendingIncrementalDelta: IncrementalDelta | null = null;
  /** 收益遥测：入账帧数 / 判决附着数（分 kind）/ 驱逐摘要数 / 降级数 / 保住 token 估算 */
  private incrStats = {
    framesIngested: 0,
    deltasAttached: 0,
    byKind: { keyframe: 0, patch: 0, scroll: 0, silent: 0 } as Record<IncrementalDelta['kind'], number>,
    explicitFeeds: 0,
    evictionSummaries: 0,
    estVisualTokensPreserved: 0,
    degradedIngests: 0,
  };

  constructor(maxImageCount: number = 3) {
    this.maxImageCount = maxImageCount;
    this.maxImageKb = 600;
    this.legacySummary = true;
    this.legacySummaryMaxChars = 200;
    this.enableOcr = false;
  }

  /** DSH 配置规范：窗口宽度与体积预算由 cordis.yml 决定，而非代码常量 */
  configure(maxImageCount: number, maxImageKb?: number, legacySummary?: boolean, legacySummaryMaxChars?: number, enableOcr?: boolean) {
    this.maxImageCount = maxImageCount;
    if (maxImageKb !== undefined) this.maxImageKb = maxImageKb;
    if (legacySummary !== undefined) this.legacySummary = legacySummary;
    if (legacySummaryMaxChars !== undefined) this.legacySummaryMaxChars = legacySummaryMaxChars;
    if (enableOcr !== undefined) this.enableOcr = enableOcr;
  }

  /** C-4 配置：注意力引擎参数（cordis.yml 决定） */
  configureFocus(salienceFocus: boolean, pinBudget: number, subconsciousCapacity: number, subconsciousMatchDistance: number) {
    this.salienceFocus = salienceFocus;
    this.pinBudget = Math.max(0, pinBudget);
    this.subconsciousCapacity = Math.max(0, subconsciousCapacity);
    this.subconsciousMatchDistance = Math.max(0, subconsciousMatchDistance);
  }

  // ── W8-A5（DEBTS D-C3 增量编码消费方）：开关 / 投喂面 / 收益遥测 ──

  /**
   * W8-A5：增量编码消费开关 —— 本模块自有的参数式注入面（与 configureFocus
   * 同族；不读 config / 不读注册表 / 不依赖 index.ts 铸键）。
   * 开（enabled=true）⇒ 每次 addScreenshot：优先消费 recordIncrementalDelta
   * 显式投喂的判决，缺席则内部 ScreenStateLedger 对本帧真差分（sharp 480px
   * 管线 —— 与 autonomy/runtime 的账本同机不同例，各自独立开关互不干扰）；
   * 干净判决随记录入窗，驱逐时铸造增量摘要增补段。
   * 关（缺省）⇒ 上述全部缺席：不建账本、不解码、不附着、驱逐文本与现状
   * 逐字节一致（显式投喂也被丢弃 —— 单一开关辖制投喂与消费两面）。
   * summaryMaxChars：增补段字符预算（缺省 480；脏值回声缺省）。绝不抛。
   */
  configureIncremental(enabled: boolean, summaryMaxChars?: number) {
    this.incrementalEnabled = enabled === true;
    if (typeof summaryMaxChars === 'number' && Number.isFinite(summaryMaxChars) && summaryMaxChars >= MIN_INCREMENTAL_SUMMARY_CHARS) {
      this.incrementalSummaryMaxChars = Math.floor(summaryMaxChars);
    }
    if (!this.incrementalEnabled) this.pendingIncrementalDelta = null; // 关向即刻弃投喂（不跨开关泄漏）
  }

  /**
   * W8-A5：显式投喂增量判决 —— 下一次 addScreenshot 的帧间变化物料（参数式
   * 注入面，与 recordTaskAnchor 同族：宿主感知层/测试把账本判决交来即可，
   * 压过内部账本的自算 —— 调用方已有判决时不必重复差分）。
   * 入参宽入口（LedgerVerdict 形状或手工构造）：cleanIncrementalDelta 规整，
   * 脏值拒收返回 false（不猜、不抛）。单槽：重复投喂以最后一次为准。
   * 开关关 ⇒ 拒收返回 false（单一开关辖制投喂与消费两面 —— 杜绝陈旧判决
   * 跨开关存活、在错误帧上错位附着）。
   */
  recordIncrementalDelta(raw: unknown): boolean {
    if (!this.incrementalEnabled) return false;
    const cleaned = cleanIncrementalDelta(raw);
    if (!cleaned) return false;
    this.pendingIncrementalDelta = cleaned;
    this.incrStats.explicitFeeds += 1;
    return true;
  }

  /**
   * W8-A5：收益遥测快照（模块自有的仪表盘面 —— 与 imageCount/imageKb 同族的
   * Token 仪表盘扩展；防御副本）。estVisualTokensPreserved = 逐次驱逐摘要
   * 附带携带的源图视觉 token 估算之和（codec.estimateVlmTokens 现尺 ——
   * 「被驱逐图片的视觉 token 中，多少的变化几何在文本里活了下来」）。
   */
  incrementalDeltaStats(): {
    enabled: boolean;
    framesIngested: number;
    deltasAttached: number;
    byKind: Record<IncrementalDelta['kind'], number>;
    explicitFeeds: number;
    evictionSummaries: number;
    estVisualTokensPreserved: number;
    degradedIngests: number;
  } {
    return {
      enabled: this.incrementalEnabled,
      framesIngested: this.incrStats.framesIngested,
      deltasAttached: this.incrStats.deltasAttached,
      byKind: { ...this.incrStats.byKind },
      explicitFeeds: this.incrStats.explicitFeeds,
      evictionSummaries: this.incrStats.evictionSummaries,
      estVisualTokensPreserved: this.incrStats.estVisualTokensPreserved,
      degradedIngests: this.incrStats.degradedIngests,
    };
  }

  /**
   * W8-A5：本帧的增量判决求值（addScreenshot 内部调用 —— 开关开时）。
   * 优先级：显式投喂 > 内部账本真差分。防御式绝不抛：
   *   · data URL 前缀剥离后 base64 解码为空（脏输入）⇒ undefined + 降级计数；
   *   · 内部账本 ingest 抛错 / 判决带 degraded 注记（端口缺席/分析失败——
   *     账本自己申报「本次判断不可信」）⇒ undefined + 降级计数（诚实降级：
   *     无可信判决就不附着，驱逐摘要自然回退纯墓志铭语义）；
   *   · 判决干净 ⇒ cleanIncrementalDelta 规整后返回（维度从账本 prevDims 补全
   *     —— 锚点归一化换算与 token 估算的基准）。
   */
  private async resolveIncrementalDelta(dataUrl: string): Promise<IncrementalDelta | undefined> {
    try {
      // 显式投喂优先（调用方已有判决 ⇒ 免重复差分）；单槽即取即清
      if (this.pendingIncrementalDelta) {
        const fed = this.pendingIncrementalDelta;
        this.pendingIncrementalDelta = null;
        this.incrStats.framesIngested += 1;
        return fed;
      }
      const bare = dataUrl.replace(/^data:[^;]+;base64,/, '');
      const buf = Buffer.from(bare, 'base64');
      if (buf.length === 0) {
        this.incrStats.framesIngested += 1;
        this.incrStats.degradedIngests += 1;
        return undefined; // 脏 base64：无可信判决，不附着
      }
      if (!this.incrementalLedger) this.incrementalLedger = new ScreenStateLedger({}, {});
      const verdict = await this.incrementalLedger.ingest(buf);
      this.incrStats.framesIngested += 1;
      if (verdict.degraded) {
        this.incrStats.degradedIngests += 1;
        return undefined; // 账本自报不可信（端口缺席/分析失败）—— 诚实降级
      }
      const dims = this.incrementalLedger.stats().prevDims;
      const cleaned = cleanIncrementalDelta({
        kind: verdict.kind,
        changedPct: verdict.changedPct,
        patches: verdict.patches,
        scroll: verdict.scroll,
        generation: verdict.generation,
        ...(dims && dims.width >= 1 && dims.height >= 1
          ? { sourceWidth: dims.width, sourceHeight: dims.height } : {}),
      });
      if (!cleaned) {
        this.incrStats.degradedIngests += 1;
        return undefined;
      }
      return cleaned;
    } catch {
      this.incrStats.degradedIngests += 1;
      return undefined; // 增量是增益不是依赖：任何意外都不带崩截图主路径
    }
  }

  /** 生命周期规范：插件卸载时清空历史（由入口的 ctx.effect disposer 调用） */
  reset() {
    this.history = [];
    this.subconscious = [];
    this.taskQueryCache = null;
    this.taskAnchor = null; // W1-9：锚点随会话清空（新任务不继承旧注视）
    // W8-A5：增量面一并归零 —— 账本（会话边界：帧链不跨任务延续）、待投喂、
    // 收益遥测（与潜意识池同律：reset 即新会话的诚实起点）
    if (this.incrementalLedger) this.incrementalLedger.reset();
    this.pendingIncrementalDelta = null;
    this.incrStats = {
      framesIngested: 0,
      deltasAttached: 0,
      byKind: { keyframe: 0, patch: 0, scroll: 0, silent: 0 },
      explicitFeeds: 0,
      evictionSummaries: 0,
      estVisualTokensPreserved: 0,
      degradedIngests: 0,
    };
  }

  // ── W1-9（P1 任务驱动注视）：任务锚点缓存与注入面 ──

  /**
   * W1-9：记录上一轮任务目标锚点（下次编码消费的注视种子）。
   * 参数式注入面 —— 不读 config / 不读注册表：调用方（grounding 命中、点击
   * 目标确定）把目标 bbox + 视口尺寸交来即可。防御规整（绝不抛）：非对象 /
   * bbox 缺席 / 坐标非有限 ⇒ 拒收返回 false；倒置盒先交换；floor/ceil 整数化
   * 后压扁盒扩 1px；归一化中心仅在视口在场且 ≥1px 时计算（缺席 = normalized
   * 诚实缺席，suggestFoveaCenter 少这一路候选）。重复记录以最后一次为准。
   */
  recordTaskAnchor(anchor: {
    bbox: { x0: number; y0: number; x1: number; y1: number };
    viewport?: { width: number; height: number };
    route?: string;
    taskRelevance?: number;
    screenshotId?: number;
  }): boolean {
    try {
      const a = anchor as
        | {
          bbox?: unknown; viewport?: unknown; route?: unknown;
          taskRelevance?: unknown; screenshotId?: unknown;
        }
        | null
        | undefined;
      if (a === null || typeof a !== 'object') return false;
      const b = a.bbox as { x0?: unknown; y0?: unknown; x1?: unknown; y1?: unknown } | null | undefined;
      if (b === null || typeof b !== 'object') return false;
      const { x0, y0, x1, y1 } = b as Record<string, unknown>;
      if (![x0, y0, x1, y1].every(n => typeof n === 'number' && Number.isFinite(n))) return false;
      let rx0 = Math.floor(Math.min(x0 as number, x1 as number));
      let rx1 = Math.ceil(Math.max(x0 as number, x1 as number));
      let ry0 = Math.floor(Math.min(y0 as number, y1 as number));
      let ry1 = Math.ceil(Math.max(y0 as number, y1 as number));
      if (rx1 <= rx0) rx1 = rx0 + 1; // 压扁/压线盒扩 1px（无面积的盒没有几何身份）
      if (ry1 <= ry0) ry1 = ry0 + 1;
      const cx = (rx0 + rx1) / 2;
      const cy = (ry0 + ry1) / 2;
      const vp = a.viewport as { width?: unknown; height?: unknown } | null | undefined;
      const vpOk = vp !== null && typeof vp === 'object'
        && typeof vp.width === 'number' && Number.isFinite(vp.width) && (vp.width as number) >= 1
        && typeof vp.height === 'number' && Number.isFinite(vp.height) && (vp.height as number) >= 1;
      const rel = a.taskRelevance;
      const sid = a.screenshotId;
      const rec: TaskAnchor = {
        bbox: { x0: rx0, y0: ry0, x1: rx1, y1: ry1 },
        center: { x: cx, y: cy },
        route: typeof a.route === 'string' && a.route !== '' ? a.route : 'grounding',
        capturedAt: Date.now(),
        ...(vpOk ? {
          normalized: {
            x: clampUnit(cx / (vp!.width as number)),
            y: clampUnit(cy / (vp!.height as number)),
          },
        } : {}),
        ...(typeof rel === 'number' && Number.isFinite(rel) ? { taskRelevance: clampUnit(rel) } : {}),
        ...(typeof sid === 'number' && Number.isFinite(sid) && sid >= 0 ? { screenshotId: sid } : {}),
      };
      this.taskAnchor = rec;
      return true;
    } catch {
      return false; // 绝不抛：锚点缓存是增益不是依赖
    }
  }

  /** W1-9：读取上一轮任务锚点（防御副本；无锚点 = null） */
  getTaskAnchor(): TaskAnchor | null {
    if (!this.taskAnchor) return null;
    const a = this.taskAnchor;
    return {
      bbox: { ...a.bbox },
      center: { ...a.center },
      route: a.route,
      capturedAt: a.capturedAt,
      ...(a.normalized ? { normalized: { ...a.normalized } } : {}),
      ...(a.taskRelevance !== undefined ? { taskRelevance: a.taskRelevance } : {}),
      ...(a.screenshotId !== undefined ? { screenshotId: a.screenshotId } : {}),
    };
  }

  /** W1-9：显式清锚点（任务目标切换/完成 —— 旧注视不再引用） */
  clearTaskAnchor(): void {
    this.taskAnchor = null;
  }

  /**
   * W1-9（注入面）：组装三路候选交 gazeRouter 加权，产出下次编码的注视中心。
   * 候选路：缓存锚点（按其 route 归位，未知串按 grounding 语义 —— 锚点定义即
   * 「上一轮任务目标」）+ 可选 visualDiff 最大连通域质心（归一化方言直收）+
   * 可选光标（像素方言，须 viewport 在场归一 —— 缺席则该路诚实跳过）。
   * 纯组合：不编码、不落账、绝不抛；decision.center 即 encodeForVlm 的
   * foveaCenter 方言（源图归一化 [0,1]²），全缺席 ⇒ 几何中心回退（gazeRouter 兜底）。
   */
  suggestFoveaCenter(extra?: {
    diffCentroid?: { x: number; y: number };
    cursor?: { x: number; y: number };
    viewport?: { width: number; height: number };
  }): GazeDecision {
    const cands: GazeCandidate[] = [];
    const anchor = this.taskAnchor;
    if (anchor?.normalized) {
      const route: GazeCandidate['route'] =
        anchor.route === 'diff' || anchor.route === 'cursor' ? anchor.route : 'grounding';
      cands.push({
        route,
        center: { ...anchor.normalized },
        ...(anchor.taskRelevance !== undefined ? { taskRelevance: anchor.taskRelevance } : {}),
      });
    }
    const d = extra?.diffCentroid as { x?: unknown; y?: unknown } | undefined;
    if (d && typeof d === 'object'
      && typeof d.x === 'number' && Number.isFinite(d.x)
      && typeof d.y === 'number' && Number.isFinite(d.y)) {
      cands.push({ route: 'diff', center: { x: clampUnit(d.x), y: clampUnit(d.y) } });
    }
    const cur = extra?.cursor as { x?: unknown; y?: unknown } | undefined;
    const vp = extra?.viewport as { width?: unknown; height?: unknown } | undefined;
    const vpOk = vp !== null && typeof vp === 'object'
      && typeof vp.width === 'number' && Number.isFinite(vp.width) && (vp.width as number) >= 1
      && typeof vp.height === 'number' && Number.isFinite(vp.height) && (vp.height as number) >= 1;
    if (cur && typeof cur === 'object'
      && typeof cur.x === 'number' && Number.isFinite(cur.x)
      && typeof cur.y === 'number' && Number.isFinite(cur.y)
      && vpOk) {
      cands.push({
        route: 'cursor',
        center: {
          x: clampUnit((cur.x as number) / (vp!.width as number)),
          y: clampUnit((cur.y as number) / (vp!.height as number)),
        },
      });
    }
    return gazeRouter(cands);
  }

  /**
   * C-4 显著度评估：类型加权 × 任务相关度 × 时间衰减。
   * 任务相关度 = 旧图遗像/摘要与当前任务描述的语义余弦（C-2 地基供血）。
   * 无任务/无摘要 ⇒ 相关度取中位 0.5，退化为「类型 × 新近度」的弱焦点。
   */
  private assessSalience(record: ScreenshotRecord, now: number): number {
    // 类型加权：携带 OCR 遗像的记录信息密度高；纯墓志铭次之
    const typeWeight = record.textSummary?.includes('Last visible text:') ? 1.0 : 0.8;
    // 任务相关度：任务向量缓存（任务描述变更时重算，微秒级）
    let relevance = 0.5;
    const task = journal.currentTask();
    if (task && record.textSummary) {
      if (!this.taskQueryCache || this.taskQueryCache.text !== task) {
        this.taskQueryCache = { text: task, vec: embed(task) };
      }
      relevance = Math.max(0.2, cosine(embed(record.textSummary), this.taskQueryCache.vec));
    }
    // 时间衰减：半衰期 5 分钟 —— 「刚看过」的记忆天然更鲜活
    const ageMin = (now - record.timestamp) / 60_000;
    const recency = Math.exp(-ageMin / 5);
    const base = Math.round(typeWeight * relevance * (0.4 + 0.6 * recency) * 1000) / 1000;
    // E-4 预测残差加成：页面级跳变帧（≥SURPRISE_BIT_FLOOR/64 位）+0.45（封顶 1）。基线帧
    // 0.8×0.5×1.0=0.4 被抬到 0.85 —— 跨过 0.8 钉扎线，世界剧变锚点获得
    // 与任务目标同级的钉扎优先权（预测处理理论：注意力跟随预测误差）。
    // SURPRISE_BIT_FLOOR 与 0.45 是算法形状字面量：24 位 ≈ 全屏 dHash 的页面级变化下界
    // （元素级反馈撑不满此距离，不误伤）；0.45 恰把满新近度基线抬过钉扎线。
    if ((record.surpriseBits ?? 0) >= SURPRISE_BIT_FLOOR) return Math.min(1, base + 0.45);
    return base;
  }

  /**
   * C-4 钉扎决策：显著度 >= 0.8 且钉扎名额未满 ⇒ 钉扎。
   * 名额约束保证 while 驱逐循环必然终止（安全阀：全部被钉扎时逐最旧钉扎图）。
   */
  private refreshPins(): void {
    if (!this.salienceFocus) return;
    const now = Date.now();
    // J 纪元修正（钉扎名额泄漏）：先清"已降级仍钉扎"的僵尸名额 ——
    // 旧实现 pinnedCount 统计全部 history（含 base64 已清空的降级记录），
    // 但解钉分支只作用于仍有图的候选；安全阀驱逐过一张钉扎图后，
    // 该名额被永久占用（默认 pinBudget=1 ⇒ 从此任何图都无法再钉扎）。
    for (const h of this.history) {
      if (h.pinned && !h.base64) h.pinned = false; // 降级即解钉：钉扎是图像驻留机制
    }
    const candidates = this.history
      .filter(h => h.base64)
      .map(h => ({ h, s: this.assessSalience(h, now) }))
      .sort((a, b) => b.s - a.s);
    let pinnedCount = this.history.filter(h => h.pinned && h.base64).length;
    for (const { h, s } of candidates) {
      if (s >= 0.8 && pinnedCount < this.pinBudget) {
        if (!h.pinned) { h.pinned = true; pinnedCount++; }
      } else if (h.pinned && s < 0.5) {
        h.pinned = false; // 显著度衰减 ⇒ 解钉（焦点随任务漂移）
      }
      h.salience = s;
    }
  }

  /**
   * C-4 潜意识写入：驱逐时不丢弃，压缩为 (指纹, 要旨) 元组入池。
   * 池满逐最旧 —— 潜意识容量受硬顶，Token 消耗恒定。
   */
  private sinkToSubconscious(record: ScreenshotRecord, gist: string): void {
    if (!this.subconsciousCapacity || !record.hash) return;
    this.subconscious.push({
      sceneHash: record.hash,
      gist: gist.slice(0, this.legacySummaryMaxChars),
      createdAt: Date.now(),
      // S-6：双指纹的第二指 —— Δ-3：victim 入窗时自铸的 pHash（record.phash），
      // 绝非驱逐时刻新入帧的 lastPhash（凶案现场的指纹要取自死者，不是目击者）
      scenePhash: record.phash ?? undefined,
    });
    while (this.subconscious.length > this.subconsciousCapacity) this.subconscious.shift();
  }

  /**
   * C-4 既视感（灵光一闪）：新截图指纹与潜意识指纹汉明距离 ≤ 阈值 ⇒ 浮现提示。
   * 「看似忘记了，关键时刻又想起来」的工程实现 —— 零额外截图，纯指纹比对。
   */
  private flashback(newHash: string): string {
    if (!this.subconscious.length || !this.subconsciousMatchDistance) return '';
    let best: SubconsciousTrace | null = null;
    let bestDist = Infinity;
    for (const t of this.subconscious) {
      const d = hammingDistance(t.sceneHash, newHash);
      if (d < bestDist) { bestDist = d; best = t; }
    }
    if (best && bestDist <= this.subconsciousMatchDistance) {
      // S-6 双指共识：库存 pHash 在场 ⇒ 频谱域复核（相似度 ≥0.85 才闪）；
      // 任一指纹缺席 ⇒ 单指判定（既有语义，零回归）。
      // 纪元 Ξ（Ξ-D 生产接线）：复核门读内核注册表 —— ctx.flashbackSim（缺省
      // 0.85）。未注册 ⇒ getOrDefault 回声字面量，既视感判决逐字节不变。
      const flashbackSim = kernelRegistry.getOrDefault('ctx.flashbackSim', 0.85);
      if (best.scenePhash && this.lastPhash) {
        if (similarity(best.scenePhash, this.lastPhash) < flashbackSim) return '';
      }
      return ` [Flashback: a similar scene appeared before — ${best.gist.slice(0, 120)}]`;
    }
    return '';
  }

  /** 潜意识池快照（checkpoint 恢复用） */
  dumpSubconscious(): SubconsciousTrace[] {
    return [...this.subconscious];
  }

  restoreSubconscious(traces: SubconsciousTrace[] | undefined): void {
    if (!Array.isArray(traces)) return;
    // 容量 0 = 潜意识关闭：slice(-0) 会整表回灌（-0 === 0），必须显式清空
    this.subconscious = this.subconsciousCapacity > 0 ? traces.slice(-this.subconsciousCapacity) : [];
  }

  /**
   * 添加新截图并执行降级清理。
   * 返回 { currentId, message }：currentId 供状态锚点引用，message 直接喂给模型。
   * 注意（B-6）：驱逐时可异步生成 OCR 遗像，故本方法为 async。
   */
  public async addScreenshot(base64: string, hash?: string): Promise<{ currentId: number; message: string }> {
    // Date.now() 一值三用：唯一且单调递增的 id、timestamp、以及「id 升序 = 时间序」
    // 的隐含保证 —— 后文 find 取首个有图记录即最旧图，排序算法被彻底省略。
    // O 纪元（#22 残差根除）：同毫秒双截 ⇒ 纯 Date.now() 碰撞（锚点引用歧义）。
    // 混合逻辑时钟：max(墙上钟, lastId+1) —— 数值 id 三重语义全保留，碰撞时
    // +1ms 顶进（旧测试的 3ms tick 规避从此成为多余而非必需）。
    const newId = Math.max(Date.now(), (this.history[this.history.length - 1]?.id ?? 0) + 1);

    // C-4 既视感：新帧入窗前与潜意识比对（旧场景重现 ⇒ 灵光一闪）
    // S 纪元（S-6）：双指纹第二指 —— dHash 初中后以 pHash 复核（频谱域独立
    // 证据），压制同梯度不同内容的假灵光；sharp 缺席 ⇒ 单指回忆（零回归）。
    this.lastPhash = null;
    try {
      const { phash } = await import('./perceptualHash');
      // 入参方言是 data URL（全部调用方都拼 `data:image/...;base64,` 前缀）。
      // Buffer.from(x,'base64') 对前缀字符的宽容解码产出腐坏字节，sharp 必抛 ⇒
      // lastPhash 恒 null、S-6 双指复核沦为死代码 —— 先剥前缀再解码。
      const bare = base64.replace(/^data:[^;]+;base64,/, '');
      if (hash) this.lastPhash = await phash(Buffer.from(bare, 'base64'));
    } catch { this.lastPhash = null; }
    const dejaVu = hash ? this.flashback(hash) : '';
    // E-4 预测残差：与前一幅在窗图像的指纹距离（推送前计算 —— 前馈基准）。
    // 页面级跳变 ⇒ surpriseBits 入记录 ⇒ 显著度加成 + 钉扎资格（见 assessSalience）
    const prevHash = this.lastImageRecord()?.hash;
    const surpriseBits = hash && prevHash ? hammingDistance(prevHash, hash) : undefined;
    // W8-A5（D-C3 增量编码消费方）：开关开 ⇒ 求值本帧增量判决（显式投喂优先，
    // 缺席走内部账本真差分）随记录入窗；关 ⇒ undefined —— push 的条件展开为空，
    // 记录自身键集与现状逐字节一致（回归锁）。任何降级（脏 base64/账本自报
    // 不可信/意外异常）⇒ 不附着，驱逐摘要自然回退纯墓志铭语义。
    const incrementalDelta = this.incrementalEnabled
      ? await this.resolveIncrementalDelta(base64)
      : undefined;
    if (incrementalDelta) {
      this.incrStats.deltasAttached += 1;
      this.incrStats.byKind[incrementalDelta.kind] += 1;
    }
    // Δ-3：pHash 与帧同生（入窗即铸）—— 驱逐时潜意识条目取 victim 自己的第二指
    this.history.push({
      id: newId, timestamp: newId, base64, hash, surpriseBits, phash: this.lastPhash ?? undefined,
      ...(incrementalDelta ? { incrementalDelta } : {}),
    });

    // C-4 注意力刷新：显著度评估 + 钉扎决策（驱逐顺序的事实源）
    this.refreshPins();

    // 不变量恢复式驱逐（B-7 双谓词）：反复问「图片数或体积还超标吗」。
    // 即便未来一次 push 多张或图片尺寸剧变，这段逻辑无需修改依然正确。
    let evictedMessage = '';
    const totalKb = () => this.history.reduce((n, h) => n + (h.base64 ? approxKb(h.base64) : 0), 0);
    const imageCount = () => this.history.filter(h => h.base64).length;

    while (imageCount() > this.maxImageCount || totalKb() > this.maxImageKb) {
      // C-4 驱逐顺序进化：最低显著度的未钉扎图优先（FIFO 是 salienceFocus=false 的退化态）；
      // 安全阀：无未钉扎图可逐时逐最旧钉扎图 —— while 必然终止，双预算不变量不被击穿
      const pool = this.history.filter(h => h.base64 && !h.pinned);
      const victim = (this.salienceFocus && pool.length
        ? [...pool].sort((a, b) => (a.salience ?? 0.5) - (b.salience ?? 0.5))[0]
        : null) ?? this.history.find(h => h.base64);
      if (!victim) break; // 无图可逐：谓词已不可能满足（防御：异常巨量文本不在此预算内）
      // B-6 遗像：驱逐前尽力读屏中央带，降级文本携带画面语义
      const legacy = this.legacySummary && this.enableOcr
        ? await this.makeLegacySummary()
        : '';
      // W8-A5（D-C3 增量编码消费）：开关开且 victim 携带干净增量判决 ⇒ 铸造
      // 增补段（silent 恒同申报 / patch 补丁锚点 / scroll 滚动向量 / keyframe
      // 诚实申报无紧凑差分）—— codec.patchAnchorText 产物随文本存活。关或
      // 无判决 ⇒ 空串，墓志铭与现状逐字节一致（回归锁）。收益遥测：源图
      // 视觉 token 估算计入 estVisualTokensPreserved。
      const incrSegment = this.incrementalEnabled && victim.incrementalDelta
        ? incrementalEvictionSummary(victim.incrementalDelta, this.incrementalSummaryMaxChars)
        : '';
      if (incrSegment) {
        this.incrStats.evictionSummaries += 1;
        this.incrStats.estVisualTokensPreserved += estimateVlmTokens(
          victim.incrementalDelta!.sourceWidth ?? 0,
          victim.incrementalDelta!.sourceHeight ?? 0,
        );
      }
      // 降级话术三要素：时间属性 + 原因 + 行为指引（+ 遗像内容 + 增量增补段）
      // —— 防模型对已驱逐图产生幻觉或执着
      victim.textSummary =
        `[System Note: Screenshot #${victim.id} was taken earlier and has been cleared ` +
        `from memory to save context space. Rely on the most recent screenshots for current UI state.]` +
        (legacy ? ` Last visible text: ${legacy}` : '') +
        incrSegment;
      // C-4 潜意识沉淀：驱逐不等于遗忘 —— (指纹, 要旨) 压缩入潜意识池
      this.sinkToSubconscious(victim, legacy || victim.textSummary.slice(0, 60));
      victim.base64 = ''; // 释放内存；置空与谓词翻转原子地同时发生
      victim.pinned = false; // J 纪元：降级即解钉 —— 钉扎名额随图像一起释放
      evictedMessage += ' (Note: An older screenshot was cleared to prevent context overflow.)';
    }

    // 驱逐不静默：每次上下文收缩都对模型透明；既视感提示随行
    return {
      currentId: newId,
      message: `Screenshot #${newId} captured successfully.${evictedMessage}${dejaVu}`,
    };
  }

  /**
   * B-6 遗像摘要：读屏中央带（水平居中 60% / 垂直上 60%：标题栏+主内容区），
   * 截取前 N 字符。失败/禁用 ⇒ 空串（优雅回退到墓志铭现状）。
   * Δ-4 修正注记：旧实现直连 sharp+tesseract（两者均为 devDeps —— 生产环境
   * 必挂，遗像特性在生产恒空串，等于不存在）。改走 textReader.readTextAny
   * （服务端 L2 优先 + 60s 负缓存 + legacy 探针前置 —— 既有降级律全数继承）。
   * 语义注记：服务端读的是驱逐时刻的**活屏**中央带（victim 像素无服务端
   * 入口）；victim 至多落后 maxImageCount 帧，中央带形态（标题栏/主内容区）
   * 通常逐帧延续 —— 用 dev 环境逐像素的精确性换取生产环境的特性存活。
   */
  private async makeLegacySummary(): Promise<string> {
    try {
      const { readTextAny } = await import('./textReader');
      const { text } = await readTextAny({ x: 0.2, y: 0, width: 0.6, height: 0.6 });
      const flat = (text || '').replace(/\s+/g, ' ').trim();
      return flat ? flat.slice(0, this.legacySummaryMaxChars) : '';
    } catch {
      return ''; // OCR 不可用/失败：退化为通用墓志铭（零行为回归）
    }
  }

  /** 变化门控支持：最近一张仍在窗口内的图片记录（降级后无 base64 的不算） */
  public lastImageRecord(): ScreenshotRecord | undefined {
    return [...this.history].reverse().find(h => h.base64);
  }

  /** Token 仪表盘：当前窗口内真实图片数 */
  public imageCount(): number {
    return this.history.filter(h => h.base64).length;
  }

  /** Token 仪表盘（B-7）：当前窗口内图片累计 KB */
  public imageKb(): number {
    return Math.round(this.history.reduce((n, h) => n + (h.base64 ? approxKb(h.base64) : 0), 0));
  }

  /** 最近 n 张仍在窗口内的图片（旧→新），供差分等下游消费 */
  public recentImages(n: number): Array<{ id: number; base64: string }> {
    // n ≤ 0 必须返回空：slice(-0) === slice(0) 会整表泄漏（负数更会跳过头部）
    if (n <= 0) return [];
    return this.history.filter(h => h.base64).slice(-n).map(h => ({ id: h.id, base64: h.base64 }));
  }

  /**
   * 投影为模型线缆格式（Anthropic 多模态 content block）。
   * 存储模型与视图模型分离；for-of 保序输出 -> 降级占位符留在历史位置，时间线永不断裂。
   */
  public getContextForModel(): Array<{ type: string; [key: string]: any }> {
    const content: Array<{ type: string; [key: string]: any }> = [];
    for (const record of this.history) {
      if (record.base64) {
        // 从 data URL 解析真实 MIME 与裸 base64 —— 格式转换压缩到唯一一行、唯一一处
        const match = record.base64.match(/^data:([^;]+);base64,(.*)$/s);
        if (match) {
          content.push({
            type: 'image',
            source: { type: 'base64', media_type: match[1], data: match[2] },
          });
        }
      } else if (record.textSummary) {
        content.push({ type: 'text', text: record.textSummary });
      }
    }
    return content;
  }
}

// 单例是正确的：屏幕只有一块、会话只有一条，截图历史天然全局单份。
export const contextManager = new ContextManager(3);
