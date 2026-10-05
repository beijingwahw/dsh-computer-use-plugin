// src/riskGate.ts
// 第五轮创新之二：风险感知人机协同（Risk Gate）。
// E-6 混淆免疫（第五维·信息热力学）：归一化匹配对抗视觉混淆（p@ssw0rd/密 码/PIN 码）。
// 世界级 CUA 的安全共识：凭据类输入不该由 Agent 代劳 —— Operator 遇到密码框
// 会交还控制权。本模块用两段式实现：
//   1. click_mouse 时识别敏感目标（target_description 命中风险词）⇒ 标记焦点为敏感
//   2. type_text 到敏感焦点 ⇒ 拦截，要求暂停并请用户亲自输入（绝不回显内容）
// 风险词可配置（逗号分隔），默认覆盖中英常见凭据语义。
import { CONFUSABLES_ASCII } from './riskGate.confusables.generated';

export const DEFAULT_RISK_PATTERNS = 'password,passwd,密码,口令,验证码,verification code,2fa,otp,pin,secret,token,api key,私钥';

// 第六轮：不可逆操作模式 —— 命中即需一次性审批令牌（用户显式授权后方可执行）
export const DEFAULT_DANGER_PATTERNS =
  'send,发送,delete,删除,remove,移除,pay,支付,付款,buy,购买,checkout,结算,下单,submit order,提交订单,' +
  'confirm,确认订单,format,格式化,erase,抹掉,uninstall,卸载,reset,重置,清空,withdraw,提现,transfer,转账';

/** 解析逗号分隔的风险词配置（空串回退 fallback） */
export function parseRiskPatterns(csv: string, fallback: string = DEFAULT_RISK_PATTERNS): string[] {
  return (csv || fallback)
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
}

// ─── E-6 混淆免疫（第五维·信息热力学）：归一化对抗视觉混淆 ───

/** leet 还原表：人类可读、机器漏检的视觉同形混淆（0↔o、1↔l、@↔a…）。
 *  算法形状字面量 —— 覆盖常见凭据字段混淆；完整 homoglyph 表（西里尔 а 等）
 *  是留白（NFKC 归一化 + Unicode 同形映射，需真实语料定标）。 */
const LEET_MAP: Record<string, string> = {
  '0': 'o', '1': 'l', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's',
};

// ΠΑΝ-9（H-1 归一化补全·防御纵深）：不可见字符剥除集扩展 + NFKC 前置。
// 旧剥除集 [\s\u200b\u200c\u200d\p{P}\p{S}] 只覆盖空白/零宽三兄弟/标点/符号 ——
// 软连字符 U+00AD、词连接符 U+2060 与函数应用族 U+2061-2064（皆 Cf 类）、组合
// 附加记号（Mn，如 U+0301）、变体选择符 U+FE0E/F 与 VS17-256（U+E0100-E01EF，
// 亦 Mn）全部穿透 ⇒ 'pass­word'（软连字符）折叠后仍带不可见字符，词表
// password 不命中 —— 风险词与不可逆操作词两道闸同时绕过（对抗性页面把敏感
// 字段命名成不可见字符变体，OCR/模型转述携带该字符即漏拦，凭据被代输）。
// 修法两条腿（缺一不可 —— NFKC 实测不消除 Cf/Mn：'\u00AD'.normalize('NFKC')
// 原样返回；剥除集也管不到兼容分解形）：
//   1) 剥除集扩为 Cf 全类 + Mn 全类 + FE0F/E0100-E01EF 显式点名（后两者本属
//      Mn —— 显式列出防 Unicode 类目演进漂移；既有 \s/零宽/标点/符号类全保留）；
//   2) 归一化链前置单码点 NFKC（见 normalizeOnceMapped 发射门）—— 兼容分解形
//      （全角/带圈/数学字母/罗马数字/连字）不再单靠策表折叠。
// 语义方向：剥除使不可见字符两侧**拼接** —— 'pass­word'→'password' 必须命中
// 词表（这正是目的：剥除只许产生新的命中，不许产生新的逃逸）；方向与模块
// 「宁误拦不漏拦」一致。绝不抛：正则/normalize 均为全函数。
/** ΠΑΝ-9 不可见字符判据（Cf 全类 + Mn 全类 + 变体选择符点名）。
 *  双重用途：① 剥除集成员判据（见 RISK_STRIP_RE）；② 生成同形字表里以不可见
 *  字符为**键**的条目的运行时过滤（见 buildHomoglyphMap）—— 折叠顺序是
 *  LEET/HOMOGLYPH 先于剥除，不可见键会从隐形字符注入可见字母（打断邻接 ⇒
 *  漏报），与剥除语义冲突。注意判据刻意不含 \s/\p{P}/\p{S}：'|'→'l'、'×'→'x'
 *  这类可见符号键的折叠是既有执法面（先折叠后剥除），必须保留。 */
const INVISIBLE_CHAR_RE = /[\p{Cf}\p{Mn}\uFE0F\u{E0100}-\u{E01EF}]/u;
/** 归一化剥除集：既有类（空白/零宽/标点/符号）+ ΠΑΝ-9 不可见类（Cf/Mn/变体选择符） */
const RISK_STRIP_RE = /[\s\u200b\u200c\u200d\p{P}\p{S}\p{Cf}\p{Mn}\uFE0F\u{E0100}-\u{E01EF}]/u;

/**
 * 归一化：小写 + 单码点 NFKC 前置 + leet 还原 + 同形字折叠 + 剥空白/零宽/不可见
 * 字符（Cf/Mn/变体选择符）/标点/符号。
 * 「p@ssw0rd」→「password」、「密 码」→「密码」、「verificati0n c0de」→
 * 「verificationcode」、「pass­word」（软连字符）→「password」—— 四类视觉
 * 混淆在归一化域内全部还原为可匹配形态（第四类是 ΠΑΝ-9：不可见字符注入）。
 * 语义方向：匹配面扩大只增召回（宁误拦不漏拦 —— 风险闸门的使命是保守，
 *  拦截的代价有界：模型多看一眼截图；漏拦的代价是凭据被代输）。
 * 词表与待检文本同律归一（双向一致 —— 词表「api key」与文本「A P I k e y」对齐）。
 */
// K 纪元（留白兑现之六）：同形字（homoglyph）归一 —— E-6 留白的兑现。
// 策领图（Unicode confusables 的策展子集，覆盖攻击面最广的三族）：
//   西里尔/希腊视觉同形 → 拉丁；全角字母数字 → 半角。完整 consortium 表
//   数千条 —— 策展 ~50 条是"值即边界"（新增条目零风险，纯数据扩展）。
/**
 * L 纪元扩表（值即边界 → 算术全表）：数学字母五套（U+1D400 系）、带圈
 * Ⓐ-ⓩ/ⓐ-ⓩ、上标/下标字母 —— 码点偏移算术批量生成（推导即数据，零数据文件）。
 * 策展跨脚本核心（西里尔/希腊/亚美尼亚/科普特）保留手工映射 —— 覆盖 =
 * 算术族全覆盖 + 混杂族策展；扩展是加一行，不是加一张表。
 */
/**
 * O 纪元（#10 全表）：Unicode confusables.txt（UTS #39）全表蒸馏接入 ——
 * 1665 条原型纯 ASCII 条目（数据血缘与再生命令见 generated 文件头）打底；
 * 策展/算术族覆写在后：既有行为零回归，全表只填空白。ASCII→ASCII 折叠
 * （如 m→rn、0→o）无害且正确 —— haystack 与 pattern 双方过同一归一化，
 * 对称一致（UTS#39 的混淆语义：rn 与 m 视觉互混，双向都该命中）。
 */
function buildHomoglyphMap(): Record<string, string> {
  const m: Record<string, string> = {
    ...CONFUSABLES_ASCII,
    // ── 策展跨脚本核心（覆写位：与生成表冲突时以策展为准）──
    'а': 'a', 'е': 'e', 'о': 'o', 'с': 'c', 'р': 'p',
    'х': 'x', 'у': 'y', 'і': 'i', 'ѕ': 's', 'һ': 'h',
    'ԁ': 'd', 'җ': 'g', 'ӏ': 'l', 'ӣ': 'm', 'й': 'u',
    'ј': 'j', 'ѣ': 'y', 'ԛ': 'q',
    'α': 'a', 'ο': 'o', 'ρ': 'p', 'ε': 'e', 'ι': 'i',
    'κ': 'k', 'μ': 'm', 'ν': 'v', 'τ': 't', 'χ': 'x',
    'ա': 'a', 'ս': 's', 'օ': 'o', 'չ': 'p', 'թ': 't',
    'ⱥ': 'a', 'ⱦ': 'e', 'ꭱ': 'e',
  };
  for (let i = 0; i < 26; i++) {
    m[String.fromCharCode(0xff21 + i)] = String.fromCharCode(97 + i); // 全角 Ａ-Ｚ
    m[String.fromCharCode(0xff41 + i)] = String.fromCharCode(97 + i); // 全角 ａ-ｚ
    m[String.fromCodePoint(0x1d400 + i)] = String.fromCharCode(97 + i);      // 数学粗体
    m[String.fromCodePoint(0x1d434 + i)] = String.fromCharCode(97 + i);     // 数学斜体
    m[String.fromCodePoint(0x1d468 + i)] = String.fromCharCode(97 + i);     // 数学粗斜体
    m[String.fromCodePoint(0x1d4d0 + i)] = String.fromCharCode(97 + i);     // 数学粗花体
    m[String.fromCharCode(0x24b6 + i)] = String.fromCharCode(97 + i);       // 带圈大写
    m[String.fromCharCode(0x24d0 + i)] = String.fromCharCode(97 + i);       // 带圈小写
  }
  for (let i = 0; i < 10; i++) m[String.fromCharCode(0xff10 + i)] = String(i); // 全角数字
  // ΠΑΝ-9: 同形表不得含**不可见字符键** —— 折叠链是 LEET/HOMOGLYPH 先于剥除，
  // 若 Cf/Mn 键存在会从不可见字符注入可见字母（'pass\u0301word' 若 U+0301 折叠
  // 成某字母则 password 邻接断裂 ⇒ 漏报；反向则是无中生有的假字母）。当前
  // 生成表实测 0 条此类键（scripts/gen_confusables.mjs 的 ΠΑΝ-11 蒸馏同律排除）；
  // 运行时过滤是 belt-and-braces：陈旧生成文件也不带入坏键，与再生路径双保险。
  for (const k of Object.keys(m)) {
    if (INVISIBLE_CHAR_RE.test(k)) delete m[k];
  }
  return m;
}
const HOMOGLYPH_MAP: Record<string, string> = buildHomoglyphMap();

// Δ 纪元（安全外围#1）：单遍替换的折叠不对称 —— 全角 ｍ 单遍归一为 'm' 后不再
// 折叠为 'rn'，而 ASCII 词表 'submit' 单遍即成 'subrnit'（CONFUSABLES_ASCII 的
// m→rn 折叠）⇒ haystack 与 pattern 停在不同的中间形态（实测 ｓｕｂｍｉｔ 逃逸）。
// 修法：迭代归一至不动点（haystack 与词表两侧同律）。上限 3 遍 —— 恶意构造的
// 长折叠链（m→rn→…）不能把归一化变成放大器；真实混淆链（全角→ASCII→折叠）
// 两遍内收敛，3 遍是安全裕度。
const NORMALIZE_MAX_PASSES = 3;

// ΝΩ-23（词法匹配升级·半一）：归一化带位置映射。归一化剥掉空格/标点后词边界
// 信息随之蒸发（「enter pin」→「enterpin」、「pin-code」→「pincode」），而拉丁
// 短词的硬边界判定（见 compiledPatternSet）必须回到原文看相邻字符。本层在产出
// 归一化串的同时为每个输出码点记账「其在原串的 UTF-16 起始索引」，跨不动点
// 迭代逐遍组合（一对多折叠如 m→rn 的多个输出码点共享同一来源）。
// 等价律：本层产出的 text 与旧 normalizeOnce 逐字节一致 —— 仍整串 toLowerCase
// （整串小写带语境规则：Final_Sigma 词尾 Σ→ς、İ 展开两码点 —— 逐码点小写会
// 破坏前者，零回归不容），随后按码点对齐账把折叠/剥除作用在小写串上，与旧
// 循环同一谓词、同一次序。
interface MappedNormalization {
  /** 归一化串（= normalizeForRisk 输出） */
  readonly text: string;
  /** text 第 k 个码点 ← 原串 UTF-16 起始索引（长度 = text 的码点数） */
  readonly map: ReadonlyArray<number>;
}

function normalizeOnceMapped(s: string, prev: ReadonlyArray<number> | null): MappedNormalization {
  const lo = s.toLowerCase(); // 与旧实现完全一致的整串小写（Final_Sigma 等语境规则保持）
  const loCps = [...lo];
  // 对齐账：lo 的每个码点 ← s 的码点（经 prev 组合到原串坐标）。
  // 一对多小写（İ→i+U+0307）按展开量对齐；语境分歧（Final_Sigma：词尾整串折叠
  // 为 ς 而单码点折叠为 σ）按单码点消耗 —— 已知的语境分歧均为单码点。
  const originOf: number[] = new Array<number>(loCps.length);
  let j = 0;
  let cp = 0;
  let u16 = 0; // s 的 UTF-16 游标（星面码点占 2 单位 —— 原串坐标必须按码元计）
  for (const ch of s) {
    const origin = prev !== null ? prev[cp] : u16;
    const exp = [...ch.toLowerCase()];
    let matched = j + exp.length <= loCps.length;
    if (matched) {
      for (let e = 0; e < exp.length; e++) {
        if (loCps[j + e] !== exp[e]) { matched = false; break; }
      }
    }
    if (matched) {
      for (let e = 0; e < exp.length; e++) originOf[j + e] = origin;
      j += exp.length;
    } else {
      originOf[j] = origin; // 语境变体：单码点消耗
      j += 1;
    }
    cp++;
    u16 += ch.length;
  }
  let out = '';
  const map: number[] = [];
  let lastOrigin = 0; // 未对齐残留（理论不可达）沿袭前一来源 —— 文本面不受影响
  const lim = Math.min(j, loCps.length);
  for (let k = 0; k < lim; k++) {
    const ch = loCps[k];
    const origin = originOf[k] !== undefined ? originOf[k] : lastOrigin;
    lastOrigin = origin;
    // ΠΑΝ-9: 单码点 NFKC 前置展开（兼容分解：ﬁ→fi、①→1、㏒→log、ｍ→m…）。
    // 展开产物逐码点过同一 LEET/同形/剥除链，来源索引共享（一对多展开同源 ——
    // 与 LEET/HOMOGLYPH 的既有记账律一致）。跨码点组合（a+◌́→预组合 á）不经
    // 此路：分解形中的组合记号由扩展剥除集（Mn）兜住 ⇒ 'pa\u0301ssword' 与
    // 'password' 在折叠域收敛为同一形态（剥除后拼接只产生新命中，不产生新逃逸）。
    for (const dst of ch.normalize('NFKC')) {
      if (LEET_MAP[dst] !== undefined) {
        for (const c of LEET_MAP[dst]) { out += c; map.push(origin); }
        continue;
      }
      if (HOMOGLYPH_MAP[dst] !== undefined) {
        for (const c of HOMOGLYPH_MAP[dst]) { out += c; map.push(origin); }
        continue;
      }
      if (RISK_STRIP_RE.test(dst)) continue; // ΠΑΝ-9: 空白/零宽/标点/符号/不可见（Cf/Mn/VS）全剥
      out += dst;
      map.push(origin);
    }
  }
  return { text: out, map };
}

function normalizeMapped(s: string): MappedNormalization {
  let text = s;
  let map: ReadonlyArray<number> | null = null;
  for (let i = 0; i < NORMALIZE_MAX_PASSES; i++) {
    const next = normalizeOnceMapped(text, map);
    if (next.text === text) return next; // 不动点：再归一不变 ⇒ 已是最终形态
    text = next.text;
    map = next.map;
  }
  return { text, map: map ?? [] }; // 越过迭代上限：按已收敛部分匹配（有界保守，不为恶意长链无限付费）
}

/** 风险域归一化（导出供同律消费者对齐；匹配语义只经 matches* 两函数） */
export function normalizeForRisk(s: string): string {
  return normalizeMapped(s).text;
}

// Δ 纪元（安全外围#2）：模式归一化记忆化 —— matches* 每次调用都重切 CSV 并逐
// pattern 归一化，而 csv 是每回合稳定的配置串。按「生效 csv 字符串」缓存编译
// 产物（上限 32 条，满时逐出最旧 —— Map 保序，首键即 LRU 牺牲者；词表配置的
// 组合空间天然远小于 32）。ΝΩ-23 起缓存条目升级为编译集（词表 + 边界元数据 +
// Aho-Corasick 自动机）：词表变更 = 新键 ⇒ 自动机重建，缓存键即热重建律。
const PATTERN_CACHE_LIMIT = 32;
const patternCache = new Map<string, CompiledPatternSet>();

/** 编译词表（记忆化；键 = 生效 csv，即 csv || fallback）—— 归一化词表 +
 *  边界元数据 + 自动机三位一体，一次编译多回合复用 */
function compiledPatternSet(csv: string, fallback: string): CompiledPatternSet {
  const key = csv || fallback;
  const hit = patternCache.get(key);
  if (hit) return hit;
  const words: string[] = [];
  const hardBoundary: boolean[] = [];
  const wordCpLen: number[] = [];
  for (const entry of key.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)) {
    const folded = normalizeForRisk(entry); // 与 haystack 同律（含不动点迭代 —— 两侧停在同一形态）
    // 归一化后为空的模式（纯标点/符号词，如 "***"）必须剔除：'' 是一切串的
    // 子串，留下它会令 matches* 对任意文本恒真 —— 风险门整体失效（全拦 = 失能）
    if (folded.length === 0) continue;
    words.push(folded);
    // 边界律按词条原形（trim+小写、未折叠）判定：纯拉丁字母单字且长度 ≤7 ⇒
    // 硬边界。长度上限取 7（而非惯例的 6）是为收编 confirm（7 —— confirmation
    // 误报源）；password(8)/checkout(8)/verificationcode(17) 等长词、含数字者
    // （2fa）与含空格的复合词（api key —— 折叠域已是粘合词）免边界，中文词
    // 无词边界概念 —— 三者维持逐字节现状，收窄面只有拉丁短词的粘词误报。
    hardBoundary.push(HARD_BOUNDARY_WORD.test(entry) && entry.length <= HARD_BOUNDARY_MAX_LEN);
    wordCpLen.push([...folded].length);
  }
  const set: CompiledPatternSet = { words, hardBoundary, wordCpLen, automaton: buildAhoCorasick(words) };
  if (patternCache.size >= PATTERN_CACHE_LIMIT) {
    const oldest = patternCache.keys().next().value;
    if (oldest !== undefined) patternCache.delete(oldest);
  }
  patternCache.set(key, set);
  return set;
}

/** 记忆化探针（测试/可观测性用：断言缓存命中、无需重复归一化） */
export function riskPatternCacheSize(): number {
  return patternCache.size;
}

// ─── ΝΩ-23（词法匹配升级·半二）：Aho-Corasick 自动机 + 词边界感知 ───
//
// 背景（系统性误报）：归一化剥标点后纯 includes 的匹配面把 typing 当 pin、
// secretary 当 secret、confirmation 当 confirm、preset 当 reset —— 英文 UI 上
// 敏感焦点误标 ⇒ type_text 被人机闸门误拦，用户感知「频繁要确认」。
// 修法（前沿：多模式匹配自动机 + 边界元数据）：
//   · 手写 Aho-Corasick（goto/fail/output 三表）：构建 O(总词长)、匹配
//     O(文本长) —— 旧实现每回合 30+ 词 × O(n) 逐词 includes 降为单趟扫描；
//   · 拉丁短词硬边界：命中区段经位置映射回到原文，前后相邻字符均非
//     [A-Za-z0-9] 才算命中 —— 「pin-code」「enter pin」命中（连字符/空格/
//     行首尾是边界），「pincode」「typing」不命中（粘连字母不是边界）；
//   · 非拉丁/长词/含数字词条免边界（中文词表行为逐字节不变），方向单侧：
//     只删粘词误报、绝不新增命中（收窄 = 宁误拦语义下唯一可接受的方向）。

/** 硬边界词条的形状（纯 [a-z] 单字）与长度上限（confirm=7 —— 见 compiledPatternSet 注） */
const HARD_BOUNDARY_WORD = /^[a-z]+$/;
const HARD_BOUNDARY_MAX_LEN = 7;

/** 编译产物：折叠域词表 + 逐词边界元数据 + 自动机（不可变，随缓存共享） */
interface CompiledPatternSet {
  readonly words: ReadonlyArray<string>;
  /** 与 words 同下标对齐：该词是否要求硬边界 */
  readonly hardBoundary: ReadonlyArray<boolean>;
  /** 与 words 同下标对齐：词长的码点数（扫描坐标是码点序 —— 星面字符占 2 码元， length 会误标） */
  readonly wordCpLen: ReadonlyArray<number>;
  readonly automaton: AhoAutomaton;
}

/** Aho-Corasick 自动机（goto/fail/output 三表；节点 0 = 根；转移键 = 码点字符串） */
interface AhoAutomaton {
  readonly goto: ReadonlyArray<ReadonlyMap<string, number>>;
  readonly fail: ReadonlyArray<number>;
  /** 各节点处终止的词索引（构建期已并入 fail 链继承 —— 匹配期零回溯） */
  readonly out: ReadonlyArray<readonly number[]>;
}

/** 手写 Aho-Corasick 构建：trie 插入 → BFS 失配链 → 输出表沿 BFS 序继承
 *  （fail 指向更浅节点 ⇒ BFS 序保证先于本节点并入）。纯数据操作，不抛。 */
function buildAhoCorasick(words: ReadonlyArray<string>): AhoAutomaton {
  const gotoTab: Array<Map<string, number>> = [new Map()];
  const out: number[][] = [[]];
  for (let w = 0; w < words.length; w++) {
    let node = 0;
    for (const ch of words[w]) {
      let next = gotoTab[node].get(ch);
      if (next === undefined) {
        next = gotoTab.length;
        gotoTab.push(new Map());
        out.push([]);
        gotoTab[node].set(ch, next);
      }
      node = next;
    }
    out[node].push(w);
  }
  const fail = new Array<number>(gotoTab.length).fill(0);
  const order: number[] = [];
  for (const child of gotoTab[0].values()) order.push(child); // 根的子节点 fail=0（缺省）
  for (let qi = 0; qi < order.length; qi++) {
    const node = order[qi];
    for (const [ch, child] of gotoTab[node]) {
      let f = fail[node];
      while (f !== 0 && !gotoTab[f].has(ch)) f = fail[f];
      const via = gotoTab[f].get(ch);
      fail[child] = via !== undefined && via !== child ? via : 0;
      order.push(child);
    }
  }
  for (let qi = 0; qi < order.length; qi++) {
    const inherited = out[fail[order[qi]]];
    if (inherited.length > 0) out[order[qi]] = out[order[qi]].concat(inherited);
  }
  return { goto: gotoTab, fail, out };
}

/** 原文码点（按 UTF-16 索引取整码点；越界 = ''）——边界邻接字符的读取面 */
function codePointAt16(s: string, i: number): string {
  if (i < 0 || i >= s.length) return '';
  const unit = s.charCodeAt(i);
  // 命中低代理项 ⇒ 回退一步取完整星面码点（相邻字符是 𝐚 之类的场合）
  if (unit >= 0xdc00 && unit <= 0xdfff && i > 0) {
    const high = s.charCodeAt(i - 1);
    if (high >= 0xd800 && high <= 0xdbff) return s.slice(i - 1, i + 1);
  }
  const cp = s.codePointAt(i);
  return cp === undefined ? '' : String.fromCodePoint(cp);
}

/** 邻接字符的码点 → UTF-16 长度（星面码点占 2） */
function utf16LenOf(ch: string): number {
  return ch.length === 2 ? 2 : 1;
}

// 邻接字符按「折叠后首字符是否 [a-z0-9]」判定词内性：直接判原文码元会让全角
// ｐ（U+FF50，不在 ASCII 类）被当成边界 —— 「ｐｒｅｓｅｔ」就会绕过 reset 的
// 硬边界重新误报。折叢单字符后判定（ｐ→p 词内；'-'→'' 边界；密→密 边界），
// 与归一化同律。记忆化：字符集天然有界，512 封顶逐最旧（防御式，不为脏输入付费）。
const WORD_UNIT_MEMO_LIMIT = 512;
const wordUnitMemo = new Map<string, boolean>();

function isWordUnitChar(ch: string): boolean {
  const hit = wordUnitMemo.get(ch);
  if (hit !== undefined) return hit;
  const folded = normalizeForRisk(ch);
  const word = folded.length > 0 && /[a-z0-9]/.test(folded[0]);
  if (wordUnitMemo.size >= WORD_UNIT_MEMO_LIMIT) {
    const oldest = wordUnitMemo.keys().next().value;
    if (oldest !== undefined) wordUnitMemo.delete(oldest);
  }
  wordUnitMemo.set(ch, word);
  return word;
}

/** 硬边界判定：折叠域命中区段 [start,end)（码点坐标）映射回原文，前后邻接
 *  字符均非词内字符（串首尾天然是边界）才算命中。判据取原文而非折叠域 ——
 *  折叠已把「pin-code」压成「pincode」，边界信息只在原文。 */
function boundaryClean(original: string, norm: MappedNormalization, start: number, end: number): boolean {
  const first = norm.map[start];
  if (first !== undefined && first > 0) {
    if (isWordUnitChar(codePointAt16(original, first - 1))) return false;
  }
  const last = norm.map[end - 1];
  if (last !== undefined) {
    const tailChar = codePointAt16(original, last + utf16LenOf(codePointAt16(original, last)));
    if (tailChar !== '' && isWordUnitChar(tailChar)) return false;
  }
  return true;
}

/** 单趟扫描（O(文本长)）：非边界词命中即真；边界词须过 boundaryClean ——
 *  脏命中不终止扫描（同词后继出现处可能是干净边界）。 */
function ahoScanHit(compiled: CompiledPatternSet, norm: MappedNormalization, original: string): boolean {
  const { words, hardBoundary, wordCpLen, automaton } = compiled;
  const gotoTab = automaton.goto;
  const fail = automaton.fail;
  const out = automaton.out;
  let node = 0;
  let pos = 0; // 折叠域码点游标（与 norm.map 对齐）
  for (const ch of norm.text) {
    while (node !== 0 && !gotoTab[node].has(ch)) node = fail[node];
    const stepped = gotoTab[node].get(ch);
    node = stepped !== undefined ? stepped : 0;
    const hits = out[node];
    for (let h = 0; h < hits.length; h++) {
      const w = hits[h];
      if (!hardBoundary[w]) return true;
      if (boundaryClean(original, norm, pos + 1 - wordCpLen[w], pos + 1)) return true;
    }
    pos++;
  }
  return false;
}

/** 匹配核心（matches* 共用）：自动机单趟 + 边界执法。铁律：绝不抛 —— 任何
 *  内部意外降级为旧 includes 语义（全子串、无边界），降级方向保守不漏拦。 */
function matchAnyPattern(text: string, csv: string, fallback: string): boolean {
  try {
    const compiled = compiledPatternSet(csv, fallback);
    if (compiled.words.length === 0) return false;
    return ahoScanHit(compiled, normalizeMapped(text), text);
  } catch {
    const hay = normalizeForRisk(text);
    const pats = (csv || fallback).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    for (let i = 0; i < pats.length; i++) {
      const folded = normalizeForRisk(pats[i]);
      if (folded.length > 0 && hay.includes(folded)) return true;
    }
    return false;
  }
}

/** 文本是否命中任一风险词（混淆免疫：归一化后自动机匹配 + 拉丁短词硬边界） */
export function matchesRiskPatterns(text: string, csv: string): boolean {
  if (!text) return false;
  return matchAnyPattern(text, csv, DEFAULT_RISK_PATTERNS);
}

/** 文本是否命中任一不可逆操作词（需审批令牌；同律归一化 + 词边界感知） */
export function matchesDangerPatterns(text: string, csv: string): boolean {
  if (!text) return false;
  return matchAnyPattern(text, csv, DEFAULT_DANGER_PATTERNS);
}

// ─── W4-3（S5 可逆性分级注册表）：风险判定的叠加维度 ───
//
// 世界级 CUA 的可逆性共识：动作的可撤销性是一个独立于「危不危险」的维度 ——
// 危险词闸门（上方 matches*）回答「要不要审批」，分级注册表回答「派发走哪条
// 道、坏了怎么救」。三级语义（对齐 W3-1 逆转托管的策略表）：
//   reversible   可逆   —— 逆动作存在且非破坏（滚动/切页/再点开关）⇒ 走快道；
//   compensable  可补偿 —— 有托管补偿路径（表单提交/文件删除/写入）⇒ 走 W3-1
//                          托管（先铸逆转预案 mintPlan 再 beginAttempt）；
//   irreversible 不可逆 —— 发送/支付/永久删除：已发生的不可逆是物理事实 ⇒
//                          强制审批 + 人类亲办（escrow 策略表 manual-only 同律）。
// 保守律：**未知动作默认最高级**（irreversible）—— 分级知识的缺口按最坏情况
// 收费，宁可用审批打扰用户，不可用乐观分级放出一次无法撤销的破坏。
//
// 级别在线校准（Beta 风格证据门）：
//   · Τ示范事件 —— approval-denied = 该用户视此为不可逆的最强证据（adverse）；
//     approval-consumed = 特权正示范（supportive —— 后验分母，防高频成功里的
//     偶发拒绝翻级）；
//   · failureMemory 负证据（只读查询）—— 经注入的 negativeEvidenceQuery 折算
//     adverse（**瞬态合并**：查询结果不入持久计数器 —— classify 每次调用都
//     查一次，入册会自我膨胀 β）；
//   · 证据门 —— Beta(1+adverse, 1+supportive) 后验均值 ≥ 0.5 且 adverse ≥ 2
//     才升一级；adverse ≥ 4 且后验 ≥ 0.75 升两级 —— 单事件（adverse=1）无论
//     后验多高都不翻级（防单事件翻级是本门的立法目的）。
//   · 方向不对称 —— 在线校准**只升不降**：正示范证明「用户接受此动作」而非
//     「此动作可撤销」，自动降级会把审批面拱手让给统计噪声；降级只能经部署
//     显式注入（setLevel / arm.extensionLevels —— 人的决策，不是数据的决策）。
//
// 正交性：不改既有危险词语义（分级是叠加维度，词表零变化）；approval.request
// 仅**携带**级别（缺省 undefined ⇒ 既有审批语义逐字节不变）。
// 防御式：本段一切公开面绝不抛 —— 脏输入/端口故障一律收敛为保守返回值。

/** 可逆性三级（S5 的核心枚举） */
export type ReversibilityLevel = 'reversible' | 'compensable' | 'irreversible';

/** 分级判定的等级序（校准升级的步进面：reversible < compensable < irreversible） */
const LEVEL_ORDER: Readonly<Record<ReversibilityLevel, number>> = {
  reversible: 0, compensable: 1, irreversible: 2,
};

/** 分级判定（classify 的返回面） */
export interface ReversibilityVerdict {
  level: ReversibilityLevel;
  /** 注册表键（语义类别；未知 = 'unknown'） */
  semantics: string;
  /** 判定来源：内置表 / 注入扩展 / 证据门校准 / 未知默认最高（保守律） */
  source: 'builtin' | 'extension' | 'calibrated' | 'unknown-default';
  /** 校准证据快照（透明化面 —— 测试/遥测可断言「为什么升了级」） */
  evidence?: { adverse: number; supportive: number; posterior: number; raisedNotches: number };
}

/** 分道指令（执行路径按级分道 —— 派发层的消费面） */
export interface DispatchLane {
  lane: 'fast' | 'escrow' | 'human';
  /** 可逆性维度自身是否要求审批令牌（危险词闸门独立执法，此处不重复） */
  requiresApprovalToken: boolean;
  /** 是否要求先铸 W3-1 托管逆转预案（mintPlan → beginAttempt） */
  requiresEscrowPlan: boolean;
  /** 是否人类亲办（派发层拒绝自动执行，交还控制权） */
  humanExecution: boolean;
  note: string;
}

/** 按级分道（纯函数）：三级 → 派发要求。 */
export function dispatchLaneFor(level: ReversibilityLevel): DispatchLane {
  switch (level) {
    case 'reversible':
      return {
        lane: 'fast', requiresApprovalToken: false, requiresEscrowPlan: false, humanExecution: false,
        note: 'reversible: fast lane — a non-destructive inverse exists (scroll back / re-click / switch back); ' +
          'no reversibility-imposed requirements (danger-word gate still applies independently)',
      };
    case 'compensable':
      return {
        lane: 'escrow', requiresApprovalToken: false, requiresEscrowPlan: true, humanExecution: false,
        note: 'compensable: W3-1 escrow lane — mint a reversal plan (reversalEscrow.mintPlan) BEFORE beginAttempt; ' +
          'compensation path is hosted and verified (danger-word gate may still require approval independently)',
      };
    case 'irreversible':
      return {
        lane: 'human', requiresApprovalToken: true, requiresEscrowPlan: false, humanExecution: true,
        note: 'irreversible: forced approval + HUMAN execution — the escrow strategy table is manual-only ' +
          '(fail-closed: a delivered message cannot be unsent); automation must hand control back to the user',
      };
  }
}

/**
 * 内置语义 → 级别表。键与 reversalEscrow 的补偿策略表对齐（compensable 键 =
 * 策略表 kind:'compensate' 的语义；irreversible 键 = manual-only 的语义 ——
 * 两表各自独立维护，键对齐是纪律不是依赖：riskGate 不得 import reversalEscrow
 * （会与 approval → riskGate 成环），对齐靠测试与注释执法）。
 */
const BUILTIN_LEVELS: ReadonlyMap<string, ReversibilityLevel> = new Map([
  // 可逆：逆动作存在且非破坏
  ['viewport-scroll', 'reversible'],   // scroll_page → 反向滚动
  ['tab-switch', 'reversible'],        // switch_tab / switch_window → 切回
  ['popup-dismiss', 'reversible'],     // dismiss_popup → 关掉的浮层不改变持久世界
  ['toggle', 'reversible'],            // 开关/复选 → 再点一次（精确逆）
  // 可补偿：W3-1 托管策略表有补偿路径
  ['form-submit', 'compensable'],      // Ctrl+Z / 草稿箱回收
  ['file-delete', 'compensable'],      // 回收站还原 / Ctrl+Z
  ['file-write', 'compensable'],       // 应用内 undo 栈
  ['text-input', 'compensable'],       // Ctrl+Z（W6-3 扩表后与 escrow 策略表对齐：输入类走应用内 undo）
  ['navigation', 'compensable'],       // 后退导航 Backspace（W6-3 扩表：返回动作前页面）
  // 不可逆：策略表明示 manual-only
  ['send-message', 'irreversible'],    // 已发出的消息无法收回
  ['payment', 'irreversible'],         // 退款是新交易不是撤销
  ['permanent-delete', 'irreversible'],// 不进回收站的删除 —— 语义上已放弃可逆性
]);

/**
 * 描述关键词 → 语义键（与危险词表同律归一化、但**独立成表** —— 不改既有
 * 危险词语义，分级是叠加维度）。匹配序 = 表序：不可逆族最前（保守优先 ——
 * "delete then send" 的复合描述归入 send-message），可补偿族次之，可逆族最后。
 */
const LEVEL_KEYWORDS: ReadonlyArray<{ readonly key: string; readonly semantics: string }> = [
  // 不可逆族（对齐 DEFAULT_DANGER_PATTERNS 的发送/支付/格式化词组）
  { key: normalizeForRisk('send'), semantics: 'send-message' },
  { key: '发送', semantics: 'send-message' },
  { key: normalizeForRisk('pay'), semantics: 'payment' },
  { key: '支付', semantics: 'payment' }, { key: '付款', semantics: 'payment' },
  { key: 'buy', semantics: 'payment' }, { key: '购买', semantics: 'payment' },
  { key: 'checkout', semantics: 'payment' }, { key: '结算', semantics: 'payment' },
  { key: 'withdraw', semantics: 'payment' }, { key: '提现', semantics: 'payment' },
  { key: 'transfer', semantics: 'payment' }, { key: '转账', semantics: 'payment' },
  { key: 'format', semantics: 'permanent-delete' }, { key: '格式化', semantics: 'permanent-delete' },
  { key: 'erase', semantics: 'permanent-delete' }, { key: '抹掉', semantics: 'permanent-delete' },
  // 可补偿族
  { key: 'delete', semantics: 'file-delete' }, { key: '删除', semantics: 'file-delete' },
  { key: 'remove', semantics: 'file-delete' }, { key: '移除', semantics: 'file-delete' },
  { key: 'submit', semantics: 'form-submit' }, { key: '提交', semantics: 'form-submit' },
  { key: '下单', semantics: 'form-submit' }, { key: '订单', semantics: 'form-submit' },
  { key: 'type', semantics: 'text-input' }, { key: '输入', semantics: 'text-input' },
  { key: '填写', semantics: 'text-input' },
  { key: 'open', semantics: 'navigation' }, { key: 'navigate', semantics: 'navigation' },
  { key: '跳转', semantics: 'navigation' },
  // 可逆族（描述面少用 —— 工具回退表承担主力）
  { key: 'scroll', semantics: 'viewport-scroll' }, { key: '滚动', semantics: 'viewport-scroll' },
  { key: 'tab', semantics: 'tab-switch' },
];

/** 已知工具 → 语义键回退表（描述无命中时的次级判定面）。
 *  刻意不收录 click_mouse/click_element/drag_mouse/press_hotkey —— 这些工具
 *  的可逆性由**目标语义**决定而非工具本身（点开关可逆、点发送不可逆），目标
 *  未知 ⇒ 保守律默认最高级。 */
const TOOL_SEMANTICS: ReadonlyMap<string, string> = new Map([
  ['scroll_page', 'viewport-scroll'],
  ['switch_tab', 'tab-switch'],
  ['switch_window', 'tab-switch'],
  ['dismiss_popup', 'popup-dismiss'],
  ['type_text', 'text-input'],
  ['open_url', 'navigation'],
]);

// ─── 证据门常量（Beta 风格 —— 值即边界） ───

/** 升一级的最低 adverse 事件数（防单事件翻级的执法点） */
const RAISE_MIN_ADVERSE = 2;
/** 升一级的后验均值门（Beta(1+adverse, 1+supportive) 均值） */
const RAISE_POSTERIOR = 0.5;
/** 升两级的最低 adverse 事件数 */
const RAISE2_MIN_ADVERSE = 4;
/** 升两级的后验均值门 */
const RAISE2_POSTERIOR = 0.75;
/** 证据键封顶（无界键表 = 无界记忆 —— 满后逐出最旧） */
const EVIDENCE_KEYS_MAX = 128;
/** 单次负证据查询的折算上限（查询返回巨数不得一次买断两级） */
const NEGATIVE_EVIDENCE_CAP = 10;

/** 每语义键的证据账（在线校准的唯一持久态） */
interface LevelEvidence {
  adverse: number;      // denial 示范 + 注入的持久负证据
  supportive: number;   // consumed 示范（后验分母）
}

// ─── 注册表模块态（全部经 arm 注入；缺省 = 内置表 + 无扩展 + 无查询） ───

let extensionLevels = new Map<string, ReversibilityLevel>();
let evidenceStore = new Map<string, LevelEvidence>();
let negativeEvidenceQuery: ((semantics: string) => number) | null = null;

function cleanStr(v: unknown, max: number): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v.slice(0, max) : undefined;
}

function isLevel(v: unknown): v is ReversibilityLevel {
  return v === 'reversible' || v === 'compensable' || v === 'irreversible';
}

function clampCount(v: unknown, max: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : 0;
  return Math.max(0, Math.min(max, n));
}

/** 证据账读取（无则零账 —— 诚实起点） */
function evidenceOf(semantics: string): LevelEvidence {
  return evidenceStore.get(semantics) ?? { adverse: 0, supportive: 0 };
}

/** 证据账写入（封顶逐出最旧 —— Map 保序，首键即牺牲者） */
function putEvidence(semantics: string, ev: LevelEvidence): void {
  if (evidenceStore.size >= EVIDENCE_KEYS_MAX && !evidenceStore.has(semantics)) {
    const oldest = evidenceStore.keys().next().value;
    if (oldest !== undefined) evidenceStore.delete(oldest);
  }
  evidenceStore.set(semantics, ev);
}

/** Beta 后验均值：Beta(1+adverse, 1+supportive) 的 mean = α/(α+β)（α=1+adverse；W7 审计改正原注释方向笔误） */
function posteriorMean(ev: LevelEvidence): number {
  return (ev.adverse + 1) / (ev.adverse + ev.supportive + 2);
}

/** 证据门（纯函数）：base 级 + 证据账 → 校准级与升档数 */
function gateLevel(base: ReversibilityLevel, ev: LevelEvidence): { level: ReversibilityLevel; raisedNotches: number } {
  const p = posteriorMean(ev);
  let notches = 0;
  if (ev.adverse >= RAISE_MIN_ADVERSE && p >= RAISE_POSTERIOR) notches = 1;
  if (ev.adverse >= RAISE2_MIN_ADVERSE && p >= RAISE2_POSTERIOR) notches = 2;
  const levelNum = Math.min(LEVEL_ORDER.irreversible, LEVEL_ORDER[base] + notches);
  const level = (['reversible', 'compensable', 'irreversible'] as const)[levelNum];
  return { level, raisedNotches: levelNum - LEVEL_ORDER[base] };
}

/** 描述 → 语义键（关键词表序匹配 —— 不可逆族优先的保守序） */
function semanticsFromDescription(description: string): string | null {
  if (!description) return null;
  const hay = normalizeForRisk(description);
  if (hay === '') return null;
  for (const { key, semantics } of LEVEL_KEYWORDS) {
    if (key !== '' && hay.includes(key)) return semantics;
  }
  return null;
}

/** 分级判定的核心实现（注册表方法与示范入账共用的内部面） */
function classifyIntent(intent: { tool?: unknown; description?: unknown; semantics?: unknown }): ReversibilityVerdict {
  try {
    const explicit = cleanStr(intent?.semantics, 64);
    const tool = cleanStr(intent?.tool, 64);
    const description = cleanStr(intent?.description, 200);
    let semantics: string | null = null;
    let known = false;
    if (explicit !== undefined && (BUILTIN_LEVELS.has(explicit) || extensionLevels.has(explicit))) {
      semantics = explicit; known = true;
    }
    if (!known) {
      const byDesc = description !== undefined ? semanticsFromDescription(description) : null;
      if (byDesc !== null) { semantics = byDesc; known = true; }
    }
    if (!known && tool !== undefined && TOOL_SEMANTICS.has(tool)) {
      semantics = TOOL_SEMANTICS.get(tool)!; known = true;
    }
    if (!known) {
      // 保守律：未知动作默认最高级（分级知识的缺口按最坏情况收费）
      return { level: 'irreversible', semantics: 'unknown', source: 'unknown-default' };
    }
    const ext = extensionLevels.get(semantics!);
    const base = ext ?? BUILTIN_LEVELS.get(semantics!) ?? 'irreversible';
    const baseSource: ReversibilityVerdict['source'] = ext !== undefined ? 'extension' : 'builtin';
    // 瞬态负证据合并（只读查询 —— 不入持久账，防 classify 自我膨胀）
    let ev = evidenceOf(semantics!);
    if (semantics !== 'unknown' && negativeEvidenceQuery !== null) {
      try {
        ev = { ...ev, adverse: ev.adverse + clampCount(negativeEvidenceQuery(semantics!), NEGATIVE_EVIDENCE_CAP) };
      } catch { /* 查询端口故障 = 无负证据（诚实缺席，不炸分级） */ }
    }
    const gated = gateLevel(base, ev);
    if (gated.raisedNotches > 0) {
      return {
        level: gated.level, semantics: semantics!, source: 'calibrated',
        evidence: {
          adverse: ev.adverse, supportive: ev.supportive,
          posterior: Math.round(posteriorMean(ev) * 1000) / 1000,
          raisedNotches: gated.raisedNotches,
        },
      };
    }
    return { level: gated.level, semantics: semantics!, source: baseSource };
  } catch {
    return { level: 'irreversible', semantics: 'unknown', source: 'unknown-default' }; // 防御式兜底
  }
}

/**
 * W4-3（S5）：可逆性分级注册表（模块单例 —— 插件卸载随闭包消亡）。
 * 一切公开面绝不抛：脏输入 / 查询端口故障 ⇒ 收敛为保守返回值（未知默认
 * 最高级是缺省的方向，不是异常的出口）。
 */
export const reversibilityRegistry = {
  /** 分级判定（纯读 + 瞬态负证据合并；绝不抛）。
   *  判定序：显式语义键（表内）→ 描述关键词 → 工具回退表 → 未知默认最高。
   *  显式语义键不在表内 ⇒ 同样默认最高（未注册的语义 = 注册表的知识缺口）。 */
  classify(intent: { tool?: unknown; description?: unknown; semantics?: unknown }): ReversibilityVerdict {
    return classifyIntent(intent);
  },

  /** Τ示范事件入账（approval.emitDemonstration 的旁路落点；绝不抛）：
   *  approval-denied ⇒ adverse++（用户视此为不可逆的证据）；
   *  approval-consumed ⇒ supportive++（特权正示范 —— 后验分母）。
   *  语义键解析：显式 semantics ?? 由 tool/description 现场分类（与 classify
   *  同一判定面 —— 事件落在哪个键上，分级就在哪个键上长证据）。 */
  observeDemonstration(ev: { kind: unknown; semantics?: unknown; tool?: unknown; description?: unknown }): void {
    try {
      if (ev?.kind !== 'approval-denied' && ev?.kind !== 'approval-consumed') return;
      let key = cleanStr(ev?.semantics, 64) ?? null;
      if (key === null || (!BUILTIN_LEVELS.has(key) && !extensionLevels.has(key))) {
        const v = classifyIntent({ tool: ev?.tool, description: ev?.description, semantics: ev?.semantics });
        key = v.semantics === 'unknown' ? null : v.semantics;
      }
      if (key === null) return; // 键不可解析 ⇒ 证据不落账（不把噪声记成知识）
      const cur = evidenceOf(key);
      putEvidence(key, ev?.kind === 'approval-denied'
        ? { ...cur, adverse: cur.adverse + 1 }
        : { ...cur, supportive: cur.supportive + 1 });
    } catch { /* 旁路义务：教育失败绝不炸调用方 */ }
  },

  /** 持久负证据注入（failureMemory 之外的显式入账面；一次封顶 8 —— 单次
   *  调用不得买断两级）。绝不抛。 */
  applyNegativeEvidence(semantics: unknown, count: unknown): void {
    try {
      const key = cleanStr(semantics, 64);
      if (key === undefined) return;
      const cur = evidenceOf(key);
      putEvidence(key, { ...cur, adverse: cur.adverse + clampCount(count, 8) });
    } catch { /* 防御式兜底 */ }
  },

  /** 部署显式定级（人的决策 —— 在线校准只升不降，降级走此面或 arm 扩展） */
  setLevel(semantics: unknown, level: unknown): boolean {
    try {
      const key = cleanStr(semantics, 64);
      if (key === undefined || !isLevel(level)) return false;
      extensionLevels.set(key, level);
      return true;
    } catch {
      return false;
    }
  },

  // ─── W9-2（DEBTS D-C1 落锤）：外部补偿策略表的同步登记通道（增量）───
  //
  // 决策理由：D-C1 的剩余债是「compensate 扩表面待部署知识」—— 内置表受
  // S5-5d 键对齐律封死（riskGate 所有权），部署方扩表的正确姿势是**以文件
  // 扩表而非改源码**：reversalEscrow.loadExternalStrategyTable(path) 从 JSON
  // 外部表装载补偿路径，本通道是它在分级注册表侧的对应落点 —— 两表在同一
  // 次装载里同键登记（compensate ⇔ compensable；manual-only ⇔ irreversible），
  // 「两侧同步登记」由装载面原子完成，不再依赖部署方手工两次接线。
  // 立法边界：本通道只**增量登记**（compensable / irreversible 两级，不收
  // reversible —— 外部表没有「快道」语义面）；批量全有或全无（一条坏件 ⇒
  // 整批拒绝，绝不留下半套登记的中间态）；一切公开面绝不抛。

  /**
   * W9-2：批量定级登记（全有或全无 —— 外部策略表装载的分级侧半边）。
   * entries 每项 { semantics, level }；level 仅收 'compensable' | 'irreversible'
   * （reversible 是内置快道知识，不经部署文件面注入 —— 保守缺省）。
   * 任何一项不合格 ⇒ { ok:false } 且**零登记**（调用方整批重试或放弃）。
   */
  registerLevels(entries: unknown): { ok: boolean; registered?: number; error?: string } {
    try {
      if (!Array.isArray(entries) || entries.length === 0) {
        return { ok: false, error: 'entries must be a non-empty array' };
      }
      const parsed: Array<{ semantics: string; level: ReversibilityLevel }> = [];
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        if (!e || typeof e !== 'object') return { ok: false, error: `entry ${i}: not an object` };
        const key = cleanStr((e as { semantics?: unknown }).semantics, 64);
        const level = (e as { level?: unknown }).level;
        if (key === undefined) return { ok: false, error: `entry ${i}: semantics is required` };
        if (level !== 'compensable' && level !== 'irreversible') {
          return { ok: false, error: `entry ${i} (${key}): level must be 'compensable' or 'irreversible'` };
        }
        if (parsed.some(p => p.semantics === key)) {
          return { ok: false, error: `entry ${i}: duplicate semantics "${key}"` };
        }
        parsed.push({ semantics: key, level });
      }
      for (const p of parsed) extensionLevels.set(p.semantics, p.level);
      return { ok: true, registered: parsed.length };
    } catch {
      return { ok: false, error: 'internal registration failure — nothing registered' };
    }
  },

  /**
   * W9-2：基级查询（校准前的注册表基础级别 —— 双侧对齐律的校验锚点）。
   * 与 classify 的分野：classify 叠加证据门校准（只升不降）与保守律默认，
   * 结果是「当下该怎么派发」；levelOf 返回注册表里**登记了什么**（内置/
   * 扩展来源面），供装载面验证「文件说的级别 = 注册表登记的级别」——
   * 对齐律校验必须用基级，否则校准升级（安全方向）会被误判为不对齐。
   * 未知键 ⇒ null（诚实缺席，不猜）。
   */
  levelOf(semantics: unknown): { level: ReversibilityLevel; source: 'builtin' | 'extension' } | null {
    try {
      const key = cleanStr(semantics, 64);
      if (key === undefined) return null;
      const ext = extensionLevels.get(key);
      if (ext !== undefined) return { level: ext, source: 'extension' };
      const builtin = BUILTIN_LEVELS.get(key);
      if (builtin !== undefined) return { level: builtin, source: 'builtin' };
      return null;
    } catch {
      return null;
    }
  },

  /** 武装（幂等）：注入扩展级别表 / failureMemory 负证据只读查询。绝不抛。 */
  arm(opts: {
    extensionLevels?: Array<{ semantics: string; level: ReversibilityLevel }>;
    negativeEvidenceQuery?: ((semantics: string) => number) | null;
  } = {}): void {
    try {
      if (Array.isArray(opts.extensionLevels)) {
        const m = new Map<string, ReversibilityLevel>();
        for (const e of opts.extensionLevels) {
          const key = cleanStr(e?.semantics, 64);
          if (key !== undefined && isLevel(e?.level)) m.set(key, e.level);
        }
        extensionLevels = m;
      }
      if ('negativeEvidenceQuery' in opts) {
        negativeEvidenceQuery = typeof opts.negativeEvidenceQuery === 'function' ? opts.negativeEvidenceQuery : null;
      }
    } catch { /* 武装失败 = 保持现状（诚实降级） */ }
  },

  /** 透明化（测试/遥测面）：证据账快照（深拷贝 —— 新的在后） */
  dumpEvidence(): Array<{ semantics: string; adverse: number; supportive: number; posterior: number }> {
    return [...evidenceStore.entries()].map(([semantics, ev]) => ({
      semantics, adverse: ev.adverse, supportive: ev.supportive,
      posterior: Math.round(posteriorMean(ev) * 1000) / 1000,
    }));
  },

  /** 隔离缝（测试 beforeEach / 插件卸载）：扩展表/证据账/查询端口归零回缺省 */
  reset(): void {
    extensionLevels = new Map();
    evidenceStore = new Map();
    negativeEvidenceQuery = null;
  },
};
