// src/skillFederation.ts
// W6-2 结构性保留（doctor smell.over-engineering 登记）：技能联邦 —— 导入/导出/清单/协商围绕同一联邦协议方言（版本兼容矩阵），协议单文件即规范文本。
// W4-2（创新提案 G3：策略联邦）—— 联邦从「评价计数」升级为「联邦怎么走」。
// 纪元 Μ 联邦的是认知器官的成败水位（「这条路走得通吗」）；本模块把联邦对象
// 提升为**技能本身**：「同一场景 + 同一参数形状的工作流，万机各自怎么走」。
//
// 世界级纪律（一字不违）：
//   · 差分隐私红线 —— 上传载荷只含 (技能指纹, 数值槽统计中位数+IQR, reliability,
//     使用计数) + Laplace 噪声；**绝不上传原始文本 / 坐标序列 / 截图引用 / 技能 id**。
//     指纹 = 场景指纹前 8 位 + 参数 LSH 桶（与 swarm 晶体键同律的匿名锚点）；
//   · 鲁棒聚合 —— robustMergeDigests 风格：同指纹多实例**逐格（逐数值槽）中位数**
//     + IQR 离群检疫；k ≥ 3 同指纹才聚合（少源是噪声不是共识）。聚合产物是
//     「参数分布摘要」—— 结构上不含任何可执行步骤（不可执行是类型保证，不是约定）；
//   · dormant 安全律（注入三律）—— ① 接收端 Thompson/Beta 采样决定是否注入尝试；
//     ② 候选默认 **dormant**（只登记，绝不进匹配池）；③ 本地命中 2 次（本地证据）
//     才激活，且激活只经 skillLibrary 端口 addDormantSkill 登记为 dormant 技能
//     （联邦没有任何直达匹配池的写径 —— 与 Μ「绝不直接写 kernelRegistry 值」同律）；
//   · 信任与份额 —— 沿用 federation 三道闸（零证据不掺 / 份额帽 / 信任函数
//     1/(1+regressed)），技能联邦的掺入独立记账（不动证据账本一分）；
//   · 防御式绝不抛 —— 一切端口调用、一切公开面全程 try/catch，失败 = 诚实
//     跳过/降级（联邦是纯增益旁路，绝不炸宿主）。peer 缺席 / 聚合数据不足 ⇒
//     诚实跳过。
//
// 端口纪律（对 W4-1 领地零侵入）：本地技能经**结构化类型端口**消费（与
// skillLibrary 正在实现的契约 listSkillDigests / addDormantSkill 同形状），
// 不 import 其内部 —— 生产接线由宿主一次 wireSwarmSkillFederation 完成，
// 测试注入桩。全模块随机源/时钟/端口可注入，skillFederation.reset() 供测试隔离。
//（ΑΩ-R34：旧注释写作 resetSkillFederation —— 该名从未存在，真实隔离缝是
//  单例的 reset() 方法：端口/候选/计数归零并解除持久化武装。）
//
// ΠΑΝ-69（值域分离）：stepsDigest 的契约值是 hashArgsNumeric 的 32 位哈希
//（uint32），旧管线却按屏域坐标裁剪 ±4096 + 0.05 网格量化 —— 哈希几乎必然
// 全裁到 4096 ⇒ 指纹桶号坍缩成常量、slotStats 中位数恒 4096、IQR 检疫阈永不
// 触发。修复：typed channels（坐标类 |v| ≤ 4096 走 ±4096 + 0.05 网格（旧律
// 逐字节）；哈希/计数类 v > 4096 走 uint32 原生域、网格 1、不裁剪）+ LSH 桶按
// 值域分族（哈希 token 带 `h` 族标）+ 槽统计按通道取噪声尺度与检疫阈地板
//（见 SKILL_SLOT_CLIP 节的 ΠΑΝ-69 立法注记）。
import { Telemetry } from './telemetry.js';
// ΤΕΛ-5 D-G25③：robustDispersionOf（IQR 等价 MAD 口径离散臂）；iqrOf 仍是
// 上传统计量（share 槽 iqr 的 DP 加噪面）的口径原语
import { iqrOf, robustDispersionOf } from './federation/aggregate.js';
import { laplaceNoise, mulberry32, federationTrustOf, DEFAULT_FEDERATION_EPSILON, DEFAULT_MAX_REMOTE_SHARE, } from './federation/index.js';
import { swarm } from './swarm.js';
// ΝΩ-41（方言克隆律）：本地 FNV-1a→base36 副本退役 —— 单源 src/dialects/random.ts
// 的 fnv1aBase36（string 返回方言；逐字节同实现，指纹不变；金样
// test/no41.dialectClones.test.ts）。
import { fnv1aBase36 } from './dialects/random.js';
// W7-0（W6-4 接线收尾）：持久化面 —— 原子写的 node:fs/node:path 原语
//（federation 信任账 createFederationTrustFileStore 同律；零新依赖）。
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync, } from 'node:fs';
import { dirname as pathDirname } from 'node:path';
// ─── 算法形状字面量（模块常量 —— 一切数值在此审计，绝无内联魔数） ───
/** 技能联邦上传段 schema 版本（v≠1 的份额按坏源缺席处理） */
export const SKILL_FED_VERSION = 1;
/** 技能指纹的场景前缀长度：8 位 —— 与 swarm 晶体键 `${hash.slice(0,8)}` 同律
 *  （匿名锚点：8 位十六进制已是 2^32 级命名空间，且与本仓库既有上传口径一致） */
export const SKILL_FP_SCENE_PREFIX = 8;
/** 参数 LSH 量化网格：数值参数按 0.05 网格取整 —— 与 skillLibrary 的 motif 量化
 *  同律（坐标抖动 <0.025 ⇒ 同桶 ⇒ 同指纹：LSH 的碰撞即「同一个工作流的微差」） */
export const SKILL_LSH_GRID = 0.05;
/** 数值槽对称裁剪域 [-CLIP, +CLIP]：屏域坐标 / 长度 / 位移的宽界（margin 裁剪
 *  [-1,1] 的 DIGEST_MARGIN_CLIP 同律思想 —— 域外夹到边界，分布尾保守收拢） */
export const SKILL_SLOT_CLIP = 4096;
// ─── ΠΑΝ-69（值域分离）：typed channels —— 联邦数学复活的前提 ───
//
// 缝隙（C1-3 H-2）：stepsDigest 的契约值是 hashArgsNumeric 的 **32 位 FNV 哈希**
//（0..2³²−1，skillLibrary.signatures.ts 的 W4-1 摘要律），而本管线把每个数值槽
// 当屏域坐标裁剪 ±4096 再按 0.05 网格量化 —— 32 位哈希几乎必然 >4096 ⇒ **全部
// 裁剪到边界 4096** ⇒ 指纹每个数值槽桶号恒 81920（指纹退化为「场景前 8 位 +
// 工具序列形状」）、slotStats 中位数恒 4096 / IQR 恒 0、IQR 检疫阈 T = 0.15 永不
// 触发 —— 差分隐私机制对常量加噪：数学正确但语义空转。0.05 网格的 LSH 局部性
// 对哈希值也不成立（哈希对输入微扰是雪崩的）。
// 修复律（值域标注 / typed channels）：
//   · **坐标通道（coord）**：|v| ≤ SKILL_SLOT_CLIP —— 屏域坐标/长度/归一化参数/
//     小计数的原生域；裁剪 ±4096 + 0.05 网格量化（LSH 局部性对真坐标成立，
//     量化网格提供 <0.025 抖动的碰撞）；指纹桶号域恰为旧律（零回归）。
//   · **哈希通道（hash）**：v > SKILL_SLOT_CLIP（上至 2³²−1）—— hashArgsNumeric
//     的 uint32 原生域 / 大计数域；**不裁剪**（裁剪正是病灶），量化网格 = 1（哈希
//     是身份件不是测量值：雪崩性下唯一诚实的「局部性」就是恒等匹配）；值夹回
//     [0, 2³²−1] 是防御性钳制（非语义裁剪）。
//   · **LSH 桶按值域分族**：指纹 token 对坐标通道不带族标（旧律逐字节保持 ——
//     既有金样不动），哈希通道带 `h` 族标（`i.key.h<v>` vs `i.key.<bucket>`）——
//     两族桶号空间不相交，坐标桶 5 ≠ 哈希值 5。
//   · 槽统计的 DP 噪声尺度按通道取桶宽/ε（coord: 0.05/ε；hash: 1/ε）；
//     聚合检疫阈的地板同律按通道（coord: 3×0.05；hash: 3×1 —— ε=1 的 Laplace
//     噪声中位 |noise|≈0.69 < 3，诚实源不吃票）。
// 分类判据是**幅度域**（|v| ≤ 4096 即坐标类）：哈希落入坐标域的概率 ≈ 4096/2³²
// ≈ 1e-6（届时按坐标量化 —— 指纹粒度损失可忽略）；真坐标越界 4096 在屏域语义
// 下不存在。防御式：负值越界照旧坐标裁剪（margin 类）。
/** ΠΑΝ-69：哈希通道的原生域上界（uint32 —— hashArgsNumeric 的值域） */
export const SKILL_HASH_DOMAIN_MAX = 0xFFFFFFFF;
/** ΠΑΝ-69：哈希通道的量化网格 = 1（身份件精确匹配 —— 雪崩哈希上更粗的网格是伪局部性） */
export const SKILL_HASH_GRID = 1;
/**
 * ΠΑΝ-69：数值槽的值域分类（纯函数、绝不抛）。v 非有限 ⇒ null（缺席，不入管线）；
 * v > SKILL_SLOT_CLIP ⇒ 'hash'（uint32 原生域）；其余（含负值）⇒ 'coord'。
 */
export function slotChannelOf(v) {
    if (typeof v !== 'number' || !Number.isFinite(v))
        return null;
    return v > SKILL_SLOT_CLIP ? 'hash' : 'coord';
}
/** 聚合最低同指纹源数：k < 3 拒聚（两源的「共识」无鲁棒性 —— 中位数需要
 *  ≥3 才有 50% 崩溃点的语义；与 robustMergeDigests 的 k≥3 中位数同律） */
export const SKILL_MIN_AGGREGATE_SOURCES = 3;
/** 检疫阈地板（桶宽倍数）：|源值−鲁棒值| ≤ 3×桶宽 恒不检疫 —— OUTLIER_FLOOR=3
 *  的技能域口径（计数的阈是 3 格；技能统计的格是 LSH 桶，噪声尺度=桶宽/ε） */
export const SKILL_OUTLIER_FLOOR_BUCKETS = 3;
/** 检疫阈的格间尺度：T = max(地板, 2×该槽中位数表的 IQR) —— OUTLIER_IQR_SCALE 同值 */
export const SKILL_OUTLIER_IQR_SCALE = 2;
/** Thompson 注入采样门：Beta(α,β) 单样本 ≥ 0.5 才注入尝试（「后验过半才出手」——
 *  高可靠候选几乎必过、低可靠候选偶获探索机会，与 0.5 多数表决同形的保守门） */
export const SKILL_INJECT_SAMPLE_GATE = 0.5;
/** dormant 激活所需本地命中数：2（本地证据门槛 —— 单次巧合不成技，与晶体
 *  attempts≥2 才上报/入反事实的「单次经验是噪声不是信号」同律） */
export const SKILL_ACTIVATE_LOCAL_HITS = 2;
/** 单次上传的技能数上限（swarm 晶体 100 条同律的载荷护栏） */
export const SKILL_MAX_UPLOADS = 100;
/** 数值护栏：x 非有限或越界 ⇒ 缺省（federation.numOr 同律，绝不抛） */
function numOr(x, dflt, min, max) {
    return typeof x === 'number' && Number.isFinite(x) && x >= min && x <= max ? x : dflt;
}
// ─── 技能指纹（场景前 8 位 + 参数 LSH 桶） ───
// （本地 fnv1a 副本已退役 —— 见上方 import：单源 fnv1aBase36 承接 string 返回方言）
/**
 * W4-2：技能指纹（纯函数、确定性、绝不抛）。
 *   · 场景锚：sceneFingerprint 前 8 位小写（swarm 晶体键同律 —— 匿名且稳定）；
 *   · 参数 LSH 桶：每步每数值槽按 0.05 网格量化取桶（键字典序 + 步序确定
 *     枚举序 ⇒ 键序无关、抖动 <半网格宽即碰撞 —— LSH 的 locality），序列化后
 *     FNV-1a 哈希成 base36 短串。**只留桶号，不留原值** —— 指纹本身是匿名件。
 *   · ΠΑΝ-69（值域分族）：坐标通道（|v| ≤ 4096）token = `${i}.${key}.${bucket}`
 *     （旧律逐字节 —— 金样不动）；哈希通道（v > 4096）token =
 *     `${i}.${key}.h${v}`（uint32 原生域精确身份 + `h` 族标 —— 两族桶号空间
 *     不相交，且哈希值不再被 ±4096 裁剪坍缩成常量桶 81920）。
 * 场景指纹缺席 ⇒ 'noscene' 占位（诚实：无锚点的技能仍可按参数形状聚合）。
 */
export function skillFingerprintOf(sceneFingerprint, stepsDigest) {
    try {
        const scene = typeof sceneFingerprint === 'string' && sceneFingerprint !== ''
            ? sceneFingerprint.slice(0, SKILL_FP_SCENE_PREFIX).toLowerCase()
            : 'noscene';
        const tokens = [];
        if (Array.isArray(stepsDigest)) {
            stepsDigest.forEach((step, i) => {
                if (!step || typeof step !== 'object' || Array.isArray(step))
                    return; // 坏步缺席
                for (const key of Object.keys(step).sort()) {
                    const v = step[key];
                    if (typeof v !== 'number' || !Number.isFinite(v))
                        continue; // 非数值槽不进指纹
                    // ΠΑΝ-69：哈希通道 —— 原生域精确身份（不裁剪不量化），h 族标与坐标桶分族
                    if (v > SKILL_SLOT_CLIP) {
                        tokens.push(`${i}.${key}.h${Math.min(SKILL_HASH_DOMAIN_MAX, Math.max(0, Math.round(v)))}`);
                        continue;
                    }
                    const clipped = Math.min(SKILL_SLOT_CLIP, Math.max(-SKILL_SLOT_CLIP, v));
                    const bucket = Math.round(clipped / SKILL_LSH_GRID);
                    tokens.push(`${i}.${key}.${bucket}`);
                }
            });
        }
        return `${scene}:${fnv1aBase36(tokens.join('|'))}`;
    }
    catch {
        return 'noscene:err'; // 防御带（理论不可达）：确定性降级键，绝不抛
    }
}
/** 浮点中位数（奇数取正中；偶数取中间两数均值 —— **不取整**：与 aggregate.ts 的
 *  计数中位数不同域，技能参数是连续量，取整会吃掉 0.05 网格以下的分辨率） */
function medianF(values) {
    const s = [...values].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
/**
 * 单槽值的收集与量化（ΠΑΝ-69 typed channels）：按值分类通道 —— 坐标通道（|v| ≤
 * 4096）裁剪进对称域再按 0.05 网格量化（旧律）；哈希通道（v > 4096）不裁剪、
 * 网格 1（uint32 原生域精确值 —— 哈希是身份件，量化网格在雪崩值上是伪局部性）。
 * 其余（非有限）缺席。返回 槽 →（量化值表, 值域标注）。
 */
function collectQuantized(stepsDigest) {
    const slotValues = new Map();
    if (!Array.isArray(stepsDigest))
        return slotValues;
    for (const step of stepsDigest) {
        if (!step || typeof step !== 'object' || Array.isArray(step))
            continue;
        for (const key of Object.keys(step)) {
            const v = step[key];
            if (typeof v !== 'number' || !Number.isFinite(v))
                continue;
            const channel = slotChannelOf(v) ?? 'coord';
            let q;
            if (channel === 'hash') {
                // ΠΑΝ-69：哈希通道 —— 原生域（[0, 2³²−1] 防御性钳制），网格 1，不裁到 ±4096
                q = Math.min(SKILL_HASH_DOMAIN_MAX, Math.max(0, Math.round(v)));
            }
            else {
                const clipped = Math.min(SKILL_SLOT_CLIP, Math.max(-SKILL_SLOT_CLIP, v));
                q = Math.round(clipped / SKILL_LSH_GRID) * SKILL_LSH_GRID;
            }
            const cur = slotValues.get(key) ?? { values: [], domain: channel };
            cur.values.push(q);
            if (channel === 'hash')
                cur.domain = 'hash'; // 混合域槽按哈希口径申报（保守：噪声/阈取宽的一侧）
            slotValues.set(key, cur);
        }
    }
    return slotValues;
}
/**
 * W4-2：铸造技能上传段（纯函数、确定性（注入 rng/seed）、绝不抛 —— 端口故障 ⇒
 * 空数组诚实跳过）。隐私机制（沿用联邦现有纪律，逐字面声明）：
 *   · 槽统计（中位数/IQR）：值先裁剪进 [-4096,4096] 再按 0.05 网格量化 —— 分位数
 *     在桶化域上单记录的典型位移是一个桶宽 ⇒ Laplace 尺度 = 桶宽/ε（工程口径的
 *     分位数敏感度；诚实注记：序统计的严格敏感度是数据相关的，此处按桶宽计是
 *     「量化域上单桶位移」的保守实用口径，与计数域 Δ=1 ⇒ 1/ε 同构）；
 *   · reliability：敏感度 = 1/useCount（单次成败翻转幅度 —— swarm.buildPacket 对
 *     successRate 的同律）⇒ 尺度 = 1/(ε·useCount)；
 *   · useCount：计数明文上报（swarm 上报 attempts 明文同律 —— 敏感统计已加噪）。
 * 输出面：每技能一条，键 = 技能指纹（skillId 与一切本地身份不出港）。
 */
export function buildSkillUploads(port, opts) {
    try {
        if (!port || typeof port.listSkillDigests !== 'function')
            return []; // 端口非法：诚实空手
        const epsilon = numOr(opts?.epsilon, DEFAULT_FEDERATION_EPSILON, Number.MIN_VALUE, Infinity);
        const rng = typeof opts?.rng === 'function'
            ? opts.rng
            : mulberry32(typeof opts?.seed === 'number' && Number.isFinite(opts.seed) ? opts.seed : 0);
        const maxUploads = numOr(opts?.maxUploads, SKILL_MAX_UPLOADS, 1, 10_000);
        let records = [];
        try {
            records = port.listSkillDigests() ?? [];
        }
        catch {
            return []; // 端口读故障：诚实空手（绝不炸宿主）
        }
        const uploads = [];
        for (const rec of Array.isArray(records) ? records : []) {
            try {
                if (!rec || typeof rec !== 'object')
                    continue; // 垃圾记录缺席
                if (typeof rec.sceneFingerprint !== 'string' || !Array.isArray(rec.stepsDigest))
                    continue;
                const fingerprint = skillFingerprintOf(rec.sceneFingerprint, rec.stepsDigest);
                const slotValues = collectQuantized(rec.stepsDigest);
                const slotStats = {};
                for (const key of [...slotValues.keys()].sort()) { // 键字典序 ⇒ 序列化确定性
                    const { values, domain } = slotValues.get(key);
                    // ΠΑΝ-69：噪声尺度 = 通道桶宽/ε（coord: 0.05/ε —— 分位数敏感度的工程口径；
                    // hash: 1/ε —— 身份域的桶宽是 1）；后处理夹回各自值域（多掩蔽方向 ——
                    // 哈希通道夹回 uint32 域而非 ±4096：裁剪到 4096 正是要修的坍缩）
                    const scale = (domain === 'hash' ? SKILL_HASH_GRID : SKILL_LSH_GRID) / epsilon;
                    const lo = domain === 'hash' ? 0 : -SKILL_SLOT_CLIP;
                    const hi = domain === 'hash' ? SKILL_HASH_DOMAIN_MAX : SKILL_SLOT_CLIP;
                    const med = Math.min(hi, Math.max(lo, medianF(values) + laplaceNoise(scale, rng())));
                    const spr = Math.min(hi - lo, Math.max(0, iqrOf(values) + laplaceNoise(scale, rng())));
                    slotStats[key] = domain === 'hash'
                        ? {
                            median: Math.round(med * 1000) / 1000,
                            iqr: Math.round(spr * 1000) / 1000,
                            domain, // ΠΑΝ-69：值域标注随摘要上行（聚合侧检疫阈按通道取地板）；坐标通道不带键 —— 旧形状零迁移
                        }
                        : {
                            median: Math.round(med * 1000) / 1000,
                            iqr: Math.round(spr * 1000) / 1000,
                        };
                }
                const useCount = Math.max(1, Math.floor(numOr(rec.useCount, 1, 0, 1e9)));
                const relRaw = numOr(rec.reliability, 0.5, 0, 1);
                // reliability 噪声：1/(ε·useCount)（单次成败的翻转幅度 —— swarm 同律）
                const relScale = 1 / (epsilon * useCount);
                const rel = Math.min(1, Math.max(0, relRaw + laplaceNoise(relScale, rng())));
                uploads.push({
                    v: SKILL_FED_VERSION,
                    fingerprint,
                    slotStats,
                    reliability: Math.round(rel * 1000) / 1000,
                    useCount,
                });
                if (uploads.length >= maxUploads)
                    break; // 载荷护栏
            }
            catch {
                continue; // 单条读取故障（陷阱属性等）：该条缺席，其余不受牵连
            }
        }
        return uploads;
    }
    catch {
        return []; // 绝不抛纪律的兜底臂
    }
}
/** 单份额的资格甄别（纯函数、含单源 try 隔离 —— 坏源只能缺席，不能否决聚合） */
function validShareOf(raw) {
    try {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw))
            return null;
        const s = raw;
        if (s.v !== SKILL_FED_VERSION)
            return null; // 版本错配：源级事件
        if (typeof s.fingerprint !== 'string' || s.fingerprint === '')
            return null;
        if (!s.slotStats || typeof s.slotStats !== 'object' || Array.isArray(s.slotStats))
            return null;
        return s;
    }
    catch {
        return null; // 陷阱属性：按缺席处理
    }
}
/**
 * W4-2：联邦侧技能聚合（纯函数、确定性、绝不抛 —— robustMergeDigests 的技能域
 * 同律实现）：
 *   · 源甄别：坏份额按缺席处理（excluded）；
 *   · 按指纹分组（首现序），k < SKILL_MIN_AGGREGATE_SOURCES(3) ⇒ 拒聚进 skipped
 *     （诚实跳过：两源的均值没有鲁棒性，不冒充共识）；
 *   · 逐槽聚合：各源该槽中位数 → 再取中位数（中位数的中位数 —— 毒源 < 一半时被
 *     结构性隔离）；槽缺席的源不参与该槽（也不参与该槽检疫 —— 缺席没有离群资格）；
 *   · 逐槽检疫：|源值−鲁棒值| > T ⇒ 该源 1 票；T = max(3×桶宽, 2×该槽源值表的
 *     IQR)（阈值基于鲁棒值 ⇒ 毒源拉不动阈）；
 *   · IQR 聚合取各源 IQR 的中位数（离散度共识）；reliability/useCount 同取中位数
 *     （真值规模的诚实注记，非求和 —— 求和会被洪泛拉爆）。
 */
export function aggregateSkillShares(shares, opts) {
    try {
        const empty = { aggregated: [], quarantined: {}, skipped: [], excluded: [], notes: [] };
        if (!Array.isArray(shares) || shares.length === 0) {
            empty.notes.push('输入非数组或为空：无可聚合源（诚实空手）');
            return empty;
        }
        const sourceIds = Array.isArray(opts?.sourceIds) ? opts.sourceIds : [];
        const labelOf = (i) => {
            const s = sourceIds[i];
            return typeof s === 'string' && s !== '' ? s : String(i);
        };
        const groups = new Map();
        const excluded = [];
        shares.forEach((raw, i) => {
            const s = validShareOf(raw);
            if (!s) {
                excluded.push(i);
                return;
            }
            let g = groups.get(s.fingerprint);
            if (!g) {
                g = { sources: new Set(), reliability: [], useCount: [], slots: new Map(), iqrs: new Map() };
                groups.set(s.fingerprint, g);
            }
            g.sources.add(i);
            if (typeof s.reliability === 'number' && Number.isFinite(s.reliability)) {
                g.reliability.push(Math.min(1, Math.max(0, s.reliability)));
            }
            if (typeof s.useCount === 'number' && Number.isFinite(s.useCount) && s.useCount > 0) {
                g.useCount.push(Math.floor(s.useCount));
            }
            for (const key of Object.keys(s.slotStats ?? {})) {
                const st = s.slotStats[key];
                const med = st && typeof st.median === 'number' && Number.isFinite(st.median) ? st.median : null;
                const iqr = st && typeof st.iqr === 'number' && Number.isFinite(st.iqr) && st.iqr >= 0 ? st.iqr : null;
                if (med === null)
                    continue; // 坏槽：缺席（不参与聚合也不参与检疫）
                const domain = st && st.domain === 'hash' ? 'hash' : 'coord'; // ΠΑΝ-69：缺省 coord（旧份额零迁移）
                const arr = g.slots.get(key) ?? [];
                arr.push({ i, median: med, domain });
                g.slots.set(key, arr);
                if (iqr !== null) {
                    const ia = g.iqrs.get(key) ?? [];
                    ia.push(iqr);
                    g.iqrs.set(key, ia);
                }
            }
        });
        const aggregated = [];
        const skipped = [];
        const quarantined = {};
        const notes = [];
        for (const [fingerprint, g] of groups) {
            const k = g.sources.size;
            if (k < SKILL_MIN_AGGREGATE_SOURCES) {
                skipped.push(fingerprint);
                continue; // k<3 拒聚：少源是噪声不是共识
            }
            const slotStats = {};
            for (const key of [...g.slots.keys()].sort()) {
                const entries = g.slots.get(key);
                const values = entries.map(e => e.median);
                const robust = medianF(values);
                // ΠΑΝ-69：检疫阈按槽的值域标注取地板 —— 坐标通道 3×桶宽（0.05 网格 ⇒
                // 0.15，旧律）；哈希通道 3×1 = 3（uint32 身份域的桶宽 1 —— ε=1 的 Laplace
                // 噪声中位 |noise|≈0.69 < 3，诚实源不吃票；旧律对哈希中位数用 0.15 的
                // 地板 ⇒ DP 噪声本身就会逐槽计票）。缺省（旧格式份额）= 'coord'。
                const domain = entries[0]?.domain ?? 'coord';
                const gridFloor = SKILL_OUTLIER_FLOOR_BUCKETS * (domain === 'hash' ? SKILL_HASH_GRID : SKILL_LSH_GRID);
                // ΤΕΛ-5 D-G25③：离散臂换 robustDispersionOf（IQR 等价 MAD 口径 —— 少源
                // 时四分位插值不再把毒隙半程混进阈，3 诚实 + 1 毒的 k=4 组毒源照常计票；
                // ≥4 诚实源域与旧 2×IQR 律同尺度 —— 见 aggregate.madOf 头注）
                const T = Math.max(gridFloor, SKILL_OUTLIER_IQR_SCALE * robustDispersionOf(values));
                for (const { i, median } of entries) {
                    if (Math.abs(median - robust) > T) {
                        const label = labelOf(i);
                        quarantined[label] = (quarantined[label] ?? 0) + 1;
                    }
                }
                const iqrConsensus = medianF(g.iqrs.get(key) ?? [0]);
                slotStats[key] = {
                    median: Math.round(robust * 1000) / 1000,
                    iqr: Math.round(iqrConsensus * 1000) / 1000,
                    ...(domain === 'hash' ? { domain: 'hash' } : {}), // ΠΑΝ-69：值域标注随聚合产物透传
                };
            }
            aggregated.push({
                fingerprint,
                aggregatedFrom: k,
                slotStats,
                reliability: Math.round(medianF(g.reliability.length > 0 ? g.reliability : [0.5]) * 1000) / 1000,
                useCount: Math.round(medianF(g.useCount.length > 0 ? g.useCount : [1])),
            });
        }
        if (excluded.length > 0)
            notes.push(`坏源按缺席处理：${excluded.join(', ')}（序号）`);
        if (skipped.length > 0)
            notes.push(`k<${SKILL_MIN_AGGREGATE_SOURCES} 拒聚 ${skipped.length} 个指纹（少源是噪声不是共识 —— 诚实跳过）`);
        const voteTotal = Object.values(quarantined).reduce((s, v) => s + v, 0);
        if (voteTotal > 0)
            notes.push(`离群检疫共 ${voteTotal} 票（逐槽计票 —— 与 robustMergeDigests 同律）`);
        return { aggregated, quarantined, skipped, excluded, notes };
    }
    catch {
        return { aggregated: [], quarantined: {}, skipped: [], excluded: [], notes: ['聚合过程异常：诚实空手（绝不炸宿主）'] };
    }
}
// ─── 注入三律之一：Thompson/Beta 采样决策（纯函数） ───
/** Beta 采样器实例（H-3 的 Marsaglia–Tsang 实现 —— 复用不复制；swarm.thompsonTopRoutes 同律） */
const betaSampler = new Telemetry();
/**
 * W4-2：Thompson 注入决策（绝不抛）：Beta(α, β) 单样本 ≥ 0.5 才注入尝试。
 *   α = reliability·useCount + 1，β = (1−reliability)·useCount + 1 —— 把聚合面的
 *   (可靠度, 使用计数) 还原成 Beta 后验（swarm 晶体的 Beta(s+1, f+1) 同构：
 *   reliability 即后验均值、useCount 即证据量）。价值：低证据候选后验宽，偶被
 *   抽高而获一次尝试机会（按证据不足程度成比例探索）；高证据候选分布窄，
 *   长期由真值主导。uniform 流注入 ⇒ 确定性可测；采样器故障 ⇒ false（保守臂）。
 */
export function shouldAttemptInjection(reliability, useCount, uniform) {
    try {
        const r = numOr(reliability, 0.5, 0, 1);
        const n = Math.max(1, Math.floor(numOr(useCount, 1, 0, 1e9)));
        const sample = betaSampler.sampleBeta(r * n + 1, (1 - r) * n + 1, uniform);
        return Number.isFinite(sample) && sample >= SKILL_INJECT_SAMPLE_GATE;
    }
    catch {
        return false; // 绝不抛：保守不注入
    }
}
/**
 * W4-2：技能联邦接收端（防御式绝不抛 —— 一切故障诚实跳过）。
 * 三道闸（federation.applyFederatedEvidence 同律的技能域移植）：
 *   ① 本地零证据不掺：本地技能数为 0 ⇒ 全跳过（本地没有技能生态就不引入
 *      外源候选 —— 防外源漂移）；
 *   ② 份额帽：cap = floor(maxRemoteShare × 本地技能数)，防远端候选洪泛；
 *   ③ 信任折减：quota = floor(cap × trust)（信任账 1/(1+regressed) —— 检疫票
 *      经 applyQuarantineToTrust 折算过的源在此被折减）。
 * 注入律：配额内逐候选 Thompson 采样（shouldAttemptInjection）—— 采样通过才
 * 登记，且登记的候选一律 **dormant**（只进本账本，绝不进匹配池）。
 * 独立记账：本账本只动自己的计数器，不触碰 evidenceLedger / kernelRegistry。
 */
class SkillFederation {
    port = null;
    candidates = new Map();
    totals = { localHits: 0, activations: 0, thompsonAttempts: 0 };
    lastReceivedAt = 0;
    /** 接线 skillLibrary 端口（null = 摘线 —— 一切面诚实归零语义） */
    configure(port) {
        try {
            this.port = port && typeof port.listSkillDigests === 'function' && typeof port.addDormantSkill === 'function'
                ? port
                : null; // 形状不合法的端口按未接线处理（绝不抛）
        }
        catch {
            this.port = null;
        }
    }
    /** 接收聚合产物（见类 JSDoc 三道闸 + 注入律） */
    receive(aggregated, opts = {}) {
        const base = {
            ok: true, injected: 0, cap: 0, quota: 0, trust: 1, localSkillCount: 0, perFingerprint: [], notes: [],
        };
        try {
            let nowMs = Date.now();
            if (typeof opts.now === 'function') {
                try {
                    const t = opts.now();
                    if (Number.isFinite(t))
                        nowMs = t;
                }
                catch { /* 时钟故障保持 Date.now */ }
            }
            this.lastReceivedAt = nowMs;
            // 本地证据面：显式注入优先；否则端口实读（端口故障 ⇒ 0 —— 安全方向）
            let localN = 0;
            if (typeof opts.localSkillCount === 'number' && Number.isFinite(opts.localSkillCount) && opts.localSkillCount >= 0) {
                localN = Math.floor(opts.localSkillCount);
            }
            else if (this.port) {
                try {
                    localN = Array.isArray(this.port.listSkillDigests()) ? this.port.listSkillDigests().length : 0;
                }
                catch {
                    localN = 0;
                }
            }
            // 信任解析：显式 trust 优先；否则查信任账；再否则初见全信
            let trust = 1;
            if (typeof opts.trust === 'number' && Number.isFinite(opts.trust) && opts.trust > 0) {
                trust = Math.min(1, opts.trust);
            }
            else if (typeof opts.sourceId === 'string' && opts.sourceId !== '') {
                trust = federationTrustOf(opts.sourceId);
            }
            const share = numOr(opts.maxRemoteShare, DEFAULT_MAX_REMOTE_SHARE, 0, 1);
            const cap = Math.floor(share * localN);
            const quota = Math.floor(cap * trust);
            const report = { ...base, trust, localSkillCount: localN, cap, quota };
            const items = Array.isArray(aggregated) ? aggregated : [];
            if (items.length === 0) {
                report.notes.push('聚合产物为空：无可接收者（诚实空手 —— peer 缺席/数据不足是常态不是错误）');
                return report;
            }
            if (localN <= 0) {
                report.notes.push('闸①：本地零技能证据不掺入（防外源漂移 —— 本地没有技能生态）');
                return report;
            }
            if (cap <= 0) {
                report.notes.push(`闸②：份额上限折没（share=${share} × 本地 ${localN} 技 ⇒ cap=0）`);
                return report;
            }
            if (quota <= 0) {
                report.notes.push(`闸③：信任折没（trust=${Math.round(trust * 1000) / 1000} × cap=${cap} ⇒ quota=0）`);
                return report;
            }
            const rng = typeof opts.rng === 'function' ? opts.rng : Math.random;
            let injected = 0;
            for (const raw of items) {
                try {
                    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
                        continue; // 坏条目缺席
                    const a = raw;
                    if (typeof a.fingerprint !== 'string' || a.fingerprint === '')
                        continue;
                    if (typeof a.aggregatedFrom !== 'number' || a.aggregatedFrom < SKILL_MIN_AGGREGATE_SOURCES) {
                        report.perFingerprint.push({ fingerprint: String(a.fingerprint), decision: 'reject-k-lt-3' });
                        continue; // 聚合门防御性复审：k<3 的聚合产物不收
                    }
                    if (injected >= quota) {
                        report.perFingerprint.push({ fingerprint: a.fingerprint, decision: 'quota-exhausted' });
                        continue; // 配额用尽：诚实出局
                    }
                    // 注入律①：Thompson/Beta 采样决定是否注入尝试
                    const rel = numOr(a.reliability, 0.5, 0, 1);
                    const use = Math.max(1, Math.floor(numOr(a.useCount, 1, 0, 1e9)));
                    let sampled = false;
                    try {
                        sampled = shouldAttemptInjection(rel, use, rng);
                    }
                    catch {
                        sampled = false; // 采样故障：保守不注入
                    }
                    if (!sampled) {
                        report.perFingerprint.push({ fingerprint: a.fingerprint, decision: 'thompson-reject' });
                        continue;
                    }
                    injected += 1;
                    this.totals.thompsonAttempts += 1;
                    // W7-0：候选写入 = 账本突变（武装了持久化时按突变计数节流落盘；
                    // 缺省未武装 ⇒ 零磁盘，接收语义零变化）
                    noteSkillFedMutation();
                    // 注入律②：候选默认 dormant —— 只登记，绝不进匹配池。已有候选 ⇒ 刷新
                    // 统计但**保留 localHits 与 state**（本地证据只增不减，联邦刷新不清账）
                    const existing = this.candidates.get(a.fingerprint);
                    const slotStats = {};
                    if (a.slotStats && typeof a.slotStats === 'object' && !Array.isArray(a.slotStats)) {
                        for (const key of Object.keys(a.slotStats).sort()) {
                            const st = a.slotStats[key];
                            const med = st && typeof st.median === 'number' && Number.isFinite(st.median)
                                ? st.median : 0;
                            const iqr = st && typeof st.iqr === 'number' && Number.isFinite(st.iqr) && st.iqr >= 0
                                ? st.iqr : 0;
                            // ΠΑΝ-69：值域标注随候选透传（激活登记草案携带 —— 下游消费同口径）
                            slotStats[key] = st.domain === 'hash'
                                ? { median: med, iqr: iqr, domain: 'hash' }
                                : { median: med, iqr: iqr };
                        }
                    }
                    this.candidates.set(a.fingerprint, {
                        fingerprint: a.fingerprint,
                        slotStats,
                        reliability: rel,
                        useCount: use,
                        aggregatedFrom: Math.floor(a.aggregatedFrom),
                        receivedAt: nowMs,
                        state: existing?.state ?? 'dormant',
                        localHits: existing?.localHits ?? 0,
                    });
                    report.perFingerprint.push({ fingerprint: a.fingerprint, decision: existing ? 'refreshed-dormant-ledger' : 'registered-dormant' });
                }
                catch {
                    continue; // 单条读取故障：缺席，其余不受牵连
                }
            }
            report.injected = injected;
            if (injected === 0)
                report.notes.push('配额在场但零候选通过 Thompson 采样（保守臂 —— 诚实注记）');
            return report;
        }
        catch {
            return { ...base, ok: false, notes: ['接收过程异常：诚实全跳（绝不炸宿主）'] };
        }
    }
    /**
     * W4-2 注入律③：本地命中记账 —— 命中 2 次激活。激活动作 = 经 skillLibrary 端口
     * addDormantSkill 登记 dormant 技能（登记后它仍是库的 dormant 技能 —— 两段
     * dormant 安全律：联邦登记面 + 库激活面各自把门）。未知指纹的命中诚实忽略
     * （本地巧合不臆造联邦候选）；端口故障/返回 false ⇒ 保持 dormant（下次命中重试）。
     */
    noteLocalHit(fingerprint, now) {
        try {
            const cand = this.candidates.get(fingerprint);
            if (!cand) {
                return { ok: false, state: 'unknown', localHits: 0, activated: false, registered: false, reason: 'unknown-fingerprint' };
            }
            cand.localHits += 1;
            this.totals.localHits += 1;
            // W7-0：命中记账 = 账本突变（节流落盘旁路；缺省未武装零磁盘）
            noteSkillFedMutation();
            if (typeof now === 'function') {
                try {
                    const t = now();
                    if (Number.isFinite(t))
                        cand.receivedAt = t; // 新鲜化（命中即最近在场证据）
                }
                catch { /* 时钟故障保持原值 */ }
            }
            // 已激活：只记账不重复登记（幂等律）
            if (cand.state === 'active') {
                return { ok: true, state: 'active', localHits: cand.localHits, activated: false, registered: false };
            }
            if (cand.localHits < SKILL_ACTIVATE_LOCAL_HITS) {
                return { ok: true, state: 'dormant', localHits: cand.localHits, activated: false, registered: false };
            }
            // 激活：经端口登记 dormant 技能（登记草案只含分布摘要 —— 不可执行件）
            let registered = false;
            if (this.port) {
                try {
                    registered = this.port.addDormantSkill({
                        fingerprint: cand.fingerprint,
                        sceneFingerprint: cand.fingerprint.split(':')[0] ?? '', // 匿名前缀（全指纹从未离开本机）
                        slotStats: cand.slotStats,
                        reliability: cand.reliability,
                        useCount: cand.useCount,
                        provenance: 'federated',
                        aggregatedFrom: cand.aggregatedFrom,
                    }) === true;
                }
                catch {
                    registered = false; // 端口故障：保持 dormant，下次命中重试
                }
            }
            if (registered) {
                cand.state = 'active';
                this.totals.activations += 1;
                // W7-0：激活 = 账本突变（同律节流落盘旁路）
                noteSkillFedMutation();
                return { ok: true, state: 'active', localHits: cand.localHits, activated: true, registered: true };
            }
            return {
                ok: true, state: 'dormant', localHits: cand.localHits, activated: false, registered: false,
                reason: this.port ? 'addDormantSkill-refused' : 'port-not-wired',
            };
        }
        catch {
            return { ok: false, state: 'unknown', localHits: 0, activated: false, registered: false, reason: 'internal-error' };
        }
    }
    /** 候选快照（防御副本 —— 调用方改写不触账本） */
    candidatesSnapshot() {
        try {
            return [...this.candidates.values()]
                .map(c => ({ ...c, slotStats: Object.fromEntries(Object.entries(c.slotStats).map(([k, v]) => [k, { ...v }])) }))
                .sort((a, b) => (a.fingerprint < b.fingerprint ? -1 : 1));
        }
        catch {
            return [];
        }
    }
    /** 联邦技能账观测面（swarm.report 的 federatedSkills 段数据源） */
    ledgerStats() {
        const cands = [...this.candidates.values()];
        return {
            wired: this.port !== null,
            candidates: cands.length,
            dormant: cands.filter(c => c.state === 'dormant').length,
            active: cands.filter(c => c.state === 'active').length,
            localHits: this.totals.localHits,
            activations: this.totals.activations,
            thompsonAttempts: this.totals.thompsonAttempts,
            lastReceivedAt: this.lastReceivedAt,
        };
    }
    /** 测试缝：账本归零（端口一并摘除 —— configure 重接；生产代码无理由调用）。
     *  W7-0：持久化武装一并解除（federation resetFederationRuntime 同律 —— 复位后
     *  回纯内存缺省，零磁盘行为；下次 arm 重武装）。 */
    reset() {
        this.port = null;
        this.candidates.clear();
        this.totals = { localHits: 0, activations: 0, thompsonAttempts: 0 };
        this.lastReceivedAt = 0;
        disarmSkillFederationPersistence();
    }
    // ── W7-0（W6-4 接线收尾）：持久化面 —— 序列化 / 防御恢复（绝不抛） ──
    /**
     * W7-0：账本序列化（落盘形态；指纹字典序 ⇒ 同账本态同字节）。时钟可注入
     * （savedAt 的确定性测试缝）；候选快照与 candidatesSnapshot 同源（防御副本）。
     */
    serialize(now) {
        let savedAt = Date.now();
        if (typeof now === 'function') {
            try {
                const t = now();
                if (Number.isFinite(t))
                    savedAt = t;
            }
            catch { /* 时钟故障保持 Date.now */ }
        }
        const doc = {
            v: SKILL_FED_STORE_VERSION,
            savedAt,
            candidates: this.candidatesSnapshot(),
            totals: { ...this.totals },
            lastReceivedAt: this.lastReceivedAt,
        };
        return JSON.stringify(doc);
    }
    /**
     * W7-0：防御恢复（垃圾归先验、绝不抛）—— 档**整体替换**账本候选与计数
     * （restore 是权威语义；端口接线不落盘不复原 —— wiring 是运行时面）。
     * 档级垃圾（非对象/版本错配/candidates 非数组）⇒ 整档拒绝（restored:0 +
     * note，账本不动）；条目级垃圾（无指纹）⇒ skipped++；字段级垃圾归先验
     * （state 垃圾 ⇒ dormant；数值垃圾 ⇒ 0/0.5/1 的保守缺省）。恢复幂等。
     */
    restoreLedger(payload) {
        try {
            if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
                return { restored: 0, skipped: 0, note: '技能账档非对象：整档拒绝（内存账不动）' };
            }
            const doc = payload;
            if (doc.v !== SKILL_FED_STORE_VERSION) {
                return { restored: 0, skipped: 0, note: `技能账档版本不符（期望 v=${SKILL_FED_STORE_VERSION}）：整档拒绝` };
            }
            if (!Array.isArray(doc.candidates)) {
                return { restored: 0, skipped: 0, note: '技能账档 candidates 非数组：整档拒绝' };
            }
            const next = new Map();
            let skipped = 0;
            for (const raw of doc.candidates) {
                if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
                    skipped++;
                    continue;
                }
                const e = raw;
                if (typeof e.fingerprint !== 'string' || e.fingerprint === '') {
                    skipped++;
                    continue;
                } // 无主条目不立账
                const slotStats = {};
                if (e.slotStats && typeof e.slotStats === 'object' && !Array.isArray(e.slotStats)) {
                    for (const key of Object.keys(e.slotStats)) {
                        const st = e.slotStats[key];
                        if (!st || typeof st !== 'object')
                            continue; // 坏槽缺席（聚合/检疫同律）
                        // 字段级垃圾归 0（保守缺省 —— 中位数 0 的分布摘要不可执行件）
                        slotStats[key] = {
                            median: typeof st.median === 'number' && Number.isFinite(st.median) ? st.median : 0,
                            iqr: typeof st.iqr === 'number' && Number.isFinite(st.iqr) && st.iqr >= 0 ? st.iqr : 0,
                            ...(st.domain === 'hash' ? { domain: 'hash' } : {}), // ΠΑΝ-69：值域标注持久化往返保持
                        };
                    }
                }
                next.set(e.fingerprint, {
                    fingerprint: e.fingerprint,
                    slotStats,
                    reliability: numOr(e.reliability, 0.5, 0, 1), // 垃圾 ⇒ 0.5 先验
                    useCount: Math.max(1, sanitizeCount(e.useCount) || 1),
                    aggregatedFrom: sanitizeCount(e.aggregatedFrom), // 垃圾 ⇒ 0（消费方 k≥3 门自会复审）
                    receivedAt: typeof e.receivedAt === 'number' && Number.isFinite(e.receivedAt) ? e.receivedAt : 0,
                    state: e.state === 'active' ? 'active' : 'dormant', // 垃圾 ⇒ dormant（注入三律的安全方向）
                    localHits: sanitizeCount(e.localHits),
                });
            }
            this.candidates.clear();
            for (const [k, v] of next)
                this.candidates.set(k, v);
            const t = (doc.totals ?? {});
            this.totals = {
                localHits: sanitizeCount(t.localHits),
                activations: sanitizeCount(t.activations),
                thompsonAttempts: sanitizeCount(t.thompsonAttempts),
            };
            this.lastReceivedAt = typeof doc.lastReceivedAt === 'number' && Number.isFinite(doc.lastReceivedAt)
                ? doc.lastReceivedAt : 0;
            resetSkillFedMutationClock(); // 恢复即权威：突变计数与节流钟一并归零
            return { restored: next.size, skipped };
        }
        catch {
            return { restored: 0, skipped: 0, note: '恢复过程异常：整档拒绝（防御式兜底）' };
        }
    }
}
/** W4-2：技能联邦接收端单例（W7-0 前账本纯内存不落盘 —— 现可选持久化，缺省仍未武装） */
export const skillFederation = new SkillFederation();
// ─── W7-0（W6-4 接线收尾）：联邦技能账持久化 —— 信任账（federation 信任账）刚例的移植 ───
//
// 纪律（federation/index.ts W6-4 持久化缝包逐字同律）：
//   · 原子写 —— tmp + fsync + rename：要么完整旧档要么完整新档，绝无半档；
//     写失败 = 诚实 ok:false（账本继续在内存执法 —— 持久化是旁路义务）；
//   · 防御恢复 —— 垃圾归先验：条目级跳过、字段级归 0/0.5/1、档级整档拒绝；
//     state 垃圾 ⇒ dormant（dormant 安全律的恢复向：宁可重新攒两次本地命中）；
//   · 节流 —— 突变计数制（每 N 次账本突变一次落盘）：无时钟依赖、离线可测；
//   · 缺省未武装 —— arm 之前一切公开面零磁盘行为（与旧行为逐字节一致，
//     skillFederation.reset() 解除武装 = 测试隔离缝。ΑΩ-R34：旧名核正，同上）。
/** W7-0：技能账档 schema 版本（版本错配 ⇒ 整档拒绝恢复） */
export const SKILL_FED_STORE_VERSION = 1;
/** W7-0：突变计数节流缺省：每 8 次账本突变落盘一次（信任账 DEFAULT_TRUST_FLUSH_EVERY 同值） */
export const DEFAULT_SKILL_FED_FLUSH_EVERY = 8;
/** W7-0：单计数字段消毒（信任账 sanitizeTrustCount 同律）：有限非负 ⇒ 取整封顶；其余 ⇒ 0 */
function sanitizeCount(v) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0)
        return 0;
    return Math.min(Math.floor(v), Number.MAX_SAFE_INTEGER);
}
/** 已武装的存储端口（armSkillFederationPersistence 注入；null = 纯内存） */
let skillFedStore = null;
/** 节流阈值：每 N 次账本突变触发一次落盘 */
let skillFedFlushEvery = DEFAULT_SKILL_FED_FLUSH_EVERY;
/** 自上次成功落盘以来的突变计数（节流钟） */
let skillFedMutations = 0;
/** W7-0：突变计数推进 + 节流落盘（receive/noteLocalHit 的旁路尾钩，绝不抛） */
function noteSkillFedMutation() {
    try {
        skillFedMutations++;
        if (skillFedStore && skillFedMutations >= skillFedFlushEvery)
            flushSkillFederationLedger();
    }
    catch {
        /* 绝不抛 */
    }
}
/** W7-0：突变计数归零（恢复/冲刷后的节流钟重置） */
function resetSkillFedMutationClock() {
    skillFedMutations = 0;
}
/**
 * W7-0：解除武装（reset 的摘线面 + 测试隔离缝 —— 端口摘除、阈值回缺省、计数归零）。
 * ΤΕΛ-1 起导出：生产卸载链的摘线面（组合根 flush 后调用 —— 信任账的
 * resetFederationRuntime 同律；不导出则热重载后武装残留在旧存储端口，下个
 * 会话的突变会写进上个会话的目录）。绝不抛。
 */
export function disarmSkillFederationPersistence() {
    skillFedStore = null;
    skillFedFlushEvery = DEFAULT_SKILL_FED_FLUSH_EVERY;
    skillFedMutations = 0;
}
/** W7-0：文件存储实现（原子写：tmp + fsync + rename —— federation 信任账同律，绝不抛） */
export function createSkillFedFileStore(filePath) {
    return {
        load() {
            try {
                if (!filePath || !existsSync(filePath))
                    return null;
                const text = readFileSync(filePath, 'utf8');
                return typeof text === 'string' && text.trim() !== '' ? text : null;
            }
            catch {
                return null; // 读故障（含 ENOENT 竞态）= 无持久化账（诚实方向）
            }
        },
        save(text) {
            if (!filePath)
                return { ok: false, error: 'skill-fed store path is empty' };
            const tmp = filePath + '.tmp';
            try {
                mkdirSync(pathDirname(filePath), { recursive: true });
                // fsync 落盘后再换名：rename 可先于数据块持久化 —— 崩溃后可能读到空/截断档
                const fd = openSync(tmp, 'w');
                try {
                    writeSync(fd, Buffer.from(text, 'utf8'));
                    fsyncSync(fd);
                }
                finally {
                    closeSync(fd);
                }
                renameSync(tmp, filePath); // 原子换名：要么完整旧档要么完整新档
                return { ok: true };
            }
            catch (e) {
                try {
                    unlinkSync(tmp);
                }
                catch { /* tmp 可能未创建 */ }
                return { ok: false, error: e instanceof Error ? e.message : String(e) };
            }
        },
    };
}
/**
 * W7-0：武装技能账持久化（幂等：重复武装以后一次为准）。store 结构非法 ⇒
 * false（诚实拒绝，保持纯内存）。武装后账本突变每 flushEvery 次触发一次原子
 * 落盘；flushSkillFederationLedger 随时可强制冲刷。绝不抛。
 */
export function armSkillFederationPersistence(store, opts) {
    try {
        if (!store || typeof store.load !== 'function' || typeof store.save !== 'function')
            return false;
        skillFedStore = store;
        const raw = opts?.flushEvery;
        skillFedFlushEvery = typeof raw === 'number' && Number.isFinite(raw) && raw >= 1
            ? Math.floor(raw)
            : DEFAULT_SKILL_FED_FLUSH_EVERY;
        skillFedMutations = 0;
        return true;
    }
    catch {
        return false; // 防御式兜底：武装失败保持纯内存
    }
}
/**
 * W7-0：立即落盘（强制冲刷，绝不抛、幂等）。未武装 ⇒ ok:true + written:0
 * （纯内存是合法配置态，不是故障）。写失败 ⇒ ok:false + error（突变计数保留
 * ⇒ 下次突变即重试；内存账不受影响 —— 持久化失败绝不反噬联邦执法）。
 */
export function flushSkillFederationLedger() {
    try {
        if (!skillFedStore)
            return { ok: true, written: 0 };
        const text = skillFederation.serialize();
        const res = skillFedStore.save(text);
        if (res.ok) {
            skillFedMutations = 0;
            let written = 0;
            try {
                written = JSON.parse(text).candidates.length;
            }
            catch {
                written = 0;
            }
            return { ok: true, written };
        }
        return { ok: false, written: 0, error: res.error ?? 'save failed' };
    }
    catch (e) {
        return { ok: false, written: 0, error: e instanceof Error ? e.message : String(e) };
    }
}
/**
 * W7-0：从存储端口读档并恢复（生产接线的一步调用：启动时 arm 前先 load）。
 * 档缺席/不可读/坏 JSON ⇒ restored:0 + note（冷启动空账 —— 诚实方向，绝不抛）。
 */
export function loadSkillFederationLedger(store) {
    try {
        if (!store || typeof store.load !== 'function') {
            return { restored: 0, skipped: 0, note: '存储端口缺席：无持久化账可恢复' };
        }
        const text = store.load();
        if (text === null || text === '') {
            return { restored: 0, skipped: 0, note: '无持久化档：冷启动空账' };
        }
        try {
            return skillFederation.restoreLedger(JSON.parse(text));
        }
        catch {
            return { restored: 0, skipped: 0, note: '技能账档坏 JSON：整档拒绝（冷启动空账）' };
        }
    }
    catch {
        return { restored: 0, skipped: 0, note: '读档异常：整档拒绝（防御式兜底）' };
    }
}
/** W7-0：持久化簿记状态（审计面：armed/阈值/未冲刷突变/候选数，防御副本） */
export function skillFederationPersistenceStatus() {
    return {
        armed: skillFedStore !== null,
        flushEvery: skillFedFlushEvery,
        pendingMutations: skillFedMutations,
        candidates: skillFederation.ledgerStats().candidates,
    };
}
// ─── swarm 接线（packet v2 的技能联邦段 + 晶体层联邦技能账） ───
/**
 * W4-2：生产接线（宿主一行完成）：① 接上 skillLibrary 结构化端口（真源由 W4-1
 * 的 listSkillDigests/addDormantSkill 契约提供）；② 把上传铸造与账本观测面挂进
 * swarm —— buildPacket 从此携带 schema v2 的技能联邦段，report 携带联邦技能账。
 * 返回 false = 接线失败（端口形状坏等 —— 诚实降级为未接线，绝不抛）。
 * 注：swarm.ts 对本模块只有 import type（编译期擦除）—— 无运行时模块环。
 */
export function wireSwarmSkillFederation(port) {
    try {
        // 形状闸：非空端口必须是完整契约形状（listSkillDigests + addDormantSkill）——
        // 形状坏 ⇒ 拒绝接线（诚实 false），swarm 保持未接线行为
        if (port !== null && port !== undefined &&
            (typeof port !== 'object' ||
                typeof port.listSkillDigests !== 'function' ||
                typeof port.addDormantSkill !== 'function')) {
            return false;
        }
        const wired = port ?? null;
        skillFederation.configure(wired);
        if (!wired) {
            swarm.attachSkillFederation(null);
            return true; // 显式摘线也是成功语义
        }
        swarm.attachSkillFederation({
            uploads: (dpEpsilon, uniform) => buildSkillUploads(wired, { epsilon: dpEpsilon, rng: uniform }),
            ledgerStats: () => skillFederation.ledgerStats(),
        });
        return true;
    }
    catch {
        return false; // 接线故障：诚实降级（swarm 保持无技能段行为）
    }
}
