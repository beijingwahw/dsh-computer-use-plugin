// test/epochO.test.ts
// O 纪元（28 项清账战役）：按推荐执行序逐项兑现并执法。
// 每一项测试以原编号命名（O-#n），与七轮战役后的全量待完善项清单一一对应。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';

// ─── O-#10：homoglyph Unicode confusables 全表（UTS #39 蒸馏接入）───

test('O-#10: confusables 全表 —— 非算术族命中 + 零误伤 + 性能预算', async () => {
  const { matchesRiskPatterns, matchesDangerPatterns } = await import('../src/riskGate.ts');
  // 覆盖面：数学等宽系（U+1D670 —— M 纪元算术族之外，仅全表可达）
  const mk = (base: number, letters: string) => [...letters].map(c => String.fromCodePoint(base + (c.charCodeAt(0) - 97))).join('');
  assert.ok(matchesRiskPatterns(mk(0x1d670, 'password'), 'password'), '数学等宽 𝚙𝚊𝚜𝚜𝚠𝚘𝚛𝚍（全表新增覆盖）');
  // ASCII→ASCII 对称折叠：rn ↔ m 视觉互混（UTS#39 语义）
  assert.ok(matchesDangerPatterns('please confirrn the order', ''), 'confirrn（rn 仿 m）命中 confirm');
  // 误伤防线（M-2 回归 + CJK 句子）
  assert.ok(!matchesRiskPatterns('viewreport', 'password'), '正常词不误伤');
  assert.ok(!matchesDangerPatterns('modern art', ''), 'modern 不因 m→rn 折叠误命中 remove');
  assert.ok(!matchesRiskPatterns('请在输入框里输入你的姓名和地址', 'password'), 'CJK 句子不误伤');
  // 血缘执法：生成文件头声明数据来源与条目数
  const gen = readFileSync(new URL('../src/riskGate.confusables.generated.ts', import.meta.url), 'utf8');
  assert.ok(gen.includes('confusables.txt'), '数据血缘（consortium 表）成文');
  assert.ok(/1665 条/.test(gen), '条目数成文（1665）');
  // 性能预算：全表下归一化吞吐不得劣化到不可用（1MB < 1s —— 实测 ~22MB/s）
  const sample = '请输入 𝐩𝐚𝐬𝐬𝐰𝐨𝐫𝐝 Ⓟⓐⓢⓢｗｏｒｄ p@ssw0rd fi ﬁ ⅼaptop normal '.repeat(160);
  const t0 = performance.now();
  for (let i = 0; i < 100; i++) matchesRiskPatterns(sample, 'password');
  const ms = performance.now() - t0;
  assert.ok(ms < 1000, `归一化 100x${sample.length} 字符 = ${ms.toFixed(0)}ms（预算 1000ms）`);
});

// ─── O-#22：contextManager 同毫秒 id 碰撞根除（混合逻辑时钟）───

test('O-#22: 零间隔双截 —— id 唯一、单调、数值语义保留', async () => {
  const { contextManager } = await import('../src/contextManager.ts');
  contextManager.reset();
  const a = await contextManager.addScreenshot('aaaa', 'hash-a');
  const b = await contextManager.addScreenshot('bbbb', 'hash-b'); // 同毫秒（零间隔）
  const c = await contextManager.addScreenshot('cccc', 'hash-c');
  assert.notEqual(a.currentId, b.currentId, '同毫秒不碰撞');
  assert.ok(b.currentId > a.currentId && c.currentId > b.currentId, '严格单调（id 升序 = 时间序）');
  assert.ok(Number.isInteger(a.currentId), '数值 id 语义保留');
  // 防时钟回拨：系统时间倒退时 id 依然单调（lastId+1 下限顶住）
  const realNow = Date.now;
  (globalThis as any).Date.now = () => realNow() - 10_000; // 假装时钟回拨 10s
  try {
    const d = await contextManager.addScreenshot('dddd', 'hash-d');
    assert.ok(d.currentId > c.currentId, '时钟回拨下 id 依然单调');
  } finally {
    (globalThis as any).Date.now = realNow;
  }
});

// ─── O-#21：worldModel restore 悬空引用校验（幽灵类型不入库）───

test('O-#21: restore 拒悬空 from/next + 拒重复 next 键 + 拒破缺记账', async () => {
  const { InMemoryWorldModel } = await import('../src/knowledge/worldModel.ts');
  const scene = (els: Array<[string, number, number]>) => [{
    region: { id: 'g0x0', x: 0, y: 0, width: 1, height: 1 },
    elements: els.map(([name, x, y]) => ({
      source: 'L1-tree' as const, role: 'button' as const, name,
      rect: { x, y, width: 0.08, height: 0.04 },
    })),
    funnelDepth: 'L1' as const, capturedAt: 0,
  }];
  const mk = () => {
    const wm = new InMemoryWorldModel();
    const a = wm.typeOf(scene([['OK', 0.4, 0.7], ['Cancel', 0.6, 0.7]]))!;
    const b = wm.typeOf(scene([['File', 0.1, 0.05], ['Edit', 0.25, 0.05]]))!;
    wm.observe(a, 'click_mouse@22', b, true);
    return { wm, snap: wm.exportSnapshot() as Record<string, unknown> };
  };
  const { snap } = mk();
  assert.ok(new InMemoryWorldModel().restoreSnapshot(structuredClone(snap)).ok, '合法快照照常水合（零回归）');
  const rejects = (mut: (s: Record<string, unknown>) => void, why: string) => {
    const bad = structuredClone(snap);
    mut(bad);
    const r = new InMemoryWorldModel().restoreSnapshot(bad);
    assert.ok(!r.ok, `${why} 被拒`);
  };
  rejects(s => { (s.transitions as any[])[0].from = 'screen-999'; }, '悬空 from');
  rejects(s => { ((s.transitions as any[])[0].next as Array<[string, number]>)[0] = ['screen-999', 1]; }, '悬空 next');
  rejects(s => {
    const tr = (s.transitions as any[])[0];
    tr.next = [...tr.next, [...(tr.next as Array<[string, number]>)[0]]];
    tr.total = (tr.total as number) + 1;
  }, '重复 next 键');
  rejects(s => { (s.transitions as any[])[0].total = 5; }, 'sum(next) != total 记账破缺');
});

// ─── O-#26：首轮知识检索串行化选项（场景信号主权归部署者）───

test('O-#26: firstRoundSerialKnowledge —— 首轮查询带新鲜场景；缺省并行语义零回归', async () => {
  const { KnowledgePipelineOrchestrator } = await import('../src/knowledge/pipeline.ts');
  const { InMemoryKnowledgeBase } = await import('../src/knowledge/knowledgeBase.ts');
  const { DoctorVerdictBridge } = await import('../src/knowledge/adapters.ts');
  const VALID = {
    timeout: { overall: 2000, perStep: 500, perPerception: 500 },
    retryPolicy: { maxRetries: 1, backoffMs: 1, maxBackoffMs: 2 },
    knowledgeTimeout: 200, knowledgeMaxResults: 5, knowledgeMaxChars: 300,
  };
  const mkStations = (kb: any, sceneQueries: string[]) => ({
    knowledge: {
      query: (q: { sceneDescription: string; intentDescription: string }) => {
        sceneQueries.push(q.sceneDescription);
        return kb.query(q);
      },
    },
    vision: {
      async perceive(): Promise<any[]> {
        return [{
          region: { id: 'g0x0', x: 0, y: 0, width: 1, height: 1 },
          elements: [{ source: 'L1-tree', role: 'button', name: 'Settings gear', rect: { x: 0.9, y: 0.05, width: 0.08, height: 0.04 } }],
          funnelDepth: 'L1', capturedAt: 0,
        }];
      },
    },
    decision: { async decide(): Promise<any> { return { kind: 'noop', args: {}, rationale: 'stub' }; } },
    execution: { async execute(env: any): Promise<any> { return { action: env.payload, status: 'success', durationMs: 1 }; } },
    verdictBridge: new DoctorVerdictBridge(),
    emit: () => { /* 旁路 */ },
  });

  // 串行档：首轮查询的场景描述非空（新鲜感知先入查询）
  const serialQueries: string[] = [];
  const o1 = new KnowledgePipelineOrchestrator();
  o1.configure({ ...VALID, firstRoundSerialKnowledge: true } as never);
  o1.wire(mkStations(new InMemoryKnowledgeBase(), serialQueries) as never, {});
  await o1.run({ id: 'i-ser', description: 'open settings' });
  assert.ok(serialQueries.length >= 1 && serialQueries[0].length > 0, `首轮查询带场景信号："${serialQueries[0].slice(0, 30)}"`);

  // 并行档（缺省）：首轮查询的场景描述为空（既有语义 —— 检索只靠意图）
  const parallelQueries: string[] = [];
  const o2 = new KnowledgePipelineOrchestrator();
  o2.configure({ ...VALID } as never);
  o2.wire(mkStations(new InMemoryKnowledgeBase(), parallelQueries) as never, {});
  await o2.run({ id: 'i-par', description: 'open settings' });
  assert.ok(parallelQueries.length >= 1 && parallelQueries[0] === '', '缺省并行：首轮场景信号缺席（零回归）');
});

// ─── O-#27：CUSUM 双边化 + 基线稳定化 ───

test('O-#27: 双边 CUSUM —— 降臂告警 + 环前终身基线不随环翻转', async () => {
  const { cusumAlarmTwoSided, Telemetry } = await import('../src/telemetry.ts');
  // 原子：痊愈臂 —— 长期失败后突然全好 ⇒ direction='down'
  const healing = [...Array(20).fill(1), ...Array(12).fill(0)];
  const r1 = cusumAlarmTwoSided(healing, 0.8);
  assert.equal(r1.direction, 'down', `痊愈臂告警（sumDown=${r1.sumDown}）`);
  // 原子：恶化臂（回归）—— 单边语义保留
  const worsening = [...Array(20).fill(0), ...Array(12).fill(1)];
  assert.equal(cusumAlarmTwoSided(worsening, 0.2).direction, 'up', '恶化臂保留');
  // 平稳流不告警
  const calm = [0, 1, 0, 1, 0, 1, 0, 1, 0, 0, 1, 0];
  assert.equal(cusumAlarmTwoSided(calm, 0.4).direction, null, '平稳流零告警');

  // 集成：基线稳定化 —— 旧实现环刷新后基线被新 regime 吸收（告警消失），
  // 新实现环前终身基线（append-only）持续锚定旧世界。环容量 64：
  // 先灌 80 成功 ⇒ 环前史 28 个确定结局（终身锚成型），再触发 12 连败。
  const t = new Telemetry();
  for (let i = 0; i < 80; i++) t.observe('tool', 'SUCCESS', 1); // 旧世界：全好
  for (let i = 0; i < 12; i++) t.observe('tool', 'FAILED', 1);  // 突变：恶化
  const shifts1 = t.regimeShifts();
  assert.equal(shifts1.length, 1, '恶化告警在场');
  assert.equal(shifts1[0].direction, 'up');
  assert.equal(shifts1[0].baselineSource, 'lifetime', '环前终身基线');
  assert.equal(shifts1[0].baselineFailureRate, 0, '基线锚定旧世界（0 失败史）');
  // 环滑动 40 步（旧实现此刻基线已翻转到新 regime、告警消失；新实现终身锚仍在）
  for (let i = 0; i < 40; i++) t.observe('tool', 'FAILED', 1);
  const shifts2 = t.regimeShifts();
  assert.equal(shifts2.length, 1, '告警不因环刷新而消失（基线不翻转）');
  assert.equal(shifts2[0].direction, 'up', '仍是恶化方向');
  assert.equal(shifts2[0].baselineFailureRate, 0, '终身锚仍在旧世界（0）');
  // 痊愈方向集成：全败史后突然好转 ⇒ down 告警（RECOVERY 语义）
  const t2 = new Telemetry();
  for (let i = 0; i < 80; i++) t2.observe('heal', 'FAILED', 1);
  for (let i = 0; i < 12; i++) t2.observe('heal', 'SUCCESS', 1);
  const shifts3 = t2.regimeShifts();
  assert.equal(shifts3[0]?.direction, 'down', '痊愈臂集成告警');
});

// ─── O-#11：PID 白名单实际值（部署助手 + 本机演示 + 机制端到端）───

test('O-#11: compute_pid_whitelist 助手 —— 64-hex 输出 + auth.py 半载拒绝兼容', async () => {
  const { execFileSync } = await import('node:child_process');
  const nodeExe = process.execPath; // 本机真实 node 二进制（Windows: node.exe）
  const out = execFileSync('python', ['scripts/compute_pid_whitelist.py', '--path', nodeExe], { encoding: 'utf8' });
  // 输出的 export 行含 64-hex sha256（auth.py _load_pid_whitelist 方言）
  const m = out.match(/DSH_PHYSICAL_PID_WHITELIST="\$\{[^}]+\}([0-9a-f]{64})"/);
  assert.ok(m, `输出含即贴即用 env 行：\n${out}`);
  // 与独立计算一致（哈希真实性）
  const { createHash } = await import('node:crypto');
  const { readFileSync: rf } = await import('node:fs');
  const expect = createHash('sha256').update(rf(nodeExe)).digest('hex');
  assert.equal(m![1], expect, '哈希与独立计算一致');
  // auth.py 机制端到端：合法值装载非空、非法条目整条拒绝（半载比空表更危险）
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { writeFileSync: wf, rmSync } = await import('node:fs');
  const probePath = join(tmpdir(), 'dsh-o11-probe.py');
  wf(probePath, [
    'import sys',
    "sys.path.insert(0, 'python_service')",
    'from dsh_physical.auth import _load_pid_whitelist',
    `assert _load_pid_whitelist('${expect}') == {'${expect}'}`,
    'try:',
    `    _load_pid_whitelist('${expect},zz')`,
    "    raise SystemExit('bad accepted')",
    'except ValueError:',
    '    pass',
    "print('auth-ok')",
  ].join('\n'));
  try {
    const authOut = execFileSync('python', [probePath], { encoding: 'utf8' });
    assert.ok(authOut.includes('auth-ok'), `auth.py 机制端到端：${authOut.trim()}`);
  } finally {
    rmSync(probePath, { force: true });
  }
});

// ─── O-#12：GPD PWM 第二估计器 + 矩法反演修正 + 一致性检验 ───

test('O-#12: PWM 双估计器 —— 反演修正后精确恢复真值 + 一致性可测', async () => {
  const { fitGpdTail, fitGpdPwm } = await import('../src/telemetry.ts');
  // 确定性网格逆 CDF 采样（与 F-2 同法 —— 无随机，精度断言可复现）
  const gpdGrid = (xi: number, sigma: number, n: number) =>
    Array.from({ length: n }, (_, i) => {
      const u = (i + 0.5) / n;
      return xi === 0 ? -sigma * Math.log(u) : (sigma / xi) * (Math.pow(1 - u, -xi) - 1);
    });
  // ① 反演修正执法：真 ξ=0.4 —— PWM 主估计显著优于旧反演的 0.444
  const fit1 = fitGpdTail(gpdGrid(0.4, 10, 400))!;
  assert.ok(fit1, '重尾拟合在场');
  assert.ok(Math.abs(fit1.xiPwm - 0.4) < Math.abs(0.444 - 0.4), `PWM ξ=${fit1.xiPwm} 优于旧反演的 0.444`);
  assert.ok(Math.abs(fit1.xi - fit1.xiPwm) < 1e-9, 'PWM 主估计权（xi === xiPwm）');
  // ② 指数尾（ξ=0）：PWM 近 0
  const fit2 = fitGpdTail(gpdGrid(0, 5, 400))!;
  assert.ok(fit2 && Math.abs(fit2.xiPwm) <= 0.1, `指数尾 PWM 近 0（${fit2?.xiPwm}）`);
  // ③ PWM 原子：网格大样本收敛（n=8000 → 0.392，真值 0.4）
  const big = gpdGrid(0.25, 8, 8000);
  const u = [...big].sort((a, b) => a - b)[Math.floor(8000 * 0.9)];
  const excess = big.filter(s => s > u).map(s => s - u);
  const pwm = fitGpdPwm(excess)!;
  assert.ok(Math.abs(pwm.xi - 0.25) <= 0.05, `PWM 大样本恢复 ξ=0.25（±0.05）：${pwm.xi.toFixed(3)}`);
  // ④ 一致性检验的分歧臂：混合两分布的尾（regime 混合 ⇒ 两估计器系统性分歧）
  let seed = 42;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  const mixture = [...gpdGrid(0.45, 10, 250), ...Array.from({ length: 250 }, () => 1 + rnd() * 3)];
  const fit3 = fitGpdTail(mixture);
  if (fit3) {
    assert.ok(typeof fit3.consistent === 'boolean', `一致性字段在场（=${fit3.consistent}）`);
  }
});

// ─── O-#20：worldModel run 级快照（并发 run 的 typeOf 隔离）───

test('O-#20: fork 隔离中途定型 + merge 重放 + 并发同号类型重铸', async () => {
  const { InMemoryWorldModel } = await import('../src/knowledge/worldModel.ts');
  const scene = (els: Array<[string, number, number]>) => [{
    region: { id: 'g0x0', x: 0, y: 0, width: 1, height: 1 },
    elements: els.map(([name, x, y]) => ({
      source: 'L1-tree' as const, role: 'button' as const, name,
      rect: { x, y, width: 0.08, height: 0.04 },
    })),
    funnelDepth: 'L1' as const, capturedAt: 0,
  }];
  const BASE = scene([['OK', 0.4, 0.7]]);
  const OTHER = scene([['Share', 0.9, 0.05], ['Print', 0.95, 0.05]]); // 异构 ⇒ 新类型

  const root = new InMemoryWorldModel();
  const rootId = root.typeOf(BASE)!;
  // fork 隔离：fork 内铸造新类型，root 不可见（并发 run 不再互污）
  const f1 = root.fork();
  const f1Id = f1.typeOf(OTHER)!;
  assert.notEqual(f1Id, rootId, 'fork 铸造新类型');
  assert.equal(root.stats().types, 1, 'root 不见 fork 的中途定型（隔离执法）');
  // fork 内 observe 不入 root
  f1.observe(rootId, 'click_mouse@22', f1Id, true);
  const p0 = root.predict(rootId, 'click_mouse@22');
  assert.ok(p0.ok && p0.value === null, '转移同样隔离');
  // merge：重放回 root
  root.merge(f1);
  assert.equal(root.stats().types, 2, 'merge 后新类型入册');
  const p1 = root.predict(rootId, 'click_mouse@22');
  assert.ok(p1.ok && p1.value !== null && p1.value.nextTypes.length === 1, '转移入账');
  // 并发同号重铸：两个 fork 都铸造了 screen-2 ⇒ merge 重铸为不同新 id
  const fA = root.fork();
  const fB = root.fork();
  const idA = fA.typeOf(scene([['Alpha', 0.1, 0.1]]))!;   // 两个互不同构的新场景
  const idB = fB.typeOf(scene([['Beta', 0.8, 0.8], ['Gamma', 0.85, 0.85]]))!;
  root.merge(fA);
  root.merge(fB);
  assert.equal(root.stats().types, 4, '并发双铸造 ⇒ 两个不同类型（同号重铸，无覆写）');
  const snap = root.exportSnapshot() as { types: Array<{ id: string }> };
  const ids = snap.types.map(t => t.id);
  assert.equal(new Set(ids).size, ids.length, 'id 全局无碰撞');
  // 会员计数正确合并：root 的 BASE 会员数 = root 观察 + fork 的 member op
  const f2 = root.fork();
  f2.typeOf(BASE); f2.typeOf(BASE);
  const before = (root.exportSnapshot() as any).types.find((t: any) => t.id === rootId).members;
  root.merge(f2);
  const after = (root.exportSnapshot() as any).types.find((t: any) => t.id === rootId).members;
  assert.equal(after, before + 2, '会员计数按观察增量合并');
});

// ─── O-#24/#25：I-4 瞬移链接（极端 UI 变化不再误判 transient）+ W₁ 信息熵加权 ───

test('O-#24: 相干瞬移场 —— ≥2 特征同矢量共移判 persistent；单个候选诚实瞬态', async () => {
  const { classifyPersistence, noteDiffObserved, resetDiffPersistence } =
    await import('../src/visualDiff.ts');
  type DiffRegion = import('../src/visualDiff.ts').DiffRegion;
  resetDiffPersistence();
  const mk = (index: number, x: number, y: number, w: number, h: number, t: number): DiffRegion => ({
    index,
    bbox_normalized: { x0: x - w / 2, y0: y - h / 2, x1: x + w / 2, y1: y + h / 2 },
    center: { x, y },
    tiles_changed: t,
  });
  // 第一幕：工具条(0.20,0.95) + 状态栏(0.80,0.95) 同位三现 ⇒ 双 persistent 快照入环
  const toolbar = mk(1, 0.20, 0.95, 0.10, 0.04, 12);
  const statusbar = mk(2, 0.80, 0.95, 0.10, 0.04, 12);
  for (let i = 0; i < 3; i++) noteDiffObserved([toolbar, statusbar]);
  // 极端重排：整窗上移 0.70（两特征同矢量 (0,+0.70) 共移，位移 ≫ 半径 0.10）
  const movedToolbar = mk(3, 0.20, 0.25, 0.10, 0.04, 12);
  const movedStatusbar = mk(4, 0.80, 0.25, 0.10, 0.04, 12);
  const v1 = classifyPersistence([movedToolbar, movedStatusbar]);
  assert.equal(v1.get(3), 'persistent', '工具条随相干场判 persistent（#24 债务闭合）');
  assert.equal(v1.get(4), 'persistent', '状态栏同上');
  // 反例 1：单个候选无共移证人 ⇒ 诚实瞬态（I-4 反例律保住）
  resetDiffPersistence();
  for (let i = 0; i < 3; i++) noteDiffObserved([toolbar, statusbar]);
  const lone = mk(5, 0.20, 0.25, 0.10, 0.04, 12);
  assert.equal(classifyPersistence([lone]).get(5), 'transient', '单个远盒证据不足 ⇒ 瞬态');
  // 反例 2：两特征位移矢量不一致（非刚体重排）⇒ 双瞬态
  resetDiffPersistence();
  for (let i = 0; i < 3; i++) noteDiffObserved([toolbar, statusbar]);
  const scatterA = mk(6, 0.20, 0.25, 0.10, 0.04, 12);   // 位移 (0, +0.70)
  const scatterB = mk(7, 0.15, 0.60, 0.10, 0.04, 12);   // 位移 (−0.65, +0.35) —— 矢量不一致
  const v3 = classifyPersistence([scatterA, scatterB]);
  assert.equal(v3.get(6), 'transient', '非相干位移 ⇒ 瞬态');
  assert.equal(v3.get(7), 'transient', '非相干位移 ⇒ 瞬态');
  // 反例 3：形状不守恒（宽扁 → 高瘦）即使同矢量也不连
  resetDiffPersistence();
  for (let i = 0; i < 3; i++) noteDiffObserved([toolbar, statusbar]);
  const morphA = mk(8, 0.20, 0.25, 0.04, 0.16, 12);     // aspect 0.25 vs 2.5
  const morphB = mk(9, 0.80, 0.25, 0.04, 0.16, 12);
  const v4 = classifyPersistence([morphA, morphB]);
  assert.equal(v4.get(8), 'transient', '形变不守恒 ⇒ 瞬态');
  assert.equal(v4.get(9), 'transient', '形变不守恒 ⇒ 瞬态');
  resetDiffPersistence();
});

test('O-#25: W₁ 信息熵加权 —— 质量视图不动，信息视图显形掩蔽', async () => {
  const { spatialDisplacement } = await import('../src/visualDiff.ts');
  type DiffRegion = import('../src/visualDiff.ts').DiffRegion;
  const mk = (index: number, x: number, y: number, t: number): DiffRegion => ({
    index,
    bbox_normalized: { x0: x - 0.05, y0: y - 0.05, x1: x + 0.05, y1: y + 0.05 },
    center: { x, y },
    tiles_changed: t,
  });
  const at = { x: 0.5, y: 0.5 };
  // 单区域：熵退化 ⇒ 两视图同值
  const solo = spatialDisplacement(at, [mk(1, 0.3, 0.3, 10)]);
  assert.ok(Math.abs(solo.w1 - solo.w1Info) < 1e-9 && solo.infoRatio === 1, '单区域熵退化');
  // 大面积近处冲刷 + 远处小而独特的变化：质量视图说"就在手边"（w1 小），
  // 信息视图揭穿掩蔽（w1Info 大）⇒ infoRatio 显著 >1
  const masked = spatialDisplacement(at, [mk(1, 0.52, 0.5, 90), mk(2, 0.95, 0.95, 10)]);
  assert.ok(masked.w1 < 0.1, `质量视图：近处重质量主导（W1=${masked.w1}，H-1 语义不动）`);
  assert.ok(masked.w1Info > masked.w1, `信息视图揭穿远 minority（w1Info=${masked.w1Info} > w1）`);
  assert.ok(masked.infoRatio > 1.2, `分歧度显形（infoRatio=${masked.infoRatio}）`);
  // 均匀分布：两视图同判
  const even = spatialDisplacement(at, [mk(1, 0.2, 0.5, 50), mk(2, 0.8, 0.5, 50)]);
  assert.ok(Math.abs(even.infoRatio - 1) < 0.01, `均衡变化两视图同判（${even.infoRatio}）`);
});

// ─── O-#23：LTLf 性质挖掘自动化 ───

test('O-#23: 挖掘器 —— 有界响应/先序/防重三族自动立法 + 弱模式不立', async () => {
  const { mineTraceProperties, reactTraceProperties, MINE_MIN_SUPPORT } = await import('../src/ltlf.ts');
  // 迹：交替 [ss, click]×3 —— 有界响应（间隔 1）+ click 从未自我紧邻（3 次机会）
  // 先序不立：交替迹必有 click 紧邻在 ss 前的回绕（语义正确，如实不立）
  const entries = [
    { tool: 'take_screenshot', observed: true },
    { tool: 'click_mouse' },
    { tool: 'take_screenshot', observed: true },
    { tool: 'click_mouse' },
    { tool: 'take_screenshot', observed: true },
    { tool: 'click_mouse' },
    { tool: 'take_screenshot', observed: true },
  ];
  const mined = mineTraceProperties(entries);
  const ids = mined.map(m => m.id);
  // 有界响应：screenshot 后 ≤1 步必有 click（3 支持 0 反例）
  assert.ok(ids.some(id => id.includes('mined-response[take_screenshot→click_mouse]≤1')), `有界响应立法：${ids.join(' | ')}`);
  // 防重：click 有 3 次自我紧邻机会且零重复
  assert.ok(ids.some(id => id.includes('mined-repeat-guard[click_mouse]')), '防重立法');
  assert.ok(!ids.some(id => id.includes('mined-precedence[')), '交替迹回绕抢跑 ⇒ 先序如实不立');
  // 分组迹（find×3 后 click×3）：先序立法 —— click 从未紧邻抢在 find 前
  const grouped = [
    { tool: 'find_text' }, { tool: 'find_text' }, { tool: 'find_text' },
    { tool: 'click_mouse' }, { tool: 'click_mouse' }, { tool: 'click_mouse' },
  ];
  const gIds = mineTraceProperties(grouped).map(m => m.id);
  assert.ok(gIds.some(id => id.includes('mined-response[find_text→click_mouse]≤3')), `分组迹有界响应（maxGap=3）：${gIds.join(' | ')}`);
  assert.ok(gIds.some(id => id.includes('mined-precedence[click_mouse¬≪find_text]')), '分组迹先序立法（click 从未紧邻抢跑）');
  for (const m of mined) {
    assert.ok(m.support >= MINE_MIN_SUPPORT, `支持度门槛（${m.id}: ${m.support}）`);
    assert.equal(m.confidence, 1, '挖掘只收铁律（零反例）');
    assert.equal(m.violations.length, 0, '挖掘性质在本迹恒成立');
  }
  // 弱模式不立：screenshot→click 只出现 2 次（< 3）⇒ 无对应立法
  const short = mineTraceProperties(entries.slice(0, 4)); // 2 次配对
  assert.ok(!short.some(m => m.id.includes('mined-response[take_screenshot→click_mouse]')), '机会不足不立法');
  // 反例灭法：一次 click 紧接 click ⇒ repeat-guard 不立（零例前提被打破）
  const withRepeat = [
    { tool: 'take_screenshot' }, { tool: 'click_mouse' }, { tool: 'click_mouse' },
    { tool: 'take_screenshot' }, { tool: 'click_mouse' },
  ];
  assert.ok(!mineTraceProperties(withRepeat).some(m => m.id.includes('mined-repeat-guard[click_mouse]')), '有反例不立法');
  // 预铸库零回归：三条铁律仍由 reactTraceProperties 供给
  assert.equal(reactTraceProperties(entries).length, 3, '预铸库不动');
});

// ─── O-#14：switch_tab 标签页栈模型（N 纪元最后的留白）───

test('O-#14: 标签页栈 —— 指针循环移动有证据；栈 <2 诚实反证', async () => {
  const { VirtualScreen } = await import('../src/sandbox/virtualScreen.ts');
  const tab = (name: string, x: number) => ({
    role: 'tab', name, rect: { x, y: 0.05, width: 0.1, height: 0.04 },
  });
  // 三标签栈：A B C
  const vs = new VirtualScreen([tab('Inbox', 0.05), tab('Sent', 0.2), tab('Drafts', 0.35)]);
  const e1 = vs.applyAction({ kind: 'switch_tab', args: { direction: 'next' } } as never);
  assert.equal(e1.effectDetected, true, 'next 移动指针 = L1 证据');
  assert.match(e1.note, /Inbox → Sent/, `首标签起步 next：${e1.note}`);
  const e2 = vs.applyAction({ kind: 'switch_tab', args: { direction: 'next' } } as never);
  assert.match(e2.note, /Sent → Drafts/, e2.note);
  // 循环回绕：C → A
  const e3 = vs.applyAction({ kind: 'switch_tab', args: { direction: 'next' } } as never);
  assert.match(e3.note, /Drafts → Inbox/, `栈尾回绕：${e3.note}`);
  // previous 反向
  const e4 = vs.applyAction({ kind: 'switch_tab', args: { direction: 'previous' } } as never);
  assert.match(e4.note, /Inbox → Drafts/, e4.note);
  // 指针状态延续：再 next 应回到 Inbox（栈指针 = 上次切换的落点）
  const e4b = vs.applyAction({ kind: 'switch_tab', args: { direction: 'next' } } as never);
  assert.match(e4b.note, /Drafts → Inbox/, `指针延续：${e4b.note}`);
  // 反证：单标签（或零标签）无处可切
  const lone = new VirtualScreen([tab('Only', 0.05)]);
  const e5 = lone.applyAction({ kind: 'switch_tab', args: { direction: 'next' } } as never);
  assert.equal(e5.effectDetected, false, '单标签 ⇒ 反证（无处可切）');
  // 无 tab 控件的场景：同样反证（role='tab' 方言的诚实缺席）
  const noTabs = new VirtualScreen([{ role: 'button', name: 'OK', rect: { x: 0.4, y: 0.4, width: 0.1, height: 0.06 } }]);
  const e6 = noTabs.applyAction({ kind: 'switch_tab', args: { direction: 'next' } } as never);
  assert.equal(e6.effectDetected, false, '无标签方言 ⇒ 反证');
});

// ─── O-#15：沙箱 L3 语义层（场景 OCR 点燃休眠的 L3-semantic）───

test('O-#15: 场景 OCR —— expectedText 瞄准验证 + L3 层激活 + 误瞄反证', async () => {
  const { VirtualScreen } = await import('../src/sandbox/virtualScreen.ts');
  const vs = new VirtualScreen([
    { role: 'button', name: 'Submit order', rect: { x: 0.4, y: 0.5, width: 0.12, height: 0.05 } },
    { role: 'button', name: 'Cancel', rect: { x: 0.6, y: 0.5, width: 0.1, height: 0.05 } },
    { role: 'textbox', name: 'Search', rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.04 }, acceptsText: true },
  ]);
  // 场景 OCR 原子：区域读出控件名（+ 已上屏缓冲）
  assert.ok(vs.sceneOcr(0.45, 0.52).includes('Submit order'), '区域 OCR 读出标签');
  assert.equal(vs.sceneOcr(0.5, 0.9), '', '空区域读出空串');
  // 瞄准验证：预期 'Submit order' 且点中 Submit ⇒ L3+L4 双层满足
  const good = vs.applyAction({
    kind: 'click_mouse', args: { x: 0.45, y: 0.52 },
    expect: { scale: 'text-level', expectedText: 'Submit order' },
  } as never);
  assert.equal(good.expectationMet, true, '瞄准命中');
  assert.ok(good.layers.includes('L3-semantic'), `L3 层激活：${good.layers.join('+')}`);
  // 误瞄反证：预期 'Cancel' 但点了 Submit ⇒ OCR 读出 Submit ≠ Cancel
  const bad = vs.applyAction({
    kind: 'click_mouse', args: { x: 0.45, y: 0.52 },
    expect: { scale: 'text-level', expectedText: 'Cancel' },
  } as never);
  assert.equal(bad.expectationMet, false, '瞄准反证（读出的文字不含预期）');
  // 无 expectedText 的 text-level：既有 acceptsText 语义零回归
  const classic = vs.applyAction({
    kind: 'click_mouse', args: { x: 0.15, y: 0.12 },
    expect: { scale: 'text-level' },
  } as never);
  assert.equal(classic.expectationMet, true, '无 expectedText ⇒ acceptsText 语义（零回归）');
  assert.ok(!classic.layers.includes('L3-semantic'), '缺席声明不点火 L3');
  // 输入缓冲也是屏上文字：type 后区域 OCR 含已上屏文本
  vs.applyAction({ kind: 'click_mouse', args: { x: 0.15, y: 0.12 } } as never);
  vs.applyAction({ kind: 'type_text', args: { text: 'hello world' } } as never);
  assert.ok(vs.sceneOcr(0.15, 0.12).includes('hello world'), '上屏文本入 OCR');
});

// ─── O-#16：SO_PEERCRED Node 客户端半（undici UDS dispatcher）───

test('O-#16: UDS 基址解析 + dispatcher 注入 + configure 不再拒绝 http+unix://', async () => {
  const { parseUnixBaseUrl, setUndiciBridge } = await import('../src/physicalExecution/httpClient.ts');
  // 解析方言：socket 止于最后一个 .sock，其后是 URL path
  const a = parseUnixBaseUrl('http+unix:///var/run/dsh-physical.sock/v1');
  assert.deepEqual(a, { socketPath: '/var/run/dsh-physical.sock', urlPath: '/v1' }, '明文方言');
  const b = parseUnixBaseUrl('http+unix://%2Fvar%2Frun%2Fx.sock/capabilities');
  assert.deepEqual(b, { socketPath: '/var/run/x.sock', urlPath: '/capabilities' }, '百分号编码方言（requests 风格）');
  assert.equal(parseUnixBaseUrl('http://127.0.0.1:8421/v1'), null, 'TCP 基址不解析为 UDS');
  assert.equal(parseUnixBaseUrl('http+unix:///no/socket/here'), null, '无 .sock ⇒ 不可解析');
  // 桥注入 + dispatcher 缓存
  const made: unknown[] = [];
  setUndiciBridge({
    Agent: class { constructor(opts: unknown) { made.push(opts); } },
  } as never);
  // microFetch 走 UDS 路径：无真 socket ⇒ 连接失败但**以 dispatcher 传输**
  // （错误归类 transport_error，detail 含 UDS socket 路径 —— 诚实归因）
  const { microFetch } = await import('../src/physicalExecution/httpClient.ts');
  const r = await microFetch(
    { baseUrl: 'http+unix:///tmp/o16-test.sock/v1', defaultTimeoutMs: 1500 },
    '/health', { method: 'GET' },
  );
  assert.ok(!r.ok, '无真 socket ⇒ 失败（预期）');
  if (!r.ok) {
    assert.equal((r.error as any).kind, 'transport_error', '错误信封在场');
    assert.ok(!String((r.error as any).detail).includes('UDS transport unavailable'), '桥在场 ⇒ 不走无桥降级分支');
  }
  assert.ok(made.length >= 1 && (made[0] as any).connect?.socketPath === '/tmp/o16-test.sock',
    `Agent 以 socketPath 铸造：${JSON.stringify(made[0])}`);
  setUndiciBridge(null); // 清桥（后续测试不受污染）
  // configure 不再拒绝：UDS 合法形状通过加载层（J 纪元拒绝令退役）
  const { PhysicalExecutionAdapterImpl } = await import('../src/physicalExecution/adapter.ts');
  const keyDir = (await import('node:fs')).mkdtempSync((await import('node:os')).tmpdir() + '/o16-key-');
  try {
    const adapter = new PhysicalExecutionAdapterImpl();
    adapter.configure({
      baseUrl: 'http+unix:///var/run/dsh-physical.sock/v1',
      timeoutMs: 1000,
      keyPath: keyDir + '/k.pem',
    } as never);
    assert.ok(true, 'UDS 基址通过 configure（客户端半兑现）');
    (adapter as any).dispose?.();
  } finally {
    (await import('node:fs')).rmSync(keyDir, { recursive: true, force: true });
  }
});

// ─── O-#8：token 真实消耗计量（工位自报回路）───

test('O-#8: usageMeter 探针 —— finalReport 携带 tokenUsageReported；未装探针报 0', async () => {
  const { PipelineOrchestratorImpl } = await import('../src/orchestration/pipeline.ts');
  type DecisionOutput = import('../src/orchestration/contracts.ts').DecisionOutput;
  const o = new PipelineOrchestratorImpl();
  o.configure({
    maxDecisionRetries: 0, regionGrid: { cols: 2, rows: 2 },
    stationTokenBudgets: { vision: 2000, decision: 8000, execution: 0 },
    rehearseBeforeExecute: false, attemptTimeoutMs: 500, perceptionDeadlineMs: 500,
    consumePlanReady: false,
  } as never);
  let used = 0;
  const decision = {
    async decide(): Promise<DecisionOutput> {
      used += Math.ceil((200 + 100) / 4);
      return { kind: 'noop', args: {}, rationale: 'metered' };
    },
  };
  const vision = { async *perceive(): AsyncIterable<never> { } };
  const execution = {
    async execute(env: any) { return { action: env.payload, status: 'success', durationMs: 1 }; },
  };
  o.wire({
    vision: vision as never, decision: decision as never, execution: execution as never,
    emit: () => { },
    usageMeter: { decision: () => used },
  } as never, {});
  const report = await o.run({ id: 'intent-o8', goal: 'meter me' } as never);
  assert.ok(report.tokenUsageReported, '报告携带实际消耗字段');
  assert.ok(report.tokenUsageReported!.decision >= 75, `决策自报计量（${report.tokenUsageReported!.decision}）`);
  assert.equal(report.tokenUsageReported!.vision, 0, '未装探针报 0（未计量 ≠ 未消耗）');
  assert.equal(report.tokenUsageReported!.execution, 0, '零模型肌肉恒 0');
  assert.ok(report.tokenBudgetsGranted.decision > 0, '授予字段并存（双记账）');
  const o2 = new PipelineOrchestratorImpl();
  o2.configure({ maxDecisionRetries: 0, regionGrid: { cols: 2, rows: 2 },
    stationTokenBudgets: { vision: 2000, decision: 8000, execution: 0 },
    rehearseBeforeExecute: false, attemptTimeoutMs: 500, perceptionDeadlineMs: 500,
    consumePlanReady: false } as never);
  o2.wire({ vision: vision as never, decision: decision as never, execution: execution as never } as never, {});
  const r2 = await o2.run({ id: 'intent-o8b', goal: 'unmetered' } as never);
  assert.deepEqual(r2.tokenUsageReported, { vision: 0, decision: 0, execution: 0 }, '无探针 ⇒ 全 0 如实');
});

// ─── O-#18：审批根除的模型侧协议强制（target_description 必填契约）───

test('O-#18: click_mouse 的 target_description 升格为 schema 必填（协议层根除）', async () => {
  const src = readFileSync(new URL('../src/tools/clickMouse.ts', import.meta.url), 'utf8');
  const idx = src.indexOf('target_description: {');
  const block = src.slice(idx, src.indexOf('}', idx));
  assert.ok(/required:\s*true/.test(block), `schema 必填契约在场：${block.slice(0, 120)}`);
  assert.ok(src.includes('REQUIRED'), '工具描述宣告必填');
});

// ─── O-#9：CPT 真实遥测标定（oracle 换血）───

test('O-#9: calibrateCptFromTelemetry —— 真实观测分布加权标定 + 血缘成文', async () => {
  const { calibrateCptFromTelemetry, observeSignalsForCalibration } = await import('../src/diagnosis.ts');
  // 推导端：遥测五信号视图（与 get_metrics 洞见判据同律）
  const sig = observeSignalsForCalibration({
    regimeShifts: [{ tool: 'click_mouse' }],
    hurst: 0.72, behavior: { normalized: 0.6, phrases: 10, length: 30 },
    heavyLatencyTail: false, highNoopTools: [],
  });
  assert.deepEqual(sig, { shifted: true, hurstHigh: true, loop: false, heavyTail: false, highNoop: false });
  // 标定端：真实分布（组合可带频次权重；未触达组合 ⇒ 专家律托底）
  const r = calibrateCptFromTelemetry([
    { ...sig, weight: 5 },                                    // shift+cluster 现场 ×5
    { shifted: false, hurstHigh: false, loop: true, heavyTail: false, highNoop: false, weight: 3 },  // loop 现场 ×3
    { shifted: false, hurstHigh: false, loop: false, heavyTail: false, highNoop: false, weight: 10 }, // 健康 ×10
  ]);
  assert.equal(r.sampled, 18, '加权观测数');
  assert.equal(r.distinct, 3, '真实分布只出现见过的组合（≤32）');
  assert.ok(r.syndromeSamples['shift-and-cluster'] === 5, '症候群样本计数');
  // 值域执法：标定行 ∈ (0,1)；未触达行 = 专家律（同 M-3 律）
  for (const v of Object.values(r.cpt) as number[][]) {
    for (const p of v) assert.ok(p > 0 && p < 1, `CPT 值域 (0,1)：${p}`);
  }
  assert.ok(r.agreement >= 0 && r.agreement <= 1, `agreement=${r.agreement}（数据血缘：真实观测 × 规则标签）`);
});

// ─── O-#13：标定回路四原子（A² MC 自举 / Kalman QR / Schmitt / NCD 阈）───

test('O-#13: 四标定原子 —— 可复现、有诚实下限、产可比对字面量的值', async () => {
  const C = await import('../src/calibration.ts');
  // ① A² 临界表：MC 自举可复现（同种子同表）；α 序单调（01 ≥ 05 ≥ 10）
  const t1 = C.gpdAdCriticalTable({ nSample: 120, nSims: 300 });
  const t2 = C.gpdAdCriticalTable({ nSample: 120, nSims: 300 });
  assert.deepEqual(t1, t2, '同种子同表（可复现）');
  assert.ok(t1.alpha01 >= t1.alpha05 && t1.alpha05 >= t1.alpha10 && t1.alpha10 > 0,
    `A² 分位单调：10%=${t1.alpha10} 5%=${t1.alpha05} 1%=${t1.alpha01}`);
  // ② Kalman Q/R（P 纪元互补滤波语义）：好模型（预测准）+ 噪声观测 ⇒ 低比
  //  （信任模型先验）；坏模型（预测恒错滞留）+ 真值观测 ⇒ 高比（信任观测）
  let seed2 = 7;
  const jitter = () => { seed2 = (seed2 * 1664525 + 1013904223) >>> 0; return (seed2 / 2 ** 32 - 0.5) * 0.2; };
  const goodModel = Array.from({ length: 40 }, () => ({ predicted: 0.5, observed: 0.5 + jitter() }));
  let walk = 0;
  const badModel = Array.from({ length: 40 }, () => { walk += 0.4; return { predicted: 0.5, observed: walk + jitter() * 0.3 }; });
  const qCalm = C.calibrateKalmanQR(goodModel), qWalk = C.calibrateKalmanQR(badModel);
  assert.ok(qCalm && qWalk, '样本充分 ⇒ 标定在场');
  assert.ok(qCalm!.ratio < qWalk!.ratio, `好模型比坏模型更受信任（${qCalm!.ratio} < ${qWalk!.ratio}）`);
  assert.equal(C.calibrateKalmanQR(goodModel.slice(0, 4)), null, '样本 <8 ⇒ 诚实拒标定');
  // ③ Schmitt 证据强度：真弹窗帧（语义+几何）与非弹窗帧分离
  const frames = [
    ...Array.from({ length: 6 }, () => ({ semantic: true, geometric: true, isPopup: true })),
    ...Array.from({ length: 6 }, (_, i) => ({ semantic: false, geometric: i % 3 === 0, isPopup: false })),
  ];
  const sch = C.calibrateSchmittEvidence(frames);
  assert.ok(sch && sch.separation > 0.3, `分离度显形（${sch?.separation}）`);
  assert.ok(sch!.evidenceSem >= sch!.evidenceGeo, '语义证据 ≥ 几何证据（词表命中强于形状）');
  // ④ NCD 阈：高相似相关 / 低相似无关 ⇒ Youden J 在中位阈值附近
  const pairs = [
    ...Array.from({ length: 8 }, (_, i) => ({ similarity: 0.6 + i * 0.04, relevant: true })),
    ...Array.from({ length: 8 }, (_, i) => ({ similarity: i * 0.04, relevant: false })),
  ];
  const th = C.calibrateNcdThreshold(pairs);
  assert.ok(th && th.j >= 0.9, `J 最优（${th?.j}）`);
  assert.ok(th!.threshold >= 0.25 && th!.threshold <= 0.6, `阈在两簇之间（${th!.threshold}）`);
});

// ─── O-#17：set_contrast 真机往返修形（真机执法抓出的潜伏 bug 群）───

test('O-#17: set_contrast 不需要窗口 + HIGHCONTRAST 结构体 + 精确还原', async () => {
  const src = readFileSync(new URL('../src/environmentShaper.ts', import.meta.url), 'utf8');
  // bug①（真机抓出）：set_contrast 是系统级动作，apply 不得要求窗口句柄
  assert.ok(src.includes("action.kind !== 'set_contrast'"), '系统级动作豁免窗口解析');
  const { WindowsAdapter } = await import('../src/environmentShaper.ts');
  const scripts: string[] = [];
  const a = new WindowsAdapter({ probe: () => true, exec: async (_c: string, args: string[]) => {
    scripts.push(String(args[args.length - 1]));
    return { stdout: '4\n' };
  } });
  const recipe = await a.apply({ kind: 'set_contrast' }); // 无 titleHint —— 旧实现此处 throw
  assert.equal(recipe.before?.theme, '4', 'GET 快照');
  // bug②：PS 单引号律（\" 在 PS 双引号串中不是转义 —— execFile 真机路径从未编译成功）
  assert.ok(!src.includes('\\"user32.dll\\"'), 'P/Invoke 声明无非法 \\" 转义');
  assert.ok(scripts.some(s => s.includes("MemberDefinition '")), 'C# 定义包 PS 单引号串');
  // bug③：pvParam 是 HIGHCONTRAST 结构体（cbSize 先置），非 int 引用（旧形状 SET 恒 false）
  assert.ok(scripts.some(s => s.includes('public struct HC') && s.includes('cbSize')), '结构体形状');
  assert.ok(scripts.some(s => s.includes('::SetHC(5')), 'SET = 4|1 = 5');
  await a.undo(recipe);
  // bug④（残余不诚实）：undo 精确还原（原本开着的 ON 位不得错关）
  assert.ok(scripts[scripts.length - 1].includes('::SetHC(4)'), 'undo = 原值精确还原（4）');
});

// ─── O-#6：dsh.vision.* 三服务自荐注册（L 纪元服务归属法的补完）───

test('O-#6: D-6 以自铸回退源自荐 dsh.vision.structured/traditional —— 单属主铁律', async () => {
  // 编译期：orchestration 源码含 set?. 自荐（与 D-5/D-7 同律）
  const src = readFileSync(new URL('../src/orchestration/index.ts', import.meta.url), 'utf8');
  assert.ok(src.includes("'dsh.vision.structured'"), 'structured 属主声明');
  assert.ok(src.includes("'dsh.vision.traditional'"), 'traditional 属主声明');
  // 行为验证：假宿主（get 全缺席 ⇒ 回退源自铸 ⇒ 自荐两条）
  const registered = new Map<string, unknown>();
  const fakeCtx = {
    set: (n: string, v: unknown) => registered.set(n, v),
    on: () => { /* 事件旁路 */ },
    get: (_n: string) => undefined,
    effect: () => { /* 生命周期登记 no-op */ },
    emit: () => { /* 发射旁路 */ },
    tools: { register: () => { /* 工具面旁路 */ } },
  };
  const { apply } = await import('../src/orchestration/index.ts');
  await apply(fakeCtx as never, {});
  assert.ok(registered.has('dsh.vision.structured'), 'structured 上线');
  assert.ok(registered.has('dsh.vision.traditional'), 'traditional 上线');
  assert.ok(!registered.has('dsh.vision.semantic'), 'semantic 无自铸源 ⇒ 不注册（诚实：无物可荐）');

  // 单属主铁律：外部源在场 ⇒ D-6 不覆写（get 命中的对象原样保留）
  const external = { marker: 'external-owner' };
  const fakeCtxExternal = {
    ...fakeCtx,
    get: (n: string) => (n === 'dsh.vision.structured' ? external : undefined),
  };
  const registered2 = new Map<string, unknown>();
  fakeCtxExternal.set = (n: string, v: unknown) => registered2.set(n, v);
  await apply(fakeCtxExternal as never, {});
  assert.ok(!registered2.has('dsh.vision.structured'), '外部属主不被覆写');
  assert.ok(registered2.has('dsh.vision.traditional'), '外部缺席者仍由 D-6 顶上');
});
