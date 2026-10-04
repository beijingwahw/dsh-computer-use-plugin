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
import { readText } from '../textReader';
import { getGlmClient, isGlmConfigured, type GlmClient } from '../vlm/glmClient';
import { groundElements } from '../vlm/grounding';
import type { GroundedElement } from '../vlm/grounding';
import type { LocalElement } from '../vlm/arbitration';
import { composeSnapshot, type WorldSnapshot } from './worldSnapshot';
import { SceneSemanticsCache } from './sceneSemantics';
import { kernelRegistry } from '../kernel/registry';
import { contextManager } from '../contextManager';
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
  const readWords = deps.readWords ?? makeDefaultReadWords(deps.ocrLang);
  const groundVlm = deps.groundVlm ?? makeDefaultGroundVlm(deps.client, deps.verifyTaskId);
  const now = deps.now ?? ((): number => Date.now());
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
  // W4-1：惊异信号（前帧 vs 本帧 dhash 的汉明距离；证据缺席 ⇒ 0 —— 不伪报惊异）
  const surpriseBitsOf = (fingerprint: string | null): number => {
    if (!prevIncrementalDhash || !fingerprint) return 0;
    const d = w1HashDistance(prevIncrementalDhash, fingerprint);
    return d === null ? 0 : d;
  };

  return async (): Promise<WorldSnapshot> => {
    const buf = await capture(); // 失败上抛 —— 闭环收敛为 error 步
    const { width, height } = await imageSize(buf);

    // 次级传感器：指纹 / OCR / 云脑接地（各自降级，互不拖垮）
    const fingerprint = await dhashOf(buf).catch((): string | null => null);
    const words = await readWords(buf).catch((): RuntimeWord[] => []);
    const vlmElements = await groundVlm(buf).catch((): GroundedElement[] => []);

    // 纪元 Η（Η-5）：同屏语义复用 —— 指纹在场才读（无键不读，dhash 相同直接命中
    // 缓存语义）；失败/降级零影响（sceneLabel 维持缺省 ''）
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

    const snap = composeSnapshot({
      image: buf,
      width,
      height,
      dhash: fingerprint,
      vlmElements,
      localElements,
      ocrText,
      ...(sceneLabel !== '' ? { sceneLabel } : {}),
      now: now(),
    });
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
    if (deps.lastSnapshotRef) deps.lastSnapshotRef.current = snap;
    return snap;
  };
}

/** 缺省词级 OCR：textReader.readText（归一化 bbox → 像素换算，confidence/100 夹 [0,1]） */
export function makeDefaultReadWords(
  lang: string | undefined,
): (buf: Buffer) => Promise<RuntimeWord[]> {
  return async (buf: Buffer): Promise<RuntimeWord[]> => {
    const result = await readText(buf, typeof lang === 'string' && lang.trim() !== '' ? lang : 'eng');
    const meta = await (async (): Promise<{ width: number; height: number }> => {
      const sharp = await getSharp();
      const m = await sharp(buf).metadata();
      return { width: m.width ?? 0, height: m.height ?? 0 };
    })();
    const W = meta.width > 0 ? meta.width : 1;
    const H = meta.height > 0 ? meta.height : 1;
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
