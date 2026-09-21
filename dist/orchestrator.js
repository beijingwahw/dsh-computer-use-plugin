// src/orchestrator.ts
// Planner-Actor 编排引擎。原版即干净可用，核心协议原样保留：
//   Actor 状态协议([SUCCESS]/[FAILED]) + fail-fast 短路 + 完整执行轨迹汇总。
// 融合增强：空计划守卫（Planner 不可用时响亮失败，而非静默零循环）。
import { planTasks } from './planner.js';
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
    const r = success ? 1 : 0;
    channelEma[channel] = channelEma[channel] + EMA_ALPHA * (r - channelEma[channel]);
}
export function actorChannelWeights() {
    return { ...channelEma };
}
/** W 纪元（W-1 隔离缝）：通道仲裁归零（Laplace 0.5/0.5）—— 测试隔离与卸载共用 */
export function resetChannelArbitration() {
    channelEma.agents = 0.5;
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
        const skillMatch = deps.matchSkill?.(task) ?? [];
        const bestSkill = skillMatch.find(m => m.reliability > 0.5 && m.steps.length > 0);
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
        const best = bestSkill ?? (deps.matchSkill?.(task) ?? []).find(m => m.reliability > 0.5 && m.steps.length > 0);
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
export async function runOrchestrator(userPrompt, actorFn, chat, timeBudgetMs) {
    const startAt = Date.now();
    // 1. 调用 Planner 拆解任务
    const subTasks = await planTasks(userPrompt, chat);
    // 空计划守卫：宁可响亮失败，不可静默空转
    if (subTasks.length === 0) {
        return '[Planner] 未能生成任务计划（检查 llm 服务与提示词），任务未执行。';
    }
    const results = [];
    // 2. 循环执行子任务
    for (const task of subTasks) {
        // 预算感知：在子任务边界检查时钟 —— 长任务的优雅降级，而非无限烧钱
        if (timeBudgetMs && Date.now() - startAt > timeBudgetMs) {
            const elapsed = Math.round((Date.now() - startAt) / 1000);
            results.push(`[TIMEOUT] Time budget of ${Math.round(timeBudgetMs / 1000)}s exhausted after ${elapsed}s. ` +
                `${subTasks.length - results.length} task(s) skipped.`);
            console.warn(`[Orchestrator] Time budget exhausted. Aborting with partial results.`);
            break;
        }
        console.log(`[Orchestrator] Executing Task #${task.id}: ${task.action}`);
        // 3. 将子任务交给 Actor 执行（依赖注入：编排器不关心 Actor 如何实现）
        const result = await actorFn(task.action);
        results.push(`Task #${task.id} (${task.action}): ${result}`);
        // 4. fail-fast 容错：后续步骤建立在失败步骤的前提上，中止是最理性的选择
        if (result.includes('[FAILED]') || result.includes('[TIMEOUT]')) {
            console.warn(`[Orchestrator] Task #${task.id} failed. Aborting plan.`);
            break;
        }
    }
    // 5. 汇总保留完整执行轨迹，每步可追溯
    return results.join('\n');
}
