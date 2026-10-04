// src/autonomy/runtime.types.ts
// W8-B2（doctor smell.over-engineering 清偿 · D-F2 千行文件群）：自 runtime.ts
// 低风险分区提取 —— 契约类型区（宏动作方言 / 运行时 OCR 词方言 / 执行结局与
// 验证明细）。逐字节搬迁、type-only 依赖；runtime.ts 以再导出保持导入面不变。
import type { PolicyAction, StepOutcome } from './policyEngine';

// ─── W4-1（A1）：宏动作方言 —— PolicyAction 的 runtime 等价决策面扩展字 ───

/**
 * W4-1：宏动作（kind:'macro'）。policyEngine 的 AutonomyActionKind 闭集零
 * 触碰（其领地主权），本执行面经联合扩展合法消费宏指令：payload 携宏定位
 * （skillId 直取字面量技能 / templateId 绑洞模板）与参数化实参
 * （args.target 重锚定标签提示 / args.text 覆盖 type_text 槽）。
 */
export interface MacroPolicyAction extends Omit<PolicyAction, 'kind'> {
  kind: 'macro';
  payload?: {
    skillId?: number;
    templateId?: number;
    args?: { target?: string; text?: string };
  } & Record<string, unknown>;
}

/** W4-1：runtime 决策面的动作全集（闭集 + 宏扩展字） */
export type RuntimePolicyAction = PolicyAction | MacroPolicyAction;

// ─── 契约类型 ───

/** 运行时词级 OCR 结果：label + 像素 bbox + 置信（[0,1]）—— composeSnapshot 的 localElements 方言 */
export interface RuntimeWord {
  label: string;
  bbox: { x0: number; y0: number; x1: number; y1: number };
  confidence: number;
}

/** 执行结局汇报：结局分类 + 判据证据（可选）+ 一句附注（云脑问答/技能召回等观察性动作的记事本） */
export interface ExecOutcome {
  outcome: StepOutcome;
  /** 判据证据：index 对应 spec.successCriteria 下标（失败不产生 violated —— 宁缺毋错） */
  criteriaEvidence?: Array<{ index: number; status: 'met' | 'violated' }>;
  /** 一句中文附注（ask_vlm 的回答 / recall_skill 的命中 / 异常归因） */
  note?: string;
  /** W1-1：验证过程明细（可选字段 —— 旧消费方零感知；测试与审计的取证面） */
  verification?: ExecVerification;
}

/**
 * W1-1：一次执行后验证的过程明细 —— 三区判决证据（A2）+ 稳态门账目（A5）+
 * 网格重试账目（A4）。全部 boolean|null（null = 证据缺席/降级，绝不猜）。
 */
export interface ExecVerification {
  /** A2①：动作点 ROI 区域指纹判变（null = 区域指纹缺席） */
  roiChanged: boolean | null;
  /** A2②：frameDiff 变化区与预期区域交叠（null = 帧差分/预期框缺席） */
  expectedHit: boolean | null;
  /** A2③：ROI 内 OCR 词级标签集判变（null = OCR 证据缺席） */
  roiOcrChanged: boolean | null;
  /** 全屏 dhash 判变（null = 指纹缺席 —— 旧管线回退时必为 boolean） */
  fullscreenChanged: boolean | null;
  /** 全屏变而 ROI 三证皆无 ⇒ 噪声（时钟/闪烁类假阳性，不算进展） */
  noise: boolean;
  /** A5：稳态门结果（null = 未走门/能力缺席） */
  steady: boolean | null;
  /** A5：稳态门轮询次数 */
  steadyPolls: number;
  /** A4：网格重试次数（0 = 首发落点） */
  retries: number;
  /** 降级标签（'roi' / 'steady-timeout' / 'steady-sample' / …） */
  degraded: string[];
}

// AutonomyActionKind 仅为 PolicyAction 联合面的成员类型（macro case 的 switch
// 窄化用）—— runtime.ts 桶的 createExecute 直接自 './policyEngine' 同源引入。
