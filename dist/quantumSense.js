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
import { journal } from './journal.js';
import { extractInteractiveElements, hasAccessibilityProvider } from './uiExtractor.js';
/** label 截断预算：标注文本最长 20 字符（Token 纪律） */
const LABEL_MAX = 20;
/** IoU > 0.5 或中心点互相包含 ⇒ 同一视觉元素（去重策略：白盒只补盲区，不重复标注） */
function iou(a, b) {
    const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.width, b.x + b.width);
    const y2 = Math.min(a.y + a.height, b.y + b.height);
    if (x2 <= x1 || y2 <= y1)
        return 0;
    const inter = (x2 - x1) * (y2 - y1);
    return inter / (a.width * a.height + b.width * b.height - inter);
}
function centerInside(a, b) {
    const cx = a.x + a.width / 2, cy = a.y + a.height / 2;
    return cx >= b.x && cx <= b.x + b.width && cy >= b.y && cy <= b.y + b.height;
}
function overlaps(a, b) {
    return iou(a, b) > 0.5 || centerInside(a, b) || centerInside(b, a);
}
/** UiExtractorWhitebox：元素 ID 模式基础设施的白盒适配器（零新依赖的通道复用） */
export class UiExtractorWhitebox {
    name = 'ui-extractor';
    isReady() {
        return hasAccessibilityProvider();
    }
    async extract() {
        try {
            const els = await extractInteractiveElements();
            return els.map(e => ({ rect: e.rect, label: e.name }));
        }
        catch {
            return []; // provider 缺失/树提取失败：诚实空集，不毒化截图管线
        }
    }
}
class QuantumMachine {
    mode_ = 'black_box';
    failStreak = 0;
    successStreak = 0;
    degradeBlocked = 0;
    provider = null;
    degradeAfter = 3;
    restoreOn = 2;
    maxNodes = 30;
    tagSeq = 0;
    /** 单一事实源：configure 被真实调用 = 特性存在。未启用时一切入口 no-op */
    enabled = false;
    configure(degradeAfterFailures, restoreOnSuccess, maxNodes) {
        this.degradeAfter = Math.max(1, Math.floor(degradeAfterFailures));
        this.restoreOn = Math.max(1, Math.floor(restoreOnSuccess));
        this.maxNodes = Math.max(1, Math.floor(maxNodes ?? 30));
        this.enabled = true;
    }
    setProvider(p) {
        this.provider = p;
    }
    mode() {
        return this.mode_;
    }
    recordEffect(detected) {
        if (!this.enabled || detected === undefined)
            return; // 无验证证据：不计数（零回归保证）
        if (detected) {
            this.failStreak = 0;
            if (this.mode_ === 'superposition') {
                this.successStreak++;
                if (this.successStreak >= this.restoreOn)
                    this.shift('black_box'); // 急救成功出院
            }
        }
        else {
            this.successStreak = 0;
            this.failStreak++;
            if (this.mode_ === 'black_box' && this.failStreak >= this.degradeAfter) {
                if (this.provider?.isReady()) {
                    this.shift('superposition'); // 眼镜在：黑盒失明 ⇒ 借白盒一观
                }
                else {
                    this.degradeBlocked++; // 无源不降级：想自救但没有眼镜，诚实计数
                }
            }
            // 叠加态下继续失败：留在急救室（白盒已是最后防线，无更深降级）
        }
    }
    shift(to) {
        const from = this.mode_;
        this.mode_ = to;
        this.failStreak = 0;
        this.successStreak = 0;
        if (to === 'superposition')
            this.tagSeq = 0; // episode 内编号从头计数
        void journal.appendMarker({ kind: 'SENSE_SHIFT', from, to }); // D-1 预留类型，直接消费
    }
    async overlayNodes(existing) {
        if (!this.enabled || this.mode_ !== 'superposition' || !this.provider)
            return [];
        let nodes;
        try {
            nodes = await this.provider.extract();
        }
        catch {
            return []; // 白盒源故障：叠加态保持但不产出标注（不毒化截图管线）
        }
        const out = [];
        for (const n of nodes) {
            if (out.length >= this.maxNodes)
                break; // 预算裁剪（Token 纪律）
            if (existing.some(e => overlaps(e.rect, n.rect)))
                continue; // 与已标注元素重合：跳过
            if (out.some(o => overlaps(o.rect, n.rect)))
                continue; // 白盒彼此重合：跳过
            out.push({
                tag: ++this.tagSeq,
                label: n.label.length > LABEL_MAX ? `${n.label.slice(0, LABEL_MAX)}…` : n.label,
                rect: n.rect,
            });
        }
        return out;
    }
    status() {
        return {
            mode: this.mode_,
            failStreak: this.failStreak,
            successStreak: this.successStreak,
            degradeBlocked: this.degradeBlocked,
            providerName: this.provider?.name ?? null,
        };
    }
    dump() {
        return { mode: this.mode_, failStreak: this.failStreak, successStreak: this.successStreak };
    }
    restore(state) {
        if (!state || (state.mode !== 'black_box' && state.mode !== 'superposition'))
            return;
        // 防御性恢复：非负整数钳制，坏档不毒化状态机
        this.mode_ = state.mode;
        this.failStreak = Math.max(0, Math.floor(state.failStreak ?? 0));
        this.successStreak = Math.max(0, Math.floor(state.successStreak ?? 0));
    }
    reset() {
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
