// src/uiExtractor.ts
// 可访问性树提取 —— 「结构化清单纪元」的遗产，在纯视觉架构中降级为可选混合模式。
// 融合修复：
//   1. 原版 import 不存在的包 -> 改为 Provider 注入（三角色实践：定义与实现分离）；
//   2. 原版「每次重新提取导致 ID 漂移」-> 增加短时缓存，保证 ID 在一次任务内可稳定引用。
export interface UIElement {
  id: number;
  name: string; // 元素文本或 aria-label
  role: string; // button / textbox / link ...
  rect: { x: number; y: number; width: number; height: number }; // 原始像素边界框
}

/** 树节点形状由具体 Provider 决定；本模块只依赖 {rect, role, name, value, children} 约定 */
export type AccessibilityProvider = () => Promise<unknown>;

let provider: AccessibilityProvider | null = null;
let cache: UIElement[] = [];
let cacheAt = 0;
const CACHE_TTL_MS = 1500; // 缓存窗口内 ID 稳定 —— click_element 与 take_screenshot 握手的基石

let globalElementId = 1;

export function setAccessibilityProvider(p: AccessibilityProvider) {
  provider = p;
}

/**
 * 提取可交互元素。双重过滤（语义角色 + 几何面积>0）+ 三级 fallback 命名 + Token 预算(50)。
 */
export async function extractInteractiveElements(force: boolean = false): Promise<UIElement[]> {
  if (!provider) {
    throw new Error(
      'Accessibility provider not configured. ' +
      'Call setAccessibilityProvider() at plugin startup to enable element-ID mode.',
    );
  }
  // 缓存命中：ID 不会因重复提取而漂移
  if (!force && Date.now() - cacheAt < CACHE_TTL_MS) return cache;

  const elements: UIElement[] = [];
  try {
    const tree = await provider();

    function traverse(node: any) {
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
      if (node?.children) node.children.forEach(traverse);
    }

    traverse(tree);
  } catch (error) {
    console.error('[UI Extractor] Failed to get accessibility tree:', error);
  }

  // 提取层就做预算控制，而非把压缩压力推给下游
  cache = elements.slice(0, 50);
  cacheAt = Date.now();
  return cache;
}
