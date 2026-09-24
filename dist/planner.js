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
4. 用 "deps" 声明子任务间的依赖（必须先完成的子任务 id 列表）；无依赖用空数组。
   只声明真正的先序关系 —— 编号顺序本身不构成依赖。

## 输出格式
[
  {"id": 1, "action": "打开 Chrome 浏览器并导航到 GitHub 首页", "deps": []},
  {"id": 2, "action": "在搜索框中输入 'DeepSeek Harness' 并点击搜索", "deps": [1]},
  {"id": 3, "action": "点击第一个搜索结果链接", "deps": [2]}
]
`;
export function topoSortSubTasks(tasks) {
    const byId = new Map(tasks.map(t => [t.id, t]));
    // 依赖清洗：指向不存在 id 的边剔除（Planner 幻觉防御）
    const depsOf = new Map();
    for (const t of tasks) {
        depsOf.set(t.id, (t.deps ?? []).filter(d => byId.has(d) && d !== t.id));
    }
    const indegree = new Map();
    for (const t of tasks)
        indegree.set(t.id, (depsOf.get(t.id) ?? []).length);
    const ready = tasks.filter(t => (indegree.get(t.id) ?? 0) === 0).map(t => t.id);
    // 稳定性：同入度层按原编号排序（确定性输出 —— 测试可断言）
    ready.sort((a, b) => a - b);
    const order = [];
    const done = new Set();
    while (ready.length) {
        const id = ready.shift();
        const t = byId.get(id);
        order.push(t);
        done.add(id);
        for (const u of tasks) {
            const du = depsOf.get(u.id) ?? [];
            if (du.includes(id) && !done.has(u.id)) {
                const remaining = du.filter(d => !done.has(d));
                indegree.set(u.id, remaining.length);
                if (remaining.length === 0) {
                    ready.push(u.id);
                    ready.sort((a, b) => a - b);
                }
            }
        }
    }
    const cyclicIds = tasks.filter(t => !done.has(t.id)).map(t => t.id);
    return { order, cycle: cyclicIds.length > 0, cyclicIds };
}
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
    if (start === -1 || end === -1 || end <= start) {
        console.warn(`[Planner] raw output has no JSON array (len=${raw.length}): ${raw.slice(0, 200)}`);
        return [];
    }
    try {
        const parsed = JSON.parse(text.slice(start, end + 1));
        if (!Array.isArray(parsed))
            return [];
        // J 纪元修正：LLM 漏输出 id 时按序号补齐 —— 旧 filter 不校验 id，
        // orchestrator 会打出 "Task #undefined"（下游 results 格式化失真）。
        return parsed
            .filter((t) => t && typeof t.action === 'string')
            .map((t, i) => ({
            ...t,
            id: typeof t.id === 'number' ? t.id : i + 1,
            // Y-9：deps 归一为数字数组（字符串/缺失容错），未知 id 由 topo 边清洗剔除
            deps: Array.isArray(t.deps)
                ? t.deps.filter((d) => typeof d === 'number').map((d) => d)
                : undefined,
        }));
    }
    catch {
        return [];
    }
}
