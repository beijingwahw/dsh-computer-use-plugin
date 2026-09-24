import * as backend from './physicalBackend.js';
import { similarity } from './perceptualHash.js';
import { getPopupState } from './guards/popupGuard.js';
import { probeMemory, isDecisive } from './probeMemory.js';
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
/**
 * OCR 词元几何先验（探针缺席时的降级判据，也用于排序探针目标）：
   宽行/多行 ⇒ 正文（聊天消息/文档段落）；紧凑短标签 ⇒ 控件候选。
 */
export function classifyWordShape(w) {
    const width = w.bbox_normalized.x1 - w.bbox_normalized.x0;
    const height = w.bbox_normalized.y1 - w.bbox_normalized.y0;
    // 整行宽（聊天气泡/正文行）或多行高（段落块）⇒ 正文
    if (width >= 0.45 || height >= 0.055)
        return 'content-like';
    // 紧凑短标签：按钮/链接的典型形状
    if (width <= 0.16 && height <= 0.03)
        return 'control-like';
    return 'ambiguous';
}
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
/** 单点探针（probe_interactivity 工具面） */
export async function probeInteractivity(config, nx, ny) {
    const [r] = await probePoints(config, [{ x: nx, y: ny }]);
    return r;
}
