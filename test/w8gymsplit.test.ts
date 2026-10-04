// test/w8gymsplit.test.ts
// W8-B1（DEBTS D-F1 拆分潮）执法测试：gym.ts 拆分后的「导入面稳定」与
// 「立法在源」两项纪律 ——
//   ① 导入面稳定：拆分前 gym.ts 的全部公共符号（值面 + 类型面）仍从
//      '../src/autonomy/gym.ts' 原名原样可导（全部消费方零改动的结构保障）；
//      顺带锚定 autonomy 桶（autonomy/index.ts 的 export * 链）仍透出
//      AutonomyGym（dreamReplay 的既有消费路径）。
//   ② 立法在源：拆分只搬实现，缺省值/轮转律留守 gym.ts（卫星件经导入消费 ——
//      单一事实源）；头部 W6-1 结构性保留登记仍在首 5 行（w7doctor 探针契约）。
// 类型面的对账由编译期承担：下方 _TYPE_FACE 逐名引用全部再导出类型，少一个
// tsc 即红（运行时零成本 —— 数组恒空，绝无副作用）。不改任何既有断言。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as gym from '../src/autonomy/gym.ts';
import * as autonomy from '../src/autonomy/index.ts';
import type {
  AutonomyGymKernelOptions,
  AutonomyGymOptions,
  CurriculumSample,
  CurriculumSampleOptions,
  CurriculumTrace,
  GymConvergenceProbe,
  GymControl,
  GymCurriculumOptions,
  GymGenerationRecord,
  GymGenerationTrend,
  GymGenerationsReport,
  GymGrammarOptions,
  GymLabSuite,
  GymNoiseLevel,
  GymNoiseResolved,
  GymNoiseSpec,
  GymNoiseSweepOptions,
  GymNoiseSweepPoint,
  GymNoiseSweepResult,
  GymReport,
  GymRoundResult,
  GymTask,
  GymWorldKind,
  PcgCampaignOptions,
  PcgCampaignReport,
  PcgCurriculumFeedback,
  PcgDecorRule,
  PcgDerivation,
  PcgElementRule,
  PcgMainRule,
  PcgOverlayTruth,
  PcgProductionId,
  PcgProductionSpec,
  PcgRoundTrace,
  PcgRunBudgetInput,
  PcgRunReport,
  PcgSceneNode,
  PcgScreenRule,
  PcgStageTruth,
  PcgWorld,
} from '../src/autonomy/gym.ts';

/** 类型面对账锚：恒空数组 —— 任一类型名从 gym.ts 消失 ⇒ tsc 编译期即红 */
const _TYPE_FACE: Array<[
  AutonomyGymKernelOptions, AutonomyGymOptions, CurriculumSample, CurriculumSampleOptions,
  CurriculumTrace, GymConvergenceProbe, GymControl, GymCurriculumOptions, GymGenerationRecord,
  GymGenerationTrend, GymGenerationsReport, GymGrammarOptions, GymLabSuite, GymNoiseLevel,
  GymNoiseResolved, GymNoiseSpec, GymNoiseSweepOptions, GymNoiseSweepPoint, GymNoiseSweepResult,
  GymReport, GymRoundResult, GymTask, GymWorldKind, PcgCampaignOptions, PcgCampaignReport,
  PcgCurriculumFeedback, PcgDecorRule, PcgDerivation, PcgElementRule, PcgMainRule,
  PcgOverlayTruth, PcgProductionId, PcgProductionSpec, PcgRoundTrace, PcgRunBudgetInput,
  PcgRunReport, PcgSceneNode, PcgScreenRule, PcgStageTruth, PcgWorld,
]> = [];

test('W8-B1 ①导入面稳定（值面）：拆分前全部公共值符号仍从 gym.ts 原名可导', () => {
  const valueFace: Array<[string, unknown, 'function' | 'class' | 'other']> = [
    ['AutonomyGym', gym.AutonomyGym, 'class'],
    ['GymWorld', gym.GymWorld, 'class'],
    ['PcgWorld', gym.PcgWorld, 'class'],
    ['PCG_PRODUCTIONS', gym.PCG_PRODUCTIONS, 'other'],
    ['derivePcgScene', gym.derivePcgScene, 'function'],
    ['generateTasks', gym.generateTasks, 'function'],
    ['gymWorldFactory', gym.gymWorldFactory, 'function'],
    ['mulberry32', gym.mulberry32, 'function'],
    ['noiseSweep', gym.noiseSweep, 'function'],
    ['pcgBaseWeights', gym.pcgBaseWeights, 'function'],
    ['pcgEffectiveWeights', gym.pcgEffectiveWeights, 'function'],
    ['pcgWorldStream', gym.pcgWorldStream, 'function'],
    ['resolveGymNoise', gym.resolveGymNoise, 'function'],
    ['runPcgCampaign', gym.runPcgCampaign, 'function'],
    ['sampleCurriculumWorld', gym.sampleCurriculumWorld, 'function'],
    ['updatePcgCurriculum', gym.updatePcgCurriculum, 'function'],
  ];
  for (const [name, v, kind] of valueFace) {
    assert.notEqual(v, undefined, `${name} 必须仍从 gym.ts 导出（拆分律：导入面零改动）`);
    if (kind !== 'other') {
      assert.equal(typeof v, 'function', `${name} 必须保持值导出（类/函数面不降级为 type）`);
    }
  }
  // 文法立法表的形状锚（16 条产生式 —— w4pcg 词表口径的快速对账）
  assert.ok(Array.isArray(gym.PCG_PRODUCTIONS) && gym.PCG_PRODUCTIONS.length === 16);
});

test('W8-B1 ①桶透出：autonomy/index.ts 的 export * 链仍透出训练营（dreamReplay 消费路径）', () => {
  assert.equal(typeof (autonomy as unknown as Record<string, unknown>).AutonomyGym, 'function');
});

test('W8-B1 ②立法在源：缺省值/轮转律留守 gym.ts；W6-1 头注记仍在首 5 行', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, '../src/autonomy/gym.ts'), 'utf8');
  // w7doctor 探针契约锚（首 5 行必须含 W6-1 登记记号 —— 拆分不清除保留登记）
  assert.match(src.split('\n').slice(0, 5).join('\n'), /W6-1 结构性保留登记/);
  // 立法在源：缺省值/轮转律只此一份，卫星件经导入消费
  assert.match(src, /export const DEFAULT_SEED = 4242;/, '缺省种子立法在源（= 4242）');
  assert.match(src, /export const DEFAULT_MAX_STEPS = 12;/, '缺省步数上限立法在源（= 12）');
  assert.match(src, /export const CLOCK_STEP_MS = 5;/, '虚拟时钟步进立法在源（= 5ms）');
  assert.match(src, /export const KIND_ORDER/, '四世界轮转律立法在源');
  // 实现已分区：世界/文法/诊所不再同册（本测试不锁行数 —— 只锁「不再回流」）
  assert.doesNotMatch(src, /class GymWorld \{/, 'GymWorld 已分区至 gym.world.ts');
  assert.doesNotMatch(src, /class PcgWorld \{/, 'PcgWorld 已分区至 gym.pcgWorld.ts');
  assert.doesNotMatch(src, /export async function noiseSweep/, 'noiseSweep 已分区至 gym.noise.ts');
  assert.doesNotMatch(src, /export function derivePcgScene/, 'derivePcgScene 已分区至 gym.pcgDerive.ts');
  assert.doesNotMatch(src, /export async function runPcgCampaign/, 'runPcgCampaign 已分区至 gym.pcgCampaign.ts');
});
