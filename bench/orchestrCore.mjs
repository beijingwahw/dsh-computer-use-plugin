// bench/orchestrCore.mjs — R2-6 suite-full 实战批跑编排的纯逻辑核心(零 IO / 零网络 / 零时钟)。
//
// batch-orchestrator.mjs(CLI)只做 IO 编排:调 drive-desktop.mjs 跑单任务、批间
// enrich-evidence/analyze-run 固定流、宿主健康巡检;全部决策(梯次划分/门槛判定/
// checkpoint 状态机/播种清单/时长模型)一律问这里 —— 与 driveCore/analyzeCore 同律,
// 受 test/w2orchestr.test.ts 离线回归保护。
//
// 梯次设计依据:
//   · R1-3 §2 的状态机是**全序依赖链**(T1 清场→T2 播种→…→T26 终局),批划分必须
//     保持 suite 序(依赖族分组:窗口/浏览器族聚合、审批等高危族后置);
//   · R1-8 实测:保存链(无 ctrl+s 白名单,走文件菜单)是最大风险面 —— 冒烟批必须
//     含热键/保存任务;沙箱内启 GUI 不可靠 ⇒ 驱动侧 MinimizeAll + 任务自开窗;
//   · 难度递增在**批粒度**上成立(批内 suite 序优先):批1 均值 1.67 < 批2 2.33 < 批3 2.79;
//   · 批1=3(含热键) / 批2=9 / 批3=14,合计 26 全覆盖,与任务书阶梯一致。
//
// 确定性纪律:同输入恒同输出(无时间/随机;时间戳由 CLI 注入)。

// ─── 常量(时长模型;可被 CLI 覆盖展示,不进决策) ───

export const PER_TASK_OVERHEAD_MS = 45000;   // 每任务:建会话/选模型/证据采集/E2/僵尸扫荡/任务间隔(R1-8 实测每步毫秒级 + E2 1.5s + 保守余量)
export const BATCH_OVERHEAD_MS = 240000;     // 每批:健康巡检 + enrich + analyze + checkpoint(R1-7 冒烟实测分钟内)
export const NOMINAL_MS_PER_STEP = 25000;    // 名义模型:每 estStep 25s(混合简单步与重试;仅作预估,不进门槛)
export const DEFAULT_EST_STEPS = 12;         // 无 estSteps 注记任务的名义步数

/** 任务书指定的批构成(suite-full 26 任务 id → 批号;执行序 = suite 序过滤)。
 *  批1 冒烟 3 任务:清场(d1)+ 播种(d2,热键任务的硬前置)+ 热键撤销存盘(d2)——
 *  依赖链上唯一合法的"3 任务含热键"组合(任务书"难度1×2+1热键"中的第二个 d1
 *  任务 full-probe-interactivity 同样依赖 T2 播种,归批2,见 renderPlanMarkdown 理由)。 */
export const SUITE_FULL_LADDER = {
  1: ['full-setup-clean', 'full-seed-report', 'full-hotkey-undo-save'],
  2: [
    'full-seed-extras', 'full-ocr-locate', 'full-zoom-tray', 'full-probe-interactivity',
    'full-edit-precision', 'full-scroll-deep', 'full-form-html-author',
    'full-edge-open-form', 'full-open-url-nav',
  ],
  3: [
    'full-ask-screen', 'full-drag-file-move', 'full-triple-window-switch', 'full-calc-element',
    'full-diff-action-locate', 'full-memory-landmark', 'full-approval-delete-file',
    'full-macro-record-replay', 'full-skill-lifecycle', 'full-autonomous-goal',
    'full-orchestration-file', 'full-cognition-whatif', 'full-observability-panel',
    'full-final-cleanup',
  ],
};

/** 每批通过门槛(批内 last-attempt 终态计数;unknown/blocked 计为未过):
 *   批1 ≥2/3 —— 冒烟门槛,不过即停待人工(任务书指定);
 *   批2 ≥6/9 —— 2/3 同率;容忍 2 个 absent-E2 只读任务(T5/T6)与单点环境抖动;
 *   批3 无门槛 —— 终批只出报告(含 enrich/analyze 工单),不再有下游可拦。 */
export const BATCH_GATES = {
  1: { minPass: 2, action: 'stop-await-human', rationale: '冒烟批 <2/3 ⇒ 链路/环境未就绪,继续烧真机预算无意义' },
  2: { minPass: 6, action: 'stop-await-human', rationale: '2/3 同率;批3 全是 d4 高危族(审批/宏/自主/编排),放行前要多数证据' },
  3: { minPass: null, action: 'report-only', rationale: '终批无下游,门槛无拦截对象;失败全部进 analyze 工单' },
};

// ─── 播种清单(R1-3 §2 状态机的机器可核子集:文件谓词 + 前置任务) ───
// files[].mode: 'all'(缺省,全部须满足)|'any'(任一即可,对应 prompt 自愈条款);
// soft: true ⇒ 失败仅告警不阻断(prompt 内建自愈,如 T19 缺文件重建、T14 残留拖回)。
// 窗口/进程态不在此列 —— 那是任务自身/E2 的职权(播种检查零 GUI 冲击:纯 fs)。
export const SEED_MANIFEST = {
  'full-seed-report': { prereq: ['full-setup-clean'], files: [], note: '自播种(建 full-report.md);干净桌面由 T1 回执钉住' },
  'full-seed-extras': { prereq: ['full-seed-report'], files: [{ rel: 'full-report.md', contains: 'FULL-BATTERY-ANCHOR' }], note: '主文件在盘;notepad 域=1 由 T2 E2 钉住' },
  'full-hotkey-undo-save': { prereq: ['full-seed-report'], files: [{ rel: 'full-report.md', contains: 'FULL-BATTERY-ANCHOR' }], note: '热键任务吃 T2 的记事本#1(GUI 态由 T2 E2 windowExists 钉住)' },
  'full-ocr-locate': { prereq: ['full-seed-report'], files: [{ rel: 'full-report.md', contains: 'FULL-BATTERY-ANCHOR' }] },
  'full-zoom-tray': { prereq: ['full-seed-report'], files: [{ rel: 'full-report.md', contains: 'FULL-BATTERY-ANCHOR' }] },
  'full-probe-interactivity': { prereq: ['full-seed-report'], files: [{ rel: 'full-report.md', contains: 'FULL-BATTERY-ANCHOR' }] },
  'full-edit-precision': { prereq: ['full-hotkey-undo-save'], files: [{ rel: 'full-report.md', contains: 'HOTKEY-VERIFIED-OK' }], note: '吃批1 热键任务的落盘产物' },
  'full-scroll-deep': { prereq: ['full-edit-precision'], files: [{ rel: 'full-report.md', contains: 'ROW-2-EDITED-FULL' }] },
  'full-form-html-author': { prereq: ['full-scroll-deep'], files: [{ rel: 'full-report.md', contains: 'ROW-2-EDITED-FULL' }], note: 'T9 不保存 ⇒ 磁盘仍为 T8 编辑版' },
  'full-edge-open-form': { prereq: ['full-form-html-author'], files: [{ rel: 'form.html', contains: 'Full-Battery-Form' }] },
  'full-open-url-nav': { prereq: ['full-edge-open-form'], files: [{ rel: 'form.html', contains: 'checkbox' }], note: 'Edge 在场是 GUI 态,由 T11 E2 processRunning 钉住' },
  'full-ask-screen': { prereq: ['full-edge-open-form'], files: [{ rel: 'form.html', contains: 'checkbox' }] },
  'full-drag-file-move': {
    prereq: ['full-seed-extras', 'full-open-url-nav'],
    files: [{ mode: 'any', soft: true, anyOf: [{ rel: 'drag-me.txt', contains: 'drag-me-content-123' }, { rel: 'full-drag-dst\\drag-me.txt', contains: 'drag-me-content-123' }] }],
    note: 'soft:prompt 自愈条款(残留已搬则先拖回);explorer 在 playground 由 T12 后置导航钉住',
  },
  'full-triple-window-switch': { prereq: ['full-open-url-nav'], files: [{ rel: 'full-report.md', contains: 'ROW-2-EDITED-FULL' }] },
  'full-calc-element': { prereq: ['full-triple-window-switch'], files: [{ rel: 'full-report.md', contains: 'ROW-2-EDITED-FULL' }] },
  'full-diff-action-locate': { prereq: ['full-calc-element'], files: [{ rel: 'calc-elem.txt', contains: '144' }], note: '计算器在场由 T16 E2 processRunning(names 方言)钉住' },
  'full-memory-landmark': { prereq: ['full-calc-element'], files: [{ rel: 'calc-elem.txt', contains: '144' }] },
  'full-approval-delete-file': {
    prereq: ['full-drag-file-move'],
    files: [{ rel: 'trash-me.txt', contains: 'trash-me-content-456', soft: true }],
    note: 'soft:prompt 自愈(缺文件先重建);explorer 在根目录由 T14 第6步导航钉住',
  },
  // R5-3 松绑(R4-4 §5-B):宏任务不吃审批产物(trash-me 与 macro-proof 无关),
  // T19 是计划内 FAIL 金丝雀(闸门 fail-closed 死锁)——按 pass 放行会绑架 T20→T26 尾链。
  // 物料前置由 files 谓词独立核(full-report.md@编辑版);GUI 面(notepad full-report 在场)
  // 与 T19 无关(审批只动 explorer/trash-me),由 suite 序+E2 兜底。
  'full-macro-record-replay': { prereq: [], files: [{ rel: 'full-report.md', contains: 'ROW-2-EDITED-FULL' }], note: 'R5-3:与审批解耦——审批 fail(计划内金丝雀)不污染宏物料;物料面=full-report.md@编辑版(files 谓词硬核)' },
  'full-skill-lifecycle': { prereq: ['full-macro-record-replay'], files: [{ rel: 'full-report.md', contains: 'ROW-2-EDITED-FULL' }] },
  'full-autonomous-goal': { prereq: ['full-skill-lifecycle'], files: [{ rel: 'full-report.md', contains: 'ROW-2-EDITED-FULL' }] },
  'full-orchestration-file': { prereq: ['full-autonomous-goal'], files: [{ rel: 'auto-goal.txt', contains: 'AUTO-GOAL-DONE-2026' }] },
  'full-cognition-whatif': { prereq: ['full-drag-file-move'], files: [], note: '只读问答;提问素材是 journal 轨迹(文件面无前置)' },
  'full-observability-panel': { prereq: ['full-cognition-whatif'], files: [], note: '只读观测,无世界侧前置' },
  // R5-3 松绑(R4-4 §5-B):T23 是 known-limitation 计划内 FAIL(Actor 双通道在
  // stock 宿主死亡,R4-4 §4)——按 pass 放行会让终清永久 blocked。终清是世界态收口
  // (清一切在场窗口,含 T22/T23 泄漏),无任务级物料前置;与 T1 开场清对称(零前置),
  // suite 序保证最后执行。观测/认知族同理不产出终清所需物料。
  'full-final-cleanup': { prereq: [], files: [], note: 'R5-3:与编排解耦——T23 计划内 FAIL(known-limitation)不绑架终清;终清=T1 对称的世界态收口,无物料前置,suite 序保证收尾' },
};

/** seedCheckFor —— 单任务的播种检查计划(纯函数;不存在清单的任务 = 无前置)。 */
export function seedCheckFor(taskId) {
  const m = SEED_MANIFEST[taskId];
  if (!m) return { taskId, prereq: [], files: [], note: '未登记前置(套件外任务/无世界侧依赖)' };
  return { taskId, prereq: [...m.prereq], files: m.files.map((f) => ({ ...f })), note: m.note ?? '' };
}

/** checkFilePredicate —— 一条文件谓词对 (existsMap, contentMap) 的判定(纯函数;
 * CLI 负责 IO:existsMap[rel]=bool、contentMap[rel]=文件文本或 null)。
 * anyOf 任一成立即过;contains 子串;containsRegex 大小写敏感正则。 */
export function checkFilePredicate(pred, { existsMap = {}, contentMap = {} } = {}) {
  const evalOne = (p) => {
    if (p.rel === 'absent') return true; // 自愈占位:允许"文件缺席也放行"(由 soft 语义承载)
    if (!existsMap[p.rel]) return { ok: false, reason: `缺席:${p.rel}` };
    if (p.contains !== undefined) {
      const c = contentMap[p.rel] ?? '';
      return c.includes(p.contains) ? true : { ok: false, reason: `${p.rel} 不含 "${p.contains}"` };
    }
    if (p.containsRegex !== undefined) {
      try {
        return new RegExp(p.containsRegex).test(contentMap[p.rel] ?? '') ? true : { ok: false, reason: `${p.rel} 不匹配 /${p.containsRegex}/` };
      } catch (e) {
        return { ok: false, reason: `正则非法(${e.message})` };
      }
    }
    return true;
  };
  if (pred.mode === 'any') {
    const rs = (pred.anyOf ?? []).map(evalOne);
    const ok = rs.some((r) => r === true);
    return { ok, soft: !!pred.soft, reason: ok ? 'anyOf 成立' : 'anyOf 全不成立:' + rs.map((r) => r === true ? 'ok' : r.reason).join(' | ') };
  }
  const rs = (pred.allOf ?? [pred]).map(evalOne);
  const bad = rs.filter((r) => r !== true);
  return { ok: bad.length === 0, soft: !!pred.soft, reason: bad.length === 0 ? 'allOf 成立' : bad.map((r) => r.reason).join(' | ') };
}

/** seedVerdict —— 播种检查总判定(纯):prereq(按 checkpoint 终态)+ 文件谓词。
 *   verdict.hard=false ⇒ 拒跑(blocked);soft 违例仅告警。 */
export function seedVerdict(taskId, { taskStates = {}, existsMap = {}, contentMap = {} } = {}) {
  const plan = seedCheckFor(taskId);
  const missing = plan.prereq.filter((id) => taskStates[id] !== 'pass');
  const fileResults = plan.files.map((p) => ({ pred: p, ...checkFilePredicate(p, { existsMap, contentMap }) }));
  const hardFiles = fileResults.filter((r) => !r.ok && !r.soft);
  const softFails = fileResults.filter((r) => !r.ok && r.soft);
  const ok = missing.length === 0 && hardFiles.length === 0;
  return {
    taskId, ok,
    blockedBy: ok ? [] : [
      ...missing.map((id) => `前置任务未过:${id}(${taskStates[id] ?? '未跑'})`),
      ...hardFiles.map((r) => `播种文件不符:${r.reason}`),
    ],
    warnings: softFails.map((r) => `软谓词未过(prompt 自愈兜底):${r.reason}`),
    prereq: plan.prereq,
  };
}

// ─── 梯次计划 ───

function taskMeta(t) {
  return {
    id: t.id,
    category: t.category ?? null,
    family: t.family ?? t.category ?? null,
    difficulty: Number.isFinite(t.difficulty) ? t.difficulty : null,
    estSteps: Number.isFinite(t.estSteps) ? t.estSteps : DEFAULT_EST_STEPS,
    timeoutMs: Number.isFinite(t.timeoutMs) ? t.timeoutMs : null,
    hasE2: !!t.verify,
    coverage: t.coverage ?? null,
    anchor: t.anchor ?? null,
  };
}

/**
 * buildLadderPlan —— tasks(套件原序)→ 梯次计划(纯):
 *   · suite-full:按 SUITE_FULL_LADDER 分批(执行序 = suite 序过滤,保持依赖链);
 *   · 其他套件:整包单批(门槛 null)—— 编排器是 suite-full 实战件,不为陌生套件瞎分组;
 *   · 校验:id 重复/清单与套件不符 ⇒ 抛错 fail-fast(不静默跑错批)。
 * playground 只用于渲染 seed 文件的绝对路径展示,不参与决策。
 */
export function buildLadderPlan(tasks, { playground = null } = {}) {
  const ids = tasks.map((t) => t.id);
  if (new Set(ids).size !== ids.length) throw new Error('套件内任务 id 重复');
  const isSuiteFull = ids.length > 0 && SUITE_FULL_LADDER[1].concat(SUITE_FULL_LADDER[2], SUITE_FULL_LADDER[3]).every((id) => ids.includes(id));
  const ladder = isSuiteFull ? SUITE_FULL_LADDER : { 1: [...ids] };
  if (isSuiteFull) {
    const listed = Object.values(ladder).flat();
    const stray = listed.filter((id, i) => listed.indexOf(id) !== i || !ids.includes(id));
    if (stray.length || listed.length !== ids.length) throw new Error(`SUITE_FULL_LADDER 与套件不符(stray=${stray.join(',')})`);
  }
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const batches = Object.keys(ladder).map(Number).sort((a, b) => a - b).map((no) => {
    const batchIds = ladder[no];
    const metas = batchIds.map((id) => taskMeta(byId.get(id)));
    const gate = isSuiteFull ? BATCH_GATES[no] : { minPass: null, action: 'report-only', rationale: '非 suite-full 套件:单批整包,无门槛' };
    const timeouts = metas.map((m) => m.timeoutMs ?? 0);
    const sumTimeout = timeouts.reduce((a, b) => a + b, 0);
    const nominal = metas.reduce((a, m) => a + Math.min(m.timeoutMs ?? Infinity, m.estSteps * NOMINAL_MS_PER_STEP), 0);
    const worstMs = sumTimeout + metas.length * PER_TASK_OVERHEAD_MS + BATCH_OVERHEAD_MS;
    const nominalMs = nominal + metas.length * PER_TASK_OVERHEAD_MS + BATCH_OVERHEAD_MS;
    const diffs = metas.map((m) => m.difficulty).filter((d) => d !== null);
    return {
      no,
      ids: [...batchIds],
      tasks: metas,
      size: batchIds.length,
      gate: { minPass: gate.minPass, action: gate.action, rationale: gate.rationale },
      difficultyMean: diffs.length ? Math.round((diffs.reduce((a, b) => a + b, 0) / diffs.length) * 100) / 100 : null,
      families: [...new Set(metas.map((m) => m.family).filter(Boolean))],
      timeEstimate: { nominalMs, worstMs, sumTaskTimeoutMs: sumTimeout },
      seedChecks: batchIds.map((id) => {
        const sc = seedCheckFor(id);
        return {
          taskId: id, prereq: sc.prereq,
          files: sc.files.map((f) => {
            const targets = f.mode === 'any' ? f.anyOf : [f];
            return {
              mode: f.mode ?? 'all', soft: !!f.soft,
              paths: targets.filter((x) => x.rel !== 'absent').map((x) => ({ rel: x.rel, abs: playground ? `${playground}\\${x.rel}` : null, contains: x.contains ?? null, containsRegex: x.containsRegex ?? null })),
            };
          }),
        };
      }),
    };
  });
  return {
    schema: 'r26-ladder-plan/1',
    suiteTaskCount: tasks.length,
    isSuiteFull,
    batches,
    totals: {
      batches: batches.length,
      tasks: batches.reduce((a, b) => a + b.size, 0),
      nominalMs: batches.reduce((a, b) => a + b.timeEstimate.nominalMs, 0),
      worstMs: batches.reduce((a, b) => a + b.timeEstimate.worstMs, 0),
    },
  };
}

// ─── 门槛判定 ───

/**
 * gateDecision —— 批收口门槛(纯):minPass=null ⇒ 恒放行(终批);
 *   pass ≥ minPass ⇒ proceed;否则 stop-await-human。
 *   计数口径:批内**调度任务**的 last-attempt 终态(pass 数不含 unknown/blocked)。
 */
export function gateDecision({ minPass, pass, fail = 0, unknown = 0, blocked = 0, total }) {
  const scheduled = total ?? (pass + fail + unknown + blocked);
  if (minPass === null || minPass === undefined) {
    return { proceed: true, margin: null, pass, fail, unknown, blocked, scheduled, verdict: 'report-only(终批无门槛)', minPass: null };
  }
  const proceed = pass >= minPass;
  return {
    proceed, minPass, pass, fail, unknown, blocked, scheduled,
    margin: pass - minPass,
    verdict: proceed
      ? `门槛过:${pass}/${scheduled} ≥ ${minPass}(余量 ${pass - minPass})`
      : `门槛未过:${pass}/${scheduled} < ${minPass} —— ${scheduled - pass} 个未过(fail=${fail} unknown=${unknown} blocked=${blocked});停止待人工`,
  };
}

// ─── checkpoint 状态机 ───

export const TASK_STATES = ['pending', 'running', 'pass', 'fail', 'unknown', 'blocked', 'stopped'];
export const BATCH_STATES = ['pending', 'running', 'done', 'gate-failed', 'stopped', 'infra-stopped', 'health-stopped'];

/** taskOutcomeFromAttempt —— drive-desktop 退出码 + 回执 → 任务终态(纯)。
 *   入参两形:{exitCode, receipt}(原始回执)或 {exitCode, pass}(CLI 记账形,pass: true|false|null);
 *   exit 0:pass=true/false/其余 → pass/fail/unknown;回执与 pass 双缺席 ⇒ unknown(harness 记账)
 *   exit 3 stopfile / 130 sigint → 'stopped';exit 2/4/5/6/1/其他 → 'infra'(批级停,任务回到待跑)。 */
export function taskOutcomeFromAttempt({ exitCode, receipt, pass }) {
  if (exitCode === 0) {
    const p = receipt !== undefined ? receipt?.pass : pass;
    if (p === true) return 'pass';
    if (p === false) return 'fail';
    return 'unknown';
  }
  if (exitCode === 3 || exitCode === 130) return 'stopped';
  return 'infra';
}

/** initCampaign —— 新战役状态(纯;时间戳由调用方注入)。 */
export function initCampaign({ plan, campaignId, suiteFile, startedAtIso }) {
  const tasks = {};
  for (const b of plan.batches) {
    for (const id of b.ids) tasks[id] = { batch: b.no, state: 'pending', attempts: [], seed: null };
  }
  return {
    schema: 'r26-orchestr-state/1',
    campaignId, suiteFile,
    startedAt: startedAtIso, updatedAt: startedAtIso,
    batches: plan.batches.map((b) => ({ no: b.no, state: 'pending', startedAt: null, finishedAt: null, gate: null, postprocess: null })),
    tasks,
    stoppedBy: null,
  };
}

/** loadCampaignState —— 状态文件形状校验(纯;读文件在 CLI 侧;坏形状 fail-fast)。 */
export function loadCampaignState(parsed) {
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('orchestrator-state 须为对象');
  if (parsed.schema !== 'r26-orchestr-state/1') throw new Error(`orchestrator-state.schema 不识:${String(parsed.schema)}`);
  if (!Array.isArray(parsed.batches) || !parsed.batches.every((b) => BATCH_STATES.includes(b.state))) throw new Error('orchestrator-state.batches 非法');
  if (typeof parsed.tasks !== 'object' || parsed.tasks === null || Array.isArray(parsed.tasks)) throw new Error('orchestrator-state.tasks 非法');
  for (const [id, t] of Object.entries(parsed.tasks)) {
    if (!TASK_STATES.includes(t.state)) throw new Error(`tasks.${id}.state 非法:${String(t.state)}`);
    if (!Array.isArray(t.attempts)) throw new Error(`tasks.${id}.attempts 须为数组`);
  }
  return parsed;
}

export function beginBatch(state, batchNo, nowIso) {
  const batches = state.batches.map((b) => (b.no === batchNo ? { ...b, state: 'running', startedAt: b.startedAt ?? nowIso } : b));
  return { ...state, batches, updatedAt: nowIso };
}

/** recordSeed —— 播种检查结果记账(blocked 或放行+告警)。 */
export function recordSeed(state, taskId, seed, nowIso) {
  const t = state.tasks[taskId];
  if (!t) return state;
  const nextState = seed.ok ? (t.state === 'pending' ? 'running' : t.state) : 'blocked';
  return {
    ...state,
    tasks: { ...state.tasks, [taskId]: { ...t, state: nextState, seed: { ok: seed.ok, at: nowIso, blockedBy: seed.blockedBy, warnings: seed.warnings } } },
    updatedAt: nowIso,
  };
}

/** recordAttempt —— 单任务一次尝试收口(纯;attempt 形状由 CLI 组装)。 */
export function recordAttempt(state, taskId, attempt, nowIso) {
  const t = state.tasks[taskId];
  if (!t) return state;
  const outcome = taskOutcomeFromAttempt(attempt);
  // 'infra' 不给任务终态(基建错不是任务错):任务回到 pending 交由批级状态表达;
  // 'stopped' 同理保留可续跑语义 —— 批级 stopped 后 nextAction=resume。
  const nextState = outcome === 'pass' ? 'pass'
    : outcome === 'fail' ? 'fail'
      : outcome === 'unknown' ? 'unknown'
        : 'pending';
  return {
    ...state,
    tasks: { ...state.tasks, [taskId]: { ...t, state: nextState, attempts: [...t.attempts, { ...attempt, outcome, at: nowIso }] } },
    updatedAt: nowIso,
  };
}

/** batchOutcomeSummary —— 批内调度任务的终态计数(纯;门槛输入)。 */
export function batchOutcomeSummary(state, batchNo) {
  const ids = state.batches.find((b) => b.no === batchNo) ? Object.keys(state.tasks).filter((id) => state.tasks[id].batch === batchNo) : [];
  const count = (s) => ids.filter((id) => state.tasks[id].state === s).length;
  return { batchNo, scheduled: ids.length, pass: count('pass'), fail: count('fail'), unknown: count('unknown'), blocked: count('blocked'), pending: count('pending') + count('running') };
}

/** finishBatch —— 批收口:计数 → 门槛 → 批终态(纯)。
 *   未跑完(pending>0)不判门槛 —— 只有 stopped/infra 中断或全部收口才收批。 */
export function finishBatch(state, batchNo, { nowIso, stopReason = null }) {
  const sum = batchOutcomeSummary(state, batchNo);
  const batchDef = state.batches.find((b) => b.no === batchNo);
  if (!batchDef) throw new Error(`批 ${batchNo} 不在战役中`);
  let gate = null;
  let next;
  if (stopReason === 'stopfile' || stopReason === 'sigint') next = 'stopped';
  else if (stopReason === 'infra') next = 'infra-stopped';
  else if (stopReason === 'health') next = 'health-stopped';
  else if (sum.pending > 0) throw new Error(`批 ${batchNo} 尚有 ${sum.pending} 个任务未收口,不能 finishBatch`);
  else {
    gate = gateDecision({ minPass: batchDef.gate?.minPass ?? null, pass: sum.pass, fail: sum.fail, unknown: sum.unknown, blocked: sum.blocked, total: sum.scheduled });
    next = gate.proceed ? 'done' : 'gate-failed';
  }
  return {
    ...state,
    batches: state.batches.map((b) => (b.no === batchNo ? { ...b, state: next, finishedAt: nowIso, gate: gate ?? b.gate } : b)),
    stoppedBy: stopReason ?? state.stoppedBy,
    updatedAt: nowIso,
  };
}

/** markGate —— 梯次计划的门槛写进战役状态(init 时由 CLI 调用,判门槛用)。 */
export function withGates(state, plan) {
  return {
    ...state,
    batches: state.batches.map((b) => {
      const p = plan.batches.find((x) => x.no === b.no);
      return p ? { ...b, gate: b.gate ?? { minPass: p.gate.minPass, action: p.gate.action } } : b;
    }),
  };
}

/** tasksToRun —— 本次 run --batch N 应跑的任务序(纯):
 *   新批/续跑:pending(+running 中断残留,recordSeed 放行后搁浅的)任务,suite 序;
 *   --retry-failed:终态 fail/unknown/blocked(+未收口的)任务(重评门槛)。 */
export function tasksToRun(state, batchNo, { retryFailed = false } = {}) {
  const want = retryFailed ? ['fail', 'unknown', 'blocked', 'pending', 'running'] : ['pending', 'running'];
  return state.batches.find((b) => b.no === batchNo)
    ? Object.keys(state.tasks).filter((id) => state.tasks[id].batch === batchNo && want.includes(state.tasks[id].state))
    : [];
}

/** nextAction —— 状态机读模型:操作者下一步该敲什么(纯)。 */
export function nextAction(state) {
  const ordered = [...state.batches].sort((a, b) => a.no - b.no);
  for (const b of ordered) {
    if (b.state === 'done') continue;
    if (b.state === 'pending') {
      const prev = ordered.filter((x) => x.no < b.no);
      const blocker = prev.find((x) => x.state !== 'done');
      if (blocker) {
        if (blocker.state === 'gate-failed') return { cmd: 'await-human', reason: `批 ${blocker.no} 门槛未过(${JSON.stringify(blocker.gate?.verdict ?? blocker.gate)}) —— 修复后 run --batch ${blocker.no} --retry-failed 重评,或人工裁决放弃` };
        return { cmd: 'await-human', reason: `批 ${blocker.no} 状态 ${blocker.state}(非 done)—— 先处置它(续跑 run --batch ${blocker.no} / 健康巡检 / 人工)` };
      }
      return { cmd: 'run-batch', batch: b.no };
    }
    if (['running', 'stopped', 'infra-stopped', 'health-stopped'].includes(b.state)) {
      const why = b.state === 'health-stopped' ? '健康巡检曾失败:处理宿主/python/磁盘后删除 STOP 文件,再续跑' : b.state === 'infra-stopped' ? '基建中断:查 probe-failure/锁/宿主后续跑' : b.state === 'stopped' ? '曾被 stopfile/sigint 停:确认意图后删除 STOP 再续跑' : '批进行中(中断残留)';
      return { cmd: 'resume-batch', batch: b.no, reason: why };
    }
    if (b.state === 'gate-failed') return { cmd: 'await-human', reason: `批 ${b.no} 门槛未过 —— run --batch ${b.no} --retry-failed(修复后重评)或人工放弃` };
  }
  return { cmd: 'campaign-done', reason: '全部批次收口' };
}

// ─── 健康巡检判定(纯;观察由 CLI 采集) ───

/** healthVerdict —— 批间巡检裁决(纯):rpc/python/disk 任一 fail ⇒ 停(stopfile 语义)。 */
export function healthVerdict({ rpc, python, diskFreeGb, minFreeGb }) {
  const checks = [];
  if (rpc !== undefined) checks.push({ name: 'rpc', ok: rpc === true, detail: rpc === true ? 'session.list 探测通过' : 'RPC 探测失败(宿主未起/token 失效/端点错)' });
  if (python !== undefined) checks.push({ name: 'python', ok: python === true, detail: python === true ? 'python 物理服务端口活性 OK' : '8421-8428 无监听(python 服务未起/已死)' });
  if (diskFreeGb !== undefined) checks.push({
    name: 'disk',
    ok: diskFreeGb >= minFreeGb,
    detail: `free=${Math.round(diskFreeGb * 10) / 10}GB / min=${minFreeGb}GB`,
  });
  const failures = checks.filter((c) => !c.ok);
  return { ok: failures.length === 0, checks, failures, action: failures.length === 0 ? 'proceed' : 'write-stopfile-and-halt' };
}

// ─── 渲染(确定性;时间戳不掺入) ───

export function fmtMin(ms) {
  const m = ms / 60000;
  return m >= 90 ? `${(m / 60).toFixed(1)}h` : `${Math.round(m)}min`;
}

/** renderStatusText —— status 命令的单行×批次渲染(纯)。 */
export function renderStatusText(state) {
  const lines = [];
  lines.push(`campaign=${state.campaignId} suite=${state.suiteFile} updated=${state.updatedAt}`);
  for (const b of [...state.batches].sort((x, y) => x.no - y.no)) {
    const sum = batchOutcomeSummary(state, b.no);
    const gateTxt = b.gate?.verdict ? ` gate:[${b.gate.verdict}]` : b.gate?.minPass != null ? ` gate:minPass=${b.gate.minPass}` : '';
    lines.push(`batch-${b.no} ${b.state} pass=${sum.pass} fail=${sum.fail} unknown=${sum.unknown} blocked=${sum.blocked} pending=${sum.pending}${gateTxt}`);
    for (const [id, t] of Object.entries(state.tasks)) {
      if (t.batch !== b.no) continue;
      const att = t.attempts.length ? ` attempts=${t.attempts.length}(last=${t.attempts[t.attempts.length - 1].outcome}${t.attempts[t.attempts.length - 1].exitCode !== 0 ? ',exit=' + t.attempts[t.attempts.length - 1].exitCode : ''})` : '';
      const seed = t.seed ? ` seed=${t.seed.ok ? 'ok' : 'BLOCKED'}` : '';
      lines.push(`  ${id}\t${t.state}${att}${seed}${t.seed && t.seed.warnings?.length ? ' warn=' + t.seed.warnings.length : ''}`);
    }
  }
  const na = nextAction(state);
  lines.push(`next: ${na.cmd}${na.batch ? ` --batch ${na.batch}` : ''} —— ${na.reason}`);
  return lines.join('\n');
}

/** renderPlanMarkdown —— 梯次计划文档(纯;bench/batch-ladder-plan.md 的生成器)。 */
export function renderPlanMarkdown(plan) {
  const L = [];
  L.push('# suite-full 实战批跑梯次计划(R2-6)');
  L.push('');
  L.push(`schema \`${plan.schema}\` · 任务 ${plan.totals.tasks} 个 · 批 ${plan.totals.batches} 个 · 名义时长 ≈ ${fmtMin(plan.totals.nominalMs)} · 最坏 ${fmtMin(plan.totals.worstMs)}(=Σ任务超时+每任务 ${PER_TASK_OVERHEAD_MS / 1000}s 采集开销+每批 ${BATCH_OVERHEAD_MS / 1000}s 固定流)。`);
  L.push('');
  L.push('执行纪律:**严格串行**(一套鼠标键盘,drive-desktop pid 锁);编排器不直接跑 GUI——由持 GUI 锁的执行工位调用;每任务一次 drive-desktop 调用(单任务套件),批内保持 suite 序(依赖链)。');
  L.push('');
  for (const b of plan.batches) {
    L.push(`## 批${b.no}(${b.size} 任务 · 难度均值 ${b.difficultyMean} · 名义 ${fmtMin(b.timeEstimate.nominalMs)} / 最坏 ${fmtMin(b.timeEstimate.worstMs)})`);
    L.push('');
    L.push('| # | id | 族 | 难度 | estSteps | 超时 | E2 | 播种前置 |');
    L.push('|---|----|----|------|----------|------|----|----------|');
    b.tasks.forEach((t, i) => {
      const sc = b.seedChecks.find((s) => s.taskId === t.id);
      const prereq = sc && sc.prereq.length ? sc.prereq.join(',') : '-';
      L.push(`| ${i + 1} | ${t.id} | ${t.family ?? '-'} | ${t.difficulty ?? '-'} | ${t.estSteps} | ${t.timeoutMs ? Math.round(t.timeoutMs / 60000) + 'min' : '-'} | ${t.hasE2 ? 'verify' : 'absent'} | ${prereq} |`);
    });
    L.push('');
    L.push(`- **门槛**:${b.gate.minPass == null ? '无(终批只出报告)' : `≥ ${b.gate.minPass}/${b.size} pass 才进下一批`} —— ${b.gate.rationale}`);
    L.push(`- **族构成**:${b.families.map((f) => `\`${f}\``).join(' · ')}`);
    L.push(`- **时长口径**:Σ任务超时=${fmtMin(b.timeEstimate.sumTaskTimeoutMs)};nominal=min(超时, estSteps×${NOMINAL_MS_PER_STEP / 1000}s) 之和+开销(启发式预估,不进门槛)。`);
    L.push('');
  }
  L.push('## 批划分理由');
  L.push('');
  L.push('1. **依赖链全序(R1-3 §2)**:批划分 = suite 序的保持性切分。跨批前置(如批2 的 full-edit-precision 吃批1 热键任务的落盘产物)由编排器播种检查按 checkpoint 终态核放行。');
  L.push('2. **风险递增**:批1 冒烟钉「清场→播种→保存链+热键撤销」——R1-8 九次失败的正是保存链(无 ctrl+s 白名单须走菜单),链路不通时 3 任务内止损;批2 加精确编辑/滚动/表单制作/浏览器 DOM(窗口/浏览器族聚合,共享 Edge/explorer 场);批3 集中全部 d4 高危族(审批真实删除、宏重放、自主环、编排)+三窗马拉松+终局清理。难度均值 1.67 → 2.33 → 2.79 单调递增。');
  L.push('3. **任务书"难度1×2+1热键"的落地修正**:两个 d1 任务(clean/probe)中 probe 依赖 T2 播种的记事本 GUI 态(不可 fs 代播),故冒烟批取 {clean(d1), seed-report(d2,硬前置), hotkey-undo-save(热键)}——依赖链上唯一合法的 3 任务含热键组合;probe 归批2。');
  L.push('4. **审批类单独批**:full-approval-delete-file(真实删除,回收站可恢复)落在批3——两道门槛之后才放行危险词链路;宏/自主/编排同为 d4 一并后置。');
  L.push('');
  L.push('## 通过门槛与放行规则');
  L.push('');
  L.push('| 批 | 门槛 | 未过后果 |');
  L.push('|----|------|----------|');
  for (const b of plan.batches) {
    L.push(`| 批${b.no} | ${b.gate.minPass == null ? '-' : `≥${b.gate.minPass}/${b.size}`} | ${b.gate.minPass == null ? '终批:失败全部进 analyze 工单' : `编排器停止,状态 gate-failed,待人工(--retry-failed 重评或放弃)`} |`);
  }
  L.push('');
  L.push('计数口径:批内调度任务的 last-attempt 终态;unknown/blocked 计为未过;harnessError/stopfile/健康巡检异常 ⇒ 批级 stopped/infra-stopped/health-stopped(不判门槛,处置后续跑)。');
  L.push('');
  L.push('## 回滚预案');
  L.push('');
  L.push('1. **任意时刻急停**:`touch <root>/suite-full/STOP`(drive 与编排器同一 stopfile;启动闸拒绝复跑直至人工删除);失控时 R1-6 `emergency-stop.mjs`(须 `DSH_BENCH_ENDPOINT=http://127.0.0.1:19387`),现场恢复 `recover-scene.ps1`。');
  L.push('2. **批内断点续跑**:中断后 `run --batch N` 自动只跑 pending 任务(checkpoint 逐任务持久);drive 侧 resume-state 僵尸会话由其 --resume 语义认领(编排器逐任务调用天然携带)。');
  L.push('3. **门槛未过回滚**:`run --batch N --retry-failed` 只重跑 fail/unknown/blocked(失败任务从 drive resume-state 摘除后真机重跑),完成后重评门槛;播种 blocked 的任务在前置转 pass 后自动解除。');
  L.push('4. **整役重置(最后手段)**:停机后清 `<root>/suite-full/`(证据先归档)+ playground 产物(full-report.md/drag-me.txt/trash-me.txt/form.html/full-drag-dst/calc-elem.txt/macro-proof.txt/auto-goal.txt/orch-proof.txt)→ 从批1 重播。操场外零残留(R1-3 圈禁纪律)。');
  L.push('5. **基线回滚**:analyze-run 首轮自动固化 `bench/baselines/suite-full.analysis.json`;批间对比污染时 `--refresh-baseline`(旧档自动归档 archive/)。');
  L.push('');
  L.push('## 运行手册(执行工位)');
  L.push('');
  L.push('```bash');
  L.push('export PATH="/c/Program Files/nodejs:$PATH"');
  L.push(`export DSH_BENCH_TEST_RUNS='C:\\dsh3\\test-runs'   # R1-2:不 export 则缺省 D: 盘,真跑 mkdir 处 fail-fast`);
  L.push('export DSH_DESKTOP_TOKEN=<本次宿主启动日志 token> # 或 --token 传参');
  L.push('node bench/batch-orchestrator.mjs plan                     # 梯次计划 JSON(确定性)');
  L.push('node bench/batch-orchestrator.mjs run --batch 1            # 冒烟(3 任务;前置健康巡检)');
  L.push('node bench/batch-orchestrator.mjs status                   # 断点状态/下一步动作');
  L.push('node bench/batch-orchestrator.mjs run --batch 2            # 门槛过后放行');
  L.push('node bench/batch-orchestrator.mjs run --batch 3            # 终批');
  L.push('```');
  L.push('');
  L.push('每批收口自动:enrich-evidence → analyze-run(该批分析/工单/基线对比)→ 下一批开跑前健康巡检(RPC 活性/python 8421-8428/磁盘 ≥5GB,异常即写 STOP 停机)。');
  return L.join('\n');
}
