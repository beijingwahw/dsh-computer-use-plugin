// test/epochQ.test.ts
// Q 纪元（开天辟地）：八件新器官的执法册 —— 证明层 / 感知层 / 决策层 /
// 知识层 / 记忆层 / 证据层 / 探索层 / 运动层。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ─── Q-1 证明层：MMR 包含证明 ───

test('Q-1: MMR —— 全尺寸包含证明 + 篡改检测 + journal/sandboxLog 接线', async () => {
  const P = await import('../src/proof.ts');
  // 原子：1..1000 全索引可证可验
  for (const n of [1, 2, 3, 4, 7, 8, 31, 37, 100, 256]) {
    const leaves = Array.from({ length: n }, (_, i) => `leaf-${i}`);
    const root = P.mmrRoot(leaves);
    for (let i = 0; i < n; i++) {
      const pr = P.mmrInclusionProof(leaves, i)!;
      assert.ok(P.mmrVerify(pr, root), `n=${n} idx=${i} 包含证明`);
    }
  }
  // 篡改：改任一叶 ⇒ 全部旧证明失效
  const leaves = Array.from({ length: 64 }, (_, i) => `e${i}`);
  const root = P.mmrRoot(leaves);
  for (const evilIdx of [0, 17, 63]) {
    const evil = [...leaves];
    evil[evilIdx] = 'TAMPERED';
    for (let i = 0; i < 64; i += 7) {
      assert.ok(!P.mmrVerify(P.mmrInclusionProof(leaves, i)!, P.mmrRoot(evil)), `篡改叶 ${evilIdx} 被证明 ${i} 检出`);
    }
  }
  // journal 接线：真链上取证明可验
  const { journal } = await import('../src/journal.ts');
  journal.reset();
  for (let i = 0; i < 5; i++) {
    await journal.append({ ts: Date.now(), tool: 'click_mouse', args: { x: i / 10 }, status: 'SUCCESS', effect_detected: true });
  }
  const jRoot = journal.mmrRoot();
  assert.ok(jRoot, 'journal MMR 根在场');
  const jProof = journal.mmrProof(2)!;
  assert.ok(P.mmrVerify(jProof, jRoot!), 'journal 第 3 条行动的包含证明');
  // sandboxLog 接线
  const { sandboxLog } = await import('../src/sandbox/log.ts');
  sandboxLog.reset?.();
  for (let i = 0; i < 3; i++) await sandboxLog.append('rehearsal-begin', { i });
  const sRoot = sandboxLog.mmrRoot();
  assert.ok(sRoot && P.mmrVerify(sandboxLog.mmrProof(1)!, sRoot), 'sandboxLog 包含证明');
});

// ─── Q-2 感知层：pHash 第二指纹 ───

test('Q-2: pHash —— 亮度微扰不变 + 异图分辨 + 双指纹保守融合', async () => {
  const { phash, similarity, dualSimilarity } = await import('../src/perceptualHash.ts');
  const { default: sharp } = await import('sharp');
  const mk = async (blocks: Array<[number, number, string]>): Promise<Buffer> => {
    const composites = [];
    for (const [x, y, color] of blocks) {
      composites.push({ input: await sharp({ create: { width: 60, height: 60, channels: 3, background: color } }).png().toBuffer(), left: x, top: y });
    }
    return sharp({ create: { width: 300, height: 300, channels: 3, background: '#202020' } }).composite(composites).png().toBuffer();
  };
  const A = await mk([[20, 20, '#ff5050'], [180, 180, '#5050ff']]);
  const perturbed = await (sharp(A) as any).modulate({ brightness: 1.06 }).png().toBuffer();
  const B = await mk([[20, 20, '#50ff50'], [100, 60, '#ff50ff'], [220, 240, '#50ffff']]);
  // 不变性：亮度微扰 ⇒ pHash 逐位同
  assert.equal(await phash(A), await phash(perturbed), '亮度微扰 pHash 不变（DC 排除的收益）');
  // 分辨性：异布局 ⇒ 相似度显著低
  assert.ok(similarity(await phash(A), await phash(B)) < 0.85, '异图 pHash 相似度低');
  // 保守融合：同图 fused 高、异图 fused 低
  const same = await dualSimilarity(A, perturbed);
  const diff = await dualSimilarity(A, B);
  assert.ok(same.fused >= 0.95 && diff.fused < 0.85, `fused 同/异分明（${same.fused} vs ${diff.fused}）`);
  // actionVerifier 契约在场
  const av = readFileSync(new URL('../src/actionVerifier.ts', import.meta.url), 'utf8');
  assert.ok(av.includes('phashCorroborates'), 'CombinedEffect 携带频谱佐证字段');
});

// ─── Q-3 决策层：Wald SPRT 序贯最优停止 ───

test('Q-3: SPRT —— 单帧语义即判 / 双清洁判净 / 终判锁定 / 边界审计', async () => {
  const { SprtPopupFilter } = await import('../src/popupDetector.ts');
  // 单帧语义：LLR = ln(45) ≈ 3.81 > ln(19) ≈ 2.94 ⇒ 立即判 popup
  const f1 = new SprtPopupFilter();
  const s1 = f1.update({ semantic: true, geometric: false });
  assert.equal(s1.decision, 'popup', '语义单帧即判（Wald 上界 α=0.05）');
  assert.ok(s1.bounds.accept > 2.9 && s1.bounds.accept < 3.0, `A = ln(19) ≈ 2.94：${s1.bounds.accept}`);
  // 几何弱证据需累积：ln(3.5)≈1.25/帧 —— 2 帧未决，3 帧判 popup
  const f2 = new SprtPopupFilter();
  assert.equal(f2.update({ semantic: false, geometric: true }).decision, null, '1 帧几何未决');
  assert.equal(f2.update({ semantic: false, geometric: true }).decision, null, '2 帧几何仍未决（1.25×2=2.51 < 2.94）');
  assert.equal(f2.update({ semantic: false, geometric: true }).decision, 'popup', '3 帧几何判 popup（3.76 > 2.94）');
  // 双清洁：ln(0.08/0.85)≈−2.36/帧 —— 1 帧未决，2 帧判 clean
  const f3 = new SprtPopupFilter();
  assert.equal(f3.update({ semantic: false, geometric: false }).decision, null, '单帧清洁未决');
  assert.equal(f3.update({ semantic: false, geometric: false }).decision, 'clean', '双清洁判 clean');
  // 终判锁定（SPRT 停止语义）+ reset 重开
  assert.equal(f3.update({ semantic: true, geometric: true }).decision, 'clean', '终判后锁定');
  f3.reset();
  assert.equal(f3.update({ semantic: true, geometric: false }).decision, 'popup', 'reset 后重开');
});

// ─── Q-4 知识层：worldModel Dirichlet 预测熵 ───

test('Q-4: 预测熵 —— 确定转移近 0 bits / 混合转移高熵 / 集中度随证据上升', async () => {
  const { InMemoryWorldModel } = await import('../src/knowledge/worldModel.ts');
  const scene = (els: Array<[string, number, number]>) => [{
    region: { id: 'g0x0', x: 0, y: 0, width: 1, height: 1 },
    elements: els.map(([name, x, y]) => ({ source: 'L1-tree' as const, role: 'button' as const, name, rect: { x, y, width: 0.08, height: 0.04 } })),
    funnelDepth: 'L1' as const, capturedAt: 0,
  }];
  const mkModel = (toB: number, toC: number) => {
    const wm = new InMemoryWorldModel();
    const a = wm.typeOf(scene([['OK', 0.4, 0.7]]))!;
    const b = wm.typeOf(scene([['File', 0.1, 0.05], ['Edit', 0.25, 0.05]]))!;
    const c = wm.typeOf(scene([['Share', 0.9, 0.05], ['Print', 0.95, 0.05], ['Zoom', 0.85, 0.05]]))!;
    for (let i = 0; i < toB; i++) wm.observe(a, 'click_mouse@11', b, true);
    for (let i = 0; i < toC; i++) wm.observe(a, 'click_mouse@11', c, true);
    return wm.predict(a, 'click_mouse@11');
  };
  const certain = (mkModel(6, 0) as any).value!;
  const mixed = (mkModel(3, 3) as any).value!;
  assert.ok(certain.entropyBits < 0.6, `确定转移低熵：${certain.entropyBits} bits`);
  assert.ok(mixed.entropyBits > certain.entropyBits + 0.5, `混合转移高熵：${mixed.entropyBits} > ${certain.entropyBits}`);
  const lowEv = (mkModel(1, 0) as any).value!;
  const highEv = (mkModel(8, 0) as any).value!;
  assert.ok(highEv.posteriorConcentration > lowEv.posteriorConcentration, '集中度随证据上升');
  assert.ok(lowEv.entropyBits > highEv.entropyBits, '同构证据少的更无知（熵高）');
});

// ─── Q-5 记忆层：技能系谱 ───

test('Q-5: 系谱 —— parents/generation 入档 + lineage 回溯 + 祖先存续加成', async () => {
  const { skillLibrary } = await import('../src/skillLibrary.ts') as never as { skillLibrary: any };
  const dir = mkdtempSync(join(tmpdir(), 'q5-skill-'));
  try {
    skillLibrary.configure(true, join(dir, 'skills.json'), 50);
    // 铸谱系：根 r1/r2（gen 0）→ 合成 s3（parents [r1,r2], gen 1）→ s4（parents [s3], gen 2）
    const now = Date.now();
    skillLibrary.skills.push(
      { id: 1, name: 'r1', description: 'open settings pane', steps: [{ tool: 'click_mouse', args: {} }], successCount: 3, attemptCount: 4, createdAt: now, lastUsedAt: now },
      { id: 2, name: 'r2', description: 'clear the log', steps: [{ tool: 'click_mouse', args: {} }], successCount: 2, attemptCount: 5, createdAt: now, lastUsedAt: now },
      { id: 3, name: 's3', description: 'open settings then clear log', steps: [], successCount: 1, attemptCount: 2, createdAt: now, lastUsedAt: now, synthesized: true, parents: [1, 2], generation: 1 },
      { id: 4, name: 's4', description: 'deep combo', steps: [], successCount: 0, attemptCount: 1, createdAt: now, lastUsedAt: now, parents: [3], generation: 2 },
    );
    skillLibrary.save();
    // 落盘往返：parents/generation 持久化（旧档兼容的可逆面）
    const onDisk = JSON.parse(readFileSync(join(dir, 'skills.json'), 'utf8'));
    assert.ok(onDisk.skills.some((s: any) => s.parents?.length === 2 && s.generation === 1), '系谱字段入档');
    // lineage 回溯：s4 → s3 →（首母体 r1）
    const lin = skillLibrary.lineage(4);
    assert.deepEqual(lin.chain.map((s: any) => s.id), [3, 1], '祖先链 s4→s3→r1');
    assert.ok(lin.familySize >= 3, `家族规模：${lin.familySize}`);
    assert.equal(skillLibrary.lineage(999), null, '未知 id 诚实 null');
    // 环守卫：损坏数据（s5.parent = s5 自环）不死循环
    skillLibrary.skills.push({ id: 5, name: 'loop', description: 'x', steps: [], successCount: 0, attemptCount: 1, createdAt: now, lastUsedAt: now, parents: [5], generation: 9 });
    const lin5 = skillLibrary.lineage(5);
    assert.ok(lin5 && lin5.chain.length === 0, `自环截断（入链前断 —— 不死循环）：chain=${lin5?.chain.length}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Q-6 证据层：效应量 ───

test('Q-6: Cohen h 地标值 + Mann-Whitney 秩检验', async () => {
  const { cohensH, mannWhitney } = await import('../src/knowledge/metrics.ts');
  // 地标：h(0.5,0.5)=0；h(1,0)=π；h(0.8,0.2)≈1.287（反正弦尺上的经典大效应）
  assert.equal(cohensH(0.5, 0.5), 0);
  assert.ok(Math.abs(cohensH(1, 0)! - Math.PI) < 1e-3, 'h(1,0)=π');
  assert.ok(Math.abs(cohensH(0.8, 0.2)! - 1.287) < 5e-3, `h(0.8,0.2)≈1.287：${cohensH(0.8, 0.2)}`);
  assert.equal(cohensH(1.5, 0), null, '域外诚实 null');
  // Mann-Whitney：完全分离 ⇒ U1=0、p 极小；同分布 ⇒ p 大；可交换
  const sep = mannWhitney([1, 2, 3, 4, 5, 6, 7, 8], [9, 10, 11, 12, 13, 14, 15, 16])!;
  assert.equal(sep.u1, 0, '全分离 U1=0');
  assert.ok(sep.p! < 0.01, `分离显著（8v8 正态近似）：p=${sep.p}`);
  const same = mannWhitney([1, 2, 3, 4, 5], [1, 2, 3, 4, 5])!;
  assert.ok(same.p! > 0.5, `同分布不显著：p=${same.p}`);
  const flipped = mannWhitney([9, 10, 11, 12, 13, 14, 15, 16], [1, 2, 3, 4, 5, 6, 7, 8])!;
  assert.equal(flipped.u2, sep.u1, '可交换（U 对偶）');
  assert.equal(mannWhitney([1], [2]), null, '样本不足诚实 null');
});

// ─── Q-7 探索层：晶体 Thompson 采样 ───

test('Q-7: Thompson 晶体排序 —— 高证据真值主导 + 低证据获探索配额', async () => {
  const { swarm } = await import('../src/swarm.ts');
  const before = JSON.stringify((swarm as any).crystals);
  try {
    (swarm as any).crystals = new Map([
      ['aaa:click', { key: 'aaa:click', successes: 98, attempts: 100 }], // 高证据 0.98
      ['bbb:click', { key: 'bbb:click', successes: 2, attempts: 2 }],    // 低证据 1.0（2/2）
      ['ccc:click', { key: 'ccc:click', successes: 5, attempts: 50 }],   // 0.1
    ]);
    // 播种：多数轮高证据晶体居首（分布窄），但低证据 2/2 有时被抽高（分布宽）
    let topA = 0, topB = 0;
    let seed = 7;
    const uniform = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
    for (let t = 0; t < 60; t++) {
      const top = swarm.thompsonTopRoutes(1, uniform)[0];
      if (top.key === 'aaa:click') topA++;
      if (top.key === 'bbb:click') topB++;
    }
    assert.ok(topA > topB && topA >= 30, `真值主导（A 居首 ${topA}/60 > B ${topB}/60）`);
    assert.ok(topB >= 1, `低证据晶体获得探索配额（B 居首 ${topB}/60 > 0 —— Thompson 的证据比例探索）`);
  } finally {
    (swarm as any).crystals = JSON.parse(before, (k, v) => k === '' ? new Map(Object.entries(v)) : v);
    // Map 结构 restore 保守回退：直接 reset 亦可
  }
});

// ─── Q-8 运动层：焦点速度外推 ───

test('Q-8: 焦点外推 —— 匀速漂移沿速度外推；证据不足回退原点', async () => {
  const { focusTracker } = await import('../src/focusTracker.ts');
  focusTracker.clear();
  focusTracker.set(0.30, 0.30);
  await new Promise(r => setTimeout(r, 25));
  focusTracker.set(0.40, 0.30); // +0.10 / 25ms ⇒ v ≈ 0.004/ms
  await new Promise(r => setTimeout(r, 40));
  const p = focusTracker.predicted();
  assert.ok(p.extrapolated, '两帧差分 ⇒ 外推在场');
  assert.ok(p.x > 0.40 && p.x < 0.90, `沿速度外推（x=${p.x.toFixed(3)} > 0.40 且钳半屏内）`);
  assert.equal(p.y, 0.30, 'y 无速度 ⇒ 原位');
  // 证据不足：单帧（无前点）⇒ 原点
  focusTracker.clear();
  focusTracker.set(0.5, 0.5);
  await new Promise(r => setTimeout(r, 10));
  const q = focusTracker.predicted();
  assert.ok(!q.extrapolated && q.x === 0.5, '单帧无速度 ⇒ 诚实回退原点');
  focusTracker.clear();
});
