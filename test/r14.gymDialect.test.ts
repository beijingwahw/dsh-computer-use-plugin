// test/r14.gymDialect.test.ts
// ΑΩ-R14（方言统一）执法册 —— gym.ts 两处方言漂移收口的取证与差异钉死：
//   ① 判据核对：gym 证据判定（gymCriteriaEvidence）复用 criteriaEval 单一器官，
//      但肯定面取精确匹配（tolerance=0）—— 与器官缺省 fuzzy ⌈m/6⌉ 的差异在此
//      钉死：距判据一字之差的语料（W1-4 OCR 词形腐蚀「成→城/下→不/可→司」的
//      主产地）器官缺省会判 met，gym 判据通道必须保持精确 —— 噪声诊所刻意
//      测量的「噪声下退化」不可被 fuzzy 吸收（noiseSweep 单调性不失真）；
//   ② 否定面证伪（mustNotAppear:/不得出现： 前缀）随器官接入 —— 四世界/PCG
//      现行判据全为肯定面 ⇒ 纯增益零漂移，此处钉死 violated/met/降级三态；
//   ③ rng 单源：mulberry32/fnv1a 流实现自 src/dialects/random.ts 单源供给
//      （gym.mulberry32 = 单源流内核 + gym 种子归一卫兵；gym.fnv1a 原样再
//      导出）—— 金样值钉死「同 seed 逐字节一致」（确定性回放锚）。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  gymCriteriaEvidence,
  generateTasks,
  mulberry32,
  fnv1a,
} from '../src/autonomy/gym.ts';
import {
  mulberry32 as dialectMulberry32,
  fnv1a as dialectFnv1a,
} from '../src/dialects/random.ts';
import { mulberry32 as evoMulberry32 } from '../src/autonomy/evolutionPrimitives.ts';
import { evaluateCriteria, buildCriteriaPairs } from '../src/autonomy/criteriaEval.ts';

// ─── ① 肯定面保持精确：与器官缺省 fuzzy 的差异钉死 ───

test('ΑΩ-R14①a: 距判据一字差的语料 —— 器官缺省 fuzzy 判 met，gym 判据通道保持精确（零证据）', () => {
  // wizard 判据 '下一步完成'（5 字符 ⇒ 缺省容差 ⌈5/6⌉=1）；语料 '成→城' 恰距 1
  const criteria = ['下一步完成'];
  const corpus = '下一步完城 向导结束';
  // 器官缺省（runtime 主路径口径）：距 1 ⇒ fuzzy 命中 met —— 差异面真实存在
  const fuzzyOut = evaluateCriteria(buildCriteriaPairs(criteria), corpus);
  assert.deepEqual(
    fuzzyOut.evidence.map(e => ({ index: e.index, status: e.status })),
    [{ index: 0, status: 'met' }],
    '器官缺省 fuzzy 会把一字差语料判 met（取舍必须显式钉死的原因）',
  );
  // gym 判据通道（tolerance=0 精确）：零证据 —— W1-4 腐蚀词面不被吸收
  assert.deepEqual(
    gymCriteriaEvidence(criteria, corpus),
    [],
    'gym 肯定面保持精确匹配：距 1 不判 met（噪声诊所的退化测量不被 fuzzy 吸收）',
  );
  // 其余判据字面同律钉死（W1-4 混淆矩阵的另两处主产地）
  assert.deepEqual(gymCriteriaEvidence(['提醒已安排'], '提醒已安非 订单已搁置'), []);
  assert.deepEqual(gymCriteriaEvidence(['深页目标可见'], '深页目标司见 页脚版本1.0'), []);
});

test('ΑΩ-R14①b: 精确命中逐字节等价（旧折叠子串方言的零回归对照）+ 非法条目不平移下标 + 语料缺席零证据', () => {
  // 精确出现 ⇒ met（四世界终局判据字面由立法原样入读的既有口径）
  assert.deepEqual(
    gymCriteriaEvidence(['下一步完成'], '下一步完成 向导结束'),
    [{ index: 0, status: 'met' }],
  );
  // 多判据逐条独立：命中者 met、未命中者零证据（不证伪）
  assert.deepEqual(
    gymCriteriaEvidence(['提醒已安排', '不存在字面'], '提醒已安排 订单已搁置'),
    [{ index: 0, status: 'met' }],
  );
  // 非法条目（空白）剔除但下标锚定原位 —— buildCriteriaPairs 同律
  assert.deepEqual(
    gymCriteriaEvidence(['   ', '提醒已安排'], '提醒已安排 订单已搁置'),
    [{ index: 1, status: 'met' }],
  );
  // 大小写/空白折叠同律 + 语料缺席 ⇒ 零证据（诚实降级，与旧空摘要行为一致）
  assert.deepEqual(gymCriteriaEvidence(['NEXT  Done'], 'next   done banner'), [
    { index: 0, status: 'met' },
  ]);
  assert.deepEqual(gymCriteriaEvidence(['下一步完成'], ''), []);
  assert.deepEqual(gymCriteriaEvidence(['下一步完成'], '    '), []);
  assert.deepEqual(gymCriteriaEvidence(['下一步完成'], undefined), []);
  // 非字符串判据账 ⇒ 空证据（防弹）
  assert.deepEqual(gymCriteriaEvidence(null, '任意语料'), []);
});

// ─── ② 否定面证伪随器官接入（零漂移纯增益的三态钉死） ───

test('ΑΩ-R14②: 否定判据 —— 命中禁词 ⇒ violated；语料在场未命中 ⇒ met；语料缺席 ⇒ 零证据', () => {
  assert.deepEqual(
    gymCriteriaEvidence(['不得出现：立即支付'], '订单待确认 立即支付 稍后提醒'),
    [{ index: 0, status: 'violated' }],
    '中文前缀：命中禁词 ⇒ violated（证伪面 —— runAutonomousLoop ⑧ 回填 ⇒ failed）',
  );
  assert.deepEqual(
    gymCriteriaEvidence(['mustNotAppear:升级提示'], '第2页 共3页 下一步'),
    [{ index: 0, status: 'met' }],
    '英文前缀：语料在场且无禁词 ⇒ met',
  );
  assert.deepEqual(
    gymCriteriaEvidence(['不得出现：升级提示'], ''),
    [],
    '语料缺席 ⇒ 零证据（否定判据绝不因「看不见」自动为真 —— 器官诚实降级同律）',
  );
});

// ─── ③ rng 单源：流内核单源 + gym 卫兵律 + 金样（确定性回放锚） ───

test('ΑΩ-R14③a: mulberry32 金样流 —— 同 seed 逐字节一致（收口前实现口径的金样钉死）', () => {
  const r = mulberry32(42);
  assert.deepEqual(
    [r(), r(), r(), r()],
    [0.6011037519201636, 0.44829055899754167, 0.8524657934904099, 0.6697340414393693],
    'mulberry32(42) 首四拍金样（方言统一前后逐字节不变）',
  );
  assert.equal(mulberry32(4242)(), 0.5467061335220933, '缺省种子 4242 首拍金样');
  assert.equal(mulberry32(0)(), 0.26642920868471265, '种子 0 首拍金样');
  // gym 种子归一卫兵律（gym 旧方言）：小数 floor、非有限归 0
  assert.equal(mulberry32(1.9)(), mulberry32(1)(), '小数种子向下取整（floor 律）');
  assert.equal(mulberry32(-1.5)(), mulberry32(-2)(), '负小数种子沿 floor 律（非 ToInt32 截断）');
  assert.equal(mulberry32(Number.NaN)(), mulberry32(0)(), 'NaN 种子按 0 记');
  // 单源流内核消费：整数种子域上 gym 门面 = 单源 = evolutionPrimitives 旧实现
  const viaGym = mulberry32(777);
  const viaDialect = dialectMulberry32(777);
  const viaEvo = evoMulberry32(777);
  const draws = [viaGym(), viaGym(), viaGym()];
  assert.deepEqual(
    draws,
    [viaDialect(), viaDialect(), viaDialect()],
    'gym 门面与单源模块同 seed 同流（流内核只此一份）',
  );
  assert.deepEqual(
    draws,
    [viaEvo(), viaEvo(), viaEvo()],
    '整数种子域与 evolutionPrimitives 旧实现逐字节同源',
  );
});

test('ΑΩ-R14③b: fnv1a 金样与单源再导出 + 任务序列种子锚（rng 消费顺序不变）', () => {
  assert.equal(fnv1a, dialectFnv1a, 'gym.fnv1a 即单源模块原函数（原样再导出，零卫兵）');
  assert.equal(fnv1a(''), 2166136261, 'FNV offset basis');
  assert.equal(fnv1a('abc'), 440920331);
  assert.equal(fnv1a('w1-4:ocr:7'), 1979527757, 'W1-4 噪声域分离派生金样');
  assert.equal(fnv1a('下一步完成'), 262005541, '判据字面散列金样');
  // generateTasks 的 rng 流消费律锚：任务种子 = mulberry32(seed) 逐拍 floor(*0x7fffffff)
  const tasks = generateTasks(42, 2);
  assert.equal(tasks[0].seed, 1290860477, '第 1 任务种子金样（流消费顺序未变）');
  assert.equal(tasks[1].seed, 962696644, '第 2 任务种子金样（流式消费一颗种子，永不回看）');
});
