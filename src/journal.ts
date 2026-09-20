// src/journal.ts
// 突破三：行动日志（JSONL）+ 观察者挂载 + 重放支持。
// 每个工具调用的 args 与结果被忠实记录 —— 可审计、可回放、可转化为固定宏。
// 挂载点选在 post-execute 观察位：对管线零侵入，且能拿到最终状态字符串。
// 第七轮：SHA-256 哈希链 —— 每条记录携带前条哈希的哈希（区块链式防篡改审计）。
// 事后任何对历史记录的增/删/改都会断裂链条，verify_journal 立即定位第一个断点。
// 这是金融级审计日志的世界标准：日志不仅要记，还要能证明自己没被改过。
import { appendFile, mkdir } from 'fs/promises';
import { createHash } from 'crypto';
import path from 'path';
import type { Context } from '@deepseek-ai/cordis';
import type { Config } from './config';
import { onToolPost } from './guards/hooks';
import { classifyResult } from './resultContract';

/** 可重放的动作类工具（take_screenshot 等观察类工具不进日志） */
export const ACTION_TOOLS = [
  'click_mouse', 'type_text', 'scroll_page', 'press_hotkey',
  'drag_mouse', 'click_element', 'switch_tab', 'switch_window', 'dismiss_popup',
];

/**
 * D-1/D-2/D-3 生命周期标记：入链受防篡改保护，但永不进 ACTION_TOOLS——
 * 重放、技能归纳、经验结晶、反事实推理全部天然跳过标记（零污染）。
 * 一次改动，三代受益：AGENT_BEGIN/END（D-1）、ENV_SHAPED（D-2）、SENSE_SHIFT（D-3）。
 */
export type JournalMarker =
  | { kind: 'AGENT_BEGIN'; taskId: string; role: string; objective: string }
  | { kind: 'AGENT_END'; taskId: string; status: string }
  | { kind: 'ENV_SHAPED'; action: string }
  | { kind: 'SENSE_SHIFT'; from: string; to: string };

/** 标记的 tool 名集合：append 门控的旁路白名单（status 恒为 'MARKER'） */
const MARKER_TOOLS = new Set(['AGENT_BEGIN', 'AGENT_END', 'ENV_SHAPED', 'SENSE_SHIFT']);

export interface JournalEntry {
  ts: number;
  tool: string;
  args: Record<string, any>;
  status: string;
  effect_detected?: boolean;
  hash?: string; // 链上哈希：sha256(prevHash + canonical(entry without hash))
  // ── C-3 因果推理时间轴：[观察]→[思考]→[行动]→[结果] 四元组 ──
  // 观察observe / 思考thought / 行动=tool+args / 结果=status+effect_detected（既有字段天然承担）。
  // 可选字段经 canonical 键排序稳定序列化自动进入哈希域：旧链无此字段哈希不变（向后兼容），
  // 新链含此字段则受防篡改保护 —— 「为什么做」与「做了什么」同等不可抵赖。
  /** [观察] 动作前场景指纹/状态摘要（截图工具的锚点引用） */
  observe?: string;
  /** [思考] 决策依据（提取自工具调用 reasoning 参数 —— 模型行动前的出声思考） */
  thought?: string;
}

const GENESIS = 'GENESIS';

/** 稳定序列化：键排序 —— 同一对象永远产生同一字符串（哈希链的前提） */
function canonical(obj: any): string {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonical).join(',') + ']';
  return '{' + Object.keys(obj).sort()
    .map(k => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}';
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** 链式哈希：entry 的指纹 = sha256(前条哈希 + 本条内容哈希域) */
function chainHash(prev: string, entry: JournalEntry): string {
  const { hash: _omit, ...domain } = entry; // 哈希域不含自身
  return sha256(prev + canonical(domain));
}

class ActionJournal {
  private entries: JournalEntry[] = [];
  private enabled = true;
  private filePath = '';
  private capacity = 1000;
  private taskStartIndex = 0; // 最近一次复杂任务的日志起点（技能归纳的切片边界）
  private taskDescription = ''; // 最近一次复杂任务的自然语言描述（失败记忆的 query 源）
  private chainTip = GENESIS;  // 哈希链尖端：checkpoint 恢复时随行
  private chainBase = GENESIS; // 链基（B-1）：最旧存活条目的「前条哈希」。
  private lastObserved = '';   // C-3：最近观察摘要（[观察]→[行动] 因果桥）
  /** 磁盘写尾链（J 纪元）：并发 append 的 JSONL 行序与链序保持一致 */
  private diskTail: Promise<void> = Promise.resolve();
  // 容量驱逐（shift）把被驱逐条的哈希升格为新链基 —— verify 从链基起重放，
  // 存活窗口内任何篡改仍可定位；被驱逐条目的取证职责由磁盘 JSONL 承载。

  configure(enabled: boolean, filePath: string, capacity: number) {
    this.enabled = enabled;
    this.filePath = filePath;
    this.capacity = capacity;
  }

  reset() {
    this.entries = [];
    this.chainTip = GENESIS;
    this.chainBase = GENESIS;
    this.taskStartIndex = 0;
    this.lastObserved = '';
  }

  /** 当前任务描述（未处于复杂任务中则为空串） */
  currentTask(): string {
    return this.taskDescription;
  }

  async append(entry: JournalEntry): Promise<void> {
    if (!this.enabled) return;
    // 标记走同一 chainHash 路径（链不断、防篡改），但绕过 ACTION_TOOLS 门控
    const isMarker = MARKER_TOOLS.has(entry.tool);
    if (!isMarker && !ACTION_TOOLS.includes(entry.tool)) return;
    // 链式封存：本条哈希 = f(前条哈希, 本条内容)
    entry.hash = chainHash(this.chainTip, entry);
    this.chainTip = entry.hash;
    this.entries.push(entry);
    if (this.entries.length > this.capacity) {
      const evicted = this.entries.shift()!;
      this.chainBase = evicted.hash ?? GENESIS; // 链基前滚：被驱逐哈希成为新起点
      // 切片边界同步前移：否则 sinceTaskStart 会越界漂移进旧任务区
      this.taskStartIndex = Math.max(0, this.taskStartIndex - 1);
    }

    if (this.filePath) {
      // J 纪元修正：磁盘写经尾链串行化 —— 旧实现两个并发 append 各自 await
      // mkdir 后再 appendFile，完成顺序可倒置：内存哈希链正确，磁盘 JSONL
      // 行序却可能违反链序（B-1 承诺"被驱逐条的取证职责交磁盘"被架空）。
      this.diskTail = this.diskTail.then(async () => {
        try {
          // 目录不存在则创建；追加失败不阻断主流程（日志是旁路义务）
          await mkdir(path.dirname(this.filePath), { recursive: true });
          await appendFile(this.filePath, JSON.stringify(entry) + '\n', 'utf8');
        } catch (e: any) {
          console.warn(`[Journal] write failed: ${e.message}`);
        }
      });
    }
  }

  /**
   * 标记入链：生命周期事件（代理出生/死亡、环境重塑、感知相变）进入因果时间轴。
   * 载体是 JournalEntry（tool=kind, status='MARKER', args=载荷）—— canonical 序列化
   * 天然稳定，verify/restore/JSONL 落盘全部复用既有路径，零新机制。
   */
  async appendMarker(marker: JournalMarker): Promise<void> {
    const { kind, ...payload } = marker;
    await this.append({
      ts: Date.now(), tool: kind, args: payload as Record<string, any>, status: 'MARKER',
    });
  }

  /** 哈希链尖端（checkpoint 随行保存；恢复续链不断） */
  get tip(): string {
    return this.chainTip;
  }

  /** 链基（checkpoint 随行保存；恢复后 verify 不误报） */
  get base(): string {
    return this.chainBase;
  }

  /**
   * 链完整性校验：从链基（chainBase）重放存活窗口，逐条比对。
   * 返回 ok=true 或第一个断点索引（审计报告的取证锚点）。
   * 审计承诺（B-1 语义修正）：存活窗口不可篡改；窗口外由磁盘 JSONL 取证。
   */
  verify(): { ok: boolean; length: number; brokenAt: number | null } {
    let prev = this.chainBase;
    for (let i = 0; i < this.entries.length; i++) {
      const expect = chainHash(prev, this.entries[i]);
      if (this.entries[i].hash !== expect) {
        return { ok: false, length: this.entries.length, brokenAt: i };
      }
      prev = expect;
    }
    return { ok: true, length: this.entries.length, brokenAt: null };
  }

  /** checkpoint 恢复：连同链尖端与链基一起还原（否则后续 append/verify 会误判断链） */
  restoreChain(entries: JournalEntry[], chainTip?: string, chainBase?: string): void {
    this.entries = entries;
    this.chainTip = chainTip ?? entries.at(-1)?.hash ?? GENESIS;
    this.chainBase = chainBase ?? GENESIS;
    this.taskStartIndex = 0;
  }

  list(actionOnly = true): JournalEntry[] {
    return actionOnly ? this.entries.filter(e => ACTION_TOOLS.includes(e.tool)) : [...this.entries];
  }

  /**
   * F-4 行为复杂度画像：存活窗口内动作流的 LZ76 短语数 + 归一化熵率。
   * 消费方：get_metrics 的卡死洞见（near-periodic 行为签名）。长度上限 400
   * （O(n²) 解析的诚实预算；窗口语义 = 最近的行为形态，不是全史统计）。
   */
  actionComplexity(maxLen = 400): { phrases: number; normalized: number | null; length: number } {
    const tools = this.list(true).slice(-maxLen).map(e => e.tool);
    return {
      phrases: lempelZivComplexity(tools),
      normalized: normalizedActionComplexity(tools),
      length: tools.length,
    };
  }

  /** 任务起点打标：start_complex_task 执行前调用；description 供失败记忆对齐任务语境 */
  markTaskStart(description = ''): void {
    this.taskStartIndex = this.entries.length;
    this.taskDescription = description;
  }

  /** 本次任务以来的动作（技能归纳的原料） */
  sinceTaskStart(): JournalEntry[] {
    return this.entries.slice(this.taskStartIndex).filter(e => ACTION_TOOLS.includes(e.tool));
  }

  /**
   * C-3 观察登记：take_screenshot 等观察类工具把锚点摘要喂给因果链。
   * 最近观察被后续动作条目引用为 observe 字段 —— [观察]→[行动] 的因果桥。
   */
  noteObservation(summary: string): void {
    if (summary) this.lastObserved = summary.slice(0, 300); // 观察预算：锚点摘要级
  }

  /** 供 append 时引用的最近观察（无观察时 undefined） */
  lastObservation(): string | undefined {
    return this.lastObserved || undefined;
  }

  /**
   * C-3 反事实推理：定位决策点并汇集历史异action证据。
   * 证据源（零新依赖，全部复用现有记忆系统）：
   *   1. 同链历史：相同场景指纹(observe)下其他工具的结局 —— 链上侦探笔记
   *   2. UI 记忆：相似描述地标的成功坐标（调用方经 alternatives 之外自行 recall）
   * 思考缺失时如实降级标注 —— 反事实推理的证据质量对模型透明。
   */
  findDecisionPoints(query: CounterfactualQuery = {}): DecisionPoint[] {
    // 索引空间统一：决策点序号与 replay_actions / save_skill 消费的动作流
    // （list() 的 ACTION_TOOLS 过滤视图）同一空间。原始 entries 含 MARKER 条目
    // （AGENT_BEGIN/ENV_SHAPED/SENSE_SHIFT...），直接用其下标会让模型从 what_if
    // 输出推导的重放区间整体错位（错位量 = 区间内的 marker 数）。
    const actionIndexOf = new Map<number, number>();
    let actionCount = 0;
    this.entries.forEach((e, i) => {
      if (ACTION_TOOLS.includes(e.tool)) actionIndexOf.set(i, actionCount++);
    });
    const pool = this.entries
      .map((entry, index) => ({ entry, index, actionIndex: actionIndexOf.get(index) ?? -1 }))
      .filter(({ actionIndex }) => query.sinceIndex === undefined || actionIndex >= query.sinceIndex)
      .filter(({ entry }) => ACTION_TOOLS.includes(entry.tool))
      .filter(({ entry }) =>
        !query.failedOnly || entry.status === 'FAILED' || entry.effect_detected === false);

    return pool.map(({ entry, actionIndex }) => {
      const scene = entry.observe;
      // 链上异action：同场景指纹、不同工具/坐标的既往动作及其结局
      const alternatives: CounterfactualAlternative[] = scene
        ? this.entries
            .filter(e => e !== entry && e.observe === scene && ACTION_TOOLS.includes(e.tool))
            .slice(-5)
            .map(e => ({
              action: `${e.tool} ${JSON.stringify(e.args).slice(0, 80)}`,
              historicalOutcome: e.status === 'SUCCESS'
                ? (e.effect_detected === false ? 'UNKNOWN' : 'SUCCESS')
                : e.status === 'FAILED' ? 'FAILED' : 'UNKNOWN',
              evidence: `journal: same scene (${scene.slice(0, 40)}...) → ${e.status}` +
                (e.effect_detected === false ? ' (no visual effect)' : ''),
            }))
        : [];
      return {
        index: actionIndex,
        entry,
        thought: entry.thought ?? null,
        alternatives,
      };
    });
  }
}

export const journal = new ActionJournal();

/** 以观察者身份挂进工具管线：记录一切动作类调用 */
export function registerJournalGuard(ctx: Context, config: Config): void {
  journal.configure(config.enableJournal, config.journalPath, 1000);
  onToolPost(ctx, async (call, result, next) => {
    const c = classifyResult(result); // B-2：统一契约解析
    // C-3 因果链注入：思考来自模型行动前的出声思考，观察来自最近截图锚点
    await journal.append({
      ts: Date.now(), tool: call.name, args: call.args,
      status: c.status, effect_detected: c.effectDetected,
      thought: typeof call.args?.reasoning === 'string' && call.args.reasoning.trim()
        ? call.args.reasoning.trim().slice(0, 500) // 思考预算：防长篇推理反噬 Token
        : undefined,
      observe: journal.lastObservation(),
    });
    return next(result); // 纯观察，原样透传
  });
}

// ─── C-3 反事实推理：从「流水账」到「侦探笔记」 ───

export interface CounterfactualAlternative {
  /** 候选异action描述（如 "click_mouse at (0.62,0.20) [筛选 button]"） */
  action: string;
  /** 历史证据：该替代动作在本场景或相似场景的既往结局 */
  historicalOutcome: 'SUCCESS' | 'FAILED' | 'UNKNOWN';
  /** 证据来源（失败记忆/UI 记忆/技能基因的溯源说明） */
  evidence: string;
}

export interface DecisionPoint {
  /** 存活窗口内的条目索引（时光倒流的重放起点） */
  index: number;
  entry: JournalEntry;
  /** 当时的思考（可能缺失 —— 模型未声明 reasoning 时证据降级） */
  thought: string | null;
  alternatives: CounterfactualAlternative[];
}

export interface CounterfactualQuery {
  /** 只考察该索引之后的条目；缺省 = 全部存活窗口 */
  sinceIndex?: number;
  /** true = 只看失败/无效条目（死循环排查的默认视角） */
  failedOnly?: boolean;
}

// ─── F-4 LZ76 行为复杂度（第六维·压缩认知）：Kolmogorov 复杂度的可计算逼近 ───

/**
 * LZ76 复杂度（Lempel-Ziv 1976 解析法）：把序列切成「历史内最长匹配 + 1 个新符号」
 * 的短语数。数学地位：c(n) 是 Kolmogorov 复杂度的上界逼近 —— 短语越少，序列越
 * 接近周期/确定（卡死的复杂度签名）。实现于符号数组域（分隔符隔离，无字符串
 * 边界歧义）；O(n²) 最坏，消费方以长度上限执法（统计诚实 vs 计算预算）。
 * 纯函数导出：统计原子的测试面。
 */
export function lempelZivComplexity(seq: readonly string[]): number {
  if (seq.length === 0) return 0;
  const SEP = '\u0001';
  let hist = SEP + seq[0] + SEP; // 已消费历史（分隔符包裹：完整符号匹配）
  let phrases = 1;
  let i = 1;
  while (i < seq.length) {
    let l = 0; // 历史内最长匹配长度
    for (let len = 1; i + len <= seq.length; len++) {
      const cand = SEP + seq.slice(i, i + len).join(SEP) + SEP;
      if (hist.includes(cand)) l = len;
      else break;
    }
    phrases++;
    const phraseEnd = Math.min(i + l + 1, seq.length); // 短语 = 匹配 + 1 个新符号
    hist += seq.slice(i, phraseEnd).join(SEP) + SEP;
    i = phraseEnd;
  }
  return phrases;
}

/**
 * F-4 归一化行为熵率：c(n)·log₂(n) / (n·log₂(α))，α = 观测字母表大小。
 * ≈1 ⇒ 与同字母表均匀随机等复杂（真探索）；→0 ⇒ 周期/确定（卡死签名 ——
 * 与屏幕侧 oscillationTracker 互补：屏幕不变但动作在转的循环只有行为侧可见）。
 * n < 4 或 α < 2 ⇒ null（统计诚实下限）。
 */
export function normalizedActionComplexity(seq: readonly string[]): number | null {
  const n = seq.length;
  if (n < 4) return null;
  const alpha = new Set(seq).size;
  if (alpha < 2) return 0; // 单字母表 = 完全确定（熵率恒 0 —— 周期 1 的极限态）
  const c = lempelZivComplexity(seq);
  return Math.round((c * Math.log2(n)) / (n * Math.log2(alpha)) * 1000) / 1000;
}
