// src/autonomy/gym.pcgWorld.ts
// W8-B1（DEBTS D-F1 拆分潮）：自 gym.ts 低风险分区提取（对齐 actionVerifier.*
// 兄弟文件先例）—— W4-4 PcgWorld 文法世界整体搬迁：确定性帧合成（renderPcgFrame，
// 视觉语言与 GymWorld.renderFrame 同源）、文法世界状态机（PcgWorld：幕序×视口×
// 遮幕×终局四维态，GymWorld 同接口面 + W1-4 噪声全维沿用）、世界工厂
// gymWorldFactory 与无限世界流水 pcgWorldStream（生成侧无限，消费侧预算封顶）。
// 行为零变化（纯搬运，逐字节不改）；gym.ts 以再导出保持导入面不变。画布立法
// （GYM_W/GYM_H）与噪声诊所契约自兄弟件导入 —— 单一事实源不变。绝不抛异常。
// ΠΑΝ-127（D-F5 清偿）：rng 立法改自零出边叶 gym.rng.ts 导入；DEFAULT_SEED
// 缺省回退上移至桶 gym.ts 的 pcgWorldStream 包装（立法在源桶，注入于边界）。
import { fnv1a, mulberry32 } from './gym.rng.js';
import { GYM_W, GYM_H } from './gym.world.js';
import { corruptOcrLabel, GYM_NOISY_OCR_CONF, resolveGymNoise } from './gym.noise.js';
import { derivePcgScene } from './gym.pcgDerive.js';
import { getSharp } from '../_legacyDeps.js';
// ─── W4-4：PcgWorld —— 文法世界的确定性状态机 + sharp 合成帧 ───
/**
 * W4-4：合成一帧（纯函数：同键同字节；视觉语言与 GymWorld.renderFrame 同源 ——
 * 纵向条带底噪 + 控件渐变色块 + 右上角状态戳方块）。sharp 经 _legacyDeps 懒加载。
 */
async function renderPcgFrame(key, ctrls) {
    const sharp = await getSharp();
    const data = Buffer.alloc(GYM_W * GYM_H * 3);
    for (let y = 0; y < GYM_H; y++) {
        const rowTone = 22 + (y % 24) * 2;
        for (let x = 0; x < GYM_W; x++) {
            const v = rowTone + ((x * 5 + y * 11) % 13);
            const i = (y * GYM_W + x) * 3;
            data[i] = v;
            data[i + 1] = v;
            data[i + 2] = v;
        }
    }
    for (const c of ctrls) {
        if (!c)
            continue;
        const hi = c.role === 'button' ? 228 : 132;
        const lo = c.role === 'button' ? 70 : 86;
        const span = Math.max(1, c.x1 - c.x0 - 1);
        for (let y = Math.max(0, c.y0); y < Math.min(GYM_H, c.y1); y++) {
            for (let x = Math.max(0, c.x0); x < Math.min(GYM_W, c.x1); x++) {
                const v = Math.round(hi - ((hi - lo) * (x - c.x0)) / span);
                const i = (y * GYM_W + x) * 3;
                data[i] = v;
                data[i + 1] = v;
                data[i + 2] = v;
            }
        }
    }
    const sx = GYM_W - 70 - (fnv1a(key) % 11) * 52;
    for (let y = 18; y < 54; y++) {
        for (let x = sx; x < sx + 36; x++) {
            const i = (y * GYM_W + x) * 3;
            data[i] = 250;
            data[i + 1] = 200;
            data[i + 2] = 90;
        }
    }
    return sharp(data, { raw: { width: GYM_W, height: GYM_H, channels: 3 } })
        .png()
        .toBuffer();
}
/**
 * W4-4 文法世界：由一次推导铸定的确定性场景状态机（GymWorld 同接口面）。
 *
 * 状态 = 幕序 stage × 视口 viewport × 遮幕 overlayOpen × 终局 done：
 *   · nodes()/controls() 按态取推导真值（遮幕态只见遮幕节点 —— popup-maze 同律；
 *     折叠幕顶视口只见死链预览，底视口才见真目标 —— scroll-hunt 同律）；
 *   · applyAction：click 按快照中心命中（遮幕解除/破坏性诱饵落账/前进翻幕）、
 *     scroll 翻视口、hotkey Esc 解遮幕；mutations = 世界真相变化计数；
 *   · clickLedger 记每次点击命中标签（null = 落空）—— 付费陷阱审计主料；
 *   · capture() 按状态键渲染并缓存（同态同 Buffer 身份 ⇒ 假 OCR/假 VLM 按帧
 *     反查口径同步）；W1-4 噪声谱全维沿用（词面腐蚀/置信跌落/漏检/bbox 抖动/
 *     瞬态中间帧 —— 只坏传感器，ground truth 分毫不动）。
 * 绝不抛异常：坏动作静默落空。
 */
export class PcgWorld {
    W = GYM_W;
    H = GYM_H;
    /** 文法推导种子（世界身份的锚） */
    seed;
    /** 推导真值（场景图/正确动作序列/判据 —— ground truth 唯一事实源） */
    derivation;
    stage = 0;
    viewport = 'top';
    overlayOpen = false;
    done = false;
    /** 死链点击计数（折叠幕顶视口的僵局执法锚） */
    deadHits = 0;
    /** 世界真相变化计数（progress/no_effect 的裁决变量） */
    mutations = 0;
    /** capture 调用计数 */
    captures = 0;
    /** 点击标签账本：命中节点标签；null = 落空点击 */
    clickLedger = [];
    /** 滚动账本 */
    scrollLog = [];
    frameCache = new Map();
    bufIndex = new Map();
    // ─── W1-4 噪声诊所纪律沿用（三种子流 + 瞬态中间帧；缺省零漂移） ───
    noise;
    noiseOcr;
    noiseVlm;
    noiseBbox;
    transientPending = false;
    transientCtrls = [];
    transientCount = 0;
    constructor(seed, opts = {}) {
        const seedNum = Number(seed);
        this.seed = (Number.isFinite(seedNum) ? Math.floor(seedNum) : 0) % 0x80000000;
        this.derivation = derivePcgScene(this.seed, opts);
        this.noise = resolveGymNoise(opts?.noise);
        this.noiseOcr = mulberry32(fnv1a(`w1-4:ocr:${this.noise.seed}`));
        this.noiseVlm = mulberry32(fnv1a(`w1-4:vlm:${this.noise.seed}`));
        this.noiseBbox = mulberry32(fnv1a(`w1-4:bbox:${this.noise.seed}`));
        // 遮幕初始态：atStage 恒 ≥1 ⇒ 首幕永不遮（推导立法保证；防御式再钳一次）
        this.overlayOpen = this.derivation.overlay !== null && this.derivation.overlay.atStage === 0;
    }
    /** ground truth 只读视图（= derivation 本体；真值不可变） */
    groundTruth() {
        return this.derivation;
    }
    /** 噪声谱只读视图（诊所观测面） */
    get noiseSpec() {
        return { ...this.noise };
    }
    /** 下一帧是否将回放瞬态中间帧（W1-4 自适应等待病理的观测锚） */
    get transientArmed() {
        return this.noise.transientFrame === 1 && this.transientPending;
    }
    /** 当前状态的唯一键（含推导指纹 —— 异世界异键 ⇒ 状态戳异像素） */
    stateKey() {
        return `pcg|${this.derivation.fingerprint}|s${this.stage}|v${this.viewport}|o${this.overlayOpen ? 1 : 0}|d${this.done ? 1 : 0}`;
    }
    /** 当前态的场景节点表（物理真相；渲染与命中判定的唯一事实源） */
    nodes() {
        if (this.done) {
            return [
                {
                    id: 'done-banner',
                    rule: 'fixed:banner',
                    kind: 'banner',
                    label: '下一步完成 文法场景收官',
                    interactive: false,
                    x0: 200,
                    y0: 250,
                    x1: 620,
                    y1: 330,
                },
            ];
        }
        if (this.overlayOpen)
            return this.derivation.overlay ? this.derivation.overlay.nodes : [];
        const st = this.derivation.stages[this.stage];
        if (!st)
            return [];
        if (st.needScroll && this.viewport === 'bottom' && st.bottom)
            return st.bottom;
        return st.top;
    }
    /** 物理控件真相表（节点 → GymControl 方言；interactive ⇒ button，否则 text） */
    controls() {
        return this.toCtrls(this.nodes());
    }
    /** 弹窗注记（遮幕态 ⇒ 一条注记；policy 弹窗优先律的触发信号） */
    popupNotes() {
        if (!this.overlayOpen || !this.derivation.overlay)
            return [];
        const zh = this.derivation.overlay.kind === 'payTrap'
            ? '付费陷阱'
            : this.derivation.overlay.kind === 'cookie'
                ? 'Cookie横幅'
                : '升级提示';
        return [`文法${zh}遮幕`];
    }
    /** 命中判定 + 状态机推进（世界立法：遮幕解除 / 诱饵落账 / 前进翻幕） */
    clickHit(px, py) {
        const list = this.nodes();
        let hit = null;
        for (let i = list.length - 1; i >= 0; i--) {
            const c = list[i];
            if (px >= c.x0 && px <= c.x1 && py >= c.y0 && py <= c.y1) {
                hit = c;
                break;
            }
        }
        this.clickLedger.push(hit ? hit.label : null);
        if (!hit)
            return;
        // 遮幕态：只认遮幕自己的按钮（dismiss 解除；trap 落账不推进 —— 破坏性诱饵）
        if (this.overlayOpen) {
            const o = this.derivation.overlay;
            if (o && hit.label === o.dismissLabel) {
                this.overlayOpen = false;
                this.mutations += 1;
            }
            return;
        }
        if (this.done)
            return;
        const st = this.derivation.stages[this.stage];
        if (!st)
            return;
        // 折叠幕顶视口：死链永不推进（两连无效后仍在感知面 —— 僵局切换交给 scroll）
        if (st.needScroll && this.viewport === 'top') {
            if (hit.kind === 'deadLink')
                this.deadHits += 1;
            return;
        }
        // 前进按钮：翻幕（幕序 +1、视口回顶、遮幕按推导登场、末幕收官）
        if (hit.kind === 'advance' && hit.label === st.target.label) {
            this.stage += 1;
            this.viewport = 'top';
            this.mutations += 1;
            if (this.stage >= this.derivation.stages.length) {
                this.done = true;
            }
            else if (this.derivation.overlay && this.derivation.overlay.atStage === this.stage) {
                this.overlayOpen = true;
            }
        }
        // 其余（家具元素等）：落账不推进
    }
    /** 滚动立法：仅折叠幕有双视口（down 暴露深部 / up 回顶） */
    scrollDir(dir) {
        this.scrollLog.push({ dir, amount: 5 });
        const st = this.derivation.stages[this.stage];
        if (!st || !st.needScroll)
            return;
        if (dir === 'down' && this.viewport === 'top') {
            this.viewport = 'bottom';
            this.mutations += 1;
        }
        else if (dir === 'up' && this.viewport === 'bottom') {
            this.viewport = 'top';
            this.mutations += 1;
        }
    }
    /** 世界唯一动作入口（W1-4 瞬态包装同律：翻态 ⇒ 武装一拍旧态回放） */
    applyAction(action) {
        if (this.noise.transientFrame !== 1) {
            this.applyActionInner(action);
            return;
        }
        const keyBefore = this.stateKey();
        const nodesBefore = this.nodes();
        this.applyActionInner(action);
        if (this.stateKey() !== keyBefore) {
            this.transientPending = true;
            this.transientCtrls = nodesBefore;
        }
    }
    applyActionInner(action) {
        const a = (action ?? {});
        const payload = a.payload && typeof a.payload === 'object' ? a.payload : {};
        switch (a.kind) {
            case 'click': {
                const c = a.target?.center;
                if (typeof c?.x !== 'number' || !Number.isFinite(c.x) || typeof c?.y !== 'number' || !Number.isFinite(c.y)) {
                    return; // 无处落点：绝不凭空点击
                }
                this.clickHit(Math.round(c.x), Math.round(c.y));
                return;
            }
            case 'scroll': {
                const raw = typeof payload.direction === 'string' ? payload.direction : 'down';
                this.scrollDir(raw === 'up' || raw === 'left' || raw === 'right' ? raw : 'down');
                return;
            }
            case 'hotkey': {
                const keys = Array.isArray(payload.keys) ? payload.keys : [];
                if (keys.some(k => String(k).toLowerCase() === 'esc') && this.overlayOpen) {
                    this.overlayOpen = false;
                    this.mutations += 1;
                }
                return;
            }
            default:
                return;
        }
    }
    /** 截屏：按状态键渲染并缓存（同态同 Buffer；瞬态中间帧同 W1-4 律） */
    async capture() {
        this.captures += 1;
        if (this.noise.transientFrame === 1 && this.transientPending) {
            this.transientPending = false;
            const nodes = this.transientCtrls.length > 0 ? this.transientCtrls : this.nodes();
            this.transientCount += 1;
            const lagKey = `${this.stateKey()}|lag${this.transientCount}`;
            let lagEntry = this.frameCache.get(lagKey);
            if (!lagEntry) {
                lagEntry = { buf: await renderPcgFrame(lagKey, this.toCtrls(nodes)), nodes };
                this.frameCache.set(lagKey, lagEntry);
                this.bufIndex.set(lagEntry.buf, nodes);
            }
            return lagEntry.buf;
        }
        const key = this.stateKey();
        let entry = this.frameCache.get(key);
        if (!entry) {
            const nodes = this.nodes();
            entry = { buf: await renderPcgFrame(key, this.toCtrls(nodes)), nodes };
            this.frameCache.set(key, entry);
            this.bufIndex.set(entry.buf, nodes);
        }
        return entry.buf;
    }
    /** 节点表 → 控件方言 */
    toCtrls(nodes) {
        return nodes.map(n => ({
            label: n.label,
            role: n.interactive ? 'button' : 'text',
            x0: n.x0,
            y0: n.y0,
            x1: n.x1,
            y1: n.y1,
        }));
    }
    /** W1-4：bbox 抖动（四边独立 ±n、夹画布、保序 —— GymWorld 同律） */
    jitterBBox(n) {
        if (this.noise.bboxJitterPx <= 0)
            return { x0: n.x0, y0: n.y0, x1: n.x1, y1: n.y1 };
        const j = this.noise.bboxJitterPx;
        const draw = () => Math.round((this.noiseBbox() * 2 - 1) * j);
        const ax = Math.min(GYM_W - 1, Math.max(0, n.x0 + draw()));
        const bx = Math.min(GYM_W - 1, Math.max(0, n.x1 + draw()));
        const ay = Math.min(GYM_H - 1, Math.max(0, n.y0 + draw()));
        const by = Math.min(GYM_H - 1, Math.max(0, n.y1 + draw()));
        return { x0: Math.min(ax, bx), y0: Math.min(ay, by), x1: Math.max(ax, bx), y1: Math.max(ay, by) };
    }
    /** 假 OCR：按捕获帧反查节点表（RuntimeWord 方言；W1-4 噪声全维沿用） */
    wordsFor(buf) {
        const base = this.bufIndex.get(buf) ?? this.nodes();
        if (!this.noise.active) {
            return base.map(n => ({
                label: n.label,
                bbox: { x0: n.x0, y0: n.y0, x1: n.x1, y1: n.y1 },
                confidence: 0.92,
            }));
        }
        return base.map(n => {
            let label = typeof n.label === 'string' ? n.label : '';
            if (this.noise.ocrSwapRate > 0 && label.length > 0) {
                label = corruptOcrLabel(label, this.noise.ocrSwapRate, this.noiseOcr);
            }
            let confidence = 0.92;
            if (this.noise.ocrConfDrop > 0 && this.noiseOcr() < this.noise.ocrConfDrop) {
                confidence = GYM_NOISY_OCR_CONF;
            }
            return { label, bbox: this.jitterBBox(n), confidence };
        });
    }
    /** 假 VLM 接地：同一套节点带角色（双源 ⇒ composeSnapshot 真实仲裁融合） */
    vlmFor(buf) {
        const base = this.bufIndex.get(buf) ?? this.nodes();
        if (!this.noise.active) {
            return base.map((n, i) => ({
                id: `e${i + 1}`,
                label: n.label,
                role: n.interactive ? 'button' : 'text',
                bbox: { x0: n.x0, y0: n.y0, x1: n.x1, y1: n.y1 },
                center: { x: (n.x0 + n.x1) / 2, y: (n.y0 + n.y1) / 2 },
                confidence: 0.9,
                source: 'vlm',
            }));
        }
        const out = [];
        for (let i = 0; i < base.length; i++) {
            const n = base[i];
            if (this.noise.vlmMissRate > 0 && this.noiseVlm() < this.noise.vlmMissRate)
                continue;
            const bbox = this.jitterBBox(n);
            out.push({
                id: `e${i + 1}`,
                label: typeof n.label === 'string' ? n.label : '',
                role: n.interactive ? 'button' : 'text',
                bbox,
                center: { x: (bbox.x0 + bbox.x1) / 2, y: (bbox.y0 + bbox.y1) / 2 },
                confidence: 0.9,
                source: 'vlm',
            });
        }
        return out;
    }
    /** 当前传感器口径的 OCR 全文（execute 判据抽查通道） */
    ocrText() {
        return this.nodes()
            .map(n => n.label)
            .join(' ');
    }
    /**
     * 立法真值：当前态唯一正确动作（Θ-3 policy.matchConfident 的对账面）。
     * 终局 ⇒ null（无真值，如实跳过）；遮幕 ⇒ 解除；折叠顶视口 ⇒ scroll；
     * 其余 ⇒ 前进按钮。
     */
    correctNext() {
        if (this.done)
            return null;
        if (this.overlayOpen) {
            const o = this.derivation.overlay;
            return o ? { kind: 'click', label: o.dismissLabel } : null;
        }
        const st = this.derivation.stages[this.stage];
        if (!st)
            return null;
        if (st.needScroll && this.viewport === 'top')
            return { kind: 'scroll' };
        return { kind: 'click', label: st.target.label };
    }
}
/**
 * W4-4 世界工厂：seed + 文法选项 → GymWorld 兼容世界实例。seed 钉死 ⇒ 推导
 * 字节级一致（同 seed 两次工厂 ⇒ 同真值同帧字节）。ground truth 同账本：opts.
 * ledger 在场时推导期已写 pcg.truth.*（见 derivePcgScene）。绝不抛。
 */
export function gymWorldFactory(seed, opts) {
    return new PcgWorld(seed, opts ?? {});
}
/**
 * W4-4 无限世界流水：按主种子派生逐世界种子（fnv1a 域分离，序号唯一），懒生成
 * 无限 PcgWorld 序列 —— 生成侧无限，消费侧预算封顶（runPcgTasks / campaign）。
 * 同 seed 同序号 ⇒ 同世界（重放一致）；无限性仅由「永不 done」的生成器承载。
 */
export function* pcgWorldStream(seed, opts) {
    // ΠΑΝ-127（D-F5 清偿）：非法种子的立法缺省回退（DEFAULT_SEED）上移至桶
    // gym.ts 的 pcgWorldStream 公开包装（立法在源桶）—— 本核心收到的种子已由
    // 包装归一为有限数；floor 律原样保留（行为零变化）。
    const master = Math.floor(Number(seed));
    const grammar = opts ?? {};
    let i = 0;
    for (;;) {
        const worldSeed = fnv1a(`w4-4:pcg:world:${master}:${i}`) % 0x7fffffff;
        yield gymWorldFactory(worldSeed, grammar);
        i += 1;
    }
}
