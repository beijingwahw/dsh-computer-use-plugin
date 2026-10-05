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

// ── ΤΕΛ-1（C2-7 §1.3）：L1 UIA 树 provider 工厂 —— element-ID 模式的生产电源 ──
//
// 背景：setAccessibilityProvider 组合根此前零调用 ⇒ enableElementIdMode=true 在
// 任何部署都不可能工作（take_screenshot catch 后静默 elements=[]，四个下游
// 消费端恒空）。本工厂把 D-5 微服务的 L1 无障碍树通道（physicalBackend.getUiTree
// {source:'tree'} —— python_service ui_tree.py 的 comtypes/uiautomation 快照）
// 适配成本模块的 provider 契约，供组合根（src/index.ts）一行注入。
//
// role 方言归一（两端词表的已知缝隙，python 端 _UIA_CONTROL_TYPE_ROLES 注释
// 自证「与 TS 端 interactiveRoles 同形」仅部分成立）：L1 词表 'edit'/'hyperlink'
// 在本模块 interactiveRoles（button/textbox/link/checkbox/combobox/menuitem）
// 之外 —— 不映射则文本框与链接两大交互主力被提取层静默滤空。其余角色
// （button/checkbox/combobox/menuitem）双端同形直通；非交互角色原样透传
// （提取层的角色闸门自会过滤，工厂不重复立法）。

/** L1 树元素的最小结构面（physicalBackend UiTreeResult.elements 的防御投影） */
export interface UiaTreeElementLike {
  role?: unknown;
  name?: unknown;
  rect?: unknown;
}

/** L1 树快照的最小结构面（UiTreeResult 的防御投影 —— 只有 elements 被消费） */
export interface UiaTreeSnapshotLike {
  elements?: ReadonlyArray<UiaTreeElementLike> | null;
}

/** role 方言归一表：python L1 词表 → 本模块 interactiveRoles 词表 */
const UIA_ROLE_ALIASES: Readonly<Record<string, string>> = {
  edit: 'textbox',
  hyperlink: 'link',
};

/** provider 树节点形态（本模块 traverse 消费的 {rect, role, name, children} 约定） */
interface UiaTreeNode {
  rect: { x: number; y: number; width: number; height: number };
  role: string;
  name: string;
  children: UiaTreeNode[];
}

/** ΤΕΛ-1：L1 UIA 树 provider 工厂（纯适配层 —— 零副作用、永不主动抛）。
 *  fetchTree 由组合根注入真身（D-5 通道缺席时它抛出 ⇒ 提取层的 try/catch
 *  消化为空清单 —— 与无 provider 时代的 takeScreenshot 降级路径同语义）。
 *  返回的树根 rect 零尺寸（traverse 的面积闸门自滤，根永不入清单）。 */
export function createUiaTreeProvider(
  fetchTree: () => Promise<UiaTreeSnapshotLike | null | undefined>,
): AccessibilityProvider {
  return async (): Promise<UiaTreeNode> => {
    const res = await fetchTree();
    const raw = Array.isArray(res?.elements) ? res.elements : [];
    const children: UiaTreeNode[] = raw
      .filter((el): el is UiaTreeElementLike => el !== null && typeof el === 'object')
      .map((el): UiaTreeNode | null => {
        const r = el.rect as { x?: unknown; y?: unknown; width?: unknown; height?: unknown } | null;
        // 防御性几何：rect 缺席/非对象/任一字段非有限数 ⇒ 元素整体弃置（把 NaN
        // 洗成 0 会凭空铸造「原点幻影元素」—— 脏几何绝不进可点击清单）；有限
        // 但 ≤0 的宽高放行（提取层 width/height>0 闸门自滤退化框）
        if (r === null || typeof r !== 'object') return null;
        const { x, y, width, height } = r as Record<string, unknown>;
        if (![x, y, width, height].every(v => typeof v === 'number' && Number.isFinite(v))) return null;
        const roleRaw = typeof el.role === 'string' ? el.role.trim().toLowerCase() : '';
        return {
          rect: { x: x as number, y: y as number, width: width as number, height: height as number },
          role: UIA_ROLE_ALIASES[roleRaw] ?? roleRaw,
          name: typeof el.name === 'string' ? el.name : '',
          children: [],
        };
      })
      .filter((n): n is UiaTreeNode => n !== null);
    return { rect: { x: 0, y: 0, width: 0, height: 0 }, role: 'root', name: '', children };
  };
}

/** D-3 白盒源就绪判定：provider 已注入方可声明 isReady（同步、无副作用） */
export function hasAccessibilityProvider(): boolean {
  return provider !== null;
}

/**
 * 提取可交互元素。双重过滤（语义角色 + 几何面积>0）+ fallback 命名（ΠΑΝ-110：
 * name 缺席落 [role] 占位 —— 绝不回显 node.value，用户已输入内容不进提示词）
 * + Token 预算(50)。
 */
export async function extractInteractiveElements(force: boolean = false): Promise<UIElement[]> {
  if (!provider) {
    throw new Error(
      'Accessibility provider not configured. ' +
      'Call setAccessibilityProvider() at plugin startup to enable element-ID mode.',
    );
  }
  // 缓存命中：ID 不会因重复提取而漂移（返回副本 —— 调用方原地排序/裁剪不污染缓存）
  if (!force && Date.now() - cacheAt < CACHE_TTL_MS) return cache.slice();

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
      if (node?.children) node.children.forEach(traverse);
    }

    traverse(tree);
  } catch (error) {
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
function boxIou(a: UIElement['rect'], b: UIElement['rect']): number {
  const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.width, b.x + b.width);
  const y1 = Math.min(a.y + a.height, b.y + b.height);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  if (inter <= 0) return 0;
  return inter / (a.width * a.height + b.width * b.height - inter);
}

/** NMS：面积降序贪心保留，IoU ≥ 阈抑制（缺省 0.6 —— a11y 嵌套申报的经验甜点） */
export function nmsElements(elements: readonly UIElement[], threshold = 0.6): UIElement[] {
  const sorted = [...elements].sort((a, b) =>
    b.rect.width * b.rect.height - a.rect.width * a.rect.height);
  const kept: UIElement[] = [];
  for (const el of sorted) {
    if (kept.some(k => boxIou(k.rect, el.rect) >= threshold)) continue;
    kept.push(el);
  }
  // 保持原 id 升序（消费方对 id 序有隐含依赖）
  return kept.sort((a, b) => a.id - b.id);
}
