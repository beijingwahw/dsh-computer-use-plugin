// src/orchestrator.ts
// W6-2 结构性保留（doctor smell.over-engineering 登记）：D-2 编排器 —— ReAct 主循环/工具派发/上下文预算/恢复阶梯是单一认知循环的不可分相位，文件内分区注释即边界。
// Planner-Actor 编排引擎。原版即干净可用，核心协议原样保留：
//   Actor 状态协议([SUCCESS]/[FAILED]) + fail-fast 短路 + 完整执行轨迹汇总。
// 融合增强：空计划守卫（Planner 不可用时响亮失败，而非静默零循环）。
import { planTasks, topoSortSubTasks } from './planner.js';
import { kernelRegistry } from './kernel/registry.js';
// W3-4（G2 就绪层并行 + takeGranted 续跑接线）：全部只读消费 —— planner 冻结不改，
// subAgent 只增量（preseed/retire），approval 只消费 takeGranted，journal 只读步账。
import { journal, ACTION_TOOLS } from './journal.js';
import { approvalQueue } from './approval.js';
import { contextManager } from './contextManager.js';
import { coordinator } from './subAgent.js';
// W5-3（L3 跨机编排）：barrier 步注入缝 —— crossMachine 方言只读消费
//（crossMachine.ts 冻结不改；缺省缺席 = 现状逐字节一致）。
import { parseBarrierStep } from './crossMachine.js';
// Actor 人格纪律（来自「Actor 纪元」地层）：四步 ReAct 含独立的「排雷」步骤；
// 状态协议与 orchestrator 的 includes 嗅探隔着抽象层握手；反越权负面禁令锁死职责边界。
export const ACTOR_SYSTEM_PROMPT = `
# Role: 纯视觉桌面执行专家 (Vision-Only Actor)

## 核心使命
你是一个极其专注的执行者。你将收到一个具体的子任务，你必须完全依赖视觉（take_screenshot）来完成它。

## 工作流 (ReAct Loop)
1. **观察 (Observe)**：调用 \`take_screenshot\` 观察当前屏幕。
2. **排雷 (Clear)**：检查是否有弹窗遮挡，如果有，必须先处理弹窗。
3. **行动 (Act)**：思考并调用工具（\`click_mouse\`, \`type_text\` 等）执行当前子任务。
4. **验证 (Verify)**：再次调用 \`take_screenshot\` 验证子任务是否完成。

## 状态汇报规范 (极其重要)
你的输出必须且只能包含以下两种状态之一，以便 Planner 准确判断：
- 如果任务成功完成，你的最后一条回复必须包含：\`[SUCCESS] 任务已完成\`
- 如果任务失败、遇到无法解决的阻碍或超时，你的最后一条回复必须包含：\`[FAILED] 失败原因\`

## 绝对约束
- 绝对不要尝试规划下一步该做什么，只专注于当前被分配的任务！
- 永远不要在没有截图的情况下盲目操作。
- 每次只执行一个原子操作，等待系统反馈。
`;
// ── S 纪元（S-3 决策层）→ V 纪元审判日升格：通道 EMA 成功率仲裁 ──
// 法则史：乘性权重（w←w·exp(−η·loss)）+ 对称底权在「双方触底」时回到平权
// ⇒ 劣质通道周期性复辟（审判日仿真 110/151 vs 预言机 234）。根治 = EMA：
// 每通道维护成功率的指数滑动均值（α=0.15，Laplace 初始化 0.5），argmax
// （平权 ⇒ agents 优先 = 既有法）；**只更新被选通道**（未选冻结 —— 无损失
// 可见即无衰减，平权复辟物理消失）。审判日数字：EMA 226/300 vs always 104
// vs 预言机 234（p_agents=0.3/p_skill=0.8 —— 逼近预言机 96.6%）。
const channelEma = { agents: 0.5, skill: 0.5 };
const EMA_ALPHA = 0.15;
function hedgeUpdate(channel, success) {
    // 纪元 Ξ（Ξ-D 生产接线）：EMA 平滑系数读内核注册表 —— orch.emaAlpha（缺省
    // 0.15，区间 0.01..0.9）。min 护栏 Math.max(0.01,…) 防 0（α=0 会冻结学习）
    // 与 1（α=1 退化成逐次覆写，失去滑动语义）—— 区间外的病值就地夹正；
    // 未注册 ⇒ getOrDefault 回声字面量，仲裁行为逐字节不变；每次更新单次读取。
    const alpha = Math.min(0.9, Math.max(0.01, kernelRegistry.getOrDefault('orch.emaAlpha', EMA_ALPHA)));
    const r = success ? 1 : 0;
    channelEma[channel] = channelEma[channel] + alpha * (r - channelEma[channel]);
}
export function actorChannelWeights() {
    return { ...channelEma };
}
// ── P2b-1（缺陷修复，出处=全库遍历报告）：通道 EMA 的隔离边界立法 ──
// 缺陷：模块级 channelEma（S-3/V 纪元的 agents/skill 通道仲裁学习）此前无人
// 在插件卸载时归零 —— 宿主重载插件后 EMA 仍在，跨宿主实例泄漏，违背项目
// 自己的「W-1 单例隔离律」（一切有状态单例必有归零缝，卸载即回初值）。
// 边界立法（两半，缺一不可）：
//   · **跨任务保持**：runOrchestrator 之间绝不重置 —— EMA 的学习价值正在
//     任务间（上一个任务里 agents 通道连败的教训，要护着下一个任务的仲裁）；
//     只有插件卸载才清零。把 reset 埋进 runOrchestrator/任何任务入口都是
//     误杀学习记忆（本函数因此不挂在任何执行路径上）。
//   · **卸载归零**：插件卸载（dispose）时由 src/index.ts 的 ctx.effect 清理
//     函数调用（W-1 隔离律，与 resetApproval/uiMemory.reset 同律同点位）——
//     重载后的新实例从 Laplace 0.5/0.5 平权态重新学习，不继承幽灵权重。
// 测试隔离共用本缝（epochW/epochXi 先例）。
export function resetChannelArbitration() {
    channelEma.agents = 0.5; // Laplace 先验：无证据 ⇒ 平权
    channelEma.skill = 0.5;
}
function preferAgents() {
    return channelEma.agents >= channelEma.skill; // 平权 ⇒ agents（既有法）
}
export function createActor(deps = {}) {
    return async (task) => {
        // ① agents 服务原生通道（获取与调用双故障并入诚实 FAILED）
        let agentsRun = null;
        try {
            agentsRun = deps.getAgentsRun?.() ?? null;
        }
        catch (e) {
            return `[FAILED] agents service fault: ${e?.message ?? 'unknown'}`;
        }
        // S-3：技能通道可用性探测（匹配在场即可，不执行）
        // Y6 真机战果：旧判据只看 reliability>0.5 —— 一个"曾经成功过"但与子任务
        // 毫无文本/语义关联的技能（如 53 步的记事本宏顶替"关闭窗口"子任务）也
        // 能入列并整体重放。score 是 skillLibrary.match 的综合匹配分（文本相似
        // 为主 + 可靠度加成），低于 0.45 视为不相关 —— 可靠不等于相关。
        // 纪元 Ξ（Ξ-D 生产接线）：双门槛读内核注册表 —— orch.skillReliability
        //（可靠度门，缺省 0.5）/ orch.skillScore（相关度门，缺省 0.45）。未注册 ⇒
        // getOrDefault 回声字面量，探测判决逐字节不变；每次任务单次读取。
        const skillReliabilityGate = kernelRegistry.getOrDefault('orch.skillReliability', 0.5);
        const skillScoreGate = kernelRegistry.getOrDefault('orch.skillScore', 0.45);
        const skillViable = (m) => m.reliability > skillReliabilityGate && (m.score ?? 1) > skillScoreGate && m.steps.length > 0;
        const skillMatch = deps.matchSkill?.(task) ?? [];
        const bestSkill = skillMatch.find(skillViable);
        const bothViable = !!agentsRun && !!bestSkill;
        // Hedge 仲裁：双通道在场才比较权重；否则唯一通道直走（零回归）
        if (agentsRun && (!bothViable || preferAgents())) {
            try {
                const r = await agentsRun(task, ACTOR_SYSTEM_PROMPT);
                if (bothViable)
                    hedgeUpdate('agents', !r.startsWith('[FAILED]'));
                return r;
            }
            catch (e) {
                if (bothViable)
                    hedgeUpdate('agents', false);
                return `[FAILED] agents service fault: ${e?.message ?? 'unknown'}`;
            }
        }
        // ② 技能重放回退 / S-3 Hedge 接管：可靠度 > 0.5 的最佳匹配
        //（Laplace 0/0=0.5 不入场 —— 需真实验证背书）
        // bestSkill 即上面 find 的产物：确定性匹配下重调 matchSkill 只会得到同一
        // 结果并白付一次全库嵌入重算 —— 直接复用
        const best = bestSkill;
        if (best) {
            let failed = 0;
            for (const step of best.steps) {
                const r = await deps.replayStep?.(step.tool, step.args);
                if (r === undefined || r.includes('[FAILED]') || r.includes('"status": "FAILED"'))
                    failed++;
            }
            deps.recordOutcome?.(best.id, failed === 0);
            if (agentsRun)
                hedgeUpdate('skill', failed === 0); // S-3：仅双通道竞争语境记账
            return failed === 0
                ? `[SUCCESS] replayed skill ${best.id} (${best.steps.length} steps)`
                : `[FAILED] skill ${best.id} replay degraded (${failed}/${best.steps.length} steps failed — UI may have changed; re-verify)`;
        }
        // ③ 双缺席：诚实失败（零回归）
        return '[FAILED] no actors channel available (no agents service wired, no reliable skill match for this subtask).';
    };
}
/**
 * W3-4：takeGranted 续跑对账（纯函数、防御式绝不抛）。
 * stepCursor = 入队时的 journal 步账（总条数计量，与 W2-1 H4-7 同源）；当前账面
 * 与之对账决定重演窗口：
 *   · cursor 非有限/负 ⇒ no-cursor（无步账 —— 不猜）；
 *   · 账面为空/非有限 ⇒ empty-ledger（无 journal ⇒ 保守全量重规划）；
 *   · cursor > 账面 ⇒ cursor-ahead（账已轮转/换会话，证据丢失 —— 保守）；
 *   · 其余 ⇒ replay-window：windowSize = 账面 − cursor（恰为 0 = 干净续跑点）。
 */
export function reconcileResumeWindow(cursor, ledgerCount) {
    if (typeof cursor !== 'number' || !Number.isFinite(cursor) || cursor < 0) {
        return { mode: 'full-replan', reason: 'no-cursor' };
    }
    if (typeof ledgerCount !== 'number' || !Number.isFinite(ledgerCount) || ledgerCount <= 0) {
        return { mode: 'full-replan', reason: 'empty-ledger' };
    }
    const c = Math.floor(cursor);
    if (c > ledgerCount) {
        return { mode: 'full-replan', reason: 'cursor-ahead' };
    }
    return { mode: 'replay-window', cursor: c, windowSize: ledgerCount - c };
}
/**
 * W3-4 G2：Kahn 就绪层切分（纯函数、确定性）。
 * 消费 topoSortSubTasks 的无环前缀（planner 冻结 —— 分层在编排器侧自行完成）：
 * layer(t) = 1 + max(layer(dep))，未知 dep 边天然剔除（topo 已清洗）；同层内保持
 * 拓扑序（稳定输出 —— 测试可断言）。层内任务两两无依赖 ⇒ 可并行批。
 */
export function layerSubTasks(order) {
    const layerOf = new Map();
    const layers = [];
    for (const t of order) {
        if (!t || typeof t.id !== 'number')
            continue; // 防御：垃圾条目弃置
        let d = 0;
        for (const dep of Array.isArray(t.deps) ? t.deps : []) {
            const li = layerOf.get(dep);
            if (li !== undefined && li + 1 > d)
                d = li + 1;
        }
        layerOf.set(t.id, d);
        while (layers.length <= d)
            layers.push([]);
        layers[d].push(t);
    }
    return layers.filter(l => Array.isArray(l) && l.length > 0);
}
/** W3-4 G2：波次代理代号（任务 id → 团队名册 id；确定性可重放） */
function waveAgentId(taskId) {
    return `w3-${taskId}`;
}
/** W3-4 G2：就绪层流水线执行器 —— 读写分离软件流水线（深度 ≤2）。
 *
 * 节拍（对 active 队列逐代理）：
 *   ① 确注拍（depth≥2）：上一写落地后的新屏（seedBuffer，只读观察产物）预注给
 *      当前代理 —— 这就是「把动作后的新屏预注为下一 pending 代理的 seed 锚点」；
 *   ② 写拍：actorFn 派发必经 serializeWrite 通道；派发后**不立即 await** ——
 *      进入观察重叠窗口；
 *   ③ 重叠拍（depth≥2）：写在飞窗口内协调器只读观察共享屏，把在飞观察值预注给
 *      下一 pending 代理（单躯体上兑现观察重叠：读与写在时间上交叠，物理上
 *      读绝不触碰 IO）；随后才 await 写落地；
 *   ④ 收账拍：结果按串行契约行入账；写后新屏只读观察 → seedBuffer（下一轮①的
 *      权威值，覆盖③的投机值）；report 退场 + post 黑板共享发现。
 * 失败 ⇒ 停止后续派发（写已结构串行 ⇒ 无在飞写需要回收）；预算 ⇒ [TIMEOUT] 收场。
 */
async function runReadyLayerWaves(input) {
    const { layers, actorFn, write, observeSeed, team, startAt } = input;
    const depth = Math.min(2, Math.max(1, Math.floor(input.depth) || 2));
    const timeBudgetMs = typeof input.timeBudgetMs === 'number' && Number.isFinite(input.timeBudgetMs)
        ? input.timeBudgetMs : undefined;
    const lines = [];
    const completed = new Set();
    let failure = null;
    let timeoutLine = null;
    const total = layers.reduce((n, l) => n + l.length, 0);
    let executedCount = 0;
    const budgetGone = () => timeBudgetMs !== undefined && timeBudgetMs > 0 && Date.now() - startAt > timeBudgetMs;
    /** 单任务执行（写必经互斥通道 —— 单员层直行与波次代理执行同律） */
    const runOne = async (task) => {
        console.log(`[Orchestrator] Executing Task #${task.id}: ${task.action}`); // 与串行脊梁同款观测面
        // W5-3：barrier 步 —— 抵达即 arrive 等待（在写互斥通道**外**：等远端
        // 同侪不是物理写，持躯体锁等跨机同步 = 分布式死锁）；失败行自带
        // [FAILED] 方言，走既有失败脊梁（Σ-4 自愈/中止）。成功 ⇒ [Barrier] 审计行。
        if (input.barrier) {
            const b = await input.barrier(task);
            if (b) {
                if (!b.ok)
                    return b.line;
                lines.push(b.line);
            }
        }
        // 写：必经互斥通道（编排层结构串行 + 通道层互斥双保险）
        return write(() => actorFn(task.action));
    };
    /** 波次收尾：本波全部 spawn 代理（active + 让位未激活者）abort 退场 + retire 回收容量 */
    const settleWave = (agentIds) => {
        for (const id of agentIds) {
            try {
                team.abort(id, 'W3-4 wave settled (budget/failure)');
            }
            catch { /* 防御式 */ }
        }
        if (agentIds.length > 0) {
            try {
                team.retire(...agentIds);
            }
            catch { /* 防御式 */ }
        }
    };
    // 全程 spawn 名册：finally 兜底回收（labeled break / 熔断路径也不漏代理占坑）
    const spawnedAll = [];
    const cleanupAll = () => settleWave([...spawnedAll]);
    try {
        waveLoop: for (let li = 0; li < layers.length; li++) {
            const layer = layers[li];
            if (budgetGone()) {
                const elapsed = Math.round((Date.now() - startAt) / 1000);
                timeoutLine = `[TIMEOUT] Time budget of ${timeBudgetMs !== undefined ? Math.round(timeBudgetMs / 1000) : 0}s exhausted after ${elapsed}s. ` +
                    `${total - executedCount} task(s) skipped.`;
                console.warn('[Orchestrator] Time budget exhausted. Aborting with partial results.');
                break waveLoop;
            }
            // 单员层：零团队开销直行（仍走写通道；行序与串行逐字节同构）
            if (layer.length === 1) {
                const t = layer[0];
                const result = await runOne(t);
                executedCount++;
                completed.add(t.id);
                lines.push(`Task #${t.id} (${t.action}): ${result}`);
                if (result.includes('[FAILED]') || result.includes('[TIMEOUT]')) {
                    failure = { task: t, result };
                    break waveLoop;
                }
                continue;
            }
            // 多员层：团队波次（容量守限 3 —— 超额/撞租约让位者分波重试）
            let pendingTasks = [...layer];
            let guard = 0;
            const GUARD_MAX = layers.length + 4; // 防御：病态让位循环熔断（余部落回串行脊梁）
            while (pendingTasks.length > 0 && !failure && timeoutLine === null) {
                if (budgetGone()) {
                    const elapsed = Math.round((Date.now() - startAt) / 1000);
                    timeoutLine = `[TIMEOUT] Time budget of ${timeBudgetMs !== undefined ? Math.round(timeBudgetMs / 1000) : 0}s exhausted after ${elapsed}s. ` +
                        `${total - executedCount} task(s) skipped.`;
                    console.warn('[Orchestrator] Time budget exhausted. Aborting with partial results.');
                    break waveLoop;
                }
                if (++guard > GUARD_MAX)
                    break; // 熔断：余部由串行脊梁接管（runOrchestrator 重建队列）
                // ① spawn（守限3：超额静默拒绝 ⇒ 让位到下一波）
                const specs = pendingTasks.map(t => ({
                    id: waveAgentId(t.id),
                    role: 'W3-4 ready-layer executor',
                    objective: `执行子任务：${t.action}（就绪层并行波次；四步 ReAct，只汇报 [SUCCESS]/[FAILED]）`,
                    maxSteps: 10,
                }));
                let accepted = [];
                try {
                    accepted = team.spawn(specs) ?? [];
                }
                catch {
                    accepted = [];
                }
                const spawnedIds = accepted.map(a => a?.spec?.id).filter((id) => typeof id === 'string');
                spawnedAll.push(...spawnedIds);
                const active = [];
                const deferred = [];
                // ② 黑板 claim 防重复（W2-4 租约协议只读消费）：撞他人未过期租约 ⇒ 让位换目标
                for (const t of pendingTasks) {
                    const st = accepted.find(a => a?.spec?.id === waveAgentId(t.id));
                    if (!st) {
                        deferred.push(t);
                        continue;
                    } // spawn 拒收（容量满/同名重生）
                    let claim;
                    try {
                        claim = team.claim(st.spec.id, t.action);
                    }
                    catch {
                        deferred.push(t);
                        continue;
                    }
                    if (claim && claim.ok === true)
                        active.push({ task: t, agentId: st.spec.id });
                    else
                        deferred.push(t); // lease-conflict / inactive ⇒ 让位（持有者在做语义同构的事）
                }
                pendingTasks = [];
                // ③ 读写分离软件流水线（深度 ≤2；写结构串行，观察只读重叠）
                let seedBuffer = null; // 上一写落地后的新屏（权威 seed）
                for (let ai = 0; ai < active.length; ai++) {
                    const cur = active[ai];
                    if (budgetGone()) {
                        const elapsed = Math.round((Date.now() - startAt) / 1000);
                        timeoutLine = `[TIMEOUT] Time budget of ${timeBudgetMs !== undefined ? Math.round(timeBudgetMs / 1000) : 0}s exhausted after ${elapsed}s. ` +
                            `${total - executedCount} task(s) skipped.`;
                        console.warn('[Orchestrator] Time budget exhausted. Aborting with partial results.');
                        break waveLoop;
                    }
                    // 确注拍：动作后的新屏（上一写的只读观察产物）预注给当前代理
                    if (depth >= 2 && seedBuffer !== null) {
                        try {
                            team.preseed(cur.agentId, seedBuffer);
                        }
                        catch { /* 防御式 */ }
                    }
                    // 写拍：派发必经互斥通道；派发后先不 await —— 进入观察重叠窗口
                    const writeP = runOne(cur.task);
                    // 重叠拍：写在飞窗口内只读观察共享屏，预注给下一 pending 代理
                    if (depth >= 2 && ai + 1 < active.length) {
                        const overlap = safeObserve(observeSeed);
                        if (overlap !== null) {
                            try {
                                team.preseed(active[ai + 1].agentId, overlap);
                            }
                            catch { /* 防御式 */ }
                        }
                    }
                    const result = await writeP;
                    executedCount++;
                    completed.add(cur.task.id);
                    lines.push(`Task #${cur.task.id} (${cur.task.action}): ${result}`);
                    // 收账拍：写后新屏只读观察 → 权威 seedBuffer（深度 1 无下一消费者 ⇒ 零读开销）；
                    // report 退场；post 共享发现
                    if (depth >= 2)
                        seedBuffer = safeObserve(observeSeed);
                    const ok = !(result.includes('[FAILED]') || result.includes('[TIMEOUT]'));
                    try {
                        team.report(cur.agentId, result.slice(0, 2000), ok ? 0.9 : 0.1, ok ? 'completed' : 'failed');
                    }
                    catch { /* 防御式 */ }
                    if (ok && result.length > 0) {
                        try {
                            team.post(cur.agentId, cur.task.action, `done: ${result}`.slice(0, 120));
                        }
                        catch { /* 防御式 */ }
                    }
                    if (!ok) {
                        failure = { task: cur.task, result };
                        break; // 停止后续派发（写结构串行 ⇒ 无在飞写）
                    }
                }
                // ④ 波次收尾：本波全部 spawn 代理退场回收（让位/拒收者与冲突释放后的重试集合 = deferred）
                settleWave(spawnedIds);
                pendingTasks = deferred; // 容量释放后下一波重试（claim 租约已随 report 释放）
            }
            if (failure || timeoutLine !== null)
                break waveLoop;
        }
    }
    finally {
        cleanupAll(); // 兜底：任何退出路径（labeled break / 熔断 / 异常）代理不占坑
    }
    return { lines, completed, failure, timeoutLine };
}
/** W3-4：只读观察的安全包装（观察面异常 ⇒ null —— 观察是旁路，绝不炸流水线） */
function safeObserve(observe) {
    try {
        const v = observe();
        return typeof v === 'string' && v.trim() !== '' ? v : null;
    }
    catch {
        return null;
    }
}
// ─── ΝΩ-3（P1×2 · Planner 通道预算看门狗）───
//
// 病灶：runOrchestrator 两处 planTasks（首规划 + Σ-4 重规划）都是裸 await ——
// timeBudget 检查点全部在其后，一条挂起的 Planner 流把 start_complex_task
// 永久冻结（预算语义对冻结的计划相位形同虚设）。修法：计划相位（首规划 +
// 至多一次重规划**合计**）总墙钟 ≤ timeBudget 的 10%（下限钳 PLANNER_BUDGET_MIN_MS
// —— 极小 timeBudget 的 10% 派生只会保证失败，短任务不值得零计划；无进展
// 检测交给 planner.ts 的流层 idle 看门狗，总时长上限在此收口）。超限 ⇒
// 诚实失败归因 planner-budget（响亮报告，绝不静默、绝不裸抛）。
export const PLANNER_BUDGET_FRACTION = 0.1;
const PLANNER_BUDGET_MIN_MS = 5000;
/** planTasks 的预算包裹：deadline 内未落定 ⇒ tasks=[] + budgetTimeout=true；
 *  planTasks 自身的 reject 原样上抛（与裸 await 语义逐字节一致 —— 零回归），
 *  预算获胜后迟到的落定/拒绝不升级 unhandledRejection（静音收养）。
 *  ΤΕΛ-4（D-G16③）：增补第四参 planOpts 透传 planTasks（emitPlanReady/chain
 *  发射面——两条路径（无预算直通 / 预算 race）同律透传；缺席 = 逐字节旧调用）。 */
async function planTasksGuarded(userPrompt, chat, budgetMs, planOpts) {
    if (budgetMs === undefined || !Number.isFinite(budgetMs) || budgetMs <= 0) {
        return { tasks: await planTasks(userPrompt, chat, planOpts), budgetTimeout: false };
    }
    let handle;
    const gate = new Promise(resolve => {
        handle = setTimeout(() => resolve(null), budgetMs);
        handle?.unref?.(); // 预算门不阻进程退出
    });
    const planned = planTasks(userPrompt, chat, planOpts);
    planned.catch(() => { }); // 预算获胜后迟到拒绝静音（诚实归因已定，不再翻案）
    try {
        const raced = await Promise.race([planned, gate]);
        return raced === null ? { tasks: [], budgetTimeout: true } : { tasks: raced, budgetTimeout: false };
    }
    finally {
        if (handle !== undefined)
            clearTimeout(handle);
    }
}
export async function runOrchestrator(userPrompt, actorFn, chat, timeBudgetMs, opts) {
    const startAt = Date.now();
    // ΝΩ-3（b）：计划相位预算派生 —— 显式覆写 > timeBudget×10%（下限钳 5s）；
    // 绝对截止时刻供首规划 + 重规划合计消费（10% 是两段的总闸，不是各一段）
    const plannerBudgetMs = (() => {
        const explicit = opts?.plannerBudgetMs;
        if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit > 0)
            return explicit;
        if (typeof timeBudgetMs === 'number' && Number.isFinite(timeBudgetMs) && timeBudgetMs > 0) {
            return Math.max(PLANNER_BUDGET_MIN_MS, timeBudgetMs * PLANNER_BUDGET_FRACTION);
        }
        return undefined;
    })();
    const plannerDeadline = plannerBudgetMs !== undefined ? startAt + plannerBudgetMs : undefined;
    // 1. 调用 Planner 拆解任务（ΝΩ-3：预算包裹 —— 挂起的流不再能冻结整个工具调用）
    // ΤΕΛ-4（D-G16③）：chain 臂发射供源现取（首规划时刻任务窗恒空 ⇒ 空链诚实
    // 缺席；供源方抛错 ⇒ 该次不发射，绝不毒化计划主流程）
    const planOptsOf = () => {
        if (!opts?.planReady)
            return undefined;
        try {
            const chain = opts.planReady.chain ? opts.planReady.chain() : undefined;
            return chain ? { emitPlanReady: opts.planReady.emit, chain } : undefined;
        }
        catch {
            return undefined; // 供源面故障 = 该次不发射（旁路义务）
        }
    };
    const initialPlan = await planTasksGuarded(userPrompt, chat, plannerBudgetMs, planOptsOf());
    if (initialPlan.budgetTimeout) {
        return `[Planner] planner-budget exceeded：规划阶段超过 ${Math.round(plannerBudgetMs ?? 0)}ms 预算上限` +
            `（timeBudget 的 10% 派生），任务未执行。`;
    }
    const subTasks = initialPlan.tasks;
    // 空计划守卫：宁可响亮失败，不可静默空转
    if (subTasks.length === 0) {
        return '[Planner] 未能生成任务计划（检查 llm 服务与提示词），任务未执行。';
    }
    // Y-9 依赖 DAG：拓扑排序定执行序；环 ⇒ 拒绝执行（诚实上报，不静默截断）
    const topo = topoSortSubTasks(subTasks);
    if (topo.cycle) {
        return `[Planner] 子任务依赖图含环（tasks ${topo.cyclicIds.join(', ')}）——拒绝执行。请重新拆解并声明无环依赖。`;
    }
    const orderedSubTasks = topo.order;
    const results = [];
    // ── Σ-4 计划自愈（Epoch Σ：全军升维）──
    // 法则：子任务失败不再立即 fail-fast —— 若 chat 在场且尚未自愈过
    // （闭包守卫 replannedOnce：一次性 —— 防重规划风暴/失败循环无限烧钱），
    // 带失败上下文调 planTasks 重规划一次；得到非空且无环的新计划 ⇒
    // topoSortSubTasks 后**整体替换剩余未执行队列**（已执行子任务的 results
    // 轨迹保留；新计划 id 从既有最大 id 续编 —— LLM 重规划倾向从 1 重编号，
    // 不重编会与已执行轨迹的 Task #id 撞号），并在失败轨迹后追加 [Replan]
    // 审计行。自愈成功时该失败行的 [FAILED]/[TIMEOUT] 标记改写为 [RECOVERED]
    // （失败事实文本原样留痕 —— 报告是终局语义：任务已被新计划接管，不携带
    // 未解决的失败信号；下游消费者以 includes('[FAILED]') 判定任务终局）。
    // 自愈不可能（无 chat / 已用过一次 / 空计划 / 拓扑有环 / 再次失败）⇒
    // 原 fail-fast 语义一字不变（warn + break）。预算检查不因自愈豁免：
    // 重排队列仍受同一 timeBudget / 同一起点时钟约束。
    let replannedOnce = false;
    // Σ-4：固定 for-of 序列 → 可重铸队列（无自愈路径下遍历语义与旧循环严格一致）
    const queue = [...orderedSubTasks];
    let idCounter = Math.max(0, ...orderedSubTasks.map(t => t.id));
    // Σ-4 自愈的共用闭包（W3-4 抽取：串行脊梁与并行预取路径同一血脉，语义一字不变；
    // keepUpto = 队列保留前缀长 —— 串行传 qi+1（失败任务占位），并行传 0（余部整体替换））
    const replanAfterFailure = async (task, result, keepUpto) => {
        if (chat && !replannedOnce) {
            replannedOnce = true; // 闭包守卫先记账：自愈机会只有一次（含失败的自愈尝试）
            const replanPrompt = userPrompt
                + '\n以下子任务已失败，请重新规划剩余步骤避开失败路径：\n'
                + task.action
                + '\n失败结果：' + result.slice(0, 500);
            // ΝΩ-3：重规划同受计划相位总预算约束（共用截止时刻 —— 10% 是首规划+
            // 重规划的合计上限）；余额耗尽 ⇒ 不再发起调用，直接按预算超限落回
            // fail-fast（tasks=[] 与空计划同路，诚实归因由 warn 留痕）
            const replanLeft = plannerDeadline !== undefined ? plannerDeadline - Date.now() : undefined;
            // ΤΕΛ-4（D-G16③）：重规划同律透传发射面——chain 供源此刻现取（journal
            // 已含本任务已执行步 ⇒ 供源方可派生成功前缀进排练场）
            const replanOutcome = replanLeft !== undefined && replanLeft <= 0
                ? { tasks: [], budgetTimeout: true }
                : await planTasksGuarded(replanPrompt, chat, replanLeft, planOptsOf());
            if (replanOutcome.budgetTimeout) {
                console.warn('[Orchestrator] Replan exceeded planner budget (planner-budget) — falling back to fail-fast.');
            }
            const replanned = replanOutcome.tasks;
            const reTopo = replanned.length > 0 ? topoSortSubTasks(replanned) : null;
            if (reTopo && !reTopo.cycle) {
                const remaining = reTopo.order.map(t => ({ ...t, id: ++idCounter }));
                queue.length = keepUpto; // 替换剩余未执行队列 —— 新计划从头执行
                queue.push(...remaining);
                results[results.length - 1] = results[results.length - 1]
                    .replace('[FAILED]', '[RECOVERED]')
                    .replace('[TIMEOUT]', '[RECOVERED]');
                results.push(`[Replan] 子任务失败，已重规划（剩余 ${remaining.length} 步）`);
                console.warn(`[Orchestrator] Task #${task.id} failed. Replanned once (${remaining.length} step(s) ahead).`);
                return true;
            }
            // 重规划失败（空计划 / 拓扑有环）⇒ 落回原 fail-fast（诚实）
            console.warn(`[Orchestrator] Replan unavailable (empty or cyclic plan). Aborting plan.`);
        }
        console.warn(`[Orchestrator] Task #${task.id} failed. Aborting plan.`);
        return false;
    };
    // ── W3-4：takeGranted 续跑接线（重入消费 —— W2-1 H4 遗留的执行侧闭环）──
    // 法则：runOrchestrator 每次重入先消费至多一条已批队列条目（防御式：消费面
    // 异常 ⇒ null 静默降级为无续跑）；以 entry.stepCursor 对账 journal 步账 ——
    // 重演窗口内只重演 cursor 之后的可重放动作步骤（已暂存的可逆部分不重复执行）；
    // 对账不可能（无 cursor / 无账 / cursor 越界）⇒ 保守全量重规划（= 现状整计划
    // 从头执行 —— 恰是串行现状语义，只是多一行 [Resume] 审计）。已授予的不可逆
    // 动作以续跑子任务形式先行执行（描述携带执行令牌 —— 物理消费在工具层，
    // V 纪元验收式 consume 照常执法；W1-2 amendment 经 applyAmendment 同点消费）。
    const granted = (() => {
        try {
            const take = opts?.takeGranted ?? approvalQueue.takeGranted.bind(approvalQueue);
            const g = take();
            return g && typeof g === 'object' && g.entry && typeof g.entry === 'object' ? g : null;
        }
        catch {
            return null; // 消费面异常 = 无续跑（绝不炸主流程）
        }
    })();
    if (granted) {
        const entry = granted.entry;
        const ledgerCount = (() => {
            try {
                const c = opts?.ledgerCount ? opts.ledgerCount() : journal.list(false).length;
                return typeof c === 'number' && Number.isFinite(c) ? c : 0;
            }
            catch {
                return 0;
            }
        })();
        const rec = reconcileResumeWindow(entry.stepCursor, ledgerCount);
        const entryId = typeof entry.id === 'string' && entry.id !== '' ? entry.id : 'unknown';
        const grantedDesc = typeof entry.description === 'string' ? entry.description.slice(0, 200) : '';
        results.push(`[Resume] 已批队列条目 ${entryId} 续跑接入（对账：${rec.mode}` +
            (rec.mode === 'replay-window'
                ? `，cursor=${rec.cursor}，账面=${ledgerCount}，重演窗口 ${rec.windowSize} 步）`
                : `，成因 ${rec.reason}，账面=${ledgerCount} —— 保守全量重规划）`));
        // ① 已授予的不可逆动作先行（写在最前 —— 它本来就是被打断的原位步骤）；
        //    令牌随描述下发：actor 凭令牌携行执行（审批协议的既有流转面）。
        const resumeAction = `执行已批准动作：${grantedDesc}` +
            `（审批执行令牌 ${granted.executionToken} 已授予，验收通过即焚毁）`;
        const resumeTask = { id: ++idCounter, action: resumeAction, deps: [] };
        const resumeResult = await (async () => {
            try {
                return await actorFn(resumeAction);
            }
            catch (e) {
                return `[FAILED] resumed action fault: ${e instanceof Error ? e.message : String(e)}`;
            }
        })();
        results.push(`Task #${resumeTask.id} (执行已批准动作：${grantedDesc}): ${resumeResult}`);
        if (resumeResult.includes('[FAILED]') || resumeResult.includes('[TIMEOUT]')) {
            // 续跑动作失败 ⇒ 与串行同律的自愈/中止脊梁接管（queue 尚为全量计划）
            if (!(await replanAfterFailure(resumeTask, resumeResult, 0))) {
                return results.join('\n');
            }
        }
        // ② 重演窗口：只重演 cursor 之后的可重放动作步骤（防御式 —— 重放通道缺席
        //    或窗口为空 ⇒ 零重放，保守交给下方全量计划 = 保守全量重规划的执行面）
        if (rec.mode === 'replay-window' && rec.windowSize > 0 && typeof opts?.replayStep === 'function') {
            let windowEntries = [];
            try {
                windowEntries = opts.ledgerSlice
                    ? opts.ledgerSlice(rec.cursor)
                    : journal.list(false).slice(rec.cursor).filter(e => ACTION_TOOLS.includes(e.tool));
            }
            catch {
                windowEntries = [];
            }
            for (const e of windowEntries) {
                if (!e || typeof e.tool !== 'string')
                    continue;
                try {
                    const r = await opts.replayStep(e.tool, e.args ?? {});
                    results.push(`[Resume] replay ${e.tool}: ${typeof r === 'string' ? r.slice(0, 120) : 'done'}`);
                }
                catch (err) {
                    results.push(`[Resume] replay ${e.tool} failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200));
                }
            }
        }
    }
    // ── W3-4 G2：就绪层并行预取（显式 opt-in —— 缺省 false 时本块整体跳过，
    //    串行脊梁逐字节走旧路）──
    const layers = layerSubTasks(orderedSubTasks);
    const team = opts?.team ?? coordinator;
    // ── W5-3（L3 跨机编排）：crossMachine 注入缝的本地接线（缺省缺席 = 零行为差）──
    // barrierOf：步骤 → barrier 声明（注入覆写优先，缺省 = 文本方言解析。
    // ΑΩ-R34：旧注释误写 barrierFor —— 注入字段实名是 cross.barrierOf）；
    // awaitCrossBarrier：抵达即 arrive 等待 —— 成功 ⇒ [Barrier] 审计行（放行
    // 事实：seq/名册/耗时），失败 ⇒ [FAILED] 行（reason + 已见名册，诚实不臆造）。
    // 全程防御式（注入面异常 ⇒ null = 无 barrier 步，绝不炸编排主链）。
    const cross = opts?.crossMachine;
    const awaitCrossBarrier = async (task) => {
        if (!cross || typeof cross.arriveAndWait !== 'function')
            return null;
        let b = null;
        try {
            // 缺省声明解析 = 文本方言（action 内嵌 barrier:<name>#<n>）；注入覆写同签名
            const resolve = cross.barrierOf ?? ((t) => parseBarrierStep(typeof t?.action === 'string' ? t.action : ''));
            b = resolve(task);
        }
        catch {
            return null; // 声明面异常 = 无 barrier 步（防御式）
        }
        if (!b || typeof b.name !== 'string' || b.name === '' || typeof b.n !== 'number')
            return null;
        let r;
        try {
            r = await cross.arriveAndWait(b.name, b.n);
        }
        catch (e) {
            return { ok: false, line: `[FAILED] cross-barrier ${b.name}#${b.n} fault: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300) };
        }
        if (r.ok) {
            return {
                ok: true,
                line: `[Barrier] ${b.name}#${b.n} passed (seq ${r.seq}, peers ${(Array.isArray(r.peers) ? r.peers : []).join(',')}, ${r.waitedMs}ms)`,
            };
        }
        const seen = Array.isArray(r.arrived) && r.arrived.length > 0 ? `, peers seen: ${r.arrived.join(',')}` : '';
        const exp = typeof r.expected === 'number' ? ` (expected ${r.expected})` : '';
        return { ok: false, line: `[FAILED] cross-barrier ${b.name}#${b.n} ${r.reason}${exp} after ${r.waitedMs}ms${seen}` };
    };
    const useParallel = opts?.parallel === true
        && orderedSubTasks.length > 1
        && layers.some(l => l.length > 1)
        && (() => { try {
            return team.isActive() !== true;
        }
        catch {
            return false;
        } })(); // 团队余量：在役外来会话 ⇒ 退化为串行
    if (useParallel) {
        const write = opts?.serializeWrite ?? ((fn) => fn());
        const observeSeed = opts?.observeSeed ?? (() => {
            try {
                return contextManager.lastImageRecord()?.hash ?? null;
            }
            catch {
                return null;
            }
        });
        const depth = typeof opts?.pipelineDepth === 'number' && Number.isFinite(opts.pipelineDepth)
            ? opts.pipelineDepth : 2;
        const pre = await runReadyLayerWaves({
            layers, actorFn, write, observeSeed, team,
            depth, startAt, timeBudgetMs,
            ...(cross ? { barrier: awaitCrossBarrier } : {}), // W5-3：并行波内 barrier 步（写通道之外等待）
        });
        results.push(...pre.lines);
        // 队列重铸 = 未执行余部（波次异常熔断/失败截断的兜底都从这里落回串行脊梁）
        queue.length = 0;
        queue.push(...orderedSubTasks.filter(t => !pre.completed.has(t.id)));
        if (pre.timeoutLine !== null) {
            results.push(pre.timeoutLine);
            return results.join('\n');
        }
        if (pre.failure) {
            // 波次失败 ⇒ Σ-4 同律自愈；自愈后余部由串行脊梁接管（并行快路径退役 —— 诚实降级）
            if (!(await replanAfterFailure(pre.failure.task, pre.failure.result, 0))) {
                return results.join('\n');
            }
        }
    }
    // 2. 循环执行子任务
    for (let qi = 0; qi < queue.length; qi++) {
        const task = queue[qi];
        // 预算感知：在子任务边界检查时钟 —— 长任务的优雅降级，而非无限烧钱
        //（Σ-4：跳过数按当前队列计 —— 零重规划路径下与旧式 subTasks.length -
        // results.length 严格等值：检查点前每轮恰推入一行任务轨迹）
        if (timeBudgetMs && Date.now() - startAt > timeBudgetMs) {
            const elapsed = Math.round((Date.now() - startAt) / 1000);
            results.push(`[TIMEOUT] Time budget of ${Math.round(timeBudgetMs / 1000)}s exhausted after ${elapsed}s. ` +
                `${queue.length - qi} task(s) skipped.`);
            console.warn(`[Orchestrator] Time budget exhausted. Aborting with partial results.`);
            break;
        }
        console.log(`[Orchestrator] Executing Task #${task.id}: ${task.action}`);
        // W5-3（L3 跨机编排）：barrier 步 —— 到达 rendezvous 点即 arrive 等待
        //（写通道之外的跨机同步）；放行 ⇒ [Barrier] 审计行先行，失败 ⇒ [FAILED]
        // 行走 Σ-4 同律自愈/fail-fast（不执行该步骤的物理部分 —— 前提未成立）。
        if (cross) {
            const bLine = await awaitCrossBarrier(task);
            if (bLine) {
                results.push(bLine.line);
                if (!bLine.ok) {
                    if (await replanAfterFailure(task, bLine.line, qi + 1)) {
                        continue;
                    }
                    break;
                }
            }
        }
        // 3. 将子任务交给 Actor 执行（依赖注入：编排器不关心 Actor 如何实现）
        const result = await actorFn(task.action);
        results.push(`Task #${task.id} (${task.action}): ${result}`);
        // 4. fail-fast 容错：后续步骤建立在失败步骤的前提上，中止是最理性的选择
        //    （Σ-4：中止前先给一次带失败上下文的重规划机会 —— 见上方法则）
        if (result.includes('[FAILED]') || result.includes('[TIMEOUT]')) {
            if (await replanAfterFailure(task, result, qi + 1)) {
                continue;
            }
            break;
        }
    }
    // 5. 汇总保留完整执行轨迹，每步可追溯
    return results.join('\n');
}
