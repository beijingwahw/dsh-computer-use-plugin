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
  verdict: 'consensus' | 'conflict' | 'best_single';
  /** 冲突裁决时的最佳候选 taskId */
  winner?: string;
  /** 两两交叉验证：findings 的语义余弦（复用 C-2 semanticHash，零新依赖） */
  crossValidation: Array<{ pair: [string, string]; agreement: number }>;
  /** 裁决理由（对模型透明的归因） */
  rationale: string;
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

  configure(maxAgents: number, roundSteps: number): void {
    this.maxAgents = Math.max(1, maxAgents);
    this.roundSteps = Math.max(1, roundSteps);
  }

  spawn(specs: SubAgentSpec[]): SubAgentState[] {
    const accepted: SubAgentState[] = [];
    for (const spec of specs) {
      if (this.agents.length >= this.maxAgents) break; // 团队满员：超额静默拒绝
      const id = (spec.id ?? '').trim() || `agent-${++this.idSeq}`;
      if (this.agents.some(a => a.spec.id === id)) continue; // 去重：同代号不重生
      const state: SubAgentState = {
        spec: { ...spec, id, maxSteps: Math.max(1, spec.maxSteps) },
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
    return cur.stepsUsed >= cur.spec.maxSteps;
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
    this.agents = states.filter(s =>
      s && s.spec && typeof s.spec.id === 'string' && s.focus,
    );
    this.cursor = 0;
    this.idSeq = this.agents.length; // 后续自动命名不撞号
  }

  reset(): void {
    this.agents = [];
    this.cursor = 0;
    this.idSeq = 0;
  }
}

// 单例是正确的：一台躯体只有一个协调剧本；物理唯一性由 serialize 保证
export const coordinator = new Coordinator();
