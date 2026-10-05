// test/actionVerifier.channels.test.ts
// W6R-B6 补强：actionVerifier.channels 分区（W6-2 提取）的单测 —— 旁路证据通道的
// 纯函数面：W5-3 跨机互证判决（judgeRemoteChange + 净化面）与 W4-8 声学事件净化
//（sanitizeAudioEvent）。全离线确定性：纯函数 + 垃圾输入绝不抛。
//   ① sanitizeRemoteRegion：合法透传 / 越界夹取 [0,1] / 退化框（零面积、反转、
//      夹取后退化）⇒ null / 非法形状（null、数字、字符串、数组、缺字段、NaN、
//      Infinity）⇒ null 不抛；
//   ② sanitizeRemoteChange：合法载荷透传 / 字段类型不合法的诚实缺省（screen='',
//      region=null, regions=[]）/ 坏框静默剔除好框保留 / 顶层非对象与数组 ⇒ null；
//   ③ judgeRemoteChange 重叠率分支：高覆盖 corroborated（含 superset ⇒ overlap=1）、
//      闭下限恰 0.25 命中、0.2499 不达阈（overlap 照报最优值）、4 位小数舍入、
//      多区域取最优（max；不相交/退化区域贡献 0）、hint 内部净化（越界夹取后仍可
//      判 / 非法 hint ⇒ no-hint）、三分支缺席方言（absent/no-hint/no-change-regions）；
//   ④ 公开面接线：actionVerifier.ts 的 judgeRemoteChange 包装与 channels 纯核心
//      逐案同判（包装注入恰为立法常量 —— ΠΑΝ-127 拆分零漂移）；
//   ⑤ sanitizeAudioEvent：五类事件透传、confidence 夹取 [0,1]、缺席值缺省
//      （confidence→0、ts→Date.now()）、未知事件类/非对象 ⇒ null、多余字段不漏。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  judgeRemoteChange as judgeRemoteChangeCore,
  sanitizeRemoteRegion,
  sanitizeRemoteChange,
  sanitizeAudioEvent,
} from '../src/actionVerifier.channels.ts';
import {
  judgeRemoteChange as judgeViaMain,
  REMOTE_EVIDENCE_OVERLAP_MIN,
  type AudioEvent,
  type RemoteChange,
  type RemoteRegion,
} from '../src/actionVerifier.ts';

// ΠΑΝ-127（D-F5 拆环）：channels 判决核心改收阈值参数（端口注入 —— 桶
// actionVerifier.ts 的公开二参包装注入立法常量；常量受 w5cross ⑩「立法在源」
// 源级锁定不可搬家）。测试本地以同一立法常量回填二参方言 —— 下方全部调用
// 点零改动，纯核心的受测阈值与修法前逐字相同。
const judgeRemoteChange = (hint: RemoteRegion | null, change: RemoteChange | null) =>
  judgeRemoteChangeCore(hint, change, REMOTE_EVIDENCE_OVERLAP_MIN);

// ═══ ① sanitizeRemoteRegion ═══

test('W6R-ch①a: 合法归一化框原样透传（deepEqual 全字段）', () => {
  const r: RemoteRegion = { x0: 0.1, y0: 0.2, x1: 0.5, y1: 0.9 };
  assert.deepEqual(sanitizeRemoteRegion(r), r);
  // 边界值 0/1 合法（单位框）
  assert.deepEqual(sanitizeRemoteRegion({ x0: 0, y0: 0, x1: 1, y1: 1 }), { x0: 0, y0: 0, x1: 1, y1: 1 });
});

test('W6R-ch①b: 越界坐标夹取进 [0,1]（负值抬 0、超 1 压 1，几何保持非退化）', () => {
  assert.deepEqual(
    sanitizeRemoteRegion({ x0: -0.5, y0: -2, x1: 2, y1: 0.5 }),
    { x0: 0, y0: 0, x1: 1, y1: 0.5 },
  );
});

test('W6R-ch①c: 退化框 ⇒ null —— 零面积 / 反转 / 夹取后退化三形态', () => {
  assert.equal(sanitizeRemoteRegion({ x0: 0.5, y0: 0.5, x1: 0.5, y1: 0.8 }), null, 'x1===x0 零宽');
  assert.equal(sanitizeRemoteRegion({ x0: 0, y0: 0, x1: 1, y1: 0 }), null, 'y1<=y0 零高');
  assert.equal(sanitizeRemoteRegion({ x0: 0.8, y0: 0, x1: 0.2, y1: 1 }), null, 'x1<x0 反转框');
  assert.equal(sanitizeRemoteRegion({ x0: 1.5, y0: 0, x1: 1.8, y1: 1 }), null,
    '夹取后 x0=x1=1 退化 —— 值域夹取救不了几何退化');
});

test('W6R-ch①d: 非法形状 ⇒ null 绝不抛 —— null/数字/字符串/数组/缺字段/NaN/Infinity', () => {
  for (const bad of [null, undefined, 42, 'box', [0, 0, 1, 1], {}, { x0: 0, y0: 0, x1: 1 }]) {
    assert.equal(sanitizeRemoteRegion(bad), null, `垃圾输入 ${JSON.stringify(bad)} ⇒ null`);
  }
  assert.equal(sanitizeRemoteRegion({ x0: NaN, y0: 0, x1: 1, y1: 1 }), null, 'NaN 非有限 ⇒ null');
  assert.equal(sanitizeRemoteRegion({ x0: 0, y0: -Infinity, x1: 1, y1: 1 }), null, '-Infinity ⇒ null');
});

// ═══ ② sanitizeRemoteChange ═══

test('W6R-ch②a: 合法载荷透传 —— screen/region/regions 字段原样（含 region=null 方言）', () => {
  const c: RemoteChange = {
    screen: 'feedfacefeedface', region: '0123abcd0123abcd',
    regions: [{ x0: 0.1, y0: 0.1, x1: 0.5, y1: 0.5 }],
  };
  assert.deepEqual(sanitizeRemoteChange(c), c);
  assert.deepEqual(sanitizeRemoteChange({ screen: 'aa', region: null, regions: [] }),
    { screen: 'aa', region: null, regions: [] });
});

test('W6R-ch②b: 字段类型不合法 ⇒ 诚实缺省（screen 数字→空串、region 数字→null、regions 缺席→[]）', () => {
  assert.deepEqual(
    sanitizeRemoteChange({ screen: 7, region: 99 }),
    { screen: '', region: null, regions: [] },
    '形状坏字段不毒化整载荷 —— 能救的字段救，救不了的给缺省');
});

test('W6R-ch②c: regions 内坏框静默剔除、好框保留（部分坏 ≠ 全弃）', () => {
  const r = sanitizeRemoteChange({
    regions: [
      { x0: 0.9, y0: 0.9, x1: 0.1, y1: 0.2 }, // 反转 ⇒ 剔除
      'junk' as unknown as RemoteRegion,      // 非对象 ⇒ 剔除
      { x0: 0.1, y0: 0.1, x1: 0.3, y1: 0.3 }, // 合法 ⇒ 保留
    ],
  });
  assert.deepEqual(r, { screen: '', region: null, regions: [{ x0: 0.1, y0: 0.1, x1: 0.3, y1: 0.3 }] });
});

test('W6R-ch②d: 顶层非对象 / 数组 ⇒ null（证据缺席）', () => {
  assert.equal(sanitizeRemoteChange(null), null);
  assert.equal(sanitizeRemoteChange([]), null, '数组不是合法载荷形状');
  assert.equal(sanitizeRemoteChange('change'), null);
});

// ═══ ③ judgeRemoteChange 重叠率分支 ═══

/** 期望区域 [0,0]×[1,0.25]（面积 0.25）—— 覆盖率分母 */
const HINT: RemoteRegion = { x0: 0, y0: 0, x1: 1, y1: 0.25 };

test('W6R-ch③a: 超集区域 ⇒ overlap 恰 1（覆盖率以上限封顶）；高覆盖命中 corroborated', () => {
  const sup = judgeRemoteChange(HINT, { screen: '', region: null, regions: [{ x0: 0, y0: 0, x1: 1, y1: 1 }] });
  assert.deepEqual(sup, { verdict: 'corroborated', overlap: 1 }, '区域 ⊇ 期望 ⇒ 交集=期望 ⇒ 覆盖率 1');
  const half = judgeRemoteChange(HINT, { screen: '', region: null, regions: [{ x0: 0, y0: 0, x1: 1, y1: 0.125 }] });
  assert.deepEqual(half, { verdict: 'corroborated', overlap: 0.5 }, '半高覆盖 0.5 ≥ 0.25 ⇒ 命中');
});

test('W6R-ch③b: 闭下限 —— overlap 恰 0.25 ⇒ corroborated（≥ 语义）', () => {
  assert.equal(REMOTE_EVIDENCE_OVERLAP_MIN, 0.25, '立法常量经主文件再导出读数不变');
  const edge = judgeRemoteChange(HINT, { screen: '', region: null, regions: [{ x0: 0, y0: 0, x1: 1, y1: 0.0625 }] });
  assert.equal(edge.verdict, 'corroborated', '0.0625/0.25 = 0.25 恰达下限 ⇒ 命中');
  assert.equal(edge.overlap, 0.25);
});

test('W6R-ch③c: 差一丝不达阈 ⇒ unverified + overlap 照报最优值（证据保留）', () => {
  const near = judgeRemoteChange(HINT, {
    screen: '', region: null,
    regions: [{ x0: 0, y0: 0, x1: 0.9996, y1: 0.0625 }], // 交集 0.062475 / 0.25 = 0.2499
  });
  assert.deepEqual(near, { verdict: 'unverified', overlap: 0.2499, reason: 'overlap-below-min' },
    '0.2499 < 0.25 ⇒ 诚实不命中，且最优覆盖率照报');
});

test('W6R-ch③d: 覆盖率 4 位小数确定性舍入（0.44444… → 0.4444）', () => {
  // 期望 [0,0]×[0.3,0.3]（面积 0.09）；区域 [0,0]×[0.2,0.2] ⇒ 0.04/0.09 = 0.4444…
  const hint: RemoteRegion = { x0: 0, y0: 0, x1: 0.3, y1: 0.3 };
  const r = judgeRemoteChange(hint, { screen: '', region: null, regions: [{ x0: 0, y0: 0, x1: 0.2, y1: 0.2 }] });
  assert.deepEqual(r, { verdict: 'corroborated', overlap: 0.4444 }, 'Math.round(best×10000)/10000');
});

test('W6R-ch③e: 多区域取最优（max）—— 不相交与退化区域贡献 0，不拖累最优', () => {
  const r = judgeRemoteChange(HINT, {
    screen: '', region: null,
    regions: [
      { x0: 0.6, y0: 0.6, x1: 0.9, y1: 0.9 },               // 与期望不相交 ⇒ 0
      { x0: 0.5, y0: 0, x1: 0.5, y1: 0.2 },                 // 零宽退化 ⇒ 0
      { x0: 0, y0: 0, x1: 1, y1: 0.125 },                   // 覆盖 0.5 ⇒ 最优
    ],
  });
  assert.deepEqual(r, { verdict: 'corroborated', overlap: 0.5 });
});

test('W6R-ch③f: 缺席三分支 —— change=null ⇒ absent；hint 非法 ⇒ no-hint；无区域 ⇒ no-change-regions', () => {
  assert.deepEqual(judgeRemoteChange(HINT, null), { verdict: 'unverified', overlap: 0, reason: 'absent' });
  assert.deepEqual(
    judgeRemoteChange({ x0: NaN, y0: 0, x1: 1, y1: 1 }, { screen: '', region: null, regions: [HINT] }),
    { verdict: 'unverified', overlap: 0, reason: 'no-hint' },
    'hint 非法（NaN）⇒ 净化后 null ⇒ 严格不互证');
  assert.deepEqual(judgeRemoteChange(null, { screen: '', region: null, regions: [HINT] }),
    { verdict: 'unverified', overlap: 0, reason: 'no-hint' }, 'hint=null ⇒ 未声明');
  assert.deepEqual(judgeRemoteChange(HINT, { screen: '', region: null, regions: [] }),
    { verdict: 'unverified', overlap: 0, reason: 'no-change-regions' }, 'B 屏无变化区域');
});

test('W6R-ch③g: 判决内部净化 hint —— 越界 hint 夹取后仍可判（不要求调用方预净化）', () => {
  // hint {x0:-2,y0:-2,x1:2,y1:2} 夹取为单位框（面积 1）；区域覆盖 [0,0]×[1,0.5] ⇒ 0.5
  const r = judgeRemoteChange(
    { x0: -2, y0: -2, x1: 2, y1: 2 },
    { screen: '', region: null, regions: [{ x0: 0, y0: 0, x1: 1, y1: 0.5 }] },
  );
  assert.deepEqual(r, { verdict: 'corroborated', overlap: 0.5 });
});

// ═══ ④ 公开面接线（拆分零漂移）═══

test('W6R-ch④: actionVerifier 公开二参面与 channels 纯核心零漂移（包装注入恰为立法常量）', () => {
  // ΠΑΝ-127（D-F5 拆环）：主面由「再导出同一引用」改为「桶包装 + 立法常量
  // 注入」—— 零漂移断言随之升级为语义等价：公开面输出 ≡ 核心(立法阈值)
  // 输出，含闭下限 0.25 边界与缺席分支（包装不得偷换阈值或语义）。
  const HINT4: RemoteRegion = { x0: 0, y0: 0, x1: 1, y1: 0.25 };
  const inputs: Array<[RemoteRegion | null, RemoteChange | null]> = [
    [HINT4, { screen: '', region: null, regions: [{ x0: 0, y0: 0, x1: 1, y1: 0.0625 }] }], // 恰 0.25 闭下限
    [HINT4, { screen: '', region: null, regions: [{ x0: 0, y0: 0, x1: 1, y1: 0.125 }] }],  // 0.5 命中
    [HINT4, { screen: '', region: null, regions: [{ x0: 0, y0: 0, x1: 1, y1: 0.06 }] }],   // 不达阈
    [HINT4, null],                                                                        // absent
    [null, { screen: '', region: null, regions: [HINT4] }],                               // no-hint
  ];
  for (const [hint, change] of inputs) {
    assert.deepEqual(judgeViaMain(hint, change), judgeRemoteChangeCore(hint, change, REMOTE_EVIDENCE_OVERLAP_MIN),
      '公开面与纯核心逐案同判（阈值注入零漂移）');
  }
  assert.equal(REMOTE_EVIDENCE_OVERLAP_MIN, 0.25, '包装注入的立法常量读数不变（立法在源）');
});

// ═══ ⑤ sanitizeAudioEvent（W4-8 声学事件净化面）═══

test('W6R-ch⑤a: 五类非语义事件合法透传（deepEqual 精确键集，多余字段不漏出）', () => {
  for (const kind of ['notification_ding', 'error_beep', 'success_chime', 'key_click', 'silence'] as const) {
    const ev = sanitizeAudioEvent({ event: kind, confidence: 0.4, ts: 1_759_000_000_000 });
    assert.deepEqual(ev, { event: kind, confidence: 0.4, ts: 1_759_000_000_000 }, `${kind} 原样通过`);
  }
  const noisy = sanitizeAudioEvent({ event: 'silence', confidence: 0.5, ts: 1, extra: 'x' } as unknown as AudioEvent);
  assert.deepEqual(noisy, { event: 'silence', confidence: 0.5, ts: 1 }, '未知字段被剥除（净化面只放行契约字段）');
});

test('W6R-ch⑤b: confidence 夹取 [0,1] —— 越界值夹正而非弃证（7→1、-3→0）', () => {
  assert.equal(sanitizeAudioEvent({ event: 'key_click', confidence: 7, ts: 1 })!.confidence, 1);
  assert.equal(sanitizeAudioEvent({ event: 'key_click', confidence: -3, ts: 1 })!.confidence, 0);
  assert.equal(sanitizeAudioEvent({ event: 'key_click', confidence: NaN, ts: 1 })!.confidence, 0,
    'NaN 非有限 ⇒ 缺省 0');
});

test('W6R-ch⑤c: 字段缺席的缺省 —— confidence→0、ts→Date.now()（界内确定性断言）', () => {
  const onlyEvent = sanitizeAudioEvent({ event: 'silence' });
  assert.equal(onlyEvent!.confidence, 0, '缺 confidence ⇒ 0');
  const t0 = Date.now();
  const ev = sanitizeAudioEvent({ event: 'silence', confidence: 0.2 });
  const t1 = Date.now();
  assert.ok(ev!.ts >= t0 && ev!.ts <= t1, `缺 ts ⇒ 取证时刻（[${t0}, ${t1}] 界内，实测 ${ev!.ts}）`);
});

test('W6R-ch⑤d: 未知事件类 / 非对象载荷 ⇒ null 绝不抛（语义冒充物在净化层被拒）', () => {
  assert.equal(sanitizeAudioEvent({ event: 'speech_transcript', confidence: 5, ts: NaN }), null,
    '语义识别词汇冒充事件类 ⇒ 拒之门外');
  assert.equal(sanitizeAudioEvent({ event: 'SUCCESS_CHIME', confidence: 0.9, ts: 1 }), null,
    '大小写变体不宽容（字面镜像契约）');
  for (const bad of [null, undefined, 42, 'ding', [], { confidence: 0.5, ts: 1 }]) {
    assert.equal(sanitizeAudioEvent(bad), null, `垃圾输入 ${JSON.stringify(bad)} ⇒ null`);
  }
});
