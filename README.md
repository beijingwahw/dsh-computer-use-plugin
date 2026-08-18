# DSH Computer Use Plugin

**Give DeepSeek Harness real "eyes" and "hands"!**
**赋予 DeepSeek Harness 真正的"眼睛"和"双手"！**

**English** | [中文](#中文)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-green.svg)](package.json)
[![DSH Plugin](https://img.shields.io/badge/DSH-plugin-orange.svg)](https://github.com/topics/dsh-plugin)

A Computer Use plugin for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness). It completely abandons the underlying UI-tree dependency and adopts a **Vision-Only Grounding architecture**, letting the AI understand and operate a computer by "looking" at screenshots — just like a human.

## Core Features

- **Vision-Only Grounding**: No Accessibility API required; cross-platform (Win/Mac/Linux); works on cloud sandboxes, RDP sessions and even games
- **Set-of-Mark (SoM) visual assistance**: Screenshots are automatically overlaid with a grid, a green crosshair and numbered element boxes; the state anchor carries a legend — killing coordinate hallucinations
- **Smart context management**: Sliding window + image eviction to text summaries + `llm/pre-request` injection — however many screenshots you take, the model only ever sees the latest N images plus historical text placeholders
- **State anchor protocol**: Every tool returns a structured `{status, state_anchor, next_step}` triple; `MANDATORY` directives enforce the ReAct verification loop
- **Planner–Actor architecture**: The `start_complex_task` meta-tool decomposes long-horizon tasks into atomic actions and executes them step by step, failing fast on subtask failure
- **Enterprise-grade guards**: Coordinate boundary validation, consecutive-failure circuit breaker, sensitive-action audit, popup interception (waterfall short-circuit semantics)
- **Full desktop operations**: Screenshot, click, type, scroll, hotkeys, drag, tab/window switching, popup handling
- **Pluggable hybrid mode**: Optionally hook up a local vision model (OmniParser-like) or an accessibility provider for precise coordinates

## World-Class Breakthroughs: Four Self-Built Engines

Four engines targeting the four real failure modes of vision-only CUA agents:

| Failure mode | Engine | Mechanism |
| --- | --- | --- |
| **Blind spot**: click misses but agent believes it succeeded | Effect verification (`perceptualHash` + `actionVerifier`) | Take a full-screen dHash fingerprint before and after each action and compare Hamming distance; similarity > 0.97 flags a suspected no-op — the anchor warns and guides `zoom_inspect` recovery |
| **Coordinate hallucination**: full-screen estimation is imprecise | Two-stage grounding (`zoom_inspect`) | Crop the target neighborhood, enlarge, redraw a 2×-density fine grid; the anchor carries `crop_bounds` and the mapping `full_x = x0 + fx*(x1-x0)` for exact back-mapping |
| **No cross-session memory**: re-finding the same button from scratch every time | Scene-based UI memory (`remember_ui` / `recall_ui`) | Verified clicks are automatically persisted as landmarks; natural-language recall (mixed CJK/EN tokenization + overlap coefficient + success bonus + time decay); recalled values are priors only — screenshot re-verification is enforced |
| **Non-reproducible**: successful paths cannot be persisted | Action journal & replay (`journal` + `replay_actions`) | A post-execute observer records every action as JSONL (optionally persisted); `replay_actions` replays step by step after explicit `confirm` — a successful sequence instantly becomes an executable macro |

Companion enhancements:

- **Progressive recovery hints** — circuit-breaker guard escalation: 1st failure injects a "zoom for precise grounding" hint, 2nd failure injects "switch modality (keyboard nav / scroll / memory recall)", 3rd failure cools down for one round
- **Dry-run mode** (`dryRun: true`): action syscalls are recorded but not executed; screenshots stay real — a zero-risk sandbox for prompt tuning and demos
- **Confidence self-report**: `click_mouse.confidence < 0.6` proactively suggests `zoom_inspect` first, making model uncertainty explicit

## Round 2 — Adaptive Perception Loop

With the four engines working, four new systemic losses surfaced. This round unifies them under "fingerprint-driven" control:

| Loss point | Mechanism | Gain |
| --- | --- | --- |
| **Redundant screenshots**: full pipeline re-run even when the screen didn't change | Change-gated screenshots: after capture, compute dHash; distance ≤ 3 vs the newest fingerprint in window ⇒ skip compression/insertion, return an `unchanged` anchor referencing the old image (`force:true` bypasses) | Token & CPU drop in steady state; the model is explicitly told "screen unchanged, don't re-capture" |
| **Animation misjudgment**: verifying at a fixed 400ms reads "still animating" as "took effect" | Adaptive settle: poll the full-screen fingerprint until two adjacent frames differ by ≤ 1 (stable) or settleMs×4 timeout | The verification window auto-aligns to real UI rhythm — fast pages return early, slow pages wait it out |
| **Blind-retry loops**: re-clicking the same coordinate after failure | Anti-loop guard: last same-signature action already verified ineffective ⇒ intercept immediately and inject strategy-switch guidance (zoom / recall / keyboard nav / scroll); with no effect info, the 3rd repeat is intercepted | Idempotent retries get leeway; blind repetition gets cut |
| **Cross-scene memory false recall**: login-page coordinates recalled for a settings page | Scene-fingerprint bonus: landmarks record the full-screen fingerprint at formation; `recall_ui` matches against the current window fingerprint — same scene (similarity ≥ 0.9) gets a +0.3 strong bonus | Historical coordinates are most trustworthy only when "it's the same screen again" — memory goes from superstition to context-awareness |

Companion: **Token dashboard** — every screenshot anchor carries `context_images: n/limit` so the model always knows its image budget.

## Round 3 — Expectation-Anchored Region-Level Verification

Full-screen fingerprinting hides a flaw: it is insensitive to small local changes (a caret appearing, short text landing) — a 64-bit full-screen hash flips only a few bits and still reads >0.99 similarity, misjudging real effects as blind spots. Three mechanisms complete the perception stack:

| Mechanism | Design | Problem solved |
| --- | --- | --- |
| **Dual-scale verification** | `regionDhash`: fingerprint the neighborhood around the action point separately. Decision matrix: full screen changed = `page-level`; region only = `element-level` (caret/highlight/text); neither = blind spot | Local-feedback misjudgment: the click did land but only a small patch changed → no more false "missed it" reports |
| **Focus tracking** (`focusTracker`) | Click/drag endpoints auto-register a focus (30s expiry); `type_text` needs no coordinates from the model — verification centers on the focus region | Implicit inter-tool context: you almost always type where you last clicked; the faintest change (text landing) gets its own amplifier |
| **Expectation anchoring** (`expected_change`) | New `click_mouse`/`type_text` parameter: declare the expected visual change before acting; the anchor echoes it, `next_step` mandates a verification screenshot, mismatch = partial failure | Upgrades verification from "did anything change" to "did the *expected* change happen" — the model's world model made explicit and checkable |
| **Budget-aware orchestration** | `start_complex_task` gains `time_budget_sec`: subtask boundary clock checks; on expiry, gracefully abort with `[TIMEOUT]` + partial trajectory | The infinite-money-burning problem of long tasks: degrade instead of runaway |

Third-generation anchor effect block:

```json
"effect": {
  "detected": true,
  "scale": "element-level",
  "screen_similarity_pct": 99.8,
  "region_similarity_pct": 71.2
}
```

Full screen barely changed (99.8% similar) while the focus region changed dramatically (71.2%) — a textbook successful focus into an input box. The old version would falsely report a blind spot; the new one precisely identifies an element-level effect.

## Round 4 — Semantic Closure (Text Perception + Visual Diff)

The first three rounds stopped at the pixel layer — "did the change match the expectation" still relied on the model eyeballing images. This round installs **text perception** (local OCR) and **change localization** (visual diff), pushing verification to the semantic layer: the system directly confirms "did the expected content actually appear".

| Mechanism | Design | Problem solved |
| --- | --- | --- |
| **`find_text`**: text → coordinates | Capture a clean screen (no grid overlay) → local OCR → return the **exact center coordinates** of every hit | Elements with text labels no longer rely on coordinate estimation — the biggest source of coordinate hallucination is eliminated |
| **`read_text`**: region text read | Region crop + enlarge + OCR, returns plain text | Use text instead of screenshots when only content matters — order-of-magnitude Token savings |
| **`diff_view`**: visual diff | Last two screenshots, pixel-wise diff → block aggregation → connected-component merge → red-boxed diff image + list of changed-region coordinates | "What did the action actually change" is computed and drawn by the system; the model no longer compares two full screens by eye |
| **Semantic self-check (type_text)** | After typing, automatically OCR the focus neighborhood to verify **the typed text really landed** (no parameters) | Three invisible accidents exposed: typed into the wrong box / IME swallowed characters / focus lost |
| **`expected_text` (click_mouse)** | After clicking, OCR the click neighborhood and check the expected text | Pixel change + semantic hit = double confirmation; semantic mismatch fails even if pixels changed |

OCR is opt-in (`enableOcr: true`; language packs download once on first use — default `eng`, Chinese `chi_sim+eng`). All semantic features degrade gracefully when OCR is unavailable; everything else keeps working. `diff_view` is pure `sharp` — zero extra dependencies.

The final verification stack (four layers):

```
L1 Pixel     dual-scale dHash   — did anything change? at which level (page/element)?
L2 Locating  visualDiff         — exact bounds & center of the change
L3 Semantic  OCR check          — does the change contain the expected text?
L4 Expectation expected_*       — against what the model declared before acting
```

## Round 5 — Self-Evolving Skill Library + Risk-Aware Human-in-the-Loop

Rounds 1–4 improved single-execution quality. This round tackles two higher-order problems: **successful experience cannot be persisted** (the same workflow re-explored from zero every time) and **credential safety** (an agent must not type passwords for humans).

### Self-Evolving Skill Library (Trajectory → Skill → Reliability)

| Stage | Mechanism |
| --- | --- |
| **Induction** | After a complex task succeeds, automatically solidify the trajectory (replayable actions since `markTaskStart`) into a skill: trigger description + step sequence + entry-scene fingerprint; `save_skill` persists arbitrary journal fragments manually |
| **Dedup reinforcement** | Identical step sequences don't create duplicate cards — doing the same workflow three times = one skill verified three times (reliability 3/3), not three orphan cards |
| **Persistence** | With `skillLibraryPath` configured, skills survive across sessions: what the last session learned, the next one uses out of the box |
| **Matching** | `match_skill`: text overlap + Laplace-smoothed reliability + same-screen entry bonus (dHash ≥ 0.9) + recency; a skill is a prior, not a guarantee — anchors still require post-hoc verification |
| **Closed-loop calibration** | Every `run_skill` outcome writes back `successCount/attemptCount` — as the UI evolves and a skill breaks, its reliability decays naturally and its match rank drops; failure hints guide manual repair and re-`save_skill` |

### Risk Gate (Credentials Belong to Humans)

World-class CUA consensus (e.g. Operator): **credential input belongs to the human**. Implemented in two stages, reusing existing infrastructure:

1. **Sensitive-focus marking**: `click_mouse`'s `target_description` hits a risk keyword (password / verification code / 2FA / OTP / API key…, configurable) ⇒ `focusTracker` marks the focus sensitive; the anchor carries `sensitive_focus` and warns
2. **Input interception**: `type_text` into a sensitive focus (or text that itself hits risk semantics) ⇒ returns `ACTION_REQUIRED`, pausing for the human to type personally; **the pending content is never echoed** (`[REDACTED]`)

## Tool List

| Tool | Description | Key parameters |
| --- | --- | --- |
| `take_screenshot` | Capture + SoM overlay + compression + sliding window + popup sensing + change gating | `region`, `force?` |
| `click_mouse` | Normalized-coordinate click with built-in dHash effect verification + auto memory | `x`, `y`, `button`, `confidence?`, `target_description?` |
| `type_text` | Type text at the focus; cross-platform clear-first | `text`, `clearFirst` |
| `scroll_page` | Four-direction scrolling | `direction`, `amount` |
| `press_hotkey` | Key combos (whitelisted, injection-proof) | `keys` (array) |
| `drag_mouse` | Drag (four-beat sequence: move → press → move → release) | `startX/Y`, `endX/Y` |
| `dismiss_popup` | Zero-side-effect meta tool: force a ReAct re-analysis | none |
| `switch_tab` / `switch_window` | Tab / window switching (with fallback paths) | `direction` / `titleKeyword` |
| `click_element` | Click by ID (element mode, short cache against ID drift) | `id` |
| `extract_ui_vision` | Precise extraction via local vision model (optional) | none |
| `start_complex_task` | Planner–Actor orchestration engine | `userRequest` |
| `zoom_inspect` | Region crop + enlarge + fine grid, two-stage precise grounding | `x`, `y`, `half_size?` |
| `find_text` / `read_text` | Text → exact coordinates / region text read (needs `enableOcr`) | `keyword` / `x?`, `y?`, `half_size?` |
| `diff_view` | Visual diff of the last two screenshots: red-box diff image + changed-region list | none |
| `remember_ui` / `recall_ui` | Scene-based UI memory write / natural-language recall | `description`, `x`, `y` / `query` |
| `replay_actions` | Replay an action sequence from the journal (macro) | `confirm`, `from_step?`, `to_step?` |
| `save_skill` / `match_skill` / `run_skill` | Skill persistence / reliability matching / one-click execution (outcomes write back reliability) | `description` / `query` / `id`, `confirm` |

## Quick Start

### 1. Prerequisites

Node.js >= 18 (22 recommended) and pnpm. Native dependencies (`sharp` / `@nut-tree/nut-js` / `screenshot-desktop` / `tesseract.js`) install automatically with the plugin.

### 2. Install the plugin

DSH plugin source (name + origin):

```
dsh-computer-use-plugin github:beijingwahw/dsh-computer-use-plugin
```

Install with pnpm (git dependency):

```bash
pnpm add dsh-computer-use-plugin@github:beijingwahw/dsh-computer-use-plugin
```

Or add to `package.json` and `pnpm install`:

```json
{
  "dependencies": {
    "dsh-computer-use-plugin": "github:beijingwahw/dsh-computer-use-plugin"
  }
}
```

Install-and-run:

- **Build artifacts are committed** (`dist/` ships with the repo) — no build scripts run at install time (no `prepare`/`postinstall`); `main` points straight at `dist/index.js`
- **Framework dependencies are peers** (`@deepseek-ai/cordis` / `dsh-tools` / `schemastery`), provided by the DSH host
- **`dsh.bundle` points to `cordis.patch.yml`** — the plugin registers and activates automatically on install

### 3. Start DSH

```bash
pnpm dsh web
```

To override defaults, merge the `insert` entry from the bundled `cordis.patch.yml` into your own patch (when installed, `name` resolves via the package name — no absolute path needed):

```yaml
- insert:
    - id: dsh-computer-use-plugin
      name: 'dsh-computer-use-plugin'
      config:
        mouseSpeed: 1500
        compressWidth: 1440
        jpegQuality: 75
        # ... every field has a code default; trim per deployment
```

### 4. Local development (from source)

```bash
git clone https://github.com/beijingwahw/dsh-computer-use-plugin
cd dsh-computer-use-plugin
pnpm install          # devDependencies (typescript etc.)
npm run build         # regenerate dist/ (must re-run and commit after code changes)
npm test
```

When loading directly from source, set the patch entry's `name` to the entry file's absolute path (e.g. `/your/path/dsh-computer-use-plugin/dist/index.js`).

## Architecture

```
index.ts (apply)
 ├─ systemPrompt  three orthogonal segments (grounding rules / ReAct workflow / popup handling)
 ├─ buildAllTools(config)     tool factory (hybrid mode toggled by config)
 ├─ start_complex_task        Planner–Actor meta tool
 ├─ registerAllGuards         boundary / breaker / audit / popup interlock
 ├─ onLlmPreRequest           sliding-window image injection into model requests
 └─ ctx.effect                lifecycle cleanup

Screenshot pipeline: captureScreen → multi-screen awareness → SoM overlay → sharp compression → sliding window → popup sensing → state anchor
```

- **Context Manager**: singleton sliding window; old screenshots "hollow out" into text summaries with a stable timeline; shrinkage is transparent to the model
- **Visual Overlay**: high-performance SVG layer compositing via sharp (grid + crosshair + element boxes + adaptive labels)
- **Orchestrator**: Planner decomposition + Actor execution + `[SUCCESS]/[FAILED]` string protocol + fail-fast
- **Guards**: waterfall short-circuit interception; closure state dies automatically with plugin unload (Cordis register-as-effect model)

## Notes & Safety Statement

1. **System permissions**: macOS requires granting the terminal **Screen Recording** and **Accessibility** permissions in System Settings → Privacy & Security
2. **Sandboxing**: this plugin directly controls the host machine by default. Strongly recommended to run inside an isolated environment (Docker, E2B or a VM)
3. **Developer preview**: DSH core APIs iterate fast; tool-pipeline event names (`tools/pre-execute` etc.) are single-sourced in `src/guards/hooks.ts` — version migrations touch one place

## License

MIT

---

# 中文

**[English（顶部）](#dsh-computer-use-plugin)** | **中文**

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

## 第四轮创新：语义闭环（文字感知 + 视觉差分）

前三轮的验证停在像素层——"变化是否符合预期"最终仍靠模型看图自判。本轮装上**文字感知**（本地 OCR）与**变化定位**（视觉差分），把验证推到语义层：系统直接确认"预期的内容出现了没有"。

| 机制 | 设计 | 解决的问题 |
| --- | --- | --- |
| **`find_text`：文字→坐标定位** | 截干净屏（无网格叠加）→ 本地 OCR → 每个命中文词返回**精确中心坐标** | 带文字标签的元素不再靠坐标估算——坐标幻觉的最大来源被彻底消灭 |
| **`read_text`：区域文字读取** | 区域裁剪 + 放大 + OCR，返回纯文本 | 只需文字内容时用文本替代截图，Token 数量级下降 |
| **`diff_view`：视觉差分** | 最近两张截图逐像素差 → 分块聚合 → 连通域合并 → 红框差分图 + 变化区域坐标清单 | "动作到底改变了什么"由系统算出并画出来，模型不再肉眼对比两张整屏 |
| **语义自证（type_text）** | 输入后自动 OCR 焦点邻域，核对**输入的文字真的上屏了**（无需参数） | "打进了错误的框 / 输入法吞字 / 焦点丢失"三类隐形事故现形 |
| **`expected_text`（click_mouse）** | 点击后 OCR 点击点邻域，核对预期文字 | 像素变化 + 语义命中 = 双重确认；语义不符即使像素变了也判失败 |

OCR 按需启用（`enableOcr: true`，语言包首次使用联网下载，默认 `eng`，中文 `chi_sim+eng`）；OCR 不可用时所有语义特性优雅降级，其余功能不受影响。`diff_view` 纯 sharp 实现，零额外依赖。

验证栈最终形态（四层）：

```
L1 像素   dHash 双尺度 —— 有没有变化？在哪一级（页面/元素）？
L2 定位   visualDiff   —— 变化的精确边界与中心坐标
L3 语义   OCR 核对     —— 变化是否包含预期的文字内容？
L4 预期   expected_*   —— 与模型行动前声明的预期对照
```

## 第五轮创新：自进化技能库 + 风险感知人机协同

前四轮都在改进「单次执行的质量」；本轮解决两个更高维的问题：**成功经验无法沉淀**（同一个工作流每次从零探索）与**凭据安全**（Agent 不该替人输密码）。

### 自进化技能库（Trajectory → Skill → Reliability）

| 环节 | 机制 |
| --- | --- |
| **归纳** | 复杂任务成功后自动把本次轨迹（`markTaskStart` 以来的可重放动作）固化为技能：触发描述 + 步骤序列 + 入口场景指纹；`save_skill` 供手动沉淀任意日志片段 |
| **去重强化** | 完全相同的步骤序列不重复建卡——同一工作流做三遍 = 一个技能验证三次（可靠度 3/3），而非三张孤儿卡 |
| **持久化** | `skillLibraryPath` 配置后技能跨会话存活：上一个会话学会的工作流，下一个会话开箱即用 |
| **匹配** | `match_skill`：文本重合 + Laplace 平滑可靠度 + 入口场景同屏加成（dHash ≥ 0.9）+ 新近度；技能是先验不是保证，锚点仍要求事后验证 |
| **闭环校准** | `run_skill` 的每次成败回写 `successCount/attemptCount` —— UI 演化导致技能失效时可靠度自然衰减，匹配排序自动降级；失败提示引导手动修复并重新 `save_skill` |

### 风险闸门（Credentials Belong to Humans）

世界级 CUA 的安全共识（如 Operator）：**凭据类输入交还用户**。本实现为两段式，全部复用既有基础设施：

1. **敏感焦点标记**：`click_mouse` 的 `target_description` 命中风险词（密码/验证码/2FA/OTP/API key…，可配置）⇒ `focusTracker` 将焦点标记为敏感，锚点携带 `sensitive_focus` 并预警
2. **输入拦截**：`type_text` 到敏感焦点（或文本自身命中风险语义）⇒ 返回 `ACTION_REQUIRED`，要求暂停并请用户亲自输入；**待输内容绝不回显**（`[REDACTED]`）

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
| `find_text` / `read_text` | 文字→精确坐标 / 区域文字读取（需 `enableOcr`） | `keyword` / `x?`,`y?`,`half_size?` |
| `diff_view` | 最近两截图的视觉差分：红框变化图 + 区域坐标清单 | 无 |
| `remember_ui` / `recall_ui` | 场景式 UI 记忆写入 / 自然语言召回 | `description`,`x`,`y` / `query` |
| `replay_actions` | 重放日志中的动作序列（宏） | `confirm`, `from_step?`, `to_step?` |
| `save_skill` / `match_skill` / `run_skill` | 技能沉淀 / 可靠度匹配 / 一键执行（成败回写可靠度） | `description` / `query` / `id`,`confirm` |

## 快速开始

### 1. 环境准备

Node.js >= 18（推荐 22）与 pnpm。原生依赖（`sharp` / `@nut-tree/nut-js` / `screenshot-desktop` / `tesseract.js`）随插件自动安装。

### 2. 安装插件

DSH 插件源（名称 + 来源）：

```
dsh-computer-use-plugin github:beijingwahw/dsh-computer-use-plugin
```

以 pnpm 为例安装（git 依赖）：

```bash
pnpm add dsh-computer-use-plugin@github:beijingwahw/dsh-computer-use-plugin
```

或直接写入 `package.json` 依赖后 `pnpm install`：

```json
{
  "dependencies": {
    "dsh-computer-use-plugin": "github:beijingwahw/dsh-computer-use-plugin"
  }
}
```

安装即用：

- **构建产物已入库**（`dist/` 随仓库分发），安装时不执行任何构建脚本（无 `prepare`/`postinstall`），`main` 直指 `dist/index.js`
- **框架依赖按 peer 声明**（`@deepseek-ai/cordis` / `dsh-tools` / `schemastery`），由 DSH 宿主提供
- **`dsh.bundle` 指向 `cordis.patch.yml`**，插件随安装自动注册激活

### 3. 启动 DSH

```bash
pnpm dsh web
```

需要覆盖默认配置时，把包内 `cordis.patch.yml` 的 `insert` 条目并入你自己的 patch（已安装场景 `name` 直接用包名解析，无需绝对路径）：

```yaml
- insert:
    - id: dsh-computer-use-plugin
      name: 'dsh-computer-use-plugin'
      config:
        mouseSpeed: 1500
        compressWidth: 1440
        jpegQuality: 75
        # ……全部字段均有代码默认值，可按部署裁剪
```

### 4. 本地开发（源码直载）

```bash
git clone https://github.com/beijingwahw/dsh-computer-use-plugin
cd dsh-computer-use-plugin
pnpm install          # 安装 devDependencies（typescript 等）
npm run build         # 重新生成 dist/（改代码后必须重跑并提交）
npm test
```

源码直载调试时，patch 条目的 `name` 写入口文件绝对路径（如 `/你的路径/dsh-computer-use-plugin/dist/index.js`）。

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
