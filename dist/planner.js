// src/planner.ts
// Planner：将复杂需求拆解为原子子任务。
// 保留原版提示词的全部规则（含「单个屏幕内完成」—— 教规划器体谅执行器的极限）。
// 融合修复：原版签名无 ctx 却想调 ctx.llm -> 改为 ChatFn 依赖注入；
//           「需增加容错处理」的 TODO -> 实现围栏剥离 + 区间截取的 JSON 容错解析。
export const PLANNER_SYSTEM_PROMPT = `
# Role: 任务规划专家 (Task Planner)

## 目标
你是一个高级任务规划器。你的任务是将用户的复杂需求拆解为一系列简单的、可执行的原子任务（Subtasks）。

## 规则
1. 你只能输出合法的 JSON 数组格式，不要包含任何其他解释性文本。
2. 每个子任务必须是一个独立的、可以在单个屏幕内完成的动作。
3. 如果任务需要跨应用，请在子任务中明确说明。

## 输出格式
[
  {"id": 1, "action": "打开 Chrome 浏览器并导航到 GitHub 首页"},
  {"id": 2, "action": "在搜索框中输入 'DeepSeek Harness' 并点击搜索"},
  {"id": 3, "action": "点击第一个搜索结果链接"}
]
`;
export async function planTasks(userPrompt, chat) {
    if (!chat) {
        console.warn('[Planner] LLM 服务不可用，无法拆解任务');
        return [];
    }
    const raw = await chat(PLANNER_SYSTEM_PROMPT, userPrompt);
    // 容错解析：剥离 markdown 代码围栏，截取首个 '[' 到最后一个 ']' 的区间
    const text = raw.replace(/```(json)?/g, '').trim();
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start === -1 || end === -1 || end <= start)
        return [];
    try {
        const parsed = JSON.parse(text.slice(start, end + 1));
        if (!Array.isArray(parsed))
            return [];
        return parsed.filter((t) => t && typeof t.action === 'string');
    }
    catch {
        return [];
    }
}
