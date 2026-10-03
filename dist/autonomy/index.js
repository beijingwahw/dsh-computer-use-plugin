import { AutonomyConstitution } from './autonomyConstitution.js';
import { PolicyEngine } from './policyEngine.js';
import { createPerceive, createExecute } from './runtime.js';
export * from './goalState.js';
export * from './worldSnapshot.js';
export * from './policyEngine.js';
export * from './autoPilot.js';
export * from './evolutionEngine.js';
export * from './sceneSemantics.js';
export * from './uncertainty.js';
export * from './autonomyConstitution.js';
export * from './counterfactual.js';
export * from './selfAudit.js';
export * from './runtime.js';
// 纪元 Σ（Σ-2）：自主训练营 —— 确定性合成任务 + 虚拟世界闭环 + 进化引擎
export * from './gym.js';
// 纪元 Σ（Σ-3）：断点续跑记账 —— token → PilotRunRecord 档案库（autonomy_resume 的血脉）
export * from './pilotStore.js';
/** 合法风险分层表（CSV 解析白名单） */
const VALID_TIERS = new Set(['benign', 'sensitive', 'destructive']);
/** CSV → 去空白去重的词表（空串 ⇒ []） */
function csvWords(csv) {
    if (typeof csv !== 'string' || csv.trim() === '')
        return [];
    return [...new Set(csv.split(',').map(w => w.trim().toLowerCase()).filter(w => w.length > 0))];
}
/**
 * 宿主血脉接线：以插件 Config 铸造自主闭环栈（perceive / policy / constitution）。
 *
 * 规则映射律：
 *  · autonomyAllowTiers CSV → RiskTier[]（取值 benign/sensitive/destructive，
 *    非法词剔除；全非法 ⇒ 回落 ['benign'] 最保守立法；destructive 即使列入
 *    也被宪法硬法恒审批 —— 不可逆没有自主授权通道）；
 *  · autonomyForbiddenKeywords CSV → 宪法扫描词表（与 riskGate 默认不可逆
 *    词表取并集后扫描 —— 宪法 check 内建该并集，此处只喂追加词）；
 *  · autonomyMaxSteps → 宪法步数硬顶 maxTotalSteps（环的步保险丝与宪法
 *    停机线同源同值 —— 预算只有一处真相）；
 *  · autonomyVlmWhenUncertain → PolicyEngine 的不确定即咨询开关。
 *
 * 快照槽：deps.lastSnapshotRef 缺席时就地补挂在传入的 deps 对象上 —— 调用方
 * 随后以同一 deps（或其展开）铸 createExecute({...deps, spec})，感知与执行
 * 即共享 before 帧，执行后验证零额外补拍。now/sleep 透传（注入时钟贯穿全环）。
 * GoalStateMachine 由调用方铸造（每轮目标各异，栈不越权代铸）。
 */
export function buildAutonomyStack(config, deps = {}) {
    // 快照槽就地补挂（同一对象感知/执行共享 —— 见 JSDoc）
    if (!deps.lastSnapshotRef)
        deps.lastSnapshotRef = { current: null };
    const tierCsv = typeof config?.autonomyAllowTiers === 'string' ? config.autonomyAllowTiers : '';
    const allowTiers = tierCsv
        .split(',')
        .map(w => w.trim().toLowerCase())
        .filter((w) => VALID_TIERS.has(w));
    const forbiddenKeywords = csvWords(config?.autonomyForbiddenKeywords);
    const maxSteps = typeof config?.autonomyMaxSteps === 'number' && Number.isFinite(config.autonomyMaxSteps) && config.autonomyMaxSteps >= 1
        ? Math.floor(config.autonomyMaxSteps)
        : undefined;
    return {
        perceive: createPerceive(deps),
        policy: new PolicyEngine({
            ...(deps.client ? { client: deps.client } : {}),
            useVlmWhenUncertain: config?.autonomyVlmWhenUncertain !== false,
        }),
        constitution: new AutonomyConstitution({
            allowAutonomousTiers: allowTiers.length > 0 ? allowTiers : ['benign'],
            ...(forbiddenKeywords.length > 0 ? { forbiddenKeywords } : {}),
            ...(maxSteps !== undefined ? { maxTotalSteps: maxSteps } : {}),
        }),
        ...(deps.now ? { now: deps.now } : {}),
        ...(deps.sleep ? { sleep: deps.sleep } : {}),
    };
}
export { createExecute, createPerceive };
