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

## 工具列表

| 工具名称 | 描述 | 核心参数 |
| --- | --- | --- |
| `take_screenshot` | 截屏 + SoM 网格/准星叠加 + 压缩 + 滑动窗口 + 弹窗传感 | `region` |
| `click_mouse` | 归一化坐标点击，返回三坐标换算锚点 | `x`, `y`, `button` |
| `type_text` | 焦点处输入文本，支持跨平台一键清空 | `text`, `clearFirst` |
| `scroll_page` | 四方向滚动 | `direction`, `amount` |
| `press_hotkey` | 组合键（键位白名单，防注入） | `keys` (数组) |
| `drag_mouse` | 拖拽（四拍时序：移→按→移→放） | `startX/Y`, `endX/Y` |
| `dismiss_popup` | 零副作用元工具：强制 ReAct 重新分析 | 无 |
| `switch_tab` / `switch_window` | 标签页 / 窗口切换（含降级路径） | `direction` / `titleKeyword` |
| `click_element` | 按 ID 点击（需开启元素模式，短时缓存防 ID 漂移） | `id` |
| `extract_ui_vision` | 本地视觉模型精确提取（可选） | 无 |
| `start_complex_task` | Planner-Actor 编排引擎 | `userRequest` |

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
