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
/** 故障补丁铸造：扫描失败 ≠ 真空（两种空，两种决策 —— 对齐 D-6 ScenePatch.fault 契约） */
function faultPatches(grid, detail) {
    const capturedAt = Date.now();
    return gridRegions(grid).map(region => ({
        region,
        elements: [],
        funnelDepth: 'empty',
        fault: { source: 'L1', detail },
        capturedAt,
    }));
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
                name: w.text.slice(0, 20), // D-3 LABEL_MAX 先例
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
            // 网格分派（元素中心落区即入区 —— 'g{col}x{row}' 坐标同一性方言）
            const { cols, rows } = req.grid;
            const capturedAt = Date.now();
            const patches = [];
            for (let col = 0; col < cols; col++) {
                for (let row = 0; row < rows; row++) {
                    const region = {
                        id: `g${col}x${row}`,
                        x: col / cols, y: row / rows, width: 1 / cols, height: 1 / rows,
                    };
                    const inRegion = els.filter(e => e.rect.x + e.rect.width / 2 >= region.x &&
                        e.rect.x + e.rect.width / 2 <= region.x + region.width &&
                        e.rect.y + e.rect.height / 2 >= region.y &&
                        e.rect.y + e.rect.height / 2 <= region.y + region.height);
                    patches.push({
                        region,
                        elements: inRegion.map(e => ({ source: depth === 'L1' ? 'L1-tree' : 'L2-ocr', ...e })),
                        funnelDepth: inRegion.length > 0 ? depth : 'empty',
                        capturedAt,
                    });
                }
            }
            return patches;
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
