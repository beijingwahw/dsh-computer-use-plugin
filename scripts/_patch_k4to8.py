# K-4..K-8 patcher
import io

def patch(path, pairs):
    s = io.open(path, encoding='utf-8').read()
    for old, new in pairs:
        assert old in s, (path, old[:70])
        s = s.replace(old, new, 1)
    io.open(path, 'w', encoding='utf-8', newline='\n').write(s)
    print('patched', path)

# ── K-4：贝叶斯会诊皮层（精确枚举推断的小型离散网络）──
patch('src/diagnosis.ts', [(
"/** 会诊输入：各引擎的标准化信号（全部可缺席 —— 缺席不参与规则） */",
"""// ─── K 纪元（留白兑现之四）：贝叶斯会诊 —— 规则表的概率侧写 ───
// 设计立场：确定性规则表仍是**主诊断**（可审计、可回放）；本网络提供的是
// 「证据组合的信念侧写」—— 六症候群后验（均匀先验 × 专家 CPT，精确枚举
// 归一，零近似、零采样、确定性）。无训练数据时 CPT 是专家律；值即边界。

/** 信号 → 布尔视图（缺席 = 不参与似然） */
interface BinarySignals {
  shifted: boolean | null;   // CUSUM 告警在场
  hurstHigh: boolean | null; // H > 0.6
  loop: boolean | null;      // 行为近周期判据
  heavyTail: boolean | null; // GPD ξ≥0.25
  highNoop: boolean | null;  // noop 洞见在场
}

type SyndromeId =
  'shift-and-cluster' | 'regime-shift' | 'deterministic-loop'
  | 'failure-clustering' | 'blind-clicking' | 'stall-regime';

/**
 * 专家 CPT：P(signal=on | syndrome)。行 = 症候群，列 = [shifted, hurstHigh,
 * loop, heavyTail, highNoop]。0.5 = 该症候群对此信号无主张（中性似然）。
 */
const BN_CPT: Record<SyndromeId, [number, number, number, number, number]> = {
  'shift-and-cluster':   [0.90, 0.85, 0.20, 0.30, 0.30],
  'regime-shift':        [0.85, 0.30, 0.20, 0.25, 0.35],
  'deterministic-loop':  [0.15, 0.35, 0.90, 0.10, 0.45],
  'failure-clustering':  [0.20, 0.90, 0.30, 0.25, 0.30],
  'blind-clicking':      [0.10, 0.20, 0.25, 0.10, 0.92],
  'stall-regime':        [0.20, 0.25, 0.10, 0.90, 0.25],
};
const BN_SIGNAL_KEYS: Array<keyof BinarySignals> = ['shifted', 'hurstHigh', 'loop', 'heavyTail', 'highNoop'];

export interface BayesianBelief {
  syndrome: SyndromeId;
  /** 后验概率（三位置小数；全表和 = 1 —— 枚举精确归一） */
  posterior: number;
}

/**
 * 贝叶斯会诊（纯函数、确定性）：六症候群后验。
 * 输入信号全缺席 / 全 false ⇒ null（健康是诚实的缺席，不硬造分布）。
 * 消费方：get_metrics 在规则诊断之外附加 belief 块 —— 「首中即断」给处方，
 * 信念表给**证据组合的全景**（包括未被规则命中的竞争假设）。
 */
export function bayesianBelief(signals: BinarySignals): BayesianBelief[] | null {
  const observed = BN_SIGNAL_KEYS.filter(k => signals[k] !== null);
  if (observed.length === 0) return null;
  if (observed.every(k => signals[k] === false)) return null;

  const logLike: Array<{ s: SyndromeId; ll: number }> = [];
  for (const s of Object.keys(BN_CPT) as SyndromeId[]) {
    let ll = Math.log(1 / 6); // 均匀先验
    BN_SIGNAL_KEYS.forEach((k, i) => {
      const v = signals[k];
      if (v === null) return; // 缺席不参与似然（missing-at-random 的最小假设）
      const pOn = BN_CPT[s][i];
      ll += Math.log(v ? pOn : 1 - pOn);
    });
    logLike.push({ s, ll });
  }
  // log-sum-exp 归一（数值稳定；六假设直接枚举 —— 无需近似）
  const m = Math.max(...logLike.map(x => x.ll));
  const ws = logLike.map(x => Math.exp(x.ll - m));
  const z = ws.reduce((a, b) => a + b, 0);
  return logLike
    .map((x, i) => ({ syndrome: x.s, posterior: Math.round((ws[i] / z) * 1000) / 1000 }))
    .sort((a, b) => b.posterior - a.posterior);
}

/** 会诊输入：各引擎的标准化信号（全部可缺席 —— 缺席不参与规则） */"""
)])

# get_metrics 接线：belief 附加（找到 diagnose( 调用后插一行 + 输出对象加字段）
s = io.open('src/tools/observabilityTools.ts', encoding='utf-8').read()
anchor = "      const dx = diagnose({"
assert anchor in s
# 读完整个调用块再定注入点 —— 简化：在 dx 判空处附加 belief（需看上下文行）
io.open('src/tools/observabilityTools.ts', 'w', encoding='utf-8', newline='\n').write(s)
print('diagnosis BN added (wiring next)')

# ── K-5：SSD 二阶随机占优（交叉分布的可判域）──
patch('src/telemetry.ts', [(
"""  static firstOrderStochasticDominance(samplesA: readonly number[], samplesB: readonly number[]):'A' | 'B' | 'none' {""",
"""  /**
   * K 纪元（留白兑现之五）：二阶随机占优 SSD —— FSD 交叉分布的可判域。
   * 成本语义（越小越好）：A SSD B ⇔ 一切阈值 t 上 A 的下偏矩 Σ(aᵢ−t)⁺ ≤ B 的
   * （A 的"坏尾累积"处处不更重）。FSD 全序交叉时（如 [10,50] vs [20,30]），
   * SSD 仍可裁决一致性偏好 —— 部分序留白由此兑现（全序 FSD ⊂ SSD）。
   */
  static secondOrderStochasticDominance(samplesA: readonly number[], samplesB: readonly number[]):
    'A' | 'B' | 'none' {
    if (samplesA.length === 0 || samplesB.length === 0) return 'none';
    const lpm = (s: readonly number[], t: number): number =>
      s.reduce((acc, v) => acc + Math.max(0, v - t), 0) / s.length;
    const pts = [...new Set([...samplesA, ...samplesB])].sort((x, y) => x - y);
    let aDom = true, bDom = true, strict = false;
    for (const t of pts) {
      const la = lpm(samplesA, t), lb = lpm(samplesB, t);
      if (la > lb + 1e-12) aDom = false;
      if (lb > la + 1e-12) bDom = false;
      if (Math.abs(la - lb) > 1e-12) strict = true;
      if (!aDom && !bDom) return 'none';
    }
    if (strict && aDom) return 'A';
    if (strict && bDom) return 'B';
    return 'none';
  }

  /** K 纪元：可播种 RNG（mulberry32）—— Monte Carlo p 值可复现（生产默认仍是 Math.random） */
  static seededUniform(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  static firstOrderStochasticDominance(samplesA: readonly number[], samplesB: readonly number[]):'A' | 'B' | 'none' {"""
)])

# dominance pairs 附加 ssd 判定
patch('src/telemetry.ts', [(
"""    const out: Array<{ faster: string; slower: string }> = [];
    for (let i = 0; i < cands.length; i++) {
      for (let j = i + 1; j < cands.length; j++) {
        const dom = Telemetry.firstOrderStochasticDominance(cands[i].lat, cands[j].lat);
        if (dom === 'A') out.push({ faster: cands[i].tool, slower: cands[j].tool });
        else if (dom === 'B') out.push({ faster: cands[j].tool, slower: cands[i].tool });
      }
    }
    return out;""",
"""    const out: Array<{ faster: string; slower: string; order: 'FSD' | 'SSD' }> = [];
    for (let i = 0; i < cands.length; i++) {
      for (let j = i + 1; j < cands.length; j++) {
        const dom = Telemetry.firstOrderStochasticDominance(cands[i].lat, cands[j].lat);
        if (dom === 'A') { out.push({ faster: cands[i].tool, slower: cands[j].tool, order: 'FSD' }); continue; }
        if (dom === 'B') { out.push({ faster: cands[j].tool, slower: cands[i].tool, order: 'FSD' }); continue; }
        // K 纪元：FSD 交叉 ⇒ SSD 兜底裁决（一致性偏好）
        const ssd = Telemetry.secondOrderStochasticDominance(cands[i].lat, cands[j].lat);
        if (ssd === 'A') out.push({ faster: cands[i].tool, slower: cands[j].tool, order: 'SSD' });
        else if (ssd === 'B') out.push({ faster: cands[j].tool, slower: cands[i].tool, order: 'SSD' });
      }
    }
    return out;"""
)])

# ── K-6：同形字归一（confusable → ASCII）──
patch('src/riskGate.ts', [(
"function normalizeForRisk(s: string): string {\n  let out = '';\n  for (const ch of s.toLowerCase()) {\n    if (LEET_MAP[ch] !== undefined) { out += LEET_MAP[ch]; continue; }",
"""// K 纪元（留白兑现之六）：同形字（homoglyph）归一 —— E-6 留白的兑现。
// 策领图（Unicode confusables 的策展子集，覆盖攻击面最广的三族）：
//   西里尔/希腊视觉同形 → 拉丁；全角字母数字 → 半角。完整 consortium 表
//   数千条 —— 策展 ~50 条是"值即边界"（新增条目零风险，纯数据扩展）。
const HOMOGLYPH_MAP: Record<string, string> = {
  // 西里尔（视觉同形拉丁）
  '\\u0430': 'a', '\\u0435': 'e', '\\u043e': 'o', '\\u0441': 'c', '\\u0440': 'p',
  '\\u0445': 'x', '\\u0443': 'y', '\\u0456': 'i', '\\u0455': 's', '\\u04bb': 'h',
  '\\u0501': 'd', '\\u0497': 'g', '\\u04cf': 'l', '\\u04bb': 'h', '\\u04e3': 'm',
  '\\u0439': 'u', '\\u0458': 'j', '\\u0463': 'y', '\\u051b': 'q', '\\u04cf': 'l',
  // 希腊
  '\\u03b1': 'a', '\\u03bf': 'o', '\\u03c1': 'p', '\\u03b5': 'e', '\\u03b9': 'i',
  '\\u03ba': 'k', '\\u03bc': 'm', '\\u03bd': 'v', '\\u03c4': 't', '\\u03c7': 'x',
  // 全角字母数字（FF01-FF5E 区段策展）
  '\\uff41': 'a', '\\uff42': 'b', '\\uff43': 'c', '\\uff44': 'd', '\\uff45': 'e',
  '\\uff46': 'f', '\\uff47': 'g', '\\uff48': 'h', '\\uff49': 'i', '\\uff4a': 'j',
  '\\uff4b': 'k', '\\uff4c': 'l', '\\uff4d': 'm', '\\uff4e': 'n', '\\uff4f': 'o',
  '\\uff50': 'p', '\\uff51': 'q', '\\uff52': 'r', '\\uff53': 's', '\\uff54': 't',
  '\\uff55': 'u', '\\uff56': 'v', '\\uff57': 'w', '\\uff58': 'x', '\\uff59': 'y', '\\uff5a': 'z',
  '\\uff10': '0', '\\uff11': '1', '\\uff12': '2', '\\uff13': '3', '\\uff14': '4',
  '\\uff15': '5', '\\uff16': '6', '\\uff17': '7', '\\uff18': '8', '\\uff19': '9',
};

function normalizeForRisk(s: string): string {
  let out = '';
  for (const ch of s.toLowerCase()) {
    if (LEET_MAP[ch] !== undefined) { out += LEET_MAP[ch]; continue; }
    if (HOMOGLYPH_MAP[ch] !== undefined) { out += HOMOGLYPH_MAP[ch]; continue; }"""
)])

# ── K-7：噪声容忍循环检测（E-3 留白兑现）──
patch('src/oscillationTracker.ts', [(
"""// 诚实边界：精确匹配语义 —— 中途插入一帧噪声即断尾（对噪声不鲁棒）；
// 量化指纹（如 4 位格雷码桶）上的模糊循环检测是留白，值即边界。
const RING_SIZE = 12;   // 3 × 最大周期 4：容纳三份完整周期块的观测窗
const MAX_PERIOD = 4;

const ring: string[] = [];

/** 尾部 3p 帧是否构成 p-周期循环（残差类内全等 ⇒ 自相关满秩） */
function isPCycle(w: string[], p: number): boolean {
  if (w.length < 3 * p) return false;
  const tail = w.slice(w.length - 3 * p);
  for (let i = 0; i + p < tail.length; i++) {
    if (tail[i] !== tail[i + p]) return false;
  }
  return true;
}""",
"""// K 纪元（留白兑现之七）：噪声容忍循环检测 —— 从精确匹配升级为**汉明容差**
// 匹配（dHash 抖动 ≤ FUZZ_TOL 位视为"同一场景"；精确匹配即容差 0 的特例）。
// 动机（原诚实边界）：中途一帧噪声（光标闪烁/轻微动画）即断尾 —— 检测器对
// 真实 UI 的微小变化过度敏感。容差取 6/64 位：远小于场景切换（≥24 位），
// 足以吸收采集噪声 —— 阈值与 subconsciousMatchDistance（既视感）同律。
const RING_SIZE = 12;   // 3 × 最大周期 4：容纳三份完整周期块的观测窗
const MAX_PERIOD = 4;
const FUZZ_TOL = 6;     // 64 位指纹的容差位（同律阈值：既视感 6 / 场景切换 ≥24）

const ring: string[] = [];

/** 逐位汉明距离（等长二进制指纹；长度不等 ⇒ 最大距离，绝不假装可比） */
function hamming(a: string, b: string): number {
  if (a.length !== b.length) return Math.max(a.length, b.length);
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

/** 尾部 3p 帧是否构成 p-周期循环（残差类内逐对距离 ≤ 容差 ⇒ 模糊自相关满秩） */
function isPCycle(w: string[], p: number): boolean {
  if (w.length < 3 * p) return false;
  const tail = w.slice(w.length - 3 * p);
  for (let i = 0; i + p < tail.length; i++) {
    if (hamming(tail[i], tail[i + p]) > FUZZ_TOL) return false;
  }
  return true;
}"""
)])
print('K-4..K-7 patched (K-4 wiring pending)')
