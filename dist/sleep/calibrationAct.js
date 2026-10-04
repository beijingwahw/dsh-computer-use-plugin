// src/sleep/calibrationAct.ts
// W6-1（doctor 债清偿·smell.over-engineering）：从 sleep/index.ts 提取的校准幕区
// （纪元 Ζ 旁挂）—— 标定建议书铸造（gpdAdCriticalTable / calibrateKalmanQR 只建议
// 不落值）+ ④ 校准幕 actCalibrate + 记忆操作收敛摘要净化。逐字节搬运（零逻辑/
// 零数值变更；actCalibrate 加 export 供编排器消费，包外公共面不变）。
// 纪元 Ζ 运行期导入豁免注记随迁：calibration.ts 是纯数学器官（原 index.ts 头注）。
import { gpdAdCriticalTable, calibrateKalmanQR } from '../calibration.js';
import { errText, numOr0 } from './sleepActs.js';
// ─── 校准幕（纪元 Ζ 旁挂）：标定建议书 —— 睡眠时才有的离线数据 → 标定原子 ───
/** MC 自举规模（确定性常数：800 次模拟 × ~50 超额 ≪ 睡眠预算，建议书可复现） */
const SLEEP_CALIB_N_SIMS = 800;
/** 自举播种（纪元 Ζ 纪元常数 —— 建议书跨夜跨进程可复现可审计） */
const SLEEP_CALIB_SEED = 20261003;
/** GPD 临界表建议的诚实下限：与 telemetry.GPD_MIN_TAIL 同值（PWM 估计器最小样本） */
const GPD_MIN_TAIL_FOR_ADVICE = 20;
/** Kalman Q/R 建议的诚实下限：与 calibrateKalmanQR 的 8 对下限同源 */
const KALMAN_MIN_PAIRS = 8;
/**
 * journal 同目标坐标序列 → (模型先验, 观测) 漂移对（纯统计投影，绝不抛 ——
 * journal 面故障 ⇒ 空对集，缺席方向诚实；水印线/审计幕各自的 list 故障
 * 报告不因本旁挂重复上报）。
 *
 * 口径申报（诚实边界，advice.source 原样转述）：swarm 的 Kalman 滤波器内部
 * 状态不入 journal —— 无法重演其滤波先验，代用先验 = 该目标该轴**前史漂移
 * 均值**（无状态史的诚实统计量）。序列构造：同 (tool, target) 的连续坐标
 * 剧集 → 漂移 d_t = coord_t − coord_{t−1} → 对 (mean(d_..<t), d_t)；x/y 双轴
 * 与多目标池化（calibrateKalmanQR 本身即各向同性标量滤波口径，池化同律）。
 * 只有带有限 x/y 与非空 target_description 的动作条入序列（无身份的坐标
 * 不构成「同一元素的重定位」证据）。
 */
function kalmanPairsFromJournal(journal) {
    if (!journal || typeof journal.list !== 'function')
        return [];
    let entries;
    try {
        const list = journal.list(true); // 动作条（与审计幕同口径）
        entries = Array.isArray(list) ? list : [];
    }
    catch {
        return []; // 数据面故障 ⇒ 空对集（缺席是诚实方向，不冒充零漂移）
    }
    const series = new Map();
    for (const raw of entries) {
        const entry = (raw ?? {});
        if (typeof entry.tool !== 'string')
            continue;
        const args = entry.args && typeof entry.args === 'object' ? entry.args : {};
        const target = typeof args.target_description === 'string' ? args.target_description.trim() : '';
        if (target === '')
            continue;
        const x = args.x, y = args.y;
        if (typeof x !== 'number' || !Number.isFinite(x))
            continue;
        if (typeof y !== 'number' || !Number.isFinite(y))
            continue;
        const key = `${entry.tool}|${target}`;
        let s = series.get(key);
        if (!s) {
            s = { xs: [], ys: [] };
            series.set(key, s);
        }
        s.xs.push(x);
        s.ys.push(y);
    }
    const pairs = [];
    for (const s of series.values()) {
        for (const coords of [s.xs, s.ys]) {
            if (coords.length < 3)
                continue; // <3 剧集 ⇒ ≤1 漂移 ⇒ 无先验可均
            const drifts = [];
            for (let i = 1; i < coords.length; i++)
                drifts.push(coords[i] - coords[i - 1]);
            for (let t = 1; t < drifts.length; t++) {
                const prior = drifts.slice(0, t).reduce((a, b) => a + b, 0) / t;
                if (Number.isFinite(prior))
                    pairs.push({ predicted: prior, observed: drifts[t] });
            }
        }
    }
    return pairs;
}
/**
 * 标定建议书铸造（纪元 Ζ）：睡眠时才有的离线数据 → calibration.ts 标定原子
 * → 只建议不落值。接通原子按数据可得性执法，接不上的诚实注记缺什么数据：
 *   · gpdAdCriticalTable ← telemetry.tailReport 统计量（xi + 超额数）：
 *     Monte-Carlo 自举给「本估计器本样本量」的 A² 临界值表，对照 tailReport
 *     的拒绝阈字面量 3.0（fit:'poor' 判定）—— 数据到位 = 换值一行；
 *   · calibrateKalmanQR ← journal 同目标坐标漂移对：对照 swarm 的 KF_Q=1/
 *     KF_R=1（遗忘速率形状）；
 *   · calibrateSchmittEvidence / calibrateNcdThreshold：缺数据在册 ——
 *     弹窗帧 (semantic,geometric,isPopup) 三元组与带标签 (相似度,相关) 检索
 *     回访不入任何台账（先落账后接线，诚实缺席不伪造）。
 * 本函数自身不抛（数据面故障已就地吸收为缺席注记）；原子调用为纯函数 ——
 * 万一抛出由 actCalibrate 的旁挂 catch 收敛为 error 注记。
 */
function buildCalibrationBooklet(deps) {
    const advice = [];
    const notes = [];
    // 原子① GPD A² 临界值表 ← telemetry 延迟尾统计
    const tel = deps.telemetry;
    let tail = null;
    if (tel && typeof tel.tailReport === 'function')
        tail = tel.tailReport();
    if (!tel || typeof tel.tailReport !== 'function') {
        notes.push('gpdAdCriticalTable 缺席：telemetry 统计面不在睡眠依赖（延迟尾数据不可得）');
    }
    else if (!tail || typeof tail.xi !== 'number' || !Number.isFinite(tail.xi)
        || typeof tail.tailCount !== 'number' || !Number.isFinite(tail.tailCount)
        || tail.tailCount < GPD_MIN_TAIL_FOR_ADVICE) {
        notes.push(`gpdAdCriticalTable 缺席：延迟尾超额不足（需 ≥${GPD_MIN_TAIL_FOR_ADVICE}，诚实不标定）`);
    }
    else {
        const table = gpdAdCriticalTable({ xi: tail.xi, nSample: tail.tailCount, nSims: SLEEP_CALIB_N_SIMS, seed: SLEEP_CALIB_SEED });
        advice.push({
            atom: 'gpdAdCriticalTable',
            consumer: 'telemetry.tailReport 的 A² 拒绝阈字面量 3.0（fit:"poor" 判定）',
            current: '3.0',
            values: { alpha10: table.alpha10, alpha05: table.alpha05, alpha01: table.alpha01 },
            n: table.nSample,
            source: `telemetry 延迟尾统计（xi=${tail.xi}）Monte-Carlo 自举 nSims=${SLEEP_CALIB_N_SIMS} 播种 ${SLEEP_CALIB_SEED}`,
        });
    }
    // 原子② Kalman Q/R ← journal 同目标坐标漂移对
    const pairs = kalmanPairsFromJournal(deps.journal);
    if (pairs.length < KALMAN_MIN_PAIRS) {
        notes.push(`calibrateKalmanQR 缺席：坐标漂移对不足（${pairs.length}/${KALMAN_MIN_PAIRS}，诚实不标定）`);
    }
    else {
        const fit = calibrateKalmanQR(pairs);
        if (fit) {
            advice.push({
                atom: 'calibrateKalmanQR',
                consumer: 'swarm 漂移滤波 KF_Q=1/KF_R=1（各向同性标量 Kalman 的遗忘速率形状）',
                current: 'Q/R=1',
                values: { q: fit.q, r: fit.r, ratio: fit.ratio, mse: fit.mse },
                n: fit.n,
                source: `journal 同 (tool,target) 坐标漂移对 ${pairs.length} 对池化（x/y 双轴）；模型先验 = 前史漂移均值（滤波器状态史不入日志的代用统计量）`,
            });
        }
        else {
            notes.push('calibrateKalmanQR 缺席：净化后有效漂移对不足 8（原子诚实下限拒绝）');
        }
    }
    // 原子③④ 缺数据在册（缝隙登记 —— 先落账后接线，绝不伪造标签喂原子）
    notes.push('calibrateSchmittEvidence 缺席：弹窗帧 (semantic,geometric,isPopup) 三元组不入任何台账');
    notes.push('calibrateNcdThreshold 缺席：带标签 (相似度,是否相关) 检索回访不入任何台账');
    return { advice, notes };
}
/** ④ 校准幕：内核校准 tick（conductor 节流口径优先；缺则 calibrator 直连）
 * + 标定建议书旁挂（纪元 Ζ）+ 记忆操作收敛旁挂（W3-2 第二批接线②）。
 * 两个旁挂共用一条铁律：其故障不回滚 tick 的执法产出（counts 保留），但如实
 * 注记 error/absorb —— 睡眠照常完成，绝不炸宿主。收敛摘要经 out 旁车带给
 * 晨报顶层（SleepReport.memoryOps —— 与 approvalQueue 同一旁车律）。 */
export function actCalibrate(deps, out = {}) {
    const viaConductor = deps.conductor && typeof deps.conductor.maybeTick === 'function'
        ? () => deps.conductor.maybeTick()
        : null;
    const viaCalibrator = deps.calibrator && typeof deps.calibrator.tick === 'function'
        ? () => deps.calibrator.tick()
        : null;
    const tick = viaConductor ?? viaCalibrator;
    if (!tick) {
        return { name: 'calibrate', status: 'skipped', counts: {}, detail: 'conductor/calibrator 缺席 —— 校准幕跳过' };
    }
    const reports = tick();
    const arr = Array.isArray(reports) ? reports : [];
    const counts = { calibrations: arr.length };
    try {
        const { advice, notes } = buildCalibrationBooklet(deps);
        counts.recommendations = advice.length;
        const head = advice.length > 0
            ? `标定建议书 ${advice.length} 项在场（睡眠出建议、白天做决定 —— 值不落注册表）`
            : '标定建议书 0 项（数据不足，诚实缺席）';
        const detail = [head, ...notes].join('；');
        const withBooklet = advice.length > 0
            ? { name: 'calibrate', status: 'ok', counts, detail, calibrationAdvice: advice }
            : { name: 'calibrate', status: 'ok', counts, detail };
        // W3-2 第二批接线②：记忆操作收敛旁挂 —— converger 缺席 ⇒ 零行为变化；
        // 故障 ⇒ 注记吸收（不毒化建议书与 tick 产出）；成功 ⇒ 摘要入 counts +
        // 旁车（晨报顶层 memoryOps 段）。种子契约：集成面投 convergeMemoryOps
        // ({ seed: <journal 水位线> }) —— 同账本态跨夜重放一致。
        const converger = deps.memoryOpsConverger;
        if (typeof converger !== 'function')
            return withBooklet;
        try {
            const summary = sanitizeMemoryOpsReport(converger());
            if (summary) {
                counts.memoryOpsArms = summary.arms;
                counts.memoryOpsConverged = summary.converged;
                counts.memoryOpsHeld = summary.held;
                out.memoryOps = summary;
                return {
                    ...withBooklet,
                    detail: `${withBooklet.detail}；记忆操作收敛：${summary.converged}/${summary.arms} 臂落值（${summary.held} 臂反馈不足按兵不动，seed=${summary.seed}）`,
                };
            }
            return { ...withBooklet, detail: `${withBooklet.detail}；记忆操作收敛：报告不可解析（旁路注记）` };
        }
        catch (e) {
            return { ...withBooklet, detail: `${withBooklet.detail}；记忆操作收敛故障（旁路吸收）：${errText(e)}` };
        }
    }
    catch (e) {
        return {
            name: 'calibrate', status: 'error', counts,
            detail: `标定建议书故障（旁路吸收，校准 tick 已完成）：${errText(e)}`,
        };
    }
}
/**
 * W3-2 第二批接线②：记忆操作收敛报告净化（防御式 —— 说谎的 dep 不毒化晨报）：
 * 数值走 numOr0、seed 只保字符串（截 100）、明细条目只保结构合法者
 * （key 必须是非空字符串，from/to 有限数值，setOk 布尔，source 截 32）。
 * 整体垃圾 ⇒ undefined（缺席是诚实方向，不伪造零收敛）。
 */
function sanitizeMemoryOpsReport(raw) {
    if (!raw || typeof raw !== 'object')
        return undefined;
    const r = raw;
    const rawConverged = Array.isArray(r.converged) ? r.converged : [];
    const entries = [];
    for (const c of rawConverged) {
        if (!c || typeof c !== 'object')
            continue;
        const key = typeof c.key === 'string' && c.key ? c.key : undefined;
        if (key === undefined)
            continue;
        entries.push({
            key,
            from: numOr0(c.from),
            to: numOr0(c.to),
            setOk: c.setOk === true,
            source: typeof c.source === 'string' && c.source ? c.source.slice(0, 32) : '',
        });
    }
    const held = Array.isArray(r.held) ? r.held.length : 0;
    return {
        arms: numOr0(r.arms),
        converged: rawConverged.length,
        held,
        seed: typeof r.seed === 'string' && r.seed ? r.seed.slice(0, 100) : '',
        entries,
    };
}
