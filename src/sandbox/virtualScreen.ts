// src/sandbox/virtualScreen.ts
// K 纪元（留白兑现之一）：虚拟屏模拟器 —— 排练验证层的第一块真证据。
//
// 诚实契约（值即边界）：
//   - 本模拟器不是像素渲染器 —— 它是一个**确定性控件世界**（widget world）。
//     证据来源是命中测试与状态转移，不是合成位图；我们绝不假装渲染了屏幕。
//   - 场景（widgets）由调用方供给。生产路径：规划期从 UI 树提取真实控件
//     （getUiTree / extractInteractiveElements 的产物映射而来）—— 排练因此
//     验证的是**真实控件几何**上的可达性，而非虚构世界。
//   - 无场景 ⇒ 无证据（effectDetected=null）—— 既有 degraded 语义零回归。
//   - 可验证的动作：click（命中=控件聚焦）、type（焦点控件可收文本）。
//     K/N/O 纪元补全：scroll（方向化偏移记账）/ esc 关弹窗 / drag 抓取 /
//     switch_window 标题匹配 / switch_tab 标签序模型均有世界模型；
//     其余热键和弦与 page-level 导航仍恒 null（诚实缺席）。
//   - L4 期望对照：element-level ⇔ 命中；text-level+expectedText ⇔ 焦点输入
//     缓冲包含预期文本；page-level 需导航模型 —— 恒 null（声明即无法对照）。
//   - ΝΩ-30：z-order/遮挡模型 —— 命中测试自顶向下（最高 z 先判），popup 类
//     缺省铸高层；esc 关最上层弹窗；scroll 按 direction 带符号记账且落点坐标
//     参与证据；switch_tab = 有序数组 + 索引（重排跟随元素）。无 z 场景行为
//     逐字节不变（同层按场景序）。
//   - ΤΕΛ-13（D-G16 留案 M8）排练弃权语义：场景角色贫乏（全 'unknown' ——
//     生产供源 uiMemory 锚点的常态）时，「控件未申报能力」（acceptsText/
//     scrollable 缺席、<2 个 role='tab'）是诚实缺席 ⇒ 该步弃权（双 null +
//     零层），绝不铸成世界反证 —— 真机可行的宏不再被元数据贫乏结构性误拒。
//     申报过角色/能力布尔的世界断言保持既有严格反证语义（弃权 ≠ 宽纵：
//     纯弃权链零验证层 ⇒ verdict 'degraded' ⇒ 宏门禁照旧拒绝）。
import type { SandboxAction, VirtualWidget } from './types';

export type { VirtualWidget } from './types';

/** 步进证据：两层各是 boolean|null —— null = 该层不可判（诚实缺席，非 false） */
export interface StepEvidence {
  effectDetected: boolean | null;
  expectationMet: boolean | null;
  note: string;
  /** 本步产生的验证层（计入 RehearsalOutcome.verificationLayers 的评分） */
  layers: Array<'L1-pixel' | 'L3-semantic' | 'L4-expectation'>;
}

/** ΤΕΛ-13（D-G16 留案 M8）排练弃权证据形状：effectDetected/expectationMet 双
 *  null、零验证层 —— 「本步不可判」的规范形（非反证、非通过）。集中铸造
 *  保证全库弃权注记同方言。 */
function abstentionEvidence(note: string): StepEvidence {
  return { effectDetected: null, expectationMet: null, note, layers: [] };
}

const NO_EVIDENCE: StepEvidence = {
  effectDetected: null, expectationMet: null,
  note: 'no virtual scene or action outside the simulable vocabulary',
  layers: [],
};

/** ΝΩ-30：滚动方向闭集（与 actionSchema.SCROLL_DIRECTIONS 同方言 —— 方向化
 *  记账只对已知方向建模；未知方向无世界模型 = 诚实缺席） */
const SCROLL_DIRECTIONS = new Set(['up', 'down', 'left', 'right']);

/** ΝΩ-30：控件名截断上限 —— 与排练场景供源方言对齐（skillTools 的
 *  rehearsalSceneFromMemory label.slice(0, 64)）：20 字符截断让 >20 字的
 *  expectedText 在 L3 场景 OCR 对照上结构性失败（瞄准对了也读不出全文）。 */
const WIDGET_NAME_MAX = 64;

/** ΝΩ-30：弹窗缺省铸层 —— 高于一切缺省 0 层（显式有限 z 在场时从其值）。
 *  导出供 macroRehearsal.buildVirtualScene 同律铸造（单源纪律）。 */
export const VIRTUAL_POPUP_Z = 10;

/** 防御性控件铸造：畸形 rect 拒收（诚实缺席优于毒化命中测试） */
export function asVirtualWidget(raw: unknown): VirtualWidget | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = (raw as any).rect;
  const x = Number(r?.x), y = Number(r?.y), w = Number(r?.width), h = Number(r?.height);
  if (![x, y, w, h].every(Number.isFinite) || x < 0 || y < 0 || w <= 0 || h <= 0) return null;
  if (x > 1 || y > 1 || x + w > 1 + 1e-9 || y + h > 1 + 1e-9) return null;
  const popup = (raw as any).popup === true; // K 纪元补全：esc 可关闭对象
  const rawZ = Number((raw as any).z);
  // ΤΕΛ-13（D-G16 留案 M8）：acceptsText/scrollable 的三态保全 —— 申报布尔
  // 原样透传；缺席**不铸键**（键缺席 = 未申报）。旧铸造 `=== true` 把缺席折叠成
  // false，使「场景元数据贫乏」与「世界明断不可」不可区分 —— 排练弃权语义
  // （见 applyAction 各臂）依赖本处的三态保真。不铸 undefined 值键是纪律而非
  // 风格：ΠΑΝ-49 canonical「undefined 值自有键与缺键同域」—— 直接缺键让
  // 哈希域/JSON 往返/测试复刻三面零分歧。幂等性保持：缺键再铸仍缺键。
  const rawAccepts = (raw as any).acceptsText;
  const rawScrollable = (raw as any).scrollable;
  return {
    role: String((raw as any).role ?? 'unknown'),
    name: String((raw as any).name ?? '').slice(0, WIDGET_NAME_MAX),
    rect: { x, y, width: w, height: h },
    ...(typeof rawAccepts === 'boolean' ? { acceptsText: rawAccepts } : {}),
    ...(typeof rawScrollable === 'boolean' ? { scrollable: rawScrollable } : {}), // K 纪元补全：滚动证据前提（三态）
    popup,
    // ΝΩ-30：z 序 —— 显式有限值优先（调用方主权）；缺席时 popup 铸高层、
    // 其余缺省 0。无 z 场景同层按场景序 —— 既有行为逐字节不变。
    z: Number.isFinite(rawZ) ? rawZ : (popup ? VIRTUAL_POPUP_Z : 0),
  };
}

/**
 * 虚拟屏：应用动作序列，产出逐步证据。确定性、零 IO、永不抛错。
 */
export class VirtualScreen {
  /** 场景序（文档序）—— sceneOcr / 滚动容器回退 / 标签序初始化的基准 */
  private readonly widgets: VirtualWidget[];
  /** ΝΩ-30：命中序 —— z 降序稳定排序（同层按场景序）。命中测试自顶向下：
   *  最高 z 先判命中，被高 z 控件遮住的下层控件不可点（无 z 场景 = 场景序，
   *  既有行为逐字节不变）。 */
  private readonly hitOrder: VirtualWidget[];
  private focus: VirtualWidget | null = null;
  private readonly buffers = new Map<VirtualWidget, string>();
  /** 滚动偏移记账（K 纪元：内容偏移 = 滚动证据的世界状态；ΝΩ-30 方向化 ——
   *  分轴带符号：up 减 down 加（y 轴）；left 减 right 加（x 轴）） */
  private readonly scrollOffsets = new Map<VirtualWidget, { x: number; y: number }>();
  /** 活动标签指针（O 纪元 #14）：元素引用 —— 指针身份随元素而非序位 */
  private activeTab: VirtualWidget | null = null;
  /** ΝΩ-30：标签模型 = 有序标签数组 + 当前索引（重排时索引跟随元素而非位置 ——
   *  与宿主 ctrl+tab 的文档序循环对齐；场景序懒快照，reorderTabs 可重排） */
  private tabOrder: VirtualWidget[] | null = null;
  private activeTabIndex = 0;
  /** ΤΕΛ-13（D-G16 留案 M8）：场景角色贫乏标记 —— 构造时定格。全场景无任何
   *  控件申报非缺省角色（全 'unknown'）⇒ 分类元数据贫乏。C2-3 M8 病灶：生产
   *  供源（uiMemory 锚点 / skillTools 的 rehearsalSceneFromMemory）role 多为
   *  unknown，旧方言把「控件未申报能力」（acceptsText/scrollable 缺席、<2 个
   *  role='tab'）铸成世界反证（false ⇒ 链 failed ⇒ 低可靠宏结构性误拒 —— 真机
   *  完全可行）。立法：贫乏场景下「未申报」是诚实缺席 ⇒ 弃权（null，不计层），
   *  绝不铸成反证；申报过角色的场景（curated/test/规划期 UI 树提取）保持既有
   *  严格反证语义逐字节不变 —— 弃权只发生在「世界自认不知道」的场景。 */
  private readonly rolePoor: boolean;

  constructor(rawWidgets: unknown) {
    const casted = Array.isArray(rawWidgets)
      ? rawWidgets.map(asVirtualWidget).filter((w): w is VirtualWidget => w !== null)
      : [];
    this.widgets = casted;
    // 稳定排序：同 z 层保持场景序（V8 sort 稳定）—— 无 z 场景行为不变
    this.hitOrder = [...casted].sort((a, b) => (b.z ?? 0) - (a.z ?? 0));
    // ΤΕΛ-13（M8）：贫乏判定 = 零申报角色（'unknown' 是 asVirtualWidget 的缺省
    // 铸造值 —— 供源未携带角色证据的信号，非世界断言）
    this.rolePoor = !casted.some(w => w.role !== 'unknown');
  }

  get isEmpty(): boolean { return this.widgets.length === 0; }

  /** 命中测试：中心落区语义（半开 [x0,x1) + 边缘闭合 —— 与分派方言同律）。
   *  ΝΩ-30：自顶向下 —— 按 hitOrder（z 降序、同层场景序）取首个命中。 */
  widgetAt(x: number, y: number): VirtualWidget | null {
    for (const w of this.hitOrder) {
      const { x: x0, y: y0 } = w.rect;
      const x1 = x0 + w.rect.width, y1 = y0 + w.rect.height;
      const inX = x >= x0 && (x < x1 || x1 >= 1);
      const inY = y >= y0 && (y < y1 || y1 >= 1);
      if (inX && inY) return w;
    }
    return null;
  }

  /**
   * O 纪元（#15）：场景 OCR —— 区域内控件名拼接（场景供源的真文本；无像素
   * 世界的诚实等价物：widget.name 就是渲染后 OCR 会读到的文字）。命中区域
   * 的控件按场景序拼接；空区域返回空串。导出：L3 层的测试面。
   */
  sceneOcr(x: number, y: number, half = 0.08): string {
    const texts: string[] = [];
    for (const w of this.widgets) {
      const { x: x0, y: y0 } = w.rect;
      const x1 = x0 + w.rect.width, y1 = y0 + w.rect.height;
      if (x1 >= x - half && x0 <= x + half && y1 >= y - half && y0 <= y + half) {
        texts.push(w.name);
        const buf = this.buffers.get(w);
        if (buf) texts.push(buf); // 输入缓冲也是屏上文字（已上屏的输入）
      }
    }
    return texts.join(' ');
  }

  /** 应用单步动作 → 证据（世界状态随之转移） */
  applyAction(action: SandboxAction): StepEvidence {
    if (this.isEmpty) return NO_EVIDENCE;
    const num = (v: unknown): number | null =>
      typeof v === 'number' && Number.isFinite(v) ? v : null;

    if (action.kind === 'click_mouse') {
      const x = num(action.args?.x), y = num(action.args?.y);
      if (x === null || y === null) return NO_EVIDENCE;
      const hit = this.widgetAt(x, y);
      this.focus = hit; // 命中 ⇒ 聚焦转移；落空 ⇒ 焦点丢失（两者都是状态变化证据）
      const layers: StepEvidence['layers'] = ['L1-pixel'];
      let expectationMet: boolean | null = null;
      let note = hit ? `hit ${hit.role}(${hit.name})@${x.toFixed(2)},${y.toFixed(2)}` : 'miss: no widget under point';
      if (action.expect) {
        if (action.expect.scale === 'element-level') {
          expectationMet = hit !== null;
          layers.push('L4-expectation');
        } else if (action.expect.scale === 'text-level') {
          // O 纪元（#15）L3 语义层：expectedText 在场 ⇒ 场景 OCR 对照（瞄准
          // 验证 —— 点的位置读出的文字应含预期 = 瞄对了控件）；缺席 ⇒ 聚焦
          // 可输入控件即可落字的既有语义（零回归）。
          if (action.expect.expectedText) {
            expectationMet = hit !== null && this.sceneOcr(x!, y!).includes(action.expect.expectedText);
            layers.push('L3-semantic', 'L4-expectation');
            note += `; scene-ocr "${this.sceneOcr(x!, y!).slice(0, 24)}" vs expected "${action.expect.expectedText}"`;
          } else {
            // ΤΕΛ-13（M8）：无 expectedText 的 text-level 期望 = 「聚焦可输入控件
            // 即可落字」。贫乏场景下命中控件未申报接受性 ⇒ 期望不可判（弃权
            // null，非反证）；申报/富场景保持 `=== true` 旧律零回归。
            expectationMet = hit !== null && this.rolePoor && hit.acceptsText === undefined
              ? null
              : hit?.acceptsText === true; // 聚焦可输入控件 = 文字可落
            layers.push('L4-expectation');
          }
        } else {
          note += '; page-level expectation unverifiable without a navigation model (honest null)';
        }
      }
      return { effectDetected: hit !== null, expectationMet, note, layers };
    }

    if (action.kind === 'type_text') {
      const text = typeof action.args?.text === 'string' ? action.args.text : null;
      if (text === null) return NO_EVIDENCE;
      const target = this.focus;
      if (!target) {
        return { effectDetected: false, expectationMet: action.expect ? false : null,
          note: 'typed with no focused widget — text has nowhere to land',
          layers: action.expect ? ['L1-pixel', 'L4-expectation'] : ['L1-pixel'] };
      }
      // ΤΕΛ-13（D-G16 留案 M8 排练弃权）：贫乏场景 + 焦点控件未申报 acceptsText
      // ⇒ 弃权（null ≠ false —— 元数据缺席不是世界反证）。旧方言在此铸 false ⇒
      // 链 failed ⇒ 含 type 的低可靠宏被结构性误拒（真机可行）。世界演化按
      // 「宏在真机录成」假设性入账缓冲（下游期望在乐观世界判定 —— 不因我方
      // 无知制造下游反证），但本步判定弃权、零验证层计入。
      if (this.rolePoor && target.acceptsText === undefined) {
        const buf = (this.buffers.get(target) ?? '') + text;
        this.buffers.set(target, buf);
        return abstentionEvidence(
          `focused ${target.role}(${target.name}) does not declare text acceptance — scene metadata poor, `
          + 'verdict withheld (honest abstention, not counter-evidence)');
      }
      if (!target.acceptsText) {
        return { effectDetected: false, expectationMet: action.expect ? false : null,
          note: `focused ${target.role}(${target.name}) does not accept text`,
          layers: action.expect ? ['L1-pixel', 'L4-expectation'] : ['L1-pixel'] };
      }
      const buf = (this.buffers.get(target) ?? '') + text;
      this.buffers.set(target, buf);
      let expectationMet: boolean | null = null;
      const layers: StepEvidence['layers'] = ['L1-pixel'];
      if (action.expect?.scale === 'text-level') {
        expectationMet = action.expect.expectedText
          ? buf.includes(action.expect.expectedText)
          : true; // 未声明具体文本：落在输入框即为满足
        layers.push('L4-expectation');
      }
      return { effectDetected: true, expectationMet,
        note: `typed ${text.length} chars into ${target.name} (buffer ${buf.length})`, layers };
    }

    // ── K 纪元补全：滚动证据（光标所在可滚动容器 ⇒ 内容偏移变化 = L1）──
    // ΝΩ-30：证据方向化 —— 按 direction 带符号记账（up 减 down 加；left/right
    // 同理对 x 轴），落点坐标（显式 x/y）参与证据：落点决定滚动作用容器，
    // 落在不可滚动控件/空处 = 诚实反证（与点击落空同律）。
    if (action.kind === 'scroll_page') {
      const dir = action.args?.direction;
      const amount = Number(action.args?.amount);
      if (typeof dir !== 'string' || !SCROLL_DIRECTIONS.has(dir)
        || !Number.isFinite(amount) || amount <= 0) return NO_EVIDENCE; // 未知方向/脏量：无模型 —— 诚实缺席
      const px = num(action.args?.x), py = num(action.args?.y);
      let scrollable: VirtualWidget | null = null;
      let landing: { x: number; y: number };
      if (px !== null && py !== null) {
        // 落点权威：落点上的控件可滚 ⇒ 就是它；否则反证（绝不隔空找容器）。
        // ΤΕΛ-13（M8）：贫乏场景的落点控件未申报滚动能力 ⇒ 弃权（缺席 ≠ 反证）；
        // 申报 false（世界明断不可滚）或富场景未申报 ⇒ 保持旧律反证。
        landing = { x: px, y: py };
        const hit = this.widgetAt(px, py);
        if (hit?.scrollable === true) {
          scrollable = hit;
        } else if (hit !== null && this.rolePoor && hit.scrollable === undefined) {
          return abstentionEvidence(
            `scroll at (${px.toFixed(2)},${py.toFixed(2)}) landed on ${hit.role}(${hit.name}) `
            + 'which does not declare scrollability — scene metadata poor, '
            + 'verdict withheld (honest abstention, not counter-evidence)');
        }
      } else if (this.focus?.scrollable === true) {
        scrollable = this.focus;
        landing = {
          x: this.focus.rect.x + this.focus.rect.width / 2,
          y: this.focus.rect.y + this.focus.rect.height / 2,
        };
      } else {
        // 兼容回退（K-7a 方言）：无落点无焦点 ⇒ 场景序首个可滚动容器
        scrollable = this.widgets.find(w => w.scrollable) ?? null;
        landing = scrollable
          ? { x: scrollable.rect.x + scrollable.rect.width / 2, y: scrollable.rect.y + scrollable.rect.height / 2 }
          : { x: 0.5, y: 0.5 };
      }
      if (!scrollable) {
        // ΤΕΛ-13（M8）：贫乏场景且全场景零滚动申报 ⇒ 「无容器」是元数据缺席
        // 不是世界断言 ⇒ 弃权（旧方言铸 false —— 真机滚轮在未知场景完全可行）。
        // 任一控件申报过 scrollable（含 false —— 世界明断滚动性）或富场景
        // （有申报角色）⇒ 保持旧律反证零回归。
        if (this.rolePoor && !this.widgets.some(w => w.scrollable !== undefined)) {
          return abstentionEvidence(
            'scroll found no declared scrollable container — scene metadata poor, '
            + 'verdict withheld (honest abstention, not counter-evidence)');
        }
        return { effectDetected: false, expectationMet: null,
          note: px !== null && py !== null
            ? `scroll at (${px.toFixed(2)},${py.toFixed(2)}) landed off any scrollable container — content cannot move`
            : 'scroll with no scrollable container — content cannot move',
          layers: ['L1-pixel'] };
      }
      const off = this.scrollOffsets.get(scrollable) ?? { x: 0, y: 0 };
      if (dir === 'up') off.y -= amount;
      else if (dir === 'down') off.y += amount;
      else if (dir === 'left') off.x -= amount;
      else off.x += amount;
      this.scrollOffsets.set(scrollable, off);
      // 纵向单轴保持旧注格式（offset N）；横轴在场时显式分轴（方向可辨）
      const trim = (v: number): number => Math.round(v * 1e6) / 1e6;
      const offNote = off.x === 0 ? `${trim(off.y)}` : `x=${trim(off.x)},y=${trim(off.y)}`;
      return { effectDetected: true, expectationMet: null,
        note: `scrolled ${dir} x${amount} in ${scrollable.name} at (${landing.x.toFixed(2)},${landing.y.toFixed(2)}) (offset ${offNote})`,
        layers: ['L1-pixel'] };
    }

    // ── K 纪元补全：热键证据（esc ⇒ 关闭最上层弹窗 = L1 状态变化）──
    if (action.kind === 'press_hotkey') {
      const keys = Array.isArray(action.args?.keys) ? action.args!.keys : [];
      if (keys.length !== 1 || String(keys[0]).toLowerCase() !== 'esc') return NO_EVIDENCE; // 其他热键无键盘状态模型 —— 诚实缺席
      // ΝΩ-30：关闭**最上层**弹窗 —— 命中序（z 降序、同层场景序）里首个 popup，
      // 而非场景序首个（弹窗排在数组前 ≠ 在最上）。点击已不可穿透弹窗，esc
      // 亦不可隔层关窗 —— 与遮挡模型同一事实源。
      const closed = this.hitOrder.find(w => w.popup) ?? null;
      if (!closed) {
        return { effectDetected: false, expectationMet: null,
          note: 'esc with no popup open — nothing to dismiss', layers: ['L1-pixel'] };
      }
      this.removeWidget(closed);
      return { effectDetected: true, expectationMet: null,
        note: `esc dismissed popup ${closed.name}`, layers: ['L1-pixel'] };
    }

    // ── N 纪元补全：拖拽证据（起点命中 = 抓取；抓空 = 反证）──
    if (action.kind === 'drag_mouse') {
      const sx = num(action.args?.startX), sy = num(action.args?.startY);
      const ex = num(action.args?.endX), ey = num(action.args?.endY);
      if (sx === null || sy === null || ex === null || ey === null) return NO_EVIDENCE;
      const grabbed = this.widgetAt(sx, sy);
      if (!grabbed) {
        return { effectDetected: false, expectationMet: null,
          note: 'drag started on empty space — nothing grabbed', layers: ['L1-pixel'] };
      }
      this.focus = grabbed;
      return { effectDetected: true, expectationMet: null,
        note: `dragged ${grabbed.name} to (${ex.toFixed(2)},${ey.toFixed(2)})`, layers: ['L1-pixel'] };
    }
    // ── N 纪元补全：切窗证据（标题关键词命中控件 = 聚焦转移；无匹配 = 反证）──
    if (action.kind === 'switch_window') {
      const kw = typeof action.args?.titleKeyword === 'string' ? action.args.titleKeyword.toLowerCase() : '';
      if (!kw) return NO_EVIDENCE;
      const target = this.widgets.find(w => w.name.toLowerCase().includes(kw));
      if (!target) {
        return { effectDetected: false, expectationMet: null,
          note: `no window title contains ${JSON.stringify(kw)}`, layers: ['L1-pixel'] };
      }
      this.focus = target;
      return { effectDetected: true, expectationMet: null,
        note: `focus moved to ${target.name} (title match)`, layers: ['L1-pixel'] };
    }
    // ── O 纪元补全（#14）：切签证据。ΝΩ-30：模型 = 有序标签数组 + 当前索引 ——
    // 标签序是**可重排**的模型状态（reorderTabs），指针（activeTab 元素引用 +
    // activeTabIndex）在重排时跟随元素而非位置（与宿主 ctrl+tab 顺序对齐）；
    // 指针移动 = L1 状态变化。标签 <2 ⇒ 反证：无处可切）──
    if (action.kind === 'switch_tab') {
      const dir = action.args?.direction;
      const tabs = this.ensureTabOrder();
      if (tabs.length < 2) {
        // ΤΕΛ-13（M8）：贫乏场景的「<2 标签」是分类缺席不是世界断言 —— 真机
        // ctrl+tab 完全可行（宿主浏览器标签不在场景角色知识内）⇒ 弃权。
        // 申报过角色的场景（curated/test，含单标签栈）保持旧律反证零回归。
        if (this.rolePoor) {
          return abstentionEvidence(
            `tab stack shows ${tabs.length} declared tab(s) but scene roles are unclassified — `
            + 'cannot falsify switch_tab (honest abstention, not counter-evidence)');
        }
        return { effectDetected: false, expectationMet: null,
          note: `tab stack has ${tabs.length} tab(s) — nothing to switch to`,
          layers: ['L1-pixel'] };
      }
      // 活动指针初始化：聚焦在标签上 ⇒ 就是它；否则首标签（标签序 = 文档序）
      if (!this.activeTab || !tabs.includes(this.activeTab)) {
        this.activeTab = this.focus && tabs.includes(this.focus) ? this.focus : tabs[0];
      }
      const from = this.activeTab ?? tabs[0];
      const idx = tabs.indexOf(from);
      const delta = dir === 'previous' ? -1 : 1; // 缺省/未知方向 = next（与工具面方言同律）
      const nextIdx = (idx + delta + tabs.length) % tabs.length;
      const next = tabs[nextIdx];
      this.activeTab = next;
      this.activeTabIndex = nextIdx;
      this.focus = next;
      return { effectDetected: true, expectationMet: null,
        note: `tab ${from.name} → ${next.name} (${dir ?? 'next'}, stack ${tabs.length})`,
        layers: ['L1-pixel'] };
    }
    // ΝΩ-30：词表外工具的诚实标注 —— noop 若携带 unsupported_tool 标记（macroRehearsal
    // 翻译产物），注里点名无状态模型的宿主工具，而非冒充「元动作无状态模型」。
    if (action.kind === 'noop' && typeof action.args?.unsupported_tool === 'string') {
      return {
        effectDetected: null, expectationMet: null, layers: [],
        note: `host tool "${String(action.args.unsupported_tool).slice(0, 64)}" is outside the simulable vocabulary (unsupported — honest absence, not a meta no-op)`,
      };
    }
    return NO_EVIDENCE; // dismiss_popup/noop：元动作无状态模型（值即边界）
  }

  /** 标签序懒快照：role='tab' 按场景序（首次切签时定格；此后重排只经 reorderTabs） */
  private ensureTabOrder(): VirtualWidget[] {
    if (this.tabOrder === null) this.tabOrder = this.widgets.filter(w => w.role === 'tab');
    return this.tabOrder;
  }

  /**
   * ΝΩ-30：标签重排（宿主标签拖拽重排的世界事件）。索引跟随元素：当前活动
   * 标签无论移到哪一序位，指针仍指向它（位置跟随会与宿主 ctrl+tab 顺序失配）。
   * 防御式：非数组 / 长度不符 / 含未知元素 / 含重复 ⇒ 整体忽略（世界不变，
   * 绝不抛 —— 运行层铁律）。
   */
  reorderTabs(next: unknown): void {
    const current = this.ensureTabOrder();
    if (!Array.isArray(next) || next.length !== current.length) return;
    const known = new Set<VirtualWidget>(current);
    const casted = next as unknown[];
    if (!casted.every(w => known.has(w as VirtualWidget))) return;
    if (new Set(casted).size !== casted.length) return; // 重复 = 非重排
    const el = this.activeTab && current.includes(this.activeTab)
      ? this.activeTab
      : (current[this.activeTabIndex] ?? null); // 指针元素（activeTab 优先）
    this.tabOrder = [...casted as VirtualWidget[]];
    this.activeTabIndex = el && this.tabOrder.includes(el) ? this.tabOrder.indexOf(el) : 0;
  }

  /** ΝΩ-30：控件消亡的世界清理（esc 关弹窗等）—— 三序（场景/命中/标签）与
   *  指针/缓冲/偏移记账同步剥离，模型状态与可见世界永不失同步 */
  private removeWidget(w: VirtualWidget): void {
    const si = this.widgets.indexOf(w);
    if (si >= 0) this.widgets.splice(si, 1);
    const hi = this.hitOrder.indexOf(w);
    if (hi >= 0) this.hitOrder.splice(hi, 1);
    if (this.tabOrder !== null) {
      const ti = this.tabOrder.indexOf(w);
      if (ti >= 0) this.tabOrder.splice(ti, 1);
      if (this.activeTabIndex >= this.tabOrder.length) {
        const el = this.activeTab && this.tabOrder.includes(this.activeTab) ? this.activeTab : null;
        this.activeTabIndex = el ? this.tabOrder.indexOf(el) : 0;
      }
    }
    if (this.focus === w) this.focus = null;
    if (this.activeTab === w) this.activeTab = null;
    this.buffers.delete(w);
    this.scrollOffsets.delete(w);
  }
}
