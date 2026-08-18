# DSH Computer Use: 纯视觉桌面自动化 Agent 插件（融合重构版）

**赋予 DeepSeek Harness 真正的"眼睛"和"双手"！**

基于 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 构建的 Computer Use 插件。完全摒弃底层 UI 树依赖，采用**纯视觉 Grounding 架构**，让 AI 像人类一样通过"看"屏幕截图来理解和操作电脑。

## 核心特性

- **纯视觉 Grounding (Vision-Only)**：无需 Accessibility API，跨平台（Win/Mac/Linux），支持操作云端沙箱、RDP 甚至游戏界面
- **Set-of-Mark (SoM) 视觉辅助**：截图自动叠加网格、绿色鼠标准星与元素编号框，并在状态锚点中附带图例说明，消灭大模型坐标幻觉
- **智能上下文管理**：滑动窗口 + 图像降级为文字摘要 + `llm/pre-request` 注入，无论截多少图，模型永远只看到最新 N 张 + 历史文字占位符
- **状态锚点协议**：所有工具返回 `{status, state_anchor, next_step}` 三段式结构化反馈，`MANDATORY` 指令强制 ReAct 验证闭环
- **Planner-Actor 双层架构**：`start_complex_task` 元工具自动将长程任务拆解为原子操作并逐步执行，子任务失败即 fail-fast
- **企业级安全四守卫**：坐标边界校验、连续失败熔断、敏感操作审计、弹窗联动拦截（waterfall 短路语义）
- **全量桌面操作**：截图、点击、输入、滚动、快捷键、拖拽、标签页/窗口切换、弹窗处理
- **可插拔混合模式**：可选接入本地视觉模型（OmniParser 类）与无障碍 Provider 获得精确坐标

## 世界级突破：四大自研引擎

针对纯视觉 CUA Agent 的四个真实失败模式，各以一个引擎对症击破：

| 失败模式 | 引擎 | 机制 |
| --- | --- | --- |
| **盲点**：点击落空却以为成功 | 行为效果验证（`perceptualHash` + `actionVerifier`） | 动作前后各取一次整屏 dHash 指纹，汉明距离对比；相似度 > 0.97 判定疑似无效操作，锚点直接告警并引导 `zoom_inspect` 复位 |
| **坐标幻觉**：全屏估坐标误差大 | 二阶段定位（`zoom_inspect`） | 裁剪目标邻域放大重绘 2 倍密度细网格，锚点附带 `crop_bounds` 与映射公式 `full_x = x0 + fx*(x1-x0)`，微观定位精确映射回全屏 |
| **无跨会话记忆**：每次从零找按钮 | 场景式 UI 记忆（`remember_ui` / `recall_ui`） | 验证生效的点击自动沉淀为 landmark；自然语言召回（中英混合分词 + 重合系数 + 成功次数加成 + 时间衰减），召回值仅作先验、强制截图复核 |
| **不可复现**：成功路径无法固化 | 行动日志与重放（`journal` + `replay_actions`） | post-execute 观察者记录全部动作 JSONL（可落盘）；`replay_actions` 按 confirm 显式确认后逐步重放，成功操作序列即刻变成可执行宏 |

配套增强：

- **递进式恢复提示**：熔断守卫升级 —— 第 1 次失败注入「zoom 精定位」建议，第 2 次注入「换模态（键盘导航/滚动/记忆召回）」建议，第 3 次熔断冷静一轮
- **干跑模式**（`dryRun: true`）：动作类系统调用只记录不执行、截图保持真实 —— 提示词调试与演示的零风险沙箱
- **置信度自报**：`click_mouse.confidence < 0.6` 时主动建议先 `zoom_inspect`，把模型的不确定性显式化

## 第二轮优化创新：自适应感知闭环

四大引擎各自工作后，暴露出四个新的系统性损耗点，本轮以「指纹驱动」统一击破：

| 损耗点 | 机制 | 收益 |
| --- | --- | --- |
| **重复截图**：屏幕没变也全管线跑一遍 | 变化门控（change-gated screenshots）：截屏后先算 dHash，与窗口内最新指纹距离 ≤ 3 ⇒ 跳过压缩/入窗，返回 `unchanged` 锚点引用旧图（`force:true` 可强制刷新） | 稳态场景 Token 与 CPU 双降；模型被明确告知"屏幕未变，勿重截" |
| **动画期误判**：固定 400ms 后验证，把"还在动"当成"生效了" | 自适应稳定等待：轮询整屏指纹直到相邻两次距离 ≤ 1（屏幕稳定）或超时 settleMs×4 | 验证窗口自动对齐 UI 真实节奏，快页面提前返回，慢页面等够 |
| **原样重试死循环**：失败后同坐标再点、同文本再输 | 防死循环守卫：上次同签名动作已验证无效 ⇒ 立即拦截并注入换策略指引（zoom / recall / 键盘导航 / 滚动）；无效果信息时第 3 次重复拦截 | 幂等重试留余地，盲目复读必拦截 |
| **记忆跨场景误召回**：登录页记住的坐标被召回给设置页 | 场景指纹加成：landmark 记录形成时的整屏指纹；`recall_ui` 用当前窗口指纹做匹配，同场景（相似度 ≥ 0.9）+0.3 强加成 | "还是那个界面"时历史坐标才最可信，记忆从"迷信"变"情境化" |

配套：**Token 仪表盘** —— 每张截图锚点携带 `context_images: n/limit`，模型随时知道图片预算余量。

## 第三轮创新：预期锚定的区域级验证

前两轮的全屏指纹验证存在一个被掩盖的缺陷：**全屏 dHash 对局部小变化不敏感**——输入框出现光标、短文本上屏这类元素级反馈，在 64 位全屏指纹里只翻转几位，相似度仍 >0.99，会被误判为盲点。本轮以三个机制补全感知维度：

| 机制 | 设计 | 解决的问题 |
| --- | --- | --- |
| **双尺度验证** | `regionDhash`：以动作点为中心裁剪邻域单独取指纹。判定矩阵：全屏变 = `page-level`；仅区域变 = `element-level`（光标/高亮/文字）；都没变 = 盲点 | 局部反馈的误判：点击确实生效但画面只变了一小块 → 不再误报"点空了" |
| **焦点追踪**（`focusTracker`） | 点击/拖拽终点自动登记焦点（带 30s 过期）；`type_text` 无需模型传坐标，自动围绕焦点区域验证 | 工具间隐式上下文：输入的位置几乎总是上次点击的位置，文字上屏这类最微弱的变化获得专属放大器 |
| **预期锚定**（`expected_change`） | `click_mouse`/`type_text` 新参数：行动前声明预期视觉变化；锚点回显预期，`next_step` 强制要求截图核对，不符即视为部分失败 | 验证从"有没有变化"升级为"变化是否符合预期"——把模型的世界模型（world model）显式化并置于可核对地位 |
| **预算感知编排** | `start_complex_task` 新参数 `time_budget_sec`：子任务边界检查时钟，超时优雅中止并返回 `[TIMEOUT]` + 部分轨迹 | 长任务的无限烧钱问题：降级而非失控 |

锚点效果块示例（第三代）：

```json
"effect": {
  "detected": true,
  "scale": "element-level",
  "screen_similarity_pct": 99.8,
  "region_similarity_pct": 71.2
}
```

全屏几乎没变（99.8% 相似）但焦点区域剧变（71.2%）——典型的一次成功聚焦输入，旧版会误报盲点，新版精确识别为元素级效果。

## 工具列表

| 工具名称 | 描述 | 核心参数 |
| --- | --- | --- |
| `take_screenshot` | 截屏 + SoM 叠加 + 压缩 + 滑动窗口 + 弹窗传感 + 变化门控 | `region`, `force?` |
| `click_mouse` | 归一化坐标点击，内置 dHash 效果验证 + 自动记忆 | `x`, `y`, `button`, `confidence?`, `target_description?` |
| `type_text` | 焦点处输入文本，支持跨平台一键清空 | `text`, `clearFirst` |
| `scroll_page` | 四方向滚动 | `direction`, `amount` |
| `press_hotkey` | 组合键（键位白名单，防注入） | `keys` (数组) |
| `drag_mouse` | 拖拽（四拍时序：移→按→移→放） | `startX/Y`, `endX/Y` |
| `dismiss_popup` | 零副作用元工具：强制 ReAct 重新分析 | 无 |
| `switch_tab` / `switch_window` | 标签页 / 窗口切换（含降级路径） | `direction` / `titleKeyword` |
| `click_element` | 按 ID 点击（需开启元素模式，短时缓存防 ID 漂移） | `id` |
| `extract_ui_vision` | 本地视觉模型精确提取（可选） | 无 |
| `start_complex_task` | Planner-Actor 编排引擎 | `userRequest` |
| `zoom_inspect` | 区域裁剪放大 + 细网格，二阶段精定位 | `x`, `y`, `half_size?` |
| `remember_ui` / `recall_ui` | 场景式 UI 记忆写入 / 自然语言召回 | `description`,`x`,`y` / `query` |
| `replay_actions` | 重放日志中的动作序列（宏） | `confirm`, `from_step?`, `to_step?` |

## 快速开始

### 1. 环境准备

Node.js >= 18（推荐 22）与 pnpm。

### 2. 安装依赖

```bash
npm install @nut-tree/nut-js screenshot-desktop sharp
```

### 3. 配置 DSH 加载插件

在 `cordis.yml` 中引入本插件（**name 必须是入口文件的绝对路径**）：

```yaml
- insert:
    - id: computer-use-vision-plugin
      name: '/你的绝对路径/computer-use-vision-plugin/src/index.ts'
      config:
        mouseSpeed: 1500
        compressWidth: 1440
        jpegQuality: 75
        gridDivisions: 10
        maxImageCount: 3
        maxConsecutiveFailures: 3
        maxTextLength: 1000
        enableElementIdMode: false
        localVisionApi: ''
```

全部配置字段均有代码默认值，可按部署裁剪。

### 4. 启动 DSH

```bash
pnpm dsh web --patch ./cordis.yml
```

## 架构

```
index.ts (apply)
 ├─ systemPrompt 三正交段注入（定位规范 / ReAct 工作流 / 弹窗处理）
 ├─ buildAllTools(config)     工具工厂（混合模式按配置启用）
 ├─ start_complex_task        Planner-Actor 元工具
 ├─ registerAllGuards         边界 / 熔断 / 审计 / 弹窗联动
 ├─ onLlmPreRequest           滑动窗口图片注入模型请求
 └─ ctx.effect                生命周期清理

截图管线：captureScreen → 多屏感知 → SoM 叠加 → sharp 压缩 → 滑动窗口 → 弹窗传感 → 状态锚点
```

- **Context Manager**：单例滑动窗口，旧截图"掏空降级"为文字摘要，时间线保序，收缩对模型透明
- **Visual Overlay**：sharp 高性能合成 SVG 图层（网格 + 准星 + 元素框 + 自适应标签）
- **Orchestrator**：Planner 拆解 + Actor 执行 + `[SUCCESS]/[FAILED]` 字符串协议 + fail-fast
- **Guards**：waterfall 短路拦截；闭包状态随插件卸载自动消亡（符合 Cordis 注册即效果模型）

## 注意事项与安全声明

1. **系统权限**：macOS 需在"系统偏好设置 → 隐私与安全性"授予终端**屏幕录制**与**辅助功能**权限
2. **安全沙箱**：本插件默认直接控制宿主机。强烈建议在隔离环境（Docker、E2B 或虚拟机）中运行
3. **开发者预览**：DSH 核心 API 快速迭代中；工具管线事件名（`tools/pre-execute` 等）已集中在 `src/guards/hooks.ts` 单点收口，换版本只需改一处

## License

MIT
