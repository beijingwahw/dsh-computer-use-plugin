import { defineTool } from '@deepseek-ai/dsh-tools';
import { system } from './system.js';
import { contextManager } from './contextManager.js';
import { uiMemory } from './uiMemory.js';
import { journal } from './journal.js';
import { skillLibrary } from './skillLibrary.js';
import { failureMemory } from './failureMemory.js';
import { telemetry } from './telemetry.js';
import { loadCheckpoint, saveCheckpoint } from './checkpoint.js';
import { disposeOcr } from './textReader.js';
import { swarm } from './swarm.js';
import { coordinator } from './subAgent.js';
import { shaper } from './environmentShaper.js';
import { quantum, UiExtractorWhitebox } from './quantumSense.js';
import { buildAllTools } from './tools/index.js';
import { registerAllGuards, updatePopupState, onLlmPreRequest } from './guards/index.js';
import { onToolPost } from './guards/hooks.js';
import { runOrchestrator, ACTOR_SYSTEM_PROMPT } from './orchestrator.js';
import { GOAL_MAX_CHARS, SUCCESS_CRITERIA_MAX_CHARS } from './orchestration/contracts.js';
import { emitCognitionPlanReady, mintIntentPlanReady, COGNITION_PLAN_READY_EVENT, } from './cognitionEvents.js';
import { wireDoctorVerdictChannel } from './doctorChannel.js';
export { Config } from './config.js';
// ─── 提示词三正交段（能力 / 流程 / 异常处理），各自独立演化，互不污染 ───
const VISION_GROUNDING_PROMPT = `
# 纯视觉 Agent 行为准则 (Vision-Only Grounding)

你拥有强大的多模态视觉能力。你不再依赖系统底层的 UI 树，而是完全通过"看"屏幕截图来理解世界。

## 视觉定位规范 (Visual Grounding)
当你需要与屏幕上的元素交互时，你必须：
1. **仔细观察**：在脑海中扫描截图，定位目标元素（如按钮、输入框、链接）。
2. **估算坐标**：估算该元素中心点的归一化坐标 (X, Y)，范围严格在 0.0 到 1.0 之间。
   - (0.0, 0.0) 代表屏幕左上角。
   - (1.0, 1.0) 代表屏幕右下角。
3. **精准输出**：在调用 \`click_mouse\` 工具时，直接传入你估算的归一化坐标。

## 思考格式 (Thought Process)
在采取行动前，你必须在思考中明确描述你看到的内容（坐标估算出声思考，给自己纠错的机会）：
"I can see a 'Submit' button located at the bottom right of the form. Its approximate center normalized coordinates are X=0.85, Y=0.90."
`;
const REACT_WORKFLOW_PROMPT = `
## 核心工作流 (ReAct Loop)
1. **OBSERVE**: 每次行动前，**必须**先调用 \`take_screenshot\` 查看当前屏幕状态。
2. **THINK**: 结合视觉定位规范，分析截图内容，明确当前 UI 状态。
3. **ACT**: 调用工具执行操作。坐标必须使用 0.0 到 1.0 的归一化数值。
4. **VERIFY**: 执行操作后，**必须**再次调用 \`take_screenshot\` 验证操作是否成功。

## 严格约束
- 永远不要在没有截图的情况下盲目操作。
- 每次只执行一个原子操作，等待系统反馈后再进行下一步。
- 如果连续两次操作失败，请停止并报告，不要陷入死循环。
`;
const POPUP_HANDLING_PROMPT = `
## 异常状态处理：弹窗与遮挡 (Popups & Overlays)
在每次 \`take_screenshot\` 后，你必须首先检查是否存在以下情况：
1. **模态对话框 (Modal/Dialog)**：如登录框、确认提示、Cookie 同意。
2. **意外遮挡**：目标元素被其他浮层挡住。

**处理原则**：
- 如果检测到弹窗，**必须优先处理弹窗**（如点击关闭按钮、接受 Cookie 或输入验证码），然后再继续原任务。
- 如果弹窗是意料之外的广告或无关提示，尝试寻找关闭按钮（如 'X', 'Close', 'Cancel'）将其关闭，或调用 \`dismiss_popup\` 强制重新分析。
- 处理完弹窗后，必须再次 \`take_screenshot\` 确认主界面已恢复。
`;
export const name = 'dsh-computer-use-plugin';
// 必需依赖：工具注册服务。可选服务（systemPrompt / llm / agents）在使用点用 ctx.get() 查询
export const inject = ['tools'];
/** 可选服务查询：systemPrompt 存在则注入提示词，不存在则优雅降级（行为准则已内置于工具描述与锚点） */
function tryInjectPrompt(ctx) {
    const sp = ctx.get('systemPrompt');
    if (!sp) {
        console.log('[Vision Plugin] systemPrompt 服务不可用，行为准则将依赖工具描述与状态锚点。');
        return;
    }
    sp.section({ name: 'vision-grounding-rules', content: VISION_GROUNDING_PROMPT });
    sp.section({ name: 'react-workflow-rules', content: REACT_WORKFLOW_PROMPT });
    sp.section({ name: 'popup-handling-rules', content: POPUP_HANDLING_PROMPT });
}
/** 可选服务查询：llm 存在且方法签名匹配时构造 ChatFn，否则返回 undefined（Planner 响亮降级） */
function resolvePlannerChat(ctx) {
    const llm = ctx.get('llm');
    if (llm && typeof llm.chat === 'function') {
        return async (systemPrompt, user) => {
            const res = await llm.chat([
                { role: 'system', content: systemPrompt },
                { role: 'user', content: user },
            ]);
            return typeof res === 'string' ? res : res?.content ?? JSON.stringify(res);
        };
    }
    return undefined;
}
export async function apply(ctx, config) {
    console.log('[Vision Plugin] Initializing Pure Vision Computer Use...');
    // 1. 配置注入系统层与上下文层（一切魔法数字由 cordis.yml 决定）
    system.configure(config);
    // B-6/B-7 创世纪参数随行：体积硬预算 + 遗像摘要开关（OCR 关时遗像自动退化为墓志铭）
    contextManager.configure(config.maxImageCount, config.maxContextImageKb, config.enableLegacySummary, config.legacySummaryMaxChars, config.enableOcr);
    // C-4 认知焦点引擎：显著度驱逐 + 钉扎预算 + 潜意识池（cordis.yml 决定，非代码常量）
    contextManager.configureFocus(config.salienceFocus, config.pinBudget, config.subconsciousCapacity, config.subconsciousMatchDistance);
    // C-5 群体智能：本地经验晶体恒开；endpoint 配置时启动联邦定时同步（非阻塞旁路）
    swarm.configure(config.swarmEndpoint, config.swarmSyncIntervalMs, config.crystalCapacity);
    swarm.start();
    // D-2 环境重塑：能力探测（永不抛错 —— 空能力集 = 诚实世界）+ 窗口委托注入。
    // switch_window 的债务清偿在此闭环：探测出 raise_window 能力才注入委托，否则保留降级路径。
    if (config.enableEnvironmentShaper) {
        shaper.configure(config.shaperAllowSystemWide, config.dryRun);
        await shaper.initialize();
        if (shaper.capabilities().has('raise_window')) {
            system.setWindowDelegate(async (keyword) => {
                const r = await shaper.apply({ kind: 'raise_window', titleHint: keyword });
                if (!r.ok)
                    throw new Error(r.reason ?? 'raise_window failed');
            });
        }
    }
    // D-3 量子感知：验证连续失败 ⇒ 叠加态（白盒标注烧入截图，回归纯视觉闭环）。
    // 白盒源仅在元素 ID 模式可用（UiExtractor 基础设施复用）；无源时失败计数诚实累积但模式不动。
    if (config.enableQuantumSense) {
        quantum.configure(config.degradeAfterFailures, config.quantumRestoreOnSuccess, config.quantumMaxNodes);
        if (config.enableElementIdMode)
            quantum.setProvider(new UiExtractorWhitebox());
    }
    uiMemory.configure(config.uiMemoryCapacity);
    telemetry.configure(config.enableTelemetry);
    // 技能库：配置后从磁盘载入 —— 上一个会话学会的技能在本会话直接可用
    skillLibrary.configure(config.enableSkillLibrary, config.skillLibraryPath);
    skillLibrary.load();
    // 认知快照恢复（第七轮）：UI 记忆/技能/失败记忆/日志链/指标 —— 崩溃后原地满血。
    // 防御性恢复：逐子系统独立还原，单点损坏不拖垮整档。
    if (config.checkpointPath) {
        const cp = loadCheckpoint(config.checkpointPath);
        if (cp.restored) {
            console.log(`[Checkpoint] Restored: ${cp.report.join('; ')}`);
        }
        else {
            console.log(`[Checkpoint] Fresh start (${cp.report[0]}).`);
        }
    }
    // 2. 注入 System Prompt（可选服务，优雅降级）
    tryInjectPrompt(ctx);
    // 3. 工厂模式挂载工具（含条件启用的混合模式工具）
    const tools = buildAllTools(config);
    tools.forEach(tool => ctx.tools.register(tool));
    console.log(`[Vision Plugin] Loaded ${tools.length} tools.`);
    // 4. 元工具：start_complex_task —— 一次调用展开为整个 Planner-Actor 子会话
    ctx.tools.register(defineTool({
        name: 'start_complex_task',
        description: 'Use this tool ONLY when the user gives a complex, multi-step request that requires planning. ' +
            'It will break the task down and execute it step-by-step.',
        parameters: {
            userRequest: {
                type: 'string',
                required: true,
                description: 'The complex user request.',
            },
            time_budget_sec: {
                type: 'number', required: false,
                description: 'Optional wall-clock budget in seconds. On expiry the orchestrator returns partial results with a [TIMEOUT] marker.',
            },
        },
        output: {
            schema: { type: 'string' },
            // 显式标注：defineTool 嵌套于 ctx.tools.register(...) 时 TS 上下文类型断链（推断限制，非契约缺口）
            render: (_args, value) => [{ type: 'text', text: value }],
        },
        async execute(args) {
            // Planner：llm 服务可用则真实拆解，否则 orchestrator 空计划守卫会响亮报告
            const chat = resolvePlannerChat(ctx);
            // Actor：TODO 接入 DSH agents 服务的子 Agent 循环。
            // 诚实失败优于虚假成功（地层教训：simulated success 是债）—— 返回 [FAILED]
            // 让编排器的 fail-fast 协议立即中止并如实上报。
            const actorFn = async (_task) => {
                void ACTOR_SYSTEM_PROMPT; // 接入 agents 服务时作为子 Agent 的 system prompt
                return '[FAILED] Actor loop is not wired to the DSH agents service yet (developer preview).';
            };
            // 技能归纳准备：任务起点打标 + 入口场景指纹（成功轨迹的切片边界）
            journal.markTaskStart(args.userRequest);
            const entryScene = contextManager.lastImageRecord()?.hash;
            const report = await runOrchestrator(args.userRequest, actorFn, chat, args.time_budget_sec ? args.time_budget_sec * 1000 : undefined);
            // 自动归纳（第五轮）：任务无失败标记且确有可重放轨迹 ⇒ 固化为技能。
            // 同一步骤序列重复出现时只强化既有技能的可靠度，不堆卡片。
            if (config.autoInduceSkills && config.enableSkillLibrary &&
                report && !report.includes('[FAILED]') && !report.includes('[TIMEOUT]') &&
                !report.startsWith('[Planner]')) {
                const skill = skillLibrary.induceFromJournal(args.userRequest, entryScene);
                if (skill) {
                    console.log(`[Skill] Induced #${skill.id} "${skill.name}" (${skill.steps.length} steps) from a successful task.`);
                }
            }
            return report;
        },
    }));
    // 4.5 元工具：delegate_to_pipeline —— D-1 → 流水线的交班面（P0-3 发射端补全）。
    //     此前 cognition/plan-ready 只有消费侧（D-5/D-6/D-7 三处接线）而发射端缺席 ——
    //     事件面是死通道。本工具是 D-1 主权的唯一交班出口：意图铸造 → 事件总线广播，
    //     D-7 隐知识流水线主消费（P1-3 仲裁），D-5 只认 chain 臂（意图臂静默让渡）。
    ctx.tools.register(defineTool({
        name: 'delegate_to_pipeline',
        description: 'DELEGATION — hand a goal to the autonomous execution pipeline instead of driving each step yourself. ' +
            'The intent is minted and announced on the event bus (cognition/plan-ready); the D-7 knowledge-enhanced ' +
            'pipeline is the primary consumer (P1-3 arbitration). Fire-and-forget: pipeline results arrive via ' +
            'knowledge/run-end events and a reportPath handle — NOT in this tool\'s return value. ' +
            'Use start_complex_task only when you must steer every subtask yourself.',
        parameters: {
            goal: {
                type: 'string', required: true,
                description: `Abstract goal (<=${GOAL_MAX_CHARS} chars, e.g. "sign in to the portal").`,
            },
            success_criteria: {
                type: 'string', required: false,
                description: `Verifiable completion criteria (<=${SUCCESS_CRITERIA_MAX_CHARS} chars).`,
            },
            budget_ms: {
                type: 'number', required: false,
                description: 'Optional wall-clock budget for the whole pipeline run.',
            },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
        },
        async execute(args) {
            const goal = String(args.goal ?? '').slice(0, GOAL_MAX_CHARS);
            if (!goal)
                return JSON.stringify({ status: 'FAILED', reason: 'goal is required' });
            const intent = mintIntentPlanReady({
                id: `intent-d1-${Date.now().toString(36)}`,
                goal,
                successCriteria: args.success_criteria ? String(args.success_criteria) : undefined,
                budgetMs: typeof args.budget_ms === 'number' ? args.budget_ms : undefined,
            });
            // 发射守卫：事件面故障是旁路义务（emitCognitionPlanReady 内部吞错）
            emitCognitionPlanReady(ctx, intent);
            // 紧凑交班回执（Token 纪律）：只回定位锚，执行证据走 reportPath
            return JSON.stringify({
                status: 'DELEGATED',
                intent_id: intent.id,
                channel: COGNITION_PLAN_READY_EVENT,
                primary_consumer: 'dsh.knowledge-pipeline (D-7)',
                note: 'fire-and-forget — watch knowledge/run-end events for the verdict',
            });
        },
    }));
    // 5. 挂载守卫（边界 / 熔断 / 审计 / 弹窗联动）
    registerAllGuards(ctx, config);
    console.log('[Vision Plugin] Security Guards activated.');
    // 5.2 D-4 判决回执通道（P0-4 发射端补全）：rehearsal-end → 自主诊断 → doctor/verdict。
    //     此前 doctor/verdict 三方消费侧（D-5 固化闸门 / D-6 判决索引 / D-7 验收结算门）
    //     全部接线而发射端缺席 —— 判决回执是死通道，D-5 固化只能永远冻结。
    wireDoctorVerdictChannel(ctx, config);
    // 5.5 D-1 子代理步数记账：复用 journal 同款 onToolPost 观察位 —— 对管线零新增侵入。
    //     无活跃代理时 chargeStep 直通返回（与 B/C 世代行为逐字节一致）。
    if (config.enableSubAgents) {
        coordinator.configure(config.maxSubAgents, config.agentRoundSteps);
        onToolPost(ctx, async (call, result, next) => {
            coordinator.chargeStep(call.name);
            return next(result);
        });
    }
    // 6. 上下文注入接线（原版游离的「最后一块拼图」，至此闭环）：
    //    无论截了多少图，每次请求发给模型的永远是滑动窗口内的图片 + 旧图文字占位符
    onLlmPreRequest(ctx, (payload) => {
        const managed = contextManager.getContextForModel();
        const images = managed.filter(block => block.type === 'image');
        if (images.length === 0 || !Array.isArray(payload.messages))
            return;
        // 注入为末位消息；具体挂载位（system/user/tool-result）以目标 DSH 版本的消息 schema 为准
        payload.messages.push({ role: 'user', content: managed });
    });
    // 7. 生命周期清理（DSH 规范：ctx.effect 必须返回清理函数）
    ctx.effect(() => {
        console.log('[Vision Plugin] Unloaded, cleaning up system resources...');
        return () => {
            // D-2 复原尽力而为（cleanup 不能 await）：restoreAll 异步启动；若与落盘竞速未及完成，
            // 残余义务随 checkpoint 交棒下次加载（restoreUndoLog 只认领未复原条目）——失败安全而非假装完成。
            if (config.enableEnvironmentShaper && config.shaperAutoRestore && shaper.undoDepth() > 0) {
                shaper.restoreAll().then(results => {
                    const failed = results.filter(r => !r.ok).length;
                    console.log(`[Shaper] Restored ${results.length - failed}/${results.length} change(s) on unload` +
                        (failed ? ` (${failed} duties survive in the undo log)` : ''));
                }).catch(e => console.warn(`[Shaper] restoreAll failed on unload: ${e.message}`));
            }
            // 认知快照先行（第七轮）：在任何内存清空前落盘 —— 崩溃恢复的最后防线
            if (config.checkpointPath) {
                const r = saveCheckpoint(config.checkpointPath);
                console.log(r.ok
                    ? `[Checkpoint] Saved atomically (${r.steps} chained entries).`
                    : `[Checkpoint] Save failed: ${r.error}`);
            }
            // C-5 群体智能：卸载前最后一次结晶 + 尽力上报（fire-and-forget，不阻塞卸载）
            swarm.syncNow();
            swarm.reset();
            telemetry.reset(); // 指标与生命周期同归
            contextManager.reset(); // 清空截图滑动窗口
            uiMemory.reset(); // 清空场景记忆（可选保留跨会话记忆：删除此行）
            journal.reset(); // 清空行动日志
            updatePopupState(false); // 复位弹窗传感状态
            skillLibrary.save(); // 技能落盘后仅清内存 —— 技能的寿命长于会话
            skillLibrary.reset();
            failureMemory.reset(); // 失败记忆与技能库对称：已随 checkpoint 持久化
            coordinator.reset(); // D-1 团队解散（报告已随 checkpoint 持久化）
            system.setWindowDelegate(null); // D-2 委托解除（下次加载按新探测重建）
            shaper.clearUndoLog(); // D-2 弃责记账（复原义务已在 restoreAll 执行或随 checkpoint 交棒）
            quantum.reset(); // D-3 感知相位归零（快照已随 checkpoint 交棒）
            void disposeOcr(); // 终止 OCR worker（语言数据有磁盘缓存，重载后即用）
        };
    });
    console.log('[Vision Plugin] Initialization complete! Ready for action.');
}
