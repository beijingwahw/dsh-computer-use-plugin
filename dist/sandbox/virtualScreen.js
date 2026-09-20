const NO_EVIDENCE = {
    effectDetected: null, expectationMet: null,
    note: 'no virtual scene or action outside the simulable vocabulary',
    layers: [],
};
/** 防御性控件铸造：畸形 rect 拒收（诚实缺席优于毒化命中测试） */
export function asVirtualWidget(raw) {
    if (!raw || typeof raw !== 'object')
        return null;
    const r = raw.rect;
    const x = Number(r?.x), y = Number(r?.y), w = Number(r?.width), h = Number(r?.height);
    if (![x, y, w, h].every(Number.isFinite) || x < 0 || y < 0 || w <= 0 || h <= 0)
        return null;
    if (x > 1 || y > 1 || x + w > 1 + 1e-9 || y + h > 1 + 1e-9)
        return null;
    return {
        role: String(raw.role ?? 'unknown'),
        name: String(raw.name ?? '').slice(0, 20),
        rect: { x, y, width: w, height: h },
        acceptsText: raw.acceptsText === true,
    };
}
/**
 * 虚拟屏：应用动作序列，产出逐步证据。确定性、零 IO、永不抛错。
 */
export class VirtualScreen {
    widgets;
    focus = null;
    buffers = new Map();
    constructor(rawWidgets) {
        this.widgets = Array.isArray(rawWidgets)
            ? rawWidgets.map(asVirtualWidget).filter((w) => w !== null)
            : [];
    }
    get isEmpty() { return this.widgets.length === 0; }
    /** 命中测试：中心落区语义（半开 [x0,x1) + 边缘闭合 —— 与分派方言同律） */
    widgetAt(x, y) {
        for (const w of this.widgets) {
            const { x: x0, y: y0 } = w.rect;
            const x1 = x0 + w.rect.width, y1 = y0 + w.rect.height;
            const inX = x >= x0 && (x < x1 || x1 >= 1);
            const inY = y >= y0 && (y < y1 || y1 >= 1);
            if (inX && inY)
                return w;
        }
        return null;
    }
    /** 应用单步动作 → 证据（世界状态随之转移） */
    applyAction(action) {
        if (this.isEmpty)
            return NO_EVIDENCE;
        const num = (v) => typeof v === 'number' && Number.isFinite(v) ? v : null;
        if (action.kind === 'click_mouse') {
            const x = num(action.args?.x), y = num(action.args?.y);
            if (x === null || y === null)
                return NO_EVIDENCE;
            const hit = this.widgetAt(x, y);
            this.focus = hit; // 命中 ⇒ 聚焦转移；落空 ⇒ 焦点丢失（两者都是状态变化证据）
            const layers = ['L1-pixel'];
            let expectationMet = null;
            let note = hit ? `hit ${hit.role}(${hit.name})@${x.toFixed(2)},${y.toFixed(2)}` : 'miss: no widget under point';
            if (action.expect) {
                if (action.expect.scale === 'element-level') {
                    expectationMet = hit !== null;
                    layers.push('L4-expectation');
                }
                else if (action.expect.scale === 'text-level') {
                    expectationMet = hit?.acceptsText === true; // 聚焦可输入控件 = 文字可落
                    layers.push('L4-expectation');
                }
                else {
                    note += '; page-level expectation unverifiable without a navigation model (honest null)';
                }
            }
            return { effectDetected: hit !== null, expectationMet, note, layers };
        }
        if (action.kind === 'type_text') {
            const text = typeof action.args?.text === 'string' ? action.args.text : null;
            if (text === null)
                return NO_EVIDENCE;
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
            let expectationMet = null;
            const layers = ['L1-pixel'];
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
