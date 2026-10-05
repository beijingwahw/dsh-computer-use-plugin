// src/autonomy/gym.pcgCampaign.ts
// W8-B1（DEBTS D-F1 拆分潮）：自 gym.ts 低风险分区提取（对齐 actionVerifier.*
// 兄弟文件先例）—— W4-4 文法训练营有界消费面整体搬迁：预算/报告/选项契约
// （PcgRunBudgetInput / PcgRunReport / PcgCampaignOptions / PcgCampaignReport）与
// runPcgCampaign（无限流水 × 文法课程 × 预算封顶的闭环）。行为零变化（纯搬运，
// 逐字节不改）；gym.ts 以再导出保持导入面不变（AutonomyGym.runPcgTasks 的同类
// 有界消费留在馆本体 —— 闭环器官不动，本件是独立的 campaign 入口）。缺省值
// （种子 4242 / 步数 12 / 虚拟时钟步进 5ms）全部自 gym.ts 立法在源导入 ——
// 与训练营缺省同源同义。防弹：垃圾输入收敛为空报告/截断，绝不抛异常。
// ΠΑΝ-127（D-F5 清偿）：fnv1a 改自零出边叶 gym.rng.ts 导入；AutonomyGym 与
// 立法缺省（DEFAULT_SEED/DEFAULT_MAX_STEPS/CLOCK_STEP_MS）经端口注入
//（runPcgCampaign 增收 ports 参数，注入方 = 桶 gym.ts 的公开包装 —— 原自桶
// 回借构成桶-卫星 value 二环；类型面仍 type-import 自桶，type 边豁免）。
// 行为零变化。
import { fnv1a } from './gym.rng';
import type { AutonomyGym, AutonomyGymKernelOptions, GymRoundResult } from './gym';
import type { GymNoiseSpec } from './gym.noise';
import { pcgEffectiveWeights, updatePcgCurriculum } from './gym.pcgGrammar';
import type { GymGrammarOptions } from './gym.pcgGrammar';
import { gymWorldFactory } from './gym.pcgWorld';
import type { PcgWorld } from './gym.pcgWorld';
import type { RunRecord } from './evolutionEngine';

/**
 * ΠΑΝ-127：文法训练营端口（训练营工厂 + 立法缺省的注入缝 —— 卫星不再回借
 * 桶的类与常量；注入方 = gym.ts 公开包装，立法在源桶）。
 */
export interface PcgCampaignPorts {
  /** 训练营构造工厂（虚拟时钟与内核选项透传） */
  createGym: (o: {
    seed: number;
    maxSteps: number;
    kernel?: AutonomyGymKernelOptions;
    now?: () => number;
  }) => AutonomyGym;
  /** 缺省种子（= gym.ts DEFAULT_SEED，经包装注入） */
  defaultSeed: number;
  /** 缺省步数上限（= gym.ts DEFAULT_MAX_STEPS，经包装注入） */
  defaultMaxSteps: number;
  /** 虚拟时钟步进（= gym.ts CLOCK_STEP_MS，经包装注入） */
  clockStepMs: number;
}

// ─── W4-4：有界消费（预算封顶 + 诚实截断） ───

/** 预算入参（世界数 / 累计步数；全部可缺席走缺省） */
export interface PcgRunBudgetInput {
  maxWorlds?: number;
  maxTotalSteps?: number;
}

/** 有界消费报告：战绩 + 预算账 + 一句中文总结 */
export interface PcgRunReport {
  rounds: GymRoundResult[];
  worldsRun: number;
  stepsTotal: number;
  budget: { maxWorlds: number; maxTotalSteps: number; truncated: boolean; reason: 'none' | 'worlds' | 'steps' };
  summary: string;
}

/** 文法训练营选项（campaign = 无限流水 × 文法课程 × 预算封顶的闭环） */
export interface PcgCampaignOptions {
  /** 主种子（世界种子流 + 馆种子之源；缺省 4242 —— 训练营缺省同源） */
  seed?: number;
  /** 文法难度 1..3（缺省 1） */
  difficulty?: number;
  /** 每世界步数上限（缺省 12 = 训练营缺省） */
  maxSteps?: number;
  /** W1-4 噪声谱（各世界同谱传感器病变） */
  noise?: GymNoiseSpec;
  /** 初始产生式权重（课程关时也作为文法先验） */
  weights?: Record<string, number>;
  /** 预算（世界数缺省 8 / 累计步数缺省 96） */
  budget?: PcgRunBudgetInput;
  /** 文法课程（缺省关 = 权重全程不动，只按先验采样） */
  curriculum?: { enabled?: boolean; learnRate?: number };
  /** Θ-3 实验室套件注入（缺省馆内自铸独立套件 —— 隔离铁律不变） */
  kernel?: AutonomyGymKernelOptions;
}

/** campaign 总汇报：有界消费账 + 文法课程权重前后 + 一句中文总结 */
export interface PcgCampaignReport extends PcgRunReport {
  curriculum: { enabled: boolean; weightsBefore: Record<string, number>; weightsAfter: Record<string, number> };
}

/**
 * W4-4 文法 PCG 无限训练营（campaign）：无限流水 × 文法课程 × 预算封顶。
 *   · 每世界种子由主种子 fnv1a 派生（序号唯一 ⇒ 重放一致）；
 *   · 课程开：每轮收官把 {推导链, 成败} 喂 updatePcgCurriculum ⇒ 下一世界按
 *     新权重推导（失败多的产生式加权生成 —— POET 式任务-智能体共进化）；
 *     课程关：权重全程不动；
 *   · 预算封顶：任一触顶（世界数/累计步数）即停，报告诚实截断（truncated +
 *     reason）；真值入账走馆内实验室账本（pcg.truth.* 与 Θ-3 记账同本 —— 对账
 *     通道合一，隔离律不变：生产单例零触碰）；
 *   · 确定性：全注入虚拟时钟 + 钉死种子流 ⇒ 同 opts 重放逐字段一致；
 *   · 防弹：垃圾输入收敛为空报告/截断，绝不抛异常。
 */
export async function runPcgCampaign(opts: PcgCampaignOptions = {}, ports: PcgCampaignPorts): Promise<PcgCampaignReport> {
  const o = opts && typeof opts === 'object' ? opts : ({} as PcgCampaignOptions);
  const seedNum = Number(o.seed);
  // ΠΑΝ-127：立法缺省经端口注入（原直接回借 gym.ts 立法常量 —— 拆环）
  const master = Number.isFinite(seedNum) ? Math.floor(seedNum) : ports.defaultSeed;
  const msNum = Number(o.maxSteps);
  const maxSteps = Number.isFinite(msNum) && msNum >= 1 ? Math.floor(msNum) : ports.defaultMaxSteps;
  const b = o.budget && typeof o.budget === 'object' ? o.budget : ({} as PcgRunBudgetInput);
  const wRaw = Number(b.maxWorlds);
  const maxWorlds = Number.isFinite(wRaw) && wRaw >= 1 ? Math.min(4096, Math.floor(wRaw)) : 8;
  const sRaw = Number(b.maxTotalSteps);
  const maxTotalSteps = Number.isFinite(sRaw) && sRaw >= 1 ? Math.min(65536, Math.floor(sRaw)) : 96;
  const cur =
    o.curriculum && typeof o.curriculum === 'object'
      ? o.curriculum
      : ({} as NonNullable<PcgCampaignOptions['curriculum']>);
  const curOn = cur.enabled === true;

  // 虚拟时钟（零真钟；与馆内实验室校准报告同源确定）
  let t = 1_000_000;
  // ΠΑΝ-127：时钟步进与训练营构造经端口注入（原直接回借 gym.ts —— 拆环）
  const clock = (): number => (t += ports.clockStepMs);
  const gym = ports.createGym({ seed: master, maxSteps, kernel: o.kernel, now: clock });
  const labLedger = (() => {
    try {
      return gym.lab?.ledger ?? undefined;
    } catch {
      return undefined;
    }
  })();

  const weightsBefore = pcgEffectiveWeights(o.weights);
  let weights: Record<string, number> = { ...weightsBefore };

  const rounds: GymRoundResult[] = [];
  let worldsRun = 0;
  let stepsTotal = 0;
  let truncated = false;
  let reason: 'none' | 'worlds' | 'steps' = 'none';
  try {
    for (let i = 0; ; i++) {
      if (worldsRun >= maxWorlds) {
        truncated = true;
        reason = 'worlds';
        break;
      }
      if (stepsTotal >= maxTotalSteps) {
        truncated = true;
        reason = 'steps';
        break;
      }
      const worldSeed = fnv1a(`w4-4:pcg:world:${master}:${i}`) % 0x7fffffff;
      const grammar: GymGrammarOptions = {
        difficulty: o.difficulty,
        noise: o.noise && typeof o.noise === 'object' ? o.noise : undefined,
        ledger: labLedger,
        now: clock,
        ...(curOn ? { weights } : {}),
      };
      const world = gymWorldFactory(worldSeed, grammar);
      const round = await gym.runPcgWorld(world);
      rounds.push(round.result);
      worldsRun += 1;
      stepsTotal += Number.isFinite(round.result.steps) ? round.result.steps : 0;
      const record: RunRecord = {
        goal: world.derivation.goal,
        success: round.result.success,
        steps: round.result.steps,
        durationMs: round.result.durationMs,
        strategies: round.strategies,
        ...(round.result.success ? {} : { failureRootCause: `phase=${round.result.phase}` }),
      };
      gym.evolution.ingest(record);
      if (curOn && round.result.pcg) {
        weights = updatePcgCurriculum(weights, [{ chain: round.result.pcg.chain, success: round.result.success }], {
          learnRate: cur.learnRate,
        });
      }
    }
  } catch {
    /* 防弹承诺：漏网异常不炸营——已完成的世界照常入报 */
  }

  const ok = rounds.filter(r => r.success).length;
  const summary =
    `文法训练营${worldsRun}世界收官：达成${ok}轮、失败${rounds.length - ok}轮，` +
    `累计${stepsTotal}步（预算${worldsRun}/${maxWorlds}世界、${stepsTotal}/${maxTotalSteps}步${truncated ? `，${reason === 'worlds' ? '世界数' : '步数'}触顶截断` : ''}）` +
    `${curOn ? `，课程权重已按成败更新（${Object.keys(weightsBefore).length}条产生式）` : '，课程关闭（先验采样）'}——无限生成，有界消费。`;
  return {
    rounds,
    worldsRun,
    stepsTotal,
    budget: { maxWorlds, maxTotalSteps, truncated, reason },
    curriculum: { enabled: curOn, weightsBefore, weightsAfter: weights },
    summary,
  };
}
