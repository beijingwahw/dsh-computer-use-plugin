// src/quantumSense.ts
// D-3 量子感知：黑白盒叠加态。纯视觉是信仰，不是枷锁 —— 黑盒失明时，
// 白盒数据给模型一副眼镜，看完世界依然用眼睛。
//
// 核心不变式：模型的决策面永远是图。白盒数据零进对话流（Token 零成本），
// 只化作截图上的标注矩形，回归纯视觉决策闭环。
//
// 三条诚实性声明：
//   1. 置信度不计数 —— 模型自评（clickMouse.confidence）是软信号；
//      只有验证器的 effect_detected 是世界回击（硬证据）。降级只由硬证据触发。
//   2. 叠加态是急救室 —— 连续成功 K 次自动退回黑盒。白盒常驻 = 架构堕落回「结构化清单纪元」。
//   3. 无源不降级 —— 白盒源未就绪时失败计数累积但模式不动，degradeBlocked 诚实可见，
//      绝不假装进入叠加态（simulated success 是债的地层教训的对称面：simulated rescue 同罪）。
import { journal } from './journal';
import { extractInteractiveElements, hasAccessibilityProvider } from './uiExtractor';

export type SenseMode = 'black_box' | 'superposition';

/** 白盒节点：可交互元素的最小视觉标注单位 */
export interface WhiteboxNode {
  rect: { x: number; y: number; width: number; height: number }; // 原始像素
  /** name/role 摘要（渲染为标签；模块内截断 —— Token 纪律） */
  label: string;
}

/**
 * 白盒源协议：第一实现 = uiExtractor 适配器（元素 ID 模式的基础设施，零新依赖）。
 * isReady 同步 —— 状态机跃迁判据不引入异步；
 * extract 异步 —— 渲染时刻才取节点（1500ms 缓存窗口内 ID 稳定的既有语义）。
 * 未来实现（AT-SPI / UIA / 本地视觉模型）只需实现本协议 —— 架构留白。
 */
export interface WhiteboxProvider {
  readonly name: string;
  isReady(): boolean;
  /** 失败应返回 []（诚实降级，不抛错毒化截图管线） */
  extract(): Promise<WhiteboxNode[]>;
}

/** 叠加态截图标注：纯视觉渲染单位 */
export interface WhiteboxOverlay {
  /** 纯视觉渲染用的标注序号（叠加态 episode 内单调递增；非 uiExtractor 的 elementId —— 两套编号彻底解耦） */
  tag: number;
  label: string;
  rect: WhiteboxNode['rect'];
}

export interface QuantumStatus {
  mode: SenseMode;
  failStreak: number;
  successStreak: number;
  /** 失败达阈值但源未就绪的次数（诚实暴露「想自救但没有眼镜」） */
  degradeBlocked: number;
  /** 白盒源名（'ui-extractor' | null）；实例不外泄（审查修正 #4） */
  providerName: string | null;
}

/** checkpoint 快照（v3 第三次原地扩展的可选字段形态） */
export interface QuantumSnapshot {
  mode: SenseMode;
  failStreak: number;
  successStreak: number;
}

/** label 截断预算：标注文本最长 20 字符（Token 纪律） */
const LABEL_MAX = 20;

type Rect = WhiteboxNode['rect'];

/** IoU > 0.5 或中心点互相包含 ⇒ 同一视觉元素（去重策略：白盒只补盲区，不重复标注） */
function iou(a: Rect, b: Rect): number {
  const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  if (x2 <= x1 || y2 <= y1) return 0;
  const inter = (x2 - x1) * (y2 - y1);
  return inter / (a.width * a.height + b.width * b.height - inter);
}

function centerInside(a: Rect, b: Rect): boolean {
  const cx = a.x + a.width / 2, cy = a.y + a.height / 2;
  return cx >= b.x && cx <= b.x + b.width && cy >= b.y && cy <= b.y + b.height;
}

function overlaps(a: Rect, b: Rect): boolean {
  return iou(a, b) > 0.5 || centerInside(a, b) || centerInside(b, a);
}

/** UiExtractorWhitebox：元素 ID 模式基础设施的白盒适配器（零新依赖的通道复用） */
export class UiExtractorWhitebox implements WhiteboxProvider {
  readonly name = 'ui-extractor';
  isReady(): boolean {
    return hasAccessibilityProvider();
  }
  async extract(): Promise<WhiteboxNode[]> {
    try {
      const els = await extractInteractiveElements();
      return els.map(e => ({ rect: e.rect, label: e.name }));
    } catch {
      return []; // provider 缺失/树提取失败：诚实空集，不毒化截图管线
    }
  }
}

export interface QuantumSense {
  /**
   * 预算注入（唯一关闭路径 = enableQuantumSense=false：由 index.ts 保证此时
   * configure/setProvider/recordEffect 全不被调用 —— 单一事实源，审查修正 #3）。
   * @param degradeAfterFailures 下限钳制为 1（<=0 入参视为 1 —— 不存在第二条关闭语义）
   * @param restoreOnSuccess     下限钳制为 1
   * @param maxNodes             叠加态标注预算（overlayNodes 裁剪线），下限 1
   */
  configure(degradeAfterFailures: number, restoreOnSuccess: number, maxNodes?: number): void;
  /** 白盒源注入（index.ts：enableQuantumSense && enableElementIdMode 才接线） */
  setProvider(p: WhiteboxProvider | null): void;
  mode(): SenseMode;
  /**
   * 验证信号入口。调用方契约（唯一合法调用点 = settleAndVerify 消费之后）：
   *
   *   effect === null   ⇒ 传 undefined（验证未运行：verifyActions=false 或 dryRun ——
   *                        工具层 before=null 时 settleAndVerify 根本不被调用）
   *   effect !== null   ⇒ 传 effect.detected（类型为纯 boolean，不可能 undefined）
   *
   * 因此本方法所见 undefined 语义唯一：「本次动作没有验证证据」——不计数、不动状态机。
   * 未来若有人改动 settleAndVerify 返回路径，此契约由类型系统（boolean）与
   * 测试（undefined 直通锁）双重锁死。
   */
  recordEffect(detected: boolean | undefined): void;
  /**
   * 叠加态节点提取 + 内部去重。
   * dedup 策略（模块内实现，不进接口语义）：与 existing 的矩形 IoU > 0.5 或
   * 中心点互相包含者视为同一视觉元素，跳过 —— 白盒标注只补盲区，不重复标注。
   * 预算裁剪至 maxNodes 后返回；extract 失败返回 []（不毒化截图管线）。
   */
  overlayNodes(existing: Array<{ rect: Rect }>): Promise<WhiteboxOverlay[]>;
  status(): QuantumStatus;
  dump(): QuantumSnapshot;
  restore(state: QuantumSnapshot | undefined): void;
  reset(): void;
}

class QuantumMachine implements QuantumSense {
  private mode_: SenseMode = 'black_box';
  private failStreak = 0;
  private successStreak = 0;
  private degradeBlocked = 0;
  private provider: WhiteboxProvider | null = null;
  private degradeAfter = 3;
  private restoreOn = 2;
  private maxNodes = 30;
  private tagSeq = 0;
  /** 单一事实源：configure 被真实调用 = 特性存在。未启用时一切入口 no-op */
  private enabled = false;

  configure(degradeAfterFailures: number, restoreOnSuccess: number, maxNodes?: number): void {
    this.degradeAfter = Math.max(1, Math.floor(degradeAfterFailures));
    this.restoreOn = Math.max(1, Math.floor(restoreOnSuccess));
    this.maxNodes = Math.max(1, Math.floor(maxNodes ?? 30));
    this.enabled = true;
  }

  setProvider(p: WhiteboxProvider | null): void {
    this.provider = p;
  }

  mode(): SenseMode {
    return this.mode_;
  }

  recordEffect(detected: boolean | undefined): void {
    if (!this.enabled || detected === undefined) return; // 无验证证据：不计数（零回归保证）
    if (detected) {
      this.failStreak = 0;
      if (this.mode_ === 'superposition') {
        this.successStreak++;
        if (this.successStreak >= this.restoreOn) this.shift('black_box'); // 急救成功出院
      }
    } else {
      this.successStreak = 0;
      this.failStreak++;
      if (this.mode_ === 'black_box' && this.failStreak >= this.degradeAfter) {
        if (this.provider?.isReady()) {
          this.shift('superposition'); // 眼镜在：黑盒失明 ⇒ 借白盒一观
        } else {
          this.degradeBlocked++; // 无源不降级：想自救但没有眼镜，诚实计数
        }
      }
      // 叠加态下继续失败：留在急救室（白盒已是最后防线，无更深降级）
    }
  }

  private shift(to: SenseMode): void {
    const from = this.mode_;
    this.mode_ = to;
    this.failStreak = 0;
    this.successStreak = 0;
    if (to === 'superposition') this.tagSeq = 0; // episode 内编号从头计数
    void journal.appendMarker({ kind: 'SENSE_SHIFT', from, to }); // D-1 预留类型，直接消费
  }

  async overlayNodes(existing: Array<{ rect: Rect }>): Promise<WhiteboxOverlay[]> {
    if (!this.enabled || this.mode_ !== 'superposition' || !this.provider) return [];
    let nodes: WhiteboxNode[];
    try {
      nodes = await this.provider.extract();
    } catch {
      return []; // 白盒源故障：叠加态保持但不产出标注（不毒化截图管线）
    }
    const out: WhiteboxOverlay[] = [];
    for (const n of nodes) {
      if (out.length >= this.maxNodes) break; // 预算裁剪（Token 纪律）
      if (existing.some(e => overlaps(e.rect, n.rect))) continue; // 与已标注元素重合：跳过
      if (out.some(o => overlaps(o.rect, n.rect))) continue;      // 白盒彼此重合：跳过
      out.push({
        tag: ++this.tagSeq,
        label: n.label.length > LABEL_MAX ? `${n.label.slice(0, LABEL_MAX)}…` : n.label,
        rect: n.rect,
      });
    }
    return out;
  }

  status(): QuantumStatus {
    return {
      mode: this.mode_,
      failStreak: this.failStreak,
      successStreak: this.successStreak,
      degradeBlocked: this.degradeBlocked,
      providerName: this.provider?.name ?? null,
    };
  }

  dump(): QuantumSnapshot {
    return { mode: this.mode_, failStreak: this.failStreak, successStreak: this.successStreak };
  }

  restore(state: QuantumSnapshot | undefined): void {
    if (!state || (state.mode !== 'black_box' && state.mode !== 'superposition')) return;
    // 防御性恢复：非负整数钳制，坏档不毒化状态机
    this.mode_ = state.mode;
    this.failStreak = Math.max(0, Math.floor(state.failStreak ?? 0));
    this.successStreak = Math.max(0, Math.floor(state.successStreak ?? 0));
  }

  reset(): void {
    this.mode_ = 'black_box';
    this.failStreak = 0;
    this.successStreak = 0;
    this.degradeBlocked = 0;
    this.provider = null;
    this.tagSeq = 0;
    this.enabled = false;
  }
}

// 单例是正确的：一台躯体一副感知；模式跃迁的全局一致性由它保证
export const quantum = new QuantumMachine();
