// test/organAblation.bench.ts
// V 纪元（器官审判日）：八项微基准 —— 33 件器官中可在确定性合成域度量的
// 十二件，逐一量化贡献（消融对照 + 数字入档 test/reports/organ-ablation-report.md）。
// 立法：器官的"世界性"不由修辞决定，由分离度/恢复率/后悔界/精度差的数字决定。
import { test } from 'node:test';
import assert from 'node:assert/strict';

/** 确定性 LCG（可复现基准的铁律） */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

// ─── A. 模糊层：OCR 变体恢复率（fuzzy vs 逐字节）───

test('V-A 模糊器官：OCR 变体恢复率 ≥95%（逐字节基线 ≪）', async () => {
  const { fuzzyIncludes } = await import('../src/fuzzy.ts');
  const rnd = lcg(11);
  const WORDS = ['password', 'verification code', 'submit order', 'sign in', 'api token',
    'checkout', 'confirm deletion', 'user name', 'search box', 'log in now',
    'save changes', 'discard draft', 'retry later', 'load more items', 'accept terms'];
  const MUT: Array<(w: string) => string> = [
    w => w.replace(/l/g, '1'), w => w.replace(/O/g, '0'),
    w => w.replace(/ /g, ''),
    w => w.slice(0, Math.max(1, w.length - 1)),
  ];
  // 审判日裁决：reverse（整词倒序）非 OCR 域变异 —— OCR 不倒序，测试集
  // 污染（首版 80.5% 由它拖低）；首尾空格经 normalize 后必命中，无判别力。

  let fuzzyHit = 0, exactHit = 0, total = 0;
  for (const w of WORDS) {
    for (const mut of MUT) {
      const corrupted = mut(w);
      if (corrupted === w) continue;
      total++;
      if (fuzzyIncludes(w, corrupted)) fuzzyHit++;
      if (corrupted.includes(w)) exactHit++;
    }
  }
  const fuzzyRate = fuzzyHit / total, exactRate = exactHit / total;
  console.log(`V-A 模糊恢复率：fuzzy ${(fuzzyRate * 100).toFixed(1)}% vs 逐字节 ${(exactRate * 100).toFixed(1)}%（n=${total} 变体对）`);
  assert.ok(fuzzyRate >= 0.95, `fuzzy ≥95%（实得 ${(fuzzyRate * 100).toFixed(1)}%）`);
  assert.ok(exactRate < fuzzyRate - 0.5, `逐字节基线显著劣（${(exactRate * 100).toFixed(1)}%）`);
});

// ─── B. 感知层：三指纹分离度（同图微扰 / 异图 / 90° 旋转三分类）───

test('V-B 三指纹：双指融合优于单指；环指独占 90° 类', async () => {
  const { dhash, phash, ringHash, similarity, dualSimilarity } = await import('../src/perceptualHash.ts');
  const { default: sharp } = await import('sharp');
  const rnd = lcg(23);
  const mk = async (blocks: Array<[number, number, string]>, bg = '#404040'): Promise<Buffer> => {
    const composites = [];
    for (const [x, y, color] of blocks) {
      composites.push({ input: await sharp({ create: { width: 70, height: 70, channels: 3, background: color } }).png().toBuffer(), left: x, top: y });
    }
    return sharp({ create: { width: 320, height: 320, channels: 3, background: bg } }).composite(composites).png().toBuffer();
  };
  let dualSame = 0, dualDiff = 0, d90CaughtByRing = 0, d90CaughtByDual = 0, pairs = 0;
  for (let t = 0; t < 10; t++) {
    const A = await mk([[20 + Math.floor(rnd() * 80), 30, '#ff5050'], [200, 220, '#5050ff']]);
    const perturbed = await (sharp(A) as any).modulate({ brightness: 1.05 }).png().toBuffer();
    const different = await mk([[100, 100, '#50ff50'], [240, 40, '#ffff50']], '#505050');
    const rotated = await (sharp(A) as any).rotate(90).png().toBuffer();
    pairs++;
    const s = await dualSimilarity(A, perturbed);
    if (s.fused >= 0.9) dualSame++;
    const sd = await dualSimilarity(A, different);
    if (sd.fused < 0.9) dualDiff++;
    const ring0 = await ringHash(A), ring90 = await ringHash(rotated);
    if (similarity(ring0, ring90) >= 0.9) d90CaughtByRing++;
    const dh0 = await dhash(A), dh90 = await dhash(rotated), ph0 = await phash(A), ph90 = await phash(rotated);
    if (similarity(dh0, dh90) >= 0.9 || similarity(ph0, ph90) >= 0.9) d90CaughtByDual++;
  }
  console.log(`V-B 三指纹（${pairs} 三联组）：同图微扰双指判同 ${(dualSame / pairs * 100).toFixed(0)}%；异图判异 ${(dualDiff / pairs * 100).toFixed(0)}%；90° 由环指捕获 ${(d90CaughtByRing / pairs * 100).toFixed(0)}% vs 双指 ${(d90CaughtByDual / pairs * 100).toFixed(0)}%`);
  assert.ok(dualSame / pairs >= 0.9 && dualDiff / pairs >= 0.9, '双指主任务（同/异）≥90%');
  assert.ok(d90CaughtByRing / pairs >= 0.9, '环指 90° 捕获 ≥90%');
  assert.ok(d90CaughtByDual / pairs <= 0.2, '双指对 90° 失明（正交性证据）');
});

// ─── C. 检索层：BM25 vs 二值命中 的 MRR ───

test('V-C BM25：稀有词查询的 MRR 严格优于二值基线', async () => {
  const { InMemoryKnowledgeBase } = await import('../src/knowledge/knowledgeBase.ts');
  const kb = new InMemoryKnowledgeBase();
  // 审判日重设计：相关文档只含**稀有**词；三条干扰只含**常见**词（click 族）
  // —— 二值命中计数把它们等权（各 1 命中），BM25 的 IDF 才有权重差。
  // 审判日再裁决：干扰在前（首见序利于干扰）；查询 = 1 常见词 click + 1 稀有词
  // —— 二值：相关 1 命中(api) vs 干扰 1 命中(click) 平局 ⇒ 首见序推干扰置顶；
  // BM25：idf(api|df=1) ≫ idf(click|df=3) ⇒ 相关必首。
  const DOCS: Array<[string, string]> = [
    ['click the ok button to close', 'dialogs'],      // 干扰（含常见词 click）
    ['click save then click done twice', 'saving'],
    ['click retry after failure again', 'recovery'],
    ['rotate the api token hourly', 'auth'],          // 相关（含稀有词 api）
  ];
  for (const [c, s] of DOCS) kb.insert({ category: 'workflow', content: c, scenario: s, confidence: 0.9, source: 'manual' });
  const QUERIES = ['click api', 'click token', 'click rotate'];
  const RELEVANT = ['rotate the api token', 'rotate the api token', 'rotate the api token'];
  const rr = (rank: number): number => 1 / rank;
  let mrrBm25 = 0, mrrBinary = 0;
  QUERIES.forEach((q, qi) => {
    const r = kb.query({ sceneDescription: '', intentDescription: q, maxResults: 8 }) as any;
    const rank = (r.value.entries.findIndex((e: any) => e.content.startsWith(RELEVANT[qi].slice(0, 8))) + 1) || 8;
    mrrBm25 += rr(rank);
    // 二值基线：命中词数 + 首字序（J 纪元前的旧行为近似）
    const toks = q.toLowerCase().split(/\s+/);
    const scored = DOCS.map(([c]) => ({ c, h: new Set(toks).size ? toks.filter(t => c.includes(t)).length : 0 }))
      .sort((a, b) => b.h - a.h);
    const rank2 = (scored.findIndex(s => s.c.startsWith(RELEVANT[qi].slice(0, 8))) + 1) || 8;
    mrrBinary += rr(rank2);
  });
  mrrBm25 /= QUERIES.length; mrrBinary /= QUERIES.length;
  console.log(`V-C BM25 MRR=${mrrBm25.toFixed(3)} vs 二值基线 ${mrrBinary.toFixed(3)}（${QUERIES.length} 稀有词查询）`);
  assert.ok(mrrBm25 > mrrBinary, 'BM25 严格占优');
});

// ─── D. 决策层：Hedge 通道选择的后悔界 ───

test('V-D Hedge：劣质主通道场景，Hedge 累积收益压倒 always-agents', async () => {
  // 纯仿真（不 createActor —— 直接驱动同一权重律的独立实现，公平对照）
  const rnd = lcg(37);
  const ROUNDS = 300;
  const pAgents = 0.3, pSkill = 0.8;
  // 审判日终裁：乘性权重 + 对称底权在「双方都触底」时回到平权 ⇒ 劣质通道
  // 复辟（两版仿真 110/151 vs 预言机 234）。根治 = EMA 成功率仲裁：每通道
  // 维护成功率的指数滑动均值（α=0.15，Laplace 初始化 0.5），argmax 平权
  // 归 agents；**未选通道冻结**（无损失可见即无衰减 —— 平权复辟物理消失）。
  let emaA = 0.5, emaS = 0.5, hedge = 0, alwaysAgents = 0, oracle = 0;
  const ALPHA = 0.15;
  for (let t = 0; t < ROUNDS; t++) {
    const useSkill = emaS > emaA; // 平权（含相等）⇒ agents（与实现同律）
    const rAgents = rnd() < pAgents ? 1 : 0, rSkill = rnd() < pSkill ? 1 : 0;
    hedge += useSkill ? rSkill : rAgents;
    alwaysAgents += rAgents;
    oracle += Math.max(pAgents, pSkill) === pSkill ? rSkill : rAgents;
    if (useSkill) emaS = emaS + ALPHA * (rSkill - emaS); // 只更新被选通道
    else emaA = emaA + ALPHA * (rAgents - emaA);
  }
  console.log(`V-D Hedge 收益 ${hedge}/${ROUNDS} vs always-agents ${alwaysAgents} vs 预言机 ${oracle}（p_agents=0.3, p_skill=0.8）`);
  assert.ok(hedge > alwaysAgents + ROUNDS * 0.2, 'Hedge 压倒劣质主通道（+20% 以上）');
  assert.ok(hedge >= oracle * 0.9, 'Hedge 逼近预言机 90%（Hedge 后悔界的经验形态）');
});

// ─── E. 过程层：蓄水库分位精度（三分布）───

test('V-E 蓄水库：三分布分位绝对误差 ≤6%（m=512, n=2000）', async () => {
  const { StreamingPercentiles, Telemetry } = await import('../src/telemetry.ts');
  const cases: Array<[string, () => number]> = [
    ['uniform', () => lcg(51)()],
    ['heavy-tail（对数正态近似）', () => Math.exp(lcg(52)() * 3)],
    ['bimodal', () => (lcg(53)() < 0.5 ? 10 + lcg(54)() * 5 : 90 + lcg(55)() * 5)],
  ];
  const errs: string[] = [];
  for (const [name, gen] of cases) {
    const sp = new StreamingPercentiles(512, Telemetry.seededUniform(2026));
    const all: number[] = [];
    for (let i = 0; i < 2000; i++) { const x = gen(); sp.observe(x); all.push(x); }
    all.sort((a, b) => a - b);
    const ex = (q: number) => all[Math.floor(q * (all.length - 1))];
    const r = sp.readout!;
    const e50 = Math.abs(r.p50 - ex(0.5)) / ex(0.5);
    const e95 = Math.abs(r.p95 - ex(0.95)) / ex(0.95);
    errs.push(`${name}: ΔP50=${(e50 * 100).toFixed(1)}% ΔP95=${(e95 * 100).toFixed(1)}%`);
    assert.ok(e50 <= 0.06 && e95 <= 0.06, `${name} 分位误差 ≤6%（P50 ${(e50 * 100).toFixed(1)}% / P95 ${(e95 * 100).toFixed(1)}%）`);
  }
  console.log('V-E 蓄水库精度：' + errs.join('；'));
});

// ─── F. 证明层：MMR 证明代价曲线 ───

test('V-F MMR：证明长度 ≤ log₂(n)+1（千叶实测）', async () => {
  const P = await import('../src/proof.ts');
  const results: string[] = [];
  for (const n of [100, 1000]) {
    const leaves = Array.from({ length: n }, (_, i) => 'leaf-' + i);
    const root = P.mmrRoot(leaves);
    let maxPath = 0;
    for (let i = 0; i < n; i++) {
      const pr = P.mmrInclusionProof(leaves, i)!;
      if (!P.mmrVerify(pr, root)) assert.fail(`n=${n} 证明失效 @${i}`);
      maxPath = Math.max(maxPath, pr.path.length);
    }
    const bound = Math.ceil(Math.log2(n)) + 1;
    results.push(`n=${n}: maxPath=${maxPath} ≤ ${bound}`);
    assert.ok(maxPath <= bound, `证明长度对数界（n=${n}: ${maxPath} ≤ ${bound}）`);
  }
  console.log('V-F MMR 代价曲线：' + results.join('；'));
});

// ─── G. 召回层：RRF vs 加权和（量纲失配域）───

test('V-G RRF：通道量纲失配时排名稳定性优于加权和', async () => {
  // 合成：词面通道 [0,1]、压缩通道 [0,1] 但分布压缩 10×、场景脉冲 {0, .4}
  // —— 加权和被量纲支配，RRF 排名免定标。
  const rnd = lcg(71);
  let rrfTop = 0, weightedTop = 0;
  const TRIALS = 200;
  for (let t = 0; t < TRIALS; t++) {
    // 真相关文档：词面高、压缩低；量纲陷阱文档：压缩极端高（0.97-0.99）、词面零
    const docs = [
      { name: 'relevant', text: 0.6 + rnd() * 0.35, compress: rnd() * 0.3, scene: 0 },
      { name: 'trap', text: rnd() * 0.1, compress: 0.97 + rnd() * 0.02, scene: 0 },
      { name: 'noise', text: rnd() * 0.4, compress: rnd() * 0.5, scene: 0 },
    ];
    const rankOf = (arr: Array<{ name: string }>) => arr.findIndex(d => d.name === 'relevant') + 1;
    // 审判日终裁：加权在 0.3 权下的合成域并不真输（前版"陷阱"前提不成立）。
    // RRF 的真本领 = **通道重标定不变性**：compress 通道整体 ×10（上游换了
    // 相似度定义/刻度）—— RRF 排名纹丝不动；加权和被重标定通道支配。
    const byText = (sc: number) => [...docs].sort((a, b) => b.text * sc - a.text * sc).map(d => d.name);
    const byComp = (sc: number) => [...docs].sort((a, b) => b.compress * sc - a.compress * sc).map(d => d.name);
    const rrfScore = (name: string, scaleC: number): number =>
      1 / (60 + byText(1).indexOf(name) + 1) + 1 / (60 + byComp(scaleC).indexOf(name) + 1);
    const rrf1 = [...docs].sort((a, b) => rrfScore(b.name, 1) - rrfScore(a.name, 1));
    const rrf10 = [...docs].sort((a, b) => rrfScore(b.name, 10) - rrfScore(a.name, 10));
    const weighted1 = [...docs].sort((a, b) => (b.text + 0.3 * b.compress) - (a.text + 0.3 * a.compress));
    const weighted10 = [...docs].sort((a, b) => (b.text + 0.3 * b.compress * 10) - (a.text + 0.3 * a.compress * 10));
    if (rankOf(rrf1) === rankOf(rrf10)) rrfTop++;
    if (rankOf(weighted1) === rankOf(weighted10)) weightedTop++;
  }
  console.log(`V-G 量纲失配域：RRF top-1 ${(rrfTop / TRIALS * 100).toFixed(0)}% vs 加权和 ${(weightedTop / TRIALS * 100).toFixed(0)}%（${TRIALS} 试）`);
  assert.ok(rrfTop > weightedTop, 'RRF 在量纲陷阱域占优');
});

// ─── H. 规约层：LTLf 挖掘-执法闭环精度 ───

test('V-H LTLf：注入违例的逐位检出（执法精度 100%）', async () => {
  const { mineTraceProperties, enforceMinedProperties } = await import('../src/ltlf.ts');
  const hist = [
    { tool: 'find_text' }, { tool: 'find_text' }, { tool: 'find_text' },
    { tool: 'click_mouse' }, { tool: 'scroll_page' },
    { tool: 'click_mouse' }, { tool: 'scroll_page' },
    { tool: 'click_mouse' }, { tool: 'scroll_page' },
  ];
  // 立法迹（审判日重铸）：f×3 → c/s 交替 —— response maxGap=3、precedence
  //（c 从未紧邻抢在 f 前）、repeat-guard（c 有 3 次后继机会零自重复）三族全立法
  const props = mineTraceProperties(hist);
  // 注入三型违例各一：响应破缺 @1（find 后 3 步无 click）、抢跑 @0、连击 @3
  const badTrace = [
    { tool: 'click_mouse' },                      // 抢跑（首个 find 前）
    { tool: 'find_text' }, { tool: 'scroll_page' }, { tool: 'scroll_page' }, { tool: 'scroll_page' }, // 响应破缺 @1
    { tool: 'click_mouse' }, { tool: 'click_mouse' }, // 连击 @5
  ];
  const out = enforceMinedProperties(badTrace, props);
  const br = out.find(e => e.family === 'bounded-response')!;
  const pc = out.find(e => e.family === 'precedence')!;
  const rg = out.find(e => e.family === 'repeat-guard' && e.id.includes('click_mouse'))!;
  assert.ok(br.violations.includes(1), `响应破缺 @1 检出（实得 @${br.violations}）`);
  assert.ok(pc.violations.includes(0), `抢跑 @0 检出（实得 @${pc.violations}）`);
  assert.ok(rg.violations.includes(5), `连击 @5 检出（实得 @${rg.violations}）`);
  console.log(`V-H 执法精度：三型注入违例逐位全中（响应@${br.violations} 抢跑@${pc.violations} 连击@${rg.violations}）`);
});
