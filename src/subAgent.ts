// src/subAgent.ts
// D-1 多智能体协同：一台物理躯体，多重心智。
//
// 诚实的架构声明：本插件运行于 DSH 单会话工具环 —— 没有嵌套 LLM 调用的基础设施。
// 因此「子代理」的实现哲学是：
//   模型是唯一的意识线程，分饰多角；协调器持有剧本；基础设施保证角色间失忆。
// 「并行」发生在三处：目标并行（多使命书）、记忆并行（多工作记忆）、审计并行（多链段）。
// 物理 IO 由 system.serialize 串行 —— 「一台躯体，多重心智」的字面实现。
// 架构留白：未来若引入真正的嵌套推理，本模块接口无需任何变动（裁决策略可热插拔）。
import { embed, cosine } from './semanticHash';
import { journal, ACTION_TOOLS } from './journal';
import { contextManager } from './contextManager';
// W4-7（G5）：经验晶体收缩率只读消费 —— swarm.ts 是 W4-2 领地，本模块不写它，
// 仅 import 其导出的纯函数 shrinkRate（结构化端口/只读消费律）。场景收敛先验的
// 数学因此与晶体 counterfactual 单源同构，无本地漂移副本。
import { shrinkRate } from './swarm';
// W2-4 G4：争点主题提取复用项目正典分词器（纯函数，零新依赖）
import { tokenize } from './uiMemory';

/** 工作记忆硬顶：scratchpad 是纯文本，Token 消耗受结构性约束 */
const SCRATCHPAD_MAX = 512;
/** 每代理锚点引用上限：引用共享图片窗的 id（不复制图片），有界防漂移 */
const ANCHOR_MAX = 4;

// ─── 使命书：子代理的出生证明 ───

export interface SubAgentSpec {
  /** 短代号，如 'scout-1'（缺省自动生成 agent-N） */
  id: string;
  /** 角色名（模型视角的身份：「竞品A调研员」） */
  role: string;
  /** 自包含使命书：目标 + 边界 + 交付物要求（必须独立可理解，不依赖主对话上下文） */
  objective: string;
  /** 步数硬预算（动作类工具调用计数） */
  maxSteps: number;
}

// ─── 焦点快照：认知隔离的单位 ───

export interface FocusSnapshot {
  agentId: string;
  /** 代理私有工作记忆（有界纯文本 ≤512 字符，Token 受控） */
  scratchpad: string;
  /** 引用共享图片窗的锚点 id 列表（不复制图片；被驱逐后自然退化为引用） */
  anchorImageIds: number[];
  /** 出生场景指纹（意识连续性：与主任务同屏出生） */
  seedSceneHash?: string;
  /**
   * W2-4 G1：黑板摘要注入位。chargeStep 时由协调器写入当前代理的焦点视图
   * （≤256 字符的有界摘要）；黑板为空时键缺席 —— 空代理集/未用黑板时零影响。
   * 旧 checkpoint 档无此字段（restore 结构过滤天然兼容）。
   */
  boardDigest?: string;
}

// ─── 生命周期与报告 ───

export type AgentStatus = 'pending' | 'working' | 'reported' | 'aborted';

export interface SubAgentState {
  spec: SubAgentSpec;
  status: AgentStatus;
  stepsUsed: number;
  focus: FocusSnapshot;
  report?: SubAgentReport;
}

export interface SubAgentReport {
  taskId: string;
  status: 'completed' | 'failed' | 'timeout';
  /** 调研结论（纯文本，模型撰写） */
  findings: string;
  /** 自报置信度 0~1，裁决加权的输入 */
  confidence: number;
  stepsUsed: number;
}

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

// ─── W2-4 G1：租约黑板 —— 协调器持有的有界共享工作区 ───
//
// 设计律：
//   * 步数 TTL 而非时钟 —— 租约寿命以「动作步」计量（chargeStep 滴答），
//     协议全程确定性、离线可测，免时钟依赖（重放/测试同判据）。
//   * 有界 FIFO：≤8 条，超容逐出最旧（touch 到尾：续租/重铸刷新 FIFO 位）。
//   * 撞租约即让位：他人未过期 claim 且主题语义重叠（余弦 ≥0.5，与仲裁
//     consensus 阈值同域）⇒ 申请者让位换目标（结果带回持有者供改道）。
//   * 代理退场（report/abort）即释放其 claim —— 已退场者不占坑（与 TTL 双保险）。
//   * 入日志通道：journal.ts 的 JournalMarker 是封闭联合且非本模块领地，
//     无兼容的通用 marker 面 ⇒ 黑板仅驻内存（reset/restore 清零），见协作报告。

/** W2-4 G1：黑板容量硬顶（FIFO 逐出） */
const BLACKBOARD_MAX = 8;
/** W2-4 G1：claim 缺省租约（步） */
const DEFAULT_CLAIM_TTL = 5;
/** W2-4 G1：finding 缺省存活（步；共享知识比锁活得久） */
const DEFAULT_FINDING_TTL = 10;
/** W2-4 G1：租约 TTL 域执法上下限（步） */
const TTL_FLOOR = 1, TTL_CEIL = 50;
/** W2-4 G1：主题撞租约判据 —— 语义余弦阈值（与 consensus 阈值 0.5 同域） */
const LEASE_SUBJECT_SIM = 0.5;
/** W2-4 G1：黑板摘要注入预算（字符） */
const BOARD_BRIEF_MAX = 256;
/** W2-4 G1：主题/发现载荷预算（字符） */
const SUBJECT_MAX = 120, FINDING_BODY_MAX = 160;

export interface BlackboardEntry {
  /** 铸造序号（单调；审计面） */
  seq: number;
  kind: 'claim' | 'finding';
  /** 持有/张贴者代理 id */
  claimant: string;
  /** 目标主题（claim 的排他对象） */
  subject: string;
  /** finding 的载荷文本（claim 缺席） */
  body?: string;
  /** 剩余租约步数（每动作步滴答递减；≤0 即过期淘汰） */
  ttl: number;
}

export type ClaimResult =
  | { ok: true }
  | { ok: false; reason: 'inactive-agent' | 'empty-subject' }
  | { ok: false; reason: 'lease-conflict'; holder: string; holderSubject: string; holderTtl: number };

/** W2-4 G1：主题撞租约判据（纯函数）：全等或语义余弦 ≥0.5 */
function subjectsCollide(a: string, b: string): boolean {
  if (a === b) return true;
  return cosine(embed(a), embed(b)) >= LEASE_SUBJECT_SIM;
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

// ─── W4-7（G5）：步数拍卖市场 —— 全局步数池 + 每 K 步重拍卖 ───
//
// 哲学：maxSteps 出生即定是「计划经济」；拍卖市场让步数预算随边际进展流动 ——
// 收敛快的场景多买步，收敛慢的场景省步数。三条铁律：
//   * 确定性：分配走纯整数最大余数法（bids×1000 成整数），无 RNG、无时钟、
//     无 Map 迭代序依赖 —— 同输入恒同输出（可重放、可审计、离线可测）。
//   * 饿死防护：每代理每轮至少 1 步保底（除非已退场）；连续 M 轮低进展者
//     降级为「提交部分发现优雅退场」（现有 report 通道 + retire 释放容量）。
//   * 防御式绝不抛：端口炸了按零证据处理，拍卖炸了保留既有配额下轮重试。
// 兼容律：拍卖默认关闭 —— 关闭时 chargeStep/spawn/report 走原路径逐字节一致
// （现有 subAgent 测试零回归）；开启时 maxSteps 语义变为「共享池上限」并在
// 拍卖账本（报告环）genesis 条目中显式说明。

/** W4-7（G5）：重拍卖周期（每 K 个扣费动作步触发一次拍卖） */
export const AUCTION_EPOCH_K = 10;
/** W4-7（G5）：连续低进展降级阈值（连续 M 轮收缩先验 < 舰队基率 ⇒ 优雅退场） */
export const AUCTION_DEMOTE_ROUNDS = 3;
/** W4-7（G5）：拍卖账本（报告环）容量 —— 有界防漂移 */
export const AUCTION_LEDGER_MAX = 32;
/** W4-7（G5）：零证据时的舰队基率缺省（与晶体 counterfactual 的 0.5 同律） */
export const AUCTION_DEFAULT_GLOBAL_RATE = 0.5;

/** W4-7（G5）：代理场景收敛证据（成功/尝试计数 —— 晶体 successes/attempts 的同构面） */
export interface ConvergenceEvidence {
  successes: number;
  attempts: number;
}

/**
 * W4-7（G5）：场景收敛证据端口 —— 注入以便离线。
 * 生产接线：从经验晶体按代理出生场景指纹聚合 (successes, attempts)；
 * 端口缺席 / evidence 缺席 / 抛异常 ⇒ 零证据 —— 先验回退全局基率（诚实降级，
 * 全员均匀分配，绝不猜）。协议本身与证据来源完全解耦（测试注入确定性 fixture）。
 */
export interface StepAuctionPort {
  /** 每代理场景收敛证据；null/undefined/抛异常 = 零证据 */
  evidence?(agentId: string): ConvergenceEvidence | null;
}

/** W4-7（G5）：拍卖开启选项（缺省 = 名册 Σ maxSteps 的推导池 + 零证据端口） */
export interface StepAuctionOptions {
  /** 全局池总预算（正有限数；缺省 = 各代理 maxSteps 之和 —— 总预算与现状等价） */
  budget?: number;
  /** 场景收敛证据端口（缺省零证据 ⇒ 均匀分配） */
  port?: StepAuctionPort;
}

/** W4-7（G5）：单代理拍卖账目（出价 + 分得配额） */
export interface AuctionBid {
  agentId: string;
  /** 场景收敛先验（shrinkRate 收缩成功率；零证据 = 舰队基率） */
  prior: number;
  /** 自报未完成度 0~1（缺省 1 = 全然未完成） */
  incompleteness: number;
  /** 边际进展分 = 先验 × 未完成度（竞标出价） */
  bid: number;
  /** 本轮分得配额（步） */
  quota: number;
  /** 连续低进展轮数（审计面；未连败缺席或 0） */
  streak?: number;
  /** 本轮被降级退场（连续 M 轮低进展 ⇒ 部分发现优雅退出） */
  demoted?: boolean;
}

/** W4-7（G5）：一次拍卖的账面（报告环的单元 —— 账面透明律） */
export interface AuctionRound {
  /** 拍卖轮次（0 = genesis 开启记账；≥1 = 实际拍卖） */
  round: number;
  /** 拍卖时全局已扣费动作步数 */
  atStep: number;
  /** 各代理账目（名册序；降级者 quota=0 且 demoted=true） */
  agents: AuctionBid[];
  /** 拍卖后池余（步） */
  poolRemaining: number;
  /** 本轮分配总额（≤ K，≤ 池余） */
  quotaTotal: number;
  note?: string;
}

/** W4-7（G5）：拍卖市场状态视图（工具面/自省消费） */
export interface AuctionStatus {
  enabled: boolean;
  /** 外注总预算（null = 名册 endowment 推导） */
  budget: number | null;
  poolRemaining: number;
  poolCharged: number;
  k: number;
  demoteRounds: number;
  /** 当前轮内已走步数（0..K） */
  epochStep: number;
  activeAgents: number;
  /** maxSteps 语义说明（开启 = 池上限；关闭 = 各代理独立预算） */
  note: string;
}

/** W4-7（G5）：三位小数舍入（先验/出价的账面精度 —— 与 shrinkRate 同律） */
const r3 = (x: number): number => Math.round(x * 1000) / 1000;

/**
 * W4-7（G5）：边际进展分（纯函数，确定性）。
 * bid = 场景收敛先验 × 自报未完成度：
 *   * 先验 = shrinkRate(successes, attempts, globalRate) —— 晶体数学只读消费
 *     （经验贝叶斯收缩：稀疏证据向舰队基率回撤，「2 次尝试 100% 成功」不是 1.0）；
 *   * 零证据（attempts ≤ 0 / 缺席）⇒ 先验 = 舰队基率（无辜推定，均匀入场）；
 *   * 未完成度钳制 [0,1]，非法值按 1（全然未完成）处理；基率非法回退 0.5。
 * 语义：先验高（场景在收敛）× 未完成度高（多做一步的边际价值大）⇒ 值得多买步。
 */
export function marginalProgressScore(
  evidence: ConvergenceEvidence | null | undefined,
  incompleteness: number,
  globalRate: number,
): number {
  const inc = typeof incompleteness === 'number' && Number.isFinite(incompleteness)
    ? Math.max(0, Math.min(1, incompleteness)) : 1;
  const g = typeof globalRate === 'number' && Number.isFinite(globalRate)
    ? Math.max(0, Math.min(1, globalRate)) : AUCTION_DEFAULT_GLOBAL_RATE;
  const attempts = evidence && Number.isFinite(evidence.attempts) ? Math.floor(evidence.attempts) : 0;
  if (attempts <= 0) return r3(g * inc); // 零证据 ⇒ 先验回退基率（诚实降级）
  const successes = Math.max(0, Math.min(attempts,
    evidence && Number.isFinite(evidence.successes) ? Math.floor(evidence.successes) : 0));
  return r3(shrinkRate(successes, attempts, g) * inc);
}

/**
 * W4-7（G5）：配额分配（纯函数，确定性整数算法 —— 拍卖的心脏）。
 * 输入出价数组（下标即代理序）与总额 T，输出各代理配额：
 *   ① 饿死防护：T ≥ n 时每代理保底 1 步；T < n 时按代理序保底前 T 个（诚实降级）；
 *   ② 剩余按出价比例分配：份额 = bid_i·rem/Σbid。整数律：bids×1000 成整数后
 *     分子/分母全整数 —— floor 与小数部分（同分母的余数）可精确比较，零 FP 噪声；
 *   ③ 最大余数法派发零头：小数部分大者先得，平手按代理序（下标升序）；
 *   ④ 全零出价 ⇒ 均分（floor + 零头按代理序）—— 零证据市场的缺省公平。
 */
export function allocateQuotas(bids: number[], total: number): number[] {
  const n = bids.length;
  if (n === 0) return [];
  const T = typeof total === 'number' && Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0;
  const out = new Array<number>(n).fill(0);
  if (T === 0) return out;
  if (T < n) {
    for (let i = 0; i < T; i++) out[i] = 1; // 池不足以全员保底：按代理序保底前 T 个
    return out;
  }
  for (let i = 0; i < n; i++) out[i] = 1; // 饿死防护：每代理每轮至少 1 步
  const rem = T - n;
  if (rem === 0) return out;
  const mBids = bids.map(b => Math.max(0, Math.round((typeof b === 'number' && Number.isFinite(b) ? b : 0) * 1000)));
  const B = mBids.reduce((s, m) => s + m, 0);
  if (B <= 0) {
    // 全零出价 ⇒ 均分（floor + 零头按代理序 —— 平手按代理序的缺省体现）
    const base = Math.floor(rem / n), extra = rem % n;
    for (let i = 0; i < n; i++) out[i] += base + (i < extra ? 1 : 0);
    return out;
  }
  const floors: number[] = [];
  const fracNums: number[] = []; // 小数部分 × B（整数表示 —— 同分母可精确比较）
  let allocated = 0;
  for (let i = 0; i < n; i++) {
    const num = mBids[i] * rem; // 份额分子（整数）：份额 = num / B
    floors.push(Math.floor(num / B));
    fracNums.push(num % B);
    allocated += floors[i];
  }
  for (let i = 0; i < n; i++) out[i] += floors[i];
  let leftover = rem - allocated;
  const order = fracNums
    .map((f, i) => ({ f, i }))
    .sort((a, b) => b.f - a.f || a.i - b.i); // 小数大者先得；平手按代理序
  for (let k = 0; k < order.length && leftover > 0; k++, leftover--) out[order[k].i] += 1;
  return out;
}

// ─── 协调器：唯一有状态的单例 ───

export interface SubAgentCoordinator {
  spawn(specs: SubAgentSpec[]): SubAgentState[];
  /** 当前轮到的代理（意识线程的驻留角色） */
  current(): SubAgentState | null;
  /** 动作步数记账（guards 挂点调用；超预算返回 true 强制提醒模型收尾） */
  chargeStep(tool: string): boolean;
  /** 代理提交报告，自动轮转到下一个未完成代理 */
  report(taskId: string, findings: string, confidence: number, status?: SubAgentReport['status']): SubAgentState | null;
  /** 全部报告后裁决；注入自定义策略（缺省 ConfidenceWeightedArbitrator） */
  arbitrate(strategy?: ArbitrationStrategy): Promise<Arbitration | null>;
  abort(taskId: string, reason: string): void;
  // ── W2-4 G1：租约黑板 ──
  /** 认领目标（「正在处理 X」）：步数 TTL 租约；撞他人未过期租约即让位换目标 */
  claim(agentId: string, subject: string, ttlSteps?: number): ClaimResult;
  /** 张贴发现（共享知识）：步数 TTL，黑板 FIFO 逐出 */
  post(agentId: string, subject: string, finding: string, ttlSteps?: number): boolean;
  /** 黑板只读视图（过期条目不可见；chargeStep 时摘要注入当前代理 boardDigest） */
  blackboard(): BlackboardEntry[];
  /**
   * W3-4（G2 读写分离流水线）：seed 预注 —— 协调器把「动作后的新屏」指纹只读
   * 观察后预注册为 pending 代理的出生锚点（focus.seedSceneHash 就地刷新）。
   * 观察步只读共享世界；预注是纯簿记（不触碰物理 IO）。防御式绝不抛：
   * 代理缺席/已退场/指纹空串 ⇒ false（诚实拒绝，不猜）。
   */
  preseed(agentId: string, sceneHash: string | null): boolean;
  /**
   * W3-4（G2）：退场回收 —— reported/aborted 代理移出名册（释放 spawn 容量；
   * 在役 pending/working 代理不可回收）。波次执行完一茬就绪层后由协调器调用，
   * 防止已退场代理长期占坑堵死后续波次（spawn 容量按名册全长执法）。
   * 返回实际回收数；绝不抛。
   */
  retire(...agentIds: string[]): number;
  // ── W4-7（G5）：步数拍卖市场（默认关闭；关闭时行为与现状逐字节一致） ──
  /** 开启步数拍卖（幂等）：预算缺省 = 各代理 maxSteps 之和；证据端口注入可选 */
  enableStepAuction(opts?: StepAuctionOptions): boolean;
  /** 关闭并清账（回到与现状逐字节一致的缺省行为） */
  disableStepAuction(): void;
  /** 代理自报未完成度 0~1（竞标乘性因子）；市场未开/代理不在场/非法值 ⇒ false */
  declareIncompleteness(agentId: string, remaining: number): boolean;
  /** 拍卖账本只读视图（报告环：每轮出价/配额/池余；容量 AUCTION_LEDGER_MAX 轮） */
  auctionLedger(): AuctionRound[];
  /** 市场状态视图（池余/已扣费/K/M/maxSteps 语义说明） */
  auctionStatus(): AuctionStatus;
  /** 视图：全体状态（工具面与 checkpoint 消费） */
  roster(): SubAgentState[];
  isActive(): boolean;
  configure(maxAgents: number, roundSteps: number): void;
  dump(): SubAgentState[];
  restore(states: SubAgentState[] | undefined): void;
  reset(): void;
}

class Coordinator implements SubAgentCoordinator {
  private agents: SubAgentState[] = [];
  private cursor = 0;
  private maxAgents = 3;
  private roundSteps = 10; // 轮步数预算提醒线（状态视图消费，非硬闸）
  private idSeq = 0;
  // ── W2-4 G1：租约黑板（有界 FIFO；步数钟驱动 TTL —— 无时钟依赖） ──
  private board: BlackboardEntry[] = [];
  private boardSeq = 0;
  private stepClock = 0;
  // ── W4-7（G5）：步数拍卖市场（默认关闭 —— 所有新路径均以 auctionOn 门控，零回归） ──
  private auctionOn = false;
  private auctionPort: StepAuctionPort | null = null;
  /** 外注总预算（null = 名册 endowment 推导：池 = Σ 当前名册 maxSteps） */
  private poolBudgetInjected: number | null = null;
  private poolRemaining = 0;
  private poolCharged = 0;
  /** 轮内步数（0..K；到 K 触发重拍卖） */
  private epochStep = 0;
  /** 拍卖轮次（0 = genesis；每拍卖 +1） */
  private auctionSeq = 0;
  /** 池耗尽收场已记账（防账本刷屏；重新开启时复位） */
  private poolExhaustedFired = false;
  /** 代理 → 本轮配额（步）。出生/入市时 = 自身 maxSteps（首轮拍卖前与现状等价） */
  private epochQuota = new Map<string, number>();
  /** 代理 → 本轮已用步数（每轮拍卖归零） */
  private epochUsed = new Map<string, number>();
  /** 代理 → 自报未完成度 0~1（缺省 1 = 全然未完成） */
  private incompleteness = new Map<string, number>();
  /** 代理 → 连续低进展轮数（证据在案且收缩先验 < 舰队基率才累计） */
  private lowStreak = new Map<string, number>();
  /** 拍卖账本（报告环；有界 AUCTION_LEDGER_MAX） */
  private ledger: AuctionRound[] = [];

  configure(maxAgents: number, roundSteps: number): void {
    this.maxAgents = Math.max(1, maxAgents);
    this.roundSteps = Math.max(1, roundSteps);
  }

  /** W2-4 G1：TTL 域执法（maxSteps 同律：Math.max(1, NaN) === NaN 会让比较恒 false） */
  private sanitizeTtl(raw: number | undefined, fallback: number): number {
    const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : fallback;
    return Math.min(TTL_CEIL, Math.max(TTL_FLOOR, n));
  }

  /** W2-4 G1：步数钟滴答 —— 租约老化 + 过期淘汰（确定性：只随动作步前进） */
  private tickLeases(): void {
    this.stepClock++;
    this.board = this.board.filter(e => --e.ttl > 0);
  }

  /** W2-4 G1：黑板摘要（注入当前代理状态视图的有界文本） */
  private boardBrief(): string {
    return this.board.map(e => e.kind === 'claim'
      ? `[claim] ${e.claimant} working on "${e.subject}" (ttl ${e.ttl})`
      : `[finding] ${e.claimant}: ${e.subject} => ${e.body ?? ''}`,
    ).join(' | ').slice(0, BOARD_BRIEF_MAX);
  }

  /** W2-4 G1：入板。让位规则：claim 一代理一份（认领新目标即换租）；
   *  finding 按代理×主题去重（同主题重贴 touch 到尾，异主题积累） */
  private pushBoard(entry: Omit<BlackboardEntry, 'seq'>): void {
    this.board = this.board.filter(e =>
      !(e.claimant === entry.claimant && e.kind === entry.kind &&
        (entry.kind === 'claim' || e.subject === entry.subject)));
    this.board.push({ ...entry, seq: ++this.boardSeq });
    while (this.board.length > BLACKBOARD_MAX) this.board.shift(); // FIFO 逐出最旧
  }

  claim(agentId: string, subject: string, ttlSteps?: number): ClaimResult {
    const agent = this.agents.find(a => a.spec.id === agentId);
    if (!agent || agent.status === 'reported' || agent.status === 'aborted') {
      return { ok: false, reason: 'inactive-agent' };
    }
    const subj = (typeof subject === 'string' ? subject : '').trim().slice(0, SUBJECT_MAX);
    if (!subj) return { ok: false, reason: 'empty-subject' };
    // 撞租约即让位：他人未过期 claim 且主题语义重叠 ⇒ 带持有者信息改道
    for (const e of this.board) {
      if (e.kind === 'claim' && e.claimant !== agentId && subjectsCollide(e.subject, subj)) {
        return { ok: false, reason: 'lease-conflict', holder: e.claimant, holderSubject: e.subject, holderTtl: e.ttl };
      }
    }
    // 同代理认领新目标：旧 claim 让位（一代理同时只持一份租约）
    this.pushBoard({
      kind: 'claim', claimant: agentId, subject: subj, ttl: this.sanitizeTtl(ttlSteps, DEFAULT_CLAIM_TTL),
    });
    return { ok: true };
  }

  post(agentId: string, subject: string, finding: string, ttlSteps?: number): boolean {
    const agent = this.agents.find(a => a.spec.id === agentId);
    if (!agent) return false;
    const subj = (typeof subject === 'string' ? subject : '').trim().slice(0, SUBJECT_MAX);
    const body = (typeof finding === 'string' ? finding : '').trim().slice(0, FINDING_BODY_MAX);
    if (!subj || !body) return false;
    this.pushBoard({
      kind: 'finding', claimant: agentId, subject: subj, body,
      ttl: this.sanitizeTtl(ttlSteps, DEFAULT_FINDING_TTL),
    });
    return true;
  }

  blackboard(): BlackboardEntry[] {
    return this.board.map(e => ({ ...e }));
  }

  // ── W3-4（G2 读写分离流水线）：seed 预注 + 退场回收（增量 —— 防御式绝不抛） ──

  preseed(agentId: string, sceneHash: string | null): boolean {
    try {
      if (typeof sceneHash !== 'string' || sceneHash.trim() === '') return false; // 空指纹不预注（不猜）
      const a = this.agents.find(x => x.spec.id === agentId);
      if (!a || a.status === 'reported' || a.status === 'aborted') return false; // 退场者无出生锚可刷新
      a.focus.seedSceneHash = sceneHash.slice(0, 128); // 有界（指纹面预算，防漂移）
      return true;
    } catch {
      return false; // 防御式兜底（正常流不可达）
    }
  }

  retire(...agentIds: string[]): number {
    try {
      let removed = 0;
      for (const id of Array.isArray(agentIds) ? agentIds : []) {
        if (typeof id !== 'string' || id === '') continue;
        const i = this.agents.findIndex(a => a.spec.id === id);
        if (i < 0) continue;
        const a = this.agents[i]!;
        if (a.status !== 'reported' && a.status !== 'aborted') continue; // 在役代理不可回收
        this.agents.splice(i, 1);
        removed++;
        // W4-7（G5）：回收即出市 —— 拍卖簿记随名额一起释放
        if (this.auctionOn) this.releaseAuctionMaps(id);
      }
      // 轮转游标夹回界内（数组收缩后索引漂移防御；空名册归零）
      if (this.agents.length === 0) this.cursor = 0;
      else if (this.cursor >= this.agents.length) this.cursor = this.cursor % this.agents.length;
      return removed;
    } catch {
      return 0; // 防御式兜底
    }
  }

  // ── W4-7（G5）：步数拍卖市场 ──

  enableStepAuction(opts?: StepAuctionOptions): boolean {
    try {
      if (this.auctionOn) return true; // 幂等：已开启不改账（防误清池）
      const budget = opts?.budget;
      const port = opts?.port;
      const injected = typeof budget === 'number' && Number.isFinite(budget) && budget > 0
        ? Math.floor(budget) : null;
      this.auctionOn = true;
      this.auctionPort = port && typeof port.evidence === 'function' ? port : null;
      this.poolBudgetInjected = injected;
      this.poolCharged = 0;
      this.epochStep = 0;
      this.auctionSeq = 0;
      this.poolExhaustedFired = false;
      // 出生配额 = 各自 endowment（首轮拍卖前与现状逐轮等价：各花各的 maxSteps）
      this.epochQuota = new Map(this.agents.map(a => [a.spec.id, a.spec.maxSteps]));
      this.epochUsed = new Map(this.agents.map(a => [a.spec.id, 0]));
      this.incompleteness = new Map();
      this.lowStreak = new Map();
      this.ledger = [];
      // 缺省池 = Σ maxSteps（总预算与现状等价；外注预算则完全由外部决定）
      this.poolRemaining = injected
        ?? this.agents.reduce((s, a) => s + a.spec.maxSteps, 0);
      // genesis 记账：maxSteps 语义变更说明（兼容律第 5 条的「在报告说明」）
      const actives = this.agents.filter(a => a.status === 'pending' || a.status === 'working');
      this.pushLedger({
        round: 0, atStep: 0,
        agents: actives.map(a => ({
          agentId: a.spec.id, prior: 0, incompleteness: 1, bid: 0, quota: a.spec.maxSteps,
        })),
        poolRemaining: this.poolRemaining, quotaTotal: 0,
        note: `W4-7 step auction enabled (K=${AUCTION_EPOCH_K}, floor 1 step/agent/round, ` +
          `demote after ${AUCTION_DEMOTE_ROUNDS} low-progress rounds): per-agent maxSteps now acts ` +
          `as the shared step-pool cap (budget ${injected ?? 'derived = sum(maxSteps)'})`,
      });
      return true;
    } catch {
      this.auctionOn = false; // 防御式绝不抛：开启失败回退关闭态
      return false;
    }
  }

  disableStepAuction(): void {
    // 回到缺省关闭：chargeStep/spawn/report 走原路径（与现状逐字节一致）
    this.auctionOn = false;
    this.auctionPort = null;
    this.poolBudgetInjected = null;
    this.poolRemaining = 0;
    this.poolCharged = 0;
    this.epochStep = 0;
    this.auctionSeq = 0;
    this.poolExhaustedFired = false;
    this.epochQuota = new Map();
    this.epochUsed = new Map();
    this.incompleteness = new Map();
    this.lowStreak = new Map();
    this.ledger = [];
  }

  declareIncompleteness(agentId: string, remaining: number): boolean {
    try {
      if (!this.auctionOn) return false; // 市场未开：不收自报（缺省行为零影响）
      const a = this.agents.find(x => x.spec.id === agentId);
      if (!a || a.status === 'reported' || a.status === 'aborted') return false;
      if (typeof remaining !== 'number' || !Number.isFinite(remaining)) return false;
      this.incompleteness.set(agentId, Math.max(0, Math.min(1, remaining)));
      return true;
    } catch {
      return false; // 防御式兜底
    }
  }

  auctionLedger(): AuctionRound[] {
    // 深拷贝视图：外部不可经视图 mutate 账本
    return this.ledger.map(r => ({ ...r, agents: r.agents.map(b => ({ ...b })) }));
  }

  auctionStatus(): AuctionStatus {
    return {
      enabled: this.auctionOn,
      budget: this.poolBudgetInjected,
      poolRemaining: this.poolRemaining,
      poolCharged: this.poolCharged,
      k: AUCTION_EPOCH_K,
      demoteRounds: AUCTION_DEMOTE_ROUNDS,
      epochStep: this.epochStep,
      activeAgents: this.agents.filter(a => a.status === 'pending' || a.status === 'working').length,
      note: this.auctionOn
        ? `per-agent maxSteps acts as the shared step-pool cap (re-auction every ${AUCTION_EPOCH_K} charged steps)`
        : 'step auction disabled — per-agent maxSteps budgets (default)',
    };
  }

  /** W4-7（G5）：拍卖簿记回收（退场即出市：配额/自报/连败记录随名额释放） */
  private releaseAuctionMaps(agentId: string): void {
    this.epochQuota.delete(agentId);
    this.epochUsed.delete(agentId);
    this.incompleteness.delete(agentId);
    this.lowStreak.delete(agentId);
  }

  /** W4-7（G5）：证据收集（只读端口；缺席/抛异常/结构非法 ⇒ 零证据 —— 绝不抛） */
  private fetchEvidence(agentId: string): ConvergenceEvidence | null {
    if (!this.auctionPort || typeof this.auctionPort.evidence !== 'function') return null;
    try {
      const e = this.auctionPort.evidence(agentId);
      return e && typeof e === 'object' ? e : null;
    } catch {
      return null;
    }
  }

  /** W4-7（G5）：账本入环（有界 FIFO —— 与黑板同律的容量执法） */
  private pushLedger(round: AuctionRound): void {
    this.ledger.push(round);
    while (this.ledger.length > AUCTION_LEDGER_MAX) this.ledger.shift();
  }

  /**
   * W4-7（G5）：池耗尽收场 —— 全体在役代理按现有 abort 语义收场
   * （abort 释放黑板租约 + 生成 failed 报告 + AGENT_END 入链）。
   */
  private exhaustPool(): void {
    try {
      this.poolRemaining = 0;
      const actives = this.agents.filter(a => a.status === 'pending' || a.status === 'working');
      for (const a of actives) {
        this.abort(a.spec.id, `W4-7 step pool exhausted after ${this.poolCharged} charged step(s)`);
      }
      if (this.poolExhaustedFired) return; // 已收过场：不刷账本（后续 spawn 再耗尽会再 abort）
      this.poolExhaustedFired = true;
      this.auctionSeq++;
      this.pushLedger({
        round: this.auctionSeq, atStep: this.poolCharged,
        agents: actives.map(a => ({
          agentId: a.spec.id, prior: 0, incompleteness: 0, bid: 0, quota: 0,
        })),
        poolRemaining: 0, quotaTotal: 0,
        note: `step pool exhausted — ${actives.length} active agent(s) closed out via existing abort semantics`,
      });
    } catch {
      // 防御式绝不抛：收场失败不影响主流程（下一扣费步会重试）
    }
  }

  /**
   * W4-7（G5）：连续低进展降级 —— 经现有 report 通道提交部分发现优雅退场
   * （status 'timeout' 低置信 —— 未完成的诚实读数），retire 释放 spawn 容量；
   * 租约已由 report 释放（W2-4 协同：退场者不占坑）。findings 取自代理工作记忆
   * （scratchpad/boardDigest），未留痕则如实声明。
   */
  private demoteLowProgress(a: SubAgentState, streak: number, prior: number, globalRate: number): void {
    const partial = (a.focus.scratchpad || a.focus.boardDigest || '').slice(0, SCRATCHPAD_MAX);
    this.report(
      a.spec.id,
      `W4-7 step-auction partial exit: ${streak} consecutive low-progress rounds ` +
      `(shrunk prior ${prior.toFixed(3)} < fleet baseline ${globalRate.toFixed(3)}). ` +
      `Partial findings: ${partial || '(none recorded)'}`,
      0.1, 'timeout',
    );
    this.retire(a.spec.id); // 释放 spawn 容量（容量按名册全长执法）
  }

  /**
   * W4-7（G5）：拍卖执行（每 K 个扣费动作步触发）。全程确定性：
   * 证据只读收集 → 舰队基率（合并证据，零证据 0.5）→ 收缩先验 + 低进展 streak
   * → 降级（连续 M 轮低进展者优雅退场）→ 幸存者按边际进展分竞标 →
   * 整数最大余数法分配（保底 1 步）→ 入账本（报告环）。防御式绝不抛。
   */
  private runAuction(): void {
    try {
      this.epochStep = 0;
      this.auctionSeq++;
      const actives = this.agents.filter(a => a.status === 'pending' || a.status === 'working');
      if (actives.length === 0) {
        this.pushLedger({
          round: this.auctionSeq, atStep: this.poolCharged, agents: [],
          poolRemaining: this.poolRemaining, quotaTotal: 0, note: 'no active agents — auction skipped',
        });
        return;
      }
      // 证据收集 + 舰队基率（合并 successes/attempts；零证据 ⇒ 0.5 —— 晶体同律）
      const evid = new Map<string, ConvergenceEvidence | null>();
      let sumS = 0, sumA = 0;
      for (const a of actives) {
        const e = this.fetchEvidence(a.spec.id);
        evid.set(a.spec.id, e);
        const att = e && Number.isFinite(e.attempts) ? Math.floor(e.attempts) : 0;
        if (att > 0) {
          sumA += att;
          sumS += Math.max(0, Math.min(att, Number.isFinite(e!.successes) ? Math.floor(e!.successes) : 0));
        }
      }
      const globalRate = sumA > 0 ? r3(sumS / sumA) : AUCTION_DEFAULT_GLOBAL_RATE;
      // 收缩先验 + 低进展 streak（证据在案且先验 < 基率才计低 —— 无辜推定）
      const priors = new Map<string, number>();
      const isLow = new Map<string, boolean>();
      for (const a of actives) {
        const e = evid.get(a.spec.id) ?? null;
        const att = e && Number.isFinite(e.attempts) ? Math.floor(e.attempts) : 0;
        const suc = e && Number.isFinite(e.successes)
          ? Math.max(0, Math.min(att, Math.floor(e.successes))) : 0;
        const prior = att > 0 ? shrinkRate(suc, att, globalRate) : globalRate;
        priors.set(a.spec.id, prior);
        const low = att > 0 && prior < globalRate;
        isLow.set(a.spec.id, low);
        this.lowStreak.set(a.spec.id, low ? (this.lowStreak.get(a.spec.id) ?? 0) + 1 : 0);
      }
      // 降级判定（先降级后分配：退场者不占下一配额 —— 退场释放的步数留池由幸存者竞得）
      const demoteSet = new Set<string>();
      for (const a of actives) {
        const streak = this.lowStreak.get(a.spec.id) ?? 0;
        if (isLow.get(a.spec.id) && streak >= AUCTION_DEMOTE_ROUNDS) demoteSet.add(a.spec.id);
      }
      const entryById = new Map<string, AuctionBid>();
      const survivors: SubAgentState[] = [];
      for (const a of actives) {
        const prior = priors.get(a.spec.id) ?? globalRate;
        const inc = this.incompleteness.get(a.spec.id) ?? 1;
        if (demoteSet.has(a.spec.id)) {
          const streak = this.lowStreak.get(a.spec.id) ?? AUCTION_DEMOTE_ROUNDS;
          this.demoteLowProgress(a, streak, prior, globalRate); // report + retire（租约随之释放）
          entryById.set(a.spec.id, {
            agentId: a.spec.id, prior, incompleteness: inc, bid: r3(prior * inc),
            quota: 0, demoted: true, streak,
          });
          continue;
        }
        survivors.push(a);
      }
      // 幸存者竞标下一配额：bid = 收缩先验 × 自报未完成度（缺省 1）
      const bids = survivors.map(a =>
        marginalProgressScore(evid.get(a.spec.id) ?? null, this.incompleteness.get(a.spec.id) ?? 1, globalRate));
      const quotaTotal = Math.min(AUCTION_EPOCH_K, Math.max(0, this.poolRemaining));
      const quotas = allocateQuotas(bids, quotaTotal);
      survivors.forEach((a, i) => {
        this.epochQuota.set(a.spec.id, quotas[i] ?? 0); // 新一轮配额
        this.epochUsed.set(a.spec.id, 0); // 轮内用量归零（边界步属于旧轮）
        const prior = priors.get(a.spec.id) ?? globalRate;
        const inc = this.incompleteness.get(a.spec.id) ?? 1;
        entryById.set(a.spec.id, {
          agentId: a.spec.id, prior, incompleteness: inc, bid: r3(prior * inc),
          quota: quotas[i] ?? 0, streak: this.lowStreak.get(a.spec.id) ?? 0,
        });
      });
      // 账面透明：本轮全部账目（名册序）入报告环
      this.pushLedger({
        round: this.auctionSeq, atStep: this.poolCharged,
        agents: actives.map(a => entryById.get(a.spec.id)).filter((e): e is AuctionBid => !!e),
        poolRemaining: this.poolRemaining, quotaTotal,
      });
    } catch {
      // 防御式绝不抛：拍卖失败 ⇒ 保留既有配额，下一轮重试（市场不因一轮故障停摆）
    }
  }

  /**
   * W4-7（G5）：池扣费 + 拍卖触发 + 配额执法（chargeStep 的拍卖分支）。
   * 返回 true 的三种情形（与现状 maxSteps 软执法同型 —— 提醒而非硬闸）：
   * 池耗尽（全体已按 abort 收场）/ 当前代理在拍卖中被降级退场 / 本轮配额用尽。
   */
  private chargeAuctionStep(cur: SubAgentState): boolean {
    this.poolRemaining = Math.max(0, this.poolRemaining - 1); // 池扣费
    this.poolCharged++;
    this.epochStep++;
    this.epochUsed.set(cur.spec.id, (this.epochUsed.get(cur.spec.id) ?? 0) + 1);
    if (this.epochStep >= AUCTION_EPOCH_K) this.runAuction(); // 每 K 步重拍卖
    if (this.poolRemaining <= 0) {
      this.exhaustPool(); // 池耗尽 ⇒ 全体按现有 abort 语义收场
      return true;
    }
    if (cur.status !== 'pending' && cur.status !== 'working') return true; // 拍卖中降级退场
    const quota = this.epochQuota.get(cur.spec.id) ?? cur.spec.maxSteps;
    return (this.epochUsed.get(cur.spec.id) ?? 0) >= quota; // 配额尽 ⇒ 软提醒收尾
  }

  spawn(specs: SubAgentSpec[]): SubAgentState[] {
    const accepted: SubAgentState[] = [];
    for (const spec of specs) {
      if (this.agents.length >= this.maxAgents) break; // 团队满员：超额静默拒绝
      const id = (spec.id ?? '').trim() || `agent-${++this.idSeq}`;
      if (this.agents.some(a => a.spec.id === id)) continue; // 去重：同代号不重生
      // maxSteps 域执法：缺席/非有限数回退 10（与 roundSteps 缺省同量级）——
      // Math.max(1, undefined) === NaN 会让步数预算比较恒 false（预算静默失效）
      const rawMax = typeof spec.maxSteps === 'number' && Number.isFinite(spec.maxSteps)
        ? Math.floor(spec.maxSteps) : 10;
      const state: SubAgentState = {
        spec: { ...spec, id, maxSteps: Math.max(1, rawMax) },
        status: 'pending',
        stepsUsed: 0,
        focus: {
          agentId: id,
          scratchpad: '',
          anchorImageIds: [],
          // 意识连续性：出生即引用主任务当前屏（共享窗，id 引用而非复制）
          seedSceneHash: contextManager.lastImageRecord()?.hash,
        },
      };
      this.agents.push(state);
      accepted.push(state);
      // W4-7（G5）：拍卖开启时新代理携 endowment 入市 —— 出生配额 = 自身 maxSteps
      // （首轮拍卖前与现状等价）；外注预算时不扩池（总预算由外部决定）。
      if (this.auctionOn) {
        this.epochQuota.set(id, state.spec.maxSteps);
        this.epochUsed.set(id, 0);
        if (this.poolBudgetInjected === null) this.poolRemaining += state.spec.maxSteps;
      }
      void journal.appendMarker({
        kind: 'AGENT_BEGIN', taskId: id,
        role: state.spec.role, objective: state.spec.objective,
      });
    }
    return accepted;
  }

  current(): SubAgentState | null {
    for (let i = 0; i < this.agents.length; i++) {
      const a = this.agents[(this.cursor + i) % this.agents.length];
      if (a.status === 'pending' || a.status === 'working') return a;
    }
    return null;
  }

  chargeStep(tool: string): boolean {
    const cur = this.current();
    // 无活跃代理或非动作类调用：直通返回 —— 与 B/C 世代行为逐字节一致（零回归）
    if (!cur || !ACTION_TOOLS.includes(tool)) return false;
    if (cur.status === 'pending') cur.status = 'working';
    cur.stepsUsed++;
    // 锚点追踪：引用共享窗内最新图（不复制；窗驱逐后自然失效，引用退化）
    const last = contextManager.lastImageRecord();
    if (last && !cur.focus.anchorImageIds.includes(last.id)) {
      cur.focus.anchorImageIds.push(last.id);
      if (cur.focus.anchorImageIds.length > ANCHOR_MAX) cur.focus.anchorImageIds.shift();
    }
    // W2-4 G1：步数钟滴答（租约老化）+ 黑板摘要注入当前代理状态视图。
    // 空黑板不落键（旧视图结构零变化）；板清空即抹除残影（不留过期租约的幽灵视图）
    this.tickLeases();
    const brief = this.boardBrief();
    if (brief) cur.focus.boardDigest = brief;
    else delete cur.focus.boardDigest;
    // W4-7（G5）：拍卖关闭 ⇒ 原路径逐字节保留（缺省行为与现状完全一致，零回归）
    if (!this.auctionOn) return cur.stepsUsed >= cur.spec.maxSteps;
    // 开启 ⇒ 步数从全局池扣费；每 K 步重拍卖；配额尽/池耗尽 ⇒ 软提醒收尾
    return this.chargeAuctionStep(cur);
  }

  report(taskId: string, findings: string, confidence: number, status: SubAgentReport['status'] = 'completed'): SubAgentState | null {
    const a = this.agents.find(x => x.spec.id === taskId);
    if (!a || a.status === 'reported' || a.status === 'aborted') return this.current();
    a.report = {
      taskId, status,
      findings: findings.slice(0, 2000), // 报告预算：防长文反噬主上下文
      confidence: Math.max(0, Math.min(1, confidence)),
      stepsUsed: a.stepsUsed,
    };
    a.status = 'reported';
    // 报告即工作记忆：scratchpad 固化为结论摘要（轮转后其他代理不可见，仅供状态视图）
    a.focus.scratchpad = a.report.findings.slice(0, SCRATCHPAD_MAX);
    // W2-4 G1：代理退场即释放其租约（已报告者不占坑 —— 与步数 TTL 双保险；finding 留存为共享知识）
    this.board = this.board.filter(e => !(e.kind === 'claim' && e.claimant === taskId));
    // W4-7（G5）：退场即出市 —— 配额/自报/连败记录回收（步数预算不退池：已扣费即沉没）
    if (this.auctionOn) this.releaseAuctionMaps(taskId);
    void journal.appendMarker({ kind: 'AGENT_END', taskId, status });
    this.cursor = this.agents.indexOf(a); // 下一轮转从报告者之后开始
    return this.current();
  }

  async arbitrate(strategy?: ArbitrationStrategy): Promise<Arbitration | null> {
    const reports = this.agents.filter(a => a.report).map(a => a.report!);
    if (reports.length === 0 || reports.length < this.agents.length) return null; // 未全员报告
    const s = strategy ?? new ConfidenceWeightedArbitrator();
    return s.arbitrate(reports);
  }

  abort(taskId: string, reason: string): void {
    const a = this.agents.find(x => x.spec.id === taskId);
    if (!a || a.status === 'reported' || a.status === 'aborted') return;
    a.status = 'aborted';
    // W2-4 G1：中止同样释放租约（退场者不占坑）
    this.board = this.board.filter(e => !(e.kind === 'claim' && e.claimant === taskId));
    a.report = {
      taskId, status: 'failed',
      findings: `aborted: ${reason}`.slice(0, 2000),
      confidence: 0, stepsUsed: a.stepsUsed,
    };
    void journal.appendMarker({ kind: 'AGENT_END', taskId, status: 'aborted' });
  }

  roster(): SubAgentState[] {
    // 深拷贝视图：外部不可通过视图对象_mutate_内部状态
    return this.agents.map(a => ({
      spec: { ...a.spec },
      status: a.status,
      stepsUsed: a.stepsUsed,
      focus: { ...a.focus, anchorImageIds: [...a.focus.anchorImageIds] },
      report: a.report ? { ...a.report } : undefined,
    }));
  }

  isActive(): boolean {
    return this.current() !== null;
  }

  /** 轮步数提醒线（状态视图消费；模型超线即被提示收尾） */
  roundBudget(): number {
    return this.roundSteps;
  }

  dump(): SubAgentState[] {
    return this.roster();
  }

  restore(states: SubAgentState[] | undefined): void {
    if (!Array.isArray(states)) return;
    // 防御性恢复：结构非法的条目跳过，不拖垮整档
    // （anchorImageIds 必查：chargeStep 对其调用数组方法，缺席会炸守卫挂点）
    this.agents = states.filter(s =>
      s && s.spec && typeof s.spec.id === 'string'
      && s.focus && Array.isArray(s.focus.anchorImageIds),
    );
    this.cursor = 0;
    // 后续自动命名不撞号：取恢复档中最大 agent-N 后缀（档内乱序/有空洞时
    // agents.length 会低估 ⇒ 同号重生被去重分支静默拒绝）
    this.idSeq = this.agents.reduce((m, a) => {
      const hit = /^agent-(\d+)$/.exec(a.spec.id);
      return hit ? Math.max(m, Number(hit[1])) : m;
    }, 0);
    // W2-4 G1：黑板不随档（journal 的 marker 联合封闭且非本模块领地，无兼容
    // 入链通道）—— 恢复即清零，租约由新会话重铸（诚实：无证据不复活锁）
    this.board = [];
    this.boardSeq = 0;
    this.stepClock = 0;
    // W4-7（G5）：拍卖市场不随档 —— 池与账本是会话内市场，跨档复活无证据
    // （诚实降级：恢复即回缺省关闭，maxSteps 回归各代理独立预算语义）
    this.disableStepAuction();
  }

  reset(): void {
    this.agents = [];
    this.cursor = 0;
    this.idSeq = 0;
    // W2-4 G1：黑板清零（含步数钟 —— 与「无时钟依赖」承诺一致）
    this.board = [];
    this.boardSeq = 0;
    this.stepClock = 0;
    // W4-7（G5）：拍卖清账（含市场开关 —— reset 后回缺省关闭，零残留）
    this.disableStepAuction();
  }
}

// 单例是正确的：一台躯体只有一个协调剧本；物理唯一性由 serialize 保证
export const coordinator = new Coordinator();
