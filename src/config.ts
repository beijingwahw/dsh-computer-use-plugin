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
  enableSkillLibrary: Schema.boolean().default(true).description('Self-evolving skill library (induce/match/run)'),
  skillLibraryPath: Schema.string().default('').description('Skill library JSON path; empty = memory only. Set a path for cross-session learning'),
  autoInduceSkills: Schema.boolean().default(true).description('Auto-induce skills from successful complex tasks'),
  enableRiskGate: Schema.boolean().default(true).description('Risk gate: credentials are typed by the user, not the agent'),
  riskPatterns: Schema.string().default('password,passwd,密码,口令,验证码,verification code,2fa,otp,pin,secret,token,api key,私钥').description('Comma-separated risk keywords'),
  enableApprovalGate: Schema.boolean().default(true).description('Approval gate: irreversible actions need a one-shot token from request_approval'),
  dangerPatterns: Schema.string().default('send,发送,delete,删除,remove,移除,pay,支付,付款,buy,购买,checkout,结算,下单,submit order,提交订单,confirm,确认订单,format,格式化,erase,抹掉,uninstall,卸载,reset,重置,清空,withdraw,提现,transfer,转账').description('Comma-separated irreversible-action keywords triggering approval'),
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
});
