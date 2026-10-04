// src/autonomy/policyEngine.ts
// 纪元 Φ（Φ-3 自主判断中枢）：给定世界快照与目标进度，裁决下一步动作。
//
// 定位：自主智能环的「意志」—— 不执行、只决策。输入 Φ-2 的世界快照与 Φ-1 的
// 目标状态，输出一个自带理据（rationale）、预期效应（expectedEffect）、效用
// （utility）与风险分层（riskTier）的 PolicyAction，交执行层落地、Φ-4 验证层核对。
//
// 决策铁律（与全仓一致）：
//   1. 确定性优先 —— 七级决策序逐级裁决、先到先得（详见 decide 的 JSDoc）；
//      云脑只在元素匹配「低置信或并列」时被咨询一次，失败即回退确定性选择。
//   2. 绝不抛异常 —— 任何内部异常收敛为 escalate 决策（degraded:true）。
//   3. 可审计 —— 每个动作自带一句中文 rationale 与预期效应，喂给验证层与人类。
//   4. 零新增依赖 —— 分词/匹配自带轻量实现（中文 2-gram + 英文单词），不复用
//      fuzzy.ts（那是对 OCR 逐字噪声的编辑距离容错，语义与此处不同）。
//   5. 分词结果有界缓存（纪元 Δ）—— GoalSpec 关键词按对象 WeakMap 缓存、字符串
//      分词走 1024 条上限的 Map：同输入同输出（行为透明），跨步复用的判据/标签/
//      技能描述零重算；缓存数组只读共享，调用方不得原地修改。
//   6. 并列破平（纪元 Η-4）—— 判据匹配得分并列带（差 < tieGap，与 uncertain 判据
//      同带）内的候选用 Φ-9 反事实效用分（counterfactual.scoreOptions 真实 API：
//      U = 0.5·progress + 0.3·info − 0.2·risk，重复动作折价含内）择优；效用并列取
//      信息增益高者、再并列取带内输入次序（确定性稳定序兜底，同输入同输出）——
//      效用全并列时保持旧确定性排序（得分→元素置信→原序）逐字节不变。
import { getGlmClient, isGlmConfigured } from '../vlm/glmClient.js';
import { kernelRegistry } from '../kernel/registry.js';
// W6-1（doctor 债清偿·smell.over-engineering）：常量 + 纯函数工具区（分词/缓存/
// 词法风险预分类/候选构建/并列破平/僵局探测/提示词铸造）逐字节搬至
// ./policyEngineUtil —— 导入面不变（extractGoalKeywords 原位再导出）。
export { extractGoalKeywords } from './policyEngineUtil.js';
import { BUDGET_MS_LOW, BUDGET_STEPS_LOW, MATCH_CONFIDENT, POPUP_CONFIRM_RE, TIE_GAP, VLM_CANDIDATE_CAP, buildCandidates, buildPickPrompt, breakTieBand, candidatesToActions, classifyClickRisk, clamp01, composeTypeOrDragAction, detectStagnation, digestHas, nextSwitchKind, normalizeWs, round2, skillOverlap, tokenizeCached, unmetCriteria, } from './policyEngineUtil.js';
// ─── 决策中枢 ───
/**
 * Φ-3 自主判断中枢 —— 无状态、确定性优先、绝不抛异常。
 *
 * decide() 的七级确定性决策序（先到先得，每级 rationale 见实现）：
 *  ① 弹窗优先：popups 非空 ⇒ 点弹窗内确认类元素（label 命中 确认/确定/同意/
 *     允许/继续/是/ok/allow/yes）或按 Esc（payload {keys:['esc']}），utility 0.9；
 *  ② 判据匹配点击：未 met 判据关键词与元素标签重合（覆盖率打分）且
 *     interactive !== false ⇒ click 最佳候选，utility = 元素 confidence；
 *     ΝΩ-10 ②′（紧邻 ② 之前）：判据含「输入/填/enter/密码」语义锚词且匹配候选
 *     为 role=input ⇒ type（payload.text 取判据引号内容或合格后缀）；判据含
 *     「拖/移动到」且两个引号落点可在快照锚定 ⇒ drag。拿不准不产（保守窄门，
 *     ② 点击与 escalate 兜底仍在）。
 *  ③ 文本宣称：无元素匹配但 textDigest 已含某判据全部关键词 ⇒ declare
 *     （宣称达成，交验证层核对），utility 0.6；
 *  ④ 僵局切换（ΝΩ-10 三级退避）：尾部同类动作连续 ≥2 次 no_effect ⇒
 *     scroll（{direction:'down'}）→ inspect（聚焦区域放大）→ hotkey Tab
 *     焦点周游 三级轮换，utility 0.5；
 *  ⑤ 技能召回：skills 描述与目标关键词重合 ⇒ recall_skill，
 *     utility = reliability × 0.8；
 *  ⑥ 预算升级：剩余步数 ≤2 或剩余毫秒 ≤15000 ⇒ escalate，utility 0.4；
 *  ⑦ 云脑兜底：ask_vlm（uncertain:true，utility 0.3，动作本身由执行层持图
 *     发问）；若云脑未配置（无注入 client 且 isGlmConfigured()=false）⇒
 *     escalate（degraded:true，utility 0.3）。
 *
 * 不确定判定（仅 ②）：最佳候选得分 <0.55 或与次佳差 <0.05 ⇒ uncertain；
 * 此时若 useVlmWhenUncertain 且云脑可用，用 client.chatJson 问一次
 * 「给定目标与元素标签列表，该点哪个 index」（纯文本对话，输出 {index, reason}），
 * 命中 ⇒ 用云脑选择；越界/失败/异常 ⇒ 回退确定性最佳选择并标 degraded:true。
 */
export class PolicyEngine {
    injectedClient;
    useVlmWhenUncertain;
    constructor(options = {}) {
        this.injectedClient = options?.client;
        // 缺省 true：不确定即咨询 —— 云脑只在这一刻介入，其余时刻全确定性
        this.useVlmWhenUncertain = options?.useVlmWhenUncertain !== false;
    }
    /** 解析可用云脑：注入 client 优先，其次全局单例（须已配置）；注入了未配置的真 client 视同未配置 */
    resolveClient() {
        try {
            const c = this.injectedClient ?? (isGlmConfigured() ? getGlmClient() : null);
            if (!c)
                return null;
            if (c.configured === false)
                return null;
            return c;
        }
        catch {
            return null;
        }
    }
    /**
     * 云脑选点咨询（只问一次）：候选列表 index → {index, reason}。
     * 越界 / 非法 / 调用失败 / 抛异常 ⇒ { picked:null, note:回退原因 }，绝不抛。
     */
    async consultVlmPick(client, goalText, unmetTexts, candidates) {
        const labels = candidates.map(c => typeof c.element.label === 'string' ? c.element.label : '');
        const prompt = buildPickPrompt(goalText, unmetTexts, labels);
        try {
            const res = await client.chatJson({
                images: [], // 快照不含像素，纯文本语义仲裁（协议允许空图对话）
                prompt,
                temperature: 0.1,
                maxTokens: 512,
            });
            if (!res.ok) {
                return { picked: null, note: `云脑咨询失败（${res.error ?? '未知错误'}），回退确定性最佳匹配` };
            }
            const v = res.value;
            if (v === null || typeof v !== 'object' || Array.isArray(v)) {
                return { picked: null, note: '云脑回复非 JSON 对象，回退确定性最佳匹配' };
            }
            const idx = v.index;
            if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0 || idx >= candidates.length) {
                return { picked: null, note: `云脑给出的 index 越界（${String(idx)}），回退确定性最佳匹配` };
            }
            const reason = String(v.reason ?? '').slice(0, 80);
            return { picked: candidates[idx], note: reason || '点击该候选最有利于推进目标' };
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return { picked: null, note: `云脑咨询异常（${msg}），回退确定性最佳匹配` };
        }
    }
    /**
     * 裁决下一步动作 —— 永不抛错；任何内部异常收敛为 escalate（degraded:true）。
     * 输入缺字段按空集处理（宁可保守升级，不可凭空动作）。
     */
    async decide(ctx) {
        try {
            const snapshot = (ctx?.snapshot ?? {});
            const spec = (ctx?.spec ?? {});
            const goal = (ctx?.goal ?? {});
            const history = Array.isArray(ctx?.history) ? ctx.history : [];
            const elements = (Array.isArray(snapshot.elements) ? snapshot.elements : []).filter(e => !!e);
            const popups = (Array.isArray(snapshot.popups) ? snapshot.popups : []).filter(p => typeof p === 'string' && p.trim() !== '');
            const unmet = unmetCriteria(goal, spec);
            const unmetTexts = unmet.map(u => u.criterion);
            const goalText = typeof spec.goal === 'string' ? spec.goal : '';
            // ① 弹窗优先：弹窗遮挡下的其余决策都不可信，先恢复主界面
            if (popups.length > 0) {
                const popupName = popups[0];
                const confirmEl = elements
                    .filter(e => e.interactive !== false && POPUP_CONFIRM_RE.test(normalizeWs(e.label)))
                    .sort((a, b) => clamp01(b.confidence) - clamp01(a.confidence))[0];
                if (confirmEl) {
                    return {
                        action: {
                            kind: 'click',
                            target: {
                                bbox: confirmEl.bbox,
                                center: confirmEl.center,
                                label: confirmEl.label,
                            },
                            payload: { popup: popupName },
                            rationale: `检测到弹窗「${popupName}」，点击其确认类元素「${confirmEl.label}」以关闭`,
                            expectedEffect: '弹窗确认后关闭，下一帧快照 popups 为空',
                            utility: 0.9,
                            riskTier: classifyClickRisk(confirmEl.label),
                        },
                        uncertain: false,
                        degraded: false,
                    };
                }
                return {
                    action: {
                        kind: 'hotkey',
                        payload: { keys: ['esc'] },
                        rationale: `检测到弹窗「${popupName}」且无确认类元素，按 Esc 先行关闭以恢复主界面`,
                        expectedEffect: '弹窗关闭，下一帧快照 popups 为空',
                        utility: 0.9,
                        riskTier: 'benign',
                    },
                    uncertain: false,
                    degraded: false,
                };
            }
            // ② 判据匹配点击：未达成判据的关键词在可交互元素标签上的最佳覆盖
            //    （纪元 Η-4：并列带内经 Φ-9 反事实效用分破平 —— 见 breakTieBand）
            const candidates = breakTieBand(buildCandidates(elements, unmet), spec, snapshot, history);
            // ΝΩ-10（候选透出）：② 级裁决随行携带排名候选（岔路账消费面，其余级缺席）
            const candidateActions = candidatesToActions(candidates);
            // ②′ ΝΩ-10（type/drag 产生通道）：type 此前只在行动词汇表、无产生路径 ——
            //    判据含「输入/填/enter/密码」语义锚词且匹配候选为 role=input ⇒ 产 type；
            //    判据含「拖/移动到」+ 两个引号锚定落点 ⇒ 产 drag。键入语义比点击更具体，
            //    故排在 ② 点击之前；拿不准不产（通道内部保守守卫），escalate 兜底仍在。
            const composed = composeTypeOrDragAction(candidates, unmet, elements);
            if (composed) {
                return {
                    action: composed,
                    uncertain: false,
                    degraded: false,
                };
            }
            if (candidates.length > 0) {
                const best = candidates[0];
                const second = candidates[1];
                // 纪元 Θ（Θ-4 生产接线）：不确定判据双阈值读内核注册表 —— 未注册 ⇒
                // getOrDefault 回声模块常量（0.55 / 0.05），行为逐字节不变。
                const tied = second !== undefined && best.score - second.score < kernelRegistry.getOrDefault('policy.tieGap', TIE_GAP);
                const low = best.score < kernelRegistry.getOrDefault('policy.matchConfident', MATCH_CONFIDENT);
                const uncertain = tied || low;
                let chosen = best;
                let degraded = false;
                let note;
                let rationale = `判据「${best.criterion}」关键词与元素「${best.element.label}」标签重合（得分 ${round2(best.score)}），点击推进目标`;
                if (uncertain && this.useVlmWhenUncertain) {
                    const client = this.resolveClient();
                    if (client) {
                        const r = await this.consultVlmPick(client, goalText, unmetTexts, candidates.slice(0, VLM_CANDIDATE_CAP));
                        if (r.picked) {
                            chosen = r.picked;
                            note = `云脑裁决：${r.note}`;
                            rationale = `元素匹配不确定（${tied ? '候选得分并列' : '匹配置信不足'}），${note}，点击「${chosen.element.label}」`;
                        }
                        else {
                            degraded = true;
                            note = r.note;
                        }
                    }
                    else {
                        note = '云脑未配置或不可用，保留确定性最佳匹配';
                    }
                }
                return {
                    action: {
                        kind: 'click',
                        target: {
                            bbox: chosen.element.bbox,
                            center: chosen.element.center,
                            label: chosen.element.label,
                        },
                        payload: { criterion: chosen.criterion, matchScore: round2(chosen.score) },
                        rationale,
                        expectedEffect: `「${chosen.element.label}」被激活，页面状态变化使判据「${chosen.criterion}」可被验证`,
                        utility: clamp01(chosen.element.confidence),
                        riskTier: classifyClickRisk(chosen.element.label),
                    },
                    uncertain,
                    degraded,
                    // ΝΩ-10：候选透出（仅 ② 级；云脑改选只动 action，candidates 保持确定性排名）
                    ...(candidateActions.length > 0 ? { candidates: candidateActions } : {}),
                    ...(note ? { note } : {}),
                };
            }
            // ③ 文本宣称：判据关键词已全部见于文本摘要 ⇒ 宣称达成，交验证层核对
            const digest = normalizeWs(snapshot.textDigest);
            if (digest) {
                for (const c of unmet) {
                    const tokens = [...new Set(tokenizeCached(c.criterion))];
                    if (tokens.length > 0 && tokens.every(t => digestHas(digest, t))) {
                        return {
                            action: {
                                kind: 'declare',
                                payload: { criterion: c.criterion },
                                rationale: `判据「${c.criterion}」的全部关键词已见于页面文本摘要，宣称其达成并交验证层核对`,
                                expectedEffect: '验证层复核后，该判据状态更新为 met',
                                utility: 0.6,
                                riskTier: 'benign',
                            },
                            uncertain: false,
                            degraded: false,
                        };
                    }
                }
            }
            // ④ 僵局切换（ΝΩ-10 三级退避）：尾部同类动作连续 ≥2 次无效果 ⇒ 三级轮换
            //    scroll → inspect → hotkey Tab 焦点周游 → scroll（与探索层全局候选
            //    hotkey#tab 同先例）；轮换状态按最近一次切换家族动作（见 nextSwitchKind）
            const stagnation = detectStagnation(history);
            if (stagnation) {
                const next = nextSwitchKind(history);
                if (next === 'scroll') {
                    return {
                        action: {
                            kind: 'scroll',
                            payload: { direction: 'down' },
                            rationale: `「${stagnation.kind}」连续 ${stagnation.count} 次无效果，切换策略：向下滚动暴露未见内容`,
                            expectedEffect: '视口下移，快照出现新元素或新文本',
                            utility: 0.5,
                            riskTier: 'benign',
                        },
                        uncertain: false,
                        degraded: false,
                    };
                }
                if (next === 'inspect') {
                    const fr = snapshot.focusedRegion;
                    const region = fr && typeof fr === 'object'
                        ? fr
                        : {
                            x0: 0,
                            y0: 0,
                            x1: typeof snapshot.width === 'number' && snapshot.width > 0 ? snapshot.width : 1920,
                            y1: typeof snapshot.height === 'number' && snapshot.height > 0 ? snapshot.height : 1080,
                        };
                    return {
                        action: {
                            kind: 'inspect',
                            payload: { region },
                            rationale: `「${stagnation.kind}」连续 ${stagnation.count} 次无效果，切换策略：聚焦区域放大细察`,
                            expectedEffect: '聚焦区域被放大细察，识别出更精细的元素或文本',
                            utility: 0.5,
                            riskTier: 'benign',
                        },
                        uncertain: false,
                        degraded: false,
                    };
                }
                // 第三级：hotkey Tab 焦点周游 —— 视口滚动与放大细察都失灵后，换键盘通路
                return {
                    action: {
                        kind: 'hotkey',
                        payload: { keys: ['tab'] },
                        rationale: `「${stagnation.kind}」连续 ${stagnation.count} 次无效果，切换策略：Tab 周游焦点寻找可达路径`,
                        expectedEffect: '焦点移至下一可交互元素，键盘通路被探测',
                        utility: 0.5,
                        riskTier: 'benign',
                    },
                    uncertain: false,
                    degraded: false,
                };
            }
            // ⑤ 技能召回：技能描述与目标关键词重合 ⇒ 复用可靠流程
            //    （描述只分词一次，重叠计算与长词复查共用 —— 纪元 Δ 每步重复分词修律）
            if (Array.isArray(ctx?.skills) && ctx.skills.length > 0) {
                const goalTokens = new Set(tokenizeCached(goalText));
                const overlapping = ctx.skills
                    .map((s, i) => {
                    const descTokens = tokenizeCached(s?.description);
                    return { skill: s, i, descTokens, shared: skillOverlap(goalTokens, descTokens) };
                })
                    .filter(e => e.shared >= 2 ||
                    (e.shared >= 1 &&
                        e.descTokens.some(t => goalTokens.has(t) && t.length >= 4)))
                    .sort((a, b) => clamp01(b.skill?.reliability) - clamp01(a.skill?.reliability) || a.i - b.i);
                const top = overlapping[0];
                if (top) {
                    return {
                        action: {
                            kind: 'recall_skill',
                            payload: { skillId: top.skill.id, description: top.skill.description },
                            rationale: `技能「${top.skill.id}」描述与目标重合（共享 ${top.shared} 个关键词），召回其可靠流程`,
                            expectedEffect: '技能流程逐步展开执行，推进目标判据',
                            utility: clamp01(top.skill.reliability) * 0.8,
                            riskTier: 'benign',
                        },
                        uncertain: false,
                        degraded: false,
                    };
                }
            }
            // ⑥ 预算升级：步数/时间将尽 ⇒ 交上游裁决，避免半途失控
            // 纪元 Ξ（Ξ-D 生产接线）：预算红线读内核注册表 —— policy.budgetStepsLow
            //（缺省 2）/ policy.budgetMsLow（缺省 15000）。未注册 ⇒ getOrDefault 回声
            // 字面量，升级判决逐字节不变；每次 decide 单次读取（set 即时生效）。
            const budget = ctx?.budgetRemaining;
            if (budget && typeof budget === 'object') {
                const steps = typeof budget.steps === 'number' && Number.isFinite(budget.steps) ? budget.steps : Number.POSITIVE_INFINITY;
                const ms = typeof budget.ms === 'number' && Number.isFinite(budget.ms) ? budget.ms : Number.POSITIVE_INFINITY;
                if (steps <= kernelRegistry.getOrDefault('policy.budgetStepsLow', BUDGET_STEPS_LOW)
                    || ms <= kernelRegistry.getOrDefault('policy.budgetMsLow', BUDGET_MS_LOW)) {
                    return {
                        action: {
                            kind: 'escalate',
                            payload: {
                                reason: 'budget-low',
                                ...(Number.isFinite(steps) ? { stepsLeft: steps } : {}),
                                ...(Number.isFinite(ms) ? { msLeft: ms } : {}),
                            },
                            rationale: `预算将尽（剩 ${Number.isFinite(steps) ? steps : '?'} 步 / ${Number.isFinite(ms) ? ms : '?'}ms），升级上游裁决避免半途失控`,
                            expectedEffect: '控制权移交上游（人工介入或重新规划）',
                            utility: 0.4,
                            riskTier: 'benign',
                        },
                        uncertain: false,
                        degraded: false,
                    };
                }
            }
            // ⑦ 云脑兜底：本地七级规则均未命中 —— 有云脑则交开放语义，无云脑则升级
            const client = this.resolveClient();
            if (client) {
                return {
                    action: {
                        kind: 'ask_vlm',
                        payload: {
                            question: `目标「${goalText || '（未给出）'}」在当前快照中无确定性动作可推进；请观察整屏并给出下一步建议（未达成判据：${unmetTexts.length > 0 ? unmetTexts.join('；') : '无'}）`,
                        },
                        rationale: '本地七级确定性规则均未命中，交云脑开放语义观察整屏给出建议',
                        expectedEffect: '云脑给出下一步动作建议，进入下一决策循环',
                        utility: 0.3,
                        riskTier: 'benign',
                    },
                    uncertain: true,
                    degraded: false,
                };
            }
            return {
                action: {
                    kind: 'escalate',
                    payload: { reason: 'no-deterministic-action' },
                    rationale: '本地规则未命中且云脑未配置（缺 API Key），升级上游或人工裁决',
                    expectedEffect: '控制权移交上游或人工，本环暂停',
                    utility: 0.3,
                    riskTier: 'benign',
                },
                uncertain: true,
                degraded: true,
            };
        }
        catch (e) {
            // 绝不抛异常：未知异常（含注入物炸裂）收敛为升级决策
            const msg = (e instanceof Error ? e.message : String(e)).slice(0, 200);
            return {
                action: {
                    kind: 'escalate',
                    payload: { reason: 'policy-engine-internal-error', detail: msg },
                    rationale: `决策管线内部异常（${msg}），升级上游裁决`,
                    expectedEffect: '本轮不执行世界动作，等待上游指令',
                    utility: 0.3,
                    riskTier: 'benign',
                },
                uncertain: true,
                degraded: true,
                note: 'policy-engine-internal-error',
            };
        }
    }
}
