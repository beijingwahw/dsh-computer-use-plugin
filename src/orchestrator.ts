// src/orchestrator.ts
// Planner-Actor 编排引擎。原版即干净可用，核心协议原样保留：
//   Actor 状态协议([SUCCESS]/[FAILED]) + fail-fast 短路 + 完整执行轨迹汇总。
// 融合增强：空计划守卫（Planner 不可用时响亮失败，而非静默零循环）。
import { planTasks, SubTask, ChatFn } from './planner';

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

export type ActorFn = (task: string) => Promise<string>;

export async function runOrchestrator(
  userPrompt: string,
  actorFn: ActorFn,
  chat?: ChatFn,
): Promise<string> {
  // 1. 调用 Planner 拆解任务
  const subTasks = await planTasks(userPrompt, chat);

  // 空计划守卫：宁可响亮失败，不可静默空转
  if (subTasks.length === 0) {
    return '[Planner] 未能生成任务计划（检查 llm 服务与提示词），任务未执行。';
  }

  const results: string[] = [];

  // 2. 循环执行子任务
  for (const task of subTasks) {
    console.log(`[Orchestrator] Executing Task #${task.id}: ${task.action}`);

    // 3. 将子任务交给 Actor 执行（依赖注入：编排器不关心 Actor 如何实现）
    const result = await actorFn(task.action);
    results.push(`Task #${task.id} (${task.action}): ${result}`);

    // 4. fail-fast 容错：后续步骤建立在失败步骤的前提上，中止是最理性的选择
    if (result.includes('[FAILED]')) {
      console.warn(`[Orchestrator] Task #${task.id} failed. Aborting plan.`);
      break;
    }
  }

  // 5. 汇总保留完整执行轨迹，每步可追溯
  return results.join('\n');
}
