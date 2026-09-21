// src/ltlf.ts
// I 纪元（第八维·判决与隐态）：LTLf —— 有限迹时序逻辑的形式验证。
//
// 理论根基（LTL on Finite Traces，De Giacomo & Vardi 2013）：标准 LTL 语义假定
// 无限迹；智能体的行动日志是天然有限迹。LTLf 的算子语义（在长度 n 的迹上）：
//   G φ（always）  ：迹上每一位置 φ 成立
//   F φ（eventually）：存在位置 φ 成立
//   X φ（next）    ：i+1 < n 且 φ(i+1)（强下一 —— 末位无下一，诚实为假）
//   φ U ψ（until） ：∃j≥i: ψ(j) ∧ ∀k∈[i,j): φ(k)
// 这是形式化方法（formal methods）界的验证原语 —— 本模块把它带到行动日志上：
// ReAct 教义（「行动前必观察、行动后必验证」）从提示词里的软约束，升格为
// 可机检的时序性质，违例逐位定位。
//
// 实现形态：组合子 API（非字符串解析器 —— 算子即函数，类型即文法）。
// 永不抛错：空迹上 G 为真（空真）、F/X/U 为假（诚实缺席）。

/** 谓词：迹上第 i 位的真值 */
export type TracePred = (i: number) => boolean;

/** always：全位置成立 */
export function ltlG(p: TracePred, n: number): boolean {
  for (let i = 0; i < n; i++) if (!p(i)) return false;
  return true;
}

/** eventually：存在位置成立 */
export function ltlF(p: TracePred, n: number): boolean {
  for (let i = 0; i < n; i++) if (p(i)) return true;
  return false;
}

/** 强 next：存在下一位置且成立（末位为假 —— 有限迹的诚实语义） */
export function ltlX(p: TracePred, n: number, i = 0): boolean {
  return i + 1 < n && p(i + 1);
}

/** until：∃j≥i ψ(j) ∧ 前段全 φ */
export function ltlU(phi: TracePred, psi: TracePred, n: number, i = 0): boolean {
  for (let j = i; j < n; j++) {
    if (psi(j)) return true;
    if (!phi(j)) return false;
  }
  return false;
}

/**
 * 有界响应（bounded response）：q 发生的每个位置，k 步内必有 p 响应 ——
 * 「行动后 ≤k 步必须验证」这类服务级性质的直接表达。
 */
export function boundedResponse(p: TracePred, q: TracePred, n: number, k: number): boolean {
  for (let i = 0; i < n; i++) {
    if (!q(i)) continue;
    let responded = false;
    for (let j = i + 1; j <= Math.min(i + k, n - 1); j++) {
      if (p(j)) { responded = true; break; }
    }
    if (!responded) return false;
  }
  return true;
}

/** G φ 的违例位清单（判决书的逐位证据） */
export function violationsOf(p: TracePred, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (!p(i)) out.push(i);
  return out;
}

// ─── 行动日志上的 ReAct 形式性质（预铸性质库）───

/** 迹的最小投影：工具名 + 观察在场 + 效果证据 */
export interface TraceEntry {
  tool: string;
  /** 动作前是否携带观察（journal.observe 在场 = 最近有截图锚点） */
  observed?: boolean;
  /** 效果证据：true 验证生效 / false 验证无效 / undefined 未验证 */
  effect?: boolean;
}

export interface TraceProperty {
  id: string;
  /** 性质的 LTLf 表达（人类可读 —— 判决书的事实引用） */
  formula: string;
  description: string;
  /** 违例位置索引（空 = 性质成立） */
  violations: number[];
}

/**
 * ReAct 教义的性质化（纯函数）：三条铁律从提示词升格为可机检判据。
 *   blind-start      ：首动作前无观察 —— G(¬first∨observed) 的对偶违例
 *   observe-starve   ：连续 ≥4 动作无观察 —— 「先看后动」的有界响应缺口
 *   unverified-streak：连续 ≥4 验证无效 —— 盲区连击（效果回击世界而未被听见）
 */
export function reactTraceProperties(entries: readonly TraceEntry[]): TraceProperty[] {
  const n = entries.length;
  const observed = (i: number) => entries[i].observed === true;
  const failed = (i: number) => entries[i].effect === false;

  // blind-start：首个动作缺乏观察
  const blindStart: number[] = n > 0 && !observed(0) ? [0] : [];

  // observe-starve：滑窗找「连续 4 个动作均无观察」的窗口证据位
  const starve: number[] = [];
  for (let i = 0; i + 3 < n; i++) {
    if (!observed(i) && !observed(i + 1) && !observed(i + 2) && !observed(i + 3)) {
      starve.push(i);
    }
  }

  // unverified-streak：连续 4 个 effect===false（验证无效连击）
  const streak: number[] = [];
  for (let i = 0; i + 3 < n; i++) {
    if (failed(i) && failed(i + 1) && failed(i + 2) && failed(i + 3)) {
      streak.push(i);
    }
  }

  return [
    {
      id: 'blind-start',
      formula: 'observed(0)',
      description: 'First action must be preceded by an observation (ReAct: OBSERVE before ACT).',
      violations: blindStart,
    },
    {
      id: 'observe-starvation',
      formula: 'G(¬(¬obs ∧ X ¬obs ∧ XX ¬obs ∧ XXX ¬obs))',
      description: 'No window of 4 consecutive actions without any observation.',
      violations: starve,
    },
    {
      id: 'unverified-streak',
      formula: 'G(¬(fail ∧ X fail ∧ XX fail ∧ XXX fail))',
      description: 'No window of 4 consecutive verified-ineffective actions (blind persistence).',
      violations: streak,
    },
  ];
}

// ─── O 纪元（#23）：性质挖掘自动化 —— 从行动迹自动铸造时序不变量 ───

/** 挖掘产物：预铸库之外、数据自己长出来的性质 */
export interface MinedProperty extends TraceProperty {
  /** 支持度：性质获得证据的机会数（出现次数） */
  support: number;
  /** 置信度：履行率（挖掘门槛 = 满支持零反例，值恒 1 —— 诚实：挖掘只收铁律） */
  confidence: 1;
  /** 挖掘族：该性质来自哪类时序模式 */
  family: 'precedence' | 'bounded-response' | 'repeat-guard';
}

/** 挖掘门槛：少于 3 次机会的模式不立法（机会不足 ⇒ 修辞不是定律） */
export const MINE_MIN_SUPPORT = 3;

/**
 * 性质挖掘器（纯函数、确定性）：三族时序模式的自动铸造 ——
 *   bounded-response ：A 后（到迹末前的首次）B 出现 ≥3 次且从未落空 ⇒
 *                      立 G(A → F≤k B)（k = 历史最大间隔 —— 有界响应的数据定标）。
 *   precedence       ：有序对 (A→B) 配对 ≥3 次且 B 从未紧邻抢在 A 前 ⇒
 *                      立 G(¬B U A)（抢跑零例才立法）。
 *   repeat-guard     ：工具 T 有 ≥3 次自我紧邻机会且从未紧接自身 ⇒
 *                      立 G(T → X ¬T)（同签名连击零例）。
 * 立法门槛：support ≥ MINE_MIN_SUPPORT 且零反例 —— 挖掘只收铁律，弱模式
 * （如「90% 遵守」）如实不立（性质库是判据不是倾向表）。挖掘性质在本迹上
 * 恒成立（violations 空）；跨迹执法由消费方持性质查新迹。
 */
export function mineTraceProperties(entries: readonly TraceEntry[]): MinedProperty[] {
  const n = entries.length;
  const out: MinedProperty[] = [];
  if (n < MINE_MIN_SUPPORT) return out;

  // ── 工具对统计：A 之后首次 B（有界响应的响应语义）+ B 紧邻抢跑机会 ──
  const pairStats = new Map<string, { count: number; maxGap: number; preceded: number }>();
  for (let i = 0; i < n; i++) {
    const a = entries[i].tool;
    for (let j = i + 1; j < n; j++) {
      if (entries[j].tool === a) continue; // 自我不算响应对
      const key = `${a}→${entries[j].tool}`;
      let st = pairStats.get(key);
      if (!st) { st = { count: 0, maxGap: 0, preceded: 0 }; pairStats.set(key, st); }
      st.count += 1;
      st.maxGap = Math.max(st.maxGap, j - i);
      break; // 只记 A 之后首次 B
    }
  }
  // 抢跑机会：B 紧邻出现在 A 之前（对在场对 A→B 计数 —— 这是 precedence 的反例面）
  for (let j = 1; j < n; j++) {
    const b = entries[j - 1].tool, a = entries[j].tool;
    if (b === a) continue;
    const st = pairStats.get(`${a}→${b}`);
    if (st) st.preceded += 1;
  }
  for (const [key, st] of pairStats) {
    const [a, b] = key.split('→');
    if (st.count >= MINE_MIN_SUPPORT) {
      out.push({
        id: `mined-response[${key}]≤${st.maxGap}`,
        formula: `G(${a} → F≤${st.maxGap} ${b})`,
        description: `Mined bounded response: ${a} is historically always followed by ${b} within ${st.maxGap} step(s) — ${st.count} supports, 0 counterexamples.`,
        violations: [],
        support: st.count,
        confidence: 1,
        family: 'bounded-response',
      });
      if (st.preceded === 0) {
        out.push({
          id: `mined-precedence[${b}¬≪${a}]`,
          formula: `G(¬${b} U ${a})`,
          description: `Mined precedence: ${b} has never appeared immediately before ${a} — ${st.count} paired supports, 0 precedences.`,
          violations: [],
          support: st.count,
          confidence: 1,
          family: 'precedence',
        });
      }
    }
  }

  // ── repeat-guard：工具自我紧邻重复的零例立法 ──
  const selfRepeat = new Map<string, number>();
  const selfChances = new Map<string, number>();
  for (let i = 0; i + 1 < n; i++) {
    const t = entries[i].tool;
    selfChances.set(t, (selfChances.get(t) ?? 0) + 1);
    if (entries[i + 1].tool === t) selfRepeat.set(t, (selfRepeat.get(t) ?? 0) + 1);
  }
  for (const [tool, chances] of selfChances) {
    if (chances >= MINE_MIN_SUPPORT && !selfRepeat.has(tool)) {
      out.push({
        id: `mined-repeat-guard[${tool}]`,
        formula: `G(${tool} → X ¬${tool})`,
        description: `Mined repeat guard: ${tool} has never immediately repeated itself — ${chances} opportunities, 0 repeats.`,
        violations: [],
        support: chances,
        confidence: 1,
        family: 'repeat-guard',
      });
    }
  }

  return out;
}

// ─── S 纪元（S-5）：挖掘性质的在线执法器 —— mine→enforce 闭环 ───

/** 执法结果：性质在新迹上的违例位（空 = 性质仍成立） */
export interface MinedEnforcement {
  id: string;
  family: MinedProperty['family'];
  violations: number[];
}

/**
 * 挖掘性质执法器（纯函数）：对**新迹**逐性质检验。挖掘立法于历史，执法
 * 于未来 —— 性质库从描述统计升格为在线规约（违例 = 世界变了或立法过拟合，
 * 两者都该被看见）。
 *   bounded-response：每个 A 位后 k 步内须有 B
 *   precedence      ：首个 A 之前不得出现 B
 *   repeat-guard    ：T 不得紧接自身
 */
export function enforceMinedProperties(
  entries: readonly TraceEntry[],
  props: readonly MinedProperty[],
): MinedEnforcement[] {
  const tools = entries.map(e => e.tool);
  const out: MinedEnforcement[] = [];
  for (const p of props) {
    const violations: number[] = [];
    if (p.family === 'bounded-response') {
      // id 形如 mined-response[A→B]≤k —— 解析 A/B/k
      const m = /^mined-response\[(.+?)→(.+?)\]≤(\d+)$/.exec(p.id);
      if (m) {
        const [, a, b, kStr] = m;
        const k = Number(kStr);
        for (let i = 0; i < tools.length; i++) {
          if (tools[i] !== a) continue;
          let ok = false;
          for (let j = i + 1; j <= Math.min(i + k, tools.length - 1); j++) {
            if (tools[j] === b) { ok = true; break; }
          }
          if (!ok) violations.push(i);
        }
      }
    } else if (p.family === 'precedence') {
      // id 形如 mined-precedence[B¬≪A] —— 首个 A 前出现 B 即违例
      const m = /^mined-precedence\[(.+?)¬≪(.+?)\]$/.exec(p.id);
      if (m) {
        const [, b, a] = m;
        const firstA = tools.indexOf(a);
        if (firstA >= 0) {
          for (let i = 0; i < firstA; i++) if (tools[i] === b) violations.push(i);
        }
      }
    } else if (p.family === 'repeat-guard') {
      const m = /^mined-repeat-guard\[(.+?)\]$/.exec(p.id);
      if (m) {
        const t = m[1];
        for (let i = 0; i + 1 < tools.length; i++) {
          if (tools[i] === t && tools[i + 1] === t) violations.push(i);
        }
      }
    }
    out.push({ id: p.id, family: p.family, violations });
  }
  return out;
}
