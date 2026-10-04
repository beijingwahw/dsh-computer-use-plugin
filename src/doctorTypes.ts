// src/doctorTypes.ts
// D-4 质量医生的类型契约（三轮评审后的终版接口）。
// 与实现分离 —— 接口是灵魂的形状，实现是灵魂的居所，各居其所。
import type { JournalEntry } from './journal';
import type { Config } from './config';

// ─── 类型契约（三轮评审后的终版接口） ───

export type AuditCategory = 'genesis' | 'smell' | 'security' | 'chain';

/** 创世铁律维度（权威清单 —— auditSelf 覆盖性基准） */
export type GenesisLaw =
  | 'io-serialization' | 'token-discipline' | 'architecture-void'
  | 'config-driven' | 'zero-intrusion' | 'honest-degradation';

export type RiskLevel = 'mechanical' | 'structural';

export interface DoctorRule {
  id: string;
  category: AuditCategory;
  severity: 'critical' | 'major' | 'minor' | 'info';
  laws: GenesisLaw[];
  baseWeight: number;
  tags?: string[];
  description: string;
  /** 契约：内部不抛错 —— 失败返回 [] 并 ctx.warn（引擎层另有兜底 try/catch 双防线） */
  scan(ctx: ScanContext): Promise<Finding[]>;
}

export interface DiagnoseScope {
  files?: string[];
  includeChainAudit?: boolean;
}

/**
 * checkpoint.ts 的 Checkpoint 是模块私有类型 —— 此处声明 D-4 的只读结构视图
 * （同名同义；仅声明医生实际消费的字段，解析真实档案 JSON 时结构兼容）。
 */
export interface CheckpointV3 {
  version: number;
  shaper?: { undoLog: Array<{ token: string; undone: boolean }> };
}

export interface ScanContext {
  sources: Array<{ path: string; content: string }>;
  chain: { entries: JournalEntry[]; chainIntact: boolean };
  snapshot: CheckpointV3 | null;
  config: Config;
  warn(message: string): void;
}

export interface Finding {
  id: string;
  ruleId: string;
  severity: DoctorRule['severity'];
  riskLevel: RiskLevel;
  location: { file: string; line: number; snippet: string };
  evidence: string;
  recommendation: string;
  /** W7-1 官方豁免：命中中央豁免注册表时携带（registered-retention —— 仍可见、不扣分、不进手术提案）。
   *  缺席 = 未豁免的普通 finding（老报告 JSON 无此字段，故可选）。 */
  exempted?: { reason: string; epoch: string };
}

/** W7-1 中央豁免注册表条目：豁免必须显式登记 —— 文件 + 理由 + 纪元三要素齐全，
 *  绝不静默跳过。理由必须溯源到源内 W6 注记或 DEBTS.md 在案条目（可审计）。 */
export interface OverEngineeringExemption {
  /** sourceRoot 相对路径（POSIX 分隔，与 finding.location.file 同键域） */
  file: string;
  /** 保留理由（非空；缺理由 = 静默豁免 = 禁止，装配即 fail-fast） */
  reason: string;
  /** 登记纪元（溯源到登记波次，如 'W6-1' / 'W6-2'） */
  epoch: string;
}

export interface Trend {
  scoreDelta: number;
  newRulesHit: string[];
  removedRulesHit: string[];
}

export interface DiagnosisReport {
  timestamp: number;
  incremental: boolean;
  score: number;
  genesisVerdict: 'intact' | 'violated';
  findings: Finding[];
  byCategory: Record<AuditCategory, number>;
  effectiveWeights: Record<string, number>;
  trend: Trend | null;
  warnings: string[];
  scannedFiles: number;
  chainAudited: boolean;
  /** W7-1 豁免可观测：registered = 中央注册表条数；applied = 本次诊断实际命中降级数。
   *  可选字段：老报告 JSON 与测试夹具构造的报告无此字段。 */
  exemptions?: { registered: number; applied: number };
}

export interface FixProposal {
  findingId: string;
  patch: { file: string; before: string; after: string; lineRange: { start: number; end: number } };
  riskLevel: RiskLevel;
}

export interface HealOptions {
  maxRisk: 'none' | 'mechanical';
  authorized: boolean;
  dryRun: boolean;
}

export interface HealResult {
  applied: FixProposal[];
  proposed: FixProposal[];
  rejected: Array<{ findingId: string; reason: string }>;
}

export interface Lesson {
  ruleId: string;
  firstSeen: number;
  occurrences: number;
  lastSeen: number;
  note: string;
}

export interface LastReport {
  score: number;
  hitRules: string[];
  findingsCount: number;
  scannedFiles: number;
}

export interface DoctorMemory {
  lessons: Lesson[];
  lastReport: LastReport | null;
  totalDiagnoses: number;
  totalFixesApplied: number;
}

export interface DoctorConfig {
  sourceRoot: string;
  memoryPath: string;
  strict: boolean;
  rules?: string[];
  tags?: string[];
}

export interface SelfAuditResult {
  coveredLaws: GenesisLaw[];
  missingLaws: GenesisLaw[];
  ruleCount: number;
  configValid: boolean;
  configErrors: string[];
}

export interface QualityDoctor {
  configure(config: DoctorConfig): Promise<void>;
  diagnose(scope?: DiagnoseScope): Promise<DiagnosisReport>;
  heal(report: DiagnosisReport, opts: HealOptions): Promise<HealResult>;
  recordLesson(ruleId: string, note: string): void;
  effectiveWeight(ruleId: string): number;
  auditSelf(): SelfAuditResult;
  memory(): Readonly<DoctorMemory>;
  reportPath(): string | null;
  resetMemory(): void;
  resetConfig(): void;
}
