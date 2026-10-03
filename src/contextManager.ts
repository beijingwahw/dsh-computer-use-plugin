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
import { journal } from './journal';
import { embed, cosine, type SparseVector } from './semanticHash';
import { hammingDistance, similarity } from './perceptualHash';
import { kernelRegistry } from './kernel/registry';
// W1-9：gazeRouter 纯函数（vlm/codec 无反向依赖 —— 依赖方向 context → vlm 单向）
import { gazeRouter, type GazeCandidate, type GazeDecision } from './vlm/codec';

/**
 * W1-9（P1 任务驱动注视）：任务锚点 —— 上一轮任务目标的屏幕位置记忆。
 * 供下次编码消费：normalized 是 encodeForVlm.foveaCenter 的直接方言
 * （源图归一化 [0,1]²）；bbox/center 保留像素系原值供点击层复核。
 */
export interface TaskAnchor {
  /** 源图像素系 bbox（记录时防御规整：倒置交换、压扁扩 1px、整数化） */
  bbox: { x0: number; y0: number; x1: number; y1: number };
  /** bbox 几何中心（源图像素，不取整 —— 取整权留给点击层） */
  center: { x: number; y: number };
  /** 源图归一化中心 [0,1]²（记录时给了 viewport 才在场；缺席 = 无法归一） */
  normalized?: { x: number; y: number };
  /** 锚点来源路（'grounding' | 'diff' | 'cursor'；自定义串原样保留 —— 路由器按已知路过滤） */
  route: string;
  /** 任务相关度 [0,1]（缺省 1 —— 路由先验即分数；目标已完成可下调） */
  taskRelevance?: number;
  capturedAt: number;
  /** 锚点指向的截图 id（可选 —— 与窗口内记录解耦） */
  screenshotId?: number;
}

/** W1-9：clamp 进 [0,1]（归一化坐标的防御收口；非有限按 0 记） */
function clampUnit(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

export interface ScreenshotRecord {
  id: number;
  timestamp: number;
  base64: string; // 仅最新几张保留图片数据；置空即「已降级」（空字符串天然 falsy）
  hash?: string; // 整屏 dHash 指纹（元数据，不占图片位）：变化门控与场景匹配的事实源
  textSummary?: string; // 旧截图降级后的文本描述（B-6 起含 OCR 遗像）
  // ── C-4 认知焦点引擎 ──
  /** 显著度 0~1：类型加权 × 任务相关 × 时间衰减。驱逐顺序的事实源 */
  salience?: number;
  /** 高显著度豁免驱逐（登录态/任务目标锚点等）。名额受 pinBudget 硬顶 */
  pinned?: boolean;
  /**
   * E-4 预测误差（第五维·信息热力学）：本帧与前一帧的指纹汉明距离 ——
   * 预测残差的离散度量。≥24/64 位（≈37.5% 位翻转 = 页面级跳变）的帧
   * 在显著度评估中获得加成：「世界刚剧变的那一帧」值得注意力优先驻留。
   * 首帧/无指纹 ⇒ 缺席（无前馈即无残差 —— 诚实缺席，不伪造基线）。
   */
  surpriseBits?: number;
  /**
   * S-6/Q-2：本帧 pHash 频谱指纹（截图入窗时一次铸就，与帧同生命周期）。
   * Δ-3 修正注记：潜意识条目的 scenePhash 从这里取 —— 旧实现驱逐时误用
   * lastPhash（驱逐时刻**新入帧**的 pHash），「死者」的遗像里存的是
   * 「目击者」的指纹：既视感的第二指从根上指错了帧（victim 与新帧的
   * pHash 几乎必然不同 ⇒ 双指共识几乎必然否决 ⇒ S-6 复核通道形同虚设）。
   */
  phash?: string;
}

/** C-4 潜意识元组：被驱逐记录的有损压缩残响。纯文本 + 硬容量，Token 消耗恒定 */
export interface SubconsciousTrace {
  /** 驱逐时的整屏 dHash —— 既视感（déjà-vu）匹配键 */
  sceneHash: string;
  /** ≤legacySummaryMaxChars 的遗像文本（B-6 OCR 已产出，零额外成本） */
  gist: string;
  createdAt: number;
  /** S 纪元（S-6）：pHash 第二指纹（缺席 = sharp 不可用时的单指回忆） */
  scenePhash?: string;
}

/** base64 字符数 → 近似 KB（data URL 前缀开销可忽略，预算用途足够精确） */
function approxKb(b64: string): number {
  return b64.length / 1024;
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
  /** 上一轮任务目标锚点（null = 无锚点 —— suggestFoveaCenter 自然少一路候选） */
  private taskAnchor: TaskAnchor | null = null;

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

  /** 生命周期规范：插件卸载时清空历史（由入口的 ctx.effect disposer 调用） */
  reset() {
    this.history = [];
    this.subconscious = [];
    this.taskQueryCache = null;
    this.taskAnchor = null; // W1-9：锚点随会话清空（新任务不继承旧注视）
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
    // E-4 预测残差加成：页面级跳变帧（≥24/64 位）+0.45（封顶 1）。基线帧
    // 0.8×0.5×1.0=0.4 被抬到 0.85 —— 跨过 0.8 钉扎线，世界剧变锚点获得
    // 与任务目标同级的钉扎优先权（预测处理理论：注意力跟随预测误差）。
    // 24 与 0.45 是算法形状字面量：24 位 ≈ 全屏 dHash 的页面级变化下界
    // （元素级反馈撑不满此距离，不误伤）；0.45 恰把满新近度基线抬过钉扎线。
    if ((record.surpriseBits ?? 0) >= 24) return Math.min(1, base + 0.45);
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
    // Δ-3：pHash 与帧同生（入窗即铸）—— 驱逐时潜意识条目取 victim 自己的第二指
    this.history.push({ id: newId, timestamp: newId, base64, hash, surpriseBits, phash: this.lastPhash ?? undefined });

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
      // 降级话术三要素：时间属性 + 原因 + 行为指引（+ 遗像内容）—— 防模型对已驱逐图产生幻觉或执着
      victim.textSummary =
        `[System Note: Screenshot #${victim.id} was taken earlier and has been cleared ` +
        `from memory to save context space. Rely on the most recent screenshots for current UI state.]` +
        (legacy ? ` Last visible text: ${legacy}` : '');
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
