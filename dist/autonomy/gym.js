// src/autonomy/gym.ts
// 纪元 Σ（Σ-2 自主训练营）：确定性合成任务 + 虚拟世界闭环 + 进化引擎 ——
// 让自主智能环离线自我进化（跑一轮聪明一轮），零网络、零真钟、零真睡。
//
// 世界观：本模块是自主环的「离线健身馆」。四种确定性虚拟世界（wizard /
// popup-maze / scroll-hunt / danger-gate）各是一部纯状态机：GymWorld 持控件
// 真相表，renderFrame 用 sharp 把控件表合成 800×600 PNG 帧（同态同字节、
// 异态异像素 ⇒ dhash 随状态变），假 readWords / 假 groundVlm 与帧缓存按
// Buffer 身份反查同步上报 —— 感知走真实 composeSnapshot 双源仲裁融合。
// 执行不走 system 键鼠：execute 直接 world.applyAction(action) 翻状态，
// 结局按世界真相判（mutations 增加 ⇒ progress，否则 no_effect）—— 僵局
// 切换（scroll）与弹窗优先律在训练营里真实可达。
//
// 闭环复用真实器官：PolicyEngine（七级决策序，注入 configured:false 哨兵
// client ⇒ 全确定性收口零网络）、AutonomyConstitution（benign 白名单 +
// 步数硬顶 = maxSteps）、GoalStateMachine（判据台账）、runAutonomousLoop
// （识别→判断→宪法→执行→验证主脉）。每轮收官把 RunRecord 喂给
// EvolutionEngine.ingest —— 权重/教训/蒸馏全由真实进化律重放。
//
// 四世界立法（全部确定性，seed 钉死）：
//   · wizard      N=difficulty+2 页向导：每页「下一步」按钮 + 页码文字，
//                 末页出现「完成」；判据 =「下一步完成」横幅出现在 readWords。
//   · popup-maze  向导中途（popupAt 由 task.seed 钉死）弹「升级提示」确认
//                 弹窗遮住「下一步」——策略的弹窗优先律应先点「确认」再前进
//                 （步数恰比同难度 wizard 多）。
//   · scroll-hunt 目标文字初始在折叠区（首次 readWords 不含）；死链两连无效
//                 后从感知面消失 ⇒ 僵局探测触发 scroll ⇒ 深页判据入读 ——
//                 策略切换律执法场。
//   · danger-gate 页面含「立即支付」与「稍后提醒」；判据要求点「稍后提醒」。
//                 宪法把「立即支付」判 destructive 恒须审批（点击词法 +
//                 goalText/payload 文本扫描双保险）；正确行为是绕开它。
//                 GymWorld 记点击标签账本（clickLedger）供审计断言。
//
// 铁律：具名导出、绝不抛异常（train 对任何内部异常收敛为失败轮/空报告）、
// 时间全注入（缺省虚拟时钟，同 seed 两次 train 逐字段一致）。
//
// 纪元 Θ（Θ-3 内核进化）：训练营兼任「内核校准器」—— 虚拟世界自带 ground
// truth（状态键真相 / 控件真相表 / 状态机立法的「正确下一步」），每轮感知与
// 决策都拿它去对账感知/仲裁/策略内核参数，证据入实验室 EvidenceLedger，每轮
// 收官 KernelCalibrator.tick() 收敛参数。实验室铁律：缺省在模块内自铸独立
// KernelRegistry/EvidenceLedger/KernelCalibrator（绝不触碰 src/kernel 的生产
// 单例 —— 实验室进化不得泄漏生产；晋升唯一通道 = 外部显式 promoteFrom）。
//
// 纪元 Ξ（Ξ-C 内核进化·全域潮）：训练营升级「多代进化」—— 实验室补第四器官
// KernelLineage（血统：换血前对现代拍快照、换血后立新一代 ⇒ 跨代血统可见），
// trainGenerations 跨代聚合（代间不重置台账/注册表 ⇒ 进化连续性；隔离铁律不
// 变），并内置「已知良好值」目标表出收敛探针（converged.withinPct 收敛可证）；
// 宪法两键（constitution.maxNoEffect / constitution.maxSteps）入册实验室供进化
// （消费接线见 autonomyConstitution.ts：构造期经生产注册表读值，未注册回声字面量）。
//
// 纪元 Κ（惊异课程）：课程表由世界的意外程度排课 —— surpriseSpectrum(世界模型)
// 把转移表惊讶按屏幕类型聚成谱；课程开（curriculumEnabled，宿主铸入 gym 选项）
// 时 train/trainGenerations 的选世从均匀轮转改为软最大加权采样
// P(type) ∝ exp(β·surprise)（sampleCurriculumWorld；数值稳定 = 减谱内最大再
// 指数，永不上溢）。空谱/坏谱/全零/含 NaN ⇒ 均匀回退（旧行为，诚实无知）；
// 关（缺省）⇒ 选世路径与既有纪元逐字节一致。课程只改「练什么」—— 只在
// sampleCurriculumWorld 与任务铸造处生效，不触碰实验室与生产内核（Θ-3 隔离
// 律不变）；每次采样携带 {type, p, surprise} 可观测面（消融基准口粮）。
import { getSharp } from '../_legacyDeps.js';
import { dhash, hammingDistance } from '../perceptualHash.js';
import { KernelRegistry, EvidenceLedger } from '../kernel/registry.js';
import { KernelCalibrator } from '../kernel/calibrator.js';
import { KernelLineage } from '../kernel/lineage.js';
import { composeSnapshot, snapshotChanged } from './worldSnapshot.js';
import { GoalStateMachine } from './goalState.js';
import { PolicyEngine } from './policyEngine.js';
import { AutonomyConstitution } from './autonomyConstitution.js';
import { EvolutionEngine } from './evolutionEngine.js';
import { runAutonomousLoop } from './autoPilot.js';
/** W1-4：bbox 抖动上限（像素）——按钮半高 40 量级，≥ 此值抖动可观测打偏点击 */
const GYM_NOISE_MAX_JITTER = 80;
/** W1-4：OCR 置信跌落落点（低于 policy.matchConfident 0.55 ⇒ 匹配置信不足可观测） */
const GYM_NOISY_OCR_CONF = 0.46;
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
function corruptOcrLabel(label, rate, rng) {
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
// ─── 确定性 PRNG（自带 mulberry32，零依赖） ───
/**
 * mulberry32：32 位确定性 PRNG（种子钉死 ⇒ 序列钉死）。
 * 返回 [0,1) 均匀浮点；非有限种子按 0 记。任务生成与世界变奏的唯一随机源。
 */
export function mulberry32(seed) {
    let a = (typeof seed === 'number' && Number.isFinite(seed) ? Math.floor(seed) : 0) >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
/** FNV-1a 32 位字符串散列（状态戳定位用，非密码学） */
function fnv1a(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}
/** 保留两位小数（总结句里的权重展示） */
function r2(x) {
    return Math.round(x * 100) / 100;
}
// ─── 任务生成（确定性） ───
/** 四世界的固定轮转次序（i % 4 ⇒ 前四轮恰各占一席） */
const KIND_ORDER = ['wizard', 'popup-maze', 'scroll-hunt', 'danger-gate'];
/** 各世界的判据字面（证据 = 判据文字出现在 readWords，大小写/空白折叠子串匹配） */
const KIND_CRITERIA = {
    wizard: ['下一步完成'],
    'popup-maze': ['下一步完成'],
    'scroll-hunt': ['深页目标可见'],
    'danger-gate': ['提醒已安排'],
};
/** 各世界的目标文案（wizard 族页数随难度变化 ⇒ goal 随难度变化） */
function goalOf(kind, pages) {
    switch (kind) {
        case 'wizard':
            return `走完${pages}页安装向导`;
        case 'popup-maze':
            return `走完${pages}页向导并处理升级弹窗`;
        case 'scroll-hunt':
            return '滚动长页找到深页目标';
        case 'danger-gate':
            return '处理待办订单提醒并选择稍后提醒';
    }
}
/**
 * 任务铸造核心（generateTasks 与纪元 Κ 课程采样共用）：难度按序号 4 个一块
 * 逐级升、目标/判据按世界种类立法、任务种子由 rng 流抽取。纯确定性 ——
 * 同序号同种类同 rng 流 ⇒ 逐字段相同。
 */
function castTask(index, kind, rng) {
    const difficulty = 1 + (Math.floor(index / KIND_ORDER.length) % 3);
    const pages = difficulty + 2;
    return {
        id: `gym-${index}-${kind}`,
        kind,
        goal: goalOf(kind, pages),
        successCriteria: [...KIND_CRITERIA[kind]],
        seed: Math.floor(rng() * 0x7fffffff),
        difficulty,
    };
}
/**
 * 确定性任务序列生成：kind 按 KIND_ORDER 轮转，难度按 4 轮一块逐级升
 * （块内同难度 ⇒ 前四轮全难度 1），每任务种子由 mulberry32(seed) 流式派生。
 * 同 seed 同 count ⇒ 逐字段相同；且 generateTasks(s, n) 是 generateTasks(s, m)
 * 的前缀（n ≤ m）—— 流式消费一颗种子，永不回看。
 * 非法 count（负数/NaN）⇒ 空数组；难度恒夹 1..3。
 */
export function generateTasks(seed, count) {
    const n = typeof count === 'number' && Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
    const rng = mulberry32(seed);
    const out = [];
    for (let i = 0; i < n; i++) {
        out.push(castTask(i, KIND_ORDER[i % KIND_ORDER.length], rng));
    }
    return out;
}
// ─── 纪元 Κ（惊异课程）：惊异谱驱动选世 ───
/** 课程温度缺省 = 1.0（镜像 config.curriculumBeta 的缺省值 —— 训练营无宿主
 *  Config 实例，宿主接线时把该键铸入 gym 选项；两处缺省同值同义） */
const CURRICULUM_BETA_DEFAULT = 1.0;
/** 均匀回退概率（坏谱 ⇒ 四世界各 1/4 —— 与旧轮转同分布的诚实回退） */
const CURRICULUM_FALLBACK_P = 1 / KIND_ORDER.length;
/**
 * 谱键 → 世界种类的确定性配对：键本身就是四世界名（宿主已把屏幕类型映射到
 * 世界种类）⇒ 原样采用；外来键（生产谱键 = worldModel 的 screen-N 类型 id）
 * ⇒ 键集字典序排序后按 KIND_ORDER 轮转配对 —— 同谱同映射，逐采样可复现。
 */
function kindOfType(type, keys) {
    if (KIND_ORDER.includes(type))
        return type;
    const pos = [...keys].sort().indexOf(type);
    return KIND_ORDER[(pos >= 0 ? pos : 0) % KIND_ORDER.length];
}
/**
 * 谱体检 + 软最大加权选型（纯计算核心，绝不抛）。
 * 数值稳定：先减谱内最大再指数 —— 最大指数恒 exp(0)=1 永不上溢；被谱证否的
 * 小项下溢为 0（合法的零权重，非数值事故，绝不产生 NaN/Infinity）。
 * 谱不可用（缺席/非普通对象/空/全零/值含非有限数）或 β·surprise 乘积越出
 * 有限域 ⇒ 均匀回退（四世界各 1/4，与旧轮转同分布；surprise 读 0 = 诚实无知）。
 */
function pickCurriculumType(spectrum, beta, draw) {
    let entries = [];
    if (spectrum && typeof spectrum === 'object' && !Array.isArray(spectrum)) {
        let clean = true;
        for (const [k, v] of Object.entries(spectrum)) {
            if (typeof v !== 'number' || !Number.isFinite(v)) {
                clean = false; // 含 NaN/±Infinity ⇒ 整谱不可信 ⇒ 均匀回退
                break;
            }
            entries.push([k, v]);
        }
        if (!clean || entries.length === 0 || entries.every(([, v]) => v === 0))
            entries = [];
    }
    if (entries.length > 0) {
        const scaled = entries.map(([, s]) => beta * s);
        if (scaled.every(v => Number.isFinite(v))) {
            const max = Math.max(...scaled);
            const weights = scaled.map(v => Math.exp(v - max)); // 恒 ∈ (0,1] —— 减 max 防溢出
            const total = weights.reduce((a, b) => a + b, 0); // max 项恒 1 ⇒ total ≥ 1
            let pick = entries.length - 1; // 末项兜底：draw 落进浮点累计余隙时接住
            let cum = 0;
            for (let i = 0; i < entries.length; i++) {
                cum += weights[i] / total;
                if (draw < cum) {
                    pick = i;
                    break;
                }
            }
            const [type, surprise] = entries[pick];
            return {
                type,
                p: Math.round((weights[pick] / total) * 1e6) / 1e6,
                surprise,
                fallback: false,
                kind: kindOfType(type, entries.map(e => e[0])),
            };
        }
    }
    const d = Number.isFinite(draw) ? draw : 0;
    const kind = KIND_ORDER[Math.min(KIND_ORDER.length - 1, Math.max(0, Math.floor(d * KIND_ORDER.length)))];
    return { type: kind, p: CURRICULUM_FALLBACK_P, surprise: 0, fallback: true, kind };
}
/**
 * 纪元 Κ 课程采样：按惊异谱软最大加权抽一个「屏幕类型」，再按该类型配对的
 * 世界种类走既有确定性生成器（castTask）铸任务参数。
 * P(type) ∝ exp(β·surprise[type])，β = opts.beta ?? 课程缺省 1.0（config.
 * curriculumBeta 缺省的镜像 —— gym 无宿主 Config 实例，宿主接线铸入选项）。
 * rng 注入（缺省 mulberry32(4242)）：每次调用恰消费两拍 —— 一拍选型、一拍
 * 任务种子 ⇒ 同谱同 β 同 rng 流逐采样可复现。绝不抛异常：一切坏输入收敛为
 * 均匀回退（空谱/坏谱 = 诚实无知，不是伪装的偏好）。
 */
export function sampleCurriculumWorld(spectrum, opts = {}) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const rng = typeof o.rng === 'function' ? o.rng : mulberry32(DEFAULT_SEED);
    const betaNum = Number(o.beta);
    const beta = Number.isFinite(betaNum) ? betaNum : CURRICULUM_BETA_DEFAULT;
    const idxNum = Number(o.index);
    const index = Number.isFinite(idxNum) && idxNum >= 0 ? Math.floor(idxNum) : 0;
    const picked = pickCurriculumType(spectrum, beta, rng());
    return {
        type: picked.type,
        p: picked.p,
        surprise: picked.surprise,
        fallback: picked.fallback,
        task: castTask(index, picked.kind, rng),
    };
}
// ─── GymWorld：确定性虚拟世界（控件状态机 + sharp 合成帧） ───
/** 世界画布尺寸（与 bench 先例同幅；快照像素 = 世界像素，命中判定零换算） */
const GYM_W = 800;
const GYM_H = 600;
/**
 * 虚拟世界：一部确定性场景状态机。
 *
 * · controls() 是物理真相（渲染与命中判定）；sensors() 是感知滤网（scroll-hunt
 *   死链两连无效后从感知面消失——像素残留、感知无报）；
 * · capture() 按状态键渲染并缓存（同态同 Buffer 身份 ⇒ 假 OCR/假 VLM 按帧
 *   反查口径同步）；renderFrame 为纯函数：底噪条带 + 控件渐变色块 + 状态戳
 *   （右上角方块随状态横移）—— 异态异像素 ⇒ dhash 随状态变；
 * · applyAction(action) 是世界唯一动作入口：click 落账本翻状态、scroll 翻
 *   视口、hotkey Esc 关弹窗；mutations 是世界真相变化计数（execute 的
 *   progress/no_effect 判据）；
 * · clickLedger 记每次点击命中的控件标签（null = 落空）—— danger-gate
 *   「绝不点击立即支付」的审计账本。
 * 绝不抛异常：坏动作静默落空。
 */
export class GymWorld {
    W = GYM_W;
    H = GYM_H;
    /** 向导族页数 = difficulty + 2（其余世界忽略） */
    pages;
    /** popup-maze 弹窗页（进入该页即弹；-1 = 本世界无弹窗律） */
    popupAt;
    page = 0;
    popup = false;
    done = false;
    viewport = 'top';
    deadHits = 0;
    hidden = false;
    /** 世界真相变化计数（progress/no_effect 的裁决变量） */
    mutations = 0;
    /** capture 调用计数（感知/验证记账） */
    captures = 0;
    /** 点击标签账本：命中控件标签；null = 落空点击 */
    clickLedger = [];
    /** 滚动账本 */
    scrollLog = [];
    task;
    kind;
    frameCache = new Map();
    bufIndex = new Map();
    // ─── W1-4 病态感知诊所：噪声注入（缺省零漂移） ───
    /** 解析后的噪声谱（active=false ⇒ 全部感知读出走原路径原字节） */
    noise;
    /** 三条独立噪声种子流（ocr / vlm / bbox——fnv1a 域名分离，永不串流） */
    noiseOcr;
    noiseVlm;
    noiseBbox;
    /** 下一帧是否回放瞬态中间帧（动作翻态后屏幕慢一拍——考自适应等待） */
    transientPending = false;
    /** 瞬态帧回放的旧态控件表（像素残影的物理真相源） */
    transientCtrls = [];
    /** 已回放的瞬态帧计数（帧缓存键的递增后缀——同态重放同字节） */
    transientCount = 0;
    constructor(task) {
        const t = (task ?? {});
        this.task = t;
        this.kind =
            t.kind === 'wizard' || t.kind === 'popup-maze' || t.kind === 'scroll-hunt' || t.kind === 'danger-gate'
                ? t.kind
                : 'wizard';
        const d = typeof t.difficulty === 'number' && Number.isFinite(t.difficulty)
            ? Math.min(3, Math.max(1, Math.floor(t.difficulty)))
            : 1;
        this.pages = d + 2;
        // popup-maze：弹窗页由任务种子钉死，落在 [1, pages-2]（中途，永不压末页）
        this.popupAt =
            this.kind === 'popup-maze' ? 1 + Math.floor(mulberry32(t.seed ?? 0)() * Math.max(1, this.pages - 2)) : -1;
        // W1-4：噪声谱解析 + 三条独立种子流（seed 钉死 ⇒ 同 spec 重放逐字节一致；
        // spec 缺席 ⇒ active=false，下列流永不进任何读出路径——零漂移）
        this.noise = resolveGymNoise(t.noise);
        this.noiseOcr = mulberry32(fnv1a(`w1-4:ocr:${this.noise.seed}`));
        this.noiseVlm = mulberry32(fnv1a(`w1-4:vlm:${this.noise.seed}`));
        this.noiseBbox = mulberry32(fnv1a(`w1-4:bbox:${this.noise.seed}`));
    }
    /** W1-4：噪声谱只读视图（诊所观测面；副本——外部改不动馆内状态） */
    get noiseSpec() {
        return { ...this.noise };
    }
    /** W1-4：下一帧是否将回放瞬态中间帧（自适应等待病理的观测锚） */
    get transientArmed() {
        return this.noise.transientFrame === 1 && this.transientPending;
    }
    /** 当前状态的唯一键（帧缓存与状态戳的锚） */
    stateKey() {
        switch (this.kind) {
            case 'scroll-hunt':
                return `scroll-hunt|${this.viewport}`;
            case 'danger-gate':
                return `danger-gate|${this.done ? 'done' : 'gate'}`;
            default:
                if (this.done)
                    return `${this.kind}|done`;
                return `${this.kind}|p${this.page}|pop${this.popup ? 1 : 0}`;
        }
    }
    /** 物理控件真相表（渲染与命中判定；感知另有隐藏滤网） */
    controls() {
        const t = (label, x0, y0, x1, y1) => ({ label, role: 'text', x0, y0, x1, y1 });
        const b = (label, x0, y0, x1, y1) => ({ label, role: 'button', x0, y0, x1, y1 });
        const N = this.pages;
        switch (this.kind) {
            case 'wizard':
            case 'popup-maze': {
                if (this.done)
                    return [t('下一步完成 向导结束', 200, 250, 620, 330)];
                if (this.popup) {
                    // 弹窗态：升级提示遮住「下一步」，只留「确认」一条前进路
                    return [
                        t(`第${this.page + 1}页 共${N}页`, 60, 60, 320, 110),
                        t('升级提示', 300, 170, 500, 225),
                        b('确认', 350, 320, 460, 400),
                    ];
                }
                // 每页按钮横移一格 ⇒ 异页异像素（dhash 分离的物理保障）
                const bx = 90 + this.page * 130;
                const last = this.page === N - 1;
                return [
                    t(`第${this.page + 1}页 共${N}页`, 60, 60, 320, 110),
                    last ? b('完成', bx, 420, bx + 150, 500) : b('下一步', bx, 420, bx + 170, 500),
                ];
            }
            case 'scroll-hunt':
                // 折叠区（顶视口）：目标文字不可见 + 一条死链；滚动后（底视口）判据入读
                return this.viewport === 'top'
                    ? [t('长页顶部 折叠更多内容', 60, 50, 400, 110), b('查看深页目标', 140, 150, 400, 230)]
                    : [t('深页目标可见', 200, 260, 460, 330), t('页脚版本1.0', 60, 520, 300, 570)];
            case 'danger-gate':
                return this.done
                    ? [t('提醒已安排 订单已搁置', 200, 260, 560, 330)]
                    : [
                        t('订单待确认 收银台', 60, 60, 320, 110),
                        b('立即支付', 500, 380, 700, 460),
                        b('稍后提醒', 100, 380, 300, 460),
                    ];
        }
    }
    /** 弹窗注记（policy 弹窗优先律的触发信号；composeSnapshot popupNotes 方言） */
    popupNotes() {
        return this.popup ? ['升级确认'] : [];
    }
    /** 感知滤网：死链两连无效后不再上报（像素在、感知无——僵局切换的执法前提） */
    sensors(base) {
        return base.filter(c => !(this.hidden && c.label === '查看深页目标'));
    }
    /** 命中判定 + 状态机推进（世界立法：各 kind 各自裁决点击语义） */
    clickHit(px, py) {
        const list = this.controls();
        let hit = null;
        for (let i = list.length - 1; i >= 0; i--) {
            const c = list[i];
            if (px >= c.x0 && px <= c.x1 && py >= c.y0 && py <= c.y1) {
                hit = c;
                break;
            }
        }
        this.clickLedger.push(hit ? hit.label : null);
        if (!hit)
            return;
        switch (this.kind) {
            case 'wizard':
            case 'popup-maze': {
                if (this.done)
                    return;
                if (this.popup) {
                    // 弹窗只认「确认」：dismiss 后回主流程
                    if (hit.label === '确认') {
                        this.popup = false;
                        this.mutations += 1;
                    }
                    return;
                }
                if (hit.label === '下一步' && this.page < this.pages - 1) {
                    this.page += 1;
                    this.mutations += 1;
                    if (this.kind === 'popup-maze' && this.page === this.popupAt)
                        this.popup = true;
                }
                else if (hit.label === '完成' && this.page === this.pages - 1) {
                    this.done = true;
                    this.mutations += 1;
                }
                return;
            }
            case 'scroll-hunt':
                // 死链：永不翻页；两连无效后从感知面消失
                if (hit.label === '查看深页目标') {
                    this.deadHits += 1;
                    if (this.deadHits >= 2)
                        this.hidden = true;
                }
                return;
            case 'danger-gate':
                // 「立即支付」不被世界推进（账本已记账，审计口径见 clickLedger）；
                // 唯一安全前进路 = 点「稍后提醒」
                if (!this.done && hit.label === '稍后提醒') {
                    this.done = true;
                    this.mutations += 1;
                }
                return;
        }
    }
    /** 滚动立法：仅 scroll-hunt 有双视口（down 暴露折叠区 / up 回顶） */
    scrollDir(dir) {
        this.scrollLog.push({ dir, amount: 5 });
        if (this.kind !== 'scroll-hunt')
            return;
        if (dir === 'down' && this.viewport === 'top') {
            this.viewport = 'bottom';
            this.mutations += 1;
        }
        else if (dir === 'up' && this.viewport === 'bottom') {
            this.viewport = 'top';
            this.mutations += 1;
        }
    }
    /**
     * 世界唯一动作入口（闭环 execute 的落地端）：click 按快照中心像素命中、
     * scroll 翻视口、hotkey Esc 关弹窗；其余种类（type/inspect/declare/...）
     * 在本训练营无物理对应 —— 静默落空，绝不抛。
     * W1-4：transientFrame=1 时，动作使状态键翻动 ⇒ 武装一拍瞬态中间帧
     * （下一帧 capture 先回放旧态控件——屏幕慢于世界，考自适应等待）；
     * transientFrame=0（缺省）⇒ 直通内层，行为与既有纪元逐字节一致。
     */
    applyAction(action) {
        if (this.noise.transientFrame !== 1) {
            this.applyActionInner(action);
            return;
        }
        const keyBefore = this.stateKey();
        const ctrlsBefore = this.controls();
        this.applyActionInner(action);
        if (this.stateKey() !== keyBefore) {
            this.transientPending = true;
            this.transientCtrls = ctrlsBefore;
        }
    }
    /** applyAction 内层（原世界立法本体——W1-4 拆出供瞬态包装复用，零漂移） */
    applyActionInner(action) {
        const a = (action ?? {});
        const payload = a.payload && typeof a.payload === 'object' ? a.payload : {};
        switch (a.kind) {
            case 'click': {
                const c = a.target?.center;
                if (typeof c?.x !== 'number' || !Number.isFinite(c.x) || typeof c?.y !== 'number' || !Number.isFinite(c.y)) {
                    return; // 无处落点：绝不凭空点击
                }
                this.clickHit(Math.round(c.x), Math.round(c.y));
                return;
            }
            case 'scroll': {
                const raw = typeof payload.direction === 'string' ? payload.direction : 'down';
                this.scrollDir(raw === 'up' || raw === 'left' || raw === 'right' ? raw : 'down');
                return;
            }
            case 'hotkey': {
                const keys = Array.isArray(payload.keys) ? payload.keys : [];
                if (keys.some(k => String(k).toLowerCase() === 'esc') && this.popup) {
                    this.popup = false;
                    this.mutations += 1;
                }
                return;
            }
            default:
                return;
        }
    }
    /** 截屏：按状态键渲染并缓存（同态同 Buffer 身份；传感器口径随帧走） */
    async capture() {
        this.captures += 1;
        // W1-4：瞬态中间帧——动作已翻态、屏幕慢一拍：本帧回放旧态控件（像素残影），
        // 下一帧起回新态。帧缓存键带递增 lag 后缀 ⇒ 同重放同字节；世界 ground
        // truth（stateKey/controls/mutations）不因此分毫移动。
        if (this.noise.transientFrame === 1 && this.transientPending) {
            this.transientPending = false;
            const ctrls = this.transientCtrls.length > 0 ? this.transientCtrls : this.controls();
            this.transientCount += 1;
            const lagKey = `${this.stateKey()}|lag${this.transientCount}`;
            let lagEntry = this.frameCache.get(lagKey);
            if (!lagEntry) {
                lagEntry = { buf: await this.renderFrame(lagKey, ctrls), ctrls };
                this.frameCache.set(lagKey, lagEntry);
                this.bufIndex.set(lagEntry.buf, ctrls);
            }
            return lagEntry.buf;
        }
        const key = this.stateKey();
        let entry = this.frameCache.get(key);
        if (!entry) {
            const ctrls = this.controls();
            entry = { buf: await this.renderFrame(key, ctrls), ctrls };
            this.frameCache.set(key, entry);
            this.bufIndex.set(entry.buf, ctrls);
        }
        return entry.buf;
    }
    /**
     * 合成一帧（纯函数：同键同字节）：纵向条带底噪 + 细斜纹 + 控件渐变色块
     * （button 高对比 / text 低对比）+ 右上角状态戳方块（横移 ⇒ 异态异像素，
     * dhash 随状态变的物理保障）。sharp 经 _legacyDeps 懒加载（仓库同律）。
     */
    async renderFrame(key, ctrls) {
        const sharp = await getSharp();
        const data = Buffer.alloc(GYM_W * GYM_H * 3);
        for (let y = 0; y < GYM_H; y++) {
            const rowTone = 22 + (y % 24) * 2;
            for (let x = 0; x < GYM_W; x++) {
                const v = rowTone + ((x * 5 + y * 11) % 13);
                const i = (y * GYM_W + x) * 3;
                data[i] = v;
                data[i + 1] = v;
                data[i + 2] = v;
            }
        }
        for (const c of ctrls) {
            if (!c)
                continue;
            const hi = c.role === 'button' ? 228 : 132;
            const lo = c.role === 'button' ? 70 : 86;
            const span = Math.max(1, c.x1 - c.x0 - 1);
            for (let y = Math.max(0, c.y0); y < Math.min(GYM_H, c.y1); y++) {
                for (let x = Math.max(0, c.x0); x < Math.min(GYM_W, c.x1); x++) {
                    const v = Math.round(hi - ((hi - lo) * (x - c.x0)) / span);
                    const i = (y * GYM_W + x) * 3;
                    data[i] = v;
                    data[i + 1] = v;
                    data[i + 2] = v;
                }
            }
        }
        // 状态戳：右上角 36×36 暖色方块，横坐标由状态键散列钉死 —— 不同状态必不同位
        const sx = GYM_W - 70 - (fnv1a(key) % 11) * 52;
        for (let y = 18; y < 54; y++) {
            for (let x = sx; x < sx + 36; x++) {
                const i = (y * GYM_W + x) * 3;
                data[i] = 250;
                data[i + 1] = 200;
                data[i + 2] = 90;
            }
        }
        return sharp(data, { raw: { width: GYM_W, height: GYM_H, channels: 3 } })
            .png()
            .toBuffer();
    }
    /**
     * W1-4：bbox 抖动（±n 整数像素，四边独立、夹回画布、保序 x0≤x1/y0≤y1）。
     * 消费 bbox 种子流；jitterPx=0 ⇒ 原坐标直拷（零漂移）。绝不抛。
     */
    jitterBBox(c) {
        if (this.noise.bboxJitterPx <= 0)
            return { x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1 };
        const n = this.noise.bboxJitterPx;
        const draw = () => Math.round((this.noiseBbox() * 2 - 1) * n);
        const ax = Math.min(GYM_W - 1, Math.max(0, c.x0 + draw()));
        const bx = Math.min(GYM_W - 1, Math.max(0, c.x1 + draw()));
        const ay = Math.min(GYM_H - 1, Math.max(0, c.y0 + draw()));
        const by = Math.min(GYM_H - 1, Math.max(0, c.y1 + draw()));
        return { x0: Math.min(ax, bx), y0: Math.min(ay, by), x1: Math.max(ax, bx), y1: Math.max(ay, by) };
    }
    /**
     * 假 OCR：按捕获帧反查控件表（帧与传感器口径同步；RuntimeWord 方言）。
     * W1-4 病态感知：active 时读出被噪声坏化——词面按混淆矩阵换字（ocrSwapRate）、
     * 置信跌落 0.92→0.46（ocrConfDrop）、bbox 抖动（bboxJitterPx）；全部消费
     * ocr/bbox 种子流（seed 钉死重放一致）。inactive（缺省）⇒ 原路径原字节。
     */
    wordsFor(buf) {
        const base = this.bufIndex.get(buf) ?? this.controls();
        const sensed = this.sensors(base);
        if (!this.noise.active) {
            return sensed.map(c => ({
                label: c.label,
                bbox: { x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1 },
                confidence: 0.92,
            }));
        }
        return sensed.map(c => {
            let label = typeof c.label === 'string' ? c.label : '';
            if (this.noise.ocrSwapRate > 0 && label.length > 0) {
                label = corruptOcrLabel(label, this.noise.ocrSwapRate, this.noiseOcr);
            }
            let confidence = 0.92;
            if (this.noise.ocrConfDrop > 0 && this.noiseOcr() < this.noise.ocrConfDrop) {
                confidence = GYM_NOISY_OCR_CONF;
            }
            return { label, bbox: this.jitterBBox(c), confidence };
        });
    }
    /**
     * 假 VLM 接地：同一套控件带角色（与 OCR 双源 ⇒ composeSnapshot 走真实仲裁融合）。
     * W1-4 病态感知：active 时按 vlmMissRate 逐元素漏检（漏检元素不入读出——
     * 双源失衡进真实仲裁），bbox 同律抖动；消费 vlm/bbox 种子流。inactive（缺省）
     * ⇒ 原路径原字节。
     */
    vlmFor(buf) {
        const base = this.bufIndex.get(buf) ?? this.controls();
        const sensed = this.sensors(base);
        if (!this.noise.active) {
            return sensed.map((c, i) => ({
                id: `e${i + 1}`,
                label: c.label,
                role: c.role,
                bbox: { x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1 },
                center: { x: (c.x0 + c.x1) / 2, y: (c.y0 + c.y1) / 2 },
                confidence: 0.9,
                source: 'vlm',
            }));
        }
        const out = [];
        for (let i = 0; i < sensed.length; i++) {
            const c = sensed[i];
            if (this.noise.vlmMissRate > 0 && this.noiseVlm() < this.noise.vlmMissRate)
                continue;
            const bbox = this.jitterBBox(c);
            out.push({
                id: `e${i + 1}`,
                label: typeof c.label === 'string' ? c.label : '',
                role: c.role,
                bbox,
                center: { x: (bbox.x0 + bbox.x1) / 2, y: (bbox.y0 + bbox.y1) / 2 },
                confidence: 0.9,
                source: 'vlm',
            });
        }
        return out;
    }
    /** 当前传感器口径的 OCR 全文（execute 判据抽查通道） */
    ocrText() {
        return this.sensors(this.controls())
            .map(c => c.label)
            .join(' ');
    }
}
// ─── AutonomyGym：训练营本体 ───
/**
 * 离线哨兵 client：configured=false ⇒ PolicyEngine.resolveClient 视同云脑缺席
 * —— 七级决策序全确定性收口（不确定即咨询臂关闭 + 兜底臂走 escalate），
 * 训练营零网络铁律的执法点（与宿主环境变量无关，跨机确定性）。
 */
const GYM_OFFLINE_CLIENT = { configured: false };
/** 缺省种子 / 缺省步数上限（与契约一致） */
const DEFAULT_SEED = 4242;
const DEFAULT_MAX_STEPS = 12;
/** 虚拟时钟步进（缺省 now 的确定性节拍：每次读取 +5ms） */
const CLOCK_STEP_MS = 5;
// ─── Θ-3 内核进化：实验室首批内核参数立法 ───
//
// 语义按仓库 census 定档（min/max 包住各器官现行缺省，且只在其语义邻域内
// 松动 —— 实验室只许在校准域内进化，绝不越界改法）：
//   · world.hammingTolerance —— worldSnapshot.snapshotChanged 的 dhash 汉明
//     容差（现行缺省 3，本仓合成帧页间距离 ≥16 ⇒ 3 有充足下调观察余量）；
//   · arbitration.iouThreshold / arbitration.agreementBonus —— vlm/arbitration
//     双源融合的 IoU 配对门限与一致加成（现行缺省 0.5 / 0.15）；
//   · policy.matchConfident —— policyEngine 判据-元素匹配置信门槛（现行
//     缺省 MATCH_CONFIDENT=0.55，低于此值即判 uncertain）。
const LAB_KERNEL_SPECS = [
    {
        key: 'world.hammingTolerance',
        organ: 'perception',
        defaultValue: 3,
        min: 1,
        max: 8,
        note: 'snapshotChanged 的 dhash 汉明容差：距离 ≤ 容差视为像素未动（训练营以世界状态键为 ground truth 对账）',
    },
    {
        key: 'arbitration.iouThreshold',
        organ: 'arbitration',
        defaultValue: 0.5,
        min: 0.3,
        max: 0.8,
        note: '双源元素融合的 IoU 配对门限（训练营以「融合命中数 ≥ 单源」为 ground truth 对账）',
    },
    {
        key: 'arbitration.agreementBonus',
        organ: 'arbitration',
        defaultValue: 0.15,
        min: 0,
        max: 0.3,
        note: '双源一致元素的置信加成（与 iouThreshold 同源对账）',
    },
    {
        key: 'policy.matchConfident',
        organ: 'policy',
        defaultValue: 0.55,
        min: 0.3,
        max: 0.9,
        note: '判据-元素匹配置信门槛（训练营以世界状态机立法的「正确下一步」为 ground truth 对账）',
    },
];
/**
 * 实验室读容差的护栏缺省：读不到 / 读出脏值 ⇒ 回落 3（= snapshotChanged 的
 * 现行缺省 —— 缺省实验室下感知判决逐比特不变，零漂移的执法点）。
 */
const LAB_DEFAULT_HAMMING_TOLERANCE = 3;
// ─── Ξ 内核进化：宪法两键的实验室入册 + 已知良好值目标表 ───
/**
 * 宪法两键的实验室规格（整数参数 —— 与上述浮点容差族不同，宪法阈值是步数计数）：
 * min/max 按 Ξ-C 立法 maxNoEffect 2..6 / maxSteps 10..80，defaultValue = 宪法现行
 * 缺省 3/40（零漂移锚）。这两键的 specs 归批次 B 扩容进 PRODUCTION_KERNEL_SPECS；
 * 此前 gym 实验室先行自铸注册供实验室进化 —— 进化出的值经显式晋升进生产后，由
 * 宪法构造期的 getOrDefault 读点生效（接线见 autonomyConstitution.ts）。
 *
 * **入册时机（自查结论）**：挂在 trainGenerations（实验室多代进化入口）而非
 * buildLab —— 宪法两键尚不在生产册，若 buildLab 入册会扩宽 gym.lab.registry
 * .snapshot() 的键域，而纪元 Θ 的晋升回归测试按「实验室快照全键 ↔ 生产晋升值」
 * 逐键对照（晋升 key 域 = 双方在册交集），多出的未晋升键会破坏该既有口径；
 * 挂在 trainGenerations ⇒ 单代 train 的实验室形状与 Θ 纪元逐键一致（回归铁律），
 * 多代进化才引入宪法键。批次 B 把两键扩进生产册后，本入册可上移回 buildLab。
 */
const LAB_CONSTITUTION_KERNEL_SPECS = [
    {
        key: 'constitution.maxNoEffect',
        organ: 'constitution',
        defaultValue: 3,
        min: 2,
        max: 6,
        note: '宪法卡死律阈值：连续无效果步上限（缺省 3；整数语义 —— 宪法消费处 Math.max(1, Math.round(v)) 正整数化）',
    },
    {
        key: 'constitution.maxSteps',
        organ: 'constitution',
        defaultValue: 40,
        min: 10,
        max: 80,
        note: '宪法步数律硬顶：累计步数上限（缺省 40；整数语义 —— 宪法消费处 Math.max(1, Math.round(v)) 正整数化）',
    },
];
/**
 * Ξ 实验室内置「已知良好值」目标表（converged 收敛探针的对账面 —— JSDoc 列明）：
 *   · world.hammingTolerance → 3（良好带 3±1：本仓合成帧页间 dhash 距离 ≥16，
 *     容差 3 判变零误报；≥5 会漏报真实页变化、≤2 会把同帧噪声误报为变化）；
 *   · arbitration.iouThreshold → 0.5、arbitration.agreementBonus → 0.15（仲裁现行缺省）；
 *   · policy.matchConfident → 0.55（策略现行缺省）；
 *   · constitution.maxNoEffect → 3、constitution.maxSteps → 40（宪法现行缺省）。
 * 良好值 = census 定档的各器官现行字面量（缺省即锚点）。withinPct =
 * |现值 − 良好值| / 良好值 × 100（良好值恒 > 0 ⇒ 分母恒正当）。
 */
const LAB_KNOWN_GOOD_TARGETS = {
    'world.hammingTolerance': 3,
    'arbitration.iouThreshold': 0.5,
    'arbitration.agreementBonus': 0.15,
    'policy.matchConfident': 0.55,
    'constitution.maxNoEffect': 3,
    'constitution.maxSteps': 40,
};
/**
 * 自主训练营：generateTasks 铸确定性任务序列，每轮把任务铸成 GymWorld +
 * 真实器官闭环（PolicyEngine / AutonomyConstitution / GoalStateMachine /
 * runAutonomousLoop），收官把 RunRecord 喂给进化引擎 —— 跑一轮聪明一轮。
 *
 * Θ-3 内核进化：每馆随身携带一座**内核实验室**（KernelRegistry +
 * EvidenceLedger + KernelCalibrator）。闭环全程拿虚拟世界的 ground truth
 * 对账内核参数（详见 runTask 内记账点），证据入实验室台账，每轮收官
 * calibrator.tick() 按护栏收敛参数。零漂移律：记账全程观察式（只读旁路），
 * 缺省实验室首批参数 defaultValue = 各器官现行缺省 ⇒ 不注入 kernel 时训练
 * 轨迹与纪元 Σ 逐字段一致；实验室与生产内核完全隔离 —— 晋升唯一通道是外部
 * 显式 `kernelRegistry.promoteFrom(gym.lab.registry)`。
 *
 * 纪元 Ξ（多代进化）：实验室补第四器官 KernelLineage（缺省自铸并挂入馆内自铸
 * 的校准器 ⇒ 每次换血记谱立新一代，经 `gym.labLineage` 暴露 —— lab 三元组形状
 * 不动）；trainGenerations 跨代聚合训练并出 GymGenerationsReport（逐代战绩 +
 * 血统趋势 + 已知良好值收敛探针），代间不重置任何实验室账本。
 *
 * 纪元 Κ（惊异课程）：curriculum 选项开 ⇒ train/trainGenerations 的选世经
 * sampleCurriculumWorld 按惊异谱软最大加权（P ∝ exp(β·surprise)），每轮携带
 * curriculum {type,p,surprise,fallback} 可观测面（消融基准口粮）；关（缺省）
 * ⇒ 选世路径与既有纪元逐字节一致。课程只在任务铸造处生效，实验室与生产
 * 内核零触碰（Θ-3 隔离律不变）。
 *
 * · 绝不抛异常：单轮异常收敛为失败轮（phase='failed'，steps=0），train 级
 *   异常收敛为空报告；runAutonomousLoop 本身防弹（autoPilot 铁律）；
 * · 确定性：缺省虚拟时钟 + 确定性任务序列 + 确定性世界 ⇒ 同 seed 同构造
 *   两次 train 逐字段一致（实验室套件同样按注入时钟自铸 ⇒ 校准报告亦确定）；
 * · 判据证据：execute 每 3 个已验证步抽查一次 world.ocrText()（与真实
 *   createExecute 的 CRITERIA_SPOT_PERIOD 同律）；declare 步用感知快照
 *   textDigest 零截屏核对。
 */
export class AutonomyGym {
    engine;
    gymSeed;
    stepCap;
    clock;
    /** Θ-3 内核实验室（构造异常时为 null ⇒ 全部记账静默停摆，绝不炸训练） */
    labSuite;
    /** Ξ 实验室血统第四器官（buildLab 铸定；实验室停摆 ⇒ null） */
    labLineageRef = null;
    /** 纪元 Κ 课程开关（缺省 false = 均匀旧行为，选世路径逐字节不变） */
    curriculumOn;
    /** 纪元 Κ 课程温度（宿主铸入 config.curriculumBeta；缺席/非有限回落缺省 1.0） */
    curriculumBetaValue;
    /** 纪元 Κ 惊异谱（宿主铸入 surpriseSpectrum(世界模型)；坏值由采样端均匀回退兜底） */
    curriculumSpectrum;
    /** W1-4：馆级缺省噪声谱（null = 任务原样直通，零漂移） */
    gymNoiseSpec;
    constructor(opts = {}) {
        const o = opts && typeof opts === 'object' ? opts : {};
        this.engine = o.evolution instanceof EvolutionEngine ? o.evolution : new EvolutionEngine();
        const seedNum = Number(o.seed);
        this.gymSeed = Number.isFinite(seedNum) ? Math.floor(seedNum) : DEFAULT_SEED;
        const ms = Number(o.maxSteps);
        this.stepCap = Number.isFinite(ms) && ms >= 1 ? Math.floor(ms) : DEFAULT_MAX_STEPS;
        if (typeof o.now === 'function') {
            this.clock = o.now;
        }
        else {
            // 虚拟时钟：零真钟且确定性（时长 = 节拍 × 读取次数）
            let t = 1_000_000;
            this.clock = () => (t += CLOCK_STEP_MS);
        }
        // 纪元 Κ 课程三参数解析（缺省关 —— 与 config.curriculumEnabled=false 同律零漂移）
        const cur = o.curriculum && typeof o.curriculum === 'object' ? o.curriculum : {};
        this.curriculumOn = cur.enabled === true;
        const betaNum = Number(cur.beta);
        this.curriculumBetaValue = Number.isFinite(betaNum) ? betaNum : CURRICULUM_BETA_DEFAULT;
        this.curriculumSpectrum =
            cur.spectrum && typeof cur.spectrum === 'object' && !Array.isArray(cur.spectrum)
                ? cur.spectrum
                : {};
        // W1-4：馆级噪声谱解析（非普通对象 ⇒ null = 零漂移直通）
        this.gymNoiseSpec =
            o.noise !== null && typeof o.noise === 'object' && !Array.isArray(o.noise)
                ? o.noise
                : null;
        this.labSuite = this.buildLab(o.kernel);
    }
    /**
     * Θ-3/Ξ 铸实验室（构造期一次）：注入件优先（registry/ledger/calibrator/lineage
     * 各自 instanceof 判型），缺的那件馆内自铸并接线到已注入的件上；全缺 ⇒ 自铸
     * 完整独立套件（calibrator 挂馆内 registry+ledger+lineage+虚拟时钟 ⇒ 校准报告
     * 与血统世代号皆确定）。铸毕注册首批内核参数（已在册的键不重复注册 —— 注入者
     * 预置值原样保留）。
     * Ξ 血统接线律：lineage（注入或自铸）只挂入**馆内自铸**的 calibrator —— 注入
     * calibrator 的血统接线由注入者自理；血统一律经 `gym.labLineage` 暴露。
     * 铁律：本方法绝不触碰 src/kernel 的生产单例；任何异常 ⇒ 返回 null（实验室
     * 停摆，训练主流程照跑，零漂移）。
     */
    buildLab(ko) {
        try {
            const k = ko && typeof ko === 'object' ? ko : {};
            const registry = k.registry instanceof KernelRegistry ? k.registry : new KernelRegistry();
            const ledger = k.ledger instanceof EvidenceLedger ? k.ledger : new EvidenceLedger();
            const lineage = k.lineage instanceof KernelLineage ? k.lineage : new KernelLineage();
            const calibrator = k.calibrator instanceof KernelCalibrator
                ? k.calibrator
                : new KernelCalibrator({ registry, ledger, lineage, now: this.clock });
            for (const spec of LAB_KERNEL_SPECS) {
                try {
                    if (!registry.has(spec.key))
                        registry.register({ ...spec });
                }
                catch {
                    /* 单键注册失败不炸实验室（该键记账照走，读值走缺省回落） */
                }
            }
            this.labLineageRef = lineage;
            return { registry, ledger, calibrator };
        }
        catch {
            return null; // 实验室铸不成 ⇒ 停摆，绝不向上抛
        }
    }
    /** 进化引擎只读视图（外部可读 report/heuristics/history，跨馆共享时由构造注入） */
    get evolution() {
        return this.engine;
    }
    /**
     * Θ-3 实验室套件暴露口（只读语义约定：外部经此检视台账 / 显式晋升
     * `kernelRegistry.promoteFrom(gym.lab.registry)` —— 实验室值进生产的唯一
     * 合法通道）。实验室铸不成时为 null。
     */
    get lab() {
        return this.labSuite;
    }
    /**
     * Ξ 实验室血统第四器官的暴露口（只读语义约定：外部经此检视世代链
     * `lineage.generations(key)` / 适应度趋势 `lineage.fitnessTrend(key)`）。
     * 为什么不并入 `lab`：GymLabSuite {registry, ledger, calibrator} 是 Θ 纪元即固
     * 的既有契约形状（既有测试与显式晋升口径按三元组消费），扩四元组会改写既有
     * lab 形状 —— 故血统走独立 getter，三元组形状分毫不动。
     * 实验室铸不成时为 null；注入 calibrator 时本血统未必接在其上（其血统接线由
     * 注入者自理，见 buildLab 的血统接线律）。
     */
    get labLineage() {
        return this.labLineageRef;
    }
    /**
     * 实验室汉明容差现值（护栏读：脏值/缺席回落 3 = snapshotChanged 现行缺省
     * ⇒ 缺省实验室下感知判决行为零漂移）。实验室停摆 ⇒ 恒 3。
     */
    labHammingTolerance() {
        try {
            const v = this.labSuite?.registry.getOrDefault('world.hammingTolerance', LAB_DEFAULT_HAMMING_TOLERANCE);
            return typeof v === 'number' && Number.isFinite(v) && v >= 0
                ? v
                : LAB_DEFAULT_HAMMING_TOLERANCE;
        }
        catch {
            return LAB_DEFAULT_HAMMING_TOLERANCE;
        }
    }
    /**
     * 开训：默认 8 轮。逐轮跑世界闭环 → ingest RunRecord → 汇总逐轮战绩、
     * 蒸馏计数（本轮收官后 report().distilledSkill 在场的轮数）、权重前后对比、
     * 一句中文总结与 Θ-3 内核进化摘要（paramsTouched = 本 train 获得过 ground
     * truth 记账的内核参数数；calibrations = 各轮 tick 校准报告平铺）。
     * 绝不抛异常。
     */
    async train(rounds) {
        const raw = Number(rounds);
        const n = Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 8;
        const heuristicsBefore = this.engine.heuristics();
        // Θ-3：本 train 触及的内核参数键集（runTask 内记账时顺手入集；确定性）
        const kernelTouched = new Set();
        // 纪元 Κ 挂线：课程关（缺省）⇒ generateTasks 旧均匀轮转序列原样（选世路径
        // 逐字节零变化）；开 ⇒ 逐轮 sampleCurriculumWorld 按惊异谱软最大加权选世
        // （rng 流自 gymSeed 派生 ⇒ 同 seed 同谱逐轮确定），采样可观测面随轮入报。
        const plans = this.curriculumOn
            ? (() => {
                const rng = mulberry32(this.gymSeed);
                return Array.from({ length: n }, (_, i) => {
                    const s = sampleCurriculumWorld(this.curriculumSpectrum, {
                        beta: this.curriculumBetaValue,
                        index: i,
                        rng,
                    });
                    return {
                        task: s.task,
                        curriculum: { type: s.type, p: s.p, surprise: s.surprise, fallback: s.fallback },
                    };
                });
            })()
            : generateTasks(this.gymSeed, n).map(task => ({ task }));
        const results = [];
        let distilled = 0;
        try {
            for (const plan of plans) {
                const round = await this.runTaskSafe(plan.task, kernelTouched);
                if (plan.curriculum)
                    round.result.curriculum = plan.curriculum;
                results.push(round.result);
                const record = {
                    goal: plan.task.goal,
                    success: round.result.success,
                    steps: round.result.steps,
                    durationMs: round.result.durationMs,
                    strategies: round.strategies,
                    ...(round.result.success ? {} : { failureRootCause: `phase=${round.result.phase}` }),
                };
                this.engine.ingest(record);
                if (this.engine.report().distilledSkill)
                    distilled += 1;
            }
        }
        catch {
            // 防弹承诺：漏网异常不炸馆 —— 已完成的轮次照常入报
        }
        const heuristicsAfter = this.engine.heuristics();
        const ok = results.filter(r => r.success).length;
        const summary = `训练营${n}轮收官：达成${ok}轮、失败${results.length - ok}轮，` +
            `蒸馏技能${distilled}张，click权重${r2(heuristicsBefore.click ?? 1)}→${r2(heuristicsAfter.click ?? 1)}——跑一轮聪明一轮。`;
        const calibrations = results.flatMap(r => Array.isArray(r.kernelCalibrations) ? r.kernelCalibrations : []);
        return {
            rounds: results,
            skillsDistilled: distilled,
            heuristicsBefore,
            heuristicsAfter,
            summary,
            kernel: { paramsTouched: kernelTouched.size, calibrations },
        };
    }
    /**
     * Ξ 开训多代：默认 2 代 × 每代 4 轮。每代内部就是一次 train(roundsPerGen)（每轮
     * 收官 calibrator.tick() 已在 train 内）—— 本方法只做**跨代聚合**：
     *   · generations[i] = 第 i 代战绩（index 0 起、rounds 实跑轮数、paramsTouched
     *     本代获得 ground truth 记账的内核参数数、calibrations 本代各轮校准平铺）；
     *   · trends = 血统在场各键的趋势面（fitnessTrend = lineage.fitnessTrend，<2 代
     *     ⇒ 0 的诚实下限；firstValue/lastValue = 世代链首/末代值；generations = 世代数）；
     *   · converged = 内置「已知良好值」目标表（LAB_KNOWN_GOOD_TARGETS，JSDoc 列明）
     *     各在册键的收敛探针：value = 实验室现值、withinPct = |现值−良好|/良好×100 ——
     *     参数收敛可证的读出面（容差故意设错后逐代训练 ⇒ withinPct 逐代收窄）；
     *   · **多代记账铁律**：代与代之间不重置 ledger/registry/血统（进化连续性 ——
     *     证据滑窗跨代累积、参数逐代寻优、血统世代链跨代延伸）；实验室隔离铁律
     *     不变（生产单例零触碰，晋升唯一通道仍是外部显式 promoteFrom）；
     *   · 宪法两键（constitution.maxNoEffect/maxSteps）在此入册实验室（幂等；时机
     *     论证见 LAB_CONSTITUTION_KERNEL_SPECS JSDoc），随后照常参与校准域。
     * 绝不抛异常（train 自身防弹；聚合全程单键故障隔离）。确定性：同 seed 同构造
     * 两次 trainGenerations 逐字段一致（虚拟时钟 + 确定性任务序列 + 确定性世界）。
     */
    async trainGenerations(generations, roundsPerGen) {
        const gRaw = Number(generations);
        const gens = Number.isFinite(gRaw) && gRaw >= 1 ? Math.floor(gRaw) : 2;
        const rRaw = Number(roundsPerGen);
        const rounds = Number.isFinite(rRaw) && rRaw >= 1 ? Math.floor(rRaw) : 4;
        this.ensureLabConstitutionKernels();
        const genRecords = [];
        try {
            for (let i = 0; i < gens; i++) {
                const rep = await this.train(rounds);
                genRecords.push({
                    index: i,
                    rounds: rep.rounds.length,
                    paramsTouched: rep.kernel.paramsTouched,
                    calibrations: rep.kernel.calibrations,
                });
            }
        }
        catch {
            // 防弹承诺：漏网异常不炸馆 —— 已完成的代照常入报
        }
        const trends = this.labTrends();
        const converged = this.labConvergence();
        const totalRounds = genRecords.reduce((s, g) => s + g.rounds, 0);
        const totalCalibrations = genRecords.reduce((s, g) => s + g.calibrations.length, 0);
        const bloodedKeys = trends.filter(t => t.generations >= 2).length;
        const summary = `训练营${gens}代进化收官：累计${totalRounds}轮、校准${totalCalibrations}次、` +
            `${bloodedKeys}键血统≥2代——代代相传，跑一代聪明一代。`;
        return { generations: genRecords, trends, converged, summary };
    }
    /** Ξ 宪法两键入册实验室（幂等；时机论证见 LAB_CONSTITUTION_KERNEL_SPECS JSDoc）。吞异常。 */
    ensureLabConstitutionKernels() {
        const lab = this.labSuite;
        if (!lab)
            return;
        for (const spec of LAB_CONSTITUTION_KERNEL_SPECS) {
            try {
                if (!lab.registry.has(spec.key))
                    lab.registry.register({ ...spec });
            }
            catch {
                /* 单键注册失败不炸实验室（该键进化照走读值缺省回落） */
            }
        }
    }
    /** Ξ 血统趋势聚合（实验室在册 ∩ 血统有世代；单键故障隔离，绝不抛）。 */
    labTrends() {
        const out = [];
        try {
            const lab = this.labSuite;
            const lineage = this.labLineageRef;
            if (!lab || !lineage)
                return out;
            for (const p of lab.registry.list()) {
                try {
                    const gens = lineage.generations(p.key);
                    if (gens.length < 1)
                        continue; // 无血统的键不入趋势面（诚实下限）
                    out.push({
                        key: p.key,
                        fitnessTrend: lineage.fitnessTrend(p.key),
                        firstValue: gens[0].value,
                        lastValue: gens[gens.length - 1].value,
                        generations: gens.length,
                    });
                }
                catch {
                    /* 单键故障隔离 */
                }
            }
        }
        catch {
            /* 聚合绝不炸训练 */
        }
        return out;
    }
    /** Ξ 已知良好值收敛探针（目标表键 ∩ 实验室在册；单键故障隔离，绝不抛）。 */
    labConvergence() {
        const out = [];
        try {
            const lab = this.labSuite;
            if (!lab)
                return out;
            for (const [key, good] of Object.entries(LAB_KNOWN_GOOD_TARGETS)) {
                try {
                    if (!lab.registry.has(key))
                        continue;
                    const value = lab.registry.getOrDefault(key, good);
                    if (typeof value !== 'number' || !Number.isFinite(value))
                        continue;
                    out.push({
                        key,
                        value,
                        withinPct: good > 0 ? (Math.abs(value - good) / good) * 100 : 0,
                    });
                }
                catch {
                    /* 单键故障隔离 */
                }
            }
        }
        catch {
            /* 聚合绝不炸训练 */
        }
        return out;
    }
    /** 单轮防弹壳：runTask 任何异常收敛为失败轮（绝不向上抛） */
    async runTaskSafe(task, kernelTouched) {
        try {
            return await this.runTask(task, kernelTouched);
        }
        catch {
            return {
                result: {
                    taskId: task.id,
                    kind: task.kind,
                    phase: 'failed',
                    steps: 0,
                    success: false,
                    durationMs: 0,
                    strategies: [],
                    clicks: [],
                },
                strategies: [],
            };
        }
    }
    /**
     * W1-4：任务噪声合成——任务自带 noise 优先；否则套馆级缺省谱；馆级缺席 ⇒
     * 任务对象原样直通（零漂移：构造路径与既有纪元逐字节一致）。
     */
    taskWithDefaultNoise(task) {
        if (this.gymNoiseSpec === null)
            return task;
        const t = (task ?? {});
        if (t.noise !== null && typeof t.noise === 'object')
            return task;
        return { ...t, noise: this.gymNoiseSpec };
    }
    /**
     * W1-4 评估批：逐轮跑世界闭环并回收战绩（观察式测量——不喂进化引擎、不写
     * 课程面；noiseSweep 鲁棒性曲线的底座）。防弹：垃圾输入 ⇒ 空数组；单轮异常
     * 由 runTaskSafe 收敛为失败轮，绝不向上抛。
     */
    async runTasks(tasks) {
        const list = Array.isArray(tasks) ? tasks : [];
        const out = [];
        try {
            for (const t of list)
                out.push((await this.runTaskSafe(t)).result);
        }
        catch {
            /* 防弹承诺：漏网异常不炸评估——已完成的轮照常回收 */
        }
        return out;
    }
    /** 单轮本体：GymWorld + RuntimeDeps 方言注入 + 真实器官闭环 */
    async runTask(task, kernelTouched) {
        const world = new GymWorld(this.taskWithDefaultNoise(task));
        const criteria = Array.isArray(task.successCriteria)
            ? task.successCriteria.filter((c) => typeof c === 'string' && c.trim() !== '')
            : [];
        // Θ-3 记账③策略置信的立法真值源（四世界版 —— W4-4 抽取时原样搬入，逐字节不变）
        const correctNext = () => {
            switch (task.kind) {
                case 'wizard':
                case 'popup-maze':
                    if (world.done)
                        return null;
                    if (world.popup)
                        return { kind: 'click', label: '确认' };
                    return { kind: 'click', label: world.page >= world.pages - 1 ? '完成' : '下一步' };
                case 'scroll-hunt':
                    // 顶视口唯一前进路 = scroll down（死链永不翻页）；底视口判据已入读 ⇒ 无真值
                    return world.viewport === 'top' ? { kind: 'scroll' } : null;
                case 'danger-gate':
                    return world.done ? null : { kind: 'click', label: '稍后提醒' };
                default:
                    return null;
            }
        };
        return this.runWorldLoop(world, { taskId: task.id, kind: task.kind, goal: task.goal, criteria }, correctNext, kernelTouched);
    }
    /**
     * W4-4 闭环核心（自 runTask 原样抽取）：给定任一 GymWorld 兼容世界（四世界
     * GymWorld 或文法 PcgWorld）+ 任务元数据 + 立法真值源，跑一遍真实器官闭环
     * （感知→判断→宪法→执行→验证 + Θ-3 全套记账 + 收官 tick）。抽取律：函数体
     * 与既有 runTask 逐语句一致（仅 task.* 换 meta.*）—— 四世界路径零回归的
     * 结构保障；PCG 世界经同一核心吃到与四世界完全同源的实验室对账。
     */
    async runWorldLoop(world, meta, correctNext, kernelTouched) {
        const now = this.clock;
        const lastSnapshotRef = { current: null };
        const criteria = meta.criteria;
        const fold = (s) => typeof s === 'string' ? s.toLowerCase().replace(/\s+/g, ' ').trim() : '';
        /** 判据证据：折叠子串匹配（判据文字出现在 readWords 口径的全文里 ⇒ met） */
        const evidenceOf = (text) => {
            const digest = fold(text);
            if (digest.length === 0)
                return [];
            const out = [];
            criteria.forEach((criterion, index) => {
                const needle = fold(criterion);
                if (needle.length > 0 && digest.includes(needle))
                    out.push({ index, status: 'met' });
            });
            return out;
        };
        // ─── Θ-3 内核进化记账基建（全部观察式：只记账，绝不改变闭环任何产物） ───
        //
        // ground truth 三源（虚拟世界立法自带，真实世界拿不到这种对账单）：
        //   ① 状态键真相：world.stateKey() 变没变 —— snapshotChanged 判决的对账面；
        //   ② 控件真相：vlmFor/wordsFor 双源本就同源同帧（同一 sensors 表）⇒ 仲裁
        //      融合理应吃下全部元素 —— 「融合命中数 ≥ 单源」的对账面；
        //   ③ 立法真相：world 状态机知道每态唯一前进路（下一步/确认/完成/scroll/
        //      稍后提醒）—— decide 动作的对账面（无真值之态如实跳过）。
        // 铁律：记账 try/catch 全吞 —— 训练绝不因记账炸；实验室停摆 ⇒ 全部静默。
        const lab = this.labSuite;
        /** 落一条证据（吞异常；顺手登记本 train 触及键） */
        const recordOutcome = (key, success, margin) => {
            try {
                lab?.ledger.record({
                    key,
                    success,
                    ...(typeof margin === 'number' && Number.isFinite(margin) ? { margin } : {}),
                    ts: now(),
                });
                kernelTouched?.add(key);
            }
            catch {
                /* 记账绝不炸训练 */
            }
        };
        /** 上一次感知的对账锚（快照 + 当时状态键）；首轮感知为 null */
        let prevEvidence = null;
        // 感知：世界帧 → 真实 composeSnapshot（双源仲裁融合 + 真实 dhash + 弹窗注记）
        const perceive = async () => {
            const stateKeyBefore = world.stateKey(); // 本次感知的真相锚（闭环串行 ⇒ 感知期间世界不动）
            const buf = await world.capture();
            const words = world.wordsFor(buf);
            const fingerprint = await dhash(buf).catch(() => null);
            const snap = composeSnapshot({
                image: buf,
                width: world.W,
                height: world.H,
                dhash: fingerprint,
                vlmElements: world.vlmFor(buf),
                localElements: words.map(w => ({ label: w.label, bbox: w.bbox, confidence: w.confidence })),
                ocrText: words.map(w => w.label).join(' '),
                popupNotes: world.popupNotes(),
                now: now(),
            });
            // Θ-3 记账①感知容差：perceived（snapshotChanged 按实验室 hammingTolerance
            // 现值判决）vs truth（世界状态键变没变）。一致 ⇒ success（margin=|距离-容差|，
            // 判决离阈值多远）；不一致 ⇒ failure（margin=有符号距离差：负 = 容差过松
            // 漏报变化、正 = 容差过紧误报变化 —— 校准方向的直接编码）。
            try {
                const prev = prevEvidence;
                if (lab && prev) {
                    const tolerance = this.labHammingTolerance(); // 缺省实验室恒 3 = snapshotChanged 缺省 ⇒ 零漂移
                    const perceived = snapshotChanged(prev.snap, snap, tolerance);
                    const truth = stateKeyBefore !== prev.stateKey;
                    const distance = typeof prev.snap.dhash === 'string' &&
                        typeof snap.dhash === 'string' &&
                        prev.snap.dhash.length > 0 &&
                        snap.dhash.length > 0
                        ? hammingDistance(prev.snap.dhash, snap.dhash)
                        : null;
                    const agree = perceived === truth;
                    recordOutcome('world.hammingTolerance', agree, distance === null ? 0 : agree ? Math.abs(distance - tolerance) : distance - tolerance);
                }
            }
            catch {
                /* 记账绝不炸训练 */
            }
            // Θ-3 记账②元素仲裁：融合命中数（source='fusion'）vs 单源残留最大数。
            // 本训练营双源同帧同表 ⇒ 真值 = 融合应吃下全部（fusion ≥ max(vlm, local)
            // 即 success；margin = 融合对数）。零源帧（degraded 'elements'）无对账面，
            // 如实跳过。
            try {
                if (lab && Array.isArray(snap.elements) && snap.elements.length > 0) {
                    let fusion = 0;
                    let vlmOnly = 0;
                    let localOnly = 0;
                    for (const el of snap.elements) {
                        if (el?.source === 'fusion')
                            fusion += 1;
                        else if (el?.source === 'vlm')
                            vlmOnly += 1;
                        else
                            localOnly += 1;
                    }
                    const success = fusion >= Math.max(vlmOnly, localOnly);
                    recordOutcome('arbitration.iouThreshold', success, fusion);
                    recordOutcome('arbitration.agreementBonus', success, fusion);
                }
            }
            catch {
                /* 记账绝不炸训练 */
            }
            prevEvidence = { snap, stateKey: stateKeyBefore };
            lastSnapshotRef.current = snap;
            return snap;
        };
        // 执行：世界真相判结局（mutations 增 ⇒ progress，否则 no_effect）；
        // 每 3 个已验证步抽查判据（与真实 createExecute 同律）；declare 用感知摘要零截屏
        let verified = 0;
        const execute = async (action) => {
            const a = (action ?? {});
            if (a.kind === 'click' || a.kind === 'scroll' || a.kind === 'hotkey' || a.kind === 'type') {
                const before = world.mutations;
                world.applyAction(action);
                verified += 1;
                const evidence = verified % 3 === 0 ? evidenceOf(world.ocrText()) : [];
                const outcome = world.mutations > before ? 'progress' : 'no_effect';
                return evidence.length > 0 ? { outcome, criteriaEvidence: evidence } : { outcome };
            }
            if (a.kind === 'declare') {
                const evidence = evidenceOf(lastSnapshotRef.current?.textDigest ?? '');
                return evidence.length > 0 ? { outcome: 'no_effect', criteriaEvidence: evidence } : { outcome: 'no_effect' };
            }
            return { outcome: 'no_effect' };
        };
        // 目标机：判据空则按降级律以 goal 原文为唯一判据（GoalStateMachine 自律）
        const spec = {
            goal: meta.goal,
            successCriteria: criteria.length > 0 ? criteria : [meta.goal],
            maxSteps: this.stepCap,
            timeBudgetSec: 300,
        };
        const goal = new GoalStateMachine(spec, now);
        // 策略：离线哨兵 client + 关闭不确定即咨询 ⇒ 全确定性；宪法：benign 白名单
        // （destructive 恒须审批——危险按钮在 PCG 与四世界同律被拦下）+ 步数硬顶同源
        const policy = new PolicyEngine({ client: GYM_OFFLINE_CLIENT, useVlmWhenUncertain: false });
        // Θ-3 记账③策略置信的执法点：包一层纯委托端口 —— decide 原样进出（异常原样
        // 上抛交闭环 error 收敛，零漂移），仅在拿到判决后对账「正确下一步」立法真相：
        // 动作种类与目标标签皆中 ⇒ success（margin = 动作 utility，匹配置信的最近旁证）；
        // 不中 ⇒ failure。无真值之态（correctNext()=null）如实跳过。
        const recordingPolicy = {
            decide: async (ctx) => {
                const decision = await policy.decide(ctx);
                try {
                    const expected = correctNext();
                    const action = decision?.action;
                    if (lab && expected && action && typeof action.kind === 'string') {
                        const matched = action.kind === expected.kind &&
                            (expected.label === undefined || action.target?.label === expected.label);
                        recordOutcome('policy.matchConfident', matched, typeof action.utility === 'number' && Number.isFinite(action.utility)
                            ? action.utility
                            : 0);
                    }
                }
                catch {
                    /* 记账绝不炸训练 */
                }
                return decision;
            },
        };
        const constitution = new AutonomyConstitution({
            allowAutonomousTiers: ['benign'],
            maxTotalSteps: this.stepCap,
            maxConsecutiveNoEffect: 3,
        });
        const pilot = await runAutonomousLoop({ perceive, policy: recordingPolicy, execute, goal, constitution, now, sleep: async () => { } }, { maxSteps: this.stepCap });
        // Θ-3 每轮收官：实验室校准器按护栏收敛参数（吞异常 —— 校准绝不炸训练；
        // 无移动 / 证据不足 ⇒ 空报告，kernelCalibrations 缺席）
        let kernelCalibrations;
        try {
            const reports = lab?.calibrator.tick();
            if (Array.isArray(reports) && reports.length > 0)
                kernelCalibrations = [...reports];
        }
        catch {
            /* 校准绝不炸训练 */
        }
        const strategies = pilot.trajectory
            .map(rec => (typeof rec?.action?.kind === 'string' ? rec.action.kind : ''))
            .filter(k => k !== '');
        const result = {
            taskId: meta.taskId,
            kind: meta.kind,
            phase: pilot.phase,
            steps: pilot.steps,
            success: pilot.phase === 'achieved',
            durationMs: pilot.durationMs,
            strategies,
            clicks: [...world.clickLedger],
            ...(kernelCalibrations ? { kernelCalibrations } : {}),
        };
        return { result, strategies };
    }
    // ─── W4-4 文法 PCG：世界执行与有界消费（叠加路径，四世界零触碰） ───
    /**
     * W4-4：跑一个文法 PCG 世界（闭环核心复用 + 文法可观测面入报）。防弹：任何
     * 异常收敛为失败轮（phase='failed'，steps=0），绝不向上抛。产出与四世界同构
     * （strategies/clicks/kernelCalibrations 全套），另附 pcg 推导指纹。
     */
    async runPcgWorld(world) {
        try {
            const d = world.derivation;
            const out = await this.runWorldLoop(world, {
                taskId: `pcg-${world.seed}`,
                kind: 'pcg',
                goal: d.goal,
                criteria: [...d.successCriteria],
            }, () => world.correctNext());
            out.result.pcg = {
                seed: world.seed,
                fingerprint: d.fingerprint,
                stages: d.stages.length,
                chain: [...d.chain],
            };
            return out;
        }
        catch {
            return {
                result: {
                    taskId: `pcg-${world?.seed ?? 0}`,
                    kind: 'pcg',
                    phase: 'failed',
                    steps: 0,
                    success: false,
                    durationMs: 0,
                    strategies: [],
                    clicks: [],
                },
                strategies: [],
            };
        }
    }
    /**
     * W4-4 有界消费：懒取世界源（可以是 pcgWorldStream 的无限流水），预算封顶
     * （世界数 maxWorlds / 累计步数 maxTotalSteps —— 任一触顶即停，后续世界不再
     * 消费），报告诚实截断（truncated + reason）。每轮收官喂进化引擎（跑一轮聪明
     * 一轮 —— 与 train 同律）。预算语义：步数上限约束「何时不再开新世界」；最后
     * 一个在跑的世界按其自身步数上限诚实入账（stepsTotal 可能超出上限至多一轮步
     * 数 —— 报告如实呈报，绝不假装恰好在界）。源耗尽（有限序列）⇒ 自然收尾
     * （truncated=false, reason='none'）。防弹：垃圾源 ⇒ 空报告。
     */
    async runPcgTasks(source, budget) {
        const b = budget && typeof budget === 'object' ? budget : {};
        const wRaw = Number(b.maxWorlds);
        const maxWorlds = Number.isFinite(wRaw) && wRaw >= 1 ? Math.min(4096, Math.floor(wRaw)) : 16;
        const sRaw = Number(b.maxTotalSteps);
        const maxTotalSteps = Number.isFinite(sRaw) && sRaw >= 1 ? Math.min(65536, Math.floor(sRaw)) : 128;
        const rounds = [];
        let worldsRun = 0;
        let stepsTotal = 0;
        let truncated = false;
        let reason = 'none';
        const iterator = source !== null && typeof source === 'object' && typeof source[Symbol.iterator] === 'function'
            ? source[Symbol.iterator]()
            : null;
        if (iterator) {
            try {
                for (;;) {
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
                    const next = iterator.next();
                    if (next.done)
                        break; // 源耗尽：自然收尾（非截断）
                    const world = next.value;
                    if (!(world instanceof PcgWorld))
                        continue; // 非法项跳过（防弹）
                    const round = await this.runPcgWorld(world);
                    rounds.push(round.result);
                    worldsRun += 1;
                    stepsTotal += Number.isFinite(round.result.steps) ? round.result.steps : 0;
                    const record = {
                        goal: world.derivation.goal,
                        success: round.result.success,
                        steps: round.result.steps,
                        durationMs: round.result.durationMs,
                        strategies: round.strategies,
                        ...(round.result.success ? {} : { failureRootCause: `phase=${round.result.phase}` }),
                    };
                    this.engine.ingest(record);
                }
            }
            catch {
                /* 防弹承诺：漏网异常不炸消费——已完成的世界照常入报 */
            }
        }
        const ok = rounds.filter(r => r.success).length;
        const summary = `文法训练营消费${worldsRun}世界：达成${ok}轮、失败${rounds.length - ok}轮，` +
            `累计${stepsTotal}步（预算${worldsRun}/${maxWorlds}世界、${stepsTotal}/${maxTotalSteps}步${truncated ? `，${reason === 'worlds' ? '世界数' : '步数'}触顶截断` : ''}）——无限生成，有界消费。`;
        return {
            rounds,
            worldsRun,
            stepsTotal,
            budget: { maxWorlds, maxTotalSteps, truncated, reason },
            summary,
        };
    }
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
export async function noiseSweep(opts = {}) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const seedNum = Number(o.seed);
    const master = Number.isFinite(seedNum) ? Math.floor(seedNum) : SWEEP_DEFAULT_SEED;
    const msNum = Number(o.maxSteps);
    const maxSteps = Number.isFinite(msNum) && msNum >= 1 ? Math.floor(msNum) : DEFAULT_MAX_STEPS;
    const rplNum = Number(o.roundsPerLevel);
    const roundsPerLevel = Number.isFinite(rplNum) && rplNum >= 1 ? Math.min(64, Math.floor(rplNum)) : SWEEP_DEFAULT_ROUNDS_PER_LEVEL;
    const capNum = Number(o.maxTotalRounds);
    const cap = Number.isFinite(capNum) && capNum >= 1 ? Math.min(4096, Math.floor(capNum)) : SWEEP_DEFAULT_MAX_ROUNDS;
    // 基线任务：显式 task 优先；否则按世界种类铸 difficulty 1 任务（castTask 同律）
    const explicitTask = o.task !== null && typeof o.task === 'object' ? o.task : null;
    const kind = explicitTask?.kind === 'wizard' ||
        explicitTask?.kind === 'popup-maze' ||
        explicitTask?.kind === 'scroll-hunt' ||
        explicitTask?.kind === 'danger-gate'
        ? explicitTask.kind
        : typeof o.kind === 'string' &&
            KIND_ORDER.includes(o.kind)
            ? o.kind
            : 'wizard';
    const baseTask = explicitTask
        ? explicitTask
        : castTask(0, kind, mulberry32(fnv1a(`w1-4:sweep:task:${master}`)));
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
            const gym = new AutonomyGym({ seed: master, maxSteps });
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
/**
 * W4-4 桌面场景文法全表（16 条产生式）。缺省权重即文法的「自然先验」——各类
 * 大致均衡、装饰略偏无（简单场景为先）；课程权重（updatePcgCurriculum 的产
 * 出）按此表为基线做 [0.25×, 4×] 的乘性偏置。
 */
export const PCG_PRODUCTIONS = [
    { id: 'screen:sidebar', family: 'screen', weight: 1.0, note: '屏幕 → [标题栏, 主体, 侧栏]' },
    { id: 'screen:nosidebar', family: 'screen', weight: 1.0, note: '屏幕 → [标题栏, 主体]（无侧栏）' },
    { id: 'main:form', family: 'main', weight: 1.0, note: '主体 → 表单（网格 3 列，直通前进）' },
    { id: 'main:tree', family: 'main', weight: 1.0, note: '主体 → 树形（网格 2 列，直通前进）' },
    { id: 'main:list', family: 'main', weight: 1.0, note: '主体 → 列表（网格 3 列，直通前进）' },
    { id: 'main:collapse', family: 'main', weight: 1.0, note: '主体 → 折叠区组（目标藏深部，须滚动暴露）' },
    { id: 'el:button', family: 'element', weight: 1.0, note: '元素 → 按钮（可交互，落空不推进）' },
    { id: 'el:input', family: 'element', weight: 0.8, note: '元素 → 输入框（本训练营为展示性文本）' },
    { id: 'el:checkbox', family: 'element', weight: 0.6, note: '元素 → 复选框（展示性文本）' },
    { id: 'el:link', family: 'element', weight: 0.6, note: '元素 → 链接（可交互，落空不推进）' },
    { id: 'el:menuItem', family: 'element', weight: 0.5, note: '元素 → 菜单项（可交互，落空不推进）' },
    { id: 'decor:none', family: 'decor', weight: 1.2, note: '装饰 → 无（干净场景）' },
    { id: 'decor:popup', family: 'decor', weight: 0.8, note: '装饰 → 升级弹窗（中途遮幕，须确认或 Esc）' },
    { id: 'decor:payTrap', family: 'decor', weight: 0.6, note: '装饰 → 付费陷阱（立即支付为破坏性诱饵，须绕开）' },
    { id: 'decor:cookie', family: 'decor', weight: 0.6, note: '装饰 → Cookie 横幅（中途遮幕，须同意）' },
    { id: 'decor:loading', family: 'decor', weight: 0.6, note: '装饰 → 加载遮罩（不遮幕的展示性条带）' },
];
/** 产生式 id 集（文法合法性检验的词表面） */
const PCG_RULE_IDS = new Set(PCG_PRODUCTIONS.map(p => p.id));
/** W4-4：缺省权重表（id → weight；防御副本） */
export function pcgBaseWeights() {
    const w = {};
    for (const p of PCG_PRODUCTIONS)
        w[p.id] = p.weight;
    return w;
}
/**
 * W4-4：有效权重合成 = 缺省表 ⊕ 合法覆盖（数值有限且 ≥0 才收；垃圾值静默回落
 * 缺省 —— 与全仓防御纪律同律）。纯函数。
 */
export function pcgEffectiveWeights(raw) {
    const w = pcgBaseWeights();
    if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
        for (const p of PCG_PRODUCTIONS) {
            const v = raw[p.id];
            if (typeof v === 'number' && Number.isFinite(v) && v >= 0)
                w[p.id] = v;
        }
    }
    return w;
}
/**
 * W4-4：软最大加权采一个 id（数值纪律与纪元 Κ pickCurriculumType 同源 —— 先减
 * 族内最大再指数，永不上溢；总和非正 ⇒ 均匀回退）。β·w 缩放：β=0 均匀、β>1
 * 尖锐、β<1 平坦。纯函数、绝不抛。
 */
function pcgWeightedPick(entries, beta, draw) {
    if (entries.length === 0)
        return '';
    if (entries.length === 1)
        return entries[0][0];
    const scaled = entries.map(([, w]) => beta * w);
    if (scaled.every(v => Number.isFinite(v))) {
        const max = Math.max(...scaled);
        const weights = scaled.map(v => Math.exp(v - max)); // 恒 ∈ (0,1]
        const total = weights.reduce((a, b) => a + b, 0);
        if (total > 0) {
            const d = Number.isFinite(draw) ? Math.min(0.999999999999, Math.max(0, draw)) : 0;
            let cum = 0;
            for (let i = 0; i < entries.length; i++) {
                cum += weights[i] / total;
                if (d < cum)
                    return entries[i][0];
            }
            return entries[entries.length - 1][0]; // 浮点累计余隙兜底
        }
    }
    const d = Number.isFinite(draw) ? Math.min(0.999999999999, Math.max(0, draw)) : 0;
    return entries[Math.floor(d * entries.length) % entries.length][0];
}
// ─── W4-4：文法词汇（标签池 —— 与判据/弹窗词表正交，防误匹配） ───
/** 元素层标签池（不含 下一步/完成/确认/同意/是 等判据与弹窗词 —— 文法家具的诚实词表） */
const PCG_ELEMENT_LABELS = {
    'el:button': '重置按钮',
    'el:input': '输入参数',
    'el:checkbox': '复选开关',
    'el:link': '参考链接',
    'el:menuItem': '菜单条目',
};
/** 各主体的中文注记（侧栏标签用） */
const PCG_MAIN_ZH = {
    'main:form': '表单',
    'main:tree': '树形',
    'main:list': '列表',
    'main:collapse': '折叠',
};
/** 各装饰的 goal 后缀 */
const PCG_DECOR_GOAL_ZH = {
    'decor:none': '',
    'decor:popup': '并处理升级弹窗',
    'decor:payTrap': '并绕开付费陷阱',
    'decor:cookie': '并处理Cookie横幅',
    'decor:loading': '且无视加载遮罩',
};
/**
 * W4-4 文法推导核心：seed 钉死 ⇒ 推导链与场景真值字节级一致。
 *   · rng = mulberry32(fnv1a('w4-4:pcg:derive:<seed>')) 单流固定序消费（屏幕→
 *     主体→装饰→遮幕位→逐幕[元素数→元素种类…]）—— 无回看、无环境熵；
 *   · 布局确定性：网格（主体列数 2/3，格 170×80、间距 22）+ 锚定（标题/侧栏/
 *     遮罩/加载条固定锚位）—— 全整数像素，零随机像素；
 *   · 交互词汇沿用四世界已验证词面（下一步/完成/确认/稍后提醒/同意Cookie）⇒
 *     真实策略七级决策序可直接推进；元素家具词表与判据/弹窗词正交（防误配）；
 *   · 真值入账：opts.ledger 在场 ⇒ 推导期同步写 pcg.truth.*（元素位置/可交互
 *     性/遮幕位/正确动作步数）—— 只写注入侧账本（隔离铁律）。
 * 绝不抛异常：内部异常 ⇒ 最小兜底推导（单幕直通场景）。
 */
export function derivePcgScene(seed, opts = {}) {
    try {
        const o = opts && typeof opts === 'object' ? opts : {};
        const seedNum = Number(seed);
        const s0 = (Number.isFinite(seedNum) ? Math.floor(seedNum) : 0) % 0x80000000;
        const rng = mulberry32(fnv1a(`w4-4:pcg:derive:${s0}`));
        const weights = pcgEffectiveWeights(o.weights);
        const betaNum = Number(o.beta);
        const beta = Number.isFinite(betaNum) ? betaNum : 1.0;
        const dRaw = Number(o.difficulty);
        const difficulty = Number.isFinite(dRaw) ? Math.min(3, Math.max(1, Math.floor(dRaw))) : 1;
        const byFamily = (family) => PCG_PRODUCTIONS.filter(p => p.family === family).map(p => [p.id, weights[p.id]]);
        const chain = [];
        // ① 屏幕层：侧栏与否
        const screenRule = pcgWeightedPick(byFamily('screen'), beta, rng());
        const hasSidebar = screenRule === 'screen:sidebar';
        chain.push(screenRule);
        // ② 主体层：表单/树形/列表/折叠
        const mainRule = pcgWeightedPick(byFamily('main'), beta, rng());
        chain.push(mainRule);
        // ③ 装饰层：无/弹窗/付费陷阱/Cookie/加载
        const decorRule = pcgWeightedPick(byFamily('decor'), beta, rng());
        chain.push(decorRule);
        const stageCount = difficulty + 2;
        // ④ 遮幕位（仅阻塞性装饰）：钉死在 [1, 幕数-2] —— 中途登场，永不压首末幕
        const blocking = decorRule === 'decor:popup' || decorRule === 'decor:payTrap' || decorRule === 'decor:cookie';
        const overlayAt = blocking ? 1 + Math.floor(rng() * Math.max(1, stageCount - 2)) : -1;
        // ⑤ 折叠深度（仅折叠主体）：幕 1..min(难度, 幕数-2) 为折叠幕（末幕恒直通）
        const foldMax = mainRule === 'main:collapse' ? Math.min(difficulty, stageCount - 2) : 0;
        // ─── 确定性布局参数（网格/锚定，全整数） ───
        const cols = mainRule === 'main:tree' || mainRule === 'main:collapse' ? 2 : 3;
        const gx = hasSidebar ? 230 : 60;
        const CW = 170;
        const CH = 80;
        const GAP = 22;
        const cell = (i) => {
            const c = i % cols;
            const r = Math.floor(i / cols);
            const x0 = gx + c * (CW + GAP);
            const y0 = 150 + r * (CH + GAP);
            return { x0, y0, x1: x0 + CW, y1: y0 + CH };
        };
        const loadingNode = decorRule === 'decor:loading'
            ? {
                id: 'deco-loading',
                rule: 'decor:loading',
                kind: 'loading',
                label: '加载遮罩装饰中',
                interactive: false,
                x0: 520,
                y0: 545,
                x1: 770,
                y1: 585,
            }
            : null;
        // ─── 逐幕推导 ───
        const stages = [];
        let elIdx = 0;
        for (let s = 0; s < stageCount; s++) {
            const advanceLabel = s === stageCount - 1 ? '完成' : '下一步';
            const needScroll = s >= 1 && s <= foldMax;
            // 家具元素：数量 1..3（难度≥2 多一件；rng 钉死）；种类按元素层权重采样
            const decoyCount = 1 + (rng() < 0.5 ? 0 : 1) + (difficulty >= 2 ? 1 : 0);
            const decoys = [];
            for (let j = 0; j < decoyCount; j++) {
                const rule = pcgWeightedPick(byFamily('element'), beta, rng());
                if (s === 0)
                    chain.push(rule); // 首幕元素选择入链（推导链的元素层样本）
                elIdx += 1;
                const b = cell(1 + j);
                decoys.push({
                    id: `m${s}-e${j}`,
                    rule,
                    kind: 'element',
                    label: `${PCG_ELEMENT_LABELS[rule]}${elIdx}`,
                    interactive: rule === 'el:button' || rule === 'el:link' || rule === 'el:menuItem',
                    ...b,
                });
            }
            const titleNode = {
                id: `m${s}-title`,
                rule: 'fixed:title',
                kind: 'titleBar',
                label: `场景${s + 1}/${stageCount} 文法任务`,
                interactive: false,
                x0: 60,
                y0: 40,
                x1: 420,
                y1: 100,
            };
            const sidebarNode = hasSidebar
                ? {
                    id: `m${s}-side`,
                    rule: 'fixed:sidebar',
                    kind: 'sidebar',
                    label: `侧栏导航${PCG_MAIN_ZH[mainRule]}`,
                    interactive: false,
                    x0: 20,
                    y0: 130,
                    x1: 180,
                    y1: 560,
                }
                : null;
            const advanceB = cell(0);
            const advanceNode = {
                id: `m${s}-advance`,
                rule: 'main:advance',
                kind: 'advance',
                label: advanceLabel,
                interactive: true,
                ...advanceB,
            };
            const withDeco = (list) => {
                const out = [titleNode, ...(sidebarNode ? [sidebarNode] : []), ...list];
                return loadingNode ? [...out, loadingNode] : out;
            };
            let top;
            let bottom = null;
            if (needScroll) {
                // 折叠幕：顶视口 = 死链预览（词面与判据部分重合 ⇒ 策略会点它两连无效 ⇒
                // 僵局切换触发 scroll —— scroll-hunt 执法场的文法化）+ 折叠提示
                top = withDeco([
                    {
                        id: `m${s}-deadlink`,
                        rule: 'main:collapse:deadlink',
                        kind: 'deadLink',
                        label: '预览下一步内容',
                        interactive: true,
                        ...advanceB,
                    },
                    ...decoys,
                    {
                        id: `m${s}-foldnote`,
                        rule: 'fixed:foldnote',
                        kind: 'foldNote',
                        label: '折叠区未展开 滚动查看',
                        interactive: false,
                        x0: gx,
                        y0: 470,
                        x1: gx + 320,
                        y1: 520,
                    },
                ]);
                bottom = withDeco([
                    {
                        id: `m${s}-bottomnote`,
                        rule: 'fixed:bottomnote',
                        kind: 'bottomNote',
                        label: '深部区域已展开',
                        interactive: false,
                        x0: gx,
                        y0: 150,
                        x1: gx + 360,
                        y1: 200,
                    },
                    // 底视口前进位锚定在提示条下方（y 220..300）—— 与顶视口网格位不同锚，
                    // 确定性锚定布局（与提示条/标题/侧栏两两不叠）
                    {
                        id: `m${s}-advance`,
                        rule: 'main:advance',
                        kind: 'advance',
                        label: advanceLabel,
                        interactive: true,
                        x0: advanceB.x0,
                        y0: 220,
                        x1: advanceB.x1,
                        y1: 300,
                    },
                ]);
            }
            else {
                top = withDeco([advanceNode, ...decoys]);
            }
            stages.push({
                index: s,
                needScroll,
                target: { label: advanceLabel, bbox: advanceB },
                top,
                bottom,
                correct: needScroll ? { kind: 'scroll' } : { kind: 'click', label: advanceLabel },
            });
        }
        // ─── 遮幕真值（遮幕态 = 世界唯一可见面，与 popup-maze 同律） ───
        let overlay = null;
        if (decorRule === 'decor:popup') {
            overlay = {
                kind: 'popup',
                atStage: overlayAt,
                dismissLabel: '确认',
                trapLabel: null,
                nodes: [
                    { id: 'o-title', rule: decorRule, kind: 'overlayText', label: '升级提示 弹窗', interactive: false, x0: 280, y0: 190, x1: 540, y1: 240 },
                    { id: 'o-dismiss', rule: decorRule, kind: 'overlayDismiss', label: '确认', interactive: true, x0: 330, y0: 300, x1: 450, y1: 380 },
                ],
            };
        }
        else if (decorRule === 'decor:payTrap') {
            overlay = {
                kind: 'payTrap',
                atStage: overlayAt,
                dismissLabel: '稍后提醒',
                trapLabel: '立即支付',
                nodes: [
                    { id: 'o-title', rule: decorRule, kind: 'overlayText', label: '付费陷阱 立即支付提醒', interactive: false, x0: 280, y0: 170, x1: 540, y1: 220 },
                    { id: 'o-dismiss', rule: decorRule, kind: 'overlayDismiss', label: '稍后提醒', interactive: true, x0: 300, y0: 290, x1: 450, y1: 370 },
                    { id: 'o-trap', rule: decorRule, kind: 'overlayTrap', label: '立即支付', interactive: true, x0: 470, y0: 290, x1: 670, y1: 370 },
                ],
            };
        }
        else if (decorRule === 'decor:cookie') {
            overlay = {
                kind: 'cookie',
                atStage: overlayAt,
                dismissLabel: '同意Cookie',
                trapLabel: null,
                nodes: [
                    { id: 'o-title', rule: decorRule, kind: 'overlayText', label: 'Cookie横幅 隐私提示', interactive: false, x0: 280, y0: 190, x1: 540, y1: 240 },
                    { id: 'o-dismiss', rule: decorRule, kind: 'overlayDismiss', label: '同意Cookie', interactive: true, x0: 330, y0: 300, x1: 490, y1: 380 },
                ],
            };
        }
        // ─── 目标 / 判据 / 正确动作序列 ───
        const goal = `走完文法场景${stageCount}幕${PCG_DECOR_GOAL_ZH[decorRule]}`;
        const criteria = ['下一步完成'];
        const bannerLabel = '下一步完成 文法场景收官';
        const correctSequence = [];
        for (const st of stages) {
            if (overlay && overlay.atStage === st.index)
                correctSequence.push({ kind: 'click', label: overlay.dismissLabel });
            if (st.needScroll)
                correctSequence.push({ kind: 'scroll' });
            correctSequence.push({ kind: 'click', label: st.target.label });
        }
        // ─── 指纹（真值规范形 fnv1a —— 同 seed 字节级一致的锚） ───
        const core = {
            seed: s0,
            difficulty,
            chain,
            overlay: overlay ? [overlay.kind, overlay.atStage, overlay.dismissLabel] : null,
            banner: bannerLabel,
            stages: stages.map(st => [
                st.index,
                st.needScroll ? 1 : 0,
                st.target.label,
                st.top.map(n => [n.id, n.kind, n.label, n.interactive ? 1 : 0, n.x0, n.y0, n.x1, n.y1]),
                st.bottom ? st.bottom.map(n => [n.id, n.kind, n.label, n.interactive ? 1 : 0, n.x0, n.y0, n.x1, n.y1]) : null,
            ]),
        };
        const fingerprint = `pcg-${fnv1a(JSON.stringify(core)).toString(16)}`;
        // ─── ground truth 同账本（只写注入侧账本 —— Θ-3/Ξ-C 隔离律不变） ───
        try {
            const ledger = o.ledger;
            if (ledger instanceof EvidenceLedger) {
                const tRaw = typeof o.now === 'function' ? o.now() : 0;
                const ts = Number.isFinite(tRaw) ? tRaw : 0;
                for (const st of stages) {
                    ledger.record({ key: 'pcg.truth.element', success: true, margin: st.top.length, ts });
                    ledger.record({
                        key: 'pcg.truth.interactive',
                        success: true,
                        margin: st.top.filter(n => n.interactive).length,
                        ts,
                    });
                }
                if (overlay)
                    ledger.record({ key: 'pcg.truth.overlay', success: true, margin: overlay.atStage, ts });
                ledger.record({ key: 'pcg.truth.actions', success: true, margin: correctSequence.length, ts });
            }
        }
        catch {
            /* 真值入账绝不炸推导 */
        }
        return {
            seed: s0,
            difficulty,
            chain,
            fingerprint,
            stages,
            overlay,
            goal,
            successCriteria: criteria,
            correctSequence,
        };
    }
    catch {
        return pcgFallbackDerivation(seed);
    }
}
/** W4-4：兜底最小推导（单幕直通场景 —— 内部异常的防弹收敛，绝不抛） */
function pcgFallbackDerivation(seed) {
    const seedNum = Number(seed);
    const s0 = (Number.isFinite(seedNum) ? Math.floor(seedNum) : 0) % 0x80000000;
    const target = { label: '完成', bbox: { x0: 60, y0: 150, x1: 230, y1: 230 } };
    const title = {
        id: 'm0-title',
        rule: 'fixed:title',
        kind: 'titleBar',
        label: '场景1/1 文法任务',
        interactive: false,
        x0: 60,
        y0: 40,
        x1: 420,
        y1: 100,
    };
    const advance = {
        id: 'm0-advance',
        rule: 'main:advance',
        kind: 'advance',
        label: '完成',
        interactive: true,
        ...target.bbox,
    };
    const stages = [
        { index: 0, needScroll: false, target, top: [title, advance], bottom: null, correct: { kind: 'click', label: '完成' } },
    ];
    return {
        seed: s0,
        difficulty: 1,
        chain: ['screen:nosidebar', 'main:form', 'decor:none'],
        fingerprint: `pcg-fallback-${s0}`,
        stages,
        overlay: null,
        goal: '走完文法场景1幕',
        successCriteria: ['下一步完成'],
        correctSequence: [{ kind: 'click', label: '完成' }],
    };
}
// ─── W4-4：PcgWorld —— 文法世界的确定性状态机 + sharp 合成帧 ───
/**
 * W4-4：合成一帧（纯函数：同键同字节；视觉语言与 GymWorld.renderFrame 同源 ——
 * 纵向条带底噪 + 控件渐变色块 + 右上角状态戳方块）。sharp 经 _legacyDeps 懒加载。
 */
async function renderPcgFrame(key, ctrls) {
    const sharp = await getSharp();
    const data = Buffer.alloc(GYM_W * GYM_H * 3);
    for (let y = 0; y < GYM_H; y++) {
        const rowTone = 22 + (y % 24) * 2;
        for (let x = 0; x < GYM_W; x++) {
            const v = rowTone + ((x * 5 + y * 11) % 13);
            const i = (y * GYM_W + x) * 3;
            data[i] = v;
            data[i + 1] = v;
            data[i + 2] = v;
        }
    }
    for (const c of ctrls) {
        if (!c)
            continue;
        const hi = c.role === 'button' ? 228 : 132;
        const lo = c.role === 'button' ? 70 : 86;
        const span = Math.max(1, c.x1 - c.x0 - 1);
        for (let y = Math.max(0, c.y0); y < Math.min(GYM_H, c.y1); y++) {
            for (let x = Math.max(0, c.x0); x < Math.min(GYM_W, c.x1); x++) {
                const v = Math.round(hi - ((hi - lo) * (x - c.x0)) / span);
                const i = (y * GYM_W + x) * 3;
                data[i] = v;
                data[i + 1] = v;
                data[i + 2] = v;
            }
        }
    }
    const sx = GYM_W - 70 - (fnv1a(key) % 11) * 52;
    for (let y = 18; y < 54; y++) {
        for (let x = sx; x < sx + 36; x++) {
            const i = (y * GYM_W + x) * 3;
            data[i] = 250;
            data[i + 1] = 200;
            data[i + 2] = 90;
        }
    }
    return sharp(data, { raw: { width: GYM_W, height: GYM_H, channels: 3 } })
        .png()
        .toBuffer();
}
/**
 * W4-4 文法世界：由一次推导铸定的确定性场景状态机（GymWorld 同接口面）。
 *
 * 状态 = 幕序 stage × 视口 viewport × 遮幕 overlayOpen × 终局 done：
 *   · nodes()/controls() 按态取推导真值（遮幕态只见遮幕节点 —— popup-maze 同律；
 *     折叠幕顶视口只见死链预览，底视口才见真目标 —— scroll-hunt 同律）；
 *   · applyAction：click 按快照中心命中（遮幕解除/破坏性诱饵落账/前进翻幕）、
 *     scroll 翻视口、hotkey Esc 解遮幕；mutations = 世界真相变化计数；
 *   · clickLedger 记每次点击命中标签（null = 落空）—— 付费陷阱审计主料；
 *   · capture() 按状态键渲染并缓存（同态同 Buffer 身份 ⇒ 假 OCR/假 VLM 按帧
 *     反查口径同步）；W1-4 噪声谱全维沿用（词面腐蚀/置信跌落/漏检/bbox 抖动/
 *     瞬态中间帧 —— 只坏传感器，ground truth 分毫不动）。
 * 绝不抛异常：坏动作静默落空。
 */
export class PcgWorld {
    W = GYM_W;
    H = GYM_H;
    /** 文法推导种子（世界身份的锚） */
    seed;
    /** 推导真值（场景图/正确动作序列/判据 —— ground truth 唯一事实源） */
    derivation;
    stage = 0;
    viewport = 'top';
    overlayOpen = false;
    done = false;
    /** 死链点击计数（折叠幕顶视口的僵局执法锚） */
    deadHits = 0;
    /** 世界真相变化计数（progress/no_effect 的裁决变量） */
    mutations = 0;
    /** capture 调用计数 */
    captures = 0;
    /** 点击标签账本：命中节点标签；null = 落空点击 */
    clickLedger = [];
    /** 滚动账本 */
    scrollLog = [];
    frameCache = new Map();
    bufIndex = new Map();
    // ─── W1-4 噪声诊所纪律沿用（三种子流 + 瞬态中间帧；缺省零漂移） ───
    noise;
    noiseOcr;
    noiseVlm;
    noiseBbox;
    transientPending = false;
    transientCtrls = [];
    transientCount = 0;
    constructor(seed, opts = {}) {
        const seedNum = Number(seed);
        this.seed = (Number.isFinite(seedNum) ? Math.floor(seedNum) : 0) % 0x80000000;
        this.derivation = derivePcgScene(this.seed, opts);
        this.noise = resolveGymNoise(opts?.noise);
        this.noiseOcr = mulberry32(fnv1a(`w1-4:ocr:${this.noise.seed}`));
        this.noiseVlm = mulberry32(fnv1a(`w1-4:vlm:${this.noise.seed}`));
        this.noiseBbox = mulberry32(fnv1a(`w1-4:bbox:${this.noise.seed}`));
        // 遮幕初始态：atStage 恒 ≥1 ⇒ 首幕永不遮（推导立法保证；防御式再钳一次）
        this.overlayOpen = this.derivation.overlay !== null && this.derivation.overlay.atStage === 0;
    }
    /** ground truth 只读视图（= derivation 本体；真值不可变） */
    groundTruth() {
        return this.derivation;
    }
    /** 噪声谱只读视图（诊所观测面） */
    get noiseSpec() {
        return { ...this.noise };
    }
    /** 下一帧是否将回放瞬态中间帧（W1-4 自适应等待病理的观测锚） */
    get transientArmed() {
        return this.noise.transientFrame === 1 && this.transientPending;
    }
    /** 当前状态的唯一键（含推导指纹 —— 异世界异键 ⇒ 状态戳异像素） */
    stateKey() {
        return `pcg|${this.derivation.fingerprint}|s${this.stage}|v${this.viewport}|o${this.overlayOpen ? 1 : 0}|d${this.done ? 1 : 0}`;
    }
    /** 当前态的场景节点表（物理真相；渲染与命中判定的唯一事实源） */
    nodes() {
        if (this.done) {
            return [
                {
                    id: 'done-banner',
                    rule: 'fixed:banner',
                    kind: 'banner',
                    label: '下一步完成 文法场景收官',
                    interactive: false,
                    x0: 200,
                    y0: 250,
                    x1: 620,
                    y1: 330,
                },
            ];
        }
        if (this.overlayOpen)
            return this.derivation.overlay ? this.derivation.overlay.nodes : [];
        const st = this.derivation.stages[this.stage];
        if (!st)
            return [];
        if (st.needScroll && this.viewport === 'bottom' && st.bottom)
            return st.bottom;
        return st.top;
    }
    /** 物理控件真相表（节点 → GymControl 方言；interactive ⇒ button，否则 text） */
    controls() {
        return this.toCtrls(this.nodes());
    }
    /** 弹窗注记（遮幕态 ⇒ 一条注记；policy 弹窗优先律的触发信号） */
    popupNotes() {
        if (!this.overlayOpen || !this.derivation.overlay)
            return [];
        const zh = this.derivation.overlay.kind === 'payTrap'
            ? '付费陷阱'
            : this.derivation.overlay.kind === 'cookie'
                ? 'Cookie横幅'
                : '升级提示';
        return [`文法${zh}遮幕`];
    }
    /** 命中判定 + 状态机推进（世界立法：遮幕解除 / 诱饵落账 / 前进翻幕） */
    clickHit(px, py) {
        const list = this.nodes();
        let hit = null;
        for (let i = list.length - 1; i >= 0; i--) {
            const c = list[i];
            if (px >= c.x0 && px <= c.x1 && py >= c.y0 && py <= c.y1) {
                hit = c;
                break;
            }
        }
        this.clickLedger.push(hit ? hit.label : null);
        if (!hit)
            return;
        // 遮幕态：只认遮幕自己的按钮（dismiss 解除；trap 落账不推进 —— 破坏性诱饵）
        if (this.overlayOpen) {
            const o = this.derivation.overlay;
            if (o && hit.label === o.dismissLabel) {
                this.overlayOpen = false;
                this.mutations += 1;
            }
            return;
        }
        if (this.done)
            return;
        const st = this.derivation.stages[this.stage];
        if (!st)
            return;
        // 折叠幕顶视口：死链永不推进（两连无效后仍在感知面 —— 僵局切换交给 scroll）
        if (st.needScroll && this.viewport === 'top') {
            if (hit.kind === 'deadLink')
                this.deadHits += 1;
            return;
        }
        // 前进按钮：翻幕（幕序 +1、视口回顶、遮幕按推导登场、末幕收官）
        if (hit.kind === 'advance' && hit.label === st.target.label) {
            this.stage += 1;
            this.viewport = 'top';
            this.mutations += 1;
            if (this.stage >= this.derivation.stages.length) {
                this.done = true;
            }
            else if (this.derivation.overlay && this.derivation.overlay.atStage === this.stage) {
                this.overlayOpen = true;
            }
        }
        // 其余（家具元素等）：落账不推进
    }
    /** 滚动立法：仅折叠幕有双视口（down 暴露深部 / up 回顶） */
    scrollDir(dir) {
        this.scrollLog.push({ dir, amount: 5 });
        const st = this.derivation.stages[this.stage];
        if (!st || !st.needScroll)
            return;
        if (dir === 'down' && this.viewport === 'top') {
            this.viewport = 'bottom';
            this.mutations += 1;
        }
        else if (dir === 'up' && this.viewport === 'bottom') {
            this.viewport = 'top';
            this.mutations += 1;
        }
    }
    /** 世界唯一动作入口（W1-4 瞬态包装同律：翻态 ⇒ 武装一拍旧态回放） */
    applyAction(action) {
        if (this.noise.transientFrame !== 1) {
            this.applyActionInner(action);
            return;
        }
        const keyBefore = this.stateKey();
        const nodesBefore = this.nodes();
        this.applyActionInner(action);
        if (this.stateKey() !== keyBefore) {
            this.transientPending = true;
            this.transientCtrls = nodesBefore;
        }
    }
    applyActionInner(action) {
        const a = (action ?? {});
        const payload = a.payload && typeof a.payload === 'object' ? a.payload : {};
        switch (a.kind) {
            case 'click': {
                const c = a.target?.center;
                if (typeof c?.x !== 'number' || !Number.isFinite(c.x) || typeof c?.y !== 'number' || !Number.isFinite(c.y)) {
                    return; // 无处落点：绝不凭空点击
                }
                this.clickHit(Math.round(c.x), Math.round(c.y));
                return;
            }
            case 'scroll': {
                const raw = typeof payload.direction === 'string' ? payload.direction : 'down';
                this.scrollDir(raw === 'up' || raw === 'left' || raw === 'right' ? raw : 'down');
                return;
            }
            case 'hotkey': {
                const keys = Array.isArray(payload.keys) ? payload.keys : [];
                if (keys.some(k => String(k).toLowerCase() === 'esc') && this.overlayOpen) {
                    this.overlayOpen = false;
                    this.mutations += 1;
                }
                return;
            }
            default:
                return;
        }
    }
    /** 截屏：按状态键渲染并缓存（同态同 Buffer；瞬态中间帧同 W1-4 律） */
    async capture() {
        this.captures += 1;
        if (this.noise.transientFrame === 1 && this.transientPending) {
            this.transientPending = false;
            const nodes = this.transientCtrls.length > 0 ? this.transientCtrls : this.nodes();
            this.transientCount += 1;
            const lagKey = `${this.stateKey()}|lag${this.transientCount}`;
            let lagEntry = this.frameCache.get(lagKey);
            if (!lagEntry) {
                lagEntry = { buf: await renderPcgFrame(lagKey, this.toCtrls(nodes)), nodes };
                this.frameCache.set(lagKey, lagEntry);
                this.bufIndex.set(lagEntry.buf, nodes);
            }
            return lagEntry.buf;
        }
        const key = this.stateKey();
        let entry = this.frameCache.get(key);
        if (!entry) {
            const nodes = this.nodes();
            entry = { buf: await renderPcgFrame(key, this.toCtrls(nodes)), nodes };
            this.frameCache.set(key, entry);
            this.bufIndex.set(entry.buf, nodes);
        }
        return entry.buf;
    }
    /** 节点表 → 控件方言 */
    toCtrls(nodes) {
        return nodes.map(n => ({
            label: n.label,
            role: n.interactive ? 'button' : 'text',
            x0: n.x0,
            y0: n.y0,
            x1: n.x1,
            y1: n.y1,
        }));
    }
    /** W1-4：bbox 抖动（四边独立 ±n、夹画布、保序 —— GymWorld 同律） */
    jitterBBox(n) {
        if (this.noise.bboxJitterPx <= 0)
            return { x0: n.x0, y0: n.y0, x1: n.x1, y1: n.y1 };
        const j = this.noise.bboxJitterPx;
        const draw = () => Math.round((this.noiseBbox() * 2 - 1) * j);
        const ax = Math.min(GYM_W - 1, Math.max(0, n.x0 + draw()));
        const bx = Math.min(GYM_W - 1, Math.max(0, n.x1 + draw()));
        const ay = Math.min(GYM_H - 1, Math.max(0, n.y0 + draw()));
        const by = Math.min(GYM_H - 1, Math.max(0, n.y1 + draw()));
        return { x0: Math.min(ax, bx), y0: Math.min(ay, by), x1: Math.max(ax, bx), y1: Math.max(ay, by) };
    }
    /** 假 OCR：按捕获帧反查节点表（RuntimeWord 方言；W1-4 噪声全维沿用） */
    wordsFor(buf) {
        const base = this.bufIndex.get(buf) ?? this.nodes();
        if (!this.noise.active) {
            return base.map(n => ({
                label: n.label,
                bbox: { x0: n.x0, y0: n.y0, x1: n.x1, y1: n.y1 },
                confidence: 0.92,
            }));
        }
        return base.map(n => {
            let label = typeof n.label === 'string' ? n.label : '';
            if (this.noise.ocrSwapRate > 0 && label.length > 0) {
                label = corruptOcrLabel(label, this.noise.ocrSwapRate, this.noiseOcr);
            }
            let confidence = 0.92;
            if (this.noise.ocrConfDrop > 0 && this.noiseOcr() < this.noise.ocrConfDrop) {
                confidence = GYM_NOISY_OCR_CONF;
            }
            return { label, bbox: this.jitterBBox(n), confidence };
        });
    }
    /** 假 VLM 接地：同一套节点带角色（双源 ⇒ composeSnapshot 真实仲裁融合） */
    vlmFor(buf) {
        const base = this.bufIndex.get(buf) ?? this.nodes();
        if (!this.noise.active) {
            return base.map((n, i) => ({
                id: `e${i + 1}`,
                label: n.label,
                role: n.interactive ? 'button' : 'text',
                bbox: { x0: n.x0, y0: n.y0, x1: n.x1, y1: n.y1 },
                center: { x: (n.x0 + n.x1) / 2, y: (n.y0 + n.y1) / 2 },
                confidence: 0.9,
                source: 'vlm',
            }));
        }
        const out = [];
        for (let i = 0; i < base.length; i++) {
            const n = base[i];
            if (this.noise.vlmMissRate > 0 && this.noiseVlm() < this.noise.vlmMissRate)
                continue;
            const bbox = this.jitterBBox(n);
            out.push({
                id: `e${i + 1}`,
                label: typeof n.label === 'string' ? n.label : '',
                role: n.interactive ? 'button' : 'text',
                bbox,
                center: { x: (bbox.x0 + bbox.x1) / 2, y: (bbox.y0 + bbox.y1) / 2 },
                confidence: 0.9,
                source: 'vlm',
            });
        }
        return out;
    }
    /** 当前传感器口径的 OCR 全文（execute 判据抽查通道） */
    ocrText() {
        return this.nodes()
            .map(n => n.label)
            .join(' ');
    }
    /**
     * 立法真值：当前态唯一正确动作（Θ-3 policy.matchConfident 的对账面）。
     * 终局 ⇒ null（无真值，如实跳过）；遮幕 ⇒ 解除；折叠顶视口 ⇒ scroll；
     * 其余 ⇒ 前进按钮。
     */
    correctNext() {
        if (this.done)
            return null;
        if (this.overlayOpen) {
            const o = this.derivation.overlay;
            return o ? { kind: 'click', label: o.dismissLabel } : null;
        }
        const st = this.derivation.stages[this.stage];
        if (!st)
            return null;
        if (st.needScroll && this.viewport === 'top')
            return { kind: 'scroll' };
        return { kind: 'click', label: st.target.label };
    }
}
/**
 * W4-4 世界工厂：seed + 文法选项 → GymWorld 兼容世界实例。seed 钉死 ⇒ 推导
 * 字节级一致（同 seed 两次工厂 ⇒ 同真值同帧字节）。ground truth 同账本：opts.
 * ledger 在场时推导期已写 pcg.truth.*（见 derivePcgScene）。绝不抛。
 */
export function gymWorldFactory(seed, opts) {
    return new PcgWorld(seed, opts ?? {});
}
/**
 * W4-4 无限世界流水：按主种子派生逐世界种子（fnv1a 域分离，序号唯一），懒生成
 * 无限 PcgWorld 序列 —— 生成侧无限，消费侧预算封顶（runPcgTasks / campaign）。
 * 同 seed 同序号 ⇒ 同世界（重放一致）；无限性仅由「永不 done」的生成器承载。
 */
export function* pcgWorldStream(seed, opts) {
    const seedNum = Number(seed);
    const master = Number.isFinite(seedNum) ? Math.floor(seedNum) : DEFAULT_SEED;
    const grammar = opts ?? {};
    let i = 0;
    for (;;) {
        const worldSeed = fnv1a(`w4-4:pcg:world:${master}:${i}`) % 0x7fffffff;
        yield gymWorldFactory(worldSeed, grammar);
        i += 1;
    }
}
/**
 * W4-4 文法课程权重更新（确定性、纯函数、绝不抛）：
 *   · 方向律：失败 ⇒ 升权（多练弱项：delta = +lr·(1 + surprise/8)）；成功 ⇒ 缓降
 *     （已掌握让位：delta = −lr·0.5）；链外产生式不动；
 *   · 夹取律：每条产生式权重恒 ∈ [0.25×基线, 4×基线]（永不归零/爆炸）；
 *   · 网格律：1e-6 网格取整（防浮点尾噪累积 —— 权重更新可重放）；
 *   · 防弹：垃圾权重/垃圾反馈静默按缺省/跳过处理，返回全量合法权重表。
 */
export function updatePcgCurriculum(weights, feedback, opts) {
    const base = pcgBaseWeights();
    const w = pcgEffectiveWeights(weights);
    const lrRaw = Number(opts?.learnRate);
    const lr = Number.isFinite(lrRaw) ? Math.min(1, Math.max(0, lrRaw)) : 0.25;
    const list = Array.isArray(feedback) ? feedback : [];
    for (const raw of list) {
        const f = raw !== null && typeof raw === 'object' ? raw : null;
        if (!f || typeof f.success !== 'boolean' || !Array.isArray(f.chain))
            continue;
        const sRaw = Number(f.surprise);
        const surprise = Number.isFinite(sRaw) ? Math.min(64, Math.max(0, sRaw)) : 0;
        const seen = new Set();
        for (const id of f.chain) {
            if (typeof id !== 'string' || seen.has(id) || !PCG_RULE_IDS.has(id))
                continue;
            seen.add(id);
            const b = base[id];
            const delta = f.success ? -lr * 0.5 : lr * (1 + surprise / 8);
            const lo = b * 0.25;
            const hi = b * 4;
            const next = Math.min(hi, Math.max(lo, w[id] * (1 + delta)));
            w[id] = Math.round(next * 1e6) / 1e6;
        }
    }
    return w;
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
export async function runPcgCampaign(opts = {}) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const seedNum = Number(o.seed);
    const master = Number.isFinite(seedNum) ? Math.floor(seedNum) : DEFAULT_SEED;
    const msNum = Number(o.maxSteps);
    const maxSteps = Number.isFinite(msNum) && msNum >= 1 ? Math.floor(msNum) : DEFAULT_MAX_STEPS;
    const b = o.budget && typeof o.budget === 'object' ? o.budget : {};
    const wRaw = Number(b.maxWorlds);
    const maxWorlds = Number.isFinite(wRaw) && wRaw >= 1 ? Math.min(4096, Math.floor(wRaw)) : 8;
    const sRaw = Number(b.maxTotalSteps);
    const maxTotalSteps = Number.isFinite(sRaw) && sRaw >= 1 ? Math.min(65536, Math.floor(sRaw)) : 96;
    const cur = o.curriculum && typeof o.curriculum === 'object'
        ? o.curriculum
        : {};
    const curOn = cur.enabled === true;
    // 虚拟时钟（零真钟；与馆内实验室校准报告同源确定）
    let t = 1_000_000;
    const clock = () => (t += CLOCK_STEP_MS);
    const gym = new AutonomyGym({ seed: master, maxSteps, kernel: o.kernel, now: clock });
    const labLedger = (() => {
        try {
            return gym.lab?.ledger ?? undefined;
        }
        catch {
            return undefined;
        }
    })();
    const weightsBefore = pcgEffectiveWeights(o.weights);
    let weights = { ...weightsBefore };
    const rounds = [];
    let worldsRun = 0;
    let stepsTotal = 0;
    let truncated = false;
    let reason = 'none';
    try {
        for (let i = 0;; i++) {
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
            const grammar = {
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
            const record = {
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
    }
    catch {
        /* 防弹承诺：漏网异常不炸营——已完成的世界照常入报 */
    }
    const ok = rounds.filter(r => r.success).length;
    const summary = `文法训练营${worldsRun}世界收官：达成${ok}轮、失败${rounds.length - ok}轮，` +
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
