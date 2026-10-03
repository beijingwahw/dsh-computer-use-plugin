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
import { MuscleMemoryStore } from './memory';
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
  note: string;
}

/**
 * W4-1：宏链 → SandboxAction 翻译（纯函数、确定性、绝不抛）。
 * 宿主技能步方言（tool + args）→ 沙箱动作方言（kind + args）；沙箱词汇表
 * 之外的宿主工具 ⇒ noop（世界无状态模型 —— 诚实缺席而非拒绝整链）。
 */
export function translateToSandboxActions(steps: ReadonlyArray<SkillStep>): SandboxAction[] {
  const out: SandboxAction[] = [];
  for (const s of Array.isArray(steps) ? steps : []) {
    const args = s && typeof s.args === 'object' && s.args !== null ? { ...s.args } : {};
    switch (s?.tool) {
      case 'click_mouse':
      case 'type_text':
      case 'scroll_page':
      case 'press_hotkey':
      case 'drag_mouse':
      case 'switch_tab':
      case 'switch_window':
      case 'dismiss_popup':
        out.push({ kind: s.tool, args });
        break;
      default:
        out.push({ kind: 'noop', args: {} });
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
      role: 'unknown',
      name: String(w.label ?? '').slice(0, 20),
      rect: {
        x: Math.min(1, x), y: Math.min(1, y),
        width: Math.min(1, width), height: Math.min(1, height),
      },
      acceptsText: w.acceptsText === true,
      scrollable: w.scrollable === true,
      popup: w.popup === true,
    });
  }
  return widgets;
}

/**
 * W4-1：宏排练门禁 —— MuscleMemoryStore 虚拟排练的执行器接线。
 * 纯内存态（store 不 configure 落盘路径 ⇒ 会话级登记；持久化由宿主沙箱
 * 引擎自己的 MuscleMemoryStore 负责 —— 本门禁的登记是「放行证据账」）。
 */
export class MacroRehearsalGate {
  private readonly store: MuscleMemoryStore;
  private readonly idGen: IdGenerator;

  constructor(store?: MuscleMemoryStore, idGen?: IdGenerator) {
    this.store = store ?? new MuscleMemoryStore();
    this.idGen = idGen ?? createDefaultIdGenerator();
  }

  /** 已登记条目数（观测面 —— 测试与审计） */
  registeredEntries(): number {
    return this.store.size();
  }

  /** W4-1：登记账面归零（测试隔离 / 卸载语义 —— 排练登记是会话级轻量账） */
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
      const scene = buildVirtualScene(opts.scene);
      if (scene.length === 0) {
        return {
          required, verdict: 'degraded', allowed: false,
          note: `可靠度 ${rel.toFixed(3)} < ${MACRO_REHEARSAL_GATE} 且当前帧无控件场景证据 —— `
            + '沙箱无从排练（诚实拒绝：低可靠宏 + 零世界证据不放行）',
        };
      }
      // 引擎的 replay 出口消费宏链（零熵重演；反证 ⇒ failed，零证据 ⇒ degraded）
      const replay = deterministicReplay(actions, { scene });
      if (replay.verdict === 'failed') {
        return {
          required, verdict: 'failed', allowed: false,
          note: `虚拟排练反证（${replay.note}）—— 宏链在当前控件世界不可达，拒绝放行`,
        };
      }
      if (replay.verdict === 'degraded') {
        return {
          required, verdict: 'degraded', allowed: false,
          note: `虚拟排练零证据（${replay.note}）—— 无世界证据不放行`,
        };
      }
      // passed：步骤链登记入 MuscleMemoryStore（「排练通过」的账面 —— 可靠度
      // 计数不动，唯一事实源仍是宿主重放）
      const trigger = typeof opts.trigger === 'string' && opts.trigger.trim() !== ''
        ? opts.trigger : `macro rehearsal (${actions.length} steps)`;
      const entry = this.store.consolidate(
        this.idGen, trigger, `macro-${Date.now().toString(36)}`, actions, undefined);
      return {
        required, verdict: 'passed', allowed: true,
        muscleEntryId: entry.id,
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

/** W4-1：共享门禁单例（elementTracker 同生命周期形态 —— 纯模块、会话级内存态） */
export const sharedMacroRehearsalGate = new MacroRehearsalGate();

/** W4-1：生命周期归零（测试隔离 / 插件卸载语义对齐 —— 登记账面随会话清零） */
export function resetMacroRehearsalGate(): void {
  sharedMacroRehearsalGate.reset();
}
