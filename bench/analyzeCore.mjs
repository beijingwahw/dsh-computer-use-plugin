// bench/analyzeCore.mjs — R1-7 实战优化回路的分析核心(纯函数,零 IO/零网络/零时钟)。
//
// 证据采集 → 缺陷分析 → 优化工单 的「分析器大脑」:失败归类/统计聚合/跨任务模式/
// 基线对比/工单生成全部在此,bench/analyze-run.mjs(IO CLI)与 bench/enrich-evidence.mjs
// (采集增强)只做编排与落盘 —— 决策一律问本模块(与 driveCore/drive-hardened 同律)。
//
// 消费的三种证据形态(由 IO 层归一后喂入):
//   1. R1-4 drive-hardened 证据包:<out>/<suite>/<task-id>/{hist,session-events,journal-lines}.jsonl
//      + receipt.json + evidence/ + screenshots/(见 .survey/practice/R1-4.md);
//   2. R1-7 enrich-evidence 增强件:vlm-meter.json / retry-chain.json / kernel-snapshot.json / frames/;
//   3. battery.mjs 报告:report.json 的 results[](events 用 ev:call|result 字段)。
//
// 确定性纪律:全部输出为输入的纯函数;Map 遍历前排序;样本分位用最近邻秩法
// (与 telemetry.percentile / vlm metering.rankPercentile 同律);密钥脱敏先于落盘。

// ─── 工具族表(优化向信号的分桶键) ───

/** 走 VLM 云脑的工具 → 计量 kind(vlmMeter.byKind 的同族词表;非 VLM 工具不进表) */
export const VLM_TOOL_KINDS = {
  click_element: 'ground',        // 语义点击:grounding 主力
  zoom_inspect: 'ground',         // 放大复检:grounding 自纠
  extract_ui_vision: 'screen',    // UI 结构提取
  ask_screen: 'screen',           // 屏幕问答
  probe_interactivity: 'screen',  // 交互性探测
  read_text: 'ocr',               // 文本阅读(VLM OCR)
  find_text: 'ocr',               // 文本定位
  switch_vision_model: 'admin',   // VLM 管理面
  vlm_wizard: 'admin',
  vlm_platforms: 'admin',
};

/** journal.ACTION_TOOLS 的镜像(bench 侧不 import src/ —— 表字面量锁定,漂移由测试守护) */
export const ACTION_TOOLS = [
  'click_mouse', 'type_text', 'scroll_page', 'press_hotkey',
  'drag_mouse', 'click_element', 'switch_tab', 'switch_window', 'dismiss_popup', 'open_url',
];

/** 失败归类(任务书五分类 + pass/unknown;次序即优先级,见 classifyFailure) */
export const FAILURE_CATEGORIES = [
  'driver',        // 驱动故障:RPC/核查通道/中断 —— 基建不是任务的错
  'timing',        // 时序失败:超时/贴着超时上限结束
  'gate-blocked',  // 闸门拦截:审批/守卫/风险词 fail-closed
  'locating',      // 定位失败:grounding 反复重试/坐标无效/无视觉效应
  'comprehension', // 理解失败:工具报错/轮错误/终态与预期不符
  'unknown',       // 两侧证据缺席
];

export const FAILURE_CATEGORY_LABELS = {
  driver: '驱动故障', timing: '时序失败', 'gate-blocked': '闸门拦截',
  locating: '定位失败', comprehension: '理解失败', unknown: '未归类', pass: '通过',
};

/** VLM 降级症状 → 归一标签(receipt/events 错误文本的模式归纳) */
const DEGRADE_PATTERNS = [
  [/\b429\b|rate.?limit|too many requests/i, 'rate-limited'],
  [/breaker|circuit.?open|熔断/i, 'breaker-open'],
  [/timeout|timed?\s*out|etimedout|econnaborted/i, 'timeout'],
  [/\b5\d{2}\b|bad gateway|service unavailable/i, 'server-5xx'],
  [/json|parse|extract|unmarshal/i, 'extraction-failed'],
];

// ─── 小工具(统计原子;与库内实现同律但 bench 侧独立,零依赖) ───

export function rankPercentile(sorted, q) {
  if (!sorted || sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[idx];
}

export function median(xs) {
  if (!xs || xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return rankPercentile(s, 0.5);
}

export function mean(xs) {
  if (!xs || xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

const r3 = (x) => (x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 1000) / 1000);

// ─── 密钥脱敏(落盘前最后一道;确定性,无随机) ───

/** 长十六进制/base64 串(≥32 连续无分隔符的键料形态)→ [REDACTED:blob] */
const BLOB_RE = /[A-Za-z0-9+/_-]{32,}/g;
/** 显式键名后随值 → 键名保留、值抹除(可读性优先:知道有钥匙,不知道钥匙) */
const NAMED_RE = /\b(api[_-]?key|apikey|token|authorization|password|passwd|secret|confirm[_-]?code|bearer)\b(\s*["']?\s*[:=]\s*["']?)([^\s"',}]{4,})/gi;
const SK_RE = /\bsk-[A-Za-z0-9_-]{8,}\b/g;

/** redactSecrets —— 密钥/令牌/确认码脱敏(纯函数;路径与普通文本不动) */
export function redactSecrets(s) {
  if (typeof s !== 'string') return s;
  return s
    .replace(SK_RE, '[REDACTED:key]')
    .replace(NAMED_RE, (m, name, sep) => `${name}${sep}[REDACTED]`)
    .replace(BLOB_RE, (m) => (m.startsWith('[REDACTED') ? m : '[REDACTED:blob]'));
}

// ─── 证据行归一(两种来源 → 一种形状) ───

/**
 * normalizeHistRow —— drive hist(kind 字段)与 battery events(ev 字段)归一:
 * {ev:'call'|'result'|'assistant'|'user'|'turn_error', name, isError, turn, step, args, text, seq}
 * 未知形状安全透传(ev:null),消费方按缺席计。
 */
export function normalizeHistRow(row) {
  if (!row || typeof row !== 'object') return { ev: null };
  const ev = row.ev ?? row.kind ?? null;
  return {
    ev,
    name: row.name ?? null,
    callId: row.callId ?? row.toolCallId ?? null,
    isError: row.isError === true,
    turn: row.turn ?? null,
    step: row.step ?? null,
    seq: row.seq ?? null,
    args: typeof row.args === 'string' ? row.args : (row.args !== undefined ? JSON.stringify(row.args) : null),
    text: row.text ?? null,
    error: row.error ?? null,
  };
}

// ─── VLM 计量切片(纯函数;events = session-events.jsonl 行) ───

function parseEventData(row) {
  if (typeof row?.data !== 'string') return {};
  try { return JSON.parse(row.data); } catch { return {}; }
}

function extractTs(obj) {
  for (const k of ['ts', 'timestamp', 'at', 'time']) {
    const v = obj?.[k];
    if (typeof v === 'number' && Number.isFinite(v) && v > 1e12) return v; // epoch ms 量级
    if (typeof v === 'string' && /^\d{13,}$/.test(v)) return Number(v);
  }
  return null;
}

function classifyDegrade(text) {
  if (!text) return null;
  for (const [re, label] of DEGRADE_PATTERNS) if (re.test(text)) return label;
  return null;
}

/** tool/result 裁剪数据里的调用 id 与错误位(宿主两种嵌套形态都认;缺 ⇒ undefined) */
function resultCallInfo(rd) {
  const msg = rd?.message;
  const part = Array.isArray(msg?.content) ? msg.content[0] : undefined;
  return {
    callId: rd?.callId ?? rd?.toolCallId ?? part?.toolCallId,
    isError: rd?.isError === true || part?.isError === true,
    errorText: rd?.error ?? rd?.message?.error ?? part?.text ?? null,
  };
}

/**
 * vlmMeterFromEvents —— 从原始事件流切出 VLM 调用计量(采集增强的纯核):
 *   · call 行的 name ∈ VLM_TOOL_KINDS ⇒ 一次 VLM 族调用;
 *   · 与其后最近的 tool/result 配对(按 seq 顺序,同 callId 优先)取 isError 与错误文本;
 *   · ts 在场(事件流带 epoch ms)⇒ call→result 差值入延迟样本;缺席 ⇒ latency:null(诚实);
 *   · 错误文本过 DEGRADE_PATTERNS ⇒ 降级计数(kind 维度)。
 * 产出与 src/vlm/metering.ts summary() 同族字段(calls/failures/p50/p95/byKind),
 * 外加 degrade 分桶与 redact 过的 errorSamples(≤5 条)。
 */
export function vlmMeterFromEvents(events) {
  const rows = (events ?? []).filter((e) => e && typeof e === 'object');
  const calls = [];
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].type !== 'tool/call') continue;
    const kind = VLM_TOOL_KINDS[rows[i].name];
    if (!kind) continue;
    const data = parseEventData(rows[i]);
    const ts = extractTs(data) ?? extractTs(rows[i]);
    const callId = data.callId ?? data.id ?? undefined;
    let isError = false, errorText = null, resultTs = null;
    for (let j = i + 1; j < rows.length; j++) {
      if (rows[j].type !== 'tool/result') continue;
      if (rows[j].name && rows[i].name && rows[j].name !== rows[i].name) continue;
      const rd = parseEventData(rows[j]);
      const info = resultCallInfo(rd);
      if (info.callId !== undefined && callId !== undefined && info.callId !== callId) continue;
      isError = info.isError;
      errorText = isError ? String(info.errorText ?? (rows[j].data ?? '')).slice(0, 200) : null;
      resultTs = extractTs(rd) ?? extractTs(rows[j]);
      break;
    }
    calls.push({ kind, tool: rows[i].name, ts, isError, errorText, resultTs });
  }
  const byKind = {};
  const degrade = {};
  const errorSamples = [];
  let failures = 0;
  const latencies = [];
  for (const c of calls) {
    byKind[c.kind] = (byKind[c.kind] ?? 0) + 1;
    if (c.isError) {
      failures++;
      const d = classifyDegrade(c.errorText);
      if (d) degrade[d] = (degrade[d] ?? 0) + 1;
      if (errorSamples.length < 5) errorSamples.push(redactSecrets(String(c.errorText ?? '').slice(0, 160)));
    }
    if (c.ts !== null && c.resultTs !== null && c.resultTs >= c.ts) latencies.push(c.resultTs - c.ts);
  }
  const sorted = [...latencies].sort((a, b) => a - b);
  return {
    schema: 'r17-vlm-meter-slice/1',
    present: Array.isArray(events), // [] = 通道在场而零调用;null/undefined = 通道缺席(诚实区分)
    calls: calls.length,
    failures,
    byKind,
    degrade,
    latency: latencies.length
      ? { samples: latencies.length, p50: rankPercentile(sorted, 0.5), p95: rankPercentile(sorted, 0.95), mean: r3(mean(latencies)) }
      : { samples: 0, p50: null, p95: null, mean: null, note: '事件流无 ts(裁剪态)—— 延迟不可数,诚实缺席' },
    errorSamples,
    tools: [...new Set(calls.map((c) => c.tool))].sort(),
  };
}

// ─── 重试链(失败步的尝试序列;纯函数) ───

/**
 * retryChainsFromHist —— 从归一化历史行提取「失败步重试链」:
 *   · 历史 = call/result 交错 ⇒ 先归约为 call 序列(call↔result 配对三通道:
 *     callId 精确 > name 栈顶 > FIFO 队首 —— drive hist 的 result 无 name、
 *     battery events 的 result 有 name,两种真实形态都吃);
 *   · 再在 call 序列上找同名极大连发 = 链;
 *   · VLM 族(grounding 重试信号强):连发 ≥2 或任一发带错 ⇒ 入链;
 *   · 动作族:任一发带错才入链(同名连发全成功 = 正常桌面作业,不是重试);
 *   · attempts=连长,endedInError=链末次的错误态(自纠成功与否);
 *   · turn_error 行独立入账(轮级错误,非工具级)。
 * RPC 侧重试(receipt.retries)由调用方并入(rpcRetries 字段直通 + 分类汇总)。
 */
export function retryChainsFromHist(rows) {
  const norm = (rows ?? []).map(normalizeHistRow);
  const callsSeq = [];
  // 配对策略(两种真实形态都吃):
  //   · drive hist:result 行带 callId 无 name(call 行两者皆无)⇒ FIFO 队首(串行派发下
  //     结果按调用序到达 —— ioMutex/单会话循环的既成事实;误配界 = 乱序窗);
  //   · battery events:result 行带 name(+callId)⇒ 名字栈顶优先;
  //   · callId 双侧在场 ⇒ 精确配对(未来 drive 补 callId 时零改动点亮)。
  const fifo = [];
  const byName = new Map();
  const byCallId = new Map();
  for (const r of norm) {
    if (r.ev === 'call' && r.name) {
      callsSeq.push({ name: r.name, isError: false, errorText: null });
      const idx = callsSeq.length - 1;
      fifo.push(idx);
      byName.set(r.name, idx);
      if (r.callId) byCallId.set(r.callId, idx);
    } else if (r.ev === 'result') {
      let idx = null;
      if (r.callId && byCallId.has(r.callId)) idx = byCallId.get(r.callId);
      else if (r.name && byName.has(r.name)) idx = byName.get(r.name);
      else if (fifo.length > 0) idx = fifo[0];
      if (idx !== null) {
        if (r.isError) {
          callsSeq[idx].isError = true;
          callsSeq[idx].errorText = r.text ?? r.error ?? null;
        }
        const at = fifo.indexOf(idx);
        if (at >= 0) fifo.splice(at, 1);
        if (r.name && byName.get(r.name) === idx) byName.delete(r.name);
        for (const [k, v] of byCallId) if (v === idx) byCallId.delete(k);
      }
    }
  }
  const chains = [];
  let i = 0;
  while (i < callsSeq.length) {
    let len = 1;
    while (i + len < callsSeq.length && callsSeq[i + len].name === callsSeq[i].name) len++;
    const run = callsSeq.slice(i, i + len);
    const anyError = run.some((c) => c.isError);
    const last = run[run.length - 1];
    const isVlm = callsSeq[i].name in VLM_TOOL_KINDS;
    if ((isVlm && (len >= 2 || anyError)) || (!isVlm && anyError)) {
      chains.push({
        tool: callsSeq[i].name,
        family: isVlm ? 'vlm:' + VLM_TOOL_KINDS[callsSeq[i].name] : 'action',
        attempts: len,
        endedInError: last.isError,
        lastError: last.errorText !== null ? redactSecrets(String(last.errorText).slice(0, 160)) : null,
      });
    }
    i += len;
  }
  const turnErrors = norm.filter((r) => r.ev === 'turn_error').length;
  return { schema: 'r17-retry-chain/1', chains, turnErrors, chainCount: chains.length };
}

/** rpcRetrySummary —— receipt.retries(RPC 重试账)的确定性汇总(方法×kind 计数) */
export function rpcRetrySummary(retries) {
  const byMethod = {};
  let transient = 0, fatal = 0;
  for (const r of retries ?? []) {
    if (!r || typeof r !== 'object') continue;
    const key = `${r.method ?? '?'}:${r.kind ?? '?'}`;
    byMethod[key] = (byMethod[key] ?? 0) + 1;
    if (r.kind === 'transient') transient++; else fatal++;
  }
  return { total: (retries ?? []).length, transient, fatal, byMethod };
}

// ─── kernel/telemetry 快照(机会主义提取;纯函数) ───

/**
 * kernelSnapshotFromHist —— 在历史结果文本里找 get_metrics/metrics_dashboard 形态的
 * JSON(含 global.tools 双键或 uptime_sec),提取 telemetry 快照作为 kernel 侧观测。
 * 找不到 ⇒ {present:false}(诚实缺席:kernelRegistry 是插件进程内存态,事后不可回取;
 * 需要真快照的操作者应在 suite 里安排一次 get_metrics 调用,或接 doctor dump)。
 */
export function kernelSnapshotFromHist(rows) {
  for (const raw of rows ?? []) {
    const row = normalizeHistRow(raw);
    if (row.ev !== 'result' || !row.text) continue;
    const m = row.text.match(/\{[\s\S]*\}/);
    if (!m) continue;
    let obj;
    try { obj = JSON.parse(m[0]); } catch { continue; }
    if (obj && typeof obj === 'object' && Array.isArray(obj.tools) && (obj.global || obj.uptime_sec !== undefined)) {
      return {
        schema: 'r17-kernel-snapshot/1', present: true, source: 'hist:get_metrics-result',
        uptime_sec: obj.uptime_sec ?? null,
        global: obj.global ?? null,
        tools: obj.tools.slice(0, 16).map((t) => ({
          tool: t.tool, calls: t.calls, success_rate: t.success_rate ?? null,
          noop_rate: t.noop_rate ?? null, avg_ms: t.avg_ms ?? null, p95_ms: t.p95_ms ?? null,
        })),
      };
    }
  }
  return { schema: 'r17-kernel-snapshot/1', present: false, reason: '证据包内无 get_metrics 形态结果 —— kernelRegistry 为插件内存态,事后不可回取(如需:在 suite 任务中安排 get_metrics 收尾调用)' };
}

// ─── journal 切片的行动统计(步间隔/无效动作/守卫拦截) ───

/**
 * journalActionStats —— journal-lines.jsonl(哈希链行动日志的任务窗切片)统计:
 *   · 每动作一行(ts/tool/status/effect_detected),相邻行 ts 差 = 步间隔(含模型思考,
 *     诚实命名 stepGap 而非 toolLatency);
 *   · effect_detected===false 或 intent.satisfied===false ⇒ noopish(疑似无效动作);
 *   · tool==='GUARD_BLOCKED' 行 ⇒ 闸门拦截计数(失败归类的关键证据);
 *   · status==='FAILED' 行 ⇒ 动作失败计数。
 */
export function journalActionStats(journalRows) {
  const rows = (journalRows ?? []).filter((r) => r && typeof r === 'object' && typeof r.ts === 'number');
  const actions = rows.filter((r) => ACTION_TOOLS.includes(r.tool));
  let failed = 0, noopish = 0, guardBlocked = 0;
  const callsByTool = {};
  const gapsByTool = {};
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i];
    callsByTool[a.tool] = (callsByTool[a.tool] ?? 0) + 1;
    if (a.status === 'FAILED') failed++;
    if (a.effect_detected === false || a?.intent?.satisfied === false) noopish++;
    const next = actions[i + 1];
    if (next && next.ts >= a.ts) (gapsByTool[a.tool] ??= []).push(next.ts - a.ts);
  }
  for (const r of rows) if (r.tool === 'GUARD_BLOCKED') guardBlocked++;
  const perTool = {};
  for (const tool of [...new Set([...Object.keys(callsByTool), ...Object.keys(gapsByTool)])].sort()) {
    const gaps = gapsByTool[tool] ?? [];
    const s = [...gaps].sort((a, b) => a - b);
    perTool[tool] = {
      calls: callsByTool[tool] ?? gaps.length,
      gapSamples: gaps.length,
      stepGapMean: gaps.length ? r3(mean(gaps)) : null, // 尾行动无下一行 ⇒ 无间隔(诚实 null,不冒充 0)
      stepGapP95: rankPercentile(s, 0.95),
      totalTimeMs: gaps.reduce((x, y) => x + y, 0),
    };
  }
  return {
    schema: 'r17-journal-stats/1',
    present: rows.length > 0,
    actionCalls: actions.length,
    failed, noopish, guardBlocked,
    noopishRate: actions.length ? r3(noopish / actions.length) : null,
    perTool,
  };
}

// ─── 失败归类(五分类;优先级次序即声明,可测试) ───

/**
 * classifyFailure —— 单任务失败归类(纯函数)。判序(前者吞掉后者,基建错优先于任务错):
 *   0. pass===true ⇒ 'pass';
 *   1. 驱动故障:harnessError/interrupted/E2 通道自身崩溃(channelError);
 *   2. 时序失败:timedOut,或 waitedMs 贴住生效上限(≥98%);
 *   3. 闸门拦截:journal 切片 GUARD_BLOCKED>0,或历史文本带审批死锁特征
 *      (confirm-code-required / code-attempts-exhausted / approval 阻塞);
 *   4. 定位失败:VLM 族错误率 ≥50%(calls≥3),或同名工具最长连发 ≥3(反复重定位),
 *      或 journal noopishRate ≥40%;
 *   5. 理解失败:工具报错/轮错误在场,或终判 fail 且轨迹与 E2 证据齐全(执行了但错了);
 *   6. 其余(两侧证据缺席的 unknown 终判)⇒ 'unknown'。
 */
export function classifyFailure(view) {
  const v = view ?? {};
  if (v.pass === true) return 'pass';
  if (v.harnessError || v.interrupted || v.channelError) return 'driver';
  if (v.timedOut === true) return 'timing';
  if (typeof v.waitedMs === 'number' && typeof v.effectiveTimeoutMs === 'number'
    && v.effectiveTimeoutMs > 0 && v.waitedMs / v.effectiveTimeoutMs >= 0.98) return 'timing';
  if ((v.guardBlocked ?? 0) > 0 || v.approvalDeadlock === true) return 'gate-blocked';
  const vlmCalls = v.vlm?.calls ?? 0;
  const vlmErrRate = vlmCalls >= 3 ? (v.vlm.failures ?? 0) / vlmCalls : null;
  const noopishRate = v.journal?.noopishRate ?? null;
  if ((vlmErrRate !== null && vlmErrRate >= 0.5) || (v.maxConsecutiveRepeat ?? 0) >= 3
    || (noopishRate !== null && noopishRate >= 0.4)) return 'locating';
  if ((v.toolErrors ?? 0) > 0 || (v.turnErrors ?? 0) > 0 || v.pass === false) return 'comprehension';
  return 'unknown';
}

// ─── 单任务视图构建(IO 层喂原始材料,此处纯变换) ───

/**
 * buildTaskView —— 原始材料 → 归一任务视图(raw 形状见 analyze-run.mjs 的装载器):
 *   raw = { taskId, category, receipt, histRows, events, journalRows, enriched?, evidencePaths }
 *   receipt 统一为 drive-receipt 形状(battery 的 rec 由 IO 层先行转写)。
 * 输出 view = 归一信号 + classifyFailure 的落点 + 证据路径(工单引用)。
 */
export function buildTaskView(raw) {
  const receipt = raw.receipt ?? {};
  const rows = (raw.histRows ?? []).map(normalizeHistRow);
  const meter = raw.enriched?.vlmMeter ?? vlmMeterFromEvents(raw.events ?? []);
  const chain = raw.enriched?.retryChain ?? retryChainsFromHist(rows);
  const journal = raw.enriched?.journalStats ?? journalActionStats(raw.journalRows ?? []);

  const calls = rows.filter((r) => r.ev === 'call' && r.name);
  // 同名工具最长连发(重定位信号)
  let maxConsecutiveRepeat = 0, run = 0, lastName = null;
  for (const c of calls) {
    run = c.name === lastName ? run + 1 : 1;
    lastName = c.name;
    if (run > maxConsecutiveRepeat) maxConsecutiveRepeat = run;
  }
  const hay = JSON.stringify(rows.map((r) => ({ n: r.name, t: (r.text ?? '').slice(0, 400), e: r.error ?? null })));
  const approvalDeadlock = /confirm-code-required|code-attempts-exhausted|confirm-channel-absent|approval.*(死锁|blocked|pending)/i.test(hay);

  const view = {
    taskId: raw.taskId,
    category: raw.category ?? null,
    pass: receipt.pass,
    trajectoryPass: receipt.trajectoryPass ?? null,
    e2: receipt.e2 ? { present: !!receipt.e2.present, pass: receipt.e2.result?.pass ?? null, channelError: receipt.e2.result?.channelError === true } : { present: false },
    timedOut: receipt.timedOut === true,
    waitedMs: receipt.waitedMs ?? null,
    effectiveTimeoutMs: receipt.timeoutPlan?.effective ?? null,
    harnessError: receipt.harnessError ? redactSecrets(String(receipt.harnessError).slice(0, 200)) : null,
    interrupted: receipt.interrupted === true,
    promptUncertain: receipt.promptUncertain === true,
    channelError: receipt.e2?.result?.channelError === true,
    guardBlocked: journal.guardBlocked,
    approvalDeadlock,
    vlm: { calls: meter.calls, failures: meter.failures, byKind: meter.byKind, degrade: meter.degrade, latency: meter.latency },
    journal,
    steps: calls.length,
    toolErrors: rows.filter((r) => r.ev === 'result' && r.isError).length,
    turnErrors: chain.turnErrors ?? 0,
    maxConsecutiveRepeat,
    retryChain: chain,
    rpc: rpcRetrySummary(receipt.retries ?? []),
    toolCalls: calls.map((c) => c.name),
    failedExpectations: receipt.failedExpectations ?? null,
    kernel: raw.enriched?.kernelSnapshot ?? null,
    frames: raw.enriched?.frames ?? null,
    evidencePaths: raw.evidencePaths ?? {},
  };
  view.failureCategory = classifyFailure(view);
  return view;
}

// ─── 聚合(任务级 → 轮级) ───

function histogram(values) {
  const h = {};
  for (const v of values) h[v] = (h[v] ?? 0) + 1;
  return Object.fromEntries(Object.entries(h).sort((a, b) => a[0].localeCompare(b[0])));
}

/**
 * aggregateViews —— 轮级统计(纯函数):通过率/步数分布/每步工具耗时(journal stepGap)/
 * VLM 调用与延迟/失败归类直方图/任务清单(按 id 排序,确定性)。
 */
export function aggregateViews(views) {
  const vs = [...(views ?? [])].sort((a, b) => String(a.taskId).localeCompare(String(b.taskId)));
  const firsts = vs.filter((v) => !v.isRerun);
  const steps = firsts.map((v) => v.steps).filter((n) => Number.isFinite(n));
  const perTool = {};
  for (const v of firsts) {
    for (const [tool, st] of Object.entries(v.journal?.perTool ?? {})) {
      const acc = perTool[tool] ??= { calls: 0, totalTimeMs: 0, gapSamples: [] };
      acc.calls += st.calls ?? 0;
      acc.totalTimeMs += st.totalTimeMs ?? 0;
      if (st.stepGapMean !== null && st.stepGapMean !== undefined) acc.gapSamples.push(st.stepGapMean * st.calls);
    }
  }
  const perToolAgg = {};
  for (const [tool, acc] of Object.entries(perTool).sort((a, b) => a[0].localeCompare(b[0]))) {
    perToolAgg[tool] = {
      calls: acc.calls,
      stepGapMean: acc.calls ? r3(acc.totalTimeMs / acc.calls) : null,
    };
  }
  const vlmLatencies = firsts.flatMap((v) => (v.vlm?.latency && v.vlm.latency.samples ? [v.vlm.latency] : []));
  const degrade = {};
  let vlmCalls = 0, vlmFailures = 0;
  for (const v of firsts) {
    vlmCalls += v.vlm?.calls ?? 0;
    vlmFailures += v.vlm?.failures ?? 0;
    for (const [k, n] of Object.entries(v.vlm?.degrade ?? {})) degrade[k] = (degrade[k] ?? 0) + n;
  }
  const failures = firsts.filter((v) => v.pass === false);
  return {
    schema: 'r17-aggregate/1',
    tasks: firsts.length,
    pass: firsts.filter((v) => v.pass === true).length,
    fail: failures.length,
    unknown: firsts.filter((v) => v.pass === undefined || v.pass === null).length,
    passRate: firsts.length ? r3(firsts.filter((v) => v.pass === true).length / firsts.length) : null,
    steps: {
      min: steps.length ? Math.min(...steps) : null,
      p50: median(steps),
      max: steps.length ? Math.max(...steps) : null,
      mean: r3(mean(steps)),
    },
    perTool: perToolAgg,
    vlm: {
      calls: vlmCalls, failures: vlmFailures,
      failureRate: vlmCalls ? r3(vlmFailures / vlmCalls) : null,
      degrade,
      p50Latency: vlmLatencies.length ? median(vlmLatencies.map((l) => l.p50).filter((x) => x !== null)) : null,
      p95Latency: vlmLatencies.length ? median(vlmLatencies.map((l) => l.p95).filter((x) => x !== null)) : null,
    },
    failuresByCategory: histogram(firsts.filter((v) => v.pass !== true).map((v) => v.failureCategory)),
    byCategory: (() => {
      const cats = {};
      for (const v of firsts) {
        const c = cats[v.category ?? 'uncategorized'] ??= { total: 0, pass: 0, fail: 0, unknown: 0 };
        c.total++;
        if (v.pass === true) c.pass++;
        else if (v.pass === false) c.fail++;
        else c.unknown++;
      }
      return Object.fromEntries(Object.entries(cats).sort((a, b) => a[0].localeCompare(b[0])));
    })(),
    tasksSummary: firsts.map((v) => ({
      taskId: v.taskId, category: v.category ?? null, pass: v.pass ?? null,
      failureCategory: v.failureCategory, steps: v.steps, vlmCalls: v.vlm?.calls ?? 0,
      timedOut: v.timedOut, rpcRetries: v.rpc?.total ?? 0,
    })),
  };
}

// ─── 跨任务模式(哪族工具慢/哪类屏幕 grounding 差/降级热点) ───

/**
 * crossTaskPatterns —— 轮级模式提取(纯函数):
 *   · slowTools:journal stepGap 均值降序(calls≥3 才参战 —— 小样本无分辨力);
 *   · groundingPoor:VLM ground 族 calls≥3 且(错误率≥50% 或最长连发≥3 或 noopish≥40%)的任务;
 *   · degradeHotspots:VLM 降级症状(429/熔断/超时/…)按任务计数;
 *   · repeatHotspots:重试链最长的工具族;
 *   · timeoutTasks / driverFaults / gateBlocks:结构性失败清单(工单原料)。
 */
export function crossTaskPatterns(views) {
  const vs = [...(views ?? [])].sort((a, b) => String(a.taskId).localeCompare(String(b.taskId)));
  const slowTools = [];
  for (const [tool, st] of Object.entries(aggregateViews(vs).perTool)) {
    if (st.calls >= 3 && st.stepGapMean !== null) slowTools.push({ tool, calls: st.calls, stepGapMean: st.stepGapMean });
  }
  slowTools.sort((a, b) => (b.stepGapMean - a.stepGapMean) || a.tool.localeCompare(b.tool));

  const groundingPoor = vs.filter((v) => {
    const groundCalls = (v.vlm.byKind?.ground ?? 0) + (v.vlm.byKind?.screen ?? 0);
    if (groundCalls < 3) return false;
    const errRate = groundCalls ? (v.vlm.failures ?? 0) / groundCalls : 0;
    const noopish = v.journal?.noopishRate ?? 0;
    return errRate >= 0.5 || (v.maxConsecutiveRepeat ?? 0) >= 3 || noopish >= 0.4;
  }).map((v) => ({
    taskId: v.taskId,
    vlmGroundCalls: (v.vlm.byKind?.ground ?? 0) + (v.vlm.byKind?.screen ?? 0),
    vlmFailures: v.vlm.failures ?? 0,
    maxConsecutiveRepeat: v.maxConsecutiveRepeat,
    noopishRate: v.journal?.noopishRate ?? null,
  }));

  const degradeHotspots = vs
    .map((v) => ({ taskId: v.taskId, degrade: v.vlm.degrade ?? {}, total: Object.values(v.vlm.degrade ?? {}).reduce((a, b) => a + b, 0) }))
    .filter((d) => d.total > 0)
    .sort((a, b) => b.total - a.total || a.taskId.localeCompare(b.taskId));

  const repeatAgg = {};
  for (const v of vs) {
    for (const c of v.retryChain?.chains ?? []) {
      const key = c.family + ':' + c.tool;
      repeatAgg[key] = Math.max(repeatAgg[key] ?? 0, c.attempts);
    }
  }
  const repeatHotspots = Object.entries(repeatAgg)
    .map(([key, maxAttempts]) => ({ tool: key, maxAttempts }))
    .filter((r) => r.maxAttempts >= 3)
    .sort((a, b) => b.maxAttempts - a.maxAttempts || a.tool.localeCompare(b.tool));

  return {
    schema: 'r17-patterns/1',
    slowTools,
    groundingPoor,
    degradeHotspots,
    repeatHotspots,
    timeoutTasks: vs.filter((v) => v.timedOut).map((v) => v.taskId),
    driverFaults: vs.filter((v) => v.failureCategory === 'driver').map((v) => ({ taskId: v.taskId, harnessError: v.harnessError })),
    gateBlocks: vs.filter((v) => (v.guardBlocked ?? 0) > 0 || v.approvalDeadlock).map((v) => ({ taskId: v.taskId, guardBlocked: v.guardBlocked ?? 0, approvalDeadlock: v.approvalDeadlock })),
  };
}

// ─── 基线对比(与旧轮;纯函数) ───

/**
 * compareWithBaselineReport —— 当前轮 vs 基线轮(同任务 id 交集为唯一比较总体,
 * battery ΠΑΝ-98 同律):通过率差/步数差/逐任务翻转(regressed=基线过今败,
 * improved=基线败今过)/失败归类迁移。基线缺席 ⇒ null(首轮,调用方负责固化)。
 */
export function compareWithBaselineReport(current, baseline) {
  if (!baseline || !baseline.aggregate) return null;
  const curById = new Map((current.tasksSummary ?? []).map((t) => [t.taskId, t]));
  const baseById = new Map((baseline.aggregate.tasksSummary ?? []).map((t) => [t.taskId, t]));
  const shared = [...new Set([...curById.keys()].filter((id) => baseById.has(id)))].sort();
  const regressed = [], improved = [];
  for (const id of shared) {
    const c = curById.get(id), b = baseById.get(id);
    if (b.pass === true && c.pass === false) regressed.push(id);
    if (b.pass === false && c.pass === true) improved.push(id);
  }
  const curPass = shared.filter((id) => curById.get(id).pass === true).length;
  const basePass = shared.filter((id) => baseById.get(id).pass === true).length;
  const curSteps = shared.map((id) => curById.get(id).steps).filter((n) => Number.isFinite(n));
  const baseSteps = shared.map((id) => baseById.get(id).steps).filter((n) => Number.isFinite(n));
  return {
    schema: 'r17-baseline-compare/1',
    baselineRunId: baseline.runId ?? null,
    sharedTasks: shared.length,
    currentOnly: [...curById.keys()].filter((id) => !baseById.has(id)).sort(),
    baselineOnly: [...baseById.keys()].filter((id) => !curById.has(id)).sort(),
    sharedPass: { current: curPass, baseline: basePass },
    passRateDelta: shared.length ? r3(curPass / shared.length - basePass / shared.length) : null,
    stepsDelta: curSteps.length && baseSteps.length ? r3(mean(curSteps) - mean(baseSteps)) : null,
    regressed, improved,
    failureCategoryShift: {
      current: current.failuresByCategory ?? {},
      baseline: baseline.aggregate.failuresByCategory ?? {},
    },
    note: '同总体口径:仅两轮共有任务(ΠΑΝ-98 同律);比例差无显著性检验(逐任务 SPRT 由 battery 管,此处为工单向描述统计)',
  };
}

// ─── 工单生成(分析报告 → 下一波优化的直接输入) ───

/** 工单 schema:r17-ticket/1 —— 现象/证据包路径/疑似模块/优先级(任务书契约) */
let ticketSeq = 0; // 模块内序号发生器(buildTickets 入口重置 —— 同输入同序号,确定性)

function mkTicket({ title, symptom, evidence, suspectedModule, priority, hint }) {
  ticketSeq += 1;
  const id = `R17-${String(ticketSeq).padStart(3, '0')}`;
  return { id, schema: 'r17-ticket/1', title, symptom, evidence, suspectedModule, priority, hint: hint ?? null };
}

/**
 * buildTickets —— 规则式工单生成(纯函数;规则次序即工单次序,同输入同输出):
 *   P0:驱动故障簇(≥1)/ 闸门拦截簇(≥1)/ 通过率对基线回归;
 *   P1:定位失败簇 / grounding 差屏幕簇 / 时序(超时)簇 / VLM 降级热点;
 *   P2:慢工具族 / journal 缺席或丢行 / promptUncertain / kernel 快照缺席(观测面缺口)。
 * evidence 字段是证据包内的**相对路径数组**(调用方负责拼根)。
 */
export function buildTickets({ views, aggregate, patterns, compare, evidenceRoot = '' }) {
  ticketSeq = 0;
  const tickets = [];
  const rel = (taskId, file) => `${evidenceRoot ? evidenceRoot + '/' : ''}${taskId}/${file}`;
  const catTasks = (cat) => views.filter((v) => v.failureCategory === cat).map((v) => v.taskId).sort();

  // P0 ── 驱动故障(基建错吞任务,修不动任务先修路)
  const driverTasks = catTasks('driver');
  if (driverTasks.length > 0) {
    tickets.push(mkTicket({
      title: `驱动故障簇:${driverTasks.length} 个任务被基建错误吞掉`,
      symptom: `任务 ${driverTasks.join(', ')} 终判受 harnessError/中断/E2 通道错误影响,任务语义不可判`,
      evidence: driverTasks.map((id) => rel(id, 'receipt.json')),
      suspectedModule: 'bench/drive-hardened.mjs RPC 链 + bench/verifyCore.mjs E2 通道',
      priority: 'P0',
      hint: '先看 receipt.harnessError 与 rpc 重试账;通道错区分端点抖动与谓词世界失联',
    }));
  }
  // P0 ── 闸门拦截(审批 fail-closed 死锁,R1-6 已知形态)
  const gateTasks = catTasks('gate-blocked');
  if (gateTasks.length > 0) {
    tickets.push(mkTicket({
      title: `闸门拦截簇:${gateTasks.length} 个任务卡在审批/守卫`,
      symptom: `任务 ${gateTasks.join(', ')} 的 journal 切片含 GUARD_BLOCKED 行或历史文本带 confirm-code-required/approval 死锁特征`,
      evidence: gateTasks.map((id) => rel(id, 'journal-lines.jsonl')),
      suspectedModule: 'src/riskGate.ts dangerPatterns + src/approval.ledger.ts 带外确认码(R1-6:stock 宿主内码不可达)',
      priority: 'P0',
      hint: '操场模式按 R1-6 模式 B 收窄 dangerPatterns;真不可逆词保留 fail-closed 是正确行为',
    }));
  }
  // P0 ── 基线回归(共有任务翻车)
  if (compare && compare.regressed && compare.regressed.length > 0) {
    tickets.push(mkTicket({
      title: `基线回归:${compare.regressed.length} 个共有任务由过转败`,
      symptom: `任务 ${compare.regressed.join(', ')} 在基线轮(${compare.baselineRunId ?? '?'})通过、本轮失败;passRateDelta=${compare.passRateDelta}`,
      evidence: compare.regressed.map((id) => rel(id, 'receipt.json')),
      suspectedModule: '待分诊(先 diff 两轮 receipt 的 toolCalls 与 E2 checks)',
      priority: 'P0',
      hint: '逐任务看 failedExpectations 与 verify.checks 的 fail 项;环境漂移(窗口布局/文件残留)优先排除',
    }));
  }
  // P1 ── 定位失败簇(grounding 反复重试)
  const locTasks = catTasks('locating');
  if (locTasks.length > 0) {
    tickets.push(mkTicket({
      title: `定位失败簇:${locTasks.length} 个任务 grounding 反复重试`,
      symptom: `任务 ${locTasks.join(', ')} 呈现 VLM 族错误率≥50% / 同名工具连发≥3 / noopish≥40% 之一`,
      evidence: locTasks.map((id) => rel(id, 'session-events.jsonl')),
      suspectedModule: 'src/vlm/grounding.ts + src/tools/clickElement.ts 提示词 + zoom_inspect 自纠回路',
      priority: 'P1',
      hint: '对照 frames/ 首末帧人工复盘该屏幕;click_element 连发优先查坐标归一化与 som 布局',
    }));
  }
  // P1 ── grounding 差的具体屏幕(跨任务模式)
  if (patterns.groundingPoor.length >= 1) {
    tickets.push(mkTicket({
      title: `grounding 质量差的屏幕:${patterns.groundingPoor.length} 个任务命中`,
      symptom: patterns.groundingPoor.map((g) => `${g.taskId}(groundCalls=${g.vlmGroundCalls},fails=${g.vlmFailures},maxRepeat=${g.maxConsecutiveRepeat},noopish=${g.noopishRate})`).join('; '),
      evidence: patterns.groundingPoor.map((g) => rel(g.taskId, 'frames/')),
      suspectedModule: 'src/vlm/som.ts + src/uiExtractor.ts(屏幕结构化质量)+ 任务 prompt 的目标描述',
      priority: 'P1',
      hint: 'frames/ 首末帧留档供人工复盘;同屏多任务命中 ⇒ 屏幕本身(密集小目标/中文渲染)是变量',
    }));
  }
  // P1 ── 时序失败簇
  const timingTasks = catTasks('timing');
  if (timingTasks.length > 0) {
    tickets.push(mkTicket({
      title: `时序失败簇:${timingTasks.length} 个任务超时/贴顶`,
      symptom: `任务 ${timingTasks.join(', ')} timedOut 或 waitedMs≥98% 生效上限`,
      evidence: timingTasks.map((id) => rel(id, 'receipt.json')),
      suspectedModule: 'suite timeoutMs 预算 + config.mouseSpeed(拟人延迟 ↔ 时长上限的权衡)',
      priority: 'P1',
      hint: '步数不高仍超时 ⇒ mouseSpeed/长等待;步数爆炸 ⇒ 定位回路差(转定位工单)',
    }));
  }
  // P1 ── VLM 降级热点
  if (patterns.degradeHotspots.length > 0) {
    tickets.push(mkTicket({
      title: `VLM 降级热点:${patterns.degradeHotspots.length} 个任务出现服务端症状`,
      symptom: patterns.degradeHotspots.map((d) => `${d.taskId}:${JSON.stringify(d.degrade)}`).join('; '),
      evidence: patterns.degradeHotspots.map((d) => rel(d.taskId, 'vlm-meter.json')),
      suspectedModule: 'src/vlm/providers(429 回填/熔断)+ src/vlm/metering.ts 限流双桶',
      priority: 'P1',
      hint: 'rate-limited 集中出现 ⇒ 调 maxPerMinute 或错峰;breaker-open ⇒ 查主模型健康',
    }));
  }
  // P2 ── 慢工具族(吞吐优化向)
  if (patterns.slowTools.length > 0) {
    const top = patterns.slowTools.slice(0, 3);
    tickets.push(mkTicket({
      title: `慢工具族:stepGap 均值 TOP${top.length}`,
      symptom: top.map((t) => `${t.tool}(calls=${t.calls},stepGapMean=${t.stepGapMean}ms)`).join('; ') + '(含模型思考时间,非纯工具延迟)',
      evidence: views.filter((v) => Object.keys(v.journal?.perTool ?? {}).length > 0).slice(0, 3).map((v) => rel(v.taskId, 'journal-lines.jsonl')),
      suspectedModule: 'src/physicalBackend(鼠标轨迹拟人)+ src/vlm(glmClient 延迟)',
      priority: 'P2',
      hint: 'stepGap 是动作到下一动作的间隔:大头通常在 VLM 思考;对照 vlm-meter.json 延迟切片再归因',
    }));
  }
  // P2 ── journal 观测面缺口
  const noJournal = views.filter((v) => v.journal && v.journal.present === false).map((v) => v.taskId).sort();
  if (noJournal.length > 0) {
    tickets.push(mkTicket({
      title: `journal 切片缺席:${noJournal.length} 个任务无行动日志`,
      symptom: `任务 ${noJournal.join(', ')} 的 journal-lines.jsonl 为空(journal 未启用/路径不对/时间窗切空)`,
      evidence: noJournal.map((id) => rel(id, 'journal-lines.jsonl')),
      suspectedModule: 'DSH_BENCH_JOURNAL 路径配置 + src/journal.ts 落盘 + drive journalWindow 切片窗',
      priority: 'P2',
      hint: 'noopish/GUARD_BLOCKED/步间隔全部依赖 journal;缺它则定位/闸门归类的证据面塌一半',
    }));
  }
  // P2 ── promptUncertain(RPC 防重复回退的暗账)
  const uncertain = views.filter((v) => v.promptUncertain).map((v) => v.taskId).sort();
  if (uncertain.length > 0) {
    tickets.push(mkTicket({
      title: `promptUncertain:${uncertain.length} 个任务下发证据不足`,
      symptom: `任务 ${uncertain.join(', ')} 的 prompt 瞬态失败后历史不可读(hold-uncertain),不排除未下发/重复下发`,
      evidence: uncertain.map((id) => rel(id, 'receipt.json')),
      suspectedModule: 'bench/drive-hardened.mjs sendPromptSafe 三证逻辑 + RPC 稳定性',
      priority: 'P2',
      hint: '对照 hist.jsonl 开头 user 行数量:0 ⇒ 可能未下发;2 ⇒ 可能双发',
    }));
  }
  // P2 ── kernel 快照观测面缺口(一次性提一张,不逐任务刷屏)
  const noKernel = views.filter((v) => v.kernel && v.kernel.present === false).length;
  if (noKernel === views.length && views.length > 0) {
    tickets.push(mkTicket({
      title: 'kernel/telemetry 快照缺席:全轮无 get_metrics 观测点',
      symptom: `全部 ${noKernel} 个任务的历史里没有 get_metrics 形态结果 —— kernelRegistry/telemetry 内存态事后不可回取`,
      evidence: views.slice(0, 1).map((v) => rel(v.taskId, 'hist.jsonl')),
      suspectedModule: 'suite 任务设计(收尾步加一次 get_metrics)+ bench/enrich-evidence.mjs 的机会主义提取',
      priority: 'P2',
      hint: '在代表性任务的 prompt 末尾追加「完成后调用一次 get_metrics」即可点亮该观测面',
    }));
  }
  return tickets;
}

// ─── 人读 markdown 渲染(纯函数;确定性) ───

const pct = (x) => (x === null || x === undefined ? '-' : `${Math.round(x * 1000) / 10}%`);

export function renderReportMarkdown({ runId, suiteName, aggregate, patterns, compare, tickets, enrichStats }) {
  const L = [];
  L.push(`# R1-7 跑批分析报告`);
  L.push('');
  L.push(`- run: \`${runId ?? '?'}\` · suite: \`${suiteName ?? '?'}\``);
  L.push(`- 通过率: **${aggregate.pass}/${aggregate.tasks}(${pct(aggregate.passRate)})**` +
    ` · fail=${aggregate.fail} unknown=${aggregate.unknown}`);
  L.push(`- 步数分布: min=${aggregate.steps.min} p50=${aggregate.steps.p50} max=${aggregate.steps.max} mean=${aggregate.steps.mean}`);
  L.push(`- VLM: calls=${aggregate.vlm.calls} 失败率=${pct(aggregate.vlm.failureRate)} p50=${aggregate.vlm.p50Latency ?? '-'}ms p95=${aggregate.vlm.p95Latency ?? '-'}ms` +
    (Object.keys(aggregate.vlm.degrade).length ? ` 降级=${JSON.stringify(aggregate.vlm.degrade)}` : ''));
  if (enrichStats) L.push(`- 采集增强: ${enrichStats}`);
  L.push('');
  L.push(`## 失败归类(判序优先级:驱动故障 > 时序 > 闸门拦截 > 定位 > 理解;前者吞掉后者)`);
  L.push('');
  L.push(`| 类别 | 数量 | 任务 |`);
  L.push(`| --- | --- | --- |`);
  const byCat = {};
  for (const t of aggregate.tasksSummary) if (t.pass !== true) (byCat[t.failureCategory] ??= []).push(t.taskId);
  for (const cat of FAILURE_CATEGORIES) {
    if (byCat[cat]) L.push(`| ${FAILURE_CATEGORY_LABELS[cat]} | ${byCat[cat].length} | ${byCat[cat].join(', ')} |`);
  }
  L.push('');
  L.push(`## 跨任务模式`);
  L.push('');
  L.push(`- 慢工具族(stepGap 均值,含思考): ${patterns.slowTools.map((t) => `${t.tool}=${t.stepGapMean}ms(n=${t.calls})`).join(', ') || '无样本'}`);
  L.push(`- grounding 差屏幕: ${patterns.groundingPoor.map((g) => g.taskId).join(', ') || '无'}`);
  L.push(`- VLM 降级热点: ${patterns.degradeHotspots.map((d) => `${d.taskId}(${JSON.stringify(d.degrade)})`).join(', ') || '无'}`);
  L.push(`- 重试链热点: ${patterns.repeatHotspots.map((r) => `${r.tool}×${r.maxAttempts}`).join(', ') || '无'}`);
  L.push(`- 超时任务: ${patterns.timeoutTasks.join(', ') || '无'}`);
  L.push('');
  if (compare) {
    L.push(`## 与基线对比(${compare.baselineRunId ?? '?'})`);
    L.push('');
    L.push(`- 共有任务 ${compare.sharedTasks}:当前过 ${compare.sharedPass.current} vs 基线过 ${compare.sharedPass.baseline}(Δ=${compare.passRateDelta})`);
    L.push(`- 回归 ${compare.regressed.join(', ') || '无'} · 改善 ${compare.improved.join(', ') || '无'} · 步数Δ=${compare.stepsDelta}`);
    L.push('');
  }
  L.push(`## 任务清单`);
  L.push('');
  L.push(`| 任务 | 类别 | 终判 | 归类 | 步数 | VLM | 超时 | RPC重试 |`);
  L.push(`| --- | --- | --- | --- | --- | --- | --- | --- |`);
  for (const t of aggregate.tasksSummary) {
    L.push(`| ${t.taskId} | ${t.category ?? '-'} | ${t.pass === null ? '?' : t.pass ? 'PASS' : 'FAIL'} | ${FAILURE_CATEGORY_LABELS[t.failureCategory]} | ${t.steps} | ${t.vlmCalls} | ${t.timedOut ? 'Y' : '-'} | ${t.rpcRetries} |`);
  }
  L.push('');
  L.push(`## 工单(${tickets.length} 条)`);
  L.push('');
  for (const t of tickets) {
    L.push(`### [${t.priority}] ${t.id} ${t.title}`);
    L.push(`- 现象: ${t.symptom}`);
    L.push(`- 证据: ${Array.isArray(t.evidence) ? t.evidence.join(' ; ') : t.evidence}`);
    L.push(`- 疑似模块: ${t.suspectedModule}`);
    if (t.hint) L.push(`- 处置提示: ${t.hint}`);
    L.push('');
  }
  return L.join('\n');
}
