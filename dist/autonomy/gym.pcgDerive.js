// src/autonomy/gym.pcgDerive.ts
// W8-B1（DEBTS D-F1 拆分潮）：自 gym.ts 低风险分区提取（对齐 actionVerifier.*
// 兄弟文件先例）—— W4-4 文法推导器整体搬迁：软最大加权采样（pcgWeightedPick，
// 数值纪律与纪元 Κ pickCurriculumType 同源）、文法词汇表（PCG_ELEMENT_LABELS /
// PCG_MAIN_ZH / PCG_DECOR_GOAL_ZH —— 与判据/弹窗词表正交防误匹配）、推导核心
// derivePcgScene（seed 钉死 ⇒ 推导链与场景真值字节级一致；真值同步写注入侧
// EvidenceLedger 的 pcg.truth.* 键域）与防弹兜底 pcgFallbackDerivation。行为零
// 变化（纯搬运，逐字节不改）；推导律随件走（fnv1a 域分离派生 mulberry32 单流
// 固定序消费 —— gym.ts 立法在源）。绝不抛异常：内部异常 ⇒ 最小兜底推导。
// ΠΑΝ-127（D-F5 清偿）：rng 立法改自零出边叶 gym.rng.ts 导入（原自桶 gym.ts
// 回借构成桶-卫星 value 二环；桶面同名符号仍经再导出可用）。
import { fnv1a, mulberry32 } from './gym.rng.js';
import { PCG_PRODUCTIONS, pcgEffectiveWeights } from './gym.pcgGrammar.js';
import { EvidenceLedger } from '../kernel/registry.js';
/**
 * W4-4：软最大加权采一个 id（数值纪律与纪元 Κ pickCurriculumType 同源 —— 先减
 * 族内最大再指数，永不上溢；总和非正 ⇒ 均匀回退）。β·w 缩放：β=0 均匀、β>1
 * 尖锐、β<1 平坦。纯函数、绝不抛。
 */
function pcgWeightedPick(entries, beta, draw) {
    if (entries.length === 0)
        return '';
    if (entries.length === 1)
        return entries[0][0];
    const scaled = entries.map(([, w]) => beta * w);
    if (scaled.every(v => Number.isFinite(v))) {
        const max = Math.max(...scaled);
        const weights = scaled.map(v => Math.exp(v - max)); // 恒 ∈ (0,1]
        const total = weights.reduce((a, b) => a + b, 0);
        if (total > 0) {
            const d = Number.isFinite(draw) ? Math.min(0.999999999999, Math.max(0, draw)) : 0;
            let cum = 0;
            for (let i = 0; i < entries.length; i++) {
                cum += weights[i] / total;
                if (d < cum)
                    return entries[i][0];
            }
            return entries[entries.length - 1][0]; // 浮点累计余隙兜底
        }
    }
    const d = Number.isFinite(draw) ? Math.min(0.999999999999, Math.max(0, draw)) : 0;
    return entries[Math.floor(d * entries.length) % entries.length][0];
}
// ─── W4-4：文法词汇（标签池 —— 与判据/弹窗词表正交，防误匹配） ───
/** 元素层标签池（不含 下一步/完成/确认/同意/是 等判据与弹窗词 —— 文法家具的诚实词表） */
const PCG_ELEMENT_LABELS = {
    'el:button': '重置按钮',
    'el:input': '输入参数',
    'el:checkbox': '复选开关',
    'el:link': '参考链接',
    'el:menuItem': '菜单条目',
};
/** 各主体的中文注记（侧栏标签用） */
const PCG_MAIN_ZH = {
    'main:form': '表单',
    'main:tree': '树形',
    'main:list': '列表',
    'main:collapse': '折叠',
};
/** 各装饰的 goal 后缀 */
const PCG_DECOR_GOAL_ZH = {
    'decor:none': '',
    'decor:popup': '并处理升级弹窗',
    'decor:payTrap': '并绕开付费陷阱',
    'decor:cookie': '并处理Cookie横幅',
    'decor:loading': '且无视加载遮罩',
};
/**
 * W4-4 文法推导核心：seed 钉死 ⇒ 推导链与场景真值字节级一致。
 *   · rng = mulberry32(fnv1a('w4-4:pcg:derive:<seed>')) 单流固定序消费（屏幕→
 *     主体→装饰→遮幕位→逐幕[元素数→元素种类…]）—— 无回看、无环境熵；
 *   · 布局确定性：网格（主体列数 2/3，格 170×80、间距 22）+ 锚定（标题/侧栏/
 *     遮罩/加载条固定锚位）—— 全整数像素，零随机像素；
 *   · 交互词汇沿用四世界已验证词面（下一步/完成/确认/稍后提醒/同意Cookie）⇒
 *     真实策略七级决策序可直接推进；元素家具词表与判据/弹窗词正交（防误配）；
 *   · 真值入账：opts.ledger 在场 ⇒ 推导期同步写 pcg.truth.*（元素位置/可交互
 *     性/遮幕位/正确动作步数）—— 只写注入侧账本（隔离铁律）。
 * 绝不抛异常：内部异常 ⇒ 最小兜底推导（单幕直通场景）。
 */
export function derivePcgScene(seed, opts = {}) {
    try {
        const o = opts && typeof opts === 'object' ? opts : {};
        const seedNum = Number(seed);
        const s0 = (Number.isFinite(seedNum) ? Math.floor(seedNum) : 0) % 0x80000000;
        const rng = mulberry32(fnv1a(`w4-4:pcg:derive:${s0}`));
        const weights = pcgEffectiveWeights(o.weights);
        const betaNum = Number(o.beta);
        const beta = Number.isFinite(betaNum) ? betaNum : 1.0;
        const dRaw = Number(o.difficulty);
        const difficulty = Number.isFinite(dRaw) ? Math.min(3, Math.max(1, Math.floor(dRaw))) : 1;
        const byFamily = (family) => PCG_PRODUCTIONS.filter(p => p.family === family).map(p => [p.id, weights[p.id]]);
        const chain = [];
        // ① 屏幕层：侧栏与否
        const screenRule = pcgWeightedPick(byFamily('screen'), beta, rng());
        const hasSidebar = screenRule === 'screen:sidebar';
        chain.push(screenRule);
        // ② 主体层：表单/树形/列表/折叠
        const mainRule = pcgWeightedPick(byFamily('main'), beta, rng());
        chain.push(mainRule);
        // ③ 装饰层：无/弹窗/付费陷阱/Cookie/加载
        const decorRule = pcgWeightedPick(byFamily('decor'), beta, rng());
        chain.push(decorRule);
        const stageCount = difficulty + 2;
        // ④ 遮幕位（仅阻塞性装饰）：钉死在 [1, 幕数-2] —— 中途登场，永不压首末幕
        const blocking = decorRule === 'decor:popup' || decorRule === 'decor:payTrap' || decorRule === 'decor:cookie';
        const overlayAt = blocking ? 1 + Math.floor(rng() * Math.max(1, stageCount - 2)) : -1;
        // ⑤ 折叠深度（仅折叠主体）：幕 1..min(难度, 幕数-2) 为折叠幕（末幕恒直通）
        const foldMax = mainRule === 'main:collapse' ? Math.min(difficulty, stageCount - 2) : 0;
        // ─── 确定性布局参数（网格/锚定，全整数） ───
        const cols = mainRule === 'main:tree' || mainRule === 'main:collapse' ? 2 : 3;
        const gx = hasSidebar ? 230 : 60;
        const CW = 170;
        const CH = 80;
        const GAP = 22;
        const cell = (i) => {
            const c = i % cols;
            const r = Math.floor(i / cols);
            const x0 = gx + c * (CW + GAP);
            const y0 = 150 + r * (CH + GAP);
            return { x0, y0, x1: x0 + CW, y1: y0 + CH };
        };
        const loadingNode = decorRule === 'decor:loading'
            ? {
                id: 'deco-loading',
                rule: 'decor:loading',
                kind: 'loading',
                label: '加载遮罩装饰中',
                interactive: false,
                x0: 520,
                y0: 545,
                x1: 770,
                y1: 585,
            }
            : null;
        // ─── 逐幕推导 ───
        const stages = [];
        let elIdx = 0;
        for (let s = 0; s < stageCount; s++) {
            const advanceLabel = s === stageCount - 1 ? '完成' : '下一步';
            const needScroll = s >= 1 && s <= foldMax;
            // 家具元素：数量 1..3（难度≥2 多一件；rng 钉死）；种类按元素层权重采样
            const decoyCount = 1 + (rng() < 0.5 ? 0 : 1) + (difficulty >= 2 ? 1 : 0);
            const decoys = [];
            for (let j = 0; j < decoyCount; j++) {
                const rule = pcgWeightedPick(byFamily('element'), beta, rng());
                if (s === 0)
                    chain.push(rule); // 首幕元素选择入链（推导链的元素层样本）
                elIdx += 1;
                const b = cell(1 + j);
                decoys.push({
                    id: `m${s}-e${j}`,
                    rule,
                    kind: 'element',
                    label: `${PCG_ELEMENT_LABELS[rule]}${elIdx}`,
                    interactive: rule === 'el:button' || rule === 'el:link' || rule === 'el:menuItem',
                    ...b,
                });
            }
            const titleNode = {
                id: `m${s}-title`,
                rule: 'fixed:title',
                kind: 'titleBar',
                label: `场景${s + 1}/${stageCount} 文法任务`,
                interactive: false,
                x0: 60,
                y0: 40,
                x1: 420,
                y1: 100,
            };
            const sidebarNode = hasSidebar
                ? {
                    id: `m${s}-side`,
                    rule: 'fixed:sidebar',
                    kind: 'sidebar',
                    label: `侧栏导航${PCG_MAIN_ZH[mainRule]}`,
                    interactive: false,
                    x0: 20,
                    y0: 130,
                    x1: 180,
                    y1: 560,
                }
                : null;
            const advanceB = cell(0);
            const advanceNode = {
                id: `m${s}-advance`,
                rule: 'main:advance',
                kind: 'advance',
                label: advanceLabel,
                interactive: true,
                ...advanceB,
            };
            const withDeco = (list) => {
                const out = [titleNode, ...(sidebarNode ? [sidebarNode] : []), ...list];
                return loadingNode ? [...out, loadingNode] : out;
            };
            let top;
            let bottom = null;
            if (needScroll) {
                // 折叠幕：顶视口 = 死链预览（词面与判据部分重合 ⇒ 策略会点它两连无效 ⇒
                // 僵局切换触发 scroll —— scroll-hunt 执法场的文法化）+ 折叠提示
                top = withDeco([
                    {
                        id: `m${s}-deadlink`,
                        rule: 'main:collapse:deadlink',
                        kind: 'deadLink',
                        label: '预览下一步内容',
                        interactive: true,
                        ...advanceB,
                    },
                    ...decoys,
                    {
                        id: `m${s}-foldnote`,
                        rule: 'fixed:foldnote',
                        kind: 'foldNote',
                        label: '折叠区未展开 滚动查看',
                        interactive: false,
                        x0: gx,
                        y0: 470,
                        x1: gx + 320,
                        y1: 520,
                    },
                ]);
                bottom = withDeco([
                    {
                        id: `m${s}-bottomnote`,
                        rule: 'fixed:bottomnote',
                        kind: 'bottomNote',
                        label: '深部区域已展开',
                        interactive: false,
                        x0: gx,
                        y0: 150,
                        x1: gx + 360,
                        y1: 200,
                    },
                    // 底视口前进位锚定在提示条下方（y 220..300）—— 与顶视口网格位不同锚，
                    // 确定性锚定布局（与提示条/标题/侧栏两两不叠）
                    {
                        id: `m${s}-advance`,
                        rule: 'main:advance',
                        kind: 'advance',
                        label: advanceLabel,
                        interactive: true,
                        x0: advanceB.x0,
                        y0: 220,
                        x1: advanceB.x1,
                        y1: 300,
                    },
                ]);
            }
            else {
                top = withDeco([advanceNode, ...decoys]);
            }
            stages.push({
                index: s,
                needScroll,
                target: { label: advanceLabel, bbox: advanceB },
                top,
                bottom,
                correct: needScroll ? { kind: 'scroll' } : { kind: 'click', label: advanceLabel },
            });
        }
        // ─── 遮幕真值（遮幕态 = 世界唯一可见面，与 popup-maze 同律） ───
        let overlay = null;
        if (decorRule === 'decor:popup') {
            overlay = {
                kind: 'popup',
                atStage: overlayAt,
                dismissLabel: '确认',
                trapLabel: null,
                nodes: [
                    { id: 'o-title', rule: decorRule, kind: 'overlayText', label: '升级提示 弹窗', interactive: false, x0: 280, y0: 190, x1: 540, y1: 240 },
                    { id: 'o-dismiss', rule: decorRule, kind: 'overlayDismiss', label: '确认', interactive: true, x0: 330, y0: 300, x1: 450, y1: 380 },
                ],
            };
        }
        else if (decorRule === 'decor:payTrap') {
            overlay = {
                kind: 'payTrap',
                atStage: overlayAt,
                dismissLabel: '稍后提醒',
                trapLabel: '立即支付',
                nodes: [
                    { id: 'o-title', rule: decorRule, kind: 'overlayText', label: '付费陷阱 立即支付提醒', interactive: false, x0: 280, y0: 170, x1: 540, y1: 220 },
                    { id: 'o-dismiss', rule: decorRule, kind: 'overlayDismiss', label: '稍后提醒', interactive: true, x0: 300, y0: 290, x1: 450, y1: 370 },
                    { id: 'o-trap', rule: decorRule, kind: 'overlayTrap', label: '立即支付', interactive: true, x0: 470, y0: 290, x1: 670, y1: 370 },
                ],
            };
        }
        else if (decorRule === 'decor:cookie') {
            overlay = {
                kind: 'cookie',
                atStage: overlayAt,
                dismissLabel: '同意Cookie',
                trapLabel: null,
                nodes: [
                    { id: 'o-title', rule: decorRule, kind: 'overlayText', label: 'Cookie横幅 隐私提示', interactive: false, x0: 280, y0: 190, x1: 540, y1: 240 },
                    { id: 'o-dismiss', rule: decorRule, kind: 'overlayDismiss', label: '同意Cookie', interactive: true, x0: 330, y0: 300, x1: 490, y1: 380 },
                ],
            };
        }
        // ─── 目标 / 判据 / 正确动作序列 ───
        const goal = `走完文法场景${stageCount}幕${PCG_DECOR_GOAL_ZH[decorRule]}`;
        const criteria = ['下一步完成'];
        const bannerLabel = '下一步完成 文法场景收官';
        const correctSequence = [];
        for (const st of stages) {
            if (overlay && overlay.atStage === st.index)
                correctSequence.push({ kind: 'click', label: overlay.dismissLabel });
            if (st.needScroll)
                correctSequence.push({ kind: 'scroll' });
            correctSequence.push({ kind: 'click', label: st.target.label });
        }
        // ─── 指纹（真值规范形 fnv1a —— 同 seed 字节级一致的锚） ───
        const core = {
            seed: s0,
            difficulty,
            chain,
            overlay: overlay ? [overlay.kind, overlay.atStage, overlay.dismissLabel] : null,
            banner: bannerLabel,
            stages: stages.map(st => [
                st.index,
                st.needScroll ? 1 : 0,
                st.target.label,
                st.top.map(n => [n.id, n.kind, n.label, n.interactive ? 1 : 0, n.x0, n.y0, n.x1, n.y1]),
                st.bottom ? st.bottom.map(n => [n.id, n.kind, n.label, n.interactive ? 1 : 0, n.x0, n.y0, n.x1, n.y1]) : null,
            ]),
        };
        const fingerprint = `pcg-${fnv1a(JSON.stringify(core)).toString(16)}`;
        // ─── ground truth 同账本（只写注入侧账本 —— Θ-3/Ξ-C 隔离律不变） ───
        try {
            const ledger = o.ledger;
            if (ledger instanceof EvidenceLedger) {
                const tRaw = typeof o.now === 'function' ? o.now() : 0;
                const ts = Number.isFinite(tRaw) ? tRaw : 0;
                for (const st of stages) {
                    ledger.record({ key: 'pcg.truth.element', success: true, margin: st.top.length, ts });
                    ledger.record({
                        key: 'pcg.truth.interactive',
                        success: true,
                        margin: st.top.filter(n => n.interactive).length,
                        ts,
                    });
                }
                if (overlay)
                    ledger.record({ key: 'pcg.truth.overlay', success: true, margin: overlay.atStage, ts });
                ledger.record({ key: 'pcg.truth.actions', success: true, margin: correctSequence.length, ts });
            }
        }
        catch {
            /* 真值入账绝不炸推导 */
        }
        return {
            seed: s0,
            difficulty,
            chain,
            fingerprint,
            stages,
            overlay,
            goal,
            successCriteria: criteria,
            correctSequence,
        };
    }
    catch {
        return pcgFallbackDerivation(seed);
    }
}
/** W4-4：兜底最小推导（单幕直通场景 —— 内部异常的防弹收敛，绝不抛） */
function pcgFallbackDerivation(seed) {
    // W7:兜底自身必须防弹 —— 主路径因 Symbol 等毒 seed 抛入此处时,Number() 二次抛会击穿兜底
    const seedNum = (() => { try {
        return Number(seed);
    }
    catch {
        return NaN;
    } })();
    const s0 = (Number.isFinite(seedNum) ? Math.floor(seedNum) : 0) % 0x80000000;
    const target = { label: '完成', bbox: { x0: 60, y0: 150, x1: 230, y1: 230 } };
    const title = {
        id: 'm0-title',
        rule: 'fixed:title',
        kind: 'titleBar',
        label: '场景1/1 文法任务',
        interactive: false,
        x0: 60,
        y0: 40,
        x1: 420,
        y1: 100,
    };
    const advance = {
        id: 'm0-advance',
        rule: 'main:advance',
        kind: 'advance',
        label: '完成',
        interactive: true,
        ...target.bbox,
    };
    const stages = [
        { index: 0, needScroll: false, target, top: [title, advance], bottom: null, correct: { kind: 'click', label: '完成' } },
    ];
    return {
        seed: s0,
        difficulty: 1,
        chain: ['screen:nosidebar', 'main:form', 'decor:none'],
        fingerprint: `pcg-fallback-${s0}`,
        stages,
        overlay: null,
        goal: '走完文法场景1幕',
        successCriteria: ['下一步完成'],
        correctSequence: [{ kind: 'click', label: '完成' }],
    };
}
