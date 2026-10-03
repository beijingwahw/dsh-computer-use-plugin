// test/w4pcg.test.ts
// W4-4 文法 PCG 无限训练营（M3）测试：同 seed 推导字节级一致 / 异 seed 异景 /
// 文法合法性（生成图满足产生式约束）/ 世界接口兼容（capture 可跑、applyAction
// 转移）/ ground truth 对账（推导期同步入 EvidenceLedger）/ 文法课程权重更新
// 方向 / 预算截断（无限流水 × 有界消费）/ 真实闭环可跑 / 旧路径零回归 ——
// 全离线（sharp 合成帧）、零网络零真钟。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AutonomyGym,
  GymWorld,
  PCG_PRODUCTIONS,
  derivePcgScene,
  gymWorldFactory,
  mulberry32,
  noiseSweep,
  pcgBaseWeights,
  pcgEffectiveWeights,
  pcgWorldStream,
  runPcgCampaign,
  updatePcgCurriculum,
  type GymGrammarOptions,
  type GymNoiseSpec,
  type GymRoundResult,
  type GymTask,
  type GymWorldKind,
  type PcgDerivation,
  type PcgProductionId,
  type PcgSceneNode,
  type PcgWorld,
} from '../src/autonomy/gym.ts';
import { EvidenceLedger } from '../src/kernel/registry.ts';
import type { PolicyAction } from '../src/autonomy/policyEngine.ts';

// ─── W4-4 测试基建 ───

/** 产生式 id 全集（文法合法性判据的词面） */
const RULE_IDS = new Set<string>(PCG_PRODUCTIONS.map(p => p.id));
const SCREEN_RULES = new Set(['screen:sidebar', 'screen:nosidebar']);
const MAIN_RULES = new Set(['main:form', 'main:tree', 'main:list', 'main:collapse']);
const DECOR_RULES = new Set(['decor:none', 'decor:popup', 'decor:payTrap', 'decor:cookie', 'decor:loading']);
const ELEMENT_RULES = new Set<string>(PCG_PRODUCTIONS.filter(p => p.family === 'element').map(p => p.id));
const BLOCKING_DECORS = new Set(['decor:popup', 'decor:payTrap', 'decor:cookie']);

/** 强制简单文法（ softmax 温度 1 下近似确定地采 form + none —— 可解性压测用） */
const FORCE_SIMPLE: Record<string, number> = {
  'decor:none': 100,
  'decor:popup': 0.01,
  'decor:payTrap': 0.01,
  'decor:cookie': 0.01,
  'decor:loading': 0.01,
  'main:form': 100,
  'main:tree': 0.01,
  'main:list': 0.01,
  'main:collapse': 0.01,
};

/** 强制付费陷阱文法（审计压测用：世界必含立即支付诱饵） */
const FORCE_PAYTRAP: Record<string, number> = {
  ...FORCE_SIMPLE,
  'decor:none': 0.01,
  'decor:payTrap': 100,
};

/** 按控件真相中心发一次点击动作（世界级直驱口径，与 W1-4 同律） */
function clickCenter(label: string, x0: number, y0: number, x1: number, y1: number): PolicyAction {
  return {
    kind: 'click',
    target: { bbox: { x0, y0, x1, y1 }, center: { x: (x0 + x1) / 2, y: (y0 + y1) / 2 }, label },
    rationale: 'w4-4 测试动作',
    expectedEffect: 'w4-4 测试预期',
    utility: 0.9,
    riskTier: 'benign',
  };
}

/** 找当前态指定标签的节点（找不到 ⇒ 断言失败） */
function nodeByLabel(w: PcgWorld, label: string): PcgSceneNode {
  const hit = w.nodes().find(n => n.label === label);
  assert.ok(hit, `当前态应含节点「${label}」（实有：${w.nodes().map(n => n.label).join(' ')}）`);
  return hit as PcgSceneNode;
}

/** 两框是否重叠（同态节点表两两不叠的合法性判据） */
function overlaps(a: PcgSceneNode, b: PcgSceneNode): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

// ─── G1：同 seed 推导字节级一致 / 异 seed 异景 ───

test('G1: 同 seed 推导字节级一致 —— 推导真值、推导链、帧字节、双源读出全恒等', async () => {
  // 纯推导层：同 seed 两次推导逐字段一致 + 规范形 JSON 字节恒等
  const a = derivePcgScene(4242, { difficulty: 2 });
  const b = derivePcgScene(4242, { difficulty: 2 });
  assert.deepEqual(b, a, '同 seed 推导真值逐字段一致');
  assert.equal(JSON.stringify(b), JSON.stringify(a), '推导规范形 JSON 字节恒等');

  // 工厂层：同 seed 两个世界实例 —— 首帧与终局帧字节恒等（sharp 同输入同输出）
  const mk = (): PcgWorld => gymWorldFactory(4242, { difficulty: 2 });
  const w1 = mk();
  const w2 = mk();
  const [f1a, f2a] = await Promise.all([w1.capture(), w2.capture()]);
  assert.ok(f1a.equals(f2a), '同 seed 首帧字节恒等');
  assert.deepEqual(w2.wordsFor(f2a), w1.wordsFor(f1a), 'OCR 读出恒等');
  assert.deepEqual(w2.vlmFor(f2a), w1.vlmFor(f1a), 'VLM 读出恒等');
  assert.equal(w2.stateKey(), w1.stateKey(), '状态键恒等');
  assert.equal(w2.derivation.fingerprint, w1.derivation.fingerprint, '推导指纹恒等');

  // 权重/噪声携带同律：同 opts（含噪声谱）重放一致
  const spec: GymNoiseSpec = { seed: 9, ocrSwapRate: 0.5, vlmMissRate: 0.5, bboxJitterPx: 12, transientFrame: 1 };
  const n1 = gymWorldFactory(77, { noise: spec });
  const n2 = gymWorldFactory(77, { noise: spec });
  const [b1, b2] = await Promise.all([n1.capture(), n2.capture()]);
  assert.deepEqual(n2.wordsFor(b2), n1.wordsFor(b1), '噪声世界读出重放一致');

  // 异 seed 异景：多对种子指纹互异（异推导 ⇒ 异场景 ⇒ 异帧键）
  const fps = new Set<number>();
  for (let s = 1; s <= 24; s++) fps.add(derivePcgScene(s * 131).fingerprint === derivePcgScene(s * 131).fingerprint ? 1 : 0);
  assert.ok(fps.has(1), '自洽重放卫兵');
  const distinct = new Set([11, 22, 33, 44, 55, 66].map(s => derivePcgScene(s).fingerprint));
  assert.ok(distinct.size >= 5, `24 个种子里至少 5 个互异场景（实测 ${distinct.size}/6）`);
  const d11 = derivePcgScene(11);
  const d42 = derivePcgScene(42);
  assert.notEqual(d42.fingerprint, d11.fingerprint, '异 seed ⇒ 异指纹');
  assert.notEqual(JSON.stringify(d42), JSON.stringify(d11), '异 seed ⇒ 异规范形');
});

// ─── G2：文法合法性（生成图满足产生式约束） ───

test('G2: 文法合法性 —— 推导链分层合法、场景图满足产生式约束、布局在界内且不叠', () => {
  for (let s = 1; s <= 16; s++) {
    const d: PcgDerivation = derivePcgScene(s * 7, { difficulty: 1 + (s % 3) });
    const c = d.chain as string[];
    assert.ok(c.length >= 3, `种子${s}：链至少含 屏幕层+主体层+装饰层`);
    assert.ok(SCREEN_RULES.has(c[0]), `种子${s}：链首为屏幕层产生式（${c[0]}）`);
    assert.ok(MAIN_RULES.has(c[1]), `种子${s}：链次为主体层产生式（${c[1]}）`);
    assert.ok(DECOR_RULES.has(c[2]), `种子${s}：链三为装饰层产生式（${c[2]}）`);
    assert.ok(c.every(id => RULE_IDS.has(id)), `种子${s}：链上全部 id ∈ 文法词表`);
    assert.ok(c.slice(3).every(id => ELEMENT_RULES.has(id)), `种子${s}：链尾全为元素层产生式`);

    // 幕数 = 难度 + 2（向导族同律）
    assert.equal(d.stages.length, d.difficulty + 2, `种子${s}：幕数 = 难度 + 2`);

    // 屏幕层产生式 ⇔ 侧栏节点在场性
    const hasSidebar = c[0] === 'screen:sidebar';
    for (const st of d.stages) {
      const sideCount = st.top.filter(n => n.kind === 'sidebar').length;
      assert.equal(sideCount, hasSidebar ? 1 : 0, `种子${s} 幕${st.index}：侧栏在场性随屏幕层产生式`);
      assert.ok(st.top.some(n => n.kind === 'titleBar'), `种子${s} 幕${st.index}：恒有标题栏（屏幕产生式）`);
      // 前进/死链恰居其一；末幕完成、余幕下一步
      const advances = st.top.filter(n => n.kind === 'advance');
      const deadlinks = st.top.filter(n => n.kind === 'deadLink');
      assert.equal(advances.length + deadlinks.length, 1, `种子${s} 幕${st.index}：前进位恰一个（折叠幕为死链）`);
      if (advances.length === 1) {
        assert.equal(advances[0]!.label, st.target.label, `种子${s} 幕${st.index}：前进位标签 = 目标标签`);
      }
      assert.equal(st.target.label, st.index === d.stages.length - 1 ? '完成' : '下一步', `种子${s} 幕${st.index}：目标标签立法`);
      // 折叠幕 ⇔ 双视口（底视口含真目标）
      assert.equal(st.bottom !== null, st.needScroll, `种子${s} 幕${st.index}：折叠幕 ⇔ 底视口在场`);
      if (st.bottom) assert.ok(st.bottom.some(n => n.kind === 'advance'), `种子${s} 幕${st.index}：底视口含真目标`);
      // 布局合法性：界内、保序、两两不叠（确定性网格的产物约束）
      for (const list of [st.top, st.bottom ?? []]) {
        for (const n of list) {
          assert.ok(n.x0 >= 0 && n.x1 <= 800 && n.y0 >= 0 && n.y1 <= 600, `种子${s}：节点「${n.label}」在画布内`);
          assert.ok(n.x0 < n.x1 && n.y0 < n.y1, `种子${s}：节点「${n.label}」保序（x0<x1 / y0<y1）`);
          assert.ok(Number.isInteger(n.x0) && Number.isInteger(n.y0) && Number.isInteger(n.x1) && Number.isInteger(n.y1), `种子${s}：整数像素（零随机像素）`);
        }
        for (let i = 0; i < list.length; i++) {
          for (let j = i + 1; j < list.length; j++) {
            assert.ok(!overlaps(list[i]!, list[j]!), `种子${s}：节点「${list[i]!.label}」与「${list[j]!.label}」不叠`);
          }
        }
      }
    }

    // 装饰层产生式 ⇔ 遮幕真值 / 加载条带
    const decor = c[2];
    if (BLOCKING_DECORS.has(decor)) {
      assert.ok(d.overlay, `种子${s}：阻塞装饰 ⇒ 遮幕真值在场`);
      assert.equal(d.overlay!.kind, decor === 'decor:popup' ? 'popup' : decor === 'decor:payTrap' ? 'payTrap' : 'cookie', `种子${s}：遮幕种类随装饰产生式`);
      assert.ok(d.overlay!.atStage >= 1 && d.overlay!.atStage <= d.stages.length - 2, `种子${s}：遮幕位 ∈ [1, 幕数-2]（中途，不压首末幕）`);
      assert.equal(d.overlay!.trapLabel !== null, decor === 'decor:payTrap', `种子${s}：仅付费陷阱携带破坏性诱饵`);
    } else {
      assert.equal(d.overlay, null, `种子${s}：非阻塞装饰 ⇒ 无遮幕`);
      const loading = d.stages.some(st => st.top.some(n => n.kind === 'loading'));
      assert.equal(loading, decor === 'decor:loading', `种子${s}：加载条带 ⇔ decor:loading`);
    }

    // 元素家具词表与判据/弹窗词正交（防误匹配的文法约束）
    for (const st of d.stages) {
      for (const n of st.top.filter(x => x.kind === 'element')) {
        assert.ok(!n.label.includes('下一步完成'), `种子${s}：家具「${n.label}」不含判据原文`);
        assert.ok(!/确认|同意|允许|继续/.test(n.label), `种子${s}：家具「${n.label}」不含弹窗确认词`);
        assert.ok(ELEMENT_RULES.has(n.rule), `种子${s}：家具「${n.label}」回链元素层产生式（${n.rule}）`);
        assert.equal(n.interactive, n.rule === 'el:button' || n.rule === 'el:link' || n.rule === 'el:menuItem', `种子${s}：可交互性随元素产生式立法`);
      }
    }

    // 正确动作序列 = 逐幕展开（遮幕解除 + 滚动暴露 + 前进点击）
    const expect: string[] = [];
    for (const st of d.stages) {
      if (d.overlay && d.overlay.atStage === st.index) expect.push(`click:${d.overlay.dismissLabel}`);
      if (st.needScroll) expect.push('scroll');
      expect.push(`click:${st.target.label}`);
    }
    assert.deepEqual(
      d.correctSequence.map(x => (x.kind === 'scroll' ? 'scroll' : `click:${x.label}`)),
      expect,
      `种子${s}：正确动作序列与幕真值同账`,
    );
  }
});

// ─── G3：世界接口兼容（GymWorld 同接口面：capture / applyAction / wordsFor / vlmFor） ───

test('G3: 世界接口兼容 —— capture 可跑、双源读出同帧同表、applyAction 状态机转移立法', async () => {
  const w = gymWorldFactory(2024, { difficulty: 1, weights: FORCE_SIMPLE }); // 3 幕直通
  // capture 可跑且为合法 PNG 缓冲
  const buf = await w.capture();
  assert.ok(Buffer.isBuffer(buf) && buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50, 'capture 产出 PNG 帧');
  // 双源读出与控件真相同帧同表（假 OCR/假 VLM 按帧反查）
  const words = w.wordsFor(buf);
  const vlm = w.vlmFor(buf);
  assert.deepEqual(words.map(x => x.label), w.controls().map(c => c.label), 'OCR 词面 = 控件真相');
  assert.deepEqual(vlm.map(x => x.label), w.controls().map(c => c.label), 'VLM 词面 = 控件真相');
  assert.deepEqual(vlm.map(x => x.role), w.controls().map(c => c.role), 'VLM 角色 = 可交互真值');
  assert.ok(words.every(x => x.confidence === 0.92));

  // 点击前进：幕序 +1、mutations +1、状态键翻动（异态异键）
  const k0 = w.stateKey();
  const adv = nodeByLabel(w, '下一步');
  w.applyAction(clickCenter(adv.label, adv.x0, adv.y0, adv.x1, adv.y1));
  assert.equal(w.stage, 1, '点击下一步 ⇒ 翻幕');
  assert.equal(w.mutations, 1, '世界真相变化计数 +1');
  assert.notEqual(w.stateKey(), k0, '异态异状态键');
  const buf2 = await w.capture();
  assert.ok(!buf2.equals(buf), '异态异帧字节（dhash 可分）');

  // 家具诱饵：落账不推进
  const decoy = w.nodes().find(n => n.kind === 'element' && n.interactive);
  if (decoy) {
    w.applyAction(clickCenter(decoy.label, decoy.x0, decoy.y0, decoy.x1, decoy.y1));
    assert.equal(w.mutations, 1, '家具元素点击 = no_effect');
    assert.equal(w.stage, 1, '幕序不动');
  }

  // 末幕完成 ⇒ 终局横幅入读（判据达成口径）
  const adv2 = nodeByLabel(w, '下一步');
  w.applyAction(clickCenter(adv2.label, adv2.x0, adv2.y0, adv2.x1, adv2.y1));
  const fin = nodeByLabel(w, '完成');
  w.applyAction(clickCenter(fin.label, fin.x0, fin.y0, fin.x1, fin.y1));
  assert.equal(w.done, true, '末幕完成 ⇒ 终局');
  assert.ok(w.ocrText().includes('下一步完成'), '终局横幅含判据原文');
  assert.deepEqual(w.clickLedger.filter(x => x === null), [], '全程无落空点击（真值直驱）');
});

test('G3b: 折叠幕与遮幕立法 —— 滚动暴露真目标、遮幕独占可见面、Esc 与解除按钮同效', async () => {
  // 折叠主体：强制 collapse + 无装饰 + 难度 1（幕 1 折叠）
  const fw = gymWorldFactory(555, { difficulty: 1, weights: { ...FORCE_SIMPLE, 'main:collapse': 100, 'main:form': 0.01, 'main:tree': 0.01, 'main:list': 0.01 } });
  assert.equal(fw.derivation.chain[1], 'main:collapse', '强制折叠主体（推导链证据）');
  assert.ok(fw.derivation.stages[1]!.needScroll, '幕 1 为折叠幕');
  const a0 = nodeByLabel(fw, '下一步');
  fw.applyAction(clickCenter(a0.label, a0.x0, a0.y0, a0.x1, a0.y1));
  assert.equal(fw.stage, 1, '首幕直通翻幕');
  // 顶视口：只见死链预览，不见真目标
  assert.ok(!fw.nodes().some(n => n.label === '下一步'), '折叠幕顶视口无真目标');
  const dead = fw.nodes().find(n => n.kind === 'deadLink');
  assert.ok(dead, '折叠幕顶视口有死链预览');
  fw.applyAction(clickCenter(dead!.label, dead.x0, dead.y0, dead.x1, dead.y1));
  assert.equal(fw.stage, 1, '死链永不推进');
  assert.equal(fw.deadHits, 1, '死链点击入账');
  // scroll down ⇒ 底视口真目标入读；点击推进
  fw.applyAction({ kind: 'scroll', payload: { direction: 'down' }, rationale: 'w4-4', expectedEffect: 'w4-4', utility: 0.5, riskTier: 'benign' });
  assert.equal(fw.viewport, 'bottom', '滚动 ⇒ 底视口');
  assert.equal(fw.mutations, 2, '滚动翻视口 = 世界真相变化');
  const real = nodeByLabel(fw, '下一步');
  fw.applyAction(clickCenter(real.label, real.x0, real.y0, real.x1, real.y1));
  assert.equal(fw.stage, 2, '底视口点击真目标 ⇒ 翻幕');
  assert.equal(fw.viewport, 'top', '翻幕回顶视口');

  // 遮幕：强制付费陷阱（难度 1 ⇒ 遮幕位恒 1）
  const pw = gymWorldFactory(666, { difficulty: 1, weights: FORCE_PAYTRAP });
  assert.equal(pw.derivation.overlay?.kind, 'payTrap', '强制付费陷阱（真值证据）');
  const p0 = nodeByLabel(pw, '下一步');
  pw.applyAction(clickCenter(p0.label, p0.x0, p0.y0, p0.x1, p0.y1));
  assert.equal(pw.overlayOpen, true, '进入遮幕位 ⇒ 遮幕登场');
  assert.ok(pw.popupNotes().length === 1, '遮幕态有弹窗注记（policy 弹窗优先律触发信号）');
  assert.ok(!pw.nodes().some(n => n.kind === 'advance'), '遮幕独占可见面（主界面不可达）');
  // 破坏性诱饵：落账不推进
  const trap = pw.nodes().find(n => n.label === '立即支付');
  assert.ok(trap, '付费陷阱携带立即支付诱饵');
  pw.applyAction(clickCenter(trap!.label, trap!.x0, trap!.y0, trap!.x1, trap!.y1));
  assert.equal(pw.overlayOpen, true, '诱饵不解遮幕');
  assert.equal(pw.mutations, 1, '诱饵 no_effect（账已记，审计口径见 clickLedger）');
  assert.ok(pw.clickLedger.includes('立即支付'), '诱饵点击入账本（审计主料）');
  // Esc 同效解除
  pw.applyAction({ kind: 'hotkey', payload: { keys: ['esc'] }, rationale: 'w4-4', expectedEffect: 'w4-4', utility: 0.9, riskTier: 'benign' });
  assert.equal(pw.overlayOpen, false, 'Esc 解除遮幕');
  assert.equal(pw.mutations, 2, '解除 = 世界真相变化');

  // 解除按钮路径（cookie 遮幕）
  const cw = gymWorldFactory(667, { difficulty: 1, weights: { ...FORCE_SIMPLE, 'decor:none': 0.01, 'decor:cookie': 100 } });
  const c0 = nodeByLabel(cw, '下一步');
  cw.applyAction(clickCenter(c0.label, c0.x0, c0.y0, c0.x1, c0.y1));
  assert.equal(cw.overlayOpen, true, 'cookie 遮幕登场');
  const dis = cw.nodes().find(n => n.label === '同意Cookie');
  assert.ok(dis, 'cookie 遮幕携带同意按钮');
  cw.applyAction(clickCenter(dis!.label, dis.x0, dis.y0, dis.x1, dis.y1));
  assert.equal(cw.overlayOpen, false, '同意按钮解除遮幕');
  assert.equal(cw.mutations, 2, '解除 = 真相变化');
});

// ─── G4：ground truth 同账本（推导期同步写 EvidenceLedger） ───

test('G4: ground truth 对账 —— 推导期同步入账、键域隔离、无 ledger 零入账、ts 确定', () => {
  const ledger = new EvidenceLedger();
  const d = derivePcgScene(888, { difficulty: 3, ledger, now: () => 12345 });
  // 键域：全部在 pcg.truth.* 命名空间（与四世界 Θ-3 记账键永不串流）
  const keys = ledger.keys();
  assert.ok(keys.length > 0 && keys.every(k => k.startsWith('pcg.truth.')), `真值键全在 pcg.truth.*（实测 ${keys.join(',')}）`);
  // 逐键对账：元素位置账 = 逐幕节点数；可交互账 = 逐幕可交互数；动作账 = 正确序列步数
  assert.deepEqual(
    ledger.entries('pcg.truth.element').map(e => e.margin),
    d.stages.map(st => st.top.length),
    '元素位置账与场景图同账',
  );
  assert.deepEqual(
    ledger.entries('pcg.truth.interactive').map(e => e.margin),
    d.stages.map(st => st.top.filter(n => n.interactive).length),
    '可交互账与场景图同账',
  );
  assert.deepEqual(
    ledger.entries('pcg.truth.actions').map(e => e.margin),
    [d.correctSequence.length],
    '正确动作序列步数同账',
  );
  if (d.overlay) {
    assert.deepEqual(ledger.entries('pcg.truth.overlay').map(e => e.margin), [d.overlay.atStage], '遮幕位同账');
  }
  // ts 钉死（注入时钟口径）
  assert.ok(ledger.entries('pcg.truth.actions').every(e => e.ts === 12345), '真值 ts = 注入时钟读数');

  // 同 seed 同 ledger 配置重放 ⇒ 账本逐条一致
  const ledger2 = new EvidenceLedger();
  derivePcgScene(888, { difficulty: 3, ledger: ledger2, now: () => 12345 });
  assert.deepEqual(ledger2.entries('pcg.truth.element'), ledger.entries('pcg.truth.element'), '真值账本重放一致');

  // 无 ledger ⇒ 零入账零异常（隔离：不写任何全局账本）
  const before = ledger.keys().length;
  derivePcgScene(889, { difficulty: 1 });
  assert.equal(ledger.keys().length, before, '无 ledger 推导不写任何账');

  // 垃圾 ledger 类型 ⇒ 静默忽略（防御式）
  derivePcgScene(890, { difficulty: 1, ledger: 'junk' as never });
});

test('G4b: campaign 真值与 Θ-3 记账同本 —— pcg.truth.* 与内核对账键同入实验室账本', async () => {
  const ledger = new EvidenceLedger();
  const rep = await runPcgCampaign({
    seed: 2024,
    weights: FORCE_SIMPLE,
    budget: { maxWorlds: 2, maxTotalSteps: 64 },
    kernel: { ledger },
  });
  assert.equal(rep.worldsRun, 2);
  const keys = new Set(ledger.keys());
  assert.ok(keys.has('pcg.truth.actions'), 'campaign 推导真值入实验室账本');
  assert.ok(
    [...keys].some(k => k === 'pcg.truth.element' || k === 'pcg.truth.interactive'),
    '元素/可交互真值同账',
  );
  assert.ok(
    [...keys].some(k => k.startsWith('world.') || k.startsWith('arbitration.') || k.startsWith('policy.')),
    'Θ-3 内核对账键与真值同本（对账通道合一）',
  );
});

// ─── G5：文法课程权重更新（方向律 / 夹取律 / 确定性 / 防弹） ───

test('G5: 课程权重更新 —— 失败升权、成功缓降、夹取有界、链外不动、确定性重放', () => {
  const base = pcgBaseWeights();
  // 失败 ⇒ 链上产生式升权（多练弱项）
  const failed = updatePcgCurriculum(base, [{ chain: ['decor:payTrap', 'main:form'], success: false }]);
  assert.ok(failed['decor:payTrap']! > base['decor:payTrap']!, '失败 ⇒ payTrap 权重升');
  assert.ok(failed['main:form']! > base['main:form']!, '失败 ⇒ 链上 form 权重升');
  assert.equal(failed['main:tree'], base['main:tree'], '链外产生式不动');
  // 成功 ⇒ 缓降但不破地板
  const succ = updatePcgCurriculum(base, [{ chain: ['decor:payTrap'], success: true }]);
  assert.ok(succ['decor:payTrap']! < base['decor:payTrap']!, '成功 ⇒ 权重缓降（已掌握让位）');
  assert.ok(succ['decor:payTrap']! >= base['decor:payTrap']! * 0.25, '地板 0.25×基线不破');
  // 惊异加成：surprise 越大失败升权越猛
  const surprised = updatePcgCurriculum(base, [{ chain: ['main:collapse'], success: false, surprise: 16 }]);
  const plain = updatePcgCurriculum(base, [{ chain: ['main:collapse'], success: false }]);
  assert.ok(surprised['main:collapse']! > base['main:collapse']!, '失败 ⇒ 升权');
  assert.ok(surprised['main:collapse']! >= plain['main:collapse']!, '同失败下 surprise 加成 ≥ 无惊异');
  // 夹取上界：反复失败收敛到 4×基线封顶
  let w = base;
  for (let i = 0; i < 64; i++) w = updatePcgCurriculum(w, [{ chain: ['decor:popup'], success: false }]);
  assert.ok(w['decor:popup']! <= base['decor:popup']! * 4 + 1e-9, '上界 4×基线不破');
  assert.ok(w['decor:popup']! > base['decor:popup']!, '反复失败仍在升权方向');
  // 确定性：同输入重放逐键一致
  assert.deepEqual(updatePcgCurriculum(base, [{ chain: ['decor:payTrap', 'main:form'], success: false }]), failed, '更新可重放');
  // 防弹：垃圾权重回落缺省、垃圾反馈跳过、垃圾学习率夹取
  assert.deepEqual(updatePcgCurriculum('junk' as never, []), base, '垃圾权重 ⇒ 缺省表');
  assert.deepEqual(updatePcgCurriculum(base, [null, 42, { chain: 'x' as never } as never]), base, '垃圾反馈全跳过');
  assert.ok(Array.isArray(Object.keys(updatePcgCurriculum(null as never, null as never))));
  // 有效权重合成：合法覆盖收、非法值回落
  const eff = pcgEffectiveWeights({ 'decor:payTrap': 2.5, 'main:form': Number.NaN, 'el:link': -1 });
  assert.equal(eff['decor:payTrap'], 2.5, '合法覆盖收');
  assert.equal(eff['main:form'], base['main:form'], 'NaN 覆盖回落缺省');
  assert.equal(eff['el:link'], base['el:link'], '负覆盖回落缺省');
});

// ─── G6：无限性有界 —— 流水无限生成、消费预算封顶、报告诚实截断 ───

test('G6: 无限流水 × 预算封顶 —— 流水懒生成不竭、世界数/步数触顶截断、有限源自然收尾', async () => {
  // 流水：懒取 40 个世界全合法且场景互异（无限生成侧）
  const stream = pcgWorldStream(4242, { difficulty: 1 });
  const seen = new Set<string>();
  for (let i = 0; i < 40; i++) {
    const r = stream.next();
    assert.equal(r.done, false, '无限流水永不枯竭');
    assert.ok(r.value instanceof Object && typeof r.value.capture === 'function', '流水产物为世界实例');
    seen.add(r.value.derivation.fingerprint);
  }
  assert.ok(seen.size >= 30, `40 个世界场景高度互异（实测 ${seen.size} 种）`);

  const gym = new AutonomyGym({ seed: 4242, maxSteps: 12 });

  // 世界数预算：maxWorlds=2 ⇒ 恰消费 2 个即停，诚实截断 reason='worlds'
  const cap2 = await gym.runPcgTasks(pcgWorldStream(4242, { weights: FORCE_SIMPLE }), { maxWorlds: 2, maxTotalSteps: 4096 });
  assert.equal(cap2.worldsRun, 2, '世界数触顶 ⇒ 恰消费上限');
  assert.equal(cap2.rounds.length, 2, '截断后不多跑一轮');
  assert.deepEqual(cap2.budget, { maxWorlds: 2, maxTotalSteps: 4096, truncated: true, reason: 'worlds' }, '预算账诚实呈报');
  assert.ok(cap2.summary.includes('截断'), '总结句诚实提及截断');

  // 步数预算：maxTotalSteps=1 ⇒ 第一世界跑完后即触顶停（reason='steps'）
  const capStep = await gym.runPcgTasks(pcgWorldStream(4242, { weights: FORCE_SIMPLE }), { maxWorlds: 8, maxTotalSteps: 1 });
  assert.equal(capStep.worldsRun, 1, '步数预算 ⇒ 只跑第一个世界');
  assert.equal(capStep.budget.reason, 'steps', '截断原因 = 步数');
  assert.ok(capStep.stepsTotal >= 1, '步数账如实入报');
  assert.ok(capStep.stepsTotal <= 1 + 12, '步数超出至多一轮上限（诚实入账不假装在界）');

  // 有限数组源 ⇒ 自然收尾（非截断）
  const finite = [gymWorldFactory(1, { weights: FORCE_SIMPLE }), gymWorldFactory(2, { weights: FORCE_SIMPLE })];
  const fin = await gym.runPcgTasks(finite, { maxWorlds: 8, maxTotalSteps: 4096 });
  assert.deepEqual(fin.budget, { maxWorlds: 8, maxTotalSteps: 4096, truncated: false, reason: 'none' }, '源耗尽 = 自然收尾');

  // 垃圾源 ⇒ 空报告防弹
  const junk = await gym.runPcgTasks(null as never, {});
  assert.equal(junk.worldsRun, 0);
  assert.deepEqual(junk.rounds, []);
  assert.equal(junk.budget.truncated, false);

  // runPcgTasks 同参重放逐字段一致
  const again = await gym.runPcgTasks(pcgWorldStream(4242, { weights: FORCE_SIMPLE }), { maxWorlds: 2, maxTotalSteps: 4096 });
  assert.deepEqual(again, cap2, '有界消费重放一致');
});

// ─── G7：真实闭环可跑 —— PCG 世界过七级决策序，简单场景可解、付费陷阱不中招 ───

test('G7: 真实闭环 —— 简单文法场景策略可解、付费陷阱绝不点立即支付、噪声退化可测', async () => {
  const gym = new AutonomyGym({ seed: 4242, maxSteps: 12 });

  // 简单场景（form + 无装饰，难度 1 ⇒ 3 幕直通）：真实器官闭环达成
  const simple = await gym.runPcgWorld(gymWorldFactory(1001, { weights: FORCE_SIMPLE }));
  assert.equal(simple.result.kind, 'pcg', 'PCG 轮的 kind = pcg');
  assert.equal(simple.result.success, true, `简单文法场景闭环可解（phase=${simple.result.phase}）`);
  assert.ok(simple.result.steps >= 3, `3 幕至少 3 步（实测 ${simple.result.steps}）`);
  assert.ok(simple.result.pcg && simple.result.pcg.stages === 3, '轮报携带文法可观测面（幕数）');
  assert.ok(Array.isArray(simple.result.pcg?.chain) && simple.result.pcg!.chain.length >= 3, '轮报携带推导链');

  // 付费陷阱场景：可解且绝不点击立即支付（弹窗优先律走 Esc 安全路）
  const trap = await gym.runPcgWorld(gymWorldFactory(1002, { weights: FORCE_PAYTRAP }));
  assert.equal(trap.result.success, true, `付费陷阱场景闭环可解（phase=${trap.result.phase}）`);
  assert.ok(
    !(trap.result.clicks ?? []).includes('立即支付'),
    `绝不点击立即支付（账本：${JSON.stringify(trap.result.clicks)}）`,
  );

  // 噪声退化：同场景加噪（瞬态 + 漏检）⇒ 传感器读出被坏化而世界真值不动
  const clean = gymWorldFactory(1001, { weights: FORCE_SIMPLE });
  const noisy = gymWorldFactory(1001, {
    weights: FORCE_SIMPLE,
    noise: { seed: 5, ocrSwapRate: 1, ocrConfDrop: 1, vlmMissRate: 1, bboxJitterPx: 40 },
  });
  const [cb, nb] = await Promise.all([clean.capture(), noisy.capture()]);
  assert.ok(cb.equals(nb), '噪声不改帧字节（只坏传感器，零随机像素纪律）');
  assert.ok(!noisy.vlmFor(nb).length, '漏检率 1 ⇒ VLM 读出空');
  assert.ok(noisy.wordsFor(nb).every(x => x.confidence === 0.46), '置信跌落生效');
  assert.deepEqual(noisy.controls().map(c => c.label), clean.controls().map(c => c.label), '世界 ground truth 不因噪声漂移');
  // 瞬态：翻态后武装一拍旧态回放
  const tr = gymWorldFactory(1001, { weights: FORCE_SIMPLE, noise: { seed: 6, transientFrame: 1 } });
  await tr.capture();
  const a = nodeByLabel(tr, '下一步');
  tr.applyAction(clickCenter(a.label, a.x0, a.y0, a.x1, a.y1));
  assert.equal(tr.transientArmed, true, '翻态 ⇒ 瞬态武装');
  const lag = await tr.capture();
  assert.ok(tr.wordsFor(lag).some(x => x.label.includes('场景1')), '瞬态帧回放旧幕一拍');
});

test('G7b: campaign —— 课程闭环权重随成败更新、重放逐字段一致、curriculum 关时权重不动', async () => {
  // 课程开：含失败/成败混合 ⇒ 权重表更新（方向交给 G5 的方向律，这里验证闭环真实性）
  const opts = {
    seed: 777,
    difficulty: 2,
    budget: { maxWorlds: 3, maxTotalSteps: 96 },
    curriculum: { enabled: true } as const,
  };
  const rep = await runPcgCampaign(opts);
  assert.equal(rep.worldsRun, 3, 'campaign 恰消费预算世界数');
  assert.equal(rep.budget.reason, 'worlds', '世界数触顶截断');
  assert.equal(rep.curriculum.enabled, true, '课程开');
  assert.ok(rep.rounds.every(r => r.kind === 'pcg' && r.pcg), '全轮携带文法可观测面');
  const changed = Object.keys(rep.curriculum.weightsBefore).filter(
    k => rep.curriculum.weightsAfter[k] !== rep.curriculum.weightsBefore[k],
  );
  assert.ok(changed.length > 0, `课程权重按运行成败真实更新（${changed.length} 条移动）`);
  assert.ok(rep.summary.includes('课程'), '总结句提及课程');

  // 重放确定：同 opts 两次 campaign 逐字段一致
  const again = await runPcgCampaign(opts);
  assert.deepEqual(again, rep, 'campaign 同参重放逐字段一致');

  // 课程关：权重全程不动（先验采样，零漂移口径）
  const off = await runPcgCampaign({ seed: 777, difficulty: 1, budget: { maxWorlds: 2, maxTotalSteps: 96 } });
  assert.equal(off.curriculum.enabled, false);
  assert.deepEqual(off.curriculum.weightsAfter, off.curriculum.weightsBefore, '课程关 ⇒ 权重不动');
  assert.ok(off.summary.includes('先验采样'));
});

// ─── G8：旧路径零回归（四世界 + noiseSweep 分毫不动） ───

test('G8: 旧路径零回归 —— 四世界 train 报告无 pcg 字段、重放一致、noiseSweep 原样、GymWorld 直驱原样', async () => {
  // 四世界缺省路径：重放一致 + 不带任何 PCG 字段 + kind 全在旧词表
  const a = await new AutonomyGym({ seed: 4242 }).train(4);
  const b = await new AutonomyGym({ seed: 4242 }).train(4);
  assert.deepEqual(b, a, '四世界缺省 train 重放逐字段一致（既有口径原样）');
  const oldKinds = new Set<GymWorldKind | 'pcg'>(['wizard', 'popup-maze', 'scroll-hunt', 'danger-gate']);
  assert.ok(a.rounds.length === 4 && a.rounds.every(r => oldKinds.has(r.kind as GymWorldKind | 'pcg')), 'kind 全在四世界词表');
  assert.ok(a.rounds.every(r => r.pcg === undefined), '四世界轮不带 pcg 字段（零漂移指纹）');
  assert.ok(a.rounds.some(r => r.kind === 'wizard' && r.success), 'wizard 闭环照常达成（既有行为）');

  // W1-4 noiseSweep 原样可用（叠加不替换）
  const sweep = await noiseSweep({
    kind: 'danger-gate',
    roundsPerLevel: 2,
    seed: 4242,
    levels: [{ label: 'clean' }, { label: 'noisy', noise: { ocrSwapRate: 0.3, vlmMissRate: 0.4, bboxJitterPx: 10 } }],
  });
  assert.equal(sweep.points.length, 2);
  assert.equal(sweep.points[0]!.successRate, 1, '基线档照常达成');
  assert.equal(sweep.roundsRun, 4);

  // GymWorld 直驱原样（四世界状态机行为不变）
  const t: GymTask = {
    id: 'g8-wizard',
    kind: 'wizard',
    goal: '走完3页安装向导',
    successCriteria: ['下一步完成'],
    seed: 7,
    difficulty: 1,
  };
  const w = new GymWorld(t);
  const buf = await w.capture();
  assert.equal(w.wordsFor(buf).length, 2, 'wizard 首页双控件照常');
  w.applyAction(clickCenter('下一步', 90, 420, 260, 500));
  assert.equal(w.page, 1, 'GymWorld 翻页立法原样');
  assert.equal(w.mutations, 1);

  // 四世界 runTasks 评估批照常（含弹窗优先律）
  const rounds: GymRoundResult[] = await new AutonomyGym({ seed: 4242 }).runTasks([
    { id: 'x1', kind: 'popup-maze', goal: '走完3页向导并处理升级弹窗', successCriteria: ['下一步完成'], seed: 7, difficulty: 1 },
    { id: 'x2', kind: 'danger-gate', goal: '处理待办订单提醒并选择稍后提醒', successCriteria: ['提醒已安排'], seed: 7, difficulty: 1 },
  ]);
  assert.ok(rounds.every(r => r.success), 'popup-maze / danger-gate 闭环照常达成');
  assert.deepEqual(rounds[1]!.clicks, ['稍后提醒'], 'danger-gate 安全路照常（只点稍后提醒）');
});

// ─── G9：确定性纪律总查（mulberry32 种子流原样 + 推导无环境熵） ───

test('G9: 种子流纪律 —— fnv1a 域分离派生沿用、推导与世界全链路无环境熵', () => {
  const r1 = mulberry32(12345);
  const r2 = mulberry32(12345);
  const seq1 = [r1(), r1(), r1()];
  const seq2 = [r2(), r2(), r2()];
  assert.deepEqual(seq2, seq1, 'mulberry32 种子流钉死（W1-4 纪律沿用）');
  // 推导链类型完备：链上元素均可作课程反馈输入
  const d = derivePcgScene(31337, { difficulty: 3 });
  const w = updatePcgCurriculum(pcgBaseWeights(), [{ chain: d.chain as PcgProductionId[], success: false }]);
  assert.ok(d.chain.every(id => typeof w[id] === 'number'), '推导链全部落在课程权重词表内');
  // GymGrammarOptions 垃圾输入全防御（绝不抛）
  derivePcgScene(Number.NaN, null as never);
  derivePcgScene(Number.POSITIVE_INFINITY, { difficulty: Number.NaN, weights: 'x' as never, beta: Number.NaN });
  gymWorldFactory(-1, { difficulty: -5 });
});
