// src/autonomy/gym.noise.ts
// W8-B1（DEBTS D-F1 拆分潮）：自 gym.ts 低风险分区提取（对齐 actionVerifier.*
// 兄弟文件先例）—— W1-4 病态感知诊所整体搬迁：噪声注入契约（GymNoiseSpec /
// resolveGymNoise / 词形混淆矩阵 / 腐蚀函数）+ noiseSweep 鲁棒性曲线。行为零
// 变化（纯搬运，逐字节不改）；gym.ts 以再导出保持导入面不变。诊所律随件走：
// 噪声只坏「传感器读出」、世界 ground truth 分毫不动；三条独立种子流（fnv1a
// 域分离永不串流）；脏值一律夹取收敛（GYM_NOISE_MAX_JITTER / GYM_NOISY_OCR_CONF
// 单一事实源在此，世界铸造侧 gym.world.ts / gym.pcgWorld.ts 经导入消费）。
import {
  AutonomyGym,
  castTask,
  fnv1a,
  KIND_ORDER,
  mulberry32,
  r2,
  DEFAULT_MAX_STEPS,
} from './gym';
import type { GymTask, GymWorldKind } from './gym';

// ─── W1-4 病态感知诊所：噪声注入契约 ───
//
// 设计律（与训练营既有铁律同源）：
//   · 零漂移：spec 缺席 / 全零 ⇒ resolveGymNoise().active = false ⇒
//     wordsFor / vlmFor / capture / applyAction 全部走原路径原字节——既有 gym
//     测试原样通过是硬约束；
//   · 种子钉死：一切随机消费走 spec.seed 派生的三条独立种子流（ocr / vlm /
//     bbox，fnv1a 域名分离永不串流）——同 spec 重放逐字节一致；
//   · 只坏传感器：噪声作用于假 OCR 的词面与置信、假 VLM 的漏检、双源 bbox
//     抖动与瞬态中间帧；世界的状态机 / 控件真相 / 判据 / 账本（ground truth）
//     分毫不动 ⇒ Θ-3 实验室记账点全部原样复用——「完美感知下校准、噪声下
//     退化」可被对账测量；
//   · 防御式：脏值一律夹取收敛（率夹 [0,1]、抖动夹 [0,80]、瞬态只认 0/1），
//     绝不抛异常。

/** 病态感知噪声谱（全部可缺席；缺席字段按零噪声记） */
export interface GymNoiseSpec {
  /** 噪声主种子（派生 ocr/vlm/bbox 三条独立流；缺省 0——seed 钉死 ⇒ 重放逐字节一致） */
  seed?: number;
  /** OCR 词形混淆率：每个可混淆字符按词形混淆矩阵换字的概率 [0,1]（缺省 0） */
  ocrSwapRate?: number;
  /** OCR 置信跌落率：命中词的置信 0.92 → 0.46 的概率 [0,1]（缺省 0） */
  ocrConfDrop?: number;
  /** VLM 漏检率：每个接地元素被漏报的概率 [0,1]（缺省 0） */
  vlmMissRate?: number;
  /** bbox 抖动幅度：双源读出框四边各加 ±n 整数像素抖动，n 夹 [0,80]（缺省 0） */
  bboxJitterPx?: number;
  /** 瞬态中间帧：1 = 每次动作翻态后，下一帧先回放旧态一拍再入新态（考自适应等待）（缺省 0） */
  transientFrame?: 0 | 1;
}

/** 解析后的规范噪声谱（防御式夹取后的只读形；active = 任一噪声维度在册） */
export interface GymNoiseResolved {
  seed: number;
  ocrSwapRate: number;
  ocrConfDrop: number;
  vlmMissRate: number;
  bboxJitterPx: number;
  transientFrame: 0 | 1;
  /** 任一噪声维度 > 0 / 瞬态在册 ⇒ true（false = 感知读出零漂移） */
  active: boolean;
}

/** W1-4：bbox 抖动上限（像素）——按钮半高 40 量级，≥ 此值抖动可观测打偏点击 */
const GYM_NOISE_MAX_JITTER = 80;
/** W1-4：OCR 置信跌落落点（低于 policy.matchConfident 0.55 ⇒ 匹配置信不足可观测） */
export const GYM_NOISY_OCR_CONF = 0.46;

/**
 * W1-4 词形混淆矩阵（内置小表）：OCR 高频字形混淆对（双向对称）——相邻字形 /
 * 易混字符。覆盖训练营词面（下/页/完/成/深/提/安/稍/支/即/看/目/可），换字只
 * 改 sensor 读出的词面，物理像素与控件真相不动。
 */
const OCR_CONFUSABLES: Readonly<Record<string, string>> = {
  '下': '不', '不': '下',
  '页': '贝', '完': '元', '成': '城', '深': '演',
  '提': '堤', '安': '按', '稍': '梢', '支': '枝',
  '即': '既', '看': '着', '目': '且', '可': '司',
};

/**
 * W1-4：按混淆矩阵腐蚀一个 OCR 词（逐字符独立掷骰，rate=1 ⇒ 可混淆字符全换）。
 * 纯函数 + 注入 rng ⇒ 同 seed 同腐蚀，绝不抛。
 */
export function corruptOcrLabel(label: string, rate: number, rng: () => number): string {
  let out = '';
  for (const ch of typeof label === 'string' ? label : '') {
    const decoy = OCR_CONFUSABLES[ch];
    out += typeof decoy === 'string' && decoy.length > 0 && rng() < rate ? decoy : ch;
  }
  return out;
}

/**
 * W1-4：噪声谱解析（防御式规范形）。非对象 / 脏值全部收敛为该维零噪声；
 * active = 任一维度在册。绝不抛异常。
 */
export function resolveGymNoise(raw: unknown): GymNoiseResolved {
  const o =
    raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Partial<GymNoiseSpec>)
      : {};
  const rate = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
  const seedNum = Number(o.seed);
  const seed =
    Number.isFinite(seedNum) ? Math.floor(Math.abs(seedNum)) % 0x80000000 : 0;
  const jRaw = typeof o.bboxJitterPx === 'number' && Number.isFinite(o.bboxJitterPx) ? o.bboxJitterPx : 0;
  const bboxJitterPx = Math.min(GYM_NOISE_MAX_JITTER, Math.max(0, Math.round(jRaw)));
  const ocrSwapRate = rate(o.ocrSwapRate);
  const ocrConfDrop = rate(o.ocrConfDrop);
  const vlmMissRate = rate(o.vlmMissRate);
  const transientFrame: 0 | 1 = o.transientFrame === 1 ? 1 : 0;
  return {
    seed,
    ocrSwapRate,
    ocrConfDrop,
    vlmMissRate,
    bboxJitterPx,
    transientFrame,
    active:
      ocrSwapRate > 0 || ocrConfDrop > 0 || vlmMissRate > 0 || bboxJitterPx > 0 || transientFrame === 1,
  };
}

// ─── W1-4 病态感知诊所：noiseSweep 鲁棒性曲线 ───

/** 一个噪声档：档位名 + 噪声谱（noise 缺席 = 零漂移基线档） */
export interface GymNoiseLevel {
  /** 档位名（曲线上的横轴标签；缺省/空串按 `L<i>` 兜底） */
  label: string;
  /** 本档噪声谱（缺席 = 基线档——完美感知参照） */
  noise?: GymNoiseSpec;
}

/** 曲线上的一个点：一档噪声 × 若干轮闭环的成功率 / 平均步数 */
export interface GymNoiseSweepPoint {
  /** 档位名（与 levels 同序） */
  label: string;
  /** 本档实跑轮数（预算截断时可能小于 roundsPerLevel） */
  rounds: number;
  /** 成功轮数 */
  successes: number;
  /** 成功率 = successes / rounds（0 轮 ⇒ 0；四位小数网格防浮点尾噪） */
  successRate: number;
  /** 平均步数（含失败轮；0 轮 ⇒ 0；两位小数） */
  avgSteps: number;
  /** 本档噪声谱规范形回声（基线档 ⇒ null——曲线证据的可复核面） */
  noise: GymNoiseResolved | null;
}

/** noiseSweep 总汇报：逐档曲线点 + 预算账 + 一句中文总结 */
export interface GymNoiseSweepResult {
  /** 逐档曲线点（与 levels 同序；预算耗尽处截断） */
  points: GymNoiseSweepPoint[];
  /** 全程实跑轮数（≤ 预算上限） */
  roundsRun: number;
  /** 预算账：cap = 上限轮数；truncated = 有档因预算未足额跑 */
  budget: { cap: number; truncated: boolean };
  /** 一句中文总结（确定性：只由档数、轮数与成功率推导） */
  summary: string;
}

/** noiseSweep 选项（全部可缺席；离线、有预算上限） */
export interface GymNoiseSweepOptions {
  /** 世界种类（task 缺席时铸基线任务用；缺省 'wizard'） */
  kind?: GymWorldKind;
  /** 显式基线任务（在场则 kind/difficulty/seed 全以此为准） */
  task?: GymTask;
  /** 噪声档序列（按序成曲线；缺省/非数组 ⇒ 空曲线） */
  levels?: GymNoiseLevel[];
  /** 每档轮数（缺省 3；夹 [1,64]） */
  roundsPerLevel?: number;
  /** 主种子（任务种子与各轮噪声种子之源；缺省 4242——与训练营缺省同源） */
  seed?: number;
  /** 每轮步数上限（缺省 12 = 训练营缺省） */
  maxSteps?: number;
  /** 总轮数预算上限（缺省 48；夹 [1,4096]） */
  maxTotalRounds?: number;
}

/** W1-4：noiseSweep 缺省值（与训练营既有缺省同源同义） */
const SWEEP_DEFAULT_SEED = 4242;
const SWEEP_DEFAULT_ROUNDS_PER_LEVEL = 3;
const SWEEP_DEFAULT_MAX_ROUNDS = 48;

/**
 * W1-4 noiseSweep：病态感知诊所的鲁棒性曲线函数——给定世界×任务×噪声档序列，
 * 逐档跑真实器官闭环（AutonomyGym.runTasks 观察式评估：不喂进化引擎），返回
 * 「噪声档 → 成功率 / 平均步数」结构化结果。设计律：
 *   · 确定性：主种子钉死任务种子与每轮噪声种子（fnv1a 派生，档序×轮序唯一）
 *     ⇒ 同 opts 重放逐字段一致；各轮噪声种子互异 ⇒ 成功率是对噪声抽样的测量，
 *     不是同一轮的复读；
 *   · 预算上限：maxTotalRounds 封顶总轮数，耗尽处截断（truncated=true，后续档
 *     不再入曲线）；每档一轮都不剩时整档省略；
 *   · 零漂移基线：noise 缺席的档 = 完美感知参照（任务原样直通）；
 *   · 防弹：垃圾输入收敛为空曲线/截断，绝不抛异常。
 * 用途：「完美感知下校准、噪声下退化」的可测量证据——固定策略在递增噪声档上
 * 的成功率单调性即诊所的分辨力。
 */
export async function noiseSweep(opts: GymNoiseSweepOptions = {}): Promise<GymNoiseSweepResult> {
  const o = opts && typeof opts === 'object' ? opts : ({} as GymNoiseSweepOptions);
  const seedNum = Number(o.seed);
  const master = Number.isFinite(seedNum) ? Math.floor(seedNum) : SWEEP_DEFAULT_SEED;
  const msNum = Number(o.maxSteps);
  const maxSteps = Number.isFinite(msNum) && msNum >= 1 ? Math.floor(msNum) : DEFAULT_MAX_STEPS;
  const rplNum = Number(o.roundsPerLevel);
  const roundsPerLevel = Number.isFinite(rplNum) && rplNum >= 1 ? Math.min(64, Math.floor(rplNum)) : SWEEP_DEFAULT_ROUNDS_PER_LEVEL;
  const capNum = Number(o.maxTotalRounds);
  const cap = Number.isFinite(capNum) && capNum >= 1 ? Math.min(4096, Math.floor(capNum)) : SWEEP_DEFAULT_MAX_ROUNDS;

  // 基线任务：显式 task 优先；否则按世界种类铸 difficulty 1 任务（castTask 同律）
  const explicitTask =
    o.task !== null && typeof o.task === 'object' ? (o.task as Partial<GymTask>) : null;
  const kind: GymWorldKind =
    explicitTask?.kind === 'wizard' ||
    explicitTask?.kind === 'popup-maze' ||
    explicitTask?.kind === 'scroll-hunt' ||
    explicitTask?.kind === 'danger-gate'
      ? explicitTask.kind
      : typeof o.kind === 'string' &&
          (KIND_ORDER as readonly string[]).includes(o.kind)
        ? (o.kind as GymWorldKind)
        : 'wizard';
  const baseTask: GymTask = explicitTask
    ? (explicitTask as GymTask)
    : castTask(0, kind, mulberry32(fnv1a(`w1-4:sweep:task:${master}`)));

  const rawLevels = Array.isArray(o.levels) ? o.levels : [];
  const points: GymNoiseSweepPoint[] = [];
  let roundsRun = 0;
  let truncated = false;

  try {
    for (let i = 0; i < rawLevels.length; i++) {
      const raw = rawLevels[i];
      const entry =
        raw !== null && typeof raw === 'object' ? (raw as Partial<GymNoiseLevel>) : {};
      const label =
        typeof entry.label === 'string' && entry.label.trim() !== '' ? entry.label : `L${i}`;
      const levelNoise =
        entry.noise !== null && typeof entry.noise === 'object' ? (entry.noise as GymNoiseSpec) : null;
      const rounds = Math.min(roundsPerLevel, cap - roundsRun);
      if (rounds <= 0) {
        truncated = true; // 预算耗尽：本档一轮不剩，整档省略
        break;
      }
      if (rounds < roundsPerLevel) truncated = true;
      // 逐轮任务：噪声种子按「主种子×档序×轮序」fnv1a 派生——同 opts 同种子流，
      // 各轮互异（成功率 = 对噪声抽样的统计，非同轮复读）
      const tasks: GymTask[] = [];
      for (let j = 0; j < rounds; j++) {
        const noiseSeed = fnv1a(`w1-4:sweep:${master}:${i}:${j}`) % 0x7fffffff;
        tasks.push(
          levelNoise
            ? ({ ...baseTask, noise: { ...levelNoise, seed: noiseSeed } } as GymTask)
            : baseTask,
        );
      }
      const gym = new AutonomyGym({ seed: master, maxSteps });
      const results = await gym.runTasks(tasks);
      const successes = results.filter(r => r.success === true).length;
      const avgSteps =
        results.length > 0
          ? r2(results.reduce((s, r) => s + (Number.isFinite(r.steps) ? r.steps : 0), 0) / results.length)
          : 0;
      points.push({
        label,
        rounds: results.length,
        successes,
        successRate: results.length > 0 ? Math.round((successes / results.length) * 1e4) / 1e4 : 0,
        avgSteps,
        noise: levelNoise ? resolveGymNoise(levelNoise) : null,
      });
      roundsRun += results.length;
    }
  } catch {
    /* 防弹承诺：漏网异常不炸诊所——已测成的点照常入曲线 */
  }

  const curve = points.map(p => `${p.label}:${Math.round(p.successRate * 100)}%`).join('→');
  const summary =
    points.length > 0
      ? `病态诊所扫频${points.length}档${roundsRun}轮：成功率曲线 ${curve}（预算${roundsRun}/${cap}${truncated ? '，截断' : ''}）——完美感知校准，噪声下退化可测。`
      : `病态诊所扫频0档0轮（预算${roundsRun}/${cap}）——无噪声档可测。`;
  return { points, roundsRun, budget: { cap, truncated }, summary };
}
