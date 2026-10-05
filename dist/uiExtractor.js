let provider = null;
let cache = [];
let cacheAt = 0;
const CACHE_TTL_MS = 1500; // 缓存窗口内 ID 稳定 —— click_element 与 take_screenshot 握手的基石
let globalElementId = 1;
export function setAccessibilityProvider(p) {
    provider = p;
}
/** role 方言归一表：python L1 词表 → 本模块 interactiveRoles 词表 */
const UIA_ROLE_ALIASES = {
    edit: 'textbox',
    hyperlink: 'link',
};
/** ΤΕΛ-1：L1 UIA 树 provider 工厂（纯适配层 —— 零副作用、永不主动抛）。
 *  fetchTree 由组合根注入真身（D-5 通道缺席时它抛出 ⇒ 提取层的 try/catch
 *  消化为空清单 —— 与无 provider 时代的 takeScreenshot 降级路径同语义）。
 *  返回的树根 rect 零尺寸（traverse 的面积闸门自滤，根永不入清单）。 */
export function createUiaTreeProvider(fetchTree) {
    return async () => {
        const res = await fetchTree();
        const raw = Array.isArray(res?.elements) ? res.elements : [];
        const children = raw
            .filter((el) => el !== null && typeof el === 'object')
            .map((el) => {
            const r = el.rect;
            // 防御性几何：rect 缺席/非对象/任一字段非有限数 ⇒ 元素整体弃置（把 NaN
            // 洗成 0 会凭空铸造「原点幻影元素」—— 脏几何绝不进可点击清单）；有限
            // 但 ≤0 的宽高放行（提取层 width/height>0 闸门自滤退化框）
            if (r === null || typeof r !== 'object')
                return null;
            const { x, y, width, height } = r;
            if (![x, y, width, height].every(v => typeof v === 'number' && Number.isFinite(v)))
                return null;
            const roleRaw = typeof el.role === 'string' ? el.role.trim().toLowerCase() : '';
            return {
                rect: { x: x, y: y, width: width, height: height },
                role: UIA_ROLE_ALIASES[roleRaw] ?? roleRaw,
                name: typeof el.name === 'string' ? el.name : '',
                children: [],
            };
        })
            .filter((n) => n !== null);
        return { rect: { x: 0, y: 0, width: 0, height: 0 }, role: 'root', name: '', children };
    };
}
/** D-3 白盒源就绪判定：provider 已注入方可声明 isReady（同步、无副作用） */
export function hasAccessibilityProvider() {
    return provider !== null;
}
/**
 * 提取可交互元素。双重过滤（语义角色 + 几何面积>0）+ fallback 命名（ΠΑΝ-110：
 * name 缺席落 [role] 占位 —— 绝不回显 node.value，用户已输入内容不进提示词）
 * + Token 预算(50)。
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
                        // ΠΑΝ-110（隐私 · C1-3 M-9）：三级 fallback 砍掉 node.value 臂 ——
                        // 旧实现 `node.name || node.value || [role]` 把无 name 的 textbox 的
                        // value（用户已键入的搜索词、聊天草稿、验证码回显等）当元素名送进
                        // 提示词/点击握手。风险词脱敏（typeText 方言）只覆盖凭据类词面，
                        // 普通敏感输入不命中词表 —— 回显 value 与「绝不回显用户输入」的
                        // 红线冲突。修法：value 一律不进 name（控件可寻址性由 id+role+rect
                        // 承担 —— name 缺席时落 [role] 占位，元素永远有可读名字）。
                        name: (typeof node.name === 'string' && node.name.trim() ? node.name : '') || `[${node.role}]`,
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
