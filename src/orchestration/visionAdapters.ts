// src/orchestration/visionAdapters.ts
// D-6 视觉源适配器（P1-4 落地）：把插件自身既有的视觉能力（uiExtractor 无障碍树 /
// textReader OCR）适配为 D-6 三级漏斗的 L1/L2 端口方言 —— D-3→中枢边从死线变为
// 「外部服务优先，内部能力回退，双缺席诚实降级」的三级供给。
// 产权纪律：端口类型 import orchestration/stations（D-6 主权）；能力模块 import
// 根空间（uiExtractor 纯 JS 可静态引入；textReader 依赖 sharp/tesseract 原生二进制
// —— 惰性动态引入，沙箱环境零污染 D-6 模块图）。
// 异常诚实（J 纪元修正）：适配器**不再吞错**——故障向上抛，由工位的 safe*
// 包装捕获并归因为 fault 补丁（「失败空 ≠ 真空」）。旧实现内部 catch 后返回
// []，工位看来是"层 ready 但真空"，fault 文案谎报 `L1:ready, L2:ready`，
// 归因链断裂；且 OCR 持续失败时每分区重试一次全屏 OCR（4 分区 = 4 次整屏）。
// 返回 [] 只保留一个语义：诚实空集（真的什么都没提取到）。
import type { RegionSpec, UIElement } from './contracts';
import type { StructuredSource, TraditionalVisionSource, SemanticSource } from './stations';
import {
  extractInteractiveElements, hasAccessibilityProvider,
} from '../uiExtractor';
import { isGlmConfigured, getGlmClient, type GlmClient } from '../vlm/glmClient';
// W5-4: SoM 类型面（type-only —— 零运行时足迹，D-6 模块图零污染；renderSomOverlay
// / assembleSomScores 运行时经动态引入，grounding/textReader 同款懒加载纪律）
import type { SomMarker, SomScoreSeed } from '../vlm/som';
// W2-0（C 接线）：Zoom 复核开关读内核注册表（宿主 index.ts 以 config.vlmZoomVerify
// 铸入 grounding.verifyZoom；未注册 ⇒ 回声 1=开 —— grounding.nmsIou 同款缺省律）
import { kernelRegistry } from '../kernel/registry';

/** 屏幕尺寸供给口（像素 → 归一化的除数源；真机由 system.getScreenSize 注入） */
export type ScreenSizeFn = () => Promise<{ width: number; height: number }>;

/** 像素 rect → 归一化 rect（StructuredSource 契约：坐标归一化责任在适配器） */
function normalizeRect(
  rect: { x: number; y: number; width: number; height: number },
  size: { width: number; height: number },
): UIElement['rect'] {
  return {
    x: rect.x / size.width,
    y: rect.y / size.height,
    width: rect.width / size.width,
    height: rect.height / size.height,
  };
}

/** 中心落区判定（L1/L2 同律）：半开 [x0, x1) —— 恰落在格线上的中心归属右侧
 *  分区；最右/最下边缘区（右/下界 = 1.0）例外闭合，防边缘元素被所有分区漏掉。
 *  与 knowledge/stations.dispatchElementsToGrid 的分派语义同源。 */
function centerInRegion(cx: number, cy: number, region: RegionSpec): boolean {
  const inX = cx >= region.x && (cx < region.x + region.width || region.x + region.width >= 1);
  const inY = cy >= region.y && (cy < region.y + region.height || region.y + region.height >= 1);
  return inX && inY;
}

// ─── L1 结构化源适配器：uiExtractor（无障碍树）→ StructuredSource ───

export interface StructuredAdapterOpts {
  /** 屏幕尺寸供给（像素坐标归一化的除数源）；缺席/故障 ⇒ extract 返回空集 */
  screenSize: ScreenSizeFn;
  /** 适配器审计名（工位 funnelFaultDetail 归因用） */
  name?: string;
}

/**
 * L1 适配器（<1ms 预算域的诚实边界：无障碍树提取本身 <1ms，屏幕尺寸查询是
 * 一次性异步开销）。就绪条件 = 宿主已注入 AccessibilityProvider
 * （setAccessibilityProvider —— uiExtractor 既有契约，本适配器不越权代注入）。
 */
export function createStructuredFromUiExtractor(opts: StructuredAdapterOpts): StructuredSource {
  return {
    name: opts.name ?? 'uiExtractor-a11y(L1-adapter)',
    isReady(): boolean {
      return hasAccessibilityProvider();
    },
    async extract(region?: RegionSpec): Promise<Array<Pick<UIElement, 'role' | 'name' | 'state' | 'rect'>>> {
      if (!hasAccessibilityProvider()) return [];
      // J 纪元修正：不再吞错 —— provider 抛错/尺寸查询失败向上抛，
      // 工位 safeExtract 记 fault 补丁（失败空 ≠ 真空，归因链不断裂）
      const [els, size] = await Promise.all([
        extractInteractiveElements(),
        opts.screenSize(),
      ]);
      const normalized = els.map(e => ({
        role: e.role,
        name: e.name,
        rect: normalizeRect(e.rect, size),
      }));
      // 区域过滤（中心落区即入区）：无障碍树是全屏提取 —— 不过滤会把整套
      // 元素重复贴进每个分区补丁（2×2 网格 = 每元素 4 份，决策 prompt 被污染）
      if (!region) return normalized;
      return normalized.filter(e =>
        centerInRegion(e.rect.x + e.rect.width / 2, e.rect.y + e.rect.height / 2, region));
    },
  };
}

// ─── L2 传统视觉源适配器：textReader（OCR）→ TraditionalVisionSource ───

export interface TraditionalAdapterOpts {
  /** 截屏供给（像素缓冲；真机由 system.captureScreen 注入） */
  capture: () => Promise<Buffer>;
  /** 屏幕尺寸供给（OCR 词框已是全屏归一化域 —— 尺寸仅作就绪审计） */
  screenSize: ScreenSizeFn;
  /** OCR 语言（textReader 缺省 'eng'） */
  lang?: string;
  /** 捕获+OCR 缓存窗口（一次扫描多分区共享一次全屏 OCR；缺省 1500ms 对齐 uiExtractor） */
  cacheTtlMs?: number;
}

/** OCR 全屏词缓存条目（多分区共享 —— L2 预算域的效率前提） */
interface OcrCache {
  at: number;
  words: Array<Pick<UIElement, 'role' | 'name' | 'rect'>>;
}

/**
 * L2 适配器（<50ms 预算域）：全屏 OCR 一次 + 分区词过滤（词中心落区即入区）。
 * 词框 bbox_normalized 已是全屏归一化域 —— 与 UIElement.rect 同域直通（零换算）。
 * tesseract/sharp 是原生二进制依赖 —— 惰性动态引入（首次 detect 才加载）。
 * J 纪元修正：故障向上抛（工位 safeDetect 记 fault），并带**负缓存** ——
 * OCR 持续失败时同一 TTL 窗口内不重复整屏截屏+OCR（旧实现 4 分区 = 4 次重试）。
 */
export function createTraditionalFromOcr(opts: TraditionalAdapterOpts): TraditionalVisionSource {
  const lang = opts.lang ?? 'eng';
  const ttl = opts.cacheTtlMs ?? 1500;
  let cache: OcrCache | null = null;
  let failCache: { at: number; error: Error } | null = null;

  async function ocrWords(): Promise<OcrCache['words']> {
    const now = Date.now();
    if (cache && now - cache.at < ttl) return cache.words;
    if (failCache && now - failCache.at < ttl) throw failCache.error; // 负缓存命中
    try {
      const { readText } = await import('../textReader');
      const buffer = await opts.capture();
      const result = await readText(buffer, lang);
      const words = result.words.map(w => ({
        role: 'text',
        name: w.text.slice(0, 20), // D-3 LABEL_MAX 先例：元素名 ≤20 字符
        rect: {
          x: w.bbox_normalized.x0,
          y: w.bbox_normalized.y0,
          width: w.bbox_normalized.x1 - w.bbox_normalized.x0,
          height: w.bbox_normalized.y1 - w.bbox_normalized.y0,
        },
      }));
      cache = { at: now, words };
      failCache = null;
      return words;
    } catch (e: any) {
      failCache = { at: now, error: e instanceof Error ? e : new Error(String(e)) };
      throw failCache.error;
    }
  }

  return {
    name: 'textReader-ocr(L2-adapter)',
    isReady(): boolean {
      return true; // capture 端口在场即就绪（结构就绪）；运行时故障在 detect 诚实归因
    },
    async detect(region: RegionSpec): Promise<Array<Pick<UIElement, 'role' | 'name' | 'rect'>>> {
      // J 纪元修正：不再吞错 —— OCR/截屏故障向上抛，工位记 fault 补丁
      const words = await ocrWords();
      // 词中心落区过滤（region 是归一化域 —— 与词框同域零换算；半开语义
      // 见 centerInRegion：格线中心不重复入区）
      return words.filter(w =>
        centerInRegion(w.rect.x + w.rect.width / 2, w.rect.y + w.rect.height / 2, region));
    },
  };
}

// ─── L3 语义源适配器：GLM-5.3-Flash 云脑皮层（grounding）→ SemanticSource ───

/**
 * W5-4: SoM 标记种子 —— 宿主把 L1/L2 元素与 interactivityProbe 判决以**数据面**
 * 注入（本适配器绝不 import interactivityProbe：其顶部拉 physicalBackend，会
 * 污染 D-6 模块图 —— som.ts 同款纪律）。bbox 为屏幕像素系，与 capture 缓冲
 * 同系 —— 这是叠加零换算坐标闭环的前提（overlay 同尺寸合成，见 applySparseSom）。
 */
export interface SomMarkerSeed {
  /** 屏幕像素包围盒（x1>x0、y1>y0；与 capture 缓冲/声明屏幕系同系） */
  bbox: { x0: number; y0: number; x1: number; y1: number };
  /** 元素可见文本（taskRelevance 的输入；缺席 = 无语义证据） */
  text?: string;
  /** interactivityProbe 判决置信 0..1（缺席 = 无交互证据） */
  probeConfidence?: number;
}

/**
 * W5-4: SoM 叠加事件（可观测面：元素数 / 预算 / 回退原因）—— 每次 ground 至多
 * 记一条。applied=false 时 reason 给出四路降级归因；degraded=true 表示「尝试过
 * 叠加但失败 ⇒ 原图直通」的诚实降级注记（区别于预算关/供给缺席的常态直通）。
 */
export interface SomPipelineEvent {
  /** true = 叠加成功，叠加图已替代原图进入编码 */
  applied: boolean;
  /** applied=false 时的回退归因 */
  reason?: 'budget-off' | 'marker-port-absent' | 'marker-source-fault' | 'elements-empty' | 'overlay-failed';
  /** true = 叠加尝试失败后原图直通（诚实降级注记） */
  degraded?: boolean;
  /** 本次生效预算（0 = 关；floor 语义与 renderSomOverlay 一致） */
  budget: number;
  /** 参与名额分派的种子数（区域过滤后；直通路径为 0） */
  elementsIn: number;
  /** 实际渲染的 marker id 序列（applied 时在场） */
  selected?: number[];
  /** 稀疏请求因证据缺席回退全量时为 true（renderSomOverlay.sparseFallback 透传） */
  sparseFallback?: boolean;
  /** 失败详情摘录（overlay-failed / marker-source-fault 时在场） */
  detail?: string;
}

export interface SemanticAdapterOpts {
  /** 截屏供给（像素缓冲；真机由 system.captureScreen 注入） */
  capture: () => Promise<Buffer>;
  /** 屏幕尺寸供给（groundElements 像素坐标 → UIElement 归一化坐标的除数源） */
  screenSize: ScreenSizeFn;
  /** 适配器审计名（工位 funnelFaultDetail 归因用） */
  name?: string;
  /** VLM client 注入（缺省走 getGlmClient() 全局单例；测试注入假 client 绝不联网） */
  client?: GlmClient;
  /** W2-0（C 接线）：Zoom 复核用 VLM 端口（W1-8 P3）—— 独立第二意见脑；缺省回落
   *  client / 已配置单例（同脑自任复核，流量受 grounding 任务级预算 8 次封顶） */
  verifyClient?: GlmClient;
  /**
   * W5-4: SoM 稀疏标注预算（Top-K 上限）。裁决序：显式入参 > 内核键
   * 'som.sparseBudget'（宿主以 config.somSparseBudget 铸入 —— grounding.verifyZoom
   * 同款配置通道）> 回声 0 = 关（缺省，与 config.somSparseBudget 缺省 0 一致）。
   * <=0 / 非有限 ⇒ 原图直通（逐字节现状）。
   */
  somSparseBudget?: number;
  /**
   * W5-4: SoM 标记种子供给口（L1/L2 元素 + probe 置信的数据面）。缺席 ⇒ 原图
   * 直通（证据链缺席不叠加）；返回空数组 ⇒ 同样直通（元素面为空）。供给口
   * 抛错 ⇒ 诚实降级直通（SoM 是增益不是依赖，防御式绝不抛）。
   */
  somMarkers?: () => Promise<readonly SomMarkerSeed[]>;
  /** W5-4: 叠加事件遥测回调（每次 ground 至多一条；回调抛错被吞 —— 遥测面绝不毒化主管线） */
  onSomEvent?: (ev: SomPipelineEvent) => void;
}

/**
 * L3 适配器（花钱层 —— 仅 ceiling='L3' 时工位才会调用，闸门主权在中枢）。
 * 就绪条件 = GLM 云脑已配置（isGlmConfigured：config 铸造的单例或环境变量）。
 * ground 管线：截全屏 → [W5-4] 稀疏 SoM 叠加（预算>0 且证据在场 ⇒ renderSomOverlay
 * 同尺寸合成，叠加图替代原图）→ groundElements（question 聚焦，坐标 = 屏幕像素系）
 * → 像素 bbox ÷ 屏幕尺寸归一化 → 中心落区过滤（与 L1/L2 同律）。
 * 故障约定与 L1/L2 同（J 纪元立法）：**故障向上抛** —— groundElements 的
 * ok:false（云脑失败/降级）转 throw，由工位 safeGround 捕获归因为
 * 'L3 source fault' 补丁（失败空 ≠ 真空）；ok:true 空 elements 是诚实空集，
 * 原样返回 []。
 *
 * W5-4 坐标闭环（叠加是视觉辅助，坐标仍以原图系为准）：renderSomOverlay 在
 * **同一 buffer 的元数据尺寸**上合成（SVG W×H = 原图尺寸、top/left=0、无裁剪
 * 无缩放）⇒ 叠加图与原图逐像素同尺寸 —— 模型在叠加图上作答的 bbox 天然就在
 * 原图像素系，groundElements 的 clamp/反算/本适配器的归一化全部沿用原图基准，
 * 零换算、零平移（测试 W5-4⑥ 四重闭环断言）。
 */
export function createSemanticFromVlm(
  opts: SemanticAdapterOpts,
): SemanticSource & { somEventLog(): readonly SomPipelineEvent[] } {
  // W5-4: 叠加事件账本（适配器级累积；somEventLog 防御拷贝读出）+ 遥测回调
  const somLog: SomPipelineEvent[] = [];
  const emitSom = (ev: SomPipelineEvent): void => {
    somLog.push(ev);
    try { opts.onSomEvent?.(ev); } catch { /* 遥测面绝不毒化主管线（防御式） */ }
  };

  /**
   * W5-4: 稀疏 SoM 叠加步（编码前挂点 —— groundElements 内部才走 encodeForVlm，
   * 此处替换进编码的 buffer 即「叠加图替代原图」）。幂等可降级四律 + 防御绝不抛：
   *   1. 预算 <=0 / 非有限 ⇒ 原图直通（budget-off；缺省路径，逐字节现状）；
   *   2. 种子供给口缺席（probe/元素证据链缺席）⇒ 直通（marker-port-absent）；
   *   3. 元素面为空（供给空/全脏/区域外全滤）⇒ 直通（elements-empty）；
   *   4. 叠加失败（sharp 缺席/解码失败/供给口抛错）⇒ 原图直通 + degraded 注记。
   * scores 组装：confidence = 种子随行的 probe 置信（缺席省略键），relevance =
   * taskRelevance(种子文本, question)—— assembleSomScores 纯函数成形。种子按
   * 中心落区过滤（与 L1/L2 同一分派律：预算花在当前扫描区）。routeLabels /
   * stableColors 随稀疏模式一并开（抗遮挡标签路由 + 跨帧稳定染色）。
   */
  async function applySparseSom(
    buffer: Buffer,
    size: { width: number; height: number },
    region: RegionSpec,
    question: string,
  ): Promise<Buffer> {
    // 预算裁决：显式入参 > 内核键 som.sparseBudget（config.somSparseBudget 的
    // 宿主铸入通道）> 回声 0。非法（NaN/±∞/负）一律按关处理 —— 配置错误不毒化管线。
    const rawOpt = opts.somSparseBudget;
    const budget = typeof rawOpt === 'number' && Number.isFinite(rawOpt)
      ? rawOpt
      : kernelRegistry.getOrDefault('som.sparseBudget', 0);
    if (!Number.isFinite(budget) || budget <= 0) {
      emitSom({ applied: false, reason: 'budget-off', budget: 0, elementsIn: 0 });
      return buffer;
    }
    if (typeof opts.somMarkers !== 'function') {
      emitSom({ applied: false, reason: 'marker-port-absent', budget, elementsIn: 0 });
      return buffer;
    }
    // 防御式绝不抛：供给口故障 / som 模块加载故障 / 渲染故障 ⇒ 原图直通 + degraded
    try {
      const supplied = await opts.somMarkers();
      const seeds: SomMarkerSeed[] = Array.isArray(supplied) ? supplied : [];
      // 种子规整 + 中心落区过滤（与 L1/L2 适配器同一分派语义）；脏种子跳过不毒化
      const markers: SomMarker[] = [];
      const scoreSeeds: SomScoreSeed[] = [];
      for (const s of seeds) {
        if (s === null || typeof s !== 'object') continue;
        const b = s.bbox;
        if (!b || ![b.x0, b.y0, b.x1, b.y1].every(Number.isFinite)) continue;
        if (!(b.x1 > b.x0) || !(b.y1 > b.y0)) continue;
        const cx = ((b.x0 + b.x1) / 2) / size.width;
        const cy = ((b.y0 + b.y1) / 2) / size.height;
        if (!centerInRegion(cx, cy, region)) continue;
        markers.push({
          id: markers.length + 1,
          bbox: { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 },
          center: { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 },
          ...(typeof s.text === 'string' && s.text !== '' ? { text: s.text } : {}),
        });
        // scores 种子与 marker 平行对齐（text/probeConfidence 原样随行；缺席证据
        // 的键省略语义由 assembleSomScores 收口 —— 无证据 ≠ 0 分）
        scoreSeeds.push({ text: s.text, probeConfidence: s.probeConfidence });
      }
      if (markers.length === 0) {
        emitSom({ applied: false, reason: 'elements-empty', budget, elementsIn: 0 });
        return buffer;
      }
      const { renderSomOverlay, assembleSomScores } = await import('../vlm/som');
      const scores = assembleSomScores(scoreSeeds, question);
      const res = await renderSomOverlay(buffer, {
        markers,
        scores,
        sparseBudget: budget,
        routeLabels: true,   // W5-4: 抗遮挡标签路由随稀疏模式一并开
        stableColors: true,  // W5-4: 跨帧稳定染色随稀疏模式一并开
      });
      if (res.ok && Buffer.isBuffer(res.buffer)) {
        emitSom({
          applied: true,
          budget,
          elementsIn: markers.length,
          selected: res.selected,
          ...(res.sparseFallback !== undefined ? { sparseFallback: res.sparseFallback } : {}),
        });
        return res.buffer;
      }
      emitSom({
        applied: false, reason: 'overlay-failed', degraded: true,
        budget, elementsIn: markers.length,
        ...(res.error ? { detail: res.error.slice(0, 200) } : {}),
      });
      return buffer;
    } catch (e) {
      // 供给口抛错 / som 模块图加载失败等未知异常 —— 诚实降级原图直通，绝不抛
      emitSom({
        applied: false, reason: 'marker-source-fault', degraded: true,
        budget, elementsIn: 0,
        detail: (e instanceof Error ? e.message : String(e)).slice(0, 200),
      });
      return buffer;
    }
  }

  const source: SemanticSource & { somEventLog(): readonly SomPipelineEvent[] } = {
    name: opts.name ?? 'glm-vision(L3-adapter)',
    isReady(): boolean {
      return isGlmConfigured();
    },
    /** W5-4: 叠加事件账本读出（防御拷贝 —— 观察面与账本解耦） */
    somEventLog(): readonly SomPipelineEvent[] {
      return [...somLog];
    },
    async ground(region: RegionSpec, question: string): Promise<Array<Pick<UIElement, 'role' | 'name' | 'rect'>>> {
      // 截屏 + 尺寸（任一故障向上抛 —— 工位记 fault，两种空两种决策）
      const [buffer, size] = await Promise.all([opts.capture(), opts.screenSize()]);
      if (!Number.isFinite(size.width) || size.width < 1 || !Number.isFinite(size.height) || size.height < 1) {
        throw new Error(`invalid screen size ${size.width}x${size.height}`);
      }
      // W5-4: 编码前稀疏 SoM 叠加（条件直通/降级见 applySparseSom；绝不抛 ——
      // 叠加失败时 groundElements 收到的仍是原图，行为与无 SoM 时逐字节一致）
      const groundBuffer = await applySparseSom(buffer, size, region, question);
      // 云脑接地：坐标语义 = width×height 屏幕像素系（groundElements 内部编码+规整+NMS）
      const { groundElements } = await import('../vlm/grounding');
      const result = await groundElements(groundBuffer, {
        width: size.width, height: size.height, question,
        ...(opts.client ? { client: opts.client } : {}),
        // W2-0（C 接线）：Zoom 复核端口（W1-8 P3）—— grounding.verifyZoom 内核键
        //（宿主以 config.vlmZoomVerify 铸入，缺省 1=开）控制；显式 verifyClient 优先，
        // 次选本适配器 client，再回落已配置单例（未配置 ⇒ 缺席 ⇒ port-absent 放行）。
        ...(kernelRegistry.getOrDefault('grounding.verifyZoom', 1) > 0.5
          ? {
              verifyClient:
                opts.verifyClient ??
                opts.client ??
                (isGlmConfigured() ? getGlmClient() : undefined),
            }
          : {}),
      });
      if (!result.ok) {
        throw new Error(result.error ?? 'vlm grounding failed');
      }
      // 像素 → 归一化 + 中心落区过滤（与 L1/L2 适配器同一分派语义）
      const normalized = result.elements.map(el => {
        const rect = {
          x: el.bbox.x0 / size.width,
          y: el.bbox.y0 / size.height,
          width: (el.bbox.x1 - el.bbox.x0) / size.width,
          height: (el.bbox.y1 - el.bbox.y0) / size.height,
        };
        return {
          role: el.role,
          name: el.label.slice(0, 20), // D-3 LABEL_MAX 先例：元素名 ≤20 字符
          rect,
        };
      });
      return normalized.filter(e =>
        centerInRegion(e.rect.x + e.rect.width / 2, e.rect.y + e.rect.height / 2, region));
    },
  };
  // W5-4: 适配器返回结构携带叠加事件账本读出面（SemanticSource 契约零变更 ——
  // 只加不自夺；既有消费方按 SemanticSource 面消费不受影响）
  return source;
}
