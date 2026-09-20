# Epoch J — 工程收敛纪元（Engineering Convergence）

> 第九纪元。前八纪元（B→I）建的是能力；J 纪元还的是债 —— 一次全库逐行审读
> （20,388 行 TS + 3,032 行 Python + 8,194 行测试）之后，把审读发现的全部
> 结构性缺陷一次性收敛。方法论不变：每项修复配独立执法测试（epochJ.test.ts，
> 14 用例），防「借尸还魂」。

## 回归基线

- 基线：273 项 / 266 pass / 0 代码性 fail / 7 skipped（sharp 与 Python 服务缺席的环境项）
- 终态：**287 项 / 280 pass / 0 fail / 7 skipped**（净增 14 项 J 纪元执法测试，全绿）
- `tsc --noEmit` 零错误；Python 侧 `compileall` 零错误
- 3 项既有测试按协议升级有意更新（B-3 审批两例 + safetySystems 审批一例），
  更新原因见 J-4；其余 267 项零改动通过 —— 零回归承诺兑现

## 致命级修复（四条主链路首次真正打通）

### J-A 物理点击 100% 失败（input.py）
`_run_in_executor(pa.click, px, py, button=btn, ...)` 旧签名不收 kwargs ⇒
必抛 `TypeError` 被 `safe_call` 归为 internal_error —— 非 dry-run 点击全灭。
修复：executor 支持 kwargs（`functools.partial`）。同文件：屏幕尺寸缓存加
30s TTL（分辨率热插拔不再终身旧值）；drag 的 dry-run 假像素（`int(sx*1000)`）
改为真实换算或诚实的"无显示仅归一化"回执；键白名单补 f6-f10。

### J-B health 类型错位 → NaN 坐标（routes.py + ui_tree.py + d7HostPort.ts）
health 误用 input 控制器的 tuple 版 `get_screen_size()`（序列化成 `[w,h]`），
Node 端 `HealthInfo.screen` 契约是 `{width,height}` ⇒ `undefined` 除法产出
**NaN 归一化坐标**（静默数据损坏）。修复：health 改用 screen 控制器的 dict
版本；`capabilities` 语义撞名修正（真能力位图 + `controllers` 分列）。

### J-C 截图共享内存通道（shm.py）
三处独立缺陷：① `weakref.finalize` 挂在 routes 层的瞬态 handle 上 ——
CPython 引用计数下 finalizer 在响应前后即 munmap/unlink，Node 端 reopen
必然 ENOENT（**shm 模式实际不可用**）；② mmap-file 注册表键（短名）与
`ShmHandle.name`（全路径）不一致 —— DELETE 端点永恒 miss；③ `or/and`
优先级使 Windows 强制 shm 静默跌落 base64（与文档相反）。
修复：注册表成为唯一生命周期（移除 weakref）；键 = handle.name 严格一致；
显式级联降级；double-close 单一出口 + 失败路径回收半成品对象；GC 顺手在
release 时触发。

### J-D D-5+D-6 组合必败（orchestration/stations.ts）
D-5 排练 verdict 恒 `degraded`（虚拟屏验证层是声明的留白），而执行工位
`verdict !== 'passed'` 一刀切拒绝 ⇒ 默认配置（rehearseBeforeExecute=true
且 D-5 服务在场）下**每个动作都死在预演闸门，流水线恒 failed**。
修复：`failed`/`aborted` 仍拒（硬反证据/预算耗尽）；`degraded` = 无证据
⇒ 照常交付，效果验证交宿主，`rehearsed` 不冒领。哲学对齐：「无证据」阻断
**记忆固化**（D-5 freeze-for-review），不阻断执行。

## 严重级修复

### J-E doctor verdict 三方言配对（orchestration + doctorChannel）
全库唯一发射方 doctorChannel 的 subject = chainId，而 D-6 按
`${intentRef}:${seq}` 解析 ⇒ 判决索引/补写/查询永恒空转；`chain-exec-${seq}`
在并发 run 下还撞号。修复：执行工位编入 `chain-exec-${intentRef}-${seq}`
并经新契约字段 `ExecutionResult.rehearsalChainId` 回流 AttemptRecord；
`backfillVerdict` 双方言精确匹配；run 出环后 `reconcileVerdicts` 回收在途
判决 —— 顺带兑现 **'rejected' verdict 的首次可达**（D-4 否决权）。

### J-F 审批协议升级：grant 是执行的必要条件（approval.ts + 工具层）
旧协议"从未 grant"与"grant=true"对执行层无区别（validate 只查在场+TTL）——
同意环节形同虚设。升级：`PendingApproval.granted` + `grant()` 落点；
validate/consume 双要求已授予。配套：click_mouse 锚点新增 `approval_gate`
透明化盲区（描述缺席时闸门物理失明 —— 无法强制但必须可见）；
type_text 回显防御纵深（文本命中风险词时无论闸门开关一律 `[REDACTED]`）。
**这是本纪元唯一一处有意变更既有测试语义的修复**（3 例更新如上）。

### J-G 安全修复（Python 服务）
- AppleScript 注入：f-string 先插值后 replace 占位符 = no-op，原始 keyword
  直接入脚本；转义顺序也反了。修复：先转义反斜杠再转义引号，转义值直接插值。
- `POST /v1/mint_token` 移除：自举死锁（被 auth 挡住永不可达）+ 安全洞
  （若入白名单则任何本地进程可免密铸全能力 token）的组合。信任根 = 密钥文件。
- 中间件洋葱序修正：unhandled 兜底注册到最后 = 最外层（旧序下中间件自身
  异常漏成真 500）；nonce 防重放复用 `parse_token` 的 exp（删手工双解）；
  `safe_call` 信封透传判据收紧（status 必须在词表内）。

### J-H swarm 重复计数（swarm.ts）
注释宣称"增量式"，实现无游标全量遍历，而调用点极多（5 分钟定时器 / 每次
what_if / checkpoint）⇒ 成功率先验系统性膨胀。修复：WeakSet 身份游标
（给 journal 条目补 seq 会改哈希域破坏旧链 verify —— 身份游标零迁移成本；
跨会话残差如实记入注释）。执法测试 J-2：重复 crystalize 零新增 + 增量入账。

### J-I 钉扎名额泄漏（contextManager.ts）
pinnedCount 统计含已降级记录，解钉只作用于有图候选 ⇒ 安全阀驱逐钉扎图后
名额永久占用（pinBudget=1 时从此任何图无法钉扎）。修复：降级即解钉（驱逐
路径 + refreshPins 僵尸清理 + 计数只认有图记录）。执法测试 J-8：驱逐后
高显著度图仍可钉扎并存续。

### J-K 知识层口径统一（knowledge/*）
- **Tier 0 压制判据**：从全类别 maxConfidence 改为 error-pattern 条目最大值
  （与 Tier 2 逐 fragment 判定同口径）—— 高置信 workflow 不再劫持压制（J-4a/b）。
- escalateL3 去粘性：forceL3 消费后即失能，升级权只由本轮转移结算重新授予
  （旧实现一次惊讶后 L3 持续计费多轮）。
- tokenize 统一：KB 检索通道复用 uiMemory 分词（CJK 单字+二元组）——
  旧私有分词把 CJK 连续串当整体 token，与决策通道不同构，中文 keyword
  通道几乎必然哑火。
- hybridScore token 去重（"click click click" 三倍加权消灭）；
  degraded 痕迹如实标注（不再学成 "succeeded"）；快照水合执法容量上限；
  损坏状态文件改名隔离（`.corrupt-<ts>`）而非被首个 run-end 无声覆写；
  主入口接通 stateDir/metricsPath（反遗忘与仪表盘此前在插件运行中休眠）；
  P 代理 symbol 键防御。

## 中等级修复（择要）

| 修复 | 位置 | 内容 |
| --- | --- | --- |
| to_step 下界钳制 | replayActions / skillTools | `to=max(from, min(len-1, to))` —— 负数不再触发 slice 尾部语义铸错技能（J-10） |
| similarity 长度自适应 | perceptualHash | 分母取实际位长（旧硬编码 64：10 位全异 = 0.84）（J-3） |
| DIMS 死常量删除 | semanticHash | "256 桶"从未实现（实际 32 位 FNV-1a 全域）—— 注释撒谎级别失真清除 |
| repeatGuard 契约化 | guards | 嗅探 `'"status": "FAILED"'` 缩进巧合改走 classifyResult（B-2 教义的违例者归队）；stale 签名防线（post 与 pre 工具名对账） |
| grounding 裁决兑现 | orchestration/pipeline | approveGrounding 实现注释承诺：幻觉 regionId 拒绝、已 L3 拒绝重扫、无 regionId 批准**全网格**（旧恒批准+静默回退左上象限）；L3 结果**并入**场景而非替换（视野不再永久收窄到 1/4 屏）（J-6a/b） |
| L1 fault 降级断裂 | orchestration/stations | fault 分支不再 `continue` 跳过本区 L2/L3（注释与行为一致化） |
| 视觉适配器吐错 | visionAdapters | 不再吞错返 []（fault 归因链修复）+ OCR 负缓存（失败窗口内不重复整屏截屏） |
| 发号器三连 | skillLibrary | checkpoint 携带 nextSynthId；稀疏 ids 下 nextId 取 max+1；recombine 撞签名真实强化（bump 计数） |
| heal 多行空 catch | qualityDoctor | open 行注释化真实改写（旧 no-op 却计入 totalFixesApplied）（J-9） |
| doctorChannel 队列 | doctorChannel | busy 期间到达进 FIFO（上限 4）而非直接丢弃 |
| 物理层门控 | physicalExecution/router | click/drag 坐标缺失/非法 ⇒ gate-rejected（旧静默点屏幕中心/左上角）；switch_tab 全平台 Ctrl+Tab（旧 darwin 用 Cmd+Tab 实际切换应用） |
| d7HostPort 韧性 | physicalExecution | 初始化失败可重试（旧 rejected promise 永久缓存 = 实例终身瘫痪）；adapter 覆盖项不再覆盖连接事实；`_translateTree` 坐标直通 + depth 忠实映射（L3/empty 不再伪装 L1） |
| 坐标系统一 | ui_tree.py | 服务输出统一为**全屏归一化**（L1 像素÷屏幕、L2 裁剪内像素回映射、L3 图内归一经 region 复合）—— 三层坐标混用 + Node 端二次缩小一并消灭；L1 region 中心过滤生效（旧三层后端全部忽略 region） |
| get_ui_tree 复用截屏 | routes.py | 走 ScreenCapture 统一路径（享受测试合成图降级）；截屏失败不再 `pass` 静默 |
| healthCache 兑现 | adapter.ts | 只写不读的死缓存 + 无人消费的 healthCheckIntervalMs —— TTL 30s 读路径 |
| UDS 诚实拒绝 | adapter.ts | `http+unix://` 声明支持但 undici fetch 不认 —— 加载层显式拒绝优于运行时误导 |
| type-only 导入 | skillTools.ts | 接口按值导入在 Node strip-only 运行时必炸（`does not provide an export named 'Skill'`）—— 真实潜伏 bug，epochJ 首次构造该工具时引爆并修复 |
| 工具 schema 兼容 | 19 个工具文件 | 清扫 50 处 `required: false` —— 严格 schema 编译器（dsh-tools）要求 required 键存在即必须为 true；schemastery 语义缺省即可选，删除冗余键双版本兼容 |
| 杂项 | journal / cli / planner / system / textTools / config.py / errors.py | JSONL 磁盘写尾链串行化（行序=链序）；doctorCli .catch；planner 漏 id 按序补齐；nut-js 错误保留 .cause；read_text 单坐标诚实报错；Python env 绑定补全（L1/L2/OCR 语言/API-key env 名）+ dataclass/env 缺省对齐 + fail_safe_corner 死字段删除 |

## 方法论注记

- **J 纪元的修复优先级**由「致命 → 严重 → 中等」的三级审读分级驱动；
  每处修复在代码内携带 `J 纪元修正` 注记（含旧缺陷的机理），git blame
  之外留下第二层可考古性。
- **协议升级的测试纪律**：变更既有测试语义时（J-F 审批授予门，3 例），
  测试名携带纪元标注且断言消息说明新旧协议差异 —— 与 v3.1 参数采纳先例
  同律：「承重性是向量的高阶函数」，协议变更必须重立执法。

## 诚实边界（本纪元未覆盖 / 已知残差）

1. 跨会话 swarm 结晶仍会重复入账一次（checkpoint 恢复的条目是新对象 ——
   身份游标的固有边界，已记入代码注释）。
2. 审批闸门的盲区只能透明化不能根除（target_description 是模型自由
   参数；锚点 `approval_gate: 'blind-spot'` 是最大可达的诚实）。
3. D-5 虚拟屏模拟器仍是声明的留白 —— J-D 只是让留白不再阻断执行；
  verdict 'passed' 依旧不可达，肌肉记忆固化保持 freeze-for-review。
4. ~~'escalated' 态无赋值路径~~ —— 已在追加轮兑现双语义（见附录三），七态枚举无死态。
5. Python 侧 PID Attestation 仍是存在性校验（二进制白名单为空集 ——
   SO_PEERCRED 需自定义 uvicorn handler，留白如旧但文档已如实）。
6. 本机 Windows 环境未覆盖的路径：UDS 监听、X11 窗口栈、真机基准
  （realMachine.bench 需 Xvfb）—— 7 项环境 skip 与基线一致。

## 附录：致命级修复的运行时验收（世界级证据，J 纪元追加）

> 修复的下半场是证明。本机（Windows / Python 3.13+ / fastapi+uvicorn+PIL 在场，
> pyautogui 缺席）三路证据：

1. **集成测试真机解锁**：`physicalExecution.{d7HostPort,shmReader,screenshotHandle}`
   三组测试此前因服务起不来整组跳过（基线 7 skip 中的主体）——现在
   **20/20 真实执行全部通过**：真实 spawn Python 微服务、HTTP 探活、
   perceive→execute 双端口同进程（pid 不变）、跨进程 mmap-file 通道逐字节读回、
   显式释放语义。
2. **运行时证据脚本**（`scripts/verify_fatal_fixes.py`，14/14 通过）：
   - V1a-d：受控桩直击原崩溃行 —— 真实（非 dry-run）点击不再抛 TypeError，
     `button`/`_pause` kwargs 完整抵达 pyautogui（`('click', 960, 540, 'right',
     {'_pause': False})`），像素回执正确，屏幕尺寸 TTL 过期后随分辨率刷新
     （1920→2560 重算为 1280）。
   - V2a-c：health.screen 成功臂是 `{width,height}` dict（错误臂诚实进入
     `{error}` —— TS 契约联合两臂全部实测）；capabilities 是能力位图。
   - V3a-g：weakref 兜底已移除；注册表键 == ShmHandle.name（DELETE 可命中）；
     **gc.collect() 后通道仍存活**（旧实现在此 munmap/unlink）；10240 字节
     逐位一致；显式释放 True → 文件消失 → 二次释放诚实 False（幂等）。
3. **消费侧纵深防御（新增）**：`sanitizeScreenSize` 有限正数闸（纯函数导出）——
   任何一端未来再产出坏尺寸（undefined/NaN/0/负/Infinity 一切旧事故形态）
   ⇒ 缓存保持 null ⇒ perceive 诚实 fault，NaN 归一化坐标永久免疫。
   执法测试 J-11 锁定七种形态。

D-5+D-6 预演闸门（J-D）的执法由 epochJ J-5a/b 承担（degraded 放行 + failed
拒绝 + rehearsalChainId 回流），随全量套件通过。

**终态：288 项测试 / 281 pass / 0 fail / 7 skipped；tsc 零错误；
`python scripts/verify_fatal_fixes.py` 14/14。**

## 附录三：严重级升级（J 纪元追加轮）—— 七态无死态 + 盲区收窄 + 可测转义

> 严重级七条（subject 协议 / mint_token / AppleScript / 审批 / swarm / 钉扎 /
> 压制口径）已在主提交修复。本轮补上修复后仍存留的三个结构性弱点：

1. **'escalated' 兑现双语义**（此前七态枚举的死态，`rejected` 已在主轮可达）：
   - 路径 A：grounding 批准预算熔断 ⇒ `escalated`（决策层持续索要 L3 帮助 =
     流水线自身无法推进 ⇒ **上交裁决权**，而非谎称 'failed'；p0-fixes 的
     熔断测试按协议升级同步更新）；
   - 路径 B：`reconcileVerdicts` 中报告自称 completed 而最后一条 attempt 的
     D-4 判决为 needs_review ⇒ 降格 `escalated`（硬证据说成了但医生要复核 ⇒
     上交人类，不静默放行；保守边界：非 completed 不受篡改）。执法 J-12/J-13。
2. **审批盲区收窄**：`expected_text` 成为第二危险信号 —— 模型即使沉默不填
   target_description，其对按钮的自述（"预期出现『发送订单』字样"）同样触发
   闸门；绕过需要同时沉默**两条独立信号通道**，锚点携带 `danger_signal`
   归因。执法 J-14。
3. **AppleScript 转义提为纯函数** `escape_applescript`（顺序铁律注释内立法）；
   运行时证据 S2a-c：转义正确、每个引号被反斜杠前导（注入面闭合）、
   反斜杠先行（旧顺序错误形态结构性不可复现）。
4. **运行时证据扩至 20/20**（verify 脚本新增 S1/S2/S3）：mint_token 从路由表
   消失（10 条路由实证）、AuthResult 单次解析携带 exp（nonce 上界直取）、
   篡改签名拒绝。
5. **全模块烟测导入器**（`npm run smoke`）：112 个 src 模块在 Node strip-only
   运行时逐一 import —— 又捕获两枚同型潜伏炸弹（clickMouse 的
   CombinedEffect/SemanticConfirm 接口按值导入，生产 bundler 约定会掩盖），
   已修复并固化为永久防线。

**终态：291 项测试 / 284 pass / 0 fail / 7 skipped；epochJ 18 项执法；
verify 脚本 20/20；112 模块导入干净；tsc 零错误；dist 已重建。**

## 附录四：中等级收口（J 纪元第三轮）—— 命名消歧 × 词表对称 × 机制化

> 中等级约 40 项中 34 项已在主提交修复（to_step / DIMS / similarity /
> repeatGuard / nextSynthId / recombine / 回显 / UDS / initPromise / grounding
> 视野 / 适配器吞错 / persistence 接线 / 双 tokenize 等各有执法测试）。本轮
> 收口剩余 7 项结构性弱点：

1. **同名异构类型消歧**：knowledge 侧 `DoctorVerdictPayload`（D-7 内部三态
   方言）更名 **`D7DoctorVerdict`** —— 与 D-4 事件方言
   `doctorEvents.DoctorVerdictPayload`（subject/chainTip/score 载荷）以命名
   立分，跨文件阅读不再混淆；adapters/index 联动改写，编译期全库验证。
2. **parseExpectation 词表对称**（J-15）：JSON 分支与简写分支走**同一 kind
   词表校验** —— 旧实现 JSON 分支任意字符串直通 as 断言，模型拼错 kind 得
   到"貌似合法实为弃权"的裁决；现在未知 kind ⇒ null（诚实缺席），下游零回归。
3. **PID 白名单机制化**（S5a-c）：`_NODE_BINARY_HASHES` 从环境变量
   `DSH_PHYSICAL_PID_WHITELIST` 装载（逗号分隔 64-hex；非法条目**整条拒绝**
   —— 半载白名单比空表更危险）；Layer 2 从"永远空集的空壳"变为可用旋钮，
   传输层 SO_PEERCRED 仍诚实留白。
4. **visualOverlay NaN 防御**：外部 UI 数据的非有限/非正 rect 直接跳过、
   有效 rect 与准星同律夹取 —— 非法 SVG 毒化整张叠加图的路径关闭。
5. **tokenUsage 诚实重命名** → `tokenBudgetsGranted`（契约/流水线/日志/工具
   输出四处联动）：它计量的是授予的信封预算而非实际消耗 —— 旧名暗示消耗，
   名不副实；模型面 JSON 键同步为 `token_budgets_granted`。
6. **auditGuard 深层脱敏**：敏感键的数组/嵌套对象整值脱敏 + 一层递归 ——
   旧实现数组原样放行（`text: ["pwd1","pwd2"]` 全裸进控制台）。
7. **文档性收口**：uiMemory 召回的"信任/新近独立过线填充"正式立法为设计
   决策（含行为切换路径）；diffView 焦点窗口 2× 命名化（双标是有意的）；
   fitGpdTail 门槛"必要非充分"注记（实践需 200+ 样本）；telemetry.render
   列宽 24 截断；serviceManager 重生路径条件语义注释。

**终态：292 项测试 / 285 pass / 0 fail / 7 skipped；epochJ 19 项执法；
verify 脚本 23/23；112 模块导入干净；tsc 零错误；dist 已重建。**

## 附录五：K 纪元 —— 留白兑现（代码诚实声明的，逐一落成）

> 终章。J 纪元修的是"坏"；K 纪元填的是"空"—— 各纪元诚实边界章节声明的
> 留白，七项落成 + 一项机制化，每项配 epochK 执法（17 用例）。

1. **虚拟屏模拟器**（D-5 冻结的根源 —— `sandbox/virtualScreen.ts`）：
   确定性**控件世界**（非像素渲染 —— 绝不假装渲染屏幕）：场景由调用方供给
   （生产 = 规划期 UI 树提取的真实控件几何），click 走命中测试（L1 证据：
   命中=聚焦转移/落空=反证），type 校验焦点控件的文本接收与缓冲包含
   （L4 证据：expectedText 核验）。引擎 verdict 规则同步升格：**任何反证**
   （L1 落空或 L4 期望违例）⇒ failed（与宿主 intentBetrayed 同律）。
   历史性结果：**'passed' 首次可达，肌肉记忆固化首次真实入库**（K-1e：
   passed × 医生 approved → 双闸门放行 → recall 可召回）——
   "记忆固化恒 freeze"的留白终结。无场景 ⇒ degraded 零回归（K-1c）。
2. **WindowsAdapter 落成**（PowerShell + Win32 P/Invoke）：raise/maximize/
   move/set_zoom 四动作 + 几何快照撤销（SetWindowPos 精确归位）；PS 单引号
   转义闭合标题注入面（K-2b："O'Brien" → 'O''Brien'）；set_contrast 诚实
   缺席（注册表+SPI 往返不可靠 —— 留白如实申报）。**genesis.premature-impl
   规则诚实演化**：从"不得实现"到"注入纪律"（实现合法，裸进程调用违法 ——
   K-2d 双向执法：真实源码零违规 + 裸调用形态仍被拦截）。本机即 Windows：
   能力探测真机生效（agency 的空能力测试改经 NullAdapter 注入锁死）。
3. **Actor 双通道接线**（start_complex_task）：① DSH agents 服务在场 ⇒
   原生通道（获取/调用双故障并入诚实 FAILED）；② 技能重放回退 —— 可靠度
   >0.5（Laplace 0/0=0.5 不入场）的匹配逐步重放并回写可靠度；
   ③ 双缺席 ⇒ 诚实 [FAILED] 零回归（K-3a/b/c）。"Actor 未接线"终结。
4. **贝叶斯会诊皮层**（diagnosis.ts）：六症候群 × 五信号的专家 CPT +
   精确枚举归一（log-sum-exp，零近似零采样）；规则表仍主诊断，信念表给
   证据组合全景 —— get_metrics 附加 `BELIEF` 洞见行。全缺席/全阴 ⇒ null
   （健康是诚实的缺席）；后验和 = 1（K-4）。"贝叶斯网络留白"兑现。
5. **SSD 二阶随机占优**（telemetry）：FSD 交叉分布（如 [10,50] vs [20,30]）
   由下偏矩不等式裁决 —— 全序 FSD ⊂ SSD；latencyDominancePairs 升级
   `order: 'FSD' | 'SSD'`（K-5）。"部分序留白"兑现。附带 `seededUniform`
   （mulberry32）—— MC p 值可复现（K-5）。
6. **同形字归一**（riskGate）：西里尔/希腊视觉同形 + 全角字母数字的策展
   映射表（~50 条，值即边界；扩展纯数据零风险）—— 三重混淆叠加
   （西里尔 а + leet 0）也命中（K-6）。E-6 的"Unicode 同形攻击留白"兑现。
7. **噪声容忍循环检测**（oscillationTracker）：精确匹配升级为汉明容差 6 位
   （与既视感阈值同律，远小于场景切换 ≥24）—— 周期内 ≤6 位抖动不再断尾
   （epochE 新增噪声测试）；"互异"语义随容差升级（旧 1 位步进夹具实为噪声级
   抖动）。E-3 的"模糊循环检测留白"兑现。
8. **附带的第四枚类型炸弹**：orchestrator 的 `ChatFn/SubTask` 按值导入
   （epochK 首次直载即爆）—— type-only 修复；smoke 导入器扩至 113 模块全绿。

**K 纪元终态：310 项测试 / 303 pass / 0 fail / 7 skipped；epochK 17 项执法；
113 模块导入干净；verify 23/23；tsc 零错误；dist 已重建。**

## 留白清账总表（K 纪元后仍诚实声明的）

- 传输层 SO_PEERCRED（需自定义 uvicorn handler —— Linux 独有，本机不可测）
- Windows set_contrast（注册表+SPI 往返不可靠）
- 虚拟屏的 scroll/hotkey/switch 证据（布局与键盘状态模型仍留白）
- 贝叶斯 CPT 为专家律（无训练数据 —— 值即边界）
- Homoglyph 策展子集（consortium 全表数千条 —— 扩展是数据工作非架构工作）
