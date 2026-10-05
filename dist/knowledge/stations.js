// ΠΑΝ-46（分词单源收口）：词法面（反射弧/运动弧/前额叶仿真）从 ../uiMemory 的
// 第二套口径换到 dialects.tokenizeText 单源（停用词剥离 + 分段 bigram）。
// 注意：intentGrammar.residueTokens（运动弧残差）仍是 uiMemory 口径 —— 非
// knowledge 链文件，跨口径比较的重合度影响已在测试覆盖下（英文词与 CJK
// bigram 双口径基本重合；纯数字 residue 会失去元素侧对应 token，可接受损失）。
import { tokenizeText } from '../dialects/tokenizer.js';
import { embed, cosine } from '../semanticHash.js';
import { trustOf } from './knowledgeBase.js';
import { P } from './params.js';
import { SANDBOX_ACTION_KINDS } from '../sandbox/types.js';
import { classifyWordShape } from '../wordShape.js';
import { classifyMotor, extractQuotedSpans, residueTokens, extractScroll, extractHotkey, } from '../intentGrammar.js';
// ΠΑΝ-127（D-F5 清偿）：网格分区三件（gridRegions/faultPatches/
// dispatchElementsToGrid）已下沉零环基座 knowledge/gridDispatch.ts ——
// physicalExecution/d7HostPort.ts 曾回借本件 faultPatches/dispatchElementsToGrid
// 构成 knowledge↔physicalExecution 跨模块 value 环的一臂；此处再导出保导入面
// 零破坏（epochX/harness 测试面照旧），本件内部消费改 import 叶。
// 行为零变化 —— 纯结构搬家。
export { faultPatches, dispatchElementsToGrid } from './gridDispatch.js';
// 件内消费（工位桩/能力源同方言复用分派三件）：ΠΑΝ-127 下沉叶后经导入回流。
import { faultPatches, dispatchElementsToGrid } from './gridDispatch.js';
/**
 * L2 OCR 词元 → 点击候选元素（Z-2 正文剔除，纯函数 —— 测试面）。
 * content-like（宽行/多行段落形态：聊天消息、文档正文）不参选 —— 反射弧
 * 的落点选举不允许正文入场，「输出的正文被当作点击的按钮」在零模型路径
 * 上失去燃料。剔除是保守降级不是死刑：极宽的真按钮被形态误判时，反射弧
 * 诚实接地（比错点正文便宜 —— 精确性优先，与运动弧拒绝语义同律）。
 * wordShape 纯模块引入（非 interactivityProbe）：工位桩零二进制依赖红线。
 */
export function ocrWordsToClickCandidates(words) {
    return words
        .filter(w => classifyWordShape(w) !== 'content-like')
        .map(w => ({
        role: 'text',
        name: w.text.slice(0, 20), // D-3 LABEL_MAX 先例
        rect: {
            x: w.bbox_normalized.x0, y: w.bbox_normalized.y0,
            width: w.bbox_normalized.x1 - w.bbox_normalized.x0,
            height: w.bbox_normalized.y1 - w.bbox_normalized.y0,
        },
    }));
}
/**
 * 能力回退场景源（P1-4）：'dsh.vision.station' 外部服务缺席时，用插件自身
 * 视觉能力顶上 —— L1 无障碍树优先（uiExtractor 纯 JS 静态引入），
 * L1 不可用/为空 ⇒ L2 全屏 OCR（textReader 惰性动态引入 —— 原生依赖隔离，
 * 沙箱环境零污染）分派到网格分区。双缺席 ⇒ 抛错（工位 catch 转 fault 补丁
 * —— 「看不见」是 fault，不是真空）。
 * 元素 rect 归一化域 = 全屏（像素 ÷ 屏幕尺寸 —— 归一化责任在适配器）。
 * Z-2：L2 路径的词元先过正文剔除（ocrWordsToClickCandidates）—— OCR 是
 * 纯视觉，看不见交互性；几何先验是它唯一免费的自卫。
 */
export async function createCapabilitySceneSource(opts) {
    const { extractInteractiveElements, hasAccessibilityProvider } = await import('../uiExtractor.js');
    async function l1Elements() {
        if (!hasAccessibilityProvider())
            return [];
        try {
            const [els, size] = await Promise.all([extractInteractiveElements(), opts.screenSize()]);
            return els.map(e => ({
                role: e.role,
                name: e.name,
                rect: {
                    x: e.rect.x / size.width, y: e.rect.y / size.height,
                    width: e.rect.width / size.width, height: e.rect.height / size.height,
                },
            }));
        }
        catch {
            return []; // provider 违约 ⇒ 空集（降 L2，绝不毒化）
        }
    }
    async function l2Elements() {
        try {
            const { readText } = await import('../textReader.js');
            const buffer = await opts.capture();
            const ocr = await readText(buffer, opts.lang ?? 'eng');
            return ocrWordsToClickCandidates(ocr.words);
        }
        catch {
            return []; // OCR/截屏故障 ⇒ 空集（双缺席 ⇒ 抛错转 fault）
        }
    }
    return {
        name: 'capability-scene(L1-a11y>L2-ocr)',
        async perceive(req) {
            let els = await l1Elements();
            let depth = 'L1';
            if (els.length === 0) {
                els = await l2Elements();
                depth = 'L2';
            }
            if (els.length === 0) {
                throw new Error('no vision capability available (a11y provider absent + OCR/capture failed)');
            }
            // 网格分派公用件（'g{col}x{row}' 坐标同一性方言 —— 与 D-5 源同律）
            return dispatchElementsToGrid(els, req.grid, depth, depth === 'L1' ? 'L1-tree' : 'L2-ocr');
        },
    };
}
/**
 * 视觉感知工位桩。forceL3 是语义授权标志 —— 桩纪元无 L3 通道，授权只被记录
 * 不被消费（诚实：无代码路径假装跑了大模型）。信封 tokenBudget 仅 L3 可动用，
 * 桩纪元恒不消耗。
 */
export class StubVisionStation {
    opts;
    // 显式字段赋值（非参数属性）：Node strip-only 运行时契约 —— 现世源码同方言
    constructor(opts) {
        this.opts = opts;
    }
    async perceive(env, signal) {
        const req = env.payload;
        if (!this.opts.source) {
            return faultPatches(req.grid, 'no scene source wired (stub era — honest degradation)');
        }
        try {
            const patches = await this.opts.source.perceive(req, signal);
            return Array.isArray(patches) ? patches : [];
        }
        catch (e) {
            // 端口契约违约（抛错）⇒ fault 补丁归因，绝不毒化流水线
            const msg = e instanceof Error ? e.message : String(e);
            return faultPatches(req.grid, `scene source fault: ${msg}`);
        }
    }
}
/**
 * 决策规划工位桩。输入信封 = DecisionContext（intent + scene + 隐知识注入 ≤300 字符）。
 * 输出契约：AtomicAction | NeedGrounding（D-7 方言：reason/focus 判别，无 kind 字段）。
 * 通道故障 / 解析失败 ⇒ NeedGrounding 诚实回退 —— 绝不抛错毒化流水线。
 */
export class StubDecisionStation {
    opts;
    constructor(opts) {
        this.opts = opts;
    }
    /** 决策上下文 → 紧凑 prompt（Token 纪律：结构化场景表 + 隐知识摘要，零散文背景）。
     *  ΝΩ-16：advisory = 级联仲裁上一级的咨询性证据附注（压制证据 / Tier2 效用
     *  排序）—— 提示非指令，裁决权仍在模型。 */
    buildPrompt(ctx, retryCtx, advisory) {
        const scene = ctx.scene
            .map(p => `[${p.region.id}] ${p.funnelDepth}: ` +
            p.elements.map(e => `${e.role}(${e.name})@${e.rect.x.toFixed(2)},${e.rect.y.toFixed(2)}`).join(' '))
            .join('\n');
        const knowledge = ctx.knowledgeContext
            ? `\nTACIT KNOWLEDGE (conf ${ctx.knowledgeContext.maxConfidence.toFixed(2)}): ${ctx.knowledgeContext.summary}`
            : '';
        const advisoryNote = advisory ? `\nADVISORY: ${advisory}` : '';
        const retry = retryCtx ? `\nLAST FAILURE (retry ${retryCtx.retryCount}): ${retryCtx.reason}` : '';
        const prev = ctx.previousResults?.length
            ? `\nPREVIOUS RESULTS: ${ctx.previousResults.map(r => `${r.action.kind}=${r.status}`).join(', ')}`
            : '';
        return `GOAL: ${ctx.intent.description}${knowledge}${advisoryNote}${prev}${retry}\nSCENE:\n${scene}\n` +
            'OUTPUT (strict JSON): {"type":"action","action":{"kind":"click_mouse|type_text|...","args":{...}},"rationale":"..."} ' +
            'or {"type":"need-grounding","reason":"...","focus":"..."}';
    }
    async decide(env, retryCtx, signal) {
        return this.decideAdvisory(env, retryCtx, signal);
    }
    /** 咨询性证据注入的决策变体（ΝΩ-16 级联仲裁的 LLM 断后面）：级联上一级
     *  的判定证据（免疫压制 / 效用排序）随 prompt 交大脑 —— 大脑可凭理由推翻，
     *  推翻与否由其 rationale 自证（审计面不减）。通道语义与 decide 完全同律。 */
    async decideAdvisory(env, retryCtx, signal, advisory) {
        if (!this.opts.chat) {
            return { reason: 'no decision channel wired (stub era — honest degradation)', focus: 'full-scene' };
        }
        let raw;
        try {
            raw = await this.opts.chat(this.buildPrompt(env.payload, retryCtx, advisory), signal);
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return { reason: `decision channel fault: ${msg}`, focus: 'full-scene' };
        }
        return this.parse(raw);
    }
    /** 输出解析：JSON 判别收窄；任何失败 ⇒ NeedGrounding（运行层永不抛错） */
    parse(raw) {
        try {
            const obj = JSON.parse(raw.trim());
            if (obj?.type === 'need-grounding' && typeof obj.reason === 'string') {
                return { reason: obj.reason.slice(0, 120), focus: String(obj.focus ?? 'full-scene').slice(0, 120) };
            }
            if (obj?.type === 'action' && obj.action && typeof obj.action.kind === 'string') {
                const candidate = obj.action;
                // 解析边界执法：kind 必须在动作词汇表内、args 必须是普通对象 ——
                // 模型输出的未知 kind / 畸形 args 在此拒绝，而非流入宿主执行器
                if (!SANDBOX_ACTION_KINDS.has(candidate.kind) ||
                    (candidate.args !== undefined && (typeof candidate.args !== 'object' || candidate.args === null || Array.isArray(candidate.args)))) {
                    return { reason: `decision action rejected (kind '${candidate.kind}' outside vocabulary or malformed args)`, focus: 'full-scene' };
                }
                const action = candidate;
                return { ...action, rationale: String(obj.rationale ?? '').slice(0, 120) };
            }
        }
        catch { /* fallthrough：诚实回退 */ }
        return { reason: 'decision output unparseable (non-JSON or missing discriminator)', focus: 'full-scene' };
    }
}
// ─── 反射决策工位（Reflexive Decision）—— 桩纪元终结者，神经纪元四层脑 ───
// 免疫抑制阈值、前额叶仿真参数与核证接地地板（REFLEX_SUPPRESS_CONFIDENCE /
// DELIB_RELEVANCE_FLOOR / DELIB_WORKFLOW_WEIGHT / VERIFY_TRUST_FLOOR）
// 登记于 params.ts（校准可行区间见登记处）。
// 弱陷阱折扣系数与亲证半衰期为算法形状字面量（见下 / knowledgeBase.ts）—— 非旋钮。
/** 弱陷阱折扣系数（conf < 压制阈值的嫌疑证据：utility −= sim×conf×3）。
 *  流水线校准不敏感（包络内弱证据不登场 —— 陷阱证据要么 ≥ 阈值走否决，
 *  要么还没入库）；但单元测试（reflexiveDecision #3 双证据经济学）在弱证据
 *  域证明其承重 ⇒ 内联保留，值即设计。 */
const DELIB_ERROR_WEIGHT = 3;
/** 探针闩锁容量上限（防爆环保险丝：已探针 intent 不许无界滞留内存 —— FIFO 淘汰） */
const PROBE_LATCH_MAX = 128;
// ─── DS-3（ΝΩ-16 顺修）：仿真层文本嵌入的进程级 LRU 缓存 ───
// 病灶：deliberate 每轮对同一 intent / fragment / 元素名重复 embed —— run 内
// 场景与证据高度复现（重试轮尤甚），重复哈希是纯浪费。embed 是纯函数
// （同文本恒同向量）⇒ 进程级共享零语义漂移；key = 文本自身（Map 字符串键
// 即引擎级哈希寻址 —— 不自铸 hash，零碰撞语义负担），容量 1024，纯 Map 实现：
// 命中即删重插（新鲜度刷新，严格 LRU），超容逐最旧（Map 迭代序 = 插入序）。
const EMBED_CACHE_CAPACITY = 1024;
const embedCache = new Map();
/** LRU 嵌入查询（deliberate 全通道消费；导出为测试面 —— 命中返回同一引用可断言） */
export function embedCached(text) {
    const hit = embedCache.get(text);
    if (hit !== undefined) {
        embedCache.delete(text);
        embedCache.set(text, hit); // 命中重插 = LRU 新鲜度刷新（不是 FIFO）
        return hit;
    }
    const v = embed(text);
    embedCache.set(text, v);
    if (embedCache.size > EMBED_CACHE_CAPACITY) {
        const oldest = embedCache.keys().next().value;
        if (oldest !== undefined)
            embedCache.delete(oldest);
    }
    return v;
}
// ─── DS-4（ΝΩ-16 顺修）：探针闩锁的进程级升级层 ───
// 病灶：「一 run 一针」的跨 run 保护由知识闭环兑现（探针失败 ⇒ auto-learn
// 亲证压制诞生 ⇒ 信任门控通过 ⇒ 不再探针）；learnFromOutcome 因容量拒绝
// （满库且无 auto-learn 可驱逐 —— 全 manual/import 主权库）时该闭环断裂，
// 工位实例闩锁只护 run 内 —— 每个 run 都重付探针学费。修法：学习侧容量
// 拒绝上报时（escalateProbeLatch，接线缝 = pipeline learnSettled 的
// r.error.field === 'capacity' 分支 —— ΠΑΝ-48 已接线，不再是无调用的死声明），
// 该 intent 的闩锁升进程级 —— 跨工位实例存活；1h 衰减懒过期自动解除（容量拒绝可被上游清库解除，永久闩锁
// 会把「世界会变」的复活通道焊死 —— 探针本是传闻的解药，不是刑具）。
const PROCESS_LATCH_DECAY_MS = 60 * 60 * 1000;
const processProbeLatch = new Map(); // intentId → 升级时刻
/** 进程级闩锁查询（懒过期）：过线即除键 —— 1h decay 自动解除无需扫 Timer
 *  （查询时才结算，零后台开销）。 */
function processLatchActive(intentId) {
    const at = processProbeLatch.get(intentId);
    if (at === undefined)
        return false;
    if (Date.now() - at >= PROCESS_LATCH_DECAY_MS) {
        processProbeLatch.delete(intentId);
        return false; // 衰减过线 = 闩锁自动解除（世界会变，复活通道不焊死）
    }
    return true;
}
/**
 * 反射决策工位：级联仲裁脑（ΝΩ-16 反转「LLM 独裁坍缩」—— 旧律 chat 在场
 * 则 Tier0/1/2/2.5 全部旁路：陷阱记忆拦不住 LLM、每个明确点击也过 LLM。
 * 新律：反射先行，LLM 断后）。
 *
 * 级联序（快→慢，每级失败才降级到下一级；chat 在场与否只改写降级终点）：
 *   Tier 0 免疫抑制（恒跑 —— 安全机制无 LLM 豁免）→ KnowledgeInjection 含
 *          高置信 error-pattern ⇒ 压制本能弧。两级语义：
 *            · 确定性一级：被压制的本能弧绝不发射（chat 在否都一样）；
 *            · 咨询性二级：chat 在场时压制证据注入 prompt 交大脑绕行/换路
 *              —— 证据不被旁路，但裁决权不剥夺；chat 缺席时前额叶改道 +
 *              核证探针兜底（「陷阱已知」不是死刑判决：停手是为了找活路）。
 *   Tier 1 脊髓反射（反射先行）→ intent 词汇 × 场景元素名的严格领先匹配
 *          （平票/零重合不发射 —— 发射条件零放宽）且无压制且非重试语境
 *          ⇒ 直接 click 元素中心跳过 LLM（延迟/成本归零；重试 = 上次发射
 *          已失败，确定性复读交大脑绕行 —— 保守原则：不确定 ⇒ 多花钱）。
 *   Tier 2 前额叶仿真 → chat 缺席时的破局者：全候选效用评分（语义相似度 ×
 *          知识证据），最高效用且严格领先 ⇒ 执行；chat 在场时降格为 prompt
 *          排序提示（RANKING HINT —— 提示非指令，大脑可推翻）。
 *   Tier 2.5 核证探针 → 仅 chat 缺席的压制终局（信任门控一针验证，闩锁
 *          一 run 一针；DS-4：学习闭环容量断裂时闩锁升进程级 1h）。
 *   Tier 3 大脑（chat 在场）→ LLM 断后（复用 StubDecisionStation —— 组合
 *          不重写）：歧义/无弧/压制改道/重试的全量终审 + 消融对照组。
 *
 * 核证接地（verified grounding 纪元）：Tier 0 压制 + Tier 2 无活路（即将
 * 接地终局）时，对压制证据族（error-pattern fragments）做信任门控 ——
 * 最高信任 ≥ VERIFY_TRUST_FLOOR（亲证背书：信任 = 置信度 × 亲证衰减，
 * 传闻 trust=0）⇒ 诚实接地；全部不被信任（传闻/陈年）⇒ 放行被压制的
 * 本能弧执行**一针探针**。探针零特殊执行路径：它是普通动作走既有
 * 执行-结算-学习闭环，验证性由知识更新自然完成（成功 ⇒ 反证传闻 +
 * workflow 亲证托举；失败 ⇒ auto-learn 亲证压制）。
 * 一 run 至多一针 = 双保险：跨 run 由知识状态自然实现（探针失败 ⇒
 * 亲证 error-pattern 诞生 ⇒ 信任门控通过 ⇒ 不再探针）；run 内由
 * 闩锁结构执法（intentId 已探针 ⇒ 不再放行）—— D-4 回执沉默的世界里
 * 学习挂账至 run-end 冲账，run 内重试期间知识不变，无闩锁则探针连发
 * （学费翻倍）。闩锁与结算时序解耦：无论回执快慢，一 run 一针。
 * 消除三害：误告（传闻冤枉活路 → 一针反证）、死锁（压制+无活路+传闻
 * → 探针破局）、陈年死锁（亲证过期 → 复活探针）。
 *
 * 决策轨迹全量写入 rationale（审计可回放）—— 反射与仿真都是白盒推理；
 * ΝΩ-16 增列 tierUsed 层别标注（'reflex' | 'llm'）：审计链可回答
 * 「这一步是谁裁的」，每级判定理由不减面。
 */
export class ReflexiveDecisionStation {
    suppressAt;
    reflexOn;
    deliberationOn;
    motorOn;
    llm;
    /** 探针一次性闩锁（intentId → 已探针）：一 run 一针的结构执法 ——
     *  与 D-4 结算时序解耦（回执沉默 ⇒ 学习挂账 run-end，run 内知识不变） */
    probeLatch = new Map();
    constructor(opts) {
        this.suppressAt = opts.suppressConfidence ?? P.REFLEX_SUPPRESS_CONFIDENCE;
        this.reflexOn = !opts.disableReflex;
        this.deliberationOn = !opts.disableDeliberation;
        this.motorOn = !opts.disableMotorArc;
        this.llm = opts.chat ? new StubDecisionStation({ chat: opts.chat }) : null;
    }
    async decide(env, retryCtx, signal) {
        // ΝΩ-16 级联仲裁：Tier0 免疫压制评估**恒跑**（chat 在场也不旁路 ——
        // 安全机制没有 LLM 豁免权）。压制评估（Tier 0）与本能弧（Tier 1）
        // 并行计算 —— 探针需要被压制的弧
        const ctx = env.payload;
        const suppression = this.assessSuppression(ctx);
        const arc = this.reflexOn ? this.arcOf(ctx) : null;
        // ── 压制路径：本能弧冻结。两级语义（chat 在场）：
        //    一级（确定性）—— 被压制的本能弧绝不发射，Tier2 陷阱相似候选照旧否决；
        //    二级（咨询性）—— 压制证据 + 效用排序注入 prompt，大脑绕行/换路；
        //    大脑接地/故障 ⇒ 压制接地兜底（最坏情形 = 诚实停手，绝不是本能弧）。
        //    chat 缺席 = 既有四层链零改动（仿真改道 → 核证探针 → 诚实接地）──
        if (suppression) {
            if (!this.llm) {
                if (this.deliberationOn) {
                    const deliberated = this.deliberate(ctx);
                    if (deliberated)
                        return this.stampTier(deliberated, 'reflex');
                }
                const probe = this.verdictProbe(ctx, arc);
                if (probe)
                    return this.stampTier(probe, 'reflex');
                return suppression;
            }
            const advisory = [
                this.suppressionHint(ctx, suppression),
                this.utilityHint(ctx),
            ].filter(s => s.length > 0).join('\n');
            const rerouted = await this.llm.decideAdvisory(env, retryCtx, signal, advisory || undefined);
            return 'kind' in rerouted ? this.stampTier(rerouted, 'llm') : suppression;
        }
        // ── 反射先行（Tier 1）：无歧义 = 既有严格词法领先匹配（平票/零重合不
        //    发射 —— 发射条件零放宽）且无压制 ⇒ 直接发射，chat 在场也不打扰大脑
        //    （延迟/成本归零）。重试语境例外（仅 chat 在场时）：上次发射已失败，
        //    确定性复读大概率徒劳，交大脑读失败上下文绕行 —— 保守原则：不确定
        //    是否仍无歧义 ⇒ 宁可多花钱不多误点。chat 缺席保持确定性复读语义
        //    （决策纯函数，同刺激同反应 —— 零回归）──
        if (arc && 'action' in arc && !(this.llm && retryCtx)) {
            return this.stampTier(arc.action, 'reflex');
        }
        // ── LLM 断后（Tier 3）：歧义 / 无弧 / 反射断电 / 重试 ⇒ 大脑终审。
        //    Tier2 效用评分降格为 prompt 排序提示（提示非指令 —— 大脑可凭理由
        //    推翻，推翻与否由其 rationale 自证）。大脑的接地就是接地（不再
        //    探针 —— 探针是零模型世界的验证通道；大脑在场时大脑本身就是改道）──
        if (this.llm) {
            const hint = this.utilityHint(ctx);
            const out = await this.llm.decideAdvisory(env, retryCtx, signal, hint || undefined);
            return 'kind' in out ? this.stampTier(out, 'llm') : out;
        }
        // ── chat 缺席：既有慢路径（与级联化之前逐行同语义 —— 零回归。能走到
        //    这里 arc 只剩接地变体：action 变体已在上方反射门返回或已交大脑）──
        if (arc && 'grounding' in arc) {
            if (arc.deliberable && this.deliberationOn) {
                const deliberated = this.deliberate(ctx);
                if (deliberated)
                    return this.stampTier(deliberated, 'reflex');
            }
            return arc.grounding;
        }
        // 反射断电（消融）：一切交慢路径
        if (this.deliberationOn) {
            const deliberated = this.deliberate(ctx);
            if (deliberated)
                return this.stampTier(deliberated, 'reflex');
        }
        return { reason: 'reflex ablated — slow path only', focus: 'full-scene' };
    }
    /** 层别标注（ΝΩ-16）：纯附加可选字段 —— rationale 之上的「谁裁的」维度，
     *  不改既有字段语义，执行工位（只读 kind/args/expect）零感知。 */
    stampTier(action, tier) {
        return { ...action, tierUsed: tier };
    }
    /** 压制证据的 prompt 注入（压制路径二级面，ΝΩ-16）：证据交大脑，指令面
     *  只声明「本能路径已被压制 + 绕行要求」—— 不点名坐标不替大脑选路
     *  （两级语义：确定性的事结构执法，判断性的事归大脑）。有界 400 字符
     *  （Token 纪律）。 */
    suppressionHint(ctx, suppression) {
        const kc = ctx.knowledgeContext;
        const traps = (kc?.fragments ?? [])
            .filter(f => f.category === 'error-pattern')
            .slice(0, 3)
            .map(f => `'${f.content.slice(0, 60)}' (conf ${f.confidence.toFixed(2)})`)
            .join('; ');
        const evidence = traps || (kc ? kc.summary.slice(0, 120) : '');
        return (`IMMUNE SUPPRESSION ACTIVE: ${suppression.reason}` +
            (evidence ? ` | trap evidence: ${evidence}` : '') +
            '. The instinctive click path is suppressed — reroute via a different element or ground; do not repeat the known trap.').slice(0, 400);
    }
    /** Tier2 效用评分的 prompt 排序提示（LLM 断后路径，ΝΩ-16）：deliberate 的
     *  胜者证据链交大脑作排序先验 —— 提示非指令，大脑可推翻。消融（仿真断电）
     *  / 无证据 / 全负 ⇒ 空串（诚实缺席，不伪造排序）。有界 400 字符。 */
    utilityHint(ctx) {
        if (!this.deliberationOn)
            return '';
        const best = this.deliberate(ctx);
        if (!best)
            return '';
        return (`RANKING HINT (tier-2 utility): ${best.rationale}` +
            ' — consider this ranking first; overrule only with reason.').slice(0, 400);
    }
    /** 免疫压制评估（Tier 0）：error-pattern 在场且置信度达阈值 ⇒ 压制。
     *  返回压制接地理由（NeedGrounding）；未压制 ⇒ null。
     *  判据保持原始 confidence（信任只门控接地，不动压制 —— 保守设计：
     *  传闻压制仍发生，但接地前必须核证）。
     *  J 纪元修正：置信度口径 = **error-pattern 条目的最大值**（与 Tier 2
     *  前额叶逐 fragment 判 `f.confidence ≥ suppressAt` 同口径）。旧判据用
     *  全类别 maxConfidence —— 一条 0.9 的 workflow + 一条 0.1 的
     *  error-pattern 也会触发压制，压制语义被无关类别劫持。
     *  fragments 缺席（旧方言/预算截断）回退 kc.maxConfidence（保守：
     *  宁可压制不可踩坑）。 */
    assessSuppression(ctx) {
        const kc = ctx.knowledgeContext;
        if (!kc || !kc.categories.includes('error-pattern'))
            return null;
        const errorFragments = kc.fragments?.filter(f => f.category === 'error-pattern') ?? [];
        const errorConf = errorFragments.length > 0
            ? Math.max(...errorFragments.map(f => f.confidence))
            : kc.maxConfidence;
        if (errorConf >= this.suppressAt) {
            return {
                reason: `reflex suppressed by error-pattern (conf ${errorConf.toFixed(2)} ≥ ${this.suppressAt}) — known trap, rerouting`,
                focus: 'knowledge',
            };
        }
        return null;
    }
    /**
     * 核证接地：接地前信任门控的探针验证。
     *
     * 触发条件（四者同时在场）：
     *   1. 压制 + 前额叶无活路（本方法只从压制路径调用）
     *   2. 压制证据族（error-pattern fragments）最高信任 < VERIFY_TRUST_FLOOR
     *      —— 全传闻（manual 种子 verifiedAt 缺席 ⇒ trust 0）或陈年亲证
     *      （衰减过线 —— 世界会变，亲证会过期）
     *   3. 被压制的本能弧在场（无从探针 ⇒ 诚实接地）
     *   4. 本 intent 尚未探过针（一次性闩锁 —— 一 run 一针，与结算时序解耦：
     *      探针失败后的 run 内重试不再放行，直接诚实接地；DS-4 升级：
     *      学习闭环因容量断裂的 intent 由进程级闩锁跨实例续护 1h）
     *
     * 探针语义：放行一针验证 —— 探针是普通 AtomicAction（rationale 带
     * probe 标记，审计可识别），走既有执行-结算-学习闭环：
     *   成功 ⇒ 传闻被现实反证（冤枉解除；workflow 亲证托举下次改道）
     *   失败 ⇒ auto-learn 亲证压制诞生（跨 run 信任门控通过 ⇒ 不再探针）
     */
    verdictProbe(ctx, arc) {
        if (!arc || !('action' in arc))
            return null; // 无被压制的本能弧 ⇒ 无从探针
        const fragments = ctx.knowledgeContext?.fragments;
        if (!fragments || fragments.length === 0)
            return null; // 无证据面 ⇒ 门控无从评估（旧实现兼容）
        // 一次性闩锁：run 内（实例闩锁）或学习闭环断裂升级（进程闩锁，DS-4）
        // 已探针 ⇒ 诚实接地
        if (this.probeLatch.has(ctx.intent.id) || processLatchActive(ctx.intent.id))
            return null;
        const now = Date.now();
        let maxTrust = 0;
        for (const f of fragments) {
            if (f.category !== 'error-pattern')
                continue;
            maxTrust = Math.max(maxTrust, trustOf(f.confidence, f.verifiedAt, now));
        }
        if (maxTrust >= P.VERIFY_TRUST_FLOOR)
            return null; // 亲证背书在场 ⇒ 诚实接地
        this.probeLatch.set(ctx.intent.id, true); // 落闩：一 run 一针
        if (this.probeLatch.size > PROBE_LATCH_MAX) {
            const oldest = this.probeLatch.keys().next().value; // Map 迭代序 = 插入序（FIFO）
            if (oldest !== undefined)
                this.probeLatch.delete(oldest);
        }
        return {
            ...arc.action,
            rationale: `probe(verified-grounding): trap evidence untrusted (max trust ${maxTrust.toFixed(2)} < floor ${P.VERIFY_TRUST_FLOOR.toFixed(2)}) — suppressed arc released for one-shot verification; ${arc.action.rationale}`,
        };
    }
    /**
     * DS-4 学习闭环断裂上报（接线缝：pipeline 侧 learnSettled 检出容量拒绝
     * `r.error.field === 'capacity'` 时对本工位调用 —— 工位在 pipeline deps 内
     * 可直达。ΠΑΝ-48 已接线：此前该缝在 pipeline.ts 无对应分支，本方法是
     * 零调用方的死声明 —— 注释承诺的保护不存在）：该 intent 的探针闩锁升
     * 进程级（跨工位实例存活），1h 衰减自动解除（容量拒绝可被上游清库解除
     * —— 探针是传闻的解药不是刑具）。
     * 运行层永不抛错：非法输入静默拒绝（守卫不炸流水线）。
     * now 可注入（时间旅行测试缝 —— 与 trustOf 同方言）；缺省墙钟。
     */
    escalateProbeLatch(intentId, now = Date.now()) {
        if (typeof intentId !== 'string' || !intentId)
            return;
        processProbeLatch.set(intentId, now);
        if (processProbeLatch.size > PROBE_LATCH_MAX) {
            const oldest = processProbeLatch.keys().next().value; // Map 迭代序 = 插入序（FIFO 保险丝同律）
            if (oldest !== undefined)
                processProbeLatch.delete(oldest);
        }
    }
    /** 弧合流点（Tier 1）：运动类刺激 ⇒ 运动反射弧主权；否则点击弧（既有律） */
    arcOf(ctx) {
        if (this.motorOn) {
            const motor = this.motorArc(ctx);
            if (motor)
                return motor;
        }
        return this.reflexArc(ctx);
    }
    /**
     * 运动反射弧（Tier 1 运动词汇，X 纪元）—— 零 LLM 的结构化动作发射器。
     *
     * 刺激类别（动词位判别）→ 逐类提取 → 发射或拒绝：
     *   typing  : 引号锚定载荷（信息无损）+ 残差落点（载荷词不参选）
     *   scrolling: 方向词唯一 + 幅度在运动学域 [1,20]
     *   hotkey  : 键名归一 + 和弦 ≤4
     *
     * 运动序法则（先落点后运笔）：残差对场景元素有**严格领先**词法命中 ⇒
     * 本轮发射前置动作（点击落点/聚焦控件），笔迹留待焦点就位后的下一轮 ——
     * 书写 presupposes 落点，这是 {落点 → 笔迹} 依赖 DAG 的拓扑序，
     * 不是启发式。'press the red button' 同律被保护（button 残差命中 ⇒ 点击，
     * 不会误入热键弧）。
     *
     * 自证反射（born-verified reflex）：引号锚定让 type_text 生而携带 L4
     * 预期锚（expectedText === 载荷，编辑距离 0）—— 反射第一次「知道自己
     * 成功长什么样」；点击弧做不到（无法预像素），笔迹弧可以（载荷即预期）。
     *
     * 拒绝语义（精确性优先）：载荷缺席/多义、方向缺席/多义、幅度域外、
     * 键名域外 ⇒ 结构化 grounding —— 自由文本提取是有损猜测，打错一个字
     * 的密码与没打一样。知识能救落点（deliberable ⇒ workflow 语义托举），
     * 救不了词法结构（引号缺失不是知识问题）。
     */
    motorArc(ctx) {
        const motorClass = classifyMotor(ctx.intent.description);
        if (!motorClass)
            return null; // 非运动类刺激 —— 点击弧主权不动
        // 落点优先法则：残差（引号段+动词已切除）对元素的严格领先命中
        const lead = this.lexicalLead(new Set(residueTokens(ctx.intent.description)), ctx.scene);
        if (lead.match) {
            const { name, cx, cy } = lead.match;
            return {
                action: {
                    kind: 'click_mouse',
                    args: { x: Math.round(cx * 10000) / 10000, y: Math.round(cy * 10000) / 10000 },
                    rationale: `motor-reflex(${motorClass}): prerequisite-first — acquiring '${name}' (residue overlap=${lead.match.score}, best of ${lead.total}); motion deferred until focus is set`,
                },
            };
        }
        if (motorClass === 'typing') {
            const spans = extractQuotedSpans(ctx.intent.description);
            if (spans.length === 1) {
                const text = spans[0].content;
                return {
                    action: {
                        kind: 'type_text',
                        // clearFirst：引号载荷 = 字段的完整内容（不是追加片段）—— 重试/
                        // 复放语义确定性：同载荷重打覆盖而非叠加。
                        args: { text, clearFirst: true },
                        // 自证 L4 锚：引号锚定的载荷与预期同源 —— 编辑距离 0 的自我预言
                        expect: { scale: 'text-level', expectedText: text },
                        rationale: `motor-reflex(type): payload ${text.length} chars quote-anchored (${spans[0].quote}, lossless, clearFirst); no named target — focus-carried`,
                    },
                };
            }
            return {
                grounding: {
                    reason: spans.length === 0
                        ? 'motor-reflex refused: typing without quoted payload (free-text extraction is lossy — precision-first)'
                        : `motor-reflex refused: ${spans.length} quoted spans (payload ambiguous)`,
                    focus: 'full-scene',
                },
                deliberable: spans.length === 0, // 无载荷但可能有语义落点（workflow 可托举）；多载荷是结构病
            };
        }
        if (motorClass === 'scrolling') {
            const r = extractScroll(ctx.intent.description);
            if (r.kind === 'ok') {
                return {
                    action: {
                        kind: 'scroll_page',
                        args: { direction: r.value.direction, amount: r.value.amount },
                        rationale: `motor-reflex(scroll): ${r.value.direction} x${r.value.amount} (kinematic domain [1,${20}])`,
                    },
                };
            }
            return { grounding: { reason: `motor-reflex refused: ${r.reason}`, focus: 'full-scene' }, deliberable: false };
        }
        // hotkey
        const r = extractHotkey(ctx.intent.description);
        if (r.kind === 'ok') {
            return {
                action: {
                    kind: 'press_hotkey',
                    args: { keys: r.value.keys },
                    rationale: `motor-reflex(hotkey): chord [${r.value.keys.join('+')}] (normalized key names)`,
                },
            };
        }
        // 键名域外 ⇒ 可能本就是点击意图（'press the big red button' 且词法零重合）
        // —— 语义托举仍可能找到落点，deliberable
        return { grounding: { reason: `motor-reflex refused: ${r.reason}`, focus: 'full-scene' }, deliberable: true };
    }
    /** 词法领先扫描（反射弧与运动弧的共用件）：token 集 × 场景元素，
     *  最优严格领先才匹配 —— 平票/零重合 ⇒ 无匹配（绝不掷硬币）。 */
    lexicalLead(intentTokens, scene) {
        let best = null;
        let second = 0;
        let total = 0;
        for (const patch of scene) {
            for (const el of patch.elements) {
                total += 1;
                const score = tokenizeText(el.name).filter(t => intentTokens.has(t)).length;
                if (!best || score > best.score) {
                    second = best ? best.score : 0;
                    best = { name: el.name, cx: el.rect.x + el.rect.width / 2, cy: el.rect.y + el.rect.height / 2, score };
                }
                else if (score > second) {
                    second = score;
                }
            }
        }
        if (!best || best.score === 0)
            return { match: null, second, total };
        if (best.score === second)
            return { match: null, second, total }; // 平票 ⇒ 歧义交上层
        return { match: best, second, total };
    }
    /** 脊髓反射弧（Tier 1）：动作 / 接地 + 前额叶可否接手（压制路径外独立计算） */
    reflexArc(ctx) {
        const intentTokens = new Set(tokenizeText(ctx.intent.description));
        if (intentTokens.size === 0) {
            return {
                grounding: { reason: 'intent has no recognizable tokens — no reflex arc', focus: 'full-scene' },
                deliberable: false, // 零 token 意图连语义锚也没有 —— 仿真同样无米下锅
            };
        }
        const { match, second, total } = this.lexicalLead(intentTokens, ctx.scene);
        if (!match) {
            if (second === 0 && total > 0 && intentTokens.size > 0) {
                // 全零重合（second===0 且 best.score===0 被 lexicalLead 判无匹配）
                return {
                    grounding: { reason: `no reflex arc: none of ${total} scene elements match intent tokens`, focus: 'full-scene' },
                    deliberable: true, // 词汇零重合 ≠ 语义零相关 —— 前额叶的零样本泛化可能命中
                };
            }
            return {
                grounding: { reason: `reflex ambiguous: top candidates tie at score ${second} — grounding`, focus: 'full-scene' },
                deliberable: true, // 平票 ⇒ 知识证据是唯一合法的破局者
            };
        }
        return {
            action: {
                kind: 'click_mouse',
                args: { x: Math.round(match.cx * 10000) / 10000, y: Math.round(match.cy * 10000) / 10000 },
                rationale: `reflex: '${match.name}' matched intent (overlap=${match.score}, best of ${total})`,
            },
        };
    }
    /**
     * 前额叶仿真（Tier 2 慢路径推理）：全候选 × 全证据的效用评估。
     *
     * 两类证据两种语义（消融基准暴露缺陷后的原则性修复）：
     *   已确立陷阱（error-pattern conf ≥ suppressAt —— 与 Tier 0 同一阈值，
     *   一个阈值一个含义）⇒ **否决**：候选出局，不参与效用竞争。失败结局的
     *   预测是排除性知识，不是偏好折扣 —— 线性惩罚（旧版）在字面+语义双重
     *   吸引下会被反超（实测 0.72 vs 0.60 陷阱险胜），免疫系统对已确立
     *   陷阱必须给出不可逾越的边界。
     *   弱陷阱证据（conf < 阈值）⇒ 线性惩罚（嫌疑，不是定罪）。
     *
     * 效用经济学（未被否决的候选）：
     *   + intent 词汇重合数（Tier 1 同源基信号）
     *   + 意图↔元素语义相似度（≥ 地板才计 —— 零样本泛化通道）
     *   − 弱 error-pattern 相似度 × 置信度 × 陷阱权重
     *   + workflow 相似度 × 置信度 × 妙手权重
     * 胜出条件：最高效用 > 0 且严格领先次名 —— 平票/全负 ⇒ null（接地），
     * 绝不掷硬币。证据链全量入 rationale（白盒可审计）。
     */
    deliberate(ctx) {
        const fragments = ctx.knowledgeContext?.fragments;
        if (!fragments || fragments.length === 0)
            return null; // 无证据 ⇒ 无仿真（诚实降级）
        // X 纪元（载荷剥夺）：运动类意图的词法通道用残差 token —— 引号内的
        // 载荷词不参加落点选举（与运动弧同律）；语义通道仍用完整意图（证据
        // 经济学不因词法纪律而失明）。
        const motorClass = classifyMotor(ctx.intent.description);
        const intentTokens = new Set(motorClass ? residueTokens(ctx.intent.description) : tokenizeText(ctx.intent.description));
        // DS-3（ΝΩ-16 顺修）：三处嵌入全走进程级 LRU 缓存 —— run 内 intent/
        // fragment/元素名高度复现（重试轮尤甚），重复哈希是纯浪费；embed 纯函数
        // ⇒ 缓存命中零语义漂移。
        const intentVec = embedCached(ctx.intent.description);
        const fragmentVecs = fragments.map(f => embedCached(f.content));
        let best = null;
        let second = null;
        const vetoed = [];
        let total = 0;
        for (const patch of ctx.scene) {
            for (const el of patch.elements) {
                total += 1;
                const elVec = embedCached(el.name);
                const evidence = [];
                let utility = 0;
                let veto = false;
                const matched = new Set(tokenizeText(el.name).filter(t => intentTokens.has(t))).size;
                if (matched > 0)
                    utility += matched;
                const intentSim = cosine(intentVec, elVec);
                if (intentSim >= P.DELIB_RELEVANCE_FLOOR) {
                    utility += intentSim;
                    evidence.push(`intent-sim ${intentSim.toFixed(2)}`);
                }
                for (let i = 0; i < fragments.length && !veto; i++) {
                    const sim = cosine(fragmentVecs[i], elVec);
                    if (sim < P.DELIB_RELEVANCE_FLOOR)
                        continue;
                    const f = fragments[i];
                    if (f.category === 'error-pattern') {
                        if (f.confidence >= this.suppressAt) {
                            // 已确立陷阱 ⇒ 否决（免疫的排除语义，非折扣）
                            veto = true;
                            vetoed.push(`'${el.name}' (${f.confidence.toFixed(2)}×${sim.toFixed(2)})`);
                            break;
                        }
                        utility -= sim * f.confidence * DELIB_ERROR_WEIGHT; // 嫌疑折扣
                        evidence.push(`-${f.category} ${f.confidence.toFixed(2)}×${sim.toFixed(2)}`);
                    }
                    else if (f.category === 'workflow') {
                        utility += sim * f.confidence * P.DELIB_WORKFLOW_WEIGHT;
                        evidence.push(`+workflow ${f.confidence.toFixed(2)}×${sim.toFixed(2)}`);
                    }
                }
                if (veto)
                    continue; // 出局者不参与排名（但入审计轨迹）
                if (!best || utility > best.utility) {
                    second = best ? { name: best.name, utility: best.utility, evidence: best.evidence } : null;
                    best = { name: el.name, cx: el.rect.x + el.rect.width / 2, cy: el.rect.y + el.rect.height / 2, utility, evidence };
                }
                else if (!second || utility > second.utility) {
                    second = { name: el.name, utility, evidence };
                }
            }
        }
        if (!best || best.utility <= 0 || (second && best.utility <= second.utility))
            return null;
        // 审计轨迹双向白盒：胜者的赢面 + 次名的落选理由 + 被否决者（免疫执法记录）
        const runnerUp = second ? `; runner-up '${second.name}' utility=${second.utility.toFixed(2)} evidence=[${second.evidence.join(', ')}]` : '';
        const vetoNote = vetoed.length > 0 ? `; vetoed=[${vetoed.join(', ')}]` : '';
        return {
            kind: 'click_mouse',
            args: { x: Math.round(best.cx * 10000) / 10000, y: Math.round(best.cy * 10000) / 10000 },
            rationale: `deliberation: '${best.name}' utility=${best.utility.toFixed(2)} (best of ${total}) evidence=[${best.evidence.join(', ')}]${runnerUp}${vetoNote}`,
        };
    }
}
/**
 * 执行工位桩。不思考为什么，不修正参数，不重试 —— AtomicAction 进，ExecutionResult 出。
 * action 内联回显（D-7 方言）：Outcome 打包无需二次查表。
 */
export class StubExecutionStation {
    opts;
    constructor(opts) {
        this.opts = opts;
    }
    /**
     * 可选止损 signal（ΠΑΝ-43~48 修复潮对接点）：透传到宿主端口的实际派发
     * （host.execute(action, signal)）—— 流水线执行步超时的止损经此抵达真机
     * 躯体（D-5 微服务断流）。端口不消费 signal 时由其内层超时兜底（浪费窗口
     * 有界），工位零强求。
     */
    async execute(env, signal) {
        const action = env.payload;
        const startedAt = Date.now();
        if (!this.opts.host) {
            return {
                action,
                status: 'failure',
                durationMs: Date.now() - startedAt,
                failure: { kind: 'host-error', detail: 'no host executor wired (stub era — honest degradation)' },
            };
        }
        try {
            const r = await this.opts.host.execute(action, signal);
            // 外部注入执行端口（dsh.host-executor）的返回是外部数据：status 词表外或
            // 缺失 ⇒ 按契约违约处理（host-error），不得把垃圾值伪装成 degraded 完成
            if (!r || (r.status !== 'success' && r.status !== 'failure' && r.status !== 'degraded')) {
                return {
                    action,
                    status: 'failure',
                    durationMs: Date.now() - startedAt,
                    failure: { kind: 'host-error', detail: `host executor returned invalid result (status=${JSON.stringify(r?.status)})` },
                };
            }
            return { action, ...r, durationMs: Date.now() - startedAt };
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return {
                action,
                status: 'failure',
                durationMs: Date.now() - startedAt,
                failure: { kind: 'host-error', detail: `host executor threw (contract breach): ${msg}` },
            };
        }
    }
}
