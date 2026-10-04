// src/subAgent.arbitration.ts
// W9-3（D-F4 拆分·仲裁分区）：自 subAgent.ts 低风险提取 —— 裁决策略模式
// （Arbitration 契约 + ConfidenceWeightedArbitrator 缺省策略）+ W2-4 G4 实证
// 仲裁（验证使命铸造/锚定匹配/EvidenceBackedArbitrator）。逐字节搬运（零逻辑
// 变更）；subAgent.ts 原位再导出 —— 导入面不变（消费方零改动）。
import { embed, cosine } from './semanticHash';
// W2-4 G4：争点主题提取复用项目正典分词器（纯函数，零新依赖）
import { tokenize } from './uiMemory';
// 报告契约经 type-only 回指主文件（编译期擦除 —— 运行时零回路）
import type { SubAgentReport } from './subAgent';

// ─── 裁决：策略模式（架构师指令：先接口，策略可热插拔） ───

export interface Arbitration {
  verdict: 'consensus' | 'conflict' | 'best_single' | 'adjudicated';
  /** 冲突裁决时的最佳候选 taskId */
  winner?: string;
  /** 两两交叉验证：findings 的语义余弦（复用 C-2 semanticHash，零新依赖） */
  crossValidation: Array<{ pair: [string, string]; agreement: number }>;
  /** 裁决理由（对模型透明的归因） */
  rationale: string;
  /**
   * W2-4 G4：verdict='adjudicated' 时的证据归因（其余 verdict 缺席）——
   * 验证代理是谁、使命是什么、每个候选的锚定匹配分、引用了哪些屏幕区域。
   */
  evidence?: EvidenceAttribution;
}

export interface ArbitrationStrategy {
  name: string;
  /** 只读报告集，产出裁决。禁止持有可变状态（策略可热插拔） */
  arbitrate(reports: SubAgentReport[]): Promise<Arbitration>;
}

/**
 * 缺省策略：置信度 × 同侪一致性加权。
 * consensus 阈值 0.5：语义余弦在同一事实域（共享关键实体词）时天然越过；
 * 分歧域（各自调研不同对象）天然落阈下 —— 无需任何魔法数字调参。
 */
export class ConfidenceWeightedArbitrator implements ArbitrationStrategy {
  readonly name = 'confidence-weighted';

  async arbitrate(reports: SubAgentReport[]): Promise<Arbitration> {
    if (reports.length === 0) {
      return { verdict: 'best_single', crossValidation: [], rationale: 'no reports submitted' };
    }
    if (reports.length === 1) {
      return {
        verdict: 'best_single', winner: reports[0].taskId, crossValidation: [],
        rationale: `single reporter (${reports[0].taskId}, confidence ${reports[0].confidence})`,
      };
    }
    // 两两交叉验证：findings 语义余弦（零依赖子词哈希，微秒级）
    const crossValidation: Arbitration['crossValidation'] = [];
    for (let i = 0; i < reports.length; i++) {
      for (let j = i + 1; j < reports.length; j++) {
        const agreement = Math.round(
          cosine(embed(reports[i].findings), embed(reports[j].findings)) * 1000) / 1000;
        crossValidation.push({ pair: [reports[i].taskId, reports[j].taskId], agreement });
      }
    }
    const minAgreement = Math.min(...crossValidation.map(c => c.agreement));
    if (minAgreement >= 0.5) {
      return {
        verdict: 'consensus', crossValidation,
        rationale: `all pairwise semantic agreements >= 0.5 (min ${minAgreement})`,
      };
    }
    // 冲突：综合分 = 置信 0.6 + 与他者的平均一致性 0.4 —— 高置信但众叛亲离者不胜出
    const scored = reports
      .map(r => {
        const pairs = crossValidation.filter(c => c.pair.includes(r.taskId));
        const meanPeer = pairs.length
          ? pairs.reduce((n, p) => n + p.agreement, 0) / pairs.length : 0.5;
        return { r, score: r.confidence * 0.6 + meanPeer * 0.4 };
      })
      .sort((a, b) => b.score - a.score);
    const best = scored[0];
    return {
      verdict: 'conflict', winner: best.r.taskId, crossValidation,
      rationale: `findings diverge (min agreement ${minAgreement}); winner by confidence×peer-agreement: ` +
        `${best.r.taskId} (score ${best.score.toFixed(2)})`,
    };
  }
}


// ─── W2-4 G4：实证仲裁 —— 硬证据压倒置信分 ───
//
// 冲突不再是「谁嗓门大（置信×同侪）」：自动铸造一个验证代理使命
// （「在当前屏找 X 的证据并引用区域」），其证据报告经注入的锚定端口
// 与各候选的可验证声明比对 —— 硬证据优先级压倒置信分。
// 端口缺席 ⇒ 回退 ConfidenceWeightedArbitrator 行为（诚实降级）。
// 无嵌套 LLM 基础设施 ⇒ 验证代理的「意识」仍由模型分饰：生产接线上
// runVerifier 负责铸造/驱动验证代理使命并解析其引用区域的报告；
// 离线测试注入确定性 fixture —— 协议本身与证据来源完全解耦。

/** W2-4 G4：验证代理引用的屏幕区域（visualDiff.DiffRegion 风格的归一化 bbox） */
export interface AnchoredRegion {
  /** 区域语义标签（锚定匹配的文本面，如 'pricing-table'） */
  label: string;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

/** W2-4 G4：候选报告中的可验证声明（锚定端口的比对单元） */
export interface VerifiableClaim {
  taskId: string;
  /** 声明全文（findings） */
  text: string;
  /** 声明自带的期望区域（可选 —— 几何锚定通路的输入） */
  bbox?: { x0: number; y0: number; x1: number; y1: number };
}

/** W2-4 G4：冲突时确定性铸造的验证代理使命书 */
export interface VerifierMission {
  /** 争点主题（从前二候选 findings 的共享词确定性提取） */
  subject: string;
  /** 自包含使命书（可直接作为验证代理的 objective） */
  objective: string;
  /** 参与比对的候选 taskId（按基础分降序） */
  candidates: string[];
}

/** W2-4 G4：验证代理提交的证据报告（引用区域 = 几何+语义锚） */
export interface VerifierEvidence {
  taskId: string;
  /** 声称找到证据的主题 */
  subject: string;
  /** 引用的屏幕区域（空 = 无证据 ⇒ 降级） */
  regions: AnchoredRegion[];
  /** 自报置信 0~1 */
  confidence: number;
}

/** W2-4 G4：证据归因（adjudicated 裁决的审计面） */
export interface EvidenceAttribution {
  /** 验证代理 taskId */
  verifier: string;
  /** 被执行的使命书（铸造即存证） */
  mission: string;
  /** 每候选的锚定匹配分（null = 证据不适用该候选） */
  perCandidate: Array<{ taskId: string; match: number | null }>;
  /** 引用的屏幕区域 */
  regions: AnchoredRegion[];
}

/**
 * W2-4 G4：证据锚定端口 —— 注入以便离线。
 * 缺席（或 runVerifier 缺席）⇒ 整体回退 ConfidenceWeightedArbitrator 行为；
 * matchClaim 缺席 ⇒ 用内置 semanticAnchorMatch（semanticHash 风格锚定）。
 */
export interface EvidenceAnchorPort {
  /** 给使命 → 回证据报告；null/undefined/抛异常 = 证据缺席（诚实降级） */
  runVerifier?(mission: VerifierMission): VerifierEvidence | null;
  /** 声明 × 证据 → 锚定匹配分 0~1；null = 证据不适用该候选 */
  matchClaim?(claim: VerifiableClaim, evidence: VerifierEvidence): number | null;
}

/** W2-4 G4：锚定匹配的最低采信分（与 consensus 阈值 0.5 同域） */
const EVIDENCE_MATCH_MIN = 0.5;

/** W2-4 G4：区域 bbox 的 IoU（elementTracker.iou 风格，归一化坐标域；纯函数） */
export function anchorIoU(
  a: { x0: number; y0: number; x1: number; y1: number },
  b: { x0: number; y0: number; x1: number; y1: number },
): number {
  const x0 = Math.max(a.x0, b.x0), y0 = Math.max(a.y0, b.y0);
  const x1 = Math.min(a.x1, b.x1), y1 = Math.min(a.y1, b.y1);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const areaA = Math.max(0, a.x1 - a.x0) * Math.max(0, a.y1 - a.y0);
  const areaB = Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
  const union = areaA + areaB - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * W2-4 G4：语义锚定匹配（缺省 matchClaim，semanticHash 风格 —— 零依赖离线）：
 * 声明文本与证据区域标签的余弦，取最强区域。无区域 ⇒ null（证据不适用）。
 */
export function semanticAnchorMatch(claim: VerifiableClaim, evidence: VerifierEvidence): number | null {
  if (!evidence || !Array.isArray(evidence.regions) || evidence.regions.length === 0) return null;
  const v = embed(claim.text);
  let best = 0;
  for (const r of evidence.regions) {
    const s = cosine(v, embed(typeof r?.label === 'string' ? r.label : ''));
    if (s > best) best = s;
  }
  return Math.round(best * 1000) / 1000;
}

/**
 * W2-4 G4：几何锚定匹配（visualDiff/elementTracker 风格）：声明自带期望 bbox 时
 * 与证据区域做 IoU 锚定（elementTracker 的贪心匹配同款判据），取最强区域；
 * 声明无几何锚 ⇒ null（诚实：证据不适用，不猜）。
 */
export function geometricAnchorMatch(claim: VerifiableClaim, evidence: VerifierEvidence): number | null {
  if (!claim.bbox || !evidence || !Array.isArray(evidence.regions) || evidence.regions.length === 0) return null;
  let best = 0;
  for (const r of evidence.regions) {
    if (!r?.bbox) continue;
    const s = anchorIoU(claim.bbox, r.bbox);
    if (s > best) best = s;
  }
  return Math.round(best * 1000) / 1000;
}

/** W2-4 G4：基础分复刻（ConfidenceWeightedArbitrator 的冲突公式 —— 置信 0.6 + 同侪 0.4） */
function baseScore(r: SubAgentReport, base: Arbitration): number {
  const pairs = base.crossValidation.filter(c => c.pair.includes(r.taskId));
  const meanPeer = pairs.length
    ? pairs.reduce((n, p) => n + p.agreement, 0) / pairs.length : 0.5;
  return r.confidence * 0.6 + meanPeer * 0.4;
}

/** W2-4 G4：共享词提取（纯函数，正典分词器；len≥2 过滤 CJK 单字噪声） */
function sharedTokens(a: string, b: string): string[] {
  const setB = new Set(tokenize(b));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokenize(a)) {
    if (t.length >= 2 && setB.has(t) && !seen.has(t)) { seen.add(t); out.push(t); }
  }
  return out;
}

/**
 * W2-4 G4：冲突使命铸造（纯函数、确定性）：争点主题 = 前二候选（按基础分）
 * findings 的共享词（≤6 个）；无共享词 ⇒ 分高者 findings 摘要。同输入恒同输出。
 */
export function mintVerifierMission(reports: SubAgentReport[], base: Arbitration): VerifierMission {
  const ranked = [...reports].sort((a, b) =>
    baseScore(b, base) - baseScore(a, base) || (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0));
  const top2 = ranked.slice(0, 2);
  const shared = sharedTokens(top2[0]?.findings ?? '', top2[1]?.findings ?? '');
  const subject = shared.length > 0
    ? shared.slice(0, 6).join(' ')
    : (top2[0]?.findings ?? '').slice(0, 60);
  return {
    subject,
    objective: `在当前屏寻找「${subject}」的证据并引用区域（每个区域给 label + 归一化 bbox），` +
      `以裁决候选分歧 [${ranked.map(r => r.taskId).join(' vs ')}]`,
    candidates: ranked.map(r => r.taskId),
  };
}

/**
 * W2-4 G4：实证仲裁策略（实现 ArbitrationStrategy，可热插拔）。
 * 行为阶梯（全部确定性、防御式绝不抛）：
 *   ① 端口缺席 / 基础裁决非 conflict ⇒ 逐字节返回 ConfidenceWeightedArbitrator 结果。
 *   ② 有端口无证据（runVerifier 缺席/返回空/抛异常）⇒ 判决与胜者保持缺省行为，
 *      归因注明诚实降级。
 *   ③ 有证据：各候选锚定匹配 ≥0.5 者进入硬证据域 —— 证据分压倒置信分定胜者
 *      （平分按基础分、再平按 taskId 字典序 —— 全序确定）；verdict='adjudicated'
 *      并附证据归因。无候选达阈 ⇒ 同 ② 降级。
 */
export class EvidenceBackedArbitrator implements ArbitrationStrategy {
  readonly name = 'evidence-backed';
  private readonly base = new ConfidenceWeightedArbitrator();
  private readonly port?: EvidenceAnchorPort;
  constructor(port?: EvidenceAnchorPort) {
    this.port = port; // 显式赋值：strip-only 模式不支持 constructor 参数属性
  }

  async arbitrate(reports: SubAgentReport[]): Promise<Arbitration> {
    const base = await this.base.arbitrate(reports);
    // 诚实降级 ①：端口缺席或非冲突 —— 与缺省策略逐字节同行为（零影响）
    if (!this.port || typeof this.port.runVerifier !== 'function' || base.verdict !== 'conflict') {
      return base;
    }
    const mission = mintVerifierMission(reports, base);
    let evidence: VerifierEvidence | null = null;
    try {
      const filed = this.port.runVerifier(mission);
      evidence = filed && typeof filed === 'object' ? filed : null;
    } catch {
      evidence = null; // 防御式绝不抛：端口炸了按证据缺席处理
    }
    const noEvidence = !evidence || !Array.isArray(evidence.regions) || evidence.regions.length === 0;
    if (noEvidence) {
      return { ...base, rationale: base.rationale +
        ' | evidence-backed: no verifier evidence filed — confidence-weighted fallback (honest degradation)' };
    }
    const matchFn = typeof this.port.matchClaim === 'function' ? this.port.matchClaim : semanticAnchorMatch;
    const perCandidate = reports.map(r => {
      let m: number | null = null;
      try {
        m = matchFn({ taskId: r.taskId, text: r.findings }, evidence!);
      } catch {
        m = null; // 单候选比对失败不拖垮整场裁决
      }
      return {
        taskId: r.taskId,
        match: m === null || !Number.isFinite(m) ? null : Math.max(0, Math.min(1, m)),
      };
    });
    const supported = perCandidate
      .filter(s => s.match !== null && s.match >= EVIDENCE_MATCH_MIN)
      .sort((a, b) =>
        (b.match! - a.match!) ||
        baseScore(reports.find(r => r.taskId === b.taskId)!, base) -
          baseScore(reports.find(r => r.taskId === a.taskId)!, base) ||
        (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0));
    if (supported.length === 0) {
      return { ...base, rationale: base.rationale +
        ` | evidence-backed: no candidate anchored to verifier evidence (all matches < ${EVIDENCE_MATCH_MIN}) — confidence-weighted fallback` };
    }
    const winner = supported[0];
    const ev = evidence!;
    return {
      verdict: 'adjudicated',
      winner: winner.taskId,
      crossValidation: base.crossValidation,
      rationale: `hard evidence overrides confidence: verifier "${ev.taskId}" cited ` +
        `${ev.regions.length} region(s) [${ev.regions.map(r => r?.label ?? '?').slice(0, 4).join(', ')}]; ` +
        `best anchored candidate ${winner.taskId} (match ${winner.match!.toFixed(2)}) beats ` +
        `confidence ranking winner ${base.winner ?? 'n/a'}`,
      evidence: {
        verifier: ev.taskId,
        mission: mission.objective,
        perCandidate,
        regions: ev.regions.map(r => ({
          label: typeof r?.label === 'string' ? r.label : '',
          bbox: { x0: r.bbox.x0, y0: r.bbox.y0, x1: r.bbox.x1, y1: r.bbox.y1 },
        })),
      },
    };
  }
}
