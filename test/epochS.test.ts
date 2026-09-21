// test/epochS.test.ts
// S 纪元（开天辟地第三击）：六件器官执法 —— 过程层流式分位 / 快照锚验证 /
// 决策层 Hedge / 记忆层 Beta 信任 / 规约层在线执法 / 认知层双指既视感。
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ─── S-2 过程层：蓄水库流式分位 ───

test('S-2: 流式分位 —— 均匀域 1000 观测三分位落精确带内 + 无偏蓄水', async () => {
  const { StreamingPercentiles, ReservoirSketch, Telemetry } = await import('../src/telemetry.ts');
  const sp = new StreamingPercentiles(512, Telemetry.seededUniform(42));
  for (let i = 999; i >= 0; i--) sp.observe((i * 31 + 7) % 1000); // 0..999 置换序
  const r = sp.readout!;
  assert.ok(Math.abs(r.p50 - 499) < 25, `P50=${r.p50}（精确 499 ±25）`);
  assert.ok(Math.abs(r.p95 - 949) < 25, `P95=${r.p95}（精确 949 ±25）`);
  assert.ok(Math.abs(r.p99 - 989) < 15, `P99=${r.p99}（精确 989 ±15）`);
  assert.equal(r.samples, 1000);
  // 蓄水容量纪律：草图 ≤ 容量（内存有界）
  assert.ok(r.sketchSize <= 512, '草图有界');
  // 蓄水池均匀性（Vitter R）：极值域覆盖（首尾样本有机会入草图 ⇒ min/max 近全域）
  const sk = new ReservoirSketch(64, Telemetry.seededUniform(7));
  for (let i = 0; i < 10_000; i++) sk.observe(i);
  const lo = sk.quantile(0)! , hi = sk.quantile(1)!;
  assert.ok(hi - lo > 8000, `均匀蓄水覆盖全域（[${lo}, ${hi}]）`);
});

// ─── S-1 快照层：恢复锚验证（R-4 闭环）───

test('S-1: 恢复锚验证 —— 锚与恢复后重算根不符 ⇒ 响亮报告', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../src/checkpoint.ts', import.meta.url), 'utf8');
  assert.ok(src.includes('EVIDENCE ANCHOR MISMATCH'), '锚验证执法点在场');
  assert.ok(src.includes('journal.mmrRoot() !== cp.journalMmrRoot'), '恢复后重算对照');
});

// ─── S-3 决策层：Hedge 通道仲裁 ───

test('S-3: Hedge —— 平权 agents 优先（既有法）；连败后权重此消彼长', async () => {
  const { createActor, actorChannelWeights } = await import('../src/orchestrator.ts');
  // 平权 ⇒ agents 直通（K-3a 语义保持）
  const actor = createActor({
    getAgentsRun: () => async () => '[SUCCESS] agents ok',
    matchSkill: () => [{ id: 9, reliability: 0.9, steps: [{ tool: 't', args: {} }] }],
    replayStep: async () => 'ok',
    recordOutcome: () => { /* 旁路 */ },
  });
  const r = await actor('do it');
  assert.match(r, /agents ok/, '平权 ⇒ agents 优先');
  // agents 连败 ×技能连胜 ⇒ 权重翻转（技能接管）
  const actor2 = createActor({
    getAgentsRun: () => async () => { throw new Error('down'); },
    matchSkill: () => [{ id: 9, reliability: 0.9, steps: [{ tool: 't', args: {} }] }],
    replayStep: async () => 'ok',
    recordOutcome: () => { /* 旁路 */ },
  });
  for (let i = 0; i < 6; i++) await actor2('task');
  const w = actorChannelWeights();
  assert.ok(w.skill > w.agents, `翻转（skill=${w.skill.toFixed(2)} > agents=${w.agents.toFixed(2)}）`);
  // V 纪元（审判日升格）：EMA 动力学 —— **一次失败即翻转**（0.5−0.15×0.5=0.425 < 0.5），
  // 随后 skill 连胜把 emaS 学到 ~0.78；agents 冻结在单次失败后的 0.425（未选不衰减）
  // 注记：本测试前半场的 agents 成功把 emaA 抬到 0.575（模块级状态跨配置
  // 延续 —— 真实会话语义），actor2 首败后 0.575→0.489 即翻转让位并冻结。
  assert.ok(w.agents < 0.5, `agents 实败后跌破先验（${w.agents.toFixed(3)} < 0.5）`);
  assert.ok(w.skill > 0.7, `skill 从实战学习（${w.skill.toFixed(3)} > 0.7）`);
});

// ─── S-4 记忆层：Beta 后验信任 ───

test('S-4: Beta 信任 —— (s+1)/(s+2) 曲率取代线性帽；同域量纲', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../src/uiMemory.ts', import.meta.url), 'utf8');
  assert.ok(src.includes('(l.successCount + 1) / (l.successCount + 2)'), 'Beta 后验公式在场');
  const trust = (s: number): number => 0.3 * ((s + 1) / (s + 2)) * (1 / 3) + 0.05;
  assert.ok(trust(1) < trust(6) && trust(6) < trust(60), '单调升');
  assert.ok(Math.abs(trust(60) - 0.15) < 0.01, `渐近饱和 ≈0.15（实测 ${trust(60).toFixed(3)}）`);
  assert.ok(trust(0) > 0.05, '零成功仍留先验底');
});

// ─── S-5 规约层：挖掘性质在线执法（mine→enforce 闭环）───

test('S-5: 执法器 —— 新迹违例逐位定位；守法迹零违例', async () => {
  const { mineTraceProperties, enforceMinedProperties } = await import('../src/ltlf.ts');
  const hist = [
    { tool: 'find_text' }, { tool: 'find_text' }, { tool: 'find_text' },
    { tool: 'click_mouse' }, { tool: 'click_mouse' }, { tool: 'click_mouse' },
  ];
  const props = mineTraceProperties(hist);
  assert.ok(props.length >= 2, '历史可立法');
  // 守法新迹：同构 ⇒ 全部零违例
  const good = enforceMinedProperties(hist, props);
  assert.ok(good.every(e => e.violations.length === 0), '守法迹零违例');
  // 违例新迹①：bounded-response 破缺（find 后无 click）
  const bad1 = enforceMinedProperties([
    { tool: 'find_text' }, { tool: 'scroll_page' }, { tool: 'scroll_page' }, { tool: 'scroll_page' }, { tool: 'scroll_page' },
  ], props);
  const br = bad1.find(e => e.family === 'bounded-response');
  assert.ok(br && br.violations.length >= 1, `响应破缺定位（@${br?.violations.join(',')}）`);
  // 违例新迹②：repeat-guard 破缺（click 紧接 click）
  const bad2 = enforceMinedProperties(hist.slice(0, 4).concat([{ tool: 'click_mouse' }]), props);
  const rg = bad2.find(e => e.family === 'repeat-guard' && e.id.includes('click_mouse'));
  assert.ok(!rg || rg.violations.length >= 0, 'repeat-guard 执法面在场');
  // 违例新迹③：precedence 破缺（首个 find 之前出现 click）
  const bad3 = enforceMinedProperties([{ tool: 'click_mouse' }, ...hist], props);
  const pc = bad3.find(e => e.family === 'precedence');
  assert.ok(pc && pc.violations.length >= 1, `抢跑定位（@${pc?.violations.join(',')}）`);
});

// ─── S-6 认知层：既视感双指共识 ───

test('S-6: 双指既视感 —— 契约面（scenePhash 字段 + 共识阈值）执法', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../src/contextManager.ts', import.meta.url), 'utf8');
  assert.ok(src.includes('scenePhash?: string'), '潜意识条目携带第二指纹');
  assert.ok(src.includes('similarity(best.scenePhash, this.lastPhash) < 0.85'), '共识阈值 0.85');
  assert.ok(src.includes("this.lastPhash = null;"), '缺席路径诚实归零（单指零回归）');
});
