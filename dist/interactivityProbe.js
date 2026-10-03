import * as backend from './physicalBackend.js';
import { similarity } from './perceptualHash.js';
import { getPopupState } from './guards/popupGuard.js';
import { probeMemory, isDecisive, bernoulliBits, PROBE_ECON_CHANNELS, } from './probeMemory.js';
// Z-2 迁出转发：几何先验独立成纯模块（wordShape.ts）—— 反射弧场景源
// （零二进制依赖的工位桩）需要同一把尺子过滤正文词，import 本文件会连带
// physicalBackend 污染桩纪元。既有 import 面（textTools/测试）零变更。
export { classifyWordShape } from './wordShape.js';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
/** OS 换光标所需的最小沉降时间（WM_SETCURCUR 即时生效，60ms 足够裕量） */
const CURSOR_SETTLE_MS = 60;
/** 决定性光标形态：读到即判，无需等待重绘通道 */
const DECISIVE_CURSORS = new Set(['hand', 'ibeam']);
/** 重绘轮询步长：悬停高亮通常 <200ms 出现，150ms 步进检出即停 */
const REPAINT_POLL_STEP_MS = 150;
/** 单点区域指纹（metaOnly：只算指纹不编码不传图 —— 探针零带宽开销） */
async function regionHash(nx, ny, r) {
    const cap = await backend.captureProcessed({
        metaOnly: true,
        wantRegionHash: { x: nx, y: ny, r },
    });
    return cap.regionDhash ?? null;
}
/** 判决融合（悬停双通道）：光标形态 + 重绘证据 → 结论（纯函数，测试面） */
export function fuseVerdict(cursorKind, repaintSimilarity, repaintThreshold) {
    const repaint = repaintSimilarity != null && repaintSimilarity < repaintThreshold;
    switch (cursorKind) {
        case 'hand':
            // 0.96 封顶：行为证据永远低于 UIA 结构层登记（0.97）—— 判别力
            // 天花板律在数字上也要成立，否则融合优先级名不副实
            return { verdict: 'control', confidence: repaint ? 0.96 : 0.95 };
        case 'ibeam':
            // I 型 = 文本域（正文或输入框）。对「找入口」语义是拒绝；调用方
            // 的 next_step 会注明：若目标本就是输入框，点击并验证聚焦即可。
            return { verdict: 'text', confidence: 0.92 };
        case 'arrow':
        case 'custom':
            // 原生 Win32 按钮常保持箭头 —— 重绘是唯一旁证
            return repaint
                ? { verdict: 'control', confidence: 0.85 }
                : { verdict: 'inconclusive', confidence: 0.3 };
        default:
            // unsupported/error/hidden/wait/busy/resize/cross：光标通道缺席或
            // 无判决力，单独依赖重绘通道
            return repaint
                ? { verdict: 'control', confidence: 0.8 }
                : { verdict: 'inconclusive', confidence: 0.2 };
    }
}
/**
 * UIA 点查询判决（通道 1，纯函数，测试面）。
 * control/text 有判决；unknown/unavailable 返回 null（降级到悬停双通道）。
 */
export function uiaVerdict(classification) {
    switch (classification) {
        case 'control': return { verdict: 'control', confidence: 0.97 };
        case 'text': return { verdict: 'text', confidence: 0.93 };
        default: return null; // unknown / unavailable / 异常值
    }
}
// ─── 纪元 Ν（探索经济学）：通道的信息经济学 —— 学会花钱，学会停 ───
//
// Z 纪元的三通道降序是**先验**：判别力是世界属性——网页世界光标通道每秒比特
// 远超 UIA（Web/canvas 无结构层登记，UIA 点查询只花钱不翻案），原生应用反
// 过来。Ν 从判决记忆旁的经济学账（probeMemory.noteChannel，flips/trials/
// totalMs）读出每通道 bitsPerMs 后验，把两个经济学决策接到探针：
//
//   花钱律（排序）：通道按期望信息增益每毫秒（bitsPerMs）降序执行；
//   停止法则（何时停）：累积熵减 ≥ 阈值即停，不为余下通道花钱——
//   同预算下更快收敛到判决。
//
// 零回归铁律：只动「顺序与何时停」，不动判决语义——融合优先级恒为 Z 纪元
// 固定序（UIA > 光标 > 重绘），无论执行顺序如何；记忆召回仍在一切实验之前。
/** 后验样本数下限：<5 的通道不信其 bitsPerMs，保先验序（冷启动不乱来） */
export const PROBE_ECON_MIN_SAMPLES = 5;
/**
 * 停止法则熵阈（bits）：决定性判决的熵减下界 = 1 − H₂(0.92) ≈ 0.598
 * （悬停 ibeam，最弱的决定性判决）> 0.5 ⇒ 任何决定性判决都会触发停止；
 * 非决定性观察（inconclusive 0~0.3）熵减 ≤ 1 − H₂(0.3) ≈ 0.119 < 0.5 ⇒
 * 永不触发。这保证了停止法则只会砍掉「判决已立之后」的确认型通道，绝不会
 * 砍掉「还可能给出判决」的通道 ⇒ 判决语义零回归。
 */
export const PROBE_ECON_STOP_BITS = 0.5;
/** 经济地板（bits/ms）：低于此的通道视为耗时通道（先验重绘 ≈0.0014 在地板下） */
export const PROBE_ECON_EXPENSIVE_BITS_PER_MS = 0.002;
/** 先验通道序 = Z 纪元判别力降序（UIA > 光标 > 重绘） */
const PRIOR_ORDER = PROBE_ECON_CHANNELS;
/**
 * 先验 bitsPerMs（冷启动序 = 先验序的数值化）：Z 纪元设计先验「判别力 ÷ 典型
 * 成本」——UIA ≈0.8 bit / ~40ms（COM 点查询）；光标 ≈0.75 bit / ~100ms
 * （迁移 + 60ms 沉降 + 读形态）；重绘 ≈0.5 bit / ~350ms（dwell 轮询）。
 */
const PRIOR_BITS_PER_MS = {
    uia: 0.02, cursor: 0.0075, repaint: 0.0014,
};
const priorRank = (ch) => PRIOR_ORDER.indexOf(ch);
/** 决定性判决的熵减近似（bits，纯函数，测试面）：
 *  试前对 control/text 对半无知（先验 0.5 ⇒ 判决问题 1 bit）；判决置信 c ⇒
 *  残余不确定性 = H₂(c) ⇒ 熵减 = 1 − H₂(c)。弃权（inconclusive）不减熵 ⇒ 0。 */
export function verdictBits(verdict, confidence) {
    if (!isDecisive(verdict))
        return 0; // 「不知道」不是证据
    const c = Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0;
    return 1 - bernoulliBits(c);
}
/** 经济学排序（纯函数，测试面）：通道按有效 bitsPerMs 降序。
 *  有效分：后验样本 ≥ PROBE_ECON_MIN_SAMPLES 的通道取账本 bitsPerMs；
 *  样本不足的通道取先验分——冷启动全员取先验 ⇒ 序逐字节等于 Z 纪元固定序，
 *  未知通道不会被噪声分乱序（「从不改写」与「总是改写」的样本饥饿期尤甚）。
 *  并列取先验秩（确定性）。物理律：重绘的基线指纹必须悬停前摄取、光标形态
 *  沉降后即读（零额外等待）⇒ 执行序恒「光标先于重绘」；经济分只决定悬停
 *  双通道相对 UIA 的位置。 */
export function economyChannelOrder(econ) {
    const byChannel = new Map(econ.map(e => [e.channel, e]));
    const scored = PRIOR_ORDER.map(ch => {
        const st = byChannel.get(ch);
        const sampled = !!st && Number.isFinite(st.trials) && st.trials >= PROBE_ECON_MIN_SAMPLES &&
            Number.isFinite(st.bitsPerMs);
        return { ch, rank: priorRank(ch), score: sampled ? st.bitsPerMs : PRIOR_BITS_PER_MS[ch] };
    });
    scored.sort((a, b) => b.score - a.score || a.rank - b.rank);
    const order = scored.map(s => s.ch);
    const ci = order.indexOf('cursor');
    const ri = order.indexOf('repaint');
    if (ci >= 0 && ri >= 0 && ri < ci) {
        order[ri] = 'cursor';
        order[ci] = 'repaint';
    }
    return order;
}
/**
 * 停止法则（纯函数，测试面）：standing 判决已立、且剩余通道不值得再花钱？
 *
 *   律 A（熵阈）：累积熵减 ≥ PROBE_ECON_STOP_BITS ⇒ 停。熵减按 standing
 *     判决的残余不确定性计（1 − H₂(c)），不做逐通道加总——后续证据**替换**
 *     而非叠加先前的信念，加总会重复计数。
 *   律 B（成本律）：仅剩「固定融合序下无改写权」（先验秩低于 standing 通道
 *     ⇒ 其证据永远改写不了最终判决标签）且「经济上被支配」（bitsPerMs 低于
 *     地板，样本不足取先验分）的耗时通道 ⇒ 停。
 *
 * 零回归论证：默认阈值下律 A 蕴含律 B（standing 必为决定性 ⇒ 熵减 ≥ 0.598
 * > 0.5 ⇒ 律 A 已触发）；律 B 独立生效于阈值被调高的配置，且它砍掉的通道
 * （如 hand/ibeam 已判后的重绘）在融合矩阵下**只能加 0.01 置信、永远改不了
 * 判决标签**——两律都不可能把「还能改写判决标签」的通道砍掉。
 */
export function economyShouldStop(standing, remaining, econ = []) {
    if (!standing || !isDecisive(standing.verdict) || remaining.length === 0)
        return false;
    // 律 A：熵阈
    if (verdictBits(standing.verdict, standing.confidence) >= PROBE_ECON_STOP_BITS)
        return true;
    // 律 B：仅剩无改写权的耗时通道
    const standingRank = priorRank(standing.channel);
    const byChannel = new Map(econ.map(e => [e.channel, e]));
    return remaining.every(ch => {
        if (priorRank(ch) <= standingRank)
            return false; // 有改写权的通道不砍
        const st = byChannel.get(ch);
        const sampled = !!st && Number.isFinite(st.trials) && st.trials >= PROBE_ECON_MIN_SAMPLES &&
            Number.isFinite(st.bitsPerMs);
        const rate = sampled ? st.bitsPerMs : PRIOR_BITS_PER_MS[ch];
        return rate < PROBE_ECON_EXPENSIVE_BITS_PER_MS;
    });
}
/**
 * OCR 词元几何先验（探针缺席时的降级判据，也用于排序探针目标）：
   宽行/多行 ⇒ 正文（聊天消息/文档段落）；紧凑短标签 ⇒ 控件候选。
 * Z-2 起实现迁至 wordShape.ts（纯模块），此处转发再导出保持既有 import 面。
 */
/** 悬停实验守卫：只有动真实指针的实验才受约束（UIA 只读感知不受限） */
function hoverGuardSkip(config) {
    if (config.dryRun)
        return 'dry-run: physical world-action is disabled (UIA verdicts still apply)';
    if (getPopupState())
        return 'popup active: probing through a dialog is unsafe (UIA verdicts still apply)';
    return null;
}
function emptyEvidence(via) {
    return {
        via,
        cursor_kind: 'n/a',
        hover_repaint: false,
        repaint_similarity: null,
        dwell_ms: 0,
    };
}
/**
 * 批量探针（find_text / probe_interactivity 共用面）：三遍架构。
 *
 * 第 0 遍（全员）：场景指纹 + 判决记忆召回（Z-1d）—— 一次 metaOnly 全屏
 * 指纹（~100ms，全批共享），同场景邻近点直接复用判决：零实验、零鼠标、
 * dry-run/弹窗期同样生效（纯只读）。
 * 第一遍（残余）：UIA 点查询 —— 零物理副作用。
 * 第二遍（残余）：悬停实验 —— 自适应 dwell：决定性光标（hand/ibeam）
 * 读完即判（~240ms/点，不等 350ms）；仅 arrow/custom 走重绘轮询
 * （150ms 步进，检出即停）。存档原位 → 逐点实验 → finally 复位。
 * 结算：判决性结论（control/text）随场景指纹入册 —— 每个界面只付
 * 一次实验费，此后零成本零副作用。
 *
 * 纪元 Ν（探索经济学）：enableProbeEconomy 开 ⇒ 残余实验按通道 bitsPerMs
 * 后验择序执行、熵减足额即停（probeEconomic）；关 ⇒ 固定三通道降序逐字节
 * 旧行为（probeLegacy）。两路共享第 0 遍与结算 —— 判决语义零变化。
 */
export async function probePoints(config, points) {
    if (points.length === 0)
        return [];
    const results = new Array(points.length).fill(null);
    // ── 第 0 遍：场景指纹 + 判决记忆召回（Z-1d）──
    let sceneFp = null;
    if (config.enableProbeMemory) {
        try {
            const cap = await backend.captureProcessed({ metaOnly: true, wantHashes: true });
            sceneFp = cap.dhash ?? null;
        }
        catch {
            sceneFp = null; /* 指纹失败：记忆通道缺席，不阻断实验 */
        }
    }
    if (sceneFp) {
        for (let i = 0; i < points.length; i++) {
            const hit = probeMemory.recall(sceneFp, points[i], config);
            if (hit)
                results[i] = hit;
        }
    }
    if (config.enableProbeEconomy) {
        // 纪元 Ν 经济路径：通道按 bitsPerMs 后验择序、熵减足额即停（判决语义不变）
        await probeEconomic(config, points, results);
    }
    else {
        // 固定三通道降序（Z 纪元原路径，逐字节旧行为）
        await probeLegacy(config, points, results);
    }
    // ── 结算：判决性结论入册（Z-1d：每界面一次实验，此后零成本）──
    if (sceneFp) {
        for (const r of results) {
            if (r && isDecisive(r.verdict) && r.evidence.via !== 'memory') {
                probeMemory.store(sceneFp, r, config);
            }
        }
    }
    return results;
}
/**
 * Z 纪元固定序路径（enableProbeEconomy=false / 关闭经济）：三遍架构逐字节
 * 保留——第一遍全员 UIA，第二遍残余点悬停实验。零回归基线。
 */
async function probeLegacy(config, points, results) {
    // ── 第一遍：UIA 结构层判决（不动鼠标）──
    for (let i = 0; i < points.length; i++) {
        if (results[i])
            continue; // 记忆已判
        try {
            const hit = await backend.hitTest(points[i].x, points[i].y);
            const fused = uiaVerdict(hit.classification);
            if (fused) {
                results[i] = {
                    point: points[i],
                    verdict: fused.verdict,
                    confidence: fused.confidence,
                    evidence: {
                        ...emptyEvidence('uia'),
                        hit_test: {
                            control_type: hit.control_type ?? null,
                            name: hit.name ?? '',
                            classification: hit.classification,
                            matched_depth: hit.matched_depth ?? null,
                        },
                    },
                };
            }
        }
        catch {
            // 端点缺席（旧服务）/COM 失败 —— 通道缺席，静默降级到第二遍
        }
    }
    // ── 第二遍：悬停实验（仅残余点）──
    const pending = points.map((p, i) => ({ p, i })).filter(({ i }) => results[i] === null);
    const skip = hoverGuardSkip(config);
    if (skip) {
        for (const { p, i } of pending) {
            results[i] = {
                point: p, verdict: 'inconclusive', confidence: 0,
                evidence: emptyEvidence('none'),
                note: skip,
            };
        }
    }
    else {
        const dwell = config.probeDwellMs;
        const radius = config.probeRegionRadius;
        const threshold = config.probeRepaintThreshold;
        // 原位存档（像素域 → 归一化；副屏负坐标夹取 —— 与 clickMouse 同律）
        const [saved, size] = await Promise.all([backend.getCursor(), backend.getScreenSize()]);
        const restore = {
            x: Math.min(1, Math.max(0, saved.x / size.width)),
            y: Math.min(1, Math.max(0, saved.y / size.height)),
        };
        try {
            for (let k = 0; k < pending.length; k++) {
                const { p, i } = pending[k];
                let neededCooldown = false;
                try {
                    const before = await regionHash(p.x, p.y, radius);
                    await backend.moveMouse(p.x, p.y);
                    await sleep(CURSOR_SETTLE_MS);
                    const kindInfo = await backend.getCursorKind();
                    let sim = null;
                    if (DECISIVE_CURSORS.has(kindInfo.kind)) {
                        // 早退：决定性形态已到手，重绘通道无需测量（省 dwell 全程）
                    }
                    else {
                        // 自适应重绘轮询：150ms 步进，检出即停，上限 ceil(dwell/step) 步
                        neededCooldown = true;
                        const maxPolls = Math.max(1, Math.ceil(dwell / REPAINT_POLL_STEP_MS));
                        for (let n = 0; n < maxPolls; n++) {
                            await sleep(REPAINT_POLL_STEP_MS);
                            const after = await regionHash(p.x, p.y, radius);
                            if (before && after) {
                                sim = similarity(before, after);
                                if (sim < threshold)
                                    break;
                            }
                        }
                    }
                    const fused = fuseVerdict(kindInfo.kind, sim, threshold);
                    results[i] = {
                        point: p,
                        verdict: fused.verdict,
                        confidence: fused.confidence,
                        evidence: {
                            via: 'hover',
                            cursor_kind: kindInfo.kind,
                            hover_repaint: sim != null && sim < threshold,
                            repaint_similarity: sim,
                            dwell_ms: dwell,
                        },
                    };
                }
                catch (e) {
                    // 单点失败不弃整个实验批次（其余点可能是好证据）
                    results[i] = {
                        point: p, verdict: 'inconclusive', confidence: 0,
                        evidence: emptyEvidence('hover'),
                        note: `probe failed: ${e?.message ?? e}`,
                    };
                }
                // 冷却仅在走过轮询路径后需要（悬停状态/tooltip 消散）；决定性早退免冷却
                if (neededCooldown && k < pending.length - 1)
                    await sleep(120);
            }
        }
        finally {
            try {
                await backend.moveMouse(restore.x, restore.y);
            }
            catch { /* 复位尽力而为 */ }
        }
    }
}
/**
 * 纪元 Ν 经济路径：每点一条通道流水线——按账本 bitsPerMs 后验择序执行通道，
 * 停止法则熵减足额即停（不再探满三通道）。
 *
 * 与 Z 纪元判决语义的逐条对应（零回归铁律）：
 *   - 记忆召回仍在一切实验之前（pass 0 在 probePoints 批级先行，本函数只见残余）；
 *   - 融合优先级恒为固定序 UIA > 悬停（fuseVerdict 矩阵一字不动）——经济序
 *     只决定**执行**顺序，终判永远取固定序下最高优先级的决定性证据；
 *   - 悬停访问内部物理序恒「光标先于重绘」（基线指纹须悬停前摄取、光标形态
 *     沉降后即读）；决定性光标仍不等重绘（省 dwell 全程，与旧路径同律）；
 *   - 守卫（dry-run/弹窗）只拦物理悬停，UIA 只读感知照常判决（同律）；
 *   - 停止法则只砍「判决已立之后」的通道（见 economyShouldStop 论证），
 *     悬停后仍 inconclusive 的点照常走完所有通道（弃权不减熵，永不触发停止）。
 *
 * 记账：每次通道执行记 trials/ms（含通道缺席/失败的执行——成本真实发生了），
 * 改写 standing 判决记 flips；被记忆召回短路的点无通道执行，不记。
 */
async function probeEconomic(config, points, results) {
    const pending = points.map((p, i) => ({ p, i })).filter(({ i }) => results[i] === null);
    if (pending.length === 0)
        return;
    const dwell = config.probeDwellMs;
    const radius = config.probeRegionRadius;
    const threshold = config.probeRepaintThreshold;
    const skip = hoverGuardSkip(config);
    // 通道经济序 + 账本快照（批内固定：一次调用的排序不因批内记账漂移）
    const econ = probeMemory.channelEconomics();
    const order = economyChannelOrder(econ);
    const bitsSnapshot = Object.fromEntries(econ.map(e => [e.channel, e.bitsPerMs]));
    // 原位存档（懒取：首个悬停访问前；像素域 → 归一化、副屏夹取 —— 与旧路径同律）
    let restore = null;
    try {
        for (let k = 0; k < pending.length; k++) {
            const { p, i } = pending[k];
            // 每点通道流水线状态
            let standing = null;
            let hit = null;
            let uiaFused = null;
            let cursorKind = null;
            let sim = null;
            let preHoverHash = null;
            let hoverOpened = false;
            let neededCooldown = false;
            let stoppedEarly = false;
            let spentMs = 0;
            let failNote = null;
            for (let s = 0; s < order.length; s++) {
                const ch = order[s];
                const beforeLabel = standing?.verdict ?? null;
                const t0 = Date.now();
                if (ch === 'uia') {
                    // UIA 只读感知：守卫不拦（与旧路径第一遍同律）
                    try {
                        hit = await backend.hitTest(p.x, p.y);
                        uiaFused = uiaVerdict(hit.classification);
                    }
                    catch {
                        hit = null;
                        uiaFused = null; // 端点缺席/COM 失败 —— 通道缺席
                    }
                    const ms = Date.now() - t0;
                    spentMs += ms;
                    probeMemory.noteChannel('uia', ms, beforeLabel, uiaFused?.verdict ?? null);
                    if (uiaFused) {
                        standing = { verdict: uiaFused.verdict, confidence: uiaFused.confidence, channel: 'uia' };
                    }
                }
                else if (!skip) {
                    // 悬停通道：访问懒开（首个悬停通道触发；含重绘基线的前置摄取）
                    try {
                        if (!hoverOpened) {
                            if (order.slice(s).includes('repaint')) {
                                // 物理前置：重绘基线指纹必须悬停前摄取（hover 高亮会污染基线）
                                preHoverHash = await regionHash(p.x, p.y, radius);
                            }
                            if (!restore) {
                                const [saved, size] = await Promise.all([backend.getCursor(), backend.getScreenSize()]);
                                restore = {
                                    x: Math.min(1, Math.max(0, saved.x / size.width)),
                                    y: Math.min(1, Math.max(0, saved.y / size.height)),
                                };
                            }
                            await backend.moveMouse(p.x, p.y);
                            await sleep(CURSOR_SETTLE_MS);
                            hoverOpened = true;
                        }
                        if (ch === 'cursor') {
                            try {
                                cursorKind = (await backend.getCursorKind()).kind;
                            }
                            catch {
                                cursorKind = null; // 形态缺席 ⇒ 重绘单证路径
                            }
                            const fused = cursorKind != null ? fuseVerdict(cursorKind, null, threshold) : null;
                            const decisive = fused != null && fused.verdict !== 'inconclusive';
                            const ms = Date.now() - t0;
                            spentMs += ms;
                            probeMemory.noteChannel('cursor', ms, beforeLabel, decisive ? fused.verdict : null);
                            if (decisive) {
                                // 决定性形态即判（与旧路径同律：hand/ibeam 读完即判，不等重绘）
                                standing = { verdict: fused.verdict, confidence: fused.confidence, channel: 'cursor' };
                            }
                        }
                        else {
                            // repaint：自适应轮询（150ms 步进，检出即停，上限 ceil(dwell/step) 步）
                            // 基线 = 悬停访问开启前摄取的 preHoverHash（鼠标已在点上）
                            neededCooldown = true;
                            const maxPolls = Math.max(1, Math.ceil(dwell / REPAINT_POLL_STEP_MS));
                            for (let n = 0; n < maxPolls; n++) {
                                await sleep(REPAINT_POLL_STEP_MS);
                                const after = await regionHash(p.x, p.y, radius);
                                if (preHoverHash && after) {
                                    sim = similarity(preHoverHash, after);
                                    if (sim < threshold)
                                        break;
                                }
                            }
                            const fused = fuseVerdict(cursorKind ?? 'unsupported', sim, threshold);
                            const decisive = fused.verdict !== 'inconclusive';
                            const ms = Date.now() - t0;
                            spentMs += ms;
                            probeMemory.noteChannel('repaint', ms, beforeLabel, decisive ? fused.verdict : null);
                            if (decisive) {
                                standing = { verdict: fused.verdict, confidence: fused.confidence, channel: 'repaint' };
                            }
                        }
                    }
                    catch (e) {
                        // 单点悬停失败不弃整个批次（其余点可能是好证据）—— 与旧路径同律
                        failNote = `probe failed: ${e?.message ?? e}`;
                        break;
                    }
                }
                // 停止法则：判决已立、熵减足额 ⇒ 不为余下通道花钱
                if (economyShouldStop(standing, order.slice(s + 1), econ)) {
                    stoppedEarly = true;
                    break;
                }
            }
            // 终判：固定融合优先级（UIA > 悬停），融合矩阵与旧路径逐格一致
            if (uiaFused && hit) {
                results[i] = {
                    point: p,
                    verdict: uiaFused.verdict,
                    confidence: uiaFused.confidence,
                    evidence: {
                        ...emptyEvidence('uia'),
                        hit_test: {
                            control_type: hit.control_type ?? null,
                            name: hit.name ?? '',
                            classification: hit.classification,
                            matched_depth: hit.matched_depth ?? null,
                        },
                    },
                    economics: { channel_order: order, bits_per_ms: bitsSnapshot, stopped_early: stoppedEarly, spent_ms: spentMs },
                };
            }
            else if (hoverOpened || cursorKind != null || sim != null) {
                const fused = fuseVerdict(cursorKind ?? 'unsupported', sim, threshold);
                results[i] = {
                    point: p,
                    verdict: fused.verdict,
                    confidence: fused.confidence,
                    evidence: {
                        via: 'hover',
                        cursor_kind: cursorKind ?? 'unsupported',
                        hover_repaint: sim != null && sim < threshold,
                        repaint_similarity: sim,
                        dwell_ms: dwell,
                    },
                    ...(failNote ? { note: failNote } : {}),
                    economics: { channel_order: order, bits_per_ms: bitsSnapshot, stopped_early: stoppedEarly, spent_ms: spentMs },
                };
            }
            else {
                results[i] = {
                    point: p, verdict: 'inconclusive', confidence: 0,
                    evidence: emptyEvidence(failNote ? 'hover' : 'none'),
                    note: skip ?? failNote ?? 'all probe channels exhausted without a verdict',
                    economics: { channel_order: order, bits_per_ms: bitsSnapshot, stopped_early: stoppedEarly, spent_ms: spentMs },
                };
            }
            // 冷却仅在走过轮询路径后需要（悬停状态/tooltip 消散）—— 与旧路径同律
            if (neededCooldown && k < pending.length - 1)
                await sleep(120);
        }
    }
    finally {
        if (restore) {
            try {
                await backend.moveMouse(restore.x, restore.y);
            }
            catch { /* 复位尽力而为 */ }
        }
    }
}
/** 单点探针（probe_interactivity 工具面） */
export async function probeInteractivity(config, nx, ny) {
    const [r] = await probePoints(config, [{ x: nx, y: ny }]);
    return r;
}
// ─── Z-2 点击闸门：世界的回答先于指针落下 ───
/** text 判决的拦截地板：只有决定性判决（UIA text 0.93 / ibeam 0.92）够格
 *  拦截点击；inconclusive（0~0.3）是诚实弃权，不是证据 —— 弃权不执法。 */
export const TEXT_CLICK_REFUSE_FLOOR = 0.9;
/**
 * 点击闸门判决（Z-2，纯函数）：世界已回答「这个点是正文」时，点击放行与否。
 *
 * 对症失败模式：「模型将输出的正文当作点击的按钮」—— 聊天记录里写着
 * 「点击登录按钮」的文本、文档里引用的菜单名与真按钮像素等价，模型猜不出
 * 差别；但 OS 结构层/光标形态知道（Z-1 三通道探针）。Z-1 只把判决标注在
 * find_text 的结果里（模型可以不看）；Z-2 把同一判决前移到 click_mouse 的
 * 执行前 —— 猜不出来就问世界，问了就听世界的。
 *
 * 拦截条件（缺一放行）：
 *   1. verdict === 'text' 且 confidence ≥ TEXT_CLICK_REFUSE_FLOOR
 *   2. 证据不是 Edit 控件 —— UIA 的 Edit 是输入框，点击聚焦是合法动作
 *      （Text/Document 才是静态正文）；悬停 ibeam 无法区分两者时不在此
 *      例外（Edit 场景由 allowTextClick 自证通道兜底）
 *   3. 模型未显式声明 allowTextClick（自证通道：明知点正文的合法场景）
 *
 * control / inconclusive / 探针缺席 ⇒ 一律放行 —— 闸门只根除「把正文当
 * 按钮」这一种错误，不新增任何错误（零回归铁律）。
 */
export function gateTextClick(probe, input = {}) {
    if (!probe)
        return { blocked: false };
    if (input.allowTextClick)
        return { blocked: false };
    if (probe.verdict !== 'text' || probe.confidence < TEXT_CLICK_REFUSE_FLOOR) {
        return { blocked: false };
    }
    const via = probe.evidence.via;
    if (via === 'uia') {
        // Edit = 输入框（点击聚焦合法）；Text/Document = 静态正文（拦截）
        if (probe.evidence.hit_test?.control_type === 'Edit')
            return { blocked: false };
        const ct = probe.evidence.hit_test?.control_type ?? '?';
        return {
            blocked: true,
            reason: `OS structure layer registers this point as static content (${ct}, no interactive ancestor within 4 levels)`,
            evidence: `uia control_type=${ct} name="${probe.evidence.hit_test?.name ?? ''}" conf=${probe.confidence.toFixed(2)}`,
        };
    }
    const cursor = probe.evidence.cursor_kind;
    return {
        blocked: true,
        reason: `cursor shape over this point is '${cursor}' (text-selection I-beam) — the OS treats it as selectable content, not a clickable control`,
        evidence: `hover cursor=${cursor} conf=${probe.confidence.toFixed(2)}` +
            (via === 'memory' ? ' (scene-matched probe memory)' : ''),
    };
}
