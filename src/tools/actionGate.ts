// src/tools/actionGate.ts
// Δ 纪元（全库跃迁·审计#1）：动作闸门的唯一事实源。
//
// 背景：审批闸门（危险词 ⇒ 需已授予的一次性令牌）与风险闸门（凭据 ⇒ 交还
// 用户）原本住在 clickMouse / typeText 工具内部 —— 而 replayOne（replay_actions
// / run_skill / orchestrator 的技能回退）直调 system.clickMouse/typeText，完全
// 绕过工具层。日志里的「发送」点击、凭据输入可被 run_skill 无令牌原样重放。
//
// 修法：判定逻辑抽取为本模块的 assertActionAllowed —— 工具层与重放层共用同一
// 事实源。抽取自 clickMouse（第六轮 + B-3 + J-14 跨通道 + N 纪元硬前置）与
// typeText（长度防御 + 第五轮风险闸门），逐语义等价：
//   click_mouse：
//     · 危险信号 = target_description **或** expected_text 命中 dangerPatterns
//       （J-14：expected_text 是第二危险信号通道 —— 绕过须同时沉默两条独立通道）；
//     · dangerous（闸门开启且命中）且无已授予有效令牌 ⇒ 拒绝（token 在场归因
//       'token-not-granted-or-expired'，缺席归因 'irreversible-action'），
//       阻断路径顺手 sweep 过期令牌（与旧实现同律）；
//     · 闸门开启时双通道全沉默 ⇒ 'undescribed-click' 硬前置（N 纪元 #18）。
//   type_text：
//     · 长度防御：text 超过 maxTextLength ⇒ 拒绝（防注入超长文本）；
//     · 风险闸门：焦点被标记为敏感区（点击密码框后）或文本自身命中风险语义
//       ⇒ 拒绝（凭据类输入不代劳）。
//
// 纪元 Ρ（双钥公证锁）：多通道语义公证。
// 背景审计：危险判定此前只信模型自述（target_description/expected_text）——
// 被提示注入的模型谎报目标（"press the button"）即可绕过 dangerPatterns 词表。
// 修法：assertActionAllowed 签名兼容扩展可选 evidence 参数，三通道 fail-heavy：
//   模型自述（现有双通道）∪ OCR 实读（ocrLabel）∪ 白盒控件名（structuralName），
//   任一通道经 normalizeForRisk 归一后命中 dangerPatterns ⇒ 按危险处理（需已授予令牌）。
// 配套语义握手（notarySemanticHandshake）：ocrLabel 与模型描述同时在场时，归一化后
// 须 fuzzyIncludes 双向宽松印证；不符 ⇒ 'notary-mismatch' 拒绝并要求以屏幕实读文字
// 重新描述目标。零回归律：evidence 缺席/两新通道全 null ⇒ 判定逐字段同旧版，仅加
// notarization:'degraded' 诚实标注；总开关 enableNotarizationLock=false ⇒ 完全旧路径。
//
// ── ΠΑΝ-12（键盘/拖拽侧门封堵）：ActionKind 扩员为完整闭集 ──
// 批判报告 C1-5 H4/H5：ActionKind 此前仅 click/type —— press_hotkey 完全在闸门
// 约束之外（点击危险按钮后 press_hotkey(['enter']) 激活确认零审批；敏感焦点上
// ctrl+v 把剪贴板粘进凭据框绕过 sensitive-input 闸）；drag_mouse 在工具层是纯
// 模型自述判定（无公证、无预留）。本纪元把全部物理写通道纳入同一事实源：
//   press_hotkey：黑名单和弦（复用 system.hotkeyPolicy 的纯函数 hotkeyBlacklistHit，
//     同一执法词表，无环依赖）+ ctrl/cmd+v × 敏感焦点 = 'sensitive-input'（type
//     臂的键盘孪生）+ context_description 命中危险词 ⇒ 审批域（enter 激活危险
//     默认钮的主通道 —— 模型声明「这个热键作用在什么上」，与 click 的
//     target_description 同律）。
//   drag_mouse：复用 click 判定核（四通道 fail-heavy + Ρ 语义握手 + 公证戳），
//     仅一点有意差异 —— 描述是**可选**通道（滑块/窗口拖拽无危险语义，不设
//     undescribed 硬前置；'undescribed-click' 折叠为放行，但公证通道见危险时
//     仍按危险执法 —— fail-heavy 先于可选通道松弛）。
//   scroll_page：视口导航，无可判定的不可逆语义面 —— 恒放行；纳入闭集是为了
//     ΠΑΝ-14 的完备性执法（新增物理写通道必须显式过闸，而不是静默落进别的臂）。
// 零回归律：既有 click/type 两臂的判定行为逐字节不变；新判定只对新纳入的
// ActionKind 生效；未登记 kind 从「静默落进 type 臂」改为结构化 fail-closed 拒绝
// （'unknown-action-kind'，绝不抛）。
import { matchesRiskPatterns, matchesDangerPatterns, normalizeForRisk, DEFAULT_RISK_PATTERNS, DEFAULT_DANGER_PATTERNS } from '../riskGate';
import { fuzzyIncludes } from '../fuzzy';
import { approval, type TargetHint } from '../approval';
import { focusTracker } from '../focusTracker';
// ΠΑΝ-12：只 import 纯函数（hotkeyPolicy 仅依赖 config —— 无环）；
// 黑名单 CSV 由调用方经 cfg.hotkeyBlacklist 显式携带（Config 结构子集），
// 缺席 ⇒ 本闸不重复执法黑名单 —— 事实源仍是 system.pressHotkey（P1-3 立法）。
import { hotkeyBlacklistHit } from '../system.hotkeyPolicy';

/**
 * 受闸门约束的动作种类 —— 全部物理写通道的完整闭集（ΠΑΝ-12 扩员）。
 * click_mouse/type_text 是 Δ 纪元原住民；press_hotkey/drag_mouse/scroll_page
 * 是 ΠΑΝ-12 纳入的侧门封堵面。装配执法（ΠΑΝ-14）：新增 kind 必须同步
 * ACTION_KIND_UNIVERSE 与 ACTION_KIND_HANDLERS（映射类型缺键 ⇒ 编译红），
 * 测试锁定闭集完整性（新增 kind 漏判即红）。
 */
export type ActionKind = 'click_mouse' | 'type_text' | 'press_hotkey' | 'drag_mouse' | 'scroll_page';

/**
 * ΠΑΝ-14：闭集宇宙常量 —— 与 ActionKind 联合类型一一对应（装配期/测试期
 * 完备性执法的事实源）。Object.freeze 防运行时篡改；测试用 deepEqual 锁死
 * 成员与顺序，新增/删除 kind 而不同步本常量 ⇒ 测试红。
 */
export const ACTION_KIND_UNIVERSE: ReadonlyArray<ActionKind> = Object.freeze([
  'click_mouse', 'type_text', 'press_hotkey', 'drag_mouse', 'scroll_page',
]);

/** 拒绝原因（allowed=false 时必有） */
export type ActionGateReason =
  | 'irreversible-action'            // click/drag/hotkey：危险目标且无令牌
  | 'token-not-granted-or-expired'   // click/drag/hotkey：令牌在场但未授予/已过期
  | 'undescribed-click'              // click：双信号通道全沉默（N 纪元硬前置）
  | 'text-too-long'                  // type：超长文本
  | 'sensitive-input'                // type/hotkey：凭据/验证码语义（含粘贴面）
  | 'notary-mismatch'                // Ρ：OCR 实读与模型自述不符（要求以屏幕实读文字重述）
  | 'blacklisted-hotkey'             // ΠΑΝ-12：系统级热键黑名单和弦（alt+f4/meta/…，令牌不可解）
  | 'unknown-action-kind';           // ΠΑΝ-14：未登记 kind 的 fail-closed 拒绝（绝不抛）

export interface ActionGateDecision {
  allowed: boolean;
  /** 拒绝原因（allowed=true 时为 undefined） */
  reason?: ActionGateReason;
  /** 该拒绝属审批域（危险词命中）：一枚已授予的有效令牌可解封 */
  requiresApproval: boolean;
  /** click 专属：危险词命中且审批闸门开启（带有效令牌放行时仍为 true ——
   *  下游的验收式消费/派发预留逻辑据此挂钩） */
  dangerous: boolean;
  /** 危险信号通道（J-14 锚点归因用；Ρ 纪元扩至公证双通道；ΠΑΝ-12 扩至
   *  hotkey 的 context_description 自述通道） */
  dangerSignalChannel?: 'target_description' | 'expected_text' | 'ocr_label' | 'structural_name' | 'context_description';
  /** Ρ 纪元：公证锁参与情况。undefined = 总开关关闭（完全旧路径，键不入场）；
   *  'degraded' = 锁开但证据缺席/通道全空（判定同旧版，仅诚实标注）或握手被
   *  跳过（短标签防误杀）；'engaged' = 至少一条公证通道在场参与判定。 */
  notarization?: 'engaged' | 'degraded';
  /** Ρ 纪元：degraded/拒因的诚实注记（如 'handshake-skipped:ocr-label-too-short'） */
  notaryNote?: string;
}

/**
 * Ρ 纪元（双钥公证锁）：点击落点的独立取证证据。
 * 由调用方（clickMouse/clickElement）在物理派发前采集；本模块保持纯判定 ——
 * 取证失败一律 null（诚实缺席），锁只在「通道在场且见危险/不符」时收紧。
 */
export interface NotaryEvidence {
  /** OCR 实读通道：点击落点邻域的屏幕实读文字（null/空 = 通道缺席） */
  ocrLabel?: string | null;
  /** 白盒结构通道：UIA 点查询返回的控件登记名（null/空 = 通道缺席） */
  structuralName?: string | null;
}

/** 闸门判定所需的配置子集（Config 的结构子类型 —— 工具层直接传全量 config） */
export interface ActionGateConfig {
  enableApprovalGate: boolean;
  dangerPatterns: string;
  enableRiskGate: boolean;
  riskPatterns: string;
  maxTextLength: number;
  focusMaxAgeMs: number;
  /** Ρ 纪元：双钥公证锁总开关（false = 完全旧路径，evidence 一律无视） */
  enableNotarizationLock: boolean;
  /** Ρ 纪元：语义握手 —— OCR 实读与模型描述的宽松双向印证，不符 ⇒ notary-mismatch */
  notarySemanticHandshake: boolean;
  /** ΠΑΝ-12：系统级热键黑名单 CSV（Config.hotkeyBlacklist 的结构子集）。
   *  可选且缺席 ⇒ 本闸不重复执法黑名单（事实源仍是 system.pressHotkey 的
   *  P1-3 执法点 —— 无 config 的调用方保持完全旧路径）。 */
  hotkeyBlacklist?: string;
}

/** 缺省闸门配置：与 Config 缺省同值 —— 重放层未透传配置时不得静默失守 */
export const DEFAULT_ACTION_GATE_CONFIG: ActionGateConfig = {
  enableApprovalGate: true,
  dangerPatterns: DEFAULT_DANGER_PATTERNS,
  enableRiskGate: true,
  riskPatterns: DEFAULT_RISK_PATTERNS,
  maxTextLength: 1000,
  focusMaxAgeMs: 30_000,
  enableNotarizationLock: true,
  notarySemanticHandshake: true,
  // ΠΑΝ-12：hotkeyBlacklist 刻意缺席 —— 缺省不携带（无 config 的调用方交给
  // system 层 P1-3 执法；携带了 Config 的调用方自然透传，闸门前置结构化拒绝）
};

/** 重放/技能步骤被闸门拦截的稳定标记（replay_actions 据此 fail-fast 中止；
 *  run_skill 据 FAILED 前缀计失败步） */
export const SAFETY_GATE_BLOCK = 'safety-gate-blocked';

// ─── ΠΑΝ-114（F2-1 移交项①）：validate 侧的 targetHint —— 与 consume 同标准 ───
//
// 病灶（F1-4 移交项③残余 / F2-1 第七节 1）：approval.ledger 的 validate 自
// ΠΑΝ-5 起接受可选 targetHint（macaroon 式目标绑定比对），但本闸门两处
// validate 调用（click 判定核 / hotkey 判定面）只传令牌 —— 携带目标绑定的令牌
// 在闸门处恒被 fail-closed 拒绝（target-hint-required），绑定令牌在「审批通过
// → 派发」全链路上只有 consume 兑现面一处能通过：合法持有者携**与 consume 同
// 标准**的完整形状到闸门，也照样被拦（安全方向但语义残缺 —— F2-1 报告申报的
// 移交点）。
//
// 修法：validate 侧从 args 铸造与消费点同标准的 hint（clickMouse 兑换面 =
// {tool:'click_mouse', x, y, target_description: target_description ?? expected_text}；
// dragMouse = 描述级；pressHotkey = {tool:'press_hotkey', target_description:
// context_description}）。零回归律：未携带绑定的令牌对 hint 免疫（ΠΑΝ-5 兼容律
// —— validate 的绑定检查直接放行）；携带绑定的令牌缺坐标（live clickMouse 的
// 闸门 args 不含 x/y）⇒ 摘要不匹配照旧拒绝（fail-closed 方向不变，仅内部归因
// 从 target-hint-required 变 target-mismatch）；args 携带完整形状（replayOne 的
// 重放步带全量参数）⇒ 匹配即放行 —— 绑定令牌的「一次同意恰授权这一个目标」
// 契约自此在闸门与兑现面**同一标准**成立。

/**
 * ΠΑΝ-114：validate 侧 hint 铸造（纯函数、绝不抛）。坐标/描述字段按在场性
 * 防御收口（非有限数/非字符串一律缺席 —— 与 computeTargetDigest 的规范化
 * 管道同域：缺席字段不参与摘要，铸出的 digest 与携带同字段的 consume hint
 * 逐字节一致）。tool 恒为该判定面的 ActionKind（与各消费点的 consume hint
 * 同 tool 方言）。
 */
function targetHintOf(
  kind: ActionKind,
  a: Record<string, any>,
  descOverride?: string,
): TargetHint {
  const hint: { tool: string; x?: number; y?: number; target_description?: string } = { tool: kind };
  if (typeof a.x === 'number' && Number.isFinite(a.x)) hint.x = a.x;
  if (typeof a.y === 'number' && Number.isFinite(a.y)) hint.y = a.y;
  // 描述通道与消费点同标准：target_description ?? expected_text（click 兑换面
  // 同一优先序）；descOverride 供 hotkey 臂把 context_description 映射进
  // target_description 槽（pressHotkey 兑换面的既定方言）。
  const rawDesc = typeof descOverride === 'string' && descOverride.trim() !== ''
    ? descOverride
    : typeof a.target_description === 'string' && a.target_description.trim() !== ''
      ? a.target_description
      : typeof a.expected_text === 'string' && a.expected_text.trim() !== ''
        ? a.expected_text
        : undefined;
  if (rawDesc !== undefined) hint.target_description = rawDesc;
  return hint;
}

// ─── 纪元 Ρ：语义握手（纯函数，测试面） ───

/** OCR 实读标签的最小可用长度：低于此（图标按钮的「×」「+」）跳过握手 ——
 *  单字符标签对任何描述都无法印证，执法即误杀 */
const NOTARY_LABEL_MIN_CHARS = 2;

/** 词元切分：空白分词 + 风险域归一化；归一后 <2 字符的词元剔除 ——
 *  单字符 pattern 在 fuzzyIncludes 的容差（⌈1/6⌉=1）下对空串也命中，必须过滤 */
function notaryTokens(raw: string): string[] {
  return raw
    .toLowerCase()
    .split(/\s+/)
    .map(t => normalizeForRisk(t))
    .filter(t => t.length >= 2);
}

/**
 * 双钥握手（Ρ-2）：屏幕实读标签与模型描述的宽松双向印证。
 * 判据（任一成立即通过）：
 *   1. 整串双向：归一化后的标签与描述互为（OCR 容错）子串 —— 长串的容差
 *      ⌈m/6⌉ 吸收 OCR 噪声；
 *   2. 词元双向覆盖（ΤΕΛ-6/D-G32·M2 收口）：两侧**同时**有实义词元印证 ——
 *      实读侧至少一个词元（归一化后精确）出现在描述全文（邻域多控件并读，
 *      实读侧不设多数 —— 防误杀），且描述侧的多数词元（≥⌈n/2⌉）在实读全文
 *      可见。原「任一侧任一同现词即过」的判据被 C1-5 M2 点名：注入式描述
 *      只要在长描述里撒一个邻域可见词（页面标题/常见 UI 词）即可穿透握手
 *      点击别的控件；收紧后多词描述必须过半数可见（引用式纪律 —— 工具层
 *      next_step 本就要求「用屏幕实读文字重述」）。
 *      刻意保留的宽面（诚实边界）：≤2 词元的短描述维持旧律（词元太少时多数律
 *      无信息量且误杀引用式描述；CJK 无空白分词天然单词元 —— 中文描述零回归）；
 *      单词元描述引用邻域词与诚实引用在邻域 OCR 证据形状下不可区分 —— 该
 *      残余缝隙由白盒控件名通道（目标级证据）与新鲜度层（M3）承接。
 * 跳过（ok=true 且 skipped 注明理由，调用方记 degraded 注记）：
 *   标签过短（<2 字符）/ 纯标点（归一化后为空）/ 描述不可归一 —— 防误杀。
 * 纯函数：两侧输入同过 normalizeForRisk（leet/同形字/全角在归一域内对齐）。
 */
export function notaryHandshake(rawLabel: string, rawDesc: string): { ok: boolean; skipped: string | null } {
  const label = rawLabel.trim();
  if (label.length < NOTARY_LABEL_MIN_CHARS) return { ok: true, skipped: 'ocr-label-too-short' };
  const labelNorm = normalizeForRisk(label);
  if (!labelNorm) return { ok: true, skipped: 'ocr-label-pure-punctuation' };
  const descNorm = normalizeForRisk(rawDesc);
  if (!descNorm) return { ok: true, skipped: 'description-unnormalizable' };
  // 整串双向：描述里能找到屏幕实读标签（或反之）即印证。容差只授予够长的
  // pattern（≥3 字符）：2 字符串配 ⌈m/6⌉=1 的容差会把 'ok' 匹配到无关邻接
  // 对 'ow' 上 —— 短串退回精确包含（混淆免疫仍由归一化双侧完成）。
  const wholeHit = (p: string, hay: string) => (p.length >= 3 ? fuzzyIncludes(p, hay) : hay.includes(p));
  if (wholeHit(labelNorm, descNorm) || wholeHit(descNorm, labelNorm)) {
    return { ok: true, skipped: null };
  }
  // 词元双向覆盖（ΤΕΛ-6/D-G32·M2）：实读侧 ≥1 词元在描述中 ∧ 描述侧达门槛。
  // 词元级不走编辑距离（2 字符词元配容差 1 会把 'ok' 匹配到 'ow' 这类无关
  // 邻接对上）；混淆免疫已由 normalizeForRisk 在双侧完成。
  const labelTokens = notaryTokens(label);
  const descTokens = notaryTokens(rawDesc);
  const matchedLabel = labelTokens.filter(t => descNorm.includes(t)).length;
  const matchedDesc = descTokens.filter(t => labelNorm.includes(t)).length;
  // 短描述（≤2 词元，含 CJK 单词元）维持「任一同现」旧律；≥3 词元须过半可见
  const descFloor = descTokens.length >= 3 ? Math.ceil(descTokens.length / 2) : 1;
  if (matchedLabel >= 1 && matchedDesc >= descFloor) return { ok: true, skipped: null };
  return { ok: false, skipped: null };
}

// ─── ΤΕΛ-6（D-G32·M3）：公证证据新鲜度 —— 层间缝隙的纯函数判决面 ───

/** 公证证据（OCR 实读/白盒控件名）从取证到物理派发的最大可信间隔。
 *  C1-5 M3 实测：notary 在链路早期执行，其后反驳法院最坏 8s + 记忆预验 +
 *  探针 + 多次截屏 ⇒ 取证到派发可隔 10s+ —— 帧票据 2s 新鲜度只管截屏复用，
 *  不管公证证据。10s 立法取「批判实测下界 + 反驳法院上界」的整化值（修法面：
 *  改值即修法，与 NOTARY_LABEL_MIN_CHARS 同律 —— 模块常量不进 config）。 */
const NOTARY_EVIDENCE_MAX_AGE_MS = 10_000;

/**
 * 公证证据时效判决（纯函数、绝不抛）：取证时刻与「现在」之差超阈 ⇒ 证据过期。
 * capturedAtMs 非有限数（null/undefined/NaN —— 公证未 engage 或取证面缺席）
 * ⇒ false：本检查只对「在场的证据」执法，证据缺席的 degraded 语义归
 * notarization 标注面，不在此重复。时钟回拨（差为负）不判过期（证据来自
 * 「未来」是时钟面异常，交给既有的时间回拨披露面 —— ΠΑΝ-53 同族）。
 * 消费点：clickMouse 派发前闸（dangerous+token 面，freshness 同执法点族）；
 * 导出为纯函数供测试与重放层共用（与 notaryHandshake 同方言）。
 */
export function notaryEvidenceStale(capturedAtMs: number | null | undefined, nowMs: number): boolean {
  if (typeof capturedAtMs !== 'number' || !Number.isFinite(capturedAtMs)) return false;
  if (!Number.isFinite(nowMs)) return false;
  const age = nowMs - capturedAtMs;
  if (age < 0) return false;
  return age > NOTARY_EVIDENCE_MAX_AGE_MS;
}

// ─── Δ/Ρ 判定核：click 语义面（ΠΑΝ-12 起 drag 同核复用） ───

/**
 * 指针动作判定核（click_mouse 的 Δ/Ρ 全量语义；ΠΑΝ-13 起 drag_mouse 同核
 * 复用 —— 仅 expected_text 通道由 drag 臂显式不供给）。行为与 ΠΑΝ-12 之前的
 * click 臂逐字节等价（零回归律：click 调用方的判定/归因/副作用谱不变）。
 * ΠΑΝ-114：kind 入参（validate 侧 hint 的 tool 槽与消费点同方言）+ validate
 * 携 targetHint（与 consume 同标准 —— 见 targetHintOf 头注）。
 */
function judgePointerFace(
  kind: ActionKind,
  a: Record<string, any>,
  c: ActionGateConfig,
  evidence?: NotaryEvidence,
): ActionGateDecision {
  // 通道字段类型收口：args 是模型输出的任意 JSON —— 非字符串真值（如数字）
  // 会在 matchesDangerPatterns（.toLowerCase）/approval.validate（.trim）抛
  // TypeError，炸穿「纯判定」契约（clickMouse 的闸门调用不在 try 内）。
  // 非字符串一律按缺席处理（fail-closed：唯一描述通道非字符串 ⇒ undescribed-click）。
  const target_description: string | undefined =
    typeof a.target_description === 'string' ? a.target_description : undefined;
  const expected_text: string | undefined =
    typeof a.expected_text === 'string' ? a.expected_text : undefined;
  const approval_token: string | undefined =
    typeof a.approval_token === 'string' ? a.approval_token : undefined;

  // ── 纪元 Ρ（双钥公证锁）：证据通道收口与总开关 ──
  // 总开关关 ⇒ evidence 一律无视，返回值与 Ρ 之前逐字节同形（完全旧路径，
  // 连 notarization 键都不入场）。空串证据 = 通道读到空 ⇒ 按缺席（degraded）。
  const ocrLabel: string | null =
    c.enableNotarizationLock && typeof evidence?.ocrLabel === 'string' && evidence.ocrLabel.length > 0
      ? evidence.ocrLabel
      : null;
  const structuralName: string | null =
    c.enableNotarizationLock && typeof evidence?.structuralName === 'string' && evidence.structuralName.length > 0
      ? evidence.structuralName
      : null;
  // 公证参与态：锁开且至少一条新通道在场；否则诚实标注 degraded（判定同旧版）
  const engaged = ocrLabel !== null || structuralName !== null;
  // stamp：undefined（锁关，不添键）| 'degraded'（锁开无通道/握手跳过）| 'engaged'
  let stamp: 'engaged' | 'degraded' | undefined = !c.enableNotarizationLock
    ? undefined
    : engaged ? 'engaged' : 'degraded';
  let note: string | undefined;
  /** 按参与态封存返回值：锁关不加键；有注记才加 notaryNote（键形稳定，deepEqual 可锚） */
  const fin = (base: ActionGateDecision): ActionGateDecision => {
    if (stamp === undefined) return note ? { ...base, notaryNote: note } : base;
    const out: ActionGateDecision = { ...base, notarization: stamp };
    if (note) out.notaryNote = note;
    return out;
  };

  // J-14 跨通道法则 → Ρ 纪元四通道：模型自述双通道 ∪ OCR 实读 ∪ 白盒控件名，
  // 任一命中（normalizeForRisk 同律归一）即触发审批域 —— 绕过须同时沉默四条
  // 独立信号通道，其中两条不归模型管（注入谎报目标的根除点）。
  const descHit = target_description ? matchesDangerPatterns(target_description, c.dangerPatterns) : false;
  const textHit = expected_text ? matchesDangerPatterns(expected_text, c.dangerPatterns) : false;
  const ocrHit = engaged && ocrLabel ? matchesDangerPatterns(ocrLabel, c.dangerPatterns) : false;
  const structHit = engaged && structuralName ? matchesDangerPatterns(structuralName, c.dangerPatterns) : false;
  const dangerous = c.enableApprovalGate && (descHit || textHit || ocrHit || structHit);
  // ΠΑΝ-114：validate 携 targetHint（与 consume 同标准）—— 未绑定令牌零行为，
  // 绑定令牌按摘要比对（匹配放行 / 缺形状与不匹配照旧 fail-closed 拒绝）。
  if (dangerous && !(approval_token && approval.validate(approval_token, targetHintOf(kind, a)))) {
    approval.sweep(); // 顺手清理过期令牌（与旧工具内实现同律）
    // 归因优先级：老通道在前（既有锚点归因零回归），公证通道殿后
    return fin({
      allowed: false,
      reason: approval_token ? 'token-not-granted-or-expired' : 'irreversible-action',
      requiresApproval: true,
      dangerous: true,
      dangerSignalChannel: descHit ? 'target_description'
        : textHit ? 'expected_text'
        : ocrHit ? 'ocr_label'
        : 'structural_name',
    });
  }
  // ── Ρ-2 语义握手：OCR 实读与模型自述的双向宽松印证 ──
  // 前置于 undescribed 前置、后于危险执法（Ρ-1 律：描述无害但屏读「删除」⇒
  // 判危险需令牌，而非 mismatch）。危险通道在场时持有有效令牌也须过握手 ——
  // 令牌授权的是「这个目标」，不是「随便哪个目标」。
  if (engaged && c.notarySemanticHandshake && ocrLabel) {
    const descs = [target_description, expected_text]
      .filter((s): s is string => typeof s === 'string' && s.length > 0);
    if (descs.length > 0) {
      const verdicts = descs.map(d => notaryHandshake(ocrLabel, d));
      if (verdicts.every(v => v.skipped)) {
        // 标签过短/纯标点：跳过握手（防误杀图标按钮），记 degraded 注记
        stamp = 'degraded';
        note = `handshake-skipped:${verdicts[0].skipped}`;
      } else if (!verdicts.some(v => v.ok && !v.skipped)) {
        return fin({
          allowed: false,
          reason: 'notary-mismatch',
          requiresApproval: false, // 重述可解，令牌不可解：谎报/漂移的目标不在授权域内
          dangerous,
          notaryNote: `ocr="${ocrLabel.slice(0, 60)}" vs desc="${descs[0].slice(0, 60)}"`,
        });
      }
    }
  }
  // N 纪元（盲区根除）：闸门开启时描述是硬前置 —— 两条信号通道全沉默的点击
  // 不再放行（审批闸门无法审判一个无名目标；OCR 在场不能替代模型自述）。
  if (c.enableApprovalGate && !target_description && !expected_text) {
    return fin({ allowed: false, reason: 'undescribed-click', requiresApproval: false, dangerous: false });
  }
  return fin({ allowed: true, requiresApproval: dangerous, dangerous });
}

// ─── ΠΑΝ-12：type 语义面（行为与旧 type 臂逐字节等价，仅收编为具名函数） ───

function judgeTypeFace(a: Record<string, any>, c: ActionGateConfig): ActionGateDecision {
  const text: string = typeof a.text === 'string' ? a.text : '';
  if (text.length > c.maxTextLength) {
    return { allowed: false, reason: 'text-too-long', requiresApproval: false, dangerous: false };
  }
  if (c.enableRiskGate && (focusTracker.isSensitive(c.focusMaxAgeMs) || matchesRiskPatterns(text, c.riskPatterns))) {
    return { allowed: false, reason: 'sensitive-input', requiresApproval: false, dangerous: false };
  }
  return { allowed: true, requiresApproval: false, dangerous: false };
}

// ─── ΠΑΝ-12：hotkey 语义面（键盘侧门封堵） ───

/**
 * 热键和弦归一：小写 + 去空白 + 重复键折叠（['alt','alt','f4'] 与 ['alt','f4']
 * 同一和弦 —— 重复修饰键不改变和弦语义，却能躲开黑名单的全等比对）。
 * args 是模型输出的任意 JSON：非数组/非字符串成员一律收口（缺席键不参与）。
 */
function normalizeHotkeyChord(rawKeys: unknown): string[] {
  if (!Array.isArray(rawKeys)) return [];
  return [...new Set(
    rawKeys
      .map(k => String(k ?? '').trim().toLowerCase())
      .filter(Boolean),
  )];
}

/**
 * ΠΑΝ-12：press_hotkey 判定 —— 三层执法（顺序即优先级，全部结构化拒绝）：
 *   ① 黑名单和弦（cfg.hotkeyBlacklist 在场时执法；复用 system.hotkeyPolicy
 *      的 hotkeyBlacklistHit 纯函数 —— 与 system 层同一词表同一比对律）⇒
 *      'blacklisted-hotkey'（requiresApproval:false —— OS 壳层和弦令牌不可解，
 *      system 层 P1-3 本就硬拒，此处是前置的结构化拒绝 + 重放面收口）；
 *   ② 粘贴面：ctrl/cmd+v × 敏感焦点（focusTracker，type 臂同源）⇒
 *      'sensitive-input'（把剪贴板粘进凭据框 = 凭据代输的键盘孪生）；
 *   ③ 危险上下文：context_description（模型声明的「热键作用面」—— 与 click
 *      的 target_description 同律的自述通道）命中危险词 ⇒ 审批域（enter 激活
 *      危险默认钮的主通道；令牌可解，与 click 闸门同律归因）。
 * 黑名单 CSV 缺席 ⇒ ①不执法（事实源仍是 system.pressHotkey —— 无 config 的
 * 调用方完全旧路径，p1-fixes 的 system 层拦截方言逐字节保持）。
 */
// ─── R5-1（恢复键误撞不可逆闸校正）：制造可逆性的和弦不进审批域 ───
//
// 病灶（AGON 批2 T8 双败实证，hist seq279）：`delete` 键的 context_description
// 自述「删除选中内容」命中 dangerPatterns ⇒ reason:'irreversible-action' 拦截；
// `ctrl+z` 的自述含「清空/删除」字样时同样被拦。但这两类动作恰恰是**恢复路径**：
//   · undo/redo 和弦（ctrl/cmd+z、ctrl+shift+z、ctrl/cmd+y）定义上就是最可逆的
//     动作 —— 它们创造可逆性；把恢复键拦死 = fail-closed 系统拆掉自己的出口，
//     无人值守场景下退化为永久 PENDING（R1-6 §1.4 带外码死端）。
//   · 裸编辑删除键（无修饰键的 delete/backspace）作用于文本选区，编辑器撤销栈
//     可完整补偿；资源管理器里裸 delete 进回收站（可恢复）。真不可逆的变体
//     （shift+delete 永久删除）带修饰键，不在豁免面内。
// 执法边界：豁免只作用于 ③ 危险上下文分类 —— ① 系统黑名单（meta/cmd 族逃逸
// 和弦）与 ② 敏感焦点粘贴面**前置且不受影响**；enter/space 激活危险默认钮的主
// 通道（ΠΑΝ-12 ③ 的设计意图）保持原样 —— 豁免面不含任何激活键。
// 判定收口为纯函数 isRecoveryChord（测试面锁定；含 alt 的和弦不豁免 ——
// ctrl+alt+z 等应用层宏语义不可枚举，保守归旧路径）。

/** 修饰键集合（豁免面承认的修饰键；alt 刻意缺席 —— 见上注） */
const RECOVERY_SAFE_MODIFIERS = new Set(['ctrl', 'cmd', 'meta', 'shift']);

/**
 * R5-1：恢复键和弦判定（纯函数）——
 *   undo/redo 族：非修饰键恰一个且 ∈ {z,y}，携带 ctrl/cmd/meta 家族修饰；
 *   裸编辑删除族：和弦恰为单键 delete/backspace（无任何修饰键）。
 */
export function isRecoveryChord(keys: readonly string[]): boolean {
  const ks = (Array.isArray(keys) ? keys : [])
    .map((k) => String(k ?? '').trim().toLowerCase())
    .filter(Boolean);
  if (ks.length === 0) return false;
  const nonMods = ks.filter((k) => !RECOVERY_SAFE_MODIFIERS.has(k));
  if (nonMods.length === 0) return false; // 纯修饰键长按：无恢复语义，不豁免
  const hasCtrlFamily = ks.includes('ctrl') || ks.includes('cmd') || ks.includes('meta');
  const undoRedo = nonMods.length === 1 && (nonMods[0] === 'z' || nonMods[0] === 'y')
    && hasCtrlFamily
    && ks.every((k) => RECOVERY_SAFE_MODIFIERS.has(k) || k === nonMods[0]); // alt 等其余修饰键在场 ⇒ 不豁免
  if (undoRedo) return true; // ctrl(±shift)+z/y、cmd(±shift)+z/y —— undo/redo 家族
  return ks.length === 1 && (ks[0] === 'delete' || ks[0] === 'backspace'); // 裸编辑删除键
}

function judgeHotkeyFace(a: Record<string, any>, c: ActionGateConfig): ActionGateDecision {
  const keys = normalizeHotkeyChord(a.keys);
  const context_description: string | undefined =
    typeof a.context_description === 'string' ? a.context_description : undefined;
  const approval_token: string | undefined =
    typeof a.approval_token === 'string' ? a.approval_token : undefined;

  // ΠΑΝ-12 ①：黑名单和弦（重复键先折叠 —— ['alt','alt','f4'] 与 ['alt','f4'] 同和弦）
  if (typeof c.hotkeyBlacklist === 'string' && c.hotkeyBlacklist.trim().length > 0) {
    if (hotkeyBlacklistHit(keys, c.hotkeyBlacklist) !== null) {
      return { allowed: false, reason: 'blacklisted-hotkey', requiresApproval: false, dangerous: false };
    }
  }
  // ΠΑΝ-12 ②：粘贴面 —— ctrl/cmd+v 落在敏感焦点上（凭据粘贴不代劳）
  const isPasteChord = keys.includes('v') && (keys.includes('ctrl') || keys.includes('meta') || keys.includes('cmd'));
  if (c.enableRiskGate && isPasteChord && focusTracker.isSensitive(c.focusMaxAgeMs)) {
    return { allowed: false, reason: 'sensitive-input', requiresApproval: false, dangerous: false };
  }
  // ΠΑΝ-12 ③：危险上下文（enter 激活危险默认钮 / 任何作用在危险面上的和弦）。
  // R5-1：恢复键和弦（undo/redo / 裸编辑删除键）不进本分类 —— 见 isRecoveryChord
  // 头注；自述里的「删除/清空」字样描述的是**被恢复的对象**，不是被制造的危险。
  const ctxHit = !isRecoveryChord(keys) && context_description
    ? matchesDangerPatterns(context_description, c.dangerPatterns)
    : false;
  const dangerous = c.enableApprovalGate && ctxHit;
  // ΠΑΝ-114：validate 携 targetHint —— 与 pressHotkey 兑换面同标准
  // （{tool:'press_hotkey', target_description: context_description}）。
  const hotkeyHint = targetHintOf('press_hotkey', a, context_description);
  if (dangerous && !(approval_token && approval.validate(approval_token, hotkeyHint))) {
    approval.sweep(); // 顺手清理过期令牌（与 click 闸门同律）
    return {
      allowed: false,
      reason: approval_token ? 'token-not-granted-or-expired' : 'irreversible-action',
      requiresApproval: true,
      dangerous: true,
      dangerSignalChannel: 'context_description',
    };
  }
  return { allowed: true, requiresApproval: dangerous, dangerous };
}

// ─── ΠΑΝ-13：drag 语义面（拖拽侧门封堵 —— 复用 click 判定核） ───

/**
 * ΠΑΝ-13：drag_mouse 判定 —— click 判定核的复用面（四通道 fail-heavy + Ρ 语义
 * 握手 + 公证戳一个不少），仅供给 target_description/approval_token 两通道
 * （drag 的 schema 无 expected_text）。与 click 臂的唯一有意差异：描述是可选
 * 通道 —— 'undescribed-click' 折叠为放行（滑块/窗口拖拽不设硬前置），但：
 *   · 公证通道（OCR 实读/白盒控件名）见危险时，危险执法先于可选通道松弛
 *     （fail-heavy 判定核里 token 分支在前 —— 无描述的拖拽落进 OCR 读出的
 *     「删除区」照样被拦）；
 *   · 公证戳（notarization/notaryNote）在折叠放行时如实保留（诚实标注）。
 */
function judgeDragFace(
  a: Record<string, any>,
  c: ActionGateConfig,
  evidence?: NotaryEvidence,
): ActionGateDecision {
  const d = judgePointerFace(
    'drag_mouse',
    { target_description: a.target_description, approval_token: a.approval_token },
    c,
    evidence,
  );
  if (!d.allowed && d.reason === 'undescribed-click') {
    // 可选通道律：无危险语义的拖拽照常放行（Δ#6 立法保持 —— 不设 click 式硬前置）
    const { reason, ...rest } = d;
    void reason; // 折叠掉拒因（放行回执不携带 reason 键 —— 键形稳定）
    return { ...rest, allowed: true, requiresApproval: false, dangerous: false };
  }
  return d;
}

// ─── ΠΑΝ-12：scroll 语义面 ───

/**
 * ΠΑΝ-12：scroll_page 判定 —— 视口导航无可判定的不可逆语义面（无描述通道、
 * 无凭据面），恒放行。纳入闭集的意义是 ΠΑΝ-14 的完备性执法：scroll 是物理
 * 写通道之一，必须在闸门的 kind 分派表里显式占位 —— 否则未登记 kind 会静默
 * 落进别的臂（ΠΑΝ-12 前的病灶：非 click kind 一律按 type_text 判定）。
 */
function judgeScrollFace(_a: Record<string, any>, _c: ActionGateConfig): ActionGateDecision {
  return { allowed: true, requiresApproval: false, dangerous: false };
}

// ─── ΠΑΝ-14（装配执法）：kind 分派表 —— 映射类型缺键 ⇒ 编译红 ───

/**
 * 每个 ActionKind 必须在此显式占位（`{ [K in ActionKind]: ... }` 映射类型：
 * 联合类型新增成员而分派表未同步 ⇒ TypeScript 缺属性编译错误 —— 新增物理
 * 写通道漏判在编译期即红，不靠运行时侥幸）。运行期按字符串索引取件，
 * 未登记 kind ⇒ 'unknown-action-kind' 结构化 fail-closed 拒绝（绝不抛）。
 */
const ACTION_KIND_HANDLERS: {
  [K in ActionKind]: (
    a: Record<string, any>,
    c: ActionGateConfig,
    evidence?: NotaryEvidence,
  ) => ActionGateDecision;
} = {
  // ΠΑΝ-114：判定核以 kind 为首参（validate hint 的 tool 槽）—— click 直连，
  // drag 经 judgeDragFace 内部同核（描述级 hint）。
  click_mouse: (a, c, e) => judgePointerFace('click_mouse', a, c, e),
  type_text: judgeTypeFace,
  press_hotkey: judgeHotkeyFace,
  drag_mouse: judgeDragFace,
  scroll_page: judgeScrollFace,
};

/**
 * 断言一个动作（live 工具调用或日志/技能重放步）是否被放行。
 * 纯判定 + 与旧工具内实现一致的副作用谱（仅审批域阻断路径 sweep 过期令牌）。
 * 不派发任何物理动作 —— 派发与验收式消费仍是调用方（clickMouse/replayOne）的职责。
 *
 * Ρ 纪元签名兼容扩展：可选 evidence 携带点击落点的独立取证（OCR 实读 +
 * 白盒控件名）。三通道 fail-heavy；缺席 ⇒ 判定与返回字段同旧版（仅加
 * notarization:'degraded'）；enableNotarizationLock=false ⇒ 完全旧路径。
 *
 * ΠΑΝ-12/14：kind 分派经 ACTION_KIND_HANDLERS（编译期闭集 + 运行期
 * fail-closed）；click/type 两臂行为与扩员前逐字节等价（零回归律）。
 */
export function assertActionAllowed(
  kind: ActionKind,
  args: Record<string, any> | undefined,
  cfg?: Partial<ActionGateConfig>,
  evidence?: NotaryEvidence,
): ActionGateDecision {
  const c: ActionGateConfig = { ...DEFAULT_ACTION_GATE_CONFIG, ...cfg };
  const a = args ?? {};
  // ΠΑΝ-14：运行期闭集执法 —— 未登记 kind 一律结构化拒绝（fail-closed），
  // 绝不静默落进其他臂（扩员前的病灶），也绝不抛（运行层宪律）。
  // ΠΑΝ-114：judgePointerFace 签名扩了 kind 首参 —— 分派值的形状改以
  // judgeDragFace（a/c/evidence 三参、无 kind）为参照。
  const handler = (ACTION_KIND_HANDLERS as Record<string, typeof judgeDragFace | undefined>)[
    typeof kind === 'string' ? kind : ''
  ];
  if (typeof handler !== 'function') {
    return { allowed: false, reason: 'unknown-action-kind', requiresApproval: false, dangerous: false };
  }
  return handler(a, c, evidence);
}
