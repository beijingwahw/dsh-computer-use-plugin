// src/tools/actionGate.ts
// Δ 纪元（全库跃迁·审计#1）：动作闸门的唯一事实源。
//
// 背景：审批闸门（危险词 ⇒ 需已授予的一次性令牌）与风险闸门（凭据 ⇒ 交还
// 用户）原本住在 clickMouse / typeText 工具内部 —— 而 replayOne（replay_actions
// / run_skill / orchestrator 的技能回退）直调 system.clickMouse/typeText，完全
// 绕过工具层。日志里的「发送」点击、凭据输入可被 run_skill 无令牌原样重放。
//
// 修法：判定逻辑抽取为本模块的 assertActionAllowed —— 工具层与重放层共用同一
// 事实源。抽取自 clickMouse（第六轮 + B-3 + J-14 跨通道 + N 纪元硬前置）与
// typeText（长度防御 + 第五轮风险闸门），逐语义等价：
//   click_mouse：
//     · 危险信号 = target_description **或** expected_text 命中 dangerPatterns
//       （J-14：expected_text 是第二危险信号通道 —— 绕过须同时沉默两条独立通道）；
//     · dangerous（闸门开启且命中）且无已授予有效令牌 ⇒ 拒绝（token 在场归因
//       'token-not-granted-or-expired'，缺席归因 'irreversible-action'），
//       阻断路径顺手 sweep 过期令牌（与旧实现同律）；
//     · 闸门开启时双通道全沉默 ⇒ 'undescribed-click' 硬前置（N 纪元 #18）。
//   type_text：
//     · 长度防御：text 超过 maxTextLength ⇒ 拒绝（防注入超长文本）；
//     · 风险闸门：焦点被标记为敏感区（点击密码框后）或文本自身命中风险语义
//       ⇒ 拒绝（凭据类输入不代劳）。
//
// 纪元 Ρ（双钥公证锁）：多通道语义公证。
// 背景审计：危险判定此前只信模型自述（target_description/expected_text）——
// 被提示注入的模型谎报目标（"press the button"）即可绕过 dangerPatterns 词表。
// 修法：assertActionAllowed 签名兼容扩展可选 evidence 参数，三通道 fail-heavy：
//   模型自述（现有双通道）∪ OCR 实读（ocrLabel）∪ 白盒控件名（structuralName），
//   任一通道经 normalizeForRisk 归一后命中 dangerPatterns ⇒ 按危险处理（需已授予令牌）。
// 配套语义握手（notarySemanticHandshake）：ocrLabel 与模型描述同时在场时，归一化后
// 须 fuzzyIncludes 双向宽松印证；不符 ⇒ 'notary-mismatch' 拒绝并要求以屏幕实读文字
// 重新描述目标。零回归律：evidence 缺席/两新通道全 null ⇒ 判定逐字段同旧版，仅加
// notarization:'degraded' 诚实标注；总开关 enableNotarizationLock=false ⇒ 完全旧路径。
import { matchesRiskPatterns, matchesDangerPatterns, normalizeForRisk, DEFAULT_RISK_PATTERNS, DEFAULT_DANGER_PATTERNS } from '../riskGate.js';
import { fuzzyIncludes } from '../fuzzy.js';
import { approval } from '../approval.js';
import { focusTracker } from '../focusTracker.js';
/** 缺省闸门配置：与 Config 缺省同值 —— 重放层未透传配置时不得静默失守 */
export const DEFAULT_ACTION_GATE_CONFIG = {
    enableApprovalGate: true,
    dangerPatterns: DEFAULT_DANGER_PATTERNS,
    enableRiskGate: true,
    riskPatterns: DEFAULT_RISK_PATTERNS,
    maxTextLength: 1000,
    focusMaxAgeMs: 30_000,
    enableNotarizationLock: true,
    notarySemanticHandshake: true,
};
/** 重放/技能步骤被闸门拦截的稳定标记（replay_actions 据此 fail-fast 中止；
 *  run_skill 据 FAILED 前缀计失败步） */
export const SAFETY_GATE_BLOCK = 'safety-gate-blocked';
// ─── 纪元 Ρ：语义握手（纯函数，测试面） ───
/** OCR 实读标签的最小可用长度：低于此（图标按钮的「×」「+」）跳过握手 ——
 *  单字符标签对任何描述都无法印证，执法即误杀 */
const NOTARY_LABEL_MIN_CHARS = 2;
/** 词元切分：空白分词 + 风险域归一化；归一后 <2 字符的词元剔除 ——
 *  单字符 pattern 在 fuzzyIncludes 的容差（⌈1/6⌉=1）下对空串也命中，必须过滤 */
function notaryTokens(raw) {
    return raw
        .toLowerCase()
        .split(/\s+/)
        .map(t => normalizeForRisk(t))
        .filter(t => t.length >= 2);
}
/**
 * 双钥握手（Ρ-2）：屏幕实读标签与模型描述的宽松双向印证。
 * 判据（任一成立即通过）：
 *   1. 整串双向：归一化后的标签与描述互为（OCR 容错）子串 —— 长串的容差
 *      ⌈m/6⌉ 吸收 OCR 噪声；
 *   2. 词元双向：一侧的任一实义词元**精确**出现在另一侧的归一化全文中 ——
 *      词元级不走编辑距离（2 字符词元配容差 1 会把 'ok' 匹配到 'ow' 这类
 *      无关邻接对上）；混淆免疫已由 normalizeForRisk 在双侧完成。
 * 跳过（ok=true 且 skipped 注明理由，调用方记 degraded 注记）：
 *   标签过短（<2 字符）/ 纯标点（归一化后为空）/ 描述不可归一 —— 防误杀。
 * 纯函数：两侧输入同过 normalizeForRisk（leet/同形字/全角在归一域内对齐）。
 */
export function notaryHandshake(rawLabel, rawDesc) {
    const label = rawLabel.trim();
    if (label.length < NOTARY_LABEL_MIN_CHARS)
        return { ok: true, skipped: 'ocr-label-too-short' };
    const labelNorm = normalizeForRisk(label);
    if (!labelNorm)
        return { ok: true, skipped: 'ocr-label-pure-punctuation' };
    const descNorm = normalizeForRisk(rawDesc);
    if (!descNorm)
        return { ok: true, skipped: 'description-unnormalizable' };
    // 整串双向：描述里能找到屏幕实读标签（或反之）即印证。容差只授予够长的
    // pattern（≥3 字符）：2 字符串配 ⌈m/6⌉=1 的容差会把 'ok' 匹配到无关邻接
    // 对 'ow' 上 —— 短串退回精确包含（混淆免疫仍由归一化双侧完成）。
    const wholeHit = (p, hay) => (p.length >= 3 ? fuzzyIncludes(p, hay) : hay.includes(p));
    if (wholeHit(labelNorm, descNorm) || wholeHit(descNorm, labelNorm)) {
        return { ok: true, skipped: null };
    }
    // 词元双向：实读标签的词元（归一化后精确）出现在描述里，或反之
    for (const t of notaryTokens(label))
        if (descNorm.includes(t))
            return { ok: true, skipped: null };
    for (const t of notaryTokens(rawDesc))
        if (labelNorm.includes(t))
            return { ok: true, skipped: null };
    return { ok: false, skipped: null };
}
/**
 * 断言一个动作（live 工具调用或日志/技能重放步）是否被放行。
 * 纯判定 + 与旧工具内实现一致的副作用谱（仅审批域阻断路径 sweep 过期令牌）。
 * 不派发任何物理动作 —— 派发与验收式消费仍是调用方（clickMouse/replayOne）的职责。
 *
 * Ρ 纪元签名兼容扩展：可选 evidence 携带点击落点的独立取证（OCR 实读 +
 * 白盒控件名）。三通道 fail-heavy；缺席 ⇒ 判定与返回字段同旧版（仅加
 * notarization:'degraded'）；enableNotarizationLock=false ⇒ 完全旧路径。
 */
export function assertActionAllowed(kind, args, cfg, evidence) {
    const c = { ...DEFAULT_ACTION_GATE_CONFIG, ...cfg };
    const a = args ?? {};
    if (kind === 'click_mouse') {
        // 通道字段类型收口：args 是模型输出的任意 JSON —— 非字符串真值（如数字）
        // 会在 matchesDangerPatterns（.toLowerCase）/approval.validate（.trim）抛
        // TypeError，炸穿「纯判定」契约（clickMouse 的闸门调用不在 try 内）。
        // 非字符串一律按缺席处理（fail-closed：唯一描述通道非字符串 ⇒ undescribed-click）。
        const target_description = typeof a.target_description === 'string' ? a.target_description : undefined;
        const expected_text = typeof a.expected_text === 'string' ? a.expected_text : undefined;
        const approval_token = typeof a.approval_token === 'string' ? a.approval_token : undefined;
        // ── 纪元 Ρ（双钥公证锁）：证据通道收口与总开关 ──
        // 总开关关 ⇒ evidence 一律无视，返回值与 Ρ 之前逐字节同形（完全旧路径，
        // 连 notarization 键都不入场）。空串证据 = 通道读到空 ⇒ 按缺席（degraded）。
        const ocrLabel = c.enableNotarizationLock && typeof evidence?.ocrLabel === 'string' && evidence.ocrLabel.length > 0
            ? evidence.ocrLabel
            : null;
        const structuralName = c.enableNotarizationLock && typeof evidence?.structuralName === 'string' && evidence.structuralName.length > 0
            ? evidence.structuralName
            : null;
        // 公证参与态：锁开且至少一条新通道在场；否则诚实标注 degraded（判定同旧版）
        const engaged = ocrLabel !== null || structuralName !== null;
        // stamp：undefined（锁关，不添键）| 'degraded'（锁开无通道/握手跳过）| 'engaged'
        let stamp = !c.enableNotarizationLock
            ? undefined
            : engaged ? 'engaged' : 'degraded';
        let note;
        /** 按参与态封存返回值：锁关不加键；有注记才加 notaryNote（键形稳定，deepEqual 可锚） */
        const fin = (base) => {
            if (stamp === undefined)
                return note ? { ...base, notaryNote: note } : base;
            const out = { ...base, notarization: stamp };
            if (note)
                out.notaryNote = note;
            return out;
        };
        // J-14 跨通道法则 → Ρ 纪元四通道：模型自述双通道 ∪ OCR 实读 ∪ 白盒控件名，
        // 任一命中（normalizeForRisk 同律归一）即触发审批域 —— 绕过须同时沉默四条
        // 独立信号通道，其中两条不归模型管（注入谎报目标的根除点）。
        const descHit = target_description ? matchesDangerPatterns(target_description, c.dangerPatterns) : false;
        const textHit = expected_text ? matchesDangerPatterns(expected_text, c.dangerPatterns) : false;
        const ocrHit = engaged && ocrLabel ? matchesDangerPatterns(ocrLabel, c.dangerPatterns) : false;
        const structHit = engaged && structuralName ? matchesDangerPatterns(structuralName, c.dangerPatterns) : false;
        const dangerous = c.enableApprovalGate && (descHit || textHit || ocrHit || structHit);
        if (dangerous && !(approval_token && approval.validate(approval_token))) {
            approval.sweep(); // 顺手清理过期令牌（与旧工具内实现同律）
            // 归因优先级：老通道在前（既有锚点归因零回归），公证通道殿后
            return fin({
                allowed: false,
                reason: approval_token ? 'token-not-granted-or-expired' : 'irreversible-action',
                requiresApproval: true,
                dangerous: true,
                dangerSignalChannel: descHit ? 'target_description'
                    : textHit ? 'expected_text'
                        : ocrHit ? 'ocr_label'
                            : 'structural_name',
            });
        }
        // ── Ρ-2 语义握手：OCR 实读与模型自述的双向宽松印证 ──
        // 前置于 undescribed 前置、后于危险执法（Ρ-1 律：描述无害但屏读「删除」⇒
        // 判危险需令牌，而非 mismatch）。危险通道在场时持有有效令牌也须过握手 ——
        // 令牌授权的是「这个目标」，不是「随便哪个目标」。
        if (engaged && c.notarySemanticHandshake && ocrLabel) {
            const descs = [target_description, expected_text]
                .filter((s) => typeof s === 'string' && s.length > 0);
            if (descs.length > 0) {
                const verdicts = descs.map(d => notaryHandshake(ocrLabel, d));
                if (verdicts.every(v => v.skipped)) {
                    // 标签过短/纯标点：跳过握手（防误杀图标按钮），记 degraded 注记
                    stamp = 'degraded';
                    note = `handshake-skipped:${verdicts[0].skipped}`;
                }
                else if (!verdicts.some(v => v.ok && !v.skipped)) {
                    return fin({
                        allowed: false,
                        reason: 'notary-mismatch',
                        requiresApproval: false, // 重述可解，令牌不可解：谎报/漂移的目标不在授权域内
                        dangerous,
                        notaryNote: `ocr="${ocrLabel.slice(0, 60)}" vs desc="${descs[0].slice(0, 60)}"`,
                    });
                }
            }
        }
        // N 纪元（盲区根除）：闸门开启时描述是硬前置 —— 两条信号通道全沉默的点击
        // 不再放行（审批闸门无法审判一个无名目标；OCR 在场不能替代模型自述）。
        if (c.enableApprovalGate && !target_description && !expected_text) {
            return fin({ allowed: false, reason: 'undescribed-click', requiresApproval: false, dangerous: false });
        }
        return fin({ allowed: true, requiresApproval: dangerous, dangerous });
    }
    // type_text
    const text = typeof a.text === 'string' ? a.text : '';
    if (text.length > c.maxTextLength) {
        return { allowed: false, reason: 'text-too-long', requiresApproval: false, dangerous: false };
    }
    if (c.enableRiskGate && (focusTracker.isSensitive(c.focusMaxAgeMs) || matchesRiskPatterns(text, c.riskPatterns))) {
        return { allowed: false, reason: 'sensitive-input', requiresApproval: false, dangerous: false };
    }
    return { allowed: true, requiresApproval: false, dangerous: false };
}
