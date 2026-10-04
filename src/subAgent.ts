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
import { journal, ACTION_TOOLS, type JournalMarker } from './journal';
import { contextManager } from './contextManager';
// W4-7（G5）：经验晶体收缩率只读消费 —— swarm.ts 是 W4-2 领地，本模块不写它，
// 仅 import 其导出的纯函数 shrinkRate（结构化端口/只读消费律）。场景收敛先验的
// 数学因此与晶体 counterfactual 单源同构，无本地漂移副本。
import { shrinkRate } from './swarm';

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


// W9-3（D-F4 拆分）：仲裁分区与拍卖分区已提取至卫星件 —— 本文件保留器官主体
//（协调器：名册/焦点轮转/租约黑板/步数记账围绕单一 Coordinator 私有状态）。
import {
  ConfidenceWeightedArbitrator,
  type Arbitration, type ArbitrationStrategy,
} from './subAgent.arbitration';
import {
  AUCTION_EPOCH_K, AUCTION_DEMOTE_ROUNDS, AUCTION_LEDGER_MAX, AUCTION_DEFAULT_GLOBAL_RATE,
  marginalProgressScore, allocateQuotas, r3,
  type ConvergenceEvidence, type StepAuctionPort, type StepAuctionOptions,
  type AuctionBid, type AuctionRound, type AuctionStatus,
} from './subAgent.auction';

// W9-3：原导出面原位再导出（导入面稳定 —— 既有消费方零改动）。
export {
  type Arbitration, type ArbitrationStrategy, ConfidenceWeightedArbitrator,
  type AnchoredRegion, type VerifiableClaim, type VerifierMission, type VerifierEvidence,
  type EvidenceAttribution, type EvidenceAnchorPort,
  anchorIoU, semanticAnchorMatch, geometricAnchorMatch, mintVerifierMission,
  EvidenceBackedArbitrator,
} from './subAgent.arbitration';
export {
  AUCTION_EPOCH_K, AUCTION_DEMOTE_ROUNDS, AUCTION_LEDGER_MAX, AUCTION_DEFAULT_GLOBAL_RATE,
  type ConvergenceEvidence, type StepAuctionPort, type StepAuctionOptions,
  type AuctionBid, type AuctionRound, type AuctionStatus,
  marginalProgressScore, allocateQuotas,
} from './subAgent.auction';

// ─── W2-4 G1：租约黑板 —— 协调器持有的有界共享工作区 ───
//
// 设计律：
//   * 步数 TTL 而非时钟 —— 租约寿命以「动作步」计量（chargeStep 滴答），
//     协议全程确定性、离线可测，免时钟依赖（重放/测试同判据）。
//   * 有界 FIFO：≤8 条，超容逐出最旧（touch 到尾：续租/重铸刷新 FIFO 位）。
//   * 撞租约即让位：他人未过期 claim 且主题语义重叠（余弦 ≥0.5，与仲裁
//     consensus 阈值同域）⇒ 申请者让位换目标（结果带回持有者供改道）。
//   * 代理退场（report/abort）即释放其 claim —— 已退场者不占坑（与 TTL 双保险）。
//   * W6-4（持久化缝包）：入日志通道已开 —— journal.JournalMarker 增 AGENT_NOTE
//     kind（封闭联合的定向扩展，白名单隔离见 journal.ts W6-4 注记）。claim/post
//     成功事件经注入的 journal 端口落链（fire-and-forget、防御式绝不抛；测试注
//     桩）。落链的是**审计行**：restore 仍不复活租约（跨进程步数钟失效 ⇒ 诚实
//     重建为空板），链上行只作存证 —— 「发生过什么」可查，「持有什么锁」不臆造。

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

// ─── W6-4（持久化缝包）：黑板事件的 journal 端口 ───

/**
 * W6-4：黑板事件入链端口 —— appendMarker 的结构化最小面（真 journal 结构性
 * 满足；测试注入桩捕获 marker）。缺省用全局 journal 单例（与 spawn/report 的
 * AGENT_BEGIN/END 直写同一通道）；wireBoardJournal(null) 复位回缺省。
 * 端口异常/拒绝绝不炸黑板协议（fire-and-forget + 防御式吞错 —— 审计是旁路
 * 义务，不是主路债主）。
 */
export interface BoardJournalPort {
  appendMarker(marker: JournalMarker): Promise<void> | void;
}

/** W6-4：黑板事件 marker 的代理 id 预算（字符 —— 与 subject/body 预算同律的有界面） */
const BOARD_AGENT_ID_MAX = 64;

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
   * W6-4（持久化缝包）：接线黑板事件的 journal 端口（缺省 = 全局 journal 单例；
   * 测试注入桩）。null ⇒ 复位回缺省。幂等：重复接线以后一次为准。绝不抛。
   */
  wireBoardJournal(port: BoardJournalPort | null): void;
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
  // ── W6-4（持久化缝包）：黑板事件入链端口（缺省真 journal；wireBoardJournal 注入）──
  private boardJournal: BoardJournalPort = journal;
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

  /** W6-4：接线黑板事件 journal 端口（null ⇒ 复位缺省真 journal；绝不抛） */
  wireBoardJournal(port: BoardJournalPort | null): void {
    this.boardJournal = port && typeof port.appendMarker === 'function' ? port : journal;
  }

  /**
   * W6-4：黑板事件落链（fire-and-forget、防御式绝不抛）—— 成功的 claim/post
   * 铸 AGENT_NOTE marker 经端口入链。载荷全部经预算执法（agentId/subject/body
   * 有界）。端口抛错/拒绝 ⇒ 静默吞（审计旁路义务不炸黑板协议主路）。
   */
  private noteBoard(
    agentId: string,
    event: 'claim' | 'post',
    subject: string,
    body?: string,
  ): void {
    try {
      const marker: JournalMarker = body === undefined
        ? { kind: 'AGENT_NOTE', agentId: agentId.slice(0, BOARD_AGENT_ID_MAX), event, subject }
        : {
          kind: 'AGENT_NOTE', agentId: agentId.slice(0, BOARD_AGENT_ID_MAX), event, subject,
          body,
        };
      const p = this.boardJournal.appendMarker(marker);
      if (p && typeof (p as Promise<void>).then === 'function') {
        (p as Promise<void>).then(() => { /* fire-and-forget */ }, () => { /* 绝不炸 */ });
      }
    } catch {
      /* 防御式兜底：端口故障不炸黑板协议 */
    }
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
    this.noteBoard(agentId, 'claim', subj); // W6-4：成功认领入链存证
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
    this.noteBoard(agentId, 'post', subj, body); // W6-4：发现张贴入链存证
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
    // W2-4 G1 / W6-4：黑板不随档复活 —— 即便 AGENT_NOTE 审计行已在链上（W6-4
    // 落链通道已开），租约也不自动重建。保守选择的论证：租约寿命以步数钟计量
    // （chargeStep 滴答），跨进程崩溃后 stepClock 语境失效 —— 恢复的租约既无法
    // 诚实折算剩余 TTL，也无法证明持有者仍存活（进程死亡 = 意图证据中断）；
    // 复活一把无法证伪的锁，最坏情况是他代理永久让位（僵尸租约）。空板重建 +
    // 链上审计行留痕（checkpoint 的 journal 段随行 AGENT_NOTE ——「谁曾认领过
    // 什么」可查）是唯一不臆造的恢复语义：无证据不复活锁。
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