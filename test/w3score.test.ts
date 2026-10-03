// test/w3score.test.ts
// W3-8(E4 免标注过程评分器)执法测试:step credit assignment 的口径锁。
//
// 铁律:
//   · 四通道各自数值由手算例锁定(effect=detected×scale / intent 证据阶梯 /
//     osc 签名 run / wait 无效果 streak);
//   · 缺席 = 中性 0.5 + 缺席计数(缺席不是 0 分 —— 口径诚实);
//   · 聚合:均值 + PBR 晚期加权(w_i = (1-λ)+2λ·i/(n-1),后期步权重高);
//   · 首低分步锚定(首个低于阈值的步 + 前后文);
//   · 垃圾行跳过计数 / 空轨迹诚实报空 / 病态载荷绝不抛;
//   · 口径版本戳 E4-v1(跨版本可比的锚);
//   · 评分工具面与 journal.ACTION_TOOLS 同步(防漂移执法);
//   · CLI 冒烟:strip-types 直跑与无旗标透明重启两条路径均 exit 0。
// 全部用例离线确定性:纯文本输入、零 IO、零网络、零截屏。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  scoreJournalText, scoreJournalLines, renderProcessScore,
  SCORE_CALIBER_VERSION, DEFAULT_CHANNEL_WEIGHTS, DEFAULT_LOW_STEP_THRESHOLD, DEFAULT_LATE_BIAS,
} from '../src/processScore.ts';
import { ACTION_TOOLS } from '../src/journal.ts';

// ── 构造工坊:行助手(手算例的最小证据面) ──

/** click_mouse 基线行(坐标 x=0.5,y=0.5 ⇒ 签名恒定,便于 osc 手算) */
function click(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { tool: 'click_mouse', ts: 1700000000000, status: 'SUCCESS', args: { x: 0.5, y: 0.5 }, ...over };
}

/** 手算舍入助手(与核心 r3 同律:千分位) */
function r3(x: number): number { return Math.round(x * 1000) / 1000; }

/** 压行:对象数组 → JSONL 文本 */
const jl = (...lines: Record<string, unknown>[]): string =>
  lines.map(l => JSON.stringify(l)).join('\n');

const AGENT_END = (status: string): Record<string, unknown> =>
  ({ tool: 'AGENT_END', ts: 2, status: 'MARKER', args: { taskId: 't1', status } });

// ─── 通道 1:effect(detected × scale 手算) ───

test('effect 通道:detected×scale 四档手算', () => {
  const page = scoreJournalText(jl(click({ effect_detected: true, scale: 'page-level' })));
  assert.equal(page.steps[0].channels.effect, 1);      // page-level = 1.0
  assert.equal(page.steps[0].absent.effect, false);

  const elem = scoreJournalText(jl(click({ effect_detected: true, scale: 'element-level' })));
  assert.equal(elem.steps[0].channels.effect, 0.9);    // element-level = 0.9

  const noScale = scoreJournalText(jl(click({ effect_detected: true })));
  assert.equal(noScale.steps[0].channels.effect, 0.95); // scale 缺席 = 双档中点

  const contradiction = scoreJournalText(jl(click({ effect_detected: true, scale: 'none' })));
  assert.equal(contradiction.steps[0].channels.effect, 0.95); // 矛盾证据 ⇒ 中点,不站队

  const noEffect = scoreJournalText(jl(click({ effect_detected: false })));
  assert.equal(noEffect.steps[0].channels.effect, 0);  // 链上明示无效果(盲点)
  assert.equal(noEffect.steps[0].absent.effect, false); // 明示 false 不是缺席

  const absent = scoreJournalText(jl(click()));
  assert.equal(absent.steps[0].channels.effect, 0.5);  // 缺席 = 中性 0.5
  assert.equal(absent.steps[0].absent.effect, true);
  assert.equal(absent.channel_absence.effect, 1);
});

// ─── 通道 2:intent(证据阶梯手算:intent > phash > thought) ───

test('intent 通道:证据阶梯手算', () => {
  const sat = scoreJournalText(jl(click({ intent: { expected: 'navigate', satisfied: true, evidence: 'x' } })));
  assert.equal(sat.steps[0].channels.intent, 1);        // 物理规则证实

  const unsat = scoreJournalText(jl(click({ intent: { expected: 'navigate', satisfied: false, evidence: 'x' } })));
  assert.equal(unsat.steps[0].channels.intent, 0);      // 规则否证

  const agree = scoreJournalText(jl(click({ phashCorroborates: true })));
  assert.equal(agree.steps[0].channels.intent, 0.9);    // pHash 同判

  const dissent = scoreJournalText(jl(click({ phashCorroborates: false })));
  assert.equal(dissent.steps[0].channels.intent, 0.4);  // pHash 异议 = 存疑不下 0

  const thoughtOnly = scoreJournalText(jl(click({ thought: '点击提交按钮以进入下一步' })));
  assert.equal(thoughtOnly.steps[0].channels.intent, 0.6); // 仅有出声思考 = 弱佐证
  assert.equal(thoughtOnly.steps[0].absent.intent, false);

  const none = scoreJournalText(jl(click()));
  assert.equal(none.steps[0].channels.intent, 0.5);     // 全缺席 = 中性
  assert.equal(none.steps[0].absent.intent, true);
  assert.equal(none.channel_absence.intent, 1);
});

test('intent 阶梯优先级:intent 在场时压制 phash/thought', () => {
  const rep = scoreJournalText(jl(click({
    intent: { expected: 'navigate', satisfied: true, evidence: 'x' },
    phashCorroborates: false, // 异议被更强的物理规则证据压制
    thought: '因为…',
  })));
  assert.equal(rep.steps[0].channels.intent, 1);
});

// ─── 通道 3:oscillation(连续同签名 run 手算) ───

test('osc 通道:同签名 run=1/2/≥3 ⇒ 1.0/0.5/0', () => {
  const rep = scoreJournalText(jl(click(), click(), click()));
  assert.equal(rep.steps[0].channels.oscillation, 1);
  assert.equal(rep.steps[1].channels.oscillation, 0.5);
  assert.equal(rep.steps[2].channels.oscillation, 0);
  assert.deepEqual(rep.steps.map(s => s.evidence.repeat_run), [1, 2, 3]);
});

test('osc 通道:异签名重置 run;reasoning 不入签名域', () => {
  const rep = scoreJournalText(jl(
    click(),
    click({ args: { x: 0.9, y: 0.1 } }), // 异坐标 = 异签名 ⇒ run 重置
    click({ args: { x: 0.9, y: 0.1 }, reasoning: '换个说法再试' }), // 同坐标不同 reasoning ⇒ 同签名
  ));
  assert.deepEqual(rep.steps.map(s => s.evidence.repeat_run), [1, 1, 2]);
});

test('osc 通道:环境 marker(ENV_SHAPED/SENSE_SHIFT/AGENT_BEGIN)重置签名连续性', () => {
  const rep = scoreJournalText(jl(
    click(),
    { tool: 'ENV_SHAPED', status: 'MARKER', args: { action: 'window-resize' } },
    click(), // 环境被重塑 ⇒ 同签名不再算重复
  ));
  assert.equal(rep.steps[0].evidence.repeat_run, 1);
  assert.equal(rep.steps[1].evidence.repeat_run, 1);
  assert.equal(rep.steps[1].channels.oscillation, 1);
  assert.equal(rep.totals.marker_lines, 1); // marker 不入步分
});

// ─── 通道 4:wait(连续无效果 streak 手算) ───

test('wait 通道:streak 递减 0.4(1→0.6, 2→0.2, ≥3→0)', () => {
  const rep = scoreJournalText(jl(
    click({ args: { x: 1, y: 1 }, effect_detected: false }),
    click({ args: { x: 2, y: 2 }, effect_detected: false }),
    click({ args: { x: 3, y: 3 }, effect_detected: false }),
  ));
  assert.deepEqual(rep.steps.map(s => s.channels.wait), [0.6, 0.2, 0]);
  assert.deepEqual(rep.steps.map(s => s.evidence.no_effect_streak), [1, 2, 3]);
});

test('wait 通道:有效果归 1.0 并清零 streak;缺席步不累积不清零', () => {
  const rep = scoreJournalText(jl(
    click({ args: { x: 1, y: 1 }, effect_detected: false }), // streak=1 → 0.6
    click({ args: { x: 2, y: 2 } }),                          // 缺席 → 0.5,streak 保持 1
    click({ args: { x: 3, y: 3 }, effect_detected: false }),   // streak=2 → 0.2
    click({ args: { x: 4, y: 4 }, effect_detected: true, scale: 'page-level' }), // 归 1.0 清零
    click({ args: { x: 5, y: 5 }, effect_detected: false }),   // streak=1 → 0.6
  ));
  assert.deepEqual(rep.steps.map(s => s.channels.wait), [0.6, 0.5, 0.2, 1, 0.6]);
  assert.equal(rep.steps[1].absent.wait, true);
  assert.equal(rep.channel_absence.wait, 1);
});

// ─── 步分合成:权重手算(全缺席步 = 0.6 中性基线) ───

test('步分:全缺席单步手算 0.45×0.5+0.15×0.5+0.2×1+0.2×0.5 = 0.6', () => {
  const rep = scoreJournalText(jl(click()));
  assert.equal(rep.steps[0].score, 0.6);
});

test('步分:全证据好步 = 1.0;权重可注入(单通道隔离)', () => {
  const good = scoreJournalText(jl(click({
    effect_detected: true, scale: 'page-level',
    intent: { expected: 'navigate', satisfied: true, evidence: 'x' },
  })));
  assert.equal(good.steps[0].score, 1);

  // 注入 effect 单通道权重 ⇒ 步分退化为 effect 通道值(权重归一化的执法)
  const noEffectOnly = scoreJournalText(
    jl(click({ effect_detected: false })),
    { weights: { effect: 1, intent: 0, oscillation: 0, wait: 0 } },
  );
  assert.equal(noEffectOnly.steps[0].score, 0);
  assert.deepEqual(noEffectOnly.calibration.weights, { effect: 1, intent: 0, oscillation: 0, wait: 0 });
});

// ─── 聚合:均值 + PBR 晚期加权(手算) ───

test('聚合:plain 与 weighted 手算(w=[0.5,1.5],后期权重 3 倍)', () => {
  const good = click({
    args: { x: 1, y: 1 },
    effect_detected: true, scale: 'page-level',
    intent: { expected: 'navigate', satisfied: true, evidence: 'x' },
  }); // channels(1,1,1,1) ⇒ 1.0
  const bad = {
    tool: 'press_hotkey', ts: 2, status: 'SUCCESS', args: { keys: 'enter' },
    effect_detected: false, intent: { expected: 'open-menu', satisfied: false, evidence: 'x' },
  }; // effect=0, intent=0, osc=1(run1), wait=0.6(streak1) ⇒ 0.2×1+0.2×0.6 = 0.32
  const rep = scoreJournalText(jl(good, bad));
  assert.equal(rep.steps[0].score, 1);
  assert.equal(rep.steps[1].score, 0.32);
  assert.equal(rep.task.plain_mean, 0.66);               // (1+0.32)/2
  assert.equal(rep.task.weighted_mean, 0.49);             // (0.5×1+1.5×0.32)/2
});

test('聚合:late_bias 注入(λ=0 ⇒ weighted=plain);单步轨迹不除零', () => {
  const good = click({
    args: { x: 1, y: 1 }, effect_detected: true, scale: 'page-level',
    intent: { expected: 'navigate', satisfied: true, evidence: 'x' },
  });
  const bad = {
    tool: 'press_hotkey', ts: 2, status: 'SUCCESS', args: { keys: 'enter' }, effect_detected: false,
  };
  const flat = scoreJournalText(jl(good, bad), { lateBias: 0 });
  assert.equal(flat.task.weighted_mean, flat.task.plain_mean);

  const single = scoreJournalText(jl(good));
  assert.equal(single.task.weighted_mean, single.task.plain_mean); // n=1:w_i/(n-1) 无除零
  assert.equal(single.task.plain_mean, 1);
});

// ─── 终局分并报与混合 ───

test('终局分:AGENT_END 解析并报;blended=0.7×过程+0.3×终局', () => {
  const good = click({
    args: { x: 1, y: 1 }, effect_detected: true, scale: 'page-level',
    intent: { expected: 'navigate', satisfied: true, evidence: 'x' },
  });
  const bad = {
    tool: 'press_hotkey', ts: 2, status: 'SUCCESS', args: { keys: 'enter' },
    effect_detected: false, intent: { expected: 'open-menu', satisfied: false, evidence: 'x' },
  }; // 与聚合测试同构造 ⇒ steps=[1.0, 0.32], weighted=0.49
  // weighted=0.49 ⇒ blended = 0.7×0.49+0.3×1 = 0.643
  const win = scoreJournalText(jl(good, bad, AGENT_END('success')));
  assert.equal(win.task.final_score, 1);
  assert.equal(win.task.final_status, 'success');
  assert.equal(win.task.blended, 0.643);

  const loss = scoreJournalText(jl(good, bad, AGENT_END('failed')));
  assert.equal(loss.task.final_score, 0);
  assert.equal(loss.task.blended, r3(0.7 * 0.49));

  const odd = scoreJournalText(jl(good, bad, AGENT_END('timeout'))); // 非二值状态 ⇒ 中立 0.5
  assert.equal(odd.task.final_score, 0.5);

  const open = scoreJournalText(jl(good, bad)); // 无终局标记 ⇒ null(诚实缺席)
  assert.equal(open.task.final_score, null);
  assert.equal(open.task.final_status, null);
  assert.equal(open.task.blended, null);
});

test('AGENT_BEGIN 的 objective 进报告语境(不参与评分)', () => {
  const rep = scoreJournalText(jl(
    { tool: 'AGENT_BEGIN', status: 'MARKER', args: { taskId: 't1', role: 'main', objective: '打开设置面板' } },
    click({ effect_detected: true, scale: 'page-level' }),
  ));
  assert.equal(rep.task.objective, '打开设置面板');
  assert.equal(rep.steps.length, 1); // marker 不入步分
  assert.equal(rep.totals.marker_lines, 1);
});

// ─── 首低分步锚定 ───

test('锚定:首个低于阈值的步 + 前后文 + 负面证据清单', () => {
  const good1 = click({ args: { x: 1, y: 1 }, effect_detected: true, scale: 'page-level', intent: { expected: 'a', satisfied: true, evidence: 'x' } });
  const bad1 = { tool: 'press_hotkey', ts: 2, status: 'SUCCESS', args: { keys: 'enter' }, effect_detected: false, intent: { expected: 'b', satisfied: false, evidence: 'x' } }; // 0.32
  const good2 = click({ args: { x: 2, y: 2 }, effect_detected: true, scale: 'page-level', intent: { expected: 'c', satisfied: true, evidence: 'x' } });
  const bad2 = { tool: 'scroll_page', ts: 4, status: 'SUCCESS', args: { direction: 'down' }, effect_detected: false };

  const rep = scoreJournalText(jl(good1, bad1, good2, bad2));
  const fl = rep.first_low_step;
  assert.ok(fl);
  assert.equal(fl.index, 1);                 // 首低分步(第二个 bad 也低但只锚首个)
  assert.equal(fl.score, 0.32);
  assert.equal(fl.threshold, DEFAULT_LOW_STEP_THRESHOLD);
  assert.equal(fl.tool, 'press_hotkey');
  assert.ok(fl.args_summary.includes('enter'));
  assert.ok(fl.reasons.some(r => r.includes('detected=false')));
  assert.ok(fl.reasons.some(r => r.includes('intent unsatisfied')));
  assert.deepEqual(fl.prev, { index: 0, tool: 'click_mouse', score: 1 });
  assert.deepEqual(fl.next, { index: 2, tool: 'click_mouse', score: 1 });

  const clean = scoreJournalText(jl(good1, good2));
  assert.equal(clean.first_low_step, null);  // 全好轨迹 ⇒ 无锚定
});

test('锚定:阈值可注入(score < threshold 严格小于)', () => {
  const rep = scoreJournalText(jl(click()), { lowStepThreshold: 0.61 });
  assert.equal(rep.steps[0].score, 0.6);
  assert.equal(rep.first_low_step?.index, 0);          // 0.6 < 0.61 ⇒ 锚定
  const repEq = scoreJournalText(jl(click()), { lowStepThreshold: 0.6 });
  assert.equal(repEq.first_low_step, null);            // 0.6 ≮ 0.6 ⇒ 不锚
});

// ─── 垃圾行防御 / 空轨迹 / 病态载荷 ───

test('垃圾行防御:非 JSON/非对象/缺 tool 跳过并计数,好行照评', () => {
  const text = [
    'not json at all',
    '42',                       // 合法 JSON 但非对象
    'null',
    '[1,2,3]',                  // 数组不是行对象
    '{"status":"SUCCESS"}',     // 缺 tool
    '{"tool": 123}',            // tool 非字符串
    '',                         // 空白行:不算垃圾(尾部换行常态)
    '   ',
    JSON.stringify(click({ effect_detected: true, scale: 'page-level' })),
  ].join('\n');
  const rep = scoreJournalText(text);
  assert.equal(rep.ok, true);
  assert.equal(rep.totals.lines_total, 9);
  assert.equal(rep.totals.lines_blank, 2);
  assert.equal(rep.totals.lines_garbage, 6);
  assert.equal(rep.steps.length, 1);
  // 手算:effect 1 / intent 缺席 0.5 / osc 1(run1) / wait 1(detected=true)
  // ⇒ 0.45×1 + 0.15×0.5 + 0.2×1 + 0.2×1 = 0.925
  assert.equal(rep.steps[0].score, 0.925);
});

test('评分工具面:观察类工具不入步分(lines_unscored_tool 计数)', () => {
  const rep = scoreJournalText(JSON.stringify({ tool: 'take_screenshot', status: 'SUCCESS', args: {} }));
  assert.equal(rep.steps.length, 0);
  assert.equal(rep.totals.lines_unscored_tool, 1);
  assert.equal(rep.totals.lines_garbage, 0);
});

test('工具面同步:与 journal.ACTION_TOOLS 逐工具一致(防漂移执法)', () => {
  const text = ACTION_TOOLS.map(t => JSON.stringify({ tool: t, status: 'SUCCESS', args: {} })).join('\n');
  const rep = scoreJournalText(text);
  assert.equal(rep.steps.length, ACTION_TOOLS.length);
  assert.equal(rep.totals.lines_unscored_tool, 0);
});

test('空轨迹:诚实报空(null 而非 0),不抛', () => {
  for (const text of ['', '\n\n', '   \n']) {
    const rep = scoreJournalText(text);
    assert.equal(rep.ok, true);
    assert.equal(rep.steps.length, 0);
    assert.equal(rep.task.step_count, 0);
    assert.equal(rep.task.plain_mean, null);
    assert.equal(rep.task.weighted_mean, null);
    assert.equal(rep.task.blended, null);
    assert.equal(rep.first_low_step, null);
  }
  const allGarbage = scoreJournalText('garbage\n{"tool":1}');
  assert.equal(allGarbage.steps.length, 0);
  assert.equal(allGarbage.totals.lines_garbage, 2);
});

test('病态载荷防御:环形 args / BigInt / 奇异类型字段绝不抛', () => {
  const cyc: Record<string, unknown> = { x: 1 };
  cyc.self = cyc; // 环形引用:JSON.stringify 会抛 ⇒ 签名域哨兵降级
  const rep = scoreJournalLines([
    { tool: 'click_mouse', args: cyc, status: 'SUCCESS', effect_detected: true, scale: 'page-level' },
    { tool: 'type_text', args: { n: 10n }, status: 'SUCCESS' }, // BigInt:canonical 抛 ⇒ 哨兵
    'not-an-object', // 对象入口的垃圾元素
    42,
  ]);
  assert.equal(rep.ok, true);
  assert.equal(rep.steps.length, 2);        // 病态载荷不弃步,只降级签名区分度
  assert.equal(rep.totals.lines_garbage, 2);
  assert.equal(rep.steps[0].channels.effect, 1);
  assert.equal(rep.steps[1].channels.effect, 0.5);

  // 非字符串输入(防御上限):scoreJournalText 只认 string,其余按空轨迹处理
  const weird = scoreJournalText(undefined as unknown as string);
  assert.equal(weird.ok, true);
  assert.equal(weird.steps.length, 0);
});

// ─── 口径版本戳与确定性 ───

test('口径版本戳:报告与常量一致;calibration 回显可复算', () => {
  const rep = scoreJournalText(jl(click()));
  assert.equal(SCORE_CALIBER_VERSION, 'E4-v1');
  assert.equal(rep.caliber_version, 'E4-v1');
  assert.equal(rep.generated_by, 'W3-8 processScore');
  assert.deepEqual(rep.calibration.weights, { ...DEFAULT_CHANNEL_WEIGHTS });
  assert.equal(rep.calibration.low_step_threshold, DEFAULT_LOW_STEP_THRESHOLD);
  assert.equal(rep.calibration.late_bias, DEFAULT_LATE_BIAS);
  assert.equal(rep.calibration.caliber_version, 'E4-v1');
});

test('离线确定性:同输入 ⇒ 深度相等报告', () => {
  const text = jl(click(), click({ effect_detected: false }), AGENT_END('success'));
  assert.deepEqual(scoreJournalText(text), scoreJournalText(text));
});

test('权重归一化防御:负值夹 0;全零回退默认;非有限值忽略', () => {
  const rep = scoreJournalText(jl(click()), {
    weights: { effect: -1, intent: 'x' as unknown as number, oscillation: NaN, wait: 1 },
  });
  // -1→0,'x'/NaN→保持默认(intent .15, osc .2),wait 1 ⇒ 和=1.35 ⇒ 归一化除以 1.35
  assert.deepEqual(rep.calibration.weights, { effect: 0, intent: 0.111, oscillation: 0.148, wait: 0.741 });

  const zero = scoreJournalText(jl(click()), { weights: { effect: 0, intent: 0, oscillation: 0, wait: 0 } });
  assert.deepEqual(zero.calibration.weights, { ...DEFAULT_CHANNEL_WEIGHTS });
});

// ─── 渲染 ───

test('渲染:人类可读摘要(空轨迹/正常轨迹/内部错误三态)', () => {
  assert.match(renderProcessScore(scoreJournalText('')), /EMPTY/);
  const rep = scoreJournalText(jl(
    click({ effect_detected: true, scale: 'page-level' }),
    { tool: 'press_hotkey', status: 'SUCCESS', args: { keys: 'enter' }, effect_detected: false, intent: { expected: 'open-menu', satisfied: false, evidence: 'x' } },
    AGENT_END('success'),
  ));
  const text = renderProcessScore(rep);
  assert.match(text, /ProcessScore/);
  assert.match(text, /caliber=E4-v1/);
  assert.match(text, /weighted=/);
  assert.match(text, /final=1\.000/);
  assert.match(text, /low  : first low step #1/);
  const bad = scoreJournalLines(null as unknown as readonly unknown[]);
  assert.match(renderProcessScore(bad), /internal-error|caliber/);
});

// ─── CLI 冒烟(两条路径:显式 strip-types 与透明重启) ───

function makeTempJournal(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'w3score-cli-'));
  const file = path.join(dir, 'journal.jsonl');
  writeFileSync(file, jl(
    { tool: 'AGENT_BEGIN', status: 'MARKER', args: { taskId: 't', role: 'main', objective: '冒烟任务' } },
    click({ effect_detected: true, scale: 'page-level' }),
    { tool: 'type_text', status: 'SUCCESS', args: { text: 'hello' }, effect_detected: true, scale: 'element-level' },
    { tool: 'press_hotkey', status: 'SUCCESS', args: { keys: 'enter' }, effect_detected: false },
    AGENT_END('success'),
  ) + '\n', 'utf8');
  return file;
}

const CLI_PATH = fileURLToPath(new URL('../scripts/processScore.mjs', import.meta.url));

test('CLI:strip-types 直跑 → exit 0 + 摘要 + JSON 落盘', () => {
  const file = makeTempJournal();
  try {
    const r = spawnSync(process.execPath,
      ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', CLI_PATH, file],
      { encoding: 'utf8', timeout: 120000 });
    assert.equal(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.match(r.stdout, /ProcessScore/);
    assert.match(r.stdout, /caliber=E4-v1/);
    assert.match(r.stdout, /steps=3/);
    assert.match(r.stdout, /final=1\.000/);
    const report = JSON.parse(readFileSync(file + '.score.json', 'utf8'));
    assert.equal(report.caliber_version, 'E4-v1');
    assert.equal(report.ok, true);
    assert.equal(report.task.step_count, 3);
  } finally {
    rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test('CLI:无旗标透明重启 + --out/--threshold 注入 → exit 0', () => {
  const file = makeTempJournal();
  const outFile = file + '.custom.json';
  try {
    const r = spawnSync(process.execPath,
      [CLI_PATH, file, '--out', outFile, '--threshold', '0.99'],
      { encoding: 'utf8', timeout: 120000 });
    assert.equal(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.match(r.stdout, /ProcessScore/); // stdio 透传:重启子进程的摘要回到本进程 stdout
    const report = JSON.parse(readFileSync(outFile, 'utf8'));
    assert.equal(report.calibration.low_step_threshold, 0.99); // 阈值注入生效
    assert.ok(report.first_low_step);                          // 0.99 阈值 ⇒ 有步被锚定
  } finally {
    rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test('CLI:缺参数 → exit 1 友好用法(不抛 stack)', () => {
  const r = spawnSync(process.execPath,
    ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', CLI_PATH],
    { encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /用法/);
  assert.ok(!r.stderr.includes(' at ')); // 无 stack 泄漏
});
