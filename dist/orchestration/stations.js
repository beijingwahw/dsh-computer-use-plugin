import { SANDBOX_ACTION_KINDS } from '../sandbox/types.js';
/**
 * 视觉感知工位默认实现 —— “我只描述，不判断”。
 * 三级漏斗纪律（蓝图铁律）：L1 命中 ⇒ 绝不启动 L2；L2 命中 ⇒ 绝不启动 L3；
 * L3 仅当 ceiling='L3'（中枢授权）才可用 —— 无授权而启动 = 越权花钱，工位无此代码路径。
 * Never-reject 契约：perceive 流永不 reject —— 故障化作 fault 空补丁。
 * 骨架诚实声明：流式分区间产出为最小实现（逐区 for-await 产出，无跨区并发）——
 * 真正的阶段重叠（扫描区 N 时决策消费区 N-1）由 pipeline.ts 的消费侧并行达成，
 * 工位侧只需保证 AsyncIterable 语义正确（骨架不伪造并发，诚实标注）。
 */
export class DefaultVisionStation {
    opts;
    // 显式字段赋值（非参数属性）：Node strip-only 运行时契约 —— 现世源码同方言
    constructor(opts) {
        this.opts = opts;
    }
    async *perceive(env) {
        const req = env.payload;
        // deadlineMs 是时长（pipeline 传 config.perceptionDeadlineMs）—— 先换算为绝对
        // 时刻再与 Date.now() 比较；直接比较会让任何正时长立即「超时」（漏斗全灭）
        const deadlineAt = req.deadlineMs === undefined ? Number.POSITIVE_INFINITY : Date.now() + req.deadlineMs;
        // 契约兜底（contracts.ts 立法）：空分区 = 默认全屏网格（1×1 单区）
        const regions = req.regions.length > 0
            ? req.regions
            : [{ id: 'g0x0', x: 0, y: 0, width: 1, height: 1 }];
        for (const region of regions) {
            if (Date.now() > deadlineAt) {
                // 超时是 fault（≠ 真空）：归因到授权漏斗深度 —— 丢弃 detail 会让超时
                // 补丁与真空不可区分（「两种空两种决策」契约被自己的超时路径打破）
                yield this.emptyPatch(region, req.funnelCeiling, 'perception deadline exceeded');
                continue;
            }
            // J 纪元修正：L1/L2 源故障改为「记 fault + 降层继续」。
            // 旧实现 fault 分支 `continue` 直接跳到下一个分区 —— 当前分区的
            // L2/L3 被跳过，与注释宣称的「降 L2 继续」矛盾；a11y 持续故障时
            // L2/OCR 永远不被尝试，区域补丁只带 L1 fault。
            let degradedFault;
            // L1：结构化层（<1ms 预算域）
            if (this.opts.structured?.isReady()) {
                const { els, fault } = await this.safeExtract(region, this.opts.structured);
                if (els.length > 0) {
                    yield this.patch(region, els, 'L1');
                    continue; // 漏斗短路：L1 命中，绝不启动 L2
                }
                if (fault)
                    degradedFault = { source: 'L1', detail: fault };
            }
            // L2：传统视觉层（<50ms 预算域）
            if (this.opts.traditional?.isReady()) {
                const { els, fault } = await this.safeDetect(region, this.opts.traditional);
                if (els.length > 0) {
                    yield this.patch(region, els, 'L2');
                    continue; // 漏斗短路：L2 命中，绝不启动 L3
                }
                if (fault)
                    degradedFault = degradedFault ?? { source: 'L2', detail: fault };
            }
            // L3：语义层 —— 仅当中枢授权（ceiling='L3'）。工位无权自启（架构保证）
            if (req.funnelCeiling === 'L3' && this.opts.semantic?.isReady() && req.l3Reason) {
                const { els, fault } = await this.safeGround(region, this.opts.semantic, req.l3Reason);
                if (els.length > 0) {
                    yield this.patch(region, els, 'L3');
                    continue;
                }
                yield this.emptyPatch(region, 'L3', fault ?? 'semantic grounding returned no elements');
                continue;
            }
            // 三层皆空：诚实空补丁。fault 在场 = 源缺席/失败 ≠ 真空（决策工位两种空两种决策）
            yield degradedFault
                ? this.emptyPatch(region, degradedFault.source, degradedFault.detail)
                : this.emptyPatch(region, req.funnelCeiling === 'L3' ? 'L3' : 'L2', this.funnelFaultDetail());
        }
    }
    /** 源缺席/全失败的归因文案（诚实：说明哪层缺席，而非笼统 failed） */
    funnelFaultDetail() {
        const l1 = this.opts.structured?.isReady() ? 'ready' : 'absent';
        const l2 = this.opts.traditional?.isReady() ? 'ready' : 'absent';
        return `all funnel layers empty (L1:${l1}, L2:${l2})`;
    }
    patch(region, els, layer) {
        return {
            region,
            elements: els.map(e => ({
                source: layer === 'L1' ? 'L1-tree' : layer === 'L2' ? 'L2-ocr' : 'L3-vlm',
                role: e.role, name: e.name, state: e.state, rect: e.rect,
            })),
            funnelDepth: layer,
            capturedAt: Date.now(),
        };
    }
    emptyPatch(region, source, detail) {
        return {
            region, elements: [], funnelDepth: 'empty',
            fault: source ? { source, detail } : undefined,
            capturedAt: Date.now(),
        };
    }
    // 三源安全包装：源失败（契约违约抛错）⇒ 捕获为空集 + fault 归因 —— Never-reject 的上游防线。
    // 修复记录：早期实现把 fault 伪装成伪元素返回 —— 违反「fault 归因」契约
    // （失败空 ≠ 真空，两种空两种决策），已改为显式 fault 通道。
    async safeExtract(region, src) {
        try {
            return { els: await src.extract(region) };
        }
        catch (e) {
            return { els: [], fault: `L1 source fault: ${e?.message ?? 'extract failed'}` };
        }
    }
    async safeDetect(region, src) {
        try {
            return { els: await src.detect(region) };
        }
        catch (e) {
            return { els: [], fault: `L2 source fault: ${e?.message ?? 'detect failed'}` };
        }
    }
    async safeGround(region, src, q) {
        try {
            return { els: await src.ground(region, q) };
        }
        catch (e) {
            return { els: [], fault: `L3 source fault: ${e?.message ?? 'ground failed'}` };
        }
    }
}
/**
 * 决策规划工位默认实现 —— “唯一的大脑，唯一的花钱处”。
 * 输入信封：intent + ScenePatch[]（无截图字节 —— 像素永不进大脑）。
 * 输出契约：AtomicAction | NeedGrounding（JSON 判别收窄；解析失败 ⇒ NeedGrounding 诚实回退，
 * 绝不抛错毒化流水线 —— 重试语境由编排器管理）。
 */
export class DefaultDecisionStation {
    opts;
    // 显式字段赋值（非参数属性）：Node strip-only 运行时契约
    constructor(opts) {
        this.opts = opts;
    }
    /** 决策上下文 → 紧凑 prompt（Token 纪律：结构化元素表 ≤N 行，绝不内嵌散文背景） */
    buildPrompt(ctx, retryCtx) {
        if (this.opts.promptTemplate)
            return this.opts.promptTemplate(ctx, retryCtx);
        const scene = ctx.scene
            .map(p => `[${p.region.id}] ${p.funnelDepth}: ` +
            p.elements.map(e => `${e.role}(${e.name})@${e.rect.x.toFixed(2)},${e.rect.y.toFixed(2)}`).join(' '))
            .join('\n');
        const retry = retryCtx ? `\nLAST FAILURE [seq ${retryCtx.seq}] ${retryCtx.kind}: ${retryCtx.detail}` : '';
        return `GOAL: ${ctx.intent.goal}\nCRITERIA: ${ctx.intent.successCriteria ?? '(none)'}\nSCENE:\n${scene}${retry}\n` +
            'OUTPUT (strict JSON): {"kind":"action","action":{...},"rationale":"..."} or ' +
            '{"kind":"need-grounding","regionId":"...","question":"..."}';
    }
    async decide(env, retryCtx) {
        // P0-5：通道缺席 ⇒ NeedGrounding 诚实回退（信息缺口的最广义形态），绝不抛错
        if (!this.opts.chat) {
            return { kind: 'need-grounding', question: 'decision channel absent (cognition service not wired)' };
        }
        const prompt = this.buildPrompt(env.payload, retryCtx);
        let raw;
        try {
            raw = await this.opts.chat(prompt);
        }
        catch (e) {
            // 大模型通道故障：NeedGrounding 诚实回退（通道故障 = 信息缺口的最广义形态）
            return { kind: 'need-grounding', question: `decision channel fault: ${e?.message ?? 'unknown'}` };
        }
        return this.parse(raw);
    }
    /** 输出解析：JSON 判别收窄；任何解析失败 ⇒ NeedGrounding（运行层永不抛错） */
    parse(raw) {
        try {
            const m = JSON.stringify(JSON.parse(raw.trim())); // 语法校验
            const obj = JSON.parse(m);
            if (obj?.kind === 'need-grounding' && typeof obj.question === 'string') {
                return { kind: 'need-grounding', regionId: obj.regionId, question: obj.question.slice(0, 120) };
            }
            if (obj?.kind === 'action' && obj.action && typeof obj.action.kind === 'string') {
                // 解析边界执法（动作词汇表唯一）：未知 kind / 畸形 args 在此拒绝 ——
                // 否则模型输出经 as 断言直通宿主执行器，失败被误归因为 host-error
                if (!SANDBOX_ACTION_KINDS.has(obj.action.kind) ||
                    (obj.action.args !== undefined && (typeof obj.action.args !== 'object' || obj.action.args === null || Array.isArray(obj.action.args)))) {
                    return { kind: 'need-grounding', question: `decision action rejected (kind '${obj.action.kind}' outside vocabulary or malformed args)` };
                }
                const a = obj.action;
                return { ...a, rationale: String(obj.rationale ?? '').slice(0, 120) };
            }
        }
        catch { /* fallthrough to honest fallback */ }
        return { kind: 'need-grounding', question: 'decision output unparseable (non-JSON or missing discriminator)' };
    }
}
/**
 * 执行工位默认实现 —— “零模型肌肉”：AtomicAction 进，ExecutionResult 出。
 * 不思考为什么，不修正参数，不重试。D-5 预演优先（rehearseBeforeExecute）：
 * 预演 degraded/failed ⇒ gate-rejected 诚实上报（让大脑换方案，不让沙箱说谎）。
 * 本工位 tokenBudget 恒 0（信封类型层执法 —— 但工位仍如实计量，报告用）。
 */
export class DefaultExecutionStation {
    opts;
    // 显式字段赋值（非参数属性）：Node strip-only 运行时契约
    constructor(opts) {
        this.opts = opts;
    }
    async execute(env) {
        const { seq, action, intentRef } = env.payload;
        const startAt = Date.now();
        const base = { seq, latencyMs: 0, rehearsed: false, rehearsalChainId: undefined };
        // D-5 预演闸门（DRILL, THEN DELIVER —— 沙箱是彩排，宿主是首演）
        if (this.opts.rehearseBeforeExecute && this.opts.sandbox) {
            // J 纪元修正：chain id 编入 intentRef —— 全库 doctor verdict 的 subject
            // 即 chainId；旧 id `chain-exec-${seq}` 在并发 run 下必然撞号，回执无法
            // 精确配对。链 id 经 ExecutionResult.rehearsalChainId 回流 AttemptRecord，
            // 供 D-4 判决补写按 subject 精确匹配。
            const chainId = `chain-exec-${intentRef ? `${intentRef}-` : ''}${seq}`;
            try {
                const o = await this.opts.sandbox.rehearse({
                    id: chainId, actions: [action], origin: 'manual',
                });
                if (o.verdict === 'failed' || o.verdict === 'aborted') {
                    // 排练**硬失败/中止**（有明确反证据或预算耗尽）⇒ 拒绝交付
                    return {
                        ...base, latencyMs: Date.now() - startAt,
                        effectDetected: null,
                        rehearsalChainId: chainId,
                        failure: {
                            kind: o.verdict === 'aborted' ? 'timeout' : 'sandbox-degraded',
                            detail: `sandbox rehearsal ${o.verdict} (${o.reportPath})`,
                        },
                    };
                }
                // J 纪元修正：degraded = 排练跑完但验证层缺席（模拟器纪元常态，
                // D-5 引擎本纪元 verdict 恒 degraded —— 虚拟屏未实现是声明的留白）。
                // 「无证据」阻断**记忆固化**（D-5 侧 freeze-for-review），但不应阻断
                // 宿主执行 —— 旧实现 `verdict !== 'passed'` 一刀切，默认配置
                // （rehearseBeforeExecute=true 且 D-5 服务在场）下每个动作都死在
                // 预演闸门，流水线恒 failed。诚实形态：排练无法验证时照常交付，
                // 效果验证交宿主 settleAndVerify，rehearsed 不冒领（仅 passed 置真）。
                if (o.verdict === 'passed')
                    base.rehearsed = true;
                base.rehearsalChainId = chainId;
            }
            catch {
                // 预演通道故障 = 不可判 ⇒ 诚实降级继续（沙箱缺席不是宿主的错）——
                // rehearsed 标记缺席，效果验证交宿主 settleAndVerify
            }
        }
        // 宿主执行（通道缺席 = 开发者预览：诚实失败优于虚假成功 —— orchestrator Actor 未接线先例）
        if (!this.opts.host) {
            return {
                ...base, latencyMs: Date.now() - startAt, effectDetected: null,
                failure: { kind: 'host-error', detail: 'no host executor wired (developer preview)' },
            };
        }
        try {
            const r = await this.opts.host.execute(action);
            return { ...base, ...r, latencyMs: Date.now() - startAt, rehearsed: base.rehearsed };
        }
        catch (e) {
            return {
                ...base, latencyMs: Date.now() - startAt, effectDetected: null,
                failure: { kind: 'host-error', detail: `host executor threw (contract breach): ${e?.message ?? 'unknown'}` },
            };
        }
    }
}
