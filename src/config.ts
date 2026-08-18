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
});
