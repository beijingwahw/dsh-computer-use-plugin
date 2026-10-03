// src/processScore.ts
// W3-8(创新提案 E4):免标注过程评分器 —— step credit assignment。
//
// 世界观:终局分(任务成没成)是稀疏的 0/1 信号;一条轨迹里真正稠密的信息在
// 过程里 —— 每一步的动作效果、意图佐证、振荡与浪费。本模块离线回放 journal
// JSONL 轨迹(journal.ts 哈希链行格式),把每步可得证据量化为 0-1 步分,再聚合
// 成任务级过程分 —— 免标注:不需要人工打标,证据全部来自链上既有字段。
//
// W3-8 设计铁律:
//   1. 纯函数核心 + 离线确定性:零依赖、零 IO、零随机 —— 同一输入永远同一报告
//      (跨版本对比的前提;四通道定义/权重/聚合公式任一变更必须 bump
//      SCORE_CALIBER_VERSION,否则版本间分数不可比)。
//   2. 口径诚实:字段缺席 ⇒ 该通道记 0.5 中性并计数 —— 「没有证据」与「证据
//      不利」是两回事(缺席不是 0 分;与 Δ-7 诚实降级同律)。
//   3. 防御式绝不抛:垃圾行/缺字段跳过并计数、空轨迹诚实报空、病态载荷
//      (环形 args / BigInt)就地降级,最外层兜底捕获产出 ok=false 报告。
//
// 四通道(每步各 [0,1],加权合成步分;权重模块常量 + 可注入):
//   effect      动作效果:detected × scale(page-level 1.0 / element-level 0.9 /
//               缺席或矛盾 0.95 —— 双尺度中点,不猜测哪个对)。
//   intent      意图佐证:证据阶梯 intent.satisfied > phashCorroborates > thought
//               (actionVerifier.ts 的 CombinedEffect 字段落盘到 journal 行顶层后
//               即被采信;当前未落盘 ⇒ 0.5 中性 + 缺席计数)。
//   oscillation 振荡惩罚:连续同签名(tool + args 指纹)run=1/2/≥3 ⇒ 1.0/0.5/0;
//               环境重塑 marker(ENV_SHAPED/SENSE_SHIFT/AGENT_BEGIN)重置 run。
//   wait        等待浪费:连续无效果 streak 每步递减 0.4(单次失败 = 探索容错
//               0.6,连续失败 = 进度停滞 → 0);「无效果信息」(缺席)= 中性 0.5。
/** 口径版本号:四通道刻度/权重语义/聚合公式任一变更 ⇒ 必须 bump(跨版本可比的锚) */
export const SCORE_CALIBER_VERSION = 'E4-v1';
// ── W3-8 刻度常量(全部进报告 calibration 回显,消费方可复算) ──
/** scale → effect 通道刻度:页面级变化(导航/弹窗/大区块) */
export const SCALE_VALUE_PAGE = 1.0;
/** scale → effect 通道刻度:元素级变化(文字输入/光标出现)—— 真实但弱于页面级 */
export const SCALE_VALUE_ELEMENT = 0.9;
/** scale 缺席/矛盾(detected=true 而 scale='none')⇒ 双档中点,不站队 */
export const SCALE_VALUE_UNKNOWN = 0.95;
/** intent 证据阶梯:物理规则证实期望 */
export const INTENT_VALUE_SATISFIED = 1.0;
/** intent 证据阶梯:规则否证(变化不是预期的变化) */
export const INTENT_VALUE_UNSATISFIED = 0.0;
/** intent 证据阶梯:pHash 频谱第二意见同判(Q-2 佐证) */
export const INTENT_VALUE_PHASH_AGREE = 0.9;
/** intent 证据阶梯:pHash 异议 —— 证据冲突,存疑但不下 0.4 定罪 */
export const INTENT_VALUE_PHASH_DISSENT = 0.4;
/** intent 证据阶梯:仅有出声思考(thought)—— 弱佐证,意图可解释 ≠ 意图正确 */
export const INTENT_VALUE_THOUGHT_ONLY = 0.6;
/** osc 刻度:连续同签名第 2 次(一次重试在容错域内 ⇒ 减半) */
export const OSC_RUN2 = 0.5;
/** wait 刻度:每多一步连续无效果递减 0.4(streak=1→0.6, 2→0.2, ≥3→0) */
export const WAIT_STREAK_DECAY = 0.4;
/** 过程分与终局分的混合比(blended 参考值;并报不替代) */
export const BLEND_PROCESS = 0.7;
export const BLEND_FINAL = 0.3;
/**
 * W3-8 默认四通道权重。理由:
 *   effect 0.45 —— 主通道:「这一步改变了世界吗」是过程质量的直接证据;
 *   intent 0.15 —— 佐证通道:当前 journal 大多不落盘 intent/phash(缺席=0.5),
 *                   权重过高会稀释主信号,过低则退化为纯结果主义;
 *   oscillation 0.2 / wait 0.2 —— 浪费通道的两种正交形态:空间重复(同签名
 *                   反复执行)与时间停滞(连续无效果),等权对偶。
 */
export const DEFAULT_CHANNEL_WEIGHTS = Object.freeze({
    effect: 0.45, intent: 0.15, oscillation: 0.2, wait: 0.2,
});
/** 首低分步锚定阈值:低于此的首步被自动锚定。落在中性基线(≈0.6)与
 *  明确无效(≈0.1-0.3)之间 —— 只有「有明确负面证据」的步才被点名。 */
export const DEFAULT_LOW_STEP_THRESHOLD = 0.35;
/** PBR 风格晚期偏置 λ:步权重 w_i = (1-λ) + 2λ·i/(n-1) —— 后期步权重高
 *  (任务后期的无效步比开局的探索失败更致命;λ=0.5 ⇒ 末步权重 3 倍于首步) */
export const DEFAULT_LATE_BIAS = 0.5;
// ── W3-8 工具面(与 journal.ts 的 ACTION_TOOLS/MARKER_TOOLS 同步;
//    本模块零依赖(离线 CLI 可直接 strip-types 加载),故自持副本 + 执法测试防漂移) ──
const SCORED_TOOLS = new Set([
    'click_mouse', 'type_text', 'scroll_page', 'press_hotkey',
    'drag_mouse', 'click_element', 'switch_tab', 'switch_window', 'dismiss_popup',
    'open_url',
]);
const MARKER_TOOLS = new Set([
    'AGENT_BEGIN', 'AGENT_END', 'ENV_SHAPED', 'SENSE_SHIFT', 'GUARD_BLOCKED', 'AUDIT_PRE',
]);
/** 环境被重塑/感知相变/代理重生 ⇒ 同签名的「连续性」被打断(物理直觉) */
const OSC_RESET_MARKERS = new Set(['AGENT_BEGIN', 'ENV_SHAPED', 'SENSE_SHIFT']);
// ─── W3-8 防御原语(绝不抛) ───
function isPlainObject(v) {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function r3(x) {
    return Math.round(x * 1000) / 1000;
}
/** 键排序稳定序列化(journal.ts canonical 同律);环形/BigInt 等病态载荷 ⇒ 哨兵串 */
function safeCanonical(v) {
    try {
        const walk = (x) => {
            if (x === null || typeof x !== 'object')
                return JSON.stringify(x) ?? 'null';
            if (Array.isArray(x))
                return '[' + x.map(walk).join(',') + ']';
            const rec = x;
            return '{' + Object.keys(rec).sort()
                .filter(k => rec[k] !== undefined)
                .map(k => JSON.stringify(k) + ':' + walk(rec[k])).join(',') + '}';
        };
        return walk(v);
    }
    catch {
        return '"#unserializable"'; // 病态载荷降级为常量哨兵(签名仍稳定,只是无区分度)
    }
}
/** args 摘要(人类可读锚定用):截断防长篇 reasoning 反噬 */
function argsSummary(args) {
    const s = safeCanonical(args);
    return s.length > 120 ? s.slice(0, 117) + '...' : s;
}
/** 签名域:tool + args 指纹(剔除 reasoning —— 同坐标同工具的重复才叫振荡,
 *  出声思考的变化不应打断签名 run) */
function actionSignature(tool, args) {
    let domain = args;
    if (isPlainObject(args) && 'reasoning' in args) {
        const { reasoning: _drop, ...rest } = args;
        domain = rest;
    }
    return tool + '|' + safeCanonical(domain);
}
/** 有界数值注入:非有限/越界 ⇒ 缺省(CLI 侧 Number('abc')=NaN 在此就地夹正) */
function numIn(v, def, lo, hi) {
    return typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def;
}
function strField(v) {
    return typeof v === 'string' && v.trim() ? v : null;
}
/** 权重解析:注入值夹到 [0,∞) 后归一化(和≤0 ⇒ 回退默认 —— 全零权重无意义) */
function resolveWeights(pw) {
    const w = { ...DEFAULT_CHANNEL_WEIGHTS };
    if (isPlainObject(pw)) {
        for (const k of ['effect', 'intent', 'oscillation', 'wait']) {
            const v = pw[k];
            if (typeof v === 'number' && Number.isFinite(v))
                w[k] = Math.max(0, v);
        }
    }
    const sum = w.effect + w.intent + w.oscillation + w.wait;
    if (sum <= 0)
        return { ...DEFAULT_CHANNEL_WEIGHTS };
    if (Math.abs(sum - 1) > 1e-9) {
        w.effect /= sum;
        w.intent /= sum;
        w.oscillation /= sum;
        w.wait /= sum;
    }
    return w;
}
/** 终局分解析:'success'→1 / fail|error|abort|crash→0 / 其他非空→0.5 / 空→null */
function parseFinalScore(status) {
    if (!status)
        return null;
    const s = status.toLowerCase();
    if (s.includes('success'))
        return 1;
    if (/fail|error|abort|crash/.test(s))
        return 0;
    return 0.5; // timeout/cancel 等已知但非二值的状态:中立 0.5(口径诚实,不猜)
}
function fallbackReport(msg) {
    return {
        ok: false,
        caliber_version: SCORE_CALIBER_VERSION,
        generated_by: 'W3-8 processScore',
        internal_error: msg,
        totals: {
            lines_total: 0, lines_blank: 0, lines_garbage: 0,
            lines_unscored_tool: 0, action_steps: 0, marker_lines: 0,
        },
        channel_absence: { effect: 0, intent: 0, oscillation: 0, wait: 0 },
        steps: [],
        task: {
            objective: null, step_count: 0, plain_mean: null, weighted_mean: null,
            final_score: null, final_status: null, blended: null,
        },
        first_low_step: null,
        calibration: {
            weights: { ...DEFAULT_CHANNEL_WEIGHTS },
            low_step_threshold: DEFAULT_LOW_STEP_THRESHOLD,
            late_bias: DEFAULT_LATE_BIAS,
            caliber_version: SCORE_CALIBER_VERSION,
        },
    };
}
function resolveCalibration(opts = {}) {
    return {
        weights: resolveWeights(opts.weights),
        threshold: numIn(opts.lowStepThreshold, DEFAULT_LOW_STEP_THRESHOLD, 0, 1),
        lateBias: numIn(opts.lateBias, DEFAULT_LATE_BIAS, 0, 1),
    };
}
/**
 * 单步四通道评分(纯函数;state 为入参快照,调用方持有演进)。
 * 口径:缺席 ⇒ 0.5 中性 + absent 标记(计数归聚合层)。
 */
function stepChannels(entry, tool, args, st) {
    // ── 证据提取(全部宽容:类型不符 = 缺席)──
    const detected = typeof entry.effect_detected === 'boolean' ? entry.effect_detected : null;
    const scale = typeof entry.scale === 'string' ? entry.scale : null;
    const rawIntent = entry.intent;
    const intentSatisfied = isPlainObject(rawIntent) && typeof rawIntent.satisfied === 'boolean'
        ? rawIntent.satisfied : null;
    const phash = typeof entry.phashCorroborates === 'boolean' ? entry.phashCorroborates : null;
    const thought = typeof entry.thought === 'string' && entry.thought.trim() ? entry.thought : null;
    const observe = typeof entry.observe === 'string' && entry.observe.trim() ? entry.observe : null;
    // ── 通道 1:effect(detected × scale)──
    let effect;
    if (detected === null)
        effect = 0.5; // 缺席 = 中性
    else if (!detected)
        effect = 0; // 链上明示无效果(盲点/noop)
    else
        effect = scale === 'page-level' ? SCALE_VALUE_PAGE
            : scale === 'element-level' ? SCALE_VALUE_ELEMENT
                : SCALE_VALUE_UNKNOWN; // 缺席/'none' 矛盾 ⇒ 中点
    // ── 通道 2:intent(证据阶梯:intent > phash > thought)──
    let intent;
    if (intentSatisfied !== null)
        intent = intentSatisfied ? INTENT_VALUE_SATISFIED : INTENT_VALUE_UNSATISFIED;
    else if (phash !== null)
        intent = phash ? INTENT_VALUE_PHASH_AGREE : INTENT_VALUE_PHASH_DISSENT;
    else if (thought !== null)
        intent = INTENT_VALUE_THOUGHT_ONLY;
    else
        intent = 0.5; // 全缺席 = 中性
    // ── 通道 3:oscillation(连续同签名 run)──
    const signature = actionSignature(tool, args);
    const run = signature === st.lastSignature ? st.lastRun + 1 : 1;
    const oscillation = run === 1 ? 1.0 : run === 2 ? OSC_RUN2 : 0;
    // ── 通道 4:wait(连续无效果 streak;缺席步不累积不清零)──
    let wait;
    if (detected === null)
        wait = 0.5; // 无效果信息 = 中性
    else if (detected) {
        st.noEffectStreak = 0;
        wait = 1;
    }
    else {
        st.noEffectStreak += 1;
        wait = Math.max(0, 1 - WAIT_STREAK_DECAY * st.noEffectStreak);
    }
    // 状态演进(签名 run;streak 已在上面就地演进)
    st.lastSignature = signature;
    st.lastRun = run;
    return {
        channels: {
            effect: r3(effect), intent: r3(intent),
            oscillation: r3(oscillation), wait: r3(wait),
        },
        absent: {
            effect: detected === null,
            intent: intentSatisfied === null && phash === null && thought === null,
            oscillation: false, // 签名由 tool+args 派生,永可得(缺席概念不适用)
            wait: detected === null,
        },
        evidence: {
            ts: typeof entry.ts === 'number' && Number.isFinite(entry.ts) ? entry.ts : null,
            status: strField(entry.status),
            detected, scale,
            intent_satisfied: intentSatisfied,
            phash_corroborates: phash,
            has_thought: thought !== null,
            has_observe: observe !== null,
            signature: signature.length > 60 ? signature.slice(0, 57) + '...' : signature,
            repeat_run: run,
            no_effect_streak: st.noEffectStreak,
        },
    };
}
// ─── W3-8 主评分管线 ───
function scoreParsed(lines, cal) {
    const st = { lastSignature: null, lastRun: 0, noEffectStreak: 0 };
    const steps = [];
    const absence = { effect: 0, intent: 0, oscillation: 0, wait: 0 };
    let garbage = 0, unscored = 0, markers = 0;
    let objective = null;
    let finalStatus = null;
    for (const raw of lines) {
        if (!isPlainObject(raw)) {
            garbage++;
            continue;
        }
        const tool = raw.tool;
        if (typeof tool !== 'string') {
            garbage++;
            continue;
        } // 缺 tool = 垃圾行(计数,不抛)
        const entry = raw;
        const args = isPlainObject(entry.args) ? entry.args : {};
        // 标记行:不入步分;AGENT_END 提供终局分;环境 marker 重置签名 run
        if (MARKER_TOOLS.has(tool) || entry.status === 'MARKER') {
            markers++;
            if (tool === 'AGENT_BEGIN' && objective === null) {
                objective = strField(args.objective)?.slice(0, 200) ?? null; // 首个 = 轨迹头语境
            }
            if (tool === 'AGENT_END') {
                finalStatus = strField(args.status); // 最后一个 AGENT_END 为准(多任务轨迹)
            }
            if (OSC_RESET_MARKERS.has(tool)) {
                st.lastSignature = null;
                st.lastRun = 0;
            }
            continue;
        }
        if (!SCORED_TOOLS.has(tool)) {
            unscored++;
            continue;
        } // 观察类工具无动作语义
        const { channels, absent, evidence } = stepChannels(entry, tool, args, st);
        if (absent.effect)
            absence.effect++;
        if (absent.intent)
            absence.intent++;
        if (absent.oscillation)
            absence.oscillation++;
        if (absent.wait)
            absence.wait++;
        const score = r3(Math.min(1, Math.max(0, cal.weights.effect * channels.effect +
            cal.weights.intent * channels.intent +
            cal.weights.oscillation * channels.oscillation +
            cal.weights.wait * channels.wait)));
        steps.push({
            index: steps.length, tool,
            ts: evidence.ts,
            score, channels, absent,
            args_summary: argsSummary(args),
            evidence,
        });
    }
    // ── 聚合:均值 + PBR 晚期加权 ──
    const n = steps.length;
    let plain = null;
    let weighted = null;
    let blended = null;
    const finalScore = parseFinalScore(finalStatus);
    if (n > 0) {
        plain = r3(steps.reduce((s, x) => s + x.score, 0) / n);
        if (n === 1 || cal.lateBias <= 0)
            weighted = plain;
        else {
            let sw = 0, sumW = 0;
            for (let i = 0; i < n; i++) {
                const w = (1 - cal.lateBias) + 2 * cal.lateBias * (i / (n - 1));
                sw += w * steps[i].score;
                sumW += w;
            }
            weighted = r3(sw / sumW);
        }
        if (finalScore !== null && weighted !== null) {
            blended = r3(BLEND_PROCESS * weighted + BLEND_FINAL * finalScore);
        }
    }
    // ── 首低分步锚定(低于阈值的首步 + 前后文) ──
    let firstLow = null;
    for (let i = 0; i < n; i++) {
        if (steps[i].score >= cal.threshold)
            continue;
        const s = steps[i];
        const reasons = [];
        if (s.evidence.detected === false)
            reasons.push('detected=false (no visual effect)');
        if (s.evidence.intent_satisfied === false)
            reasons.push('intent unsatisfied');
        if (s.evidence.repeat_run >= 2)
            reasons.push(`signature repeat run=${s.evidence.repeat_run}`);
        if (s.evidence.no_effect_streak >= 2)
            reasons.push(`no-effect streak=${s.evidence.no_effect_streak}`);
        if (reasons.length === 0)
            reasons.push('below threshold (no single dominant cause)');
        firstLow = {
            index: s.index, score: s.score, threshold: cal.threshold,
            tool: s.tool, args_summary: s.args_summary,
            reasons, channels: s.channels,
            prev: i > 0 ? { index: steps[i - 1].index, tool: steps[i - 1].tool, score: steps[i - 1].score } : null,
            next: i + 1 < n ? { index: steps[i + 1].index, tool: steps[i + 1].tool, score: steps[i + 1].score } : null,
        };
        break;
    }
    return {
        ok: true,
        caliber_version: SCORE_CALIBER_VERSION,
        generated_by: 'W3-8 processScore',
        internal_error: null,
        totals: {
            lines_total: lines.length, lines_blank: 0, lines_garbage: garbage,
            lines_unscored_tool: unscored, action_steps: n, marker_lines: markers,
        },
        channel_absence: absence,
        steps,
        task: {
            objective, step_count: n,
            plain_mean: plain, weighted_mean: weighted,
            final_score: finalScore, final_status: finalStatus, blended,
        },
        first_low_step: firstLow,
        calibration: {
            weights: {
                effect: r3(cal.weights.effect), intent: r3(cal.weights.intent),
                oscillation: r3(cal.weights.oscillation), wait: r3(cal.weights.wait),
            },
            low_step_threshold: cal.threshold,
            late_bias: cal.lateBias,
            caliber_version: SCORE_CALIBER_VERSION,
        },
    };
}
/**
 * W3-8 对象数组入口(已 parse 的 journal 行):评分器 API 面。
 * 病态元素跳过计数;绝不抛(最外层兜底捕获 → ok=false 报告)。
 */
export function scoreJournalLines(lines, opts = {}) {
    try {
        return scoreParsed(lines, resolveCalibration(opts));
    }
    catch (e) {
        return fallbackReport(`internal: ${String(e?.message ?? e)}`);
    }
}
/**
 * W3-8 主入口:journal JSONL 文本 → 过程评分报告(纯函数,离线确定性)。
 * 垃圾行(非 JSON/非对象/缺 tool)跳过并计数;空轨迹诚实报空;绝不抛。
 */
export function scoreJournalText(text, opts = {}) {
    try {
        const parsed = [];
        let blank = 0, garbage = 0;
        const lines = typeof text === 'string' ? text.split(/\r?\n/) : [];
        for (const raw of lines) {
            if (!raw || !raw.trim()) {
                blank++;
                continue;
            } // 空白行(尾部换行等)不算垃圾
            try {
                const v = JSON.parse(raw);
                if (isPlainObject(v))
                    parsed.push(v);
                else
                    garbage++; // number/null/array 等合法 JSON 非行对象
            }
            catch {
                garbage++;
            }
        }
        const rep = scoreJournalLines(parsed, opts);
        // 文本层的行统计并入(对象入口的 lines_total 只数对象)
        rep.totals.lines_total += blank + garbage;
        rep.totals.lines_blank += blank;
        rep.totals.lines_garbage += garbage;
        return rep;
    }
    catch (e) {
        return fallbackReport(`internal: ${String(e?.message ?? e)}`);
    }
}
/** W3-8 人类可读渲染(CLI stdout;与 telemetry.render 同风格的观测面) */
export function renderProcessScore(rep) {
    const t = rep.totals;
    const L = [
        `[ProcessScore] caliber=${rep.caliber_version} steps=${t.action_steps} lines=${t.lines_total}` +
            ` (blank=${t.lines_blank} garbage=${t.lines_garbage} unscored=${t.lines_unscored_tool} markers=${t.marker_lines})`,
    ];
    if (!rep.ok) {
        L.push(`internal-error: ${rep.internal_error} (defensive fallback — nothing thrown)`);
        return L.join('\n');
    }
    if (rep.task.step_count === 0) {
        L.push('task: EMPTY — no scoreable action steps in trajectory (honest empty report)');
        return L.join('\n');
    }
    const f3 = (x) => x === null ? '-' : x.toFixed(3);
    if (rep.task.objective)
        L.push(`objective: ${rep.task.objective}`);
    L.push(`task : plain=${f3(rep.task.plain_mean)} weighted=${f3(rep.task.weighted_mean)}` +
        ` (late_bias=${rep.calibration.late_bias}) final=${f3(rep.task.final_score)}` +
        ` (${rep.task.final_status ?? 'no-end-marker'}) blended=${f3(rep.task.blended)}`);
    const a = rep.channel_absence;
    const n = rep.task.step_count;
    L.push(`absent(neutral=0.5): effect=${a.effect}/${n} intent=${a.intent}/${n}` +
        ` oscillation=${a.oscillation}/${n} wait=${a.wait}/${n}`);
    const fl = rep.first_low_step;
    if (fl) {
        L.push(`low  : first low step #${fl.index} score=${fl.score.toFixed(3)} < ${fl.threshold}` +
            ` — ${fl.tool} ${fl.args_summary}`);
        L.push(`       evidence: ${fl.reasons.join('; ')} | channels(e/i/o/w)=` +
            `${fl.channels.effect}/${fl.channels.intent}/${fl.channels.oscillation}/${fl.channels.wait}`);
        const p = fl.prev ? `#${fl.prev.index} ${fl.prev.tool} ${fl.prev.score.toFixed(3)}` : 'none';
        const nx = fl.next ? `#${fl.next.index} ${fl.next.tool} ${fl.next.score.toFixed(3)}` : 'none';
        L.push(`       context: prev ${p} | next ${nx}`);
    }
    else {
        L.push(`low  : no step below ${rep.calibration.low_step_threshold}`);
    }
    L.push('steps: ' + rep.steps.map(s => `${s.index}=${s.score.toFixed(3)}`).join(' '));
    return L.join('\n');
}
