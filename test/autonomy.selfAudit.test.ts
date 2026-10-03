// test/autonomy.selfAudit.test.ts
// 纪元 Φ（Φ-10 自我审计官）：纯函数审计全离线确定性测试 —— 零网络、零 IO、零真钟。
// 覆盖：五种 verdict 各自触发与优先级压制（reckless>oscillating>wasteful>opaque>healthy）、
// 比例边界（恰 50%/30%/40% 不判、50.1% 判 —— 全部用可整除构造杜绝浮点争议）、
// OSC-1 尾窗动作循环 / OSC-2 dhash ABA 往返（周期 2 与 3）/ WST-1 占比 / WST-2 连错、
// RCK-1 破坏性判定 / RCK-2 敏感占比 / RCK 生效分层优先 effectiveRiskTier（纪元 Δ：
// 宪法盖章优先、缺席回退申报）/ OPQ-1 黑箱占比、score 逐分手算、
// 空轨迹免检、trajectorySignature 稳定与截断、畸形输入绝不抛。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditTrajectory, trajectorySignature } from '../src/autonomy/selfAudit.ts';
import type { StepRecord } from '../src/autonomy/autoPilot.ts';
import type { PolicyAction, StepOutcome } from '../src/autonomy/policyEngine.ts';

// ─── 字面量工坊 ───

/** 步铸造器：缺省全进步（progress + 有 rationale + benign + 恒定指纹 'ffff'——静止画面不构成往返） */
let seq = 0;
function mk(
  kind: PolicyAction['kind'],
  over: {
    label?: string;
    rationale?: string;
    tier?: PolicyAction['riskTier'];
    effTier?: 'benign' | 'sensitive' | 'destructive';
    outcome?: StepOutcome;
    dhash?: string | null;
  } = {},
): StepRecord {
  const action: PolicyAction = {
    kind,
    ...(over.label === undefined
      ? {}
      : {
          target: {
            bbox: { x0: 0, y0: 0, x1: 20, y1: 20 },
            center: { x: 10, y: 10 },
            label: over.label,
          },
        }),
    rationale: over.rationale ?? '为推进目标而动作',
    expectedEffect: '世界状态向目标靠近',
    utility: 0.5,
    riskTier: over.tier ?? 'benign',
  };
  const rec: StepRecord = {
    stepIndex: seq++,
    action,
    outcome: over.outcome ?? 'progress',
    // 显式判 undefined 而非 ??：null 是"感知失败指纹"的合法取值，必须原样保留
    snapshotDhash: over.dhash === undefined ? 'ffff' : over.dhash,
    at: 1_000 + seq,
    ...(over.effTier === undefined ? {} : { effectiveRiskTier: over.effTier }),
  };
  return rec;
}

/** 1000 步大轨迹（可整除边界专用）：唯一标签杜绝 OSC-1，恒定指纹杜绝 OSC-2 */
function manySteps(noEffectCount: number): StepRecord[] {
  const out: StepRecord[] = [];
  for (let i = 0; i < 1000; i++) {
    out.push(
      mk(i % 2 === 0 ? 'click' : 'type', {
        label: `元素${i}`,
        outcome: i < noEffectCount ? 'no_effect' : 'progress',
      }),
    );
  }
  return out;
}

// ─── Φ-10-a 空轨迹免检 ───

test('Φ-10: 空轨迹免检——healthy + info AUD-0 + 满分 + 健康建议', () => {
  const r = auditTrajectory([]);
  assert.equal(r.verdict, 'healthy');
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0]!.code, 'AUD-0');
  assert.equal(r.findings[0]!.severity, 'info');
  assert.equal(r.score, 100);
  assert.ok(r.advice.includes('轨迹健康，可蒸馏技能'));
  assert.equal(trajectorySignature([]), '');
});

// ─── Φ-10-b healthy：全进步 + 满分封顶（100+10 夹回 100）───

test('Φ-10: 全进步健康轨迹——零发现、奖励封顶后仍 100 分、签名基本拼接', () => {
  const steps = [mk('click', { label: '开始' }), mk('type'), mk('scroll'), mk('hotkey')];
  const r = auditTrajectory(steps);
  assert.equal(r.verdict, 'healthy');
  assert.equal(r.findings.length, 0);
  assert.equal(r.score, 100); // 100 - 0 + min(10, 4×10/4) = 110 ⇒ 夹回 100
  assert.deepEqual(r.advice, ['轨迹健康，可蒸馏技能']);
  assert.equal(trajectorySignature(steps), 'click>type>scroll>hotkey');
});

// ─── Φ-10-c OSC-1：尾窗同签名 ≥3 次 ⇒ 震荡 ───

test('Φ-10: OSC-1——尾窗 6 步内同签名 6 次点击 ⇒ critical 震荡，score 85 手算', () => {
  const steps = Array.from({ length: 6 }, () => mk('click', { label: '刷新' }));
  const r = auditTrajectory(steps);
  assert.equal(r.verdict, 'oscillating');
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0]!.code, 'OSC-1');
  assert.equal(r.findings[0]!.severity, 'critical');
  assert.ok(r.findings[0]!.detail.includes('click@刷新'));
  assert.equal(r.score, 85); // 100 - 25(critical) + min(10, 6×10/6)=10
  assert.ok(r.advice.length >= r.findings.length);
});

test('Φ-10: OSC-1 负例——尾窗内同签名仅 2 次不判震荡', () => {
  const steps = [
    mk('click', { label: '提交' }),
    mk('click', { label: '提交' }),
    mk('type'),
    mk('scroll'),
    mk('hotkey'),
    mk('inspect'),
  ];
  const r = auditTrajectory(steps);
  assert.equal(r.verdict, 'healthy');
  assert.equal(r.findings.length, 0);
});

// ─── Φ-10-d 窗口选项：oscillationWindow 收缩可豁免 ───

test('Φ-10: oscillationWindow 选项——缺省 6 步判震荡，收缩到 3 步窗口即豁免', () => {
  const steps = [
    mk('click', { label: '甲' }),
    mk('click', { label: '甲' }),
    mk('click', { label: '甲' }),
    mk('type'),
    mk('scroll'),
    mk('hotkey'),
  ];
  assert.equal(auditTrajectory(steps).verdict, 'oscillating'); // 尾窗 6 = 全轨迹 ⇒ 甲×3
  const narrowed = auditTrajectory(steps, { oscillationWindow: 3 });
  assert.equal(narrowed.verdict, 'healthy'); // 尾窗 3 = type/scroll/hotkey 互异
  assert.equal(narrowed.findings.length, 0);
});

// ─── Φ-10-e OSC-2：dhash ABA 往返（周期 2 / 周期 3 / 静止与空指纹不判）───

test('Φ-10: OSC-2 周期 2——尾 4 指纹 [a,b,a,b] ⇒ warn 但不改判 verdict（healthy 带警）', () => {
  const steps = [
    mk('click', { dhash: '11' }),
    mk('type', { dhash: '22' }),
    mk('scroll', { dhash: '11' }),
    mk('hotkey', { dhash: '22' }),
  ];
  const r = auditTrajectory(steps);
  assert.equal(r.verdict, 'healthy'); // OSC-2 仅告警，不推翻 verdict
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0]!.code, 'OSC-2');
  assert.equal(r.findings[0]!.severity, 'warn');
  assert.equal(r.score, 100); // 100 - 10(warn) + min(10, 4×10/4)=10
  assert.ok(r.advice.includes('轨迹健康，可蒸馏技能')); // healthy verdict 保底建议仍在
  assert.ok(r.advice.length >= r.findings.length);
});

test('Φ-10: OSC-2 周期 3——尾 6 指纹 [a,b,c,a,b,c] ⇒ warn 往返', () => {
  const hashes = ['11', '22', '33', '11', '22', '33'];
  const kinds: PolicyAction['kind'][] = ['click', 'type', 'scroll', 'hotkey', 'inspect', 'drag'];
  const steps = kinds.map((k, i) => mk(k, { dhash: hashes[i] }));
  const r = auditTrajectory(steps);
  assert.equal(r.verdict, 'healthy');
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0]!.code, 'OSC-2');
  assert.ok(r.findings[0]!.detail.includes('周期 3'));
});

test('Φ-10: OSC-2 负例——全同指纹属停滞不属往返；null 指纹步不参与序列', () => {
  const statics = [mk('click'), mk('type'), mk('scroll'), mk('hotkey')]; // dhash 全 'ffff'
  assert.equal(auditTrajectory(statics).findings.length, 0);
  const withNulls = [
    mk('click', { dhash: null }),
    mk('type', { dhash: 'aa' }),
    mk('scroll', { dhash: null }),
    mk('hotkey', { dhash: 'aa' }),
  ];
  assert.doesNotThrow(() => auditTrajectory(withNulls));
  assert.equal(auditTrajectory(withNulls).findings.length, 0); // 有效指纹仅 2 枚，不够往返
});

// ─── Φ-10-f/g/h/i WST-1：no_effect 占比阈值（恰 50% 不判 / 50.1% 判 / 步数闸 / 选项）───

test('Φ-10: WST-1 边界——8 步恰 50%（4 no_effect）不判，score 满分封顶', () => {
  const kinds: PolicyAction['kind'][] = [
    'click', 'type', 'scroll', 'hotkey', 'inspect', 'drag', 'recall_skill', 'wait',
  ];
  const steps = kinds.map((k, i) => mk(k, { outcome: i < 4 ? 'no_effect' : 'progress' }));
  const r = auditTrajectory(steps);
  assert.equal(r.verdict, 'healthy'); // 4×100 = 50×8 ⇒ 不大于，不判
  assert.equal(r.findings.length, 0);
  assert.equal(r.score, 100); // 100 - 0 + (4×10)/8 = 105 ⇒ 夹回 100
});

test('Φ-10: WST-1 边界——1000 步可整除构造：501 步（50.1%）判，500 步（恰 50%）不判', () => {
  const guilty = auditTrajectory(manySteps(501));
  assert.equal(guilty.verdict, 'wasteful');
  assert.equal(guilty.findings.length, 1);
  assert.equal(guilty.findings[0]!.code, 'WST-1');
  assert.equal(guilty.findings[0]!.severity, 'warn');
  assert.ok(guilty.findings[0]!.detail.includes('50.1')); // detail 必含占比
  assert.ok(guilty.findings[0]!.detail.includes('501/1000'));
  // score 手算：100 - 10(warn) + (499×10)/1000 = 94.99（容差吞浮点尾噪）
  assert.ok(Math.abs(guilty.score - 94.99) < 1e-9);
  const innocent = auditTrajectory(manySteps(500));
  assert.equal(innocent.verdict, 'healthy'); // 500×100 = 50×1000 ⇒ 恰阈值不判
  assert.equal(innocent.findings.length, 0);
});

test('Φ-10: WST-1 步数闸——3 步中 2 步 no_effect（66.7%）仍不判（至少 4 步）', () => {
  const steps = [
    mk('click', { outcome: 'no_effect' }),
    mk('type', { outcome: 'no_effect' }),
    mk('scroll'),
  ];
  const r = auditTrajectory(steps);
  assert.equal(r.verdict, 'healthy');
  assert.equal(r.findings.length, 0);
});

test('Φ-10: wasteThresholdPct 选项——阈值降到 30 后 4 步 50% 即判', () => {
  const steps = [
    mk('click', { outcome: 'no_effect' }),
    mk('type', { outcome: 'no_effect' }),
    mk('scroll'),
    mk('hotkey'),
  ];
  const r = auditTrajectory(steps, { wasteThresholdPct: 30 });
  assert.equal(r.verdict, 'wasteful');
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0]!.code, 'WST-1');
  assert.ok(r.findings[0]!.detail.includes('30'));
});

// ─── Φ-10-j WST-2：连续 error ≥3 ⇒ critical 浪费 ───

test('Φ-10: WST-2——连续 3 步 error ⇒ critical 浪费，score 79 手算；2 连与非连不判', () => {
  const main = [
    mk('click'),
    mk('type', { outcome: 'error' }),
    mk('scroll', { outcome: 'error' }),
    mk('hotkey', { outcome: 'error' }),
    mk('inspect'),
  ];
  const r = auditTrajectory(main);
  assert.equal(r.verdict, 'wasteful');
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0]!.code, 'WST-2');
  assert.equal(r.findings[0]!.severity, 'critical');
  assert.ok(r.findings[0]!.detail.includes('3'));
  assert.equal(r.score, 79); // 100 - 25(critical) + (2×10)/5 = 79
  const two = [
    mk('click', { outcome: 'error' }),
    mk('type', { outcome: 'error' }),
    mk('scroll'),
    mk('hotkey'),
  ];
  assert.equal(auditTrajectory(two).findings.length, 0); // 仅 2 连不判
  const scattered = [
    mk('click', { outcome: 'error' }),
    mk('type'),
    mk('scroll', { outcome: 'error' }),
    mk('hotkey'),
    mk('inspect', { outcome: 'error' }),
  ];
  assert.equal(auditTrajectory(scattered).findings.length, 0); // 3 个 error 但不连续
});

// ─── Φ-10-k RCK-1：破坏性步骤未取得进步 ⇒ critical 鲁莽 ───

test('Φ-10: RCK-1——destructive 且 outcome=regress ⇒ critical 鲁莽 score 82.5；destructive+progress 豁免', () => {
  const main = [
    mk('click', { label: '删除文件', tier: 'destructive', outcome: 'regress' }),
    mk('type'),
    mk('scroll'),
    mk('hotkey'),
  ];
  const r = auditTrajectory(main);
  assert.equal(r.verdict, 'reckless');
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0]!.code, 'RCK-1');
  assert.equal(r.findings[0]!.severity, 'critical');
  assert.ok(r.findings[0]!.detail.includes('outcome=regress'));
  assert.equal(r.score, 82.5); // 100 - 25 + (3×10)/4 = 82.5
  const excused = [
    mk('click', { label: '清空回收站', tier: 'destructive' }), // outcome=progress ⇒ 豁免
    mk('type'),
    mk('scroll'),
  ];
  const ok = auditTrajectory(excused);
  assert.equal(ok.verdict, 'healthy');
  assert.equal(ok.findings.length, 0);
});

// ─── Φ-10-l RCK-2：sensitive 占比 > 40%（≥5 步）⇒ warn 鲁莽 ───

test('Φ-10: RCK-2——5 步 3 步 sensitive（60%）⇒ warn 鲁莽；恰 40% 与不足 5 步豁免', () => {
  const main = [
    mk('click', { label: '发送邮件', tier: 'sensitive' }),
    mk('type', { tier: 'sensitive' }),
    mk('scroll', { tier: 'sensitive' }),
    mk('hotkey'),
    mk('inspect'),
  ];
  const r = auditTrajectory(main);
  assert.equal(r.verdict, 'reckless');
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0]!.code, 'RCK-2');
  assert.equal(r.findings[0]!.severity, 'warn');
  assert.ok(r.findings[0]!.detail.includes('60.0'));
  assert.equal(r.score, 100); // 100 - 10 + min(10, 5×10/5)=10 ⇒ 夹回 100
  const forty = [
    mk('click', { tier: 'sensitive' }),
    mk('type', { tier: 'sensitive' }),
    mk('scroll'),
    mk('hotkey'),
    mk('inspect'),
  ];
  assert.equal(auditTrajectory(forty).findings.length, 0); // 2×100 = 40×5 ⇒ 恰阈值不判
  const gate = [
    mk('click', { tier: 'sensitive' }),
    mk('type', { tier: 'sensitive' }),
    mk('scroll', { tier: 'sensitive' }),
    mk('hotkey', { tier: 'sensitive' }),
  ];
  assert.equal(auditTrajectory(gate).findings.length, 0); // 100% 但不足 5 步，闸门拦截
});

// ─── Φ-10-l2 RCK 计数优先 effectiveRiskTier（纪元 Δ：宪法判决盖章） ───

test('Φ-10: RCK 生效分层——effectiveRiskTier（宪法盖章）优先于 action.riskTier，缺席回退申报', () => {
  // 盖章 destructive（申报 benign）且未进步 ⇒ RCK-1 执法（旧律只看申报会漏放）
  const stamped = [
    mk('click', { label: '看似无害的按钮', effTier: 'destructive', outcome: 'regress' }),
    mk('type'),
    mk('scroll'),
    mk('hotkey'),
  ];
  const r = auditTrajectory(stamped);
  assert.equal(r.verdict, 'reckless');
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0]!.code, 'RCK-1');
  assert.equal(r.score, 82.5); // 100 − 25 + (3×10)/4（与申报 destructive 的 RCK-1 同分手算）

  // 盖章压制申报：申报 destructive 但宪法判 benign 且 progress ⇒ 不再误判鲁莽
  const excused = [
    mk('click', { label: '删除', tier: 'destructive', effTier: 'benign' }),
    mk('type'),
    mk('scroll'),
  ];
  assert.equal(auditTrajectory(excused).verdict, 'healthy');
  assert.equal(auditTrajectory(excused).findings.length, 0);

  // RCK-2 计数同律：盖章 sensitive（申报 benign）5 步 3 步 ⇒ 60% 判占比
  const ratio = [
    mk('click', { effTier: 'sensitive' }),
    mk('type', { effTier: 'sensitive' }),
    mk('scroll', { effTier: 'sensitive' }),
    mk('hotkey'),
    mk('inspect'),
  ];
  const rr = auditTrajectory(ratio);
  assert.equal(rr.verdict, 'reckless');
  assert.equal(rr.findings[0]!.code, 'RCK-2');
  assert.ok(rr.findings[0]!.detail.includes('60.0'));
  // 对照：同轨迹只看申报（全 benign，无盖章）⇒ 不判
  const declared = ratio.map(s => ({ ...s, effectiveRiskTier: undefined }));
  assert.equal(auditTrajectory(declared as StepRecord[]).findings.length, 0);
});

// ─── Φ-10-m OPQ-1：rationale 缺席占比 > 30%（≥3 步）⇒ 黑箱 ───

test('Φ-10: OPQ-1——10 步 4 步无理由（含纯空白）⇒ opaque；恰 30% 与不足 3 步豁免', () => {
  const kinds: PolicyAction['kind'][] = [
    'click', 'type', 'scroll', 'hotkey', 'inspect',
    'drag', 'recall_skill', 'wait', 'declare', 'ask_vlm',
  ];
  const main = kinds.map((k, i) =>
    mk(k, { rationale: i < 3 ? '' : i === 3 ? '   ' : '正常理由' }),
  );
  const r = auditTrajectory(main);
  assert.equal(r.verdict, 'opaque');
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0]!.code, 'OPQ-1');
  assert.equal(r.findings[0]!.severity, 'warn');
  assert.ok(r.findings[0]!.detail.includes('40.0'));
  assert.equal(r.score, 100); // 100 - 10 + min(10, 10×10/10)=10 ⇒ 夹回 100
  const thirty = kinds.map((k, i) => mk(k, { rationale: i < 3 ? '' : '正常理由' }));
  assert.equal(auditTrajectory(thirty).findings.length, 0); // 3×100 = 30×10 ⇒ 恰阈值不判
  const gate = [mk('click', { rationale: '' }), mk('type')];
  assert.equal(auditTrajectory(gate).findings.length, 0); // 50% 但不足 3 步，闸门拦截
});

// ─── Φ-10-n 优先级压制：多症并发取最重，findings 累积不互斥 ───

test('Φ-10: 优先级——四症并发（破坏+震荡+浪费+黑箱）⇒ reckless 压制一切，score 31.25 手算', () => {
  const steps: StepRecord[] = [
    mk('click', { label: '删除', tier: 'destructive', outcome: 'regress' }), // RCK-1
    mk('type', { rationale: '', outcome: 'error' }),
    mk('click', { label: '刷新', outcome: 'no_effect', rationale: '' }),
    mk('click', { label: '刷新', outcome: 'no_effect', rationale: '' }),
    mk('click', { label: '刷新', outcome: 'no_effect' }),
    mk('click', { label: '刷新', outcome: 'no_effect' }),
    mk('click', { label: '刷新', outcome: 'no_effect' }),
    mk('click', { label: '刷新' }),
  ];
  const r = auditTrajectory(steps);
  assert.equal(r.verdict, 'reckless'); // 最重者胜
  assert.deepEqual(
    r.findings.map(f => f.code),
    ['OSC-1', 'WST-1', 'RCK-1', 'OPQ-1'], // 累积不互斥，顺序固定
  );
  assert.deepEqual(
    r.findings.map(f => f.severity),
    ['critical', 'warn', 'critical', 'warn'],
  );
  // score 手算：100 - 2×25 - 2×10 + (1×10)/8 = 31.25
  assert.equal(r.score, 31.25);
  assert.ok(r.advice.length >= r.findings.length); // 每个 finding 至少一条建议
  assert.ok(r.advice.every(a => typeof a === 'string' && a.length > 0));
});

test('Φ-10: 优先级——震荡压制浪费（OSC-1 + WST-1 并发 ⇒ oscillating）', () => {
  const steps: StepRecord[] = [
    mk('click', { label: '甲' }),
    mk('type'),
    ...Array.from({ length: 6 }, () => mk('click', { label: '乙', outcome: 'no_effect' })),
  ];
  const r = auditTrajectory(steps);
  assert.equal(r.verdict, 'oscillating');
  assert.deepEqual(
    r.findings.map(f => f.code),
    ['OSC-1', 'WST-1'],
  );
});

test('Φ-10: 优先级——浪费压制黑箱（WST-1 + OPQ-1 并发 ⇒ wasteful，score 84 手算）', () => {
  const kinds: PolicyAction['kind'][] = [
    'click', 'type', 'scroll', 'hotkey', 'inspect',
    'drag', 'recall_skill', 'wait', 'declare', 'ask_vlm',
  ];
  const steps = kinds.map((k, i) =>
    mk(k, { outcome: i < 6 ? 'no_effect' : 'progress', rationale: i < 4 ? '' : '正常理由' }),
  );
  const r = auditTrajectory(steps);
  assert.equal(r.verdict, 'wasteful');
  assert.deepEqual(
    r.findings.map(f => f.code),
    ['WST-1', 'OPQ-1'],
  );
  assert.equal(r.score, 84); // 100 - 2×10(warn) + (4×10)/10 = 84
});

// ─── Φ-10-o score 独立手算：OSC-2 + WST-1 双 warn ───

test('Φ-10: score 手算——OSC-2 与 WST-1 各扣 10，progress 奖励 +4 ⇒ 84', () => {
  const kinds: PolicyAction['kind'][] = [
    'click', 'type', 'scroll', 'hotkey', 'inspect',
    'drag', 'recall_skill', 'wait', 'declare', 'ask_vlm',
  ];
  const steps = kinds.map((k, i) =>
    mk(k, {
      outcome: i < 6 ? 'no_effect' : 'progress',
      dhash: i < 6 ? `h${i}` : ['aa', 'bb', 'aa', 'bb'][i - 6] ?? 'zz',
    }),
  );
  const r = auditTrajectory(steps);
  assert.deepEqual(
    r.findings.map(f => f.code),
    ['OSC-2', 'WST-1'],
  );
  assert.equal(r.verdict, 'wasteful');
  assert.equal(r.score, 84); // 100 - 10 - 10 + (4×10)/10
});

// ─── Φ-10-p trajectorySignature：纯函数稳定性与截断 ───

test('Φ-10: trajectorySignature——kind 序列拼接、同 kind 折叠、截断恰 100 字符、顺序敏感', () => {
  const three = [mk('click', { label: '甲' }), mk('type'), mk('scroll')];
  assert.equal(trajectorySignature(three), 'click>type>scroll');
  assert.equal(
    trajectorySignature([mk('click', { label: '甲' }), mk('click', { label: '乙' })]),
    'click>click', // 只看 kind，不看 label
  );
  const twelve = Array.from({ length: 12 }, () => mk('escalate'));
  const sig = trajectorySignature(twelve);
  assert.equal(sig.length, 100); // 12×8 + 11 = 107 ⇒ 截 100
  assert.equal(sig, 'escalate>'.repeat(11) + 'e');
  // 稳定：同输入两次一致；顺序敏感：反序即变
  assert.equal(trajectorySignature(three), trajectorySignature(three.slice()));
  assert.notEqual(
    trajectorySignature(three),
    trajectorySignature([...three].reverse()),
  );
});

// ─── Φ-10-q 防弹：畸形输入绝不抛 ───

test('Φ-10: 防弹——null 轨迹、缺 action 步、非法 opts 全部收敛不抛', () => {
  const normal = [mk('click'), mk('type'), mk('scroll'), mk('hotkey')];
  assert.doesNotThrow(() => auditTrajectory(null as never));
  const nulled = auditTrajectory(null as never);
  assert.equal(nulled.verdict, 'healthy'); // 非数组按空轨迹免检
  assert.equal(nulled.findings[0]!.code, 'AUD-0');
  const malformed = [
    null,
    { stepIndex: 0, outcome: 'progress', snapshotDhash: 'aa', at: 1 },
  ] as unknown as StepRecord[];
  let report: ReturnType<typeof auditTrajectory> | null = null;
  assert.doesNotThrow(() => { report = auditTrajectory(malformed); });
  assert.equal(report!.verdict, 'healthy'); // 缺 action 步黑箱占比 100%，但不足 3 步闸门拦截
  assert.equal(report!.score, 100); // 唯一有效步 progress ⇒ 100 - 0 + 10 ⇒ 夹回 100
  assert.equal(trajectorySignature(malformed), 'unknown>unknown'); // null 步与缺 action 步均以 unknown 占位
  assert.equal(trajectorySignature(null as never), '');
  assert.doesNotThrow(() =>
    auditTrajectory(normal, {
      oscillationWindow: Number.NaN,
      wasteThresholdPct: Number.POSITIVE_INFINITY,
    }),
  );
  assert.equal(
    auditTrajectory(normal, {
      oscillationWindow: Number.NaN,
      wasteThresholdPct: Number.POSITIVE_INFINITY,
    }).verdict,
    'healthy', // 非法 opts 回退缺省，行为与缺省一致
  );
});
