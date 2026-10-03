// src/kernel/index.ts
// 纪元 Θ（Θ-4 生产接线）：内核器官桶 —— 五模块 re-export + 生产内核入册单。
//
// 职责边界：
//   · 桶：registry（注册表 + 证据账本）/ calibrator（在线校准器）/ lineage（血统）
//     / store（Ξ-A 进化存档）/ conductor（Ξ-A 进化编排）的统一出口 ——
//     宿主与工具层只 import 本文件即可触达内核全系；
//   · registerProductionKernels()：生产内核读点（Θ-4 + Ξ-D 接线清单）的幂等入册。
//     入册语义零行为变化：register 的 value := 夹取后 defaultValue，而每颗读点
//     的 defaultValue 就是其现行字面量 ⇒ 注册表现值 = 字面量 = 消费方
//     getOrDefault 的 fallback —— 读点行为逐字节不变。入册的意义是把可行区间、
//     器官归属与出处注记立册在案，让 set / promoteFrom / 校准器有合法的落笔处
//     （set 未注册键恒失败 —— 注册是进化通道的门，不是行为开关）。
//
// 与训练营（autonomy/gym.ts LAB_KERNEL_SPECS）的分工：实验室自铸注册表在馆内
// 进化；本单册在**生产单例**上声明同一 key 域（键名与 gym 前批四键逐字一致，
// organ 词表同源：perception / arbitration / policy），晋升走
// kernelRegistry.promoteFrom(gym.lab.registry) —— key 域交集即晋升面。
//
// 幂等律：register 对重复 key 保持现值、只更新规格 —— 本函数可无限次重入
// （apply 每会话调一次，多会话/热重载亦无害）。入册本身不设开关（恒入册、
// 值全默认 = 零行为变化）；纪元 Ξ（Ξ-A）起生产进化经 config 双字段接线：
// kernelStatePath（进化成果存档，空 = 仅内存）与 kernelEvolutionEnabled
//（生产进化总开关，缺省 false = 只记账不进化）—— 均缺省零行为。
//
// Ξ-A 新增导出面：
//   · store.ts：KernelStore + KernelStateFile —— 进化三账（值/证据/代际）的
//     tmp+rename 原子存档与防御性回放（只认已注册 key）；
//   · conductor.ts：EvolutionConductor + ConductorReport + ConductorOptions
//     + DEFAULT_TICK_INTERVAL_MS —— enabled 总开关与 minIntervalMs 节流窗的
//     tick 指挥棒（缺省 disabled + 5 分钟窗）。
export * from './registry.js';
export * from './calibrator.js';
export * from './lineage.js';
export * from './store.js';
export * from './conductor.js';
import { kernelRegistry } from './registry.js';
/**
 * 生产内核入册单：Θ-4 + Ξ-D 接线的全部读点键（55 键 / 21 读点文件）。
 * min/max 按 census 区间；defaultValue = 各读点现行字面量（零行为变化的锚）；
 * organ 为消费器官名（与 gym LAB_KERNEL_SPECS 同一词表 + 新器官扩展）。
 *
 * 诚实否决记录（审了不接 —— 与接线同等立档在案）：
 *   · BM25 k1/b（semanticHash 检索层）：模块立法「值即设计非旋钮」—— k1/b 是
 *     排名函数的形状参数而非可进化阈值，接线只会把立法降格为旋钮；
 *   · policyEngine 七处效用基线（escalate/utility 诸常量）：进化价值低 ——
 *     它们只在日志/注记里排序次序，不参与任何判决翻转。
 */
const PRODUCTION_KERNEL_SPECS = [
    // ── 感知器官（worldSnapshot.snapshotChanged 的 dhash 汉明容差） ──
    {
        key: 'world.hammingTolerance',
        organ: 'perception',
        defaultValue: 3,
        min: 1,
        max: 8,
        note: 'snapshotChanged 的 dhash 汉明容差：距离 ≤ 容差视为像素未动（缺省 3；与训练营 LAB_KERNEL_SPECS 同键同区间）',
    },
    // ── 仲裁器官（vlm/arbitration 的双源融合判据） ──
    {
        key: 'arbitration.iouThreshold',
        organ: 'arbitration',
        defaultValue: 0.5,
        min: 0.3,
        max: 0.8,
        note: '双源元素融合的 IoU 配对门限（缺省 0.5）',
    },
    {
        key: 'arbitration.agreementBonus',
        organ: 'arbitration',
        defaultValue: 0.15,
        min: 0,
        max: 0.3,
        note: '双源一致元素的置信加成，融合置信 = min(1,(cv+cl)/2+此值)（缺省 0.15）',
    },
    {
        key: 'arbitration.textSimilarity',
        organ: 'arbitration',
        defaultValue: 0.8,
        min: 0.5,
        max: 0.95,
        note: 'arbitrateText 的归一化 Levenshtein 相似判决线（缺省 0.8）',
    },
    // ── 策略器官（autonomy/policyEngine 的元素匹配置信门槛） ──
    {
        key: 'policy.matchConfident',
        organ: 'policy',
        defaultValue: 0.55,
        min: 0.3,
        max: 0.9,
        note: '判据-元素匹配置信门槛：最佳候选得分低于此值 ⇒ uncertain（缺省 0.55）',
    },
    {
        key: 'policy.tieGap',
        organ: 'policy',
        defaultValue: 0.05,
        min: 0.01,
        max: 0.2,
        note: '候选并列判定：最佳与次佳得分差小于此值 ⇒ uncertain（缺省 0.05）',
    },
    // ── 认识论器官（autonomy/uncertainty 的校准常数与三档双阈值） ──
    {
        key: 'uncertainty.alpha',
        organ: 'uncertainty',
        defaultValue: 4,
        min: 1,
        max: 10,
        note: 'Beta 式校准 α（自报可信 ⇒ 确实可信的先验强度；缺省 4，与 β=1 联合得 eff 值域 [0.2,0.8]）',
    },
    {
        key: 'uncertainty.beta',
        organ: 'uncertainty',
        defaultValue: 1,
        min: 0.5,
        max: 5,
        note: 'Beta 式校准 β（自报不可信 ⇒ 其实可信的底噪强度；缺省 1）',
    },
    {
        key: 'uncertainty.highProceed',
        organ: 'uncertainty',
        defaultValue: 0.85,
        min: 0.7,
        max: 1,
        note: 'high 档 proceed 直放线（缺省 0.85 > 校准值域上限 0.8 —— 高危无免检直通道的刻意设计）',
    },
    {
        key: 'uncertainty.highVlm',
        organ: 'uncertainty',
        defaultValue: 0.6,
        min: 0.4,
        max: 0.8,
        note: 'high 档云脑复核线（缺省 0.6）',
    },
    {
        key: 'uncertainty.mediumProceed',
        organ: 'uncertainty',
        defaultValue: 0.7,
        min: 0.55,
        max: 0.9,
        note: 'medium 档 proceed 直放线（缺省 0.7）',
    },
    {
        key: 'uncertainty.mediumVlm',
        organ: 'uncertainty',
        defaultValue: 0.45,
        min: 0.3,
        max: 0.65,
        note: 'medium 档云脑复核线（缺省 0.45）',
    },
    {
        key: 'uncertainty.lowProceed',
        organ: 'uncertainty',
        defaultValue: 0.5,
        min: 0.35,
        max: 0.8,
        note: 'low 档 proceed 直放线（缺省 0.5）',
    },
    {
        key: 'uncertainty.lowVlm',
        organ: 'uncertainty',
        defaultValue: 0.3,
        min: 0.15,
        max: 0.5,
        note: 'low 档云脑复核线（缺省 0.3）',
    },
    // ── OCR 器官（textReader 的词置信截断线） ──
    {
        key: 'ocr.wordConfidenceFloor',
        organ: 'ocr',
        defaultValue: 60,
        min: 30,
        max: 90,
        note: 'legacy tesseract 词级置信截断线：confidence ≤ 此值的词被滤除（缺省 60）',
    },
    // ── 接地器官（vlm/grounding 的 NMS 去冗余阈） ──
    {
        key: 'grounding.nmsIou',
        organ: 'grounding',
        defaultValue: 0.6,
        min: 0.4,
        max: 0.8,
        note: 'NMS 去冗余 IoU 阈：≥ 此值视为同一元素的重复检出（缺省 0.6）',
    },
    // ── 技能器官（skillLibrary.match 的入口场景同屏判据） ──
    {
        key: 'skill.sceneGate',
        organ: 'skill',
        defaultValue: 0.9,
        min: 0.7,
        max: 0.98,
        note: '技能匹配的入口场景指纹相似门：dhash 相似 ≥ 此值给同屏加成（缺省 0.9）',
    },
    {
        key: 'skill.sceneBonus',
        organ: 'skill',
        defaultValue: 0.3,
        min: 0,
        max: 0.5,
        note: '技能匹配的同屏加成分值（缺省 0.3）',
    },
    // ══ 纪元 Ξ（Ξ-D 二梯队全接线）：以下 37 键为第二梯队读点 ══
    // ── 判决器官（policyEngine 预算红线 + vlm/verdict 双脑融合判据） ──
    {
        key: 'policy.budgetStepsLow',
        organ: 'policy',
        defaultValue: 2,
        min: 1,
        max: 5,
        note: '预算升级红线：剩余步数 ≤ 此值 ⇒ escalate 上游（缺省 2）',
    },
    {
        key: 'policy.budgetMsLow',
        organ: 'policy',
        defaultValue: 15000,
        min: 1000,
        max: 60000,
        note: '预算升级红线：剩余毫秒 ≤ 此值 ⇒ escalate 上游（缺省 15000）',
    },
    {
        key: 'verdict.fuseBonus',
        organ: 'verdict',
        defaultValue: 0.1,
        min: 0,
        max: 0.3,
        note: 'fuseWithPixelEvidence 双脑一致判「有效果」的置信加成（缺省 0.1，封顶 1）',
    },
    {
        key: 'verdict.conservativeCap',
        organ: 'verdict',
        defaultValue: 0.6,
        min: 0.3,
        max: 0.9,
        note: 'fuseWithPixelEvidence 分歧/不确定判决的保守置信帽：min(vlmConf, 此值)（缺省 0.6）',
    },
    // ── 验证器官（actionVerifier 轮询/判距/pHash 门 + oscillationTracker 循环谱） ──
    {
        key: 'verify.phashGate',
        organ: 'verify',
        defaultValue: 0.9,
        min: 0.7,
        max: 0.98,
        note: 'pHash 频谱佐证门：前后相似度 < 此值 = 频谱域看到变化（缺省 0.9；双读点同键同步）',
    },
    {
        key: 'verify.stableGap',
        organ: 'verify',
        defaultValue: 1,
        min: 0,
        max: 6,
        note: '稳定帧判距：dhash 汉明距离 ≤ 此值视为同帧（缺省 1；双读点同键同步）',
    },
    {
        key: 'verify.pollMs',
        organ: 'verify',
        defaultValue: 150,
        min: 30,
        max: 1000,
        note: '动作后稳定轮询间隔 ms（缺省 150；消费处 Math.max(1,…) 防 0 忙等）',
    },
    {
        key: 'verify.settleFactor',
        organ: 'verify',
        defaultValue: 4,
        min: 1,
        max: 10,
        note: '自适应等待窗倍率：maxWaitMs = settleMs × 此值（缺省 4；消费处 Math.max(1,…) 防 0 清零）',
    },
    {
        key: 'osc.ringSize',
        organ: 'oscillation',
        defaultValue: 12,
        min: 4,
        max: 64,
        note: '振荡检测观测窗帧数（缺省 12 = 3×maxPeriod 4；结构序守护：消费处 ringSize = Math.max(3*maxPeriod, round(v)) —— 窗容不下 3 份周期块时自抬到结构下限）',
    },
    {
        key: 'osc.maxPeriod',
        organ: 'oscillation',
        defaultValue: 4,
        min: 1,
        max: 6,
        note: '循环谱检测的最大周期 p（缺省 4；探测序 p=1..此值，p=1 语义 = 旧版行为回归）',
    },
    {
        key: 'osc.fuzzTol',
        organ: 'oscillation',
        defaultValue: 6,
        min: 0,
        max: 12,
        note: '循环检测的 dhash 汉明容差位（缺省 6/64 —— 与既视感同律；0 = 精确匹配特例）',
    },
    // ── 记忆器官（skillLibrary 评分 / orchestrator 仲裁 / failureMemory 召回 / contextManager 既视感） ──
    {
        key: 'skill.scoreFloor',
        organ: 'skill',
        defaultValue: 0.15,
        min: 0,
        max: 0.5,
        note: '技能匹配入选地板：综合分 ≤ 此值的候选被滤除（缺省 0.15）',
    },
    {
        key: 'skill.reliabilityWeight',
        organ: 'skill',
        defaultValue: 0.3,
        min: 0,
        max: 1,
        note: '技能评分的贝叶斯可靠度权重（缺省 0.3）',
    },
    {
        key: 'skill.ciDiscount',
        organ: 'skill',
        defaultValue: 0.1,
        min: 0,
        max: 0.3,
        note: '技能评分的 95% CI 半宽折扣（缺省 0.1 —— 只做同均值平票裁决，不做主排序信号）',
    },
    {
        key: 'skill.recencyHalfLifeH',
        organ: 'skill',
        defaultValue: 72,
        min: 1,
        max: 720,
        note: '技能新近度半衰期（小时；缺省 72 —— 三天前的技能贡献减半；消费处 Math.max(1,…) 防除零）',
    },
    {
        key: 'orch.skillReliability',
        organ: 'orchestration',
        defaultValue: 0.5,
        min: 0,
        max: 1,
        note: '子代理技能通道可用性判据的可靠度门（缺省 0.5 —— Laplace 0/0=0.5 不入场）',
    },
    {
        key: 'orch.skillScore',
        organ: 'orchestration',
        defaultValue: 0.45,
        min: 0,
        max: 1,
        note: '子代理技能通道可用性判据的相关度门（缺省 0.45 —— 可靠不等于相关）',
    },
    {
        key: 'orch.emaAlpha',
        organ: 'orchestration',
        defaultValue: 0.15,
        min: 0.01,
        max: 0.9,
        note: '通道 EMA 成功率平滑系数 α（缺省 0.15；消费处夹 [0.01,0.9] —— α=0 冻结学习、α=1 退化成逐次覆写）',
    },
    {
        key: 'failure.score2Floor',
        organ: 'failure',
        defaultValue: 0.2,
        min: 0,
        max: 0.6,
        note: '失败记忆相关性闸门：legacy 加权和 score2 ≤ 此值不召回（缺省 0.2 —— R-6 之前的既有阈值语义）',
    },
    {
        key: 'failure.rrfK',
        organ: 'failure',
        defaultValue: 60,
        min: 10,
        max: 200,
        note: 'RRF 倒数排名融合的平滑常数 k（缺省 60 —— TREC 2003 Cormack 惯例；消费处 round 整数化）',
    },
    {
        key: 'failure.sceneBonus',
        organ: 'failure',
        defaultValue: 0.4,
        min: 0,
        max: 0.8,
        note: '失败记忆的同场景脉冲分值（缺省 0.4 —— 场景指纹通道的 0/此值 二值证据）',
    },
    {
        key: 'ctx.flashbackSim',
        organ: 'context',
        defaultValue: 0.85,
        min: 0.5,
        max: 0.98,
        note: '既视感双指共识门：库存 pHash 与当前帧相似度 ≥ 此值才闪回（缺省 0.85）',
    },
    // ── 治理器官（popupDetector 施密特全套）—— 结构序守护见各 note ──
    {
        key: 'popup.priorWeight',
        organ: 'popup',
        defaultValue: 0.05,
        min: 0.01,
        max: 0.3,
        note: '贝叶斯弹窗信念先验（缺省 0.05 —— 世界大多数时刻没有弹窗；构造/reset 时读）',
    },
    {
        key: 'popup.evidenceGeo',
        organ: 'popup',
        defaultValue: 4.0,
        min: 1,
        max: 6,
        note: '几何证据强度（nats；缺省 4.0 —— 单帧几何 ⇒ 后验 ≈0.98 立即 ON）。结构序守护：语义 ≥ 几何是模块立法 —— specs 层 sem 下限 5、消费处再 Math.max(sem, geo) 兜序（geo 可探至 6 越过 sem 下限，越序值就地抬正）',
    },
    {
        key: 'popup.evidenceSem',
        organ: 'popup',
        defaultValue: 5.0,
        min: 5,
        max: 10,
        note: '语义证据强度（nats；缺省 5.0 —— 词表命中是确定性更强的信号）。下限取 5 而非 6：缺省 5.0 必须落在区间内（入册值 = 字面量的零行为铁律优先于区间美学），「geo 上限 < sem 下限」的结构序由消费处 Math.max(sem, geo) 兜底保证',
    },
    {
        key: 'popup.evidenceClean',
        organ: 'popup',
        defaultValue: -1.5,
        min: -4,
        max: -0.5,
        note: '清洁帧证据强度（nats；缺省 −1.5 —— 单帧清洁把 ON 态拉入迟滞带但不放行）',
    },
    {
        key: 'popup.onThreshold',
        organ: 'popup',
        defaultValue: 0.6,
        min: 0.55,
        max: 0.9,
        note: '施密特触发 ON 线：belief ≥ 此值进入弹窗态（缺省 0.6）。结构序守护：off 区间上限 0.5 < 本区间下限 0.55（specs 层不交叠），消费处再 Math.min(off, on) 兜序 —— 施密特退化为逐帧抖动是结构崩坏，非旋钮',
    },
    {
        key: 'popup.offThreshold',
        organ: 'popup',
        defaultValue: 0.35,
        min: 0.1,
        max: 0.5,
        note: '施密特触发 OFF 线：belief ≤ 此值退出弹窗态（缺省 0.35）。区间上限 0.5 < onThreshold 区间下限 0.55 —— 迟滞带恒非负宽的结构保证（消费处 Math.min(off, on) 二道兜底）',
    },
    {
        key: 'popup.geoLow',
        organ: 'popup',
        defaultValue: 0.55,
        min: 0.2,
        max: 0.9,
        note: '几何比之一：中心标准差 < 全图标准差 × 此值（缺省 0.55 —— 更均匀；服务端/legacy 双路径同键同步）',
    },
    {
        key: 'popup.geoHigh',
        organ: 'popup',
        defaultValue: 1.15,
        min: 1.0,
        max: 2.0,
        note: '几何比之二：中心均值 > 全图均值 × 此值（缺省 1.15 —— 更亮；下限 1.0 = 中心不暗于全图的结构语义）',
    },
    // ── 云脑计量器官（vlm/metering 熔断 + quantumSense 去重 + vlm/codec 编码缺省） ──
    {
        key: 'vlm.breakerFailures',
        organ: 'metering',
        defaultValue: 5,
        min: 2,
        max: 20,
        note: 'VlmApiBreaker 熔断阈：连续失败 ≥ 此值 ⇒ open（缺省 5；读点在构造器缺省参 —— set 后新实例生效，显式入参压过注册表）',
    },
    {
        key: 'vlm.breakerCooldownMs',
        organ: 'metering',
        defaultValue: 60000,
        min: 5000,
        max: 600000,
        note: 'VlmApiBreaker 冷却期 ms：期满自动回 closed（缺省 60000；半开语义惰性判定）',
    },
    {
        key: 'quantum.iou',
        organ: 'quantum',
        defaultValue: 0.5,
        min: 0.3,
        max: 0.8,
        note: '叠加态标注的白盒元素去重 IoU 门（缺省 0.5；或中心点互相包含）',
    },
    {
        key: 'codec.maxDim',
        organ: 'codec',
        defaultValue: 1568,
        min: 512,
        max: 4096,
        note: 'encodeForVlm 缺省长边上限：超过则等比缩小（缺省 1568 —— VLM 最佳分辨率带宽；缺省单点全辖六个调用方）',
    },
    {
        key: 'codec.quality',
        organ: 'codec',
        defaultValue: 80,
        min: 50,
        max: 95,
        note: 'encodeForVlm 缺省 JPEG 质量 1-100（缺省 80 —— UI 文字边缘清晰且体积可控）',
    },
    // ── 宪法器官（Ξ-C 已在 gym 实验室入册接线；生产册此补 specs，读点不动） ──
    {
        key: 'constitution.maxNoEffect',
        organ: 'constitution',
        defaultValue: 3,
        min: 2,
        max: 6,
        note: '宪法卡死律阈值：连续无效果步上限（缺省 3；与 gym LAB_CONSTITUTION_KERNEL_SPECS 同键同区间 —— 晋升面就绪）',
    },
    {
        key: 'constitution.maxSteps',
        organ: 'constitution',
        defaultValue: 40,
        min: 10,
        max: 80,
        note: '宪法步数律硬顶：累计步数上限（缺省 40；与 gym 同键同区间）',
    },
];
/**
 * 生产内核入册（幂等、零行为变化）：把 Θ-4 + Ξ-D 接线的全部读点键注册进生产单例。
 *   - 首次：value = defaultValue（= 各读点现行字面量）⇒ getOrDefault 读数不变；
 *   - 重入：register 保持现值 / 证据 / 代际，只刷新规格 —— 无限次重入无害
 *     （幂等性由 registry.register 的重复注册契约保证，本函数不设标记位 ——
 *     标记位会被 resetKernelRuntime 清册后卡死，register 自身才是唯一权威）；
 *   - 纯同步、绝不抛（垃圾 spec 静默忽略是 registry 的契约；本单册全部合格）。
 * 宿主 apply() 启动调用一次；测试经 resetKernelRuntime() 隔离后自行决定是否入册。
 */
export function registerProductionKernels() {
    for (const spec of PRODUCTION_KERNEL_SPECS) {
        kernelRegistry.register({ ...spec });
    }
}
