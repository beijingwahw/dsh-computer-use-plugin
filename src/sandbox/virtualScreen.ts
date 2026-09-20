// src/sandbox/virtualScreen.ts
// K 纪元（留白兑现之一）：虚拟屏模拟器 —— 排练验证层的第一块真证据。
//
// 诚实契约（值即边界）：
//   - 本模拟器不是像素渲染器 —— 它是一个**确定性控件世界**（widget world）。
//     证据来源是命中测试与状态转移，不是合成位图；我们绝不假装渲染了屏幕。
//   - 场景（widgets）由调用方供给。生产路径：规划期从 UI 树提取真实控件
//     （getUiTree / extractInteractiveElements 的产物映射而来）—— 排练因此
//     验证的是**真实控件几何**上的可达性，而非虚构世界。
//   - 无场景 ⇒ 无证据（effectDetected=null）—— 既有 degraded 语义零回归。
//   - 可验证的动作：click（命中=控件聚焦）、type（焦点控件可收文本）。
//     scroll/hotkey/switch 无布局/键盘状态模型 —— 恒 null（诚实缺席）。
//   - L4 期望对照：element-level ⇔ 命中；text-level+expectedText ⇔ 焦点输入
//     缓冲包含预期文本；page-level 需导航模型 —— 恒 null（声明即无法对照）。
import type { SandboxAction, VirtualWidget } from './types';

export type { VirtualWidget } from './types';

/** 步进证据：两层各是 boolean|null —— null = 该层不可判（诚实缺席，非 false） */
export interface StepEvidence {
  effectDetected: boolean | null;
  expectationMet: boolean | null;
  note: string;
  /** 本步产生的验证层（计入 RehearsalOutcome.verificationLayers 的评分） */
  layers: Array<'L1-pixel' | 'L4-expectation'>;
}

const NO_EVIDENCE: StepEvidence = {
  effectDetected: null, expectationMet: null,
  note: 'no virtual scene or action outside the simulable vocabulary',
  layers: [],
};

/** 防御性控件铸造：畸形 rect 拒收（诚实缺席优于毒化命中测试） */
export function asVirtualWidget(raw: unknown): VirtualWidget | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = (raw as any).rect;
  const x = Number(r?.x), y = Number(r?.y), w = Number(r?.width), h = Number(r?.height);
  if (![x, y, w, h].every(Number.isFinite) || x < 0 || y < 0 || w <= 0 || h <= 0) return null;
  if (x > 1 || y > 1 || x + w > 1 + 1e-9 || y + h > 1 + 1e-9) return null;
  return {
    role: String((raw as any).role ?? 'unknown'),
    name: String((raw as any).name ?? '').slice(0, 20),
    rect: { x, y, width: w, height: h },
    acceptsText: (raw as any).acceptsText === true,
  };
}

/**
 * 虚拟屏：应用动作序列，产出逐步证据。确定性、零 IO、永不抛错。
 */
export class VirtualScreen {
  private readonly widgets: VirtualWidget[];
  private focus: VirtualWidget | null = null;
  private readonly buffers = new Map<VirtualWidget, string>();

  constructor(rawWidgets: unknown) {
    this.widgets = Array.isArray(rawWidgets)
      ? rawWidgets.map(asVirtualWidget).filter((w): w is VirtualWidget => w !== null)
      : [];
  }

  get isEmpty(): boolean { return this.widgets.length === 0; }

  /** 命中测试：中心落区语义（半开 [x0,x1) + 边缘闭合 —— 与分派方言同律） */
  widgetAt(x: number, y: number): VirtualWidget | null {
    for (const w of this.widgets) {
      const { x: x0, y: y0 } = w.rect;
      const x1 = x0 + w.rect.width, y1 = y0 + w.rect.height;
      const inX = x >= x0 && (x < x1 || x1 >= 1);
      const inY = y >= y0 && (y < y1 || y1 >= 1);
      if (inX && inY) return w;
    }
    return null;
  }

  /** 应用单步动作 → 证据（世界状态随之转移） */
  applyAction(action: SandboxAction): StepEvidence {
    if (this.isEmpty) return NO_EVIDENCE;
    const num = (v: unknown): number | null =>
      typeof v === 'number' && Number.isFinite(v) ? v : null;

    if (action.kind === 'click_mouse') {
      const x = num(action.args?.x), y = num(action.args?.y);
      if (x === null || y === null) return NO_EVIDENCE;
      const hit = this.widgetAt(x, y);
      this.focus = hit; // 命中 ⇒ 聚焦转移；落空 ⇒ 焦点丢失（两者都是状态变化证据）
      const layers: StepEvidence['layers'] = ['L1-pixel'];
      let expectationMet: boolean | null = null;
      let note = hit ? `hit ${hit.role}(${hit.name})@${x.toFixed(2)},${y.toFixed(2)}` : 'miss: no widget under point';
      if (action.expect) {
        if (action.expect.scale === 'element-level') {
          expectationMet = hit !== null;
          layers.push('L4-expectation');
        } else if (action.expect.scale === 'text-level') {
          expectationMet = hit?.acceptsText === true; // 聚焦可输入控件 = 文字可落
          layers.push('L4-expectation');
        } else {
          note += '; page-level expectation unverifiable without a navigation model (honest null)';
        }
      }
      return { effectDetected: hit !== null, expectationMet, note, layers };
    }

    if (action.kind === 'type_text') {
      const text = typeof action.args?.text === 'string' ? action.args.text : null;
      if (text === null) return NO_EVIDENCE;
      const target = this.focus;
      if (!target) {
        return { effectDetected: false, expectationMet: action.expect ? false : null,
          note: 'typed with no focused widget — text has nowhere to land',
          layers: action.expect ? ['L1-pixel', 'L4-expectation'] : ['L1-pixel'] };
      }
      if (!target.acceptsText) {
        return { effectDetected: false, expectationMet: action.expect ? false : null,
          note: `focused ${target.role}(${target.name}) does not accept text`,
          layers: action.expect ? ['L1-pixel', 'L4-expectation'] : ['L1-pixel'] };
      }
      const buf = (this.buffers.get(target) ?? '') + text;
      this.buffers.set(target, buf);
      let expectationMet: boolean | null = null;
      const layers: StepEvidence['layers'] = ['L1-pixel'];
      if (action.expect?.scale === 'text-level') {
        expectationMet = action.expect.expectedText
          ? buf.includes(action.expect.expectedText)
          : true; // 未声明具体文本：落在输入框即为满足
        layers.push('L4-expectation');
      }
      return { effectDetected: true, expectationMet,
        note: `typed ${text.length} chars into ${target.name} (buffer ${buf.length})`, layers };
    }

    return NO_EVIDENCE; // scroll/hotkey/switch/dismiss/noop：布局与键盘模型留白
  }
}
