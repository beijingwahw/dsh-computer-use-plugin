// src/config.ts
// DSH 规范：「两个部署可能想要不同值的一切都必须是配置字段」。
// 原项目地层中散落的全部魔法数字（1280/1440、q60/q75、窗口=3、熔断=3、1000 字符）
// 在此统一收敛为带默认值的配置。
import Schema from '@deepseek-ai/schemastery';
// ΤΕΛ-8b（D-G25① 收口）：federationEpsilon 的域上界单源对接 —— 从 federation 侧
// 导入 PRIVACY_BUDGET_EPSILON_TOTAL（ΠΑΝ-70 的 validFederationEpsilon 判据参数，
// sync/mint 入口已按它 fail-closed）。config 层前置校验共用同一上界：federation
// 侧将来收紧总预算而 config 未跟 ⇒ 域外值在装载期即被拒（配置面不撒谎），绝不
// 出现「config 放行 / federation 拒铸」的两处立法漂移。无环：digest 仅依赖
// dialects/random，不回指本模块。
import { PRIVACY_BUDGET_EPSILON_TOTAL } from './federation/digest.js';
const bNum = (min, max) => {
    const s = Schema.number();
    return s.min(min).max(max);
};
export const Config = Schema.object({
    // ΠΑΝ-105：数值字段全量加域（bNum(min,max) —— 域表与立法注释见文件头）
    mouseSpeed: bNum(1, 600_000).default(1500).description('nut-js mouseSpeed(ms), larger = more human-like'),
    compressWidth: bNum(320, 7680).default(1440).description('Screenshot resize width in px'),
    jpegQuality: bNum(1, 100).default(75).description('JPEG quality 0-100'),
    gridDivisions: bNum(0, 64).default(10).description('SoM grid divisions per axis, 0 disables'),
    maxImageCount: bNum(1, 32).default(3).description('Sliding-window: max real images kept in context'),
    maxConsecutiveFailures: bNum(1, 100).default(3).description('Circuit breaker threshold'),
    maxTextLength: bNum(1, 100_000).default(1000).description('Max chars per type_text call'),
    enableElementIdMode: Schema.boolean().default(false).description('Enable element-ID addressing (needs accessibility provider)'),
    localVisionApi: Schema.string().default('').description('Local vision model endpoint, empty = disabled'),
    verifyActions: Schema.boolean().default(true).description('dHash before/after effect verification'),
    actionSettleMs: bNum(0, 60_000).default(400).description('Wait ms after action before after-hash'),
    noopSimilarityThreshold: bNum(0, 1).default(0.97).description('Similarity above this = likely no-op'),
    autoRemember: Schema.boolean().default(true).description('Auto-save verified clicks to UI memory'),
    enableUIMemory: Schema.boolean().default(true).description('Enable remember_ui / recall_ui tools'),
    uiMemoryCapacity: bNum(1, 100_000).default(200).description('UI memory capacity'),
    enableJournal: Schema.boolean().default(true).description('Enable action journal & replay'),
    journalPath: Schema.string().default('').description('JSONL journal path, empty = memory only'),
    replayMaxSteps: bNum(1, 10_000).default(100).description('Max steps per replay'),
    dryRun: Schema.boolean().default(false).description('Dry-run: log actions without executing'),
    stableScreenDistance: bNum(0, 64).default(3).description('Change-gate: dHash distance <= this = screen unchanged'),
    adaptiveSettle: Schema.boolean().default(true).description('Poll until screen settles before verifying effects'),
    regionVerifyRadius: bNum(0, 0.5).default(0.15).description('Region-verify radius as screen fraction; 0 = off'),
    focusMaxAgeMs: bNum(0, 3_600_000).default(30000).description('Focus validity window for region verification'),
    // ΑΝΒ-4（D5-C 能力腿）：缺省 true —— read_text/find_text 部署首日即在场（部署陷阱
    // 根除；本地推理零 API 成本；缺席披露制度见文件尾 CONFIG_GATED_TOOLS 册）
    enableOcr: Schema.boolean().default(true).description('Enable local OCR (read_text/find_text + semantic verification). Default ON since ANB-4: pure local capability, zero API cost — the old default-off made read_text/find_text unreachable on day one with zero warning; set false to opt out'),
    ocrLang: Schema.string().default('eng').description('OCR language, e.g. eng / chi_sim+eng'),
    typeFocusGuard: Schema.boolean().default(true).description('R2-3 type_text pre-focus guard: before typing, read the foreground window title; if it matches the host-window markers, auto refocus the last switched target window, and fail honestly (never type) when refocus is impossible — prevents typing into the agent host chat box (next-turn prompt pollution)'),
    hostWindowMarkersCsv: Schema.string().default('dsh,deepseek harness').description('R2-3 host-window markers (CSV, case-insensitive substring against the foreground title); empty = built-in defaults. Override when the host build renames its window'),
    enableInteractivityProbe: Schema.boolean().default(true).description('Hover-probe OCR hits (cursor shape + hover repaint) so conversation text is never mistaken for a clickable entry'),
    probeDwellMs: bNum(1, 10_000).default(350).description('Probe hover dwell in ms'),
    probeRegionRadius: bNum(0.001, 0.5).default(0.06).description('Probe region-hash radius as screen fraction'),
    probeRepaintThreshold: bNum(0.5, 1).default(0.985).description('Region similarity below this during hover = repaint detected'),
    probeMaxTargets: bNum(0, 64).default(4).description('Max find_text hits probed per call'),
    enableProbeMemory: Schema.boolean().default(true).description('Memoize probe verdicts per scene fingerprint; repeat scenes reuse verdicts with zero experiments'),
    probeMemoryTtlMs: bNum(0, 86_400_000).default(300000).description('Probe-verdict memory TTL in ms'),
    probeMemoryCapacity: bNum(1, 100_000).default(128).description('Probe-verdict memory capacity (LRU)'),
    probeMemorySceneSimilarity: bNum(0, 1).default(0.9).description('Scene-fingerprint similarity required to recall a verdict'),
    probeRecallRadius: bNum(0.0001, 0.5).default(0.015).description('Normalized point-distance radius for verdict recall (OCR bbox jitter tolerance)'),
    enableOpenUrl: Schema.boolean().default(true).description('open_url tool: URL sensing (extract/normalize/scheme allowlist) + jump via the OS default browser'),
    enableSkillLibrary: Schema.boolean().default(true).description('Self-evolving skill library (induce/match/run)'),
    skillLibraryPath: Schema.string().default('').description('Skill library JSON path; empty = memory only. Set a path for cross-session learning'),
    autoInduceSkills: Schema.boolean().default(true).description('Auto-induce skills from successful complex tasks'),
    enableRiskGate: Schema.boolean().default(true).description('Risk gate: credentials are typed by the user, not the agent'),
    riskPatterns: Schema.string().default('password,passwd,密码,口令,验证码,verification code,2fa,otp,pin,secret,token,api key,私钥').description('Comma-separated risk keywords'),
    enableApprovalGate: Schema.boolean().default(true).description('Approval gate: irreversible actions need a one-shot token from request_approval'),
    dangerPatterns: Schema.string().default('send,发送,delete,删除,remove,移除,pay,支付,付款,buy,购买,checkout,结算,下单,submit order,提交订单,confirm,确认订单,format,格式化,erase,抹掉,uninstall,卸载,reset,重置,清空,withdraw,提现,transfer,转账').description('Comma-separated irreversible-action keywords triggering approval'),
    approvalTokenTtlMs: bNum(1000, 86_400_000).default(600000).description('Approval-token TTL (ms). ONE user consent covers the whole task retry window; each failed attempt re-arms it (capped at 3x TTL from mint)'),
    approvalMaxAttempts: bNum(1, 100).default(5).description('Max physical attempts per approval token: failed (unverified) clicks retry under the same consent without re-asking; beyond this a fresh approval is required'),
    // ─── W6R（安全收口）：危险令牌路径的验证旁路双重逃生门 ───
    allowUnverifiedDangerous: Schema.boolean().default(false).description('DANGEROUS (risk flag, default false): allow dangerous (approval-token / beginAttempt-consume) actions to dispatch when effect verification is unavailable (verifyActions=false), the grounding freshness probe is absent/failed, or the canary probe is absent/failed on a token-bearing call. false (default) = fail-closed at all three points. true = explicit escape hatch restoring degraded pass-through / legacy unverified-dispatch-consumed dialect (verification bypass additionally requires verifyActions=false — two explicit keys). Irreversible actions may then execute unverified — only for deployments that explicitly accept that risk.'),
    enableTelemetry: Schema.boolean().default(true).description('Telemetry: per-tool success/no-op rates, latency percentiles, memory hit rates'),
    checkpointPath: Schema.string().default('').description('Cognitive-state checkpoint JSON (atomic). Auto-restore on start, auto-save on unload. Empty = disabled'),
    // ─── 创世纪（B-5~B-8） ───
    visionApiTimeoutMs: bNum(100, 600_000).default(5000).description('Timeout (ms) for the local vision API. Fail fast instead of hanging the agent'),
    enableLegacySummary: Schema.boolean().default(true).description('OCR the evicted screenshot into a short text summary so old frames keep semantic content'),
    legacySummaryMaxChars: bNum(1, 10_000).default(200).description('Character budget for legacy summaries (prevents OCR text from flooding context)'),
    maxContextImageKb: bNum(1, 100_000).default(600).description('Hard budget (KB) for cumulative in-context image bytes; combined with maxImageCount'),
    popupKeywords: Schema.string().default('cookie,allow,accept,confirm,登录,订阅,update,install,allow notifications,trial,upgrade now,subscribe,accept all,agree').description('Comma-separated keywords: OCR hit in the center region confirms a popup semantically'),
    // ─── 认知升维（C-1~C-5） ───
    intentVerify: Schema.boolean().default(true).description('Intent-aware verification: actions may carry expected_effect; a physics rule engine then seeks evidence (no expectation = zero behavior change)'),
    physicsRules: Schema.string().default('').description('Comma-separated physics-rule kinds to enable (toggle_on,toggle_off,menu_expand,menu_collapse,scroll_content_up,scroll_content_down,input_focus); empty = all'),
    enableRecombination: Schema.boolean().default(true).description('Skill DNA recombination: synthesize new skills from gene segments when match_skill finds nothing'),
    salienceFocus: Schema.boolean().default(true).description('Cognitive-focus engine: salience-driven eviction + task-goal pinning (off = plain FIFO)'),
    pinBudget: bNum(0, 32).default(1).description('Max pinned screenshots (prevents pin-everything from breaking the dual budget)'),
    subconsciousCapacity: bNum(0, 4096).default(32).description('Subconscious pool capacity (evicted records compressed to (hash,gist) tuples); 0 disables flashback'),
    subconsciousMatchDistance: bNum(0, 64).default(6).description('Déjà-vu trigger threshold (dHash hamming distance) for subconscious flashback'),
    swarmEndpoint: Schema.string().default('').description('Swarm-intelligence center endpoint; empty = zero network (local experience crystals still work)'),
    swarmSyncIntervalMs: bNum(1000, 86_400_000).default(300000).description('Swarm sync interval (ms); upload is async fire-and-forget, never blocks the hot path'),
    crystalCapacity: bNum(1, 100_000).default(500).description('Experience-crystal capacity (aggregated from the journal chain)'),
    // ─── 第四维（D-1） ───
    enableSubAgents: Schema.boolean().default(true).description('Multi-agent swarm: spawn role-based sub-agents via swarm_dispatch (one body, many minds)'),
    maxSubAgents: bNum(1, 64).default(3).description('Hard cap on concurrent sub-agents; excess spawn attempts are rejected'),
    agentRoundSteps: bNum(1, 10_000).default(10).description('Per-agent action-step budget reminder line (surface via swarm_dispatch status)'),
    // ─── 第四维（D-2） ───
    enableEnvironmentShaper: Schema.boolean().default(true).description('Environment shaping: reshape the workspace (raise/maximize/move/zoom) with a LIFO undo log; zero behavior when capability set is empty'),
    shaperAutoRestore: Schema.boolean().default(true).description('Auto restoreAll on unload — the power to change the world comes with the duty to restore it'),
    shaperAllowSystemWide: Schema.boolean().default(false).description('Gate for system-wide changes (set_contrast); disabled by default'),
    // ─── 第四维（D-3） ───
    enableQuantumSense: Schema.boolean().default(true).description('Quantum sensing: after N consecutive verified failures, enter superposition — whitebox annotations are burned into the screenshot, keeping the decision surface purely visual; zero behavior without a whitebox provider'),
    degradeAfterFailures: bNum(1, 1000).default(3).description('Consecutive verified-effect failures before degrading to superposition (hard evidence only)'),
    quantumRestoreOnSuccess: bNum(1, 1000).default(2).description('Consecutive verified successes in superposition before reverting to pure vision'),
    quantumMaxNodes: bNum(0, 500).default(30).description('Max whitebox annotation nodes per screenshot (token discipline)'),
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
    vlmFallbackProviders: Schema.string().default('').description('R3-2: CSV fallback platform chain (e.g. "anthropic,gemini") minted into a failover pool behind the primary; each segment may carry a per-brain model override as "id=model" (e.g. "glm=glm-4v-flash" - explicit model beats the registry preset default; keys still resolve via each platform env); empty = no pool'),
    // ─── 纪元 Λ（开箱即亮） ───
    vlmAutoAdoptLocal: Schema.boolean().default(true).description('When NO vision brain is configured at all (no config, no env), auto-adopt a local zero-key vision service (Ollama/LM Studio/vLLM loopback probe, 1.5s budget each); off = skip straight to the wizard'),
    vlmOnboardingEnabled: Schema.boolean().default(true).description('When NO vision model is resolvable at all (no archive, no local service, no env), pop up the local connection wizard page (loopback HTTP server + default browser); off = stay dark until manual configuration'),
    vlmOnboardingPort: bNum(1, 65_535).default(18432).description('Default port for the connection wizard server (falls back +1 up to +8 when occupied)'),
    // ─── 纪元 Φ（自主智能环） ───
    autonomyEnabled: Schema.boolean().default(false).description('Enable the autonomous loop meta-tool (autonomous_run): goal -> perceive -> judge -> constitution -> execute -> verify -> evolve. Off = tool not mounted'),
    autonomyMaxSteps: bNum(1, 1000).default(24).description('Autonomous loop per-run step cap (both the loop fuse and the constitution hard stop), default 24'),
    autonomyTimeBudgetSec: bNum(1, 86_400).default(300).description('Autonomous loop per-run wall-clock budget in seconds, default 300'),
    autonomyAllowTiers: Schema.string().default('benign').description('CSV of risk tiers allowed to run autonomously without approval (values: benign, sensitive; destructive is always constitution-gated), default "benign"'),
    autonomyVlmWhenUncertain: Schema.boolean().default(true).description('Consult the GLM cortex when element matching is low-confidence or tied (PolicyEngine uncertainty arbitration), default true'),
    autonomyForbiddenKeywords: Schema.string().default('').description('CSV of extra danger keywords appended to the autonomy constitution scan list (goal/target/payload text scan), empty = none'),
    autonomyTracePath: Schema.string().default('').description('Append-only JSONL trace path for autonomous runs (begin/step/finish event lines replayed on load) enabling autonomy_resume across processes; empty = in-memory only (resume tokens live and die with the process)'),
    // ─── 纪元 Ξ（Ξ-A 进化存档与进化编排） ───
    kernelStatePath: Schema.string().default('').description('Kernel evolution-state JSON path (atomic tmp+rename write): params/evidence/generations carried across sessions (restored on load, saved on unload and after evolution ticks); empty = memory only'),
    kernelEvolutionEnabled: Schema.boolean().default(false).description('Master switch for production kernel evolution: throttled calibrator ticks on user-message hooks; false (default) = bookkeeping only, zero behavior change'),
    // ─── 地基速修（P1） ───
    ioTimeoutMs: bNum(0, 3_600_000).default(15000).description('ioMutex per-IO queue/execution timeout (ms): a hung physical call no longer blocks the global queue forever; 0 = wait forever (legacy behavior)'),
    // ΤΕΛ-8c（D-G30 收口）：缺省串补齐 ctrl+shift+esc,alt+space 两键 —— 与
    // system.hotkeyPolicy 的装载期补全 withPan10DefaultAdditions 收敛同一生效缺省
    //（字面与该模块 canonical 完全一致 ⇒ 补全函数自此对缺省路径自动变 no-op，
    // 幂等兜底保留防镜像漂移）；显式配置（含显式空串=明示不设防）逐字节生效不被越权。
    hotkeyBlacklist: Schema.string().default('alt+f4,meta,meta+l,meta+r,meta+d,win,cmd+q,ctrl+alt+delete,ctrl+shift+esc,alt+space').description('Comma-separated system-hotkey blacklist (lowercase key names): press_hotkey matches are rejected outright (window-close / OS-shell escape moves: alt+f4, meta/win, ctrl+alt+delete, ctrl+shift+esc task manager, alt+space window menu)'),
    // ─── 纪元 Ρ（双钥公证锁） ───
    enableNotarizationLock: Schema.boolean().default(true).description('Two-key semantic notarization for irreversible actions: OCR-read label + whitebox control name + model self-description — ANY channel seeing danger blocks (fail-heavy); channels absent degrade honestly to legacy single-channel behavior'),
    notarySemanticHandshake: Schema.boolean().default(true).description('Semantic handshake: the OCR-read label at the click point must agree with the model description, otherwise reject and demand re-description (defeats injection lying about the target)'),
    // ─── 纪元 Γ（注视经济） ───
    foveatedEncoding: Schema.boolean().default(false).description('Foveated encoding: center region at native resolution, periphery downsampled — maximize information gain per VLM token; false (default) = uniform encoding (legacy)'),
    foveaSize: bNum(0.01, 1).default(0.5).description('Fovea window edge as a fraction of the encoded image (square), default 0.5'),
    foveaPeripheryScale: bNum(1, 16).default(2).description('Periphery downsampling factor (>1: periphery shrunk by this factor then scaled back into place), default 2'),
    // ─── 纪元 Υ（认知睡眠周期） ───
    enableSleepCycle: Schema.boolean().default(false).description('Cognitive sleep cycle: on session end run the six-act offline consolidation (replay -> distill -> immune -> calibrate -> audit -> morning report); fully offline, idempotent via watermark'),
    sleepTracePath: Schema.string().default('').description('Sleep watermark + morning-report JSONL path; empty = memory only (cross-process idempotency lost)'),
    // ─── 纪元 Η（认识论闭环） ───
    enableEpistemicGate: Schema.boolean().default(true).description('Epistemic gate in the autonomy loop: calibrated confidence x error-cost adjudicates proceed/ask_human/abort BEFORE the constitution check (the agent asks for help at mathematically justified moments)'),
    // ─── 纪元 Κ（惊异课程） ───
    curriculumEnabled: Schema.boolean().default(false).description('Surprise-driven curriculum: gym world generation samples proportional to the production worldModel surprise spectrum, P(world) ~ exp(beta*surprise); false (default) = uniform (legacy)'),
    curriculumBeta: bNum(0, 10).default(1).description('Surprise-curriculum temperature beta: higher = more concentration on high-surprise scenes, default 1.0'),
    // ─── 纪元 Π（行为公证账本） ───
    notaryEndpoint: Schema.string().default('').description('RFC 3161 timestamp-authority (TSA) endpoint; empty = local-time anchors only (honestly labeled source:local, zero network)'),
    notaryTracePath: Schema.string().default('').description('Append-only JSONL path for anchor records (tolerant of torn last lines); empty = memory only (anchor chain lost across processes)'),
    notaryAutoAnchor: Schema.boolean().default(false).description('Automatically mint one anchor (chain tip + MMR root + timestamp) for the journal on unload; false (default) = notarize only manually via the quality_checkup notarize action'),
    // ─── 纪元 Μ（万脑联邦进化） ───
    federationEndpoint: Schema.string().default('').description('Federation aggregation endpoint; empty = zero network (local mint/merge/apply still fully functional for multi-process and test use)'),
    federationEpsilon: bNum(0.001, PRIVACY_BUDGET_EPSILON_TOTAL).default(1).description('Differential-privacy epsilon for federated evidence digests (Laplace count noise; same default of 1 as the swarm experience crystals). Valid domain (0, total privacy budget] is single-sourced from federation (validFederationEpsilon / PRIVACY_BUDGET_EPSILON_TOTAL): out-of-domain values are rejected at config load (fail-loud) and again fail-closed at the federation mint/sync entry (PAN-70); lower bound 0.001 approximates the open interval (schemastery has closed domains only)'),
    federationMaxRemoteShare: bNum(0, 1).default(0.5).description('Cap (0~1) on remote-evidence share per key relative to the local ledger: prevents remote flooding from dominating local calibration; 0.5 = at most half-and-half blending'),
    // ─── 纪元 Ι（自我模型） ───
    enableSelfModel: Schema.boolean().default(true).description('Self-model: decayed Beta competence posteriors per (action-kind x scene-bucket), passive bookkeeping consumed by the epistemic gate and introspection'),
    selfModelMinEvidence: bNum(0, 10_000).default(8).description('Minimum evidence n before the self-model may inform the epistemic gate (honest cold start, no fabricated experience)'),
    selfModelHalfLifeH: bNum(0.1, 100_000).default(168).description('Self-model memory half-life in hours: old outcomes decay exponentially, default 168 (one week)'),
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
    autonomyW1RoiRadiusPx: bNum(1, 4096).default(128).description('W1-1 A2: action-point ROI radius in px (normalized by capture short edge), default 128'),
    autonomyW1RoiHammingTolerance: bNum(0, 64).default(2).description('W1-1 A2: ROI region-hash "changed" hamming threshold (distance > this = changed), default 2'),
    autonomyW1FocusShortcutRadius: bNum(0, 1).default(0.01).description('W1-1 A3: focus shortcut radius (normalized distance <= this skips re-dispatch), default 0.01'),
    autonomyW1LargeBboxPx: bNum(1, 4096).default(96).description('W1-1 A4: large-bbox threshold (long edge >= this => word-centroid landing point), default 96'),
    autonomyW1SmallBboxPx: bNum(0, 4096).default(24).description('W1-1 A4: small-bbox threshold (short edge < this => shrink landing toward center), default 24'),
    autonomyW1SmallShrinkRatio: bNum(0, 1).default(0.2).description('W1-1 A4: small-bbox shrink ratio (0.2 = pull 20 percent toward center), default 0.2'),
    autonomyW1WordMaxAreaRatio: bNum(0, 1).default(0.6).description('W1-1 A4: word-element area cap as a fraction of the target bbox (above = treated as the target itself), default 0.6'),
    autonomyW1ClickRetryMax: bNum(0, 64).default(8).description('W1-1 A4: grid retry cap (3x3 minus center = 8 neighbors; 0 disables grid retry), default 8'),
    autonomyW1GridStepRatio: bNum(0, 1).default(0.25).description('W1-1 A4: grid step as a fraction of the target short edge, default 0.25'),
    autonomyW1GridStepMinPx: bNum(0, 512).default(4).description('W1-1 A4: grid step lower bound in px, default 4'),
    autonomyW1GridStepMaxPx: bNum(1, 4096).default(40).description('W1-1 A4: grid step upper bound in px, default 40'),
    autonomyW1SteadyPollMs: bNum(1, 10_000).default(150).description('W1-1 A5: steady-gate poll interval in ms, default 150'),
    autonomyW1SteadyTimeoutMs: bNum(1, 600_000).default(2000).description('W1-1 A5: steady-gate forced-release timeout in ms (records degraded), default 2000'),
    autonomyW1SteadyHamming: bNum(0, 64).default(2).description('W1-1 A5: steady-gate hamming threshold (two consecutive frames <= this = settled), default 2'),
    autonomyW1RowMeansGrid: bNum(1, 8192).default(64).description('W1-1 A5: row-means grid for frameRowmeans, default 64'),
    autonomyW1RowShiftSearchRange: bNum(1, 4096).default(16).description('W1-1 A5: row-shift search range for estimateRowShift, default 16'),
    autonomyW1FrameGate: Schema.boolean().default(true).description('W2-0: perception-gate (C1 act-expectation no-look gating) wiring — buildAutonomyStack injects the local frameHash port (capture -> dhash; failure => null => honest degrade to full perception). Five-fold AND gate keeps only the narrowest benign no-impact class skippable'),
    autonomyW1GateHammingTolerance: bNum(0, 64).default(3).description('W1-3 C1: gate dHash hamming tolerance (same default 3 as worldSnapshot), default 3'),
    autonomyW1GatePollIntervalMs: bNum(1, 60_000).default(250).description('W1-3 C1: wait-watch poll interval in ms, default 250'),
    autonomyW1GatePollMaxMs: bNum(1, 600_000).default(2000).description('W1-3 C1: wait-watch max duration in ms (then advance with a light observation), default 2000'),
    autonomyW1GateMaxConsecutiveSkips: bNum(0, 100).default(1).description('W1-3 C1: max consecutive perception skips before a forced full perception (bounded freshness for terminal-criteria OCR), default 1'),
    vlmZoomVerify: Schema.boolean().default(true).description('W1-8 P3: zoom re-verify verifyClient wiring (registered into the kernel registry as grounding.verifyZoom): low-confidence / small-target / dense-neighborhood groundings get a selective zoom re-grounding + OCR cross-check; off => trigger events degrade to port-absent and pass through'),
    somSparseBudget: bNum(0, 4096).default(0).description('W1-7 P4: sparse SoM marking budget (Top-K cap); 0 (default) = full marking (OFF — flipping the sparse default changes the existing annotation output surface; keep off until the evidence chain is battle-tested)'),
    // ─── 纪元 W2（第二批器官 · W3-0 集成接线） ───
    vlmProviderTiers: Schema.string().default('').description('W2-8 C2: CSV provider-tier map for the failover pool tier roster (e.g. "ollama=cheap,siliconflow=cheap"; tier = cheap|primary; keys are pool provider ids) feeding the cost-cascade cheap arm; empty (default) = no cheap tier, cascade always abstains (zero behavior change)'),
    vlmCascadeDangerMax: bNum(0, 1).default(0.35).description('W2-8 C2: cost-cascade triage danger ceiling (0~1): danger <= this tries the deterministically-validated cheap arm before the primary; default 0.35 with the wiring-time conservative static factors (medium risk / unfamiliar scene / neutral confidence => danger 0.6) keeps the cascade abstaining (fail-safe: no evidence, no cheapening)'),
    recoveryEfficacyPath: Schema.string().default('').description('W2-5: recovery-efficacy ledger JSON path (atomic tmp+rename): Beta posteriors per (syndrome x root-cause x recovery action) restored on load, auto-persisted on episode close, saved on unload; empty (default) = memory only'),
    // ─── 纪元 W3（第三批器官 · W4-0 集成接线） ───
    enableExploration: Schema.boolean().default(false).description('W4-0: exploration frontier (W3-7 R2) — buildAutonomyStack mints an ExplorationLedger into deps.exploration (UCB frontier advice on the recovery escalate branch + per-step observe bookkeeping); false (default) = port absent, byte-identical legacy escalate path'),
    explorationPersistPath: Schema.string().default('').description('W4-0: exploration-ledger standalone persistence path (JSON, tmp+fsync+rename, never touches checkpoint); empty (default) = memory only (cross-session exploration memory honestly lost)'),
    autonomySteerEnabled: Schema.boolean().default(false).description('W4-0: in-loop living-intent drift consumption (W3-5 H2) — driveLoop asks createSteerSession.maybeCheckAndAsk each step (stepIndex + latest calibrated entropy); a question mints a steer-drift escalation for the model to relay; false (default) = whole section skipped (zero-regression red line)'),
    orchestratorParallel: Schema.boolean().default(false).description('W4-0: start_complex_task ready-layer parallelism (W3-4 G2) — passed through as RunOrchestratorOptions.parallel (actual parallelism still needs a Kahn ready layer with >=2 independent subtasks AND team headroom); false (default) = serial spine, byte-identical'),
    // ─── 纪元 W4（第四批器官 · W5-0 集成接线） ───
    enableReversibilityLanes: Schema.boolean().default(false).description('W4-3 S5: dispatch lanes by reversibility level — click/type/drag tools classify the intent (reversibilityRegistry.classify) BEFORE dispatch: reversible = fast lane, compensable = escrow lane (mint a reversal plan BEFORE approval.beginAttempt on dangerous+token paths; non-enforcement paths annotate only), irreversible = hand control back to the HUMAN (no automated dispatch). Unknown-semantics actions are left to the existing danger-word gate (classification-knowledge absence is not a lane verdict). false (default) = byte-identical legacy path'),
    enableStepAuction: Schema.boolean().default(false).description('W4-7 G5: step-auction market for sub-agents — per-agent maxSteps becomes a shared pool re-auctioned every K charged steps (convergence evidence aggregated from experience crystals by birth-scene fingerprint); false (default) = per-agent maxSteps budgets, byte-identical'),
    stepAuctionBudget: bNum(0, 100_000).default(0).description('W4-7 G5: explicit total step-pool budget for the auction market; 0 (default) = derived from the roster (sum of maxSteps — total budget equivalent to the status quo)'),
    // ─── ΤΕΛ-8a（沙箱栈专属开关 · D-G16① 收口）───
    // 刻意**不设 .default()**（undefined 穿透）：组合根门控为
    // `config.enableSandboxStack ?? config.autonomyEnabled` —— 未设跟随旧门控回退
    //（兼容律），显式 true/false 优先。三态语义全述见 interface 注释。
    enableSandboxStack: Schema.boolean().description('Sandbox stack (rehearse -> consolidate -> replay dojo: 4 tools + 3 event wirings + sandboxLog ledger persistence) root-assembly switch. Tri-state by design (no schema default — unset stays undefined): unset = follow the legacy autonomyEnabled gate (byte-identical compatibility; F2-3 interim gate retired per D-G16-1); explicit true = light up independently of the autonomous loop; explicit false = off regardless of autonomyEnabled (explicit setting wins). Default deployment stays OFF (zero regression)'),
    // ─── ΑΝΒ-7（考核纪律 · 决策 D9 升维）───
    benchDiscipline: Schema.boolean().default(false).description('ANAB-7 (decision D9 upgraded): benchmark discipline — opt-in fail-closed PRE-hoc interception via the host ctx.tools.guard() channel: only plugin tools (50-name closed set, single-sourced with bench/anti-cheat.mjs PLUGIN_TOOL_NAMES) plus host session/meta control-plane tools (host-meta/host-job, e.g. ask_user_question / job_*) may run in this session; host shell / file / run-code and UNKNOWN tools are denied outright (fail-closed: outside the allowlist = blocked). Absent host guard channel degrades honestly (one log line, never throws; enforcement falls back to prompt discipline + post-hoc anti-cheat). Default false = ZERO behavior change. Enabling CHANGES host-session behavior — run the joint-review checklist (C:\\2\\.survey\\practice\\ANAB-7-review.md) first.'),
});
/** ΑΝΒ-4：配置门控工具册（单源立法）。谓词逐门镜像 buildAllTools 的挂载 if。 */
export const CONFIG_GATED_TOOLS = [
    { key: 'enableOcr', tools: ['read_text', 'find_text'], mounted: c => Boolean(c.enableOcr),
        note: 'ΑΝΒ-4 起缺省 true（纯能力面：本地推理零 API 成本）—— 显式 false 才缺席' },
    { key: 'enableElementIdMode', tools: ['click_element'], mounted: c => Boolean(c.enableElementIdMode),
        note: 'opt-in（D5-C）：UIA 无障碍树通道的资源占用姿态' },
    { key: 'localVisionApi', tools: ['extract_ui_vision'], mounted: c => Boolean(c.localVisionApi),
        note: '端点类门：空串 = 关' },
    { key: 'enableUIMemory', tools: ['remember_ui', 'recall_ui'], mounted: c => Boolean(c.enableUIMemory) },
    { key: 'enableJournal', tools: ['replay_actions', 'what_if'], mounted: c => Boolean(c.enableJournal) },
    { key: 'vlmApiKey(+env)', tools: ['ask_screen', 'vlm_platforms'],
        mounted: c => Boolean(c.vlmApiKey), envSensitive: true,
        note: 'env 敏感门：vlmApiKey 或云脑 env（GLM_API_KEY 等）/连接存档在场即挂载' },
    { key: 'autonomyEnabled', tools: ['autonomous_run', 'autonomy_resume', 'steer_choice', 'steer_answer'],
        mounted: c => Boolean(c.autonomyEnabled),
        note: 'opt-in（D5-C）：自主环缺省不放行 —— 安全姿态由主人显式背书' },
    { key: 'enableInteractivityProbe', tools: ['probe_interactivity'], mounted: c => Boolean(c.enableInteractivityProbe) },
    { key: 'enableOpenUrl', tools: ['open_url'], mounted: c => Boolean(c.enableOpenUrl) },
    { key: 'enableSkillLibrary', tools: ['save_skill', 'match_skill', 'run_skill'], mounted: c => Boolean(c.enableSkillLibrary) },
    { key: 'enableQualityDoctor', tools: ['quality_checkup'], mounted: c => Boolean(c.enableQualityDoctor) },
    { key: 'enableSubAgents', tools: ['swarm_dispatch'], mounted: c => Boolean(c.enableSubAgents) },
    { key: 'enableEnvironmentShaper', tools: ['shape_environment'], mounted: c => Boolean(c.enableEnvironmentShaper) },
    { key: 'enableApprovalGate', tools: ['request_approval', 'grant_approval', 'adjudicate_approval_queue'],
        mounted: c => Boolean(c.enableApprovalGate) },
    { key: 'enableTelemetry', tools: ['get_metrics', 'verify_journal', 'self_diagnose'], mounted: c => Boolean(c.enableTelemetry) },
    { key: 'checkpointPath', tools: ['save_checkpoint'], mounted: c => Boolean(c.checkpointPath),
        note: '端点类门：空串 = 关（快照无处可落）' },
    { key: 'kernelEvolutionEnabled||federationEndpoint', tools: ['federation_sync'],
        mounted: c => Boolean(c.kernelEvolutionEnabled) || c.federationEndpoint !== '',
        note: '复合门：进化语境或显式联邦 opt-in 任一即挂载' },
    { key: 'enableSandboxStack??autonomyEnabled', tools: ['rehearse_chain', 'recall_muscle', 'replay_on_host', 'verify_sandbox_log'],
        mounted: c => Boolean(c.enableSandboxStack ?? c.autonomyEnabled),
        note: '三态门（ΤΕΛ-8a）：未设跟随 autonomyEnabled 旧门控；工具经 applySandboxStack 装配（非桶）' },
];
/** ΑΝΒ-4：预测面缺席（医生视角）—— 纯 config 谓词求值，无装配观察。
 *  env 敏感门在 envView.vlmLive 为真时视为开（config 字面关 + env 在场 = 已挂载）。 */
export function predictConfigToolAbsence(config, envView = {}) {
    const out = [];
    for (const gate of CONFIG_GATED_TOOLS) {
        const on = gate.envSensitive
            ? gate.mounted(config) || envView.vlmLive === true
            : gate.mounted(config);
        if (!on)
            out.push({ key: gate.key, tools: gate.tools, gateOn: false, ...(gate.note ? { note: gate.note } : {}) });
    }
    return out;
}
/** ΑΝΒ-4：观察面缺席（组合根视角）—— 拿真实挂载名集对账：册上工具凡不在
 *  mountedNames 即缺席（连「门开但装配失败」也如实可见，gateOn 供分诊）。
 *  extraMounted = 桶外装配面（如 applySandboxStack 的四件演武工具）的挂载名。 */
export function observeToolFaceAbsence(mountedNames, config, envView = {}) {
    const seen = mountedNames instanceof Set ? mountedNames : new Set(mountedNames);
    const out = [];
    for (const gate of CONFIG_GATED_TOOLS) {
        const absent = gate.tools.filter(t => !seen.has(t));
        if (absent.length === 0)
            continue;
        const on = gate.envSensitive
            ? gate.mounted(config) || envView.vlmLive === true
            : gate.mounted(config);
        out.push({ key: gate.key, tools: absent, gateOn: on, ...(gate.note ? { note: gate.note } : {}) });
    }
    return out;
}
/** ΑΝΒ-4：会话披露状态（单睡单账 —— 每次 apply 装配完成时整账重写；披露是
 *  观察不是资源，无需入卸载清单，下次 apply 覆写即无跨会话残留语义）。 */
let toolFaceDisclosure = null;
/** ΑΝΒ-4：组合根记账（index.ts 装配完成后调用；防御式绝不抛） */
export function recordToolFaceDisclosure(d) {
    try {
        toolFaceDisclosure = d;
    }
    catch { /* 披露是旁路义务 */ }
}
/** ΑΝΒ-4：观测面读取（get_metrics / metrics_dashboard 消费；未记账 = null 诚实缺席） */
export function getToolFaceDisclosure() {
    return toolFaceDisclosure;
}
