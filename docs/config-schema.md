# 配置字段总表（config-schema）

> 本文件由 `scripts/gen_config_docs.mjs` 从 `src/config.ts` 的 Config Schema 自动生成，请勿手改（重跑即重铸）。
> 生成命令：`node --import ./test/register.mjs scripts/gen_config_docs.mjs`

共 154 个配置字段。

| 键 | 类型 | 缺省 | 描述 |
| --- | --- | --- | --- |
| mouseSpeed | number | 1500 | nut-js mouseSpeed(ms), larger = more human-like |
| compressWidth | number | 1440 | Screenshot resize width in px |
| jpegQuality | number | 75 | JPEG quality 0-100 |
| gridDivisions | number | 10 | SoM grid divisions per axis, 0 disables |
| maxImageCount | number | 3 | Sliding-window: max real images kept in context |
| maxConsecutiveFailures | number | 3 | Circuit breaker threshold |
| maxTextLength | number | 1000 | Max chars per type_text call |
| enableElementIdMode | boolean | false | Enable element-ID addressing (needs accessibility provider) |
| localVisionApi | string | "" | Local vision model endpoint, empty = disabled |
| verifyActions | boolean | true | dHash before/after effect verification |
| actionSettleMs | number | 400 | Wait ms after action before after-hash |
| noopSimilarityThreshold | number | 0.97 | Similarity above this = likely no-op |
| autoRemember | boolean | true | Auto-save verified clicks to UI memory |
| enableUIMemory | boolean | true | Enable remember_ui / recall_ui tools |
| uiMemoryCapacity | number | 200 | UI memory capacity |
| enableJournal | boolean | true | Enable action journal & replay |
| journalPath | string | "" | JSONL journal path, empty = memory only |
| replayMaxSteps | number | 100 | Max steps per replay |
| dryRun | boolean | false | Dry-run: log actions without executing |
| stableScreenDistance | number | 3 | Change-gate: dHash distance <= this = screen unchanged |
| adaptiveSettle | boolean | true | Poll until screen settles before verifying effects |
| regionVerifyRadius | number | 0.15 | Region-verify radius as screen fraction; 0 = off |
| focusMaxAgeMs | number | 30000 | Focus validity window for region verification |
| enableOcr | boolean | false | Enable local OCR (read_text/find_text + semantic verification) |
| ocrLang | string | "eng" | OCR language, e.g. eng / chi_sim+eng |
| enableInteractivityProbe | boolean | true | Hover-probe OCR hits (cursor shape + hover repaint) so conversation text is never mistaken for a clickable entry |
| probeDwellMs | number | 350 | Probe hover dwell in ms |
| probeRegionRadius | number | 0.06 | Probe region-hash radius as screen fraction |
| probeRepaintThreshold | number | 0.985 | Region similarity below this during hover = repaint detected |
| probeMaxTargets | number | 4 | Max find_text hits probed per call |
| enableProbeMemory | boolean | true | Memoize probe verdicts per scene fingerprint; repeat scenes reuse verdicts with zero experiments |
| probeMemoryTtlMs | number | 300000 | Probe-verdict memory TTL in ms |
| probeMemoryCapacity | number | 128 | Probe-verdict memory capacity (LRU) |
| probeMemorySceneSimilarity | number | 0.9 | Scene-fingerprint similarity required to recall a verdict |
| probeRecallRadius | number | 0.015 | Normalized point-distance radius for verdict recall (OCR bbox jitter tolerance) |
| enableOpenUrl | boolean | true | open_url tool: URL sensing (extract/normalize/scheme allowlist) + jump via the OS default browser |
| enableSkillLibrary | boolean | true | Self-evolving skill library (induce/match/run) |
| skillLibraryPath | string | "" | Skill library JSON path; empty = memory only. Set a path for cross-session learning |
| autoInduceSkills | boolean | true | Auto-induce skills from successful complex tasks |
| enableRiskGate | boolean | true | Risk gate: credentials are typed by the user, not the agent |
| riskPatterns | string | "password,passwd,密码,口令,验证码,verification code,2fa,otp,pin,secret,token,api key,私钥" | Comma-separated risk keywords |
| enableApprovalGate | boolean | true | Approval gate: irreversible actions need a one-shot token from request_approval |
| dangerPatterns | string | "send,发送,delete,删除,remove,移除,pay,支付,付款,buy,购买,checkout,结算,下单,submit order,提交订单,confirm,确认订单,format,格式化,erase,抹掉,uninstall,卸载,reset,重置,清空,withdraw,提现,transfer,转账" | Comma-separated irreversible-action keywords triggering approval |
| approvalTokenTtlMs | number | 600000 | Approval-token TTL (ms). ONE user consent covers the whole task retry window; each failed attempt re-arms it (capped at 3x TTL from mint) |
| approvalMaxAttempts | number | 5 | Max physical attempts per approval token: failed (unverified) clicks retry under the same consent without re-asking; beyond this a fresh approval is required |
| allowUnverifiedDangerous | boolean | false | DANGEROUS (risk flag, default false): allow dangerous (approval-token / beginAttempt-consume) actions to dispatch when effect verification is unavailable (verifyActions=false), the grounding freshness probe is absent/failed, or the canary probe is absent/failed on a token-bearing call. false (default) = fail-closed at all three points. true = explicit escape hatch restoring degraded pass-through / legacy unverified-dispatch-consumed dialect (verification bypass additionally requires verifyActions=false — two explicit keys). Irreversible actions may then execute unverified — only for deployments that explicitly accept that risk. |
| enableTelemetry | boolean | true | Telemetry: per-tool success/no-op rates, latency percentiles, memory hit rates |
| checkpointPath | string | "" | Cognitive-state checkpoint JSON (atomic). Auto-restore on start, auto-save on unload. Empty = disabled |
| visionApiTimeoutMs | number | 5000 | Timeout (ms) for the local vision API. Fail fast instead of hanging the agent |
| enableLegacySummary | boolean | true | OCR the evicted screenshot into a short text summary so old frames keep semantic content |
| legacySummaryMaxChars | number | 200 | Character budget for legacy summaries (prevents OCR text from flooding context) |
| maxContextImageKb | number | 600 | Hard budget (KB) for cumulative in-context image bytes; combined with maxImageCount |
| popupKeywords | string | "cookie,allow,accept,confirm,登录,订阅,update,install,allow notifications,trial,upgrade now,subscribe,accept all,agree" | Comma-separated keywords: OCR hit in the center region confirms a popup semantically |
| intentVerify | boolean | true | Intent-aware verification: actions may carry expected_effect; a physics rule engine then seeks evidence (no expectation = zero behavior change) |
| physicsRules | string | "" | Comma-separated physics-rule kinds to enable (toggle_on,toggle_off,menu_expand,menu_collapse,scroll_content_up,scroll_content_down,input_focus); empty = all |
| enableRecombination | boolean | true | Skill DNA recombination: synthesize new skills from gene segments when match_skill finds nothing |
| salienceFocus | boolean | true | Cognitive-focus engine: salience-driven eviction + task-goal pinning (off = plain FIFO) |
| pinBudget | number | 1 | Max pinned screenshots (prevents pin-everything from breaking the dual budget) |
| subconsciousCapacity | number | 32 | Subconscious pool capacity (evicted records compressed to (hash,gist) tuples); 0 disables flashback |
| subconsciousMatchDistance | number | 6 | Déjà-vu trigger threshold (dHash hamming distance) for subconscious flashback |
| swarmEndpoint | string | "" | Swarm-intelligence center endpoint; empty = zero network (local experience crystals still work) |
| swarmSyncIntervalMs | number | 300000 | Swarm sync interval (ms); upload is async fire-and-forget, never blocks the hot path |
| crystalCapacity | number | 500 | Experience-crystal capacity (aggregated from the journal chain) |
| enableSubAgents | boolean | true | Multi-agent swarm: spawn role-based sub-agents via swarm_dispatch (one body, many minds) |
| maxSubAgents | number | 3 | Hard cap on concurrent sub-agents; excess spawn attempts are rejected |
| agentRoundSteps | number | 10 | Per-agent action-step budget reminder line (surface via swarm_dispatch status) |
| enableEnvironmentShaper | boolean | true | Environment shaping: reshape the workspace (raise/maximize/move/zoom) with a LIFO undo log; zero behavior when capability set is empty |
| shaperAutoRestore | boolean | true | Auto restoreAll on unload — the power to change the world comes with the duty to restore it |
| shaperAllowSystemWide | boolean | false | Gate for system-wide changes (set_contrast); disabled by default |
| enableQuantumSense | boolean | true | Quantum sensing: after N consecutive verified failures, enter superposition — whitebox annotations are burned into the screenshot, keeping the decision surface purely visual; zero behavior without a whitebox provider |
| degradeAfterFailures | number | 3 | Consecutive verified-effect failures before degrading to superposition (hard evidence only) |
| quantumRestoreOnSuccess | number | 2 | Consecutive verified successes in superposition before reverting to pure vision |
| quantumMaxNodes | number | 30 | Max whitebox annotation nodes per screenshot (token discipline) |
| enableQualityDoctor | boolean | true | Quality Doctor: immune system auditing code genes (iron laws) and causal-chain legality; diagnose is read-only, mechanical fixes need explicit authorization |
| doctorRules | string | "" | Comma-separated rule-ID whitelist (empty = all rules active) |
| doctorStrict | boolean | false | Strict mode: genesis violations surface loudly (CLI exit code 1); never throws |
| doctorMemoryPath | string | "doctor-memory.json" | Evolution-memory file for lessons and baselines (developer asset, not runtime cognition) |
| vlmApiKey | string | "" | GLM vision-model API key; empty = fall back to env (GLM_API_KEY/ZHIPUAI_API_KEY/ZAI_API_KEY). Takes priority over env when set |
| vlmBaseUrl | string | "https://open.bigmodel.cn/api/paas/v4" | GLM OpenAI-compatible base URL |
| vlmModel | string | "glm-5.3-flash" | GLM vision model name |
| vlmAssistOcr | boolean | false | Allow the VLM cloud cortex to read the screen as a third path when BOTH local OCR paths (server L2 + legacy tesseract) fail (semanticConfirm fallback) |
| vlmProvider | string | "" | Vision-model platform id (openai/anthropic/gemini/qwen/moonshot/doubao/xai/siliconflow/openrouter/ollama/lmstudio/vllm/custom; unknown ids are treated as OpenAI-compatible custom endpoints); empty = auto-detect from env (GLM envs first, then each platform envKeys) |
| vlmFallbackProviders | string | "" | CSV fallback platform chain (e.g. "anthropic,gemini") minted into a failover pool behind the primary; empty = no pool |
| vlmAutoAdoptLocal | boolean | true | When NO vision brain is configured at all (no config, no env), auto-adopt a local zero-key vision service (Ollama/LM Studio/vLLM loopback probe, 1.5s budget each); off = skip straight to the wizard |
| vlmOnboardingEnabled | boolean | true | When NO vision model is resolvable at all (no archive, no local service, no env), pop up the local connection wizard page (loopback HTTP server + default browser); off = stay dark until manual configuration |
| vlmOnboardingPort | number | 18432 | Default port for the connection wizard server (falls back +1 up to +8 when occupied) |
| autonomyEnabled | boolean | false | Enable the autonomous loop meta-tool (autonomous_run): goal -> perceive -> judge -> constitution -> execute -> verify -> evolve. Off = tool not mounted |
| autonomyMaxSteps | number | 24 | Autonomous loop per-run step cap (both the loop fuse and the constitution hard stop), default 24 |
| autonomyTimeBudgetSec | number | 300 | Autonomous loop per-run wall-clock budget in seconds, default 300 |
| autonomyAllowTiers | string | "benign" | CSV of risk tiers allowed to run autonomously without approval (values: benign, sensitive; destructive is always constitution-gated), default "benign" |
| autonomyVlmWhenUncertain | boolean | true | Consult the GLM cortex when element matching is low-confidence or tied (PolicyEngine uncertainty arbitration), default true |
| autonomyForbiddenKeywords | string | "" | CSV of extra danger keywords appended to the autonomy constitution scan list (goal/target/payload text scan), empty = none |
| autonomyTracePath | string | "" | Append-only JSONL trace path for autonomous runs (begin/step/finish event lines replayed on load) enabling autonomy_resume across processes; empty = in-memory only (resume tokens live and die with the process) |
| kernelStatePath | string | "" | Kernel evolution-state JSON path (atomic tmp+rename write): params/evidence/generations carried across sessions (restored on load, saved on unload and after evolution ticks); empty = memory only |
| kernelEvolutionEnabled | boolean | false | Master switch for production kernel evolution: throttled calibrator ticks on user-message hooks; false (default) = bookkeeping only, zero behavior change |
| ioTimeoutMs | number | 15000 | ioMutex per-IO queue/execution timeout (ms): a hung physical call no longer blocks the global queue forever; 0 = wait forever (legacy behavior) |
| hotkeyBlacklist | string | "alt+f4,meta,meta+l,meta+r,meta+d,win,cmd+q,ctrl+alt+delete" | Comma-separated system-hotkey blacklist (lowercase key names): press_hotkey matches are rejected outright (window-close / OS-shell escape moves) |
| enableNotarizationLock | boolean | true | Two-key semantic notarization for irreversible actions: OCR-read label + whitebox control name + model self-description — ANY channel seeing danger blocks (fail-heavy); channels absent degrade honestly to legacy single-channel behavior |
| notarySemanticHandshake | boolean | true | Semantic handshake: the OCR-read label at the click point must agree with the model description, otherwise reject and demand re-description (defeats injection lying about the target) |
| foveatedEncoding | boolean | false | Foveated encoding: center region at native resolution, periphery downsampled — maximize information gain per VLM token; false (default) = uniform encoding (legacy) |
| foveaSize | number | 0.5 | Fovea window edge as a fraction of the encoded image (square), default 0.5 |
| foveaPeripheryScale | number | 2 | Periphery downsampling factor (>1: periphery shrunk by this factor then scaled back into place), default 2 |
| enableSleepCycle | boolean | false | Cognitive sleep cycle: on session end run the six-act offline consolidation (replay -> distill -> immune -> calibrate -> audit -> morning report); fully offline, idempotent via watermark |
| sleepTracePath | string | "" | Sleep watermark + morning-report JSONL path; empty = memory only (cross-process idempotency lost) |
| enableEpistemicGate | boolean | true | Epistemic gate in the autonomy loop: calibrated confidence x error-cost adjudicates proceed/ask_human/abort BEFORE the constitution check (the agent asks for help at mathematically justified moments) |
| curriculumEnabled | boolean | false | Surprise-driven curriculum: gym world generation samples proportional to the production worldModel surprise spectrum, P(world) ~ exp(beta*surprise); false (default) = uniform (legacy) |
| curriculumBeta | number | 1 | Surprise-curriculum temperature beta: higher = more concentration on high-surprise scenes, default 1.0 |
| notaryEndpoint | string | "" | RFC 3161 timestamp-authority (TSA) endpoint; empty = local-time anchors only (honestly labeled source:local, zero network) |
| notaryTracePath | string | "" | Append-only JSONL path for anchor records (tolerant of torn last lines); empty = memory only (anchor chain lost across processes) |
| notaryAutoAnchor | boolean | false | Automatically mint one anchor (chain tip + MMR root + timestamp) for the journal on unload; false (default) = notarize only manually via the quality_checkup notarize action |
| federationEndpoint | string | "" | Federation aggregation endpoint; empty = zero network (local mint/merge/apply still fully functional for multi-process and test use) |
| federationEpsilon | number | 1 | Differential-privacy epsilon for federated evidence digests (Laplace count noise; same default of 1 as the swarm experience crystals) |
| federationMaxRemoteShare | number | 0.5 | Cap (0~1) on remote-evidence share per key relative to the local ledger: prevents remote flooding from dominating local calibration; 0.5 = at most half-and-half blending |
| enableSelfModel | boolean | true | Self-model: decayed Beta competence posteriors per (action-kind x scene-bucket), passive bookkeeping consumed by the epistemic gate and introspection |
| selfModelMinEvidence | number | 8 | Minimum evidence n before the self-model may inform the epistemic gate (honest cold start, no fabricated experience) |
| selfModelHalfLifeH | number | 168 | Self-model memory half-life in hours: old outcomes decay exponentially, default 168 (one week) |
| enableDemonstrations | boolean | true | Intervention-as-education: acceptance-consumed approvals strengthen skill trust, denied approvals feed failure memory (never records credential content — action shape and screen fingerprint only) |
| enableProphecy | boolean | true | Prophecy engine: before each autonomy-loop action the world model mints a prediction (expected screen type/effect); after execution the outcome is reconciled and surprise recorded — pure audit bypass, never blocks the action |
| enableRefuteCourt | boolean | true | Refutation court: before a dangerous dispatch a second brain is asked to REFUTE "target = description" — disagreement blocks (activates only with >=2 brains configured; single-brain deployments degrade to zero behavior) |
| enableProbeEconomy | boolean | true | Probe economics: interactivity-probe channel ordering by learned bits-per-cost posteriors (driven by memoized-verdict statistics; off = fixed three-channel descending order, legacy) |
| autonomyW1Exec | boolean | true | W1 exec-layer quad upgrade wiring: buildAutonomyStack injects probe (ExecWorldProbe — only lights up when the physical service is already alive, never spawns) + focus source (origin-tagged, no cross-layer shortcuts); off = pre-wire byte-identical legacy path |
| autonomyW1RoiRadiusPx | number | 128 | W1-1 A2: action-point ROI radius in px (normalized by capture short edge), default 128 |
| autonomyW1RoiHammingTolerance | number | 2 | W1-1 A2: ROI region-hash "changed" hamming threshold (distance > this = changed), default 2 |
| autonomyW1FocusShortcutRadius | number | 0.01 | W1-1 A3: focus shortcut radius (normalized distance <= this skips re-dispatch), default 0.01 |
| autonomyW1LargeBboxPx | number | 96 | W1-1 A4: large-bbox threshold (long edge >= this => word-centroid landing point), default 96 |
| autonomyW1SmallBboxPx | number | 24 | W1-1 A4: small-bbox threshold (short edge < this => shrink landing toward center), default 24 |
| autonomyW1SmallShrinkRatio | number | 0.2 | W1-1 A4: small-bbox shrink ratio (0.2 = pull 20 percent toward center), default 0.2 |
| autonomyW1WordMaxAreaRatio | number | 0.6 | W1-1 A4: word-element area cap as a fraction of the target bbox (above = treated as the target itself), default 0.6 |
| autonomyW1ClickRetryMax | number | 8 | W1-1 A4: grid retry cap (3x3 minus center = 8 neighbors; 0 disables grid retry), default 8 |
| autonomyW1GridStepRatio | number | 0.25 | W1-1 A4: grid step as a fraction of the target short edge, default 0.25 |
| autonomyW1GridStepMinPx | number | 4 | W1-1 A4: grid step lower bound in px, default 4 |
| autonomyW1GridStepMaxPx | number | 40 | W1-1 A4: grid step upper bound in px, default 40 |
| autonomyW1SteadyPollMs | number | 150 | W1-1 A5: steady-gate poll interval in ms, default 150 |
| autonomyW1SteadyTimeoutMs | number | 2000 | W1-1 A5: steady-gate forced-release timeout in ms (records degraded), default 2000 |
| autonomyW1SteadyHamming | number | 2 | W1-1 A5: steady-gate hamming threshold (two consecutive frames <= this = settled), default 2 |
| autonomyW1RowMeansGrid | number | 64 | W1-1 A5: row-means grid for frameRowmeans, default 64 |
| autonomyW1RowShiftSearchRange | number | 16 | W1-1 A5: row-shift search range for estimateRowShift, default 16 |
| autonomyW1FrameGate | boolean | true | W2-0: perception-gate (C1 act-expectation no-look gating) wiring — buildAutonomyStack injects the local frameHash port (capture -> dhash; failure => null => honest degrade to full perception). Five-fold AND gate keeps only the narrowest benign no-impact class skippable |
| autonomyW1GateHammingTolerance | number | 3 | W1-3 C1: gate dHash hamming tolerance (same default 3 as worldSnapshot), default 3 |
| autonomyW1GatePollIntervalMs | number | 250 | W1-3 C1: wait-watch poll interval in ms, default 250 |
| autonomyW1GatePollMaxMs | number | 2000 | W1-3 C1: wait-watch max duration in ms (then advance with a light observation), default 2000 |
| autonomyW1GateMaxConsecutiveSkips | number | 1 | W1-3 C1: max consecutive perception skips before a forced full perception (bounded freshness for terminal-criteria OCR), default 1 |
| vlmZoomVerify | boolean | true | W1-8 P3: zoom re-verify verifyClient wiring (registered into the kernel registry as grounding.verifyZoom): low-confidence / small-target / dense-neighborhood groundings get a selective zoom re-grounding + OCR cross-check; off => trigger events degrade to port-absent and pass through |
| somSparseBudget | number | 0 | W1-7 P4: sparse SoM marking budget (Top-K cap); 0 (default) = full marking (OFF — flipping the sparse default changes the existing annotation output surface; keep off until the evidence chain is battle-tested) |
| vlmProviderTiers | string | "" | W2-8 C2: CSV provider-tier map for the failover pool tier roster (e.g. "ollama=cheap,siliconflow=cheap"; tier = cheap\|primary; keys are pool provider ids) feeding the cost-cascade cheap arm; empty (default) = no cheap tier, cascade always abstains (zero behavior change) |
| vlmCascadeDangerMax | number | 0.35 | W2-8 C2: cost-cascade triage danger ceiling (0~1): danger <= this tries the deterministically-validated cheap arm before the primary; default 0.35 with the wiring-time conservative static factors (medium risk / unfamiliar scene / neutral confidence => danger 0.6) keeps the cascade abstaining (fail-safe: no evidence, no cheapening) |
| recoveryEfficacyPath | string | "" | W2-5: recovery-efficacy ledger JSON path (atomic tmp+rename): Beta posteriors per (syndrome x root-cause x recovery action) restored on load, auto-persisted on episode close, saved on unload; empty (default) = memory only |
| enableExploration | boolean | false | W4-0: exploration frontier (W3-7 R2) — buildAutonomyStack mints an ExplorationLedger into deps.exploration (UCB frontier advice on the recovery escalate branch + per-step observe bookkeeping); false (default) = port absent, byte-identical legacy escalate path |
| explorationPersistPath | string | "" | W4-0: exploration-ledger standalone persistence path (JSON, tmp+fsync+rename, never touches checkpoint); empty (default) = memory only (cross-session exploration memory honestly lost) |
| autonomySteerEnabled | boolean | false | W4-0: in-loop living-intent drift consumption (W3-5 H2) — driveLoop asks createSteerSession.maybeCheckAndAsk each step (stepIndex + latest calibrated entropy); a question mints a steer-drift escalation for the model to relay; false (default) = whole section skipped (zero-regression red line) |
| orchestratorParallel | boolean | false | W4-0: start_complex_task ready-layer parallelism (W3-4 G2) — passed through as RunOrchestratorOptions.parallel (actual parallelism still needs a Kahn ready layer with >=2 independent subtasks AND team headroom); false (default) = serial spine, byte-identical |
| enableReversibilityLanes | boolean | false | W4-3 S5: dispatch lanes by reversibility level — click/type/drag tools classify the intent (reversibilityRegistry.classify) BEFORE dispatch: reversible = fast lane, compensable = escrow lane (mint a reversal plan BEFORE approval.beginAttempt on dangerous+token paths; non-enforcement paths annotate only), irreversible = hand control back to the HUMAN (no automated dispatch). Unknown-semantics actions are left to the existing danger-word gate (classification-knowledge absence is not a lane verdict). false (default) = byte-identical legacy path |
| enableStepAuction | boolean | false | W4-7 G5: step-auction market for sub-agents — per-agent maxSteps becomes a shared pool re-auctioned every K charged steps (convergence evidence aggregated from experience crystals by birth-scene fingerprint); false (default) = per-agent maxSteps budgets, byte-identical |
| stepAuctionBudget | number | 0 | W4-7 G5: explicit total step-pool budget for the auction market; 0 (default) = derived from the roster (sum of maxSteps — total budget equivalent to the status quo) |
