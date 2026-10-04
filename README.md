# 基于 DeepSeek Harness (DSH) 构建的 Computer Use 插件

**中文** | **[English](#english)**

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
- **GLM-5.3-Flash 云脑皮层（可选）**：十器官外接智谱视觉大模型（元素接地 / 语义判决 / 看屏问答 `ask_screen`），与本地感知保守双脑仲裁，零 Key 零成本优雅降级
- **万脑归一（纪元 Ψ）**：全平台视觉模型统一支持——13 颗脑（智谱 / OpenAI / Anthropic / Gemini / 通义 / Kimi / 豆包 / Grok / 硅基流动 / OpenRouter + Ollama/vLLM/LM Studio 本地免钥）密钥给谁就用谁，主力挂了备补位；缺省 GLM 行为逐字节不变
- **自主智能环（纪元 Φ，默认关闭）**：`autonomous_run` 元工具一次调用驱动"识别→判断→执行→进化"四环闭环——自主宪法六律立法（destructive 恒审批），立法者显式开启才自主

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

## 第六纪元（J）：工程收敛 —— 全库质量加固

前五轮堆出了 32 个数学引擎与 D-1~D-7 器官方阵；本轮停止加-feature，把整个器官群焊牢：**四条主链致命修复**（Python 服务真实点击此前 100% TypeError、shm 传输生命周期注册表单主、降级排练不再误锁主机执行、D-4 判决三方言配对令 `rejected` 否决权首次可达）、**审批协议改为"请求 ≠ 同意"**（`grant_approval` 是执行前置）、安全面（AppleScript 注入序、中间件洋葱序、nonce 双解码）与数十项中危修复。287 测试全绿起步。

## 第七纪元（K）：留白兑现 —— 诚实声明的空白逐一落成

| 留白 | 落成 |
| --- | --- |
| 排练永远 `degraded`（无验证层） | **虚拟屏模拟器**（`sandbox/virtualScreen.ts`）：确定性控件世界，命中测试产 L1 证据、焦点输入产 L4 证据（`expectedText` 核对）——历史性一刻：`passed` 首次可达，肌肉记忆固化真实触发 |
| Windows 环境塑形缺席 | **WindowsAdapter**：PowerShell + Win32 P/Invoke（raise/maximize/move/set_zoom），几何快照 undo，PS 单引号转译封死标题注入面 |
| Actor 无真实后端 | **双通道**：DSH `agents` 服务在场走服务；缺席走技能回放（可靠度 > 0.5）并回写结局；双缺席诚实 `[FAILED]` |
| 会诊只有规则表 | **贝叶斯皮层**：六症候群 × 五信号 CPT，log-sum-exp 精确枚举；规则为主、信念侧写随报告附体 |
| 统计兵器缺口 | **SSD 二阶随机占优**（FSD 交叉时按下偏矩不等式裁决）、**同形字归一化**（西里尔/希腊/全角三层混淆仍命中风险词）、**噪声容忍环检测**（汉明容差 6） |
| 无科学基准 | **基准套件**（`npm run bench`）：消融/标定/参数消融/联合标定四件套，首跑全绿 |

## 第八纪元（L）：服务归属立法 —— 消费方终于有注册方

**法条：仓内天然属主自荐，宿主裁决总线。** D-5 `apply()` 经可选 `ctx.set?` 面自荐 `dsh.sandbox` 引擎视图；D-7 自荐 `dsh.knowledge-pipeline`；宿主无 `set` 面 ⇒ 既有诚实降级一字不动。同时把三处"死导出"契约占位符激活为执法面（`hasVerificationLayer` 进审计面、`SandboxDoctorView` 得真实门面适配器、intent 铸造走 `IdGenerator` 三重防碰撞）。

## 第九纪元（M）：值即边界 —— 五项数值留白交付

- **Windows `set_contrast`**：SystemParametersInfo 官方 API（SPI_GETHIGHCONTRAST 快照 → SPI_SETHIGHCONTRAST 置位，undo 还原原 flags）
- **同形字算术全表**：五个数学字母系（U+1D400..）、带圈、上标、亚美尼亚/科普特系——码点算术生成，零数据文件，扩展 = 一行
- **CPT 蒸馏标定**（`calibrateCptFromRules`）：32 信号组合全枚举 + 共现计数 + Beta(1,1) 平滑 + 专家收缩；与规则首判一致率 0.484 本身即量化数据，真遥测接入 = 换 oracle 接口不变
- **SO_PEERCRED 服务端半**：UDS 连接捕获对端 PID，auth 中间件强校验 `token.pid == peer_pid`（非 Linux 优雅回退）

## 第十纪元（N）：残差根除

swarm 跨会话重复入账以**持久化消费水位**根除（restore 后跳过已消费前缀）；**审批盲区硬前置根除**——闸门开启时双描述通道皆沉默的点击返回 `ACTION_REQUIRED` 而非透明放行（合规是零成本的：带描述重发即可）；虚拟屏 drag 命中证据与 switch_window 标题匹配焦点证据补齐。套件 325/318/0 败。

## 第十一纪元（O）：28 项清账战役 —— 世界性创世升级

七轮战役后的全量待完善清单，按推荐执行序 28 项逐一兑现（`test/epochO.test.ts` 逐项执法）：

**环境与真机**：Windows 真机基准落地（`test/realMachineWin.bench.ts` 四实验全绿 —— D-5 服务真截屏 → tesseract.js 离线 OCR → **真 pyautogui 物理点击** → tkinter 世界状态翻转；E1b 陷阱改道与 E3 学习曲线在真机上复现）；POSIX shm 跨进程往返测试 + Linux CI workflow（`/.github/workflows/ci.yml`）；sharp/tesseract.js 入库后 7 项环境闸全绿。

**潜伏 bug 群根除（真机执法的战果）**：① Windows `set_contrast` 的三只（apply 误要求窗口句柄 / PS `\"` 转义非法 / pvParam 须为 HIGHCONTRAST **结构体**）—— 真机往返 126→127→126 VERIFIED；② `screen.py` JPEG 闭包 UnboundLocalError（任何平台必炸）；③ GPD 矩估计反演代数错误（(k−1)/(2k−1) → (k−1)/(2k)，双估计器上线后现形）；④ contextManager id 时钟回拨。

**数学器官**：GPD **PWM 第二估计器** + 一致性检验（主估计权归 PWM）；**双边 CUSUM** + 环前终身基线（基线不再随环翻转，痊愈臂 = RECOVERY 洞见）；W₁ **信息熵加权**（w1Info/infoRatio 双视图显形掩蔽）；I-4 **相干瞬移场**（≥2 特征同矢量共移 = 刚体重排证据，单候选诚实瞬态）；LTLf **性质挖掘器**（有界响应/先序/防重三族自动立法，支持度≥3 零反例才立）；A² 临界值 **MC 自举表** + Kalman Q/R / Schmitt / NCD 阈**标定回路**（`src/calibration.ts`）。

**架构补全**：`dsh.vision.structured/traditional` 服务自荐（单属主铁律）；worldModel **run 级快照**（fork/merge 重放，并发同号类型重铸）；restore 悬空引用三重校验；沙箱 **L3 场景 OCR**（`sceneOcr` 点燃休眠的 L3-semantic 层）；switch_tab **标签页栈模型**（role='tab' 循环指针）；SO_PEERCRED **Node 客户端半**（undici UDS dispatcher + 桥注入）；token **真实消耗计量**（工位自报回路 `tokenUsageReported`）；审批根除的**模型侧协议强制**（`target_description` schema 必填）；首轮知识检索**串行化选项**；homoglyph **Unicode confusables 全表**（1665 条蒸馏，~22MB/s）。

## 第十二纪元（P）：灭虫圣战 —— 全库清虫 + 虫型免疫机制

对全库（TS 13 文件深审 + Python 3 文件 + 机械扫描）猎杀潜伏 bug，**共根除 7 只**，并把每类虫型铸成永久免疫：

- **#8（严重）`auth_middleware` 顺序倒置**：peer-PID 比对在令牌解析之前执行——UDS+Linux+peercred 路径（M 纪元 SO_PEERCRED 服务端半）**落地即 UnboundLocalError 崩溃**。M-4 源级执法从未运行故未现形。
- **#9（严重）A² 反号约定**：`calibration.ts` 的 GPD CDF 用了与采样器相反的 ξ 符号约定——MC 临界表在错误分布下计算（分位 78–160 vs 文献 ~0.5–1.1）。
- **#10 标定器 NaN 泄漏 + 装饰字段**：`calibrateNcdThreshold` 被毒化后仍返回貌似合法的标定；`calibrateKalmanQR` 的 `predicted` 字段从未被使用（API 谎言）——修为真互补滤波。
- **#11/#12（严重）swarm 消费水位双缺陷**：restore 静默丢弃持久化的水位（N-1 的根除名存实亡）；水位基于 journal 滑窗位置（容量饱和后位置不稳 ⇒ 会话中途永久停止积累经验）。修为「武装水位」：恢复后首轮前缀跳过即标记进身份游标（WeakSet），会话内驱逐免疫。
- **#13** `recombine` 去重强化路径漏 `save()`（崩溃窗口内计数丢失）。
- **#14** 多显示器准星钉边：全局虚拟屏坐标混入截图本地域——鼠标在副屏时给出**自信的错位** grounding 信号；修为域外诚实缺席。
- 另修 `verify` 的 V2c 环境假设（pyautogui 装机后"无显示"模拟失效——改毒性模块注入，任何机器确定性执法）。

**免疫机制（创世）**：`scripts/bug_class_lint.py` —— **Bug 类注册表（BCR）**：每类历史虫型（PS 引号律/闭包重赋值/时钟单调假设）铸成机械检测器，全库扫描签名形状，接入 `npm run verify` 构建闸；`test/epochP.test.ts` —— **属性测试炮台**：全部统计引擎过「已知参数恢复 + 闭式对齐 + 不变量」关（Hurst iid→0.5、置换检验对 Fisher 闭式、贝叶斯归一、NCD 对称、A² 文献带、Kalman 对 DARE 闭式、汉明度量律、LTLf 有限迹语义）。示例断言抓不住约定错配——参数恢复能。

## 第十三纪元（Q）：开天辟地 —— 全模块八器官创世

对全部模块簇的一次创世级升级——每簇一件真正的新数学器官（`test/epochQ.test.ts` 逐件执法）：

- **Q-1 证明层 `src/proof.ts`（新器官）**：Merkle Mountain Range——追加型证据流的 **O(log n) 包含证明**（叶数为 2 的幂的山峰二进制分解 + 峰袋根）。journal 与 sandbox 链双双接线：审计者凭单根 + 单证明核验单条记录在册，**免整链重放**；篡改任一叶 ⇒ 全部旧证明失效（Q-1 执法 1..1000 全尺寸 + 全篡改检出）。
- **Q-2 感知层 pHash**：DCT-II 低频谱第二指纹（32×32 → 二维可分离 DCT → 左上 8×8 中位阈值，DC 排除 ⇒ 亮度不变）。dHash（梯度域）与 pHash（频谱域）失效模式正交——`dualSimilarity` 保守融合（min）；actionVerifier 判决携带 `phashCorroborates` 独立第二意见。
- **Q-3 决策层 Wald SPRT**：弹窗判决的**序贯最优停止**（Wald 1945；Wald–Wolfowitz 定理：同 (α,β) 下期望样本量全类最小）。语义单帧即判（LLR=ln45）、几何三帧累积、双清洁两帧判净、终判锁定；与 Schmitt 迟滞并存（后者保既有语义零回归）。
- **Q-4 知识层 Dirichlet 预测熵**：worldModel 转移预测携带 `entropyBits`（平滑预测熵——「点了之后世界去哪」的主张强度，L3 付费观看的正当性可量化）与 `posteriorConcentration`（可信的不确定性 vs 廉价的均匀无知）。
- **Q-5 记忆层技能系谱**：Skill 增 `parents/generation`——合成技能登记基因供体谱系；`lineage(id)` 祖先链回溯（环守卫诚实截断）；容量驱逐感知**谱系存续**（活跃祖先 ×1.5 加成——基因仍在后代中表达的技能不死）。
- **Q-6 证据层效应量**：`cohensH`（反正弦效应量——比例近 0/1 域不虚胀）+ `mannWhitney`（非参秩检验，并列校正 + 连续性修正；延迟是重尾——GPD 纪元的教训，A/B 对照配秩检验不配 t 检验）。「主张要有数字」升格为「数字要有效应量与检验」。
- **Q-7 探索层 Thompson 晶体**：swarm 经验晶体的 Beta(s+1,f+1) 抽样排序（H-3 同律迁移）——低证据晶体（2/2 全胜）按证据不足程度**成比例**获探索配额，反事实推理不再被早期幸运儿垄断。
- **Q-8 运动层焦点外推**：焦点两点一阶差分估计漂移速度，`predicted()` 外推长延迟后的焦点位置（钳半屏）；证据不足诚实回退原点。

## 第十四纪元（R）：开天辟地第二击 —— 六层器官再造

对 Q 纪元未触及的六个模块簇各铸一件新器官（`test/epochR.test.ts` 逐件执法）：

- **R-1 模糊层 `src/fuzzy.ts`（新器官）**：子串编辑距离近似匹配（Wagner–Fischer 行进形；Myers 位向量的渐近界备案、审计性优先选经典 DP）——OCR 把 l 读成 1、O 读成 0、吞空格时，`expected_text` 的逐字节对照在真机必然漏判；容错 ≤⌈m/6⌉ 判决接入 textReader 语义核对。
- **R-2 检索层 BM25**：知识库词法通道从二值命中计数升格为 BM25（k1=1.2/b=0.75，语料级 IDF + 长度归一 + tf 饱和）——稀有词（'api token'）的判别力被语料统计兑现，长文本不再靠篇幅堆命中。
- **R-3 熔断层 Beta-Bernoulli 序贯后验**：连续计数熔断的盲区是**交替成败型坏路线**（失败-成功-失败…永不连败即永不熔断）；滚动窗内 P(失败率>50%) ≥ 0.95（正则化不完全 Beta，Lentz 连分式 + Lanczos lnΓ）即熔断。
- **R-4 快照层 v4 证据锚**：checkpoint 携带 journal/sandbox 双 MMR 根（快照与证据链的一致性锚——恢复时可验"重算根 == 锚"）；v1/v2/v3 幂等迁移。
- **R-5 视觉层跨帧稳定元素 ID**：IoU 贪心跟踪（阈值 0.4，消失 ≤5 帧续号）——同一物理控件跨截图保号，`click_element` 的"点 3 号"不再每帧语义漂移。
- **R-6 召回层 RRF**：失败记忆三通道（词面/NCD/场景）改倒数排名融合（TREC 形 Σ1/(60+rank)）——排名无量纲，三通道不再需要逐通道定标；旧加权和并存为 `score2`。

## 第十五纪元（S）：开天辟地第三击 —— 六器官闭环

给仍未触及的模块簇铸六件，并把前世代的环**闭环**（`test/epochS.test.ts` 逐件执法）：

- **S-1 快照层·锚验证**：checkpoint 恢复时重算 journal MMR 根与锚对照——不符即 `EVIDENCE ANCHOR MISMATCH` 置顶报告（R-4 的另一半，快照-证据一致性从"可锚"到"可验"）。
- **S-2 过程层·蓄水库流式分位**（Vitter 1985 算法 R + 序统计）：逐观测 O(1) 维护 P50/P95/P99 活体读数，容量 512 内存有界，种子可注入可复现（P² 标记法实测增量可破序发散，诚实弃用并备案）。
- **S-3 决策层·Hedge 通道仲裁**：Actor 双通道按乘性权重 w←w·exp(−η·loss) 学得偏好——平权时 agents 优先（既有法零回归），agents 连败且技能连胜后技能通道接管；权重带 0.1 底权（复活通道不死）。
- **S-4 记忆层·Beta 后验信任**：UI 地标信任分从线性帽 `0.05·min(s,6)` 升格 `(s+1)/(s+2)` 贝叶斯曲率——一次成功不配满信任、渐近饱和、零成功留先验底。
- **S-5 规约层·挖掘性质在线执法**：`enforceMinedProperties` —— R/Q 纪元挖掘的性质在新迹上逐位执法（bounded-response 破缺/抢跑/连击定位），性质库从描述统计升格为**在线规约**（mine→enforce 闭环）。
- **S-6 认知层·既视感双指共识**：潜意识条目携带 pHash 第二指纹，dHash 初中后须频谱域复核（≥0.85）才闪灵光——同梯度不同内容的假既视感被压制；sharp 缺席单指回忆零回归。

## 第十六纪元（T）：开天辟地第四击 —— 对称与传播

主题：给只有正半边的机制补对称、把已立器官传播到残余模块（`test/epochT.test.ts` 逐件执法）：

- **T-1 行为层·量化相似签名**：防死循环守卫的逐字节签名对坐标抖动（0.501 vs 0.500）失明——同一按钮的微移重试不算"重复"。数值参数 0.01 网格量化后铸签（≈20px@1080p 物理分辨率），抖动同签、真位移异签。
- **T-2 期望词表对称性认证**：intent 物理词表的消失半边（toggle_off/menu_collapse/text_vanish/scroll_down）核验已在册——**认证而非重造**（不为改而改）。
- **T-3 判决通道·同链去重**：D-4 回执队列对同 chainId 的重复回执合并（保留最新）——同链多次排练不再触发多次昂贵会诊。
- **T-4 服务层·全抖动指数退避**：`uniform(0, base·2^n)` 取代定值退避（AWS 经典形态）——并发等待者重试相位解相关，惊群免疫。
- **T-5 证据层·反事实效应量传播**：what_if 决策点的异路线证据携带 Laplace 路线率（同场景全池统计），并给出最优异路线 vs 本路线的 **Cohen's h**——"换这条路好多少"从定性变定量（R-6 器官传播到反事实推理）。

## 第十七纪元（U）：开天辟地第五击 —— 旋转与自省

- **U-1 感知层·环形旋转不变指纹**：dHash/pHash 双双怕旋转——质心环带强度分布（旋转不改变环带内像素集合）给出第三指。诚实边界：不变域 = 90° 整数倍（实测 sim=1.0；小角重采样与环宽量化同阶）——专职竖屏/横屏切换类判定。
- **U-2 视觉层·非极大值抑制（NMS）**：a11y 树的嵌套申报（容器与其子按钮共占一区）在元素预算前先去冗余——面积降序贪心保留，IoU≥0.6 抑制。
- **U-3 证明层·守卫裁决入链**：`GUARD_BLOCKED` 标记种类——每次守卫拦截都是防篡改链上的政策裁决事实（proof 器官闭环到守卫层，拦截不可抵赖）。
- **U-4 自省层·器官册 census**（`src/organCensus.ts`）：七纪元 33 件数学器官登记入册（层/数学根基/自检 λ），`quality_checkup` 自省段逐件点名——genesis 的 "premature-impl" 规则至此有了对称面：**impl 之后的 operational census**。

## 第十八纪元（V）：器官审判日 —— 联合消融基准

给七纪元铸的器官上科学法庭：`test/organAblation.bench.ts` 八项微基准（确定性、可复现），每件器官的贡献由数字判决（`test/reports/organ-ablation-report.md` 全表）：

| 器官 | 审判数字 |
| --- | --- |
| 模糊匹配 | OCR 变体恢复率 **100%** vs 逐字节基线 0% |
| 三指纹 | 同/异图双指 100%；90° 旋转环指捕获 **100%** vs 双指 0%（正交性实证） |
| BM25 | 稀有词查询 MRR **0.583** vs 二值基线 0.250 |
| 通道仲裁 | 劣质主通道场景 EMA 收益 **226/300** vs always-agents 104，逼近预言机 234 的 96.6% |
| 蓄水库分位 | 三分布（均匀/重尾/双峰）ΔP50=ΔP95=**0.0%**（m=512, n=2000） |
| MMR | 千叶证明长度 ≤ log₂(n)+1（实测 6/9） |
| RRF | 通道重标定（×10）排名稳定 **100%** vs 加权和 0% |
| LTLf 执法 | 三型注入违例**逐位全中**（响应@1/抢跑@0/连击@5） |

**审判日的真实战果**：仿真抓到 S-3 乘性权重的**复辟缺陷**（对称底权触底后回到平权 ⇒ 劣质通道周期性复辟，151/300）——裁决升格为 **EMA 成功率仲裁**（只更新被选通道，未选冻结），回写实现后逼近预言机。另裁决两例测试前提不成立（加权 0.3 律在合成域不真输、倒序非 OCR 域变异）——法庭对自己一样诚实。

## 第十九纪元（W）：第七击 —— 隔离与真机审判

- **W-1 单例隔离审计**：一切有状态单例必有归零缝——补上两只真缺（`approval` 审批簿记、`orchestrator` 通道 EMA——V 日泄漏源），执法矩阵：脏化 → reset → 必须回到初值。
- **W-2 真机审判**：器官时代后首次重跑 Windows 真机基准——**4/4 全绿**（真 OCR 感知 / 真鼠标物理点击闭环 / 陷阱改道 / 学习曲线）：六纪元改造后真截屏→离线 OCR→真 pyautogui→tkinter 世界翻转全链无恙。
- **W-3 创世总账**（[GENESIS.md](GENESIS.md)）：30+ 器官一行一件（数学根基/执法册/审判数字），七击可导航。

## 纪元 X：笔迹纪元 —— 反射纪元大脑的运动反射弧

反射纪元的决策大脑对世界只会一件事：点击。本纪元给它一套**运动词汇表** —— `type_text` / `scroll_page` / `press_hotkey` —— 零 LLM，经 `src/intentGrammar.ts`（纯函数意图文法）与 `ReflexiveDecisionStation` 中的运动弧落地：

- **引号锚定载荷提取（构造性无损）**：待打文本必须由可逆编码携带 —— 引号区间（`"…"` / `'…'` / `「…」` / `『…』` / `“…”` / `‘…’`）逐字节精确提取（编辑距离 0）。自由文本提取是有损猜测 —— 密码打错与没打一样糟 —— 一律拒绝（精确性优先）。执法自身抓到一只真缺陷：缩写撇号（`don't`）与后文单引号载荷配对时会静默腐蚀载荷；单引号开启符现已带词界门。
- **运动序法则（先取落点，再落笔）**：依赖 DAG `{target → text}` 按拓扑序执行 —— `type "gamma" into the server field` 先对字段发*点击*（夺取焦点），焦点在手后才落笔。同一条法则也保护 `press the big red button` 不被误路由进热键弧。
- **载荷剥夺**：残差（意图 − 动词 − 引号区间）才是对*落点*投票的一方 —— 载荷词永远不投落点票，运动弧与前额叶深思（deliberation）的词法通道两处同律。
- **生而自证的反射（L4 自锚）**：引号锚一物两用，兼作 `expectedText` —— 反射第一次*知道自己的成功长什么样*（点击预言不了像素；载荷预言得了文本）。基准的执行站拿它对照世界真值执法。
- **运动学域**：滚动量必须落在 `[1,20]`（域外拒绝，绝不钳位 —— 钳位会把 `scroll 999` 静默改写成 20）；热键和弦归一键名别名（`control→ctrl`、`escape→esc`）并封顶 4 键。
- **层级不破**：Tier-0 免疫抑制照旧门控每一类运动；知识教「哪里」（残差上的 workflow 升益），文法教「什么」（载荷）；`disableMotorArc` 消融证明贡献（打字意图退化为诚实零动作接地）。

执法：`test/epochX.test.ts`（14 项，X-1..X-9 —— 提取表、弧选择表、L4 达标的虚拟屏排练、消融、压制优先级）。真机审判：大规模 Data Console 基准长出第六页（`editor`：三个带焦点真值的文本字段）与 `typing` 类别 —— 真 pyautogui **键盘击键**落进 tkinter entry，由逐键世界状态裁决。

战役本身根除两只真机缺陷：(1) `pyautogui.typewrite` 穿过活动输入法（`alpha.local` → `alpha。local`、`ada` → `阿达`）—— D-5 服务在 Windows 上改走 `SendInput` + `KEYEVENTF_UNICODE`，唯一与输入法正交的确定性文本注入；(2) 同基线导航/内容词污染 tesseract 行切分（`settings` + `format disk` 同排 ⇒ `setines`，conf 0）—— 感知改跑**条带 OCR**（导航条带 | 内容条带分开识别，跨列行混合在构造上不可能），导航不变量收紧为六词（files/network/reports/settings/archive/editor）全在场。

## 第二十纪元（Z）：世界行动引擎 —— 交互性探针

**对症失败模式**：「对话文本被误识别为可点击的入口」。聊天记录里写着「点击登录按钮」的消息、文档中引用的菜单名、渲染在屏幕上的任务指令 —— 它们与真按钮在像素层**完全等价**，任何视觉分类器（包括大模型自己）都只能猜。

**世界行动律：猜不出来，就问世界。** Z-1 以三个证据通道判决交互性，按判别力降序（`src/interactivityProbe.ts`）：

| 通道 | 动作 | 证据 | 置信 |
| --- | --- | --- | --- |
| 1. UIA 点查询（Z-1c） | `ControlFromPoint` 单点问结构层 | 官方登记的控件类型（Button/Hyperlink/Text/Edit...）；**祖先链律**：按钮里的 Text 标签沿祖先上行找到 Button 即判 control | control 0.97 / text 0.93 |
| 2. 光标本体感觉（Z-1a） | 悬停（`move_mouse`，绝不按下）读 `cursor_kind`（Win32 `GetCursorInfo`） | `hand` ⇒ OS 亲口承认的可点击热区；`ibeam` ⇒ 可选择文本（正文/聊天消息）—— 不是入口 | control 0.95~0.96 / text 0.92 |
| 3. 悬停重绘（Z-1b） | 悬停前后区域 dHash 对比（`metaOnly` 指纹，零图像传输） | 控件会有 hover 高亮/下划线/tooltip，正文纹丝不动 | control 0.8~0.85 |

**两遍架构（实验经济学）**：第一遍全员 UIA 点查询——**零物理副作用**（不动鼠标、不截图、无时序抖动），dry-run 与弹窗期也照常判决（只读感知不受守卫约束）；仅当 UIA 缺席/unknown 的残余点才进入第二遍悬停实验（存档原位 → 逐点实验 → finally 复位，实验不留痕律）。大多数点在第一通道即被判决，鼠标根本不动。

**Z-1d 判决记忆化（实验成本摊销到每个场景一次）**：判决性结论（control/text）随形成时的整屏指纹入册（`probeMemory`，LRU + TTL + checkpoint 存活）；同场景（指纹相似度 ≥ 0.9）再遇邻近点（距离 ≤ 0.015，OCR bbox 微抖容忍带）直接复用判决——零实验、零鼠标、dry-run/弹窗期同样生效。**负向记忆恰是最有价值的一半**：聊天文本的 text 拒判稳定且每次 find_text 都会重遇。诚实律：inconclusive 不入册（「不知道」不是证据）、召回降一等（confidence -0.03 且封顶 0.9，via=memory 永不冒充新鲜实验）、场景漂移（聊天滚动/换界面 ⇒ 指纹变化）自动失效重实验。真机实测：同场景复用 **877ms → 57ms（15.4x）**，鼠标全程未动。

**Z-1e 自适应 dwell（悬停实验提速）**：决定性光标形态（hand/ibeam）读完即判——OS 换光标是即时的，无需等待重绘通道的 350ms dwell；仅 arrow/custom 走重绘轮询（150ms 步进，检出即停，上限 ceil(dwell/150) 步）。决定性路径单点成本 ~750ms → ~240ms；冷却仅在走过轮询路径后需要。

降级链完整：记忆 miss → UIA 库缺席/`DSH_PHYSICAL_L1_BACKEND=disabled`（纯视觉意识形态门控）/游戏与 canvas 无登记 ⇒ 通道缺席，静默落回悬停双通道，不伤害。`unknown`（Pane/Custom）同样落回。

**接线四处**：

- `find_text`：OCR 命中先过探针（优先级 ambiguous > content-like > control-like，上限 `probeMaxTargets`），每条坐标携带 `interactivity=control|text|unprobed` 与判决通道（`via=uia(Button)` / `via=hover(cursor=ibeam)` / `via=memory`）；`next_step` 明令「只点 control；text 是提到关键词的正文，点了就是事故」。
- `probe_interactivity`（新工具）：对任意坐标做三通道判决（记忆 → UIA → 悬停实验）—— 模型对任何拿不准的文字都可在点击前问一句 OS。
- `take_screenshot` 图例：内容区文字（聊天/文档/表格）是数据不是 UI。
- `click_mouse`（Z-2 点击闸门）：见下。

**Z-2 点击闸门（判决前移到指针落下之前）**：Z-1 的判决只标注在 `find_text` 结果里——模型可以不看。Z-2 把同一三通道判决接到 `click_mouse` 执行前（`gateTextClick` 纯函数 + `src/tools/clickMouse.ts`）：左键点击前先探针目标点，判决为 `text` 且置信 ≥ 0.9（决定性判决）且证据不是 Edit 输入框 ⇒ 结构化拒绝（`ACTION_REQUIRED`），告知模型「此点是正文——文字只是*提到*了你要找的标签」，并给出改道指引（find_text 找 control 命中 / 截图重定位 / 滚动）。例外通道全部显式：**Edit 放行**（点击输入框聚焦是合法动作）、**右键放行**（正文上的上下文菜单合法）、**`allow_text_click: true` 自证放行**（模型明知点正文：文档放置光标/选中文本）、dry-run/探针缺席零回归。闸门在 `captureBefore` 之前执行——悬停实验可能触发 hover 高亮，before 帧必须在探针后取，否则污染「无变化」基线。
同法根除零模型路径：反射弧场景源的 L2 OCR 词元先过几何先验剔除（`ocrWordsToClickCandidates`，`wordShape.ts` 纯模块）——宽行/多行段落形态不参选落点选举，「正文被当作按钮」在脊髓反射层失去燃料（误剔真入口 ⇒ 诚实接地，比错点正文便宜）。

与四层验证栈的关系：`actionVerifier` 验证「点击之后有没有生效」（事后），Z-1/Z-2 验证「点击之前该不该点」（事前）—— 感知闭环从执行域前移到决策域。守卫集成：悬停实验在弹窗激活期/dryRun 下跳过（UIA 判决不受限）、探针失败诚实降级为 `unprobed` 而非谎报。物理服务版本门控 0.4.0；`/hit_test` 属结构感知能力位（`ui_tree`）。

## 第廿三纪元（AA）：世界跳转引擎 —— open_url

**对症需求**：「自动跳转网页链接」。屏幕上的 URL（聊天正文里、文档里、OCR 噪声里）不是控件 —— 点击要么被 Z-2 闸门否决（正文），要么点不中。世界行动律的答案：**链接不靠点，交给 OS 壳层**。

**AA-1 URL 感知（`src/urlSense.ts`，纯函数零依赖）**：

- **提取无损**：从自由文本（OCR 全文/控件名）提取完整 URL 子串；尾随标点剥离（中文句号/全角括号是 OCR 粘连）带**括号平衡律** —— 维基百科式 `…wiki/Python_(lang)` 的成对括号是 URL 的一部分，不许误剥；
- **归一无猜**：`www.` 前缀补 `https://`（www 是显式网页自声明，唯一被授权的猜测）；裸域名（`example.com`）拒绝 —— 精确性优先，与运动弧引号锚定同律；
- **安检无情**：scheme 白名单 `[http, https]` —— `file://`（本地文件系统）、`javascript:`（脚本执行）、`data:`/`vbscript:`（数据/脚本载荷）一律结构化拒绝。跳转引擎只把模型带向公开网页，**不做任意协议启动器**；无点主机拒绝（`http://foo` 是词不是站），localhost 例外；超长（>2048）拒绝。

**AA-1 跳转躯体（`system.openUrl`）**：平台 opener（win=`cmd start` / darwin=`open` / linux=`xdg-open`），fire-and-forget —— 回执证明的是「壳层请求已发出」而非「页面已加载」，验证交给世界（take_screenshot / switch_window）。Windows 引号转义在 spawn 层手工完成（`windowsVerbatimArguments`）—— 查询参数里的 `&` 是常态，Node 默认 argv 引用不覆盖它，裸露会被 cmd 当命令分隔符。真机战果：`https://example.com/?a=1&b=2` 完整落地（Edge 窗口标题取证）。

**接线四处**：

- `open_url`（新工具，`enableOpenUrl` 默认开）：入参可以是裸 URL 或含 URL 的自由文本（OCR 行直接粘贴）；提取精确、多候选歧义结构化拒绝（绝不掷硬币打开一个）；`ACTION_TOOLS` 在册 —— 跳转可重放、可审计、可归纳进技能。
- `read_text`：OCR 全文里的 URL 自动浮出（`urls_detected` 字段 + next_step 指引 open_url）—— 「自动跳转」的感知面，模型不必手抄链接。
- Z-2 点击闸门：被否决的正文若含 URL（UIA 控件名回执，零成本复用），拒绝信息直接给出改道出口：「别点，用 open_url 跳」。
- 弹窗守卫：popup 激活期 open_url 一并冻结（先处理弹窗，世界秩序不破）。

## 纪元 Ω：GLM-5.3-Flash 云脑皮层

本地反射弧（OCR / 模糊匹配 / 探针）以毫秒级回答确定性事实，但**开放语义**——整屏理解、陌生界面形态、图文混读、状态推断——是纯本地栈的盲区。本纪元外接云脑：智谱 GLM-5.3-Flash 视觉大模型，十件器官（`src/vlm/`）各司其职，与本地感知保守双脑仲裁。

十器官（`test/vlm.*.test.ts` 逐件执法）：

| 器官 | 机制 | 解决的问题 |
| --- | --- | --- |
| **Ω-1 云脑客户端 `glmClient`** | 智谱 OpenAI 兼容协议 + 全抖动指数退避重试 + JSON 围栏剥壳（fetch 可注入） | 与云脑对话的可靠传输层：重试相位解相关、围栏/方言 JSON 健壮提取 |
| **Ω-2 感知编解码 `codec`** | 1568 长边 / JPEG 80 / 兴趣区裁剪 + `VlmBudget` 任务级图量与字节配额 + 视觉 Token 估算 | 云脑往返的带宽礼仪：超支在下发前被拒绝，而非事后补救 |
| **Ω-3 SoM 提示工程 `som`** | VLM 专用编号框叠加 + 中文铁律提示词族（grounding / verdict / ocr / 差分） | 把「像素绝对坐标、图外非法、不臆造」写进模型输入——云端坐标幻觉歼灭 |
| **Ω-4 元素检测 `grounding`** | `groundElements` + NMS IoU≥0.6 去冗余 + `clampBbox` 图内夹取 | 截图进、可点击元素出；云输出方言归一为仓库标准，宁空不错 |
| **Ω-5 语义 OCR `vlmOcr`** | `readTextViaVlm` / `findTextViaVlm`，匹配与本地 textReader 同律（大小写/空白不敏感） | 云端读字找字：本地 OCR 的云侧姊妹，命中返回中心像素坐标 |
| **Ω-6 效果判决 `verdict`** | `judgeEffect` 前后双图对比 → confirmed/refuted/uncertain + `fuseWithPixelEvidence` 像素双脑融合（一致加成 +0.1、分歧降级 uncertain） | L3.5 云端语义判决：「变的对不对」只有看得懂语义的脑能答 |
| **Ω-7 差分解说 `diffExplainer`** | 变化区域 + 双图 → 一句中文总述 + 区域级注解，label 对齐律 | 「哪里变了」升级为「变的是什么」；对不上号宁可丢弃注解，绝不硬凑 |
| **Ω-8 故障会诊 `diagnosis`** | `diagnoseFailure`：任务/动作/锚点/错误/屏幕文本 + 可选截图 → 根因 + 假设概率归一 + 恢复步骤（循环引用防护） | 「为什么停」的云端归因——本地会诊（qualityDoctor）的云侧会诊室 |
| **Ω-9 双脑仲裁 `arbitration`** | IoU 贪心配对 + 置信加权凸组合融合 + 一致加成 0.15 + winner 四分支 + `normalizedLevenshtein` 文本仲裁 | 本地感知与云端意见分歧时的纯数学裁决：仲裁不靠权威靠测度 |
| **Ω-10 计量治理 `metering`** | `vlmMeter` 分位台账 p50/p95（千样本窗）+ 双桶滑动窗限速（分钟×小时）+ 连续失败熔断 5 次/60s 冷却 + 全抖动 uniform(0, b·2ⁿ) | 云脑的花费与心跳可观测、可限量、可熔断 |

### 集成血脉

- **config 四新字段**：`vlmApiKey` / `vlmBaseUrl`（默认 `open.bigmodel.cn/api/paas/v4`）/ `vlmModel`（默认 `glm-5.3-flash`）/ `vlmAssistOcr`（默认 `false`）；`index.ts` 经 `configureVlm` 铸造云脑单例——config 优先于环境变量（`GLM_API_KEY` > `ZHIPUAI_API_KEY` > `ZAI_API_KEY`）。
- **SemanticSource 云脑适配器**（`createSemanticFromVlm`）：D-6 三级漏斗的 L3 语义源——宿主总线优先立法不变，宿主未供且云脑可用时缺席自铸一档，只加不自夺。
- **`semanticConfirm` 第三路径**：本地双路径（服务端 L2 → legacy tesseract）皆败后 VLM 兜底读屏；签名不变，开关关闭或无 Key 时行为逐字节不变。
- **新工具 `ask_screen`**：看屏问答——截当前干净屏 + 自然语言问题 → 云脑作答（只读不碰世界；分工律：毫秒级确定性归本地反射，秒级开放语义归云脑）。

### 设计宪法

- **零 Key 零成本优雅降级**：未配置 apiKey ⇒ `degraded:true` 零网络短路（不拨号、不编码、不发请求），本地反射层照常运转——degraded 语义贯穿十器官。
- **绝不抛异常、绝不联网的离线测试**：一切失败以返回值表达；测试经假 client / 假 fetch 注入。
- **双脑保守仲裁哲学**：本地与云端是两条独立观测信道——一致加成（判决 +0.1 / 仲裁 +0.15）、分歧一律降级 uncertain；融合框取置信加权凸组合，落在两框凸包内，永不仲裁出一条谁都没看见的框。

### 使用方法

配置任一通道即点亮云脑：

```yaml
config:
  vlmApiKey: '你的智谱 API Key'   # 或 env：GLM_API_KEY / ZHIPUAI_API_KEY / ZAI_API_KEY
  # vlmBaseUrl / vlmModel 已有默认值，按部署覆写；vlmAssistOcr: true 开启 OCR 兜底
```

点亮后 `ask_screen` 工具与系统提示词使用准则自动注入；`vlmAssistOcr: true` 激活 `semanticConfirm` 的 VLM 第三路径。审判数字：vlm 家族 127 测试 0 败（十器官 121 + 集成 6）；typecheck 0 错；build `dist/vlm` 全量产出；smoke 141 模块 import 干净。

## 纪元 Φ：自主智能环

本地栈至此已能"看得准、点得对"，但每一步仍由模型驱动。本纪元铸**四环闭环**：机器自己看世界快照（识别）、自己决定下一步（判断）、自己执行并验证（执行）、跑完自我审计并进化策略权重（进化）。高度自主的前提是立法——十器官 + 宪法 + 运行时适配（`src/autonomy/`）。

十器官（`test/autonomy.*.test.ts` 逐件执法）：

| 器官 | 机制 | 解决的问题 |
| --- | --- | --- |
| **Φ-1 目标状态机 `goalState`** | 七相 GoalPhase（planning/acting/verifying/blocked/achieved/failed/aborted），判据逐条核对、超步超时熔断、非法 spec 降级不抛 | 「任务到底完成没有」由判据账裁决，不由模型口说 |
| **Φ-2 世界快照 `worldSnapshot`** | VLM+OCR 双源复用 `arbitration` 数学仲裁融合、interactive 三态、dhash 变化门控 | 五种感知方言对表成一张总账，决策层不再逐源对表 |
| **Φ-3 策略引擎 `policyEngine`** | 七级确定性决策序：弹窗优先→判据关键词匹配点击→declare→no_effect 策略切换→技能召回→预算升级→ask_vlm 兜底 | 下一步先到先得全确定性；不确定（低置信/并列）时才咨询云脑一次 |
| **Φ-4 自主执行环 `autoPilot`** | perceive→decide→宪法 check→execute→criteriaEvidence→tick→终局熔断；时间睡眠全注入 | 环本身：任何依赖异常收敛为 error 步，绝不炸环 |
| **Φ-5 进化引擎 `evolutionEngine`** | 成败回写五策略权重 ±、失败签名教训去重升级、成功短路径蒸馏技能（reliability 复验递增）、下次运行建议 | 跑一次聪明一次：经验跨轮存活 |
| **Φ-6 场景语义缓存 `sceneSemantics`** | VLM 读屏认场景，dhash 指纹 LRU 缓存 | 「这是什么场景」不再每步重烧云脑——同屏不问第二遍 |
| **Φ-7 认识论中枢 `uncertainty`** | 香农熵 + 加权几何平均置信融合 + Beta 校准 + 三档代价决策表（proceed/ask_vlm/ask_human/abort） | 何时放行、何时问云脑、何时问人、何时收手，全凭数值说话 |
| **Φ-8 自主宪法 `autonomyConstitution`** | 六律：黑名单/分层取重/危险词扫描（复用 riskGate 同形字归一——西里尔 dеlete 也命中）/白名单外审批/destructive 硬法恒审批/卡死与超步停机 | 哪些动作允许自主做、哪些必须请示人类——高度自主的前提是立法 |
| **Φ-9 反事实规划器 `counterfactual`** | 效用 = 0.5×进展 + 0.3×信息增益 − 0.2×风险，重复动作折价，并列取信息增益高者 | 行动前沙盘预演，择优而非先到先得 |
| **Φ-10 自我审计官 `selfAudit`** | 五判定（healthy/oscillating/wasteful/reckless/opaque）四症候：震荡/浪费/鲁莽/黑箱，100 起扣评分 | 跑完回看自己的轨迹——审计官首先得自己无害 |

### 集成血脉

- **config 六字段**：`autonomyEnabled`（默认 `false`——立法者显式开启才自主）/ `autonomyMaxSteps`（默认 24，环保险丝与宪法硬顶同源此值）/ `autonomyTimeBudgetSec`（默认 300）/ `autonomyAllowTiers`（默认 `'benign'`；destructive 即使列入也恒审批）/ `autonomyVlmWhenUncertain`（默认 `true`）/ `autonomyForbiddenKeywords`（默认空）；`buildAutonomyStack` 把六字段铸成闭环栈。
- **新元工具 `autonomous_run`**（`goal, success_criteria?, max_steps?, time_budget_sec?`）：一次调用驱动整个环直到预算尽头；锚点携带 `phase` / `criteria` 账 / 自审 `verdict`/`score` / `lessons` / `next_run_advice` / 蒸馏技能。判据缺省律：goal 原文作唯一字面判据（OCR 折叠子串核对）。
- **宪法升级 `ACTION_REQUIRED` 语义**：审批是人的裁决权——`approval-required` 批了就能做，`constitution-veto` 审批也救不了；dry-run 防线天然继承（system 层 guardDryRun）。

### 设计宪法

- **默认关闭 + 宪法先行**：`autonomyEnabled: false` 是缺省状态——自主是立法者显式授予的权限；destructive 恒审批的硬法不可让渡，宪法失灵时宁可保守停机。
- **离线确定性测试**：时间/睡眠/截屏/OCR/云脑全注入（假 VLM client），零联网。
- **识别层坐标系律**：快照活在捕获图空间，执行时归一化除以快照宽高——与 `click_mouse` 同一换算链。

### 使用方法

```yaml
config:
  autonomyEnabled: true        # 立法者显式开启
  # autonomyMaxSteps: 24 / autonomyTimeBudgetSec: 300 / autonomyAllowTiers: 'benign'
  # autonomyVlmWhenUncertain: true / autonomyForbiddenKeywords: ''
```

调用 `autonomous_run({ goal: '打开系统设置并进入蓝牙页', success_criteria: ['蓝牙'] })`；锚点结构：`{phase, steps, criteria:{met,total}, verdict, score, lessons, next_run_advice, …}`。审判数字：autonomy 家族 164 测试 0 败（十器官 158 + 集成 6）；typecheck 0 错；smoke 154 模块 import 干净。

## 纪元 Ψ：万脑归一

云脑皮层（纪元 Ω）只认智谱一家。本纪元立意**不绑定任何一家**：统一抽象吃下全平台视觉模型，密钥给谁就用谁，主力挂了备补位。七模块（`src/vlm/providers/`，经 `providers/index.ts` 桶再分发；`test/vlm.providers.*.test.ts` 逐件执法）：

| 模块 | 机制 | 覆盖平台 |
| --- | --- | --- |
| **Ψ-1 统一契约 `types`** | VisionProvider 接口 + 密钥卫生律 `sanitizeError`（错误面与计量永不出现在密钥）+ 全抖动重试 `fetchWithRetry`（仅 429/5xx/网络错重试，超时不重试） | 全部（协议底座，叶子模块零依赖） |
| **Ψ-2 OpenAI 兼容适配器 `openai`** | `/chat/completions` + Bearer 鉴权 + `response_format` JSON 模式；本地服务免钥直连 | OpenAI / 智谱 / 通义兼容模式 / Kimi / 豆包方舟 / Grok / 硅基流动 / OpenRouter / Ollama / vLLM / LM Studio（一族通吃） |
| **Ψ-3 Anthropic 适配器 `anthropic`** | `/v1/messages` + `x-api-key` + `anthropic-version` 头 + image source 三字段；jsonMode 用提示词模拟 | Anthropic Claude |
| **Ψ-4 Gemini 适配器 `gemini`** | `models/:generateContent` + 密钥走 `x-goog-api-key` 头不走 URL + `inline_data` + `responseMimeType` | Google Gemini |
| **Ψ-5 平台注册表 `registry`** | 13 平台预设 + env 自动识别 + baseUrl 识别 + explicit/baseurl/env 四路解析 + custom 合成预设 | glm / openai / anthropic / gemini / qwen / moonshot / doubao / xai / siliconflow / openrouter / ollama / lmstudio / vllm |
| **Ψ-6 故障切换池 `failover`** | 按序补位 + 复用 `VlmApiBreaker` 熔断跳行 + 切换决策环形笔记（最近 10 条） | 任意多脑战斗序列 |
| **Ψ-7 探针 `probe`** | 1x1 白图 15s 体检 + `visionGuessed` 判定 + 三协议模型清单发现 + 全平台并行体检 | 全部 13 平台 |

### 兼容层命门（五大命门全守）

`GlmClient` 保持同名 class 与全部导出，构造器按 platform 委托对应适配器，**缺省 glm 路径行为逐字节不变**（错误前缀 / meter kind / GLM 环境变量语义原样）；`getGlmClient` 缺省解析增强——GLM env 优先，否则 env 自动识别他平台；`isGlmConfigured` 语义升格为「任一云脑可用」（仍不铸造单例）。整套系统（`ask_screen` / grounding / 语义 OCR 兜底 / 判决 / 会诊 / autonomy 策略咨询）随任一平台密钥自动点亮，消费面零改动。测试全程离线：`fetchImpl` 注入 + env 保存恢复法。

### 使用方法

三种点亮方式任选其一：

```yaml
# 方式一：单平台 env（零配置）——任一平台密钥在 env 即自动识别并点亮整套系统
#   GLM_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY / GEMINI_API_KEY / DASHSCOPE_API_KEY …
config:
  # 方式二：vlmProvider 显式指定平台（空 = 自动探测）
  vlmProvider: 'openai'      # 或 anthropic / gemini / qwen / moonshot / doubao / xai /
                             # siliconflow / openrouter / ollama / lmstudio / vllm
  # 方式三：再加备选链 —— 主力挂了备补位（熔断跳行按序切换）
  vlmFallbackProviders: 'anthropic,gemini'   # CSV 备选链
```

新工具 `vlm_platforms({ probe: true })`：列出 13 平台配置状态与健康（1x1 白图并行体检、15s 超时，绝不发送真实屏幕内容），附当前生效平台与备选池健康。审判数字：vlm 家族 250 测试 0 败（Ω 原 127 + providers 115 + universal 8，providers 分件 14/19/24/21/8/11/18）；typecheck 0 错；smoke 163 模块。

## 纪元 Δ：全库跃迁

器官时代既成，本纪元**不造新器官**：五个审计代理扫全库产出 52 项带证据改进点，实施军团按簇并行落地——把既有器官全部磨利。

### 六大安全修复

| 缺口 | 修复 |
| --- | --- |
| 重放/技能执行绕闸 | `replayOne` 前置共享闸门 `actionGate`：危险步（发送/支付/凭据）无令牌即拦，`replay_actions`/`run_skill` fail-fast |
| 审批令牌双花窗口 | `beginAttempt` 在途预留 + 结算，并发同令牌恰一次派发 |
| riskGate 全角折叠不对称 | 归一化迭代至不动点，ｓｕｂｍｉｔ 混淆变体不再逃逸 |
| dragMouse 零安检 | 补 `target_description` + 危险词检查，危险目的地无令牌即拦 |
| anthropic/gemini 错误面密钥 | 兜底擦除 + 单字符密钥误伤门槛 |
| 弹窗自动点击扫描缺口 | 确定/同意/是 入确认词表；恢复出厂/重置系统 入不可逆词表——「OK 恢复出厂设置」不再被判 benign 自主点击 |

### 正确性与性能

| 修复 | 战果 |
| --- | --- |
| failureMemory RRF 过滤恒真 | 无关失败记忆不再污染召回 |
| 潜意识 pHash 配错帧 | 既视感误压根除（scenePhash 记 victim 自己的指纹） |
| actionVerifier 退化指纹假阳性 | 全零/长度不等指纹不再虚报"页面变化"焚毁审批令牌 |
| doctorChannel 死代码复活 | 同链回执去重从未生效——T-3 断言升级为活实现 |
| journal.reset 残留 taskDescription | 显著度毒化根除 + 目录保证一次化 |
| BM25 O(N²)→O(N)；policyEngine 分词 WeakMap 缓存 | df 子串匹配收敛为 token 精确匹配；closedloop 基准行为零漂移 |
| OCR 负缓存覆盖 legacy；ncd lzCount 输入闸 | 不再为注定失败的识别付整帧截屏；O(n³) 上界封顶 |

### 工程治理

- 卸载 disposer 补四件单例归零（SPRT/振荡环/元素跟踪/焦点）；进化引擎 reset + 环形 200 + history 副本；goalState 2000 字符闸；counterfactual 权重夹取
- `start_complex_task` 失败报告尾附 `autonomous_run` 转轨建议（双轨互通）；serviceManager 探活升级——子进程早退 + 包体 pid 校验，端口占坑者 142ms 现形而非 8s 假等（Python `/health` 增 pid 字段）
- organCensus 去装饰化：4 件真自检 + 29 件如实标 static，hedge-actor 描述纠偏为 EMA；vlmMeter 计量接线（`configureVlm` 缺省挂表，观测闭环合拢）；自主宪法 `effectiveRiskTier` 回写轨迹（审计可见宪法升级）；openai maxTokens 1024→2048 契约对齐；LM Studio/vLLM 探针不再错发 gpt-4o-mini；英文区补译五纪元 + 7 工具 + 云脑与自主配置段（README 877→1079 行）

**审计否决（诚实）**：`Object.freeze(system)` 否决（杀死测试注入缝）；器官 API"死导出"清理否决（是交付面非死码）；telemetry 池化 GPD 分治缓议（形状被锁 + A² 自疑已在）。审判数字：epochDelta 四族 35 测试 0 败（safety 10 / perimeter 10 / infra 7 / 感知记忆 8）+ vlm 家族 250→258（+8）+ autonomy 171→189（含 bench 7，+18）≈ 净增 61；实测全套 941 测试 0 败（14 skipped 为平台性跳过）；typecheck 0 错。

## 纪元 Σ：全军升维

Δ 是修缺陷磨利；Σ 的立意升一级——**给每个模块家族升一件能力**。七件升维全部增量式落地，缺省字节等同（无 display 参数、无新配置时与 Δ 终态逐字节一致）。

| 升维 | 机制 | 价值 |
| --- | --- | --- |
| **Σ-1 云脑合议庭**（`src/vlm/providers/ensemble.ts`） | 多平台视觉模型并席作答：`normalizedLevenshtein` ≥0.7 并查集聚类 ⇒ unanimous/majority/split 三级裁决；判决多数票（平票 uncertain、`dissents` 点名少数派）；元素多源折叠喂真 `arbitrateElements`；`createEnsembleCourt` 从 registry/env 铸庭 | 单颗脑是一家之言，庭是多脑互相作证——幻觉/方言/坐标漂移须骗过整庭才能成为答案 |
| **Σ-2 自主训练营**（`src/autonomy/gym.ts`） | mulberry32 确定性任务生成 + 四世界（wizard 向导 / popup-maze 弹窗迷宫 / scroll-hunt 滚动狩猎 / danger-gate 危险门）+ sharp 合成帧 + 全注入闭环——真实策略/宪法/进化器官离线重放 | 自主环离线自我进化（跑一轮聪明一轮），零网络、零真钟、零真睡 |
| **Σ-3 断点续跑**（`pilotStore.ts` + `autonomy_resume`） | JSONL 追加式运行档案（begin/step/finish 三型事件行、重载重放、磁盘故障降级内存）；`autonomous_run` 锚点携 `resume_token`；判据回放——已 met 不重核 | 中断的自主任务凭 token 续跑；`autonomyTracePath` 配置后跨进程存活 |
| **Σ-4 计划自愈**（`orchestrator.ts`） | 子任务失败不再立即 fail-fast——带失败上下文重规划一次（闭包守卫只愈一次），新计划整体接管剩余队列（id 续编防撞号），失败行改判 `[RECOVERED]` 留痕；无 chat / 已愈过 / 空计划 / 环形 ⇒ 原 fail-fast 逐字不变 | 长链任务一次局部失败不再全盘报废；自愈不可能时旧语义原样 |
| **Σ-5 多显示器感知** | `display` 参数全链贯通（screen.py / routes.py / adapter / physicalBackend / takeScreenshot）：全屏虚拟坐标系按显示器矩形最上游裁剪；顺手挖出并修复 `/displays` 从未真正工作的潜伏 bug（ctypes 无 MONITORINFO 致枚举恒空——手写 MONITORINFOW 结构体）与 DPI 逻辑/物理像素错位（包围盒比例映射） | 副屏可截可点，锚点携带目标屏 origin/resolution；缺省无 display 字节等同 |
| **Σ-6 HMAC 质询应答式身份证明**（serviceManager + routes.py） | 探活发随机 nonce，服务用共享密钥 HMAC-SHA256 回签，`timingSafeEqual` 验签（回签不泄密钥）；旧服务回退 pid 等值 | 根治 Δ 留案的启动器别名 pid 盲区：异 pid+正确回签 = healthy；错回签快报 `port_squatted`，不再误报也不傻等 |
| **Σ-7 遥测仪表盘**（`metricsDashboard.ts` + hooks.ts 打点） | `metrics_dashboard(section?)` 四分区文本仪表盘（≤80 列等宽对齐）：工具延迟分位 / 云脑用量 / 自主战绩 / 守卫拦截计数；守卫 deny 分支喂 `telemetry.note` 激活计数 | 全系统健康折叠为一张表——纯只读、零配置依赖、恒挂载 |

训练营战绩（`test/autonomy.gym.test.ts`）：wizard 3 步达成；popup-maze 弹窗优先律先 dismiss 多付一步仍达成；scroll-hunt 死链两连后触发策略切换律（轨迹含 scroll）；danger-gate 点击账本只有「稍后提醒」——宪法硬法之下「立即支付」绝不被点；四轮全成 ⇒ 蒸馏 4 技能、click 权重 1.0→1.4。

### 使用方法

```yaml
config:
  autonomyTracePath: 'C:/dsh/autonomy-trace.jsonl'   # Σ-3：非空 ⇒ 运行档案落盘，resume token 跨进程存活（缺省空 = 纯内存，行为不变）
```

- **合议庭（Σ-1）**：编程面铸庭（经 providers 桶导出，密钥走各平台 env）——`createEnsembleCourt({ provider: 'openai', extraProviders: ['anthropic', 'gemini'] })`；问询面 `askText / askVerdict / askElements`，`fetchImpl` 可注入
- **训练营（Σ-2）**：`new AutonomyGym({ seed: 4242 }).train(4)`——四世界各一轮；同 seed 两次 train 逐字段一致
- **续跑（Σ-3）**：`autonomous_run` 非达成终局锚点携带 `resume_token`（如 `AUTO-1a2b3c4d`）⇒ `autonomy_resume({ token })` 判据回放后续跑；已 done 的 token 诚实拒绝
- **跨屏（Σ-5）**：`take_screenshot({ display: 1 })`——0 起索引，锚点携带 `display` 与目标屏 `active_display`（origin/resolution）；不带参数 = 主屏现状，字节不变

审判数字：纪元 Σ 新增 63 测试（vlm.providers.ensemble 16 / autonomy.gym 8 / epochSigma.plan 7 / epochSigma.resume 7 / epochSigma.identity 11 / epochSigma.display 9（真 FastAPI 端到端 + TS 纯逻辑）/ epochSigma.dashboard 5）；新工具 `autonomy_resume`、`metrics_dashboard` 与 `take_screenshot` 的 `display` 参数；新配置 `autonomyTracePath`。

## 纪元 Θ：内核进化

技能库早有系谱与灭绝剪枝（Q-5），数学内核却仍是全库写死的字面量——容差、门限、置信线散落在器官深处。本纪元给内核同等待遇：**约 50 个数学内核普查在册，首批 18 键生产接线**（`registerProductionKernels` 实测清单）——带血统、带证据门、带护栏与回滚；训练营里用 ground truth 离线进化，实验室与生产隔离、晋升须显式（`src/kernel/`）。

四模块（`test/kernel.*.test.ts` + `test/epochTheta.wiring.test.ts` 逐件执法）：

| 模块 | 机制 | 解决的问题 |
| --- | --- | --- |
| **Θ-1 注册表与证据账本**（`registry.ts`） | `KernelParamSpec{key,organ,default,min,max}` 幂等注册 + bounds 夹取（区间外不存在状态）+ drift 百分比 + snapshot/restore + **promoteFrom 实验室→生产晋升**（generation+1、evidence 继承、拷贝非移动）；EvidenceLedger 每 key 滑窗 200；getOrDefault 未注册回退 | 内核阈值有了唯一权威源与可行区间；未注册 ⇒ fallback 原样回声字面量——生产缺省零行为变化的关键缝 |
| **Θ-2 在线校准器与参数血统**（`calibrator.ts`/`lineage.ts`） | optimalThreshold 网格扫描（样本 <8 诚实 null，致敬 calibration.ts 下限律）；四护栏（minEvidence 30 / maxStepPct 10% 值域 / rollbackDrop 0.05 / minPostEvidence 20）；回归守卫自动回滚上代；血统 promote/extinct（至少留 1 条、fitness 冠军例外存活——skillLibrary 灭绝剪枝的血统直译）/fitnessTrend | 进化可回滚、可审计、可复现——一次一小步，坏血统自动出局 |
| **Θ-3 训练营实验室进化**（`gym.ts`） | perceive 闭包 ground-truth 对账：dhash 判决 vs 世界 stateKey 真相、元素融合 vs 控件真相、策略选择 vs 世界立法的正确下一步；实验室自建独立注册表**绝不触碰生产单例**；每轮收官 calibrator.tick()；GymReport.kernel 摘要 | 内核进化有免费且无穷的监督信号——虚拟世界自带对账单，真实世界拿不到 |
| **Θ-4 生产接线** | 18 键 / 十读点 getOrDefault 化，七消费文件（arbitration 双参数+文本相似度 / worldSnapshot 容差+仲裁传参 / policyEngine 置信与并列阈 / uncertainty 校准与三档 / OCR 词置信截断 / NMS IoU / skillLibrary 场景门与加成）——**未注册场景行为逐字节等同**；启动幂等注册（值全默认 ⇒ drift 空）；仪表盘第五分区 kernel | 注册表现值 = 字面量 = fallback——入册只是为 set/promoteFrom 开合法通道；漂移可在仪表盘观测 |

### 设计宪法

- **实验室-生产隔离**：进化绝不泄漏——晋升唯一通道是显式 `kernelRegistry.promoteFrom(gym.lab.registry)`。
- **证据门**：证据不满 30 观测不动参数——不满月不换血，字面量继续服役。
- **步长护栏 + 回归回滚**：单次 ≤10% 值域，一次一小步；成功率跌出上代 fitness −0.05 自动回滚上代值。
- **缺省零行为变化**：不注入内核时训练营轨迹与纪元 Σ 逐字段一致；生产入册值全默认 ⇒ drift 空。

### 使用方法

- **离线进化**：`new AutonomyGym({ seed }).train()` 训练 → `gym.lab` 检视台账与血统 → `kernelRegistry.promoteFrom(gym.lab.registry)` 晋升。
- **手动调参**：`kernelRegistry.set(key, value)`（越界自动夹取，回执带 clampedTo）。
- **观察漂移**：`metrics_dashboard('kernel')`——每键一行（key/器官/现值/缺省/漂移%/证据/代际）。

审判数字：纪元 Θ 新增 49 测试（kernel.registry 16 / kernel.calibrator 23 含血统 7 / kernel.gym 5 / epochTheta.wiring 5）0 败；无新工具、无新配置（入册不设开关，恒入册、值全默认）。

## 纪元 Ξ：内核进化·全域潮

Θ 立了进化基建并接线首批 18 键；Ξ 把普查在册的内核尽数纳入进化版图，并补齐生产闭环——三路并进（`src/kernel/`）。

| 路线 | 机制 | 价值 |
| --- | --- | --- |
| **二梯队全接线（Ξ-D）** | 注册表 18→55 键（第二梯队 37 键，覆盖判决 / 验证 / 记忆 / 治理 / vlm 五族 12 文件读点；另宪法两键生产册入册）。诚实否决两处立档在案：BM25 k1/b（模块立法「值即设计非旋钮」——排名函数的形状参数不降格为旋钮）、policyEngine 七处效用基线（只在日志里排序次序，进化价值低） | 普查在册内核全部获得可行区间、器官归属与晋升通道；结构序守护双保险（specs 区间不交叠 + 消费处 Math.min/max 兜序——施密特迟滞带、语义 ≥ 几何证据律不被旋钮拆毁） |
| **生产自监督闭环（Ξ-B）** | 免费证据恒开：判据匹配点击的成败即 `policy.matchConfident` 对账（纯内存记账，零额外等待）；慢真值门控：`kernelEvolutionEnabled` 开时 click/type 走 settle-verify 稳定帧作真值，校准 `world.hammingTolerance`——快路径判决用慢而准的路径对账 | 生产环境白得证据流：不进化也记账，开闸即有粮；关闸零额外 await（连微任务都不添，性能铁律）；观察式旁路绝不改写 outcome / 轨迹 / 锚点 |
| **进化成果持久化与编排（Ξ-A）** | `KernelStore` tmp+rename 原子存档（params / evidence / generations 三账，checkpoint 同律）+ `kernelStatePath` 配置 + `EvolutionConductor` 节流 tick（5 分钟窗——高频用户消息只记账不进化）+ session 边界钩子（入册后存档复载 / 卸载段 checkpoint 后落盘） | 进化成果跨会话存活；参数换血需要窗后新证据（窗是进化稳定器，不是性能补丁）；缺省全关零行为变化 |

### 多代进化收敛证明（本纪元王牌）

容差故意设错 8（已知良好值 3），`trainGenerations(10, 4)` 实测几何收敛：

```
8 → 5.9 → 4.075 → 3.5375 → 3.2687 → 3.1344 → 3.0672 → 3.0336 → 3.0168 → 3.0084 → 3.0042
```

末值 3.004，与良好值 3 偏差 0.14%；6 代即到 3.067（2.24%）。血统 16 代可溯、方向 10/10 正确、单步恒 ≤ 护栏 0.7（单步 ≤10% 值域的 Θ-2 宪法全程无违）。

### 使用方法

```yaml
config:
  kernelStatePath: 'C:/dsh/kernel-state.json'  # 进化成果存档（缺省 '' = 纯内存）
  kernelEvolutionEnabled: true                 # 生产进化总开关（缺省 false = 只记账不进化）
```

实验室多代进化：`new AutonomyGym({ seed }).trainGenerations(10, 4)` → 检视 `report.trends`（血统趋势）/ `report.converged`（已知良好值收敛探针）→ `kernelRegistry.promoteFrom(gym.lab.registry)` 显式晋升。

审判数字：纪元 Ξ 新增 33 测试（kernel.store 10 / kernel.conductor 7 / kernel.selfverify 5 / kernel.generations 6 / epochXi.wiring 5）0 败；新配置 `kernelStatePath`（''）/ `kernelEvolutionEnabled`（false）；新 API `AutonomyGym.trainGenerations(gens, rounds)` / `EvolutionConductor.maybeTick` / `KernelStore.save·load·applyTo`；无新工具。

## 纪元 Λ：开箱即亮

Ψ 让十三颗脑可选，但新装用户一颗未配：云脑全黑，`ask_screen` 恒降级。本纪元立意**装上即亮**——五级解析链按序点亮第一盏能亮的灯（`src/vlm/connection.ts` / `autoAdopt.ts` / `onboarding.ts`）：

| 级 | 路径 | 机制 |
| --- | --- | --- |
| ① | 显式 config | `vlmApiKey` / `vlmProvider`（Ω/Ψ 既有路径，逐字节不变） |
| ② | 连接存档 | `~/.dsh/vlm-connection.json`（`DSH_VLM_CONNECTION` 可覆写；tmp+rename 原子写 + 防御性消毒读 + chmod 0600 尽力）——重启 `apply()` 读档自动续连：用户切过什么，重启还是什么 |
| ③ | env 自动识别 | 任一平台密钥在 env 即点亮（Ψ 既有） |
| ④ | 本地自动接管 | 轻叩 Ollama 11434 / LM Studio 1234 / vLLM 8000 的 `/models`（串行、无鉴权头、单候选 1.5s 止损），视觉模型名优先（vl/vision/llava/minicpm/moondream/qwen-vl 命名家族）——免密钥零配置即用，`via:'auto-adopt'` 存档 |
| ⑤ | 向导弹出 | `startOnboarding` 环回 HTTP 服务 + `system.openUrl` 开浏览器；fire-and-forget 绝不阻塞装载，失败静默 |

**向导页**（onboarding.ts 内嵌单文件 HTML，离线无 CDN，中文 UI）：13 平台卡片单选（环境就绪绿点、本地免钥徽标）、密钥输入（本地平台提示免钥）、测试连接（`probeProvider` 探活延迟）、获取模型列表（`discoverModels` 下拉）、保存并启用（ConnectionStore 存档 + `onConnect` 热应用 + **迟到注册**——连接成功后补注册 `ask_screen` 工具与提示词段，宿主允许）、断开连接。**安全律**：只绑 127.0.0.1（非回环入参强制归环回）、密钥只回显 `maskKey` 打码形态、请求体 32KB 上限（413）、端口占用 +1..+8 回退（18432..18440）、30 分钟空闲自动关。

**两工具恒注册**（无模型时恰是最需要的时刻）：`switch_vision_model(platform, api_key?, base_url?, model?)`——探活通过才切换（1×1 白图先探后切，失败零落档）、存档 `via:'tool'`、`resetGlmClient` 重铸单例（下游十器官每次现取 `getGlmClient` ⇒ 全库即时生效；热应用失败如实注明「存档已写未生效」）；`vlm_wizard()`——随时重开向导（模块级服务单例，地址跨调用稳定）。`ask_screen` 无模型降级的 `next_step` 现在指路 `vlm_wizard`。

### 使用方法

三种点亮方式沿用纪元 Ψ（env 自动识别 / 显式 `vlmProvider` / 备选链），本纪元补**第四种——什么都不配**：本机跑着 Ollama/LM Studio/vLLM 即被自动接管，开箱即亮；全无则向导页自动弹出，用户贴一次密钥两分钟内即亮。④⑤ 两级各设开关：`vlmAutoAdoptLocal: false` / `vlmOnboardingEnabled: false`。

审判数字：纪元 Λ 新增 46 测试（vlm.connection 16 / vlm.onboarding 15 / vlm.tools 7 / epochLambda.onboarding 8）0 败；新工具 `switch_vision_model` / `vlm_wizard`；新配置 `vlmAutoAdoptLocal`（true）/ `vlmOnboardingEnabled`（true）/ `vlmOnboardingPort`（18432）。

## 世界性创新纪元潮（Ρ·Γ·Υ·Η·Κ·Π·Μ 及续笔）

Λ 之后项目对准业界三大未解之痛——**注入不可防（Ρ/Π/Β）、token 太贵（Γ/Γ2）、agent 不长进（Υ/Κ/Μ/Η/Ι/Τ/Ε/Ν）**——按既有纪元文化（设计 + 接线 + 执法测试 + 报告）发起一整代创新施工：四波共落地十七项，新增 163 项执法（并入全库 1295/0）、六个新模块（`src/sleep` / `src/notary` / `src/federation` / `src/selfmodel` / `src/prophecy` / `src/vlm/refute`）、新工具 `federation_sync`、新配置 25 键。蓝图与实施总账见 [INNOVATION.md](INNOVATION.md) 与 [GENESIS.md](GENESIS.md)，此处一行一件：

| 纪元 | 机制 | 解决的问题 |
| --- | --- | --- |
| **P1 地基速修** | ioMutex 排队超时（队列不毒化）、沙箱重放令牌换 CSPRNG、系统级热键黑名单（win/meta 别名折叠、和弦排序无关匹配） | 创新潮前置的真实缺陷清障 |
| **Ρ 双钥公证锁**（默认开） | 不可逆动作放行前的四通道语义公证：模型自述 ∪ OCR 实读 ∪ UIA 控件名，全过 normalizeForRisk 不动点归一（leet/同形字免疫）后 fail-heavy 取最重；语义握手 fuzzyIncludes 双向（描述与实读不符 ⇒ 拒绝并要求重述）；click_element 安全洼地收编同闸 | 提示注入下的不可逆操作防护——注入可骗模型，骗不了屏幕实渲染的像素与控件名 |
| **Γ/Γ2 注视经济** | 编码坐标→源图坐标反算纯函数（往返 ≤1px）+ 中央凹合成编码（中央原生/外围降采样、sharp 缺席诚实回退）；Γ2 inset 主图降采样 + 中央原生凹窗 + 分段反算——bench 实测 token −75.00% / JPEG 字节 −67.8%，凹窗保真 ≤JPEG 级容差 | 单位 VLM token 的期望信息增益最大化：屏幕信息密度高度不均，整图等分辨率编码是浪费 |
| **Υ 认知睡眠**（默认关） | 六幕离线整合（回放结算→技能蒸馏→免疫整合→内核校准→轨迹审计→晨报）+ 幂等水位线（同状态二睡六幕全 noop）+ 逐幕预算宁短勿挂 | agent 的记忆/技能/参数获得系统性离线巩固阶段——睡一觉，自带报告 |
| **Η 认识论闭环**（默认开） | adviseAction 四维裁决（错误代价 × Beta 校准置信 × 云脑在否 × 预算余量）插宪法之前；Φ-9 效用分破平；感知接场景语义同屏缓存 | agent 在数学上该问人的时刻问人——弃权（abstention）成为一等公民动作 |
| **Κ 惊异课程**（默认关） | 生产转移表惊讶按屏型聚合出谱 + 软最大加权采样 P(type)∝exp(β·surprise)——在哪跌倒就在哪加练 | 部署端惊异谱反哺课程生成：「生产→课程→进化→生产」外循环 |
| **Π 行为公证** | 锚自链 sha256(canonical 含 prevAnchorHash) + 零依赖 DER/RFC3161 时间戳客户端（信封/物证双核验）+ verifyNotary 四绿章（链完整/MMR 在册/时间戳锚/重放一致）+ `quality_checkup` 第五动作 `notarize` | 企业合规：「这段自动化操作未被篡改且可复现验证」的密码学证明 |
| **Μ/Μ2 万脑联邦** | EvidenceLedger 每 key 铸 Laplace(1/ε) 噪声直方图摘要 + 三道闸掺入（本地零证据不掺/份额上限/信任折减——远端证据只喂账本不直写值）；Μ2 拜占庭鲁棒聚合（k≥3 逐格中位数 + 离群检疫喂信任账） | 器官参数的差分隐私联邦进化：单宿主经验太少，跨宿主共享又过不了隐私墙 |
| **Ι 自我模型**（默认开） | （动作类×场景桶）衰减 Beta 胜任度后验（半衰期 168h、冷启动诚实 null），认识论闸门换装经验校准置信 | agent 在自己历史上反复失败的格子前真正知道怕 |
| **Τ 干预即教育**（默认开） | 验收式消费成功 = 特权正示范（用户背书 × 世界验证双证据）；用户拒绝 = 负示范（回避清单降档）；隐私铁律：type_text 只记长度桶 | 人类审批从闸门升格为教材 |
| **Χ 沙箱重放证词** | 虚拟屏确定性重放逐位比对指纹序列——绿 = 可复现、红 = 首分歧步精确定位、真机段恒诚实 n/a | Π 公证的第四绿章从 n/a 转绿 |
| **Ε 预言引擎**（默认开，纯审计旁路） | 动作前经世界模型铸预言（期望屏型 + 概率），动作后首帧感知对账三态落账（hit/miss/no-model）；环形 500 错题本 + 结算回灌世界模型 | agent 的世界观第一次有了考试（Dyna 式） |
| **Β 反驳法院**（默认开，单脑诚实缺席） | 不可逆动作派发前请异构第二脑「请反驳」：refuted 即拦（令牌不烧）、upheld 放行注记、uncertain 缺席审判零行为 | 注入须同时骗过主脑 + 像素公证 + 异构反驳脑三道防线 |
| **Ν 探索经济学**（默认开） | 探针通道按学习到的 bitsPerMs 后验择序 + 累积熵减 ≥0.5 bits 即停（数学上永不砍掉还能改写判决的通道） | 实验预算按信息价值分配，判决语义零变化 |
| **Ζ/PyS 收尾** | checkpoint 加性 selfModel 段 + 睡眠④幕标定建议书（「睡眠出建议、白天做决定」）；Python UIElement 增 score 真值字段、TS 双态语义（真值在场无 assumed 标记 / 缺席旧方言逐字节） | 持久化闭环 + OCR 置信从「假设值」升格「测量值」 |

## 器官潮 W1–W5：韧性 · 自律 · 活意图 · 身体外延 · 收官过秤

创新潮之后连续五批器官潮（多器官并行交付 + 专属集成接线，执法册全部在 [GENESIS.md](GENESIS.md) 登记），把旗舰命题推向执行层、离线安全、长跑自纠偏与物理外延的深水区。W5 收官口径：全量 2018 用例、typecheck 0 错、242 模块烟测干净（1 例环境暴露 fail 如实登记，见 DEBTS）。

- **W1 执行与感知韧性（九器官 + 集成接线，执法 169/0）**：执行层四连改（ROI 三区判决 / UIA 动作前预检 × 焦点短路 / 词级质心 + 网格重试 / 稳态门）、**带外确认码**（CSPRNG 6 位 + 恒定时间比较——模型可见面绝无码，用户不在场即无法伪造同意）、免看门控（dHash 未变跳过重型感知，实测跳过率 50%）、噪声诊所（四维感知噪声注入）、EXP4 上下文老虎机、失败根因归因链（三类根因鉴别试验）、稀疏 SoM + 抗遮挡标签、Zoom 复核（低置信/小目标/拥挤三触发 + 8 次任务级预算）、视觉经济（三路注视路由 + requote 预算弹性）。
- **W2 离线韧性与成本自律（九器官 + 集成接线，执法 173/0）**：离线批准队列（用户离开 ⇒ 不可逆动作连同证据链入暂存队列，晨报列清单 + `adjudicate_approval_queue` 批注式批量裁决）、审计 fail-closed × 探针 fail-open 的刻意不对称 + 新鲜度探针、bench 可信度（契约核查器 + 方差感知 SPRT 回归门）、租约黑板 + 实证仲裁、恢复疗效账本（(症候×根因×动作) Beta 后验）、记忆操作老虎机（分类级 Thompson 采样）、金丝雀试演（高风险链前可逆微探针先演后 commit）、成本级联路由（三因子分诊 + 便宜臂确定性校验，实测节省率 0.55）。
- **W3 活意图与自纠偏（九器官 + 集成接线，执法 155/0）**：逆转托管（动作级 WAL + 补偿预案，无预案 fail-closed 拒派）、参数化通用技能（DTW 对齐 + 反统一归纳出参数洞）、脏矩形增量编码（视频 P 帧式感知，实测 token −74.6%）、DAG 就绪层流水线（读写分离三防线 + takeGranted 续跑）、活意图漂移（`steer_choice` / `steer_answer`——屏幕离目标太远时把 A/B/C 单键题交回用户）、反事实岔路卡（失败终局相铸三候选卡换支重放）、探索前沿（UCB 择路，只在恢复态出手）、过程评分器（步级四通道 credit assignment）。
- **W4 第四批器官潮（九器官 + 收官接线，执法 133/0 + Python 自测 58 断言）**：宏重放（kind:'macro' 扩展字 + 低可靠度先虚拟排练，实测决策调用 −71.4%）、策略联邦（技能差分隐私上传：指纹 + 槽统计中位数，k≥3 聚合检疫 + 本地命中 2 次才激活）、可逆性体系（三级分级 + dispatchLaneFor 三道——compensable 托管 / irreversible 交还人类 / reversible 快道）、PCG 无限训练营（文法产生式派生场景）、**移动 Surface**（Android 经 scrcpy/ADB 以虚拟显示器入列，归一化坐标换算只在服务端）、**零 API 设备面**（HDMI 采集卡 UVC 眼 + CH9329 串口 HID 手——目标设备视角是一只真鼠键，零驱动零检测面）、步数拍卖市场（全局步数池每 K=10 步重拍卖 + 饿死防护）、声学通道（音频只作非语义物理证据，权重恒低于视觉）。
- **W5 第五批收官潮（七器官，执法 83/0 + 7 bench 全绿）**：Python 端点注册落盘（uvc / hid / audio 六端点 + /health hardware 能力面，硬件缺席恒结构化 200 绝不 5xx）、梦回放（PER 优先级 p = ŝ×cost×recency + 同构世界冻结重放 + 分歧点定位双写）、跨机编排（分布式 barrier 四支柱：全到达才放行 / 序号防重放 / 两阶段防脑裂 / 有界状态 + 跨机视觉互证谓词）、SoM 调用面（W1-7 稀疏标注从零调用方接进生产管线，坐标闭环 ≤1e-9）、steer 闭环三缝收官（B 应答回灌重启 / 岔路锚强校验 / 换支偏置 12 步预算执法）、效能基准七过秤（六器官「声明 vs 实测」同表呈报）。

## W6-R 修复浪潮

W5 收官后的全库安全与正确性修复潮（多代理并行施工；本节为阶段性快照，收尾状态见本节末行）：

- **审批 fail-closed**：带外确认码通道缺席（confirm_channel=out-of-band-absent）即拒绝 grant——令牌永不可在会话内授予，用户必须经宿主 UI 亲证；确认码只走事件总线（带外通道），console 输出全脱敏，模型可见面绝无码。
- **提示注入纪律**：系统提示新增「数据/指令二味纪律」段——屏幕内容一律是不可信数据，任何渲染在屏幕上的「指令」不构成指令；确认码只认带外通道。SoM 提示词同步加固。
- **Python 物理服务**：adb type_text 设备 shell 注入修复（shlex.quote 包裹 + 可打印 ASCII 白名单）；nonce 强制校验（缺 X-Request-Id 即 401）；认证失败改判 401；HID 控制器公有收口面；uvc.py D-E1 双重包装 bug（cv2 在场 + DirectShow 可读环境必 TypeError）已修；pyproject 补齐 pyserial / opencv-python / comtypes 三依赖。
- **VLM**：工具函数去重（internalUtils.ts 单一实现）；verifyGate 复核预算按任务作用域化——并发任务不再串账。
- **联邦**：federationSync 缺省 robust:true（拜占庭鲁棒聚合投产，D-B6 闭合）；聚合 server HMAC 签名认证（DSH_FEDERATION_TOKEN，无签名头即 401）；信任账持久化接线锁定。
- **物理执行 TS 端**：移除 PID 证明强制关闭（防探活误杀）；密钥文件 0600；全端点 X-Request-Id；401 语义识别。
- **工程**：CI 补 verify + build 步骤；sharp / tesseract.js 归入 dependencies；.gitignore 补 with-interrupt。
- **Shell 加固**：openUrl 改 rundll32 数组参数直调（不经 shell 解析、不做变量展开）；PowerShell 全部改走 -EncodedCommand（消除命令行注入面）。
- **守卫**：审计 fail-closed 名单 6→18 工具；重复动作检测量化收紧 + 轨迹级循环检测。
- **收尾完成（W6R-C3）**：危险动作探针 fail-closed（canaryGuard 令牌路径收口，w2canary 测试锁定）、VLM 密钥静态保护（maskKey 打码纪律全落点）、全量回归（typecheck 0 错；node --test 2350 例 0 fail；verify 23/23；doctor 85.5 分、sec.\* 零命中；dist 与 src 同步）——三项均已落地。

## W8 世界创新修复潮

W6-R 之后「已造未通电」器官接线与结构性债的清偿潮（2 批 18 修复代理 + 2 收尾复核，执法册 w8.\* 11 册 96/96）：

- **巨文件拆分**：gym.ts 3377→1557+6 卫星件、approval.ts 1584→97 桶+9 卫星件、autonomy/runtime.ts 1581→989+6 卫星件（导入面零改动，执法册锚定面不动）。
- **判据证伪**：criteriaEval 器官在同一判据 DSL 上长出否定判据（`mustNotAppear:` /「不得出现：」前缀，OCR 命中禁词 ⇒ violated ⇒ 终局 failed）+ fuzzy 容错（⌈m/6⌉ 六字符容一错）+ OCR 缺席诚实降级；autoPilot 环内只执法否定面，肯定面归 execute 通道（极性分工红线）。
- **循环破除**：autonomy↔tools 包级循环断开——canaryLogic 对 autonomy 零 import、autoPilot 对 tools 零 import，依赖方向恒 tools/guards→autonomy 单向。
- **记忆升级**：failureMemory 显著性感知淘汰（新近性/去重命中/根因拥挤罚 + 独苗保护硬配额，记录五元组零改动）；selfmodel 24bit 两段式场景桶（16bit 粗段旧桶逐位同律 + 8bit 细段密度位图，旧桶键诚实迁移）。
- **预言与公证**：prophecy 粗层屏型桥（精确键查无 ⇒ dhash 粗格回退一问，predictedVia:'coarse' 诚实标注）+ 惊异喂养通道生接线（结算失手自动喂进化引擎）；重放公证 replayWitness（replay_actions / run_skill 双接线——步指纹 + 三态结局 + 整体成败铸入 notary 锚，公证缺席诚实降级）。
- **单源化**：federation-server.mjs 薄 re-export `dist/crossMachine.js`（barrier 状态机唯一权威源，双实现口径债消解）。
- **CI Linux**：物理服务 e2e 步骤落地（ubuntu 可编辑安装 dsh_physical → 预起 tcp:8421 → adapter 真服务路径 + /dev/shm 真机执法——待首次 push 验证）。
- **bench 谓词**：`windowCount` 窗口计数谓词（titleRegex 锚定目标窗口域 + equals/gte/lte 可组合合取——「跑前跑后窗口数不变/归零」的机器等价物）。
- **接线收口与修法**：SoM 种子供源 / 梦失败源 dreamFeed / 增量编码消费方（contextManager，缺省关）三线通电；悬挂测试根治（全量 cancelled 首次归零）；repeatActionGuard 叶级数值距离（半格悬崖收口）+ auditGuard 只读子动作分流。
- **全量回归（W8-C2 实测）**：2472 用例 / 2467 通过 / 0 fail / 0 cancelled / 5 skip（环境守卫）；verify 23/23 + BC 零命中；compileall 0 错；doctor 90.5（crit/major/minor 0/0/0，info 40 = 21 豁免 + 19 未豁免，sec.\* 零命中）；dist 272 件与 src 对齐；tsc 0 错。DEBTS 43→47 条（翻案闭环 11 / 部分闭环 2 / 半闭 1 / 新增 4）。

## 工具列表

| 工具名称 | 描述 | 核心参数 |
| --- | --- | --- |
| `take_screenshot` | 截屏 + SoM 叠加 + 压缩 + 滑动窗口 + 弹窗传感 + 变化门控 + 多屏感知（纪元 Σ-5） | `region`, `force?`, `display?` |
| `click_mouse` | 归一化坐标点击，内置 dHash 效果验证 + 自动记忆 + Z-2 交互性闸门（静态正文上的左键点击被结构化拒绝） | `x`, `y`, `button`, `confidence?`, `target_description?`, `allow_text_click?` |
| `type_text` | 焦点处输入文本，支持跨平台一键清空 | `text`, `clearFirst` |
| `scroll_page` | 四方向滚动 | `direction`, `amount` |
| `press_hotkey` | 组合键（键位白名单，防注入） | `keys` (数组) |
| `drag_mouse` | 拖拽（四拍时序：移→按→移→放） | `startX/Y`, `endX/Y` |
| `dismiss_popup` | 零副作用元工具：强制 ReAct 重新分析 | 无 |
| `switch_tab` / `switch_window` | 标签页 / 窗口切换（含降级路径） | `direction` / `titleKeyword` |
| `click_element` | 按 ID 点击（需开启元素模式，短时缓存防 ID 漂移） | `id` |
| `extract_ui_vision` | 本地视觉模型精确提取（可选） | 无 |
| `start_complex_task` | Planner-Actor 编排引擎 | `userRequest` |
| `autonomous_run` | 自主智能环元工具（纪元 Φ，需 `autonomyEnabled: true`）：识别→判断→宪法→执行→验证→进化一次调用闭环 | `goal`, `success_criteria?`, `max_steps?`, `time_budget_sec?` |
| `autonomy_resume` | 断点续跑（纪元 Σ-3，需 `autonomyEnabled: true`）：凭 `resume_token` 重载运行档案、判据回放（已 met 不重核）后驱动同一自主环续跑 | `token` |
| `zoom_inspect` | 区域裁剪放大 + 细网格，二阶段精定位 | `x`, `y`, `half_size?` |
| `find_text` / `read_text` | 文字→精确坐标（内置交互性探针判决）/ 区域文字读取（需 `enableOcr`；URL 自动浮出） | `keyword` / `x?`,`y?`,`half_size?` |
| `ask_screen` | 看屏问答：截干净屏 + 自然语言问题 → GLM 视觉模型作答（需 `vlmApiKey` / `GLM_API_KEY`；只读不操作） | `question` |
| `vlm_platforms` | 平台花名册与体检（纪元 Ψ）：13 平台配置状态 + 当前生效平台 + 备选池健康；`probe:true` 并行体检（1x1 白图，绝不发送真实屏幕内容） | `probe?` |
| `switch_vision_model` | 手动换脑（纪元 Λ）：1×1 白图探活通过才切换 → 存档（via:'tool'）→ 热应用重铸单例（ask_screen 等云脑器官即时跟脑；探活失败零落档） | `platform`, `api_key?`, `base_url?`, `model?` |
| `vlm_wizard` | 打开浏览器连接向导（纪元 Λ）：无 Key 用户的第 0 步——回环向导页选平台/贴密钥/试连/保存即亮（via:'wizard'，存档+热应用） | 无 |
| `metrics_dashboard` | 五分区遥测仪表盘（纪元 Σ-7 + Θ-4）：工具延迟分位 / 云脑用量 / 自主战绩 / 守卫拦截计数 / 内核参数台账，≤80 列文本表 + 机读 health 锚点 | `section?` |
| `probe_interactivity` | 三通道交互性判决：UIA 点查询 → 悬停光标形态 → 悬停重绘 | `x`, `y` |
| `open_url` | URL 安检（scheme 白名单 http/https + 噪声提取）→ 系统默认浏览器跳转 | `url`（裸 URL 或含 URL 文本）, `reasoning?` |
| `diff_view` | 最近两截图的视觉差分：红框变化图 + 区域坐标清单 | 无 |
| `remember_ui` / `recall_ui` | 场景式 UI 记忆写入 / 自然语言召回 | `description`,`x`,`y` / `query` |
| `replay_actions` | 重放日志中的动作序列（宏） | `confirm`, `from_step?`, `to_step?` |
| `save_skill` / `match_skill` / `run_skill` | 技能沉淀 / 可靠度匹配 / 一键执行（成败回写可靠度） | `description` / `query` / `id`,`confirm` |
| `request_approval` / `grant_approval` | 人机协同审批闸门（需 `enableApprovalGate`）：不可逆动作先铸令牌（一次同意覆盖整任务重试窗口；用户离开可 stage 入离线队列）；grant 需用户带外 6 位确认码（W1-2），带外通道缺席即 fail-closed 拒绝 | `description`,`consequence?`,`stage?` / `token`,`grant`,`confirm_code?`,`note?` |
| `adjudicate_approval_queue` | 离线批准队列批量裁决（W2-1）：晨报列出暂存的不可逆动作，用户一次批注式裁决多项（grant 复用 amendment 协议、过期保守拒绝、已裁决拒翻案） | `ids?`, `grant`, `note?` |
| `what_if` / `swarm_report` | 反事实推理（换条路好多少——Laplace 路线率 + Cohen's h）/ 群体智慧报告（需 `enableJournal`） | `scenario` / 无 |
| `quality_checkup` | 质量医生门诊（D-4 + 纪元 Π）：诊断代码基因与因果链、显式授权下的机械修复、教训与自审；第五动作 `notarize` 出公证四绿章报告（需 `enableQualityDoctor`） | `action`, `files?`, `authorize?`, `max_risk?`, `dry_run?` |
| `swarm_dispatch` | 多智能体协同（一台躯体多重心智，需 `enableSubAgents`）：按角色孵化子代理 → 以在场者行动 → 汇报 → 仲裁交叉验证结论；开市后附步数拍卖摘要面（W4-7） | `action`, `specs?`, `findings?`, `confidence?` |
| `shape_environment` | 环境重塑（需 `enableEnvironmentShaper`）：raise / maximize / move / set_zoom / set_contrast，严格 LIFO undo 账本；能力探测先行、`restore` 复原 | `action`, `kind?`, `title_hint?`, `x?`, `y?`, `level?` |
| `get_metrics` / `verify_journal` / `self_diagnose` | 工程卓越三件套（需 `enableTelemetry`）：运行时遥测分位与洞见 / 行动日志哈希链审计（防篡改）/ 全子系统活体健康检查 | 无 / `from_step?` / 无 |
| `save_checkpoint` | 认知状态全量快照（UI 记忆/技能/失败记忆/journal 链/遥测，原子写；需 `checkpointPath`） | 无 |
| `federation_sync` | 万脑联邦（纪元 Μ，需 `kernelEvolutionEnabled` 或 `federationEndpoint`）：铸造差分隐私证据摘要、可选上行聚合端、远端证据只喂本地账本（绝不直写参数值）；缺省 robust 拜占庭聚合、endpoint 空 = 零网络；`DSH_FEDERATION_TOKEN` 在场自动 HMAC 签名 | `action?`（digest/sync/status）, `robust?` |
| `steer_choice` / `steer_answer` | 活意图漂移检查对（W3-5，需 `autonomyEnabled`）：屏幕离目标太远时出 A 继续 / B 修判据 / C 终止的单键题；应答经 `steer_answer` 结算（垃圾输入原题重问绝不猜；持卡时 "2"/"B2" 换支重放） | `step_index`, `entropy?` / `answer` |

## 快速开始

### 1. 环境准备

Node.js >= 18（推荐 22）与 pnpm。原生依赖（`sharp` / `@nut-tree/nut-js` / `screenshot-desktop` / `tesseract.js`）随插件自动安装。

### 2. 安装插件

推荐的安装方式：

```
dsh plugin add beijingwahw/dsh-computer-use-plugin --profile web
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

---

# DSH Computer Use Plugin

**Give DeepSeek Harness real "eyes" and "hands"!**
**赋予 DeepSeek Harness 真正的"眼睛"和"双手"！**

[中文（顶部）](#中文) | **English**

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

## Epoch Ψ (Psi): One Brain, Every Platform

The cloud cortex (Epoch Ω) recognized exactly one vendor: Zhipu. This epoch's founding intent is to **bind to no one** — one unified abstraction swallows the vision models of every platform: whoever's key you hold is the brain you use, and when the primary falls, a backup steps up. Seven modules (`src/vlm/providers/`, redistributed through the `providers/index.ts` barrel; each enforced item-by-item by `test/vlm.providers.*.test.ts`):

| Module | Mechanism | Platforms covered |
| --- | --- | --- |
| **Ψ-1 Unified contract `types`** | VisionProvider interface + the key-hygiene law `sanitizeError` (keys never appear on error surfaces or in metering) + full-jitter retry `fetchWithRetry` (retries only 429/5xx/network errors, never timeouts) | All (the protocol base; a leaf module with zero dependencies) |
| **Ψ-2 OpenAI-compatible adapter `openai`** | `/chat/completions` + Bearer auth + `response_format` JSON mode; local services connect keyless | OpenAI / Zhipu / Qwen-compatible mode / Kimi / Doubao Ark / Grok / SiliconFlow / OpenRouter / Ollama / vLLM / LM Studio (one adapter devours the family) |
| **Ψ-3 Anthropic adapter `anthropic`** | `/v1/messages` + `x-api-key` + `anthropic-version` headers + three-field image source; jsonMode simulated via prompt | Anthropic Claude |
| **Ψ-4 Gemini adapter `gemini`** | `models/:generateContent` + the key travels in the `x-goog-api-key` header, never the URL + `inline_data` + `responseMimeType` | Google Gemini |
| **Ψ-5 Platform registry `registry`** | 13 platform presets + env auto-detection + baseUrl recognition + explicit/baseurl/env four-way resolution + synthesized custom presets | glm / openai / anthropic / gemini / qwen / moonshot / doubao / xai / siliconflow / openrouter / ollama / lmstudio / vllm |
| **Ψ-6 Failover pool `failover`** | In-order standbys + reuses `VlmApiBreaker` (tripped lines are skipped) + a ring buffer of switch decisions (latest 10) | Any multi-brain battle sequence |
| **Ψ-7 Probe `probe`** | 1×1 white-image 15s health check + `visionGuessed` verdict + model-list discovery over the three protocols + all-platform parallel checkups | All 13 platforms |

### The compatibility layer's vital points (all five held)

`GlmClient` keeps the same class name and every export; the constructor delegates to the matching adapter by platform, and the **default glm path stays byte-for-byte unchanged** (error prefixes / meter kind / GLM env-var semantics as-is). `getGlmClient` default resolution is enhanced — GLM env first, otherwise env auto-detection of the other platforms; `isGlmConfigured` is upgraded to mean "any cloud brain available" (still mints no singleton). The entire system (`ask_screen` / grounding / semantic-OCR fallback / verdict / consultation / autonomy policy advice) lights up automatically with any platform's key — zero changes on the consumer side. Tests stay fully offline: `fetchImpl` injection + env save/restore.

### Usage

Any one of three ways lights it up:

```yaml
# Way 1: single-platform env (zero config) — any platform key present in env is auto-detected and lights up the whole system
#   GLM_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY / GEMINI_API_KEY / DASHSCOPE_API_KEY …
config:
  # Way 2: vlmProvider names the platform explicitly (empty = auto-detect)
  vlmProvider: 'openai'      # or anthropic / gemini / qwen / moonshot / doubao / xai /
                             #    siliconflow / openrouter / ollama / lmstudio / vllm
  # Way 3: add a fallback chain — when the primary falls, backups step up (breaker skips lines in order)
  vlmFallbackProviders: 'anthropic,gemini'   # CSV fallback chain
```

New tool `vlm_platforms({ probe: true })`: lists the configuration status and health of the 13 platforms (a 1×1 white-image parallel checkup with a 15s timeout — real screen content is never sent), plus the currently active platform and the fallback provider pool's health. Judgment numbers: the vlm family — 250 tests, 0 failures (Ω's original 127 + providers 115 + universal 8; providers per-file 14/19/24/21/8/11/18); typecheck 0 errors; smoke — 163 modules.

## Epoch Δ (Delta): The Global Lift

With the organ era complete, this epoch forges **no new organ**: five audit agents swept the entire repository and produced 52 evidence-backed improvement points, landed in parallel by cluster — every existing organ, sharpened.

Six security fixes headline the campaign: replay/skill execution bypassing the gate (a shared `actionGate` now runs ahead of `replayOne` — dangerous steps without a token are intercepted, `replay_actions`/`run_skill` fail fast); the approval-token double-spend window (an in-flight reservation in `beginAttempt` — a concurrent same-token click dispatches exactly once); asymmetric full-width folding in riskGate (normalization iterated to a fixed point — ｓｕｂｍｉｔ confusable variants no longer escape); dragMouse's zero screening (target description + danger-word checks added); key-scrub fallback on the anthropic/gemini error surfaces; and the popup auto-click scan gap (确定/同意/是 join the confirmation vocabulary; 恢复出厂/重置系统 join the irreversible one — "OK, restore factory settings" is no longer judged benign).

Correctness and performance: the always-true RRF filter in failureMemory, the mis-framed subconscious pHash, actionVerifier's degenerate-fingerprint false positives (which burned approval tokens), doctorChannel's dead same-chain receipt coalescing revived (the T-3 assertion upgraded to a live implementation), journal.reset's taskDescription residue, openai maxTokens 1024→2048, and the LM Studio/vLLM probe no longer guessing gpt-4o-mini; BM25 O(N²)→O(N), a policyEngine tokenization WeakMap cache (zero drift on the closedloop bench), OCR negative caching over the legacy path, journal mkdir made once, and an input gate capping ncd lzCount at O(n³). Governance: four more singleton reset seams in the unload disposer, dual-track rerouting advice from `start_complex_task` to `autonomous_run`, pid-verified service liveness (a port squatter surfaces in 142ms instead of an 8s false wait; `/health` gains a pid field), organCensus de-decorated (4 real self-checks + 29 honestly static), vlmMeter wired into `configureVlm`, the constitution's `effectiveRiskTier` written back into trajectories. Honest rejections: `Object.freeze(system)` (would kill the test-injection seam); organ-API "dead export" cleanup (a delivery surface, not dead code); pooled-telemetry GPD divide-and-conquer (deferred). Judgment numbers: epochDelta four families — 35 tests, 0 failures (safety 10 / perimeter 10 / infra 7 / perception-memory 8); vlm 250→258 (+8); autonomy 171→189 (bench 7 included, +18) ≈ 61 net-new; full suite — 941 tests, 0 failures (14 platform skips); typecheck 0 errors.

## Epoch Σ (Sigma): The Capability Lift

Delta sharpened the existing organs; Sigma raises every module family one capability — seven lifts, all incremental, all byte-identical by default (no `display` argument and no new config ⇒ the exact Delta end-state). **Σ-1 ensemble court** (`src/vlm/providers/ensemble.ts`): multiple platform vision models answer in parallel; normalizedLevenshtein ≥0.7 union-find clustering issues unanimous/majority/split verdicts, judgments go by majority vote (ties → uncertain, `dissents` names the minority), and element lists from several brains fold through the real `arbitrateElements`. **Σ-2 autonomy gym** (`src/autonomy/gym.ts`): mulberry32 deterministic task generation + four worlds (wizard / popup-maze / scroll-hunt / danger-gate) + sharp-synthesized frames, all injected — the autonomy loop evolves itself offline (wizard achieved in 3 steps; popup-first law pays one extra step and still succeeds; scroll-hunt triggers the strategy-switch law; the danger-gate click ledger proves "Pay now" is never clicked under the constitution's hard law). **Σ-3 resume**: append-only JSONL pilot records (begin/step/finish event lines replayed on load, disk failure degrades to memory) + a `resume_token` anchor + `autonomy_resume(token)` replaying already-met criteria without re-verification; new config `autonomyTracePath`. **Σ-4 plan self-healing** (`orchestrator.ts`): a failed subtask no longer fails fast immediately — one contextual replan (closure guard: healed at most once), the failed line re-marked `[RECOVERED]` with the failure text preserved; no chat / already healed / empty or cyclic plan ⇒ the original fail-fast, verbatim. **Σ-5 multi-display awareness**: the `display` parameter runs the whole chain (screen.py / routes.py / adapter / physicalBackend / take_screenshot), cropping by monitor rectangle at the very source in the full-screen virtual coordinate system — and along the way unearthed and fixed a latent bug where `/displays` had never actually worked (ctypes lacks a MONITORINFO struct, so enumeration was always empty — hand-written MONITORINFOW) plus a DPI logical/physical pixel mismatch (bounding-box proportional mapping). **Σ-6 HMAC challenge-response identity**: the liveness probe sends a random nonce; the service signs it HMAC-SHA256 with the shared key; `timingSafeEqual` verifies — curing Delta's leftover launcher-alias pid blind spot (foreign pid + correct proof = healthy; wrong proof fails fast as `port_squatted`; old services fall back to pid equality). **Σ-7 telemetry dashboard**: `metrics_dashboard(section?)` renders a four-pane ≤80-column text dashboard (tool-latency percentiles / cloud-brain usage / autonomy track record / guard-interception counts), with the guard deny branch feeding `telemetry.note`. Judgment numbers: 63 Sigma tests (ensemble 16 / gym 8 / plan 7 / resume 7 / identity 11 / display 9 — real FastAPI end-to-end included / dashboard 5); new tools `autonomy_resume` and `metrics_dashboard`, plus `take_screenshot`'s `display` parameter; new config `autonomyTracePath`.

## Epoch Θ (Theta): Kernel Evolution

The skill library long had phylogeny and extinction pruning; the mathematical kernels deserved the same treatment. Theta turns the repo's hard-coded thresholds — roughly 50 surveyed, the first **18 keys wired into production** (the measured `registerProductionKernels` roster) — into evolvable parameters with lineage, evidence gates, guardrails, and rollback (`src/kernel/`). **Θ-1 registry & evidence ledger** (`registry.ts`): `KernelParamSpec{key,organ,default,min,max}` with idempotent registration and bounds clamping (no state outside the interval), drift percent, snapshot/restore, `promoteFrom` lab→production promotion (generation+1, evidence inherited, copy-not-move), a per-key 200-entry sliding-window ledger, and `getOrDefault` echoing the literal fallback for unregistered keys — the seam that keeps the default byte-identical. **Θ-2 calibrator & lineage** (`calibrator.ts`/`lineage.ts`): a grid-scan `optimalThreshold` (honest null under 8 samples, in homage to calibration.ts); four guardrails (minEvidence 30 / maxStep 10% of range / rollbackDrop 0.05 / minPostEvidence 20); a regression guard that rolls back to the previous generation; lineage promote/extinct (never fewer than one entry, the fitness champion survives) — the blood-line of skillLibrary's extinction pruning. **Θ-3 gym lab evolution** (`gym.ts`): the perceive closure reconciles kernel verdicts against the virtual world's ground truth (dhash verdict vs the world's stateKey truth; element fusion vs the control truth; policy choice vs the world's legislated correct next step) into a lab-owned registry that never touches the production singleton, with `calibrator.tick()` closing each round and a `GymReport.kernel` summary. **Θ-4 production wiring**: ten read points across seven consumer files go through `getOrDefault` (arbitration pair + text similarity / snapshot tolerance + arbitration pass-through / policy confidence & tie gap / uncertainty calibration & three tiers / OCR word-confidence floor / NMS IoU / skill scene gate & bonus) — unregistered keys behave byte-identically; startup registration is idempotent (all defaults ⇒ empty drift); the dashboard grows a fifth `kernel` pane. Usage: evolve offline in the gym, inspect `gym.lab`, promote explicitly via `kernelRegistry.promoteFrom(gym.lab.registry)`; tune manually via `kernelRegistry.set` (auto-clamped); watch drift via `metrics_dashboard('kernel')`. Judgment numbers: 49 Theta tests, 0 failures (registry 16 / calibrator 23, lineage 7 included / gym 5 / wiring 5); no new tools, no new config.

## Epoch Ξ (Xi): Kernel Evolution — Full Sweep

Theta built the evolution infrastructure and wired the first 18 keys; Xi sweeps every surveyed kernel into the evolution map and closes the production loop — three routes in parallel (`src/kernel/`). **Full second-tier wiring**: the registry grows 18→55 keys (37 new across the verdict / verification / memory / governance / vlm families, 12 consumer files), with two honest vetoes on record (BM25 k1/b — "the value is the design, not a knob"; seven policyEngine utility baselines — low evolution value) and structural-order guards held twice (non-overlapping spec intervals plus consumer-side Math.min/max clamping — Schmitt hysteresis and the semantic≥geometric evidence law survive knob-turning). **Production self-supervision**: free evidence always on (every criteria-matched click's outcome reconciles `policy.matchConfident` at zero extra cost); slow-truth reconciliation gated by `kernelEvolutionEnabled` — settle-verify stable frames serve as ground truth to calibrate `world.hammingTolerance`, the fast path calibrated by the slow path, with zero extra awaits when the gate is closed. **Persistence & orchestration**: `KernelStore` atomic tmp+rename archives (params/evidence/generations) behind `kernelStatePath`, an `EvolutionConductor` throttling calibration ticks to a 5-minute window on user-message hooks, and load-on-start / save-on-unload session seams — all off by default, zero behavior change. The epoch's trump card, the **multi-generation convergence proof**: tolerance deliberately mis-set to 8, `trainGenerations(10, 4)` converges geometrically 8→3.004 (0.14% off the known-good 3; 3.067 after 6 generations), lineage traceable across 16 generations, direction right 10/10, every single step within the 0.7 guardrail. New configs `kernelStatePath` ('') / `kernelEvolutionEnabled` (false); new APIs `AutonomyGym.trainGenerations(gens, rounds)` / `EvolutionConductor.maybeTick` / `KernelStore.save·load·applyTo`; the constitution pair (maxNoEffect/maxSteps) joins the production roster and evolves in the gym lab. Judgment numbers: 33 Xi tests, 0 failures (store 10 / conductor 7 / selfverify 5 / generations 6 / wiring 5).

## Epoch Λ (Lambda): Zero-Config Onboarding

Psi made thirteen brains selectable; Lambda makes the fresh install glow — a five-level resolution chain lights the first lamp it can: explicit config > saved connection (`~/.dsh/vlm-connection.json`, `DSH_VLM_CONNECTION` overridable; restart resumes whatever the user last chose) > env auto-detection > **local auto-adopt** (a loopback knock on Ollama 11434 / LM Studio 1234 / vLLM 8000 `/models` — serial, no auth header, 1.5s budget each — picking a vision-named model first: zero keys, zero config, archived `via:'auto-adopt'`) > **wizard popup** (`startOnboarding` loopback HTTP server + `system.openUrl`; fire-and-forget, never blocking plugin load). The wizard is an offline single-file Chinese page: 13 platform cards, key input (local platforms keyless), test-connect probe, model-list discovery, save-and-enable (archive + hot apply + **late registration** of `ask_screen`), disconnect — under the security laws: loopback-only bind, keys echoed only in masked form, 32KB body cap, port fallback +1..+8 from 18432, 30-minute idle auto-shutdown. Two always-registered tools — `switch_vision_model(platform, api_key?, base_url?, model?)` (probe first, persist `via:'tool'`, then re-mint the client hot: every VLM organ re-fetches `getGlmClient`, so the whole stack follows the new brain immediately) and `vlm_wizard()` (reopen the wizard anytime); `ask_screen`'s degraded `next_step` now points to it. New configs `vlmAutoAdoptLocal` (true) / `vlmOnboardingEnabled` (true) / `vlmOnboardingPort` (18432). Judgment numbers: 46 Lambda tests, 0 failures (vlm.connection 16 / vlm.onboarding 15 / vlm.tools 7 / epochLambda.onboarding 8).

## The World-Class Innovation Wave (Epochs Ρ·Γ·Υ·Η·Κ·Π·Μ and sequels)

After Lambda, the project took aim at the industry's three unsolved pains — **injection cannot be prevented (Ρ/Π/Β), tokens cost too much (Γ/Γ2), agents do not improve (Υ/Κ/Μ/Η/Ι/Τ/Ε/Ν)** — in four construction waves landing seventeen epochs: 163 new enforcement tests (merged into the 1295/0 suite), six new modules (`sleep` / `notary` / `federation` / `selfmodel` / `prophecy` / `vlm/refute`), the new tool `federation_sync`, and 25 new config keys. Full ledger in [GENESIS.md](GENESIS.md) and [INNOVATION.md](INNOVATION.md); one line each:

- **Ρ two-key notarization lock** (on by default): irreversible actions require multi-channel semantic notarization — model self-report ∪ OCR ground truth ∪ UIA control names, each normalized to a fixed point (leet/homoglyph immune) and adjudicated fail-heavy; a semantic handshake rejects descriptions that contradict what the screen actually reads. Injection can fool the model; it cannot fool the rendered pixels and control names.
- **Γ/Γ2 gaze economy**: foveated encoding (native-resolution center, downsampled periphery) with exact coordinate round-trips (≤1px) — measured **token −75% / JPEG bytes −67.8%** at JPEG-level fovea fidelity, peripheral loss honestly reported.
- **Υ cognitive sleep** (off by default): a six-act offline consolidation cycle (replay → distill → immunize → calibrate → audit → morning report) with idempotent watermarks and per-act budgets.
- **Η epistemic closure** (on by default): a four-factor gate (error cost × Beta-calibrated confidence × cloud availability × budget headroom) inserted ahead of the constitution check — the agent asks the human exactly when the math says it should; abstention is a first-class action.
- **Κ surprise curriculum** (off by default): production surprise spectra drive a softmax-weighted synthetic-world sampler, P(world) ∝ exp(β·surprise) — train more where you failed more.
- **Π notarized behavior ledger**: self-chained anchors (sha256 over canonical records) + a zero-dependency DER/RFC3161 timestamp client + four-green-seal verification exposed as `quality_checkup`'s fifth action `notarize` — cryptographic proof that the recorded automation is untampered and reproducible.
- **Μ/Μ2 federation of brains**: differentially-private Laplace-noise evidence digests merged via Byzantine-robust per-cell medians (k≥3, 50% crash tolerance) with outlier quarantine feeding a trust ledger — remote evidence feeds the local ledger only; parameter values still move solely through the local evidence gate.
- **Sequels**: Ι **self-model** (decaying Beta competence posteriors per action×scene cell — the epistemic gate learns to fear cells where the agent historically fails), Τ **intervention-as-education** (granted approvals become privileged positive demonstrations; refusals become avoidance lists; type_text logs only length buckets), Χ **sandbox replay testimony** (deterministic re-runs pinpoint the first divergent step), Ε **prophecy engine** (Dyna-style pre-action predictions reconciled hit/miss/no-model, feeding back into the world model), Β **refute court** (a heterogeneous second brain is asked to *refute* irreversible actions — injection must now fool the primary brain, the pixel notary, and the adversarial refuter), Ν **probe economics** (probe channels ordered by learned bits/ms, stopping at ≥0.5 bits of entropy reduction), Ζ/PyS **persistence & OCR ground truth** (checkpoint self-model segments; sleep-driven calibration advice; Python OCR word-level confidence scores cross the wire as measured values).

## The W1–W5 Organ Waves: Resilience · Discipline · Intent · Embodiment · Final Audit

Five consecutive organ waves followed (each delivering multiple organs in parallel plus dedicated integration wiring, all enforced and registered in [GENESIS.md](GENESIS.md)), pushing the flagship themes into execution, offline safety, long-run self-correction, and physical embodiment. At the W5 close: **2018 total tests, typecheck clean, 242 modules importing clean** (one environment-exposed failure honestly logged; see DEBTS).

- **W1 execution & perception resilience** (9 organs + integration wiring, 169/0): execution-layer quadruple fix (ROI three-evidence verdict / UIA precheck × focus short-circuit / word-centroid landing points / settle gate), **out-of-band confirm codes** (CSPRNG 6-digit with constant-time compare — the code never appears on any model-visible surface, so an absent user cannot be impersonated), perception gating (skip heavy perception when the dHash is unchanged — measured 50% skip rate), a noise clinic, EXP4 contextual bandits, root-cause attribution chains, sparse SoM with occlusion-avoiding labels, zoom re-verification (three triggers, 8-per-task budget), and visual economy (three-way gaze routing + budget-aware re-encoding).
- **W2 offline resilience & cost discipline** (9 organs + integration wiring, 173/0): an offline approval queue (staged irreversible actions adjudicated in one annotated batch from the morning report via `adjudicate_approval_queue`), the deliberate audit-fail-closed × probe-fail-open asymmetry with freshness probes, bench trustworthiness (contract checker + variance-aware SPRT regression gate), lease blackboard + evidence-based arbitration, a recovery-efficacy Beta ledger, memory-ops bandits, canary rehearsals, and cost-cascade routing (measured savings rate 0.55).
- **W3 living intent & self-correction** (9 organs + integration wiring, 155/0): reversal escrow (action-level WAL + compensation plans, fail-closed without a plan), parameterized skills (DTW alignment + anti-unification into parameter holes), dirty-rectangle incremental encoding (P-frame-style perception, measured **token −74.6%**), DAG pipeline with staged resume, intent drift (`steer_choice` / `steer_answer` — single-key A/B/C questions when the screen drifts from the goal), branch cards (counterfactual replay on failure), exploration frontier (UCB, recovery mode only), and a process scorer (step-level four-channel credit assignment).
- **W4 embodiment & economics** (9 organs + closing wiring, 133/0 + 58 Python self-test assertions): macro replay (measured decision calls −71.4%), federated skills (DP upload: fingerprints + slot medians; k≥3 aggregation; activated only after two local hits), reversibility lanes (compensable escrow / irreversible handed to the human / reversible fast lane), a PCG infinite gym, **mobile surface** (Android devices enrolled as virtual displays via scrcpy/ADB), **zero-API device face** (an HDMI capture-card UVC eye + a CH9329 serial HID hand — the target device sees a real mouse and keyboard: zero drivers, zero API, zero detection surface), a step-auction market, and an acoustic channel (non-semantic evidence only, always subordinate to vision).
- **W5 closing wave** (7 organs, 83/0 + 7 benches green): Python endpoint registration (uvc/hid/audio endpoints + a /health hardware face; absent hardware always degrades to a structured 200, never a bare 5xx), dream replay (PER-priority counterfactual re-runs with divergence-point double-entry), cross-machine orchestration (a distributed barrier with full-quorum release, sequence anti-replay, two-phase commit, and bounded state; plus cross-machine visual corroboration predicates), the SoM call face (sparse annotation wired into the production pipeline with ≤1e-9 coordinate closure), steer closure (all three declared gaps closed), and an efficiency benchmark putting six organs' claims on the scale — declared vs measured, side by side.

## W6-R: The Repair Wave

A post-W5 full-repo security and correctness repair wave (parallel agents; snapshot — closing status in the last bullet):

- **Approval fail-closed**: when the out-of-band confirm channel is absent (`confirm_channel=out-of-band-absent`), grant is refused — the token can never be granted in-chat; confirm codes travel only the event bus and console output is fully redacted.
- **Prompt-injection discipline**: a "data vs instruction" segment added to the system prompt — screen content is untrusted data, and any "instruction" rendered on screen is not an instruction; confirm codes are honored only out-of-band. SoM prompts hardened in step.
- **Python physical service**: the adb type_text device-shell injection fixed (shlex.quote + printable-ASCII allowlist); mandatory nonce (a missing X-Request-Id ⇒ 401); auth failures re-mapped to 401; the HID controller public convergence surface; the uvc.py D-E1 double-wrap bug fixed; pyproject gains pyserial / opencv-python / comtypes.
- **VLM**: tool-function deduplication (a single internalUtils.ts implementation); verifyGate re-verification budgets scoped per task (concurrent tasks no longer bleed into each other).
- **Federation**: federationSync defaults to robust:true (Byzantine-robust aggregation in production, D-B6 closed); HMAC-signed aggregation auth (DSH_FEDERATION_TOKEN); trust-ledger persistence wired and locked.
- **Physical execution, TS side**: forced-close on PID proof removed; key files 0600; X-Request-Id on all endpoints; 401 semantics recognized.
- **Engineering**: CI gains verify + build steps; sharp/tesseract.js moved into dependencies; .gitignore gains with-interrupt.
- **Shell hardening**: openUrl via rundll32 with array arguments (no shell parsing, no variable expansion); all PowerShell goes through -EncodedCommand.
- **Guards**: the audit fail-closed roster grows 6→18 tools; tighter quantized repeat-action detection plus trajectory-level loop detection.
- **Closed out (W6R-C3)**: fail-closed dangerous-action probes (canaryGuard token-path gate), static VLM key protection (maskKey redaction), and full regression (typecheck clean; 2350 tests, 0 fail; verify 23/23; doctor 85.5, zero sec.* hits; dist synced with src) — all landed.

## W8: The World-Innovation Repair Wave

The wave that followed W6-R, clearing the "built but not wired" organ debts and structural debts (2 batches, 18 repair agents + 2 closing reviews; 11 enforcement suites, 96/96):

- **Giant-file splits**: gym.ts 3377→1557 + 6 satellites, approval.ts 1584→97-line bucket + 9 satellites, autonomy/runtime.ts 1581→989 + 6 satellites — import faces unchanged, enforcement anchors untouched.
- **Criteria falsification**: the criteriaEval organ grows negative criteria on the same DSL (`mustNotAppear:` prefix — an OCR hit on the forbidden phrase ⇒ violated ⇒ final failed), fuzzy tolerance (one error per six characters), and honest degradation when OCR is absent; the pilot loop enforces only the negative side (polarity red line — the positive side stays with the execute channel).
- **Cycle breaking**: the autonomy↔tools package cycle severed (canaryLogic imports nothing from autonomy; autoPilot imports nothing from tools — dependency direction is strictly tools/guards → autonomy).
- **Memory upgrades**: failureMemory gains salience-aware eviction (recency / dedup hits / root-cause crowding penalty + sole-survivor quota); selfmodel moves to 24-bit two-stage scene buckets with honest migration from old 16-bit keys.
- **Prophecy & notarization**: a coarse screen-type bridge (exact-key miss ⇒ coarse dhash fallback, honestly labeled `predictedVia:'coarse'`) plus the surprise-feed live wiring into the evolution engine; replayWitness notarizes replay trajectories (replay_actions / run_skill dual wiring — step fingerprints + three-state outcomes anchored into the notary chain, degrading honestly when the notary is absent).
- **Single-sourcing**: federation-server.mjs becomes a thin re-export of `dist/crossMachine.js` (one authoritative barrier state machine).
- **CI on Linux**: a physical-service e2e step lands (ubuntu installs dsh_physical editable, pre-starts tcp:8421, runs the adapter real-service path plus the /dev/shm branch — awaiting first push validation).
- **Bench predicate**: a `windowCount` check (titleRegex-anchored window counting with combinable equals/gte/lte — the machine equivalent of "the window count is unchanged/zero afterwards").
- **Wiring closeout & guard fixes**: SoM seed supply, dream failure feed, and the incremental-encoding consumer (contextManager, off by default) all wired; the hanging-test debt eradicated (suite-wide cancellations reach zero for the first time); repeatActionGuard gains leaf-level numeric distance and auditGuard splits read-only sub-actions.
- **Full regression (W8-C2, measured)**: 2472 tests / 2467 pass / 0 fail / 0 cancelled / 5 skipped (environment guards); verify 23/23 with zero BC hits; compileall clean; doctor 90.5 (0/0/0 across crit/major/minor, 40 info = 21 exempted + 19 unexempted, zero sec.* hits); dist at 272 files in sync with src; tsc clean. DEBTS ledger 43→47 (11 flipped closed / 2 partial / 1 semi-closed / 4 new).

## Epoch Φ (Phi): The Autonomy Loop

The local stack could by now "see precisely and click correctly" — but every step was still model-driven. This epoch forges the **four-ring loop**: the machine takes its own world snapshot (perceive), decides its own next step (judge), executes and verifies by itself (execute), and after the run audits itself and evolves its strategy weights (evolve). The precondition of high autonomy is legislation — ten organs + a constitution + runtime adaptation (`src/autonomy/`).

Ten organs (each enforced item-by-item by `test/autonomy.*.test.ts`):

| Organ | Mechanism | Problem solved |
| --- | --- | --- |
| **Φ-1 Goal state machine `goalState`** | Seven GoalPhases (planning/acting/verifying/blocked/achieved/failed/aborted), criteria checked item by item, over-step/over-time fuses, invalid specs degrade instead of throwing | "Is the task actually done" is ruled by the criteria ledger, not by the model's say-so |
| **Φ-2 World snapshot `worldSnapshot`** | VLM+OCR dual sources fused by the `arbitration` mathematical arbiter, three-state interactivity, dhash change gating | Five perception dialects reconciled into one ledger — the decision layer stops cross-checking source by source |
| **Φ-3 Policy engine `policyEngine`** | A seven-rung deterministic decision ladder: popup first → criteria-keyword matched click → declare → no-effect strategy switch → skill recall → budget escalation → ask_vlm fallback | First-match-wins and fully deterministic; the cloud brain is consulted exactly once — and only under uncertainty (low confidence / ties) |
| **Φ-4 Autonomous execution loop `autoPilot`** | perceive → decide → constitution check → execute → criteriaEvidence → tick → terminal fuses; time & sleeps fully injected | The loop itself: any dependency exception converges into an error step — the loop never blows up |
| **Φ-5 Evolution engine `evolutionEngine`** | Outcomes write the five strategy weights ±; failure-signature lessons deduplicated and upgraded; successful short paths distilled into skills (reliability re-verified upward); next-run advice | Smarter with every run: experience survives across rounds |
| **Φ-6 Scene semantics cache `sceneSemantics`** | The VLM reads the screen to recognize the scene; a dhash-fingerprint LRU cache | "What scene is this" is no longer re-billed to the cloud at every step — the same screen is never asked twice |
| **Φ-7 Epistemic hub `uncertainty`** | Shannon entropy + weighted-geometric-mean confidence fusion + Beta calibration + a three-tier cost decision table (proceed / ask_vlm / ask_human / abort) | When to proceed, when to ask the cloud, when to ask a human, when to stop — decided by numbers |
| **Φ-8 Autonomy constitution `autonomyConstitution`** | Six laws: blacklist / tier-max weighting / danger-keyword scan (reusing riskGate's homoglyph normalization — a Cyrillic dеlete still hits) / approval outside the whitelist / the destructive hard law: always approval / deadlock & over-step shutdown | Which actions may run autonomously and which must petition a human — the precondition of high autonomy is legislation |
| **Φ-9 Counterfactual planner `counterfactual`** | Utility = 0.5×progress + 0.3×information gain − 0.2×risk; repeated actions discounted; ties broken toward higher information gain | Sand-table rehearsal before acting — choose the best, not the first |
| **Φ-10 Self-auditor `selfAudit`** | Five verdicts (healthy/oscillating/wasteful/reckless/opaque) over four syndromes: oscillation / waste / recklessness / black box; scored from 100 | Look back at your own trajectory after the run — the auditor must first be harmless itself |

### Integration bloodstream

- **Six config fields**: `autonomyEnabled` (default `false` — autonomy only upon the legislator's explicit opt-in) / `autonomyMaxSteps` (default 24; both the loop fuse and the constitution's hard stop derive from this value) / `autonomyTimeBudgetSec` (default 300) / `autonomyAllowTiers` (default `'benign'`; destructive stays always-approval even when listed) / `autonomyVlmWhenUncertain` (default `true`) / `autonomyForbiddenKeywords` (default empty); `buildAutonomyStack` mints the six fields into the closed-loop stack.
- **New meta tool `autonomous_run`** (`goal, success_criteria?, max_steps?, time_budget_sec?`): one call drives the entire loop to the end of its budget; the anchor carries `phase` / the `criteria` ledger / the self-audit `verdict`/`score` / `lessons` / `next_run_advice` / distilled skills. Default-criteria law: absent criteria, the goal text stands as the sole literal criterion (an OCR-folded substring check).
- **Constitutional upgrade of `ACTION_REQUIRED` semantics**: approval is the human's prerogative — `approval-required` becomes executable once granted; `constitution-veto` cannot be saved by approval; the dry-run line of defense is inherited for free (guardDryRun at the system layer).

### Design constitution

- **Off by default + constitution first**: `autonomyEnabled: false` is the resting state — autonomy is a permission the legislator grants explicitly; the destructive-always-approval hard law is inalienable, and when the constitution fails, the loop prefers conservative shutdown.
- **Offline deterministic tests**: time / sleeps / screenshots / OCR / cloud brain all injected (a fake VLM client) — zero networking.
- **Perception-layer coordinate law**: snapshots live in the captured-image space; execution normalizes by dividing by the snapshot's width and height — the same conversion chain as `click_mouse`.

### Usage

```yaml
config:
  autonomyEnabled: true        # the legislator explicitly opts in
  # autonomyMaxSteps: 24 / autonomyTimeBudgetSec: 300 / autonomyAllowTiers: 'benign'
  # autonomyVlmWhenUncertain: true / autonomyForbiddenKeywords: ''
```

Call `autonomous_run({ goal: 'Open System Settings and go to the Bluetooth page', success_criteria: ['Bluetooth'] })`; anchor structure: `{phase, steps, criteria:{met,total}, verdict, score, lessons, next_run_advice, …}`. Judgment numbers: the autonomy family — 164 tests, 0 failures (ten organs 158 + integration 6); typecheck 0 errors; smoke — 154 modules import clean.

## Epoch Ω (Omega): GLM-5.3-Flash Cloud Cortex

The local reflex arc (OCR / fuzzy matching / probes) answers deterministic facts in milliseconds, but **open semantics** — whole-screen understanding, unfamiliar interface shapes, mixed image-text reading, state inference — are the blind spots of a purely local stack. This epoch attaches a cloud brain: the Zhipu GLM-5.3-Flash vision LLM, with ten organs under `src/vlm/` each holding its own duty, arbitrated conservatively against local perception in a dual-brain arrangement.

Ten organs (each enforced item-by-item by `test/vlm.*.test.ts`):

| Organ | Mechanism | Problem solved |
| --- | --- | --- |
| **Ω-1 Cloud-brain client `glmClient`** | Zhipu's OpenAI-compatible protocol + full-jitter exponential-backoff retry + JSON fence stripping (injectable fetch) | The reliable transport layer for talking to the cloud brain: decorrelated retry phases; robust extraction of fenced / dialect JSON |
| **Ω-2 Perception codec `codec`** | 1568 long edge / JPEG 80 / region-of-interest crops + `VlmBudget` task-level image-count and byte quotas + vision-token estimation | Bandwidth etiquette for cloud round trips: overruns are refused before dispatch, not patched after the fact |
| **Ω-3 SoM prompt engineering `som`** | A VLM-specific Set-of-Mark numbered-box overlay + iron-law prompt families in Chinese (grounding / verdict / ocr / diff) | Writes "absolute pixel coordinates, nothing outside the image, no fabrication" into the model input — cloud-side coordinate hallucination annihilated |
| **Ω-4 Element detection `grounding`** | `groundElements` + NMS IoU≥0.6 de-redundancy + `clampBbox` in-image clamping | Screenshot in, clickable elements out; cloud output dialects normalized to the repo standard — prefer empty over wrong |
| **Ω-5 Semantic OCR `vlmOcr`** | `readTextViaVlm` / `findTextViaVlm`, matching under the same law as the local textReader (case/whitespace-insensitive) | Cloud-side reading and finding of text: the cloud sister of local OCR; hits return center pixel coordinates |
| **Ω-6 Effect verdict `verdict`** | `judgeEffect` compares the before/after image pair → confirmed/refuted/uncertain + `fuseWithPixelEvidence` dual-brain pixel fusion (agreement bonus +0.1; disagreement demotes to uncertain) | The L3.5 cloud semantic verdict: "was it the right change" can only be answered by a brain that reads semantics |
| **Ω-7 Diff explainer `diffExplainer`** | Changed regions + two images → a one-sentence summary + region-level annotations, under a label-alignment law | "Where it changed" upgraded to "what changed"; annotations that cannot be matched are dropped — never forced |
| **Ω-8 Failure consultation `diagnosis`** | `diagnoseFailure`: task/action/anchor/error/screen text + optional screenshot → root cause + normalized hypothesis probabilities + recovery steps (cycle-reference protection) | Cloud-side attribution for "why did it stop" — the cloud consultation room beside the local qualityDoctor |
| **Ω-9 Dual-brain arbitration `arbitration`** | IoU greedy pairing + confidence-weighted convex-combination fusion + agreement bonus 0.15 + a four-branch winner + `normalizedLevenshtein` text arbitration | Purely mathematical adjudication when local perception and cloud opinion disagree: arbitration by measure, not by authority |
| **Ω-10 Metering governance `metering`** | `vlmMeter` percentile ledger p50/p95 (thousand-sample window) + dual-bucket sliding-window rate limiting (minute × hour) + a consecutive-failure breaker at 5 failures / 60s cooldown + full jitter uniform(0, b·2ⁿ) | The cloud brain's spend and heartbeat: observable, rate-limited, breakable |

### Integration bloodstream

- **Four new config fields**: `vlmApiKey` / `vlmBaseUrl` (default `open.bigmodel.cn/api/paas/v4`) / `vlmModel` (default `glm-5.3-flash`) / `vlmAssistOcr` (default `false`); `index.ts` mints the cloud-brain singleton via `configureVlm` — config takes priority over environment variables (`GLM_API_KEY` > `ZHIPUAI_API_KEY` > `ZAI_API_KEY`).
- **SemanticSource cloud adapter** (`createSemanticFromVlm`): the L3 semantic source of the D-6 three-stage funnel — the host-bus-first legislation stands; when the host supplies none and the cloud brain is available, the missing tier self-mints, adding only, never usurping.
- **`semanticConfirm` third path**: after both local paths fail (server L2 → legacy tesseract), the VLM reads the screen as the fallback; the signature is unchanged — with the switch off or no key present, behavior stays byte-for-byte identical.
- **New tool `ask_screen`**: look-and-answer — capture the current clean screen + a natural-language question → the cloud brain answers (read-only, never touches the world; division-of-labor law: millisecond-scale deterministic facts belong to the local reflex, second-scale open semantics to the cloud).

### Design constitution

- **Zero-key, zero-cost graceful degradation**: no apiKey configured ⇒ `degraded:true`, a zero-network short-circuit (no dialing, no encoding, no requests) — the local reflex layer runs on as ever; `degraded` semantics run through all ten organs.
- **Offline tests that never throw and never touch the network**: every failure is expressed as a return value; tests run on injected fake clients / fake fetch.
- **Conservative dual-brain arbitration philosophy**: local and cloud are two independent observation channels — agreement bonuses (verdict +0.1 / arbitration +0.15), disagreements always demoted to uncertain; the fused box is the confidence-weighted convex combination, landing inside the convex hull of the two boxes — never arbitrating into a box neither channel saw.

### Usage

Configure any one channel to light up the cloud brain:

```yaml
config:
  vlmApiKey: 'your Zhipu API key'   # or env: GLM_API_KEY / ZHIPUAI_API_KEY / ZAI_API_KEY
  # vlmBaseUrl / vlmModel already have defaults — override per deployment; vlmAssistOcr: true enables the OCR fallback
```

Once lit, the `ask_screen` tool and its system-prompt usage rules are injected automatically; `vlmAssistOcr: true` activates the VLM third path of `semanticConfirm`. Judgment numbers: the vlm family — 127 tests, 0 failures (ten organs 121 + integration 6); typecheck 0 errors; the build emits the full `dist/vlm`; smoke — 141 modules import clean.

## Epoch AA: The World Jump Engine — open_url

**Target need**: "automatically follow web links". URLs on screen (inside chat body copy, documents, OCR noise) are not controls — clicking them is either vetoed by the Z-2 gate (body copy) or simply misses. The world action law's answer: **links are not clicked — hand them to the OS shell**.

**AA-1 URL sense (`src/urlSense.ts`, pure functions, zero dependencies)**:

- **Lossless extraction**: complete URL substrings are extracted from free text (full OCR text / control names); trailing punctuation is stripped (Chinese full stops and full-width parentheses are OCR adhesions) under a **parenthesis-balance law** — the paired parentheses of a Wikipedia-style `…wiki/Python_(lang)` are part of the URL and must never be stripped;
- **Normalization without guessing**: a `www.` prefix gets `https://` completed (www is an explicit web self-declaration — the only authorized guess); bare domains (`example.com`) are refused — precision first, the same law as the motor arc's quote anchoring;
- **Merciless security screening**: scheme allowlist `[http, https]` — `file://` (local filesystem), `javascript:` (script execution), `data:`/`vbscript:` (data/script payloads) are all structurally refused. The jump engine only ever takes the model to public web pages — **it is not an arbitrary-protocol launcher**; hostless URLs are refused (`http://foo` is a word, not a site), localhost excepted; over-long URLs (>2048) refused.

**AA-1 jump body (`system.openUrl`)**: platform openers (win=`cmd start` / darwin=`open` / linux=`xdg-open`), fire-and-forget — the receipt proves "the shell request was issued", not "the page loaded"; verification is delegated to the world (take_screenshot / switch_window). Windows quote escaping is done by hand at the spawn layer (`windowsVerbatimArguments`) — `&` inside query parameters is routine, Node's default argv quoting does not cover it, and left bare, cmd would read it as a command separator. Real-machine result: `https://example.com/?a=1&b=2` lands intact (evidenced by the Edge window title).

**Four wiring points**:

- `open_url` (new tool, `enableOpenUrl` on by default): the input may be a bare URL or free text containing one (paste the OCR line directly); extraction is exact, and multi-candidate ambiguity is structurally refused (never flip a coin and open one); registered in `ACTION_TOOLS` — jumps are replayable, auditable, and inductible into skills.
- `read_text`: URLs inside full OCR text surface automatically (an `urls_detected` field + next_step guidance toward open_url) — the perception face of "auto-jump"; the model never has to transcribe a link by hand.
- Z-2 click gate: vetoed body copy that contains a URL (from the UIA control-name receipt, reused at zero cost) gets its rerouting exit written into the refusal itself: "don't click — jump with open_url".
- Popup guard: open_url is frozen during popup-active periods as well (handle the popup first; the world's order holds).

## Epoch Z: The World Action Engine — the Interactivity Probe

**Target failure mode**: "conversational text misread as a clickable entry". A chat message that reads "click the login button", a menu name quoted in a document, a task instruction rendered on screen — each is **pixel-equivalent** to a real button; any visual classifier (the LLM included) can only guess.

**World action law: when you cannot tell, ask the world.** Z-1 adjudicates interactivity over three evidence channels, ordered by descending discriminative power (`src/interactivityProbe.ts`):

| Channel | Action | Evidence | Confidence |
| --- | --- | --- | --- |
| 1. UIA point query (Z-1c) | `ControlFromPoint` asks the structural layer about a single point | The officially registered control type (Button/Hyperlink/Text/Edit…); **ancestor-chain law**: a Text label inside a button climbs the ancestor chain until it finds the Button — verdict: control | control 0.97 / text 0.93 |
| 2. Cursor proprioception (Z-1a) | Hover (`move_mouse`, never press) and read `cursor_kind` (Win32 `GetCursorInfo`) | `hand` ⇒ a clickable hotspot the OS itself acknowledges; `ibeam` ⇒ selectable text (body copy / chat messages) — not an entry | control 0.95–0.96 / text 0.92 |
| 3. Hover repaint (Z-1b) | Region dHash before vs after the hover (`metaOnly` fingerprint, zero image transfer) | Controls repaint with hover highlight / underline / tooltip; body copy does not budge | control 0.8–0.85 |

**Two-pass architecture (experimental economics)**: the first pass runs the UIA point query for every candidate — **zero physical side effects** (no mouse movement, no screenshots, no timing jitter), and verdicts are still issued under dry-run and popup-active periods (read-only perception is exempt from guard constraints). Only the residual points where UIA is absent or `unknown` enter the second-pass hover experiment (archive the original position → experiment point by point → restore in a `finally` — the leave-no-trace law). Most points are adjudicated in the first channel; the mouse never moves at all.

**Z-1d verdict memoization (experiment cost amortized to once per scene)**: decisive verdicts (control/text) are recorded together with the full-screen fingerprint at formation (`probeMemory`, LRU + TTL + checkpoint survival); when the same scene recurs (fingerprint similarity ≥ 0.9) and a nearby point is probed again (distance ≤ 0.015, the OCR-bbox micro-jitter tolerance band), the verdict is reused directly — zero experiments, zero mouse movement, equally effective under dry-run / popup-active periods. **Negative memory is precisely the most valuable half**: chat-text `text` refusals are stable, and every `find_text` re-encounters them. Honesty laws: `inconclusive` is never recorded ("don't know" is not evidence); recalled verdicts are demoted one grade (confidence −0.03, capped at 0.9 — `via=memory` never impersonates a fresh experiment); scene drift (chat scrolling / a different screen ⇒ a different fingerprint) invalidates entries automatically and re-experiments. Real-machine measurement: same-scene reuse **877ms → 57ms (15.4×)** — the mouse untouched throughout.

**Z-1e adaptive dwell (hover-experiment speedup)**: decisive cursor shapes (hand/ibeam) decide the moment they are read — the OS switches cursors instantly, so there is no need to wait out the redraw channel's 350ms dwell; only arrow/custom enters redraw polling (150ms steps, stop on detection, at most ceil(dwell/150) steps). The decisive path's per-point cost drops ~750ms → ~240ms; cooldown is only needed after the polling path.

The degradation chain is complete: memory miss → UIA library absent / `DSH_PHYSICAL_L1_BACKEND=disabled` (the pure-vision ideology gate) / unregistered games & canvas ⇒ the channel is absent, silently falling back to the dual hover channels — harmless. `unknown` (Pane/Custom) falls back the same way.

**Four wiring points**:

- `find_text`: OCR hits pass the probe first (priority ambiguous > content-like > control-like, capped by `probeMaxTargets`); every coordinate carries `interactivity=control|text|unprobed` and the deciding channel (`via=uia(Button)` / `via=hover(cursor=ibeam)` / `via=memory`); `next_step` issues an explicit order: "click only control hits; text hits are body copy that merely mentions the keyword — clicking one is an incident".
- `probe_interactivity` (new tool): three-channel adjudication for arbitrary coordinates (memory → UIA → hover experiment) — the model can ask the OS about any text it is unsure of, before clicking.
- `take_screenshot` legend: text in content regions (chat / documents / tables) is data, not UI.
- `click_mouse` (Z-2 click gate): see below.

**Z-2 click gate (the verdict moves ahead of pointer-down)**: Z-1's verdicts only annotate `find_text` results — the model can simply not look. Z-2 wires the same three-channel verdict in front of `click_mouse` execution (`gateTextClick` pure function + `src/tools/clickMouse.ts`): before a left click, the target point is probed; a `text` verdict with confidence ≥ 0.9 (decisive) whose evidence is not an Edit input box ⇒ a structured refusal (`ACTION_REQUIRED`) telling the model "this point is body copy — the text merely *mentions* the label you are looking for", plus rerouting guidance (find a control hit via find_text / re-ground via screenshot / scroll). Every exception channel is explicit: **Edit passes** (clicking an input box to focus it is a legal action), **right-click passes** (context menus over body copy are legal), **`allow_text_click: true` self-certified pass** (the model knowingly clicks text: placing the caret in a document / selecting text), and dry-run / probe-absent keep zero regression. The gate runs before `captureBefore` — the hover experiment may trigger hover highlights, so the before-frame must be taken after the probe, or the "no change" baseline is polluted.
The same law eradicates the zero-model path: L2 OCR tokens from the reflex-arc scene source first pass a geometric-prior cull (`ocrWordsToClickCandidates`, a pure module in `wordShape.ts`) — wide-row / multi-line paragraph shapes no longer stand for landing-point election; "body copy treated as a button" loses its fuel at the spinal-reflex layer (mistakenly culling a real entry ⇒ honest grounding, which is cheaper than mis-clicking body copy).

Relation to the four-layer verification stack: `actionVerifier` verifies "did the click take effect" (after the fact); Z-1/Z-2 verify "should this be clicked at all" (before the fact) — the perception loop moves from the execution domain up into the decision domain. Guard integration: hover experiments are skipped during popup-active / dryRun (UIA verdicts unrestricted); probe failure degrades honestly to `unprobed` rather than lying. The physical service is version-gated at 0.4.0; `/hit_test` belongs to the structural-perception capability bit (`ui_tree`).

## Epoch X — The Graphomotor Epoch: Motor Reflexes for the Reflex-Era Brain

The reflex-era decision brain could only do one thing with the world: click. This epoch gives it a **motor vocabulary** — `type_text` / `scroll_page` / `press_hotkey` — with zero LLM, via `src/intentGrammar.ts` (pure-function intent grammar) and the motor arc in `ReflexiveDecisionStation`:

- **Quote-anchored payload extraction (lossless by construction)**: the text to type must be carried by a reversible encoding — quoted spans (`"…"` / `'…'` / `「…」` / `『…』` / `“…”` / `‘…’`) are extracted exactly (edit distance 0). Free-text extraction is a lossy guess — a mistyped password is as bad as none — and is refused (precision-first). Enforcement itself caught a real defect: contraction apostrophes (`don't`) paired with later single-quote payloads and silently corrupted them; single-quote openers now carry a word-boundary gate.
- **Motor-sequence law (acquire the landing point before writing)**: the dependency DAG `{target → text}` is executed in topological order — `type "gamma" into the server field` first emits the *click* on the field (focus acquisition), the writing follows once focus is carried. The same law protects `press the big red button` from being misrouted into the hotkey arc.
- **Payload disenfranchisement**: the residue (intent minus verbs minus quoted spans) is what votes on *where*; payload words never vote on the landing point — in both the motor arc and deliberation's lexical channel.
- **Born-verified reflex (L4 self-anchor)**: the quote anchor doubles as `expectedText` — for the first time a reflex *knows what its own success looks like* (a click cannot predict pixels; a payload can predict text). The bench's execution station enforces it against world truth.
- **Kinematic domains**: scroll amounts must fall in `[1,20]` (out-of-domain refused, never clamped — clamping would silently rewrite `scroll 999` into 20); hotkey chords normalize key aliases (`control→ctrl`, `escape→esc`) and cap at 4 keys.
- **Hierarchy intact**: Tier-0 immune suppression still gates every motor class; knowledge teaches *where* (workflow lift on residue), grammar teaches *what* (the payload); `disableMotorArc` ablation proves the contribution (typing intents degrade to honest zero-action grounding).

Enforcement: `test/epochX.test.ts` (14 items, X-1..X-9 — extraction tables, arc-selection tables, virtual-screen rehearsal with L4 met, ablation, suppression precedence). Real-machine judgment: the large-scale Data Console bench grows a sixth page (`editor`: three text fields with focus ground-truth) and a `typing` category — real pyautogui **keystrokes** landing in tkinter entries, judged by per-keystroke world state.

The campaign itself eradicated two real-machine defects: (1) `pyautogui.typewrite` passes through the active IME (`alpha.local` → `alpha。local`, `ada` → `阿达`) — the D-5 service now types via `SendInput` + `KEYEVENTF_UNICODE` on Windows, the only IME-orthogonal deterministic text injection; (2) same-baseline nav/content words corrupt tesseract's line segmentation (`settings` + `format disk` in one row ⇒ `setines`, conf 0) — perception now runs **strip OCR** (nav strip | content strip recognized separately, cross-column line mixing impossible by construction), with the nav invariant tightened to all-six-words-present.

## Epoch W — The Seventh Strike: Isolation & Real-Machine Judgment

- **W-1 Singleton isolation audit**: every stateful singleton must expose a reset seam (two real gaps fixed: the approval ledger and the channel-EMA arbitration); enforced by a dirty→reset→initial-state matrix.
- **W-2 Real-machine judgment**: the Windows real-machine benchmark re-run for the first time after six epochs of organ changes — **4/4 green** (real OCR perception, real pyautogui click loop, trap rerouting, learning curve).
- **W-3 Genesis ledger** (`GENESIS.md`): every organ on one line — mathematical root, enforcement test, judgment number.

## Epoch V — Judgment Day: The Joint Organ-Ablation Benchmark

Eight deterministic micro-benchmarks (`test/organAblation.bench.ts`) put the organs on trial with numbers: fuzzy recovery 100% vs 0% baseline; ring-hash catches 90° rotations at 100% while the dual fingerprint is at 0% (orthogonality proven); BM25 MRR 0.583 vs 0.250; EMA channel arbitration reaches 226/300 versus the always-agents 104, within 3.4% of the oracle; reservoir quantiles exact to 0.0% across three distributions; MMR proofs within the log bound; RRF 100% stable under channel rescaling where the weighted sum collapses to 0%; LTLf enforcement pinpoints all three injected violation types. The trial itself caught a real defect (S-3's multiplicative weights let a degraded channel periodically revive) — the verdict, EMA arbitration, was written back into the implementation.

## Epoch U — The Fifth Genesis: Rotation & Self-Reflection

- **U-1 Ring-hash rotation-invariant fingerprint** (third fingerprint; invariance domain honestly scoped to multiples of 90°).
- **U-2 NMS** for nested accessibility-tree element declarations (IoU ≥ 0.6, area-descending greedy).
- **U-3 `GUARD_BLOCKED` chain markers** — every guard interception becomes a tamper-evident policy fact.
- **U-4 Organ census** (`src/organCensus.ts`): 33 mathematical organs registered with self-checks, surfaced in `quality_checkup`.

## Epoch T — The Fourth Genesis: Symmetry & Propagation

- **T-1 Quantized action signatures**: the repeat-action guard's byte-exact signature was blind to coordinate jitter; numeric args now quantize to a 0.01 grid (≈20px at 1080p).
- **T-2 Expectation vocabulary symmetry certified** (verification, not rework).
- **T-3 Verdict-channel coalescing**: duplicate receipts for the same chain merge (newest wins).
- **T-4 Full-jitter exponential backoff** in the service manager (decorrelated retry phases).
- **T-5 Counterfactual effect sizes**: what_if alternatives carry Laplace route rates and a Cohen's h versus the current route.

## Epoch S — The Third Genesis: Six Organs That Close Loops

- **S-1 Snapshot anchor verification**: restored checkpoints recompute the journal MMR root and loudly report anchor mismatches (completing R-4).
- **S-2 Streaming percentiles**: Vitter reservoir-sampling sketches with exact order statistics (O(1)/observation, bounded memory, seedable; the P² marker method was tried, found divergent in this domain, and honestly retired).
- **S-3 Hedge channel arbitration**: the Actor's dual channels learn a multiplicative-weights preference (agents-first tie-break preserved; skill channel takes over after agents fails while skills succeed; floor weight keeps revival possible).
- **S-4 Beta-posterior landmark trust**: (s+1)/(s+2) replaces the linear cap on UI-landmark trust.
- **S-5 Online enforcement of mined properties**: mined LTLf invariants are checked against new traces with per-position violations (mine→enforce closure).
- **S-6 Dual-fingerprint déjà-vu**: subconscious traces carry a pHash second opinion; flashbacks require spectral corroboration.

## Epoch R — The Second Genesis: Six More Organs

- **R-1 Fuzzy layer — `src/fuzzy.ts` (new organ)**: approximate substring edit-distance matching (OCR-tolerant expected_text verification; the Myers bit-vector bound is documented, classic DP chosen for auditability).
- **R-2 Retrieval — BM25**: corpus-statistics IDF with length normalization replaces binary hit counting in the knowledge base.
- **R-3 Breaker — Beta-Bernoulli sequential posterior**: a rolling-window P(failure-rate > 50%) ≥ 0.95 trip arm catching flaky-broken routes the consecutive counter can never see.
- **R-4 Snapshots — v4 evidence anchors**: checkpoints carry journal/sandbox MMR roots; idempotent v1→v4 migration.
- **R-5 Vision — stable cross-frame element IDs**: greedy IoU tracking keeps the same label on the same physical widget across screenshots.
- **R-6 Recall — RRF**: reciprocal-rank fusion over the three failure-memory channels (dimension-free ranking; legacy weighted score kept as `score2`).

## Epoch Q — The Genesis Upgrades: Eight New Organs Across Every Module Cluster

- **Q-1 Proof layer — `src/proof.ts` (new organ)**: a Merkle Mountain Range giving **O(log n) inclusion proofs** over append-only evidence streams; wired into both the journal and sandbox chains — a single root plus a single proof now certifies one record without replaying the chain (tamper-evident across all sizes 1..1000).
- **Q-2 Perception — pHash**: a DCT-II low-spectrum second fingerprint (brightness-invariant via DC exclusion). Its failure modes are near-orthogonal to dHash's; `dualSimilarity` fuses conservatively and `actionVerifier` carries a `phashCorroborates` second opinion.
- **Q-3 Decision — Wald SPRT**: sequential optimal stopping for popup verdicts (Wald–Wolfowitz: minimum expected sample size at fixed error rates). Single semantic frame decides; weak geometric evidence accumulates; terminal decisions lock.
- **Q-4 Knowledge — Dirichlet predictive entropy**: worldModel predictions now carry `entropyBits` (how uninformed the model is about where the world goes next — quantified justification for paid L3 looks) and `posteriorConcentration`.
- **Q-5 Memory — skill phylogeny**: skills record `parents`/`generation`; `lineage()` walks ancestry with cycle guards; capacity eviction grants survival bonuses to ancestors of living lineages.
- **Q-6 Evidence — effect sizes**: Cohen's h for proportion contrasts and a tie-corrected Mann–Whitney U for heavy-tailed latency A/B (never a t-test on GPD-tailed data).
- **Q-7 Exploration — Thompson crystals**: swarm experience crystals rank by Beta posterior sampling — exploration proportional to evidence insufficiency.
- **Q-8 Motion — focus extrapolation**: first-difference velocity estimation projects the focus point across long delays (clamped to half a screen; honest fallback without evidence).

## Epoch P — The Great Bug Hunt: Eradication + Class Immunity

Seven more latent bugs eradicated across a full-repo audit (13 TS files line-by-line + 3 Python files + mechanical scans), headlined by: the `auth_middleware` ordering bug that made the M-era SO_PEERCRED server half **dead on arrival** (peer-PID compare before token parse → UnboundLocalError); an opposite-sign CDF convention silently corrupting the Monte-Carlo A² critical table; and a two-part swarm watermark defect that both voided the N-era cross-session fix and permanently stopped experience accumulation once the journal's sliding window saturated. Plus the immunity machinery: a **Bug Class Registry** (`scripts/bug_class_lint.py`) turning every historical bug class into a mechanical detector wired into `npm run verify`, and a **property-test battery** (`test/epochP.test.ts`) verifying every statistical engine by known-parameter recovery against closed forms — the kind of check example-based tests cannot provide.

## Epoch O — The 28-Item Closeout Campaign

Every remaining item from the post-campaign ledger, delivered in recommended order and enforced one-by-one (`test/epochO.test.ts`):
- **Real-machine Windows benchmark** (`test/realMachineWin.bench.ts`, 4/4 green): real service screenshots → offline tesseract.js OCR → **real pyautogui physical clicks** → tkinter world-state flips; trap-rerouting and the learning curve reproduce on real hardware. Plus a Linux CI workflow with a live POSIX-shm cross-process round-trip test.
- **Latent-bug eradication caught by live verification**: three Windows `set_contrast` bugs (window-handle requirement / illegal PS `\"` escaping / pvParam must be a HIGHCONTRAST **struct**) — live round trip 126→127→126 VERIFIED; a JPEG-closure UnboundLocalError in `screen.py`; the GPD moment-inversion algebra error; the contextManager clock-rollback hazard.
- **Mathematical organs**: PWM second estimator with consistency adjudication; two-sided CUSUM with a lifetime pre-ring baseline; entropy-weighted W₁ (info-view `w1Info`/`infoRatio`); coherent-teleport fields for I-4; an LTLf property miner (bounded-response/precedence/repeat-guard); a Monte-Carlo A² critical table plus Kalman/Schmitt/NCD calibration loops (`src/calibration.ts`).
- **Architecture completions**: `dsh.vision.*` service self-registration (single-owner law); worldModel run-level snapshots (fork/merge replay); dangling-ref validation on restore; sandbox scene-OCR lighting up the dormant L3-semantic layer; a switch_tab tab-stack model; the SO_PEERCRED Node client half (undici UDS dispatcher); station-reported token metering (`tokenUsageReported`); `target_description` as a REQUIRED protocol field; first-round serial knowledge retrieval option; the full Unicode confusables table (1665 distilled entries).

## Epochs J–N: Engineering Convergence, Void-Filling, and Residual Eradication

- **Epoch J — engineering convergence**: fatal fixes unblocking all four main chains (real clicks previously threw 100% of the time; shm transport lifecycle single-owner; degraded rehearsals no longer block host execution; the D-4 `rejected` veto became reachable for the first time). Approval protocol upgraded to *request ≠ consent* — `grant_approval` is now a precondition for execution. Security surface hardened (AppleScript injection order, middleware onion order, nonce double-decode).
- **Epoch K — the honestly-declared blanks, delivered**: a **virtual screen simulator** (deterministic widget world; hit-testing yields L1 evidence, focused-input buffering yields L4 evidence — the `passed` verdict and muscle-memory consolidation became reachable for the first time); a **WindowsAdapter** (PowerShell + Win32 P/Invoke with geometry-snapshot undo); **Actor dual-channel** (DSH agents service → skill replay → honest `[FAILED]`); a **Bayesian cortex** (6-syndrome × 5-signal CPT, exact log-sum-exp enumeration); SSD second-order stochastic dominance; homoglyph normalization; noise-tolerant cycle detection; and the **scientific benchmark suite** (`npm run bench`) — first run all green.
- **Epoch L — service ownership codified**: the natural in-repo owner self-nominates onto the host bus via the optional `ctx.set?` surface (D-5 → `dsh.sandbox`, D-7 → `dsh.knowledge-pipeline`); hosts without `set` keep the existing honest degradation. Contract placeholders promoted from dead exports to enforced surfaces.
- **Epoch M — value-is-boundary**: Windows `set_contrast` via SystemParametersInfo (snapshot + undo); homoglyph arithmetic full table (mathematical alphabets generated from codepoint arithmetic — zero data files); `calibrateCptFromRules()` CPT distillation (32-combination enumeration + Beta smoothing + expert shrinkage); SO_PEERCRED server half (UDS peer-PID capture, `token.pid == peer_pid` enforced).
- **Epoch N — residuals eradicated**: swarm cross-session double-count fixed by a persisted consumption watermark; the approval blind spot eradicated as a hard precondition (a click silent on both description channels returns `ACTION_REQUIRED`, not a pass-through); virtual-screen drag/switch-window evidence delivered. Suite: 325 tests / 318 pass / 0 fail.

## Tool List

| Tool | Description | Key parameters |
| --- | --- | --- |
| `take_screenshot` | Capture + SoM overlay + compression + sliding window + popup sensing + change gating + multi-display awareness (Epoch Σ-5) | `region`, `force?`, `display?` |
| `click_mouse` | Normalized-coordinate click with built-in dHash effect verification + auto memory + Z-2 interactivity gate (left-clicks on static text are structurally refused) | `x`, `y`, `button`, `confidence?`, `target_description?`, `allow_text_click?` |
| `type_text` | Type text at the focus; cross-platform clear-first | `text`, `clearFirst` |
| `scroll_page` | Four-direction scrolling | `direction`, `amount` |
| `press_hotkey` | Key combos (whitelisted, injection-proof) | `keys` (array) |
| `drag_mouse` | Drag (four-beat sequence: move → press → move → release) | `startX/Y`, `endX/Y` |
| `dismiss_popup` | Zero-side-effect meta tool: force a ReAct re-analysis | none |
| `switch_tab` / `switch_window` | Tab / window switching (with fallback paths) | `direction` / `titleKeyword` |
| `click_element` | Click by ID (element mode, short cache against ID drift) | `id` |
| `extract_ui_vision` | Precise extraction via local vision model (optional) | none |
| `start_complex_task` | Planner–Actor orchestration engine | `userRequest` |
| `swarm_dispatch` | Multi-agent team coordinator (one physical body, many minds): spawn role-based sub-agents → act as the active one → report → arbitrate the cross-validated verdict | `action`, `specs?`, `findings?`, `confidence?` |
| `shape_environment` | Reshape the physical workspace (raise / maximize / move window, set zoom / contrast) with a strict LIFO undo log; `capabilities` first, `restore` when done | `action`, `kind?`, `title_hint?`, `x?`, `y?`, `level?` |
| `autonomous_run` | Autonomy-loop meta tool (Epoch Φ, requires `autonomyEnabled: true`): perceive → judge → constitution → execute → verify → evolve in one closed-loop call | `goal`, `success_criteria?`, `max_steps?`, `time_budget_sec?` |
| `zoom_inspect` | Region crop + enlarge + fine grid, two-stage precise grounding | `x`, `y`, `half_size?` |
| `find_text` / `read_text` | Text → exact coordinates / region text read (needs `enableOcr`; URLs auto-surfaced) | `keyword` / `x?`, `y?`, `half_size?` |
| `ask_screen` | Look-and-answer: capture a clean screen + a natural-language question → answered by the GLM vision model (needs `vlmApiKey` / `GLM_API_KEY`; read-only, no actions) | `question` |
| `vlm_platforms` | Platform roster & health check (Epoch Ψ): 13 platforms' configuration status + currently active platform + fallback-pool health; `probe:true` runs the parallel checkup (1×1 white image — real screen content is never sent) | `probe?` |
| `probe_interactivity` | Three-channel interactivity verdict: UIA point query → hover cursor shape → hover repaint | `x`, `y` |
| `open_url` | URL security check (http/https scheme allowlist + noise-tolerant extraction) → jump via the OS default browser | `url` (bare URL or text containing one), `reasoning?` |
| `diff_view` | Visual diff of the last two screenshots: red-box diff image + changed-region list | none |
| `remember_ui` / `recall_ui` | Scene-based UI memory write / natural-language recall | `description`, `x`, `y` / `query` |
| `replay_actions` | Replay an action sequence from the journal (macro) | `confirm`, `from_step?`, `to_step?` |
| `save_skill` / `match_skill` / `run_skill` | Skill persistence / reliability matching / one-click execution (outcomes write back reliability) | `description` / `query` / `id`, `confirm` |
| `quality_checkup` | The Quality Doctor's clinic (D-4): diagnose code genes & causal chains, heal mechanical fixes under explicit authorization, lessons, self-audit; fifth action `notarize` emits the four-green-seal notary report (Epoch Π) | `action`, `files?`, `authorize?`, `max_risk?`, `dry_run?` |
| `request_approval` / `grant_approval` | Human-in-the-loop approval gate (needs `enableApprovalGate`): mint a one-consent token for irreversible actions (one consent covers the whole task's retry window; stage into the offline queue when the user is away); grant requires the user's out-of-band 6-digit confirm code (W1-2) and fails closed when the out-of-band channel is absent | `description`, `consequence?`, `stage?` / `token`, `grant`, `confirm_code?`, `note?` |
| `adjudicate_approval_queue` | Batch adjudication of the offline staging queue (W2-1): the morning report lists staged irreversible actions; the user rules once with annotations (grants reuse the amendment protocol; expired items conservatively refused; no re-deciding) | `ids?`, `grant`, `note?` |
| `what_if` / `swarm_report` | Counterfactual reasoning (how much better the alternative route is — Laplace route rates + Cohen's h) / swarm wisdom report (needs `enableJournal`) | `scenario` / none |
| `get_metrics` / `verify_journal` / `self_diagnose` | Engineering-excellence trio (needs `enableTelemetry`): runtime telemetry percentiles & insights / action-journal hash-chain audit (tamper-evident) / live health checks of all subsystems | none / `from_step?` / none |
| `save_checkpoint` | Full cognitive-state snapshot (UI memory / skills / failure memory / journal chain / metrics; atomic write; needs `checkpointPath`) | none |
| `federation_sync` | Federation of brains (Epoch Μ, needs `kernelEvolutionEnabled` or `federationEndpoint`): mint differentially-private evidence digests, optionally POST to an aggregation endpoint, and blend returned digests into the LOCAL LEDGER ONLY; robust Byzantine aggregation by default, zero network with an empty endpoint; HMAC-signed when `DSH_FEDERATION_TOKEN` is set | `action?` (digest/sync/status), `robust?` |
| `steer_choice` / `steer_answer` | Intent-drift check pair (W3-5, needs `autonomyEnabled`): when the screen drifts too far from the goal, issue a single-key A/B/C question (continue / amend criterion / terminate); answers settle via `steer_answer` (garbage input re-asks, never guesses; a held branch card makes "2"/"B2" switch branches) | `step_index`, `entropy?` / `answer` |

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

### Configuration for the cloud cortex & autonomy

All fields below have code defaults; the cloud cortex and the autonomy loop are strictly opt-in:

```yaml
config:
  # Cloud cortex (Epoch Ω) — any one channel lights it up:
  vlmApiKey: 'your-api-key'        # or env: GLM_API_KEY / ZHIPUAI_API_KEY / ZAI_API_KEY
  # vlmBaseUrl: 'https://open.bigmodel.cn/api/paas/v4'   (default)
  # vlmModel: 'glm-5.3-flash'                              (default)
  # vlmAssistOcr: true    # VLM reads the screen as the third path when both local OCR paths fail
  # One brain, every platform (Epoch Ψ) — explicit platform + CSV fallback chain:
  # vlmProvider: 'openai' # or anthropic / gemini / qwen / moonshot / doubao / xai /
  #                       #    siliconflow / openrouter / ollama / lmstudio / vllm
  #                       # empty = auto-detect from env (any platform key works)
  # vlmFallbackProviders: 'anthropic,gemini'   # backups step up when the primary trips
  # Autonomy loop (Epoch Φ) — off by default; the legislator explicitly opts in:
  # autonomyEnabled: true
  # autonomyMaxSteps: 24 / autonomyTimeBudgetSec: 300 / autonomyAllowTiers: 'benign'
  # autonomyVlmWhenUncertain: true / autonomyForbiddenKeywords: ''
```

With no key configured, the cloud cortex reports `degraded` and performs zero network calls — the local reflex layer keeps running unchanged. With `autonomyEnabled: true`, one `autonomous_run({ goal: '…', success_criteria: ['…'] })` call drives the whole perceive → judge → constitution → execute → verify → evolve loop; use `vlm_platforms({ probe: true })` to check which of the 13 vision platforms are configured and healthy.

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

