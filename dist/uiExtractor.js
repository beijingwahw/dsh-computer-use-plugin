let provider = null;
let cache = [];
let cacheAt = 0;
const CACHE_TTL_MS = 1500; // 缓存窗口内 ID 稳定 —— click_element 与 take_screenshot 握手的基石
let globalElementId = 1;
export function setAccessibilityProvider(p) {
    provider = p;
}
/** D-3 白盒源就绪判定：provider 已注入方可声明 isReady（同步、无副作用） */
export function hasAccessibilityProvider() {
    return provider !== null;
}
/**
 * 提取可交互元素。双重过滤（语义角色 + 几何面积>0）+ 三级 fallback 命名 + Token 预算(50)。
 */
export async function extractInteractiveElements(force = false) {
    if (!provider) {
        throw new Error('Accessibility provider not configured. ' +
            'Call setAccessibilityProvider() at plugin startup to enable element-ID mode.');
    }
    // 缓存命中：ID 不会因重复提取而漂移（返回副本 —— 调用方原地排序/裁剪不污染缓存）
    if (!force && Date.now() - cacheAt < CACHE_TTL_MS)
        return cache.slice();
    const elements = [];
    try {
        const tree = await provider();
        function traverse(node) {
            // 双重闸门：必须有非零边界框，且角色属于可交互集合
            if (node?.rect && node.rect.width > 0 && node.rect.height > 0) {
                const interactiveRoles = ['button', 'textbox', 'link', 'checkbox', 'combobox', 'menuitem'];
                if (interactiveRoles.includes(node.role?.toLowerCase())) {
                    elements.push({
                        id: globalElementId++,
                        // 三级 fallback：无文本取值，无值取角色 —— 元素永远有可读名字
                        name: node.name || node.value || `[${node.role}]`,
                        role: node.role,
                        rect: node.rect,
                    });
                }
            }
            if (node?.children)
                node.children.forEach(traverse);
        }
        traverse(tree);
    }
    catch (error) {
        console.error('[UI Extractor] Failed to get accessibility tree:', error);
    }
    // 提取层就做预算控制，而非把压缩压力推给下游
    // U-2：NMS 先行 —— a11y 嵌套申报（容器+子按钮同区）在预算前先去冗余
    cache = nmsElements(elements).slice(0, 50);
    cacheAt = Date.now();
    return cache;
}
// ── U 纪元（U-2 视觉层）：非极大值抑制（NMS）──
// a11y 树常有嵌套冗余（容器与其子按钮共占一区；两角色重叠申报）—— 模型
// 收到双框同义元素。NMS 律：按面积降序保留首遇，与已保留框 IoU ≥ 0.6 的
// 后到者抑制（面积更小的重复申报让位）。纯函数导出：测试面。
/** 交并比（与 elementTracker 同式 —— 局部复刻避免工具面耦合） */
function boxIou(a, b) {
    const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y);
    const x1 = Math.min(a.x + a.width, b.x + b.width);
    const y1 = Math.min(a.y + a.height, b.y + b.height);
    const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
    if (inter <= 0)
        return 0;
    return inter / (a.width * a.height + b.width * b.height - inter);
}
/** NMS：面积降序贪心保留，IoU ≥ 阈抑制（缺省 0.6 —— a11y 嵌套申报的经验甜点） */
export function nmsElements(elements, threshold = 0.6) {
    const sorted = [...elements].sort((a, b) => b.rect.width * b.rect.height - a.rect.width * a.rect.height);
    const kept = [];
    for (const el of sorted) {
        if (kept.some(k => boxIou(k.rect, el.rect) >= threshold))
            continue;
        kept.push(el);
    }
    // 保持原 id 升序（消费方对 id 序有隐含依赖）
    return kept.sort((a, b) => a.id - b.id);
}
