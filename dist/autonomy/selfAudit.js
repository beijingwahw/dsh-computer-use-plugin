/** 震荡检测的尾部窗口缺省步数（opts.oscillationWindow 覆盖；非法值回退此值） */
const DEFAULT_OSCILLATION_WINDOW = 6;
/** no_effect 占比的浪费阈值缺省百分比（opts.wasteThresholdPct 覆盖；非法值回退此值） */
const DEFAULT_WASTE_PCT = 50;
/** 健康轨迹的固定建议语（verdict=healthy 时保证出现于 advice） */
const HEALTHY_ADVICE = '轨迹健康，可蒸馏技能';
/** finding 代码 → 中文建议（每个代码至少一条；与审计律一一对应，纯静态映射） */
const ADVICE_BY_CODE = {
    'AUD-0': ['轨迹健康，可蒸馏技能'],
    'OSC-1': ['尾部动作循环：停止重复同一动作，重读目标与最新快照，改走键盘导航或换一条路径'],
    'OSC-2': ['画面在数个状态间往返：换一个目标元素或先 inspect 细察，打破来回切换'],
    'WST-1': ['无效果动作占比过高：先 inspect 验证目标元素可交互，再小步试探，勿让无效点击堆积'],
    'WST-2': ['连续 error 达 3 步以上：暂停盲目重试，排查感知/执行依赖链路，必要时升级人工'],
    'RCK-1': ['破坏性动作未取得进展：立即停用破坏性路径，改为可逆动作并在执行前确认世界状态'],
    'RCK-2': ['敏感动作占比过高：以只读动作先行确认，再谨慎执行提交/发送类操作'],
    'OPQ-1': ['大量步骤缺少 rationale：为每步补写决策理由，保证轨迹可回放、可审计'],
};
/** 安全数值：有限且不小于 min 才采信，否则回退缺省（绝不抛） */
function safeNumber(v, min, fallback) {
    return typeof v === 'number' && Number.isFinite(v) && v >= min ? v : fallback;
}
/** 轨迹数组防御：非数组按空轨迹处理，剔除 null/undefined 步（绝不抛） */
function safeList(steps) {
    if (!Array.isArray(steps))
        return [];
    return steps.filter(s => !!s);
}
/** 动作签名：kind@目标标签 —— 同一按钮反复点击视为同一签名；无目标动作以空标签参与 */
function actionSignature(action) {
    const kind = action && typeof action.kind === 'string' ? action.kind : 'unknown';
    const label = action?.target && typeof action.target.label === 'string' ? action.target.label : '';
    return `${kind}@${label}`;
}
/** rationale 是否缺席：非字符串或纯空白皆算黑箱步 */
function rationaleMissing(action) {
    return !(action && typeof action.rationale === 'string' && action.rationale.trim() !== '');
}
/** 步骤的生效风险分层：宪法盖章（effectiveRiskTier）优先，缺席回退 action.riskTier
 *  （纪元 Δ：宪法判决比策略申报重——审计按判决执法；旧轨迹无盖章则按申报，向后兼容） */
function effectiveTierOf(step) {
    return step.effectiveRiskTier ?? step.action?.riskTier;
}
/** 结局判定（畸形 outcome 一律不等） */
function outcomeIs(step, value) {
    return step.outcome === value;
}
/** 占比字符串：count/total 的百分比，一位小数（total≤0 ⇒ '0.0'） */
function pctStr(count, total) {
    if (total <= 0)
        return '0.0';
    return ((count * 100) / total).toFixed(1);
}
/**
 * ABA 型往返探测（纯函数）：
 * 尾 4 指纹构成周期 2（[a,b,a,b] 且 a≠b）或尾 6 指纹构成周期 3（[a,b,c,a,b,c] 且非全同）
 * ⇒ 命中返回 { period, shape }；否则 null。全同序列（[a,a,a,a]）属停滞不属往返，
 * 交给 OSC-1 的动作重复检测，不在此告警。
 */
function detectAba(h) {
    const n = h.length;
    if (n >= 4) {
        const t = h.slice(n - 4);
        if (t[0] === t[2] && t[1] === t[3] && t[0] !== t[1])
            return { period: 2, shape: t };
    }
    if (n >= 6) {
        const t = h.slice(n - 6);
        if (t[0] === t[3] && t[1] === t[4] && t[2] === t[5] && !(t[0] === t[1] && t[1] === t[2])) {
            return { period: 3, shape: t };
        }
    }
    return null;
}
/**
 * Φ-10 自我审计官：对一条已完结的轨迹做纯函数回看 —— 全部规则确定性、零随机、零 IO。
 *
 * 审计律（每条与实现一一对应）：
 *  - 震荡：尾部窗口（opts.oscillationWindow，缺省 6 步）内同一动作签名（kind@target.label）
 *    出现 ≥3 次 ⇒ critical 'OSC-1'，verdict 至少 oscillating；dhash 序列尾部构成 ABA 型
 *    往返（尾 4 指纹 [a,b,a,b] 周期 2，或尾 6 指纹 [a,b,c,a,b,c] 周期 3）⇒ warn 'OSC-2'
 *    （仅告警，不改判 verdict）。往返要求相邻状态互异；感知失败（dhash 为 null/空）的
 *    步不参与指纹序列。
 *  - 浪费：no_effect 步占比 > opts.wasteThresholdPct（缺省 50%，总步数 ≥4 才判）⇒ warn
 *    'WST-1'（detail 含具体占比）；连续 error ≥3 ⇒ critical 'WST-2'。两者任一出现 ⇒
 *    verdict 至少 wasteful。
 *  - 鲁莽：生效分层 = effectiveRiskTier（宪法判决盖章，纪元 Δ 起）优先、缺席回退
 *    action.riskTier。生效分层 destructive 且 outcome ≠ 'progress' 的步骤 ⇒ critical
 *    'RCK-1'（整条轨迹合并一条，detail 含首个步序与结局）；生效分层 sensitive 步
 *    占比 > 40%（总步数 ≥5 才判）⇒ warn 'RCK-2'。两者任一出现 ⇒ verdict 至少 reckless。
 *  - 黑箱：rationale 缺席（非字符串或纯空白）的步占比 > 30%（总步数 ≥3 才判）⇒ warn
 *    'OPQ-1' ⇒ verdict 至少 opaque。
 *  - verdict 优先级（多症并发取最重）：reckless > oscillating > wasteful > opaque >
 *    healthy；findings 累积不互斥（凡命中即入清单，顺序固定为 OSC→WST→RCK→OPQ）。
 *  - score：100 起扣 —— critical 每个 -25、warn 每个 -10、info 不扣；progress 步占比
 *    奖励 +（占比×10，封顶加 10）；最终夹 [0,100]。占比比较一律整数交叉相乘
 *    （count×100 > 阈值×total），杜绝浮点尾噪误判边界（恰 50%/30%/40% 不判）。
 *  - advice：按 findings 代码映射中文建议（每个 finding 至少一条，去重保序）；
 *    verdict=healthy 时保底追加「轨迹健康，可蒸馏技能」。
 *  - 空轨迹（含输入非数组 / 剔除空步后为零）⇒ healthy + info 'AUD-0'（空轨迹免检）
 *    + score 100。
 *
 * 防弹承诺：对任何畸形输入（null 步、缺 action、非法 opts）都按缺省语义收敛，绝不抛异常
 * —— 审计官自己首先得是无害的。
 */
export function auditTrajectory(steps, opts) {
    const window = Math.floor(safeNumber(opts?.oscillationWindow, 1, DEFAULT_OSCILLATION_WINDOW));
    const wastePct = safeNumber(opts?.wasteThresholdPct, 0, DEFAULT_WASTE_PCT);
    const list = safeList(steps);
    const total = list.length;
    // 空轨迹免检短路：无步可审计即满分放行
    if (total === 0) {
        return {
            verdict: 'healthy',
            findings: [{ severity: 'info', code: 'AUD-0', detail: '空轨迹免检：无步可审计' }],
            score: 100,
            advice: [HEALTHY_ADVICE],
        };
    }
    const findings = [];
    // ── 震荡：OSC-1 尾窗动作签名重复 / OSC-2 指纹 ABA 往返 ──
    const tail = list.slice(Math.max(0, total - window));
    const sigCounts = new Map();
    for (const s of tail) {
        const sig = actionSignature(s.action);
        sigCounts.set(sig, (sigCounts.get(sig) ?? 0) + 1);
    }
    let worstSig = '';
    let worstCount = 0;
    for (const [sig, c] of sigCounts) {
        if (c > worstCount) {
            worstSig = sig;
            worstCount = c;
        } // Map 插入序遍历 ⇒ 首个最大者胜，确定性
    }
    if (worstCount >= 3) {
        findings.push({
            severity: 'critical',
            code: 'OSC-1',
            detail: `尾部 ${tail.length} 步窗口内动作签名「${worstSig}」出现 ${worstCount} 次（≥3 判震荡）`,
        });
    }
    const hashes = [];
    for (const s of list) {
        if (typeof s.snapshotDhash === 'string' && s.snapshotDhash !== '')
            hashes.push(s.snapshotDhash);
    }
    const aba = detectAba(hashes);
    if (aba !== null) {
        findings.push({
            severity: 'warn',
            code: 'OSC-2',
            detail: `dhash 序列尾部构成周期 ${aba.period} 往返（${aba.shape.join('→')}）`,
        });
    }
    // ── 浪费：WST-1 no_effect 占比超阈 / WST-2 连续 error ≥3 ──
    const noEffectCount = list.reduce((n, s) => (outcomeIs(s, 'no_effect') ? n + 1 : n), 0);
    if (total >= 4 && noEffectCount * 100 > wastePct * total) {
        findings.push({
            severity: 'warn',
            code: 'WST-1',
            detail: `no_effect 占比 ${pctStr(noEffectCount, total)}（${noEffectCount}/${total}）超过阈值 ${wastePct}%`,
        });
    }
    let errorRun = 0;
    let maxErrorRun = 0;
    for (const s of list) {
        errorRun = outcomeIs(s, 'error') ? errorRun + 1 : 0;
        if (errorRun > maxErrorRun)
            maxErrorRun = errorRun;
    }
    if (maxErrorRun >= 3) {
        findings.push({
            severity: 'critical',
            code: 'WST-2',
            detail: `连续 error 最长达 ${maxErrorRun} 步（≥3 判浪费）`,
        });
    }
    // ── 鲁莽：RCK-1 破坏性步骤未取得进展 / RCK-2 敏感占比超阈 ──
    //（分层取 effectiveRiskTier（宪法盖章）优先、缺席回退 action.riskTier —— 纪元 Δ）
    const recklessSteps = list.filter(s => effectiveTierOf(s) === 'destructive' && !outcomeIs(s, 'progress'));
    if (recklessSteps.length > 0) {
        const first = recklessSteps[0];
        findings.push({
            severity: 'critical',
            code: 'RCK-1',
            detail: `共 ${recklessSteps.length} 处破坏性步骤未取得进展（首个在第 ${first.stepIndex} 步，outcome=${String(first.outcome)}）`,
        });
    }
    const sensitiveCount = list.reduce((n, s) => (effectiveTierOf(s) === 'sensitive' ? n + 1 : n), 0);
    if (total >= 5 && sensitiveCount * 100 > 40 * total) {
        findings.push({
            severity: 'warn',
            code: 'RCK-2',
            detail: `sensitive 步占比 ${pctStr(sensitiveCount, total)}（${sensitiveCount}/${total}）超过 40%`,
        });
    }
    // ── 黑箱：OPQ-1 rationale 缺席占比超阈 ──
    const opaqueCount = list.filter(s => rationaleMissing(s.action)).length;
    if (total >= 3 && opaqueCount * 100 > 30 * total) {
        findings.push({
            severity: 'warn',
            code: 'OPQ-1',
            detail: `rationale 缺席占比 ${pctStr(opaqueCount, total)}（${opaqueCount}/${total}）超过 30%`,
        });
    }
    // ── verdict：多症并发取最重（reckless > oscillating > wasteful > opaque > healthy）──
    const has = (code) => findings.some(f => f.code === code);
    let verdict = 'healthy';
    if (has('OPQ-1'))
        verdict = 'opaque';
    if (has('WST-1') || has('WST-2'))
        verdict = 'wasteful';
    if (has('OSC-1'))
        verdict = 'oscillating';
    if (has('RCK-1') || has('RCK-2'))
        verdict = 'reckless';
    // ── score：100 起扣 + progress 占比奖励（封顶 +10），夹 [0,100] ──
    const criticalCount = findings.filter(f => f.severity === 'critical').length;
    const warnCount = findings.filter(f => f.severity === 'warn').length;
    const progressCount = list.reduce((n, s) => (outcomeIs(s, 'progress') ? n + 1 : n), 0);
    const bonus = Math.min(10, (progressCount * 10) / total);
    const score = Math.max(0, Math.min(100, 100 - criticalCount * 25 - warnCount * 10 + bonus));
    // ── advice：finding 代码 → 中文建议（去重保序）；healthy 保底一句 ──
    const advice = [];
    for (const f of findings) {
        for (const tip of ADVICE_BY_CODE[f.code] ?? []) {
            if (!advice.includes(tip))
                advice.push(tip);
        }
    }
    if (verdict === 'healthy' && !advice.includes(HEALTHY_ADVICE))
        advice.push(HEALTHY_ADVICE);
    return { verdict, findings, score, advice };
}
/**
 * 轨迹签名的稳定摘要（纯函数、确定性）：动作 kind 序列以 '>' 连接、截取前 100 字符。
 * 缺 action/kind 的畸形步以 'unknown' 占位；非数组输入 ⇒ 空串。用于跨轨迹去重与快速比对。
 */
export function trajectorySignature(steps) {
    const list = Array.isArray(steps) ? steps : [];
    const kinds = [];
    for (const s of list) {
        kinds.push(s && s.action && typeof s.action.kind === 'string' ? s.action.kind : 'unknown');
    }
    return kinds.join('>').slice(0, 100);
}
