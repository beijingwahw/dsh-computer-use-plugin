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
    // 缓存命中：ID 不会因重复提取而漂移
    if (!force && Date.now() - cacheAt < CACHE_TTL_MS)
        return cache;
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
    cache = elements.slice(0, 50);
    cacheAt = Date.now();
    return cache;
}
