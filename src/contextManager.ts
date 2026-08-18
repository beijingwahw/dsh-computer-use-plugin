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
import { journal } from './journal';
import { embed, cosine, type SparseVector } from './semanticHash';
import { hammingDistance } from './perceptualHash';
export interface ScreenshotRecord {
  id: number;
  timestamp: number;
  base64: string; // 仅最新几张保留图片数据；置空即「已降级」（空字符串天然 falsy）
  hash?: string; // 整屏 dHash 指纹（元数据，不占图片位）：变化门控与场景匹配的事实源
  textSummary?: string; // 旧截图降级后的文本描述（B-6 起含 OCR 遗像）
  // ── C-4 认知焦点引擎 ──
  /** 显著度 0~1：类型加权 × 任务相关度 × 时间衰减。驱逐顺序的事实源 */
  salience?: number;
  /** 高显著度豁免驱逐（登录态/任务目标锚点等）。名额受 pinBudget 硬顶 */
  pinned?: boolean;
}

/** C-4 潜意识元组：被驱逐记录的有损压缩残响。纯文本 + 硬容量，Token 消耗恒定 */
export interface SubconsciousTrace {
  /** 驱逐时的整屏 dHash —— 既视感（déjà-vu）匹配键 */
  sceneHash: string;
  /** ≤legacySummaryMaxChars 的遗像文本（B-6 OCR 已产出，零额外成本） */
  gist: string;
  createdAt: number;
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
  private subconscious: SubconsciousTrace[] = []; // 潜意识池（有界双端队列）
  private subconsciousCapacity = 32;       // 池容量：32 × ≤200 字符 ≈ 6KB 封顶
  private subconsciousMatchDistance = 6;   // 既视感触发阈值（dHash 汉明距离）
  private taskQueryCache: { text: string; vec: SparseVector } | null = null; // 任务向量缓存

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
    return Math.round(typeWeight * relevance * (0.4 + 0.6 * recency) * 1000) / 1000;
  }

  /**
   * C-4 钉扎决策：显著度 >= 0.8 且钉扎名额未满 ⇒ 钉扎。
   * 名额约束保证 while 驱逐循环必然终止（安全阀：全部被钉扎时逐最旧钉扎图）。
   */
  private refreshPins(): void {
    if (!this.salienceFocus) return;
    const now = Date.now();
    const candidates = this.history
      .filter(h => h.base64)
      .map(h => ({ h, s: this.assessSalience(h, now) }))
      .sort((a, b) => b.s - a.s);
    let pinnedCount = this.history.filter(h => h.pinned).length;
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
    this.subconscious = traces.slice(-this.subconsciousCapacity);
  }

  /**
   * 添加新截图并执行降级清理。
   * 返回 { currentId, message }：currentId 供状态锚点引用，message 直接喂给模型。
   * 注意（B-6）：驱逐时可异步生成 OCR 遗像，故本方法为 async。
   */
  public async addScreenshot(base64: string, hash?: string): Promise<{ currentId: number; message: string }> {
    // Date.now() 一值三用：唯一且单调递增的 id、timestamp、以及「id 升序 = 时间序」
    // 的隐含保证 —— 后文 find 取首个有图记录即最旧图，排序算法被彻底省略。
    const newId = Date.now();

    // C-4 既视感：新帧入窗前与潜意识比对（旧场景重现 ⇒ 灵光一闪）
    const dejaVu = hash ? this.flashback(hash) : '';
    this.history.push({ id: newId, timestamp: newId, base64, hash });

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
      // B-6 遗像：驱逐前尽力 OCR 中央区域，降级文本携带画面语义
      const legacy = this.legacySummary && this.enableOcr
        ? await this.makeLegacySummary(victim.base64)
        : '';
      // 降级话术三要素：时间属性 + 原因 + 行为指引（+ 遗像内容）—— 防模型对已驱逐图产生幻觉或执着
      victim.textSummary =
        `[System Note: Screenshot #${victim.id} was taken earlier and has been cleared ` +
        `from memory to save context space. Rely on the most recent screenshots for current UI state.]` +
        (legacy ? ` Last visible text: ${legacy}` : '');
      // C-4 潜意识沉淀：驱逐不等于遗忘 —— (指纹, 要旨) 压缩入潜意识池
      this.sinkToSubconscious(victim, legacy || victim.textSummary.slice(0, 60));
      victim.base64 = ''; // 释放内存；置空与谓词翻转原子地同时发生
      evictedMessage += ' (Note: An older screenshot was cleared to prevent context overflow.)';
    }

    // 驱逐不静默：每次上下文收缩都对模型透明；既视感提示随行
    return {
      currentId: newId,
      message: `Screenshot #${newId} captured successfully.${evictedMessage}${dejaVu}`,
    };
  }

  /**
   * B-6 遗像摘要：对将驱逐图裁剪中央带（水平居中 60% / 垂直上 60%：标题栏+主内容区）
   * 放大后 OCR，截取前 N 字符。失败/禁用 ⇒ 空串（优雅回退到墓志铭现状）。
   * 延迟导入避免启动期加载 OCR worker 与 sharp。
   */
  private async makeLegacySummary(dataUrl: string): Promise<string> {
    try {
      const b64 = dataUrl.split(',')[1];
      if (!b64) return '';
      const [{ readText }, sharpMod] = await Promise.all([
        import('./textReader'),
        import('sharp'),
      ]);
      const sharp = sharpMod.default;
      const buf = Buffer.from(b64, 'base64');
      const meta = await sharp(buf).metadata();
      const W = meta.width ?? 0, H = meta.height ?? 0;
      if (W < 32 || H < 32) return '';
      const left = Math.round(W * 0.2);
      const width = Math.round(W * 0.6);
      const height = Math.round(H * 0.6);
      const crop = await sharp(buf)
        .extract({ left, top: 0, width, height })
        .resize({ width: 1000 }) // 放大识别：小字准确率关键
        .toBuffer();
      const { text } = await readText(crop);
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
