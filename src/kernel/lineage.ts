// src/kernel/lineage.ts
// 纪元 Θ（Θ-2 参数血统）：内核参数的世代档案 —— 每次换血前对「现代」拍快照、
// 换血后立新一代；灭绝剪枝只留最近数代，全局适应度冠军例外存活。
//
// 制度先例（本模块一字致敬 src/skillLibrary.ts 的技能系谱，L248-258 / L491）：
//   · 世代 = 前代 + 1 —— 对应合成技能 generation = max(母体) + 1 的参数版；
//   · 灭绝剪枝 = skillLibrary 容量驱逐（survival 排序截断）的血统版：缺省只留
//     最近 5 代，但 **fitness 最高的一代例外存活** —— 对应「是活跃谱系祖先的
//     技能获得 1.5× 存续加成」：优良血统不随时间出局；
//   · 无需环守卫：血统是单链线性表（非 parents 多叉图），坏数据入账即被静默剔除。
// 纯内存、零 IO、零网络、全确定性 —— 血统是审计事实，不是缓存。
// 垃圾静默：一切入口对畸形入参不抛、不记（诚实下限：宁缺毋假）。

/** 一代参数的档案：值、亲代值（初代无亲）、适应度、出生时间。 */
export interface ParamGeneration {
  /** 参数键（与注册表 key 同一词表，非空字符串） */
  key: string;
  /** 世代号（promote 恒前代 + 1、初代 1；手动 record 可登记任意非负整数代） */
  generation: number;
  /** 本代值 */
  value: number;
  /** 亲代值（初代无亲 ⇒ undefined；promote 自动填） */
  parentValue?: number;
  /** 适应度（登记时刻该参数的 successRate —— 只记观测事实，不带探索奖励） */
  fitness: number;
  /** 出生（登记）时间戳（epoch ms） */
  createdAt: number;
}

/** extinct 的缺省保留代数：最近 5 代（记忆预算与审计深度的平衡点）。 */
export const LINEAGE_DEFAULT_KEEP = 5;

/** 诚实样本判据：key 非空串；世代为非负整数；value / fitness / createdAt 皆有限。 */
function isHonestGeneration(g: unknown): g is ParamGeneration {
  if (g === null || typeof g !== 'object') return false;
  const x = g as Partial<ParamGeneration>;
  return (
    typeof x.key === 'string' && x.key.length > 0 &&
    typeof x.generation === 'number' && Number.isInteger(x.generation) && x.generation >= 0 &&
    typeof x.value === 'number' && Number.isFinite(x.value) &&
    typeof x.fitness === 'number' && Number.isFinite(x.fitness) &&
    typeof x.createdAt === 'number' && Number.isFinite(x.createdAt)
  );
}

/**
 * 参数血统：key → 世代链。内部按插入序存链；对外一律防御副本 + createdAt 升序。
 * 「前代」的唯一定义：createdAt 最新的一代（与插入序一致 —— 本类自身只追加）。
 */
export class KernelLineage {
  /** key → 世代链（只进诚实样本） */
  private map = new Map<string, ParamGeneration[]>();

  /**
   * 登记一代（校准器在换血前对「现代」拍快照用）。
   * 垃圾静默（不抛、不记）；**同 key 同代原位覆盖**（快照重拍语义）。
   * 存防御副本：登记后外部改原对象不污染血统。
   */
  record(g: ParamGeneration): void {
    if (!isHonestGeneration(g)) return; // 垃圾静默：宁缺毋假
    const chain = this.map.get(g.key) ?? [];
    const copy: ParamGeneration = { ...g };
    const idx = chain.findIndex(x => x.generation === copy.generation);
    if (idx >= 0) chain[idx] = copy; // 同 key 同代覆盖
    else chain.push(copy);
    this.map.set(copy.key, chain);
  }

  /** 该 key 的全部世代（防御副本，createdAt 升序）；未知 key / 垃圾 key ⇒ 空数组。 */
  generations(key: string): ParamGeneration[] {
    const chain = typeof key === 'string' ? this.map.get(key) : undefined;
    if (!chain) return [];
    return chain.map(g => ({ ...g })).sort((a, b) => a.createdAt - b.createdAt);
  }

  /** 时间上最新的一代（promote 的「前代」）；无血统 ⇒ undefined。 */
  private latest(key: string): ParamGeneration | undefined {
    const gens = this.generations(key);
    return gens.length > 0 ? gens[gens.length - 1] : undefined;
  }

  /**
   * 推动新一代：generation = 前代 + 1、parentValue = 前代值；**无前代 ⇒ generation 1**。
   * now 提供且有限 ⇒ 用作 createdAt（确定性可测），否则 Date.now()。
   * 返回新一代档案。垃圾入参（key 空串 / value / fitness 非有限）：**不登记**，
   * 回一个不入血统的描述符（原样回显，零副作用 —— 调试线索，不是账目）。
   */
  promote(key: string, value: number, fitness: number, now?: number): ParamGeneration {
    const keyOk = typeof key === 'string' && key.length > 0;
    const prev = keyOk ? this.latest(key) : undefined;
    const entry: ParamGeneration = {
      key: keyOk ? key : '',
      generation: (prev?.generation ?? 0) + 1,
      value,
      parentValue: prev?.value,
      fitness,
      createdAt: typeof now === 'number' && Number.isFinite(now) ? now : Date.now(),
    };
    if (keyOk && Number.isFinite(value) && Number.isFinite(fitness)) {
      const chain = this.map.get(key) ?? [];
      chain.push(entry);
      this.map.set(key, chain);
    }
    return entry;
  }

  /**
   * 灭绝剪枝（缺省 keep=5）：只保留最近 keep 代（createdAt 升序的末 keep 条）；
   * 被剪者中**全局适应度冠军**例外存活 —— 等价于「fitness 最高的一代必活」
   * （冠军若已在幸存区、或与幸存者最高平票 ⇒ 无需豁免，不救第二条 ——
   * skillLibrary「谱系祖先存续加成」的血统直译）。keep 非法（NaN）按缺省；
   * keep < 1 按 1（**至少保 1 条**）。返回实际剪掉的代数；key 无血统 ⇒ 0。
   */
  extinct(key: string, keep: number = LINEAGE_DEFAULT_KEEP): number {
    const chain = typeof key === 'string' ? this.map.get(key) : undefined;
    if (!chain || chain.length === 0) return 0;
    const k = Math.max(1, Number.isFinite(keep) ? Math.floor(keep) : LINEAGE_DEFAULT_KEEP);
    if (chain.length <= k) return 0; // 全员存活
    const ordered = this.generations(key); // createdAt 升序防御副本
    const recent = ordered.slice(ordered.length - k);
    const pruned = ordered.slice(0, ordered.length - k);
    let champion: ParamGeneration | null = null;
    for (const g of pruned) {
      if (!champion || g.fitness > champion.fitness) champion = g;
    }
    if (champion) {
      const bestSurvivor = Math.max(...recent.map(g => g.fitness));
      if (!(champion.fitness > bestSurvivor)) champion = null; // 冠军已在幸存区
    }
    const survivors = champion ? [...recent, champion] : recent;
    survivors.sort((a, b) => a.createdAt - b.createdAt); // 重建后仍时间升序
    this.map.set(key, survivors);
    return ordered.length - survivors.length;
  }

  /**
   * 适应度趋势：在册世代 fitness 对等距世代序号的最小二乘斜率，经
   * trend = slope / (1 + |slope|) 饱和归一到 (−1, 1)（|斜率| 封顶 ⇒ 大斜率不爆表，
   * 方向与强度保序）。**<2 代 ⇒ 0**（无趋势可言 —— 诚实下限）；斜率非有限 ⇒ 0。
   */
  fitnessTrend(key: string): number {
    const gens = this.generations(key);
    if (gens.length < 2) return 0;
    const n = gens.length;
    const meanY = gens.reduce((s, g) => s + g.fitness, 0) / n;
    const meanX = (n - 1) / 2;
    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i++) {
      num += (i - meanX) * (gens[i].fitness - meanY);
      den += (i - meanX) ** 2;
    }
    if (den === 0 || !Number.isFinite(num)) return 0;
    const slope = num / den;
    if (!Number.isFinite(slope)) return 0;
    return Math.max(-1, Math.min(1, slope / (1 + Math.abs(slope))));
  }

  /** 清空全部血统（测试隔离 / 会话切换用）。 */
  reset(): void {
    this.map.clear();
  }
}
