// src/autonomy/runtime.ts
// 纪元 Φ（真实运行时适配层）：把十器官的纯决策世界接到真实躯体 —— 截屏、指纹、
// OCR、云脑接地、system 键鼠。Φ-4 闭环只消费 perceive/execute 两个函数面，
// 本模块就是这两个函数面的铸造厂：
//   · createPerceive：截屏 → (dhash, 宽高, OCR 词, VLM 元素可选) → composeSnapshot
//   · createExecute：PolicyAction → system 键鼠/云脑问答 → 再截屏验证 → StepOutcome
// 全部依赖可注入（RuntimeDeps）—— 离线测试注入假截屏序列/假 OCR/假云脑，
// 缺省走真实管线（physicalBackend 截屏、perceptualHash 指纹、textReader 词级
// OCR、vlm/grounding 云脑接地、system 键鼠）。
// 铁律：具名导出、绝不抛异常（一切失败收敛为 error 结局或降级记 degraded）、
// system 调用方式逐字模仿 clickMouse.ts / typeText.ts（像素/归一化换算同律）。
import * as backend from '../physicalBackend';
import { system } from '../system';
import { getSharp } from '../_legacyDeps';
import { dhash } from '../perceptualHash';
import { readText } from '../textReader';
import { skillLibrary } from '../skillLibrary';
import { getGlmClient, isGlmConfigured, type GlmClient } from '../vlm/glmClient';
import { groundElements } from '../vlm/grounding';
import { encodeForVlm } from '../vlm/codec';
import type { GroundedElement } from '../vlm/grounding';
import type { LocalElement } from '../vlm/arbitration';
import { composeSnapshot, snapshotChanged, type WorldSnapshot } from './worldSnapshot';
import type { GoalSpec } from './goalState';
import type { PolicyAction, StepOutcome } from './policyEngine';

// ─── 契约类型 ───

/** 运行时词级 OCR 结果：label + 像素 bbox + 置信（[0,1]）—— composeSnapshot 的 localElements 方言 */
export interface RuntimeWord {
  label: string;
  bbox: { x0: number; y0: number; x1: number; y1: number };
  confidence: number;
}

/**
 * 运行时全部外部依赖（离线测试的生命线；缺省走真实管线）。
 * lastSnapshotRef 是感知/执行共享的「最新快照槽」：perceive 每次写入，
 * execute 读取作为变化判决的 before 帧 —— buildAutonomyStack 会就地补挂。
 */
export interface RuntimeDeps {
  /** 干净截屏供给（缺省 backend.captureCleanPng 全屏 PNG） */
  capture?: () => Promise<Buffer>;
  /** 图像尺寸探测（缺省 sharp metadata） */
  imageSize?: (buf: Buffer) => Promise<{ width: number; height: number }>;
  /** 感知指纹（缺省 perceptualHash.dhash 64 位串；失败 ⇒ null ⇒ 快照记降级） */
  dhashOf?: (buf: Buffer) => Promise<string | null>;
  /** 词级 OCR（缺省 textReader.readText：归一化 bbox → 像素换算，confidence/100） */
  readWords?: (buf: Buffer) => Promise<RuntimeWord[]>;
  /** 云脑元素接地（缺省：注入 client 或 isGlmConfigured() 时 groundElements，否则 []） */
  groundVlm?: (buf: Buffer, question?: string) => Promise<GroundedElement[]>;
  /** 词级 OCR 语言（缺省 'eng'；透传 textReader.readText） */
  ocrLang?: string;
  /** 云脑 client（ask_vlm 问答与 grounding 的注入位；测试假件由此进） */
  client?: GlmClient;
  /** 注入时钟（缺省 Date.now） */
  now?: () => number;
  /** 注入睡眠（缺省 setTimeout 真睡；测试零等待） */
  sleep?: (ms: number) => Promise<void>;
  /** 感知/执行共享的最新快照槽（perceive 写 / execute 读；缺席则执行验证自取 before 帧） */
  lastSnapshotRef?: { current: WorldSnapshot | null };
}

/** 执行结局汇报：结局分类 + 判据证据（可选）+ 一句附注（云脑问答/技能召回等观察性动作的记事本） */
export interface ExecOutcome {
  outcome: StepOutcome;
  /** 判据证据：index 对应 spec.successCriteria 下标（失败不产生 violated —— 宁缺毋错） */
  criteriaEvidence?: Array<{ index: number; status: 'met' | 'violated' }>;
  /** 一句中文附注（ask_vlm 的回答 / recall_skill 的命中 / 异常归因） */
  note?: string;
}

// ─── 内部纯工具（零异常） ───

/** 异常归因为安全字符串（绝不二次抛出） */
function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    const text = String(err);
    return text === '' ? '未知异常' : text;
  } catch {
    return '未知异常';
  }
}

/** 数字夹 [0,1]；非有限数按 0 记（归一化坐标卫兵） */
function clamp01(v: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : 0;
  return Math.min(1, Math.max(0, n));
}

/** 大小写 + 空白折叠（判据子串匹配的统一前置） */
function foldText(s: unknown): string {
  return typeof s === 'string' ? s.toLowerCase().replace(/\s+/g, ' ').trim() : '';
}

/** note 预算：附注截 500 字（Token 纪律 —— 记事本不是转录本） */
const NOTE_MAX = 500;
function clipNote(s: string): string {
  return s.length > NOTE_MAX ? `${s.slice(0, NOTE_MAX)}…[截断]` : s;
}

/** 判据抽查周期：每 3 个已验证步抽查一次（成本克制） */
const CRITERIA_SPOT_PERIOD = 3;
/** 缺省滚动行数（与 scrollPage 工具缺省同律） */
const DEFAULT_SCROLL_AMOUNT = 5;

// ─── 感知铸造厂 ───

/**
 * 铸造 perceive()：截屏 → (宽高, dhash, OCR 词, VLM 元素可选) → composeSnapshot。
 *
 * 分工律：capture 失败 ⇒ 原样上抛（闭环记 error 步 —— 感知失败是诚实错误，
 * 不是降级）；dhash/OCR/VLM 接地失败 ⇒ 各自降级（快照 degraded 记账），
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
  const groundVlm = deps.groundVlm ?? makeDefaultGroundVlm(deps.client);
  const now = deps.now ?? ((): number => Date.now());

  return async (): Promise<WorldSnapshot> => {
    const buf = await capture(); // 失败上抛 —— 闭环收敛为 error 步
    const { width, height } = await imageSize(buf);

    // 次级传感器：指纹 / OCR / 云脑接地（各自降级，互不拖垮）
    const fingerprint = await dhashOf(buf).catch((): string | null => null);
    const words = await readWords(buf).catch((): RuntimeWord[] => []);
    const vlmElements = await groundVlm(buf).catch((): GroundedElement[] => []);

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
      now: now(),
    });
    if (deps.lastSnapshotRef) deps.lastSnapshotRef.current = snap;
    return snap;
  };
}

/** 缺省词级 OCR：textReader.readText（归一化 bbox → 像素换算，confidence/100 夹 [0,1]） */
function makeDefaultReadWords(
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

/** 缺省云脑接地：注入 client 优先；否则 isGlmConfigured() 时 groundElements，否则零网络 [] */
function makeDefaultGroundVlm(
  client: GlmClient | undefined,
): (buf: Buffer, question?: string) => Promise<GroundedElement[]> {
  return async (buf: Buffer, question?: string): Promise<GroundedElement[]> => {
    if (!client && !isGlmConfigured()) return []; // 未配置 ⇒ 零网络降级
    const result = await groundElements(buf, {
      ...(client ? { client } : {}),
      ...(typeof question === 'string' && question.trim() !== '' ? { question } : {}),
    });
    return result.ok ? result.elements : [];
  };
}

// ─── 执行铸造厂 ───

/**
 * 铸造 execute(action)：动作映射律 + 执行后验证 + 判据抽查。
 *
 * 动作映射律（system 调用方式逐字模仿 clickMouse.ts / typeText.ts）：
 *  · click → target.center 像素（快照坐标系）÷ 快照宽高 = 归一化 →
 *    `system.getScreenSize()` 后 `Math.round(nx * size.width)` 像素 →
 *    `system.clickMouse(px, py, 'left')`（与 clickMouse 工具同一换算链）；
 *    target 缺席 ⇒ 不动作记 no_effect（无处落点，绝不凭空点击）。
 *  · type → `system.typeText(text, clearFirst)`（payload.text 非串 ⇒ no_effect）。
 *  · scroll → `system.scroll(direction, amount)`（direction 白名单 up/down/left/right，
 *    缺省 down；amount 缺省 5 —— 与 scrollPage 工具同律）。
 *  · hotkey → `system.pressHotkey(keys)`（payload.keys 非字符串数组 ⇒ no_effect）。
 *  · ask_vlm → 截屏 + client.chat 问答，回答仅记 note（观察性动作，不改世界）；
 *    云脑缺席 ⇒ error（诚实归因，不伪答）。
 *  · recall_skill → skillLibrary.match 以 spec.goal 召回最佳；无匹配 ⇒ no_effect；
 *    命中 ⇒ 记 note（技能重放属上游职权，本执行面只报到处）。
 *  · declare / wait / inspect / 其余 → 不动作（declare 附带判据核对，见下）。
 *
 * 执行后验证（世界动作与 ask_vlm/recall_skill 命中后）：再截屏 + dhash 对比
 * snapshotChanged(before, after) ⇒ progress，否则 no_effect；异常 ⇒ error。
 * before 帧取 lastSnapshotRef（感知快照）；槽缺席时现场补拍（独立使用亦正确）。
 *
 * 判据抽查（成本克制）：OCR 全文（readWords 拼接）对 spec.successCriteria 做
 * 大小写 + 空白折叠子串匹配（命中 ⇒ met）—— 仅 declare 步（用感知快照的
 * textDigest，零额外截屏）与每 3 个已验证步（用验证帧的 OCR）抽查；
 * 失败不产生 violated（宁缺毋错 —— 子串匹配只适合证真，不适合证伪）。
 */
export function createExecute(
  deps: RuntimeDeps & { spec: GoalSpec; width?: number; height?: number },
): (action: PolicyAction) => Promise<ExecOutcome> {
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
        return null;
      }
    });
  const readWords = deps.readWords ?? makeDefaultReadWords(deps.ocrLang);
  const now = deps.now ?? ((): number => Date.now());
  const spec = deps.spec;
  // 判据对（原文 + 原始下标）：下标锚定 spec.successCriteria 原位（recordCriterion
  // 按原数组回填）—— 过滤掉非法判据不得平移后续判据的证据下标
  const criteria: Array<{ text: string; index: number }> = [];
  if (Array.isArray(spec.successCriteria)) {
    spec.successCriteria.forEach((c, index) => {
      if (typeof c === 'string' && c.trim() !== '') criteria.push({ text: c, index });
    });
  }
  /** 已验证步计数（每 3 步抽查判据的节拍器） */
  let verifiedCount = 0;

  /** 判据核对：OCR 全文对 successCriteria 折叠子串匹配（命中 ⇒ met；证伪不做） */
  const checkCriteria = (ocrText: string): Array<{ index: number; status: 'met' }> => {
    const folded = foldText(ocrText);
    if (folded.length === 0) return [];
    const evidence: Array<{ index: number; status: 'met' }> = [];
    criteria.forEach(({ text, index }) => {
      const needle = foldText(text);
      if (needle.length > 0 && folded.includes(needle)) {
        evidence.push({ index, status: 'met' });
      }
    });
    return evidence;
  };

  /** 执行后验证：再截屏 + dhash 对比；every-N 步顺带判据抽查 */
  const verifyAfter = async (note?: string): Promise<ExecOutcome> => {
    verifiedCount++;
    const afterBuf = await capture();
    const { width, height } = await imageSize(afterBuf);
    const afterDhash = await dhashOf(afterBuf).catch((): string | null => null);
    const spotDue = verifiedCount % CRITERIA_SPOT_PERIOD === 0;
    let ocrText = '';
    if (spotDue) {
      const words = await readWords(afterBuf).catch((): RuntimeWord[] => []);
      ocrText = words.map(w => (typeof w.label === 'string' ? w.label : '')).filter(Boolean).join(' ');
    }
    const after = composeSnapshot({
      image: afterBuf, width, height, dhash: afterDhash, ocrText, now: now(),
    });
    let before: WorldSnapshot | null = null;
    if (deps.lastSnapshotRef) before = deps.lastSnapshotRef.current;
    const outcome: StepOutcome = snapshotChanged(before, after) ? 'progress' : 'no_effect';
    const evidence = spotDue ? checkCriteria(ocrText) : [];
    const result: ExecOutcome = { outcome };
    if (note !== undefined && note !== '') result.note = clipNote(note);
    if (evidence.length > 0) result.criteriaEvidence = evidence;
    return result;
  };

  return async (action: PolicyAction): Promise<ExecOutcome> => {
    const a = (action ?? {}) as Partial<PolicyAction>;
    const payload =
      a.payload && typeof a.payload === 'object' ? (a.payload as Record<string, unknown>) : {};

    try {
      switch (a.kind) {
        // ── 世界动作：system 键鼠（换算链逐字模仿 clickMouse.ts） ──
        case 'click': {
          const target = a.target as { center?: { x?: unknown; y?: unknown } } | undefined;
          const cx = target?.center?.x;
          const cy = target?.center?.y;
          if (typeof cx !== 'number' || !Number.isFinite(cx) || typeof cy !== 'number' || !Number.isFinite(cy)) {
            return { outcome: 'no_effect', note: '点击目标缺席中心坐标，不动作（绝不凭空点击）' };
          }
          const size = await system.getScreenSize();
          // 快照像素 → 归一化：坐标系优先级 = 显式入参 > 感知快照宽高（元素坐标
          // 的原生坐标系）> 屏幕尺寸（快照缺席时的兜底 —— 视捕获图与屏幕同幅）
          const refSnap = deps.lastSnapshotRef?.current;
          const w = typeof deps.width === 'number' && deps.width > 0
            ? deps.width
            : typeof refSnap?.width === 'number' && refSnap.width > 0 ? refSnap.width : size.width;
          const h = typeof deps.height === 'number' && deps.height > 0
            ? deps.height
            : typeof refSnap?.height === 'number' && refSnap.height > 0 ? refSnap.height : size.height;
          const nx = clamp01(cx / w);
          const ny = clamp01(cy / h);
          const px = Math.round(nx * size.width);
          const py = Math.round(ny * size.height);
          await system.clickMouse(px, py, 'left');
          return verifyAfter(`点击像素 (${px}, ${py})（归一化 ${nx.toFixed(3)}, ${ny.toFixed(3)}）`);
        }
        case 'type': {
          const text = payload.text;
          if (typeof text !== 'string' || text.length === 0) {
            return { outcome: 'no_effect', note: 'type 动作 payload.text 缺席，不动作' };
          }
          await system.typeText(text, payload.clearFirst === true);
          return verifyAfter(`键入 ${text.length} 字符`);
        }
        case 'scroll': {
          const raw = typeof payload.direction === 'string' ? payload.direction : 'down';
          const dirMap: Record<string, 'up' | 'down' | 'left' | 'right'> = {
            up: 'up', down: 'down', left: 'left', right: 'right',
          };
          const dir = dirMap[raw];
          if (!dir) return { outcome: 'no_effect', note: `scroll 方向非法（${raw}），不动作` };
          const amount =
            typeof payload.amount === 'number' && Number.isFinite(payload.amount) && payload.amount >= 1
              ? payload.amount
              : DEFAULT_SCROLL_AMOUNT;
          await system.scroll(dir, amount);
          return verifyAfter(`滚动 ${dir} ${amount} 行`);
        }
        case 'hotkey': {
          const keys = Array.isArray(payload.keys)
            ? payload.keys.filter((k): k is string => typeof k === 'string' && k.trim() !== '')
            : [];
          if (keys.length === 0) {
            return { outcome: 'no_effect', note: 'hotkey 动作 payload.keys 缺席，不动作' };
          }
          await system.pressHotkey(keys);
          return verifyAfter(`按键 ${keys.join('+')}`);
        }

        // ── 观察性动作：不改世界，结果仅记 note ──
        case 'ask_vlm': {
          const client = deps.client ?? (isGlmConfigured() ? getGlmClient() : null);
          if (!client) {
            return { outcome: 'error', note: 'ask_vlm：云脑未配置（缺 API Key 且未注入 client）' };
          }
          const question = typeof payload.question === 'string' && payload.question.trim() !== ''
            ? payload.question
            : `目标「${spec.goal}」的下一步建议是什么？`;
          const buf = await capture();
          const enc = await encodeForVlm(buf);
          if (!enc.ok || !enc.value) {
            return { outcome: 'error', note: `ask_vlm 截屏编码失败：${enc.error ?? '未知'}` };
          }
          const res = await client.chat({
            images: [{ base64: enc.value.base64, mime: enc.value.mime }],
            prompt: question,
            temperature: 0.2,
            maxTokens: 512,
          });
          if (!res.ok) {
            return { outcome: 'error', note: `ask_vlm 云脑失败：${res.error ?? '未知'}` };
          }
          return verifyAfter(`云脑答：${res.text.trim()}`);
        }
        case 'recall_skill': {
          const matches = ((): Array<{ id: number; name: string }> => {
            try {
              return skillLibrary.match(typeof spec.goal === 'string' ? spec.goal : '', undefined, 1)
                .map(m => ({ id: m.id, name: m.name }));
            } catch {
              return [];
            }
          })();
          if (matches.length === 0) {
            return { outcome: 'no_effect', note: 'recall_skill：技能库无匹配（无匹配 ⇒ 不动作）' };
          }
          return verifyAfter(`召回技能 #${matches[0].id}「${matches[0].name}」（重放属上游职权）`);
        }

        // ── 不动作族：declare 附带判据核对（用感知快照 textDigest，零额外截屏） ──
        case 'declare': {
          const digest = deps.lastSnapshotRef?.current?.textDigest ?? '';
          const evidence = checkCriteria(digest);
          const result: ExecOutcome = { outcome: 'no_effect' };
          if (evidence.length > 0) result.criteriaEvidence = evidence;
          else result.note = 'declare：感知文本未命中判据字面（宁缺毋错，不置位）';
          return result;
        }
        case 'wait':
          return { outcome: 'no_effect' };
        default:
          // inspect / escalate（闭环已拦截）/ 未知种类：不动世界
          return { outcome: 'no_effect', note: `动作种类「${String(a.kind)}」在本执行面无世界动作` };
      }
    } catch (err) {
      return { outcome: 'error', note: clipNote(`execute: ${errText(err)}`) };
    }
  };
}
