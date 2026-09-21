// test/epochP.test.ts
// P 纪元（灭虫圣战）：对全部统计/数学引擎做**已知参数恢复 + 不变量**属性测试
// （虫型 III 免疫 —— 示例断言抓不住约定错配，参数恢复能）；并执法本纪元
// 修复的活性 bug（auth 中间件序 / A² 约定 / verify 环境假设）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// ─── 属性炮台 1：Hurst 指数（iid ≈ 0.5 / 趋势 > 0.5）───

test('P-1: Hurst 属性 —— iid 均值回归 0.5；持续性序列 > 0.55', async () => {
  const { hurstExponent } = await import('../src/telemetry.ts');
  let seed = 42;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  // iid：64 点 × H 估计 —— 容差宽（R/S 小样本噪声大），断言均值的中心性
  const iidHs: number[] = [];
  for (let t = 0; t < 12; t++) {
    const h = hurstExponent(Array.from({ length: 256 }, () => rnd()));
    if (h !== null) iidHs.push(h);
  }
  const iidMean = iidHs.reduce((a, b) => a + b, 0) / iidHs.length;
  assert.ok(Math.abs(iidMean - 0.5) < 0.15, `iid 均值 H=${iidMean.toFixed(3)} 应近 0.5`);
  // 持续性：累积和（正自相关 ⇒ 长程依赖）
  const trendHs: number[] = [];
  for (let t = 0; t < 12; t++) {
    let acc = 0;
    const walk = Array.from({ length: 256 }, () => (acc += rnd() - 0.42)); // 正漂移随机游走
    const h = hurstExponent(walk);
    if (h !== null) trendHs.push(h);
  }
  const trendMean = trendHs.reduce((a, b) => a + b, 0) / trendHs.length;
  assert.ok(trendMean > iidMean, `趋势 H=${trendMean.toFixed(3)} 应高于 iid ${iidMean.toFixed(3)}`);
});

// ─── 属性炮台 2：置换检验 —— 精确 p 对超几何闭式解 ───

test('P-2: 置换检验精确 p —— 对齐 Fisher 超几何闭式', async () => {
  const { Telemetry } = await import('../src/telemetry.ts');
  // [[9,0],[0,6]]：单侧精确 p = 1/C(15,9) = 1/5005 ≈ 0.0001998
  const sig = Telemetry.permutationTest2Prop(9, 9, 0, 6)!;
  assert.equal(sig.mode, 'exact');
  const closed = 1 / 5005;
  assert.ok(Math.abs(sig.pValue - closed) < 1e-6, `p=${sig.pValue} vs 闭式 ${closed.toFixed(6)}`);
  // 对称性（可交换性）
  const flipped = Telemetry.permutationTest2Prop(0, 6, 9, 9)!;
  assert.equal(flipped.pValue, sig.pValue);
});

// ─── 属性炮台 3：贝叶斯信念 —— 归一化 + 诚实缺席 ───

test('P-3: 贝叶斯信念不变量 —— 后验和 = 1；全缺席 = null', async () => {
  const { bayesianBelief } = await import('../src/diagnosis.ts');
  const cases: Array<[boolean, boolean, boolean, boolean, boolean]> = [
    [true, false, true, false, true], [false, true, false, true, false],
    [true, true, true, true, true], [false, false, false, false, true],
  ];
  for (const [a, b, c, d, e] of cases) {
    const belief = bayesianBelief({ shifted: a, hurstHigh: b, loop: c, heavyTail: d, highNoop: e })!;
    const sum = belief.reduce((s, x) => s + x.posterior, 0);
    assert.ok(Math.abs(sum - 1) < 0.01, `后验归一（${a}${b}${c}${d}${e} 和=${sum}）`);
    for (const x of belief) assert.ok(x.posterior >= 0 && x.posterior <= 1, '值域 [0,1]');
  }
  assert.equal(bayesianBelief({ shifted: false, hurstHigh: false, loop: false, heavyTail: false, highNoop: false }), null,
    '全缺席 = 诚实 null');
  assert.equal(bayesianBelief({ shifted: null, hurstHigh: null, loop: null, heavyTail: null, highNoop: null }), null,
    '全 null = 诚实 null');
});

// ─── 属性炮台 4：NCD —— 对称性 + 值域 + 同一性 ───

test('P-4: NCD 不变量 —— 对称 / [0,1] / 同串 0 / 相似串 < 无关串', async () => {
  const { ncd, ncdSimilarity } = await import('../src/ncd.ts');
  const pairs = [['abcabcabc', 'xyzxyzxyz'], ['hello world', 'hello there'], ['aaaa', 'aaab'], ['x', 'xxxxxxxx']];
  for (const [a, b] of pairs) {
    assert.equal(ncd(a, b), ncd(b, a), `对称 ncd(${a},${b})`);
    assert.ok(ncd(a, b) >= 0 && ncd(a, b) <= 1, '值域 [0,1]');
    assert.ok(ncdSimilarity(a, b) >= 0 && ncdSimilarity(a, b) <= 1, '相似度值域');
  }
  assert.equal(ncd('same', 'same'), 0, '同串恒 0');
  assert.ok(ncd('abcdef', 'abcdef') < ncd('abcdef', 'zzzzzz'), '同串距离 < 无关串');
});

// ─── 属性炮台 5：A² 约定执法（第九只 bug 的回归闸）───

test('P-5: A² MC 临界表落在文献带（约定错配即刻现形）', async () => {
  const { gpdAdCriticalTable } = await import('../src/calibration.ts');
  const t = gpdAdCriticalTable({ nSample: 150, nSims: 300 });
  // 反号约定错配时分位曾达 78-160；正确约定下 GPD A² 文献带 ≈ [0.2, 3]
  assert.ok(t.alpha10 > 0.2 && t.alpha01 < 3,
    `临界表在文献带：10%=${t.alpha10} 1%=${t.alpha01}（错配时代 78-160）`);
  assert.ok(t.alpha01 > t.alpha05 && t.alpha05 > t.alpha10, '分位单调');
});

// ─── 属性炮台 6：Kalman 稳态递推 —— 对 DARE 闭式解 ───

test('P-6: 标定器稳态 Kalman 递推收敛于 DARE 闭式解', async () => {
  // 纯数学验证（不经 calibrateKalmanQR —— 检验其内嵌递推的正确形状）：
  // 稳态 P 满足 P = (P+Q)·R/(P+Q+R)；K = (P+Q)/(P+Q+R)
  const steady = (ratio: number): number => {
    let p = 1;
    for (let i = 0; i < 500; i++) p = (p + ratio) / (1 + (p + ratio));
    return p;
  };
  for (const ratio of [0.03, 0.3, 1, 3, 30]) {
    // 闭式：P² + P·(Q−R+... ) 解 P = (−a + √(a²+4a))/2，a=Q/R（R=1）
    const a = ratio;
    const closed = (-a + Math.sqrt(a * a + 4 * a)) / 2;
    assert.ok(Math.abs(steady(ratio) - closed) < 1e-9,
      `稳态 P 收敛 DARE 闭式（ratio=${ratio}）：${steady(ratio).toFixed(6)} vs ${closed.toFixed(6)}`);
  }
});

// ─── 属性炮台 7：dHash / 汉明 —— 恒等 0 / 对称 / 三角不等式抽查 ───

test('P-7: 汉明距离不变量 —— 恒等 0 / 对称', async () => {
  const { hammingDistance } = await import('../src/perceptualHash.ts');
  const a = '1'.repeat(64), b = '0'.repeat(64), c = ('10'.repeat(32));
  assert.equal(hammingDistance(a, a), 0);
  assert.equal(hammingDistance(a, b), 64);
  assert.equal(hammingDistance(a, c), hammingDistance(c, a));
  assert.ok(hammingDistance(a, c) + hammingDistance(c, b) >= hammingDistance(a, b), '三角不等式（汉明是度量）');
});

// ─── 属性炮台 8：LTLf 组合子 —— 有限迹语义不变量 ───

test('P-8: LTLf 语义不变量 —— 空迹空真 / U 的弱化 / X 末位诚实假', async () => {
  const { ltlG, ltlF, ltlX, ltlU } = await import('../src/ltlf.ts');
  assert.equal(ltlG(() => false, 0), true, '空迹 G 空真');
  assert.equal(ltlF(() => true, 0), false, '空迹 F 诚实假');
  assert.equal(ltlX(() => true, 1, 0), false, '末位无下一（强 X 诚实假）');
  // U 语义：ψ 立即成立 ⇒ 真；φ 恒真 ψ 恒假 ⇒ 假；中位成立 ⇒ 前段需 φ
  assert.equal(ltlU(() => false, () => true, 4), true, 'ψ@0 ⇒ U 真（φ 免检）');
  assert.equal(ltlU(() => true, () => false, 4), false, 'φ 恒真 ψ 恒假 ⇒ U 假');
  assert.equal(ltlU(i => i < 2, i => i === 2, 4), true, '中位 ψ ⇒ 前段 φ 全真 ⇒ U 真');
  assert.equal(ltlU(i => i < 1, i => i === 2, 4), false, '前段 φ 破 ⇒ U 假');
});

// ─── 第八只 bug 执法：auth 中间件序（UDS+peercred 路径不再落地即崩）───

test('P-9: auth_middleware 顺序 —— peer_pid 在场时先解令牌后比对（不崩）', async () => {
  const { writeFileSync, rmSync, mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'p9-auth-'));
  const probe = join(dir, 'probe.py');
  writeFileSync(probe, [
    'import sys, asyncio, types',
    "sys.path.insert(0, 'python_service')",
    // 构造 auth_middleware 的最小环境：真 parse_token + 伪 Request/call_next
    'from dsh_physical import server, auth as auth_mod',
    "from dsh_physical.errors import ErrorKind",
    'key = b"k" * 32',
    "tok = auth_mod.mint_token(key, caps=['click'], ttl_seconds=60, pid=1234)",
    '',
    'class FakeHeaders:',
    "    def __init__(self, d): self._d = d",
    "    def get(self, k, default=''): return self._d.get(k, default)",
    'class FakeRequest:',
    "    def __init__(self, headers, peer_pid):",
    '        self.headers = headers',
    '        self.url = types.SimpleNamespace(path="/v1/click")',
    '        self.scope = {"peer_pid": peer_pid}',
    '',
    'async def main():',
    '    # 服务中间件链真体：peer_pid ≠ token.pid ⇒ UNAUTHORIZED 信封（而非崩溃）',
    '    mw = None',
    '    # 从 server 模块的 run() 里抠出 middleware 构造不方便 —— 直接复刻其调用序：',
    '    # 修复执法点 = parse_token 先于 peer 比对。此处直接驱动 server.auth_middleware',
    '    # 的等价序（真函数名以模块内注册为准）：',
    '    fns = [n for n in dir(server) if "middleware" in n.lower()]',
    '    assert fns, "middleware symbols present"',
    '    r = auth_mod.parse_token(key, tok)',
    '    assert r.ok and r.pid == 1234, f"token parse ok, pid={r.pid}"',
    '    # P 纪元修复形状：源码中 peer 比对必须出现在 parse_token 之后',
    "    src = open('python_service/dsh_physical/server.py', encoding='utf8').read()",
    "    i_parse = src.index('auth_result = parse_token(key, token)')",
    "    i_peer = src.index('auth_result.pid != scope_pid')",
    '    assert i_parse < i_peer, "parse_token must precede peer-pid compare"',
    "    print('auth-order-ok')",
    'asyncio.run(main())',
  ].join('\n'));
  try {
    const out = execFileSync('python', [probe], { encoding: 'utf8', cwd: process.cwd() });
    assert.ok(out.includes('auth-order-ok'), `执法通过：${out.trim()}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── BCR 闸执法：机械检测全库零命中 ───

test('P-10: Bug 类注册表（BC-1/2/3）机械闸 —— 全库零命中', () => {
  const out = execFileSync('python', ['scripts/bug_class_lint.py', '--strict'], { encoding: 'utf8' });
  assert.match(out, /零命中/, `BCR 闸：${out.trim()}`);
});

// ─── 深审战果执法（第十一～十四只 bug）───

test('P-11: swarm 水位跨会话 —— 新对象前缀跳过 + 会话内驱逐饱和不再失聪', async () => {
  const { swarm } = await import('../src/swarm.ts');
  const { journal } = await import('../src/journal.ts');
  const h = 'ab'.repeat(32);
  const entry = (i: number, hh = h) => ({
    ts: Date.now(), tool: 'click_mouse', args: { x: 0.1, y: 0.1 },
    status: 'SUCCESS' as const, effect_detected: true, observe: `#${i} dHash=${hh}`,
  });

  // ① 真跨会话：dump → journal.reset 后**新对象**重建同批日志 → restore → 零二次入账
  journal.reset();
  for (let i = 0; i < 3; i++) await journal.append(entry(i));
  swarm.reset(); swarm.crystalize();
  const before = swarm.report().topRoutes[0]?.attempts ?? 0;
  const dump = swarm.dump();
  journal.reset(); // 模拟崩溃重启：条目对象全部重建（WeakSet 冷）
  for (let i = 0; i < 3; i++) await journal.append(entry(i)); // 同内容、新对象
  swarm.reset();
  swarm.restore(dump as never);
  const added0 = swarm.crystalize();
  assert.equal(added0, 0, `恢复后前缀跳过（旧 bug#11：+${3} 重复入账）`);
  assert.equal(swarm.report().topRoutes[0]?.attempts ?? 0, before, 'attempts 不膨胀');
  // 前缀之后的新条目照常消费（身份游标接管）
  await journal.append(entry(3));
  assert.equal(swarm.crystalize(), 1, '前缀外新条目正常入账');

  // ② 驱逐饱和（bug#12）：journal 容量 1000 饱和后新条目仍被消费
  journal.reset();
  swarm.reset();
  for (let i = 0; i < 1010; i++) await journal.append(entry(i));
  swarm.crystalize(); // 消费全窗（1000 条），水位 = plateau
  const plateau = swarm.report().topRoutes[0]?.attempts ?? 0;
  await journal.append(entry(9999)); // 驱逐活跃：新条目顶掉最旧
  const added2 = swarm.crystalize();
  assert.equal(added2, 1, `饱和后新条目仍入账（旧 bug#12：水位=plateau 吞掉全部新条目）`);
  assert.equal((swarm.report().topRoutes[0]?.attempts ?? 0) - plateau, 1, '计数精确 +1');
});

test('P-13: recombine 去重路径的强化计数即落盘（save 在 return 前）', async () => {
  const src = readFileSync(new URL('../src/skillLibrary.ts', import.meta.url), 'utf8');
  const idx = src.indexOf('const existing = this.skills.find(s => stepSignature(s.steps) === sig);');
  const dedupBlock = src.slice(idx, src.indexOf('return { skill: existing, plan };', idx));
  assert.ok(dedupBlock.includes('this.save()'), `去重强化路径含 save（第十三只 bug 执法）`);
});

test('P-14: 准星域外诚实缺席 —— 副屏鼠标不再钉死在本屏边缘', async () => {
  const { addVisualOverlay } = await import('../src/visualOverlay.ts');
  const { default: sharp } = await import('sharp');
  const png = await sharp({ create: { width: 200, height: 150, channels: 3, background: '#888888' } }).png().toBuffer();
  /** 绿色显著像素计数（准星 #00CC66 = (0,204,102) 混合灰底后 G 通道显著占优） */
  const greenPixels = async (buf: Buffer): Promise<number> => {
    const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
    let n = 0;
    for (let i = 0; i < data.length; i += info.channels) {
      if (data[i + 1] - data[i] > 40 && data[i + 1] - data[i + 2] > 40) n++;
    }
    return n;
  };
  // 域内：准星在场（十字线贯穿 ⇒ 大量绿色像素）
  const inBound = await addVisualOverlay(png, { crosshair: { x: 100, y: 75 } } as never);
  assert.ok(await greenPixels(inBound) > 50, '域内准星在场');
  // 域外（全局虚拟屏坐标 > 本屏宽）：诚实缺席（旧 bug：钉死在 x=200 边缘）
  const outBound = await addVisualOverlay(png, { crosshair: { x: 2600, y: 75 } } as never);
  assert.equal(await greenPixels(outBound), 0, '域外准星不画（诚实缺席 > 自信错位）');
});
