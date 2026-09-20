// src/sequitur.ts
// F 纪元（第六维·压缩认知）：SEQUITUR 文法归纳 —— 「压缩即学习」的最小诚实实现。
//
// 理论根基（Nevill-Manning & Witten 1997）：对符号序列在线归纳最小上下文无关文法，
// 约束二则：双字符唯一性（任一二元组至多出现一次 ⇒ 重复即刻成规则）+
// 规则效用（每条规则至少被引用两次 ⇒ 无用规则即刻内联回消）。这与 MDL 原理同源：
// 能被短文法无损描述的序列就是「有结构的」—— 对行动日志而言，结构 = 可固化技能。
//
// 本实现是批处理变体（迭代「成规则-替全体-内联回消」直至定点），非在线单遍：
// 诚实边界 —— 渐进复杂度 O(n²)（最坏），调用方以 maxLen 预算执法；日志侧仅在
// 技能匹配落空时调用一次，热路径零成本。不变量（epochF.test 守护）：
//   1. 无损性：文法展开逐符号重建输入序列
//   2. 效用性：一切保留规则引用数 ≥ 2
//   3. 无结构输入（无重复子序列）⇒ 零规则
export interface SequiturRule {
  /** 规则符号（体内引用其它规则） */
  symbols: string[];
  /** 展开后的叶符号数（不含规则引用的膨胀尺寸） */
  expandedLength: number;
  /** 被引用次数（根序列 + 其它规则体内） */
  usage: number;
}

export interface SequiturGrammar {
  /** 根序列（叶符号 + 规则符号混合） */
  root: string[];
  rules: Map<string, SequiturRule>;
}

/** 规则符号前缀（输入符号域的隔离带 —— 工具签名永不以 ⟦ 开头） */
const RULE_PREFIX = '\u27E6'; // ⟦
const RULE_SUFFIX = '\u27E7'; // ⟧
const isRuleSym = (s: string): boolean => s.startsWith(RULE_PREFIX);

/** 计算：此刻还有没有出现 ≥2 次（非重叠）的双元组？有则返回首个 */
function repeatedDigram(seq: string[]): [string, string] | null {
  const seen = new Map<string, number>(); // digram → 上次出现位置（重叠检测）
  for (let i = 0; i + 1 < seq.length; i++) {
    const key = seq[i] + '\u0000' + seq[i + 1];
    const prev = seen.get(key);
    if (prev !== undefined && i > prev + 1) return [seq[i], seq[i + 1]]; // 非重叠重复
    if (prev === undefined) seen.set(key, i); // 只记首见（重叠如 AAA 只计一次）
  }
  return null;
}

/** 统计规则符号在根序列与其它规则体内的总引用数 */
function countUsage(rules: Map<string, SequiturRule>, root: string[]): Map<string, number> {
  const usage = new Map<string, number>();
  for (const s of root) if (isRuleSym(s)) usage.set(s, (usage.get(s) ?? 0) + 1);
  for (const r of rules.values()) {
    for (const s of r.symbols) {
      if (isRuleSym(s)) usage.set(s, (usage.get(s) ?? 0) + 1);
    }
  }
  return usage;
}

/**
 * 文法归纳主入口。终止性：每次成规则使根序列严格变短；内联只减规则数 ——
 * 两个单调量保证必然到达定点。
 */
export function sequitur(input: readonly string[]): SequiturGrammar {
  const root = [...input];
  const rules = new Map<string, SequiturRule>();
  let ruleSeq = 0;

  for (;;) {
    // 1. 内联回消：引用 <2 的规则展开回去（规则效用约束），可能复原重复双元组 → 外层再跑
    let inlined = false;
    for (;;) {
      const usage = countUsage(rules, root);
      const dead = [...rules.keys()].filter(k => (usage.get(k) ?? 0) < 2);
      if (dead.length === 0) break;
      for (const k of dead) {
        const body = rules.get(k)!.symbols;
        rules.delete(k);
        const subst = (arr: string[]): string[] =>
          arr.flatMap(s => (s === k ? body : [s]));
        root.splice(0, root.length, ...subst(root));
        for (const r of rules.values()) r.symbols = subst(r.symbols);
      }
      inlined = true;
    }
    // 2. 成规则：首个非重叠重复双元组 ⇒ 新规则 + 全体替换
    const dig = repeatedDigram(root);
    if (!dig) break; // 定点：根序列双元组唯一
    const id = `${RULE_PREFIX}${++ruleSeq}${RULE_SUFFIX}`;
    rules.set(id, { symbols: dig, expandedLength: 2, usage: 0 });
    let i = 0;
    let replaced = 0;
    while (i + 1 < root.length) {
      if (root[i] === dig[0] && root[i + 1] === dig[1]) {
        root.splice(i, 2, id);
        replaced++;
      } else i++;
    }
    void replaced; void inlined;
    if (replaced < 2) {
      // 理论不可达（repeatedDigram 只报 ≥2 非重叠）；防御性回滚防死循环
      rules.delete(id);
      break;
    }
  }

  // 收尾：刷新引用计数与叶膨胀尺寸
  const usage = countUsage(rules, root);
  for (const [id, r] of rules) {
    r.usage = usage.get(id) ?? 0;
    r.expandedLength = r.symbols.reduce(
      (n, s) => n + (isRuleSym(s) ? rules.get(s)?.expandedLength ?? 1 : 1), 0);
  }
  return { root, rules };
}

/** 展开任意符号列表（规则引用递归内联）—— 规则体解码的原子 */
export function expandSymbols(g: SequiturGrammar, symbols: string[]): string[] {
  const out: string[] = [];
  for (const s of symbols) {
    const r = isRuleSym(s) ? g.rules.get(s) : undefined;
    if (r) out.push(...expandSymbols(g, r.symbols));
    else out.push(s);
  }
  return out;
}

/** 文法展开（无损性断言的事实源）：递归展开根序列为叶符号流 */
export function expandGrammar(g: SequiturGrammar): string[] {
  return expandSymbols(g, g.root);
}
