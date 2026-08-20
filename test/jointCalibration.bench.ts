// test/jointCalibration.bench.ts
// 联合标定基准 —— 把「缺省可行」推进到「缺省有价」的四步路径：
//   ① 成本模型   三类事件定价格：L3 轮（贵眼睛）/ 陷阱点击（学费+风险）/
//                接地失败（人工接手的机会成本）+ 普通执行（单位成本）。
//   ② 损失函数   价格 × 事件计数 = 标量损失。平坦的可行区间在「世界族」上
//                变成有梯度的损失面 —— 单一确定性世界里行为恒等的参数，
//                在分布上分化（误告世界罚低阈值、忏悔世界罚高步长……）。
//   ③ 联合标定   坐标下降（一维扫值 × 逐参数推进 × 两遍收敛），损失为
//                目标、七权威场景（可行性门）为约束 —— 最优解必须既便宜
//                又不翻红。
//   ④ 真机复测   缺省 vs 标定向量在真实感知噪声分布（Xvfb+OCR+xdotool）
//                下的损失对照 —— 分布偏移下的稳健性，不是优化信号。
//
// 诚实边界（与 calibration.bench 同一立场）：
//   · 价格比率是假设 —— 用四种价格机制（balanced / trap-heavy / l3-heavy /
//     fail-heavy）做敏感性：跨机制稳定的移动 = 数据结论；随机制漂移的移动 =
//     价格假设的投影，已如实标注。fail-heavy 定价人工接手（误告/接地的
//     机会成本）—— 误告经济学的枢轴价格。
//   · L3 计费的收益（升 L3 救回一局）在本包络无世界可表达 —— 计费按纯
//     成本入账，bits 阈值的「最优」= 可行性门边界，由 12.5% 教义定标。
//   · DISCONFIRM_DECAY 不入联合扫值：包络内自体反证路径全部陷入免疫
//     死锁（压制 ⇒ 不执行 ⇒ 永不复证）—— 其校准停留在契约级（S6），
//     这是结构发现，不是遗漏。
//
// v2 扩族复测（回应 v1 报告第 9 节决策点「误告代价族内被低估」）：
//   · D 组误告世界补全置信度均匀网格 {0.40..0.65}（与 A2-A4 合成 6 点，
//     每点一世界）—— v1 只有 3 个误告世界，且无一落在 0.4-0.5 判别带。
//   · faWeight ∈ {1,2,4,8}：误告任务频率先验 —— v1 的「占比低估」批评
//     的定量复测（w=1 平权扩族；w↑ = 误告任务更频繁的世界分布）。
//   · 双序坐标下降（REFLEX 先动 / 反序）：v1 披露的替代盆地
//     (0.5, W=4) vs (0.4, W=2) 是顺序敏感 —— 两序都跑，取优，消除顺序伪影。
//   · 误告率/漏报率：从世界族实测（误告世界 verdict=failed ⟺ 冤枉；
//     陷阱记忆世界 trap>0 ⟺ 漏报）—— 阈值的 ROC 两个面。
//
// v3 长期扩族（时间维度 —— 世界族此前只有「空间」分布，无「时间」分布）：
//   · E 组长期世界：E1 十天学费曲线（学习速度的长期积分）、E2 遗忘复发
//     （学 → 45 天间隔 → 复发再学 —— 遗忘曲线半衰期 30 天的经济学）、
//     E3 长期忏悔（陷阱修好后 7 天：低阈值免疫死锁 fail×5 vs 高阈值
//     反证复活 success×5）、E4 多陷阱走廊（双陷阱记忆并行强化 6 天）。
//   · 时间旅行机制（staleAfterDay）：多天世界跑完第 N 天后，把持久化
//     knowledge.json 的 updatedAt 退回 M 天 —— 与 knowledge.test 免疫 #1
//     的 snapshot 后门同一精神，作用于文件级（「隔了 M 天再回来」的表达）。
//   · 长期维度的经济学预测：E3 是 fail 价格的新大头（死锁 5 天 vs 复活
//     5 天 ⇒ fail-heavy 下低阈值被罚 ~100 单位）；E2 是遗忘的隐性学费
//     （复发 = 比初学多 1 次踩坑）；E1/E4 是步长的学费积分曲线。
//
// v4 核证接地纪元（信任门控的接地前探针 —— 误告/漏报/死锁的三联解药）：
//   · 机制：压制 + 前额叶无活路（接地终局前），压制证据族（error-pattern）
//     最高信任 < VERIFY_TRUST_FLOOR（θ）⇒ 放行被压制的本能弧执行一针探针
//     （一 run 一针，闩锁执法）。传闻（trust 0）/ 陈年亲证（衰减过线）
//     不许干瞪眼接地 —— 必须交一针学费换亲证；新鲜亲证自背书零学费。
//   · F 组核证世界：F1 陈年忏悔（60 天前亲证 → 探针学费 → 时间旅行 60 天
//     → 复活探针破局 —— 死锁的时间出口）、F2 新鲜亲证（自背书零学费
//     —— 罚高 θ）。D 组补 D4 新鲜亲证误告（窗口期冤枉 —— 免疫的诚实
//     上界，θ 无解，解药是时间）/ D5 陈年亲证误告（探针解药 —— 时间的
//     复活通道同样适用于误告）。
//   · θ 入联合扫值（SWEPT 第 7 参数）：低 θ 罚误告+死锁（传闻/陈年自背书
//     ⇒ 冤枉无解药、死锁无出口），高 θ 罚学费（新鲜亲证也探针 ⇒ F2/E1
//     每次多付一针）。θ 与 t（压制阈值）解耦：t 决定「是否压制」，θ 决定
//     「压制证据是否可信到不许验证」—— Test 3 断言其正交性。
//   · 四指标（v3 的损失/误告/漏报 + v4 的死锁）：误告率 = fa 世界 failed 比
//     （传闻误告被探针解药 ⇒ v3 50% → v4 12.5%，唯一幸存 = D4 新鲜亲证
//     窗口期）；漏报率 = trapMemo 世界非探针踩坑比（一针核证学费 ≠ 漏报
//     —— 知情学费与压制失效的语义分离）；死锁率 = 忏悔世界陷阱修好后
//     仍 failed 的天数比（F1 把「永远死锁」变成「窗口期死锁 + 时间出口」）。
//   · 时间旅行机制扩展（ageKnowledge）：verifiedAt 与 updatedAt 同退 ——
//     亲证时钟的「隔了 N 天再回来」（E2 断言不受影响：其记忆不压制 ⇒
//     信任门控无消费者 ⇒ 时间不变性结构发现继续成立）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgePipelineOrchestrator } from '../src/knowledge/pipeline.ts';
import { InMemoryKnowledgeBase } from '../src/knowledge/knowledgeBase.ts';
import { InMemoryWorldModel } from '../src/knowledge/worldModel.ts';
import { ReflexiveDecisionStation } from '../src/knowledge/stations.ts';
import { DoctorVerdictBridge } from '../src/knowledge/adapters.ts';
import { setParam, resetParams, P, type ParamName } from '../src/knowledge/params.ts';
import type {
  AtomicAction, ExecutionOutcome, PipelineConfig, PipelineReport, ScenePatch,
} from '../src/knowledge/contracts.ts';

// ─── ① 成本模型 ───

/** 四类事件的价格（成本单位）。L3 轮 = VLM 感知（数量级贵于点击）；
 *  陷阱 = 烧掉的重试 + 损坏风险；失败 = 人工接手的机会成本；执行 = 单位。 */
interface Prices { exec: number; trap: number; fail: number; l3: number }

const REGIMES: Array<{ name: string; prices: Prices; note: string }> = [
  { name: 'balanced', prices: { exec: 1, trap: 6, fail: 3, l3: 10 }, note: '基准比率' },
  { name: 'trap-heavy', prices: { exec: 1, trap: 15, fail: 3, l3: 10 }, note: '损坏主导域（陷阱代价↑2.5×）' },
  { name: 'l3-heavy', prices: { exec: 1, trap: 6, fail: 3, l3: 30 }, note: 'VLM 主导域（贵眼睛代价↑3×）' },
  { name: 'fail-heavy', prices: { exec: 1, trap: 6, fail: 20, l3: 10 }, note: '人工接手主导域（误告/接地代价↑~7×）' },
];

/** 事件计数（与价格无关的物理事实 —— 价格机制只重定价，不重跑） */
interface Events { exec: number; trap: number; fail: number; l3Pipeline: number; l3MeterBills: number }

function lossOf(e: Events, p: Prices): number {
  return e.exec * p.exec + e.trap * p.trap + e.fail * p.fail
    + (e.l3Pipeline + e.l3MeterBills) * p.l3;
}

// ─── 世界族（任务分布 —— 单确定性世界的替代物）───
//
// 每个世界是一个确定性场景；分布 = 世界的结构化集合。关键分布维度：
//   误告（error-pattern 在场但陷阱其实是好的 —— 罚低压制阈值）
//   忏悔（陷阱中途修好 —— 罚高学习步长造成的免疫死锁）
//   竞争陷阱（decoy 'delete entry' 与 intent 字面重合 —— 罚低证据权重）
//   自体证据（workflow 靠经历铸造 —— 罚低成功置信度）

interface WorldDef {
  name: string;
  group: string;
  /** 误告世界（error-pattern 在场但按钮其实是好的）—— 误告率分母；权重 = faWeight */
  fa?: boolean;
  /** 陷阱记忆世界（种子 error-pattern 且陷阱真坏）—— 漏报率分母 */
  trapMemo?: boolean;
  /** 元素（w=0.2 h=0.1 标准矩形；name 即裁决键） */
  elements: Array<{ name: string; x: number; y: number }>;
  /** 世界真相：点击必失败的元素（忏悔世界可中途修复） */
  broken: string[];
  /** 每日意图（长度 = 天数；多天世界走持久化 stateDir —— 学习跨会话） */
  intents: string[];
  /** 种子知识（仅 Day1 注入；manual 通道永不被自体学习改写）。
   *  v4 核证维度：trapVerifiedDaysAgo 缺席 = 传闻（trust 0 —— 他人转述）；
   *  在场 = 亲证（trust = conf × 衰减 —— 0 天前 = 新鲜满格，60 天前 ≈ ×0.25）。
   *  trapSource 缺席 = manual；显式 auto-learn = 自体学习铸造身份。 */
  seeds?: {
    trapConf?: number;
    trapVerifiedDaysAgo?: number;
    trapSource?: 'manual' | 'auto-learn';
    workflow?: boolean;
  };
  trapFineFromDay?: number;
  /** 时间旅行（v3 长期维度）：跑完第 N 天后，把持久化记忆的 updatedAt
   *  退回 M 天 —— 「隔了 M 天再回来」的文件级表达（遗忘曲线的测试入口）。 */
  staleAfterDay?: Record<number, number>;
  retries: number;
  note: string;
}

const TRAP = { name: 'delete item', x: 0.30, y: 0.30 };
const DECOY = { name: 'delete entry', x: 0.30, y: 0.55 }; // 竞争陷阱：与 intent 共享 'delete'
const SAFE = { name: 'clear log', x: 0.65, y: 0.65 };

const FAMILY: WorldDef[] = [
  // ── A 免疫阈值经济学（单路径：压制 or 直扑，无第三选择）──
  { name: 'A1 真陷阱·种子0.55', group: 'immune', trapMemo: true, elements: [TRAP], broken: ['delete item'],
    intents: ['delete the record'], seeds: { trapConf: 0.55 }, retries: 2,
    note: '真陷阱：压制=接地失败(3)，不压制=3次踩坑+失败(6+3+3)' },
  { name: 'A2 误告·0.55', group: 'immune', fa: true, elements: [TRAP], broken: [],
    intents: ['delete the record'], seeds: { trapConf: 0.55 }, retries: 2,
    note: '陷阱其实是好的：压制=冤枉好人(失败)，不压制=一次成功(0)' },
  { name: 'A3 误告·0.45', group: 'immune', fa: true, elements: [TRAP], broken: [],
    intents: ['delete the record'], seeds: { trapConf: 0.45 }, retries: 2,
    note: '弱误告：阈值≤0.45 冤枉，≥0.5 放行 —— 0.4 vs 0.5 的判别点之一' },
  { name: 'A4 误告·0.50', group: 'immune', fa: true, elements: [TRAP], broken: [],
    intents: ['delete the record'], seeds: { trapConf: 0.50 }, retries: 2,
    note: '边界误告：阈值0.5 冤枉（≥含等号），0.55 放行 —— 旧缺省0.5在此破财，新缺省0.55在此平反' },
  { name: 'A5 死磕陷阱', group: 'learning', elements: [TRAP], broken: ['delete item'],
    intents: ['delete the record', 'delete the record', 'delete the record', 'delete the record'],
    retries: 0, note: '零重试4天：步长小 ⇒ 第3天仍在踩坑（学费按天计）' },
  { name: 'A6 忏悔之门', group: 'learning', elements: [TRAP], broken: ['delete item'],
    intents: ['delete the record', 'delete the record', 'delete the record', 'delete the record'],
    trapFineFromDay: 3, retries: 0,
    note: '陷阱Day3修好：步长大 ⇒ 置信度冲过阈值 ⇒ 压制死锁（永远不敢再点）；步长小 ⇒ Day3放行 ⇒ 成功+反证' },
  // ── B 前额叶证据经济学（三路径：陷阱 + 竞争陷阱 + 活路）──
  { name: 'B1 全证据裁决', group: 'prefrontal', trapMemo: true, elements: [TRAP, DECOY, SAFE], broken: ['delete item', 'delete entry'],
    intents: ['delete the record'], seeds: { trapConf: 0.55, workflow: true }, retries: 2,
    note: 'decoy 字面胜出（+delete）；workflow 证据必须托举活路压过它 —— 权重/地板梯度' },
  { name: 'B2 自体workflow', group: 'prefrontal', elements: [TRAP, DECOY, SAFE], broken: ['delete item', 'delete entry'],
    intents: ['clear the log', 'delete the record'], retries: 2,
    note: 'Day1 成功铸造 workflow@AUTO_LEARN；Day2 靠它对抗 decoy —— 成功置信度梯度' },
  { name: 'B3 弱陷阱嫌疑', group: 'prefrontal', trapMemo: true, elements: [TRAP, DECOY, SAFE], broken: ['delete item', 'delete entry'],
    intents: ['delete the record'], seeds: { trapConf: 0.4, workflow: true }, retries: 2,
    note: '陷阱证据 0.4 < 压制线 ⇒ 无否决，只有嫌疑折扣 —— 地板决定证据是否入局' },
  { name: 'B4 干净意图', group: 'prefrontal', trapMemo: true, elements: [TRAP, DECOY, SAFE], broken: ['delete item', 'delete entry'],
    intents: ['erase the record'], seeds: { trapConf: 0.55, workflow: true }, retries: 2,
    note: '零字面重合 ⇒ 纯语义改道（S1/S4 同构 —— 回归守卫）' },
  // ── C 学习闭环（旗舰回归）──
  { name: 'C1 完整学习曲线', group: 'learning', elements: [TRAP, SAFE], broken: ['delete item'],
    intents: ['delete the record', 'clear the log', 'delete the record'], retries: 2,
    note: 'E3 同构：Day1 踩坑/活路 → Day3 旧脑改道（学习闭环回归守卫）' },
  // ── D 误告网格（v2 扩族；v4 核证纪元重注）──
  //  v2 扩族批评：「误告世界占比被低估」且 3 个误告世界无一落在 0.4-0.5
  //  判别带 —— D1 补 0.40 判别点，D2/D3 补 >0.55 恒误告质量。
  //  v4 行为面巨变：D1-D3/A2-A4 的传闻种子（manual 无亲证）trust=0 < θ ⇒
  //  压制终局前放行一针探针 ⇒ 点击好按钮成功 ⇒ completed —— 传闻误告的
  //  全量解药（v3 faRate 50% 的主体在此蒸发）。D4/D5 补亲证误告维度：
  //  新鲜亲证 = 窗口期冤枉（免疫的诚实上界 —— 刚验证过的错误记忆，θ 的
  //  整个可行区间都救不了，解药是时间衰减）；陈年亲证 = 探针解药（复活
  //  通道对误告同样生效 —— 冤枉好人的记忆也会过期）。
  { name: 'D1 误告·传闻0.40', group: 'false-alarm', fa: true, elements: [TRAP], broken: [],
    intents: ['delete the record'], seeds: { trapConf: 0.40 }, retries: 2,
    note: 'v4：传闻 trust 0 < θ ⇒ 探针解药（completed）—— 0.4 判别点被信任门控接管' },
  { name: 'D2 误告·传闻0.60', group: 'false-alarm', fa: true, elements: [TRAP], broken: [],
    intents: ['delete the record'], seeds: { trapConf: 0.60 }, retries: 2,
    note: 'v4：强传闻误告同被探针解药 —— 高置信传闻不再是无防线路径' },
  { name: 'D3 误告·传闻0.65', group: 'false-alarm', fa: true, elements: [TRAP], broken: [],
    intents: ['delete the record'], seeds: { trapConf: 0.65 }, retries: 2,
    note: 'v4：极强传闻误告同上 —— 信任门控不看置信度看亲证（θ 的分工）' },
  { name: 'D4 误告·亲证0.66', group: 'false-alarm', fa: true, elements: [TRAP], broken: [],
    intents: ['delete the record'], retries: 2,
    seeds: { trapConf: 0.66, trapVerifiedDaysAgo: 0, trapSource: 'auto-learn' },
    note: '新鲜亲证误告：trust 0.66 ≥ θ（全可行区间）⇒ 自背书诚实接地 ⇒ 冤枉 fail —— 免疫的诚实上界（刚验证过的错误记忆窗口期无防线，θ 无解，解药是时间）' },
  { name: 'D5 误告·陈年亲证', group: 'false-alarm', fa: true, elements: [TRAP], broken: [],
    intents: ['delete the record'], retries: 2,
    seeds: { trapConf: 0.66, trapVerifiedDaysAgo: 60, trapSource: 'auto-learn' },
    note: '陈年亲证误告：trust 0.165 < θ ⇒ 探针点击好按钮成功 ⇒ completed —— 复活通道对误告同样生效（冤枉好人的记忆也会过期）' },
  // ── E 长期世界（v3 扩族：时间维度 —— 学费积分 / 遗忘复发 / 死锁长跑 / 多陷阱走廊）──
  //  半衰期 30 天：45 天 ≈ ×0.354，60 天 ≈ ×0.25。学习动力学：失败初铸 0.3，
  //  每次失败复证 +0.7×step（0.3→0.51→0.66…），压制线 = REFLEX_SUPPRESS_CONFIDENCE。
  //  注意：E 组无种子记忆（学费是初学成本，不是漏报）—— 不标 trapMemo，
  //  漏报率分母保持「种子记忆在场」的语义纯净。
  { name: 'E1 十天学费曲线', group: 'long-horizon', elements: [TRAP, SAFE], broken: ['delete item'],
    intents: Array.from({ length: 10 }, () => 'delete the record'), retries: 0,
    note: '学费 → 死压制的长跑：Day1-2 学费（0.3→0.51）→ Day3 起压制但 SAFE 无 workflow 证据可托举（从未被成功点过）⇒ 诚实接地 fail×8 —— 「知道哪错但从没学过别的路」的长期成本，E4 是它的解药对照组' },
  { name: 'E2 时间不变性·45天', group: 'long-horizon', elements: [TRAP, SAFE], broken: ['delete item'],
    intents: ['delete the record', 'delete the record', 'delete the record', 'delete the record'],
    staleAfterDay: { 2: 45 }, retries: 0,
    note: '结构发现暴露位：45 天老化（eff 0.51→0.18）后行为与 A5 逐天一致 —— 遗忘曲线在决策路径无消费者（压制读原始 confidence；minConfidence 未被决策查询传递恒 0；排序以 hybridScore 为主）。时间维度在包络内不可经济化，Test 3 断言此不变性' },
  { name: 'E3 长期忏悔', group: 'long-horizon', elements: [TRAP, SAFE], broken: ['delete item'],
    intents: Array.from({ length: 7 }, () => 'delete the record'),
    trapFineFromDay: 3, retries: 0,
    note: '陷阱 Day3 修好 + 5 天长跑：阈值≤已学记忆（0.51）⇒ 死锁 fail×5；阈值>0.51 ⇒ Day3 放行成功 ⇒ 反证复活 success×5 —— fail 价格的新大头' },
  { name: 'E4 多陷阱走廊', group: 'long-horizon', elements: [TRAP, DECOY, SAFE], broken: ['delete item', 'delete entry'],
    intents: ['clear the log', ...Array.from({ length: 5 }, () => 'delete the record')], retries: 0,
    note: '先学活路（Day1 SAFE 成功铸 workflow 0.6）→ 再闯双陷阱走廊（Day2-5 学费×2 并行强化）→ 改道稳态 —— 多陷阱共存下的学费与破局' },
  // ── F 核证世界（v4 扩族：信任门控的接地前探针 —— 死锁出口与零学费背书）──
  //  信任 = 置信度 × 亲证衰减（半衰期 30 天）：60 天 ≈ ×0.25。
  //  F1 是「死锁的时间出口」证词：v3 的免疫死锁（压制 ⇒ 不执行 ⇒ 永不复证）
  //  在核证纪元有了出口 —— 亲证会过期，过期 ⇒ 复活探针 ⇒ 世界变化被感知。
  { name: 'F1 陈年忏悔之门', group: 'nuclear-grounding', elements: [TRAP], broken: ['delete item'],
    intents: ['delete the record', 'delete the record', 'delete the record'],
    trapFineFromDay: 3, staleAfterDay: { 2: 60 }, retries: 2,
    seeds: { trapConf: 0.66, trapVerifiedDaysAgo: 60, trapSource: 'auto-learn' },
    note: '60 天前亲证（trust 0.165 < θ=0.2）：Day1 压制+无活路 ⇒ 复活探针踩坑 ⇒ 学费铸新鲜亲证（新铸条目 0.3 —— auto-learn 文案与种子不同，不复证种子）⇒ Day2 保鲜期内自背书诚实接地（窗口期死锁，刚验证过，合理）⇒ Day2 后时间旅行 60 天 ⇒ Day3 trust 0.075 < θ ⇒ 复活探针 ⇒ 陷阱已修好 ⇒ completed 破局 —— 死锁率从「永远」（v3）变「窗口期」（v4）。θ=0.3 旧缺省在此翻红：新铸 0.3 × 衰减(毫秒) 恒微小于 0.3，初铸亲证永不安宁 ⇒ 采纳联合标定归宿 θ=0.2（conf 0.3 有 17.5 天保鲜期）' },
  { name: 'F2 新鲜亲证零学费', group: 'nuclear-grounding', trapMemo: true, elements: [TRAP], broken: ['delete item'],
    intents: ['delete the record'], retries: 2,
    seeds: { trapConf: 0.66, trapVerifiedDaysAgo: 0, trapSource: 'auto-learn' },
    note: '新鲜亲证（trust 0.66 ≥ θ）⇒ 自背书诚实接地 ⇒ failed + 0 陷阱 + 0 探针 —— 罚高 θ（θ>0.66 ⇒ 每次多付一针学费，且不可行区间 E7 已定界）' },
];

// ─── 时间旅行（v3 长期维度；v4 扩 verifiedAt）───

/** 把 stateDir 内知识条目的 updatedAt / verifiedAt 退回 days 天（文件级 ——
 *  与 knowledge.test 免疫 #1 的 snapshot 后门同一精神）。多天世界的
 *  「隔了 N 天再回来」由此表达：跑完第 M 天 → 记忆退回 N 天 → 下一天
 *  水合时遗忘曲线与亲证衰减都已生效。v4：亲证时钟（verifiedAt）同退 ——
 *  信任门控的时间消费者由此可测（陈年亲证 ⇒ 复活探针）。 */
function ageKnowledge(stateDir: string, days: number): void {
  const file = join(stateDir, 'knowledge.json');
  if (!existsSync(file)) return; // 无记忆可老化（学习未发生）
  try {
    const snap = JSON.parse(readFileSync(file, 'utf8')) as { entries?: Array<{ updatedAt?: number; verifiedAt?: number }> };
    if (!Array.isArray(snap.entries)) return;
    const back = days * 24 * 60 * 60 * 1000;
    for (const e of snap.entries) {
      if (typeof e.updatedAt === 'number') e.updatedAt -= back;
      if (typeof e.verifiedAt === 'number') e.verifiedAt -= back;
    }
    writeFileSync(file, JSON.stringify(snap), 'utf8');
  } catch { /* 损坏文件 = 空脑语义（与 persistence 降级一致）*/ }
}

// ─── 确定性世界执行 rig（消融基准同构）───

const BENCH_CONFIG: PipelineConfig = {
  timeout: { overall: 2000, perStep: 200, perPerception: 100 },
  retryPolicy: { maxRetries: 2, backoffMs: 1, maxBackoffMs: 2 },
  knowledgeTimeout: 50, knowledgeMaxResults: 5, knowledgeMaxChars: 300,
};

let runCounter = 0;

/** 跑世界的一天（station 在 setParam 之后构造 —— REFLEX_SUPPRESS 是构造时快照）。
 *  v4 返回 probes：核证探针计数（rationale 前缀识别 —— 探针是普通动作，
 *  审计标记是唯一痕迹；漏报语义由此分离：非探针踩坑 = 压制失效）。 */
async function runDay(
  world: WorldDef, day: number, stateDir: string | undefined,
): Promise<{ verdict: PipelineReport['verdict']; exec: number; trap: number; l3: number; probes: number }> {
  const elements = world.elements.map(e => ({ ...e, w: 0.2, h: 0.1 }));
  const scene: ScenePatch[] = [{
    region: { id: 'g0x0', x: 0, y: 0, width: 1, height: 1 },
    elements: elements.map(e => ({
      source: 'L1-tree' as const, role: 'button' as const, name: e.name,
      rect: { x: e.x, y: e.y, width: e.w, height: e.h },
    })),
    funnelDepth: 'L1' as const,
    capturedAt: 0,
  }];
  const trapFixed = world.trapFineFromDay !== undefined && day >= world.trapFineFromDay;
  const isBroken = (name: string) => world.broken.includes(name) && !trapFixed;

  const kb = new InMemoryKnowledgeBase();
  if (world.seeds && day === 1) {
    if (world.seeds.trapConf !== undefined) {
      kb.insert({
        category: 'error-pattern', content: 'delete item button is broken, clicks fail',
        scenario: 'record cleanup', confidence: world.seeds.trapConf,
        source: world.seeds.trapSource ?? 'manual',
        // 亲证透传：缺席 = 传闻（trust 0）；在场 = 亲证（随天数衰减）
        ...(world.seeds.trapVerifiedDaysAgo !== undefined
          ? { verifiedAt: Date.now() - world.seeds.trapVerifiedDaysAgo * 24 * 60 * 60 * 1000 }
          : {}),
      });
    }
    if (world.seeds.workflow) {
      kb.insert({ category: 'workflow', content: 'clear log after erasing records', scenario: 'record cleanup', confidence: 0.6, source: 'manual' });
    }
  }
  const probe = { exec: 0, trap: 0, l3: 0, probes: 0 };
  const rig = {
    vision: { async perceive(env: any) { if (env?.payload?.forceL3) probe.l3 += 1; return scene; } },
    execution: {
      async execute(env: any) {
        probe.exec += 1;
        const a = env.payload as AtomicAction;
        if (typeof a.rationale === 'string' && a.rationale.startsWith('probe(verified-grounding)')) probe.probes += 1;
        const hit = typeof a.args?.x === 'number' && typeof a.args?.y === 'number'
          ? elements.find(e => a.args.x >= e.x && a.args.x <= e.x + e.w && a.args.y >= e.y && a.args.y <= e.y + e.h)?.name ?? null
          : null;
        if (hit && isBroken(hit)) {
          probe.trap += 1;
          return { action: a, status: 'failure' as const, durationMs: 1, failure: { kind: 'host-error' as const, detail: `${hit} is broken` } };
        }
        return { action: a, status: 'success' as const, durationMs: 1 };
      },
    },
  };
  const o = new KnowledgePipelineOrchestrator();
  const cfg: PipelineConfig = world.retries === 2 ? BENCH_CONFIG
    : { ...BENCH_CONFIG, retryPolicy: { maxRetries: world.retries, backoffMs: 1, maxBackoffMs: 2 } };
  assert.ok(o.configure(cfg).ok);
  o.wire(
    {
      vision: rig.vision, decision: new ReflexiveDecisionStation({ chat: null }),
      execution: rig.execution, knowledge: kb, verdictBridge: new DoctorVerdictBridge(),
      emit: () => { /* 旁路 */ },
    },
    { stateDir },
  );
  const report = await o.run({ id: `jc-${++runCounter}`, description: world.intents[day - 1] });
  return { verdict: report.verdict, exec: probe.exec, trap: probe.trap, l3: probe.l3, probes: probe.probes };
}

// ─── L3 计量表轨道（WM 直驱 —— bits 通道的经济学）───
//
// 流水线静态世界里 bits 通道只有 t=0/t≥1 的二值差（novel 直通掩盖其余）；
// 稀有度环境的计费在计量表上结算：每环境 100 次转移，罕见转移按其稀有度
// 出现（100/rarity 次 × 罕见 bits≥阈值 ⇒ 计费；常见转移 bits≈0.07 静默）。
function l3MeterBills(threshold: number): number {
  let bills = 0;
  for (const rarity of [3, 10, 20]) {
    const w = new InMemoryWorldModel();
    for (let i = 0; i < rarity - 1; i++) w.observe('tA', 'click@11', 'tA', true);
    w.observe('tA', 'click@11', 'tB', true);
    const sr = w.surprise('tA', 'click@11', 'tB');
    if (sr.ok && (sr.value.novel || sr.value.bits >= threshold)) bills += 100 / rarity;
  }
  return Math.round(bills);
}

// ─── 可行性门（七权威场景 —— 与 paramAblation.bench 判据一字不改）───

function failedOutcome(topic: string): ExecutionOutcome {
  return {
    intent: { id: `i-${topic}`, description: topic },
    action: { kind: 'click_mouse', args: { x: 0.4, y: 0.35 }, rationale: 'jc' },
    result: { status: 'failure', durationMs: 1, failure: { kind: 'host-error', detail: 'trap' } },
    retryCount: 0,
  } as unknown as ExecutionOutcome;
}

function succeededOutcome(topic: string): ExecutionOutcome {
  return {
    intent: { id: `i-${topic}`, description: topic },
    action: { kind: 'click_mouse', args: { x: 0.75, y: 0.7 }, rationale: 'jc' },
    result: { status: 'success', durationMs: 1 },
    retryCount: 0,
  } as unknown as ExecutionOutcome;
}

/** 门槛解剖：七场景逐个判定（gateScenario 的细化版 —— 报告用） */
async function gateAnatomy(dir: string): Promise<Record<string, boolean>> {
  const SIMPLE: WorldDef = {
    name: 'gate', group: 'gate', elements: [TRAP, SAFE], broken: ['delete item'],
    intents: ['delete the record'], seeds: { trapConf: 0.55, workflow: true }, retries: 2, note: '',
  };
  const out: Record<string, boolean> = {};
  try {
    // S1 改道：种子在场 ⇒ completed + 0 陷阱 + 1 执行
    {
      const r = await runDay({ ...SIMPLE, name: 's1' }, 1, undefined);
      out.S1 = r.verdict === 'completed' && r.trap === 0 && r.exec === 1;
    }
    // S2 直扑：无种子 ⇒ failed + ≥3 陷阱
    {
      const r = await runDay({ ...SIMPLE, name: 's2', seeds: undefined }, 1, undefined);
      out.S2 = r.verdict === 'failed' && r.trap >= 3;
    }
    // S3 学习：Day1 踩坑/活路 → Day2 改道（持久化）
    {
      const d1 = await runDay({ ...SIMPLE, name: 's3', seeds: undefined }, 1, dir);
      const d1s = await runDay({ ...SIMPLE, name: 's3b', seeds: undefined, intents: ['clear the log'] }, 1, dir);
      const d2 = await runDay({ ...SIMPLE, name: 's3c', seeds: undefined }, 1, dir);
      out.S3 = d1.verdict === 'failed' && d1s.verdict === 'completed'
        && d2.verdict === 'completed' && d2.trap === 0 && d2.exec === 1;
    }
    // S4 静默：干净意图 ⇒ completed + l3=0
    {
      const r = await runDay({ ...SIMPLE, name: 's4', intents: ['erase the record'] }, 1, undefined);
      out.S4 = r.verdict === 'completed' && r.l3 === 0;
    }
    // S5 开火：新世界首遇 ⇒ failed + l3=1
    {
      const r = await runDay({ ...SIMPLE, name: 's5', seeds: undefined }, 1, undefined);
      out.S5 = r.verdict === 'failed' && r.l3 === 1;
    }
  } catch {
    out.S1 = out.S2 = out.S3 = out.S4 = out.S5 = false;
  }
  // S6 反证：契约 —— 严格下降且不归零（无世界依赖）
  {
    try {
      const kb = new InMemoryKnowledgeBase();
      kb.learnFromOutcome(failedOutcome('clear the log'));
      const q0 = kb.query({ sceneDescription: 's', intentDescription: 'clear the log' });
      const before = q0.ok ? (q0.value.entries.find(e => e.category === 'error-pattern')?.confidence ?? 0) : 0;
      kb.learnFromOutcome(succeededOutcome('clear the log'));
      const q = kb.query({ sceneDescription: 's', intentDescription: 'clear the log' });
      const err = q.ok ? q.value.entries.find(e => e.category === 'error-pattern') : undefined;
      out.S6 = !!err && err.confidence < before && err.confidence > 0;
    } catch { out.S6 = false; }
  }
  // S7 计费带：底噪静默 + 1/20 信号计费（无世界依赖）
  {
    try {
      const wN = new InMemoryWorldModel();
      for (let i = 0; i < 10; i++) wN.observe('tA', 'click@11', 'tA', false);
      const noise = wN.surprise('tA', 'click@11', 'tA');
      const wS = new InMemoryWorldModel();
      for (let i = 0; i < 19; i++) wS.observe('tA', 'click@11', 'tA', true);
      wS.observe('tA', 'click@11', 'tB', true);
      const signal = wS.surprise('tA', 'click@11', 'tB');
      const t = P.L3_ESCALATION_BITS;
      out.S7 = !!noise.ok && !!signal.ok
        && !(noise.value.novel || noise.value.bits >= t)
        && !!(signal.value.novel || signal.value.bits >= t);
    } catch { out.S7 = false; }
  }
  return out;
}

async function gateScenario(dir: string): Promise<boolean> {
  const a = await gateAnatomy(dir);
  return Object.values(a).every(v => v);
}

// ─── 评估器（参数向量 → 事件计数 + 可行性；带缓存）───

const SWEPT: ParamName[] = [
  'REFLEX_SUPPRESS_CONFIDENCE', 'DELIB_RELEVANCE_FLOOR', 'DELIB_WORKFLOW_WEIGHT',
  'AUTO_LEARN_SUCCESS_CONFIDENCE', 'REINFORCE_STEP', 'L3_ESCALATION_BITS',
  'VERIFY_TRUST_FLOOR', // v4 核证纪元：信任门控地板（θ）入联合扫值
];

type Vector = Record<ParamName, number>;

resetParams();
const DEFAULTS: Vector = {
  REFLEX_SUPPRESS_CONFIDENCE: P.REFLEX_SUPPRESS_CONFIDENCE,
  DELIB_RELEVANCE_FLOOR: P.DELIB_RELEVANCE_FLOOR,
  DELIB_WORKFLOW_WEIGHT: P.DELIB_WORKFLOW_WEIGHT,
  AUTO_LEARN_SUCCESS_CONFIDENCE: P.AUTO_LEARN_SUCCESS_CONFIDENCE,
  REINFORCE_STEP: P.REINFORCE_STEP,
  DISCONFIRM_DECAY: P.DISCONFIRM_DECAY, // 不入扫值（死锁结构发现 —— 见文件头）
  L3_ESCALATION_BITS: P.L3_ESCALATION_BITS,
  VERIFY_TRUST_FLOOR: P.VERIFY_TRUST_FLOOR,
};

const GRID: Record<string, number[]> = {
  // 0.3 预期不可行：首次踩坑学到的 0.3 记忆会在重试中途压制盲 agent（S2 直扑
  // 契约：无知识必须打满重试）—— 阈值的可行下界由契约定，不靠经济学。
  REFLEX_SUPPRESS_CONFIDENCE: [0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6],
  DELIB_RELEVANCE_FLOOR: [0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4],
  DELIB_WORKFLOW_WEIGHT: [0.5, 1, 1.5, 2, 3, 4, 6],
  AUTO_LEARN_SUCCESS_CONFIDENCE: [0.1, 0.3, 0.5, 0.6, 0.8, 1],
  REINFORCE_STEP: [0.2, 0.25, 0.3, 0.4, 0.5, 0.7],
  L3_ESCALATION_BITS: [1, 2, 3, 4],
  // θ（核证地板）：GRID 约束在校准登记区间 [0.2, 0.65]（calibration Part A
  // 实测，E5/E6/E7 定界）—— 入册资格 = 可行区间，联合标定只在可行域内竞价。
  // 实测教训（v4 首跑）：GRID 放进 0.1 时，cheap-fail 机制（balanced）把 θ
  // 压到 0.1 —— 深入出册区间，等于买回 E6 已否决的行为（陈年亲证 0.165 自
  // 背书 ⇒ F1 复活通道关闭、死锁率 0%→88%、误告率 13%→25%）—— 用可行域
  // 约束把 E6 契约（陈年复活探针必须触发）从「价格偏好」升格为「结构执法」。
  // 区间内梯度：0.65 罚学费（E1 学得记忆 trust ~0.64 < 0.65 ⇒ Day4 多一针
  // 探针）；0.2-0.55 行为平坦（F1/D5 的 trust 0.19/0.165 均低于全部候选值）。
  VERIFY_TRUST_FLOOR: [0.2, 0.25, 0.4, 0.55, 0.65],
};

/** 误告任务频率先验（v2 扩族扫描）：误告世界的事件计数 × faWeight。
 *  w=1 = 平权扩族（22 世界）；w↑ = 误告任务更频繁的分布。
 *  模块级可变 —— 各测试入口显式设置；进入缓存键防串档。 */
let faWeight = 1;

interface WorldOutcome { name: string; verdict: string; exec: number; trap: number; fail: number; l3: number; probes: number; weight: number; fa: boolean; trapMemo: boolean }

const evalCache = new Map<string, { events: Events; feasible: boolean; perWorld: WorldOutcome[] }>();

function vecKey(v: Vector): string {
  return `w${faWeight}|` + SWEPT.concat(['DISCONFIRM_DECAY']).map(k => `${k}=${v[k]}`).join('|');
}

async function evalVector(v: Vector): Promise<{ events: Events; feasible: boolean; perWorld: WorldOutcome[] }> {
  const key = vecKey(v);
  const hit = evalCache.get(key);
  if (hit) return hit;

  for (const k of Object.keys(v) as ParamName[]) setParam(k, v[k]);

  const perWorld: WorldOutcome[] = [];
  const events: Events = { exec: 0, trap: 0, fail: 0, l3Pipeline: 0, l3MeterBills: 0 };
  const root = mkdtempSync(join(tmpdir(), 'd7-jc-'));
  try {
    for (const w of FAMILY) {
      const weight = w.fa ? faWeight : 1; // 误告任务频率先验
      const dir = w.intents.length > 1 ? join(root, w.name) : undefined; // 多天世界才持久化
      for (let day = 1; day <= w.intents.length; day++) {
        const r = await runDay(w, day, dir);
        events.exec += r.exec * weight; events.trap += r.trap * weight; events.l3Pipeline += r.l3 * weight;
        const fail = r.verdict === 'completed' ? 0 : 1;
        events.fail += fail * weight;
        perWorld.push({ name: w.name, verdict: r.verdict, exec: r.exec, trap: r.trap, fail, l3: r.l3, probes: r.probes, weight, fa: !!w.fa, trapMemo: !!w.trapMemo });
        // 时间旅行：跑完该天后按需退回记忆时钟（遗忘+亲证双钟的「隔了 N 天」）
        if (dir && w.staleAfterDay?.[day] !== undefined) ageKnowledge(dir, w.staleAfterDay[day]);
      }
    }
    events.l3MeterBills = l3MeterBills(v.L3_ESCALATION_BITS);
    const feasible = await gateScenario(join(root, 'gate'));
    const result = { events, feasible, perWorld };
    evalCache.set(key, result);
    return result;
  } finally {
    resetParams();
    rmSync(root, { recursive: true, force: true });
  }
}

/** 误告率/漏报率（世界族实测；v4 语义精化）：
 *  误告率：误告世界 verdict=failed ⟺ 冤枉（v4 传闻误告被探针解药 ⇒
 *    幸存者只剩 D4 新鲜亲证窗口期）。
 *  漏报率：陷阱记忆世界**非探针**踩坑 ⟺ 压制失效 —— v3 的 trap>0 判据把
 *    「一针核证学费」（知情验证：探针放行、失败、亲证诞生）也计为漏报；
 *    v4 分离二者：探针踩坑 = 知情学费，非探针踩坑 = 压制没拦住（真漏报）。 */
function ratesOf(perWorld: WorldOutcome[]): { faRate: number; missRate: number; faFired: string[]; missed: string[] } {
  let faTotal = 0, faFiredW = 0, memoTotal = 0, missedW = 0;
  const faFired: string[] = [], missed: string[] = [];
  for (const w of perWorld) {
    if (w.fa) {
      faTotal += w.weight;
      if (w.verdict !== 'completed') { faFiredW += w.weight; faFired.push(w.name); }
    } else if (w.trapMemo) {
      memoTotal += w.weight;
      if (w.trap > w.probes) { missedW += w.weight; missed.push(w.name); }
    }
  }
  return {
    faRate: faTotal > 0 ? faFiredW / faTotal : 0,
    missRate: memoTotal > 0 ? missedW / memoTotal : 0,
    faFired, missed,
  };
}

/** 死锁率（v4 四指标之一）：忏悔世界（trapFineFromDay 在场）陷阱修好
 *  （day ≥ 修好日）后仍 verdict=failed 的天数比 —— 「本可完成的任务
 *  永远完不成」的量化。v3 的免疫死锁（压制 ⇒ 不执行 ⇒ 永不复证）在此
 *  有了时间出口：亲证过期 ⇒ 复活探针 ⇒ 世界变化被感知 ⇒ 破局。 */
function deadlockRateOf(perWorld: WorldOutcome[]): { deadlockRate: number; deadlocked: string[] } {
  let revivable = 0, deadlocked = 0;
  const locked: string[] = [];
  for (const w of FAMILY) {
    if (w.trapFineFromDay === undefined) continue;
    const days = perWorld.filter(p => p.name === w.name);
    for (let i = 0; i < days.length; i++) {
      if (i + 1 < w.trapFineFromDay) continue; // 修好前不计数
      revivable += days[i].weight;
      if (days[i].verdict !== 'completed') { deadlocked += days[i].weight; locked.push(`${w.name}#D${i + 1}`); }
    }
  }
  return { deadlockRate: revivable > 0 ? deadlocked / revivable : 0, deadlocked: locked };
}

/** 坐标下降：损失为目标（机制价格），七场景门为约束，两遍收敛。
 *  order：参数推进顺序 —— v1 揭示顺序敏感（先动 REFLEX 走「否决路径」盆地，
 *  先动 WEIGHT 走「托举路径」盆地），双序取优消除该伪影。 */
async function coordinateDescent(
  prices: Prices, order: ParamName[] = SWEPT,
): Promise<{ vec: Vector; loss: number; moves: string[]; evals: number; order: string }> {
  const vec: Vector = { ...DEFAULTS };
  let cur = await evalVector(vec);
  assert.ok(cur.feasible, '缺省向量必须可行（消亡则基准失守）');
  let loss = lossOf(cur.events, prices);
  const moves: string[] = [];
  let evals = 1;
  for (let pass = 0; pass < 2; pass++) {
    let moved = false;
    for (const name of order) {
      let bestVal = vec[name];
      let bestLoss = loss;
      for (const cand of GRID[name]) {
        if (cand === vec[name]) continue;
        const trial: Vector = { ...vec, [name]: cand };
        const r = await evalVector(trial);
        evals += 1;
        if (!r.feasible) continue; // 门槛外值不竞价（不可行 = 无价）
        const L = lossOf(r.events, prices);
        if (L < bestLoss - 1e-9) { bestLoss = L; bestVal = cand; }
      }
      if (bestVal !== vec[name]) {
        moves.push(`${name} ${vec[name]} → ${bestVal}`);
        vec[name] = bestVal;
        loss = bestLoss;
        moved = true;
      }
    }
    if (!moved) break;
  }
  const orderLabel = order[0] === SWEPT[0] ? 'REFLEX先动' : '反序';
  return { vec, loss, moves, evals, order: orderLabel };
}

/** 双序坐标下降取优：两序都跑，损失低者胜（平手取移动少者 —— 更贴近缺省） */
async function bestDescent(prices: Prices): Promise<{ vec: Vector; loss: number; moves: string[]; evals: number; order: string; both: Array<{ order: string; loss: number; moves: string[] }> }> {
  const runs = [
    await coordinateDescent(prices, SWEPT),
    await coordinateDescent(prices, [...SWEPT].reverse()),
  ];
  const best = runs.reduce((a, b) =>
    b.loss < a.loss - 1e-9 || (Math.abs(b.loss - a.loss) <= 1e-9 && b.moves.length < a.moves.length) ? b : a);
  return { ...best, both: runs.map(r => ({ order: r.order, loss: r.loss, moves: r.moves })) };
}

// ─── Test 1：成本模型 + 梯度存在性（平坦 → 有梯度）───

test('成本模型：缺省向量的账单 + 世界族上的一维景观（平坦变梯度）', async () => {
  const balanced = REGIMES[0].prices;
  const base = await evalVector(DEFAULTS);
  assert.ok(base.feasible, '缺省向量必须过七场景门');

  const lines: string[] = ['── ① 成本模型：缺省向量的账单（balanced: exec=1 trap=6 fail=3 l3=10）──'];
  lines.push(`总损失 L=${lossOf(base.events, balanced)}  exec=${base.events.exec} trap=${base.events.trap} fail=${base.events.fail} l3Pipeline=${base.events.l3Pipeline} l3Meter=${base.events.l3MeterBills}`);
  lines.push('── 世界逐条（事件 × 价格 = 分布上的账单结构；probe = 核证探针数）──');
  for (const w of base.perWorld) {
    const l = w.exec * balanced.exec + w.trap * balanced.trap + w.fail * balanced.fail + w.l3 * balanced.l3;
    lines.push(`${w.name.padEnd(14)} ${w.verdict.padEnd(9)} exec=${w.exec} trap=${w.trap} probe=${w.probes} fail=${w.fail} l3=${w.l3}  L=${l}`);
  }
  // 四指标基线（v4）：损失 + 误告/漏报/死锁 —— 缺省向量在 21 世界族上的形状
  {
    const { faRate, missRate, faFired, missed } = ratesOf(base.perWorld);
    const { deadlockRate, deadlocked } = deadlockRateOf(base.perWorld);
    lines.push('── 四指标基线（缺省向量；误告幸存者应为 D4 新鲜亲证窗口期）──');
    lines.push(`误告率=${(faRate * 100).toFixed(1)}%（${faFired.join(', ') || '无'}）  漏报率=${(missRate * 100).toFixed(1)}%（${missed.join(', ') || '无'}）  死锁率=${(deadlockRate * 100).toFixed(1)}%（${deadlocked.join(', ') || '无'}）`);
  }

  // 一维景观：单参数扫值（其余缺省）—— 报告梯度/平坦
  lines.push('── ② 一维损失景观（单参数扫值；损失随值变化 = 梯度存在）──');
  let gradientCount = 0;
  for (const name of SWEPT) {
    const points: string[] = [];
    const losses = new Set<number>();
    for (const v of GRID[name].concat([DEFAULTS[name]])) {
      const r = await evalVector({ ...DEFAULTS, [name]: v });
      const feasibleMark = r.feasible ? '' : '(不可行)';
      const L = r.feasible ? lossOf(r.events, balanced) : Number.POSITIVE_INFINITY;
      points.push(`${v}${feasibleMark}→${r.feasible ? L.toFixed(0) : '∅'}`);
      if (r.feasible) losses.add(L);
    }
    const hasGradient = losses.size > 1;
    if (hasGradient) gradientCount += 1;
    lines.push(`${name.padEnd(30)} ${[...new Set(points)].join('  ')}  ${hasGradient ? '梯度 ✓' : '平坦'}`);
  }
  console.log(lines.join('\n'));

  // 梯度存在性：世界族让至少 5/7 参数脱离平坦（θ 的梯度来自 F/D 组的
  // 学费-解药权衡 —— 低 θ 误告+死锁，高 θ 学费）
  assert.ok(gradientCount >= 5,
    `世界族仅让 ${gradientCount}/7 参数产生梯度 —— 分布不足以支撑联合标定，需扩族`);
  // θ 梯度存在性（v4 存在理由）：核证世界的学费-解药权衡必须产生经济学分化
  const thetaLosses = new Set<number>();
  for (const v of GRID.VERIFY_TRUST_FLOOR) {
    const r = await evalVector({ ...DEFAULTS, VERIFY_TRUST_FLOOR: v });
    if (r.feasible) thetaLosses.add(lossOf(r.events, balanced));
  }
  assert.ok(thetaLosses.size > 1,
    `θ 在世界族上损失恒定（${[...thetaLosses].join(',')}）—— F/D 组未让信任门控产生梯度`);
});

// ─── Test 2：联合标定（四价格机制 × 双序坐标下降，扩族后）───

test('联合标定：双序坐标下降 × 4 价格机制 —— 缺省 vs 标定的损失与四指标对照', async () => {
  faWeight = 1;
  const lines: string[] = ['── ③ 联合标定（扩族 22 世界平权；损失为目标，七场景门为约束，双序取优）──'];
  const calibrated: Array<{ regime: string; vec: Vector; loss: number; defLoss: number; moves: string[] }> = [];

  for (const regime of REGIMES) {
    const base = await evalVector(DEFAULTS);
    const defLoss = lossOf(base.events, regime.prices);
    const r = await bestDescent(regime.prices);
    const final = await evalVector(r.vec);
    assert.ok(final.feasible, `${regime.name} 标定结果必须可行`);
    const improved = r.loss <= defLoss + 1e-9;
    assert.ok(improved, `${regime.name}: 标定损失 ${r.loss} 必须不劣于缺省 ${defLoss}`);
    lines.push(`[${regime.name}] ${regime.note}: L(缺省)=${defLoss} → L(标定)=${r.loss}（${defLoss > 0 ? ((1 - r.loss / defLoss) * 100).toFixed(1) : 0}% 降幅；胜出序=${r.order}）`);
    lines.push(`  双序对照: ${r.both.map(b => `${b.order}→L=${b.loss}（${b.moves.length ? b.moves.join('; ') : '无移动'}）`).join('  ‖  ')}`);
    // 四指标对照（v4）：损失只是四个面之一 —— 标定不许以恶化三率为代价
    const bm = ratesOf(base.perWorld), bd = deadlockRateOf(base.perWorld);
    const cm = ratesOf(final.perWorld), cd = deadlockRateOf(final.perWorld);
    lines.push(`  四指标: 误告 ${(bm.faRate * 100).toFixed(0)}%→${(cm.faRate * 100).toFixed(0)}%  漏报 ${(bm.missRate * 100).toFixed(0)}%→${(cm.missRate * 100).toFixed(0)}%  死锁 ${(bd.deadlockRate * 100).toFixed(0)}%→${(cd.deadlockRate * 100).toFixed(0)}%`);
    calibrated.push({ regime: regime.name, vec: r.vec, loss: r.loss, defLoss, moves: r.moves });
  }

  // 跨机制稳定性：同一参数在不同价格机制下的归宿
  lines.push('── 跨机制稳定性（稳定 = 数据结论；漂移 = 价格假设的投影）──');
  for (const name of SWEPT) {
    const dests = calibrated.map(c => c.vec[name]);
    const stable = new Set(dests).size === 1;
    lines.push(`${name.padEnd(30)} {${dests.join(', ')}} ${stable ? '稳定 ✓' : '随价格漂移（假设敏感）'}（缺省 ${DEFAULTS[name]}）`);
  }
  console.log(lines.join('\n'));
});

// ─── Test 3：扩族敏感性 —— 误告权重 × 价格机制 → 阈值归宿 + 误告率对比 ───

test('扩族敏感性：误告权重扫描 → 阈值归宿与误告率对比（v1 建议的复审判据）', async () => {
  const lines: string[] = ['── ⑤ 扩族敏感性（误告任务频率先验 w × 4 价格机制；对照向量：缺省 / v1旧推荐0.4 / 托举盆地(0.5,W=4)）──'];

  // 固定对照向量（w 无关 —— 事件计数随 w 重算，行为不变）
  const VETO_PATH: Vector = { ...DEFAULTS, REFLEX_SUPPRESS_CONFIDENCE: 0.4 };   // v1 旧推荐（否决路径）
  const LIFT_PATH: Vector = { ...DEFAULTS, DELIB_WORKFLOW_WEIGHT: 4 };          // v1 披露的替代盆地（托举路径）

  // 误告率单调性（免疫阈值语义的机械不变量）：faRate(t) 非增
  {
    let prev = Number.POSITIVE_INFINITY;
    const marks: string[] = [];
    for (const t of [0.35, 0.4, 0.45, 0.5, 0.55]) {
      const r = await evalVector({ ...DEFAULTS, REFLEX_SUPPRESS_CONFIDENCE: t });
      assert.ok(r.feasible, `t=${t} 应可行（可行域 (0.3, 0.55]）`);
      const { faRate } = ratesOf(r.perWorld);
      assert.ok(faRate <= prev + 1e-9, `误告率必须随阈值非增：t=${t} faRate=${faRate} > prev=${prev}`);
      marks.push(`t=${t}→${(faRate * 100).toFixed(0)}%`);
      prev = faRate;
    }
    lines.push(`误告率单调性（机械不变量）: ${marks.join('  ')}  ✓ 非增`);
  }

  // 主扫描：w × regime → 双序下降的最优向量 + 误告率/漏报率
  const sweepResults: Array<{ w: number; regime: string; t: number; loss: number; defLoss: number; vec: Vector; faRate: number; missRate: number }> = [];
  for (const w of [1, 2, 4, 8]) {
    faWeight = w;
    for (const regime of REGIMES) {
      const base = await evalVector(DEFAULTS);
      const defLoss = lossOf(base.events, regime.prices);
      const best = await bestDescent(regime.prices);
      const final = await evalVector(best.vec);
      const { faRate, missRate } = ratesOf(final.perWorld);
      sweepResults.push({ w, regime: regime.name, t: best.vec.REFLEX_SUPPRESS_CONFIDENCE, loss: best.loss, defLoss, vec: best.vec, faRate, missRate });
      assert.ok(best.loss <= defLoss + 1e-9, `w=${w} ${regime.name}: 标定损失必须不劣于缺省`);
      const moved = SWEPT.filter(k => best.vec[k] !== DEFAULTS[k]).map(k => `${k} ${DEFAULTS[k]}→${best.vec[k]}`);
      lines.push(`w=${w} [${regime.name.padEnd(10)}] L(缺省)=${defLoss} → ${best.loss}  阈值归宿=${best.vec.REFLEX_SUPPRESS_CONFIDENCE}  误告率=${(faRate * 100).toFixed(0)}%  漏报率=${(missRate * 100).toFixed(0)}%  移动=[${moved.join('; ')}]`);
    }
  }
  faWeight = 1;

  // 时间不变性断言（v3 结构发现守卫）：E2（45 天老化）与 A5（无老化）逐天行为
  // 一致 —— 遗忘曲线的 eff 值在决策路径无消费者（压制读原始 confidence；
  // 决策查询不传 minConfidence 恒 0；排序以 hybridScore 为主，eff 仅平票
  // 次级）。时间维度在包络内不可经济化 —— 这是架构事实，不是未测。
  {
    const perWorld = (await evalVector(DEFAULTS)).perWorld;
    const pick = (name: string) => perWorld.filter(p => p.name === name)
      .map(p => `${p.verdict}/t=${p.trap}/e=${p.exec}`);
    const a5 = pick('A5 死磕陷阱');
    const e2 = pick('E2 时间不变性·45天');
    lines.push(`── 时间不变性（结构发现）：E2(45天老化) ≡ A5(无老化) 逐天一致 ──`);
    lines.push(`A5: ${a5.join(' → ')}`);
    lines.push(`E2: ${e2.join(' → ')}`);
    assert.deepEqual(e2, a5,
      '45 天老化后行为必须与无老化一致 —— 若不一致，说明遗忘曲线开始参与决策（架构变更，需重估时间维度的经济学）');
  }

  // 门槛解剖：t=0.6 在 W=2 下不可行（一维景观 ∅）但 fail-heavy 扫描选中
  // (0.6, W=4) —— 逐场景判定揭示 W 翻转了哪个门槛场景。
  lines.push('── 门槛解剖（t=0.6：W=2 vs W=4 —— 权重翻转的门槛场景）──');
  for (const wgt of [2, 4]) {
    const vec: Vector = { ...DEFAULTS, REFLEX_SUPPRESS_CONFIDENCE: 0.6, DELIB_WORKFLOW_WEIGHT: wgt };
    for (const k of Object.keys(vec) as ParamName[]) setParam(k, vec[k]);
    const root = mkdtempSync(join(tmpdir(), 'd7-jc-anat-'));
    try {
      const anat = await gateAnatomy(join(root, 'gate'));
      lines.push(`(t=0.6, W=${wgt}): ${Object.entries(anat).map(([k, v]) => `${k}=${v ? '✓' : '✗'}`).join(' ')}  ${Object.values(anat).every(v => v) ? '可行' : '不可行'}`);
    } finally {
      resetParams();
      rmSync(root, { recursive: true, force: true });
    }
  }

  // w=1 两个机制下标定向量的世界明细（报告证词：阈值归宿改了哪些世界）
  lines.push('── w=1 标定向量世界明细（标签以实测归宿为准）──');
  const showWorlds: Array<{ label: string; vec: Vector }> = [
    { label: 'balanced标定', vec: sweepResults.find(s => s.w === 1 && s.regime === 'balanced')!.vec },
    { label: 'fail-heavy标定', vec: sweepResults.find(s => s.w === 1 && s.regime === 'fail-heavy')!.vec },
  ];
  const basePerWorld = (await evalVector(DEFAULTS)).perWorld;
  const dayNo = (worldName: string, idx: number): number => {
    let n = 0;
    for (let i = 0; i <= idx; i++) if (basePerWorld[i].name === worldName) n += 1;
    return n;
  };
  for (const s of showWorlds) {
    const r = await evalVector(s.vec);
    const diff = r.perWorld
      .map((p, i) => ({ p, b: basePerWorld[i], i }))
      .filter(({ p, b }) => b && (b.verdict !== p.verdict || b.trap !== p.trap))
      .map(({ p, i }) => `${p.name}#D${dayNo(p.name, i)}:${p.verdict}/t=${p.trap}(缺省${basePerWorld[i].verdict}/t=${basePerWorld[i].trap})`);
    lines.push(`${s.label}  与缺省的差异: [${diff.join('; ')}]`);
  }

  // 对照向量在扩族（w=1）下的误告率对比 —— 用户问题的直接答案
  // 缺省向量已采纳 v3 fail-heavy 标定归宿（params.ts 注记 = 采纳记录）——
  // 此处的「缺省」是现行登记缺省（动态读 P），v1/v2 报告中的 (0.5, W=2)
  // 旧缺省向量在此作第四对照保留（历史基线，验证采纳的方向性收益）。
  lines.push('── 误告率对比（扩族 w=1，balanced 价格；v1 原族的解析值见报告）──');
  const compare: Array<{ label: string; vec: Vector }> = [
    { label: `缺省·已采纳fail-heavy归宿 (t=${DEFAULTS.REFLEX_SUPPRESS_CONFIDENCE}, W=${DEFAULTS.DELIB_WORKFLOW_WEIGHT})`, vec: DEFAULTS },
    { label: 'v1旧推荐·否决路径 (0.4, W=2)', vec: VETO_PATH },
    { label: '托举盆地 (0.5, W=4)', vec: LIFT_PATH },
    { label: '采纳前旧缺省 (0.5, W=2)', vec: { ...DEFAULTS, REFLEX_SUPPRESS_CONFIDENCE: 0.5, DELIB_WORKFLOW_WEIGHT: 2, AUTO_LEARN_SUCCESS_CONFIDENCE: 0.6 } },
  ];
  for (const regime of REGIMES) {
    const row: string[] = [];
    for (const c of compare) {
      const r = await evalVector(c.vec);
      const { faRate, missRate } = ratesOf(r.perWorld);
      row.push(`${c.label}: 误告${(faRate * 100).toFixed(0)}%/漏报${(missRate * 100).toFixed(0)}%/L=${lossOf(r.events, regime.prices)}`);
    }
    lines.push(`[${regime.name}] ${row.join('  ‖  ')}`);
  }

  // 判据断言：扩族标定的误告率不得劣于 v1 旧推荐（0.4）—— 误告质量被正视后，
  // 优化器不允许比旧推荐更冤枉好人（平手允许：二者都 100% 时）。
  {
    const w1 = sweepResults.filter(s => s.w === 1);
    for (const s of w1) {
      const veto = await evalVector(VETO_PATH);
      const vetoFa = ratesOf(veto.perWorld).faRate;
      assert.ok(s.faRate <= vetoFa + 1e-9,
        `w=1 ${s.regime}: 扩族标定误告率 ${(s.faRate * 100).toFixed(0)}% 劣于 v1 旧推荐 ${(vetoFa * 100).toFixed(0)}% —— 误告代价被低估的复测失败`);
    }
  }

  // ── 核证纪元终局（v4）：θ=0（全信 = v3 行为基线，探针永不触发）vs
  //    缺省 θ=0.2（联合标定归宿）的四指标对比 —— 误告/漏报/死锁三联解药的定量证词。──
  {
    const pre = await evalVector({ ...DEFAULTS, VERIFY_TRUST_FLOOR: 0 }); // v3 行为基线
    const post = await evalVector(DEFAULTS);                              // v4 缺省
    const pm = ratesOf(pre.perWorld), pd = deadlockRateOf(pre.perWorld);
    const qm = ratesOf(post.perWorld), qd = deadlockRateOf(post.perWorld);
    lines.push(`── 核证纪元终局：θ=0（v3 行为基线）→ θ=${DEFAULTS.VERIFY_TRUST_FLOOR}（v4 缺省）四指标对比 ──`);
    lines.push(`误告率 ${(pm.faRate * 100).toFixed(0)}% → ${(qm.faRate * 100).toFixed(0)}%（${pm.faFired.join(', ') || '无'} → ${qm.faFired.join(', ') || '无'}）`);
    lines.push(`漏报率 ${(pm.missRate * 100).toFixed(0)}% → ${(qm.missRate * 100).toFixed(0)}%  死锁率 ${(pd.deadlockRate * 100).toFixed(0)}% → ${(qd.deadlockRate * 100).toFixed(0)}%（${qd.deadlocked.join(', ') || '无'}）`);
    lines.push(`L(balanced) ${lossOf(pre.events, REGIMES[0].prices)} → ${lossOf(post.events, REGIMES[0].prices)}  L(fail-heavy) ${lossOf(pre.events, REGIMES[3].prices)} → ${lossOf(post.events, REGIMES[3].prices)}`);
    // 三联解药断言：探针不得恶化任何一率（误告严格改善；漏报/死锁不劣化）
    assert.ok(qm.faRate < pm.faRate,
      `传闻误告未被探针解药：误告率 ${pm.faRate} → ${qm.faRate}（应严格下降 —— D 组传闻世界须全数复活）`);
    assert.ok(qm.missRate <= pm.missRate + 1e-9,
      `核证学费被计为漏报：${qm.missRate} > ${pm.missRate}（探针踩坑 ≠ 压制失效 —— ratesOf 语义分离失败）`);
    assert.ok(qd.deadlockRate < pd.deadlockRate,
      `陈年死锁无时间出口：死锁率 ${pd.deadlockRate} → ${qd.deadlockRate}（F1 Day3 复活探针必须破局）`);
  }

  // ── F 组世界明细断言（核证接地的行为面证词）──
  {
    const perWorld = (await evalVector(DEFAULTS)).perWorld;
    const seq = (name: string) => perWorld.filter(p => p.name === name)
      .map(p => `${p.verdict}/t=${p.trap}/p=${p.probes}`);
    // F1 三态：探针学费（Day1）→ 窗口期死锁（Day2）→ 复活破局（Day3）
    const f1 = seq('F1 陈年忏悔之门');
    lines.push(`── F1 陈年忏悔之门（v4 死锁出口）: ${f1.join(' → ')}（期望 failed/t=1/p=1 → failed/t=0/p=0 → completed/t=0/p=1）──`);
    assert.equal(f1[0], 'failed/t=1/p=1', `F1 Day1 应为复活探针学费：got ${f1[0]}`);
    assert.equal(f1[1], 'failed/t=0/p=0', `F1 Day2 应为窗口期诚实接地（亲证保鲜）：got ${f1[1]}`);
    assert.equal(f1[2], 'completed/t=0/p=1', `F1 Day3 应为复活探针破局（陷阱已修好）：got ${f1[2]}`);
    // F2 零学费：新鲜亲证自背书 —— 一针都不多付
    const f2 = seq('F2 新鲜亲证零学费');
    lines.push(`── F2 新鲜亲证零学费: ${f2.join(' ')}（期望 failed/t=0/p=0）──`);
    assert.equal(f2[0], 'failed/t=0/p=0', `F2 应自背书零学费接地：got ${f2[0]}`);
    // D4/D5 亲证误告：窗口期冤枉（诚实上界）/ 陈年探针解药（时间解药）
    const d4 = seq('D4 误告·亲证0.66')[0], d5 = seq('D5 误告·陈年亲证')[0];
    lines.push(`── 亲证误告: D4 新鲜=${d4}（期望 failed/t=0/p=0 冤枉上界） D5 陈年=${d5}（期望 completed/t=0/p=1 探针解药）──`);
    assert.equal(d4, 'failed/t=0/p=0', `D4 新鲜亲证误告应为窗口期冤枉：got ${d4}`);
    assert.equal(d5, 'completed/t=0/p=1', `D5 陈年亲证误告应被探针解药：got ${d5}`);
  }

  // ── θ-解耦断言（v4 正交性）：θ 扫值时，非核证面（无压制或压制即改道的
  //    世界）行为逐天不变 —— t 管「是否压制」，θ 管「压制证据是否可信到
  //    不许验证」。二者重叠的面 = 压制+无活路的接地终局（探针的辖区）。──
  {
    const basePerW = (await evalVector(DEFAULTS)).perWorld;
    const anchor = new Map(basePerW.map(p => [`${p.name}#${basePerW.indexOf(p)}`, `${p.verdict}/t=${p.trap}/e=${p.exec}/l3=${p.l3}`]));
    // 探针辖区世界（θ 消费者：压制+无活路 ⇒ 信任门控被咨询）
    const THETA_DOMAINS = new Set([
      'A1 真陷阱·种子0.55', 'A5 死磕陷阱', 'A6 忏悔之门', 'E1 十天学费曲线',
      'E2 时间不变性·45天', 'E3 长期忏悔', 'E4 多陷阱走廊', 'F1 陈年忏悔之门',
      'F2 新鲜亲证零学费', 'D4 误告·亲证0.66', 'D5 误告·陈年亲证',
      'D1 误告·传闻0.40', 'D2 误告·传闻0.60', 'D3 误告·传闻0.65',
      'A2 误告·0.55', 'A3 误告·0.45', 'A4 误告·0.50',
    ]);
    const changed: string[] = [];
    for (const v of GRID.VERIFY_TRUST_FLOOR) {
      if (v === DEFAULTS.VERIFY_TRUST_FLOOR) continue;
      const r = await evalVector({ ...DEFAULTS, VERIFY_TRUST_FLOOR: v });
      r.perWorld.forEach((p, i) => {
        const key = `${p.name}#${i}`;
        const mark = `${p.verdict}/t=${p.trap}/e=${p.exec}/l3=${p.l3}`;
        if (anchor.get(key) !== mark && !THETA_DOMAINS.has(p.name)) {
          changed.push(`θ=${v}: ${p.name}#D${(p.name === basePerW[i].name ? i - basePerW.findIndex(b => b.name === p.name) : i) + 1} ${anchor.get(key)} → ${mark}`);
        }
      });
    }
    lines.push(`── θ-解耦断言: 非 θ 辖区世界（改道/直扑/学习闭环等）行为逐天不变 ✓（${THETA_DOMAINS.size} 个 θ 辖区世界外零变化）──`);
    assert.deepEqual(changed, [],
      `θ 扫值波及了压制语义（应只动信任门控）：\n${changed.join('\n')}`);
  }
  console.log(lines.join('\n'));
});

// ─── Test 4：真机复测（真实感知噪声分布下的缺省 vs 标定）───

function displayReachable(): boolean {
  try {
    execFileSync('xdpyinfo', { env: { ...process.env, DISPLAY: ':77' }, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test('真机复测：缺省 vs 标定向量在真实感知噪声分布下的损失对照', async (t) => {
  if (!displayReachable()) {
    t.skip('Xvfb :77 不可达 —— 真机复测需要真实显示服务器（Xvfb :77 -screen 0 800x600x24）');
    return;
  }
  const { startRealWorld, createRealVisionStation, createRealExecutionStation, disposeOcr } = await import('./realWorldHarness.ts');
  const balanced = REGIMES[0].prices;
  faWeight = 1;
  const calibratedVec: Vector = (await bestDescent(balanced)).vec;

  const world = await startRealWorld();
  const dirs: string[] = [];
  const lines: string[] = ['── ④ 真机复测（Xvfb+tkinter+OCR+xdotool；世界 = 真实感知噪声分布）──'];
  const results: Array<{ label: string; events: Events; loss: number }> = [];

  async function realRun(vec: Vector, label: string, intent: string, stateDir?: string): Promise<{ verdict: string; probe: { exec: number; trap: number; l3: number } }> {
    for (const k of Object.keys(vec) as ParamName[]) setParam(k, vec[k]);
    await world.reset();
    const kb = new InMemoryKnowledgeBase();
    if (label.includes('E1b')) {
      kb.insert({ category: 'error-pattern', content: 'delete item button is broken, clicks fail', scenario: 'record cleanup', confidence: 0.55, source: 'manual' });
      kb.insert({ category: 'workflow', content: 'clear log after erasing records', scenario: 'record cleanup', confidence: 0.6, source: 'manual' });
    }
    const probe = { exec: 0, trap: 0, l3: 0 };
    const vision = createRealVisionStation();
    const visionProbe = {
      async perceive(env: any) {
        if (env?.payload?.forceL3) probe.l3 += 1;
        return vision.perceive(env);
      },
    };
    const execution = {
      async execute(env: any) {
        probe.exec += 1;
        const r = await createRealExecutionStation(world).execute(env);
        if (r.status === 'failure' && r.failure?.detail?.includes("'delete item'")) probe.trap += 1;
        return r;
      },
    };
    const o = new KnowledgePipelineOrchestrator();
    assert.ok(o.configure({
      timeout: { overall: 60_000, perStep: 10_000, perPerception: 15_000 },
      retryPolicy: { maxRetries: 2, backoffMs: 1, maxBackoffMs: 2 },
      knowledgeTimeout: 200, knowledgeMaxResults: 5, knowledgeMaxChars: 300,
    }).ok);
    o.wire(
      {
        vision: visionProbe as any, decision: new ReflexiveDecisionStation({ chat: null }),
        execution: execution as any, knowledge: kb, verdictBridge: new DoctorVerdictBridge(),
        emit: () => { /* 旁路 */ },
      },
      { stateDir },
    );
    const report = await o.run({ id: `jc-real-${++runCounter}`, description: intent });
    resetParams();
    return { verdict: report.verdict, probe };
  }

  try {
    for (const [label, vec] of [['缺省', DEFAULTS], ['标定', calibratedVec]] as Array<[string, Vector]>) {
      const events: Events = { exec: 0, trap: 0, fail: 0, l3Pipeline: 0, l3MeterBills: 0 };
      // E1b-R：种子知识 + 诱惑 intent（免疫压制 + 改道）
      const e1b = await realRun(vec, `E1b-${label}`, 'delete the record');
      events.exec += e1b.probe.exec; events.trap += e1b.probe.trap; events.l3Pipeline += e1b.probe.l3;
      events.fail += e1b.verdict === 'completed' ? 0 : 1;
      lines.push(`${label} E1b-R 改道        ${e1b.verdict.padEnd(9)} exec=${e1b.probe.exec} trap=${e1b.probe.trap} l3=${e1b.probe.l3}`);
      // E3-R 迷你学习曲线：Day1 踩坑 → Day1 活路 → Day2 改道（持久化）
      const learnDir = mkdtempSync(join(tmpdir(), `d7-jc-real-${label}-`));
      dirs.push(learnDir);
      for (const intent of ['delete the record', 'clear the log', 'delete the record']) {
        const r = await realRun(vec, `learn-${label}`, intent, learnDir);
        events.exec += r.probe.exec; events.trap += r.probe.trap; events.l3Pipeline += r.probe.l3;
        events.fail += r.verdict === 'completed' ? 0 : 1;
        lines.push(`${label} 学习 ${intent.padEnd(19)} ${r.verdict.padEnd(9)} exec=${r.probe.exec} trap=${r.probe.trap} l3=${r.probe.l3}`);
      }
      const L = lossOf(events, balanced);
      results.push({ label, events, loss: L });
      lines.push(`${label} 真机账单: L=${L}（exec=${events.exec} trap=${events.trap} fail=${events.fail} l3=${events.l3Pipeline}）`);
    }

    console.log(lines.join('\n'));

    // 真机底线：两个向量的核心不变量都必须成立（分布偏移不翻车）
    for (const r of results) {
      assert.ok(r.events.trap <= 6, `${r.label}: 真机陷阱点击失控（${r.events.trap}）`);
    }
    // 诚实对照：真机世界表达不了标定向量的优势面（陷阱真坏、无竞争陷阱、
    // 无误告）—— 损失差 ≈ 0 是预期结果，写进报告而非藏进断言。
  } finally {
    await world.dispose();
    await disposeOcr();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  }
});
