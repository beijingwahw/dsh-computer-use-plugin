import { onToolPre, onToolPost } from './hooks.js';
import { failureMemory } from '../failureMemory.js';
import { journal } from '../journal.js';
import { contextManager } from '../contextManager.js';
import { classifyResult, isFailure, isSuccess } from '../resultContract.js';
import { recoveryEfficacy, classifySyndromeSignature } from '../recoveryEfficacy.js'; // W2-5（R5）：恢复疗效账
/** 把恢复提示附加到结果字符串：锚点 JSON 注入 recovery_hint 字段；非 JSON 则换行追加 */
function appendHint(result, hint) {
    try {
        const obj = JSON.parse(result);
        if (obj && typeof obj === 'object') {
            obj.recovery_hint = hint;
            return JSON.stringify(obj, null, 2);
        }
    }
    catch { /* 前缀协议字符串，走下方追加 */ }
    return `${result}\n[${hint}]`;
}
/** 失败症状提炼：锚点 JSON 取 status/next_step 首句；前缀协议取首行
 *  W1-6：导出供 rootCauseGuard 复用（同上：单一推导源） */
export function extractSymptom(result) {
    try {
        const obj = JSON.parse(result);
        if (obj?.status) {
            const step = typeof obj.next_step === 'string' ? obj.next_step.split(/[.\n]/)[0] : '';
            return `${obj.status}${step ? ': ' + step : ''}`;
        }
    }
    catch { /* 非锚点格式 */ }
    return result.split('\n')[0].slice(0, 120);
}
/** 动作签名：工具名 + 关键参数摘要（失败记忆的 approach 字段） */
function actionSignature(name, args) {
    const keys = ['x', 'y', 'text', 'hotkey', 'direction', 'title', 'index', 'query', 'target_description'];
    const parts = keys.filter(k => args[k] !== undefined).map(k => `${k}=${String(args[k]).slice(0, 40)}`);
    return `${name}(${parts.join(', ')})`;
}
/** 写入失败记忆：query 取当前任务语境（无复杂任务则标注交互态），sceneHash 随行供场景加成
 *  W1-6（R1 鉴别试验）：可选 rootCause —— 鉴别探针的归因结论随行入库/刷新
 *  （同查询+同路径的近重复记录会更新病因字段，见 failureMemory.record）。
 *  导出供 rootCauseGuard 复用：同一套 query/approach/signature 推导，保证
 *  归因刷新命中同一条记录（两套推导 = 一次失败两条记录的污染）。
 *  W2-5（R5）：返回写入/刷新的记录 —— 调用方可回读 effective rootCause
 *  （近重复去重路径会把上一次鉴别结论带回来），喂给恢复疗效账的根因轴。 */
export function rememberFailure(name, args, symptom, rootCause) {
    const query = journal.currentTask() || 'interactive session (no complex task)';
    return failureMemory.record(query, actionSignature(name, args), symptom, contextManager.lastImageRecord()?.hash, rootCause);
}
// ── R 纪元（R-3 熔断层）：Beta-Bernoulli 序贯后验臂 ──
// 连续计数的盲区：交替成败型坏路线（fail-success-fail-…，真实失败率 50%+）
// 永远凑不满连续阈值 —— 旧熔断在此**永不触发**。后验臂：滚动窗内
// P(失败率 > θ | 窗口证据) ≥ 0.95 即熔断（Beta(a=f+1, b=s+1) 的上尾质量，
// 正则化不完全 Beta 函数 I_θ(a,b) —— Lentz 连分式，Numerical Recipes 形）。
/** ln Γ(x)（Lanczos 近似 g=7 —— |ε| < 1e-13；Math.lgamma 尚未进 ES） */
// exempt(ΝΩ-41 BC-5)：与 kernel/calibrator.ts 同体有意双份（guards↔kernel 运行时零耦合的模块律，数值一致性由测试锁定）—— 知情申报
function lgamma(x) {
    const g = [
        0.99999999999980993, 676.5203681218851, -1259.1392167224028,
        771.32342877765313, -176.61502916214059, 12.507343278686905,
        -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
    ];
    if (x < 0.5) {
        return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
    }
    x -= 1;
    let a = g[0];
    const t = x + 7.5;
    for (let i = 1; i < 9; i++)
        a += g[i] / (x + i);
    return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}
/** 正则化不完全 Beta 函数 I_x(a,b)（Lentz 连分式；a,b > 0，x ∈ [0,1]） */
// exempt(ΝΩ-41 BC-5)：与 kernel/calibrator.ts 同体有意双份（guards↔kernel 运行时零耦合的模块律，数值一致性由测试锁定）—— 知情申报
export function regularizedBeta(x, a, b) {
    if (x <= 0)
        return 0;
    if (x >= 1)
        return 1;
    const lbeta = lgamma(a + b) - lgamma(a) - lgamma(b)
        + a * Math.log(x) + b * Math.log(1 - x);
    const bt = Math.exp(lbeta);
    if (x < (a + 1) / (a + b + 2)) {
        return bt * betacf(x, a, b) / a;
    }
    return 1 - bt * betacf(1 - x, b, a) / b;
}
/** 连分式（NR 6.4：迭代至 |Δ| < 3e-12，上限 200 轮） */
/** W6-1（风格债）：连分式迭代上限 —— 原裸字面量 200 提取为具名常量，数值逐位不变 */
const BETACF_MAX_ITERATIONS = 200;
// exempt(ΝΩ-41 BC-5)：与 kernel/calibrator.ts 同体有意双份（guards↔kernel 运行时零耦合的模块律，数值一致性由测试锁定）—— 知情申报
function betacf(x, a, b) {
    const FPMIN = 1e-300;
    const qab = a + b, qap = a + 1, qam = a - 1;
    let c = 1, d = 1 - (qab * x) / qap;
    if (Math.abs(d) < FPMIN)
        d = FPMIN;
    d = 1 / d;
    let h = d;
    for (let m = 1; m <= BETACF_MAX_ITERATIONS; m++) {
        const m2 = 2 * m;
        let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
        d = 1 + aa * d;
        if (Math.abs(d) < FPMIN)
            d = FPMIN;
        c = 1 + aa / c;
        if (Math.abs(c) < FPMIN)
            c = FPMIN;
        d = 1 / d;
        h *= d * c;
        aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
        d = 1 + aa * d;
        if (Math.abs(d) < FPMIN)
            d = FPMIN;
        c = 1 + aa / c;
        if (Math.abs(c) < FPMIN)
            c = FPMIN;
        d = 1 / d;
        const del = d * c;
        h *= del;
        if (Math.abs(del - 1) < 3e-12)
            break;
    }
    return h;
}
/**
 * 滚动窗熔断判决（纯函数）：窗口内 f 败 s 胜 ⇒ P(失败率 > θ) 的后验质量。
 * ≥ 0.95 且窗口 ≥ minWindow ⇒ 熔断（θ=0.5：一半以上调用在坏路线上）。
 */
export function posteriorTripProbability(failures, successes, theta = 0.5) {
    const a = failures + 1, b = successes + 1;
    return Math.round((1 - regularizedBeta(theta, a, b)) * 10000) / 10000;
}
const BREAKER_WINDOW = 20; // 滚动窗容量（后验臂的证据上限）
const BREAKER_MIN_WINDOW = 8; // 最小判决样本（先验不越数据）
const BREAKER_TRIP_MASS = 0.95; // 后验质量阈值（误熔断率 ≈ 5%）
// ── ΝΩ-7：CUSUM 双侧序贯漂移臂（叠加进复合判据 —— 既有臂只增不减）──
// 病灶：后验臂在 BREAKER_WINDOW=20 的窗内需真实失败率 ≳68%（14 败 6 胜才把
// Beta 上尾顶过 0.95）才满窗触发 —— 50-65% 的慢坏路线永不熔断。CUSUM
//（Page 1954 序贯检验）不做窗截断：逐结局累积对数似然比，漂移证据跨窗滚动
// 累加，专治「不够极端但持续在坏」的路线。全部参数冻结（纯闭式、无随机、
// 无墙钟 —— 判决只消费这些字面常量，可审计可回放）：
const CUSUM_P0 = 0.30; // 受控失败率基线（健康路线可容忍的失败水平）
const CUSUM_P1 = 0.60; // 想尽快检出的失控失败率（漂移靶）
// 伯努利 LLR 闭式增量：败 x=1 ⇒ +ln(p1/p0)=ln2；胜 x=0 ⇒ +ln((1-p1)/(1-p0))=ln(4/7)（负）
const CUSUM_W_FAILURE = Math.log(CUSUM_P1 / CUSUM_P0); // ≈ +0.6931
const CUSUM_W_SUCCESS = Math.log((1 - CUSUM_P1) / (1 - CUSUM_P0)); // ≈ -0.5596
// 上阈 h（ARL 校准论证，Wald 型近似 e^h−1−h / |漂移|；判决只用冻结常量本身）：
//   受控漂移 E0[W] = 0.30·ln2 + 0.70·ln(4/7) ≈ −0.1838/样本 ⇒ ARL0 ≈ (e^4−5)/0.1838
//   ≈ 270 —— 270 次健康调用才一次误熔，且误熔的代价只是冷静期数个拦截位
//   （非锁死），可接受。失控漂移 E1[W] = 0.60·ln2 + 0.40·ln(4/7) ≈ +0.1920/样本
//   ⇒ ARL1 ≈ h/E1[W] ≈ 21 次调用检出；55% 慢坏路线 E[W] ≈ +0.1294 ⇒ ≈ 31 次
//   —— 恰落在后验臂的盲区段（55-65%），本臂补上。
const CUSUM_TRIP_MASS = 4; // 上行臂 S⁺ ≥ 4 ⇒ 熔断
// 下阈 |h⁻|（恢复判决的判别力论证）：康复率 0.10 下 E[W] ≈ −0.4344/样本 ⇒
// ≈ 5 个净胜结局即解除；只回到基线 p0 的未康复路线 E[W] = −0.1838 ⇒
// ARL ≈ (e²−3)/0.1838 ≈ 24 —— 真康复快解除、未康复久拖。
const CUSUM_RELEASE_MASS = 2; // 下行臂 S⁻ ≤ −2 ⇒ 提前解除冷静期
// 冷静期探针预算：半开探针的真实派发结局数达此值即无条件解除冷静期
//（「强制冷静后还给机会，而非永久锁死」的边界承诺 —— 不靠墙钟、不无限拖）。
const BREAKER_PROBE_BUDGET = 6;
// ── W2-5（R5 恢复策略疗效归因）：恢复提示的动作面 ──
// 规范动作（diagnosis.RecoveryActionId）→ 提示文本。前两条是历史递进提示的
// 逐字节原文（冷启动零回归承诺：n<5 时疗效表返回的固定梯子恰好命中它们）；
// 其余四条按 ROOT_CAUSE_LADDER / RC_HYPOTHESIS 语义撰写 —— 疗效表样本量
// 充足后，提示从固定递进改为后验均值排序的动态处方。
// 导出供 metrics/doctor 消费（处方文案单一事实源），测试锁死冷启动等价性。
export const RECOVERY_HINT_TEXT = {
    'zoom-refine': "Recovery hint: call 'zoom_inspect' around the target to refine coordinates before retrying.",
    'switch-modality': 'Recovery hint: switch modality — try keyboard navigation via press_hotkey (tab/enter), '
        + "or scroll_page if the target may be off-screen. Also try recall_ui for remembered locations.",
    're-observe': "Recovery hint: re-observe before retrying — take_screenshot (or diff_view) to refresh the "
        + 'world model; the screen may have changed under you.',
    'ground-target': 'Recovery hint: ground the target first — find_text to locate the labeled control, '
        + 'or probe_interactivity to verify the point is actually clickable.',
    'wait-settle': 'Recovery hint: the world may be stalling — let it settle (wait longer) before the next '
        + 'action; avoid rapid retries that amplify tail latency.',
    'stop-ask-user': 'Recovery hint: recovery attempts are not working — STOP retrying and ask the user for help.',
};
export function registerCircuitBreakerGuard(ctx, maxFailures, 
/** W2-5（R5）：恢复疗效账的注入缝 —— 缺省进程级单例（guards/index.ts 零改动接线）；
 *  测试注入隔离实例（离线确定性）。账本绝不抛，喂入/查询失败的成本是
 *  「这一笔没记上 / 用固定梯子」，绝不是熔断路径异常。 */
efficacy = recoveryEfficacy) {
    const MAX_TRACKED_SESSIONS = 16;
    const bySession = new Map();
    const stateFor = (sessionId) => {
        const key = sessionId ?? '_anon';
        let s = bySession.get(key);
        if (!s) {
            if (bySession.size >= MAX_TRACKED_SESSIONS) {
                const oldest = bySession.keys().next().value;
                if (oldest !== undefined)
                    bySession.delete(oldest);
            }
            s = { recentFailures: 0, window: [], cusumUp: 0, cusumDown: 0, paused: false, probeSkip: false, probeOutcomes: 0 };
            bySession.set(key, s);
        }
        return s;
    };
    // 1. 执行前：三臂复合判决（连续 / 后验 / ΝΩ-7 CUSUM 上行）任一越线 -> 熔断。
    //    ΝΩ-7：熔断不再是「一拦即全复位」—— 进入冷静期（半开探针制）：本位拦截后，
    //    拦截位与半开探针位交替。探针是真实派发（其结局走 post 面喂双侧 CUSUM）：
    //    S⁻ 越下阈 ⇒ 提前解除；探针预算耗尽 ⇒ 兜底解除。半开放行保证冷静期永不
    //    演化为永久锁死（既有「强制冷静后还给机会」语义的保持）。
    onToolPre(ctx, async (toolCall, next) => {
        const st = stateFor(toolCall.sessionId);
        if (st.paused) {
            if (st.probeSkip) {
                st.probeSkip = false; // 本拦截位让位后，下一位轮到半开探针
                // U 纪元（U-3）：守卫裁决入链 —— 冷静期拦截同样是可被 MMR 证明的历史事实
                void journal.appendMarker({ kind: 'GUARD_BLOCKED', guard: 'circuit-breaker', reason: 'cooldown' }).catch(() => { });
                return '[Guard Blocked]: Circuit Breaker cooldown (forced pause continues). ' +
                    'The next call will be admitted as a recovery probe — re-observe and change the strategy instead of blind retries.';
            }
            st.probeSkip = true; // 探针位放行（真实派发）；其后一位回到拦截位（若冷静期仍未解除）
            return next();
        }
        // R-3 后验臂：交替成败型坏路线（连续计数永不满足）的熔断判决
        const f = st.window.filter(Boolean).length;
        const suc = st.window.length - f;
        const tripMass = st.window.length >= BREAKER_MIN_WINDOW
            ? posteriorTripProbability(f, suc)
            : 0;
        const posteriorTrip = tripMass >= BREAKER_TRIP_MASS;
        // ΝΩ-7 上行臂：慢漂移（55-65% 失败率，后验臂满窗也不够线）的序贯检出。
        // 复合判据 = 任一臂越线 ⇒ 熔断（既有保护只增不减）。
        const cusumTrip = st.cusumUp >= CUSUM_TRIP_MASS;
        if (st.recentFailures >= maxFailures || posteriorTrip || cusumTrip) {
            const why = cusumTrip
                ? `CUSUM arm: S+ = ${st.cusumUp.toFixed(3)} >= ${CUSUM_TRIP_MASS} (sequential drift from p0=${CUSUM_P0} toward p1=${CUSUM_P1} failure rate)`
                : posteriorTrip
                    ? `posterior arm: P(failure rate > 50% | last ${st.window.length} calls) = ${tripMass} ≥ 0.95 (flaky-broken route)`
                    : `${maxFailures} consecutive failures`;
            // 聚合症状补记一条：按真实触发臂归因（match_skill 检索时作为强负向信号）
            const tripSymptom = `circuit-breaker: ${why} triggered a forced pause`;
            rememberFailure(toolCall.name, toolCall.args, tripSymptom);
            // ΝΩ-7 疗效账去污：拦截路径不再向恢复疗效账 ingest failure。论证：
            //   1) 被拦截的调用从未执行 —— 计为「失败尝试」会把疗效账的回合划定污染成
            //      拦截风暴：无回合在场时开幽灵回合（其后的常态成功被误记为一次恢复）；
            //      有回合在场时把被拦截的恢复动作（如 zoom_inspect）记成失败观察，
            //      教坏处方排序（恢复建议恰恰会引来更多被拦截的恢复动作 —— 正反馈污染）。
            //   2) recoveryEfficacy 的事件词汇表只有 failure/success/unknown：喂
            //      'blocked' 会被防御归一降级为 unknown —— 仍消耗回合窗位、可记名工具
            //      仍计失败观察，去污不彻底。故最小且干净的改法 = 拦截路径跳过失败臂，
            //      疗效账只记真实派发的结局（post 面）。
            //   3) 证据不丢：GUARD_BLOCKED 标记仍逐次入链 —— journal 回放通道
            //      （recoveryEventsFromJournal）把标记映射回 failure 事件，离线回放
            //      仍可从熔断事件起算回合；去掉的只是活账上的双计。
            // U 纪元（U-3）：守卫裁决入链 —— 拦截即防篡改存证（proof 器官闭环到守卫层：
            // 每次拦截都是可被 MMR 证明的历史事实，事后不可抵赖）
            void journal.appendMarker({ kind: 'GUARD_BLOCKED', guard: 'circuit-breaker', reason: cusumTrip ? 'cusum' : posteriorTrip ? 'posterior' : 'consecutive' }).catch(() => { });
            // 熔断即冷静：全部证据清零后转入冷静期（既有复位语义保持 + 可解除的在场态）
            st.recentFailures = 0;
            st.window.length = 0;
            st.cusumUp = 0; // 信号即重置（CUSUM 律）：漂移已上报，从零再积累
            st.cusumDown = 0; // 解除证据只认熔断后的新派发（熔断前的旧胜局不作数）
            st.paused = true;
            st.probeSkip = false; // 熔断本位已拦截；下一个调用轮到半开探针位
            st.probeOutcomes = 0;
            return `[Guard Blocked]: Circuit Breaker triggered (${why})! ` +
                `Please STOP and re-evaluate the overall strategy or ask the user for help.`;
        }
        return next();
    });
    // 2. 执行后：经统一契约解析器判定成败（B-2：不再依赖序列化格式巧合）；
    //    第 1/2 次失败注入递进式恢复提示（waterfall 允许改写透传值）
    onToolPost(ctx, async (toolCall, result, next) => {
        if (typeof result === 'string') {
            const st = stateFor(toolCall.sessionId);
            const c = classifyResult(result);
            st.window.push(isFailure(c));
            if (st.window.length > BREAKER_WINDOW)
                st.window.shift();
            // ΝΩ-7：改写值先记账后透传（单一出口）—— 保证下面的冷静期解除判定
            // 对「带恢复提示的失败」也照常执行（提示路径不再提前 return 跳过它）。
            let rewritten = null;
            if (isFailure(c)) {
                // ΝΩ-7：CUSUM 只吃可判定结局（unknown 弃权 —— 与疗效账的诚实弃权同律）
                st.cusumUp = Math.max(0, st.cusumUp + CUSUM_W_FAILURE);
                st.cusumDown = Math.min(0, st.cusumDown + CUSUM_W_FAILURE);
                st.recentFailures++;
                // 失败即时入记忆：下一次 match_skill 即可召回「这条路走不通」
                const symptom = extractSymptom(result);
                const record = rememberFailure(toolCall.name, toolCall.args, symptom);
                // W2-5（R5）：失败事件喂疗效账（回合划定从失败事件起算；症候签名 ×
                // 回读病因 —— 近重复去重可能带回上一次鉴别结论，垃圾值由账本收口）
                efficacy.ingest({
                    kind: 'failure', tool: toolCall.name, symptom,
                    ...(record?.rootCause !== undefined ? { rootCause: record.rootCause } : {}),
                });
                // 递进式恢复策略：第一次失败教「放大精定位」，第二次教「换模态」
                // W2-5（R5）：提示选择消费疗效表排序 —— n<5 冷启动 = 固定递进梯子
                // （与历史行为逐字节等价）；n≥5 = 后验均值降序的动态处方
                if (st.recentFailures === 1 || st.recentFailures === 2) {
                    const order = efficacy.prescriptionOrder(classifySyndromeSignature(symptom, toolCall.name), record?.rootCause);
                    const action = order[Math.min(st.recentFailures, order.length) - 1];
                    rewritten = appendHint(result, RECOVERY_HINT_TEXT[action]);
                }
            }
            else if (isSuccess(c)) {
                // ΝΩ-7：胜局把 S⁺ 压回零界、把 S⁻ 推向下阈（同一增量的双侧语义）
                st.cusumUp = Math.max(0, st.cusumUp + CUSUM_W_SUCCESS);
                st.cusumDown = Math.min(0, st.cusumDown + CUSUM_W_SUCCESS);
                st.recentFailures = 0; // 成功即重置
                efficacy.ingest({ kind: 'success', tool: toolCall.name }); // W2-5：恢复回合的闭合事件
            }
            else {
                // W2-5：不可判定结果仍消耗恢复回合窗口（是一次真实尝试），但不产生疗效观察
                efficacy.ingest({ kind: 'unknown', tool: toolCall.name });
            }
            // ΝΩ-7：冷静期解除判定 —— 只由真实派发结局驱动（拦截不产结局，故解除
            // 证据天然去污）。预算计数对可判定与不可判定结局一视同仁（都是真实派发，
            // 都占了探针位）；S⁻ 提前解除只认累积胜局证据（unknown 无证据含量）。
            if (st.paused) {
                st.probeOutcomes++;
                if (st.cusumDown <= -CUSUM_RELEASE_MASS || st.probeOutcomes >= BREAKER_PROBE_BUDGET) {
                    st.paused = false; // S⁻ 越下阈提前解除 / 探针预算耗尽兜底解除
                    st.probeSkip = false;
                    st.probeOutcomes = 0;
                }
            }
            if (rewritten !== null)
                return next(rewritten);
        }
        return next(result); // 必须把 result 透传给下一个
    });
}
