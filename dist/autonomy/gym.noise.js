// src/autonomy/gym.noise.ts
// W8-B1（DEBTS D-F1 拆分潮）：自 gym.ts 低风险分区提取（对齐 actionVerifier.*
// 兄弟文件先例）—— W1-4 病态感知诊所整体搬迁：噪声注入契约（GymNoiseSpec /
// resolveGymNoise / 词形混淆矩阵 / 腐蚀函数）+ noiseSweep 鲁棒性曲线。行为零
// 变化（纯搬运，逐字节不改）；gym.ts 以再导出保持导入面不变。诊所律随件走：
// 噪声只坏「传感器读出」、世界 ground truth 分毫不动；三条独立种子流（fnv1a
// 域分离永不串流）；脏值一律夹取收敛（GYM_NOISE_MAX_JITTER / GYM_NOISY_OCR_CONF
// 单一事实源在此，世界铸造侧 gym.world.ts / gym.pcgWorld.ts 经导入消费）。
// ΠΑΝ-127（D-F5 清偿）：rng 立法（fnv1a/mulberry32/r2）改自零出边叶 gym.rng.ts
// 导入；AutonomyGym/DEFAULT_MAX_STEPS 与任务生立立法（castTask/KIND_ORDER——
// w8gymsplit ②「export const KIND_ORDER」源级锁定不可搬）经端口注入
//（noiseSweep 增收 ports 参数，注入方 = 桶 gym.ts 的公开包装 —— 原自桶回借
// 构成桶-卫星 value 二环；类型面仍 type-import 自桶，type 边豁免）。行为零变化。
import { fnv1a, mulberry32, r2 } from './gym.rng.js';
/** W1-4：bbox 抖动上限（像素）——按钮半高 40 量级，≥ 此值抖动可观测打偏点击 */
const GYM_NOISE_MAX_JITTER = 80;
/** W1-4：OCR 置信跌落落点（低于 policy.matchConfident 0.55 ⇒ 匹配置信不足可观测） */
export const GYM_NOISY_OCR_CONF = 0.46;
/**
 * W1-4 词形混淆矩阵（内置小表）：OCR 高频字形混淆对（双向对称）——相邻字形 /
 * 易混字符。覆盖训练营词面（下/页/完/成/深/提/安/稍/支/即/看/目/可），换字只
 * 改 sensor 读出的词面，物理像素与控件真相不动。
 */
const OCR_CONFUSABLES = {
    '下': '不', '不': '下',
    '页': '贝', '完': '元', '成': '城', '深': '演',
    '提': '堤', '安': '按', '稍': '梢', '支': '枝',
    '即': '既', '看': '着', '目': '且', '可': '司',
};
/**
 * W1-4：按混淆矩阵腐蚀一个 OCR 词（逐字符独立掷骰，rate=1 ⇒ 可混淆字符全换）。
 * 纯函数 + 注入 rng ⇒ 同 seed 同腐蚀，绝不抛。
 */
export function corruptOcrLabel(label, rate, rng) {
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
export function resolveGymNoise(raw) {
    const o = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
        ? raw
        : {};
    const rate = (v) => typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
    const seedNum = Number(o.seed);
    const seed = Number.isFinite(seedNum) ? Math.floor(Math.abs(seedNum)) % 0x80000000 : 0;
    const jRaw = typeof o.bboxJitterPx === 'number' && Number.isFinite(o.bboxJitterPx) ? o.bboxJitterPx : 0;
    const bboxJitterPx = Math.min(GYM_NOISE_MAX_JITTER, Math.max(0, Math.round(jRaw)));
    const ocrSwapRate = rate(o.ocrSwapRate);
    const ocrConfDrop = rate(o.ocrConfDrop);
    const vlmMissRate = rate(o.vlmMissRate);
    const transientFrame = o.transientFrame === 1 ? 1 : 0;
    return {
        seed,
        ocrSwapRate,
        ocrConfDrop,
        vlmMissRate,
        bboxJitterPx,
        transientFrame,
        active: ocrSwapRate > 0 || ocrConfDrop > 0 || vlmMissRate > 0 || bboxJitterPx > 0 || transientFrame === 1,
    };
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
export async function noiseSweep(opts = {}, ports) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const seedNum = Number(o.seed);
    const master = Number.isFinite(seedNum) ? Math.floor(seedNum) : SWEEP_DEFAULT_SEED;
    const msNum = Number(o.maxSteps);
    // ΠΑΝ-127：立法缺省经端口注入（原直接回借 gym.ts DEFAULT_MAX_STEPS —— 拆环）
    const maxSteps = Number.isFinite(msNum) && msNum >= 1 ? Math.floor(msNum) : ports.defaultMaxSteps;
    const rplNum = Number(o.roundsPerLevel);
    const roundsPerLevel = Number.isFinite(rplNum) && rplNum >= 1 ? Math.min(64, Math.floor(rplNum)) : SWEEP_DEFAULT_ROUNDS_PER_LEVEL;
    const capNum = Number(o.maxTotalRounds);
    const cap = Number.isFinite(capNum) && capNum >= 1 ? Math.min(4096, Math.floor(capNum)) : SWEEP_DEFAULT_MAX_ROUNDS;
    // 基线任务：显式 task 优先；否则按世界种类铸 difficulty 1 任务（castTask 同律）
    // ΠΑΝ-127：castTask/KIND_ORDER 经端口注入（原直接回借 gym.ts 立法 —— 拆环）
    const explicitTask = o.task !== null && typeof o.task === 'object' ? o.task : null;
    const kind = explicitTask?.kind === 'wizard' ||
        explicitTask?.kind === 'popup-maze' ||
        explicitTask?.kind === 'scroll-hunt' ||
        explicitTask?.kind === 'danger-gate'
        ? explicitTask.kind
        : typeof o.kind === 'string' &&
            ports.kindOrder.includes(o.kind)
            ? o.kind
            : 'wizard';
    const baseTask = explicitTask
        ? explicitTask
        : ports.castTask(0, kind, mulberry32(fnv1a(`w1-4:sweep:task:${master}`)));
    const rawLevels = Array.isArray(o.levels) ? o.levels : [];
    const points = [];
    let roundsRun = 0;
    let truncated = false;
    try {
        for (let i = 0; i < rawLevels.length; i++) {
            const raw = rawLevels[i];
            const entry = raw !== null && typeof raw === 'object' ? raw : {};
            const label = typeof entry.label === 'string' && entry.label.trim() !== '' ? entry.label : `L${i}`;
            const levelNoise = entry.noise !== null && typeof entry.noise === 'object' ? entry.noise : null;
            const rounds = Math.min(roundsPerLevel, cap - roundsRun);
            if (rounds <= 0) {
                truncated = true; // 预算耗尽：本档一轮不剩，整档省略
                break;
            }
            if (rounds < roundsPerLevel)
                truncated = true;
            // 逐轮任务：噪声种子按「主种子×档序×轮序」fnv1a 派生——同 opts 同种子流，
            // 各轮互异（成功率 = 对噪声抽样的统计，非同轮复读）
            const tasks = [];
            for (let j = 0; j < rounds; j++) {
                const noiseSeed = fnv1a(`w1-4:sweep:${master}:${i}:${j}`) % 0x7fffffff;
                tasks.push(levelNoise
                    ? { ...baseTask, noise: { ...levelNoise, seed: noiseSeed } }
                    : baseTask);
            }
            // ΠΑΝ-127：训练营经端口工厂构造（原直接 new AutonomyGym 回借桶 —— 拆环）
            const gym = ports.createGym({ seed: master, maxSteps });
            const results = await gym.runTasks(tasks);
            const successes = results.filter(r => r.success === true).length;
            const avgSteps = results.length > 0
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
    }
    catch {
        /* 防弹承诺：漏网异常不炸诊所——已测成的点照常入曲线 */
    }
    const curve = points.map(p => `${p.label}:${Math.round(p.successRate * 100)}%`).join('→');
    const summary = points.length > 0
        ? `病态诊所扫频${points.length}档${roundsRun}轮：成功率曲线 ${curve}（预算${roundsRun}/${cap}${truncated ? '，截断' : ''}）——完美感知校准，噪声下退化可测。`
        : `病态诊所扫频0档0轮（预算${roundsRun}/${cap}）——无噪声档可测。`;
    return { points, roundsRun, budget: { cap, truncated }, summary };
}
