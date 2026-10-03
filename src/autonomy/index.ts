// src/autonomy/index.ts
// 纪元 Φ（自主智能环桶文件）：十器官 + 运行时适配层公共导出的统一再分发，
// 以及宿主接线入口 buildAutonomyStack —— 把 Config 六字段铸成闭环除 goal 外的全部器官。
//
// 器官清单（各自测试全绿，本文件只做转发与铸造，不新增认知）：
//   goalState（Φ-1 目标机）/ worldSnapshot（Φ-2 世界快照）/ policyEngine（Φ-3 策略）/
//   autoPilot（Φ-4 闭环）/ evolutionEngine（Φ-5 进化）/ sceneSemantics（Φ-6 场景）/
//   uncertainty（Φ-7 认识论）/ autonomyConstitution（Φ-8 宪法）/
//   counterfactual（Φ-9 反事实）/ selfAudit（Φ-10 审计）/ runtime（真实躯体适配）。
//
// 依赖方向铁律（与 vlm/index.ts 同源）：config.ts 绝不 import autonomy；
// 本文件对 Config 只做 import type 引用 —— 类型擦除后无运行时回路。
import type { Config } from '../config';
import type { RiskTier } from './autonomyConstitution';
import { AutonomyConstitution } from './autonomyConstitution';
import { PolicyEngine } from './policyEngine';
import { createPerceive, createExecute, type RuntimeDeps, type ExecOutcome } from './runtime';
import type { AutonomyDeps } from './autoPilot';

export * from './goalState';
export * from './worldSnapshot';
export * from './policyEngine';
export * from './autoPilot';
export * from './evolutionEngine';
export * from './sceneSemantics';
export * from './uncertainty';
export * from './autonomyConstitution';
export * from './counterfactual';
export * from './selfAudit';
export * from './runtime';
// 纪元 Σ（Σ-2）：自主训练营 —— 确定性合成任务 + 虚拟世界闭环 + 进化引擎
export * from './gym';
// 纪元 Σ（Σ-3）：断点续跑记账 —— token → PilotRunRecord 档案库（autonomy_resume 的血脉）
export * from './pilotStore';

// ─── 宿主接线入口 ───

/**
 * 自主闭环栈：除 goal（由调用方按 GoalSpec 铸造 GoalStateMachine）与 execute
 * （需 spec 定判据）外的全部 AutonomyDeps 成员 —— perceive/policy 已铸，
 * constitution/sleep/onStep 可选在场。
 */
export type AutonomyStack = Omit<AutonomyDeps, 'goal' | 'execute'>;

/** 合法风险分层表（CSV 解析白名单） */
const VALID_TIERS: ReadonlySet<RiskTier> = new Set<RiskTier>(['benign', 'sensitive', 'destructive']);

/** CSV → 去空白去重的词表（空串 ⇒ []） */
function csvWords(csv: unknown): string[] {
  if (typeof csv !== 'string' || csv.trim() === '') return [];
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
export function buildAutonomyStack(config: Config, deps: RuntimeDeps = {}): AutonomyStack {
  // 快照槽就地补挂（同一对象感知/执行共享 —— 见 JSDoc）
  if (!deps.lastSnapshotRef) deps.lastSnapshotRef = { current: null };

  const tierCsv = typeof config?.autonomyAllowTiers === 'string' ? config.autonomyAllowTiers : '';
  const allowTiers = tierCsv
    .split(',')
    .map(w => w.trim().toLowerCase())
    .filter((w): w is RiskTier => VALID_TIERS.has(w as RiskTier));
  const forbiddenKeywords = csvWords(config?.autonomyForbiddenKeywords);
  const maxSteps =
    typeof config?.autonomyMaxSteps === 'number' && Number.isFinite(config.autonomyMaxSteps) && config.autonomyMaxSteps >= 1
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
export type { RuntimeDeps, ExecOutcome };
