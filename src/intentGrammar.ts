// src/intentGrammar.ts
// 笔迹纪元（X）：意图语法层 —— 结构化意图 → 结构化动作的零模型映射。
//
// 反射纪元的决策脑此前只会一种运动：click_mouse。本模块把「运动词汇」
// 扩张到 type_text / scroll_page / press_hotkey，全程零 LLM：
//
//   1. 刺激类别判别（动词位）：闭式动词词表 ∩ 意图 token —— 只有对应类别的
//      刺激才允许点火对应运动弧（'delete "x"' 不因引号段而误入笔迹弧）。
//   2. 引号锚定提取（信息无损）：笔迹内容必须由可逆编码携带 —— 意图里的
//      引号段（"…" / '…' / 「…」 / 『…』 / “…” / ‘…’）按构造精确还原，
//      提取与书写内容编辑距离为 0。自由文本提取是有损猜测，一律拒绝：
//      打错一个字的密码与没打一样。精确性优先（precision-first）。
//   3. 残差目标（落点投票权排除笔迹）：意图切除动词与引号段后剩余 token
//      才有资格给「点哪」投票 —— 载荷词不参加落点选举。
//   4. 数字量提取：滚动量必须落在运动学域 [1,20] 内，域外拒绝（不钳制 ——
//      钳制会把 'scroll 999' 静默改写成 20，掩盖意图与词法的分歧）。
//   5. 键名归一：修饰键同义词收敛（control→ctrl / option→alt / win|cmd|super→meta），
//      键集合外字符拒绝；和弦 ≤4 键（超长组合是解析噪声不是人手）。
//
// 零依赖纯函数（可单测到穷尽）；运行层永不抛错 —— 一切「看不懂」都以
// 结构化的 refusal 返回（{ kind:'refused', reason }），由决策站转 NeedGrounding。
import { tokenize } from './uiMemory';

// ─── 刺激类别词表（闭式 —— 扩表 = 加一行，语义不漂移）───

/** 笔迹动词（typing 类刺激）：英文 + 中文（tokenize 对中文出单字+二元） */
const TYPE_VERBS = new Set([
  'type', 'enter', 'input', 'write', 'fill', 'paste',
  '输入', '键入', '填写', '打入',
]);
/** 滚动动词 */
const SCROLL_VERBS = new Set(['scroll', '滚动', '翻页']);
/** 热键动词 */
const HOTKEY_VERBS = new Set(['press', 'hotkey', '按键', '组合键']);

/** 滚动量运动学域：一次反射弧的合法幅度（域外拒绝，不钳制） */
const SCROLL_AMOUNT_MAX = 20;
/** 热键和弦上限（ctrl+shift+esc=3；4 已是平台罕见上限） */
const HOTKEY_KEYS_MAX = 4;

/** 键名归一表（修饰键同义词收敛 + 习惯别名） */
const KEY_ALIASES: Readonly<Record<string, string>> = {
  control: 'ctrl', option: 'alt', meta: 'meta', win: 'meta', cmd: 'meta', super: 'meta',
  escape: 'esc', return: 'enter', del: 'delete', bs: 'backspace', spacebar: 'space',
};
/** 归一后的合法键全集 */
const KEY_UNIVERSE = new Set([
  'ctrl', 'alt', 'shift', 'meta',
  'esc', 'enter', 'tab', 'space', 'delete', 'backspace', 'home', 'end',
  'up', 'down', 'left', 'right', 'pagedown', 'pageup',
  ...Array.from({ length: 26 }, (_, i) => String.fromCharCode(97 + i)), // a-z
  ...Array.from({ length: 10 }, (_, i) => String(i)), // 0-9
  ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`), // f1-f12
]);

// ─── 引号锚定提取 ───

export interface QuotedSpan {
  /** 提取的笔迹内容（无损：与源字符串引号内逐字符相同） */
  content: string;
  /** 引号风格（审计面：哪种编码携带了载荷） */
  quote: 'double' | 'single' | 'corner' | 'white-corner' | 'curly-double' | 'curly-single';
  /** 在源字符串中的字符区间 [start, end)（含引号 —— 残差切除用） */
  range: { start: number; end: number };
}

interface QuotePair {
  open: string;
  close: string;
  style: QuotedSpan['quote'];
}

const QUOTE_PAIRS: QuotePair[] = [
  { open: '"', close: '"', style: 'double' },
  { open: '\'', close: '\'', style: 'single' },
  { open: '「', close: '」', style: 'corner' },
  { open: '『', close: '』', style: 'white-corner' },
  { open: '“', close: '”', style: 'curly-double' },
  { open: '‘', close: '’', style: 'curly-single' },
];

/** 引号段提取：从左到右扫描，每种引号寻找**最近的**配对闭引号。
 *  不做嵌套/转义 —— 反射纪元的载荷是平面字符串；复杂的引用结构属于
 *  LLM 层的语义，不是脊髓的语法。空段（""）不算载荷（无信息量）。
 *  撇号防护（X-1 执法出的真实缺陷）：缩写撇号（don't / it's）会与后面的
 *  单引号载荷错误配对，产出**静默损坏**的载荷（"t press "）—— 单引号族
 *  （直引号 + 弯引号）的开引号加词边界门：前邻是字母数字 ⇒ 是撇语，不是
 *  开引号。精确性优先：宁可无载荷拒绝，不要错载荷落键。 */
export function extractQuotedSpans(text: string): QuotedSpan[] {
  const spans: QuotedSpan[] = [];
  const consumed = new Array<boolean>(text.length).fill(false);
  for (let i = 0; i < text.length; i++) {
    if (consumed[i]) continue;
    const pair = QUOTE_PAIRS.find(p => text[i] === p.open);
    if (!pair) continue;
    const isSingleFamily = pair.style === 'single' || pair.style === 'curly-single';
    if (isSingleFamily && i > 0 && /[a-z0-9]/i.test(text[i - 1])) continue; // 撇号不是开引号
    const j = text.indexOf(pair.close, i + 1);
    if (j <= i) continue; // 未配对开引号：不构成载荷
    const content = text.slice(i + 1, j);
    if (content.trim().length === 0) continue; // 空段无信息量
    spans.push({ content, quote: pair.style, range: { start: i, end: j + 1 } });
    for (let k = i; k <= j; k++) consumed[k] = true;
    i = j;
  }
  return spans;
}

// ─── 刺激类别判别 ───

export type MotorClass = 'typing' | 'scrolling' | 'hotkey';

/** 动词位判别：意图 token ∩ 类别词表（多类命中按 typing > scrolling > hotkey
 *  的字典序裁决 —— 'type' 与 'scroll' 同时在场是词法噪声，取更具体的运动）。 */
export function classifyMotor(text: string): MotorClass | null {
  const tokens = tokenize(text);
  if (tokens.some(t => TYPE_VERBS.has(t))) return 'typing';
  if (tokens.some(t => SCROLL_VERBS.has(t))) return 'scrolling';
  if (tokens.some(t => HOTKEY_VERBS.has(t))) return 'hotkey';
  return null;
}

/** 残差铸造：意图切除全部引号段与全部动词 token 后的剩余 token。
 *  切除按字符串手术（先删引号段再分词）—— 引号内的词不参加落点选举。 */
export function residueTokens(text: string): string[] {
  let rest = text;
  for (const span of extractQuotedSpans(text)) {
    rest = rest.slice(0, span.range.start) + ' ' + rest.slice(span.range.end);
  }
  const verbs = new Set([...TYPE_VERBS, ...SCROLL_VERBS, ...HOTKEY_VERBS]);
  return tokenize(rest).filter(t => !verbs.has(t));
}

// ─── 数字量提取（滚动）───

export interface ScrollDirective { direction: 'up' | 'down' | 'left' | 'right'; amount: number }

/** 滚动指令提取：方向词唯一 + 幅度数字在域内，缺省幅度 1。
 *  方向缺席/歧义、幅度域外 ⇒ refusal（滚动是全局运动，方向不明 = 运动不明）。 */
export function extractScroll(text: string):
  { kind: 'ok'; value: ScrollDirective } | { kind: 'refused'; reason: string } {
  const tokens = residueTokens(text);
  const dirs = tokens.filter(t => ['up', 'down', 'left', 'right'].includes(t));
  if (dirs.length === 0) return { kind: 'refused', reason: 'scroll direction absent (up/down/left/right)' };
  if (new Set(dirs).size > 1) return { kind: 'refused', reason: `scroll direction ambiguous (${[...new Set(dirs)].join('+')})` };
  const numbers = tokens.filter(t => /^\d+$/.test(t) && t.length <= 3);
  if (numbers.length > 1) return { kind: 'refused', reason: `scroll amount ambiguous (${numbers.join(',')})` };
  let amount = 1;
  if (numbers.length === 1) {
    amount = Number(numbers[0]);
    if (amount < 1 || amount > SCROLL_AMOUNT_MAX) {
      return { kind: 'refused', reason: `scroll amount ${amount} outside kinematic domain [1,${SCROLL_AMOUNT_MAX}]` };
    }
  }
  return { kind: 'ok', value: { direction: dirs[0] as ScrollDirective['direction'], amount } };
}

// ─── 键名归一（热键）───

export interface HotkeyDirective { keys: string[] }

/** 热键和弦提取：残差 token 逐个归一（别名收敛 → 键全集校验）。
 *  任一 token 不在键宇宙 ⇒ refusal（'press the button' 的 button 不是键）；
 *  和弦 2..4 键（单键 = 普通按键，同样合法 —— esc/enter 都是单键和弦）。 */
export function extractHotkey(text: string):
  { kind: 'ok'; value: HotkeyDirective } | { kind: 'refused'; reason: string } {
  const tokens = residueTokens(text);
  const keys: string[] = [];
  for (const raw of tokens) {
    const key = KEY_ALIASES[raw] ?? (/^[a-z0-9]$/.test(raw) ? raw : raw);
    if (!KEY_UNIVERSE.has(key)) {
      return { kind: 'refused', reason: `'${raw}' is not a key name` };
    }
    keys.push(key);
  }
  if (keys.length === 0) return { kind: 'refused', reason: 'no keys in hotkey intent' };
  if (keys.length > HOTKEY_KEYS_MAX) {
    return { kind: 'refused', reason: `chord of ${keys.length} keys exceeds ${HOTKEY_KEYS_MAX} (parse noise, not a human hand)` };
  }
  return { kind: 'ok', value: { keys } };
}
