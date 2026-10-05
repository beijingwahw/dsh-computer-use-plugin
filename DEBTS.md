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
> 代码工程职权，登记防依赖图回到无执法演化的旧态）｜**本纪元ΠΑΝ处理**（ΠΑΝ
> 修复潮 F3-8 新立 2026-10-04：修复潮各工位报告移交的残留项/协调项——后续修复
> 窗口代码职权内可闭，D-PAN 系列在用）｜**后续窗口处理**（ΤΕΛ-12 新立 2026-10-05：
> ΤΕΛΟΣ 完满纪元各工位报告的留案项/拆条项——后续窗口代码职权内可闭，
> D-G33..D-G39 在用）｜**实战在册**（ἈΓΩΝ 收官新立 2026-10-05：实战期防线/
> 缓解在役、根治需人工或后续窗口的债——D-G41..D-G82 在用）｜**本纪元ΑΝΒ处理**
>（ΑΝΒ-8 新立 2026-10-05：ΑΝΑΒΑΣΙΣ 升维纪元在途工单——决策 D2/D3/D5/D6/D8/D9
> 处置与 D2 治本施工中，终局由收官补记翻案、不预填结果——D-E3/D-G66/D-G80/
> D-G84/D-G85 在用）。

<!-- W7 审计改正：状态枚举补「已知取舍」（原头部遗漏，11+ 条目在用） -->
<!-- ΝΩ-54 审计补正：状态枚举补「待拆」（D-F5 依赖环债在用） -->
<!-- ΠΑΝ-F3-8 审计补正：状态枚举补「本纪元ΠΑΝ处理」（D-PAN 系列移交项在用） -->
<!-- ΤΕΛ-12 审计补正：状态枚举补「后续窗口处理」（ΤΕΛΟΣ 留案拆条 D-G33..D-G39 在用） -->
<!-- ἈΓΩΝ 收官补正（R6-3 项目史官 2026-10-05）：状态枚举补「实战在册」（R2-9 §4.3 立法——
     实战期防线/缓解在役、根治需人工或后续窗口的债；D-G41..D-G82 在用） -->
<!-- ΑΝΒ-8 审计补正（项目史官 2026-10-05）：状态枚举补「本纪元ΑΝΒ处理」（ΑΝΑΒΑΣΙΣ
     升维纪元在途工单——不预填结果，终局由收官补记翻案） -->

## A. 真机验证清单（离线执法已绿，待硬件/长跑在环定谳）

| # | 来源 | 描述 | 状态 | 证据 |
| --- | --- | --- | --- | --- |
| D-A1 | W4-6（零 API 设备面·UVC） | HDMI 采集卡帧管线待真硬件在环验证（四角校准/方言对齐/降级链的实帧闭环）；离线 `--selftest` 58 断言只证协议数学与降级链——**W9-4 软件在环已闭**：本机 cv2 5.0.0 + DirectShow 真设备 15 连帧过完整 uvc 管线（通道序逐像素钉死/恒等与过扫描校准/dhash 门控 12 判决/PNG·JPEG 编码，帧证据 real_probe_dA1_frame.jpg）；**ΤΕΛ-9 探针真机收割（2026-10-04）**：probe-da1-uvc 一键探针本机当场 pass——UVC 12 帧稳定（640×480）过现场标定工作流、黑边剖面→建议四角（未呈黑边形态 ⇒ 恒等建议=诚实产出）、rectify 矫正 (639,479) 闭环、证据帧 evidence-da1-frame.jpg 落盘（T2-5 终验复跑同判 pass）——「唯余现场标定」残余就此收割，本条终态闭账 | 已闭环（软件在环 + ΤΕΛ-9 探针真机收割——现场标定残余已收） | python_service/dsh_physical/uvc.py（selftest）；scripts/realverify/probe-da1-uvc.py + run-all（pass 2/absent 7，报告 realverify-report.json）；C:\2\.survey\fix\T1-9.md §三、T2-5.md §三 |
| D-A2 | W4-6（零 API 设备面·HID） | CH9329 串口 HID 棒待真棒在环（SUM/CRC-16 帧构造已 dry-run 可验；pyserial 缺席环境已诚实降级——本机复核日志「pyserial unavailable」）——ΤΕΛ-9 升格「需真机+一键验证」：probe-da2-ch9329（CH340/CP210x/FT232 桥自动识别 + TX-RX 短接回读；无回执 ⇒ degraded），硬件到场即收割 | 需真机（探针就位） | python_service/dsh_physical/hid.py；test/w5pyreg.test.ts ②c；scripts/realverify/probe-da2-ch9329.py（本机 absent：无已知 VID 串口）；docs/realverify.md |
| D-A3 | W4-5（移动 Surface） | Android 设备入列的真 adb/scrcpy 端到端（④段按仓库先例 skip——无设备 CI 的诚实通道）——ΤΕΛ-9 升格「需真机+一键验证」：probe-da3-android（list_devices + 分辨率 + grab_frame 降级链真执行；注入冒烟默认关 INJECT=1 显式同意），真机到场即收割 | 需真机（探针就位） | test/w4mobile.test.ts；scripts/realverify/probe-da3-android.py（本机 absent：adb 在场设备空）；docs/realverify.md |
| D-A4 | W4-8 + W5-1（声学通道） | 真麦克风/系统提示音采集（WASAPI 建链 + comtypes 依赖；缺席环境 available=false 诚实信封——本机复核日志「comtypes unavailable」）——**ΑΩ-R1 raw-vtable 移植后**（D-E2 闭）本机 py3.14 真回环已采到真音频；**ΤΕΛ-9 探针真机收割（2026-10-04）**：probe-da4-audio 一键探针本机当场 pass——合成叮声播放→WASAPI 回环约 2.5s→classify_window 非静默命中 `notification_ding`（conf 0.7333，引擎标记 raw-vtable）——「真采集环」证据入 realverify-report.json（T2-5 终验复跑同判 pass）；comtypes 建链臂（py<3.14）另见 D-A8 | 已闭环（ΤΕΛ-9 真声学整环当场收割） | python_service/dsh_physical/audio.py（raw-vtable 引擎 + selftest）；scripts/realverify/probe-da4-audio.py；C:\2\.survey\fix\T1-9.md §二/三、T2-5.md §三 |
| D-A5 | W5-3（跨机编排）+ Μ2（拜占庭聚合） | 多真机 barrier 往返与联邦聚合生产部署（server 冒烟仅环回 127.0.0.1 参考端）——**W9-4 升格**：真三进程（server + 独立客户端 A/B）真 socket 两阶段 barrier 往返+退休 0.36s；生产部署面已由 D-C2 落锤 | 已闭环（真 socket 多进程；生产部署=D-C2 已闭） | scripts/federation-server.mjs；test/w5cross.test.ts ⑧ |
| D-A6 | W5-6（效能基准）+ Γ2（注视经济 inset） | 七项效能数字全部为离线确定性基准；inset 的真 VLM IoU 在线 A/B 与 W5-4 SoM 锚点真模型增益同族，待真模型/长跑在线对照——ΤΕΛ-9 升格「需真机+一键验证」：probe-da6-vlm（N 文本轮+1 视觉轮，p50/max 延迟与 token 计量；≥80%<100% ⇒ degraded），密钥到场即收割 | 需真机（探针就位） | test/w5*.bench.ts（六文件）；test/w5somcall.test.ts ⑨（模拟证据诚实边界）；scripts/realverify/probe-da6-vlm.mjs（本机 absent：密钥缺席）；docs/realverify.md |
| D-A7 | 早期（W-2 真机审判之后的申报）→ W8 半闭 | 原债「UDS dispatcher 真机往返待 Linux CI（Windows 主开发环境无法覆盖）」——W8 已落 ci.yml Linux 物理服务 e2e 步骤（ubuntu-latest 可编辑安装 dsh_physical 全声明依赖 → 预起 tcp:8421 服务 30s 探活 → physicalExecution.adapter.http 真服务路径实跑 + /dev/shm POSIX 分支真机执法），本机 Windows 无法复现 Linux runner 行为，下次 push 真机首验后闭——ΤΕΛ-9 增补探针：probe-da7-linux（/dev/uinput + /dev/shm 可写 + SO_PEERCRED 对端 pid 核验），Linux 机到场即收割 | 需真机（半闭：ci.yml 步骤已落地，待下次 push Linux CI 真机首验后闭；探针就位） | .github/workflows/ci.yml:1-10（Linux workflow 定位 + D-A7 申报）/ :31-42（可编辑安装 + compileall）/ :53-73（tcp:8421 预起配方 + 探活执法）；scripts/realverify/probe-da7-linux.py（本机 absent：非 Linux）；docs/realverify.md |
| D-A8 | ΠΑΝ 修复潮 F3-1 移交（ΠΑΝ-83，2026-10-04 新登记） | audio.py comtypes 建链臂（py<3.14 活动臂）的真 COM 真声卡冒烟：本机 py3.14 的 comtypes 出参约定回归使其不可用（D-E2 已闭的对照面），无法在本机实测该臂——解析层已与 raw-vtable 臂构造性同源（同一 parse_wave_format 单源 + _WaveFormatEx/_WaveFormatExtensible pack(1) 锚点 + 字节级夹具 19 项 selftest 全 PASS），唯余 py<3.14 + 真 COM 环境的建链冒烟——ΤΕΛ-9 升格「需真机+一键验证」：probe-da8-comtypes（_build_comtypes 构造 + _open_session_comtypes 真建链三步 + 引擎标记 comtypes；py≥3.14 ⇒ absent 版本域语义），py<3.14 解释器到场即收割 | 需真机（py<3.14 真机冒烟；raw 臂本机真声卡已采到真音频；探针就位） | python_service/dsh_physical/audio.py（--selftest 含 PAN-83 字节夹具 19 项 PASS）；scripts/realverify/probe-da8-comtypes.py（本机 absent：py3.14.6≥3.14——正是债的活动臂边界）；C:\2\.survey\fix\F3-1.md §ΠΑΝ-83 真机验证段、T1-9.md §五 |

## B. 激活开关清单（API/器官已就位、缺省关或投喂面未接）

| # | 来源 | 描述 | 状态 | 证据 |
| --- | --- | --- | --- | --- |
| D-B1 | W1-7 → W5-4（稀疏 SoM） | somSparseBudget 缺省 0：W5-4 已把调用面接进 orchestration L3 生产管线（W1 潮「renderSomOverlay 零调用方」缝隙闭合），但翻转稀疏默认改变标注输出面，留待真机在线 A/B 证据——ΤΕΛ-9 增补探针：probe-db1-som（A 臂原图 vs B 臂稀疏选择交替轮——可观测差异即开闸证据，负结果同为证据 ⇒ degraded），密钥+真屏到场即收割（探针只供证据，翻转立法仍归部署决策） | 需真机（开闸证据；探针就位；投喂面见 D-B3） | src/config.ts:526（default(0)）；src/vlm/som.ts；test/w5somcall.test.ts；scripts/realverify/probe-db1-som.mjs（本机 absent：密钥缺席）；docs/realverify.md |
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
| D-E3 | ΝΩ-54 收官复核发现（2026-10-04，新登记） | w9real D-A5（真三进程真 socket barrier 往返）在本机 **node v24.19.0 / Windows 确定性红**：客户端 A 完成 barrier 往返（RESULT {"ok":true,"ackOk":true,"peers":["A","B"]} —— 协议本身成功）后 `process.exit(0)` 与 libuv 异步句柄关闭竞态 ⇒ fastfail 0xC0000409（stderr「Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 94」），测试断言「客户端 A 退出码 0」失败。归因证据三链：① 测试 + 客户端脚本 + crossMachine 栈**零 ΝΩ 标记**（federation-server 的 ΝΩ-19 改动仅 /aggregate 摘要中继、不涉 barrier 端点——git diff 亲验）；② **git archive HEAD（W9 纯净树）同款复现**（RESULT ok:true 后退出异常——非 ΝΩ 回归；node v22.14.0/v22.18.0 历史 W9/AΩ 收官 0 fail 记录在 GENESIS 在册）；③ 单跑 4/4 同款红（确定性非偶发）。出路（任一，非本册 .md 产权）：CI/开发机钉选 node LTS 22.x；或客户端退出序列补丁（transport 优雅关闭后再 exit——scripts 域一行级改动）；或测试断言放宽为「RESULT ok 即过」（退出码与协议成败解耦）。**ΠΑΝ-F3-3 归因补强（2026-10-04）**：对照实验已定案——用不含任何本工单改动的裸 node:http 服务复刻 barrier 应答面，轮询方客户端同样 5/5 崩溃 ⇒ 纯客户端侧 Windows/libuv 退出竞态（process.exit 与未决 undici keep-alive socket 竞态）；一行修法在案：scripts/w9real-barrier-client.mjs 结尾 `process.exit(rc)` 改 `process.exitCode = rc`（自然排空退出） | 已闭环（ΑΝΒ-3/D3 落地 2026-10-05：退出协议升维=零 process.exit、exitCode+事件循环自然排空——0/1/2 三退出码语义逐码实测不变、断言零放宽；单册 7/7 连跑零 flake，全量 3631 测试 w9real 首次绿（node v24.19.0）——版本无关性=无抢占点；engines 上界两案[甲放宽>=20/乙维持<24]留主人定谳，CI 仍钉 22/20） | test/w9real.test.ts:96-117（断言面）/ :116（exit code 断言）；scripts/w9real-barrier-client.mjs:54（process.exit）；本册 standalone 复现记录（exit 127 / 0xC0000409 双形态 + HEAD 纯净树对照）；GENESIS「ΝΩ 前沿升级战役」段审判口径① |

## F. 结构性大文件与依赖环（拆分/破环是决策不是缺陷——先立案再动刀）

| # | 来源 | 描述 | 状态 | 证据 |
| --- | --- | --- | --- | --- |
| D-F1 | Σ/Θ/Ξ/Κ/W4-4/W5-2（训练营累积）→ W8-B1 拆分（已闭） | 原债「src/autonomy/gym.ts 3377 行：四虚拟世界 + PCG 文法 + 惊异课程 + 多代进化 + 噪声诊所 + 梦训练营六纪元集于一册（各有执法册锚定——拆分须保执法面不动）」——已拆：gym.ts 1557（训练营主体与课程/进化编排）+ 6 卫星件（gym.world.ts 476 四虚拟世界 / gym.pcgWorld.ts 450 / gym.pcgDerive.ts 425 / gym.noise.ts 286 噪声诊所 / gym.pcgGrammar.ts 219 / gym.pcgCampaign.ts 167），导入面稳定（消费方零改动）、执法册锚定面不动 | 已闭环 | wc -l 实测（2026-10-04）：gym.ts 1557 + gym.world 476 + gym.pcgWorld 450 + gym.pcgDerive 425 + gym.noise 286 + gym.pcgGrammar 219 + gym.pcgCampaign 167；test/w8gymsplit.test.ts（拆分执法册）；autonomy.gym / kernel.gym / w4pcg / w5dream 既有锚定册随全量复跑绿 |
| D-F2 | 各纪元累积 → W8 部分拆分 | 千行级产权文件：W8 已拆两大件——approval.ts 1584→97 桶 + 9 卫星件（approval.bypass 226 / approval.ledger 316 / approval.queue 275 / approval.queueState 313 / approval.security 250 / approval.constants 42 / approval.queueContracts 147 / approval.registry 67 / approval.shapes 73）、autonomy/runtime.ts 1581→989 + 6 卫星件（runtime.deps / runtime.perceive / runtime.tuning / runtime.types / runtime.utils / runtime.verdict）；index.ts 1104→1147（组合根——五脏六腑挂号处，聚集合法）。仍千行在案：skillLibrary.ts 1542 / autonomy/autoPilot.ts 1540 / reversalEscrow.ts 1439 / federation/index.ts 1205 / subAgent.ts 1335。**终谳（2026-10-04）**：组合根聚集合法终谳维持；其余千行件的拆分提案另案（未豁免清单见 D-F4，拆分/豁免是决策不是缺陷） | 已定谳（设计决策：组合根聚集合法维持；其余待拆分提案另案——19 件未豁免 >500 行的 doctor info 见 D-F4） | wc -l 实测（2026-10-04）；dist 272 件对齐（build 复跑） |
| D-F3 | W5-3（双实现口径）→ W8-A7 单源化（已闭） | 原债「crossMachine 的 TS 权威源与 federation-server.mjs 的 JS 移植并存（等价性由 w5cross ⑧ 逐字段执法——刻意架构立案备忘）」——已单源化：federation-server.mjs 改薄 re-export——barrier 状态机经 `import { createBarrierCore, BARRIER_MAX_LIVE } from '../dist/crossMachine.js'` 直连 TS 权威源的构建产物，本文件不再持有第二份实现（federation 域的 HTTP 协议胶水仍在本文件，明确不在 crossMachine 单源化范围）；w5cross ⑧ 等价性执法照旧在册 | 已闭环（单源化落地，双实现口径债消解） | scripts/federation-server.mjs:62（import dist/crossMachine.js）/ :133-138（W8-A7 单源化注释「本文件不再持有第二份」）；src/crossMachine.ts（唯一权威源）；test/w5cross.test.ts ⑧ |
| D-F4 | W8-C1V→W8-C2（doctor 分差来源） | 19 个未豁免 >500 行文件的 smell.over-engineering info（doctor score=90.5 与满分的分差来源；另 21 件结构性保留已豁免、可见不扣分）：riskGate.confusables.generated 1672 / skillLibrary 1542 / reversalEscrow 1439 / federation/index 1205 / index 1147 / contextManager 685 / processScore 818 / prophecy/index 616 / journal 604 / notary/index 547 / qualityDoctor 545 / riskGate 545 / selfmodel/index 552 / orchestration/index 509 / tools/skillTools 510 / guards/canaryGuard 516 / vlm/som 565 / config 577 / subAgent 1335——拆分或豁免是决策不是缺陷——**W9-3 窗口份额执行**：confusables.generated 豁免入册（生成物）+ skillLibrary/subAgent/federation-index 三巨件拆分（1541→1005+2卫星 / 1334→872+2卫星 / 1204→96+4卫星，豁免 21→24）；doctor 90.5→92.5（minor 归零）；剩余 15 件未豁免 info 属后续窗口（非本轮职权，如实留案） | 部分闭环（W9-3 窗口份额；剩余 15 件留案） | doctor-report.json（W8-C2 2026-10-04 实跑：findings 40 info = 21 豁免 applied + 19 未豁免）；src/doctorRules.exemptions.ts（21 件豁免注册表） |
| D-F5 | ΝΩ-41（cycle_lint 依赖环执法 · 5 value 环新债） | src 依赖图 5 个 **value 依赖环**（运行时真环——bundler 循环依赖 / 初始化顺序未定义）登记为新债：① 感知主环 SCC(10)（som.layout ↔ som ↔ grounding ↔ vlmOcr ↔ textReader ↔ wordShape ↔ knowledge/stations ↔ physicalExecution/d7HostPort ↔ physicalExecution/index ↔ physicalBackend）；② gym 家族 SCC(7)（gym ↔ gym.world ↔ pcgCampaign/Grammar/Derive/World ↔ noise——W8-B1 拆分的桶-卫星互指残留）；③ actionVerifier 三册 SCC(3)（stable ↔ 主册 ↔ channels）；④ branchCards ↔ branchCards.card（SCC 2）；⑤ rollbackPlanner ↔ rollbackPlanner.plan（SCC 2）。另 9 个 type-only 环（环上全为 import type——编译后蒸发运行时无害，warning 建议降级不执法）。cycle_lint（零依赖自带 Tarjan + value/type 边保守判定）**exit 1 立法在案：环在案一日执法红一日**——现状按「已知环不新增」执行（方言单源化 ΝΩ-41 施工期内环数封顶不增），破环（残余 value 边降 import type，或桶-卫星互指拆解经接口/常量件反转）属后续窗口结构决策，登记防依赖图回到 ΝΩ-41 之前「15 个 SCC 无执法演化」的旧态 | 已闭环（ΠΑΝ-127 · F4-1：cycle_lint 实跑 value 环 5→0 绿退出——五环拆法与验证见 C:/2/.survey/fix/F4-1.md；type-only 环 13 仍豁免在案） | scripts/cycle_lint.mjs:1-17（立法背景 + 边判定律）/ :198-253（Tarjan 找环 + value-cycle 判定）；本册收稿实跑（2026-10-04）：287 文件 / 1438 相对边 / 14 非平凡 SCC（5 value 环 exit 1 + 9 type-only warning）；test/no41.dialectClones.test.ts（9/0 本册实跑——六处方言副本退役的种子对照）；GENESIS「ΝΩ 前沿升级战役」段第 5 批 ΝΩ-41 行；F4-6 终验实测（2026-10-04，活树三次采样）：首验（22:26 前）292 文件/1493 边/15 SCC——value 环 5 与在案逐环一致（①感知主环 SCC 10→9：som.layout 已出环、环体仍在）；22:28 时点 293 文件/1496 边/14 SCC——⑤ rollbackPlanner 环已由新件 src/rollbackPlanner.trace.ts 破除（ΠΑΝ-127 在途施工）；22:30 时点 294 文件/1497 边/13 SCC——④ branchCards 环亦破（新件 branchCards.ledger.ts 抽取），value 环余 3；22:32 验收正式收口——③ actionVerifier 环亦破，value 环余 2（感知主环 9/gym 7），295 文件/1497 边/13 SCC；type-only 11（豁免级不执法）。收口时执法仍红（value 2>0）、ΠΑΝ-127 破环施工仍在收敛中，后续环数演变归其收工登记 |

## G. 其他遗留（悬挂测试 / 数据面缺失 / 增强通道）

| # | 来源 | 描述 | 状态 | 证据 |
| --- | --- | --- | --- | --- |
| D-G1 | Π + Β（悬挂测试）→ W8-A1 根治（已闭） | 原债「epochPi/epochBeta 各 3 例悬挂（全量 cancelled 6——基线即同款）」——已根治：两册各持事件循环保活 helper（持一枚 ref'd 保活定时器、finally 收口）——根因是裸测试进程的定时器句柄全 unref 不保活循环，abort 触发前事件循环先行排干 ⇒ node:test 判 cancelled；保活哨持住循环至测试自然收口，产品真挂死时保活到期后照常超时（不掩盖真缺陷）。本册复跑 epochBeta.refute 7/7、epochPi.notary 5/5、全量 cancelled 首次归零 | 已闭环 | test/epochBeta.refute.test.ts:104-115（helper 定义）/ :265-266（消费 + finally 收口）；test/epochPi.notary.test.ts:28-39（helper）/ :266（消费）；本册全量 2472 用例 / cancelled 0 实测（node v22.18.0） |
| D-G2 | Ε（预言引擎）→ W8 细化（已闭） | 原债「屏型身份用 dhash 指纹（粒度粗于世界模型聚类 ⇒ no-model 偏多）+ 惊异喂 EvolutionEngine 通道未接」——已闭两面：① 粗层桥 coarseScreenType（精确屏型键查无 ⇒ dhash 前 8 hex 粗格（上 32 位梯度）再问一次；粗层预言诚实标注 predictedVia:'coarse'，统计面 coarseAssisted 可观测——回退的收益不掺水分）；② 惊异喂养通道 surpriseFeed.ingest（结算失手自动喂进化引擎；surpriseRunRecord 水位线只喂失手、零重喂；纯旁路防御吞错绝不影响闭环）且组合根 buildAutonomyStack 生接线（ProphecyEngine 构造期直投 surpriseEvolution 单例——enableProphecy !== false 时） | 已闭环 | src/prophecy/index.ts:41-58（粗层桥 + 喂养通道设计段）/ :66（coarseScreenType）/ :82-83（predictedVia）/ :110-111（coarseAssisted）；src/autonomy/index.ts:359-365（W8-C1 生接线 surpriseFeed: surpriseEvolution）；test/w8.prophecy.test.ts（粗层/喂养/真引擎结构直收执法）+ test/w8.finalwiring.test.ts F-3 |
| D-G3 | Β（反驳法院）→ W8-A6（已闭） | 原债「VisionProvider 未外露 baseUrl（同源剔除现仅 providerId 因子——双因子是目标态）」——已闭：① providers/types.ts VisionProvider 外露 readonly baseUrl（同平台不同 baseUrl 的脑可区分，反驳法院同源剔除升双因子）；② 展示面脱敏纪律（baseUrl 进日志/UI/遥测前必经打码函数——参照 sanitizeError/maskKey 律）；③ GlmClient 具体类降为 StructuredVisionPort 窄端口（configured + chatJson 结构面——grounding 主脑/verifyClient 第二意见脑可直入任意满足端口的多供应商实现，不再锁死单实现） | 已闭环 | src/vlm/providers/types.ts:130-137（baseUrl 外露 + 注释）/ :187（装配面 baseUrl）/ :311-312（脱敏纪律）；src/vlm/grounding.ts:392-393（verifyClient: StructuredVisionPort）/ :611-619（client 窄端口）；test/w8.providerPort.test.ts（假 provider 断言 + openai 族真适配器执法） |
| D-G4 | Ζ + 早期（标定数据面） | Kalman/GPD 标定值待生产数据（睡眠④幕只建议不落值的立法语义——数据面待长跑）；Schmitt/NCD 两原子需先落账数据面（弹窗帧三元组/检索回访标签）——ΤΕΛ-9 增补探针：probe-dg4-calib（.jsonl 三族方言解析 + 诚实下限执法 + Q/R、Schmitt 强度对、NCD 阈（Youden J）、GPD 临界表建议值产出——calibration.ts 单源），生产长跑数据目录到场即收割（探针只供建议值，落值仍归部署决策） | 需真机（生产数据长跑；探针就位） | src/calibration.ts；src/sleep/index.ts（标定建议书）；scripts/realverify/probe-dg4-calib.mjs（本机 absent：0 条可解析标定记录）；docs/realverify.md |
| D-G5 | Π（重放证词留白）→ W8 双接线（已闭） | 原债「replayOne 重放层不采集公证证据（走 degraded 旧语义——有意留白）」——已闭留档：① notary/replayWitness.ts 铸证便捷面（replayStepFingerprint 步指纹——journal 链哈希优先、缺席走 canonical 摘要；anchorReplayTrajectoryOn 把 ReplayTrajectoryWitness 见证铸进 notary 锚——Notary 单例结构性满足目标端口）；② 双接线：replay_actions 与 run_skill 的重放路径均铸 witnessSteps（步指纹 + 三态结局 + 整体成败）入 notary 锚；公证缺席（宿主未装配）或铸锚失败 ⇒ 诚实降级标注——公证是旁路仪式，重放绝不因公证阻断 | 已闭环 | src/notary/replayWitness.ts:1-116（便捷面 + 运行铁律）；src/tools/replayActions.ts:53-57（import）/ :123-139（witnessSteps 铸造）/ :174-176（降级纪律）；src/tools/skillTools.ts:21-23（import）/ :424-443（同款接线）；test/w8.replaynotary.test.ts |
| D-G6 | 早期（宿主面） | #5/#7 宿主侧总线与 agents 后端（地基速修清单未竞事项） | 需人工 | INNOVATION.md 三、#5/#7 |
| D-G7 | W6R-A3（nonce 强制）+ 第 2 批集成收口（已修留档） | 行为变更：token 认证启用后 X-Request-Id（单次性 nonce）为强制头——缺头 401、同 nonce 重放 401（旧实现缺头静默放行，60s TTL 窗内可无限重放——防重放层形同虚设；认证失败统一改 HTTP 401 + failure 信封）。三册裸 fetch 冒烟（epochSigma.display / w4mobile / w5pyreg 的 svcPost/svcGet）原只带 X-Cap-Token——第 2 批集成代理已于本册收稿窗口内落地补头（每请求 randomUUID；本册亲见三文件 mtime 2026-10-04 05:34:45-59 落地、落地前 grep 确无此头、落地后逐文件计数各 2 处），生产面 microFetch 早已自动注入（缺席才注入、在场不覆盖）；w4audio 纯注入面无 fetch 不涉及。本册复跑 w5pyreg 9/0 | 已闭环（第 2 批落地，本册亲验复跑） | python_service/dsh_physical/server.py:231-247（W6-R-A3 强制头 + 重放 401）/ :183-184（auth 中间件）；test/w5pyreg.test.ts:145-147、test/w4mobile.test.ts:658-660、test/epochSigma.display.test.ts:145-147（补头）；src/physicalExecution/httpClient.ts:147-160（microFetch 缺席注入）+ :18-20（头注契约）；test/physicalExecution.httpClient.test.ts:52-85（注入/不覆盖执法） |
| D-G8 | W6R 遗留 → 第 2 批 B1（已修留档） | 原债「verifyActions 逃生门：config.verifyActions=false（或 dry-run）时效果验证整链关闭、危险动作仍派发（clickMouse 注记 "Effect verification unavailable …; token consumed on dispatch"——fail-open 逃生门，效果验证体系被单开关静默旁路）+ 同族两处探针 fail-open（新鲜度/金丝雀缺席一律 degraded 放行）」——已核实修复（第 2 批 B1/W6R-C1 落地）：① 新配置 allowUnverifiedDangerous（缺省 false，高危逃生门）：verifyActions=false 单独不再旁路危险令牌动作（clickMouse 派发前拒，reason=effect-verification-required）；须 verifyActions=false **且** allowUnverifiedDangerous=true 双钥匙齐备才恢复旧方言 unverified-dispatch-consumed（dry-run 豁免同前）；② 新鲜度探针：dangerous+token 派发前 degraded ⇒ fail-closed 拒派（reason=freshness-probe-unavailable，令牌不烧、GUARD 入链）；drifted 阳性漂移不受逃生门豁免；③ 金丝雀：仅携带 approval_token 的调用（审批域活口）探针缺席/失败 ⇒ 拦截，非令牌动作维持 degraded 放行（避免大面积误杀）。三处出路均指明：重试/开探针/显式逃生门。非 dangerous 分级维持 verifyActions 原语义不变 | 已闭环（第 2 批落地，本册亲验复跑） | src/config.ts:106-128（allowUnverifiedDangerous 声明 + 双钥匙语义注释）/:426（Schema 缺省 false）；src/tools/clickMouse.ts:704-754（新鲜度 fail-closed：:729 degraded 拒派、:707 drifted 恒拦）/:770-790（双钥匙执法块）/:909-916（unverified-dispatch-consumed 仅剩 dry-run/双逃生门两合法入口）；src/guards/canaryGuard.ts:318-321（tokenPath+failClosed 判定）/:323-347（拦截消息三条出路；:346 非令牌动作放行）；执法册 test/epochDelta.safety.test.ts:333（W6R-A 双钥匙）/:359（W6R-B 新鲜度）、test/w2audit.test.ts:446-470（S3-4）、test/w2canary.test.ts:531/:557（金丝雀令牌路径 fail-closed + 逃生门复跑） |
| D-G9 | W8-B4（判据证伪·极性分工红线） | 判据肯定面 fuzzy 容错器官层已备、环内未消费：criteriaEval.ts 在同一判据 DSL 之上为肯定面（must-appear）备好 fuzzy 容错（fuzzy.ts ⌈m/6⌉ 六字符容一错、<3 字符短模式只走精确的 actionGate 同律护栏），但 runtime 主路径 checkCriteria 仍是折叠子串匹配（只证真），autoPilot 环内只消费否定面（must-not-appear——肯定面归 execute 通道）。红线：fuzzy 肯定面若局部打补丁换用会翻转既有终局语义（OCR 距离 1 的「门没开」误判 met），换用必须 runtime 整体切换 evaluateCriteria 一次性收口——**W9-1 已收口**：runtime 三调用点整体换用、无方言并存（w9criteria 10/0 执法）；死亡世界同屏点击由宽容 progress 改判如实 no_effect ⇒ 宪法卡死律提前熔断（closedloop B6 按新终局改判 7/0） | 已闭环（W9-1） | src/autonomy/criteriaEval.ts:1-15（器官三块能力）/ :121（evaluateCriteria）；src/autonomy/runtime.ts:101-103（子串匹配只证真注释）/ :161-162（checkCriteria 现状）；src/autonomy/autoPilot.ts:1438-1452（只消费否定面 + 红线注释「肯定面归 execute 通道」）；test/w8.criteria.test.ts |
| D-G10 | W8-B4（判据 DSL 模型面公开·留档） | mustNotAppear 否定判据 DSL 已写入 autonomous_run 使用准则提示词：模型可见面声明否定形态（`mustNotAppear:` 或「不得出现：」前缀 + 禁词；OCR 命中禁词 ⇒ 该判据 violated ⇒ 终局 failed）——「错误弹窗须已消失 / 已退出登录」类收尾核对从编排方私设升格为 DSL 一等公民。行为面变更留档：提示词新增 DSL 段不改变缺省行为（无否定判据 ⇒ 逐字节旧语义） | 已闭环（W8 落地留档；供 D-G9 换用时的模型面参照） | src/index.ts:173-182（AUTONOMY_RUN_PROMPT 判据 DSL 段）；src/autonomy/criteriaEval.ts:27-33（NEGATIVE_PREFIXES 同源方言表）；test/w8.criteria.test.ts |
| D-G11 | W8（tesseract 离线语言包语义修正·留档） | langPath 迁移至 test/fixtures 后两个世界对局 harness 的 createWorker 语义修正：`gzip: false, cacheMethod: 'none'`——本地裸 eng.traineddata 非 gzip 压缩包（缺省 gzip 语义会按压缩包解包失败）、CI 每次全新装（缓存 none 杜绝陈旧缓存指向旧语言包），零网络下载的离线确定性执法面就位 | 已闭环（语义修正落地留档） | test/complexWorldWinHarness.ts:147-153（langPath 指 fixtures + gzip:false + cacheMethod:'none'）；test/realWorldWinHarness.ts:106-112（同款）；test/fixtures/eng.traineddata（离线语言包在场） |
| D-G12 | C2-8 §4.1（账面器官#1，批判点名「不在台账」）→ ΠΑΝ-34 接线（已闭） | 原债「reversalEscrow.arm 全库零生产调用 ⇒ dispatchGate 派发闸门/结算钩子/TTL sweep/WAL 持久化四命脉悬空，旗舰安全叙事发行形态不可达，且 DEBTS 未登记（比申报的债更危险的是没意识到的缺位）」——已闭：组合根 apply 内 enableReversibilityLanes（既有开关，缺省 false）开启路径 armReversalEscrow 四命脉一次激活（dispatchGate 单点注册 setDispatchEscrowHook / setEscrowSettlementHook 消费 fireEscrowSettlement / 5s unref sweep 定时器 / checkpoint 同目录 escrow-wal.jsonl 持久化）+ clickMouse beginAttempt 携 planId 闭合执法链 + mintPlan 在途上界 64；开关关（缺省）⇒ 零执行与接线前逐字节等价（缺省关立法面另见 D-B5 同族） | 已闭环（ΠΑΝ-34：组合根通电；缺省关 = opt-in 立法非债） | src/index.ts:913（armReversalEscrow 武装块）/ :890（四命脉注释）；src/tools/clickMouse.ts（attemptReservationStage 携 escrow planId）；src/reversalEscrow.ts（MAX_IN_FLIGHT_PLANS=64）；test/pan3437.fix.test.ts ΠΑΝ-34①（10/0 本册实跑）；C:\2\.survey\fix\F2-1.md |
| D-G13 | C2-8 §4.2（账面器官#2）→ ΠΑΝ-50 通道（已闭） | 原债「promoteFrom 零生产调用——Θ/Ξ 内核进化叙事（58 键、10 代收敛）全部发生在实验室，发行形态可注册不可进化；calibrator 立法封死自动通道的同时没给手动通道」——已闭：promoteFrom 重立法四护栏（步长夹取 maxStepPct×区间宽 / Beta-Bernoulli 回归守卫 P<0.9 跳过（与校准器共用 regressionPosteriorMass 单源）/ 血统快照两代同律 / 证据计数 max(生产,lab) 不覆写）+ promoteFromCli 显式 CLI 通道（缺省全副武装、dryRun 影子册、故障收敛 ok:false 绝不抛）——CLI/脚本可达的安全分池键换值唯一合法写径入口面 | 已闭环（ΠΑΝ-50：护栏 + CLI 通道就位；doctorCli 子命令接线为可选增强见 D-G22） | src/kernel/registry.ts（promoteFrom 重立法 + 四护栏）；src/kernel/index.ts:103（promoteFromCli）；test/pan49-55.fixes.test.ts（19/0 本册实跑）；C:\2\.survey\fix\F2-5.md §二 |
| D-G14 | C2-8 §4.3（账面器官#3）→ ΠΑΝ-48 接线（已闭） | 原债「escalateProbeLatch：stations.ts 注释宣称的接线缝（pipeline learnSettled 的 capacity 分支）在 pipeline 里不存在——三件齐（定义+注释+测试）、线没接，跨 run 探针闩锁不生效」——已闭：learnSettled 容量拒绝分支真实落地（r.error.field==='capacity' 且 ReflexiveDecisionStation ⇒ escalateProbeLatch 进程级闩锁 1h 懒过期 + knowledge-internal-fault 入链可观测 phase='probe-latch-escalated'；上报永不抛） | 已闭环（ΠΑΝ-48：接线缝落地，注释「已接线」自此是事实） | src/knowledge/pipeline.ts:692-699（接线点 + 注释）/ :699（escalateProbeLatch 调用）；test/pan43-48.knowledgeClosures.test.ts（11/0 本册实跑）；C:\2\.survey\fix\F2-4.md §ΠΑΝ-48 |
| D-G15 | C2-8 §4.4（账面器官#4）→ ΠΑΝ-59 接线（已闭） | 原债「clearBlockers 全库零生产调用（autoPilot 测试还得自己 mock 一个）——blocked 态无出口，生产中目标一旦 blocked 即永久卡死；autonomy_resume 同 spec 重铸再 blocked = 断点续跑 0 步死循环」——已闭：goalState 构造降级留档面（_constructionBlockers + clearConstructionBlockers 只清构造项）+ driveLoop ①′ 零步 blocked 且阻塞全为构造降级项 ⇒ 清账重评估放行（三重护栏：每 run 至多一次 / 运行期阻塞不清 / 结构面缺席逐字节旧路径） | 已闭环（ΠΑΝ-59：降级 spec 续跑死循环根除；census 册的 clearBlockers 豁免条目见 D-G27 申报） | src/autonomy/goalState.ts:321（clearConstructionBlockers）/ :305-333（构造降级留档面）；src/autonomy/autoPilot.ts:1217（driveLoop ①′ 清账接线）；test/pan56-61.autonomy.test.ts（18/0 本册实跑）；C:\2\.survey\fix\F2-6.md §ΠΑΝ-59 |
| D-G16 | ΠΑΝ 修复潮 F2-3 移交（ΠΑΝ-39/40 残留） | 沙箱栈接线收尾三件：① 根 Config 无沙箱专属开关——组合根现以 autonomyEnabled（既有缺省关）门控 applySandboxStack（语义最近的权宜，报告申报理由；独立开关 enableSandboxStack 需 config.ts 新增字段一行 schema + index.ts 门控替换）；② enableHostReplayExecution 组合根点亮面同缺（宿主真派发保持开发者预览）；③ planner chain 臂的生产发射消费方——orchestrator.ts 两处 planTasks 调用（首规划 + Σ-4 重规划）未传 opts.emitPlanReady/opts.chain；另 C2-3 M3/M7/M8 三 M 级不在四张卡内——**ΤΕΛΟΣ 清偿（2026-10-05）**：① ΤΕΛ-8a 落地 enableSandboxStack 三态门控（schema 刻意无缺省 = undefined 穿透，未设回退旧门控逐字节兼容；index.ts:1107 门控行）；② ΤΕΛ-8a 设计裁定：点亮面留在 SandboxConfig 层显式开（apply.ts:382 懒装配），组合根不点亮由 pan39-42:152 金丝雀钉死（宿主真派发最高危面，保守裁定留档）；③ ΤΕΛ-4 落地 orchestrator planReady 生产发射接线（planReady 供源闭包 + planTasksGuarded 四参透传 + index.ts 组合根注入 sinceTaskStart 可重放步链，受沙箱栈三态门控、缺省部署逐字节一致——t1-4 册 5 例全绿）；M3/M7/M8 拆条新立 D-G33/D-G34/D-G35 | 已闭环（①③ 代码在案 + ② 设计裁定留档；M3/M7/M8 拆条 D-G33..35） | src/config.ts（enableSandboxStack 三态立法 + ΤΕΛ-8a 段注释）；src/index.ts:1107（三态门控行）+ planReady 注入块；src/orchestrator.ts（RunOrchestratorOptions.planReady + planTasksGuarded 透传）；test/pan39-42.sandbox.test.ts 39c（三态门控金丝雀）；test/t1-4.gdebts.test.ts（D-G16③ 5 例）；C:\2\.survey\fix\T1-4.md §D-G16、T1-8.md §一 |
| D-G17 | ΠΑΝ 修复潮 F1-1/F2-9 移交（对接点 4/3） | 治理锚扩展两件：① doctorRules.security.ts 的 sec.approval-fail-closed canary 锚仍只锚 grantDetailed 守卫——队列裁决面（adjudicate 码校验块）与 canaryGuard 裁决面锚（adjudicateCarriesConfirmEvidence，canaryGuard.ts:427/:464 已在场）未纳入 doctor 金丝雀锚，防回改面缺一角；② escrow WAL 篡改检测的恢复面行为已落地（篡改行弃置 + in-flight 转人工）但 stats().walTamperedLines 持续非零的检视消费方（doctor 规则）未建——**ΤΕΛΟΣ 清偿（2026-10-05）**：① ΤΕΛ-4 把单面锚扩为三面锚（Ⅰ grantDetailed 原锚逐字保持 + Ⅱ 队列裁决面四结局字面量缺任一 ⇒ critical + Ⅲ 金丝雀 adjudicateCarriesConfirmEvidence 谓词与 'adjudicate_approval_queue' 工具名锚双要素——each only-if-present、isCommentLine 过滤；真实源码树金丝雀零命中执法在册）；② ΠΑΝ-116 已落地 chain.wal-tampered（critical）经 reversalEscrow.stats() 消费 walTamperedLines（pan114-119 端到端执法），Τ1-4 独立复跑取证补强 | 已闭环（① 三面锚落地 + ② ΠΑΝ-116 在案） | src/doctorRules.security.ts（三面锚）；src/doctorRules.core.ts:290/:296（chain.wal-tampered + stats() 消费）；test/t1-4.gdebts.test.ts（D-G17① 4 例 + ② 取证 1 例）；test/pan114-119.fix.test.ts ΠΑΝ-116a/b；C:\2\.survey\fix\T1-4.md §D-G17 |
| D-G18 | ΠΑΝ 修复潮 F2-9 移交（对接点 2）+ F3-3 归因② | 函数克隆单源化残余：F3-3 收稿时点 bug_class_lint 两处 BC-5 命中（approval.queueContracts.ts↔checkpoint.ts 信封镜像、vlm providers ensemble.ts↔failover.ts）——信封密钥面已由共享件 src/hmacKeyFile.ts 收口（readHexKeyFile/loadOrCreateHexKeyFile 双导入），唯共享件自身导出 HMAC_KEY_FILE_BYTES 成新孤儿（见 D-G27）；BC-5 克隆律执法在案，新克隆入红由 ΠΑΝ-85 豁免登记制治理——**Τ1-4 验证收口（2026-10-05）**：`python scripts/bug_class_lint.py --strict` 实跑 **exit 0 全库零命中**（BC-1..BC-5 全零）；共享件与双导入亲验在场；孤儿 HMAC_KEY_FILE_BYTES 已在豁免册登记（wiring-census.exemptions.json:1621）；T2-5 终验复跑同判零命中 | 已闭环（克隆面绿 + 孤儿登记在册） | scripts/bug_class_lint.py --strict（Τ1-4 与 T2-5 两次实跑 exit 0）；src/hmacKeyFile.ts；src/approval.queueContracts.ts:49 / src/checkpoint.ts:37（双导入）；scripts/wiring-census.exemptions.json:1621；C:\2\.survey\fix\T1-4.md §D-G18、T2-5.md §五 |
| D-G19 | ΠΑΝ 修复潮 F1-7/F2-7 移交（对接点） | Node/Python capability 位镜像漂移：Python auth.py 已扩 admin/observe 位（ΠΑΝ-25），TS 侧 src/physicalExecution/contracts.ts 的 Capability 联合与 ALL_CAPS 数组未镜像——未镜像期间旧 Node token 不含新位 ⇒ /v1/shutdown、/v1/stats、/v1/input_events、/v1/devices、/docs 对其 401（fail-closed 方向正确，token TTL 60s 过渡窗极短，但契约两侧须对齐）；serviceManager/adapter 铸 token 调用点若显式列举 caps 亦需补——**Τ1-4 取证闭账（2026-10-05）**：ΠΑΝ-128 已闭环（contracts.ts:106-120 Capability 联合含 'admin'｜'observe' + ALL_CAPS 镜像 + pan128.capContract 程序化对账册在场——TS 联合 === 运行时数组 === Python ALL_CAPS 序与集逐字节同源）；铸造点核验 serviceManager.ts:556 mintToken(key, pid, ALL_CAPS, 60) + adapter.ts:586 defaultCaps ?? ALL_CAPS——全库无显式 caps 列举点，漂移面结构性不存在；pan128 册 Τ1-4 独立复跑 **9/9 绿** | 已闭环（ΠΑΝ-128 闭 + 独立复跑取证） | src/physicalExecution/contracts.ts:106-120；test/pan128.capContract.test.ts（9/9 复跑）；C:\2\.survey\fix\T1-4.md §D-G19 |
| D-G20 | ΠΑΝ 修复潮 F2-7 移交（对接点 1） | knowledge failure 词表扩容：src/knowledge/contracts.ts:166 ExecutionResult.failure.kind 仍是 6 值旧方言——d7HostPort.translateFailureKind（:74）被迫把 ΝΩ-27 十四细分折叠为三类保义落位（终局/可重试/认证）；词表扩容接纳 kebab-case 十四值后翻译表可退化为恒等直通（每个已知 kind 独立 case 无隐藏耦合，结构已备好），两份契约的静默漂移就此根除——**Τ1-4 代码闭环（2026-10-05）**：D7FailureKind = ExecutionFailureKind（直接 import D-6 orchestration/contracts 单源，无环）+ 'timed-out' 自有方言增量；translateFailureKind 退化为恒等直通（19 值逐值独立 case，default 兜底 host-error 保守纵深第二层；'timeout-aborted' 不再折到 'timeout'——ΝΩ-8 归因可见性升格）；pan64-68 册 ΠΑΝ-65 矩阵改判恒等直通 + t1-4 册编译期漂移即红执法（18 值全量赋型）双册在案 | 已闭环（词表单源扩容 + 恒等直通 + 编译期执法） | src/knowledge/contracts.ts（D7FailureKind import D-6）；src/physicalExecution/d7HostPort.ts（恒等直通）；test/pan64-68.physicalExecution.test.ts + test/t1-4.gdebts.test.ts（D-G20 2 例）；C:\2\.survey\fix\T1-4.md §D-G20 |
| D-G21 | ΠΑΝ 修复潮 F2-5 移交（留白 2/3） | 校准/预言收尾两件：① autoPilot 的 settle 调用未传 prophecyId（autonomy 产权域当时未动）——引擎侧严格配对 API 已就绪且向后兼容（无号 LIFO 宿主面），宿主接线 mint 返回号后多挂起错配面即消失；② gym 实验室的 hammingTolerance margin 口径（「距离−容差」差值形态）仍旧语义——生产记录面（autonomousRun）已换 margin=原始距离新语义（ΠΑΝ-52），实验室口径的跟进使闭环证据两侧同域——**Τ1-5 代码闭环（2026-10-05）**：① prophecyArmedId 环内状态（mint 返回号防御收口——非正整数按未铸）+ perceiveAndSettle settle 第三参透传 + 真见证清号消费律（防 noMatch 噪声；号缺席 ⇒ LIFO 兼容面逐字节不变）；② gym margin 改原始 dhash 汉明距离直录（对合振荡根除，与生产面 autonomousRun.ts:424 两侧同域）；tel5 册号序断言 [undefined, 1001, undefined] + 台账非负执法 + 记录点源码锁 | 已闭环（宿主半边接线 + 实验室口径同域） | src/autonomy/autoPilot.ts（prophecyArmedId 三处）；src/autonomy/gym.ts（margin 直录 + 对合振荡论证注）；test/tel5.fixes.test.ts（D-G21① 2 例 + ② 1 例）；C:\2\.survey\fix\T1-5.md §一 |
| D-G22 | ΠΑΝ 修复潮 F2-6 移交（C1-4 中-2） | 弹窗确认点击限定：policyEngine 的 POPUP_CONFIRM_RE 未加弹窗 bounds 校验（确认点击可落在弹窗外任意同词位置）且「是」子串匹配过宽（「是否」类文案误中）——其触发面（生产 popups）因 ΠΑΝ-57 接通而激活；另 ΠΑΝ-50 的 promoteFromCli CLI 实体接线（doctorCli 子命令/独立脚本）为可选增强（接线点申报在案不动 doctorCli.ts）——**ΤΕΛΟΣ 清偿（2026-10-05）**：bounds 半面已被 ΠΑΝ-119 派发层闸闭环（autoPilot pan119PopupConfirmBoundsGate——① 级确认落点必须落弹窗栖息地，带外 ⇒ Esc 回退 fail-closed）；Τ1-5 补词面与决策层——「是」加汉字邻接守卫（单字前后均非汉字才命中：「是否/但是/是的」不再误中，多字中文词保持子串律）+ policyEngine ① 级栖息地过滤（popupHabitatNorm 单源方言 + centerInPopupHabitat 纯函数，几何缺席 ⇒ fail-closed 产 Esc——与派发层双闸同律同源）；可选增强（doctorCli 子命令）维持申报在案非债（CLI 通道 src/kernel/index.ts:103 已可达） | 已闭环（ΠΑΝ-119 派发层 + Τ1-5 词面/决策层合围） | src/autonomy/policyEngineUtil.ts（POPUP_CONFIRM_RE 邻接守卫）；src/autonomy/policyEngine.ts（① 级栖息地过滤）；src/popupDetector.ts（popupHabitatNorm/centerInPopupHabitat）；test/tel5.fixes.test.ts（D-G22 3 例）+ pan114-119 21/21 复跑；C:\2\.survey\fix\T1-5.md §二 |
| D-G23 | ΠΑΝ 修复潮 F1-9 移交（残留） | ioMutex 取消端口生产接线：serialize(fn, timeoutMs?, cancel?) 可选第三参已就位（超时即调用一次挂中止底层调用，缺席/炸裂防御吞掉），但生产侧 system.ts 键鼠包装层未接线——无端口部署下挂死调用会阻塞后续 IO 直到真实终局（「上报超时≠放行队列」串行公理的代价，cancel 端口是恢复通路）；工具层「排队超时 vs 执行超时」文案区分同批可选——**Τ1-5 代码闭环（2026-10-05）**：门面六函数增可选尾参 signal 并铸进 adapter args（缺席 ⇒ JSON 丢键请求字节等同现状）；system.ts 五处 D-5 路径挂 AbortController 端口（serialize 第三参 () => io.abort() + 五处 signal 抵达 backend 调用面——ioMutex 超时即 abort 底层 HTTP 断流 ⇒ run 尽快真 settle ⇒ 队列前滚恢复通路通电；abort 后迟来终局由 ioMutex 吞错镜像吸收）；文案半面经 ΠΑΝ-33 已陈明在案无需再动；legacy（nut-js 无 abort API）与 pressHotkey（serialize 嵌套死锁豁免）无端口为如实申报的既定语义 | 已闭环（D-5 路径恢复通路通电；legacy 面既定语义申报） | src/physicalBackend.ts（六函数 signal 透传）；src/system.ts（五处 AbortController 端口）；test/tel5.fixes.test.ts（D-G23 源码锁：15 needle 逐点断言）+ p1-fixes 25/25 复跑；C:\2\.survey\fix\T1-5.md §三 |
| D-G24 | ΠΑΝ 修复潮 F1-2/F2-1 移交（validate 侧残留） | actionGate.ts 两处 approval.validate(approval_token) 未携 targetHint——绑定令牌在闸门处 fail-closed 拒绝（安全方向），完整兑现需在闸门补 hint（clickMouse/dragMouse/pressHotkey 的验收消费点已携坐标级 hint，ΠΑΝ-36b）；pressHotkey 的 context_description 映射进 target_description 的口径与铸造面对齐同批——**已被 ΠΑΝ-114 闭环（F3-10 §一），Τ1-5 验证取证（2026-10-05）**：targetHintOf(kind, args, descOverride?) 纯函数在场（click/drag 兑换面同标准；hotkey 臂经 descOverride 把 context_description 映射进 target_description 槽——「口径对齐」半面即此）；judgePointerFace（actionGate.ts:319）与 judgeHotkeyFace（:432）两处 validate 均携 hint；铸造面（Τ1-3 request_approval target 形状）与闸门/兑换 hint 同一摘要管道；pan114-119 21/21 + pan3437 10/10 复跑取证（含「无裸调用残留」源级金丝雀） | 已闭环（ΠΑΝ-114 闭 + 双册复跑取证；actionGate 零改动） | src/tools/actionGate.ts:187（targetHintOf）/:319/:432（双 validate 携 hint）；test/pan114-119.fix.test.ts ΠΑΝ-114a/b/c/e；test/pan3437.fix.test.ts 36⑧；C:\2\.survey\fix\F3-10.md §一、T1-5.md §四 |
| D-G25 | ΠΑΝ 修复潮 F2-8/F2-9 移交（遗留） | 联邦数值面残余三件：① config.federationEpsilon 的 Schema 范围约束未接 digest.validFederationEpsilon（对接点已导出，sync 入口已按它执法——config 缺省路径受保护，Schema 面接线属 config 产权）；② 隐私预算跨进程不续账（模块级 Map——同进程内无界 k·ε 已闭，跨进程续账可随 trust store 同律落盘）；③ C2-1 F7 检疫票地板 × ε 噪声乘性误伤校准（aggregate.ts，<4 诚实源时 2×IQR 自适应阈会被毒值拉爆——测试已注明 ≥4 源可用域）；swarm 跨实例场景聚合随私有盐失效为已申报代价（共享盐是部署选项）——**ΤΕΛΟΣ 终局改判（2026-10-05）**：① **已闭环（Τ1-8b）**——config.ts:583 bNum(0.001, PRIVACY_BUDGET_EPSILON_TOTAL).default(1) 域上界单源导入 federation/digest（两处立法漂移根除；Τ1-5 取证 configDocs + epochMu.federation 18/18）；③ **已闭环（Τ1-5）**——离散臂换 2×MAD（robustDispersionOf：IQR 等价换算保 ≥4 源回归锚、MAD 崩溃面置换使 k=3 组毒源计票诚实零票——吞没域闭合，pan6975 新增子例执法）；② **定谳**：跨进程续账是部署侧增强项非代码债——digest.ts:256 在案「持久化选型（工单明示二择一）：模块级（进程生命周期）」为工单明示决策；残余暴露 = 进程重启重置预算（每进程 Σε ≤ 10 有界）；跨进程续账涉持久介质选型/防篡改信封/组合根通电三决策面（T1-5 §五论证）——**定谳论证原引 T1-5；工单指定引用的 T2-10 报告收稿时点缺席（T2 波在途），若其补交且论证相左可翻案** | 已定谳（①③ 已闭；② 部署侧增强项定谳留档——跨进程续账随部署决策另立工单） | src/config.ts:583/:332/:12（① 单源对接）；src/federation/aggregate.ts + src/skillFederation.ts（③ robustDispersionOf）；src/federation/digest.ts:256（② 二择一决策在案）；test/tel5.fixes.test.ts（D-G25③ 4 例）+ pan6975 8/8 + configDocs/epochMu.federation 18/18；C:\2\.survey\fix\T1-5.md §五、T1-8.md §二 |
| D-G26 | ΠΑΝ 修复潮 F2-7 移交（对接点 3） | python releaseShm 服务端自校验：adapter.releaseShm 按路径发 DELETE 让服务端删 mmap 暂存文件——Node 侧白名单根防线已闭（ΠΑΝ-66），服务端须自校验 name 落自家 mmap_dir（python_service 产权半边）；symlink 逃逸不在 Node 侧防御域（需 realpath + 服务端配合）同批申报——**Τ1-5 代码闭环（2026-10-05）**：shm.py 新增 _path_within 纯函数（两侧 realpath 解析——symlink 换靶 ⇒ 解析后出界 ⇒ 拒删，分隔符边界严格防前缀伪命中，任何解析失败 ⇒ False fail-closed）+ write_image 注册条目自记 mmap_root（服务端自记非客户端可影响）+ _release_handle 三条释放路径（DELETE/TTL GC/cleanup_all）单点收口（拒删 ⇒ unlinked=False ⇒ 磁盘账面不扣——ΑΩ-R26 同律）；「symlink 逃逸不在 Node 侧防御域」半面随 realpath 守卫在服务端闭合（Node 侧另见 Τ1-7 shmReader realpath 再验纵深） | 已闭环（服务端自校验纵深 + symlink 逃逸两半闭合） | python_service/dsh_physical/shm.py（_path_within/mmap_root/_release_handle）；python_service/tests/test_shm.py（新增 4 例，10 过 1 平台 skip）；C:\2\.survey\fix\T1-5.md §六 |
| D-G27 | ΠΑΝ 修复潮 F2-2 移交 + ΠΑΝ-38 册失修现状 | wiring census 剩余面：① 豁免册 6 条 unwired-organ 中 setAccessibilityProvider / armSkillFederationPersistence / enforceMinedProperties / configureFailureMemory 四条仍待接线（clearBlockers/mergeSimilarTypes 语义上已由姊妹 API 接线——ΠΑΝ-59 clearConstructionBlockers / ΠΑΝ-47 maintainCapacity，导出面按直接引用口径仍 orphan 故册条目保留）；② dead-code 34 条的删除决策（全库零引用含测试与工具链）；③ **册失修现状红（本册实跑）**：ΠΑΝ-38 之后工席新增 src/hmacKeyFile.ts 的 HMAC_KEY_FILE_BYTES 与 src/vlm/providers/cast.ts 的 castProvider 两孤儿未接线未登记豁免册 ⇒ wiring:census 与 w0wiring.census「现状g」双红（执法器按设计工作——新孤儿必须接线或登记，本条即其登记义务的台账化）——**ΤΕΛΟΣ 终验闭环（2026-10-05）**：① Τ1-1 五条真实通电 + 一条改判 internal-surface（unwired-organ 类别清零；Τ1-6 验收 census 实跑条目 6→0、未登记 0，tel1.wiring 11/0）；② Τ1-2 删除决策落地（10 条真死码清删净减约 60 行 + 24 条改判保留——census+独立 grep 双保险，定向 138/138 + smoke_imports 298 模块净）；③ 册失修红经 ΠΑΝ-130/F4 收口曾清零，Τ1-12 收稿实测未登记 0 / 非法 0（1552 值导出、605/605 在册）——ΤΕΛΟΣ 波自身删除/接线新产生的幽灵 11 条（T1-2 删除 10 + Τ1-8b 接线 PRIVACY_BUDGET_EPSILON_TOTAL 1）为**新**册同步残留（T2 波收割职权），拆条 D-G39 在册 | 已闭环（①②③ 三面收口；新产生的册同步残留另立 D-G39） | scripts/wiring_census.mjs（--check 本册实跑 exit 1：未登记 2/幽灵 0）；scripts/wiring-census.exemptions.json（unwired-organ 6 条在册）；test/w0wiring.census.test.ts（11 测 1 fail 本册实跑）；C:\2\.survey\fix\F2-2.md §七；F4-6 终验实测（2026-10-04，活树多次采样）：首验（22:26 前）--check exit 1、未登记孤儿 2→16（原在案 2 中 castProvider 已不在列=已接线、hmacKeyFile HMAC_KEY_FILE_BYTES 仍在；新增 14：crossMachine.ts barrier-MAC 面 6 导出、organCensus.ts diff/drift 2、sleep/index.ts 上限常量 2、subAgent.arbitration.ts 校准 2、processScore.ts SCORE_TOOL_SETS、resultContract.ts escapeContractPrefix、visualDiff.ts estimateGlobalDisplacement）；22:29 时点 --check exit 0——ΠΑΝ-130 于验收窗口内完成豁免册收口（未登记 0/幽灵 0/非法 0，617 孤儿全在册），③册失修积压红清除；22:32 验收正式收口时复跑 --check exit 1、未登记 2（actionVerifier.ts 的 judgeRemoteChange 与 REMOTE_EVIDENCE_OVERLAP_MIN——ΠΑΝ-127 破环在途新导出、册追认时滞，登记义务仍在）——①②（unwired-organ 待接线面 + dead-code 决策）亦仍在案；F4 终验收口实跑（2026-10-04，全部施工停止后）：npm run wiring:census 退出码 0——未登记 0/幽灵 0/非法 0，624 孤儿全在册（ΠΑΝ-127 破环新导出已随迁登记），③册失修红清除 |
| D-G28 | ΠΑΝ 修复潮 F1-7/F3-1 移交（对接点） | python 治理残余三件：① routes.py 三处陈旧注释/字段（/v1/stats 与 /v1/shutdown docstring 仍述「不在 ENDPOINT_CAPABILITY」已失效；/health 的 auth.pid_attestation 仍按 sys.platform=='linux' 布尔申报，Windows 武装态应接 auth.attestation_mode()；drain 段注释 logging 半句过时——功能性均不受影响）；② dpi.pixel_domain_report 的 /health 接线（诊断面已导出，需动 routes/server）；③ capToken.ts ensureKey 建议写后回读复核对齐 Python 侧防御（可选——Node 侧 writeFile wx 为缓冲写理论不受漂移影响）——**ΤΕΛΟΣ 清偿（2026-10-05）**：① 顺带闭环取证（routes.py:495-500 pid_attestation 已改 enable_pid_attestation and attest_pid_supported() + additive attestation_mode；:1152-1154 drain 注释已更正；:1160-1163 shutdown 鉴权注释已更新——ΠΑΝ-128/ΝΩ-27/ΠΑΝ-25 产物，Τ1-6 逐处核验）；② **Τ1-6 修复**：routes.py 新增 _pixel_domain_face()（30s TTL 缓存 + 任何异常 ⇒ {absent, reason} 诚实申报——health 绝不抛铁律 + additive pixel_domain 键），执法册 test_dpi_health.py 4/0；③ 顺带闭环取证（ΠΑΝ-129：O_EXCL 'wx' + EEXIST 竞态重读 + timingSecureEqual 逐字节比对 + unlink 诚实重写，capToken.ts:31-36/:57-90）；T2-5 终验 /health 冒烟 pixel_domain 在场（诚实 achieved:false + 六端点映射） | 已闭环（①③ 顺带闭环取证 + ② 修复执法在案） | python_service/dsh_physical/routes.py（三处更正 + _pixel_domain_face）；src/physicalExecution/capToken.ts:31-36/:57-90；python_service/tests/test_dpi_health.py（4/0）+ pytest 全量 345 过 2 skip（T2-5 复跑 348 过 3 skip）；C:\2\.survey\fix\T1-6.md §二、T2-5.md §四 |
| D-G29 | ΠΑΝ 修复潮 F3-3 移交（ΠΑΝ-88 客户端面） | federation-server v2 推荐协议的客户端面：服务端已支持 x-dsh-fed-nonce + ±30s + 重放拒绝（v1 客户端零变化可用、向后兼容执法面在测试层证明），但 src/federation/index.ts 的 federationAuthHeaders 尚无 nonce 变体、README-federation.md 的 nonce 示例未更新（均他人领地未动）——部署方采用 v2 前须补客户端半边——**Τ1-6 代码闭环（2026-10-05）**：federationAuthHeaders(body, token, nowMs, nonce?) 可选第四参（nonce 在场 ⇒ 三头 + 签名输入升格 ts.nonce.body 与服务端 v2 canonical 逐字节同构；缺席/域外 ⇒ v1 既有面逐字节——「v1 客户端零变化可用」兼容承诺保持）+ FederationSyncOptions.authNonce（true ⇒ 每次上行铸 randomUUID 一次性 nonce；铸造失败诚实降级 v1 绝不阻断同步）+ README-federation.md v2 头说明与 curl/crossMachine 示例升 v2；nonce 铸造面模块私有（census 零新孤儿）；w9deploy 13/0 + epochMu.federation/epochMu2.aggregate/p1-fixes 48/0 复跑 | 已闭环（客户端半边齐备——部署方采用 v2 只需 authNonce 开关或第四参） | src/federation/sync.ts（federationAuthHeaders 第四参 + authNonce 实接）；scripts/README-federation.md（v2 文档）；test/t1-6.fixes.test.ts（D-G29①-④）+ test/w9deploy.test.ts（13/0）；C:\2\.survey\fix\T1-6.md §三 |
| D-G30 | ΠΑΝ 修复潮 F1-3 移交（协调点） | config.ts 的 hotkeyBlacklist schema 缺省串未补 ctrl+shift+esc,alt+space 两键——system.hotkeyPolicy 的装载期补全 withPan10DefaultAdditions（:37/:56）已幂等兜底（字面比对只增不减，两条初始路径收敛同一生效缺省防镜像漂移），schema 补齐后补全函数自动变 no-op 无需回改；部署显式配置（含显式空串=明示不设防）逐字节生效不被越权——**ΤΕΛΟΣ 清偿（2026-10-05）**：**Τ1-8c 落地**（config.ts hotkeyBlacklist default 补 ctrl+shift+esc,alt+space，字面与 canonical/FALLBACK 完全一致 ⇒ 装载期补全对缺省路径自动 no-op，两初始路径收敛同一生效缺省；执法测试 getHotkeyBlacklistCsv() === schema 缺省逐字节锁定 + p1-fixes ΠΑΝ-10 幂等复跑绿）+ **Τ1-6 验收锁定**（t1-6 册 D-G30 节：schema 缺省两键在列 + 补全函数在册；docs/config-schema.md:106 再生一致 155 字段） | 已闭环（Τ1-8c 落地 + Τ1-6 验收锁定） | src/config.ts（缺省串 + Τ1-8c 注释）；docs/config-schema.md:106；test/t1-6.fixes.test.ts（D-G30 取证锁定）+ test/p1-fixes.test.ts ΠΑΝ-10 节；C:\2\.survey\fix\T1-6.md §五、T1-8.md §三 |
| D-G31 | ΠΑΝ 修复潮 F1-8 移交（已知无归零缝残留）→ **ΤΕΛ-10 闭环** | 卸载清单残余归零缝三处（修复需动各模块文件，超出当时工单独占范围）：prophecyWorldModel（prophecy/index.ts 模块级单例无 reset 面）、tools/autonomousRun 的 EXP4 单例、autonomy explorationLedger 共享实例（ΠΑΝ-60 已改 per-pilot 域 Map 并有 releaseExplorationLedger 清账点，但未入 UNLOAD_CHECKLIST 登记制）——对照 UNLOAD_CHECKLIST 48 键立法面（ΠΑΝ-28b）补齐即闭——**ΤΕΛ-10（T2-1）原子落地（2026-10-05）**：T1-6 移交方案 (a)(b)(c) 逐支兑现——① prophecy/index.ts const→let 重铸面 resetProphecyWorldModel()（ES 活绑定亲验安全，零持久化单源语义：重铸零数据损失）；② autonomousRun.ts resetAutonomousRunEvolution()（= evolution.reset()；apply 内动态具名导入绕 Λ-4 装载器地雷，census 识别 dynNamed=wired）；③ autonomy/index.ts releaseAllExplorationLedgers()（pilot 域全清、共享域 \0 前缀键不清——ΠΑΝ-60 语义）+ UNLOAD_CHECKLIST 追加 'prophecy.worldModel'/'autonomousRun.evolution.reset'/'explorationLedger.release' 三键（52 键，dreamCostLedger.reset 之后、windowDelegate.unset 之前序法）+ 清单头注「已知无归零缝残留」改判收口；w0unload 金名单 +3 键 + 新三例（源级金丝雀/prophecy 重铸行为/两域释放），**清单≡执行律两向绿（10/10）**；census 三新导出全 wired（943=940+3，模块面+登记同窗原子落地兑现） | 已闭环（ΤΕΛ-10：三单例归零缝全入册 + 执法册三例） | src/prophecy/index.ts（resetProphecyWorldModel）；src/tools/autonomousRun.ts（resetAutonomousRunEvolution）；src/autonomy/index.ts（releaseAllExplorationLedgers）；src/index.ts（UNLOAD_CHECKLIST 52 键 + 三 disposer）；test/w0unload.test.ts（10/10 含新三例；合计 232 用例 0 失败 + census exit 0 + value 环 0）；C:\2\.survey\fix\T2-1.md |
| D-G32 | ΠΑΝ 修复潮 F1-2 移交（C1-5 H1 余量） | notary 判据残余两件（批判 M 级未入工单）：① notaryHandshake 松判据（C1-5 M2——语义握手的匹配判据过松的边界收口）；② 公证证据新鲜度（C1-5 M3——OCR 实读/白盒取证的时效性约束）；另 C1-9 H2 的 disk/aux 漂移与 genTime 前拨保持注记级为 ΠΑΝ-53 工单明示的设计取舍（判据面已隔离，未来翻红只动对应分支）非债——**Τ1-6 代码闭环（2026-10-05）**：**M2** 词元双向判据收紧为双向覆盖（实读侧 ≥1 实义词元在描述全文 ∧ 描述侧多数词元 ≥⌈n/2⌉ 在实读全文可见（≥3 词元起适用）——撒单词穿透形旧律过新律拒；≤2 词元短描述与 CJK 单词元维持旧律零回归；单词元邻域引用的诚实边界留档由 M3 时效层承接）；**M3** notaryEvidenceStale(capturedAtMs, nowMs) 纯函数 + NOTARY_EVIDENCE_MAX_AGE_MS=10_000 + clickMouse freshnessStage 派发前时效执法（超阈 fail-closed 拒派 reason='notary-evidence-stale'、令牌未烧、重试即重新取证；非令牌/证据缺席/dryRun 零行为）；clickElement/dragMouse 同族管线较短未纳入本批——留档 D-G37 | 已闭环（M2 判据收口 + M3 时效闸落地；同族对齐面留 D-G37） | src/tools/actionGate.ts（notaryHandshake 双向覆盖 + notaryEvidenceStale 新导出 wired）；src/tools/clickMouse.ts（notaryEvidenceAt 记时刻 + freshnessStage 执法）；test/t1-6.fixes.test.ts（M2①-④ + M3①-②）+ epochR.notarization/pan1213.gate 26/0 等六面回归；C:\2\.survey\fix\T1-6.md §六 |
| D-G33 | ΤΕΛ-12 拆条新立 2026-10-05（自 D-G16，C2-3 M3） | verdictCache 判决缓存挤出遗忘立法：engine.ts:58/:195-198/:617 在案——256 FIFO 驱逐后 `latest===undefined` 即放行（被挤出缓存的目标再次派发走免检通道）；需独立立法设计（否决钉住策略：危险面否决记录的钉住/豁免边界），债文自身已「留后续波次」。Τ1-4 亲验现状仍在（三处行号核验）——**ΤΕΛ-13 施工亲验（Τ1-12，2026-10-05 收稿时点）**：engine.ts 已现 ΤΕΛ-13 标记的否决钉面实现（:59 钉面容量立法、:136 subject→最新 rejected 判决、:207/:220 rejected 判决钉入钉面·主缓存驱逐不再等于否决失忆、:230 veto-pin-evicted 审计链段，log.ts:54 配套告警段）且 tsc exit 0（T2-4 所见瞬态词表红已自愈）——**但工位报告与执法测试册均未交付**（test/ 零 ΤΕΛ-13 标记），待其收稿验收后翻案 | 后续窗口处理（ΤΕΛ-13 施工在场，报告/执法册未交付） | src/sandbox/engine.ts:59/:136/:207/:220/:230；src/sandbox/log.ts:54；C:\2\.survey\fix\T1-4.md §D-G16 M3 段、T2-4.md §三.1 |
| D-G34 | ΤΕΛ-12 拆条新立 2026-10-05（自 D-G16，C2-3 M7） | 记忆库遗忘淘汰立法：memory.ts 全文无 delete/decay/上限（Τ1-4 亲验零命中）——长期运行无界增长；需独立立法设计（遗忘淘汰策略/容量执法——参照 worldModel maintainCapacity 先例），债文自身已「留后续波次」——**ΤΕΛ-13 施工亲验（Τ1-12，2026-10-05 收稿时点）**：sandbox/memory.ts 已现 ΤΕΛ-13 标记的肌肉记忆库清除面（:99 遗忘淘汰立法段、:138 逐出台账 EVICTION_LEDGER_MAX 有界审计面、:148 台账随账本归零）+ MUSCLE_MEMORY_MAX_ENTRIES/MUSCLE_STALE_AFTER_MS/MUSCLE_HOST_COLLAPSE_MIN_TRIALS/MUSCLE_HOST_COLLAPSE_RELIABILITY 四常量（已由 ΤΕΛ-11 应急登记 internal-surface，注「收稿后按实况复核」）；tsc exit 0——**但工位报告与执法测试册均未交付**，待其收稿验收后翻案 | 后续窗口处理（ΤΕΛ-13 施工在场，报告/执法册未交付） | src/sandbox/memory.ts:99/:138/:148；scripts/wiring-census.exemptions.json（MUSCLE_* 四条应急登记）；C:\2\.survey\fix\T1-4.md §D-G16 M7 段、T2-2.md §一.③ |
| D-G35 | ΤΕΛ-12 拆条新立 2026-10-05（自 D-G16，C2-3 M8） | 宏排练 acceptsText 缺席误拒立法：virtualScreen.ts:186 仍把 acceptsText 缺席铸成反证（元素未声明文本能力 ⇒ 排练按不支持文本处理并计入反证）——需排练弃权语义立法（缺席 ⇒ 该步跳过不计分，而非反证），债文自身已「留后续波次」——**ΤΕΛ-13 施工亲验（Τ1-12，2026-10-05 收稿时点）**：macroRehearsal.ts:167 已现 ΤΕΛ-13 标记的三态保全（acceptsText/scrollable 缺席保持弃权语义——非反证）——**但工位报告与执法测试册均未交付**，待其收稿验收后翻案 | 后续窗口处理（ΤΕΛ-13 施工在场，报告/执法册未交付） | src/sandbox/macroRehearsal.ts:167；src/sandbox/virtualScreen.ts:186；C:\2\.survey\fix\T1-4.md §D-G16 M8 段 |
| D-G36 | Τ1-3 移交申报 → ΤΕΛ-12 拆条新立 2026-10-05 | canaryLogic 让位探针未携 targetHint：guards/canaryLogic.ts 的 approval.validate(token) 为在场性探测（已授予有效令牌在场 ⇒ 金丝雀不重复打扰），非兑现点不烧令牌——绑定令牌下 validate 无 hint 返回 false ⇒ 金丝雀多跑一次试演（安全方向冗余，非绕过：实际派发闸门 actionGate 仍强制比对）；精确成立需 guards 领地补 targetHintOf 同款透传（一行级） | 后续窗口处理 | src/guards/canaryLogic.ts（让位探针 validate）；C:\2\.survey\fix\T1-3.md §二/§六.1 |
| D-G37 | Τ1-6 留档 → ΤΕΛ-12 拆条新立 2026-10-05 | notary 证据新鲜度时效闸对齐 clickElement/dragMouse 同族管线：Τ1-6 的 notaryEvidenceStale 10s 时效执法只纳入 clickMouse（dangerous+token+非 dryRun 面）——clickElement/dragMouse 管线较短未纳入本批，如实留档为后续窗口对齐面（非 D-G32 验收门） | 后续窗口处理 | src/tools/clickMouse.ts（freshnessStage 先例）；src/tools/clickElement.ts、src/tools/dragMouse.ts（待对齐面）；C:\2\.survey\fix\T1-6.md §六 M3 段 |
| D-G38 | Τ1-7 留档 → ΤΕΛ-12 拆条新立 2026-10-05 | mmap realpath→open TOCTOU 残窗：Τ1-7b 已把 open 目标改为校验后物理路径（窗收窄），但窗内换链不随之——完全闭合需 O_NOFOLLOW 逐段开 dirfd（超当时「一处收口」职权未做）；ENOENT 放行为设计取舍（保「对象已释放」element_not_found 诚实归因契约） | 后续窗口处理 | src/physicalExecution/shmReader.ts（resolveMmapFilePath realpath 再验）；C:\2\.survey\fix\T1-7.md §五.5 |
| D-G39 | Τ1-2 §三/T1-4/T1-6 移交 → ΤΕΛ-12 新立 2026-10-05 → **ΤΕΛ-11 终局收割闭环** | wiring census 豁免册幽灵 11 条同步（ΤΕΛΟΣ 波自身产物）：T1-2 dead-code 删除 10 条成幽灵（_resetSharpCache_forTest/_resetTesseractCache_forTest/verifyEffect/remintScore/FEDERATION_AUTH_SKEW_MS/incrementalDeliveryEnabled/unwrap/_reset_forTests/getPopupSprt/mmrDeterministic）+ Τ1-8b 接线 PRIVACY_BUDGET_EPSILON_TOTAL 1 条（test-only 条目转 wired）——册收割为 T2 波工位职权（T1-2 §三清单）——**ΤΕΛ-11（T2-2）终局收割（2026-10-05 04:15-04:2x）**：① 幽灵删条 11（并行波次 04:15 落地、ΤΕΛ-11 逐条对账零残留）；② dead-code 类别清零——24 条按 T1-2 §二复核改判重铸（生产/文件内消费 16 条 internal-surface（census 词法盲区致 wired 误判——见 D-G40）+ 测试宇宙 3 条 test-only + cordis 壳契约 5 条 unwired-organ）；③ 应急补登记 4 条（MUSCLE_* 四常量——ΤΕΛ-13 M7 在途新增，internal-surface + 收稿后复核注记）；**终态 census exit 0：未登记 0 / 幽灵 0 / 非法 0，609/609 在册（册 605→609）**；w0wiring.census 11/11 绿——Τ1-12 复跑取证同判（census exit 0 + w0wiring/kernel.generations/w4wire 27/27）；T2-4 04:20 瞬态红（4 条 vlm 未登记）为豁免册编辑在途窗口、04:2x 后消散。附注：本行曾被并行波次写入含控制字节的 TELOS-REPORT.md 引用（文件不存在），Τ1-12 清除该损坏引用、以在案报告路径为准 | 已闭环（ΤΕΛ-11 收割 + 册面终态 609/609；census 词法盲区留案 D-G40） | scripts/wiring-census.exemptions.json（终态 609 条：unwired-organ 5/test-only 421/internal-surface 166/reserved-api 17/dead-code 0）；scripts/wiring_census.mjs --check（T2-2 与 Τ1-12 复跑双 exit 0）；test/w0wiring.census.test.ts（11/11 绿）；C:/2/.survey/fix/T2-2.md §一/§四、T2-4.md §一.#4、T2-3.md §二.#4 |
| D-G40 | ΤΕΛ-11（T2-2）§二发现 → ΤΕΛ-12 新立 2026-10-05 | wiring_census.mjs countRefs 引用判定的两处词法盲区（spread/三元消费位误判 orphan）：① 绑定引用正则对 spread 消费位「...NAME」误排除（名字前置 . 撞本为排除 .member 成员访问的环视）；② 对三元值位「? NAME :」误排除（名字后随 " :" 撞本为排除对象属性键位的环视）——DOCTOR_RULES_*/imageBlockFromValue/CONFUSABLES_ASCII/prophecyStats/VIRTUAL_POPUP_Z/processScore 六常量/SKILL_HASH_GRID 等生产在用符号全线被误判 orphan（实为 wired）；ΤΕΛ-11 已按 mergeSimilarTypes 同律改判 internal-surface 兜底（理由注明消费点），修 countRefs 两处环视后这 16 条应随幽灵律自动出册 | 后续窗口处理 | scripts/wiring_census.mjs（countRefs 正则两处环视待修）；scripts/wiring-census.exemptions.json（16 条 internal-surface 兜底在册）；C:/2/.survey/fix/T2-2.md §二 |

<!-- ══ ἈΓΩΝ 实战纪元债（R6-3 项目史官 2026-10-05 入账 42 条；ASCII 转写 D-G41..D-G82
     ——genesis_audit D-[A-G]\d+ 枚举兼容；草案号 D-ΑΓ-N 见来源列（R2-9 §4.3 落位决策：
     G 分区末尾追加）。候选区定谳：D-ΑΓ-27..36 转正、D-ΑΓ-37 条件立案销案（T8 修复后
     重评 PASS 条件未触发）；R5 波移交新立 D-ΑΓ-38..43。三件套底稿
     C:\2\.survey\practice\DEBTS-DAG-entries-draft.md ══ -->
<!-- ══ ΑΝΒ-8 定谳补正（项目史官 2026-10-05，工单 ANAB-8）：D7+D10 批3 既成事实回溯定谳——
     D7 三条件全消解（①T11 第 6 跑/T12 链根任务 PASS 残局自解；②R6-1 增量持久化落地
     D-G77 销案；③R5-8/R6-6 终验覆盖）。D10 销案 6（D-ΑΓ-30/31/32/33/35 批3 复证 +
     D-ΑΓ-37 以 T20/T21 编辑链 PASS 销案、治本面=D-G80/ΑΝΒ-2 在途）；转正 5+1
     （27 后半=D-G67/28 后半=D-G68→后续窗口处理、29=D-G69 维持、34 后半=D-G83 新立
     需部署决策、36=D-G76 维持、37 治本面=D-G80→本纪元ΑΝΒ处理）。六决策同步：
     D2/D3/D8/D9 落 D-G80/D-E3/D-G66，D5/D6 新立 D-G84/D-G85。报告
     C:\2\.survey\practice\ANAB-8.md ══ -->

| D-G41 | ἈΓΩΝ·D-ΑΓ-1（R1-8 遗留①→R2-2 修复→批1/批2 复核） | 热键白名单无 s/o（ctrl+s 保存链被协议层 schema 枚举拒绝——字母仅 a/c/v/z，滞后于 python 物理层全字母表立法） | 已闭环（R2-2 收割，批1/批2 实战复核） | src/tools/pressHotkey.ts+src/system.ts fallbackMap 双向镜像（`// R2-2:` 标注）；新册 6/6+局部 56/56、黑名单零弱化四层一致回归；批1 ctrl+end/z/s 三和弦全放行、ctrl+s 保存链完整达成（R3-1 §3）；批2 保存链复证+R5 重评 T8 终判含 ctrl 组合链 |
| D-G42 | ἈΓΩΝ·D-ΑΓ-2（R1-8 遗留④→R2-3 双层→R3-1 三层） | 宿主 UI 回合结束自抬抢焦（最危险形态：type_text 落宿主聊天输入框=自我注入下一回合 prompt；宿主二进制不可改） | 实战在册（ἈΓΩΝ 处理中——三层防线在役，根治需人工） | R2-3 驱动 9s 压制（只压宿主窗）+type_text 前置焦点闸（python `/active_window` 端点；20+7 测试）；R3-1 第三层打字防串窗污染扫描（r31.typingPollution 7/7→R5-1 补登后 13/13）；役累计 133 拍：压回 3、污染 0、误报 0（R5 重评波新增拍数未单独汇总——receipts focusGuard 块在盘可取）；托盘/后台模式待人工排查 |
| D-G43 | ἈΓΩΝ·D-ΑΓ-3（R1-1→R3-5 缓解） | desktop controller 无会话删除方法（会话只增不减） | 实战在册（ἈΓΩΝ 处理中——hygiene 归档在役，根治宿主侧需人工） | ops/sessions-hygiene.mjs（归档搬移不直删、results 证据包铁律豁免）；批2 末 27-28 会话（~127 事件/任务稳定，R4-7 §三）；R5-1 批前 --keep 20 执行（28→20，归档 8/0.5MB）——R5-7 SOP v2 在册 |
| D-G44 | ἈΓΩΝ·D-ΑΓ-4（R1-8 遗留②→R2-5 修复→批1 复核） | 沙箱受限 token 下 Start-Process GUI 秒死（双机制死局：libuv kill-on-close 作业连坐 × Shell/UWP 激活代理断裂） | 已闭环（R2-5 收割，批1/批2 实战复核） | src/environmentShaper.ts launch_app 白名单直启（detached+shell:false 裸 CreateProcess；r25.launchApp 20 断言、真机 5s 存活）；批1 T2 第一步直启记事本→保存链全程（R3-1 §3）；批2 T3 同通道复证；R5-3 话术清剿后全电池走 launch_app 教学 |
| D-G45 | ἈΓΩΝ·D-ΑΓ-5（R1-8 §5.3.5） | 记事本多标签会话恢复（误存盘/误清空风险） | 实战在册（ἈΓΩΝ 处理中——缓解三层：全新实例纪律+复位器按标题精杀+话术适配；根因面升格见 D-G68） | R2-7 复位器标题特征双门槛；R3-1 话术适配 10 处/6 任务；R3-7 ctrl+w 单标签纪律；批2 实录脏标签跨日存活（R4-1 §3）→R5-1 L2 定谳根因=Win11 TabState 延迟恢复（预置协议 v2 处置） |
| D-G46 | ἈΓΩΝ·D-ΑΓ-6（R2-1 §6.1→R3-2 修复） | fallback per-brain 模型配置面缺失（glm 备脑经 registry 缺省解析 glm-5.3-flash 本账户 429） | 已闭环（R3-2 收割；余面观测缺口另立 D-G61） | vlmFallbackProviders CSV 扩 `id=model` 方言（池+合议庭同解析）+max_tokens 模型键控硬顶三面单一执法；r32.failoverFallback 9/9+回归 286/286；宿主重启后池 [qwen,glm] 双 configured 双 closed |
| D-G47 | ἈΓΩΝ·D-ΑΓ-7（R2-8 GAP-1→R3-3 修复） | vlm.maxPerMinute/maxPerHour 未注册 kernelRegistry（本地限流闸配置层开不了） | 已闭环（R3-3 收割） | 双键幂等注册（[0,600]/[0,36000] 越界夹取）+rewireVlmRateGate() 单一铸造点+restores 腿重焊；r33.gaps GAP-1a/1b：set 1 ⇒ 第二次 chatJson rate limited 前置拒绝零 fetch |
| D-G48 | ἈΓΩΝ·D-ΑΓ-8（R2-8 GAP-2→R3-3 修复） | VlmBudget 无参构造（200 图/512MB 不可调） | 已闭环（R3-3 收割） | codec.maxImagesPerTask/maxBytesPerTask 入册（册容 58→60）+resolveVlmBudget()；set 2 ⇒ 第 3 图被闸拒；缺省逐字节不变 |
| D-G49 | ἈΓΩΝ·D-ΑΓ-9（R2-8 GAP-4→R3-3 修复） | 宿主无会话级轮/token 预算 | 已闭环（批1 在役实证；批2 终局 receipts 收官取数——R6-3 实读：11 任务 turnCap={limit:60} 全在役、exceeded 全 false 零触发） | --max-turns-per-session 60+waitDoneDesktop 每 tick 拉轮号+stoppedBy:'turn-cap' 分口径；r33.maxturns 3/3+51 轮事件流端到端；T8 终判轮 stoppedBy=timeout（waitedMs 481s=10min 任务钳制——时间护栏另一臂执法） |
| D-G50 | ἈΓΩΝ·D-ΑΓ-10（AG-R8 实证→R3-4 修复） | 作弊检测缺口（旁路造假/假 PASS 主动检测面缺席） | 已闭环（检测面；会话级工具禁用接线转 D-G66） | bench/anti-cheat.mjs（工具面七分类/意图六类/任务路径触碰=实锤/三态+purePassRate 聚合分离）94/94 自检+26 prompt 纪律前缀；R1-8 回溯 4/8 pure、实锤 0；全役终判 pure-pass=10/tainted=0/cheated=0（C:\2\tmp\r51-anticheat.md） |
| D-G51 | ἈΓΩΝ·D-ΑΓ-11（R2-8 GAP-3→R3-3 核实） | vlm.breakerFailures/CooldownMs 未注册（R2-8 陈述） | 已闭环（核实已闭非新修——账实分离如实登记） | R3-3 §6 实测 productionSpecs 已含两键（:475-488）——R2-8 §2.1 陈述与仓库现状不符（误记或已被并行收割）；GAP-3 视为已闭 |
| D-G52 | ἈΓΩΝ·D-ΑΓ-12（R2-8 GAP-5） | 事件流不可回取 VLM token 数 ⇒ 成本只能锚估 | 后续窗口处理 | R3-3 明示不动；批1/批2/重评三窗佐证 kernel/telemetry 快照缺席工单同族（终局分析 P2 在案）；成本口径=qwen 列表价锚估+声明依据（宪法第三律执法在案） |
| D-G53 | ἈΓΩΝ·D-ΑΓ-13（R1-7 家族） | drive trimEvents 裁剪不保 ts ⇒ vlm-meter 延迟面缺席常态 | 后续窗口处理 | 批1 p50/p95=-ms、journal 切片缺席（多窗同族）；计数/成本/降级不受影响；当前唯一延迟信号源=R4-6 GET 探测（163-186ms 平稳） |
| D-G54 | ἈΓΩΝ·D-ΑΓ-14（R1-6 §7.1） | mint 话术误导（带外码零监听者仍称「码在 approval console」） | 后续窗口处理 | 一次性探针方案在 R1-6 §7.1；与 D-B7（fail-closed 安全立法已定谳）互补——本条是话术面非安全面；R5-1 审批止损窗（approval-deadlock 分口径）为运行时面收窄 |
| D-G55 | ἈΓΩΝ·D-ΑΓ-15（早期登记） | popupSprt 全局单例无生产消费方 | 后续窗口处理 | 随会话化低优先；R4-5/R5-8 census 在册不孤儿（豁免册覆盖） |
| D-G56 | ἈΓΩΝ·D-ΑΓ-16（R2-3 刻意取舍） | click 无前置焦点闸（收窄维持：打字污染危害大于点错窗） | 后续窗口处理 | 证据增强：R3-1 冒烟 agent 改点 X 后追逐非目标窗烧 4:20——点击错窗代价实证（仍低于打字污染，刻意收窄维持） |
| D-G57 | ἈΓΩΝ·D-ΑΓ-17（R2-2 余量） | 热键白名单余量：数字键 0-9；shaper Linux 臂 ctrl+0/ctrl+'+' | 后续窗口处理 | 有需求另立工单，与字母同律论证 |
| D-G58 | ἈΓΩΝ·D-ΑΓ-18（R1-2） | 本机化残留（battery 缺省 D:、sync-and-restart.sh、轮前清理） | 后续窗口处理（主风险面已验——半收） | R3-7 #7 补验：suite-full 430 串 D: 残留 0/39 串携 C:；三小项由宪法开批清单 export 律执法，非阻断 |
| D-G59 | ἈΓΩΝ·D-ΑΓ-19（R2-7 §6.1） | explorer 多窗同进程只见一扇标题；标题特征文件名级非路径级 | 后续窗口处理（已知取舍） | R3-7 #9：T11 回退路径依赖任务栏 explorer 图标在场（首回合检查项 5-0② 实战执法） |
| D-G60 | ἈΓΩΝ·D-ΑΓ-20（R3-1 §4.4） | 并行宿主重启互斥约定缺失（共享工作树+共享宿主的并行工位模式下，重启方造成他工位 401 中断） | 实战在册（ἈΓΩΝ 处理中——批2/R5 波两次实战执法成功；成文入宪待收官） | R3-1 两次 401；R4-1 受控重启互斥广播实录；R5-1 两次重启同律（先停 watchdog 防自愈竞态）；宪法附则二可补「重启互斥律」一行 |
| D-G61 | ἈΓΩΝ·D-ΑΓ-21（R3-2 §6.1） | vlm_platforms 观测面不显备脑模型（health() 只有 id/configured/state） | 后续窗口处理（低优先） | R3-2 刻意不扩工具面契约；模型正确性由 r32 传输体断言执法 |
| D-G62 | ἈΓΩΝ·D-ΑΓ-22（批1 冒烟 R3-1 §6.2） | Edge 用户窗与 E2 windowAbsent 环境冲突（QQMail 用户窗须预关，用户重开 ⇒ Edge 族任务 E2 再冲突） | 实战在册（ἈΓΩΝ 处理中——环境前置纪律，无代码修法） | R3-7 §5-0① tasklist 确认 msedge 未跑进批前检查单；批2 执行实录 2 个 msedge 后台进程 taskkill 清零；AG-R2 兑现：全役 agent 零触碰用户窗口 |
| D-G63 | ἈΓΩΝ·D-ΑΓ-23（R3-8 §1.2） | python 懒拉起旋涡（spawn→死→重试 8421..8428 SYN_SENT；间歇性） | 后续窗口处理（观测协议在役） | R-P3 判据立法；R4-7 08:14 旋涡首次完整逐拍记录（<60s 自愈，触发源=批前健康巡检非物理失败，未达 R-P3）；R3-5/R5-7 watchdog python 面巡检在役 |
| D-G64 | ἈΓΩΝ·D-ΑΓ-24（R3-1 冒烟 r2 根因②） | MinimizeAll 与纯视觉 agent 目标可见性互斥（屏幕卫生/恢复动作把 E2 进程级目标藏起来） | 实战在册（ἈΓΩΝ 处理中） | 批1 处置=操作员清残留；结构性修法（恢复序只压宿主窗/恢复后置前目标窗）未落——与 D-G42「跑动期只压宿主窗」同律家族处置 |
| D-G65 | ἈΓΩΝ·D-ΑΓ-25（R3-6 立项→R4-3 落地 b 类） | 回执话术误导五处（b1-b5）+结构纪律三项（c1 pwsh 键鼠硬边界/c2 弹窗守卫僵局熔断/c3 坐标惯性闸门） | 部分闭环（b1-b6 六面已落地——含 v3 未列的 b6；c1-c3 三项未实施；生效性四指标重评已跑但未逐项计量——在案登记不虚填） | R4-3：6 src 文件全加法式+`// R4-3:` 注释+r43.dialectHardening 10/10+build 212 文件；R5-1 重启加载实证（Checkpoint OK）；侧面证据：T8 终判轮 read_text×10 消费+R5-2 noop CAVEAT 补强 b4 面 |
| D-G66 | ἈΓΩΝ·D-ΑΓ-26（R3-4 §3c） | 会话级工具禁用接线未决（宿主 tools.guard()/restrict() 通道实证存在，插件 config benchDiscipline 接线需联席决策） | 已闭环（ΑΝΒ-6/ΑΝΒ-7/D8+D9 落地 2026-10-05：金丝雀判读接线 analyzeCore classifyOutcome 三态[canary-pass=正向证据/canary-violation=警讯/limitation-blocked 分列]+批3 回放 T19 判 canary-pass 与终局吻合；考核模式 src/guards/hostToolPolicy.ts opt-in 接线[benchDiscipline 缺省关零回归，开=宿主工具 fail-closed 白名单 50 件闭集，通道缺席诚实降级]+联席评审框架 ANAB-7-review.md 在案） | 当前执法=提示词纪律+anti-cheat 事后检测（全役纯插件工具、宿主 shell/文件 0 调用——批3 收官抽验 15/15 pure tainted/cheated 双 0，GENESIS ἈΓΩΝ 终局补记）；接线后为事前拦截 |
| D-G67 | ἈΓΩΝ·D-ΑΓ-27（R4-1 §7①·候选转正） | 批间冷复位与链任务的宪法级冲突（附则一 §6「每批 reset --all」摧毁链式 GUI/磁盘终态）——**前半已消解**（R5-1 以 --task 确定性重建+预置协议 v2 缓解在役）；**后半（宪法附则修法+批前 world-shape 重建）批3 实锤升级**：宿主重启清前置窗+播种软谓词未过不阻断 ⇒ 批3 三根因败（triple/drag/autonomous）+7 级联 blocked（R6-2 §6.4 W9 P0——非模型能力问题），retry 后批3 终局 11/14 过 | 后续窗口处理（ANAB-8 定谳 2026-10-05：D10 转正——宪法附则修法与批前 world-shape 重建工单归后续窗口，R6-2 W9 在案） | R4-1 §3 链态恢复实录；R5-1 §1 L2/§3；R6-2 §1/§6.4（W9）；orchestrator-state 终局 26 任务 23/2/1 |
| D-G68 | ἈΓΩΝ·D-ΑΓ-28（R4-1 §7②·候选转正） | 记事本会话恢复是环境级污染源（脏标签跨日存活，reset 签名门槛打不中无 playground 特征标题）——R5-1 定谳根因=Win11 TabState 延迟恢复；预置协议 v2（taskkill 全清+TabState 清除+OCR 实读核验）实战在役；**后半（runbook/复位器 notepad 全清模式成文）仍未落**，批3 final-cleanup 首跑 Edge 残窗+explorer 关闭链撞超时败（retry 二跑过——清场链鲁棒性不足的旁证） | 后续窗口处理（ANAB-8 定谳 2026-10-05：D10 转正——复位器全清模式与 runbook 成文归后续窗口） | R4-1 §3 WM_CLOSE 实录；R5-1 §1 L2（首帧脏缓冲实证）；R6-2 §1（final-cleanup 首跑败/二跑过，orchestrator attempts false,true） |
| D-G69 | ἈΓΩΝ·D-ΑΓ-29（R4-1 §7③·候选转正） | T4 类 expect 谓词语义宽松（工具名 vs 轨迹 JSON 子串）——R5-6 F1 机制级根因定谳：expect 由 prompt 文本回声满足、工具从未被调用（修法=expect 收紧为名字锚定，须先统一两 driver 行格式）；enableOcr+read_text 真挂载后消工具缺席类回声，**消不掉字面量类**：R6-5 §3 敌意审计 10 PASS 任务 17 条 expect 100% 回声暴露、实际改写 1 任务结局（T4 存疑通过，批2 门槛判定对其鲁棒）；名字锚定未在批3 前落地，T19 金丝雀判定实际走 expectedOutcome 元数据面（R5-3 双判读）而非轨迹臂独立性 | 后续窗口处理（ANAB-8 定谳 2026-10-05：D10 转正——W-09/R6-2 W4 修法仍开放） | R4-1 §2 T4 行；R5-6 §4 F1；R6-5 §3（回声洞影响清单终判）；R6-2 §7 W4 |
| D-G70 | ἈΓΩΝ·D-ΑΓ-30（R4-4 §5-A·候选转正） | 批3 双配置开关未开（autonomyEnabled/enableElementIdMode 缺省 false ⇒ autonomous_run/click_element 未挂载） | 已闭环（R5-1 profile 王炸两枚+两次受控重启：41→43 tools、Element-ID UIA provider wired 日志实证；**ANAB-8 批3 复证 2026-10-05 销案**：T22 autonomous_run 3 跑真在役（终败于内核预算账目非工具缺席）、T16 calc-element click_element 路径 PASS） | R5-1 §2 #9+§3（离线枚举+在线差额互证）；orchestrator-state（full-autonomous-goal 3 attempts/full-calc-element PASS） |
| D-G71 | ἈΓΩΝ·D-ΑΓ-31（R4-4 §5-B·候选转正） | SEED_MANIFEST prereq 级联绑架（T19 FAIL ⇒ T20→T26 尾链 blocked） | 已闭环（R5-3 两处松绑 T20/T26 prereq→[]；物料面 files 谓词独立保留；**ANAB-8 批3 复证 2026-10-05 销案**：T19 canary FAIL×3 未绑架尾链——T20-T26 实跑 12/14（唯 T22 真败+T23 Actor 双通道死 blocked）） | R5-3 §1（w2orchestr 16/16+plan 双跑确定性+diff 恰 2 行）；orchestrator-state 批3 终局 |
| D-G72 | ἈΓΩΝ·D-ΑΓ-32（R4-4 §5-C·候选转正） | suite 话术 win+r/win+e 残留（黑名单键教学） | 已闭环（R5-3 话术清剿教学残留清零 3 处：T3 本工位修+T11/T16 并行修+复核；保留 14 反教学注记+1 shift+delete 安全禁令；**ANAB-8 批3 复证 2026-10-05 销案**：批3+retry 全队列零 win+r/win+e 教学复发——edge att6 制胜路由走 Win+搜索/ctrl+l 直填而非黑名单键，hotkey 面 44+ 次全白名单内（R6-2 §3.2）） | R5-3 §2（执法面证据：meta 单键条目 ⇒ win 族和弦全灭）；R6-2 §2.1/§3.2 |
| D-G73 | ἈΓΩΝ·D-ΑΓ-33（R4-2 §4 D5·候选转正） | type_text 换行语义缺陷（\n 被吞成单行） | 已闭环（R5-2 单点修 python _newline_plan 真 VK_RETURN 键事件+回执 newline_count/newline_semantics；回归钉「任何事件不得再以 VK_PACKET 0x0A/0x0D 注入换行」；**ANAB-8 批3 复证 2026-10-05 销案**：T20 宏/T21 技能编辑链多行键入 PASS——换行语义批3 在役零回归） | R5-2 §1-§3（python 11 项+全套件 366 过/3 skip；TS r52 7/7 dist 全链字节比对）；orchestrator-state（full-macro-record-replay/full-skill-lifecycle PASS） |
| D-G74 | ἈΓΩΝ·D-ΑΓ-34（R4-2 §4 D4·候选转正） | glm-5.3 会话纯文本：take_screenshot 图像本体不被宿主脑消费 | 已闭环（提示词面收口：R5-4 会话视觉能力自查段+visual_summary_cache 双拍冗余掐断——恒开；ask.semanticCache 键入册缺省关；**ANAB-8 定谳 2026-10-05：后半（开通图像输入=产品决策）转正 D-G83**——提示词面销案维持） | R5-4 §1.2/§2（VISION_GROUNDING 根性失修四证据+r54 7/7）；R6-2 §3.2/§4.3（两队列 take_screenshot 27+27 图本体零消费、a 项在役命中 0） |
| D-G75 | ἈΓΩΝ·D-ΑΓ-35（R4-7 §五·候选转正） | findToken 顺序：state 存档优先 ⇒ 宿主重启后首轮 RPC 必 401 | 已闭环（R5-7 修 ops/lib/dsh-ops.mjs：env→最新启动日志→state 存档；08:05 重启后首轮 rpc=ok 实测；**ANAB-8 批3 复证 2026-10-05 销案**：批3 三波 retry（11:49/12:38/13:03 起）批前巡检 rpc session.list 探测全程零首轮 401） | R5-7 §1.3 #7+§1.4；C:\2\batch3_r61*.log 批前巡检 PROBE OK 实录 |
| D-G76 | ἈΓΩΝ·D-ΑΓ-36（R4-8 §4①·候选转正） | knowledgeBase 知识档无主入口消费方（激活需 stateDir 一行指向知识档目录） | 后续窗口处理（主面已在役：R5-1 重启日志 Checkpoint failureMemory OK=部署档生效实证；第二通道水合接线仍未接） | R4-8 §1.2/§4；R5-1 §3（checkpoint 14 段全 OK） |
| D-G77 | ἈΓΩΝ·D-ΑΓ-38（R5-1 §5 条件②·新立） | 宿主 session/page 仅保留最近 ~250 事件——长任务早期轨迹被截断，traj 判据与证据包完整性受累——**R6-1 落地收割**：驱动器等待环每 tick 增量捕获事件流（seq 新于已捕获游标即 append 本地 session-events-inc.jsonl），任务收口增量与终局快照按 seq 去重合并（终局为准）写 hist.jsonl；**批3 实证**：超窗任务证据包零截断——calc-element 280 事件（seq 0-279）、diff-action-locate 279、macro-record-replay 254 全量在场（gaps 容量风暴会计 receipt.eventCapture 在案） | 已闭环（ANAB-8 定谳 2026-10-05：D7-条件② 销案——R6-1 代码 mtime 11:16-11:18 先于批3 开跑 11:49，事件文件在批3 任务目录在场为运行时实证） | bench/drive-desktop.mjs:252-253/:824-855（eventSink+seq 合并）/:860-861（hist 步）；bench/driveCore.mjs:639-710（增量折叠纯函数）；C:\dsh3\test-runs\results\suite-full\full-calc-element\session-events-inc.jsonl（280 行 seq 0-279） |
| D-G78 | ἈΓΩΝ·D-ΑΓ-39（R5-3 §6.1·新立） | T23 files 谓词仍核 auto-goal.txt（自主环产物，T22 五五开）——T22 FAIL 且未落盘时 T23 将 blocked 而非跑出 FAIL 证据 | 后续窗口处理 | R5-3 §6.1 |
| D-G79 | ἈΓΩΝ·D-ΑΓ-40（R5-3 §6.2·新立） | expectedOutcome/outcomeNote 元数据消费接线（analyze-run 侧判读：known-limitation 不计回归率、canary-FAIL 记正向证据） | 后续窗口处理 | R5-3 §3/§6.2 |
| D-G80 | ἈΓΩΝ·D-ΑΓ-41（R5-2 §4.4 建议 c/d·新立） | focusTracker 无光标概念：键盘导航到达编辑位后验证锚取鼠标兜底位（任务栏/资源管理器）⇒ 恒 noop 假阴性诱导盲重打；caret 伪锚与 press_hotkey 选族效果验证接线未落——**D2-c/d 治本即本条**（ΑΝΒ-2 工单在途）；批3 T20 宏/T21 技能编辑链 PASS 证明现行话术配方下编辑任务可达（D-ΑΓ-37 销案证据），结构性根治仍以此条为准 | 已闭环（ΑΝΒ-2/D2 落地 2026-10-05：W-07 caret 窗口中心伪锚[resolveCaretAnchor 阶梯：点击实测位＞伪锚＞null，type_text 验证区告别任务栏鼠标兜底位] + W-08 press_hotkey 选族区域 dHash 效果验证[纯本地零 VLM，SELECTION VERIFIED 附实测值/UNVERIFIED 附证据维度] + 选区账本四条保守失效律贯通 type_text——新册 anab2 23/23 全绿；伪锚≠真光标的诚实标注[anchorKind=window-center-pseudo]在案，生效待受控重启三段[归运行纪律非代码债]） | R5-2 §4.2②/§4.3/§4.4；orchestrator-state（full-macro-record-replay/full-skill-lifecycle PASS） |
| D-G81 | ἈΓΩΝ·D-ΑΓ-42（R5-6 §4 F11·新立） | verifyCore evalFileLike 的 PASS 路径只落 stat raw、内容不进证据（fail 路径才落 head.raw）——回放重判被迫字节精确重构 | 后续窗口处理（一行改动可让未来回放直接 receipt-entailed；属 verifyCore 产权） | R5-6 §4 F11/§5 |
| D-G82 | ἈΓΩΝ·D-ΑΓ-43（R5-6 §4 F10·新立） | present 类谓词（processRunning/windowExists）=verify 瞬时快照，「保持打开 N 秒」持续时间语义 DSL 不可表达 | 后续窗口处理（需 battery/world 延迟双采样——登记建议不动 battery） | R5-6 §1 攻击面 3/§4 F10 |
| D-G83 | ἈΓΩΝ·D-ΑΓ-34 后半（R4-2 §4 D4·ANAB-8 转正 2026-10-05） | glm-5.3 纯文本会话下 take_screenshot 图像本体零消费——两队列 27+27 次持平实证（R6-2 §3.2）；R5-4 a 项 visual_summary_cache 回执捎带部署后在役命中 0 次（指纹邻近+120s 新鲜+ask 先行条件过窄——R6-2 §4.3 判「未兑现」）；开通图像输入（宿主会话面或 harness 喂图）是产品决策非插件代码职权 | 需部署决策（ANAB-8 定谳：D10 转正——D-G74 提示词面已闭，本条承后半产品决策面；缓存命中面重设计归 R6-2 W12） | R6-2 §3.2/§4.3/§7 W12、W5；R5-4 §1.2；DECISIONS §D10 |
| D-G84 | D5 决策落地（ANAB-8 新立 2026-10-05） | read_text/find_text 部署首日不可达且无告警（enableOcr 缺省 false——R5-1 L4 六轮 retry 工具根本不在场的实证）；主人裁定 D5=C+B：enableOcr 缺省翻 true（零 API 成本零安全面、suite 判据硬依赖）+ doctor/health() 披露「因配置缺席未挂载的工具清单+开启键名」；落地需 census/测试期望同步（r54 等册缺省关形状断言）+ build→profile install→受控重启三段 | 已闭环（ΑΝΒ-4/D5 落地 2026-10-05：enableOcr 缺省翻 true[read_text/find_text 缺省配置即挂载] + CONFIG_GATED_TOOLS 18 门工具册单源立法 + 缺席披露三通道[doctor 第 22 条规则 config.silent-tool-absence/启动日志结构化行/get_metrics tool_face]+门开而装配失败也点名——anab4 8/8 全绿；autonomy/elementId 保持 opt-in 安全边界） | DECISIONS §D5；R5-1 §1 L4、§2 #9 |
| D-G85 | D6 决策落地（ANAB-8 新立 2026-10-05） | 成本三阈值闸（估算 >¥2 告警 STOP/硬顶 ¥5/轮/429>5%/降级>20%）现役载体=宪法第三律+批收口 SOP+watchdog CRIT——依赖每批人工纪律，换人/无人值守批是漏点；主人裁定 D6=B：watchdog daemon 心跳增读 vlm-batch-report.json 累计成本/429/降级三指标越阈即写 STOP（复用 CRIT→STOP 通道）+宪法附则一行固化「常设执法」 | 已闭环（ΑΝΒ-5/D6 落地 2026-10-05：watchdog cost-guard 常设执法[每 5 拍读 vlm-batch-report 四阈值裁决，越阈复用 CRIT→STOP 通道，代次账本防复发]+阈值单源=宪法附则四机器可读锚行[修宪即改执法]+顺手修复 suiteDirsForStop 对 results/<suite> 布局恒空的通道失明——daemon pid 17988 在役全绿） | DECISIONS §D6；R5-7 §1（daemon v2 CRIT 通道在役）；R4-6（三阈值全役零触发） |

## 统计与复核记录

条数（含已闭环与已定谳留档，ΤΕΛ-12 收官重数 2026-10-05 → R6-3 ἈΓΩΝ 收官重数 →
ΑΝΒ-8 定谳重数）：A 真机 8 ｜
B 激活开关 7 ｜ C 部署决策 5 ｜ D 已知取舍 17（W9-5 终谳十二条 + ΑΩ-R43 新立 D-D13 +
ΝΩ-54 新立 D-D14..D-D17 四条）｜ E 环境暴露 3 ｜ F 大文件与依赖环 5 ｜ G 其他 85
—— 合计 130 条（沿革：W6-0 立账三十六 → W6R 增至四十三 → W8 增至四十七 →
W9 终账四十八（新增 D-E2）→ ΑΩ 收官四十九（新立 D-D13 一条、闭环 D-E2 一条；
E 节 W9 收稿时点申报 1 为口径滞后，ΑΩ 补正为实数 2）→ ΝΩ 收官五十五（新立
D-D14/D-D15/D-D16/D-D17/D-E3/D-F5 六条，无闭环翻案）→ ΠΑΝ 修复潮七十七
（D-PAN 系列新立 22：四件账面器官补登即闭 D-G12..D-G15（C2-8 点名「不在台账」
的接线缺位，ΠΑΝ-34/50/48/59 已接线）+ 移交新债 D-G16..D-G32 十七条（本纪元ΠΑΝ
处理）+ 需真机 D-A8 一条；存量翻案 0——本潮清偿的是批判审计新发现而非旧账，
唯 D-E3 补 F3-3 归因③对照实验定案与一行修法在案）→ ΤΕΛΟΣ 完满纪元八十五
（新立八条：D-G16 拆条 M3/M7/M8 即 D-G33/D-G34/D-G35 + 工位留案 D-G36/D-G37/
D-G38 + 册同步 D-G39 + census 词法盲区 D-G40；翻案闭十八条：D-G16..D-G30/D-G32
十七条（D-G31 经 ΤΕΛ-10/T2-1 原子落地闭账、D-G39 经 ΤΕΛ-11/T2-2 终局收割闭账）
+ D-A4（Τ1-9 真机探针当场收割）；D-A1 终态收口（已闭内更新）；D-G25 定谳一条
（①③已闭、②部署侧增强项定谳）。W8 轮翻案闭十一条：D-G1 / D-B3 / D-B4 /
D-C3 / D-F1 / D-F3 / D-G2 / D-G3 / D-G5 / D-D11 / D-D12，新增 D-F4 / D-G9 /
D-G10 / D-G11 四条；D-C1 部分闭环在案，D-A7 半闭 → ἈΓΩΝ 实战纪元一百二十七
（R6-3 项目史官 2026-10-05 新立四十二条 D-G41..D-G82：正式二十六 + 候选定谳转正十
（销案一：D-ΑΓ-37 条件立案未触发——R5-1 修复后 T8 第 8 次尝试重评 PASS）+ R5 波
移交新立六；六条候选以已闭环入册（双配置/级联松绑/话术清剿/D5 换行/D4 纯文本话术面/
findToken）；批3 未跑在案登记）。
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

ΠΑΝ-F3-8 收稿复核记录（2026-10-04，ΠΑΝ 修复潮治理登记工单：GENESIS/DEBTS/config-schema
三册收官 + 审计自校；本批产权仅三份 .md，不进 tsc 编译目标，禁改一切源码/测试/脚本）：
- 四件账面器官补登即闭（C2-8 §四批判点名「DEBTS 的盲区——四件生产接线缺位均不在
  12 条未闭之列」的登记缺口，本册补正且 ΠΑΝ 已接线）：D-G12（armReversalEscrow 组合根
  通电——src/index.ts:913，ΠΑΝ-34）、D-G13（promoteFromCli 通道 + 四护栏——
  src/kernel/index.ts:103，ΠΑΝ-50）、D-G14（escalateProbeLatch 接线——
  src/knowledge/pipeline.ts:699，ΠΑΝ-48）、D-G15（clearConstructionBlockers 清账放行——
  goalState.ts:321 + autoPilot.ts:1217，ΠΑΝ-59）；mergeSimilarTypes 经 maintainCapacity
  接线（worldModel.ts:357/:363，ΠΑΝ-47）归 D-G27 census 册面申报。
- D-PAN 系列新债 18 条逐项登记（各工位报告「残留与移交」节的移交项，逐条精确到
  文件/执法册）：D-A8 + D-G16..D-G32；修复潮未新增 config 键（docs/config-schema.md
  再生实跑「内容未变 154 字段」——全部修复走既有开关/端口/模块常量，多份报告明示
  config.ts 非其领地；新开关类需求以 D-G16/D-G25/D-G30 协调项在册）。
- 逐册实跑取数（node v24.19.0 / Windows，登记前实跑不抄收稿报告）：ΠΑΝ 新执法面
  24 册 306 用例——23 册 295/0 全绿 + w0wiring.census 11 测 1 fail（现状红：ΠΑΝ-38
  之后新增 src/hmacKeyFile.ts 的 HMAC_KEY_FILE_BYTES 与 src/vlm/providers/cast.ts 的
  castProvider 两孤儿未登记豁免册——census 册失修即红是该执法器的设计语义，D-G27
  在册）；w2queue 批跑窗曾现 1 fail 单跑复验 12/0（密钥档窗口竞态）；python pytest
  300 通过/2 skip；bug_class_lint --strict 全库零命中（F3-3 收稿时点两处 BC-5 克隆
  已由 hmacKeyFile.ts 共享件等收口）；w2audit 25/0（F3-3 记录的 join 缺失已由并行
  工位补齐——genesis_audit 实跑面的在途红就此清零）。
- 台账滚动：55→77 条（新立 22：补登即闭 4 + 移交新债 17 + 需真机 1；存量翻案 0，
  唯 D-E3 描述尾补 F3-3 归因③定案与一行修法）。未闭重数（按状态主词逐条重数）：
  需真机 8｜需人工 3｜部分闭环 1｜待拆 1｜本纪元ΠΑΝ处理 17——未闭合计 30；
  已定谳 17 + 已闭环 30，三项合计 77。头部状态枚举补「本纪元ΠΑΝ处理」
  （D-PAN 系列在用——ΑΩ 补「部分闭环」、ΝΩ 补「待拆」同款补正先例）。
- genesis_audit --check 收稿复跑退出码 0（--parse 与抽样实跑两模式：虚报 0 / 实跑异常 0 /
  DEBTS 枚举违例 0 / 编号重复 0 / 合计不自洽 0 / 未入账红面 0——本册 .md 登记引发的
  审计红面为零，抽样 16 条中 11 条滞后为 W1-W5 史行对本潮扩册的软呈报不执法）。

ΤΕΛ-12 收官复核记录（2026-10-05，纪元台账立宪工单：GENESIS/DEBTS/INNOVATION 三册
收官 + 审计自校 + 全量自跑取数；本批产权仅三份 .md，不进 tsc 编译目标，禁改一切
源码/测试/脚本）：
- 终局改判逐条与工位报告对齐（T1-1..T1-9 + T2-1..T2-5 实测/取证口径）：翻案闭十八条
  （D-G16..D-G30/D-G32 十七条——其中 D-G31 经 ΤΕΛ-10/T2-1 原子落地闭账（UNLOAD_CHECKLIST
  52 键 + 三 disposer + w0unload 10/10）——+ D-A4；D-G39 新立后经 ΤΕΛ-11/T2-2 终局收割
  当场闭账）、定谳一条（D-G25——① Τ1-8b 闭环取证、③ Τ1-5 闭环、② 跨进程续账定谳为
  部署侧增强项：**定谳论证引 T1-5 §五（digest.ts:256 工单明示二择一在案 + 持久介质/
  防篡改信封/组合根通电三决策面）——工单指定引用的 T2-10 报告收稿时点缺席（T2 波在途），
  如实申报：若其补交且论证相左可翻案**）；D-A1 终态收口（Τ1-9 探针真机收割 + T2-5 复跑）；
  留案拆条新立八条 D-G33..D-G40（D-G16 M3/M7/M8 拆三条 + T1-3 canary hint / T1-6
  freshness 对齐 / T1-7 TOCTOU 残窗 / 册同步 D-G39（当场闭）/ census 词法盲区 D-G40）。
- 未闭重数（按状态主词逐条重数，终局）：需真机 7（D-A2/A3/A6/A7/A8 + D-B1 + D-G4——
  全部探针就位、硬件到场即收割）｜需人工 3（D-C4/D-E3/D-G6）｜部分闭环 1（D-F4）｜
  后续窗口处理 7（D-G33..D-G38 + D-G40）——**未闭合计 18**；已定谳 18（+D-G25）+
  已闭环 49，三项合计 85。头部状态枚举补「后续窗口处理」（D-G33..D-G38/D-G40 在用
  ——ΠΑΝ-F3-8 补「本纪元ΠΑΝ处理」同款补正先例）；「本纪元ΠΑΝ处理」枚举值随 D-PAN
  系列全数清偿历史化（枚举保留防旧档引用——「已知取舍」同律）。
- 全量自跑（本工位两次实跑，node v24.19.0 / Windows，2026-10-05——**T2 波部分工位仍在途**
  （T2-6/T2-7/T2-10 报告收稿时点缺席；ΤΕΛ-13 sandbox M3/M7/M8 施工在场未收稿），数字为
  时点快照）：首跑 `npm test` **3384 测 / 3370 过 / 5 败 / 9 skip**——5 败归因：w9real
  D-A5＝D-E3 在册（诚实红保持）；w0wiring.census＝豁免册幽灵 11（收割前在途态）；
  w4wire W4-G＝Τ1-4 planReady 注入改排版、kernel.generations Ξ-1/Ξ-2＝Τ1-5 D-G21②
  margin 口径语义变更（期望钉旧）——后三者经 T2-3（w4wire 锚更新 10/10）/T2-4
  （kernel.generations 夹具迁移 6/6）期望更新修复；二跑（收割与期望更新落地后）
  **3387 测 / 3376 过 / 2 败 / 9 skip**——败 1＝w9real D-E3 在册、败 2＝epochChi
  Χ-2（sandbox 域 ΤΕΛ-13 在途编辑面，与下方终验审计记录同判）；复跑 w0wiring.census +
  kernel.generations + w4wire 三册 **27/27 全绿**。本批产权仅 .md，上述红面零本批背书。
- `npm run wiring:census`（本工位两次实跑）：首跑 未登记 0 / 幽灵 11 / 非法 0（1552 值
  导出——收割前在途态）→ 复跑（收割落地后）**exit 0：未登记 0 / 幽灵 0 / 非法 0**，
  1559 值导出、609/609 在册、dead-code 类别清零（unwired-organ 5（cordis 壳契约改判）/
  test-only 421 / internal-surface 166 / reserved-api 17——ΤΕΛ-11 终态，见 D-G39/D-G40）。
- genesis_audit --check（本工位实跑，--parse 与抽样实跑两模式）：**exit 0**——虚报 0 /
  实跑异常 0 / DEBTS 枚举违例 0 / 编号重复 0 / 分节条数偏差 0 / 合计不自洽 0 / 未入账
  红面 0（自申报枚举 11 值含新补「后续窗口处理」全部合法；抽样 16 条账目一致 4 / 滞后
  11——W1-W5 史行对后续浪潮扩册的既有软呈报，不执法；未入账盘存 w6 五文件 0 fail）。
  注：w 前缀盘存正则限 w1-w6，w0wiring.census 不在审计射程——其状态红由全量自跑与
  D-G39/D-G40 账面如实登记。行内 `|` 转义致枚举错位的隐患一处（D-G19）已由并行终验
  审计工位改全角｜修复（见下方其记录块）。

ΤΕΛΟΣ 终验审计记录（2026-10-05，敌意抽查工位：六项敌意实测 + 两处在地小修 + 台账同步；
本工位产权＝本记录 + D-G39 状态翻转 + D-G19 行内转义修复 + 豁免册 11 幽灵收割 + D-A4 探针
临时文件竞态修复；未 commit）：
- 敌意抽查六项全过：① Τ1-1 五器官组合根真接线（index.ts:1088-1098/:1130-1140/:1152-1160、
  observabilityTools.ts:43-95、steerTools.ts:645-672）+ tel1.wiring 11/11 行为断言（真 apply/
  真提取/真目标机相位迁移，非 mock-only）；② ΠΑΝ-5/ΤΕΛ-3 令牌绑定链 14/14 敌意实测
  （谎报坐标/谎报描述/缺 hint/工具名冒充全拒、千分位抖动容忍带内放行、旧形态兼容律、
  重放面 replayTargetHintOf 同标准）；③ T1-2 十删符号全库零代码残留 + 桶面净 + tsc exit 0；
  ④ Τ1-7b junction 逃逸 payload 四面实测（目录链接/流式面/断链归因/根内真文件不误伤）；
  ⑤ Τ1-9 探针 pass 2 真硬件环取证（D-A1 真设备 12 帧 dhash 稳定比 1.0、D-A4 真回环
  116640 样本分类 notification_ding conf 0.7333——非自指涉；absent 7 与 pass 2 退出码
  分离、devices_present 不计 absent，不可伪造）；⑥ Τ1-7a cycle_lint 新解析器 13/13
  （正则含引号/除法/return 正则/嵌套模板/跨行子句不缺边；正则内伪 from/字符串/模板/
  注释伪 import 不误边；实树 299 文件/1554 边/value 环 0）。
- 在地小修三处：豁免册 11 幽灵条目收割（D-G39 闭账面）；D-G19 行内 \| 转义致
  genesis_audit 枚举错位红（改全角｜，audit 复跑 exit 0）；probe-da4-audio 的 SND_ASYNC
  临时文件清理竞态（mkstemp 延后 best-effort 清理——note 字段诚实性修复，复跑 pass
  exit 0 + realverify 册 12/12）。
- 终态实测（node v24.19.0 / Windows / py3.14.6）：npm run verify（五闸）exit 0——
  verify_fatal_fixes 23/23 · bug_class_lint --strict 零命中 · lint:cycle 299 文件/1554 边/
  14 SCC（value 环 0）· wiring:census 未登记 0/幽灵 0/非法 0（1552 值导出、605 在册、
  unwired-organ 0）· audit:genesis exit 0；tsc --noEmit exit 0；npm test 3387/3376 过/
  2 败/9 skip——败 1＝w9real D-A5（D-E3 在册 libuv 退出竞态，RESULT ok 后 0xC0000409）、
  败 2＝epochChi Χ-2（src/sandbox/{log,engine,memory,virtualScreen,macroRehearsal} 于
  04:18-04:21 被并行 T2 波在途编辑——测试册 mtime 10-04 22:59 早于改面，属在途时点红
  非 ΤΕΛΟΣ 交付面，如实登记不掩盖）；doctor score 65.5 / genesis intact / 0 crit / 0 maj /
  4 minor（magic-number）/ 77 info（over-engineering 24 豁免 + 53 未豁免——D-F4「拆分或
  豁免是决策」既定口径）；python pytest 348 过/3 skip；探针 run-all 在场 2/9 · pass 2 ·
  absent 7 · fail 0 · exit 0。
- 未闭重数滚动（D-G39 收割后）：需真机 7｜需人工 3｜部分闭环 1｜本纪元ΠΑΝ处理 1｜
  后续窗口处理 6——未闭合计 18；已定谳 18 + 已闭环 48，合计 84。
- ΤΕΛ-12 终局对账补记（上两行滚动数之后落笔）：D-G31 经 ΤΕΛ-10（T2-1）原子落地闭账
  （本纪元ΠΑΝ处理族清零）+ D-G40 新立（census 词法盲区）——终局口径：合计 **85 条**、
  未闭 18（需真机 7｜需人工 3｜部分闭环 1｜后续窗口处理 7）、已定谳 18、已闭环 49；
  与统计段首段逐字一致（genesis_audit --check exit 0 复跑执法）。

**ἈΓΩΝ 收官重数（R6-3 项目史官 2026-10-05，纪元台账写回工单）**：合计 **127 条**（新立
四十二条 D-G41..D-G82——26 条正式（草案 D-ΑΓ-1..26：已闭环 8｜实战在册 6｜部分闭环 1｜
后续窗口处理 11）+ 候选定谳转正十条（D-ΑΓ-27..36：已闭环 6｜实战在册 2｜后续窗口处理 2；
销案一：D-ΑΓ-37 条件立案未触发——R5-1 修复后 T8 第 8 次尝试重评 PASS，结构性盲区论不成立）
+ R5 波移交新立六条（D-ΑΓ-38..43，全后续窗口处理））；存量 85 条零翻案（本纪元清偿皆当场
修复入 GENESIS ἈΓΩΝ 章工位表功绩面，不入债册——D-ΑΓ-25 例外因其 c 类余项仍在册）。
未闭重数（按状态主词逐条重数）：ΤΕΛ-12 终局 18 + 新增实战在册 8 + 新增后续窗口处理 19 +
新增部分闭环 1 = **未闭 46**；已定谳 18 不变；已闭环 49+14=63——三项合计 127，与统计段
首段一致（genesis_audit --check 复跑执法）。头部状态枚举补「实战在册」（R2-9 §4.3 立法）。
在案登记：R5-5/R6-1/R6-2 报告缺席；批3 未跑（orchestrator 批 3 state=pending、无 T13-T26
任务目录）——全部按「缺的在案登记不虚填」处理；写回明细与审计输出见
C:\2\.survey\practice\R6-3.md。

**ΑΝΒ-8 定谳重数（项目史官 2026-10-05，工单 ANAB-8：D7+D10 批3 既成事实回溯定谳）**：
合计 **130 条**（对 R6-3 的 127 净增 3：新立 D-G83（D-ΑΓ-34 后半·需部署决策）/D-G84
（D5 落地）/D-G85（D6 落地）；状态迁移六——D-G77 后续窗口→已闭环（R6-1 增量持久化
落地+批3 280 事件实证，D7-② 销案）；D-G67/D-G68 实战在册→后续窗口处理（D10 转正，
批3 世界塑形实锤=R6-2 W9）；D-E3 需人工→本纪元ΑΝΒ处理（D3）；D-G66 后续窗口→
本纪元ΑΝΒ处理（D8-B+D9 联席）；D-G80 后续窗口→本纪元ΑΝΒ处理（D2 治本=ΑΝΒ-2）。
D7 三条件全消解：①T11 第 6 跑 PASS（03:48Z）+链根任务自解（scroll-deep PASS/open-url-nav
retry 首跑 PASS）②见 D-G77 ③R5-2/R5-4 终验由 R5-8（3552 全量+verify 五闸）与 R6-6
（3572/3562 唯一红=w9real 在案+五闸 EXIT 0+python 366/3）双覆盖——批3 GO 生效且终局
26 任务 23/2/1（金丝雀口径 24/26）。D10 销案 6：D-ΑΓ-30/31/32/33/35（批3 复证注记入行）
+ D-ΑΓ-37（T20 宏/T21 技能编辑链 PASS——销案维持，治本面 D-G80/ΑΝΒ-2 在途注记）。
未闭重数（按状态主词逐条重数）：需真机 7｜需人工 2｜需部署决策 1｜部分闭环 2｜
后续窗口处理 25｜实战在册 6｜本纪元ΑΝΒ处理 5 = **未闭 48**；已定谳 18 不变；
已闭环 64——三项合计 130，与统计段首段一致。批3 终局证据根：
C:\dsh3\test-runs\results\suite-full\orchestrator-state.json；写回明细见
C:\2\.survey\practice\ANAB-8.md。
