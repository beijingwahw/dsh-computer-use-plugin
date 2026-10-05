// src/autonomy/runtime.perceive.ts
// W8-B2（doctor smell.over-engineering 清偿 · D-F2 千行文件群）：自 runtime.ts
// 低风险分区提取 —— 感知铸造厂（createPerceive + 缺省词级 OCR + 缺省云脑接地
// 工厂）。闭包状态全部以参数织成（无环内共享可变状态），可整体搬迁；逐字节
// 保持判决语义；runtime.ts 以再导出保持导入面不变。
// 本文件两处 W8-B2 终态接线（行为面均为「缺席/关 ⇒ 逐字节旧路径」）：
//   ① makeDefaultGroundVlm 透传 RuntimeDeps.verifyTaskId → groundElements
//      opts.verifyTaskId（复核预算任务作用域化 —— 与跑环边界 reset 同键闭环）；
//   ② 增量账本消费段把 LedgerVerdict 显式投喂 contextManager.recordIncrementalDelta
//      （W8-A5 备好的投喂面 —— 开关关时拒收 = 零行为；开启时省内部账本重复差分）。
import * as backend from '../physicalBackend';
import { getSharp } from '../_legacyDeps';
import { dhash } from '../perceptualHash';
import { readText, readTextAny } from '../textReader';
import { getGlmClient, isGlmConfigured, type GlmClient } from '../vlm/glmClient';
import { groundElements } from '../vlm/grounding';
import type { GroundedElement } from '../vlm/grounding';
import type { LocalElement } from '../vlm/arbitration';
import { composeSnapshot, snapshotChanged, type WorldSnapshot } from './worldSnapshot';
import { SceneSemanticsCache } from './sceneSemantics';
import { kernelRegistry } from '../kernel/registry';
import { contextManager } from '../contextManager';
// ΠΑΝ-57（生产 popup 供方）：popupDetector 的纯函数面 —— 几何启发式 + 施密特
// 迟滞滤波器（src 根既有器官，import 零环：popupDetector 不依赖 autonomy）。
import { detectPopupHeuristic, SchmittPopupFilter } from '../popupDetector';
// W4-1（顺带接线）：增量账本消费 —— ScreenStateLedger.ingest → deliverIncremental
import { ScreenStateLedger, incrementalEncodingEnabled } from '../visualDiff';
import { deliverIncremental, type IncrementalDelivery } from '../imageDelivery';
import type { RuntimeDeps } from './runtime.deps';
import type { RuntimeWord } from './runtime.types';
import { clamp01 } from './runtime.utils';
import { w1HashDistance } from './runtime.verdict';

// ─── 感知铸造厂 ───

/**
 * 铸造 perceive()：截屏 → (宽高, dhash, OCR 词, VLM 元素可选) → composeSnapshot。
 *
 * 纪元 Η（Η-5）：云脑在场且 dhash 指纹在场时，另经 Φ-6 SceneSemanticsCache 读屏
 * 认场景（dhash+question 组合键、TTL 30s、LRU-16 —— 同屏零重拨），非降级读数的
 * sceneLabel 透传进快照；离线/指纹缺席 ⇒ 零网络零编码，行为与接线前一致。
 *
 * 分工律：capture 失败 ⇒ 原样上抛（闭环记 error 步 —— 感知失败是诚实错误，
 * 不是降级）；dhash/OCR/VLM 接地/场景语义失败 ⇒ 各自降级（快照 degraded 记账），
 * 绝不让次级传感器的故障拖垮主感知。合成后的快照写入 lastSnapshotRef
 * （在场时）供 execute 做变化判决的 before 帧。
 *
 * ΝΩ-14（变化门控）：每步双 VLM 往返（groundVlm + sceneRead）是自主环延迟
 * 主导项 —— benign click 后屏未变也要照付两趟网络。门控：snapshotChanged
 *（dhash 汉明 + 元素数突变双闸）判屏未变 ⇒ 复用上帧 groundVlm 产物跳过本轮
 * 接地往返，快照 notes 记 'vlm-reused-unchanged' 诚实申报（复用是节流不是
 * 降级，不占 degraded）；OCR 照跑（便宜、本地，兼作元素数闸证据）；场景语义
 * 由 SceneSemanticsCache 组合键缓存独立节流。首轮 / 屏变 / 上帧无 VLM 产物 ⇒
 * 照旧全价感知，行为与接线前一致。
 */
export function createPerceive(deps: RuntimeDeps = {}): () => Promise<WorldSnapshot> {
  const capture = deps.capture ?? ((): Promise<Buffer> => backend.captureCleanPng());
  const imageSize =
    deps.imageSize ??
    (async (buf: Buffer): Promise<{ width: number; height: number }> => {
      const sharp = await getSharp();
      const meta = await sharp(buf).metadata();
      return { width: meta.width ?? 0, height: meta.height ?? 0 };
    });
  const dhashOf =
    deps.dhashOf ??
    (async (buf: Buffer): Promise<string | null> => {
      try {
        return await dhash(buf);
      } catch {
        return null; // 指纹失败 = 无指纹（快照 degraded 记 'dhash'）
      }
    });
  const readWords = deps.readWords ?? makeDefaultReadWords(deps.ocrLang, { serverFirst: deps.ocrServerFirst === true });
  const groundVlm = deps.groundVlm ?? makeDefaultGroundVlm(deps.client, deps.verifyTaskId);
  const now = deps.now ?? ((): number => Date.now());
  // ΠΑΝ-57（生产 popup 供方）：弹窗注记通道 —— 显式注入端口优先（离线测试生命
  // 线）；缺席且 popupKeywords 词表在场（buildAutonomyStack 以 config.enableOcr
  // 门控铸入，缺省关 ⇒ 缺席 ⇒ 感知行为与接线前逐字节一致）⇒ 缺省供方：
  // popupDetector 几何启发式 + 全帧 OCR 词证（语义通道复用本帧已跑的 OCR 全文
  // —— 零二次 OCR）+ 施密特迟滞滤波（**本感知工厂私有实例** —— 不与
  // take_screenshot 的模块级单例互喂，两条观察流各自记账互不污染）。迟滞 ON ⇒
  // 快照 popups 产注记（策略①弹窗优先律与免看门控的弹窗红线自此在生产可达）。
  const popupNotesPort: ((buf: Buffer, ocrText: string) => Promise<string[] | null>) | null =
    typeof deps.popupNotes === 'function'
      ? deps.popupNotes
      : typeof deps.popupKeywords === 'string' && deps.popupKeywords.trim() !== ''
        ? makeDefaultPopupNotes(deps.popupKeywords)
        : null;
  // 纪元 Η（Η-5 感知缓存接线）：Φ-6 场景语义读屏缓存 —— dhash 相同（汉明距离 ≤ 容差）
  // 的屏在 TTL 内零重拨（内建 LRU-16）。离线（未注入 client 且未配置 GLM）时 read
  // 立即诚实降级：零网络、零编码、sceneLabel 保持 ''，与接线前逐字节同行为。
  const sceneCache = new SceneSemanticsCache({
    ...(deps.client ? { client: deps.client } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  });
  // W4-1（顺带接线）：屏幕状态账本 —— perceive 生命周期内持有（任务级状态机：
  // 关键帧代际 + 累计脏掩码跨帧记账）。prevDhash 是惊异信号的源（与本帧指纹
  // 的汉明距离 —— 与 contextManager 页面级跳变判据同律）。
  const incrementalLedger = new ScreenStateLedger({}, {});
  let prevIncrementalDhash: string | null = null;
  // ΝΩ-14（变化门控 · grounding 复用账）：上帧贵重产物 —— prevGround 是上帧
  // groundVlm 的原始产出（null = 首轮不可得；空数组 = 上帧 VLM 无元素，无可
  // 复用 ⇒ 本帧照旧全价感知，不给降级帧续命）；prevGateSnapshot 是上帧最终
  // 快照（snapshotChanged 判决的 before 帧）。两者只在帧末成对更新。
  let prevGround: GroundedElement[] | null = null;
  let prevGateSnapshot: WorldSnapshot | null = null;
  // W4-1：惊异信号（前帧 vs 本帧 dhash 的汉明距离；证据缺席 ⇒ 0 —— 不伪报惊异）
  const surpriseBitsOf = (fingerprint: string | null): number => {
    if (!prevIncrementalDhash || !fingerprint) return 0;
    const d = w1HashDistance(prevIncrementalDhash, fingerprint);
    return d === null ? 0 : d;
  };

  return async (): Promise<WorldSnapshot> => {
    const buf = await capture(); // 失败上抛 —— 闭环收敛为 error 步
    const { width, height } = await imageSize(buf);

    // 次级传感器：指纹 / OCR（各自降级，互不拖垮）。ΝΩ-14 起 OCR 仍每帧照跑
    //（便宜、本地）—— 它既入快照文本账，也是变化门控双闸的元素数证据。
    const fingerprint = await dhashOf(buf).catch((): string | null => null);
    const words = await readWords(buf).catch((): RuntimeWord[] => []);

    const localElements: LocalElement[] = words
      .filter(w => w && typeof w.label === 'string' && w.label.trim() !== '')
      .map(w => ({
        label: w.label,
        bbox: w.bbox && typeof w.bbox === 'object'
          ? {
              x0: typeof w.bbox.x0 === 'number' && Number.isFinite(w.bbox.x0) ? w.bbox.x0 : 0,
              y0: typeof w.bbox.y0 === 'number' && Number.isFinite(w.bbox.y0) ? w.bbox.y0 : 0,
              x1: typeof w.bbox.x1 === 'number' && Number.isFinite(w.bbox.x1) ? w.bbox.x1 : 0,
              y1: typeof w.bbox.y1 === 'number' && Number.isFinite(w.bbox.y1) ? w.bbox.y1 : 0,
            }
          : { x0: 0, y0: 0, x1: 0, y1: 0 },
        confidence: clamp01(w.confidence),
      }));
    const ocrText = words.map(w => (typeof w.label === 'string' ? w.label : '')).filter(Boolean).join(' ');

    // ΠΑΝ-57（生产 popup 供方）：弹窗注记生产 —— 通道在场才跑（缺席 ⇒ 本段
    // 整跳过，感知行为与接线前逐字节一致）；供方任何故障 ⇒ null 降级（弹窗是
    // 感知增益不是依赖，绝不拖垮主感知 —— 次级传感器纪律）。
    let popupNotes: string[] | null = null;
    if (popupNotesPort !== null) {
      try {
        const notes = await popupNotesPort(buf, ocrText);
        if (Array.isArray(notes)) {
          popupNotes = notes.filter((n): n is string => typeof n === 'string' && n !== '');
        }
      } catch {
        popupNotes = null; // 供方故障吞掉 —— 诚实缺席
      }
    }

    // 纪元 Η（Η-5）：同屏语义复用 —— 指纹在场才读（无键不读，dhash 相同直接命中
    // 缓存语义）；失败/降级零影响（sceneLabel 维持缺省 ''）。ΝΩ-14：屏未变时
    // 此读走 sceneSemantics 组合键缓存命中（零 VLM 零编码），与 grounding 门控
    // 各自独立节流。
    let sceneLabel = '';
    if (typeof fingerprint === 'string' && fingerprint.trim() !== '') {
      try {
        const scene = await sceneCache.read(buf, fingerprint);
        if (
          scene && scene.degraded === false && scene.reading &&
          typeof scene.reading.sceneLabel === 'string'
        ) {
          sceneLabel = scene.reading.sceneLabel;
        }
      } catch { /* 场景语义是次级传感器 —— 失败绝不拖垮主感知 */ }
    }

    // ΝΩ-14（变化门控 · grounding）：屏未变 ⇒ 复用上帧 vlm 元素，跳过 groundVlm
    // 贵重往返（自主环延迟主导项）。判决复用 worldSnapshot.snapshotChanged 双闸
    //（dhash 汉明 + 元素数突变）：以「上帧 vlm 元素 × 本帧 OCR」铸候选帧与上帧
    // 快照对判 —— 未变 ⇒ 候选即终帧（零 groundVlm 往返），并记 note
    // 'vlm-reused-unchanged' 诚实申报；变了 / 首轮（prev 不可得）/ 上帧无 VLM
    // 产物可复用 ⇒ 照旧全价感知（指纹缺席时 snapshotChanged 宽松判变，天然落回
    // 全价路径 —— 宁可重看，不可漏看）。
    const composeBase = {
      image: buf,
      width,
      height,
      dhash: fingerprint,
      localElements,
      ocrText,
      // ΠΑΝ-57：弹窗注记入快照（迟到于 0 步的弹窗在场证据 —— 策略①级与免看
      // 门控红线的生产供血；缺席 ⇒ 键不入场，composeSnapshot 行为同旧律）
      ...(popupNotes !== null && popupNotes.length > 0 ? { popupNotes } : {}),
      ...(sceneLabel !== '' ? { sceneLabel } : {}),
      now: now(),
    };
    let snap: WorldSnapshot | null = null;
    if (prevGateSnapshot !== null && prevGround !== null && prevGround.length > 0) {
      const candidate = composeSnapshot({
        ...composeBase,
        vlmElements: prevGround,
        notes: ['vlm-reused-unchanged'],
      });
      if (!snapshotChanged(prevGateSnapshot, candidate)) snap = candidate; // 复用帧：候选转正
    }
    if (snap === null) {
      const vlmElements = await groundVlm(buf).catch((): GroundedElement[] => []); // 云脑接地各自降级
      snap = composeSnapshot({ ...composeBase, vlmElements });
      prevGround = vlmElements; // 复用分支不更新 —— 上帧产物即本帧产物（同一账）
    }
    // W4-1（顺带接线 · 增量账本消费）：总闸 incrementalEncodingEnabled() 缺省关
    // ⇒ 本段整跳过，感知行为与接线前逐字节一致（零回归）。开 ⇒ 每帧入账
    // （惊异 = 前帧与本帧 dhash 的汉明距离）→ deliverIncremental 出投递产物；
    // 账本/投递/观察面任一失败 ⇒ 旁路吞掉（增量是增益不是依赖，绝不带崩感知）。
    if (incrementalEncodingEnabled()) {
      try {
        const verdict = await incrementalLedger.ingest(buf, {
          surpriseBits: surpriseBitsOf(fingerprint),
        });
        let delivery: IncrementalDelivery | null = null;
        try {
          delivery = await deliverIncremental(verdict, buf); // 附件服务缺席 ⇒ null（诚实降级）
        } catch { delivery = null; }
        if (deps.incrementalObserver) deps.incrementalObserver.current = { verdict, delivery };
        // W8-B2（D-C3 显式投喂终态接线）：把账本判决直喂 contextManager ——
        // W8-A5 备好的显式投喂面（recordIncrementalDelta）。三重零行为闸：
        //   · contextManager 增量开关关（缺省）⇒ 拒收 false = 零行为；
        //   · 开 ⇒ 下次 addScreenshot 优先消费显式判决（省内部账本对本帧的
        //     重复差分 —— 调用方已有判决时不必再算一遍）；
        //   · 投喂绝不抛（内部防御式）；外层旁路义务已兜，此处再守一层。
        try {
          contextManager.recordIncrementalDelta({
            ...verdict,
            ...(width >= 1 && height >= 1 ? { sourceWidth: width, sourceHeight: height } : {}),
          });
        } catch { /* 投喂是增益不是依赖 */ }
      } catch { /* 旁路义务：账本/投递失败绝不拖垮主感知 */ }
    }
    prevIncrementalDhash = typeof fingerprint === 'string' && fingerprint !== '' ? fingerprint : prevIncrementalDhash;
    prevGateSnapshot = snap; // ΝΩ-14：变化门控的 before 帧 —— 与 prevGround 同帧成对记账
    if (deps.lastSnapshotRef) deps.lastSnapshotRef.current = snap;
    return snap;
  };
}

/**
 * 缺省词级 OCR（textReader 双路径）：legacy readText（归一化 bbox → 像素换算，
 * confidence/100 夹 [0,1]）。
 * ΠΑΝ-58（OCR 接线）：opts.serverFirst === true ⇒ 先走 readTextAny 的服务端
 * L2 路径（服务端自截读屏 —— region 缺省全屏，bbox_normalized 即全屏归一域，
 * 与本帧捕获图同域换算）；服务端/链路失败 ⇒ 诚实回退 legacy 直读传入 buf
 * （行为与旧缺省逐字节一致）。缺席/关 ⇒ legacy 直读（零回归红律）。
 * 服务端词置信刻度（0-100）与 tesseract 同域 —— /100 夹取律共用。
 */
export function makeDefaultReadWords(
  lang: string | undefined,
  opts?: { serverFirst?: boolean },
): (buf: Buffer) => Promise<RuntimeWord[]> {
  const langUse = typeof lang === 'string' && lang.trim() !== '' ? lang : 'eng';
  return async (buf: Buffer): Promise<RuntimeWord[]> => {
    const meta = await (async (): Promise<{ width: number; height: number }> => {
      const sharp = await getSharp();
      const m = await sharp(buf).metadata();
      return { width: m.width ?? 0, height: m.height ?? 0 };
    })();
    const W = meta.width > 0 ? meta.width : 1;
    const H = meta.height > 0 ? meta.height : 1;
    if (opts?.serverFirst === true) {
      try {
        const r = await readTextAny(undefined, langUse);
        if (r && Array.isArray(r.words)) {
          return r.words.map(w => {
            const b = w.bbox_normalized ?? { x0: 0, y0: 0, x1: 0, y1: 0 };
            return {
              label: w.text,
              bbox: {
                x0: Math.round(clamp01(b.x0) * W),
                y0: Math.round(clamp01(b.y0) * H),
                x1: Math.round(clamp01(b.x1) * W),
                y1: Math.round(clamp01(b.y1) * H),
              },
              confidence: clamp01((typeof w.confidence === 'number' && Number.isFinite(w.confidence) ? w.confidence : 0) / 100),
            };
          });
        }
      } catch {
        // 服务端/双路径链失败 ⇒ 回退 legacy 直读传入 buf（诚实降级）
      }
    }
    const result = await readText(buf, langUse);
    return result.words.map(w => {
      const b = w.bbox_normalized ?? { x0: 0, y0: 0, x1: 0, y1: 0 };
      return {
        label: w.text,
        bbox: {
          x0: Math.round(clamp01(b.x0) * W),
          y0: Math.round(clamp01(b.y0) * H),
          x1: Math.round(clamp01(b.x1) * W),
          y1: Math.round(clamp01(b.y1) * H),
        },
        confidence: clamp01((typeof w.confidence === 'number' && Number.isFinite(w.confidence) ? w.confidence : 0) / 100),
      };
    });
  };
}

/**
 * ΠΑΝ-57（生产 popup 供方）：缺省弹窗注记供方 —— popupDetector 的双模证据 +
 * 施密特迟滞滤波，铸成 (buf, ocrText) ⇒ string[] | null 端口形态。
 *  · 几何通道：detectPopupHeuristic（弹窗几何特征 —— 纯函数，frameId 语义通道
 *    不消费故传 null）；
 *  · 语义通道：词表（popupKeywords CSV）对**全帧 OCR 语料**的子串命中 —— 复用
 *    感知链本帧已跑的 OCR（popupDetector 语义通道的中央带裁剪读是 take_screenshot
 *    侧的方言；此处全帧语料是其中央带的超集，零二次 OCR）；
 *  · 滤波：SchmittPopupFilter 私有实例（per 感知工厂）—— 单帧强证据立即 ON、
 *    单帧清洁不立即 OFF（迟滞带），与 take_screenshot 的模块级单例互不喂账。
 * 迟滞 active ⇒ 返回一句注记（含证据通道与信念后验）；inactive ⇒ null
 * （不产注记 —— 弹窗不在场不是证据）。任何通道故障 ⇒ null（诚实缺席）。
 */
export function makeDefaultPopupNotes(
  keywordsCsv: string,
): (buf: Buffer, ocrText: string) => Promise<string[] | null> {
  const keywords = (typeof keywordsCsv === 'string' ? keywordsCsv : '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(s => s !== '');
  const filter = new SchmittPopupFilter();
  return async (buf: Buffer, ocrText: string): Promise<string[] | null> => {
    try {
      const geometric = await detectPopupHeuristic(null, buf && buf.length > 0 ? buf : null);
      const hay = typeof ocrText === 'string' ? ocrText.toLowerCase() : '';
      const matched: string[] = [];
      for (const kw of keywords) {
        if (hay.includes(kw)) matched.push(kw);
        if (matched.length >= 3) break; // 证据上限与 popupDetector 同律（锚点不因词表膨胀）
      }
      const { belief, active } = filter.update({
        geometric,
        semantic: matched.length > 0,
      });
      if (!active) return null;
      const via = matched.length > 0
        ? `语义词证 ${matched.join('/')}`
        : geometric
          ? '几何证据'
          : '迟滞保持（前帧证据在带内）';
      return [`弹窗在场（${via}，belief ${belief}）`];
    } catch {
      return null; // 供方故障 ⇒ 诚实缺席（弹窗是感知增益不是依赖）
    }
  };
}

/**
 * 缺省云脑接地：注入 client 优先；否则 isGlmConfigured() 时 groundElements，否则零网络 []。
 * W8-B2：verifyTaskId（RuntimeDeps.verifyTaskId）透传 groundElements —— 复核
 * 预算按任务作用域键记账（跑环任务 `pilot:<token>` 与 runPilotLoop 起点的
 * resetVerifyGateBudget 同键闭环）；缺席/空串 ⇒ 不传键 ⇒ 共用模块缺省账本
 * （历史行为，逐字节一致）。
 */
export function makeDefaultGroundVlm(
  client: GlmClient | undefined,
  verifyTaskId: string | undefined,
): (buf: Buffer, question?: string) => Promise<GroundedElement[]> {
  return async (buf: Buffer, question?: string): Promise<GroundedElement[]> => {
    if (!client && !isGlmConfigured()) return []; // 未配置 ⇒ 零网络降级
    const result = await groundElements(buf, {
      ...(client ? { client } : {}),
      ...(typeof verifyTaskId === 'string' && verifyTaskId.trim() !== '' ? { verifyTaskId } : {}),
      ...(typeof question === 'string' && question.trim() !== '' ? { question } : {}),
      // W2-0（C 接线）：Zoom 复核端口（W1-8 P3）—— grounding.verifyZoom 内核键
      //（宿主 index.ts 以 config.vlmZoomVerify 铸入，缺省 1=开）控制；端口取注入
      // client 或已配置单例（同一颗脑自任第二意见 —— 复核流量仍走独立预算闸，
      // grounding.verifyBudget 任务级 8 次封顶）。关 ⇒ 端口缺席，触发事件以
      // port-absent 诚实放行原值。
      ...(kernelRegistry.getOrDefault('grounding.verifyZoom', 1) > 0.5
        ? { verifyClient: client ?? getGlmClient() }
        : {}),
    });
    return result.ok ? result.elements : [];
  };
}
