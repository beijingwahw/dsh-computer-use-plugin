// src/skillLibrary.ts
// 第五轮创新之一：自进化技能库（Trajectory -> Skill）。
// 日志记录「做了什么」，重放能「再做一次」，但都缺一块：成功经验不会自动沉淀。
// 本模块把成功轨迹归纳为「技能」—— 带触发描述、入口场景指纹、可靠度统计的宏，
// 持久化到磁盘后跨会话存活：Agent 第一次学会你的工作流，第二次直接复用。
// 可靠度闭环：每次 run_skill 的成败回写 successCount/attemptCount，
// 匹配排序时「历史验证过的技能」天然优先 —— 越用越准的肌肉记忆。
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from 'fs';
import path from 'path';
import { journal } from './journal';
import { similarity } from './perceptualHash';
import { tokenize, overlapCoefficient } from './uiMemory';
import { embed, cosine, type SparseVector } from './semanticHash';
import { sequitur, expandSymbols } from './sequitur';

export interface SkillStep {
  tool: string;
  args: Record<string, any>;
}

/** C-2 基因片段：技能的可拆解单元。普通技能 = 单基因；重组技能 = 多基因链 */
export interface SkillGene {
  steps: SkillStep[];
  /** 该基因执行时的入口场景指纹 */
  entrySceneHash?: string;
  /** 该基因执行完毕后的离场场景指纹（基因链式拼接的依据：A.exit ≈ B.entry ⇒ 可拼接） */
  exitSceneHash?: string;
  /** 溯源：来自哪个母体技能（合成技能的族谱） */
  sourceSkillId?: number;
}

export interface Skill {
  id: number;
  name: string;                 // 短名（自动生成或模型指定）
  description: string;          // 触发描述：什么任务该用这个技能
  entrySceneHash?: string;      // 归纳时的入口场景指纹（同屏加成）
  steps: SkillStep[];
  successCount: number;
  attemptCount: number;
  createdAt: number;
  lastUsedAt: number;
  // ── C-2 概念技能图谱（全部可选：缺省即旧形态，磁盘 JSON 自动兼容） ──
  /** description 的缓存嵌入（induce/restore 时懒计算，匹配微秒级） */
  embedding?: SparseVector;
  /** DNA 分解（普通技能 = 单基因；缺省时按 steps 整体视为单基因） */
  genes?: SkillGene[];
  /** 重组合成标记：合成技能可靠度从谨慎起步（Laplace 先验天然处理） */
  synthesized?: boolean;
}

/** 可重放的工具白名单：click_element 依赖运行时元素缓存，不进技能 */
const REPLAYABLE = new Set([
  'click_mouse', 'type_text', 'scroll_page', 'press_hotkey',
  'drag_mouse', 'switch_tab', 'switch_window', 'dismiss_popup',
]);

const stepSignature = (steps: SkillStep[]): string =>
  steps.map(s => `${s.tool}:${JSON.stringify(s.args)}`).join('|');

// ─── E-2 基因组组装（第五维·信息热力学）：OLC 重叠对齐 ───

/** 单步签名（对齐原子）与序列签名（stepSignature 的切片版） */
const stepSig1 = (s: SkillStep): string => `${s.tool}:${JSON.stringify(s.args)}`;
const stepsSig = (ss: readonly SkillStep[]): string => ss.map(stepSig1).join('|');

/**
 * OLC（Overlap-Layout-Consensus）最长尾头重叠：求 merged 尾部与 next 头部的
 * 最长精确重叠 k（签名逐字节相等），返回 k。合成律：merged + next[k:] ——
 * 共享子序列只保留一份（基因组组装的 contig 缝合：粘性末端对齐后拼接）。
 * 保底约束：k ≤ next.length - 1（新基因必须贡献 ≥1 步新物质 —— 全包含基因
 * 是强化不是合成，走签名撞车路径）。精确匹配语义：确定性、可审计；
 * 模糊对齐（参数近似 + 场景指纹锚定）是留白。导出仅供测试（_forTest 先例）。
 */
export function olcOverlap(merged: readonly SkillStep[], next: readonly SkillStep[]): number {
  const maxK = Math.min(merged.length, next.length - 1);
  for (let k = maxK; k > 0; k--) {
    if (stepsSig(merged.slice(merged.length - k)) === stepsSig(next.slice(0, k))) return k;
  }
  return 0;
}

// ─── E-5 贝叶斯可靠度（Beta-Bernoulli 共轭后验）───

/** 后验可靠度：Beta(1,1) 均匀先验 + (s 胜 n 试) ⇒ Beta(s+1, n-s+1)。
 *  mean = (s+1)/(n+2) —— 与既有 Laplace 平滑逐字一致（零回归的结构保证）；
 *  hw = 1.96√(αβ/((α+β)²(α+β+1))) —— 95% 可信区间半宽，随证据量 n 收缩。
 *  导出纯函数：与 riskGate.matchesRiskPatterns 同律（数学原子的测试面）。 */
export function betaReliability(successCount: number, attemptCount: number): { mean: number; hw: number } {
  const alpha = successCount + 1;
  const beta = attemptCount - successCount + 1;
  const mean = alpha / (alpha + beta);
  const hw = 1.96 * Math.sqrt((alpha * beta) / ((alpha + beta) ** 2 * (alpha + beta + 1)));
  return { mean, hw };
}

/** 递归键排序的稳定字符串化：replacer 数组只在顶层过滤键、嵌套对象的键
 *  会被整层丢弃（JSON.stringify({a:{x:1}}, ['a']) → {"a":{}}）——
 *  drag_mouse 这类嵌套 args 会全部坍缩成同一符号。排序保证键序无关性。 */
function canonicalStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    const keys = Object.keys(v as Record<string, unknown>).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalStringify((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/** F-1 符号化：args → 稳定短哈希（FNV-1a —— semanticHash 同源密码学原语） */
function hashArgs(args: Record<string, any>): string {
  let h = 0x811c9dc5;
  const s = canonicalStringify(args);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

// ─── G-3 模糊量化文法归纳（第七维·过程感知）───

/** 量化网格：数值参数按 0.05 网格取整（坐标抖动 <0.025 ⇒ 同符号）。
 *  动机：同一工作流重做时坐标总有微差（0.50 vs 0.52）—— 精确签名下 SEQUITUR
 *  看不见重复。量化等价类让「同一个按钮，稍微偏一点」仍归同一符号。
 *  仅用于 mineMotifs（建议性）；OLC 重组合成（E-2）保持精确 ——
 *  建议可模糊，执行必须精确。 */
const MOTIF_QUANT = 0.05;

/** 深层数值量化（递归；数组与嵌套对象同律）—— 模糊符号化的铸造点 */
function quantizeArgs(v: unknown): unknown {
  if (typeof v === 'number' && Number.isFinite(v)) {
    return Math.round(v / MOTIF_QUANT) * MOTIF_QUANT;
  }
  if (Array.isArray(v)) return v.map(quantizeArgs);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = quantizeArgs((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

/** 模糊符号：量化后的 args 哈希（mineMotifs 专用） */
function hashArgsFuzzy(args: Record<string, any>): string {
  return hashArgs(quantizeArgs(args) as Record<string, any>);
}

class SkillLibrary {
  private skills: Skill[] = [];
  private nextId = 1;
  private enabled = true;
  private filePath = '';
  private capacity = 50;
  private nextSynthId = 1;        // C-2：合成技能发号器（syn-N 命名，跨会话不冲突）

  configure(enabled: boolean, filePath: string, capacity = 50): void {
    this.enabled = enabled;
    this.filePath = filePath;
    this.capacity = capacity;
  }

  /** 从磁盘载入（跨会话学习的关键）。文件损坏/不存在 ⇒ 从空库开始，不致命 */
  load(): void {
    if (!this.filePath || !existsSync(this.filePath)) return;
    try {
      const data = JSON.parse(readFileSync(this.filePath, 'utf8'));
      if (Array.isArray(data.skills)) {
        this.skills = data.skills;
        // J 纪元修正（nextId 撞号）：历史档案经历过容量驱逐后 ids 稀疏，
        // `length + 1` 可能小于 max(id)+1 ⇒ 新技能撞旧 id。取两者最大值。
        const maxId = this.skills.reduce((m, s) => Math.max(m, Number(s.id) || 0), 0);
        this.nextId = Math.max(data.nextId ?? 0, maxId + 1);
        this.nextSynthId = data.nextSynthId ?? this.nextSynthId;
      }
      console.log(`[Skill] Loaded ${this.skills.length} skill(s) from ${this.filePath}`);
    } catch (e: any) {
      console.warn(`[Skill] Load failed (${e.message}); starting with empty library.`);
    }
  }

  /**
   * C-2 原子落盘（工程约束兑现）：tmp + rename —— 合成过程中崩溃 ⇒ 磁盘永远是完整旧库。
   * 与 checkpoint.ts 的 saveCheckpoint 同一原子写律。
   */
  save(): void {
    if (!this.filePath) return;
    const tmp = this.filePath + '.tmp';
    try {
      mkdirSync(path.dirname(this.filePath), { recursive: true });
      writeFileSync(tmp, JSON.stringify({ skills: this.skills, nextId: this.nextId, nextSynthId: this.nextSynthId }, null, 2), 'utf8');
      renameSync(tmp, this.filePath); // 原子换名：要么完整旧档，要么完整新档，绝无半档
    } catch (e: any) {
      try { unlinkSync(tmp); } catch { /* tmp 可能未创建 */ }
      console.warn(`[Skill] Save failed: ${e.message}`);
    }
  }

  /** 插件卸载：仅清内存，磁盘保留 —— 技能的寿命长于会话 */
  reset(): void {
    this.skills = [];
  }

  /**
   * 归纳技能。签名去重：完全相同的步骤序列不重复建卡，只 bump 可靠度 ——
   * 同一工作流做三遍 = 一个技能验证三次，而非三张卡。
   * C-2：归纳时缓存语义嵌入 + 默认单基因化（steps 整体为一个 DNA 片段）。
   */
  induce(description: string, steps: SkillStep[], entrySceneHash?: string, exitSceneHash?: string): Skill | null {
    if (!this.enabled || steps.length === 0) return null;
    const sig = stepSignature(steps);
    const existing = this.skills.find(s => stepSignature(s.steps) === sig);
    if (existing) {
      existing.attemptCount++;
      existing.successCount++;
      existing.lastUsedAt = Date.now();
      existing.description = description || existing.description;
      this.save();
      return existing;
    }

    const skill: Skill = {
      id: this.nextId++,
      name: `skill-${this.nextId - 1}`,
      description,
      entrySceneHash,
      steps,
      successCount: 1,
      attemptCount: 1,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      // C-2：嵌入缓存 + 单基因（整个轨迹一个片段；未来可按场景断点细拆）
      embedding: embed(description || sig),
      genes: [{ steps, entrySceneHash, exitSceneHash }],
    };
    this.skills.push(skill);

    // 容量驱逐：可靠度 × 新近度 综合最低者出局
    if (this.skills.length > this.capacity) {
      const now = Date.now();
      this.skills.sort((a, b) =>
        ((b.successCount / b.attemptCount) * Math.exp(-(now - b.lastUsedAt) / 7_200_000)) -
        ((a.successCount / a.attemptCount) * Math.exp(-(now - a.lastUsedAt) / 7_200_000)));
      this.skills = this.skills.slice(0, this.capacity);
    }
    this.save();
    return skill;
  }

  /** 从日志归纳：取最近一次 markTaskStart 之后的可重放动作 */
  induceFromJournal(description: string, entrySceneHash?: string): Skill | null {
    const steps = journal.sinceTaskStart()
      .filter(e => REPLAYABLE.has(e.tool))
      .map(e => ({ tool: e.tool, args: e.args ?? {} }));
    return this.induce(description, steps, entrySceneHash);
  }

  /**
   * F-1 文法归纳动机挖掘（压缩即学习）：对行动日志跑 SEQUITUR 文法归纳，
   * 重复 ≥minUsage 次的规则（子序列）即「行为中重复着自己却未被固化的技能」。
   * 与 induceFromJournal 的分工：后者只切任务边界内的整段轨迹；本方法发现
   * 跨任务重复的子序列动机（MDL：能被短文法压缩的部分就是结构）。
   * 消费方：match_skill 落空时提示「日志里已重复 N 次的序列可 save_skill 固化」。
   * 预算：maxSteps 上限（O(n²) 批处理文法归纳的诚实护栏）；零重复 ⇒ 空数组。
   */
  mineMotifs(minUsage = 2, minLength = 2, maxMotifs = 3, maxSteps = 400):
    Array<{ steps: SkillStep[]; usage: number; motifLength: number }> {
    if (!this.enabled) return [];
    const entries = journal.list(true).slice(-maxSteps);
    if (entries.length < minLength * minUsage) return [];
    // 符号化：G-3 模糊量化（tool#fnv(quantized-args)）—— 坐标抖动 <0.025 归同符号；
    // 同一工作流重做时总有微差，精确签名会漏掉全部重复（量化等价类 = 抖动容忍）
    const dict = new Map<string, SkillStep>();
    const seq: string[] = [];
    for (const e of entries) {
      const sym = `${e.tool}#${hashArgsFuzzy(e.args ?? {})}`;
      if (!dict.has(sym)) dict.set(sym, { tool: e.tool, args: e.args ?? {} });
      seq.push(sym);
    }
    const grammar = sequitur(seq);
    const motifs: Array<{ steps: SkillStep[]; usage: number; motifLength: number }> = [];
    for (const rule of grammar.rules.values()) {
      if (rule.usage < minUsage || rule.expandedLength < minLength) continue;
      // 解码：规则体展开回叶符号 → 步骤序列
      const syms = expandSymbols(grammar, rule.symbols);
      const steps = syms.map(s => dict.get(s)).filter((x): x is SkillStep => x !== undefined);
      if (steps.length === syms.length && steps.length >= minLength) {
        motifs.push({ steps, usage: rule.usage, motifLength: steps.length });
      }
    }
    // 最长且最常重复的动机优先（信息量 = 长度 × 重复度的乘积排序）
    return motifs
      .sort((x, y) => (y.motifLength * y.usage) - (x.motifLength * x.usage))
      .slice(0, maxMotifs);
  }

  /**
   * 匹配：文本重合 + 可靠度 + 入口场景同屏加成 + 新近度。
   * C-2 语义泛化：文本项取 max(overlap, semanticCosine) ——
   *   精确匹配零回归（overlap 主导）；「整理数据」经向量命中「筛选数据」（零样本泛化）。
   */
  match(query: string, currentSceneHash?: string, k = 3): Array<Skill & { score: number }> {
    const q = tokenize(query);
    const qVec = embed(query);
    const now = Date.now();
    return this.skills
      .map(s => {
        const overlap = overlapCoefficient(q, tokenize(s.description));
        // 懒嵌入：旧档技能无 embedding 时现场补算（restore 后首次匹配付一次微秒级成本）
        const vec = s.embedding ?? embed(s.description || stepSignature(s.steps));
        if (!s.embedding) s.embedding = vec;
        const semantic = cosine(qVec, vec);
        const text = Math.max(overlap, semantic);
        // E-5 贝叶斯可靠度：Beta(1,1) 后验均值（= Laplace 平滑，逐字一致 —— 零回归）
        // − 0.1 × 95% CI 半宽（不确定度折扣：同均值下证据多者胜 —— 「8/12 的老技能」
        // 排在「0/0 的新直觉」之前，因为后者可能只是运气）。0.1 是算法形状字面量：
        // 折扣只做同均值平票的裁决者，绝不做主排序信号。
        const post = betaReliability(s.successCount, s.attemptCount);
        const reliability = post.mean - 0.1 * post.hw;
        let scene = 0;
        if (currentSceneHash && s.entrySceneHash && similarity(currentSceneHash, s.entrySceneHash) >= 0.9) {
          scene = 0.3;
        }
        const ageH = (now - s.lastUsedAt) / 3_600_000;
        const recency = 0.1 * Math.exp(-ageH / 72);
        return {
          ...s, score: Math.round((text + 0.3 * reliability + scene + recency) * 1000) / 1000,
          // C-2 归因：命中通道对模型透明。overlap>=0.5 才算真正词面命中；
          // 零星共享字（CJK 单字/二元组）是子词噪声，此时排序信号实为语义向量。
          matched_via: overlap >= 0.5 && overlap >= semantic ? 'exact-tokens' : 'semantic-vector',
          // E-5 透明面：后验均值 + 95% 可信区间（模型看得见「可靠度 0.67±0.46」
          // 与「0.67±0.09」的区别 —— 不确定性与结论同等可见，决策才有质地）
          posterior_mean: Math.round(post.mean * 1000) / 1000,
          ci95: [
            Math.max(0, Math.round((post.mean - post.hw) * 1000) / 1000),
            Math.min(1, Math.round((post.mean + post.hw) * 1000) / 1000),
          ],
          // G-5 Pareto 轴（内部暂存，判定后剥离）：三目标各自合法但互相冲突，
          // 加权和排序是仲裁 —— 非支配标注让模型看见「为什么是它」的另一面
          _axes: { text, rel: post.mean, rec: recency },
        } as Skill & { score: number; matched_via: string };
      })
      .filter(s => s.score > 0.15)
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      // G-5 非支配标注：A 支配 B ⇔ 三轴全 ≥ 且至少一轴 >。非支配者标
      // pareto_optimal —— 「没有任何别的候选在所有维度都不差于它且有一维更好」。
      // 两遍式（先全量判支配，后全量剥离轴）—— 单遍变异会破坏后续判读
      .map((hit, _i, all) => {
        const axesA = (hit as any)._axes;
        const dominated = all.some(other => {
          if (other === hit) return false;
          const axesB = (other as any)._axes;
          // 轴名对齐 _axes 的 { text, rel, rec } —— 此前误写 axesA.recency
          // （undefined），比较恒 false 导致 pareto_optimal 恒 true
          const ge = axesB.text >= axesA.text && axesB.rel >= axesA.rel && axesB.rec >= axesA.rec;
          const gt = axesB.text > axesA.text || axesB.rel > axesA.rel || axesB.rec > axesA.rec;
          return ge && gt;
        });
        return { hit, dominated };
      })
      .map(({ hit, dominated }) => {
        delete (hit as any)._axes;
        return { ...hit, pareto_optimal: !dominated };
      });
  }

  /**
   * C-2 DNA 重组引擎：从既有技能的基因链中实时合成新技能。
   * 拼接律：基因 A 的离场指纹 ≈ 基因 B 的入场指纹（dHash 相似度 ≥ 0.85）⇒ 可链式拼接；
   * 或语义相邻（查询向量同时高余弦命中两母体技能）⇒ 按匹配序拼接。
   * 合成技能 synthesized=true：成功 0/尝试 0，Laplace 先验 1/2 —— 谨慎起步，用一次校准一次。
   * 原子性：合成 → 内存登记 → save() 原子落盘，中途崩溃磁盘保持完整旧库。
   */
  recombine(query: string, currentSceneHash?: string): { skill: Skill | null; plan: Array<{ skillId: number; geneIndex: number; reason: string }> } {
    if (!this.enabled) return { skill: null, plan: [] };
    // 候选母体：语义 top-k（k=4 —— 太少没得拼，太多拼出长蛇）
    const candidates = this.match(query, currentSceneHash, 4).filter(c => c.score > 0.25);
    if (candidates.length < 2) return { skill: null, plan: [] };

    const plan: Array<{ skillId: number; geneIndex: 0; reason: string }> = [];
    const genes: SkillGene[] = [];
    const chain: Array<Skill & { score: number }> = [];

    // 贪心链式拼接：从最强候选出发，尝试把后续基因接到链尾
    for (const cand of candidates) {
      const gene = cand.genes?.[0];
      if (!gene || gene.steps.length === 0) continue;
      const tail = chain[chain.length - 1];
      // 拼接判据：首基因无条件入链；后续基因需 指纹衔接 或 语义相邻
      if (!tail) {
        chain.push(cand);
        genes.push({ ...gene, sourceSkillId: cand.id });
        plan.push({ skillId: cand.id, geneIndex: 0, reason: `best match (score ${cand.score})` });
        continue;
      }
      const tailExit = tail.genes?.at(-1)?.exitSceneHash;
      const fingerprintLink = tailExit && gene.entrySceneHash
        && similarity(tailExit, gene.entrySceneHash) >= 0.85;
      const semanticLink = cand.score > 0.3; // 语义相邻阈值：两母体都与查询强相关
      if (fingerprintLink || semanticLink) {
        chain.push(cand);
        genes.push({ ...gene, sourceSkillId: cand.id });
        plan.push({
          skillId: cand.id, geneIndex: 0,
          reason: fingerprintLink
            ? 'exit→entry scene fingerprint linked'
            : `semantically adjacent (score ${cand.score})`,
        });
      }
    }

    if (genes.length < 2) return { skill: null, plan: [] }; // 单基因 = 已有技能，无需合成

    // 合成步骤 = E-2 OLC 重叠布局：逐基因折叠，尾头最长精确重叠缝合（共享子序列
    // 只保留一份）。旧「相邻重复步骤剪除」是本对齐的 k=1 特例 —— 被最长重叠自然包含。
    const merged: SkillStep[] = [];
    const splices: number[] = [];
    for (const g of genes) {
      const k = merged.length > 0 ? olcOverlap(merged, g.steps) : 0;
      splices.push(k);
      for (const st of g.steps.slice(k)) merged.push(st);
    }
    // 族谱透明：每个接缝的重叠长度写进 plan 的归因（审计可回放 —— 白盒合成）
    plan.forEach((p, i) => {
      if (i > 0 && splices[i] > 0) {
        p.reason += `; OLC spliced ${splices[i]} overlapping step(s)`;
      }
    });
    const sig = stepSignature(merged);
    const existing = this.skills.find(s => stepSignature(s.steps) === sig);
    // J 纪元修正：注释宣称"撞已有技能 = 强化"，旧实现直接 return 不 bump 计数 ——
    // 所谓强化并不发生。对齐 induce 的去重路径（attemptCount/successCount/lastUsedAt）。
    if (existing) {
      existing.attemptCount++;
      existing.successCount++;
      existing.lastUsedAt = Date.now();
      return { skill: existing, plan };
    }

    const skill: Skill = {
      id: this.nextId++,
      name: `syn-${this.nextSynthId++}`,
      description: query, // 合成技能的触发描述 = 原始查询（下次同型任务直接命中）
      entrySceneHash: genes[0].entrySceneHash,
      steps: merged,
      successCount: 0,
      attemptCount: 0,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      embedding: embed(query),
      genes,
      synthesized: true,
    };
    this.skills.push(skill);
    this.save(); // 原子落盘：合成中途崩溃 ⇒ 磁盘保持完整旧库
    return { skill, plan };
  }

  /** 执行结果回写：技能的可靠度随真实使用持续校准 */
  recordOutcome(id: number, success: boolean): void {
    const s = this.skills.find(x => x.id === id);
    if (!s) return;
    s.attemptCount++;
    if (success) s.successCount++;
    s.lastUsedAt = Date.now();
    this.save();
  }

  get(id: number): Skill | undefined {
    return this.skills.find(x => x.id === id);
  }

  /** checkpoint 序列化：与磁盘 JSON 同构（skills + 发号器进度） */
  /** checkpoint 序列化 —— J 纪元修正：补齐 nextSynthId（磁盘 save 有、
   *  快照没有 ⇒ 崩溃恢复后合成技能重复命名 syn-1，模型可见面撞名）。 */
  dump(): { skills: Skill[]; nextId: number; nextSynthId: number } {
    return { skills: this.skills, nextId: this.nextId, nextSynthId: this.nextSynthId };
  }

  restore(data: { skills?: Skill[]; nextId?: number; nextSynthId?: number } | undefined): void {
    if (!data?.skills) return;
    this.skills = data.skills;
    // 同 load 的撞号防线：ids 稀疏档案下 at(-1).id+1 不保证大于 max(id)+1
    const maxId = this.skills.reduce((m, s) => Math.max(m, Number(s.id) || 0), 0);
    this.nextId = Math.max(data.nextId ?? 0, (this.skills.at(-1)?.id ?? 0) + 1, maxId + 1);
    this.nextSynthId = data.nextSynthId ?? this.nextSynthId;
  }

  list(): Skill[] {
    return [...this.skills].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  }
}

export const skillLibrary = new SkillLibrary();
