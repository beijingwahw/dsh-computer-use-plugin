// src/sandbox/macroRehearsal.ts
// W4-1（创新提案 A1 · 排练门禁）：宏执行器与沙箱的接缝 —— 兑现 W2 报告的
// 「MuscleMemoryStore 排练门禁 + 执行器未接线」留白。
//
// 门禁语义（THE HOST IS SACRED 的宏方言）：
//   · 可靠度 < MACRO_REHEARSAL_GATE（0.5）的技能 / 一切模板绑定产物
//     （W3-2 bindTemplate 的年轻产物 —— 证据未积累）必须先在沙箱虚拟控件
//     世界排练通过，才许宿主派发；
//   · 排练 = 宏链翻译成 SandboxAction 后重入 VirtualScreen（engine 的
//     deterministicReplay 出口消费宏链 —— 零熵重演，反证 ⇒ failed）；
//   · 排练通过 ⇒ 步骤链 consolidate 入 MuscleMemoryStore（「在 MuscleMemory
//     虚拟排练通过」的登记面：rehearsalPassCount 起步、可靠度计数不动 ——
//     可靠度唯一事实源仍是宿主重放，与 D-5 哲学逐字一致）；
//   · 无场景证据（当前帧元素缺席）⇒ verdict='degraded' ⇒ 拒绝放行
//     （低可靠宏 + 零世界证据 = 不放行；诚实拒绝优于盲目派发）。
// 宿主放行逻辑在此就位；宿主执行器本体（物理派发）由宏执行器的注入 runner
// 承担（runtime case 'macro' / skillTools run_skill），本模块只管「允不允许」。
// 异常契约（运行层）：一切方法绝不抛，判决收敛为 verdict 判词。

import { deterministicReplay } from './engine';
import { MuscleMemoryStore, sharedMuscleMemoryStore } from './memory';
import { VIRTUAL_POPUP_Z } from './virtualScreen';
import {
  createDefaultIdGenerator,
  type IdGenerator,
  type SandboxAction,
  type VirtualWidget,
} from './types';
import type { SkillStep } from '../skillLibrary';

/** W4-1：排练门禁的可靠度闸（0..1 —— 与 DEFAULT_MIN_RELIABILITY 同值域口径；
 *  Beta 后验均值 < 0.5 ⇔ 失败多于成功的技能，先排练再放行） */
export const MACRO_REHEARSAL_GATE = 0.5;

/** W4-1：排练场景的控件铸造输入（归一化坐标 —— 重锚定锚点同源证据） */
export interface MacroRehearsalSceneInput {
  label: string;
  /** 归一化 bbox（x0/y0/x1/y1 ∈ [0,1]） */
  bbox: { x0: number; y0: number; x1: number; y1: number };
  acceptsText?: boolean;
  scrollable?: boolean;
  popup?: boolean;
  /** ΝΩ-30：控件角色方言（如 'tab' —— 切签证据的前提；缺省 'unknown'）。
   *  供源（uiMemory/锚点）有角色证据时透传，无则保持既有 unknown 方言。 */
  role?: string;
}

/** W4-1：排练门禁判决 */
export interface MacroRehearsalVerdict {
  /** 门禁是否要求排练（可靠度过闸 ⇒ false：直放） */
  required: boolean;
  /** 'not-required' = 可靠度过闸免排练；'passed' = 虚拟排练通过（已入 MuscleMemory）；
   *  'failed' = 排练反证；'degraded' = 场景/证据缺席（诚实拒绝） */
  verdict: 'not-required' | 'passed' | 'failed' | 'degraded';
  /** 放行与否（verdict 'not-required' | 'passed' ⇒ true） */
  allowed: boolean;
  /** 排练登记的肌肉记忆条目 id（passed 时在场） */
  muscleEntryId?: string;
  /** ΝΩ-30：词表外（unsupported）步数 —— 翻译时无沙箱状态模型的宿主工具步。
   *  观测面：诚实归因（degraded 时「为何零证据」的第一归因候选）。 */
  unsupportedSteps?: number;
  note: string;
}

/** ΝΩ-30：词表外工具的诚实标记方言 —— noop 步携带 unsupported_tool 键名
 *  （VirtualScreen 的 noop 分支据此在注里点名无模型的宿主工具，区别于
 *  dismiss_popup 这类「元动作本无状态模型」的合法 noop）。 */
const UNSUPPORTED_ARG = 'unsupported_tool';

/**
 * ΝΩ-30：热键和弦 → 沙箱可模拟操作的映射。完整键和弦按归一小写集合判：
 *   · ['esc'] ⇒ 原样过（虚拟屏键盘模型唯一单键：关最上层弹窗）；
 *   · ctrl(+shift)+tab ⇒ switch_tab next/previous（宿主切签的同一物理和弦
 *     —— index.ts 执行器 switch_tab 分支同律，不另造第二套切签机制）；
 *   · 其余和弦无键盘状态模型 ⇒ null（调用方诚实标注 unsupported）。
 */
function hotkeyChordToSandbox(keys: unknown): SandboxAction | null {
  if (!Array.isArray(keys) || keys.length === 0
    || !keys.every(k => typeof k === 'string')) return null;
  const chord = new Set(keys.map(k => k.toLowerCase()));
  if (chord.size === 1 && chord.has('esc')) {
    return { kind: 'press_hotkey', args: { keys } };
  }
  if (chord.has('tab')) {
    if (chord.has('ctrl') && chord.has('shift')) return { kind: 'switch_tab', args: { direction: 'previous' } };
    if (chord.has('ctrl')) return { kind: 'switch_tab', args: { direction: 'next' } };
  }
  return null;
}

/**
 * W4-1：宏链 → SandboxAction 翻译（纯函数、确定性、绝不抛）。
 * 宿主技能步方言（tool + args）→ 沙箱动作方言（kind + args）。
 * ΝΩ-30 词表扩展：click_element（元素 ID 寻址）→ click_mouse 坐标寻址；
 * press_hotkey 完整键和弦按 hotkeyChordToSandbox 映射（esc 原样 / ctrl±shift+tab
 * → 切签）；switch_window/drag_mouse 直通（虚拟屏均有世界模型）。技能含这些
 * 工具不再是词表外 noop（零证据 degraded ⇒ 低可靠技能永久被拒的结构性拒绝）。
 * 沙箱词汇表之外的宿主工具 ⇒ noop + unsupported_tool 诚实标注（无状态模型
 * 可排练，而非冒充元动作缺席）。
 */
export function translateToSandboxActions(steps: ReadonlyArray<SkillStep>): SandboxAction[] {
  const out: SandboxAction[] = [];
  for (const s of Array.isArray(steps) ? steps : []) {
    const args = s && typeof s.args === 'object' && s.args !== null ? { ...s.args } : {};
    switch (s?.tool) {
      case 'click_mouse':
      case 'type_text':
      case 'scroll_page':
      case 'drag_mouse':
      case 'switch_tab':
      case 'switch_window':
      case 'dismiss_popup':
        out.push({ kind: s.tool, args });
        break;
      case 'press_hotkey': {
        const mapped = hotkeyChordToSandbox(args.keys);
        if (mapped) out.push(mapped);
        else out.push({ kind: 'noop', args: { [UNSUPPORTED_ARG]: 'press_hotkey' } });
        break;
      }
      case 'click_element': {
        // 元素 ID 依赖运行时元素缓存（沙箱无缓存世界）—— 投影空间参数：
        // x/y（在场即命中测试证据）+ target_description；id/approval_token 是
        // 缓存通道方言，无虚拟等价物（坐标缺席 ⇒ 该步诚实零证据，可归因）。
        const projected: Record<string, unknown> = {};
        if (typeof args.x === 'number' && Number.isFinite(args.x)) projected.x = args.x;
        if (typeof args.y === 'number' && Number.isFinite(args.y)) projected.y = args.y;
        if (typeof args.target_description === 'string') projected.target_description = args.target_description;
        out.push({ kind: 'click_mouse', args: projected });
        break;
      }
      default:
        out.push({
          kind: 'noop',
          args: s?.tool ? { [UNSUPPORTED_ARG]: String(s.tool).slice(0, 64) } : {},
        });
        break;
    }
  }
  return out;
}

/** W4-1：场景铸造（锚点证据 → VirtualWidget；畸形框拒收 —— asVirtualWidget 同律的本地防御） */
export function buildVirtualScene(
  scene: ReadonlyArray<MacroRehearsalSceneInput> | undefined,
): VirtualWidget[] {
  if (!Array.isArray(scene)) return [];
  const widgets: VirtualWidget[] = [];
  for (const w of scene) {
    if (!w || typeof w !== 'object') continue;
    const b = w.bbox;
    const x0 = Number(b?.x0), y0 = Number(b?.y0), x1 = Number(b?.x1), y1 = Number(b?.y1);
    if (![x0, y0, x1, y1].every(Number.isFinite)) continue;
    const x = Math.min(x0, x1), y = Math.min(y0, y1);
    const width = Math.abs(x1 - x0), height = Math.abs(y1 - y0);
    if (width <= 0 || height <= 0 || x < 0 || y < 0 || x > 1 || y > 1) continue;
    widgets.push({
      // ΝΩ-30：角色方言透传（如 'tab' —— 切签证据前提；缺省 unknown 旧方言）
      role: typeof w.role === 'string' && w.role !== '' ? w.role : 'unknown',
      // ΝΩ-30：label 截断 20→64 —— 与 asVirtualWidget 的 WIDGET_NAME_MAX 同律
      //（供源方言 skillTools 的 rehearsalSceneFromMemory 本就铸 64 字 label）
      name: String(w.label ?? '').slice(0, 64),
      rect: {
        x: Math.min(1, x), y: Math.min(1, y),
        width: Math.min(1, width), height: Math.min(1, height),
      },
      // ΤΕΛ-13（D-G16 留案 M8）：三态保全 —— acceptsText/scrollable 缺席不铸键
      // （键缺席 = 未申报），申报布尔原样透传。旧铸造 `=== true` 把缺席折叠成
      // false ⇒ 排练弃权语义（virtualScreen 贫乏场景臂）失据。uiMemory 锚点
      // 供源本就不携带这两标志 —— 保守折叠等于结构性反证（C2-3 M8 病灶）。
      // 不铸 undefined 值键：ΠΑΝ-49 canonical「undefined 值自有键与缺键同域」。
      ...(typeof w.acceptsText === 'boolean' ? { acceptsText: w.acceptsText } : {}),
      ...(typeof w.scrollable === 'boolean' ? { scrollable: w.scrollable } : {}),
      popup: w.popup === true,
      // ΝΩ-30：popup 铸高层（asVirtualWidget 缺省方言同律 —— 单源 VIRTUAL_POPUP_Z）
      z: w.popup === true ? VIRTUAL_POPUP_Z : 0,
    });
  }
  return widgets;
}

/**
 * W4-1：宏排练门禁 —— MuscleMemoryStore 虚拟排练的执行器接线。
 * ΑΩ-R20（存储归一）：登记/查询改走引擎侧同一持久化 MuscleMemoryStore ——
 * 构造缺省注入 memory.ts 的 sharedMuscleMemoryStore（与引擎记账同账本：
 * 排练登记跨会话存活、宿主重放计数可积累），亦接受显式注入的独立实例
 * （离线测试隔离）。本类只持「门禁逻辑」职责，存储职责归 memory.ts。
 */
export class MacroRehearsalGate {
  private readonly store: MuscleMemoryStore;
  private readonly idGen: IdGenerator;

  constructor(store?: MuscleMemoryStore, idGen?: IdGenerator) {
    // ΑΩ-R20：缺省 = 引擎侧共享持久实例（不复制第二份存储）；显式注入优先
    this.store = store ?? sharedMuscleMemoryStore;
    this.idGen = idGen ?? createDefaultIdGenerator();
  }

  /** 已登记条目数（观测面 —— 测试与审计；ΑΩ-R20 后读的是共享持久账本） */
  registeredEntries(): number {
    return this.store.size();
  }

  /** W4-1：登记账面归零（测试隔离 / 卸载语义）。ΑΩ-R20：归零的是共享持久
   *  store 的内存态（与引擎 reset 同律 —— 落盘资产由卸载时序先行持久化） */
  reset(): void {
    this.store.reset();
  }

  /**
   * 门禁判决（绝不抛）：可靠度过闸 ⇒ 免排练直放；否则虚拟排练三态裁决。
   * opts.forceRehearsal：模板绑定产物的必排练标记（年轻证据 —— W3-2 产物
   * 的 successCount/attemptCount 尚未积累，数值闸无意义，结构上必排练）。
   */
  gate(opts: {
    reliability: number;
    steps: ReadonlyArray<SkillStep>;
    scene?: ReadonlyArray<MacroRehearsalSceneInput>;
    forceRehearsal?: boolean;
    trigger?: string;
  }): MacroRehearsalVerdict {
    try {
      const rel = typeof opts.reliability === 'number' && Number.isFinite(opts.reliability)
        ? opts.reliability : 0;
      const required = opts.forceRehearsal === true || rel < MACRO_REHEARSAL_GATE;
      if (!required) {
        return {
          required: false,
          verdict: 'not-required',
          allowed: true,
          note: `可靠度 ${rel.toFixed(3)} ≥ ${MACRO_REHEARSAL_GATE} —— 免排练直放（先验可信）`,
        };
      }
      const actions = translateToSandboxActions(opts.steps);
      if (actions.length === 0) {
        return {
          required, verdict: 'degraded', allowed: false,
          note: '宏链为空 —— 无可排练之物（拒绝放行）',
        };
      }
      // ΝΩ-30：unsupported 步计数（诚实归因面 —— degraded 时点名词表外工具）
      const unsupportedSteps = actions
        .filter(a => a.kind === 'noop' && typeof a.args?.[UNSUPPORTED_ARG] === 'string').length;
      const unsupportedNote = unsupportedSteps > 0
        ? `；${unsupportedSteps}/${actions.length} 步为词表外工具（unsupported —— 无沙箱状态模型，翻译为诚实缺席）`
        : '';
      const scene = buildVirtualScene(opts.scene);
      if (scene.length === 0) {
        return {
          required, verdict: 'degraded', allowed: false, unsupportedSteps: unsupportedSteps || undefined,
          note: `可靠度 ${rel.toFixed(3)} < ${MACRO_REHEARSAL_GATE} 且当前帧无控件场景证据 —— `
            + '沙箱无从排练（诚实拒绝：低可靠宏 + 零世界证据不放行）',
        };
      }
      // 引擎的 replay 出口消费宏链（零熵重演；反证 ⇒ failed，零证据 ⇒ degraded）
      const replay = deterministicReplay(actions, { scene });
      if (replay.verdict === 'failed') {
        return {
          required, verdict: 'failed', allowed: false, unsupportedSteps: unsupportedSteps || undefined,
          note: `虚拟排练反证（${replay.note}）—— 宏链在当前控件世界不可达，拒绝放行`,
        };
      }
      if (replay.verdict === 'degraded') {
        return {
          required, verdict: 'degraded', allowed: false, unsupportedSteps: unsupportedSteps || undefined,
          note: `虚拟排练零证据（${replay.note}）—— 无世界证据不放行${unsupportedNote}`,
        };
      }
      // passed：步骤链登记入 MuscleMemoryStore（「排练通过」的账面 —— 可靠度
      // 计数不动，唯一事实源仍是宿主重放）
      const trigger = typeof opts.trigger === 'string' && opts.trigger.trim() !== ''
        ? opts.trigger : `macro rehearsal (${actions.length} steps)`;
      const entry = this.store.consolidate(
        this.idGen, trigger, `macro-${Date.now().toString(36)}`, actions, undefined);
      // ΑΩ-R20（持久纪律）：排练通过即刻落盘 —— 登记的寿命不再依赖卸载钩子
      // （崩溃安全）。save 契约永不抛：无持久路径 = 旁路 true；落盘失败 warn
      // 旁路（持久化是资产不是命脉）。冻结副本/签名去重纪律由 consolidate 沿用。
      this.store.save();
      return {
        required, verdict: 'passed', allowed: true,
        muscleEntryId: entry.id,
        unsupportedSteps: unsupportedSteps || undefined,
        note: `虚拟排练通过（${replay.note}）—— 已登记肌肉记忆 ${entry.id}，放行宿主派发`,
      };
    } catch (e: any) {
      return {
        required: true, verdict: 'degraded', allowed: false,
        note: `门禁内部异常（${e?.message ?? 'unknown'}）—— 防御式拒绝`,
      };
    }
  }
}

/** W4-1：共享门禁单例（elementTracker 同生命周期形态 —— 纯模块级）。
 *  ΑΩ-R20：登记/查询走引擎侧 sharedMuscleMemoryStore —— 排练登记跨会话
 *  存活，宿主重放计数与门禁登记在同一账本积累（可靠度不再恒卡先验 0.5）。 */
export const sharedMacroRehearsalGate = new MacroRehearsalGate();

/** W4-1：生命周期归零（测试隔离 / 插件卸载语义对齐 —— 登记账面随会话清零） */
export function resetMacroRehearsalGate(): void {
  sharedMacroRehearsalGate.reset();
}
