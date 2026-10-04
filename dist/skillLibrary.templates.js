import { canonicalStringify } from './skillLibrary.signatures.js';
// ─── W3-2：抗过拟合门限（模块常量 —— 一切数值在此审计，绝无内联魔数） ───
/** 模板最低母体数：单母体永不产模板（结构前提 —— 一例观测不成规律） */
export const TEMPLATE_MIN_PARENTS = 2;
/** 最低同源步数：短于 2 步的模板不构成「技能」（与 motif minLength 同律） */
export const TEMPLATE_MIN_HOMOLOGS = 2;
/** DTW 对齐归一代价上限（cost / max(lenA,lenB)）：骨架差太远的对不参加反统一 */
export const TEMPLATE_MAX_ALIGN_COST_RATIO = 0.35;
/** 洞位跨母体 Beta 后验门：mean = (s+1)/(s+f+2) ≥ 0.75 ⇔ s ≥ 3f+2
 *  （f=0 时 s≥2 —— 与最低母体数自洽；一个反证母体即要求 5 个支撑母体） */
export const TEMPLATE_HOLE_POSTERIOR_GATE = 0.75;
/** 模板容量（可靠度×新近度驱逐，与技能容量驱逐同律） */
export const TEMPLATE_CAPACITY = 16;
/** 蒸馏预算护栏：参加配对的技能数上限（O(N²) 配对 × O(nm) DTW 的诚实上限） */
export const TEMPLATE_MAX_SKILLS = 64;
/** W3-2：工具骨架哈希（FNV-1a，hashArgs 同源密码学原语 —— 匹配粗筛键） */
export function hashSkeleton(tools) {
    let h = 0x811c9dc5;
    const s = tools.join('\u0001');
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
}
/** W3-2：单步对齐代价（编辑距离风格）：同工具 0 / 异工具 1（缺口代价同 1） */
const alignStepCost = (toolA, toolB) => (toolA === toolB ? 0 : 1);
/**
 * W3-2：DTW 序列对齐（纯符号、确定性）。步标签 = 动作种类（tool 名），
 * dp[i][j] = 对齐 a[0..i) 与 b[0..j) 的最小总代价；回溯取对齐路径，
 * 平局裁决固定 diag > up > left（确定性铁律 —— 同输入逐位同路径）。
 * 返回 pairs：已对齐位 [i, j]（j=-1 / i=-1 为缺口列），cost 为总代价。
 * 导出纯函数：与 olcOverlap / betaReliability 同律（数学原子的测试面）。
 */
export function dtwAlignTools(a, b) {
    const n = a.length;
    const m = b.length;
    const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(Infinity));
    dp[0][0] = 0;
    for (let i = 0; i <= n; i++) {
        for (let j = 0; j <= m; j++) {
            if (i === 0 && j === 0)
                continue;
            let best = Infinity;
            if (i > 0 && j > 0)
                best = Math.min(best, dp[i - 1][j - 1] + alignStepCost(a[i - 1], b[j - 1]));
            if (i > 0)
                best = Math.min(best, dp[i - 1][j] + 1); // 缺口（b 侧插入）
            if (j > 0)
                best = Math.min(best, dp[i][j - 1] + 1); // 缺口（a 侧插入）
            dp[i][j] = best;
        }
    }
    const pairs = [];
    let i = n;
    let j = m;
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && dp[i][j] === dp[i - 1][j - 1] + alignStepCost(a[i - 1], b[j - 1])) {
            pairs.push([i - 1, j - 1]);
            i--;
            j--;
        }
        else if (i > 0 && dp[i][j] === dp[i - 1][j] + 1) {
            pairs.push([i - 1, -1]);
            i--;
        }
        else if (j > 0 && dp[i][j] === dp[i][j - 1] + 1) {
            pairs.push([-1, j - 1]);
            j--;
        }
        else {
            break; // 防御带（dp 构造保证不可达）
        }
    }
    pairs.reverse();
    return { pairs, cost: dp[n][m] };
}
/** W3-2：值的洞类型标注（number 须有限 —— NaN/Infinity 归 json 由绑定闸拒绝） */
export function holeTypeOf(v) {
    if (typeof v === 'number')
        return Number.isFinite(v) ? 'number' : 'json';
    if (typeof v === 'string')
        return 'string';
    if (typeof v === 'boolean')
        return 'boolean';
    return 'json';
}
/** W3-2：来源提示的键形判据（确定性正则 —— 绝无模型猜测） */
const HOLE_COORD_KEY = /(^|_)(x|y|dx|dy)(_|$|\d)/i; // x / y / from_x / to_y2 …
const HOLE_CLIP_KEY = /(url|link|site|domain|address|href|path)/i; // 长串惯走粘贴
const HOLE_TEXT_KEY = /(text|content|desc|query|search|keyword|message|prompt|title|label|value|input|answer|reply)/i;
/**
 * W3-2：洞的来源提示推断（纯函数，键形 + 类型 → 读取策略）：
 * 数值且坐标形键 → coordinate；字符串且 URL 形键 → clipboard；
 * 字符串且文本形键 → ocr（屏上读到的值）；其余 → user-input（问用户/任务上下文）。
 * 提示是给绑定 reader 的路由建议，不是断言 —— 绑定失败回退字面量技能。
 */
export function inferHoleSource(key, type) {
    if (type === 'number' && HOLE_COORD_KEY.test(key))
        return 'coordinate';
    if (type === 'string' && HOLE_CLIP_KEY.test(key))
        return 'clipboard';
    if (type === 'string' && HOLE_TEXT_KEY.test(key))
        return 'ocr';
    return 'user-input';
}
/** W3-2：绑定值的类型闸（洞类型 ↔ 运行时值的守卫 —— 类型不符即绑定失败） */
export function valueMatchesHoleType(v, type) {
    switch (type) {
        case 'number': return typeof v === 'number' && Number.isFinite(v);
        case 'string': return typeof v === 'string';
        case 'boolean': return typeof v === 'boolean';
        case 'json': return v !== null && typeof v === 'object';
    }
}
/**
 * W3-2：DTW 对齐 + 参数槽反统一（纯函数，手算可回验）。
 * 步骤：① 工具骨架 DTW（归一代价过门）；② 同源步（同工具对齐位）逐槽比对 ——
 * 同值 → 常量槽、同型异值 → 洞槽（类型 + 来源提示 + 双母体实值绑定）；
 * 键集不一致或异型 ⇒ 该步结构分歧，弃置（保守：结构不稳的步不泛化）；
 * ③ 全常量（零洞）⇒ 拒绝 —— 那是字面量重复，不是泛化；④ 弃置后步数
 * < TEMPLATE_MIN_HOMOLOGS ⇒ 拒绝。洞槽的 posteriorMean 此处记 NaN 占位，
 * 由调用方（distillTemplates 的跨母体证据扫）回填真值。
 */
export function antiUnifyPair(a, b) {
    const { pairs, cost } = dtwAlignTools(a.steps.map(s => s.tool), b.steps.map(s => s.tool));
    const maxLen = Math.max(1, Math.max(a.steps.length, b.steps.length));
    const costRatio = cost / maxLen;
    const homologPairs = pairs.filter(([i, j]) => i >= 0 && j >= 0 && a.steps[i].tool === b.steps[j].tool);
    const alignment = { cost, costRatio: Math.round(costRatio * 1000) / 1000, homologs: homologPairs.length, droppedSteps: 0 };
    if (costRatio > TEMPLATE_MAX_ALIGN_COST_RATIO) {
        return { ok: false, reason: 'align-cost', detail: `costRatio=${alignment.costRatio}`, alignment };
    }
    if (homologPairs.length < TEMPLATE_MIN_HOMOLOGS) {
        return { ok: false, reason: 'insufficient-homologs', detail: `homologs=${homologPairs.length}`, alignment };
    }
    const steps = [];
    let holes = 0;
    for (const [i, j] of homologPairs) {
        const sa = a.steps[i];
        const sb = b.steps[j];
        const keysA = Object.keys(sa.args ?? {}).sort();
        const keysB = Object.keys(sb.args ?? {}).sort();
        if (JSON.stringify(keysA) !== JSON.stringify(keysB)) {
            alignment.droppedSteps++; // 键集分歧：参数结构不稳，该步不泛化（保守）
            continue;
        }
        const args = {};
        let divergent = false;
        for (const k of keysA) {
            const va = sa.args[k];
            const vb = sb.args[k];
            if (canonicalStringify(va) === canonicalStringify(vb)) {
                args[k] = { kind: 'const', value: va }; // 同值 → 常量
                continue;
            }
            const ta = holeTypeOf(va);
            const tb = holeTypeOf(vb);
            if (ta !== tb || ta === 'json') {
                divergent = true; // 异型（或双方皆非基元）⇒ 反统一非法 —— 弃置该步
                break;
            }
            args[k] = {
                kind: 'hole', type: ta, source: inferHoleSource(k, ta),
                bindings: [{ skillId: a.id, value: va }, { skillId: b.id, value: vb }],
                posteriorMean: Number.NaN, // 占位：跨母体证据扫回填（见 distillTemplates）
                bindAttempts: 0, bindSuccesses: 0,
            };
            holes++;
        }
        if (divergent) {
            alignment.droppedSteps++;
            continue;
        }
        steps.push({ tool: sa.tool, args });
    }
    if (holes === 0) {
        return { ok: false, reason: 'no-holes', detail: 'args 全同值 —— 字面量重复，非泛化', alignment };
    }
    if (steps.length < TEMPLATE_MIN_HOMOLOGS) {
        return { ok: false, reason: 'too-few-steps', detail: `steps=${steps.length}`, alignment };
    }
    return { ok: true, steps, holes, alignment };
}
/**
 * W3-2：洞位证据扫（跨母体 Beta 门的证据源 —— 纯符号，确定性）。
 * 证据池 = 全库能**完整实现**模板骨架的技能（DTW 对齐过门 + 每个模板步
 *  都映射到同工具步；多余步是缺口、缺步即排除 —— 部分实现不构成反证源，
 *  也不构成支撑源）。逐洞判定：键在且类型相符 ⇒ s（支撑证据）；键缺/异型
 *  ⇒ f（反证 —— 同骨架的工作流在这个槽位上不守恒，洞就是过拟合）。
 *  「每个洞位在各母体绑定成功才计证据」：只有全洞皆成的技能才入 supporters
 *  —— 任何一洞失败即整技出局（单母体永不产模板的结构执法在 supporters
 *  长度门）。返回值含逐洞后验均值 (s+1)/(s+f+2) 与支撑母体实值（审计面）。
 */
export function sweepHoleEvidence(candSteps, pool) {
    // 洞清单（步序 × 键字典序 —— 确定性枚举）
    const holeList = [];
    candSteps.forEach((st, si) => {
        for (const k of Object.keys(st.args).sort()) {
            const slot = st.args[k];
            if (slot.kind === 'hole')
                holeList.push({ stepIndex: si, key: k, type: slot.type });
        }
    });
    const stats = holeList.map(h => ({ stepIndex: h.stepIndex, key: h.key, s: 0, f: 0, posteriorMean: 0 }));
    const supporterValues = new Map();
    const supporters = [];
    const candTools = candSteps.map(st => st.tool);
    for (const sk of pool) {
        const { pairs, cost } = dtwAlignTools(sk.steps.map(x => x.tool), candTools);
        const ratio = cost / Math.max(1, Math.max(sk.steps.length, candTools.length));
        if (ratio > TEMPLATE_MAX_ALIGN_COST_RATIO)
            continue; // 骨架不同：既非证据亦非反证
        // 模板步 → 技能步 的同源映射（缺口/异工具 ⇒ 缺映射）
        const map = new Map();
        for (const [j, i] of pairs) {
            if (j >= 0 && i >= 0 && sk.steps[j].tool === candTools[i])
                map.set(i, j);
        }
        if (map.size < candSteps.length)
            continue; // 未完整实现骨架 —— 不入证据池
        let allBound = true;
        holeList.forEach((h, hi) => {
            const bound = map.get(h.stepIndex);
            const v = bound !== undefined ? sk.steps[bound].args?.[h.key] : undefined;
            if (bound === undefined || !(h.key in (sk.steps[bound].args ?? {})) || holeTypeOf(v) !== h.type) {
                stats[hi].f++; // 反证：同骨架在此槽位不守恒
                allBound = false;
            }
            else {
                stats[hi].s++; // 支撑：该母体在此洞位绑定成功
            }
        });
        if (!allBound)
            continue;
        supporters.push(sk);
        holeList.forEach((h, hi) => {
            const bound = map.get(h.stepIndex);
            const v = sk.steps[bound].args[h.key];
            const mk = `${h.stepIndex}#${h.key}`;
            const arr = supporterValues.get(mk) ?? [];
            arr.push({ skillId: sk.id, value: v });
            supporterValues.set(mk, arr);
        });
    }
    for (const st of stats)
        st.posteriorMean = (st.s + 1) / (st.s + st.f + 2);
    return { supporters, holeStats: stats, supporterValues };
}
