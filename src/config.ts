// src/config.ts
// DSH 规范：「两个部署可能想要不同值的一切都必须是配置字段」。
// 原项目地层中散落的全部魔法数字（1280/1440、q60/q75、窗口=3、熔断=3、1000 字符）
// 在此统一收敛为带默认值的配置。
import Schema from '@deepseek-ai/schemastery';

export interface Config {
  /** nut-js 鼠标移动速度(ms)，值越大移动越慢、越像人类（来自「双手纪元」） */
  mouseSpeed: number;
  /** 截图压缩宽度。纯视觉架构下画质优先，故默认 1440 而非 1280（来自「纯视觉定型纪元」） */
  compressWidth: number;
  /** JPEG 压缩质量，Token 杀手三参数之一（来自「Token 经济纪元」） */
  jpegQuality: number;
  /** SoM 网格分割数，0 = 关闭网格（来自 readme 承诺，原代码缺失，此处补全） */
  gridDivisions: number;
  /** 上下文滑动窗口保留的真实图片数（来自 contextManager 地层） */
  maxImageCount: number;
  /** 熔断阈值：连续失败次数（来自「守卫纪元」） */
  maxConsecutiveFailures: number;
  /** type_text 单次输入长度上限，防注入超长文本（来自 typeText 早期地层，迭代中曾丢失，此处找回） */
  maxTextLength: number;
  /** 启用 UI 元素 ID 寻址混合模式（来自「结构化清单纪元」，需注入无障碍 Provider） */
  enableElementIdMode: boolean;
  /** 本地视觉模型地址（如 http://127.0.0.1:8000/parse_gui），留空禁用（来自「混合架构纪元」） */
  localVisionApi: string;
  // ─── 世界级升级新增 ───
  /** 行为效果验证：动作前后 dHash 对比，检测盲点（点了没反应）（突破一） */
  verifyActions: boolean;
  /** 动作后等待 UI 响应的沉淀时间(ms)，再取 after 指纹 */
  actionSettleMs: number;
  /** 相似度高于此值判定为疑似无效操作（0~1） */
  noopSimilarityThreshold: number;
  /** 验证生效且带 target_description 的点击自动写入 UI 记忆（突破二） */
  autoRemember: boolean;
  /** 启用场景式 UI 记忆（remember_ui / recall_ui 工具） */
  enableUIMemory: boolean;
  /** UI 记忆容量（条） */
  uiMemoryCapacity: number;
  /** 启用行动日志与重放（突破三） */
  enableJournal: boolean;
  /** 日志 JSONL 落盘路径，留空仅内存 */
  journalPath: string;
  /** 单次重放步数上限 */
  replayMaxSteps: number;
  /** 干跑模式：动作类系统调用只记录不执行，截图仍真实（提示词调试/演示） */
  dryRun: boolean;
  // ─── 第二轮优化创新 ───
  /** 变化门控：与窗口内最新指纹汉明距离 <= 此值 ⇒ 判定屏幕未变，不重截图（省 Token/省管线） */
  stableScreenDistance: number;
  /** 自适应稳定等待：轮询至屏幕稳定再验证（动画期不误判）；false 则固定 actionSettleMs */
  adaptiveSettle: boolean;
  // ─── 第三轮创新 ───
  /** 区域验证半径（屏幕宽度比例）；聚焦动作点邻域指纹，放大局部反馈；0 = 禁用 */
  regionVerifyRadius: number;
  /** 焦点有效期(ms)：点击后多久内 type_text 可复用其坐标做区域验证 */
  focusMaxAgeMs: number;
  // ─── 第四轮创新 ───
  /** 启用本地 OCR（tesseract.js）：read_text / find_text 工具 + 语义核对。语言包首次使用需联网下载 */
  enableOcr: boolean;
  /** OCR 语言，如 'eng'、'chi_sim+eng' */
  ocrLang: string;
  // ─── Z 纪元（Z-1 世界行动引擎）───
  /** 启用交互性探针：find_text 命中先做悬停物理实验（光标形态 + 悬停重绘），对话文本不再被当成入口 */
  enableInteractivityProbe: boolean;
  /** 探针悬停停留(ms)：低于常见 tooltip 延迟，足够 hover 高亮生效 */
  probeDwellMs: number;
  /** 探针区域指纹半径（屏幕比例）：按钮级邻域，小而准 */
  probeRegionRadius: number;
  /** 悬停重绘判定阈值：区域相似度低于此值 ⇒ 判定 hover 高亮出现 */
  probeRepaintThreshold: number;
  /** find_text 单次探针目标上限：控制物理实验时长（每点 ≈ dwell + 2 次指纹） */
  probeMaxTargets: number;
  /** Z-1d 判决记忆化：同场景（指纹相似度 ≥ 阈值）复用判决，实验成本摊销到每场景一次 */
  enableProbeMemory: boolean;
  /** 判决记忆 TTL(ms)：超时即失效重实验（场景漂移的双保险） */
  probeMemoryTtlMs: number;
  /** 判决记忆容量（LRU 驱逐） */
  probeMemoryCapacity: number;
  /** 判决记忆场景匹配阈值（整屏指纹相似度） */
  probeMemorySceneSimilarity: number;
  /** 判决召回的点距半径（归一化）：OCR bbox 微抖的容忍带 */
  probeRecallRadius: number;
  // ─── AA 纪元（AA-1 世界跳转引擎）───
  /** 启用 open_url 工具：URL 感知（提取/归一/scheme 白名单）+ 系统默认浏览器跳转 */
  enableOpenUrl: boolean;
  // ─── 第五轮创新 ───
  /** 启用自进化技能库（save_skill / match_skill / run_skill + 自动归纳） */
  enableSkillLibrary: boolean;
  /** 技能库持久化路径（JSON）；留空仅内存。配置后技能跨会话存活 */
  skillLibraryPath: string;
  /** 复杂任务成功后自动把轨迹归纳为技能 */
  autoInduceSkills: boolean;
  /** 启用风险闸门：凭据类输入交还用户，Agent 不代劳 */
  enableRiskGate: boolean;
  /** 风险词（逗号分隔）：点击目标描述或待输文本命中即拦截 */
  riskPatterns: string;
  // ─── 第六轮创新 ───
  /** 启用不可逆操作审批闸门：危险目标需一次性令牌方可执行 */
  enableApprovalGate: boolean;
  /** 不可逆操作词（逗号分隔）：target_description 命中即需 request_approval 令牌 */
  dangerPatterns: string;
  /** 审批令牌初始有效期(ms)：一次用户确认覆盖整个任务的重试窗口（V 纪元：验收式消费） */
  approvalTokenTtlMs: number;
  /** 单令牌物理尝试次数上限：验收失败自动重试免二次确认，超限焚毁需重新审批 */
  approvalMaxAttempts: number;
  // ─── W6R（安全收口）：危险令牌路径的验证旁路双重逃生门 ───
  /**
   * 【风险开关，缺省 false】允许 dangerous 分级（审批令牌 / beginAttempt-consume 路径）
   * 的动作在「效果验证不可用 / 新鲜度探针缺席 / 金丝雀探针缺席」时仍然派发。
   *
   * 缺省 false 时的执法（fail-closed）：
   *   · verifyActions=false 单独关闭 ⇒ dangerous 令牌动作在派发前被拒
   *     （reason=effect-verification-required）—— 效果验证是 V 纪元验收式消费的
   *     依据，不允许被总开关静默旁路成「令牌派发即焚」；
   *   · 危险令牌动作派发前的接地新鲜度探针缺席/失败 ⇒ 拒绝派发
   *     （reason=freshness-probe-unavailable）；
   *   · 金丝雀试演在携带审批令牌的调用上探针缺席/失败 ⇒ 拦截该调用。
   *
   * true（显式逃生门）时的回退：上述三处恢复 degraded 放行 / 旧方言；且与
   * verifyActions=false **同时**配置时，危险动作跳过效果验证（acceptance 回到
   * unverified-dispatch-consumed 旧方言）。注意：单独 allowUnverifiedDangerous=true
   * 而 verifyActions=true 时效果验证照常执行（双钥匙语义 —— 绕过验证必须两把
   * 钥匙同时显式插入）；新鲜度 drifted（主动漂移证据）在任何配置下都照常拦截。
   *
   * 风险声明：true 意味着不可逆动作可能在未经验证 / 未探针的世界状态下执行，
   * 仅供明确接受该风险的部署（离线演示、受控实验、无截图能力的降级环境）。
   */
  allowUnverifiedDangerous: boolean;
  // ─── 第七轮创新：工程卓越（可观测/可审计/可恢复） ───
  /** 启用遥测：per-tool 成败/noop 率/延迟分位 + 记忆命中率 + get_metrics/self_diagnose 工具 */
  enableTelemetry: boolean;
  /** 全认知状态快照路径（JSON，原子写）；留空禁用。配置后启动自动恢复、卸载自动保存 */
  checkpointPath: string;
  // ─── 创世纪（B-5~B-8）：外部护栏 + Token 硬预算 + 语义弹窗 ───
  /** 本地视觉 API 超时（毫秒）：挂起时快速失败，agent 不永挂 */
  visionApiTimeoutMs: number;
  /** 截图降级摘要（B-6）：驱逐前 OCR 提取遗留文本，旧图保留语义「遗像」而非空占位 */
  enableLegacySummary: boolean;
  /** 遗像摘要字符预算（B-6）：防 OCR 长文反噬 Token */
  legacySummaryMaxChars: number;
  /** 上下文图片累计体积硬预算 KB（B-7）：与张数上限双约束，Token 溢出结构不可能 */
  maxContextImageKb: number;
  /** 弹窗语义词表（B-8）：OCR 命中任一词 ⇒ 语义弹窗判定（与几何启发式互补） */
  popupKeywords: string;
  // ─── 认知升维（C-1~C-5）：直觉/想象力/自我意识/群体智慧 ───
  /** C-1 意图感知验证：动作可携带 expected_effect，物理规则引擎裁决（无期望时零回归） */
  intentVerify: boolean;
  /** C-1 物理规则启用清单（逗号分隔）；空 = 全部启用 */
  physicsRules: string;
  /** C-2 语义技能匹配：向量化嵌入零样本泛化（零依赖，纯 CPU 微秒级） */
  enableSemanticMatch: boolean;
  /** C-2 DNA 重组：match_skill 未命中时自动尝试基因拼接合成新技能 */
  enableRecombination: boolean;
  /** C-4 认知焦点：显著度驱动驱逐 + 核心目标钉扎（关 = 纯 FIFO 回归） */
  salienceFocus: boolean;
  /** C-4 钉扎名额上限（防全钉扎击穿双预算） */
  pinBudget: number;
  /** C-4 潜意识池容量（条）；0 = 禁用灵光一闪 */
  subconsciousCapacity: number;
  /** C-4 既视感触发阈值（dHash 汉明距离） */
  subconsciousMatchDistance: number;
  /** C-5 群体智能中心地址；空 = 零网络行为（本地经验晶体依然生效） */
  swarmEndpoint: string;
  /** C-5 群体同步间隔（ms） */
  swarmSyncIntervalMs: number;
  /** C-5 经验晶体容量（条） */
  crystalCapacity: number;
  // ─── 第四维（D-1）：多智能体协同 —— 一台躯体，多重心智 ───
  /** 启用子代理团队（swarm_dispatch 工具：spawn/status/report/arbitrate） */
  enableSubAgents: boolean;
  /** 团队人数硬顶（spawn 超额即拒绝） */
  maxSubAgents: number;
  /** 每代理步数预算提醒线（动作类工具调用计数） */
  agentRoundSteps: number;
  // ─── 第四维（D-2）：环境重塑 —— 改变世界的权力与复原世界的义务对称 ───
  /** 启用环境重塑（shape_environment 工具：capabilities/apply/restore/undo_log） */
  enableEnvironmentShaper: boolean;
  /** 工作台预设链（如 'raise,maximize'）；空 = 无前置整理 */
  shaperPresets: string;
  /** 卸载/任务终结时自动 restoreAll（造物主的第一美德是复原） */
  shaperAutoRestore: boolean;
  /** 系统级动作闸门（set_contrast 等高影响操作默认禁用） */
  shaperAllowSystemWide: boolean;
  // ─── 第四维（D-3）：量子感知 —— 黑白盒叠加态 ───
  /** 启用量子感知：验证连续失败自动降级叠加态（白盒标注烧入截图，回归纯视觉闭环） */
  enableQuantumSense: boolean;
  /** 连续验证失败降级阈值（世界回击的硬证据才计数；模型自评置信度不算） */
  degradeAfterFailures: number;
  /** 叠加态下连续成功回归黑盒阈值（急救成功出院） */
  quantumRestoreOnSuccess: number;
  /** 叠加态标注节点预算（Token 纪律） */
  quantumMaxNodes: number;
  // ─── 第四维（D-4）：质量医生 —— 数字生命体的免疫系统 ───
  /** 启用质量医生：代码基因 + 因果链合法性审查（诊断只读；机械修复需显式授权） */
  enableQualityDoctor: boolean;
  /** 规则白名单（逗号分隔规则 ID，如 "genesis.io-mutex,smell.empty-catch"；空 = 全启用） */
  doctorRules: string;
  /** 严格模式：铁律违规时在报告中显著标红并令 CLI 退出码非零（绝不抛错中断） */
  doctorStrict: boolean;
  /** 进化记忆持久化路径（doctor-memory.json；跨会话的教训与基线） */
  doctorMemoryPath: string;
  // ─── 纪元 Ω（GLM-5.3-Flash 云脑皮层）───
  /**
   * GLM 视觉大模型 API Key（GLM_API_KEY/ZHIPUAI_API_KEY/ZAI_API_KEY 之上的配置层优先档）；空 = 走环境变量。
   *
   * W8-A2（密钥落盘边界·如实界定）：本字段所在配置文件的落盘由 cordis 宿主完成
   * （宿主自有配置档），插件只读、绝不自写 —— 宿主侧档位权限不在插件管辖面。
   * 插件侧唯一的明文密钥落盘写点是 vlm-connection.json（ConnectionStore.save，
   * src/vlm/connection.ts），已由共享模块 src/filePerms.ts 加固（写时收紧 +
   * 失败 insecure-perms 诚实降级 + 读时顺手收紧）；展示面统一走 maskKey 打码
   * （src/vlm/connection.ts —— 本模块无自造打码，不重复造轮子）。
   */
  vlmApiKey: string;
  /** GLM OpenAI 兼容基址；默认智谱开放平台 */
  vlmBaseUrl: string;
  /** GLM 视觉模型名；默认 glm-5.3-flash */
  vlmModel: string;
  /** 本地 OCR（服务端 L2 + legacy tesseract）双路径均失败后允许 VLM 云脑兜底读屏（语义核对第三路径） */
  vlmAssistOcr: boolean;
  // ─── 纪元 Ψ（万脑归一：多协议统一层）───
  /** 视觉模型平台 id（openai/anthropic/gemini/qwen/moonshot/doubao/xai/siliconflow/openrouter/ollama/lmstudio/vllm/custom；未知名按 OpenAI 兼容 custom 端点接入）；空 = 自动探测环境变量（GLM envs 优先，其次各平台 envKeys 首命中） */
  vlmProvider: string;
  /** 备选平台链（CSV，如 'anthropic,gemini'）——铸成故障切换池，主力失败按序补位；空 = 不铸池 */
  vlmFallbackProviders: string;
  // ─── 纪元 Λ（开箱即亮）：零配置解析链 ───
  /** 无任何云脑配置（config 与 env 全空）时自动探测收养本地视觉服务（Ollama/LM Studio/vLLM 环回轻叩，单候选 1.5s 止损） */
  vlmAutoAdoptLocal: boolean;
  /** 全无视觉模型（无存档、无本地、无 env）时自动弹出本机连接向导页（回环 HTTP 服务 + 默认浏览器） */
  vlmOnboardingEnabled: boolean;
  /** 连接向导服务缺省端口（被占则 +1 逐试至 +8） */
  vlmOnboardingPort: number;
  // ─── 纪元 Φ（自主智能环）：autonomous_run 元工具 ───
  /** 启用自主智能环元工具 autonomous_run（自主识别→自主判断→自主执行；关闭时工具不挂载） */
  autonomyEnabled: boolean;
  /** 自主环单轮步数上限（环保险丝与宪法步数硬顶同源此值），默认 24 */
  autonomyMaxSteps: number;
  /** 自主环单轮时长预算（秒），默认 300 */
  autonomyTimeBudgetSec: number;
  /** 允许不经审批自主执行的风险分层（CSV，取值 benign/sensitive；destructive 为宪法硬法恒审批），默认 'benign' */
  autonomyAllowTiers: string;
  /** 元素匹配低置信或候选并列时是否咨询云脑仲裁（PolicyEngine 的不确定即咨询开关），默认 true */
  autonomyVlmWhenUncertain: boolean;
  /** 自主宪法追加危险词（CSV，追加进目标/标签/参数的扫描词表；空 = 不追加） */
  autonomyForbiddenKeywords: string;
  /** 自主环断点续跑落盘路径（追加式 JSONL：begin/step/finish 事件行，重载时重放铸态）；空 = 仅内存态不落盘（纪元 Σ-3） */
  autonomyTracePath: string;
  // ─── 纪元 Ξ（Ξ-A 进化存档与进化编排）───
  /** 内核进化成果存档路径（JSON，tmp+rename 原子写）：值/证据计数/代际跨会话交棒（启动复载、卸载与进化后落盘）；空 = 仅内存不落盘 */
  kernelStatePath: string;
  /** 生产进化总开关：true 时用户消息钩子按节流窗驱动内核校准器 tick；false（缺省）= 只记账不进化，零行为变化 */
  kernelEvolutionEnabled: boolean;
  // ─── 地基速修（P1）：IO 排队超时 + 系统级热键黑名单 ───
  /** ioMutex 单次物理 IO 排队/执行超时（ms）：挂死的物理调用不再永久堵塞全局队列；0 = 无限等待（旧行为） */
  ioTimeoutMs: number;
  /** 系统级热键黑名单（CSV，键名小写）：press_hotkey 命中即拒绝（Alt+F4 关窗、Meta/Win 唤起系统壳层等逃逸动作） */
  hotkeyBlacklist: string;
  // ─── 纪元 Ρ（双钥公证锁）：不可逆动作的多通道语义公证 ───
  /** 不可逆动作放行前要求多通道语义公证：OCR 实读文字 + 白盒控件名 + 模型自述，任一通道见危险即拦（fail-heavy） */
  enableNotarizationLock: boolean;
  /** 语义握手：点击落点 OCR 实读标签须与模型描述相符，不符 ⇒ 拒绝并要求重新描述（防注入谎报目标） */
  notarySemanticHandshake: boolean;
  // ─── 纪元 Γ（注视经济）：中央凹加权编码 ───
  /** 中央凹加权编码：中央区原生分辨率、外围降采样，单位 VLM token 信息增益最大化；false（缺省）= 均质编码（旧行为） */
  foveatedEncoding: boolean;
  /** 中央凹区域边长占编码图比例（0~1，方窗），缺省 0.5 */
  foveaSize: number;
  /** 外围降采样因子（>1，外围按此倍数缩小再放大回拼），缺省 2 */
  foveaPeripheryScale: number;
  // ─── 纪元 Υ（认知睡眠周期）：离线整合六幕剧 ───
  /** 启用认知睡眠周期：会话结束时离线执行 回放→蒸馏→免疫→校准→审计→晨报 六幕（全程零网络、幂等水位线） */
  enableSleepCycle: boolean;
  /** 睡眠水位线与晨报 JSONL 落盘路径；空 = 仅内存（跨进程幂等性随之失效） */
  sleepTracePath: string;
  // ─── 纪元 Η（认识论闭环）：校准弃权闸门 ───
  /** 自主环认识论闸门：constitution 之前以校准置信×错误代价裁决 proceed/ask_human/abort（agent 在数学上该问人的时刻问人） */
  enableEpistemicGate: boolean;
  // ─── 纪元 Κ（惊异课程）：生产惊异谱驱动训练课程 ───
  /** 启用惊异课程：gym 世界生成按生产端 worldModel 惊异谱加权采样（P(world) ∝ exp(β·surprise)）；false（缺省）= 均匀（旧行为） */
  curriculumEnabled: boolean;
  /** 惊异课程温度系数 β：越大越集中于高惊异场景；缺省 1.0 */
  curriculumBeta: number;
  // ─── 纪元 Π（行为公证账本）：可对外公证的执行证据 ───
  /** RFC 3161 时间戳服务端点（TSA URL）；空 = 仅本地时间锚（诚实标注 source:'local'，零网络） */
  notaryEndpoint: string;
  /** 锚记录 JSONL 落盘路径（追加式，断行容忍）；空 = 仅内存（跨进程锚链丢失） */
  notaryTracePath: string;
  /** 卸载时自动为 journal 铸一次锚（链尖+MMR 根+时间戳）；false（缺省）= 仅经 quality_checkup 的 notarize 动作手动公证 */
  notaryAutoAnchor: boolean;
  // ─── 纪元 Μ（万脑联邦进化）：认知器官参数的隐私保护联邦 ───
  /** 联邦聚合端点；空 = 零网络（本地铸摘要/合并/应用依然全功能，供多进程与测试用） */
  federationEndpoint: string;
  /** 联邦摘要差分隐私 ε（Laplace 计数噪声；与群体经验结晶同默认 1） */
  federationEpsilon: number;
  /** 单 key 远端证据占本地账本的比例上限（0~1）：防远端洪泛主导本地校准；0.5 = 至多对半掺入 */
  federationMaxRemoteShare: number;
  // ─── 纪元 Ι（自我模型）：经验胜任度后验 ───
  /** 启用自我模型：按（动作类×场景桶）维护衰减 Beta 胜任度后验（被动记账；供认识论闸门与自省消费） */
  enableSelfModel: boolean;
  /** 自我模型参与认识论闸门的最小证据量：n 低于此值不掺入（诚实冷启动，不伪造经验） */
  selfModelMinEvidence: number;
  /** 自我模型记忆半衰期（小时）：旧战绩指数衰减，默认 168（一周） */
  selfModelHalfLifeH: number;
  // ─── 纪元 Τ（干预即教育）：审批事件蒸馏 ───
  /** 启用干预即教育：验收式消费成功的审批强化技能信任、被拒审批喂失败记忆（绝不记录凭据内容，只记动作形状与屏幕指纹） */
  enableDemonstrations: boolean;
  // ─── 纪元 Ε（预言引擎）：动作前预言、动作后审计 ───
  /** 启用预言引擎：自主环动作执行前经世界模型铸预言（期望屏型/期望效果），执行后对账记惊异——纯审计旁路，绝不阻断动作 */
  enableProphecy: boolean;
  // ─── 纪元 Β（反驳法院）：不可逆动作的跨模型对抗核验 ───
  /** 启用反驳法院：危险动作派发前请第二颗脑尝试反驳「目标=描述」——分歧即拦（≥2 颗脑配置才激活；单脑诚实缺席零行为） */
  enableRefuteCourt: boolean;
  // ─── 纪元 Ν（探索经济学）：探针的信息经济学 ───
  /** 启用探索经济学：交互性探针通道排序按学习到的「比特/成本」后验择优（记忆判决统计驱动；关 = 固定三通道降序旧行为） */
  enableProbeEconomy: boolean;
  // ─── 纪元 W1/W2（执行层四连改 · 集成接线）：autonomyW1 组字段 ───
  /** W2-0：执行层四连改接线总开关（buildAutonomyStack 注入 probe/focus；探针只在物理服务已存活时点亮，绝不主动拉起） */
  autonomyW1Exec: boolean;
  /** W1-1（A2）：动作点 ROI 半径（像素 —— 按捕获图短边归一），缺省 128 */
  autonomyW1RoiRadiusPx: number;
  /** W1-1（A2）：ROI 区域指纹判「变」的汉明阈值（距离 > 此值即变），缺省 2 */
  autonomyW1RoiHammingTolerance: number;
  /** W1-1（A3）：焦点短路半径（归一化距离 ≤ 此值即短路，免重复派发），缺省 0.01 */
  autonomyW1FocusShortcutRadius: number;
  /** W1-1（A4）：大框阈值（长边 ≥ 此值 ⇒ 词级质心落点），缺省 96 */
  autonomyW1LargeBboxPx: number;
  /** W1-1（A4）：小框阈值（短边 < 此值 ⇒ 落点向几何中心收缩），缺省 24 */
  autonomyW1SmallBboxPx: number;
  /** W1-1（A4）：小框收缩比（0.2 = 向中心收 20%），缺省 0.2 */
  autonomyW1SmallShrinkRatio: number;
  /** W1-1（A4）：词级元素面积上限（占目标框面积比 —— 超过视为目标自身），缺省 0.6 */
  autonomyW1WordMaxAreaRatio: number;
  /** W1-1（A4）：网格重试上限（3×3 去中心 = 最多 8 邻位；0 = 关闭网格重试），缺省 8 */
  autonomyW1ClickRetryMax: number;
  /** W1-1（A4）：网格步长（目标框短边比例），缺省 0.25 */
  autonomyW1GridStepRatio: number;
  /** W1-1（A4）：网格步长下限（像素），缺省 4 */
  autonomyW1GridStepMinPx: number;
  /** W1-1（A4）：网格步长上限（像素），缺省 40 */
  autonomyW1GridStepMaxPx: number;
  /** W1-1（A5）：稳态门轮询间隔（毫秒），缺省 150 */
  autonomyW1SteadyPollMs: number;
  /** W1-1（A5）：稳态门强制放行超时（毫秒，超时记 degraded），缺省 2000 */
  autonomyW1SteadyTimeoutMs: number;
  /** W1-1（A5）：稳态汉明阈值（连续两帧距离 ≤ 此值判稳），缺省 2 */
  autonomyW1SteadyHamming: number;
  /** W1-1（A5）：行亮度网格（frameRowmeans 的 grid 参数），缺省 64 */
  autonomyW1RowMeansGrid: number;
  /** W1-1（A5）：行位移搜索窗（estimateRowShift 的 searchRange），缺省 16 */
  autonomyW1RowShiftSearchRange: number;
  /** W2-0：免看门控（C1）接线开关 —— buildAutonomyStack 注入本地 frameHash 端口（capture→dhash 轻实现，失败返回 null ⇒ 门控诚实降级照旧感知） */
  autonomyW1FrameGate: boolean;
  /** W1-3（C1）：门控 dHash 汉明容差（与 worldSnapshot 缺省 3 同律），缺省 3 */
  autonomyW1GateHammingTolerance: number;
  /** W1-3（C1）：wait 值守轮询间隔毫秒，缺省 250 */
  autonomyW1GatePollIntervalMs: number;
  /** W1-3（C1）：wait 值守上限毫秒（到顶仍未变 ⇒ 轻量观察推进循环），缺省 2000 */
  autonomyW1GatePollMaxMs: number;
  /** W1-3（C1）：连续跳过上限（到顶强制一次完整感知），缺省 1 */
  autonomyW1GateMaxConsecutiveSkips: number;
  /** W1-8（P3）：Zoom 复核 verifyClient 接线开关（入册内核注册表 grounding.verifyZoom；关 ⇒ 触发事件 port-absent 放行原值），缺省开 */
  vlmZoomVerify: boolean;
  /** W1-7（P4）：SoM 稀疏标记预算（Top-K 上限）；0（缺省）= 全量标注（关闭 —— 稀疏会改变既有标注输出面，证据链未跑满前不翻转默认） */
  somSparseBudget: number;
  /** W2-8（C2）：成本级联路由的 tier 标注表（CSV "id=tier"，如 "ollama=cheap,siliconflow=cheap"；tier ∈ cheap|primary）；空（缺省）⇒ 池内无 cheap 档 ⇒ 级联恒弃权（零行为变化） */
  vlmProviderTiers: string;
  /** W2-8（C2）：级联便宜臂准入阈值（danger ≤ 此值才走便宜档）；缺省 0.35 + 保守静态因子（中危/新场景/中性置信 ⇒ danger 0.6）⇒ 级联弃权（失败安全：无证据不便宜） */
  vlmCascadeDangerMax: number;
  /** W2-5：恢复疗效账本 JSON 路径（原子 tmp+rename；启动复载 + 回合闭合自动落盘 + 卸载兜底落盘）；空（缺省）= 纯内存 */
  recoveryEfficacyPath: string;
  // ─── 纪元 W3（第三批器官 · W4-0 集成接线）───
  /** W4-0（C 接线）：启用探索前沿策略（W3-7 R2）—— buildAutonomyStack 铸 ExplorationLedger 注入 deps.exploration（恢复态升级分支的 UCB 择路 + 步落账回报）；false（缺省）= 端口缺席，升级路径逐字节旧路 */
  enableExploration: boolean;
  /** W4-0（C 接线）：探索账本独立持久化路径（JSON，tmp+fsync+rename 原子写，不碰 checkpoint）；空（缺省）= 纯内存（跨会话探索记忆失效，诚实降级） */
  explorationPersistPath: string;
  /** W4-0（B 接线）：启用活意图漂移的环内消费（W3-5 H2）—— driveLoop 每步以 stepIndex+最近校准熵经 createSteerSession 的 maybeCheckAndAsk 出题，出题 ⇒ steer-drift 升级提问；false（缺省）= 整段零执行（零回归红律） */
  autonomySteerEnabled: boolean;
  /** W4-0（G 接线）：start_complex_task 就绪层并行（W3-4 G2）—— RunOrchestratorOptions.parallel 透传（Kahn 就绪层 ≥2 无依赖子任务 + 团队余量双条件才实际并行）；false（缺省）= 串行脊梁逐字节旧路 */
  orchestratorParallel: boolean;
  // ─── 纪元 W4（第四批器官 · W5-0 集成接线）───
  /** W5-0（C 接线 · W4-3 S5）：可逆性分道派发 —— click/type/drag 派发前 classify → dispatchLaneFor 三路（reversible 快道 / compensable 托管道 / irreversible 交还人类）；未知语义交回既有危险词闸门；false（缺省）= 逐字节旧路 */
  enableReversibilityLanes: boolean;
  /** W5-0（D 接线 · W4-7 G5）：步数拍卖市场 —— maxSteps 变共享池每 K 步重拍卖（证据端口从经验晶体按出生场景指纹聚合）；false（缺省）= 各代理独立预算逐字节旧路 */
  enableStepAuction: boolean;
  /** W5-0（D 接线）：拍卖外注总预算（步）；0（缺省）= 名册推导（Σ maxSteps，与现状总额等价） */
  stepAuctionBudget: number;
}

export const Config: Schema<Config> = Schema.object({
  mouseSpeed: Schema.number().default(1500).description('nut-js mouseSpeed(ms), larger = more human-like'),
  compressWidth: Schema.number().default(1440).description('Screenshot resize width in px'),
  jpegQuality: Schema.number().default(75).description('JPEG quality 0-100'),
  gridDivisions: Schema.number().default(10).description('SoM grid divisions per axis, 0 disables'),
  maxImageCount: Schema.number().default(3).description('Sliding-window: max real images kept in context'),
  maxConsecutiveFailures: Schema.number().default(3).description('Circuit breaker threshold'),
  maxTextLength: Schema.number().default(1000).description('Max chars per type_text call'),
  enableElementIdMode: Schema.boolean().default(false).description('Enable element-ID addressing (needs accessibility provider)'),
  localVisionApi: Schema.string().default('').description('Local vision model endpoint, empty = disabled'),
  verifyActions: Schema.boolean().default(true).description('dHash before/after effect verification'),
  actionSettleMs: Schema.number().default(400).description('Wait ms after action before after-hash'),
  noopSimilarityThreshold: Schema.number().default(0.97).description('Similarity above this = likely no-op'),
  autoRemember: Schema.boolean().default(true).description('Auto-save verified clicks to UI memory'),
  enableUIMemory: Schema.boolean().default(true).description('Enable remember_ui / recall_ui tools'),
  uiMemoryCapacity: Schema.number().default(200).description('UI memory capacity'),
  enableJournal: Schema.boolean().default(true).description('Enable action journal & replay'),
  journalPath: Schema.string().default('').description('JSONL journal path, empty = memory only'),
  replayMaxSteps: Schema.number().default(100).description('Max steps per replay'),
  dryRun: Schema.boolean().default(false).description('Dry-run: log actions without executing'),
  stableScreenDistance: Schema.number().default(3).description('Change-gate: dHash distance <= this = screen unchanged'),
  adaptiveSettle: Schema.boolean().default(true).description('Poll until screen settles before verifying effects'),
  regionVerifyRadius: Schema.number().default(0.15).description('Region-verify radius as screen fraction; 0 = off'),
  focusMaxAgeMs: Schema.number().default(30000).description('Focus validity window for region verification'),
  enableOcr: Schema.boolean().default(false).description('Enable local OCR (read_text/find_text + semantic verification)'),
  ocrLang: Schema.string().default('eng').description('OCR language, e.g. eng / chi_sim+eng'),
  enableInteractivityProbe: Schema.boolean().default(true).description('Hover-probe OCR hits (cursor shape + hover repaint) so conversation text is never mistaken for a clickable entry'),
  probeDwellMs: Schema.number().default(350).description('Probe hover dwell in ms'),
  probeRegionRadius: Schema.number().default(0.06).description('Probe region-hash radius as screen fraction'),
  probeRepaintThreshold: Schema.number().default(0.985).description('Region similarity below this during hover = repaint detected'),
  probeMaxTargets: Schema.number().default(4).description('Max find_text hits probed per call'),
  enableProbeMemory: Schema.boolean().default(true).description('Memoize probe verdicts per scene fingerprint; repeat scenes reuse verdicts with zero experiments'),
  probeMemoryTtlMs: Schema.number().default(300000).description('Probe-verdict memory TTL in ms'),
  probeMemoryCapacity: Schema.number().default(128).description('Probe-verdict memory capacity (LRU)'),
  probeMemorySceneSimilarity: Schema.number().default(0.9).description('Scene-fingerprint similarity required to recall a verdict'),
  probeRecallRadius: Schema.number().default(0.015).description('Normalized point-distance radius for verdict recall (OCR bbox jitter tolerance)'),
  enableOpenUrl: Schema.boolean().default(true).description('open_url tool: URL sensing (extract/normalize/scheme allowlist) + jump via the OS default browser'),
  enableSkillLibrary: Schema.boolean().default(true).description('Self-evolving skill library (induce/match/run)'),
  skillLibraryPath: Schema.string().default('').description('Skill library JSON path; empty = memory only. Set a path for cross-session learning'),
  autoInduceSkills: Schema.boolean().default(true).description('Auto-induce skills from successful complex tasks'),
  enableRiskGate: Schema.boolean().default(true).description('Risk gate: credentials are typed by the user, not the agent'),
  riskPatterns: Schema.string().default('password,passwd,密码,口令,验证码,verification code,2fa,otp,pin,secret,token,api key,私钥').description('Comma-separated risk keywords'),
  enableApprovalGate: Schema.boolean().default(true).description('Approval gate: irreversible actions need a one-shot token from request_approval'),
  dangerPatterns: Schema.string().default('send,发送,delete,删除,remove,移除,pay,支付,付款,buy,购买,checkout,结算,下单,submit order,提交订单,confirm,确认订单,format,格式化,erase,抹掉,uninstall,卸载,reset,重置,清空,withdraw,提现,transfer,转账').description('Comma-separated irreversible-action keywords triggering approval'),
  approvalTokenTtlMs: Schema.number().default(600000).description('Approval-token TTL (ms). ONE user consent covers the whole task retry window; each failed attempt re-arms it (capped at 3x TTL from mint)'),
  approvalMaxAttempts: Schema.number().default(5).description('Max physical attempts per approval token: failed (unverified) clicks retry under the same consent without re-asking; beyond this a fresh approval is required'),
  // ─── W6R（安全收口）：危险令牌路径的验证旁路双重逃生门 ───
  allowUnverifiedDangerous: Schema.boolean().default(false).description('DANGEROUS (risk flag, default false): allow dangerous (approval-token / beginAttempt-consume) actions to dispatch when effect verification is unavailable (verifyActions=false), the grounding freshness probe is absent/failed, or the canary probe is absent/failed on a token-bearing call. false (default) = fail-closed at all three points. true = explicit escape hatch restoring degraded pass-through / legacy unverified-dispatch-consumed dialect (verification bypass additionally requires verifyActions=false — two explicit keys). Irreversible actions may then execute unverified — only for deployments that explicitly accept that risk.'),
  enableTelemetry: Schema.boolean().default(true).description('Telemetry: per-tool success/no-op rates, latency percentiles, memory hit rates'),
  checkpointPath: Schema.string().default('').description('Cognitive-state checkpoint JSON (atomic). Auto-restore on start, auto-save on unload. Empty = disabled'),
  // ─── 创世纪（B-5~B-8） ───
  visionApiTimeoutMs: Schema.number().default(5000).description('Timeout (ms) for the local vision API. Fail fast instead of hanging the agent'),
  enableLegacySummary: Schema.boolean().default(true).description('OCR the evicted screenshot into a short text summary so old frames keep semantic content'),
  legacySummaryMaxChars: Schema.number().default(200).description('Character budget for legacy summaries (prevents OCR text from flooding context)'),
  maxContextImageKb: Schema.number().default(600).description('Hard budget (KB) for cumulative in-context image bytes; combined with maxImageCount'),
  popupKeywords: Schema.string().default('cookie,allow,accept,confirm,登录,订阅,update,install,allow notifications,trial,upgrade now,subscribe,accept all,agree').description('Comma-separated keywords: OCR hit in the center region confirms a popup semantically'),
  // ─── 认知升维（C-1~C-5） ───
  intentVerify: Schema.boolean().default(true).description('Intent-aware verification: actions may carry expected_effect; a physics rule engine then seeks evidence (no expectation = zero behavior change)'),
  physicsRules: Schema.string().default('').description('Comma-separated physics-rule kinds to enable (toggle_on,toggle_off,menu_expand,menu_collapse,scroll_content_up,scroll_content_down,input_focus); empty = all'),
  enableSemanticMatch: Schema.boolean().default(true).description('Semantic skill matching via zero-dependency subword-hash embeddings (zero-shot generalization)'),
  enableRecombination: Schema.boolean().default(true).description('Skill DNA recombination: synthesize new skills from gene segments when match_skill finds nothing'),
  salienceFocus: Schema.boolean().default(true).description('Cognitive-focus engine: salience-driven eviction + task-goal pinning (off = plain FIFO)'),
  pinBudget: Schema.number().default(1).description('Max pinned screenshots (prevents pin-everything from breaking the dual budget)'),
  subconsciousCapacity: Schema.number().default(32).description('Subconscious pool capacity (evicted records compressed to (hash,gist) tuples); 0 disables flashback'),
  subconsciousMatchDistance: Schema.number().default(6).description('Déjà-vu trigger threshold (dHash hamming distance) for subconscious flashback'),
  swarmEndpoint: Schema.string().default('').description('Swarm-intelligence center endpoint; empty = zero network (local experience crystals still work)'),
  swarmSyncIntervalMs: Schema.number().default(300000).description('Swarm sync interval (ms); upload is async fire-and-forget, never blocks the hot path'),
  crystalCapacity: Schema.number().default(500).description('Experience-crystal capacity (aggregated from the journal chain)'),
  // ─── 第四维（D-1） ───
  enableSubAgents: Schema.boolean().default(true).description('Multi-agent swarm: spawn role-based sub-agents via swarm_dispatch (one body, many minds)'),
  maxSubAgents: Schema.number().default(3).description('Hard cap on concurrent sub-agents; excess spawn attempts are rejected'),
  agentRoundSteps: Schema.number().default(10).description('Per-agent action-step budget reminder line (surface via swarm_dispatch status)'),
  // ─── 第四维（D-2） ───
  enableEnvironmentShaper: Schema.boolean().default(true).description('Environment shaping: reshape the workspace (raise/maximize/move/zoom) with a LIFO undo log; zero behavior when capability set is empty'),
  shaperPresets: Schema.string().default('').description('Workspace preset chain applied via shape_environment, e.g. "raise,maximize"; empty = none'),
  shaperAutoRestore: Schema.boolean().default(true).description('Auto restoreAll on unload — the power to change the world comes with the duty to restore it'),
  shaperAllowSystemWide: Schema.boolean().default(false).description('Gate for system-wide changes (set_contrast); disabled by default'),
  // ─── 第四维（D-3） ───
  enableQuantumSense: Schema.boolean().default(true).description('Quantum sensing: after N consecutive verified failures, enter superposition — whitebox annotations are burned into the screenshot, keeping the decision surface purely visual; zero behavior without a whitebox provider'),
  degradeAfterFailures: Schema.number().default(3).description('Consecutive verified-effect failures before degrading to superposition (hard evidence only)'),
  quantumRestoreOnSuccess: Schema.number().default(2).description('Consecutive verified successes in superposition before reverting to pure vision'),
  quantumMaxNodes: Schema.number().default(30).description('Max whitebox annotation nodes per screenshot (token discipline)'),
  // ─── 第四维（D-4） ───
  enableQualityDoctor: Schema.boolean().default(true).description('Quality Doctor: immune system auditing code genes (iron laws) and causal-chain legality; diagnose is read-only, mechanical fixes need explicit authorization'),
  doctorRules: Schema.string().default('').description('Comma-separated rule-ID whitelist (empty = all rules active)'),
  doctorStrict: Schema.boolean().default(false).description('Strict mode: genesis violations surface loudly (CLI exit code 1); never throws'),
  doctorMemoryPath: Schema.string().default('doctor-memory.json').description('Evolution-memory file for lessons and baselines (developer asset, not runtime cognition)'),
  // ─── 纪元 Ω（GLM-5.3-Flash 云脑皮层） ───
  // W8-A2：配置档（含本字段）落盘归 cordis 宿主管辖，插件只读；插件侧密钥落盘唯一写点
  // vlm-connection.json 已走 src/filePerms.ts 加固 —— 详见上方 interface 注释的边界界定
  vlmApiKey: Schema.string().default('').description('GLM vision-model API key; empty = fall back to env (GLM_API_KEY/ZHIPUAI_API_KEY/ZAI_API_KEY). Takes priority over env when set'),
  vlmBaseUrl: Schema.string().default('https://open.bigmodel.cn/api/paas/v4').description('GLM OpenAI-compatible base URL'),
  vlmModel: Schema.string().default('glm-5.3-flash').description('GLM vision model name'),
  vlmAssistOcr: Schema.boolean().default(false).description('Allow the VLM cloud cortex to read the screen as a third path when BOTH local OCR paths (server L2 + legacy tesseract) fail (semanticConfirm fallback)'),
  // ─── 纪元 Ψ（万脑归一：多协议统一层） ───
  vlmProvider: Schema.string().default('').description('Vision-model platform id (openai/anthropic/gemini/qwen/moonshot/doubao/xai/siliconflow/openrouter/ollama/lmstudio/vllm/custom; unknown ids are treated as OpenAI-compatible custom endpoints); empty = auto-detect from env (GLM envs first, then each platform envKeys)'),
  vlmFallbackProviders: Schema.string().default('').description('CSV fallback platform chain (e.g. "anthropic,gemini") minted into a failover pool behind the primary; empty = no pool'),
  // ─── 纪元 Λ（开箱即亮） ───
  vlmAutoAdoptLocal: Schema.boolean().default(true).description('When NO vision brain is configured at all (no config, no env), auto-adopt a local zero-key vision service (Ollama/LM Studio/vLLM loopback probe, 1.5s budget each); off = skip straight to the wizard'),
  vlmOnboardingEnabled: Schema.boolean().default(true).description('When NO vision model is resolvable at all (no archive, no local service, no env), pop up the local connection wizard page (loopback HTTP server + default browser); off = stay dark until manual configuration'),
  vlmOnboardingPort: Schema.number().default(18432).description('Default port for the connection wizard server (falls back +1 up to +8 when occupied)'),
  // ─── 纪元 Φ（自主智能环） ───
  autonomyEnabled: Schema.boolean().default(false).description('Enable the autonomous loop meta-tool (autonomous_run): goal -> perceive -> judge -> constitution -> execute -> verify -> evolve. Off = tool not mounted'),
  autonomyMaxSteps: Schema.number().default(24).description('Autonomous loop per-run step cap (both the loop fuse and the constitution hard stop), default 24'),
  autonomyTimeBudgetSec: Schema.number().default(300).description('Autonomous loop per-run wall-clock budget in seconds, default 300'),
  autonomyAllowTiers: Schema.string().default('benign').description('CSV of risk tiers allowed to run autonomously without approval (values: benign, sensitive; destructive is always constitution-gated), default "benign"'),
  autonomyVlmWhenUncertain: Schema.boolean().default(true).description('Consult the GLM cortex when element matching is low-confidence or tied (PolicyEngine uncertainty arbitration), default true'),
  autonomyForbiddenKeywords: Schema.string().default('').description('CSV of extra danger keywords appended to the autonomy constitution scan list (goal/target/payload text scan), empty = none'),
  autonomyTracePath: Schema.string().default('').description('Append-only JSONL trace path for autonomous runs (begin/step/finish event lines replayed on load) enabling autonomy_resume across processes; empty = in-memory only (resume tokens live and die with the process)'),
  // ─── 纪元 Ξ（Ξ-A 进化存档与进化编排） ───
  kernelStatePath: Schema.string().default('').description('Kernel evolution-state JSON path (atomic tmp+rename write): params/evidence/generations carried across sessions (restored on load, saved on unload and after evolution ticks); empty = memory only'),
  kernelEvolutionEnabled: Schema.boolean().default(false).description('Master switch for production kernel evolution: throttled calibrator ticks on user-message hooks; false (default) = bookkeeping only, zero behavior change'),
  // ─── 地基速修（P1） ───
  ioTimeoutMs: Schema.number().default(15000).description('ioMutex per-IO queue/execution timeout (ms): a hung physical call no longer blocks the global queue forever; 0 = wait forever (legacy behavior)'),
  hotkeyBlacklist: Schema.string().default('alt+f4,meta,meta+l,meta+r,meta+d,win,cmd+q,ctrl+alt+delete').description('Comma-separated system-hotkey blacklist (lowercase key names): press_hotkey matches are rejected outright (window-close / OS-shell escape moves)'),
  // ─── 纪元 Ρ（双钥公证锁） ───
  enableNotarizationLock: Schema.boolean().default(true).description('Two-key semantic notarization for irreversible actions: OCR-read label + whitebox control name + model self-description — ANY channel seeing danger blocks (fail-heavy); channels absent degrade honestly to legacy single-channel behavior'),
  notarySemanticHandshake: Schema.boolean().default(true).description('Semantic handshake: the OCR-read label at the click point must agree with the model description, otherwise reject and demand re-description (defeats injection lying about the target)'),
  // ─── 纪元 Γ（注视经济） ───
  foveatedEncoding: Schema.boolean().default(false).description('Foveated encoding: center region at native resolution, periphery downsampled — maximize information gain per VLM token; false (default) = uniform encoding (legacy)'),
  foveaSize: Schema.number().default(0.5).description('Fovea window edge as a fraction of the encoded image (square), default 0.5'),
  foveaPeripheryScale: Schema.number().default(2).description('Periphery downsampling factor (>1: periphery shrunk by this factor then scaled back into place), default 2'),
  // ─── 纪元 Υ（认知睡眠周期） ───
  enableSleepCycle: Schema.boolean().default(false).description('Cognitive sleep cycle: on session end run the six-act offline consolidation (replay -> distill -> immune -> calibrate -> audit -> morning report); fully offline, idempotent via watermark'),
  sleepTracePath: Schema.string().default('').description('Sleep watermark + morning-report JSONL path; empty = memory only (cross-process idempotency lost)'),
  // ─── 纪元 Η（认识论闭环） ───
  enableEpistemicGate: Schema.boolean().default(true).description('Epistemic gate in the autonomy loop: calibrated confidence x error-cost adjudicates proceed/ask_human/abort BEFORE the constitution check (the agent asks for help at mathematically justified moments)'),
  // ─── 纪元 Κ（惊异课程） ───
  curriculumEnabled: Schema.boolean().default(false).description('Surprise-driven curriculum: gym world generation samples proportional to the production worldModel surprise spectrum, P(world) ~ exp(beta*surprise); false (default) = uniform (legacy)'),
  curriculumBeta: Schema.number().default(1).description('Surprise-curriculum temperature beta: higher = more concentration on high-surprise scenes, default 1.0'),
  // ─── 纪元 Π（行为公证账本） ───
  notaryEndpoint: Schema.string().default('').description('RFC 3161 timestamp-authority (TSA) endpoint; empty = local-time anchors only (honestly labeled source:local, zero network)'),
  notaryTracePath: Schema.string().default('').description('Append-only JSONL path for anchor records (tolerant of torn last lines); empty = memory only (anchor chain lost across processes)'),
  notaryAutoAnchor: Schema.boolean().default(false).description('Automatically mint one anchor (chain tip + MMR root + timestamp) for the journal on unload; false (default) = notarize only manually via the quality_checkup notarize action'),
  // ─── 纪元 Μ（万脑联邦进化） ───
  federationEndpoint: Schema.string().default('').description('Federation aggregation endpoint; empty = zero network (local mint/merge/apply still fully functional for multi-process and test use)'),
  federationEpsilon: Schema.number().default(1).description('Differential-privacy epsilon for federated evidence digests (Laplace count noise; same default of 1 as the swarm experience crystals)'),
  federationMaxRemoteShare: Schema.number().default(0.5).description('Cap (0~1) on remote-evidence share per key relative to the local ledger: prevents remote flooding from dominating local calibration; 0.5 = at most half-and-half blending'),
  // ─── 纪元 Ι（自我模型） ───
  enableSelfModel: Schema.boolean().default(true).description('Self-model: decayed Beta competence posteriors per (action-kind x scene-bucket), passive bookkeeping consumed by the epistemic gate and introspection'),
  selfModelMinEvidence: Schema.number().default(8).description('Minimum evidence n before the self-model may inform the epistemic gate (honest cold start, no fabricated experience)'),
  selfModelHalfLifeH: Schema.number().default(168).description('Self-model memory half-life in hours: old outcomes decay exponentially, default 168 (one week)'),
  // ─── 纪元 Τ（干预即教育） ───
  enableDemonstrations: Schema.boolean().default(true).description('Intervention-as-education: acceptance-consumed approvals strengthen skill trust, denied approvals feed failure memory (never records credential content — action shape and screen fingerprint only)'),
  // ─── 纪元 Ε（预言引擎） ───
  enableProphecy: Schema.boolean().default(true).description('Prophecy engine: before each autonomy-loop action the world model mints a prediction (expected screen type/effect); after execution the outcome is reconciled and surprise recorded — pure audit bypass, never blocks the action'),
  // ─── 纪元 Β（反驳法院） ───
  enableRefuteCourt: Schema.boolean().default(true).description('Refutation court: before a dangerous dispatch a second brain is asked to REFUTE "target = description" — disagreement blocks (activates only with >=2 brains configured; single-brain deployments degrade to zero behavior)'),
  // ─── 纪元 Ν（探索经济学） ───
  enableProbeEconomy: Schema.boolean().default(true).description('Probe economics: interactivity-probe channel ordering by learned bits-per-cost posteriors (driven by memoized-verdict statistics; off = fixed three-channel descending order, legacy)'),
  // ─── 纪元 W1/W2（执行层四连改 · 集成接线） ───
  autonomyW1Exec: Schema.boolean().default(true).description('W1 exec-layer quad upgrade wiring: buildAutonomyStack injects probe (ExecWorldProbe — only lights up when the physical service is already alive, never spawns) + focus source (origin-tagged, no cross-layer shortcuts); off = pre-wire byte-identical legacy path'),
  autonomyW1RoiRadiusPx: Schema.number().default(128).description('W1-1 A2: action-point ROI radius in px (normalized by capture short edge), default 128'),
  autonomyW1RoiHammingTolerance: Schema.number().default(2).description('W1-1 A2: ROI region-hash "changed" hamming threshold (distance > this = changed), default 2'),
  autonomyW1FocusShortcutRadius: Schema.number().default(0.01).description('W1-1 A3: focus shortcut radius (normalized distance <= this skips re-dispatch), default 0.01'),
  autonomyW1LargeBboxPx: Schema.number().default(96).description('W1-1 A4: large-bbox threshold (long edge >= this => word-centroid landing point), default 96'),
  autonomyW1SmallBboxPx: Schema.number().default(24).description('W1-1 A4: small-bbox threshold (short edge < this => shrink landing toward center), default 24'),
  autonomyW1SmallShrinkRatio: Schema.number().default(0.2).description('W1-1 A4: small-bbox shrink ratio (0.2 = pull 20 percent toward center), default 0.2'),
  autonomyW1WordMaxAreaRatio: Schema.number().default(0.6).description('W1-1 A4: word-element area cap as a fraction of the target bbox (above = treated as the target itself), default 0.6'),
  autonomyW1ClickRetryMax: Schema.number().default(8).description('W1-1 A4: grid retry cap (3x3 minus center = 8 neighbors; 0 disables grid retry), default 8'),
  autonomyW1GridStepRatio: Schema.number().default(0.25).description('W1-1 A4: grid step as a fraction of the target short edge, default 0.25'),
  autonomyW1GridStepMinPx: Schema.number().default(4).description('W1-1 A4: grid step lower bound in px, default 4'),
  autonomyW1GridStepMaxPx: Schema.number().default(40).description('W1-1 A4: grid step upper bound in px, default 40'),
  autonomyW1SteadyPollMs: Schema.number().default(150).description('W1-1 A5: steady-gate poll interval in ms, default 150'),
  autonomyW1SteadyTimeoutMs: Schema.number().default(2000).description('W1-1 A5: steady-gate forced-release timeout in ms (records degraded), default 2000'),
  autonomyW1SteadyHamming: Schema.number().default(2).description('W1-1 A5: steady-gate hamming threshold (two consecutive frames <= this = settled), default 2'),
  autonomyW1RowMeansGrid: Schema.number().default(64).description('W1-1 A5: row-means grid for frameRowmeans, default 64'),
  autonomyW1RowShiftSearchRange: Schema.number().default(16).description('W1-1 A5: row-shift search range for estimateRowShift, default 16'),
  autonomyW1FrameGate: Schema.boolean().default(true).description('W2-0: perception-gate (C1 act-expectation no-look gating) wiring — buildAutonomyStack injects the local frameHash port (capture -> dhash; failure => null => honest degrade to full perception). Five-fold AND gate keeps only the narrowest benign no-impact class skippable'),
  autonomyW1GateHammingTolerance: Schema.number().default(3).description('W1-3 C1: gate dHash hamming tolerance (same default 3 as worldSnapshot), default 3'),
  autonomyW1GatePollIntervalMs: Schema.number().default(250).description('W1-3 C1: wait-watch poll interval in ms, default 250'),
  autonomyW1GatePollMaxMs: Schema.number().default(2000).description('W1-3 C1: wait-watch max duration in ms (then advance with a light observation), default 2000'),
  autonomyW1GateMaxConsecutiveSkips: Schema.number().default(1).description('W1-3 C1: max consecutive perception skips before a forced full perception (bounded freshness for terminal-criteria OCR), default 1'),
  vlmZoomVerify: Schema.boolean().default(true).description('W1-8 P3: zoom re-verify verifyClient wiring (registered into the kernel registry as grounding.verifyZoom): low-confidence / small-target / dense-neighborhood groundings get a selective zoom re-grounding + OCR cross-check; off => trigger events degrade to port-absent and pass through'),
  somSparseBudget: Schema.number().default(0).description('W1-7 P4: sparse SoM marking budget (Top-K cap); 0 (default) = full marking (OFF — flipping the sparse default changes the existing annotation output surface; keep off until the evidence chain is battle-tested)'),
  // ─── 纪元 W2（第二批器官 · W3-0 集成接线） ───
  vlmProviderTiers: Schema.string().default('').description('W2-8 C2: CSV provider-tier map for the failover pool tier roster (e.g. "ollama=cheap,siliconflow=cheap"; tier = cheap|primary; keys are pool provider ids) feeding the cost-cascade cheap arm; empty (default) = no cheap tier, cascade always abstains (zero behavior change)'),
  vlmCascadeDangerMax: Schema.number().default(0.35).description('W2-8 C2: cost-cascade triage danger ceiling (0~1): danger <= this tries the deterministically-validated cheap arm before the primary; default 0.35 with the wiring-time conservative static factors (medium risk / unfamiliar scene / neutral confidence => danger 0.6) keeps the cascade abstaining (fail-safe: no evidence, no cheapening)'),
  recoveryEfficacyPath: Schema.string().default('').description('W2-5: recovery-efficacy ledger JSON path (atomic tmp+rename): Beta posteriors per (syndrome x root-cause x recovery action) restored on load, auto-persisted on episode close, saved on unload; empty (default) = memory only'),
  // ─── 纪元 W3（第三批器官 · W4-0 集成接线） ───
  enableExploration: Schema.boolean().default(false).description('W4-0: exploration frontier (W3-7 R2) — buildAutonomyStack mints an ExplorationLedger into deps.exploration (UCB frontier advice on the recovery escalate branch + per-step observe bookkeeping); false (default) = port absent, byte-identical legacy escalate path'),
  explorationPersistPath: Schema.string().default('').description('W4-0: exploration-ledger standalone persistence path (JSON, tmp+fsync+rename, never touches checkpoint); empty (default) = memory only (cross-session exploration memory honestly lost)'),
  autonomySteerEnabled: Schema.boolean().default(false).description('W4-0: in-loop living-intent drift consumption (W3-5 H2) — driveLoop asks createSteerSession.maybeCheckAndAsk each step (stepIndex + latest calibrated entropy); a question mints a steer-drift escalation for the model to relay; false (default) = whole section skipped (zero-regression red line)'),
  orchestratorParallel: Schema.boolean().default(false).description('W4-0: start_complex_task ready-layer parallelism (W3-4 G2) — passed through as RunOrchestratorOptions.parallel (actual parallelism still needs a Kahn ready layer with >=2 independent subtasks AND team headroom); false (default) = serial spine, byte-identical'),
  // ─── 纪元 W4（第四批器官 · W5-0 集成接线） ───
  enableReversibilityLanes: Schema.boolean().default(false).description('W4-3 S5: dispatch lanes by reversibility level — click/type/drag tools classify the intent (reversibilityRegistry.classify) BEFORE dispatch: reversible = fast lane, compensable = escrow lane (mint a reversal plan BEFORE approval.beginAttempt on dangerous+token paths; non-enforcement paths annotate only), irreversible = hand control back to the HUMAN (no automated dispatch). Unknown-semantics actions are left to the existing danger-word gate (classification-knowledge absence is not a lane verdict). false (default) = byte-identical legacy path'),
  enableStepAuction: Schema.boolean().default(false).description('W4-7 G5: step-auction market for sub-agents — per-agent maxSteps becomes a shared pool re-auctioned every K charged steps (convergence evidence aggregated from experience crystals by birth-scene fingerprint); false (default) = per-agent maxSteps budgets, byte-identical'),
  stepAuctionBudget: Schema.number().default(0).description('W4-7 G5: explicit total step-pool budget for the auction market; 0 (default) = derived from the roster (sum of maxSteps — total budget equivalent to the status quo)'),
});
