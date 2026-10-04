/**
 * W4-4 桌面场景文法全表（16 条产生式）。缺省权重即文法的「自然先验」——各类
 * 大致均衡、装饰略偏无（简单场景为先）；课程权重（updatePcgCurriculum 的产
 * 出）按此表为基线做 [0.25×, 4×] 的乘性偏置。
 */
export const PCG_PRODUCTIONS = [
    { id: 'screen:sidebar', family: 'screen', weight: 1.0, note: '屏幕 → [标题栏, 主体, 侧栏]' },
    { id: 'screen:nosidebar', family: 'screen', weight: 1.0, note: '屏幕 → [标题栏, 主体]（无侧栏）' },
    { id: 'main:form', family: 'main', weight: 1.0, note: '主体 → 表单（网格 3 列，直通前进）' },
    { id: 'main:tree', family: 'main', weight: 1.0, note: '主体 → 树形（网格 2 列，直通前进）' },
    { id: 'main:list', family: 'main', weight: 1.0, note: '主体 → 列表（网格 3 列，直通前进）' },
    { id: 'main:collapse', family: 'main', weight: 1.0, note: '主体 → 折叠区组（目标藏深部，须滚动暴露）' },
    { id: 'el:button', family: 'element', weight: 1.0, note: '元素 → 按钮（可交互，落空不推进）' },
    { id: 'el:input', family: 'element', weight: 0.8, note: '元素 → 输入框（本训练营为展示性文本）' },
    { id: 'el:checkbox', family: 'element', weight: 0.6, note: '元素 → 复选框（展示性文本）' },
    { id: 'el:link', family: 'element', weight: 0.6, note: '元素 → 链接（可交互，落空不推进）' },
    { id: 'el:menuItem', family: 'element', weight: 0.5, note: '元素 → 菜单项（可交互，落空不推进）' },
    { id: 'decor:none', family: 'decor', weight: 1.2, note: '装饰 → 无（干净场景）' },
    { id: 'decor:popup', family: 'decor', weight: 0.8, note: '装饰 → 升级弹窗（中途遮幕，须确认或 Esc）' },
    { id: 'decor:payTrap', family: 'decor', weight: 0.6, note: '装饰 → 付费陷阱（立即支付为破坏性诱饵，须绕开）' },
    { id: 'decor:cookie', family: 'decor', weight: 0.6, note: '装饰 → Cookie 横幅（中途遮幕，须同意）' },
    { id: 'decor:loading', family: 'decor', weight: 0.6, note: '装饰 → 加载遮罩（不遮幕的展示性条带）' },
];
/** 产生式 id 集（文法合法性检验的词表面） */
const PCG_RULE_IDS = new Set(PCG_PRODUCTIONS.map(p => p.id));
/** W4-4：缺省权重表（id → weight；防御副本） */
export function pcgBaseWeights() {
    const w = {};
    for (const p of PCG_PRODUCTIONS)
        w[p.id] = p.weight;
    return w;
}
/**
 * W4-4：有效权重合成 = 缺省表 ⊕ 合法覆盖（数值有限且 ≥0 才收；垃圾值静默回落
 * 缺省 —— 与全仓防御纪律同律）。纯函数。
 */
export function pcgEffectiveWeights(raw) {
    const w = pcgBaseWeights();
    if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
        for (const p of PCG_PRODUCTIONS) {
            const v = raw[p.id];
            if (typeof v === 'number' && Number.isFinite(v) && v >= 0)
                w[p.id] = v;
        }
    }
    return w;
}
/**
 * W4-4 文法课程权重更新（确定性、纯函数、绝不抛）：
 *   · 方向律：失败 ⇒ 升权（多练弱项：delta = +lr·(1 + surprise/8)）；成功 ⇒ 缓降
 *     （已掌握让位：delta = −lr·0.5）；链外产生式不动；
 *   · 夹取律：每条产生式权重恒 ∈ [0.25×基线, 4×基线]（永不归零/爆炸）；
 *   · 网格律：1e-6 网格取整（防浮点尾噪累积 —— 权重更新可重放）；
 *   · 防弹：垃圾权重/垃圾反馈静默按缺省/跳过处理，返回全量合法权重表。
 */
export function updatePcgCurriculum(weights, feedback, opts) {
    const base = pcgBaseWeights();
    const w = pcgEffectiveWeights(weights);
    const lrRaw = Number(opts?.learnRate);
    const lr = Number.isFinite(lrRaw) ? Math.min(1, Math.max(0, lrRaw)) : 0.25;
    const list = Array.isArray(feedback) ? feedback : [];
    for (const raw of list) {
        const f = raw !== null && typeof raw === 'object' ? raw : null;
        if (!f || typeof f.success !== 'boolean' || !Array.isArray(f.chain))
            continue;
        const sRaw = Number(f.surprise);
        const surprise = Number.isFinite(sRaw) ? Math.min(64, Math.max(0, sRaw)) : 0;
        const seen = new Set();
        for (const id of f.chain) {
            if (typeof id !== 'string' || seen.has(id) || !PCG_RULE_IDS.has(id))
                continue;
            seen.add(id);
            const b = base[id];
            const delta = f.success ? -lr * 0.5 : lr * (1 + surprise / 8);
            const lo = b * 0.25;
            const hi = b * 4;
            const next = Math.min(hi, Math.max(lo, w[id] * (1 + delta)));
            w[id] = Math.round(next * 1e6) / 1e6;
        }
    }
    return w;
}
