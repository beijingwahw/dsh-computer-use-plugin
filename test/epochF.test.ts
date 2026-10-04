// test/epochF.test.ts
// F 纪元（第六维·压缩认知与统计推断）回归测试 —— 六个引擎各一节，防其借尸还魂：
//   F-1 SEQUITUR 文法归纳：无损展开 / 规则效用 / 动机挖掘（压缩即学习）
//   F-2 极值理论延迟尾：GPD 矩估计恢复已知形状 / 样本不足诚实缺席
//   F-3 贝叶斯弹窗信念：Schmitt 迟滞（单帧触发 / 迟滞保持 / 双清洁退出）
//   F-4 LZ76 行为熵率：Kolmogorov 逼近（周期→低 / 多样→高）
//   F-5 Kalman 漂移滤波：非平稳跟踪（均值兼容 + 新观测主导 + 方差置信）
//   F-6 经验晶体反事实：同场景工具成功率前馈
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequitur, expandGrammar, expandSymbols } from '../src/sequitur.ts';
import { skillLibrary } from '../src/skillLibrary.ts';
import { fitGpdTail } from '../src/telemetry.ts';
import { telemetry } from '../src/telemetry.ts';
import { SchmittPopupFilter, resetPopupBelief, resetPopupSprt, detectPopup } from '../src/popupDetector.ts';
import { journal, lempelZivComplexity, normalizedActionComplexity } from '../src/journal.ts';
import { swarm } from '../src/swarm.ts';

// ─── F-1：SEQUITUR 文法归纳 ───

test('F-1 无损性 + 规则效用：文法展开逐符号重建输入；一切规则引用 ≥2', () => {
  // 伪随机但确定的符号流（LCG）+ 一段重复注入
  const base: string[] = [];
  let x = 12345;
  for (let i = 0; i < 120; i++) {
    x = (1103515245 * x + 12345) % 2147483648;
    base.push(`s${x % 17}`);
  }
  const motif = ['m0', 'm1', 'm2', 'm3'];
  const seq = [...base.slice(0, 60), ...motif, ...base.slice(60), ...motif, ...motif.slice(0, 2)];
  const grammar = sequitur(seq);
  // 无损性（MDL 的前提：压缩不丢信息）
  assert.deepEqual(expandGrammar(grammar), seq);
  // 规则效用（无用规则必须被内联回消）
  for (const r of grammar.rules.values()) {
    assert.ok(r.usage >= 2, `规则 ${r.symbols.join(',')} 引用 ${r.usage} < 2 —— 效用约束被破`);
  }
});

test('F-1 重复子序列成规则：abc 出现三次 ⇒ 文法含该动机（长度 3）', () => {
  const seq = ['a', 'b', 'c', 'x', 'a', 'b', 'c', 'y', 'a', 'b', 'c'];
  const grammar = sequitur(seq);
  const motifs = [...grammar.rules.values()]
    .filter(r => r.expandedLength >= 3);
  assert.ok(motifs.length >= 1, '应归纳出 ≥3 步的规则');
  const syms = expandSymbols(grammar, motifs[0].symbols);
  assert.deepEqual(syms, ['a', 'b', 'c']);
  assert.equal(motifs[0].usage, 3, 'abc 动机被引用三次');
});

test('F-1 无结构输入 ⇒ 零规则（无重复即无文法）', () => {
  const grammar = sequitur(['q1', 'w2', 'e3', 'r4', 't5', 'y6']);
  assert.equal(grammar.rules.size, 0);
});

test('F-1 mineMotifs：日志中重复两次的序列块被挖出（跨任务动机发现）', async () => {
  journal.reset();
  skillLibrary.reset();
  skillLibrary.configure(true, '', 50);
  const block = [
    { tool: 'click_mouse', args: { x: 0.5, y: 0.5 } },
    { tool: 'type_text', args: { text: 'hi' } },
    { tool: 'scroll_page', args: { direction: 'down', amount: 3 } },
    { tool: 'press_hotkey', args: { keys: ['enter'] } },
  ];
  for (let round = 0; round < 2; round++) {
    for (const s of block) await journal.append({ ts: Date.now(), tool: s.tool, args: s.args, status: 'SUCCESS' });
  }
  const motifs = skillLibrary.mineMotifs();
  assert.ok(motifs.length >= 1, '应挖出至少一个重复动机');
  const m = motifs[0];
  // 文法归纳找的是极大重复块：整段四步轮次本身重复 ⇒ 动机 = 完整块
  assert.equal(m.steps.length, 4);
  assert.equal(m.usage, 2);
  assert.deepEqual(m.steps.map(s => s.tool), ['click_mouse', 'type_text', 'scroll_page', 'press_hotkey']);
});

// ─── F-2：极值理论延迟尾（GPD 矩估计）───

/** 确定性 GPD 样本：逆 CDF 均匀网格（无随机 —— 测试可复现） */
function gpdSamples(xi: number, sigma: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => {
    const u = (i + 0.5) / n; // (0,1) 均匀网格
    return xi === 0 ? -sigma * Math.log(u) : (sigma / xi) * (Math.pow(1 - u, -xi) - 1);
  });
}

test('F-2 GPD 矩估计：ξ=0.4 重尾样本被恢复（Pickands 渐近域内）', () => {
  const fit = fitGpdTail(gpdSamples(0.4, 10, 400));
  assert.ok(fit, '400 样本应可拟合');
  assert.ok(Math.abs(fit!.xi - 0.4) <= 0.15, `ξ 估计 ${fit!.xi} 应在 0.4±0.15`);
  assert.ok(fit!.p999 > fit!.threshold, 'p999 外推应在阈值之上（极值外推本职）');
});

test('F-2 GPD 矩估计：指数尾（ξ=0）被识别为轻尾', () => {
  const fit = fitGpdTail(gpdSamples(0, 5, 400));
  assert.ok(fit);
  assert.ok(Math.abs(fit!.xi) <= 0.25, `ξ 应近 0，实际 ${fit!.xi}`);
});

test('F-2 样本不足 ⇒ null（拒绝拟合优于谎言拟合）', () => {
  assert.equal(fitGpdTail([1, 2, 3, 4, 5]), null);
  assert.equal(fitGpdTail([]), null);
});

test('F-2 telemetry.tailReport：GPD 形状的重尾延迟池产出非空报告（消费者集成）', () => {
  telemetry.reset();
  telemetry.configure(true);
  // 90% 常规延迟 + 10% 真 GPD(ξ=0.4) 形状尖峰（矩法对非 GPD 形状会诚实拒绝 ——
  // 上位保护：均匀尖峰 k<0.5 出域 ⇒ null，不伪装拟合）
  const spikes = gpdSamples(0.4, 200, 36);
  for (let i = 0; i < 360; i++) {
    const heavy = i % 10 === 0;
    telemetry.observe('take_screenshot', 'SUCCESS',
      heavy ? 460 + spikes[i / 10] : 40 + (i % 7) * 10);
  }
  const tail = telemetry.tailReport();
  assert.ok(tail, 'GPD 形状重尾池应可拟合');
  assert.ok(tail!.xi > 0.1, `重尾池应显正 ξ，实际 ${tail!.xi}`);
});

// ─── F-3：贝叶斯弹窗信念（Schmitt 迟滞）───

test('F-3 单帧强证据立即 ON（旧行为兼容）；迟滞带内单帧噪声不翻转', () => {
  const f = new SchmittPopupFilter();
  // 单帧几何：ON（与旧逐帧布尔一致）
  let r = f.update({ geometric: true, semantic: false });
  assert.equal(r.active, true, '单帧几何证据 ⇒ 立即 ON');
  assert.ok(r.belief >= 0.6);
  // ON 态遇单帧清洁：落入迟滞带，保持 ON（传感器抖动不再震荡守卫）
  r = f.update({ geometric: false, semantic: false });
  assert.equal(r.active, true, '单帧清洁 ⇒ 迟滞保持（不翻转）');
  assert.ok(r.belief < 0.6 && r.belief > 0.35, `信念应落入迟滞带，实际 ${r.belief}`);
  // 第二帧清洁：跌破 OFF 线 ⇒ 放行
  r = f.update({ geometric: false, semantic: false });
  assert.equal(r.active, false, '双清洁帧 ⇒ 退出（真关了才放行）');
});

test('F-3 语义证据更强：单帧语义 ON；清洁场景恒 OFF', () => {
  const f = new SchmittPopupFilter();
  assert.equal(f.update({ geometric: false, semantic: false }).active, false);
  assert.equal(f.update({ geometric: false, semantic: false }).active, false);
  const g = new SchmittPopupFilter();
  assert.equal(g.update({ geometric: false, semantic: true }).active, true, '单帧语义 ⇒ ON');
  resetPopupBelief(); // 生命周期归零通道在场（模块级单例不泄漏）
});

// ─── ΝΩ-32：popupDetector 语义通道帧复用（有 buffer ⇒ 零服务端自截）───
//
// 病灶：take_screenshot 已把 cap.buffer 传给 detectPopup，但语义 OCR 通道仍先走
// readTextAny（服务端 L2 自截一帧）—— 同一屏同一时刻的第二次截屏是纯浪费。
// 立法后：有 buffer ⇒ 帧通道（sharp 中央带裁剪 + 本地 OCR）零自截；buffer 缺席
// ⇒ 服务端 L2 旧路径零回归。全离线确定性：假 adapter（计数服务端面）+
// 假 OCR worker（textReader._setWorkerFactory_forTest 注入缝）+ 真像素帧（sharp）。

test('ΝΩ-32 F-3a: 调用方帧在场 ⇒ 词表命中（帧通道 OCR）且零自截（adapter 服务端面零调用）', async () => {
  const { default: sharp } = await import('sharp');
  const backend = await import('../src/physicalBackend.ts');
  const { _setWorkerFactory_forTest } = await import('../src/textReader.ts');

  // 服务端面计数器：take_screenshot（截屏）与 get_ui_tree（服务端自截 OCR）
  let serverShots = 0, uiTreeCalls = 0;
  backend._setAdapterForTests({
    takeScreenshot: async () => {
      serverShots++;
      return { ok: false as const, error: 'census: 不该发生服务端截屏' };
    },
    getUiTree: async () => {
      uiTreeCalls++;
      return { ok: false as const, error: 'census: 不该发生服务端自截 OCR' };
    },
  } as never);
  // 真像素帧（≥32px 才进帧通道）+ 假 OCR worker（词表命中的文本）
  const frame = await sharp(Buffer.alloc(200 * 200 * 3, 128), {
    raw: { width: 200, height: 200, channels: 3 },
  }).png().toBuffer();
  _setWorkerFactory_forTest(async () => ({
    recognize: async () => ({
      data: { text: 'We use cookies. Accept all?', words: [], lines: [] },
    }),
    terminate: async () => { /* 生命周期占位 */ },
  }) as never);
  resetPopupBelief();
  resetPopupSprt();
  try {
    const det = await detectPopup(frame, {
      enableOcr: true, popupKeywords: 'cookie,accept,更新', ocrLang: 'eng',
    }, null);
    assert.equal(det.semantic, true, '帧通道 OCR 命中词表');
    assert.ok(det.matchedKeywords.includes('cookie') && det.matchedKeywords.includes('accept'),
      `命中词随行（实际 ${JSON.stringify(det.matchedKeywords)}）`);
    assert.equal(serverShots, 0, '零服务端截屏（take_screenshot 面）');
    assert.equal(uiTreeCalls, 0, '零服务端自截 OCR（get_ui_tree 面）');
  } finally {
    backend._setAdapterForTests(null);
    _setWorkerFactory_forTest(null);
    resetPopupBelief();
    resetPopupSprt();
  }
});

test('ΝΩ-32 F-3b: 帧缺席（无帧调用方）⇒ 服务端 L2 路径零回归（getUiTree 恰一次）', async () => {
  const backend = await import('../src/physicalBackend.ts');
  let uiTreeCalls = 0;
  backend._setAdapterForTests({
    getUiTree: async () => {
      uiTreeCalls++;
      return {
        ok: true as const,
        value: {
          funnel_depth: 'l2',
          elements: [
            { source: 'L2-ocr', name: 'Accept cookies?', rect: { x: 0.2, y: 0.3, width: 0.6, height: 0.2 } },
          ],
        },
      };
    },
  } as never);
  resetPopupBelief();
  resetPopupSprt();
  try {
    const det = await detectPopup(null, {
      enableOcr: true, popupKeywords: 'cookie,accept', ocrLang: 'eng',
    }, null);
    assert.equal(det.semantic, true, '无帧路径照走服务端 L2（旧行为）');
    assert.equal(uiTreeCalls, 1, '服务端自截 OCR 恰一次（无帧专属，不重复）');
  } finally {
    backend._setAdapterForTests(null);
    resetPopupBelief();
    resetPopupSprt();
  }
});

test('ΝΩ-32 F-3c: 帧在场但 OCR 失败 ⇒ 语义证据诚实缺席（[]）且不回退自截（零自截律）', async () => {
  const { default: sharp } = await import('sharp');
  const backend = await import('../src/physicalBackend.ts');
  const { _setWorkerFactory_forTest, disposeOcr } = await import('../src/textReader.ts');

  let uiTreeCalls = 0;
  backend._setAdapterForTests({
    getUiTree: async () => {
      uiTreeCalls++;
      return { ok: false as const, error: 'census: 有帧不得回退自截' };
    },
  } as never);
  const frame = await sharp(Buffer.alloc(200 * 200 * 3, 128), {
    raw: { width: 200, height: 200, channels: 3 },
  }).png().toBuffer();
  // worker 池先清（F-3a 注入的 'eng' worker 会被 Map 缓存复用 —— 池不空则
  // 本用例的失败工厂根本不会被咨询）；帧通道 OCR 失败 ⇒ 语义缺席，不回退
  await disposeOcr();
  _setWorkerFactory_forTest(async () => {
    throw new Error('ocr offline');
  });
  resetPopupBelief();
  resetPopupSprt();
  try {
    const det = await detectPopup(frame, {
      enableOcr: true, popupKeywords: 'cookie,accept', ocrLang: 'eng',
    }, null);
    assert.equal(det.semantic, false, '语义证据诚实缺席');
    assert.deepEqual(det.matchedKeywords, []);
    assert.equal(uiTreeCalls, 0, '失败也不得回退服务端自截（零自截律）');
  } finally {
    backend._setAdapterForTests(null);
    _setWorkerFactory_forTest(null);
    resetPopupBelief();
    resetPopupSprt();
  }
});

test('ΝΩ-32 F-3d: take_screenshot 工具面 —— OCR 开启 ⇒ popupDetector 零额外截屏（cap.buffer 直通）', async () => {
  const { default: sharp } = await import('sharp');
  const { createTakeScreenshotTool } = await import('../src/tools/takeScreenshot.ts');
  const { system } = await import('../src/system.ts');
  const backend = await import('../src/physicalBackend.ts');
  const { _setWorkerFactory_forTest, disposeOcr } = await import('../src/textReader.ts');

  // 工具自身捕获走假 system（captureScreenWithOverlay）；服务端 adapter 只数
  // 「额外」截屏 —— 立法后 popupDetector 不得再产生任何一次
  let extraShots = 0, uiTreeCalls = 0;
  backend._setAdapterForTests({
    takeScreenshot: async () => {
      extraShots++;
      return { ok: false as const, error: 'census: 不该有额外服务端截屏' };
    },
    getUiTree: async () => {
      uiTreeCalls++;
      return { ok: false as const, error: 'census: 不该有服务端自截 OCR' };
    },
  } as never);

  const jpeg = await sharp(Buffer.alloc(400 * 300 * 3, 128), {
    raw: { width: 400, height: 300, channels: 3 },
  }).jpeg().toBuffer();
  const savedSystem: Record<string, unknown> = {};
  const host = system as unknown as Record<string, unknown>;
  const fakeSystem = {
    getActiveDisplay: async () => ({ name: 'Primary', x: 0, y: 0, width: 1920, height: 1080 }),
    getMousePosition: async () => ({ x: 960, y: 540 }),
    getScreenSize: async () => ({ width: 1920, height: 1080 }),
    captureScreenWithOverlay: async () => ({
      buffer: jpeg, width: 400, height: 300,
      dhash: '0011223344556677', phash: null, regionDhash: null,
      unchanged: false, frameId: null, transport: 'base64', salience: null,
    }),
  };
  for (const [k, v] of Object.entries(fakeSystem)) {
    savedSystem[k] = host[k];
    host[k] = v;
  }
  // worker 池先清（前用例的 'eng' worker 会被 Map 缓存 —— 本用例文本自证）
  await disposeOcr();
  _setWorkerFactory_forTest(async () => ({
    recognize: async () => ({
      data: { text: 'Accept cookies to continue', words: [], lines: [] },
    }),
    terminate: async () => { /* 生命周期占位 */ },
  }) as never);
  resetPopupBelief();
  resetPopupSprt();
  const tool: any = createTakeScreenshotTool({
    compressWidth: 1440, jpegQuality: 75, gridDivisions: 10,
    maxImageCount: 9, maxContextImageKb: 4096,
    enableElementIdMode: false, enableQuantumSense: false,
    enableOcr: true, popupKeywords: 'cookie,accept', ocrLang: 'eng',
    stableScreenDistance: 3,
  } as never);
  try {
    const raw = String(await tool.execute({}, undefined));
    const out = JSON.parse(raw);
    assert.equal(out.status, 'SUCCESS', '工具面照常成功');
    assert.equal(out.state_anchor.popup_detected, true, '语义通道经 cap.buffer 命中（弹窗态在场）');
    assert.match(out.state_anchor.popup_evidence, /cookie/, '锚点证据含命中词');
    assert.equal(extraShots, 0, 'popupDetector 零额外服务端截屏（take_screenshot 面零调用）');
    assert.equal(uiTreeCalls, 0, 'popupDetector 零服务端自截 OCR（get_ui_tree 面零调用）');
  } finally {
    for (const [k, v] of Object.entries(savedSystem)) host[k] = v;
    backend._setAdapterForTests(null);
    _setWorkerFactory_forTest(null);
    resetPopupBelief();
    resetPopupSprt();
  }
});

// ─── F-4：LZ76 行为熵率 ───

test('F-4 LZ76：周期流低熵率 / 多样流高熵率 / 诚实下限', () => {
  // 周期 1：400 个同符号 → 短语对数增长（≈log₂n），熵率 ≪ 1
  const periodic = normalizedActionComplexity(Array.from({ length: 400 }, () => 'a'));
  assert.ok(periodic !== null && periodic <= 0.3, `同符号熵率 ${periodic} 应 ≤0.3`);
  // 周期 2：ab 交替 → 短语翻倍增长，同样低熵
  const alt: string[] = [];
  for (let i = 0; i < 200; i++) { alt.push('a', 'b'); }
  const altRate = normalizedActionComplexity(alt);
  assert.ok(altRate !== null && altRate <= 0.35, `交替熵率 ${altRate} 应 ≤0.35`);
  // 多样流：40 个互异符号 → 与同字母表随机等复杂
  const diverse = normalizedActionComplexity(Array.from({ length: 40 }, (_, i) => `t${i}`));
  assert.ok(diverse !== null && diverse >= 0.9, `互异熵率 ${diverse} 应 ≥0.9`);
  // 诚实下限
  assert.equal(normalizedActionComplexity(['a', 'b']), null);
  assert.equal(lempelZivComplexity([]), 0);
});

test('F-4 journal.actionComplexity：交替动作日志 ⇒ 近周期签名', async () => {
  journal.reset();
  for (let i = 0; i < 400; i++) {
    await journal.append({
      ts: Date.now(), tool: i % 2 === 0 ? 'click_mouse' : 'scroll_page',
      args: i % 2 === 0 ? { x: 0.5, y: 0.5 } : { direction: 'down', amount: 3 }, status: 'SUCCESS',
    });
  }
  const c = journal.actionComplexity();
  assert.equal(c.length, 400);
  // 短语倍增签名：400 个动作只切出个位数短语（指数压缩 = 确定性行为）
  assert.ok(c.phrases <= 12, `交替行为短语数 ${c.phrases} 应个位数量级（卡死签名）`);
  assert.ok(c.normalized !== null && c.normalized <= 0.35, `交替行为熵率 ${c.normalized} 应 ≤0.35`);
});

// ─── F-5：Kalman 漂移滤波 ───

test('F-5 Kalman：双观测与均值兼容（0.05,0.07 → ≈0.06）；置信度 ∈ (0,1]', () => {
  swarm.reset();
  swarm.configure('', 300_000, 500);
  const h = '1'.repeat(64);
  swarm.observeDrift(h, 0.05, -0.03);
  swarm.observeDrift(h, 0.07, -0.05);
  const p = swarm.predictDrift(h);
  assert.ok(p, '同场景应可预测');
  assert.ok(Math.abs(p!.dx - 0.06) < 0.01, `双观测估计 ${p!.dx} 应近均值 0.06`);
  assert.ok(p!.confidence > 0 && p!.confidence <= 1, `置信度 ${p!.confidence} 应 ∈ (0,1]`);
  // 远场景不预测（门控不变）
  assert.equal(swarm.predictDrift('0'.repeat(64)), null);
});

test('F-5 Kalman 遗忘性：非平稳世界中新观测主导（等权均值做不到）', () => {
  swarm.reset();
  const h = '2'.repeat(64);
  swarm.observeDrift(h, 0, 0);
  swarm.observeDrift(h, 0, 0);
  swarm.observeDrift(h, 0, 0);
  swarm.observeDrift(h, 0.2, 0); // UI 刚改版：漂移跳变
  const p = swarm.predictDrift(h);
  // 等权均值 = 0.05；Kalman（稳态 K≈2/3）≈ 0.12+ —— 旧世界被遗忘
  assert.ok(p && p.dx > 0.1, `改版后估计 ${p?.dx} 应显著偏向新观测（>0.1）`);
});

// ─── F-6：经验晶体反事实 ───

test('F-6 counterfactual：同场景工具成功率前馈（attempts≥2 才入场）', async () => {
  swarm.reset();
  swarm.configure('', 300_000, 500);
  journal.reset();
  const scene = '#1 dHash=cafebeef popup=false';
  journal.noteObservation(scene);
  await journal.append({ ts: 1, tool: 'click_mouse', args: { x: 0.5 }, status: 'SUCCESS', effect_detected: true, observe: scene });
  await journal.append({ ts: 2, tool: 'click_mouse', args: { x: 0.6 }, status: 'SUCCESS', effect_detected: true, observe: scene });
  await journal.append({ ts: 3, tool: 'press_hotkey', args: { keys: ['enter'] }, status: 'FAILED', observe: scene });
  await journal.append({ ts: 4, tool: 'press_hotkey', args: { keys: ['enter'] }, status: 'FAILED', observe: scene });
  // 单次经验噪声地板之下的条目（不入场）
  await journal.append({ ts: 5, tool: 'drag_mouse', args: {}, status: 'SUCCESS', effect_detected: true, observe: scene });

  const fullHash = 'cafebeef' + '0'.repeat(56);
  const cf = swarm.counterfactual(fullHash);
  assert.equal(cf.length, 2, '两个 (scene,tool) 晶体入场（drag 单次被噪声地板挡下）');
  assert.equal(cf[0].tool, 'click_mouse', '尝试更多者优先');
  assert.equal(cf[0].successRate, 1);
  assert.equal(cf[0].attempts, 2);
  assert.equal(cf[1].tool, 'press_hotkey');
  assert.equal(cf[1].successRate, 0);
  assert.equal(cf[1].attempts, 2);
  // 异场景前缀 ⇒ 空前馈（诚实缺席）
  assert.equal(swarm.counterfactual('deadbeef' + '0'.repeat(56)).length, 0);
});
