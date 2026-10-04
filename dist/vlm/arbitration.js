// src/vlm/arbitration.ts
// 纪元 Ω（云脑皮层）：双源仲裁器官 —— 本地感知与云端 VLM 意见分歧时的纯数学裁决。
//
// 存在理由：本地 OCR/无障碍树与云端 VLM 是两条**独立观测信道**，对同一屏幕
// 的读出必然带噪声级分歧（框偏几像素、标签错一字母）。仲裁不靠权威靠测度：
// 空间分歧交给 Jaccard（IoU），文本分歧交给 Levenshtein，置信分歧交给凸组合。
// 纯函数、零网络、零图像依赖、零兄弟运行时依赖（codec/grounding 仅 type
// import，运行时零耦合）、确定性、绝不抛异常。
//
// 裁决律全集（本器官的全部数学规则）：
//   ① 空间一致 ⇒ 融合：IoU(A,B) = |A∩B|/|A∪B| ≥ iouThreshold（默认 0.5）
//      判同一元素，产出融合元素：
//        · bbox = 置信度加权凸组合：每坐标 = (v·cv + l·cl)/(cv+cl)。权重和
//          为 1 ⇒ 融合框落在两框的凸包内 —— 永不仲裁出一条谁都没看见的框；
//          cv+cl=0（双零置信）退化为等权中点（0.5/0.5，不除零）；
//        · label 取置信高者（cv=cl 平票归 VLM —— 与 winner 平票律同源）；
//        · confidence = min(1, (cv+cl)/2 + agreementBonus)（默认 0.15）：
//          两条独立信道命中同一元素，伪命中是乘性小概率事件 —— 双源一致
//          是比任一单信道更强的证据，故给加成并封顶于 1；
//          ΝΩ-47（连折膨胀修正）：此为 classic 模式（缺省）。合议庭 askElements
//          的座次序累进折叠复用本公式时，左席置信已含前几轮加成，等权均值会让
//          加成复利膨胀（基线 0.8 的 5 家连折两轮即饱和至 1）—— loglinear 模式
//          （opt-in）改有界累积：conf = min(1, (cv+cl)/2 + bonus/√families)，
//          见 fuseMode 选项的独立性修正论证；
//        · source='fusion'、agreesWith='both'。
//   ② 仅 VLM 命中 ⇒ source='vlm'、agreesWith='vlm'（只有自己为自己作证）。
//   ③ 仅本地命中 ⇒ source='local'、agreesWith='local'。
//      （agreesWith='none' 为未来第三方否决流预留 —— 规则①②③永不产生它。）
//   ④ winner：
//        融合对数 ≥ 1 且 ≥ 任一单源对数的 30% ⇒ 'fusion'（整数安全式
//        fusion×10 ≥ 3×max(vlm单源, local单源)，避开 0.3×n 的浮点尘）；
//        否则 vlm 元素数 > local ⇒ 'vlm'；local 多 ⇒ 'local'；
//        相等 ⇒ 'vlm'（VLM 语义更强 —— 平票律；「无融合」是其典型场景，
//        有融合但未达 30% 线的平票同走此律）。
//   配对策略：全部跨源候选对按 IoU 降序贪心一对一（最重合者先配，并列按
//   vlm/local 索引稳定打破 ⇒ 确定性、逐对可审计）。元素域是个位数到十位数，
//   匈牙利算法的 O(n³) 精确指派在此域是杀鸡用牛刀且不可回放 —— 与 fuzzy.ts
//   选经典 DP 同一「证据先于修辞」律。
//
// 退化约定（绝不抛异常）：空数组 ⇒ 空元素表、winner 按平票律缺省 'vlm'；
// 零面积框的 IoU：完全重合 ⇒ 1、否则 ⇒ 0（对 0/0 的约定式消解，不出 NaN）。
import { kernelRegistry } from '../kernel/registry.js';
/**
 * 交并比（Jaccard 系数的二维测度形态）：IoU = |A∩B| / |A∪B| ∈ [0,1]。
 * 交集取逐维 max(下界)/min(上界)，负宽高截 0（贴边 = 零交 = 相离）；
 * 面积同样截非负（对倒置框的宽容：不抛错、不出 NaN）。
 * 退化域（并面积 ≤ 0，即双方皆零面积）：完全重合 ⇒ 1（同一退化点），
 * 否则 ⇒ 0 —— 0/0 的约定式消解。
 */
export function iou(a, b) {
    const interW = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
    const interH = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
    const inter = interW * interH;
    const areaA = Math.max(0, a.x1 - a.x0) * Math.max(0, a.y1 - a.y0);
    const areaB = Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
    const union = areaA + areaB - inter;
    if (union <= 0) {
        return a.x0 === b.x0 && a.y0 === b.y0 && a.x1 === b.x1 && a.y1 === b.y1 ? 1 : 0;
    }
    return inter / union;
}
/**
 * 归一化 Levenshtein 相似度 ∈ [0,1]：1 − dist(a,b)/max(|a|,|b|)。
 * dist 为经典 Wagner–Fischer DP（插入/删除/替换各计 1），行进形态
 * O(mn) 时间 / O(n) 空间 —— 与 fuzzy.ts 同款经典 DP（可逐格审计）。
 * 边界：双空串恒等 ⇒ 1；单侧空 ⇒ 全插/全删距离 = max ⇒ 0。
 */
export function normalizedLevenshtein(a, b) {
    const s = typeof a === 'string' ? a : '';
    const t = typeof b === 'string' ? b : '';
    const m = s.length;
    const n = t.length;
    if (m === 0 && n === 0)
        return 1;
    if (m === 0 || n === 0)
        return 0;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
        const cur = new Array(n + 1);
        cur[0] = i;
        for (let j = 1; j <= n; j++) {
            const cost = s[i - 1] === t[j - 1] ? 0 : 1;
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        }
        prev = cur;
    }
    return 1 - prev[n] / Math.max(m, n);
}
/**
 * 元素级仲裁：VLM 落地元素 × 本地感知元素的纯数学调和（规则①②③④见文件头）。
 *
 * 匹配为 IoU 降序贪心一对一：每对 (v,l) 先按 iou(v.bbox,l.bbox) ≥
 * iouThreshold（默认 0.5）筛入候选，再按重合度降序配对（并列按索引稳定
 * 打破）—— 一个元素至多参与一次融合，确定性可回放。
 *
 * 输出元素表次序：vlm 序（融合与 VLM 单源混排）在前、本地单源殿后。
 * 空输入全定义：双空 ⇒ winner 'vlm'（平票律缺省）+ 空表，绝不抛错。
 */
export function arbitrateElements(vlm, local, opts) {
    // 纪元 Θ（Θ-4 生产接线）：缺省值改读内核注册表 —— getOrDefault 未注册时
    // 原样回声字面量（0.5 / 0.15），未注册场景行为与接线前逐字节一致；显式
    // opts 仍最高优先。同步纯读，纯函数性不变。
    const iouThreshold = opts?.iouThreshold ?? kernelRegistry.getOrDefault('arbitration.iouThreshold', 0.5);
    const agreementBonus = opts?.agreementBonus ?? kernelRegistry.getOrDefault('arbitration.agreementBonus', 0.15);
    // ΝΩ-47：模式与家数整形（脏值安静归缺省 —— classic / 2，绝不抛）。
    const fuseMode = opts?.fuseMode === 'loglinear' ? 'loglinear' : 'classic';
    const foldedRaw = opts?.foldedFamilies;
    const foldedFamilies = typeof foldedRaw === 'number' && Number.isFinite(foldedRaw) && foldedRaw >= 2
        ? Math.floor(foldedRaw)
        : 2;
    const vlmList = Array.isArray(vlm) ? vlm : [];
    const localList = Array.isArray(local) ? local : [];
    // 候选对全枚举（小域 O(V·L) 可审计）→ IoU 降序贪心一对一
    const pairs = [];
    for (let vi = 0; vi < vlmList.length; vi++) {
        for (let li = 0; li < localList.length; li++) {
            const overlap = iou(vlmList[vi].bbox, localList[li].bbox);
            if (overlap >= iouThreshold)
                pairs.push({ vi, li, overlap });
        }
    }
    pairs.sort((p, q) => q.overlap - p.overlap || p.vi - q.vi || p.li - q.li);
    const mateOf = new Map(); // vi -> li（一对一配对表）
    const matedLocal = new Set();
    for (const p of pairs) {
        if (!mateOf.has(p.vi) && !matedLocal.has(p.li)) {
            mateOf.set(p.vi, p.li);
            matedLocal.add(p.li);
        }
    }
    const elements = [];
    for (let vi = 0; vi < vlmList.length; vi++) {
        const v = vlmList[vi];
        const li = mateOf.get(vi);
        if (li === undefined) {
            // 规则②：仅 VLM 命中 —— 原样直通（含其自带的 center）
            elements.push({
                label: v.label,
                bbox: v.bbox,
                center: v.center,
                confidence: v.confidence,
                source: 'vlm',
                agreesWith: 'vlm',
            });
            continue;
        }
        // 规则①：双源命中同一元素 ⇒ 置信度加权凸组合融合
        const l = localList[li];
        const cv = v.confidence;
        const cl = l.confidence;
        const total = cv + cl;
        const wv = total > 0 ? cv / total : 0.5; // 双零置信 ⇒ 等权中点（不除零）
        const wl = total > 0 ? cl / total : 0.5;
        const bbox = {
            x0: v.bbox.x0 * wv + l.bbox.x0 * wl,
            y0: v.bbox.y0 * wv + l.bbox.y0 * wl,
            x1: v.bbox.x1 * wv + l.bbox.x1 * wl,
            y1: v.bbox.y1 * wv + l.bbox.y1 * wl,
        };
        // ΝΩ-47（连折置信膨胀修正，公式论证）：
        //   classic（缺省）= min(1, (cv+cl)/2 + bonus) —— 单对双源融合的既有律。
        //   连折场景（合议庭 askElements 座次序累进折叠复用本公式）的病灶：左席
        //   置信 cv 已含前几轮加成，等权均值 (cv+cl)/2 只稀释一半旧加成、又全额
        //   叠加新加成 —— 加成复利膨胀，基线 0.8 的 5 家两折即触顶饱和至 1，
        //   「多源一致」的证据强度被虚报为满分。
        //   loglinear（opt-in）= min(1, (cv+cl)/2 + bonus/√families) —— 独立性修正
        //   的最小实现：n 份证词两两相关性未知时，保守假设其联合证据增益按 √n
        //   增长（与独立噪声平均的标准差口径同源 —— 完全独立应除 n、完全相关不
        //   除，√n 是无相关性证据下的中间保守增益）；均值项保持等权（合议庭各家
        //   平等一票，左席是融合产物而非 k 张独立新票）。数值上该式有不动点
        //   c* = 基线 + 2·bonus/√n：连折收敛于基线之上的有界小增益，永不饱和。
        const confidence = fuseMode === 'loglinear'
            ? Math.min(1, (cv + cl) / 2 + agreementBonus / Math.sqrt(foldedFamilies))
            : Math.min(1, (cv + cl) / 2 + agreementBonus);
        elements.push({
            label: cv >= cl ? v.label : l.label, // 置信高者；平票归 VLM（语义强）
            bbox,
            center: { x: (bbox.x0 + bbox.x1) / 2, y: (bbox.y0 + bbox.y1) / 2 },
            confidence,
            source: 'fusion',
            agreesWith: 'both',
        });
    }
    for (let li = 0; li < localList.length; li++) {
        if (matedLocal.has(li))
            continue;
        const l = localList[li]; // 规则③：仅本地命中 —— center 由 bbox 中点补全
        elements.push({
            label: l.label,
            bbox: l.bbox,
            center: { x: (l.bbox.x0 + l.bbox.x1) / 2, y: (l.bbox.y0 + l.bbox.y1) / 2 },
            confidence: l.confidence,
            source: 'local',
            agreesWith: 'local',
        });
    }
    // 规则④：winner 判决（fusion×10 ≥ 3×max 单源 —— 整数安全的 30% 线）
    const fusionPairs = mateOf.size;
    const vlmOnly = vlmList.length - fusionPairs;
    const localOnly = localList.length - fusionPairs;
    const maxSingle = Math.max(vlmOnly, localOnly);
    let winner;
    let rationale;
    if (fusionPairs >= 1 && fusionPairs * 10 >= maxSingle * 3) {
        winner = 'fusion';
        rationale = `融合 ${fusionPairs} 对 ≥ 任一单源对数的 30% 线（vlm 单源 ${vlmOnly}、local 单源 ${localOnly}），双源一致优先`;
    }
    else if (vlmList.length > localList.length) {
        winner = 'vlm';
        rationale = `vlm 感知 ${vlmList.length} 个元素 > local ${localList.length} 个，云端语义覆盖更全`;
    }
    else if (localList.length > vlmList.length) {
        winner = 'local';
        rationale = `local 感知 ${localList.length} 个元素 > vlm ${vlmList.length} 个，本地感知覆盖更全`;
    }
    else {
        winner = 'vlm';
        rationale = `双源各 ${vlmList.length} 个元素${fusionPairs > 0 ? `（融合 ${fusionPairs} 对未达 30% 线）` : '且无融合'}，平局按 VLM 语义更强缺省`;
    }
    return { winner, elements, rationale };
}
/**
 * 文本级仲裁：VLM 读出全文 vs 本地 OCR 全文的三分支裁决。
 *
 *  ① 相似（normalizedLevenshtein ≥ similarityThreshold，默认 0.8）⇒ 双源
 *     同读一物：取 vlmText（语义更顺）、source='fusion'、返回实算相似度；
 *  ② 低于阈值且两串皆非空 ⇒ 双源真分歧：取 vlmText（置信语义强）、
 *     source='vlm'、返回实算相似度（分歧程度仍可审计）；
 *  ③ 任一为空 ⇒ 空侧无证据：返回非空者、source 对应其来源、
 *     similarity=0（对空比较无意义 —— 实算亦必为 0）。
 *
 * 边界：双空串恒等（相似度 1）⇒ 落入①：{ text:'', source:'fusion',
 * similarity:1 } —— 两信道一致认为屏幕无文本，无冲突可仲裁，不抛错。
 */
export function arbitrateText(vlmText, localText, opts) {
    // 纪元 Θ（Θ-4 生产接线）：缺省阈值读内核注册表（未注册 ⇒ 0.8 字面量兜底，零行为变化）
    const threshold = opts?.similarityThreshold ?? kernelRegistry.getOrDefault('arbitration.textSimilarity', 0.8);
    const v = typeof vlmText === 'string' ? vlmText : '';
    const l = typeof localText === 'string' ? localText : '';
    const similarity = normalizedLevenshtein(v, l);
    if (similarity >= threshold) {
        return { text: v, source: 'fusion', similarity };
    }
    if (v.length > 0 && l.length > 0) {
        return { text: v, source: 'vlm', similarity };
    }
    if (v.length === 0 && l.length === 0) {
        // 仅当阈值 > 1 的病态调用才可达（双空相似度恒为 1）：按空侧缺省 VLM 保底
        return { text: '', source: 'vlm', similarity: 0 };
    }
    return { text: v.length > 0 ? v : l, source: v.length > 0 ? 'vlm' : 'local', similarity: 0 };
}
