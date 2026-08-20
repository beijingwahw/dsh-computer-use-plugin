import { tokenize } from '../uiMemory.js';
import { embed, cosine } from '../semanticHash.js';
import { trustOf } from './knowledgeBase.js';
import { P } from './params.js';
// ─── 网格分区铸造（'g{col}x{row}' —— D-6 坐标同一性方案复刻，跨轮稳定）───
function gridRegions(grid) {
    const regions = [];
    for (let col = 0; col < grid.cols; col++) {
        for (let row = 0; row < grid.rows; row++) {
            regions.push({
                id: `g${col}x${row}`,
                x: col / grid.cols, y: row / grid.rows,
                width: 1 / grid.cols, height: 1 / grid.rows,
            });
        }
    }
    return regions;
}
/** 故障补丁铸造：扫描失败 ≠ 真空（两种空，两种决策 —— 对齐 D-6 ScenePatch.fault 契约）。
 *  导出：D-5 微服务感知端口（d7HostPort）同方言复用 —— 感知失败的形状全机体统一。 */
export function faultPatches(grid, detail) {
    const capturedAt = Date.now();
    return gridRegions(grid).map(region => ({
        region,
        elements: [],
        funnelDepth: 'empty',
        fault: { source: 'L1', detail },
        capturedAt,
    }));
}
/** 感知分派公用件：归一化元素（中心落区即入区）→ 网格分区补丁。
 *  capability 源（本机 a11y/OCR）与 D-5 微服务源（远端 UI 树）共用同一分派律 ——
 *  'g{col}x{row}' 坐标同一性方言跨源稳定。 */
export function dispatchElementsToGrid(els, grid, depth, sourceLabel) {
    const capturedAt = Date.now();
    const patches = [];
    for (let col = 0; col < grid.cols; col++) {
        for (let row = 0; row < grid.rows; row++) {
            const region = {
                id: `g${col}x${row}`,
                x: col / grid.cols, y: row / grid.rows, width: 1 / grid.cols, height: 1 / grid.rows,
            };
            const inRegion = els.filter(e => e.rect.x + e.rect.width / 2 >= region.x &&
                e.rect.x + e.rect.width / 2 <= region.x + region.width &&
                e.rect.y + e.rect.height / 2 >= region.y &&
                e.rect.y + e.rect.height / 2 <= region.y + region.height);
            patches.push({
                region,
                elements: inRegion.map(e => ({ source: sourceLabel, ...e })),
                funnelDepth: inRegion.length > 0 ? depth : 'empty',
                capturedAt,
            });
        }
    }
    return patches;
}
/**
 * 能力回退场景源（P1-4）：'dsh.vision.station' 外部服务缺席时，用插件自身
 * 视觉能力顶上 —— L1 无障碍树优先（uiExtractor 纯 JS 静态引入），
 * L1 不可用/为空 ⇒ L2 全屏 OCR（textReader 惰性动态引入 —— 原生依赖隔离，
 * 沙箱环境零污染）分派到网格分区。双缺席 ⇒ 抛错（工位 catch 转 fault 补丁
 * —— 「看不见」是 fault，不是真空）。
 * 元素 rect 归一化域 = 全屏（像素 ÷ 屏幕尺寸 —— 归一化责任在适配器）。
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
            return ocr.words.map(w => ({
                role: 'text',
                name: w.text.slice(0, 20),
                rect: {
                    x: w.bbox_normalized.x0, y: w.bbox_normalized.y0,
                    width: w.bbox_normalized.x1 - w.bbox_normalized.x0,
                    height: w.bbox_normalized.y1 - w.bbox_normalized.y0,
                },
            }));
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
    async perceive(env) {
        const req = env.payload;
        if (!this.opts.source) {
            return faultPatches(req.grid, 'no scene source wired (stub era — honest degradation)');
        }
        try {
            const patches = await this.opts.source.perceive(req);
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
    /** 决策上下文 → 紧凑 prompt（Token 纪律：结构化场景表 + 隐知识摘要，零散文背景） */
    buildPrompt(ctx, retryCtx) {
        const scene = ctx.scene
            .map(p => `[${p.region.id}] ${p.funnelDepth}: ` +
            p.elements.map(e => `${e.role}(${e.name})@${e.rect.x.toFixed(2)},${e.rect.y.toFixed(2)}`).join(' '))
            .join('\n');
        const knowledge = ctx.knowledgeContext
            ? `\nTACIT KNOWLEDGE (conf ${ctx.knowledgeContext.maxConfidence.toFixed(2)}): ${ctx.knowledgeContext.summary}`
            : '';
        const retry = retryCtx ? `\nLAST FAILURE (retry ${retryCtx.retryCount}): ${retryCtx.reason}` : '';
        const prev = ctx.previousResults?.length
            ? `\nPREVIOUS RESULTS: ${ctx.previousResults.map(r => `${r.action.kind}=${r.status}`).join(', ')}`
            : '';
        return `GOAL: ${ctx.intent.description}${knowledge}${prev}${retry}\nSCENE:\n${scene}\n` +
            'OUTPUT (strict JSON): {"type":"action","action":{"kind":"click_mouse|type_text|...","args":{...}},"rationale":"..."} ' +
            'or {"type":"need-grounding","reason":"...","focus":"..."}';
    }
    async decide(env, retryCtx) {
        if (!this.opts.chat) {
            return { reason: 'no decision channel wired (stub era — honest degradation)', focus: 'full-scene' };
        }
        let raw;
        try {
            raw = await this.opts.chat(this.buildPrompt(env.payload, retryCtx));
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
                const action = obj.action;
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
/**
 * 反射决策工位：神经纪元四层脑 —— 无 LLM 通道时的完整决策智能。
 *
 * 层级（快→慢，每层失败才降级到下一层）：
 *   Tier 0 免疫抑制（最高优先）→ KnowledgeInjection 含高置信 error-pattern ⇒
 *          压制本能弧 + 交前额叶改道（「陷阱已知」不该是死刑判决：
 *          停手是为了找活路 —— error-pattern 在效用上压负陷阱，workflow
 *          托举替代路径；找不到活路才诚实接地。消融基准暴露的缺陷修复：
 *          旧版 suppression 直接接地 = 「知道哪错但从不想别的路」）
 *   Tier 1 脊髓反射          → intent 词汇 × 场景元素名的严格领先匹配 ⇒ 直接
 *          click 元素中心（刺激→反应，零幻觉、确定性、可重放审计）
 *   Tier 2 前额叶仿真        → 反射不明确（平票/零重合/被免疫压制）时，全候选
 *          证据评估：语义相似度（零样本泛化）× 知识证据（error-pattern 惩罚 /
 *          workflow 奖励）的效用评分 —— 「整理数据」的 workflow 证据能托举
 *          「筛选数据」按钮；陷阱记忆能在效用上压垮字面匹配。最高效用且
 *          严格领先 ⇒ 执行。
 *   Tier 3 大脑（chat 在场） → LLM 规划（复用 StubDecisionStation —— 组合不重写）
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
 * 决策轨迹全量写入 rationale（审计可回放）—— 反射与仿真都是白盒推理。
 */
export class ReflexiveDecisionStation {
    suppressAt;
    reflexOn;
    deliberationOn;
    llm;
    /** 探针一次性闩锁（intentId → 已探针）：一 run 一针的结构执法 ——
     *  与 D-4 结算时序解耦（回执沉默 ⇒ 学习挂账 run-end，run 内知识不变） */
    probeLatch = new Map();
    constructor(opts) {
        this.suppressAt = opts.suppressConfidence ?? P.REFLEX_SUPPRESS_CONFIDENCE;
        this.reflexOn = !opts.disableReflex;
        this.deliberationOn = !opts.disableDeliberation;
        this.llm = opts.chat ? new StubDecisionStation({ chat: opts.chat }) : null;
    }
    async decide(env, retryCtx) {
        if (this.llm)
            return this.llm.decide(env, retryCtx);
        const ctx = env.payload;
        // 压制评估（Tier 0）与本能弧（Tier 1）并行计算 —— 探针需要被压制的弧
        const suppression = this.assessSuppression(ctx);
        const arc = this.reflexOn ? this.reflexArc(ctx) : null;
        // ── 压制路径：本能弧冻结，前额叶改道；无活路 ⇒ 核证接地（信任门控探针）──
        if (suppression) {
            if (this.deliberationOn) {
                const deliberated = this.deliberate(ctx);
                if (deliberated)
                    return deliberated;
            }
            const probe = this.verdictProbe(ctx, arc);
            if (probe)
                return probe;
            return suppression;
        }
        // ── 常规路径：弧直行 / 歧义交仿真 / 反射断电交仿真 ──
        if (arc && 'action' in arc)
            return arc.action;
        if (arc) {
            if (arc.deliberable && this.deliberationOn) {
                const deliberated = this.deliberate(ctx);
                if (deliberated)
                    return deliberated;
            }
            return arc.grounding;
        }
        // 反射断电（消融）：一切交慢路径
        if (this.deliberationOn) {
            const deliberated = this.deliberate(ctx);
            if (deliberated)
                return deliberated;
        }
        return { reason: 'reflex ablated — slow path only', focus: 'full-scene' };
    }
    /** 免疫压制评估（Tier 0）：error-pattern 在场且置信度达阈值 ⇒ 压制。
     *  返回压制接地理由（NeedGrounding）；未压制 ⇒ null。
     *  判据保持原始 confidence（信任只门控接地，不动压制 —— 保守设计：
     *  传闻压制仍发生，但接地前必须核证）。 */
    assessSuppression(ctx) {
        const kc = ctx.knowledgeContext;
        if (kc && kc.categories.includes('error-pattern') && kc.maxConfidence >= this.suppressAt) {
            return {
                reason: `reflex suppressed by error-pattern (conf ${kc.maxConfidence.toFixed(2)} ≥ ${this.suppressAt}) — known trap, rerouting`,
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
     *      探针失败后的 run 内重试不再放行，直接诚实接地）
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
        if (this.probeLatch.has(ctx.intent.id))
            return null; // 一次性闩锁：已探针 ⇒ 诚实接地
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
    /** 脊髓反射弧（Tier 1）：动作 / 接地 + 前额叶可否接手（压制路径外独立计算） */
    reflexArc(ctx) {
        const intentTokens = new Set(tokenize(ctx.intent.description));
        if (intentTokens.size === 0) {
            return {
                grounding: { reason: 'intent has no recognizable tokens — no reflex arc', focus: 'full-scene' },
                deliberable: false, // 零 token 意图连语义锚也没有 —— 仿真同样无米下锅
            };
        }
        let best = null;
        let second = 0;
        let total = 0;
        for (const patch of ctx.scene) {
            for (const el of patch.elements) {
                total += 1;
                const score = tokenize(el.name).filter(t => intentTokens.has(t)).length;
                if (!best || score > best.score) {
                    second = best ? best.score : 0;
                    best = { name: el.name, cx: el.rect.x + el.rect.width / 2, cy: el.rect.y + el.rect.height / 2, score };
                }
                else if (score > second) {
                    second = score;
                }
            }
        }
        if (!best || best.score === 0) {
            return {
                grounding: { reason: `no reflex arc: none of ${total} scene elements match intent tokens`, focus: 'full-scene' },
                deliberable: true, // 词汇零重合 ≠ 语义零相关 —— 前额叶的零样本泛化可能命中
            };
        }
        if (best.score === second) {
            return {
                grounding: { reason: `reflex ambiguous: top candidates tie at score ${best.score} — grounding`, focus: 'full-scene' },
                deliberable: true, // 平票 ⇒ 知识证据是唯一合法的破局者
            };
        }
        return {
            action: {
                kind: 'click_mouse',
                args: { x: Math.round(best.cx * 10000) / 10000, y: Math.round(best.cy * 10000) / 10000 },
                rationale: `reflex: '${best.name}' matched intent (overlap=${best.score}, best of ${total})`,
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
        const intentTokens = new Set(tokenize(ctx.intent.description));
        const intentVec = embed(ctx.intent.description);
        const fragmentVecs = fragments.map(f => embed(f.content));
        let best = null;
        let second = null;
        const vetoed = [];
        let total = 0;
        for (const patch of ctx.scene) {
            for (const el of patch.elements) {
                total += 1;
                const elVec = embed(el.name);
                const evidence = [];
                let utility = 0;
                let veto = false;
                const matched = new Set(tokenize(el.name).filter(t => intentTokens.has(t))).size;
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
    async execute(env) {
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
            const r = await this.opts.host.execute(action);
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
