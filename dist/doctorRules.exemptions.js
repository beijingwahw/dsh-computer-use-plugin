// ─── W7-1 中央豁免注册表（over-engineering 官方豁免机制） ───
// 设计律：
//   1. 豁免必须显式登记：{file, reason, epoch} 三要素齐全 —— 缺任一项装配即 fail-fast
//      （引擎层 assertExemptionRegistryValid 执法），绝不静默跳过。
//   2. 登记条目必须溯源：理由逐字取自源内 W6-1/W6-2 结构性保留注记 —— 本注册表
//      不替别人发明理由；对不上号的文件保留原判（继续扣分）。
//   3. 豁免只作用于 EXEMPTABLE_RULE_ID（唯一 info 级 smell 规则）；genesis/security/
//      chain 与 critical/major 类规则永不受豁免影响。
//   4. 命中 ⇒ 降级为 registered-retention：finding 仍在报告列表可见（evidence 前缀
//      标注），但不扣分、不进手术提案 —— 与 W6 的「文件头注记」路线的关键区别：
//      豁免登记在中央注册表，被扫描的源文件零改动，避免并行代理编辑冲突。
/** 唯一可豁免规则（info 级 smell；改此常量 = 修法，须同步修执法测试） */
export const EXEMPTABLE_RULE_ID = 'smell.over-engineering';
/** 结构性保留登记（24 件 = W6-1 三件 + W6-2 十八件 + W9-3 三件：生成物一件 + 器官主体残余两件；理由逐字对照源内注记） */
export const OVER_ENGINEERING_EXEMPTIONS = [
    // ── W6-1（三件：闭包/状态机一体性 —— 拆分即拆确定性重放地基）──
    {
        file: 'autonomy/gym.ts', epoch: 'W6-1',
        reason: '训练营高内聚单职责器官：虚拟世界状态机/PCG 文法/实验室账本/课程编排同馆互锁（共享 seed 流与虚拟时钟的环内闭包状态），拆分须重构确定性重放地基，违反「行为零变化」红线',
    },
    {
        file: 'autonomy/runtime.ts', epoch: 'W6-1',
        reason: 'createExecute 是单一 900+ 行执行铸造厂闭包（宏重放/抽查节奏/验证判据以环内状态就地织成），拆分须重构闭包状态为参数传递 —— 逻辑重构，违反「行为零变化」红线',
    },
    {
        file: 'autonomy/autoPilot.ts', epoch: 'W6-1',
        reason: 'driveLoop 是单一近 800 行 Φ-4 闭环状态机（十段闸门/旁路/记账以环内闭包状态就地织成），拆分须重构闭包状态与步序语义 —— 逻辑重构，违反「行为零变化」红线',
    },
    // ── W6-2（十八件：理由逐字对照源内 W6-2 结构性保留注记）──
    {
        file: 'diagnosis.ts', epoch: 'W6-2',
        reason: 'H 纪元会诊皮层：贝叶斯 CPT 标定/规则表/遥测观测/R1 根因链四节共享同一症候群词表与首中即断序，规则表与证据词表必须同框审计',
    },
    {
        file: 'environmentShaper.ts', epoch: 'W6-2',
        reason: '环境整形器：Windows/Linux 双适配器 + undo 账本同生命周期（genesis.premature-impl 的 AdapterDeps 注入纪律锚定本文件），拆分将稀释平台对称性',
    },
    {
        file: 'interactivityProbe.ts', epoch: 'W6-2',
        reason: 'Z-1 交互性探针：光标/结构/视觉三通道判决围绕同一探测会话态内聚，通道拆分会复制探测时序契约',
    },
    {
        file: 'knowledge/pipeline.ts', epoch: 'W6-2',
        reason: 'D-7 知识管线编排器：感知/决策/执行三工位的单文件主权（信封铸造权/失败路由/时间治理收口于此），拆分违背四大主权收口设计',
    },
    {
        file: 'knowledge/stations.ts', epoch: 'W6-2',
        reason: 'D-7 三工位（vision/decision/execution）实现：工位构造器与工位视图按纪元成对演进，按工位拆三文件将撕裂 epoch 谱系注释与契约面',
    },
    {
        file: 'orchestrator.ts', epoch: 'W6-2',
        reason: 'D-2 编排器：ReAct 主循环/工具派发/上下文预算/恢复阶梯是单一认知循环的不可分相位，文件内分区注释即边界',
    },
    {
        file: 'physicalExecution/adapter.ts', epoch: 'W6-2',
        reason: '单一传输适配器类：capToken 鉴权/微取/生命周期共享同一 AdapterState 私有状态机；方法级拆分须跨模块外泄私有状态，安全面风险 > 拆分收益',
    },
    {
        file: 'sandbox/engine.ts', epoch: 'W6-2',
        reason: 'D-5 确定性沙箱引擎单职责：动作解释/帧缓存/回归判定围绕同一引擎态高度内聚，强拆将拆散状态机不变量',
    },
    {
        file: 'skillFederation.ts', epoch: 'W6-2',
        reason: '技能联邦：导入/导出/清单/协商围绕同一联邦协议方言（版本兼容矩阵），协议单文件即规范文本',
    },
    {
        file: 'telemetry.ts', epoch: 'W6-2',
        reason: '遥测器官：七个观测引擎（noop/熵率/CUSUM/Hurst/GPD/复杂度/模态）共享同一快照账本与窗口机制，属同轴仪器阵列而非异质拼盘',
    },
    {
        file: 'tools/autonomousRun.ts', epoch: 'W6-2',
        reason: 'autonomous_run 单工具面：参数 schema/发射/遥测记录/结果铸造同链路内聚，拆分收益低于工具面碎片化代价',
    },
    {
        file: 'tools/clickMouse.ts', epoch: 'W6-2',
        reason: 'click_mouse 工具面：审批域/公证取证/接地新鲜度/验收消费在同一点击链路上线性串联（W 系列安全层逐环叠加），拆分即拆安全链',
    },
    {
        file: 'tools/steerTools.ts', epoch: 'W6-2',
        reason: 'steer 工具族：steer(k)/what_if/match_skill 三工具共享岔路卡/反事实/技能库的同一路由方言，拆分将复制消费面胶水',
    },
    {
        file: 'visualDiff.ts', epoch: 'W6-2',
        reason: 'E 系视觉差分：dHash/pHash/区域网格/振荡检测围绕同一差分代数（sim/distance 单位约定），拆分将复制指纹方言',
    },
    {
        file: 'vlm/codec.ts', epoch: 'W6-2',
        reason: '视觉编码器：编码/中央凹/预算账本/质量闸门/注视路由围绕同一 Token 经济学（预算与画质互为约束），5 纪元 40+ 测试锁定其数值面；1420 行中过半是逐键注释的算法证据，强拆将拆散闸门与账本的耦合不变量',
    },
    {
        file: 'vlm/glmClient.ts', epoch: 'W6-2',
        reason: 'GLM 主脑客户端：直连路径 + providers 委托 + 故障切换池 + 级联咨询围绕单一 GlmClient 单例态（计费/回退/委托同账本），核心类约半文件，其余分区均不足独立成篇',
    },
    {
        file: 'vlm/grounding.ts', epoch: 'W6-2',
        reason: '视觉接地引擎：坐标几何/校准/预算门控/验证共守同一接地不变量（roundtrip 精度契约），分区将增加跨文件耦合面',
    },
    {
        file: 'vlm/onboarding.ts', epoch: 'W6-2',
        reason: 'Λ onboarding 状态机：引导阶段/连接体检/平台巡检按状态机转移同表演进，拆分将拆散转移矩阵',
    },
    // ── W9-3（一件：生成物 —— 手改即违规，拆分语法域外）──
    {
        file: 'riskGate.confusables.generated.ts', epoch: 'W9-3',
        reason: 'Unicode confusables 蒸馏生成物：1671 行是 UTS #39 confusables.txt（Version 18.0.0）蒸馏出的数据字面量映射，零逻辑零分支；文件头自带「勿手改」律，手拆或重排违反生成纪律 —— 再生成命令在案（node scripts/gen_confusables.mjs，血缘 scripts/confusables-source.txt）',
    },
    // ── W9-3（两件：器官主体残余 —— 纯函数分区已提取卫星件，类主体不可再拆）──
    {
        file: 'skillLibrary.ts', epoch: 'W9-3',
        reason: '技能库器官主体残余（W9-3 拆后 1005 行）：归纳去重/匹配排序/DNA 重组/系谱回溯/模板记账/休眠登记/示范蒸馏是同一 SkillLibrary 私有账本（skills/templates/dormant/avoidShapes 同生命周期）的不可分相位；纯函数分区（skillLibrary.signatures 检索签名 + skillLibrary.templates 模板蒸馏）已提取卫星件，方法级再拆须跨文件外泄私有状态 —— 与 orchestrator.ts 同律的结构性保留',
    },
    {
        file: 'subAgent.ts', epoch: 'W9-3',
        reason: '子代理协调器器官主体残余（W9-3 拆后 872 行）：名册轮转/焦点快照/租约黑板/步数记账/拍卖接线围绕单一 Coordinator 私有状态（agents/board/quota 同账本）；仲裁分区（subAgent.arbitration）与拍卖分区（subAgent.auction）已提取卫星件，方法级再拆须外泄私有状态 —— 与 orchestrator.ts 同律的结构性保留',
    },
];
