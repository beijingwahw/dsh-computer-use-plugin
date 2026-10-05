// src/federation/digest.ts
// W9-3（D-F4 拆分·摘要分区）：自 federation/index.ts 低风险提取 —— 算法形状
// 常数（摘要 schema/坨数/裁剪域/超时/ε/份额缺省）+ 确定性随机源与 Laplace 噪声
// + Μ-a 铸摘要 / Μ-b 合并摘要。逐字节搬运（零逻辑变更）；index.ts 原位再导出 —
// — 导入面不变（消费方零改动）。
// ΝΩ-20（隐私会计）：摘要铸造不再是无台账的免费动作 —— (a) rdpEpsilon 纯函数
// 给出 Laplace 的 Rényi 发散度（Mironov 公式）；(b) 模块级 privacyBudget 账本累计
// ε，Σε 超冻结上限 ⇒ mint 拒绝（返回 null，绝不抛）且拒绝事实在账本上如实申报；
// (c) 每 key 的 n 改 Laplace(1/ε) 加噪取整非负（活动量不再明文出境）；(d) 可选
// 泊松子采样 γ（缺省关 —— 旧行为逐字节）+ 采样放大 ε_eff = log(1+γ(e^ε−1))。
// 预算未超 ⇒ 铸造结果与旧实现逐字节一致（零回归纪律）。
// ΠΑΝ-70（种子与参数的 fail-closed）：显式给出但非法的 ε（≤0 / 非有限）⇒ 拒绝
// 铸造（返回 null）—— 不再静默回落缺省 ε（「配置错当没配」是隐私面的 fail-open，
// 方向反转）；注入 rng 产出任何非有限抽头 ⇒ 整次铸造中止（绝不以零噪声真值出境
// —— 旧注释宣称「多掩蔽方向」而实现恰好反向，本工单对齐）。种子本身的密钥化
// 派生在传输分区（sync.ts 的 HMAC(K_fed, digest_id)）。
// ΠΑΝ-71（预算按主体记账）：账本键从「窗口指纹」（滑窗每滑一条 ⇒ 新指纹 ⇒ 新
// ε=10 账户 —— 相邻窗共享 199/200 条记录的重叠释放根本不组合）改为「主体 # 键」
//（subject 缺省 'local'，federationSync 喂 endpoint）：键族之间是并行组合（不同
// key 的证据是 disjoint 个体 —— 各记各账互不叠加），同键跨窗口的滑窗重叠释放
// 按最保守的朴素序列组合 Σε 累计（内容怎么滑都不换账）；预算闸内部故障 ⇒
// fail-closed（拒绝铸造，绝不放行）；账本 Map 加冻结上界（上界满 ⇒ 拒绝开新账
// —— 逐出等于洗预算，方向不可取）。
// ΠΑΝ-73（回声环闭合）：账本视图的条目带 origin 时，联邦掺入记录（origin ===
// 'federation'）不进摘要 —— 本地铸造只消费本地真实观察，掺入的远端证据下一轮
// 不再被重新铸成摘要重新上传（含 DP 噪声的反馈放大环就此切断）。
// ─── 常量（算法形状字面量 —— 非旋钮） ───
/** 摘要 schema 版本：mergeDigests 见到任一输入版本不符 ⇒ 整体拒绝合并返回 null */
export const DIGEST_VERSION = 1;
/** 每 key 的 margin 坨数 K=8（裁剪域均分，坨宽 0.25） */
export const DIGEST_BINS = 8;
/**
 * margin 裁剪域 [-1, +1]。账本真实域读码定：registry 的 margin 是任意有限值
 * （相似度 / 汉明距离 / 置信差等，器官各异且无全局界）—— 联邦摘要取对称单位域
 * 裁剪：域内无损，域外夹到边界（分布尾被保守收拢，坨坐标仍可反演）。
 */
export const DIGEST_MARGIN_CLIP = 1;
/** 联邦单次 POST 超时（swarm.fireUpload 同律 5s —— 遥测是旁路义务不是主路债主） */
export const FEDERATION_TIMEOUT_MS = 5_000;
/** 差分隐私 ε 缺省（config.federationEpsilon 同缺省 1 —— 与 H-5 群体结晶一致） */
export const DEFAULT_FEDERATION_EPSILON = 1;
/** 远端份额上限缺省（config.federationMaxRemoteShare 同缺省 0.5 —— 至多对半掺入） */
export const DEFAULT_MAX_REMOTE_SHARE = 0.5;
/**
 * ΝΩ-20：隐私预算总上限 —— 每个记账主体（主体 # 键）的累计 ε 不得超过 10（常量冻结）。
 * 语义：同一主体同一 key 的证据无论被 sync 多少次、滑窗滑多少条，朴素序列组合下的
 * 纯 DP 损失上界 Σε ≤ 10 —— sync 任意频率、窗口任意滑动都不再能无界放大隐私损失。
 */
export const PRIVACY_BUDGET_EPSILON_TOTAL = 10;
/**
 * ΠΑΝ-71：预算账本的账户数冻结上界（内存有界纪律）。上界已满时再需开新账户 ⇒
 * 拒绝铸造（fail-closed）—— 逐出旧账户等于给旧主体洗预算，方向不可取；诚实
 * 方向是停下并保持拒绝（生产上 4096 个主体#键组合已远超真实联邦规模）。
 */
export const PRIVACY_BUDGET_MAX_ACCOUNTS = 4096;
/**
 * ΠΑΝ-70：单次 release 的 ε 合法域 —— (0, PRIVACY_BUDGET_EPSILON_TOTAL]（有限）。
 * 这是 config.federationEpsilon 的范围校验对接点（config 侧与本模块共用同一判据，
 * 防两处立法漂移）：单次 release 超过预算总上限的 ε 在任何有数据的窗口都不可
 * 能被预算闸放行 —— 视为配置错误，在铸造入口就拒绝（fail-closed，绝不静默
 * 回落缺省）。纯函数、绝不抛。
 */
export function validFederationEpsilon(eps) {
    return (typeof eps === 'number' && Number.isFinite(eps) &&
        eps > 0 && eps <= PRIVACY_BUDGET_EPSILON_TOTAL);
}
/** ΝΩ-20：RDP 阶数缺省（冻结 α=10 —— rdpEpsilon 审计口径的固定阶） */
export const RDP_ORDER = 10;
/** ΝΩ-20：预算闸的浮点容差（Σε 与上限比较防 0.1+0.2 型尘埃误判方向） */
const PRIVACY_BUDGET_EPS_TOL = 1e-9;
// ─── 随机源与噪声（纯函数，确定性可测） ───
// ΝΩ-41（方言克隆律）：mulberry32 / fnv1a32 的本地副本退役 —— 流内核与滚动
// 哈希内核改自单源 src/dialects/random.ts 导入；federation 侧种子/累积器消毒
// 卫兵（floor / 非有限回落）在本边界包一层（dialects/random 头注的分工律，
// 与 gym.mulberry32 同式）。种子流与指纹逐字节一致（金样
// test/no41.dialectClones.test.ts），模块无新增依赖、不背自主环。
import { mulberry32 as dialectMulberry32, fnv1aSeeded } from '../dialects/random.js';
/**
 * mulberry32：32 位确定性 PRNG（种子钉死 ⇒ 序列钉死 ⇒ 同 seed 同摘要）。
 * 单源流内核 + federation 种子归一卫兵（有限值 Math.floor / 非有限按 0 记 ——
 * 收口前本地实现逐字节同律）。非有限种子按 0 记。
 */
export function mulberry32(seed) {
    return dialectMulberry32(typeof seed === 'number' && Number.isFinite(seed) ? Math.floor(seed) : 0);
}
/**
 * Laplace(0, scale) 噪声（纯函数，绝不抛）：swarm.buildPacket 同式的逆 CDF 采样
 * —— u ∈ [0,1) 经 -scale·sign(u-½)·ln(1-2|u-½|+1e-12) 映射（1e-12 是 u 触界时
 * log(0) 的护栏）。消毒律：scale 非有限或 ≤ 0 ⇒ 0（无噪声）；u 非有限 ⇒ 取 0.5
 * （sign(0)=0 ⇒ 噪声 0 —— 确定性降级点）；u 夹回 [0, 1-1e-12] 防域外输入炸 log。
 * 对称性是测试面：u 与 1-u 关于 0.5 对称 ⇒ 噪声严格反号。
 */
export function laplaceNoise(scale, uniform) {
    if (!Number.isFinite(scale) || scale <= 0)
        return 0;
    const u = Number.isFinite(uniform) ? Math.min(Math.max(uniform, 0), 1 - 1e-12) : 0.5;
    return -scale * Math.sign(u - 0.5) * Math.log(1 - 2 * Math.abs(u - 0.5) + 1e-12);
}
/** 数值护栏：x 非有限或越界 ⇒ 缺省（calibrator.numOr 同律，绝不抛） */
export function numOr(x, dflt, min, max) {
    return typeof x === 'number' && Number.isFinite(x) && x >= min && x <= max ? x : dflt;
}
/**
 * ΝΩ-20 (a)：Laplace(0, 1/ε) 机制的 α 阶 Rényi 发散度（纯函数、绝不抛）。
 * Mironov《Rényi Differential Privacy and the Posterior Sampling》(CSF'17) 的
 * Laplace 闭式（敏感度 Δ=1、尺度 b=1/ε）：
 *
 *   D_α = (1/(α−1)) · log( (α/(2α−1))·e^{(α−1)·ε} + ((α−1)/(2α−1))·e^{−α·ε} )
 *
 * 消毒律：ε ≤ 0 / 非有限 ⇒ 0（零噪声尺度的机制零发散——ε=0 即完美隐私）；α ≤ 1 /
 * 非有限 ⇒ 冻结缺省阶 RDP_ORDER；数值溢出（大 α·ε）⇒ 回落纯 DP 界 ε —— 这恰是
 * α→∞ 的正确极限（RDP 单调收敛于纯 DP，D_α ≤ ε 恒成立，回落只会更保守不更乐观）。
 * 性质面（测试执法）：D_α ≤ ε、对 ε 单调、对 α 单调（α↑ ⇒ 收敛 ε）。
 */
export function rdpEpsilon(eps, alpha = RDP_ORDER) {
    const e = typeof eps === 'number' && Number.isFinite(eps) && eps > 0 ? eps : 0;
    if (e === 0)
        return 0;
    const a = typeof alpha === 'number' && Number.isFinite(alpha) && alpha > 1 ? alpha : RDP_ORDER;
    const w1 = a / (2 * a - 1);
    const w2 = (a - 1) / (2 * a - 1);
    const d = (Math.log(w1 * Math.exp((a - 1) * e) + w2 * Math.exp(-a * e))) / (a - 1);
    return Number.isFinite(d) ? d : e; // 溢出臂 = α→∞ 极限（纯 DP 界 —— 保守方向）
}
/**
 * ΝΩ-20 (d)：泊松子采样放大（纯函数、绝不抛）。对数据集以速率 γ 做泊松子采样后
 * 再跑 ε-DP 机制，对原数据集满足 ε_eff-DP，标准界（Ullman；pure-DP 机制的子采样
 * 放大）：
 *
 *   ε_eff = log(1 + γ·(e^ε − 1))
 *
 * γ=1（不采样）⇒ ε；γ→0 ⇒ →0（机制几乎看不见任何个体）；γ ∈ (0,1) ⇒ ε_eff < ε
 * （ε=1, γ=0.5 ⇒ ≈0.858；ε 大时省约 log(1/γ) —— γ=0.5 恒省 ≈0.69）。消毒律：
 * ε ≤ 0 / 非有限 ⇒ 0；γ ≥ 1 / 非有限 ⇒ 原样 ε；γ ≤ 0 ⇒ 0；溢出 ⇒ ε（保守方向）。
 * 该函数只在真做了子采样（MintDigestOptions.sampleGamma ∈ (0,1)）时用于记账 ——
 * 不采样却申报放大是不诚实的账。
 */
export function subsampleAmplifiedEpsilon(eps, gamma) {
    const e = typeof eps === 'number' && Number.isFinite(eps) && eps > 0 ? eps : 0;
    if (e === 0)
        return 0;
    const g = typeof gamma === 'number' && Number.isFinite(gamma) ? gamma : 1;
    if (g <= 0)
        return 0;
    if (g >= 1)
        return e;
    const eff = Math.log1p(g * Math.expm1(e));
    return Number.isFinite(eff) ? eff : e; // 溢出臂：回落纯 DP 界（保守方向）
}
/**
 * ΝΩ-20：FNV-1a 32 位滚动哈希（纯函数）—— 窗口指纹（digest 内部）与掺入抖动
 * 种子派生（apply）共用的确定性文本→整数混合器。非有限 h 按 FNV 偏移基记、
 * 非字符串 text 按空串记（消毒卫兵在本边界）；内核为单源 fnv1aSeeded 续算
 * （逐字节同循环 —— 金样钉死）。
 */
export function fnv1a32(h, text) {
    return fnv1aSeeded(typeof h === 'number' && Number.isFinite(h) ? Math.floor(h) : 0x811c9dc5, typeof text === 'string' ? text : '');
}
/** 坨中心（掺入时 margin 的反演值）：裁剪域均分的第 b 坨中点（b=0 ⇒ -0.875） */
export function binCenter(b) {
    return -DIGEST_MARGIN_CLIP + (b + 0.5) * ((2 * DIGEST_MARGIN_CLIP) / DIGEST_BINS);
}
/** 全零坨矩阵（K × [success, fail]）—— 摘要铸造与合并的初始画布 */
export function zeroBins() {
    return Array.from({ length: DIGEST_BINS }, () => [0, 0]);
}
/** 预算账本真值源（指纹 → 账目行 + 最近拒绝注记；模块级，进程生命周期） */
const privacyBudgets = new Map();
/** 账目行求和（执法口径 —— 逐行加 ε_eff；空 ⇒ 0） */
function sumReleases(releases) {
    let s = 0;
    for (const r of releases)
        s += typeof r.epsilon === 'number' && Number.isFinite(r.epsilon) && r.epsilon > 0 ? r.epsilon : 0;
    return s;
}
/** 单账户的派生视图（防御副本 —— 外发结构不含内部可变引用） */
function budgetAccountOf(fingerprint, raw) {
    const total = sumReleases(raw.releases);
    return {
        fingerprint,
        releases: raw.releases.map(r => ({ ts: r.ts, epsilon: r.epsilon })),
        totalEpsilon: total,
        totalRdpEpsilon: raw.releases.reduce((s, r) => s + rdpEpsilon(r.epsilon), 0),
        cap: PRIVACY_BUDGET_EPSILON_TOTAL,
        exhausted: total >= PRIVACY_BUDGET_EPSILON_TOTAL - PRIVACY_BUDGET_EPS_TOL,
        ...(raw.lastRejection ? { lastRejection: { ...raw.lastRejection } } : {}),
    };
}
/** 查询某窗口指纹的预算账户（缺席 ⇒ null —— 诚实面，不臆造空账） */
export function privacyBudgetOf(fingerprint) {
    const raw = privacyBudgets.get(fingerprint);
    return raw ? budgetAccountOf(fingerprint, raw) : null;
}
/** 预算账本全表（dump 面：指纹字典序，防御副本） */
export function privacyBudgetReport() {
    return [...privacyBudgets.entries()]
        .map(([fp, raw]) => budgetAccountOf(fp, raw))
        .sort((a, b) => (a.fingerprint < b.fingerprint ? -1 : 1));
}
/**
 * 预算闸（mint 的内部执法点，绝不抛）：本次 release 记账口径 ε_eff 能否放行。
 * 通过 ⇒ 追加账目行（ts, ε_eff）；超限 ⇒ 落 lastRejection 并返回 false。
 * ΠΑΝ-71：入参是**一组** (账户键, ε_eff) —— 原子决算（任一账户超限 ⇒ 全部拒绝，
 * 绝不部分放行：一次 release 是一个机制，半放行等于对被放行键免费释放）；
 * 账本满员（PRIVACY_BUDGET_MAX_ACCOUNTS）再开新账 ⇒ 拒绝（fail-closed —— 逐出
 * 旧账 = 洗预算）；记账内部故障 ⇒ 拒绝（fail-closed —— 旧律 catch 返回 true 是
 * 隐私面的 fail-open：「记账故障 ⇒ 损失不记账继续释放」与 DP 纪律相反）。
 */
function chargePrivacyBudget(charges, ts) {
    try {
        if (!Array.isArray(charges) || charges.length === 0)
            return true; // 空窗：零成本
        // 先按账户键归并（同键多行合并入账 —— mint 每键恰一行，此处防御式归并）
        const incomingByAccount = new Map();
        for (const c of charges) {
            const e = typeof c?.epsilonEff === 'number' && Number.isFinite(c.epsilonEff) && c.epsilonEff > 0 ? c.epsilonEff : 0;
            incomingByAccount.set(c.fingerprint, (incomingByAccount.get(c.fingerprint) ?? 0) + e);
        }
        // 第一遍：全额校验（含账本上界 —— 新账户需求在满员账本上不可满足）
        const staged = new Map();
        for (const fingerprint of incomingByAccount.keys()) {
            if (!privacyBudgets.has(fingerprint) && privacyBudgets.size + staged.size >= PRIVACY_BUDGET_MAX_ACCOUNTS) {
                return false; // ΠΑΝ-71：账本满员 ⇒ 拒绝开新账（不逐出 —— 逐出 = 洗预算）
            }
            staged.set(fingerprint, privacyBudgets.get(fingerprint) ?? { releases: [] });
        }
        for (const [fingerprint, cur] of staged) {
            const total = sumReleases(cur.releases);
            const incoming = incomingByAccount.get(fingerprint) ?? 0;
            if (total + incoming > PRIVACY_BUDGET_EPSILON_TOTAL + PRIVACY_BUDGET_EPS_TOL) {
                cur.lastRejection = {
                    ts,
                    epsilon: incoming,
                    totalEpsilon: total,
                    cap: PRIVACY_BUDGET_EPSILON_TOTAL,
                    note: 'budget-exhausted：主体#键累计 ε 已达上限，mint 拒绝（诚实跳过，绝不抛）',
                };
                privacyBudgets.set(fingerprint, cur); // 拒绝事实如实落账
                return false;
            }
        }
        // 第二遍：全部通过 ⇒ 原子入账（部分放行不存在 —— 一次 release 是一个机制）
        for (const [fingerprint, cur] of staged) {
            cur.releases.push({ ts, epsilon: incomingByAccount.get(fingerprint) ?? 0 });
            privacyBudgets.set(fingerprint, cur);
        }
        return true;
    }
    catch {
        return false; // ΠΑΝ-71：记账故障 ⇒ 拒绝铸造（fail-closed —— 绝不「损失不记账继续释放」）
    }
}
/** ΝΩ-20：预算账本复位（测试隔离专用缝 —— 生产代码无理由清空会计不变量） */
export function resetPrivacyBudgetRuntime() {
    privacyBudgets.clear();
}
/**
 * 铸摘要（绝不抛）：对每 key 的窗口证据产出「margin 裁剪进 [-1,1] 的 K=8 坨 ×
 * 成败两列」直方图，每格加 Laplace(0, 1/ε) 噪声后取整非负；n 亦加同尺度噪声取整
 * 非负（ΝΩ-20 (c) —— 活动量不再明文出境）。同 seed 同账本 ⇒ 摘要逐字段一致
 * （mulberry32 流 + 固定格序：key 序、逐条目子采样币、n 噪声、坨 0..7、success
 * 先于 fail）。无 margin 的条目计入 n、不入格（直方图只覆盖带裕量的证据 —— 与
 * calibrator 只消费 margins 的口径对齐）；账本视图非法 ⇒ null（诚实跳过，
 * 绝不抛）。rng 异常产出非有限抽头 ⇒ **整次铸造中止返回 null**（ΠΑΝ-70：绝不
 * 以零噪声真值出境 —— DP 的失败方向只能是拒绝，不能是多掩蔽的缺席）。
 *
 * ΠΑΝ-73 回声环闭合：条目 origin === 'federation'（联邦掺入记录）不进摘要 ——
 * 本地铸造只消费本地真实观察，掺入的远端证据下一轮不再被重新铸成摘要重新上传。
 *
 * ΝΩ-20 (b) + ΠΑΝ-71 隐私预算闸：铸造按「主体 # 键」记账 —— 全程零有效本地条目
 * （输出与任何个体无关的纯噪声）⇒ 零成本；否则每个有贡献的 key 各记一行
 * ε_eff（采样放大后）对照 Σε ≤ 上限原子执法，超限 ⇒ 返回 null 且拒绝事件落在
 * privacyBudget 账本（lastRejection 如实申报 budget-exhausted —— null 的区分面
 * 在账本不在返回值）。窗口滑动（内容变）**不换账**：同主体同键的滑窗重叠释放
 * 按朴素序列组合累计 —— 「滑动窗生命期天然换账」的旧洞就此关闭。
 */
export function mintEvidenceDigest(ledgerView, opts) {
    try {
        if (!ledgerView || typeof ledgerView.keys !== 'function' || typeof ledgerView.entries !== 'function') {
            return null; // 账本视图非法：诚实跳过（零摘要，不是坏摘要）
        }
        // ΠΑΝ-70 fail-closed：显式给出的 ε 非法（≤0 / 非有限）⇒ 拒绝铸造 —— 不再
        // 静默回落缺省（配置错当没配是隐私面的 fail-open）
        if (opts?.epsilon !== undefined && !(typeof opts.epsilon === 'number' && Number.isFinite(opts.epsilon) && opts.epsilon > 0)) {
            return null;
        }
        const epsilon = numOr(opts?.epsilon, DEFAULT_FEDERATION_EPSILON, Number.MIN_VALUE, Infinity);
        const scale = 1 / epsilon; // 计数敏感度 1 ⇒ Laplace 尺度 1/ε（Dwork 机制）
        // ΝΩ-20 (d)：泊松子采样率 γ（缺省/非法 ⇒ 1 = 不采样 —— 旧行为逐字节）
        const gammaRaw = opts?.sampleGamma;
        const gamma = typeof gammaRaw === 'number' && Number.isFinite(gammaRaw) && gammaRaw > 0 && gammaRaw < 1 ? gammaRaw : 1;
        // ΠΑΝ-70：注入 rng 的非有限抽头哨兵 —— 任何一次抽头非有限 ⇒ 整次铸造中止
        // （mulberry32 流恒有限，此闸只对直注 rng 生效；消费点经 safeDraw 走）
        let rngInvalid = false;
        const rawRng = typeof opts?.rng === 'function'
            ? opts.rng
            : mulberry32(typeof opts?.seed === 'number' && Number.isFinite(opts.seed) ? opts.seed : 0);
        const rng = () => {
            try {
                const u = rawRng();
                if (!Number.isFinite(u))
                    rngInvalid = true;
                return typeof u === 'number' ? u : Number.NaN;
            }
            catch {
                rngInvalid = true;
                return Number.NaN;
            }
        };
        let mintedAt = Date.now();
        if (typeof opts?.now === 'function') {
            try {
                const t = opts.now();
                if (Number.isFinite(t))
                    mintedAt = t;
            }
            catch {
                /* 时钟故障保持 Date.now —— 绝不抛 */
            }
        }
        // ΠΑΝ-71：记账主体（预算账户键的 subject 段；缺省 'local' —— 离线手递手铸造）
        const subject = typeof opts?.subject === 'string' && opts.subject !== '' ? opts.subject : 'local';
        let keyList = [];
        try {
            keyList = ledgerView.keys() ?? [];
        }
        catch {
            keyList = [];
        }
        const outKeys = [];
        let totalN = 0; // 全程有效**本地**条目数（零 ⇒ 纯噪声输出 ⇒ 零记账）
        const contributingKeys = []; // ΠΑΝ-71：有本地贡献的 key（各开各账）
        for (const rawKey of keyList) {
            if (typeof rawKey !== 'string' || rawKey === '')
                continue; // 垃圾 key 不入摘要
            let entries = [];
            try {
                entries = ledgerView.entries(rawKey) ?? [];
            }
            catch {
                entries = []; // 单 key 读账故障：按空窗铸（其余 key 不受牵连）
            }
            const bins = zeroBins();
            let n = 0;
            let contributed = false;
            for (const e of entries) {
                if (!e || typeof e.success !== 'boolean')
                    continue; // 注入视图的垃圾条目：n 与格子都不收
                // ΠΑΝ-73 回声环闭合：联邦掺入记录不进摘要（本地铸造只消费本地真实观察 ——
                // 掺入的远端证据重新上传 = 含 DP 噪声的反馈放大环，就此切断）
                if (e.origin === 'federation')
                    continue;
                if (gamma < 1 && !(rng() < gamma))
                    continue; // ΝΩ-20 (d)：泊松子采样（γ=1 时此臂短路 —— 旧行为零消耗 rng）
                n += 1;
                contributed = true;
                if (e.margin === undefined || !Number.isFinite(e.margin))
                    continue; // 无裕量：只计 n
                const m = Math.min(DIGEST_MARGIN_CLIP, Math.max(-DIGEST_MARGIN_CLIP, e.margin));
                const idx = Math.min(DIGEST_BINS - 1, Math.floor((m + DIGEST_MARGIN_CLIP) / ((2 * DIGEST_MARGIN_CLIP) / DIGEST_BINS)));
                bins[idx][e.success ? 0 : 1] += 1;
            }
            if (contributed)
                contributingKeys.push(rawKey);
            totalN += n;
            // ΝΩ-20 (c)：n 加噪（Laplace(1/ε) 取整非负；rng 异常 ⇒ 0 —— 多掩蔽方向，
            // 绝不回退真值）
            const rawNoisyN = Math.round(n + laplaceNoise(scale, rng()));
            const noisyN = Number.isFinite(rawNoisyN) ? Math.max(0, rawNoisyN) : 0;
            const noisyBins = bins.map(cell => cell.map(c => {
                const v = Math.round(c + laplaceNoise(scale, rng()));
                return Number.isFinite(v) ? Math.max(0, v) : 0; // 后处理：取整非负；rng 异常 ⇒ 0（多掩蔽方向）
            }));
            outKeys.push({ key: rawKey, n: noisyN, bins: noisyBins });
        }
        // ΠΑΝ-70：注入 rng 产出过非有限抽头 ⇒ 整次铸造中止（绝不以零噪声真值出境）
        if (rngInvalid)
            return null;
        // ΝΩ-20 (b) + ΠΑΝ-71：隐私预算闸（零有效本地条目 ⇒ 纯噪声输出 ⇒ 零成本不记账；
        // 有贡献的 key 各记一行 —— 原子决算，任一超限整体拒绝）
        if (totalN > 0) {
            const epsEff = gamma < 1 ? subsampleAmplifiedEpsilon(epsilon, gamma) : epsilon;
            const charges = contributingKeys.map(k => ({ fingerprint: `s:${subject}|k:${k}`, epsilonEff: epsEff }));
            if (!chargePrivacyBudget(charges, mintedAt)) {
                return null; // budget-exhausted / 账本满员：诚实拒绝（拒绝详情在 privacyBudgetOf）
            }
        }
        return { v: DIGEST_VERSION, mintedAt, epsilon, keys: outKeys };
    }
    catch {
        return null; // 绝不抛纪律的兜底臂（理论不可达 —— 全程防御式）
    }
}
/** 单格消毒：有限、非负的数值 ⇒ 四舍五入整数；其余（NaN/±Inf/负数/非数）⇒ null（按 0 计） */
export function cleanCell(v) {
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null;
}
/**
 * 合并摘要（secure-aggregation 风格、纯函数、绝不抛）：逐格求和 + n 求和。
 *   - 非数组 / 空数组 ⇒ null（无可合并者）；
 *   - 任一份形状坏（非对象）或版本 ≠ 1 ⇒ **整体拒绝合并返回 null**（schema 演进
 *     不静默吞异版 —— 版本错配是协议事件，不是数据噪声）；
 *   - 坏格按 0 计入并 skipped++（NaN / 非数 / 负数 / bins 形状错 —— 聚合器不因
 *     单格脏数据丢弃整份贡献，也不假装它是合法值）；
 *   - mintedAt 取各源最大；epsilon 取各源最小（最保守申报 —— 各源只对自己的 ε
 *     负责，合并面按最强噪声标准立账）。
 */
export function mergeDigests(digests) {
    try {
        if (!Array.isArray(digests) || digests.length === 0)
            return null;
        let mintedAt = 0;
        let minEps = null;
        let skipped = 0;
        const keyMap = new Map();
        for (const d of digests) {
            if (!d || typeof d !== 'object' || Array.isArray(d))
                return null; // 形状坏：整体拒绝
            const dd = d;
            if (dd.v !== DIGEST_VERSION)
                return null; // 版本错配：整体拒绝合并
            if (typeof dd.mintedAt === 'number' && Number.isFinite(dd.mintedAt) && dd.mintedAt > mintedAt) {
                mintedAt = dd.mintedAt;
            }
            if (typeof dd.epsilon === 'number' && Number.isFinite(dd.epsilon) && dd.epsilon > 0) {
                minEps = minEps === null ? dd.epsilon : Math.min(minEps, dd.epsilon);
            }
            for (const rawEntry of Array.isArray(dd.keys) ? dd.keys : []) {
                if (!rawEntry || typeof rawEntry !== 'object') {
                    skipped += DIGEST_BINS * 2; // 整条坏：按全格坏注记（粒度统一为格）
                    continue;
                }
                const e = rawEntry;
                if (typeof e.key !== 'string' || e.key === '') {
                    skipped += DIGEST_BINS * 2; // 无主条目：同上按全格坏注记
                    continue;
                }
                let acc = keyMap.get(e.key);
                if (!acc) {
                    acc = { n: 0, bins: zeroBins() };
                    keyMap.set(e.key, acc);
                }
                const cleanN = cleanCell(e.n);
                if (cleanN !== null)
                    acc.n += cleanN;
                else
                    skipped += 1; // 坏 n 按 0 计入注记
                const bins = Array.isArray(e.bins) ? e.bins : [];
                for (let b = 0; b < DIGEST_BINS; b++) {
                    const cell = bins[b];
                    for (let col = 0; col < 2; col++) {
                        const v = cleanCell(Array.isArray(cell) ? cell[col] : undefined);
                        if (v !== null)
                            acc.bins[b][col] += v;
                        else
                            skipped += 1; // 坏格按 0（诚实注记，不吞整份）
                    }
                }
            }
        }
        return {
            v: DIGEST_VERSION,
            mintedAt,
            epsilon: minEps ?? DEFAULT_FEDERATION_EPSILON,
            keys: [...keyMap.entries()].map(([key, acc]) => ({ key, n: acc.n, bins: acc.bins })),
            mergedFrom: digests.length,
            skipped,
        };
    }
    catch {
        return null; // 绝不抛
    }
}
