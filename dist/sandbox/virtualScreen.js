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
        scrollable: raw.scrollable === true,
        popup: raw.popup === true, // K 纪元补全：esc 可关闭对象
    };
}
/**
 * 虚拟屏：应用动作序列，产出逐步证据。确定性、零 IO、永不抛错。
 */
export class VirtualScreen {
    widgets;
    focus = null;
    buffers = new Map();
    /** 滚动偏移记账（K 纪元：内容偏移 = 滚动证据的世界状态） */
    scrollOffsets = new Map();
    /** 活动标签指针（O 纪元 #14：标签页栈 —— role='tab' 控件按场景序成栈） */
    activeTab = null;
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
    /**
     * O 纪元（#15）：场景 OCR —— 区域内控件名拼接（场景供源的真文本；无像素
     * 世界的诚实等价物：widget.name 就是渲染后 OCR 会读到的文字）。命中区域
     * 的控件按场景序拼接；空区域返回空串。导出：L3 层的测试面。
     */
    sceneOcr(x, y, half = 0.08) {
        const texts = [];
        for (const w of this.widgets) {
            const { x: x0, y: y0 } = w.rect;
            const x1 = x0 + w.rect.width, y1 = y0 + w.rect.height;
            if (x1 >= x - half && x0 <= x + half && y1 >= y - half && y0 <= y + half) {
                texts.push(w.name);
                const buf = this.buffers.get(w);
                if (buf)
                    texts.push(buf); // 输入缓冲也是屏上文字（已上屏的输入）
            }
        }
        return texts.join(' ');
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
                    // O 纪元（#15）L3 语义层：expectedText 在场 ⇒ 场景 OCR 对照（瞄准
                    // 验证 —— 点的位置读出的文字应含预期 = 瞄对了控件）；缺席 ⇒ 聚焦
                    // 可输入控件即可落字的既有语义（零回归）。
                    if (action.expect.expectedText) {
                        expectationMet = hit !== null && this.sceneOcr(x, y).includes(action.expect.expectedText);
                        layers.push('L3-semantic', 'L4-expectation');
                        note += `; scene-ocr "${this.sceneOcr(x, y).slice(0, 24)}" vs expected "${action.expect.expectedText}"`;
                    }
                    else {
                        expectationMet = hit?.acceptsText === true; // 聚焦可输入控件 = 文字可落
                        layers.push('L4-expectation');
                    }
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
        // ── K 纪元补全：滚动证据（光标所在可滚动容器 ⇒ 内容偏移变化 = L1）──
        if (action.kind === 'scroll_page') {
            const dir = action.args?.direction;
            const amount = Number(action.args?.amount);
            if (typeof dir !== 'string' || !Number.isFinite(amount) || amount <= 0)
                return NO_EVIDENCE;
            const container = this.widgets.find(w => w.scrollable) ?? this.widgetAt(this.focus?.rect.x ?? 0.5, this.focus?.rect.y ?? 0.5);
            const scrollable = container?.scrollable === true ? container : this.widgets.find(w => w.scrollable && this.widgetAt(w.rect.x + w.rect.width / 2, w.rect.y + w.rect.height / 2));
            if (!scrollable) {
                return { effectDetected: false, expectationMet: null,
                    note: 'scroll with no scrollable container — content cannot move', layers: ['L1-pixel'] };
            }
            this.scrollOffsets.set(scrollable, (this.scrollOffsets.get(scrollable) ?? 0) + amount);
            return { effectDetected: true, expectationMet: null,
                note: `scrolled ${dir} x${amount} in ${scrollable.name} (offset ${this.scrollOffsets.get(scrollable)})`, layers: ['L1-pixel'] };
        }
        // ── K 纪元补全：热键证据（esc ⇒ 关闭最上层弹窗 = L1 状态变化）──
        if (action.kind === 'press_hotkey') {
            const keys = Array.isArray(action.args?.keys) ? action.args.keys : [];
            if (keys.length !== 1 || String(keys[0]).toLowerCase() !== 'esc')
                return NO_EVIDENCE; // 其他热键无键盘状态模型 —— 诚实缺席
            const popupIdx = this.widgets.findIndex(w => w.popup);
            if (popupIdx < 0) {
                return { effectDetected: false, expectationMet: null,
                    note: 'esc with no popup open — nothing to dismiss', layers: ['L1-pixel'] };
            }
            const [closed] = this.widgets.splice(popupIdx, 1);
            if (this.focus === closed)
                this.focus = null;
            return { effectDetected: true, expectationMet: null,
                note: `esc dismissed popup ${closed.name}`, layers: ['L1-pixel'] };
        }
        // ── N 纪元补全：拖拽证据（起点命中 = 抓取；抓空 = 反证）──
        if (action.kind === 'drag_mouse') {
            const sx = num(action.args?.startX), sy = num(action.args?.startY);
            const ex = num(action.args?.endX), ey = num(action.args?.endY);
            if (sx === null || sy === null || ex === null || ey === null)
                return NO_EVIDENCE;
            const grabbed = this.widgetAt(sx, sy);
            if (!grabbed) {
                return { effectDetected: false, expectationMet: null,
                    note: 'drag started on empty space — nothing grabbed', layers: ['L1-pixel'] };
            }
            this.focus = grabbed;
            return { effectDetected: true, expectationMet: null,
                note: `dragged ${grabbed.name} to (${ex.toFixed(2)},${ey.toFixed(2)})`, layers: ['L1-pixel'] };
        }
        // ── N 纪元补全：切窗证据（标题关键词命中控件 = 聚焦转移；无匹配 = 反证）──
        if (action.kind === 'switch_window') {
            const kw = typeof action.args?.titleKeyword === 'string' ? action.args.titleKeyword.toLowerCase() : '';
            if (!kw)
                return NO_EVIDENCE;
            const target = this.widgets.find(w => w.name.toLowerCase().includes(kw));
            if (!target) {
                return { effectDetected: false, expectationMet: null,
                    note: `no window title contains ${JSON.stringify(kw)}`, layers: ['L1-pixel'] };
            }
            this.focus = target;
            return { effectDetected: true, expectationMet: null,
                note: `focus moved to ${target.name} (title match)`, layers: ['L1-pixel'] };
        }
        // ── O 纪元补全（#14）：切签证据（标签页栈模型 —— role='tab' 按场景序成栈，
        // 活动指针循环移动；指针移动 = L1 状态变化。栈 <2 ⇒ 反证：无处可切）──
        if (action.kind === 'switch_tab') {
            const dir = action.args?.direction;
            const tabs = this.widgets.filter(w => w.role === 'tab');
            if (tabs.length < 2) {
                return { effectDetected: false, expectationMet: null,
                    note: `tab stack has ${tabs.length} tab(s) — nothing to switch to`,
                    layers: ['L1-pixel'] };
            }
            // 活动指针初始化：聚焦在标签上 ⇒ 就是它；否则首标签（场景序 = 文档序）
            if (!this.activeTab || !tabs.includes(this.activeTab)) {
                this.activeTab = this.focus && tabs.includes(this.focus) ? this.focus : tabs[0];
            }
            const from = this.activeTab;
            const idx = tabs.indexOf(from);
            const delta = dir === 'previous' ? -1 : 1; // 缺省/未知方向 = next（与工具面方言同律）
            const next = tabs[(idx + delta + tabs.length) % tabs.length];
            this.activeTab = next;
            this.activeTab = next;
            this.focus = next;
            return { effectDetected: true, expectationMet: null,
                note: `tab ${from.name} → ${next.name} (${dir ?? 'next'}, stack ${tabs.length})`,
                layers: ['L1-pixel'] };
        }
        return NO_EVIDENCE; // dismiss_popup/noop：元动作无状态模型（值即边界）
    }
}
