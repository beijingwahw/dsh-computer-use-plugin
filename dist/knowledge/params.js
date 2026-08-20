// src/knowledge/params.ts
// 认知参数登记处 —— 可调认知常数的唯一权威源。
//
// 入册资格（单一标准，别无例外）：校准基准（test/calibration.bench.ts）
// 测得可行区间 —— 区间外基准翻红，区间内行为不变。数值默认取区间内一点，
// 区间本身是结论。
//
// 清理记录（对「拍脑袋常数」批评的执行）：登记处从 19 收缩到 7，
//   核证接地纪元新增 VERIFY_TRUST_FLOOR（第 8 个 —— 信任门控的地板）。
//   出册 12 个无区间常数，全部内联为各模块私有字面量（算法形状，非旋钮），
//   校准出处注释随行：
//     · knowledgeBase.ts 8 个（SEMANTIC_WEIGHT、SEMANTIC_FLOOR、
//       AUTO_LEARN_FAILURE_CONFIDENCE、MIN_CLUSTER_SIZE、CLUSTER_SIMILARITY、
//       CONSENSUS_BONUS、CORTICALIZE_DECAY、CONFIDENCE_HALF_LIFE_MS）；
//     · worldModel.ts 3 个（TYPE_QUANTIZE、TYPE_MATCH_SIMILARITY、SURPRISE_ALPHA）；
//     · stations.ts 1 个（DELIB_ERROR_WEIGHT —— 由单元测试在弱证据域行使，
//       流水线包络外，字面量保留其承重语义）。
//   其中时间衰减机制保留（衰减形状 = 过滤 + 排序让位，由 knowledge.test
//   免疫 #1 时间旅行守护）；半衰期数值内联 —— 包络内时间不流逝，数值不可证伪。
//
// 运行时覆盖缝：setParam/resetParams（校准基准扫值入口）+ 环境变量
//   D7_PARAM_<NAME>（子进程扫值入口）—— 参数必须可在运行时改，否则
//   「校准」无从谈起。消费方一律经 P.<NAME> 读取（getter，禁止解构快照）。
//
// 预算/容量/文件名类工程值（CONTENT_MAX_CHARS、MAX_ENTRIES、
// INJECTION_MAX_CHARS、MAX_ROUNDS、缓存大小等）不入册 ——
// 它们是结构承诺，不是认知主张。
const SPECS = {
    // ─── 免疫（决策侧执法）───
    REFLEX_SUPPRESS_CONFIDENCE: {
        value: 0.55,
        note: '可行区间 [0, 0.55]：上界锚点 = 种子知识 0.55 必须触发压制（E1b）；自体学习经 3 次执行复证后必须够到阈值（E3 Day2，与 REINFORCE_STEP 联合约束）。缺省 0.55 = v3 联合标定 fail-heavy 归宿（人工接手主导域：误告率 67%→50%，忏悔世界反证复活）—— 采纳记录见 test/reports/joint-calibration-report.md §11。',
    },
    // ─── 前额叶仿真（证据经济学）───
    DELIB_RELEVANCE_FLOOR: {
        value: 0.3,
        note: '可行区间 [0.10, 0.35]：双边约束 —— 太低则噪声证据入局（误信），太高则真证据出局（漏信）。决策比检索保守：误信代价比漏信高。',
    },
    DELIB_WORKFLOW_WEIGHT: {
        value: 6,
        note: '可行区间 [0.5, 8]：下界 = 活路托举必须压过零证据候选（0 = 活路无托举，E1b/E3 全灭）；无上界敏感（本包络无对抗性 workflow 证据）。缺省 6 = v3 联合标定 fail-heavy 归宿 —— 高阈值（0.55）的补位证据：托举让走廊/竞争陷阱世界破局，且不需降低定罪标准。',
    },
    // ─── 自体学习（置信度铸造）───
    AUTO_LEARN_SUCCESS_CONFIDENCE: {
        value: 1,
        note: '可行区间 (0, 1]：0 = 成功学习零证据效用。缺省 1 = v3 联合标定 fail-heavy 归宿（顶格铸造：活路证据单次立信，配合 W=6 托举破局）；反证仍走 DISCONFIRM_DECAY，复证仍走 REINFORCE_STEP —— 铸造满格不豁免怀疑。',
    },
    REINFORCE_STEP: {
        value: 0.3,
        note: '可行区间 [0.2, 1]：下界由 E3 物理约束 —— Day1 陷阱意图的 3 次执行内，置信度必须从 0.3 升过压制阈值 0.5（step=0.15 时三次仅 0.494，Day2 物理不可能）。',
    },
    DISCONFIRM_DECAY: {
        value: 0.5,
        note: '契约有效域 (0,1)：反证必须严格下降且绝不归零（矛盾双留痕）；0.5 = 减半下沉。具体值是「矛盾退休速度」的政策点，契约测试守护结构。',
    },
    // ─── L3 计费（预测编码）───
    L3_ESCALATION_BITS: {
        value: 3,
        note: '分离带 (0.415, 3.841]：底噪 = 已知转移首见的 0.415 bits；信号 = 1/20 稀有转移的 3.841 bits。形式推导 bits=−log₂p（3 ⇔ p≤12.5%），「3 不是 2 或 4」由分离带定标。阈值 3 下 1/3(1.585b) 与 1/10(2.94b) 不计费 —— 12.5% 教义推论。',
    },
    // ─── 核证接地（信任门控的接地前探针）───
    VERIFY_TRUST_FLOOR: {
        value: 0.2,
        note: '可行区间 [0.2, 0.65]（calibration.bench Part A 实测，E5/E6/E7 三场景定界）：压制证据族（error-pattern）最高信任 ≥ 地板 ⇒ 诚实接地（亲证背书）；低于地板（全传闻 trust=0 / 陈年亲证衰减过线）⇒ 接地终局前放行一针探针（一次性闩锁：一 run 一针，与 D-4 结算时序解耦）。下界锚点 = 60 天陈年亲证（conf 0.66 × 0.5^(60/30) ≈ 0.165）必须触发复活探针（E6 忏悔世界的解药通道）⇒ floor > 0.165；上界锚点 = 新鲜亲证（conf 0.66 × 衰减 1 = 0.66）必须自背书零学费（E7 真陷阱世界不为一针多付学费）⇒ floor ≤ 0.66 —— 与 E6 同一证据，陈年复活、新鲜背书，地板落在衰减曲线的 0.165 与 0.66 之间。缺省 0.2 = 联合标定归宿（jointCalibration 四价格机制 {0.2,0.2,0.2,0.2} 稳定选择 —— 跨机制稳定 = 数据结论）+ 初铸亲证保鲜期锚点：新学陷阱条目（conf 0.3）trust = 0.3 × 0.5^(d/30) ≥ 0.2 ⟺ d ≤ 30·log₂(1.5) ≈ 17.5 天 —— 学费换来的亲证有 17 天保鲜期（期内自背书零学费，过期复活探针感知世界变化）。旧缺省 0.3 的「conf 0.3 × 衰减 1 = 0.3 含等号」只在铸造同一毫秒成立：任何物理时间流逝都使 trust 微降破线（F1 Day2 实测翻红）—— 初铸亲证永不安宁，0.3 不是稳定锚点。',
    },
};
/** 参数注册表（只读投影 + 运行时覆盖缝） */
const overrides = new Map();
// 环境变量覆盖（子进程扫值入口）：D7_PARAM_<NAME>=<number>
for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('D7_PARAM_'))
        continue;
    const name = k.slice('D7_PARAM_'.length);
    const num = Number(v);
    if (name in SPECS && Number.isFinite(num))
        overrides.set(name, num);
}
/** 校准扫值入口：设值（null = 恢复缺省）。运行时即刻生效（消费方走 getter）。 */
export function setParam(name, value) {
    if (value === null)
        overrides.delete(name);
    else
        overrides.set(name, value);
}
/** 清空全部运行时覆盖（校准基准每轮收尾义务） */
export function resetParams() {
    overrides.clear();
}
/** 读数代理：P.<NAME> 永远取「覆盖值 ?? 登记缺省」。禁止解构快照。 */
export const P = new Proxy({}, {
    get(_t, prop) {
        const spec = SPECS[prop];
        if (!spec)
            throw new Error(`unknown cognitive param: ${prop}（出册常数已内联为模块字面量）`);
        const o = overrides.get(prop);
        return o !== undefined ? o : spec.value;
    },
});
/** 只读目录（审计/仪表盘用）：名称 → {值, 区间注记} */
export function paramCatalog() {
    return Object.entries(SPECS).map(([name, s]) => ({
        name,
        value: overrides.get(name) ?? s.value,
        note: s.note,
    }));
}
