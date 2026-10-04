// src/guards/canaryLogic.ts
// W6-1（doctor 债清偿·smell.over-engineering）：从 canaryGuard.ts 提取的纯逻辑区 ——
// 契约类型 + 幂等词汇表 + 触发分类 + 反事实预测 + 预测-验证比对。逐字节搬运
// （零逻辑/零数值变更）；canaryGuard.ts 保留编排/生产端口/观察面/守卫注册，
// 并原位再导出本模块公共面（导入面不变）。
// W8-B4（tools↔autonomy 破环）：本文件对上游认识论器官（adviseAction /
// costPriorOfCall / scoreOptions 反事实预测）的直接 import 全部改为端口注入 ——
// canaryLogic 是纯逻辑区，不该反向牵动器官包；三张面经 CanaryEpistemicPorts
// 注入（调用方 opts 优先，缺省用 canaryGuard 装配时注册的生产面 —— 同一真身，
// 行为零变化；两端皆缺席 ⇒ 诚实让位 'epistemics-unbound'，绝不臆造裁决）。
import { matchesDangerPatterns } from '../riskGate';
import { approval } from '../approval';

// ─── 契约类型 ───

/** 受金丝雀约束的动作工具（与 actionGate 的 ActionKind 同一集合：直触物理世界且携带可判定语义面） */
export const CANARY_ACTION_TOOLS: ReadonlySet<string> = new Set(['click_mouse', 'type_text']);

/** 探针预算缺省：每会话（≈每任务）最多试演 6 次 —— 增益有度，绝不喧宾夺主 */
export const CANARY_PROBE_BUDGET_DEFAULT = 6;

/** 复位通道地板：探针复原后区域相似度低于此 ⇒ 净变化 ⇒ 分歧（预测是「可复原」） */
export const CANARY_RESTORE_FLOOR_DEFAULT = 0.9;

/** 可逆微探针的种类：点击回点（幂等切换）/ 单字符退格 */
export type CanaryProbeKind = 'click-toggle' | 'type-char';

/** 一次试演的探针计划（由 classifyCanaryTrigger 纯函数产出） */
export interface CanaryProbePlan {
  kind: CanaryProbeKind;
  /** click-toggle 的目标点（归一化）；type-char 为 null（作用于焦点槽） */
  point: { x: number; y: number } | null;
  /** type-char 探针输入的单字符（click-toggle 恒 'x' 占位，不派发） */
  char: string;
}

/** 三帧观察：基线→探针中→复位后的区域指纹比对结果（null = 该通道缺席） */
export interface CanaryObservation {
  /** 响应相似度 sim(h0,h1)：越高 = 探针期间变化越小（1 = 纹丝不动） */
  responseSimilarity: number | null;
  /** 复位相似度 sim(h0,h2)：越高 = 复原越完全（1 = 世界回到原样） */
  restoreSimilarity: number | null;
  /** 物理步执行日志（证据链：每步一行） */
  steps: string[];
  /** 诚实降级注记（如复位派发失败后尽力重试的记录） */
  degradedNotes: string[];
}

/**
 * 金丝雀端口（注入缝）：物理微动作原语 + 帧哈希通道，全部可缺席、全部可替换。
 * 生产实现 productionCanaryPorts 经 physicalBackend（healthSnapshot 在场 +
 * 非 dry-run 才派发 —— 与 interactivityProbe/rootCauseGuard 的零孵化、dry-run
 * 纪律同律）；测试注入假端口即全离线。
 */
export interface CanaryProbePorts {
  /** 单次点击（归一化坐标）；返回 false = 派发失败（世界未被触碰） */
  click?: (point: { x: number; y: number }) => Promise<boolean>;
  /** 输入单字符；返回 false = 派发失败 */
  typeChar?: (ch: string) => Promise<boolean>;
  /** 退格一键；返回 false = 派发失败 */
  backspace?: () => Promise<boolean>;
  /**
   * 区域指纹端口（dhash 字符串）：point 为 null 时取焦点区（焦点缺席则全屏）；
   * 返回 null/空 = 帧通道缺席（本次观察降级，绝不孵化服务来补）
   */
  regionHash?: (point: { x: number; y: number } | null, radius: number) => Promise<string | null>;
}

/** 试演事件的证据环条目（recentCanaryEvents 观察面；审计/诊断/测试） */
export interface CanaryEvent {
  at: number;
  tool: string;
  /** triggered（触发试演）/ passed（金丝雀通过）/ blocked（分歧拦截）/ degraded（降级放行）/ exempt-destructive（destructive 豁免直审批） */
  action: 'triggered' | 'passed' | 'blocked' | 'degraded' | 'exempt-destructive';
  /** 一句中文：为什么进入这个分支 */
  why: string;
  probe?: CanaryProbeKind;
  point?: { x: number; y: number } | null;
  /** 分歧度量（0..1；blocked/degraded 时在场则携带） */
  divergence?: number | null;
  responseSimilarity?: number | null;
  restoreSimilarity?: number | null;
  /** 反事实预测效果清单（触发时随行 —— 比对的另一半） */
  predictedEffects?: string[];
  /** 分歧拦截时铸造的审批令牌（降级问人的锚点；null = 审批通道异常） */
  approvalToken?: string | null;
  /** 认识论裁决摘要（触发时随行） */
  epistemics?: string;
  /** 降级注记（degraded 时随行） */
  degradedNotes?: string[];
}

/** 触发分类的让位原因（skip = 不试演、放行原动作） */
export type CanarySkipWhy =
  | 'not-action-tool'        // 非动作类工具 —— 与金丝雀无关
  | 'approval-present'       // 已持有效已授予审批令牌 —— 人已裁决，让位
  | 'budget-exhausted'       // 探针预算耗尽 —— 增益有度
  | 'low-cost'               // 代价档非 high —— 低危不触发
  | 'not-proceed'            // adviseAction 未判 proceed（问人/问云脑/收手归闸门自己）
  | 'no-reversible-probe'    // 找不到可逆探针（非幂等标签/坐标缺席）—— 诚实跳过
  | 'prediction-unavailable' // 反事实预测缺席 —— 无比对基准
  | 'epistemics-unbound';    // W8-B4：认识论端口未注入（直接单测 canaryLogic 且未绑
                             // 生产面时的诚实让位 —— 生产装配恒绑定，此分支不可达）

// ─── W8-B4（破环）：认识论结构端口（上游器官三张面的结构镜像） ───

/**
 * 认识论裁决报告的结构面（adviseAction 的产出镜像 —— canaryGuard 的 epistemics
 * 摘要与 rehearse 触发依据只消费这四个字段；真身由端口实现方返回）。
 */
export interface CanaryEpistemicReport {
  /** 熵（比特） */
  entropy: number;
  /** 有效置信（校准后） */
  confidence: number;
  /** 行动建议：放行 / 问云脑 / 问人 / 收手 */
  advise: 'proceed' | 'ask_vlm' | 'ask_human' | 'abort';
  /** 中文理由，每条一句（审计轨迹） */
  reasons: string[];
}

/**
 * W8-B4：金丝雀的认识论端口 —— 上游器官三张面经此注入（本文件零器官 import）：
 *   · costPriorOfCall —— 工具调用的错误代价档；
 *   · adviseAction —— 置信×代价×云脑×预算四维裁决；
 *   · predictEffects —— 反事实预测效果清单（scoreOptions 的包装面）。
 * 结构契约：真身函数天然满足（鸭子型）；调用方 opts 注入优先于模块注册位。
 */
export interface CanaryEpistemicPorts {
  costPriorOfCall: (
    kind: 'click' | 'type' | string,
    signals: { declaredTier?: unknown; consequenceDeclared?: unknown },
  ) => 'low' | 'medium' | 'high';
  adviseAction: (opts: {
    confidence: number;
    costOfError: 'low' | 'medium' | 'high';
    vlmAvailable: boolean;
    budgetRemainingPct?: number;
  }) => CanaryEpistemicReport;
  predictEffects: (tool: string, args: Record<string, unknown>) => string[] | null;
}

/**
 * W8-B4：认识论端口注册位（canaryGuard 装配时喂入生产面 —— 同一真身，行为零
 * 变化）。单注册位：后注册者覆盖，null 可注销（测试隔离缝）。
 */
const w8CanaryPorts: { ports: CanaryEpistemicPorts | null } = { ports: null };

/** W8-B4：注册/注销金丝雀认识论端口（生产装配点 canaryGuard 模块装载时调用） */
export function bindCanaryEpistemicPorts(ports: CanaryEpistemicPorts | null): void {
  w8CanaryPorts.ports =
    ports !== null && typeof ports === 'object' &&
    typeof ports.costPriorOfCall === 'function' &&
    typeof ports.adviseAction === 'function' &&
    typeof ports.predictEffects === 'function'
      ? ports
      : null;
}

/** W8-B4：当前注册的认识论端口只读出口（缺省 null —— 审计/测试观察面） */
export function boundCanaryEpistemicPorts(): CanaryEpistemicPorts | null {
  return w8CanaryPorts.ports;
}

/** classifyCanaryTrigger 的产出：让位 / destructive 豁免 / 试演计划 */
export type CanaryTrigger =
  | { kind: 'skip'; why: CanarySkipWhy; note: string }
  | { kind: 'exempt-destructive'; note: string }
  | {
    kind: 'rehearse';
    probe: CanaryProbePlan;
    /** counterfactual.predictedEffects（只读消费） */
    predictedEffects: string[];
    /** adviseAction 完整裁决（触发依据随行，可审计 —— W8-B4 后为结构镜像面） */
    report: CanaryEpistemicReport;
    /** 触发时的自报置信（换算链：args.confidence） */
    confidence: number;
  };

/** 预测-验证比对结果 */
export interface CanaryComparison {
  /** 分歧度量 0..1（响应/复位两通道取最大；无可比通道 ⇒ null —— 诚实弃权） */
  divergence: number | null;
  /** 是否分歧（任一通道越阈；无可比通道 ⇒ null） */
  diverged: boolean | null;
  responseSimilarity: number | null;
  restoreSimilarity: number | null;
  /** 逐通道注记（证据链） */
  notes: string[];
}

/** 探针编排产出：unavailable（未触世界）/ failed（复位派发失败，世界可能被触碰）/ observed（三帧在手） */
export type CanaryProbeOutcome =
  | { status: 'unavailable'; notes: string[] }
  | { status: 'failed'; notes: string[] }
  | { status: 'observed'; observation: CanaryObservation };

// ─── 幂等词汇表（点击类可逆探针的准入判据） ───

/**
 * 幂等切换词汇表（W2-7）：目标标签命中 ⇒ 点击+回点论证为可逆（展开/收起、
 * 菜单开合这类「再点一次就回去」的控件）。命中不了就没有可逆探针可言 ——
 * 「提交/发送」类一次性按钮点击两次比点一次更糟，绝不入选（且那类早已被
 * dangerPatterns 划入 destructive 豁免）。
 */
const TOGGLE_LEXICON =
  /expand|collapse|toggle|dropdown|fold|unfold|chevron|more|less|menu|filter|show|hide|switch|options?|settings?|gear|展开|收起|折叠|切换|菜单|更多|更少|筛选|箭头|选项|设置|齿轮/i;

/** 目标标签是否为幂等切换候选（纯函数：非字符串/空串 ⇒ false —— 无法论证可逆） */
export function isIdempotentToggleLabel(label: unknown): boolean {
  if (typeof label !== 'string') return false;
  const t = label.trim();
  if (t.length === 0 || t.length > 200) return false;
  return TOGGLE_LEXICON.test(t);
}

/**
 * 疑似即时反应词表（ΑΩ-R38）：与 TOGGLE_LEXICON 同构的输入类探针先验闸词表。
 * type-char 探针（单字符输入 + 退格）作用于真实焦点元素 —— 目标字符串证据
 * （target_description ∪ expected_text，与第 3 步危险词判定同一 J-14 双通道）
 * 命中本词表 ⇒ 该输入框疑似带 oninput 校验/自动补全/即时搜索/即时筛选：单字符
 * 就可能触发网络请求等不可逆副作用，退格只能撤字符、撤不回已发出的请求 ⇒
 * 「输入后立即退格 = 状态恒复原」的可逆性论证不成立，探针降级不可论证。
 * 词表词汇来源（不发明新文案）：filter/筛选 借自本文件 TOGGLE_LEXICON（同域
 * 即筛语义）；search 借自 skillLibrary.templates 的 HOLE_TEXT_KEY 词形；
 * 搜索/autosuggest/自动补全/live/即时 为工单 ΑΩ-R38 指定词（探针通道的
 * Z-1 判决是几何/结构证据 —— wordShape 纯几何、interactivityProbe 只有光标
 * 形态与 UIA 控件类型细类，均无文本词表可借，字符串证据即通道已有证据）。
 * 证据缺席 ⇒ false（保守按可论证，保持现状 —— 证据缺席不新增阻断，与旁路义务一致）。
 */
const INSTANT_REACTION_LEXICON =
  /search|搜索|autosuggest|自动补全|live|filter|筛选|即时/i;

/** ΑΩ-R38：目标字符串是否带疑似即时反应信号（纯函数：非字符串/空串/超长 ⇒ false —— 无证据不新增阻断） */
export function isInstantReactionLabel(label: unknown): boolean {
  if (typeof label !== 'string') return false;
  const t = label.trim();
  if (t.length === 0 || t.length > 200) return false;
  return INSTANT_REACTION_LEXICON.test(t);
}

// ─── 纯函数：触发分类 ───

/** 从工具参数提取字符串（类型收口：非字符串真值一律按缺席） */
function strArg(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

/**
 * 触发分类（纯函数，绝不抛异常）：一次工具调用是否需要金丝雀试演。
 *
 * 判序（依序短路）：
 *   1. 非 click_mouse / type_text ⇒ skip not-action-tool；
 *   2. approval_token 在场且已授予有效 ⇒ skip approval-present（人已裁决）；
 *   3. destructive：显式 risk_tier='destructive' 或 target_description /
 *      expected_text 命中 dangerPatterns ⇒ exempt-destructive（不试演，
 *      放行给既有审批闸门直接审批 —— 试演一次性按钮是二次伤害）；
 *   4. 探针预算耗尽 ⇒ skip budget-exhausted；
 *   5. costPriorOfCall 代价档非 high ⇒ skip low-cost（低危不触发）；
 *   6. adviseAction（confidence=args.confidence，缺省 0 —— 无自报置信认识论
 *      不会放行 high 档）未判 proceed ⇒ skip not-proceed；
 *   7. 探针计划：click 须有合法归一化坐标 + 幂等切换标签；type 恒有
 *      （单字符退格），但目标字符串证据命中疑似即时反应词表 ⇒ 降级不可论证
 *      （ΑΩ-R38 副作用先验闸，与 click 的幂等词表闸同构）。不可满足 ⇒ skip
 *      no-reversible-probe；
 *   8. predictedEffects 缺席 ⇒ skip prediction-unavailable（无比对基准）。
 * W8-B4：第 5/6/8 步的认识论面经端口注入（opts.epistemics 优先，缺省用装配
 * 注册位）；端口缺席 ⇒ 第 5 步前即诚实让位 'epistemics-unbound'（生产装配
 * 恒绑定 —— 该分支仅为防御缺口的显式化，绝不臆造裁决）。
 */
export function classifyCanaryTrigger(
  tool: string,
  args: Record<string, any>,
  opts: {
    dangerPatterns?: string;
    probeBudgetUsed?: number;
    probeBudgetCap?: number;
    /** W8-B4：认识论端口（调用方注入优先；缺省用 bindCanaryEpistemicPorts 注册位） */
    epistemics?: CanaryEpistemicPorts;
  } = {},
): CanaryTrigger {
  const a = args !== null && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  // W8-B4：端口解析（opts 注入 > 模块注册位；结构残缺一律按缺席 —— 防御式）
  const epistemicsRaw = opts.epistemics ?? w8CanaryPorts.ports;
  const epistemics =
    epistemicsRaw !== null && epistemicsRaw !== undefined && typeof epistemicsRaw === 'object' &&
    typeof epistemicsRaw.costPriorOfCall === 'function' &&
    typeof epistemicsRaw.adviseAction === 'function' &&
    typeof epistemicsRaw.predictEffects === 'function'
      ? epistemicsRaw
      : null;
  if (!CANARY_ACTION_TOOLS.has(tool)) {
    return { kind: 'skip', why: 'not-action-tool', note: '非动作类工具，与金丝雀无关' };
  }
  // 2. 人已裁决：已授予的有效令牌 ⇒ 让位（金丝雀不重复打扰）
  const token = strArg(a.approval_token);
  if (token) {
    try {
      if (approval.validate(token)) {
        return { kind: 'skip', why: 'approval-present', note: '已持有效已授予审批令牌，人已裁决' };
      }
    } catch {
      /* 审批簿读失败按无令牌继续 —— 绝不因旁路异常拦截主路径 */
    }
  }
  // 3. destructive 豁免：显式分层或危险词命中（J-14 双通道同律：description ∪ expected_text）
  const desc = strArg(a.target_description);
  const expectedText = strArg(a.expected_text);
  const dangerHit =
    (desc !== undefined && matchesDangerPatterns(desc, opts.dangerPatterns ?? '')) ||
    (expectedText !== undefined && matchesDangerPatterns(expectedText, opts.dangerPatterns ?? ''));
  if (a.risk_tier === 'destructive' || dangerHit) {
    return {
      kind: 'exempt-destructive',
      note: 'destructive 档豁免试演：直接放行给既有审批闸门（那类动作本就该直接审批）',
    };
  }
  // 4. 预算封顶
  const cap = typeof opts.probeBudgetCap === 'number' && Number.isFinite(opts.probeBudgetCap)
    ? Math.max(0, Math.floor(opts.probeBudgetCap))
    : CANARY_PROBE_BUDGET_DEFAULT;
  const used = typeof opts.probeBudgetUsed === 'number' && Number.isFinite(opts.probeBudgetUsed)
    ? Math.max(0, opts.probeBudgetUsed)
    : 0;
  if (used >= cap) {
    return { kind: 'skip', why: 'budget-exhausted', note: `探针预算耗尽（${used}/${cap}），让位放行` };
  }
  // 5. 代价档：非 high 不触发（低危放行是认识论的裁定，金丝雀不加戏）
  //    W8-B4：端口缺席 ⇒ 诚实让位（生产装配恒绑定，此分支不可达 —— 防御缺口的显式化）
  if (epistemics === null) {
    return {
      kind: 'skip',
      why: 'epistemics-unbound',
      note: '认识论端口未注入（opts.epistemics 与注册位双缺席），金丝雀不臆造裁决，诚实让位',
    };
  }
  const consequenceDeclared =
    strArg(a.expected_change) !== undefined || strArg(a.expected_text) !== undefined;
  let cost: 'low' | 'medium' | 'high';
  try {
    cost = epistemics.costPriorOfCall(tool === 'click_mouse' ? 'click' : 'type', {
      declaredTier: a.risk_tier,
      consequenceDeclared,
    });
  } catch {
    cost = 'low'; // 端口故障按低危让位 —— 绝不因旁路器官异常拦截主路径
  }
  if (cost !== 'high') {
    return { kind: 'skip', why: 'low-cost', note: `错误代价 ${cost} 非 high，低危不试演` };
  }
  // 6. 认识论裁决：proceed × high 才是金丝雀的领地（出厂阈值下数学不可达 ⇒ 零回归）
  const rawConf = typeof a.confidence === 'number' && Number.isFinite(a.confidence)
    ? Math.min(1, Math.max(0, a.confidence))
    : 0;
  let report: CanaryEpistemicReport;
  try {
    report = epistemics.adviseAction({
      confidence: rawConf,
      costOfError: cost,
      vlmAvailable: false,
      budgetRemainingPct: 100,
    });
  } catch {
    return { kind: 'skip', why: 'not-proceed', note: '认识论裁决器官异常，诚实让位不试演' };
  }
  if (report.advise !== 'proceed') {
    return { kind: 'skip', why: 'not-proceed', note: `认识论裁决 ${report.advise}，非 proceed 不试演` };
  }
  // 7. 可逆探针计划
  let probe: CanaryProbePlan;
  if (tool === 'click_mouse') {
    const x = a.x;
    const y = a.y;
    const pointOk = typeof x === 'number' && typeof y === 'number' &&
      Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x <= 1 && y >= 0 && y <= 1;
    if (!pointOk || !isIdempotentToggleLabel(desc)) {
      return {
        kind: 'skip',
        why: 'no-reversible-probe',
        note: '点击目标无幂等切换标签（或坐标缺席），论证不出可逆探针，诚实跳过',
      };
    }
    probe = { kind: 'click-toggle', point: { x: x as number, y: y as number }, char: 'x' };
  } else {
    // ΑΩ-R38（副作用先验闸）：type-char 探针作用于真实焦点元素 —— 对带 oninput
    // 校验/自动补全/即时搜索的控件，输入单字符就可能触发网络请求等不可逆副作用，
    // 退格撤不回。目标字符串证据（desc ∪ expected_text —— 与第 3 步危险词判定
    // 同一 J-14 双通道，探针通道已有证据，不新增感知面）命中疑似即时反应词表
    // ⇒ 「输入后立即退格 = 状态恒复原」的论证不成立，降级为不可论证（skip
    // no-reversible-probe —— 跳过试演、旁路记账，canaryGuard 侧零改动）。
    // 与 click 类的 TOGGLE_LEXICON 闸同构；证据缺席 ⇒ 保守按可论证（现状不变，
    // 出厂阈下本步本就先被第 6 步 not-proceed 短路 —— 全链零回归保持）。
    if (isInstantReactionLabel(desc) || isInstantReactionLabel(expectedText)) {
      return {
        kind: 'skip',
        why: 'no-reversible-probe',
        note: '输入目标带疑似即时反应信号（search/自动补全/即时筛选类）—— 单字符探针可能触发不可逆 oninput 副作用，论证不出可逆探针，诚实跳过（ΑΩ-R38）',
      };
    }
    probe = { kind: 'type-char', point: null, char: 'x' };
  }
  // 8. 反事实预测（只读消费经端口注入的预测面 —— W8-B4 破环后真身在 canaryGuard 侧
  //    包装上游 scoreOptions；缺席 ⇒ 无比对基准）
  let predictedEffects: string[] | null;
  try {
    predictedEffects = epistemics.predictEffects(tool, a);
  } catch {
    predictedEffects = null; // 预测面故障吞掉 —— 按无比对基准诚实跳过
  }
  if (predictedEffects === null) {
    return { kind: 'skip', why: 'prediction-unavailable', note: '反事实预测缺席，无比对基准' };
  }
  return {
    kind: 'rehearse',
    probe,
    predictedEffects,
    report,
    confidence: rawConf,
  };
}

// ─── 纯函数：反事实预测（W8-B4 破环搬运说明） ───
// 原搬运自 canaryGuard 的 syntheticActionFor / predictedEffectsOf / ZERO_SNAPSHOT
// 三件套（上游 scoreOptions 的包装面）已随端口注入回迁 canaryGuard —— 本文件
// 对上游器官零 import（见文件头 W8-B4 注）；调用链：
// classifyCanaryTrigger --(端口)--> canaryGuard.predictEffects --> scoreOptions。

// ─── 纯函数：预测-验证比对 ───

/** 数值防御：夹 [0,1]，非有限数按 null（通道缺席，不伪造观察） */
function clamp01OrNull(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.min(1, Math.max(0, v));
}

/**
 * 预测-验证比对（纯函数，绝不抛异常）。
 *
 * 预测主张映射（诚实声明的观察语义边界）：click/type 的 predictedEffects
 * （「激活元素…」/「向焦点元素输入文本」）在视觉域的共同可观察投影是
 * 「目标邻域对交互产生视觉响应」—— 本比对只核对这一主命题；「揭示新界面」
 * 「弹窗消失」等次级预言不在区域指纹的裁判域内（证据链如实记录预测原文）。
 *
 *   响应通道：expectsResponse 且 responseSimilarity 在场时，
 *     分歧度量 = responseSimilarity（无响应=1 全矛盾；剧变=0 无矛盾），
 *     越阈判据 = responseSimilarity ≥ responseCeiling（缺省 noopSimilarityThreshold
 *     0.97 —— 只有近-total 无响应才算分歧，轻微重绘绝不误拦）；
 *   复位通道：restoreSimilarity 在场时，分歧度量 = 1 − restoreSimilarity，
 *     越阈判据 = restoreSimilarity < restoreFloor（探针没能把世界复原 ——
 *     「这是幂等切换」的预测被世界否决）。
 *   divergence = 两通道最大者；两通道皆缺席 ⇒ divergence/diverged 双 null
 *   （诚实弃权，调用方降级放行）。
 */
export function compareCanaryObservation(
  predictedEffects: string[],
  obs: CanaryObservation | null | undefined,
  thresholds: { responseCeiling?: number; restoreFloor?: number } = {},
): CanaryComparison {
  const notes: string[] = [];
  const responseSim = clamp01OrNull(obs?.responseSimilarity);
  const restoreSim = clamp01OrNull(obs?.restoreSimilarity);
  const ceiling = clamp01OrNull(thresholds.responseCeiling) ?? 0.97;
  const floor = clamp01OrNull(thresholds.restoreFloor) ?? CANARY_RESTORE_FLOOR_DEFAULT;

  const expectsResponse = Array.isArray(predictedEffects) &&
    predictedEffects.some(e => typeof e === 'string' && e.trim() !== '');
  if (!expectsResponse) notes.push('预测主张不含可观察响应，弃权');

  const responseDivergence = expectsResponse && responseSim !== null ? responseSim : null;
  const responseDiverged = responseDivergence !== null && responseDivergence >= ceiling;
  const restoreDivergence = restoreSim !== null ? 1 - restoreSim : null;
  const restoreDiverged = restoreSim !== null && restoreSim < floor;

  if (responseDivergence !== null) {
    notes.push(`响应通道：相似度 ${responseSim!.toFixed(3)}（阈 ${ceiling}）${responseDiverged ? '⇒ 无响应分歧' : '⇒ 响应符合预测'}`);
  }
  if (restoreDivergence !== null) {
    notes.push(`复位通道：相似度 ${restoreSim!.toFixed(3)}（地板 ${floor}）${restoreDiverged ? '⇒ 未复原分歧' : '⇒ 复原完好'}`);
  }

  const parts = [responseDivergence, restoreDivergence].filter((v): v is number => v !== null);
  return {
    divergence: parts.length > 0 ? Math.max(...parts) : null,
    diverged: parts.length > 0 ? responseDiverged || restoreDiverged : null,
    responseSimilarity: responseSim,
    restoreSimilarity: restoreSim,
    notes,
  };
}
