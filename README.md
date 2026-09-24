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

**接线三处**：

- `find_text`：OCR 命中先过探针（优先级 ambiguous > content-like > control-like，上限 `probeMaxTargets`），每条坐标携带 `interactivity=control|text|unprobed` 与判决通道（`via=uia(Button)` / `via=hover(cursor=ibeam)` / `via=memory`）；`next_step` 明令「只点 control；text 是提到关键词的正文，点了就是事故」。
- `probe_interactivity`（新工具）：对任意坐标做三通道判决（记忆 → UIA → 悬停实验）—— 模型对任何拿不准的文字都可在点击前问一句 OS。
- `take_screenshot` 图例：内容区文字（聊天/文档/表格）是数据不是 UI。

与四层验证栈的关系：`actionVerifier` 验证「点击之后有没有生效」（事后），Z-1 验证「点击之前该不该点」（事前）—— 感知闭环从执行域前移到决策域。守卫集成：悬停实验在弹窗激活期/dryRun 下跳过（UIA 判决不受限）、探针失败诚实降级为 `unprobed` 而非谎报。物理服务版本门控 0.4.0；`/hit_test` 属结构感知能力位（`ui_tree`）。

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
| `find_text` / `read_text` | 文字→精确坐标（内置交互性探针判决）/ 区域文字读取（需 `enableOcr`） | `keyword` / `x?`,`y?`,`half_size?` |
| `probe_interactivity` | 三通道交互性判决：UIA 点查询 → 悬停光标形态 → 悬停重绘 | `x`, `y` |
| `diff_view` | 最近两截图的视觉差分：红框变化图 + 区域坐标清单 | 无 |
| `remember_ui` / `recall_ui` | 场景式 UI 记忆写入 / 自然语言召回 | `description`,`x`,`y` / `query` |
| `replay_actions` | 重放日志中的动作序列（宏） | `confirm`, `from_step?`, `to_step?` |
| `save_skill` / `match_skill` / `run_skill` | 技能沉淀 / 可靠度匹配 / 一键执行（成败回写可靠度） | `description` / `query` / `id`,`confirm` |

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

