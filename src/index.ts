// src/index.ts
// 融合重构版入口：八纪元精华的最终汇聚点。
// DSH 规范合规：Config schema / inject 依赖声明 / ctx.effect 返回清理函数 / 可选服务优雅降级。
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { Config } from './config';
import { system } from './system';
import { contextManager } from './contextManager';
import { uiMemory } from './uiMemory';
import { journal } from './journal';
import { buildAllTools } from './tools';
import { registerAllGuards, updatePopupState, onLlmPreRequest } from './guards';
import { runOrchestrator, ACTOR_SYSTEM_PROMPT, ChatFn as PlannerChatFn } from './orchestrator';

export { Config } from './config';
export type { Config } from './config';

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

export const name = 'computer-use-vision-plugin';

// 必需依赖：工具注册服务。可选服务（systemPrompt / llm / agents）在使用点用 ctx.get() 查询
export const inject = ['tools'];

/** 可选服务查询：systemPrompt 存在则注入提示词，不存在则优雅降级（行为准则已内置于工具描述与锚点） */
function tryInjectPrompt(ctx: Context): void {
  const sp = ctx.get('systemPrompt') as
    | { section: (o: { name: string; content: string }) => void }
    | undefined;
  if (!sp) {
    console.log('[Vision Plugin] systemPrompt 服务不可用，行为准则将依赖工具描述与状态锚点。');
    return;
  }
  sp.section({ name: 'vision-grounding-rules', content: VISION_GROUNDING_PROMPT });
  sp.section({ name: 'react-workflow-rules', content: REACT_WORKFLOW_PROMPT });
  sp.section({ name: 'popup-handling-rules', content: POPUP_HANDLING_PROMPT });
}

/** 可选服务查询：llm 存在且方法签名匹配时构造 ChatFn，否则返回 undefined（Planner 响亮降级） */
function resolvePlannerChat(ctx: Context): PlannerChatFn | undefined {
  const llm = ctx.get('llm') as any;
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

export function apply(ctx: Context, config: Config) {
  console.log('[Vision Plugin] Initializing Pure Vision Computer Use...');

  // 1. 配置注入系统层与上下文层（一切魔法数字由 cordis.yml 决定）
  system.configure(config);
  contextManager.configure(config.maxImageCount);
  uiMemory.configure(config.uiMemoryCapacity);

  // 2. 注入 System Prompt（可选服务，优雅降级）
  tryInjectPrompt(ctx);

  // 3. 工厂模式挂载工具（含条件启用的混合模式工具）
  const tools = buildAllTools(config);
  tools.forEach(tool => ctx.tools.register(tool));
  console.log(`[Vision Plugin] Loaded ${tools.length} tools.`);

  // 4. 元工具：start_complex_task —— 一次调用展开为整个 Planner-Actor 子会话
  ctx.tools.register(defineTool({
    name: 'start_complex_task',
    description:
      'Use this tool ONLY when the user gives a complex, multi-step request that requires planning. ' +
      'It will break the task down and execute it step-by-step.',
    parameters: {
      userRequest: {
        type: 'string',
        required: true,
        description: 'The complex user request.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      // Planner：llm 服务可用则真实拆解，否则 orchestrator 空计划守卫会响亮报告
      const chat = resolvePlannerChat(ctx);

      // Actor：TODO 接入 DSH agents 服务的子 Agent 循环。
      // 诚实失败优于虚假成功（地层教训：simulated success 是债）—— 返回 [FAILED]
      // 让编排器的 fail-fast 协议立即中止并如实上报。
      const actorFn = async (_task: string): Promise<string> => {
        void ACTOR_SYSTEM_PROMPT; // 接入 agents 服务时作为子 Agent 的 system prompt
        return '[FAILED] Actor loop is not wired to the DSH agents service yet (developer preview).';
      };

      return await runOrchestrator(args.userRequest, actorFn, chat);
    },
  }));

  // 5. 挂载守卫（边界 / 熔断 / 审计 / 弹窗联动）
  registerAllGuards(ctx, config);
  console.log('[Vision Plugin] Security Guards activated.');

  // 6. 上下文注入接线（原版游离的「最后一块拼图」，至此闭环）：
  //    无论截了多少图，每次请求发给模型的永远是滑动窗口内的图片 + 旧图文字占位符
  onLlmPreRequest(ctx, (payload) => {
    const managed = contextManager.getContextForModel();
    const images = managed.filter(block => block.type === 'image');
    if (images.length === 0 || !Array.isArray(payload.messages)) return;
    // 注入为末位消息；具体挂载位（system/user/tool-result）以目标 DSH 版本的消息 schema 为准
    payload.messages.push({ role: 'user', content: managed });
  });

  // 7. 生命周期清理（DSH 规范：ctx.effect 必须返回清理函数）
  ctx.effect(() => {
    console.log('[Vision Plugin] Unloaded, cleaning up system resources...');
    return () => {
      contextManager.reset();      // 清空截图滑动窗口
      uiMemory.reset();            // 清空场景记忆（可选保留跨会话记忆：删除此行）
      journal.reset();             // 清空行动日志
      updatePopupState(false);     // 复位弹窗传感状态
    };
  });

  console.log('[Vision Plugin] Initialization complete! Ready for action.');
}
