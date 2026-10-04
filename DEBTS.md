# 全局债务台账（DEBTS LEDGER）

> 定位：五纪元（W1 执行与感知韧性 / W2 离线韧性与成本自律 / W3 活意图与自纠偏 /
> W4 第四批器官潮 / W5 第五批收官潮）各包报告与 GENESIS「缝隙诚实」段的全量遗留
> 汇总——账（GENESIS 登记的功绩）实（未闭的缝隙）分离，本册只记债。
>
> 复核律：登记前由 W6-0 实跑复核（全量 2018 用例、w5 七包逐件、7 bench、tsc exit 0），
> 审判数字逐一过秤；账实不一致处如实标注（见 D-E1 与文末复核记录）。
>
> 状态枚举（每条恰一）：**已闭环**（债清，留档防复发）｜**本纪元W6处理**（W6 后续
> 包职权内可闭）｜**需真机**（硬件/长跑数据在环才能闭）｜**需部署决策**（扩表/
> 生产化/开闸是部署方知识决策，代码不代立法）｜**需人工**（插件面/CI 环境/拆分
> 决策等非代码职权）｜**已知取舍**（历史枚举——本族已由 W9-5 全体升格「已定谳」，
> 保留防旧档引用）｜**已定谳**（W9-5 终谳 2026-10-04：设计决策定谳维持，非未闭
> 债——留档防反复翻案）｜**部分闭环**（ΑΩ-R45 补登 2026-10-04：窗口份额已闭、
> 余量留案待后续窗口提案——D-F4 在用；W9 收稿时点的枚举口径遗留，ΑΩ 补正入册）｜
> **待拆**（ΝΩ-54 新立 2026-10-04：cycle_lint 执法在案的结构债——破环属后续窗口
> 代码工程职权，登记防依赖图回到无执法演化的旧态）。

<!-- W7 审计改正：状态枚举补「已知取舍」（原头部遗漏，11+ 条目在用） -->
<!-- ΝΩ-54 审计补正：状态枚举补「待拆」（D-F5 依赖环债在用） -->

## A. 真机验证清单（离线执法已绿，待硬件/长跑在环定谳）

| # | 来源 | 描述 | 状态 | 证据 |
| --- | --- | --- | --- | --- |
| D-A1 | W4-6（零 API 设备面·UVC） | HDMI 采集卡帧管线待真硬件在环验证（四角校准/方言对齐/降级链的实帧闭环）；离线 `--selftest` 58 断言只证协议数学与降级链——**W9-4 软件在环已闭**：本机 cv2 5.0.0 + DirectShow 真设备 15 连帧过完整 uvc 管线（通道序逐像素钉死/恒等与过扫描校准/dhash 门控 12 判决/PNG·JPEG 编码，帧证据 real_probe_dA1_frame.jpg）；唯余真采集卡现场标定 | 已闭环（软件在环；唯余现场标定=物理边界） | python_service/dsh_physical/uvc.py（selftest）；GENESIS「真机验证清单」段 |
| D-A2 | W4-6（零 API 设备面·HID） | CH9329 串口 HID 棒待真棒在环（SUM/CRC-16 帧构造已 dry-run 可验；pyserial 缺席环境已诚实降级——本机复核日志「pyserial unavailable」） | 需真机 | python_service/dsh_physical/hid.py；test/w5pyreg.test.ts ②c |
| D-A3 | W4-5（移动 Surface） | Android 设备入列的真 adb/scrcpy 端到端（④段按仓库先例 skip——无设备 CI 的诚实通道） | 需真机 | test/w4mobile.test.ts；GENESIS「真机验证清单」段 |
| D-A4 | W4-8 + W5-1（声学通道） | 真麦克风/系统提示音采集（WASAPI 建链 + comtypes 依赖；缺席环境 available=false 诚实信封——本机复核日志「comtypes unavailable」） | 需真机 | python_service/dsh_physical/audio*（selftest 合成波形桥只证分类器）；test/w5pyreg.test.ts ②d |
| D-A5 | W5-3（跨机编排）+ Μ2（拜占庭聚合） | 多真机 barrier 往返与联邦聚合生产部署（server 冒烟仅环回 127.0.0.1 参考端）——**W9-4 升格**：真三进程（server + 独立客户端 A/B）真 socket 两阶段 barrier 往返+退休 0.36s；生产部署面已由 D-C2 落锤 | 已闭环（真 socket 多进程；生产部署=D-C2 已闭） | scripts/federation-server.mjs；test/w5cross.test.ts ⑧ |
| D-A6 | W5-6（效能基准）+ Γ2（注视经济 inset） | 七项效能数字全部为离线确定性基准；inset 的真 VLM IoU 在线 A/B 与 W5-4 SoM 锚点真模型增益同族，待真模型/长跑在线对照 | 需真机 | test/w5*.bench.ts（六文件）；test/w5somcall.test.ts ⑨（模拟证据诚实边界） |
| D-A7 | 早期（W-2 真机审判之后的申报）→ W8 半闭 | 原债「UDS dispatcher 真机往返待 Linux CI（Windows 主开发环境无法覆盖）」——W8 已落 ci.yml Linux 物理服务 e2e 步骤（ubuntu-latest 可编辑安装 dsh_physical 全声明依赖 → 预起 tcp:8421 服务 30s 探活 → physicalExecution.adapter.http 真服务路径实跑 + /dev/shm POSIX 分支真机执法），本机 Windows 无法复现 Linux runner 行为，下次 push 真机首验后闭 | 需真机（半闭：ci.yml 步骤已落地，待下次 push Linux CI 真机首验后闭） | .github/workflows/ci.yml:1-10（Linux workflow 定位 + D-A7 申报）/ :31-42（可编辑安装 + compileall）/ :53-73（tcp:8421 预起配方 + 探活执法） |

## B. 激活开关清单（API/器官已就位、缺省关或投喂面未接）

| # | 来源 | 描述 | 状态 | 证据 |
| --- | --- | --- | --- | --- |
| D-B1 | W1-7 → W5-4（稀疏 SoM） | somSparseBudget 缺省 0：W5-4 已把调用面接进 orchestration L3 生产管线（W1 潮「renderSomOverlay 零调用方」缝隙闭合），但翻转稀疏默认改变标注输出面，留待真机在线 A/B 证据 | 需真机（开闸证据）；投喂面见 D-B3 | src/config.ts:526（default(0)）；src/vlm/som.ts；test/w5somcall.test.ts |
| D-B2 | W2-8 + W3-0（成本级联） | 双钥激活（vlmProviderTiers 标 cheap + vlmCascadeDangerMax ≥0.6）缺省恒弃权；接线层因子源为保守静态因子（桥不携带逐调用分诊物料）——缺省零行为是立法，非缺陷。**终谳（2026-10-04）**：双钥激活与保守静态因子=缺省零行为的立法面，终谳维持（开闸仍循部署决策，定谳语与 D-D8 同源） | 已定谳（设计决策；开闸仍为部署决策） | src/vlm/cascade；test/w3wire.test.ts；GENESIS W2 潮未闭② |
| D-B3 | W5-4（SoM 调用面）→ W8-B2 接线（已闭） | 原债「somMarkers 组合根投喂未接：createSemanticFromVlm 端口/内核键全就位，但 src/orchestration/index.ts 铸 semantic source 处未投 somMarkers 种子」——已闭：① som.ts 备供源工装 createSomMarkerSeedSupply（a11y 元素 + OCR 词双通道铸种、交互置信键诚实缺席、组合根绝不 import interactivityProbe——D-6 模块图零污染）；② 组合根在 semantic source 自铸处实投 somMarkers 端口；③ 内核键 som.sparseBudget 入册（config.somSparseBudget 铸入，缺省 0=关 ⇒ 入册前后 getOrDefault 同为 0，缺省行为与现状逐字节一致——D-B1 的缺省决策保持，翻转默认仍待真机在线 A/B 证据） | 已闭环 | src/vlm/som.ts:171-251（供源工装 + 缺省零行为双闸纪律）；src/index.ts:571-577（内核键 som.sparseBudget 入册）；src/orchestration/index.ts:221-235（W8-B2 组合根实投 somMarkers）；test/w8.organwiring.test.ts（接入即生效执法）；本册 w8.* 11 册 96/96 复跑 |
| D-B4 | W5-2（梦回放）→ W8 接线（已闭） | 原债「梦 failures 源组合根投喂未接：SleepDeps.dream 注入缝与执法册就位，src/index.ts 卸载路径 sleep deps 未投 dream」——已闭：① dreamFeed.ts 供源工装（failureMemory.dump 面适配 SleepDeps.dream：防御式净化绝不抛、dumpFailures 自身故障原样上抛不谎报空集——故障 ≠ 空集两种决策；evolution/spectrum 生产面不可及 ⇒ 诚实缺席绝不伪造双写面）；② index.ts 卸载路径实投 `dream: createDreamDeps({ dumpFailures: () => failureMemory.dump() })`。缺省零漂移：仅 enableSleepCycle（缺省 false）开时投喂块才执行（D-B4 点亮语义：开关开且失败记忆非空 ⇒ 梦回放激活） | 已闭环 | src/sleep/dreamFeed.ts:1-70（工装 + 供源纪律）/ :61（createDreamDeps）；src/sleep/index.ts:66-68（桶再导出）；src/index.ts:99（import）/ :1028-1036（实投点 + 零漂移注释）；test/w8.organwiring.test.ts |
| D-B5 | W3-5/W3-7/W4-1/W4-3/W4-7/Υ/Κ/Ξ（行为面开关总览） | 缺省关的行为面开关一览（全部 opt-in 立法、非债务）：enableSleepCycle / autonomySteerEnabled / enableExploration / orchestratorParallel / enableReversibilityLanes / enableStepAuction / curriculumEnabled / kernelEvolutionEnabled / notaryAutoAnchor / enableDemonstrations / foveatedEncoding / visualDiff.incremental 内核键（0） | 已闭环（立法本身；各开闸的证据门槛散见本表各条） | src/config.ts 各 default；GENESIS 各潮「激活策略」段 |
| D-B6 | Μ2（拜占庭聚合）→ W6R-A5 投产（已闭） | 原债「federationTools 工具面未接 robust 开关（库级 opt-in 已备）」——已闭：sync 动作缺省走 Μ2 拜占庭鲁棒臂（robust 缺省 true，仅显式 false 回退 Μ 旧行为的审计/兼容缝——预合并摘要直掺），缺省即投产（数学执法代替对聚合端的信任），响应 state_anchor.robust 恒透出（method/mergedFrom/检疫票） | 已闭环 | src/tools/federationTools.ts:146-147（robustRaw === false ? false : true 消毒）/ :151-155（federationSync 实传 robust）/ :187（state_anchor.robust）；test/epochMu.federation.test.ts:513-566（Μ-6：缺省 robust 4 源偶中位 / 显式 false 回退旧形状无 robust 字段 / 源级取证双断言防回归）；本册收稿实跑 epochMu.federation 9/0 |
| D-B7 | W6R（审批带外人证 fail-closed 安全修复） | 宿主集成须知（行为变更）：带外确认码的唯一携码通道改为 cordis 事件总线 `approval/confirm-code`（ctx.emit）——宿主未接线 emit（ctx 缺席/无 emit/emit 抛出）⇒ 铸造记 degraded ⇒ 所有该类令牌的 grant=true 一律拒绝（reason='confirm-channel-absent'，令牌保留至过期、不可追认补投，须重新 request_approval 铸新码）；旧实现降级为无码 grant 是 fail-open（grant_approval 是模型可调工具，屏幕注入文本可驱动 request→grant→click 全链自批不可逆操作——本分支是那次安全修复的执法点），无码同意通道已废除。控制台只打脱敏回执（不含码本身）。宿主出路：在 `approval/confirm-code` 事件挂 UI 弹窗/toast/推送；插件侧组合根已幂等武装（总线面整体遗留另见 D-G6）。**终谳（2026-10-04）**：无码同意通道废除是安全修复的执法面，fail-closed 终谳维持——宿主须接事件总线，本条为宿主集成须知非插件侧未闭债 | 已定谳（设计决策：fail-closed 立法维持，宿主集成须知在册） | src/approval.ts:311（confirmCodeChannel 单例）/ :323-337（deliverConfirmCode：通道缺席/故障 ⇒ undefined）/ :526-528（degraded 记账）/ :578-581（confirm-channel-absent 拒绝）；src/doctorChannel.ts:117（事件名常量）/ :127-137（投递语义注释）/ :138-160（armOutOfBandConfirmChannel：无 emit 即 false）/ :219（组合根挂点） |

## C. 需部署决策（扩表/生产化是部署方知识决策，接线层不代立法）

| # | 来源 | 描述 | 状态 | 证据 |
| --- | --- | --- | --- | --- |
| D-C1 | W4-3 + W5-0（可逆性分道）→ W8-A4 部分闭环 | 原债「text-input/navigation 两 compensable 语义不在 escrow 补偿策略表 ⇒ 执法路径 fail-closed 拒绝；扩表待部署知识」——W8 落地两面：① manual-only 三新立法键（data-export / factory-reset / app-uninstall——与 send-message/payment 同族，无法安全自动补偿的语义族显式入表，fail-closed 拒绝从「无策略」升格「立法在表」）；② 组合补偿执行器 createCompositeCompensationExecutor（GUI 执行器 + shaper 撤销栈执行器分 method 路由——shape_environment 的 undo_log 撤销栈经 executorPort 接入统一账本）。内置表 compensate 键扩面被「S5-5d 键对齐律」封死（内置键必须与 riskGate 分级注册表 compensate ⇔ compensable 双侧对齐，不得单侧扩）；部署方扩表姿势——**W9-2 落锤**：loadExternalStrategyTable(path) 文件装载面（一份 JSON 原子落两表、坏表全拒保留内置表、级别由 kind 派生双写才不失配）+ 组合根 env DSH_ESCROW_STRATEGY_TABLE 接线；w9deploy 12/0 执法 | 已闭环（W9-2 落锤） | src/reversalEscrow.ts:139-151（W8-A4 三键立法 + 键对齐律扩表纪律）/ :231-241（三键入表）/ :1353-1397（组合补偿执行器）；test/w8.escrow.test.ts（执法册） |
| D-C2 | Μ2 + W5-3（联邦/跨机 server） | 聚合与 barrier 参考端（scripts/federation-server.mjs，环回·1MB 上限·不落盘）待生产化部署——缝隙已从「未部署」变「参考实现待生产化」——**W9-2 落锤**：env 配置面（端口/体积/TTL/持久化/排水）+ SIGTERM 优雅关停 + 原子持久化 + scripts/README-federation.md 部署文档；缺省行为与参考实现逐字节一致（生产化是能力不是缺省切换）；w9deploy 12/0 | 已闭环（W9-2 落锤） | scripts/federation-server.mjs；GENESIS Μ2 行 |
| D-C3 | W4-1 + W5-0（增量编码）→ W8-A5（已闭） | 原债「增量 observer 的生产消费方尚未落位——观察槽已接通」——已闭：contextManager 增量消费方落位——recordIncrementalDelta 投喂面（调用方显式投喂 ScreenStateLedger 的干净帧间增量判决）随记录入窗，驱逐时增量几何（codec 补丁锚点/滚动向量/静默判决）以有界文本随墓志铭存活（驱逐摘要从「只剩标题」升格「增量几何可追溯」）。缺省关：incrementalEnabled 缺省 false ⇒ 关 = 全部行为缺席，驱逐文本与现状逐字节一致 | 已闭环（消费方落位；缺省关 = 行为面 opt-in 立法） | src/contextManager.ts:18-39（W8-A5 段注释）/ :77-83（开关缺省 false + 账本字段）/ :122-138（开关/投喂面/收益遥测）；test/w8.incremental.test.ts（执法册） |
| D-C4 | 早期（地基速修 #7） | 全库 git 提交卫生（316 文件未提交的历史申报；现仓库有作者未提交修改——本台账纪元禁 git 写操作） | 需人工 | INNOVATION.md 三、#7；repo 现状 |
| D-C5 | W6R-A5（联邦 server 认证） | federation-server.mjs 的 HMAC-SHA256 请求签名（x-dsh-fed-timestamp + x-dsh-fed-signature，±时钟偏移窗防重放）仅覆盖 POST /aggregate；/barrier/allocate、/barrier/commit、/barrier/status 三端点保持开放（server /health 自报「HMAC signature enforced on POST /aggregate … /barrier endpoints remain open」）——barrier 是协调原语非证据面，生产拓扑由部署方反代收口或后续版本扩签名覆盖面（扩面 = 部署知识，接线层不代立法）——**W9-2 落锤**：barrier 三端点缺省纳入 HMAC（GET 空正文签名 ${ts}.），FED_ALLOW_OPEN_BARRIER=1 兼容参考拓扑；签名客户端姿势（fetchImpl 注入缝 + federationAuthHeaders）文档化并测试实证带签双端往返 | 已闭环（W9-2 落锤） | scripts/federation-server.mjs:60-118（HMAC 校验实现，含缺头 401）/ :509（自报 barrier 开放）/ :523（/barrier/* 路由分派）/ :660（auth 模式申报文案） |

## D. 已知取舍（终谳面 · 含 module 常量 vs config 的参数面分工）

> 分工律：数学不变量/立法阈值走模块常量（改值 = 修法，源级断言锁定）；运营参数走
> config / Θ-Ξ 内核键（55 键可进化）。本表登记「留在常量侧」的每一笔及其理由。
> W9-5 终谳（2026-10-04）：本表在册取舍族十二条逐条定谳维持——设计决策定谳面，
> 非未闭债；各条描述尾带「终谳（2026-10-04）」一句定谳语，状态列改「已定谳」。
> ΑΩ-R45 补登（2026-10-04）：新增 D-D13——ΑΩ-R43 宪法 backgroundRisk 终版立法
> 是有意决策非未闭债，入本设计决策类在册。
> ΝΩ-54 补登（2026-10-04）：新立 D-D14..D-D17 四条（ΝΩ 战役有意决策——riskGate
> 词边界双轨制 / 沙箱五门与位宽域 / journal 组提交崩溃窗口 / optionalDependencies
> 迁移搁置），均设计决策定谳面非未闭债。

| # | 来源 | 描述 | 状态 | 证据 |
| --- | --- | --- | --- | --- |
| D-D1 | W5-2（梦回放） | PER_WEIGHTS（惊异半衰位/风险乘子/24h 半衰）与 DREAM_BUDGET_DEFAULTS 全部模块常量——公式可审计、手算对照是执法面（对照 Θ/Ξ 可进化键域的刻意取舍）。**终谳（2026-10-04）**：公式常量=修法面，手算对照执法在册，终谳维持 | 已定谳（设计决策） | src/sleep/dreamReplay.ts（PER_WEIGHTS）；test/w5dream.test.ts D1（手算 0.75 对照） |
| D-D2 | W5-3（跨机编排） | BARRIER_MAX_LIVE=64 / BARRIER_MAX_TOMBSTONES=256 / BARRIER_TTL_MS=120_000 / REMOTE_EVIDENCE_OVERLAP_MIN=0.25 / REMOTE_PEERS_MAX——一致性论证支柱与互证谓词阈，源级锁定（改值 = 修法）。**终谳（2026-10-04）**：一致性支柱阈立法在源、改值即修法，终谳维持 | 已定谳（设计决策） | src/crossMachine.ts；src/actionVerifier.ts；test/w5cross.test.ts ⑩「立法在源」 |
| D-D3 | W3-6 + W5-5（岔路换支） | BRANCH_REPLAY_BUDGET_STEPS=12 重放预算常量（超支 exhausted 不悄悄续命）。**终谳（2026-10-04）**：重放预算硬帽防悄悄续命，常量立法终谳维持 | 已定谳（设计决策） | src/branchCards.ts；test/w5steer.test.ts（预算执法面） |
| D-D4 | W1 + W2-0（执行层探针） | 探针懒点亮以 healthSnapshot 存活哨兵为界——纯注入 capture 的宿主管线探针诚实缺席（设计语义非缺陷）。**终谳（2026-10-04）**：懒点亮以物理服务存活哨兵为界是设计语义非缺陷，终谳维持 | 已定谳（设计决策） | src/autonomy/index.ts（buildAutonomyStack probe 懒点亮）；GENESIS W1 潮未闭③ |
| D-D5 | W3-7 + W4-0（探索账本） | 探索账本 goal 绑定 ''（铸栈时 goal 未出生；一进程一账跨目标共享，键域本不含 goal 维——跨会话自洽）。**终谳（2026-10-04）**：键域不含 goal 维、一进程一账跨目标共享，跨会话自洽设计终谳维持 | 已定谳（设计决策） | test/w4wire.test.ts（探索注入开关）；GENESIS W3 潮未闭③ |
| D-D6 | W4-7 + W5-0（步数拍卖） | 拍卖证据端口以出生场景指纹为键，冷启动（seedSceneHash 空）⇒ 零证据均匀分配（诚实降级非缺陷）。**终谳（2026-10-04）**：冷启动零证据均匀分配是诚实降级非缺陷，终谳维持 | 已定谳（设计决策） | src/subAgent.ts；GENESIS W4 潮未闭③ |
| D-D7 | W5-6（稳态门基准） | A5 慢世界边界档 33.3% < 40% 声明下限（需两轮判稳的世界上稳态门与固定等待打平——声明的诚实边界，bench 如实呈报不作断言）。**终谳（2026-10-04）**：慢世界边界档如实呈报不作断言是声明的诚实边界，终谳维持 | 已定谳（设计决策） | test/w5settle.bench.ts（附慢世界边界档） |
| D-D8 | W2-8（级联因子源） | glmClient 咨询桥不携带逐调用分诊物料（置信/风险/场景新旧度在桥另一端不可得）⇒ 保守静态因子 danger 0.6 > 阈值 0.35 恒弃权；桥面谓词只内建结构判定，语义谓词留给直连消费面。**终谳（2026-10-04）**：桥不携带逐调用分诊物料故恒弃权，宁贵勿错终谳维持 | 已定谳（设计决策） | GENESIS W2 潮未闭②；src/vlm/glmClient.ts（attachCascadeFace） |
| D-D9 | Υ（免疫幕） | 睡眠免疫幕生产缺 knowledgeBase 单例（D-7 独立插件面）——晨报标 skipped，绝不伪造——**W9-3 已供给**：knowledgeBase.ts 模块级单例 + 组合根实投 SleepDeps.knowledgeBase + 卸载 dispose（W-1 律）；缺省零漂移（enableSleepCycle 缺省关）；免疫幕 skipped→runnable | 已闭环（W9-3 供给） | src/sleep/index.ts；INNOVATION.md 六「本波已知诚实边界」② |
| D-D10 | W6R（移动 Surface 文本注入） | adb `input text` 官方只认 `%s` 空格惯用语且设备端无法转义字面 `%s`——文本含字面 "%s" 时被设备解码为空格（协议层不可表达，历史行为保持）；回执 note 已诚实申报（"literal '%s' in text is decoded as space by device 'input text'"）——调用方须知，非缺陷。**终谳（2026-10-04）**：协议局限如实申报，调用方须知在册，终谳维持 | 已定谳（设计决策：协议局限如实申报维持） | python_service/dsh_physical/android.py:552-557（诚实边界注释）/ :598（空格→%s 转义 + shlex 单引号包裹）/ :604-607（回执 note 申报） |
| D-D11 | W6R-A9（重复动作守卫）→ W8 修法（已闭） | 原取舍「轨迹网格固有半格悬崖：TRAJECTORY_GRID=20 ⇒ 微调幅度超半格（0.025）可落邻桶逃逸轨迹级检测（宁漏勿杀）」——W8 已修法收口：桶判等之上叠加叶级真数值距离判等 isNearParam（同名数值叶的数值距离 abs(a−b) ≤ 1/TRAJECTORY_GRID(=0.05) 即近参数，以真数值距离独立于桶边界判决；桶判等保留为快路径——同桶 ⇔ 各叶落在同一 0.05 桶 ⇒ 各叶阈内，数值比较补上桶边界带）。半格悬崖带归案，宁漏勿杀的合法重试边界不误伤 | 已闭环（修法落地，半格悬崖取舍不复存在） | src/guards/repeatActionGuard.ts:14-20（修法注释）/ :37-41（TRAJECTORY_NEAR_EPS 叶级阈）/ :90（isNearParam 桶判等 ∪ 叶级数值距离）/ :142-143（轨迹窗消费点）；本册全量 2472 用例 0 fail 复跑 |
| D-D12 | W6R-A9（入口审计扩容）→ W8 分流（已闭） | 原取舍「MUTATING_TOOLS 6→18 件（补 switch_tab / switch_window / open_url / replay_actions / run_skill / shape_environment / autonomous_run / autonomy_resume / save_skill / save_checkpoint / switch_vision_model / vlm_wizard——入口审计是整批动作唯一的 WAL 机会）中，shape_environment 的 capabilities / undo_log 两只读子动作被过度覆盖（按整工具入册的粒度取舍——宁过度勿遗漏）」——W8 已分流收口：SHAPE_ENV_READ_ONLY_ACTIONS 闭集（恰 capabilities / undo_log 两员）在 shape_environment 审计臂内免派发记账，其余子动作照旧 fail-closed 全覆盖；MUTATING_TOOLS 名单计数不变（18 件整工具粒度保留），只读子动作不再过度覆盖——「宁过度勿遗漏」的粒度取舍就此消解为精确分流 | 已闭环（分流落地，粒度取舍消解） | src/guards/auditGuard.ts:59-102（18 件清单照旧）/ :62（闭集执法注释）/ :85（免派发注记）/ :116（SHAPE_ENV_READ_ONLY_ACTIONS 定义）/ :124（分流判定）；本册全量 2472 用例 0 fail 复跑 |
| D-D13 | ΑΩ-R43（宪法 backgroundRisk 审计标注 · 终版立法） | 宪法扫描面分层：goal 原文的危险词不再参与动作级判决，降为「任务级背景风险」（backgroundRisk 标注，取值 elevated / high——进判决书字段与 reason，审计可见、信息不丢）；**终版立法（2026-10-04，ΑΩ-R43）**：保守顶格保持——backgroundRisk 不抬高任何动作的审批阈值，也不因任务背景危险而自动升级 benign 动作（可用性让位于保守是有意决策，非未闭债）；危险动作的审批语义仍由动作自身危险词与 riskGate 分级唯一决定（Σ-3⑦ / W7-D3 定谳同源） | 已定谳（设计决策：保守优先立法在案） | src/autonomy/autonomyConstitution.ts:9（分层立法注释）/ :67（backgroundRisk 字段）/ :73（扫描面分层注释）；GENESIS「ΑΩ 隐患清账战役」段第 5 批 R43 行 |
| D-D14 | ΝΩ-23（riskGate 词法匹配升级 · 词边界立法） | riskGate 词边界双轨制立法：Aho-Corasick 自动机多模式匹配 + 归一化带位置映射（MappedNormalization——归一化串逐码点记账其在原串的 UTF-16 起始索引，跨不动点迭代逐遍组合）+ 拉丁短词硬边界回原文判定（「enter pin」剥空格成「enterpin」不得借粘词误中「pin」的词内位置）；**双轨制是有意决策**：边界收紧只作用于拉丁字母系，免边界族（中文/CJK——无空格分界、词表命中即危险信号；标点相邻形态）立法维持逐字节子串语义——对中文上硬边界会大面积杀伤检出（中文危险词天然无词界），宁可拉丁侧防粘词误报、CJK 侧维持宽网；等价律：归一化输出与旧 normalizeOnce 逐字节一致（整串 toLowerCase 的语境规则 İ/Final_Sigma 不破——逐码点小写会破坏前者）。工单正反例全量 + 边界律立法面 + 中文逐字节零回归由 riskGate 册执法 | 已定谳（设计决策：拉丁硬边界 + 免边界族双轨制立法在案） | src/riskGate.ts:96-101（位置映射设计段）/ :184-185（编译集缓存 + Aho-Corasick）/ :208（免边界族注释）/ :212（buildAhoCorasick）；test/riskGate.test.ts（10/0 本册实跑）；GENESIS「ΝΩ 前沿升级战役」段第 3 批 ΝΩ-23 行 |
| D-D15 | ΝΩ-1（沙箱执行器 · 宿主安全链五门 + 位宽域） | 沙箱宿主重放执行器接入宿主安全链五门（危险词/分级/审批令牌/审计 WAL/守卫链全过才真派发）+ 每步派发经 journal.appendMarker 提交 SANDBOX_HOST_REPLAY 审计存证；指纹位宽域 [32,256] 单源立法（FINGERPRINT_MIN_BITS=32——低于即证据量不足保守拒绝摄取，**32 下限是有意立法非可调参数**：更短位宽的指纹在防降级/防碰撞上不可信；MAX=256 拒绝非已知方言）——ΑΩ-R19 只修了比对侧（fpSimilarity 不等宽前缀比对），本批把摄取侧硬编码 64 位对齐成域常量单源（摄取不再先于比对没收 128 位等演进格式，现行 64 位照常摄取零回归）；执行器缺省关（enableHostReplayExecution——ΑΩ-R19 立法不变，本批只补执行器与五门收口） | 已定谳（设计决策：五门序与位宽域下限在案） | src/sandbox/events.ts:116-126（位宽域常量 + 设计注释）/ :129（BINARY_FINGERPRINT_RE 单源）；src/sandbox/index.ts:26（宿主执行器适配层）/ :49（安全链接入）/ :62（审计接线）；src/sandbox/engine.ts:55-59（ΑΩ-R19 比对侧）；test/epochChi.attestation.test.ts |
| D-D16 | ΝΩ-45（journal 组提交 · 崩溃窗口） | journal 组提交崩溃窗口：主 JSONL 行缓冲 + 三重触发（缓冲 256 防涨上限立即冲刷 / 32 行批阈值立即提交 / 50ms 周期计时器——每批一次 open/write/fsync/close，旧路径每条 4 syscall 摊销为 1/32）；取舍面：**窗口内进程崩溃 ⇒ 缓冲中 ≤32 行（防涨上界 256）的主 JSONL 行丢失**，对照旧路径每条 fsync 零丢失。为什么有界丢失可接受（有意决策）：① 审计底线不由主 JSONL 承担——全部变更类工具的审计行经 appendPreDispatch 的 WAL（appendFileSync 同步写）**先行**落盘（W2-2 fail-closed 语义零变化；WAL 行自带主链交叉锚 hash，崩溃后审计史以 .wal 为准对账复原）；② checkpoint 随行持久化 + 卸载链在 saveCheckpoint 与 journal.reset 之间显式 flushJournal（优雅关闭零丢失）；③ 主 JSONL 角色本就是吞吐导向的磁盘取证副本（W2-2 注记原文「主 JSONL 是异步批写……吞吐导向，不满足先行性」——组提交正是该立法的兑现）。否决折中方案（每条 writeSync 进页缓存 + 定期 fsync）：挡得住进程崩溃挡不住断电，且把丢行边界从显式有界的 32/256 行换成 OS 页缓存的隐式承诺——显式有界窗口 + WAL 同步底线的组合更可论证可测试（journalDiskStats().buffered 即窗口深度观测面） | 已定谳（设计决策：显式有界窗口 + WAL 底线组合立法在案） | src/journal.ts:138-152（组提交参数 + 三重触发）/ :208（行缓冲 FIFO + 磁盘行序恒等链序）/ :296-321（崩溃窗口论证原文——选定方案 vs 否决折中的完整对照）；test/journal.test.ts（组提交执法） |
| D-D17 | ΝΩ 批 5 工程治理（optionalDependencies 迁移提议 · 否决搁置） | 原生依赖（sharp / tesseract.js）迁 optionalDependencies（弱平台装机韧性——平台不兼容时安装不整体失败）的提议被 sec.runtime-deps（W6R 依赖归类守护：运行时 import 的依赖必须在 dependencies——进 dev/缺席 = 生产装机 npm install --omit=dev 即缺件、感知/OCR 面整面 dead-boot，major 级 finding）否决：迁移会使两者从 dependencies 消失、doctor 立即报警。**记为搁置项（有意决策）**：除非先修法 doctor 规则（引入「optionalDependencies + 装机自检面」新类目并配套 runtime 探测降级），否则不迁——依赖归类守护的执法优先于装机韧性提议，两条立法不得静默互斥 | 已定谳（设计决策：否决在案，搁置项留档） | src/doctorRules.security.ts:129-153（sec.runtime-deps 规则本体 + finding 文案）；package.json:48-49（sharp ^0.35.4 / tesseract.js ^7.0.0 在 dependencies）；test/w6r.doctor.test.ts:152-168（规则执法） |

## E. 环境暴露缺陷（复核新发现——账实不一致的如实登记）

| # | 来源 | 描述 | 状态 | 证据 |
| --- | --- | --- | --- | --- |
| D-E1 | W5-1 复核发现（W6-0，2026-10-03）→ W6R 修复（已闭） | 原债「Cv2FrameSource.read 双重包装：`Image.fromarray(cv2_to_rgb(frame, np))` 中 cv2_to_rgb 已返回 PIL Image 再包一层 fromarray ⇒ cv2 在场 + DirectShow 设备 isOpened 且可 read 的环境必 TypeError → internal_error」——已核实修复：read() 直接 `return cv2_to_rgb(frame, np)`。本册收稿假 cap 实测（注入假 cv2 模块 + 假 DirectShow 设备 isOpened 可读——即原缺陷的触发环境）：返回 PIL Image、BGR→RGB 通道序正确（输入 BGR 蓝 [255,0,0] ⇒ RGB (0,0,255)，输入 BGR 红 [0,0,255] ⇒ RGB (255,0,0)）、无 fromarray TypeError。全量基线偏差归因点就此清零（w5pyreg 本册复跑 9/0——②b 在本机走硬件缺席诚实降级路径，kinds 逐项符合） | 已闭环 | python_service/dsh_physical/uvc.py:298-299（修复注释 + return cv2_to_rgb(frame, np)）/ :314-318（cv2_to_rgb 定义：BGR ndarray → RGB PIL）/ :244（Cv2FrameSource）；test/w5pyreg.test.ts:195-210（②b）本册复跑 9/0；本册假 cap 实测记录见 W6R-B5 复核段 |
| D-E2 | W9-4 实证发现（2026-10-04，新登记）→ ΑΩ-R1 闭环 | 原债「audio.py 的 comtypes WASAPI 路径在 py3.14 + comtypes 1.4.17 下因 ctypes 出参约定回归不可用（报文在 real_probe_report.json 在案）」——已闭：ΑΩ-R1（ΑΩ 隐患清账战役第 1 批）把 WASAPI 建链整体移植为原始 vtable(ctypes) 路径（comtypes 不再在环——出参约定回归的依赖面直接拆除），raw-vtable 会话全生命周期管理（Stop + 逆序 Release 尽力回收 COM 引用）；本机 Python 3.14.6 真硬件冒烟通过（真回环采集 + 真播放合成提示音分类命中——D-A4 真环同语义，非合成波形桥） | 已闭环（ΑΩ-R1：本机 py3.14.6 真硬件冒烟通过） | python_service/dsh_physical/audio.py:529（engine: raw-vtable）/:830（py≥3.14 首选路径）/:878（会话标死回收）；python_service/real_probe_report.json（W9-4 对照报文在案）；GENESIS「ΑΩ 隐患清账战役」段第 1 批 |
| D-E3 | ΝΩ-54 收官复核发现（2026-10-04，新登记） | w9real D-A5（真三进程真 socket barrier 往返）在本机 **node v24.19.0 / Windows 确定性红**：客户端 A 完成 barrier 往返（RESULT {"ok":true,"ackOk":true,"peers":["A","B"]} —— 协议本身成功）后 `process.exit(0)` 与 libuv 异步句柄关闭竞态 ⇒ fastfail 0xC0000409（stderr「Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 94」），测试断言「客户端 A 退出码 0」失败。归因证据三链：① 测试 + 客户端脚本 + crossMachine 栈**零 ΝΩ 标记**（federation-server 的 ΝΩ-19 改动仅 /aggregate 摘要中继、不涉 barrier 端点——git diff 亲验）；② **git archive HEAD（W9 纯净树）同款复现**（RESULT ok:true 后退出异常——非 ΝΩ 回归；node v22.14.0/v22.18.0 历史 W9/AΩ 收官 0 fail 记录在 GENESIS 在册）；③ 单跑 4/4 同款红（确定性非偶发）。出路（任一，非本册 .md 产权）：CI/开发机钉选 node LTS 22.x；或客户端退出序列补丁（transport 优雅关闭后再 exit——scripts 域一行级改动）；或测试断言放宽为「RESULT ok 即过」（退出码与协议成败解耦） | 需人工（Node 版本钉选 / 退出序列补丁取舍属 runner 与部署决策面） | test/w9real.test.ts:96-117（断言面）/ :116（exit code 断言）；scripts/w9real-barrier-client.mjs:54（process.exit）；本册 standalone 复现记录（exit 127 / 0xC0000409 双形态 + HEAD 纯净树对照）；GENESIS「ΝΩ 前沿升级战役」段审判口径① |

## F. 结构性大文件与依赖环（拆分/破环是决策不是缺陷——先立案再动刀）

| # | 来源 | 描述 | 状态 | 证据 |
| --- | --- | --- | --- | --- |
| D-F1 | Σ/Θ/Ξ/Κ/W4-4/W5-2（训练营累积）→ W8-B1 拆分（已闭） | 原债「src/autonomy/gym.ts 3377 行：四虚拟世界 + PCG 文法 + 惊异课程 + 多代进化 + 噪声诊所 + 梦训练营六纪元集于一册（各有执法册锚定——拆分须保执法面不动）」——已拆：gym.ts 1557（训练营主体与课程/进化编排）+ 6 卫星件（gym.world.ts 476 四虚拟世界 / gym.pcgWorld.ts 450 / gym.pcgDerive.ts 425 / gym.noise.ts 286 噪声诊所 / gym.pcgGrammar.ts 219 / gym.pcgCampaign.ts 167），导入面稳定（消费方零改动）、执法册锚定面不动 | 已闭环 | wc -l 实测（2026-10-04）：gym.ts 1557 + gym.world 476 + gym.pcgWorld 450 + gym.pcgDerive 425 + gym.noise 286 + gym.pcgGrammar 219 + gym.pcgCampaign 167；test/w8gymsplit.test.ts（拆分执法册）；autonomy.gym / kernel.gym / w4pcg / w5dream 既有锚定册随全量复跑绿 |
| D-F2 | 各纪元累积 → W8 部分拆分 | 千行级产权文件：W8 已拆两大件——approval.ts 1584→97 桶 + 9 卫星件（approval.bypass 226 / approval.ledger 316 / approval.queue 275 / approval.queueState 313 / approval.security 250 / approval.constants 42 / approval.queueContracts 147 / approval.registry 67 / approval.shapes 73）、autonomy/runtime.ts 1581→989 + 6 卫星件（runtime.deps / runtime.perceive / runtime.tuning / runtime.types / runtime.utils / runtime.verdict）；index.ts 1104→1147（组合根——五脏六腑挂号处，聚集合法）。仍千行在案：skillLibrary.ts 1542 / autonomy/autoPilot.ts 1540 / reversalEscrow.ts 1439 / federation/index.ts 1205 / subAgent.ts 1335。**终谳（2026-10-04）**：组合根聚集合法终谳维持；其余千行件的拆分提案另案（未豁免清单见 D-F4，拆分/豁免是决策不是缺陷） | 已定谳（设计决策：组合根聚集合法维持；其余待拆分提案另案——19 件未豁免 >500 行的 doctor info 见 D-F4） | wc -l 实测（2026-10-04）；dist 272 件对齐（build 复跑） |
| D-F3 | W5-3（双实现口径）→ W8-A7 单源化（已闭） | 原债「crossMachine 的 TS 权威源与 federation-server.mjs 的 JS 移植并存（等价性由 w5cross ⑧ 逐字段执法——刻意架构立案备忘）」——已单源化：federation-server.mjs 改薄 re-export——barrier 状态机经 `import { createBarrierCore, BARRIER_MAX_LIVE } from '../dist/crossMachine.js'` 直连 TS 权威源的构建产物，本文件不再持有第二份实现（federation 域的 HTTP 协议胶水仍在本文件，明确不在 crossMachine 单源化范围）；w5cross ⑧ 等价性执法照旧在册 | 已闭环（单源化落地，双实现口径债消解） | scripts/federation-server.mjs:62（import dist/crossMachine.js）/ :133-138（W8-A7 单源化注释「本文件不再持有第二份」）；src/crossMachine.ts（唯一权威源）；test/w5cross.test.ts ⑧ |
| D-F4 | W8-C1V→W8-C2（doctor 分差来源） | 19 个未豁免 >500 行文件的 smell.over-engineering info（doctor score=90.5 与满分的分差来源；另 21 件结构性保留已豁免、可见不扣分）：riskGate.confusables.generated 1672 / skillLibrary 1542 / reversalEscrow 1439 / federation/index 1205 / index 1147 / contextManager 685 / processScore 818 / prophecy/index 616 / journal 604 / notary/index 547 / qualityDoctor 545 / riskGate 545 / selfmodel/index 552 / orchestration/index 509 / tools/skillTools 510 / guards/canaryGuard 516 / vlm/som 565 / config 577 / subAgent 1335——拆分或豁免是决策不是缺陷——**W9-3 窗口份额执行**：confusables.generated 豁免入册（生成物）+ skillLibrary/subAgent/federation-index 三巨件拆分（1541→1005+2卫星 / 1334→872+2卫星 / 1204→96+4卫星，豁免 21→24）；doctor 90.5→92.5（minor 归零）；剩余 15 件未豁免 info 属后续窗口（非本轮职权，如实留案） | 部分闭环（W9-3 窗口份额；剩余 15 件留案） | doctor-report.json（W8-C2 2026-10-04 实跑：findings 40 info = 21 豁免 applied + 19 未豁免）；src/doctorRules.exemptions.ts（21 件豁免注册表） |
| D-F5 | ΝΩ-41（cycle_lint 依赖环执法 · 5 value 环新债） | src 依赖图 5 个 **value 依赖环**（运行时真环——bundler 循环依赖 / 初始化顺序未定义）登记为新债：① 感知主环 SCC(10)（som.layout ↔ som ↔ grounding ↔ vlmOcr ↔ textReader ↔ wordShape ↔ knowledge/stations ↔ physicalExecution/d7HostPort ↔ physicalExecution/index ↔ physicalBackend）；② gym 家族 SCC(7)（gym ↔ gym.world ↔ pcgCampaign/Grammar/Derive/World ↔ noise——W8-B1 拆分的桶-卫星互指残留）；③ actionVerifier 三册 SCC(3)（stable ↔ 主册 ↔ channels）；④ branchCards ↔ branchCards.card（SCC 2）；⑤ rollbackPlanner ↔ rollbackPlanner.plan（SCC 2）。另 9 个 type-only 环（环上全为 import type——编译后蒸发运行时无害，warning 建议降级不执法）。cycle_lint（零依赖自带 Tarjan + value/type 边保守判定）**exit 1 立法在案：环在案一日执法红一日**——现状按「已知环不新增」执行（方言单源化 ΝΩ-41 施工期内环数封顶不增），破环（残余 value 边降 import type，或桶-卫星互指拆解经接口/常量件反转）属后续窗口结构决策，登记防依赖图回到 ΝΩ-41 之前「15 个 SCC 无执法演化」的旧态 | 待拆（cycle_lint 执法在案——破环属后续窗口代码工程职权） | scripts/cycle_lint.mjs:1-17（立法背景 + 边判定律）/ :198-253（Tarjan 找环 + value-cycle 判定）；本册收稿实跑（2026-10-04）：287 文件 / 1438 相对边 / 14 非平凡 SCC（5 value 环 exit 1 + 9 type-only warning）；test/no41.dialectClones.test.ts（9/0 本册实跑——六处方言副本退役的种子对照）；GENESIS「ΝΩ 前沿升级战役」段第 5 批 ΝΩ-41 行 |

## G. 其他遗留（悬挂测试 / 数据面缺失 / 增强通道）

| # | 来源 | 描述 | 状态 | 证据 |
| --- | --- | --- | --- | --- |
| D-G1 | Π + Β（悬挂测试）→ W8-A1 根治（已闭） | 原债「epochPi/epochBeta 各 3 例悬挂（全量 cancelled 6——基线即同款）」——已根治：两册各持事件循环保活 helper（持一枚 ref'd 保活定时器、finally 收口）——根因是裸测试进程的定时器句柄全 unref 不保活循环，abort 触发前事件循环先行排干 ⇒ node:test 判 cancelled；保活哨持住循环至测试自然收口，产品真挂死时保活到期后照常超时（不掩盖真缺陷）。本册复跑 epochBeta.refute 7/7、epochPi.notary 5/5、全量 cancelled 首次归零 | 已闭环 | test/epochBeta.refute.test.ts:104-115（helper 定义）/ :265-266（消费 + finally 收口）；test/epochPi.notary.test.ts:28-39（helper）/ :266（消费）；本册全量 2472 用例 / cancelled 0 实测（node v22.18.0） |
| D-G2 | Ε（预言引擎）→ W8 细化（已闭） | 原债「屏型身份用 dhash 指纹（粒度粗于世界模型聚类 ⇒ no-model 偏多）+ 惊异喂 EvolutionEngine 通道未接」——已闭两面：① 粗层桥 coarseScreenType（精确屏型键查无 ⇒ dhash 前 8 hex 粗格（上 32 位梯度）再问一次；粗层预言诚实标注 predictedVia:'coarse'，统计面 coarseAssisted 可观测——回退的收益不掺水分）；② 惊异喂养通道 surpriseFeed.ingest（结算失手自动喂进化引擎；surpriseRunRecord 水位线只喂失手、零重喂；纯旁路防御吞错绝不影响闭环）且组合根 buildAutonomyStack 生接线（ProphecyEngine 构造期直投 surpriseEvolution 单例——enableProphecy !== false 时） | 已闭环 | src/prophecy/index.ts:41-58（粗层桥 + 喂养通道设计段）/ :66（coarseScreenType）/ :82-83（predictedVia）/ :110-111（coarseAssisted）；src/autonomy/index.ts:359-365（W8-C1 生接线 surpriseFeed: surpriseEvolution）；test/w8.prophecy.test.ts（粗层/喂养/真引擎结构直收执法）+ test/w8.finalwiring.test.ts F-3 |
| D-G3 | Β（反驳法院）→ W8-A6（已闭） | 原债「VisionProvider 未外露 baseUrl（同源剔除现仅 providerId 因子——双因子是目标态）」——已闭：① providers/types.ts VisionProvider 外露 readonly baseUrl（同平台不同 baseUrl 的脑可区分，反驳法院同源剔除升双因子）；② 展示面脱敏纪律（baseUrl 进日志/UI/遥测前必经打码函数——参照 sanitizeError/maskKey 律）；③ GlmClient 具体类降为 StructuredVisionPort 窄端口（configured + chatJson 结构面——grounding 主脑/verifyClient 第二意见脑可直入任意满足端口的多供应商实现，不再锁死单实现） | 已闭环 | src/vlm/providers/types.ts:130-137（baseUrl 外露 + 注释）/ :187（装配面 baseUrl）/ :311-312（脱敏纪律）；src/vlm/grounding.ts:392-393（verifyClient: StructuredVisionPort）/ :611-619（client 窄端口）；test/w8.providerPort.test.ts（假 provider 断言 + openai 族真适配器执法） |
| D-G4 | Ζ + 早期（标定数据面） | Kalman/GPD 标定值待生产数据（睡眠④幕只建议不落值的立法语义——数据面待长跑）；Schmitt/NCD 两原子需先落账数据面（弹窗帧三元组/检索回访标签） | 需真机（生产数据长跑） | src/calibration.ts；src/sleep/index.ts（标定建议书）；GENESIS 缝隙段 |
| D-G5 | Π（重放证词留白）→ W8 双接线（已闭） | 原债「replayOne 重放层不采集公证证据（走 degraded 旧语义——有意留白）」——已闭留档：① notary/replayWitness.ts 铸证便捷面（replayStepFingerprint 步指纹——journal 链哈希优先、缺席走 canonical 摘要；anchorReplayTrajectoryOn 把 ReplayTrajectoryWitness 见证铸进 notary 锚——Notary 单例结构性满足目标端口）；② 双接线：replay_actions 与 run_skill 的重放路径均铸 witnessSteps（步指纹 + 三态结局 + 整体成败）入 notary 锚；公证缺席（宿主未装配）或铸锚失败 ⇒ 诚实降级标注——公证是旁路仪式，重放绝不因公证阻断 | 已闭环 | src/notary/replayWitness.ts:1-116（便捷面 + 运行铁律）；src/tools/replayActions.ts:53-57（import）/ :123-139（witnessSteps 铸造）/ :174-176（降级纪律）；src/tools/skillTools.ts:21-23（import）/ :424-443（同款接线）；test/w8.replaynotary.test.ts |
| D-G6 | 早期（宿主面） | #5/#7 宿主侧总线与 agents 后端（地基速修清单未竞事项） | 需人工 | INNOVATION.md 三、#5/#7 |
| D-G7 | W6R-A3（nonce 强制）+ 第 2 批集成收口（已修留档） | 行为变更：token 认证启用后 X-Request-Id（单次性 nonce）为强制头——缺头 401、同 nonce 重放 401（旧实现缺头静默放行，60s TTL 窗内可无限重放——防重放层形同虚设；认证失败统一改 HTTP 401 + failure 信封）。三册裸 fetch 冒烟（epochSigma.display / w4mobile / w5pyreg 的 svcPost/svcGet）原只带 X-Cap-Token——第 2 批集成代理已于本册收稿窗口内落地补头（每请求 randomUUID；本册亲见三文件 mtime 2026-10-04 05:34:45-59 落地、落地前 grep 确无此头、落地后逐文件计数各 2 处），生产面 microFetch 早已自动注入（缺席才注入、在场不覆盖）；w4audio 纯注入面无 fetch 不涉及。本册复跑 w5pyreg 9/0 | 已闭环（第 2 批落地，本册亲验复跑） | python_service/dsh_physical/server.py:231-247（W6-R-A3 强制头 + 重放 401）/ :183-184（auth 中间件）；test/w5pyreg.test.ts:145-147、test/w4mobile.test.ts:658-660、test/epochSigma.display.test.ts:145-147（补头）；src/physicalExecution/httpClient.ts:147-160（microFetch 缺席注入）+ :18-20（头注契约）；test/physicalExecution.httpClient.test.ts:52-85（注入/不覆盖执法） |
| D-G8 | W6R 遗留 → 第 2 批 B1（已修留档） | 原债「verifyActions 逃生门：config.verifyActions=false（或 dry-run）时效果验证整链关闭、危险动作仍派发（clickMouse 注记 "Effect verification unavailable …; token consumed on dispatch"——fail-open 逃生门，效果验证体系被单开关静默旁路）+ 同族两处探针 fail-open（新鲜度/金丝雀缺席一律 degraded 放行）」——已核实修复（第 2 批 B1/W6R-C1 落地）：① 新配置 allowUnverifiedDangerous（缺省 false，高危逃生门）：verifyActions=false 单独不再旁路危险令牌动作（clickMouse 派发前拒，reason=effect-verification-required）；须 verifyActions=false **且** allowUnverifiedDangerous=true 双钥匙齐备才恢复旧方言 unverified-dispatch-consumed（dry-run 豁免同前）；② 新鲜度探针：dangerous+token 派发前 degraded ⇒ fail-closed 拒派（reason=freshness-probe-unavailable，令牌不烧、GUARD 入链）；drifted 阳性漂移不受逃生门豁免；③ 金丝雀：仅携带 approval_token 的调用（审批域活口）探针缺席/失败 ⇒ 拦截，非令牌动作维持 degraded 放行（避免大面积误杀）。三处出路均指明：重试/开探针/显式逃生门。非 dangerous 分级维持 verifyActions 原语义不变 | 已闭环（第 2 批落地，本册亲验复跑） | src/config.ts:106-128（allowUnverifiedDangerous 声明 + 双钥匙语义注释）/:426（Schema 缺省 false）；src/tools/clickMouse.ts:704-754（新鲜度 fail-closed：:729 degraded 拒派、:707 drifted 恒拦）/:770-790（双钥匙执法块）/:909-916（unverified-dispatch-consumed 仅剩 dry-run/双逃生门两合法入口）；src/guards/canaryGuard.ts:318-321（tokenPath+failClosed 判定）/:323-347（拦截消息三条出路；:346 非令牌动作放行）；执法册 test/epochDelta.safety.test.ts:333（W6R-A 双钥匙）/:359（W6R-B 新鲜度）、test/w2audit.test.ts:446-470（S3-4）、test/w2canary.test.ts:531/:557（金丝雀令牌路径 fail-closed + 逃生门复跑） |
| D-G9 | W8-B4（判据证伪·极性分工红线） | 判据肯定面 fuzzy 容错器官层已备、环内未消费：criteriaEval.ts 在同一判据 DSL 之上为肯定面（must-appear）备好 fuzzy 容错（fuzzy.ts ⌈m/6⌉ 六字符容一错、<3 字符短模式只走精确的 actionGate 同律护栏），但 runtime 主路径 checkCriteria 仍是折叠子串匹配（只证真），autoPilot 环内只消费否定面（must-not-appear——肯定面归 execute 通道）。红线：fuzzy 肯定面若局部打补丁换用会翻转既有终局语义（OCR 距离 1 的「门没开」误判 met），换用必须 runtime 整体切换 evaluateCriteria 一次性收口——**W9-1 已收口**：runtime 三调用点整体换用、无方言并存（w9criteria 10/0 执法）；死亡世界同屏点击由宽容 progress 改判如实 no_effect ⇒ 宪法卡死律提前熔断（closedloop B6 按新终局改判 7/0） | 已闭环（W9-1） | src/autonomy/criteriaEval.ts:1-15（器官三块能力）/ :121（evaluateCriteria）；src/autonomy/runtime.ts:101-103（子串匹配只证真注释）/ :161-162（checkCriteria 现状）；src/autonomy/autoPilot.ts:1438-1452（只消费否定面 + 红线注释「肯定面归 execute 通道」）；test/w8.criteria.test.ts |
| D-G10 | W8-B4（判据 DSL 模型面公开·留档） | mustNotAppear 否定判据 DSL 已写入 autonomous_run 使用准则提示词：模型可见面声明否定形态（`mustNotAppear:` 或「不得出现：」前缀 + 禁词；OCR 命中禁词 ⇒ 该判据 violated ⇒ 终局 failed）——「错误弹窗须已消失 / 已退出登录」类收尾核对从编排方私设升格为 DSL 一等公民。行为面变更留档：提示词新增 DSL 段不改变缺省行为（无否定判据 ⇒ 逐字节旧语义） | 已闭环（W8 落地留档；供 D-G9 换用时的模型面参照） | src/index.ts:173-182（AUTONOMY_RUN_PROMPT 判据 DSL 段）；src/autonomy/criteriaEval.ts:27-33（NEGATIVE_PREFIXES 同源方言表）；test/w8.criteria.test.ts |
| D-G11 | W8（tesseract 离线语言包语义修正·留档） | langPath 迁移至 test/fixtures 后两个世界对局 harness 的 createWorker 语义修正：`gzip: false, cacheMethod: 'none'`——本地裸 eng.traineddata 非 gzip 压缩包（缺省 gzip 语义会按压缩包解包失败）、CI 每次全新装（缓存 none 杜绝陈旧缓存指向旧语言包），零网络下载的离线确定性执法面就位 | 已闭环（语义修正落地留档） | test/complexWorldWinHarness.ts:147-153（langPath 指 fixtures + gzip:false + cacheMethod:'none'）；test/realWorldWinHarness.ts:106-112（同款）；test/fixtures/eng.traineddata（离线语言包在场） |

## 统计与复核记录

条数（含已闭环与已定谳留档，ΝΩ-54 收官重数 2026-10-04）：A 真机 7 ｜ B 激活开关 7 ｜
C 部署决策 5 ｜ D 已知取舍 17（W9-5 终谳十二条 + ΑΩ-R43 新立 D-D13 + ΝΩ-54 新立
D-D14..D-D17 四条）｜ E 环境暴露 3 ｜ F 大文件与依赖环 5 ｜ G 其他 11
—— 合计 55 条（沿革：W6-0 立账三十六 → W6R 增至四十三 → W8 增至四十七 →
W9 终账四十八（新增 D-E2）→ ΑΩ 收官四十九（新立 D-D13 一条、闭环 D-E2 一条；
E 节 W9 收稿时点申报 1 为口径滞后，ΑΩ 补正为实数 2）→ ΝΩ 收官五十五（新立
D-D14/D-D15/D-D16/D-D17/D-E3/D-F5 六条，无闭环翻案）。W8 轮翻案闭十一条：D-G1 / D-B3 / D-B4 /
D-C3 / D-F1 / D-F3 / D-G2 / D-G3 / D-G5 / D-D11 / D-D12，新增 D-F4 / D-G9 /
D-G10 / D-G11 四条；D-C1 部分闭环在案，D-A7 半闭）。
未闭债主分类（W9-5 终谳收口后逐条重数，复合状态按主状态计）：需真机 9｜本纪元W6处理 1｜
需部署决策 3｜需人工 4 —— 合计 17 未闭；已定谳（设计决策）12 条 + 已闭环留档 18 条，
三项合计 47。终谳构成：D-B2 / D-B7 / D-D1..D-D8 / D-D10 / D-F2——原已知取舍族
全体定谳维持（设计决策非未闭债，逐句定谳语见各条描述尾）。
校勘沿革：W7 审计曾改正 W6-0 登记的分项口径（复合状态按主状态计，W7 创世审计器
genesis_audit 的 DEBTS 合法性校验执法本枚举）；W8-C2 收稿重数立「未闭二十九」口径；
W9-5 终谳把已知取舍族整体移入已定谳面，未闭由二十九降至十七（历史口径数字以
各收稿时点快照为准，不回改前人收稿记录）。

**W9 终账收官重数（集成者 2026-10-04，本轮销账后）**：合计 **48 条**（新增 D-E2）。
本轮翻案闭八条：D-G9（判据器官化收口）/ D-C1 / D-C2 / D-C5（三条部署决策落锤）/
D-D9（knowledgeBase 供给）/ D-A1（UVC 真帧管线软件在环）/ D-A4（声学真环）/
D-A5（真 socket 三进程 barrier）；D-F4 记窗口份额部分闭环（三巨件拆分 + 豁免 24，
剩余 15 件 info 留案）。
未闭终态：**需真机 6**（D-A2 真棒 / D-A3 Android / D-A6 真模型长跑 / D-A7 Linux CI /
D-B1 稀疏 SoM 在线 A/B / D-G4 生产数据——全部唯余物理在场，软件在环证据均已到边界）
｜**本纪元后续处理 1**（D-E2 audio comtypes runner 修复，对照实现在案）｜**部分闭环留案 1**
（D-F4 剩余 15 件）｜**需人工 2**（D-C4 git 提交卫生——工作树 300+ 文件未提交，须
仓库主人亲裁切分方案；D-G6 宿主面 #5/#7——宿主仓库职权）——**未闭合计 10**；
已定谳 12 + 已闭环 26，三项合计 48。除物理边界与主人亲裁项外，**可闭之债已全部闭清**。

**ΑΩ-R45 收官重数（结案文档工单，2026-10-04，ΑΩ 隐患清账战役 46 项隐患 /
5 批次 / 44 编号工单 R1-R46 收官后）**：合计 **49 条**（新立 D-D13 一条）。本轮
翻案闭一条：D-E2（ΑΩ-R1 audio.py WASAPI raw-vtable 移植——本机 Python 3.14.6
真硬件冒烟通过，证据见条内）。未闭重数（按状态主词逐条重数）：需真机 7｜需人工 2｜
部分闭环 1（D-F4 剩余 15 件 info 留案）——未闭合计 10；本纪元W6处理 0、需部署决策 0
（W9 三条部署决策落锤 + D-E2 闭环后，该两族状态主词已全部清空）。已定谳 13（含
新立 D-D13）+ 已闭环留档 26，三项合计 49。台账自洽补正：头部枚举补「部分闭环」
（D-F4 状态主词入册——W9 收稿时点为口径遗留）；统计段 E 节 1→2、D 节 12→13、
合计 47→49 对账归位（genesis_audit 分节条数对照与枚举校验就此全净）。

W6-0 复核记录（2026-10-03 登记 / 2026-10-04 02:2x 收官复验，登记前实跑）：
- w5wire 14/0、w5dream 9/0、w5cross 25/0、w5somcall 9/0、w5steer 17/0（逐件实跑全绿，
  含 w5wire W5-E①/② 对 GENESIS/INNOVATION 的文本断言——本批补录后复跑仍 14/0）；
  w5cascade/w5gate/w5ledger/w5roi/w5macro/w5settle 六文件 7 bench 全绿，console 台账
  数字与 GENESIS W5 纪元段「声明 vs 实测」表逐项一致（C1 50.0%/P2C3 74.6%/A5 50.0%/
  A1 71.4%/C2 0.55/A2 守护住）。
- w5pyreg 9 项本机实测 8/9：W5-1②b 1 fail，根因 D-E1（环境暴露缺陷，非文档账错——
  作者环境基线 9/0 申报在册，本册如实并记两面）。
- 全量首跑（本批文档落盘后、W6 并行批次施工前窗口）：2018 用例 / 2006 通过 /
  1 fail（即 D-E1）/ 6 cancelled（D-G1，与基线同款）/ 5 skipped——与基线
  （2018/2007/0 fail）的偏差全额归因于 D-E1 单点，typecheck exit 0。
- 收官复验窗口内 W6 并行批次活跃施工（02:00 后 49 个 src/test 文件被改，新增
  test/w6fix.test.ts / test/w6persist.test.ts 36 用例自测全绿；期间 federation/
  index.ts 曾出现 TDZ 瞬时红后自愈）：全量 2054 用例 / 2032 通过 / 2 fail
  （D-E1 + vlm.onboarding Λ-2 的 EADDRINUSE——端口 18432 被外部进程 PID 21592
  占据，单跑复现同错，环境干扰非代码回归）/ 6 cancelled（D-G1 同款）/ 14 skipped
  （基线 5 + W6 新批次平台性 skip）。typecheck `tsc -p tsconfig.json --noEmit`
  exit 0。本批产权仅三份 .md（不进 tsc 编译目标）——全量/tsc 的一切红均不在
  本批背书范围（各潮「并行批次在途文件瞬时红不由本批背书」先例同律）。

W6R-B5 收稿复核记录（2026-10-04 05:5x，W6-R 第 1 批修复浪潮入账，登记前逐项实跑/实查）：
- 翻案 D-B6：src/tools/federationTools.ts:146-147 robust 缺省 true（仅显式 false 回退）、
  :151-155 实传 federationSync、:187 state_anchor.robust 透出；执法册 test/epochMu.federation.test.ts
  Μ-6（:513-566）含源级取证双断言（robust 消毒表达式 + 实传断言）。本册实跑该册 9/0。
- 翻案 D-E1：python_service/dsh_physical/uvc.py:299 `return cv2_to_rgb(frame, np)`（:298 修复注释）。
  本册假 cap 实测（注入假 cv2 模块 + 假 DirectShow 设备 isOpened 可读——即原缺陷触发环境）：
  返回 PIL Image、BGR→RGB 通道序正确（输入 BGR 蓝 [255,0,0] ⇒ RGB (0,0,255)；输入 BGR 红
  [0,0,255] ⇒ RGB (255,0,0)）、无 fromarray TypeError；test/w5pyreg.test.ts 复跑 9/0
  （②b 本机走硬件缺席诚实降级路径）。
- 新增七条逐项取证：D-B7（approval.ts:311/:323-337/:526-528/:578-581 +
  doctorChannel.ts:117/:138-160/:219）、D-C5（federation-server.mjs:60-118/:509/:523/:660）、
  D-D10（android.py:552-557/:598/:604-607）、D-D11（repeatActionGuard.ts:23-37）、
  D-D12（auditGuard.ts:59-102 清单实数 18 件，grep 逐件点验）、D-G7（server.py:231-247 +
  三测试册补头亲见落地）、D-G8（config.ts:28/:366 + clickMouse.ts:686/:844；
  grep allowUnverifiedDangerous 全库 0 命中）。
- 定向抽测（本册实跑）：epochMu.federation 9/0 + w6r.shellhardening & w6fix 23/0 +
  w5pyreg 9/0 = 41 用例 0 失败；nonce 强制面另以独立探针亲证（带 X-Cap-Token 缺
  X-Request-Id ⇒ 401 "missing X-Request-Id header"）。
- 收稿窗口内第 2 批在途施工亲见：test/{w5pyreg,w4mobile,epochSigma.display} 三册
  X-Request-Id 补头于 05:34:45-59 落地（本册 grep 从「无」变「有」，D-G7 据此记已修）；
  w7* 七册新测试（w7audit/w7doctor/w7e2e/w7fullon/w7fuzz/w7gate/w7wire）在场未跑——
  不在本册背书范围。
- 本批产权仅 DEBTS.md 与 GENESIS.md 两份 .md（不进 tsc 编译目标）；F 区大文件复读：
  gym.ts 3372→3377 行、runtime 1578→1581、index 1061→1104——F1/F2 现状未变（本轮新拆分册
  为 F 清单之外文件，如 actionVerifier 三分册 channels/effect/stable）。

W6R-C1 收稿复核记录（2026-10-04，第 2 批 B1 超时重试代理收稿，登记前逐项实跑/实查）：
- 翻案 D-G8：B1 首发代理超时未及回报，但源码/执法册已落盘（本册 grep allowUnverifiedDangerous
  全库命中：src/config.ts + src/tools/clickMouse.ts + src/guards/canaryGuard.ts 三源文件与
  epochDelta.safety / w2audit / w2canary / epochBeta.refute / w7fullon 五执法册）——本册逐行
  复核语义后翻案闭账，证据见 D-G8 行。原「grep 0 命中」是 B5 收稿时点快照，非终态。
- 复跑实跑：基线三册（w2canary/safetySystems/epochDelta.safety）52/0；定向八册
  （上述三册 + w3escrow/w4reverse/w6fix/w2audit/epochBeta.refute）153 用例 150 过 0 fail
  3 cancelled（epochBeta.refute Β-3c/Β-4/Β-5——D-G1 预存悬挂，本册以 HEAD 临时 worktree
  对照复跑同款 4/0/3，与改动无关）；追加交界四册（w7fullon/w1approval/epochJ/epochDelta）
  50/0。
- tsc --noEmit 全库：范围文件（config.ts/clickMouse.ts/canaryGuard.ts/canaryLogic.ts）零错误；
  余 2 错在未跟踪新文件 test/doctorCli.smoke.test.ts 与 test/tools.diffView.test.ts
  （并行批次产物，不在本批所有权，如实记）。
- 统计滚动（对 B5 收稿数）：已闭环留档 4→5（+D-G8），未闭 39→38（W6 处理 8→7）。
- 本批产权：src/config.ts、src/tools/clickMouse.ts、src/guards/canaryGuard.ts（+canaryLogic.ts
  如需，本次未动）与五执法册的既有 B1 落地内容复核背书 + DEBTS.md 本条翻案。

W8-C2 收稿复核记录（2026-10-04，W8 世界创新修复潮 2 批 18 修复代理 + 2 收尾复核的
全量回归与总账入册，登记前逐项实跑/实查，node v22.18.0）：
- 全量回归六步实测：① node --test --test-timeout=60000 全量 2472 用例 / 2467 通过 /
  0 fail / 0 cancelled / 5 skipped（adapter 四例需预起 8421 服务 + readShm 一例
  /dev/shm Linux-only——环境守卫 skip 与基线同款；W8-A1 保活收口后 cancelled
  首次归零）；② verify 23/23（致命 14 + 严重 6 + 中等 3）+ BC-1..4 全库零命中；
  ③ python -m compileall -q python_service 退出 0 零输出；④ doctor score=90.5、
  findings 40（crit/maj/minor=0/0/0，info 40 = 21 豁免 applied + 19 未豁免即
  D-F4）、sec.* 零命中、files=272；⑤ build 退出 0，dist 272 件，抽验 W8 新模块
  在场（approval.ledger.js / approval.security.js / autonomy/gym.pcgWorld.js /
  autonomy/runtime.verdict.js / notary/replayWitness.js / filePerms.js）；
  ⑥ tsc -p tsconfig.json --noEmit 退出 0 零错。
- 翻案 11 条逐项 grep 取证 + 执法册定向复跑（证据列随条更新）：D-G1（两册保活
  helper，epochBeta.refute 7/7 + epochPi.notary 5/5 单跑复验）、D-B3（som.ts:171-251
  供源工装 + index.ts:571-577 内核键 + orchestration/index.ts:221-235 组合根实投）、
  D-B4（dreamFeed.ts + index.ts:1036 实投）、D-C3（contextManager.ts:18-138 消费方
  缺省关）、D-F1（1557 + 6 卫星件 wc -l 实测）、D-F3（federation-server.mjs:62 直连
  dist/crossMachine.js）、D-G2（prophecy:41-58 + autonomy/index.ts:359-365 生接线）、
  D-G3（types.ts:130-137 + grounding 窄端口）、D-G5（replayWitness.ts + 双工具接线）、
  D-D11（repeatActionGuard.ts:37-90 叶级数值距离）、D-D12（auditGuard.ts:116/:124
  闭集分流）。
- W8 执法册定向复跑：w8.* 11 册（arch / criteria / escrow / finalwiring /
  incremental / memory / organwiring / prophecy / providerPort / replaynotary /
  w8gymsplit）96/96 全绿。
- 部分闭环在案：D-C1（manual-only 三新立法键 + 组合补偿执行器已落，内置
  compensate 扩面被键对齐律封死——部署扩表姿势已登记在条）；D-F2（approval
  1584→97+9、runtime 1581→989+6 已拆；federation/index 1205 / reversalEscrow
  1439 / skillLibrary 1542 / subAgent 1335 仍千行在案）；半闭 D-A7（ci.yml Linux
  物理服务 e2e 步骤已落地，下次 push 真机首验后闭）。
- 本批产权仅 DEBTS.md / GENESIS.md / README.md 三份 .md（不进 tsc 编译目标）；
  全量测试临时日志 w8c2_test_full.log 为复核工作产物，不入库。

W9-5 收稿复核记录（2026-10-04，终账代理：取舍终谳 + GENESIS 纪元补录 + 审计校账；
本批产权仅 DEBTS.md / GENESIS.md / INNOVATION.md 三册，禁改一切源码/测试/脚本）：
- 取舍终谳十二条逐条落笔：D-B2 / D-B7 / D-D1..D-D8 / D-D10 / D-F2 描述尾各补一句
  「终谳（2026-10-04）」定谳语（全部维持设计决策），状态列改「已定谳（设计决策）」；
  头部状态枚举增「已定谳」。并行批次在闭的 D-G9 / D-C1 / D-C2 / D-C5 / D-D9 / D-F4
  六条本册只登记不落结果——编辑时点各行证据列未更新，终局结果由集成者终账时落。
- GENESIS 补录三段（按既有浪潮章节格式，不带「纪元 Wn」标题——test/w7audit.test.ts
  以 deepEqual 锁定 GENESIS 纪元宇宙恰为 W1-W5，且审计器头注自立「w7+ 不属本审计
  宇宙」律；扩宇宙须先修执法册，非本批职权）：W6 债清偿浪潮段补五册审判表
  （16+17+19+10+6 = 68/0）；新增 W7 终局验证浪潮段七册表（14+12+2+10+25+13+20 =
  96/0）；W8 世界创新修复潮段补十一册表（6+12+9+9+10+8+11+6+15+7+3 = 96/0）——
  全部逐文件实跑取数（node v22.14.0，2026-10-04，TAP 计数），不抄任何收稿报告。
- 审计校账：genesis_audit --check 补录前后各跑一次均退出码零（详见 GENESIS W9
  占位段与终账报告）；统计段按终谳后口径重数（未闭十七 + 已定谳十二 + 已闭环十八）。
- TS 全量回归确认文档无扰（四窗实跑）：读册四册恒绿（w7audit 十四 / w5wire 十四 /
  w7doctor 十二 / genesis 十三，全零败——全库唯四读取三册 .md 的测试册）；全量用例
  2500→2503 逐窗上漂（并行 W9 批次同窗落地 w9criteria/w9deploy/w9supply 三册），
  每窗失败七→二→三→一且逐窗换脸，涉红文件单独复跑全绿——红均归因并行在途施工
  瞬时态（各潮「并行批次在途文件瞬时红不由本批背书」先例同律），详见 GENESIS
  W9 占位段。

ΑΩ-R45 收稿复核记录（2026-10-04，ΑΩ 隐患清账战役结案文档工单：三册治理文档收官 +
审计器与全量回归复跑；本批产权仅 DEBTS.md / GENESIS.md / README.md 三份 .md，
不进 tsc 编译目标，禁改一切源码/测试/脚本）：
- 翻案 D-E2：python_service/dsh_physical/audio.py 的 raw-vtable(ctypes) 路径在库
  （:529 engine 标记 / :830 py≥3.14 首选路径 / :878 会话标死回收），ΑΩ-R1 本机
  Python 3.14.6 真硬件冒烟通过（真回环采集 + 真播放合成提示音分类命中——D-A4
  真环同语义）——闭环留档，证据列随条更新。
- 新立 D-D13（ΑΩ-R43 宪法 backgroundRisk 终版立法：保守顶格保持、可用性让位于
  保守——有意决策入设计决策类，非未闭债）；头部状态枚举补「部分闭环」（D-F4
  状态主词入册——W9 收稿时点为枚举口径遗留，ΑΩ 补正）。
- 统计段重数：条数合计 48→49（D 节 12→13、E 节 1→2 口径滞后补正）；未闭主分类
  按状态主词逐条重数（需真机 7 / 需人工 2 / 部分闭环 1；本纪元W6处理与需部署决策
  两族状态主词清零）；W9 终账收官重数段为收稿时点快照，不回改（校勘沿革律）。
- GENESIS 补录「ΑΩ 隐患清账战役」段（按 W6-W9 浪潮章节格式，标题不带「纪元 Wn」
  ——不入审计器纪元宇宙，w7audit 执法册 deepEqual 锁定 W1-W5 律）；卷首全景行
  同步（W9「收口中·占位」改「终数已收口」+ ΑΩ 战役入列）。README 补 ΑΩ 段
  （全量 2613 用例口径 + 新能力极简提及，中英两区）。
- 收官复跑（登记前实跑）：新执法册四册 23/0（aor5.tsaSignature 10 / r14.gymDialect
  5 / r18.prophecy 4 / r29.dialectCensus 4，TAP 计数）；genesis_audit --check 退出码 0
  （虚报 0，DEBTS 台账枚举违例 0 / 分节条数偏差 0 / 主分类口径对账全净——本册
  统计补正的直接兑现）；全量 2613 用例 / 0 失败 / 5 skipped（环境守卫 skip 与
  W8-C2 基线同款）。战役五批次各自的全量零回归闸门（2503 → 2613 逐批上漂、
  0 失败放行）由各批收稿背书，本册只收官对账。

ΝΩ-54 收稿复核记录（2026-10-04，ΝΩ 前沿升级战役结案文档工单：三册治理文档收官 +
审计器与全量回归复跑；本批产权仅 DEBTS.md / GENESIS.md / README.md 三份 .md，
不进 tsc 编译目标，禁改一切源码/测试/脚本）：
- 落地质检（登记前 git grep 抽验）：工单标记 ΝΩ-1..45 五批全数在册（src/test/
  python_service/scripts/bench/.github 五域，逐批首注释验读）；批 6 ΝΩ-46..53 于
  本册收稿窗口内由并行施工补齐（首验时点 48/51/52 三件零命中，落定后复验 8/8
  全数在册——46 反事实世界模型端口 / 47 合议庭 quorum / 48 注视进 grounding /
  49 测试提速共享基建 / 50 Linux L1 / 51 DXGI / 52 scrcpy 控制 / 53 RawInput）。
- 新立六条逐项取证：D-D14（riskGate.ts:96/:184/:208/:212 + riskGate 册 10/0 本册
  实跑）、D-D15（sandbox/events.ts:116-126 + sandbox/index.ts:26/:49/:62）、
  D-D16（journal.ts:296-321 崩溃窗口论证原文）、D-D17（doctorRules.security.ts:
  129-153 + package.json:48-49）、D-E3（w9real node v24 libuv 退出竞态——standalone
  与 git archive HEAD 纯净树双重复现归因，证据三链见条内）、D-F5（cycle_lint 收稿
  实跑 287 文件/1438 边/14 SCC，5 value 环 exit 1 立法执法）。
- 数字实测面（本册亲跑）：新执法册十一册 100/0（no3fixes 11 / no29.bilingual 9 /
  no31fixes 7 / no41.dialectClones 9 / now25.systemPerf 19 / configDocs 2 /
  w8.abortSignal 12 / w8.no26 7 / riskGate 10 / physicalExecution.router 8 /
  physicalExecution.serviceManager 6——逐册 TAP 取数）；mutationSelfcheck 显式
  独占跑 1/1（缺省 skip 律不破）；批 6 册单跑全绿（ensemble 19 / epochBeta.refute
  17 / counterfactual 24 / arbitration 10 / d7HostPort 12）；python 152（pytest
  实收集）；SBOM 287 模块（build_manifest 实跑 digest 475f2b8fbea7）。
- 全量三窗实测（node v24.19.0 / Windows）：首窗 2938 用例 / 2916 过 / 2 fail /
  20 skip；次窗 2927 / 2901 / 2 fail / 24 skip（计数逐窗上落归因批 6 施工在途
  ——测试面活体）；**收官窗 2963 / 2952 / 1 fail / 10 skip（终值口径）**。
  fail 逐件归因：w9real D-A5 三窗皆红=确定性环境暴露（**D-E3 新登记**，
  HEAD 纯净树同款复现 ⇒ 非 ΝΩ 回归；收官窗唯一 fail 即此）；时序偶发仅见
  前两窗（首窗 w8.no26 TTL / 次窗 w7fullon W7-D3 真跑 161s；单独复跑各
  7/0、10/0 全绿且收官窗双绿——并行施工 CPU 争载，W9-5「瞬时红换脸」
  先例同律）。除 D-E3 单点外 0 失败。
- 台账滚动：49→55 条（新立六、翻案零）；未闭重数（按状态主词逐条重数）：需真机 7｜
  需人工 3（+D-E3）｜部分闭环 1｜待拆 1（D-F5）——未闭合计 12；本纪元W6处理与
  需部署决策两族维持清零；已定谳 17（+D-D14..17 四条）+ 已闭环 26，三项合计 55。
  头部状态枚举补「待拆」（D-F5 在用——ΑΩ-R45 补「部分闭环」同款补正先例）。
- genesis_audit --check 收稿复跑退出码 0（虚报 0；本册统计段 D/E/F 节与合计对账
  的直接兑现，见收官复跑输出）。
