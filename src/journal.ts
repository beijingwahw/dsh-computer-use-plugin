// src/journal.ts
// 突破三：行动日志（JSONL）+ 观察者挂载 + 重放支持。
// 每个工具调用的 args 与结果被忠实记录 —— 可审计、可回放、可转化为固定宏。
// 挂载点选在 post-execute 观察位：对管线零侵入，且能拿到最终状态字符串。
// 第七轮：SHA-256 哈希链 —— 每条记录携带前条哈希的哈希（区块链式防篡改审计）。
// 事后任何对历史记录的增/删/改都会断裂链条，verify_journal 立即定位第一个断点。
// 这是金融级审计日志的世界标准：日志不仅要记，还要能证明自己没被改过。
import {
  appendFileSync, mkdirSync, openSync, writeSync, fsyncSync, closeSync,
  statSync, renameSync, unlinkSync,
} from 'node:fs';
import { createHash } from 'crypto';
import path from 'path';
import type { Context } from '@deepseek-ai/cordis';
import type { Config } from './config';
import { onToolPost } from './guards/hooks';
import { classifyResult } from './resultContract';
import { mmrRoot, mmrInclusionProof, type InclusionProof } from './proof';
import { cohensH } from './knowledge/metrics';

/** 可重放的动作类工具（take_screenshot 等观察类工具不进日志） */
export const ACTION_TOOLS = [
  'click_mouse', 'type_text', 'scroll_page', 'press_hotkey',
  'drag_mouse', 'click_element', 'switch_tab', 'switch_window', 'dismiss_popup',
  // AA-1：跳转可重放（同 URL 再跳）—— 审计与技能归纳覆盖世界跳转
  'open_url',
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
  | { kind: 'SENSE_SHIFT'; from: string; to: string }
  /** U 纪元（U-3）：守卫拦截存证 —— 防篡改链上的政策裁决事实（guard 层 proof 闭环） */
  | { kind: 'GUARD_BLOCKED'; guard: string; reason: string }
  /** W2-2（S4）：派发前审计 WAL 行 —— 变更类工具物理派发**之前**先行入链的
   *  审计意图记录（args 已由调用方脱敏）。fail-closed 语义的落点：
   *  appendPreDispatch 返回 ok=false ⇒ 守卫拒绝派发该动作。 */
  | { kind: 'AUDIT_PRE'; tool: string; args?: Record<string, unknown> }
  /** W6-4（持久化缝包）：子代理黑板事件存证 —— claim（租约认领）/ post（发现
   *  张贴）的审计行。封闭联合的定向扩展：入链走 appendMarker（status 恒为
   *  'MARKER'）受防篡改哈希链保护，但**永不进 ACTION_TOOLS** —— 重放
   *  （orchestrator 的 ACTION_TOOLS 过滤）、技能归纳（sinceTaskStart/list(true)）、
   *  过程评分（processScore 的 status==='MARKER' 旁路）全部天然跳过黑板行，
   *  与 AUDIT_PRE（W2-2）同律的白名单隔离：黑板绝不污染动作重放。 */
  | { kind: 'AGENT_NOTE'; agentId: string; event: 'claim' | 'post'; subject: string; body?: string }
  /** ΑΩ-R4（守卫物理探针审计盲区消除）：探针存证行 —— 金丝雀试演
   *  （probe-click / probe-click-back(-retry) / probe-type-char / probe-backspace(-retry)
   *  / region-hash）与根因鉴别（hover-cursor / capture-frame）这类**绕过宿主
   *  工具管线**的物理微动作派发，此前只活在各守卫自己的事件环里、不进任何
   *  防篡改链 —— 与 W2-2「变更类动作先入审计链再派发」立法不对称。本标记
   *  把每次物理派发（含复位重试与帧通道）补进哈希链：探针是安全机制的
   *  「微型变更」，同样要有不可抵赖的轨迹。载荷走既有脱敏纪律（与 auditGuard
   *  的 REDACT_KEYS 同律从严）：只记守卫名 + 探针步名 + 区域坐标 + 结果三态；
   *  type 探针只记 charCount（单字符事实），字符/文本内容零明文。结果三态：
   *  ok（派发成功/观察在手）/ failed（派发被拒或观察缺席 —— 端口返回
   *  false/null，世界未被触碰）/ threw（端口抛错，防御式收口）。
   *  立法取舍（fail-open，与 W2-2 的 fail-closed 相反）：探针是安全机制本身
   *  —— 幂等可逆微动作 + 预算封顶，审计失败若 fail-closed 会因审计通道抖动
   *  瘫痪安全层 ⇒ fail-open + 遥测打点 <guard>:probe-audit-failed，完整论证
   *  见 guards/probeAudit.ts。白名单隔离同 AGENT_NOTE/AUDIT_PRE：GUARD_PROBE
   *  永不进 ACTION_TOOLS —— 重放/技能归纳/过程评分天然跳过探针行。 */
  | {
      kind: 'GUARD_PROBE';
      guard: 'canary' | 'rootcause';
      probe: string;
      result: 'ok' | 'failed' | 'threw';
      point?: { x: number; y: number };
      radius?: number;
      charCount?: number;
    }
  /** ΝΩ-1：沙箱宿主重放的单步派发存证（五门全过后的真派发）。三态脱敏方言
   *  与 GUARD_PROBE 同律：只记动作种类/归一坐标/字符数，文本/令牌零明文；
   *  fail-open（重放已过五门，审计通道故障不拦截）。永不进 ACTION_TOOLS。 */
  | {
      kind: 'SANDBOX_HOST_REPLAY';
      action: string;
      result: 'ok' | 'failed' | 'threw';
      point?: { x: number; y: number };
      charCount?: number;
    };

/** 标记的 tool 名集合：append 门控的旁路白名单（status 恒为 'MARKER'）。
 *  W6-4：AGENT_NOTE 入白名单（黑板行经 appendMarker 入链）；ΑΩ-R4：GUARD_PROBE
 *  入白名单（守卫物理探针存证行）；ACTION_TOOLS 不动 —— 白名单隔离是单向的：
 *  能入链 ≠ 能重放。 */
const MARKER_TOOLS = new Set(['AGENT_BEGIN', 'AGENT_END', 'ENV_SHAPED', 'SENSE_SHIFT', 'GUARD_BLOCKED', 'AUDIT_PRE', 'AGENT_NOTE', 'GUARD_PROBE', 'SANDBOX_HOST_REPLAY']);

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
  // ── W4-0（E 接线 · W3-8 过程评分器的实证数据面）：动作验证三字段顶层直录 ──
  // 现状仅 effect_detected 在链上；scale（效应尺度）/ intent（意图裁决）/
  // phashCorroborates（pHash 佐证）此前只活在工具返回的 state_anchor.effect 里，
  // 链外即失传 —— 过程评分器的四通道（effect=detected×scale / intent 证据阶梯
  // intent>phash>thought）拿不到链上实证。三键经 canonical 键排序稳定序列化
  // 自动进入哈希域：旧链无此字段哈希不变（向后兼容），新链含此字段则与
  // 「做了什么」同等不可抵赖（哈希链语义零变更 —— 只加可选载荷字段）。
  /** 动作效应尺度（actionVerifier 的 scale：page-level / element-level / none） */
  scale?: string;
  /** 意图裁决（actionVerifier 的 intent：期望 × 物理证据 —— 与 detected 分歧 = 高级幻觉警报） */
  intent?: { expected: string; satisfied: boolean; evidence: string };
  /** pHash 佐证（感知哈希对双尺度判决的 corroborate 位） */
  phashCorroborates?: boolean;
}

const GENESIS = 'GENESIS';

/** W2-2（S4）：派发前审计提交的结果契约（appendPreDispatch 的返回面） */
export type PreDispatchAuditResult =
  | { ok: true; hash?: string; skipped?: 'journal-disabled' }
  | { ok: false; error: string };

/** ΝΩ-24：canonical 病态载荷守卫参数 —— 深度上限与降级哨兵。
 *  守卫律与 processScore 的 safeCanonical 同源（降级为常量哨兵串，序列化
 *  稳定、绝不抛）；哨兵在哈希域内确定性一致 —— 同一病态载荷每次铸出同一
 *  指纹，verify 重算同哨兵，链不断。 */
const CANONICAL_MAX_DEPTH = 64;
const CANONICAL_SENTINEL = '"#unserializable"';

// ── ΝΩ-45（journal 组提交 + JSONL rotation）：flusher 与轮转参数 ──
/** 组提交窗口：50ms 周期或 32 行批阈值，先到者触发一次 open/write/fsync/close */
const FLUSH_INTERVAL_MS = 50;
/** 批阈值：第 32 行并入当批同步提交（不等周期 —— 高频动作流上把窗口压到一条尾延迟内） */
const FLUSH_BATCH = 32;
/** 防涨硬上限：缓冲达 256 行 ⇒ 同步冲刷。不变式执法缝：批阈值在每条 enqueue 后
 *  即时检查，缓冲正常上界 = FLUSH_BATCH（32）⇒ 本限正常不可达；它是为未来
 *  flusher 异步化重构（批触发改为延迟排程的形态）预留的防御底座 —— 缓冲增长
 *  永远有界，绝不因冲刷通道停滞而无限吃内存。 */
const QUEUE_LIMIT = 256;
/** 轮转阈值：当前代追加后总字节将超 5MB ⇒ 先轮转再追加（新当前代从本批起算） */
const ROTATION_LIMIT_BYTES = 5 * 1024 * 1024;
/** 轮转保留代数：.1（上一代）与 .2（上上代），更旧出局 */
const ROTATION_GENERATIONS = 2;

/** ΝΩ-45（观测/测试面）：主 JSONL 组提交通道的统计快照（reset 归零） */
export interface JournalDiskStats {
  /** 组提交次数（每批每文件一计 —— open/write/fsync/close 四联的执行次数） */
  flushes: number;
  /** fsync 调用次数（旧路径逐条 = 行数；组提交后 = 批数 —— 下降幅度的断言锚点） */
  fsyncs: number;
  /** 成功落盘行数 */
  linesWritten: number;
  /** 轮转发生次数 */
  rotations: number;
  /** 写失败丢弃的行数（旁路义务的诚实观测 —— WAL 不在此列，其永不丢） */
  droppedLines: number;
}

/** 稳定序列化：键排序 —— 同一对象永远产生同一字符串（哈希链的前提）。
 *  ΝΩ-24：递归加 WeakSet 环检测 + 深度上限 64 —— 旧实现无守卫，畸形深嵌套
 *  args 栈溢出、环形 args 无限递归，RangeError 可击穿 append（无 catch）直达
 *  宿主事件层。seen 只记当前递归路径（出口即删）：同一子对象被两键引用是
 *  合法 DAG 载荷（JSON.stringify 同律逐处展开），只有真环才降级哨兵。 */
function canonical(obj: any, depth = 0, seen = new WeakSet<object>()): string {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (depth > CANONICAL_MAX_DEPTH || seen.has(obj)) return CANONICAL_SENTINEL;
  seen.add(obj);
  try {
    if (Array.isArray(obj)) return '[' + obj.map(v => canonical(v, depth + 1, seen)).join(',') + ']';
    // 值为 undefined 的自有键与缺键同域：JSON.stringify 落盘时丢弃前者
    // （checkpoint 落盘-恢复往返），若哈希域区分两者，恢复后 verify 重算即误报断链。
    return '{' + Object.keys(obj).sort()
      .filter(k => obj[k] !== undefined)
      .map(k => JSON.stringify(k) + ':' + canonical(obj[k], depth + 1, seen)).join(',') + '}';
  } finally {
    seen.delete(obj);
  }
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
  /** ΝΩ-45（组提交）：主 JSONL 行缓冲（FIFO）。磁盘行序恒等于链序 —— J 纪元
   *  「并发 append 的 JSONL 行序与链序保持一致」不变量的新承载：入队即定序，
   *  flushDisk 单线程同步成批写出（旧实现靠 diskTail 尾链串行化，本实现靠
   *  「同步批写」这一更强的不变量 —— 无 await 窗口即无完成倒置）。 */
  private pendingLines: Array<{ filePath: string; line: string }> = [];
  /** ΝΩ-45：flusher 周期计时器（unref 不阻进程退出；node:test mock.timers 可注入假钟） */
  private flushTimer: NodeJS.Timeout | null = null;
  /** ΝΩ-45：组提交统计（观测/测试面；reset 归零） */
  private diskCounters: JournalDiskStats = { flushes: 0, fsyncs: 0, linesWritten: 0, rotations: 0, droppedLines: 0 };
  /** Δ-6：日志目录一次保证集（按路径记账）—— 首写建立后入集，configure 换路径时清空重探 */
  private ensuredDirs = new Set<string>();
  // ── W2-2（S4）：先行审计 WAL 通道的簿记 ──
  /** WAL 自身的小哈希链尖端（与主链独立；跨记录防篡改，铸造时引用主链尖端） */
  private walTip = GENESIS;
  /** WAL 序号（单调递增 —— 落盘行的对账锚点） */
  private walSeq = 0;
  /** WAL 目录一次保证集（同步通道的按路径记账 —— 与 ensuredDirs 同律） */
  private ensuredWalDirs = new Set<string>();
  // 容量驱逐（shift）把被驱逐条的哈希升格为新链基 —— verify 从链基起重放，
  // 存活窗口内任何篡改仍可定位；被驱逐条目的取证职责由磁盘 JSONL 承载。

  configure(enabled: boolean, filePath: string, capacity: number) {
    this.enabled = enabled;
    this.filePath = filePath;
    this.capacity = capacity;
    this.ensuredDirs.clear(); // 路径可能变更：目录保证随之重置（新路径首写重建）
    this.ensuredWalDirs.clear(); // W2-2（S4）：WAL 同步通道同律重置
  }

  reset() {
    this.entries = [];
    this.chainTip = GENESIS;
    this.chainBase = GENESIS;
    this.taskStartIndex = 0;
    // Δ-6：taskDescription 漏清归零 —— currentTask() 是失败记忆 match 的 query
    // 源与显著度评估的任务向量源，残留上个任务的描述会毒化新会话的两种语义
    this.taskDescription = '';
    this.lastObserved = '';
    // W2-2（S4）：WAL 链一并归零（测试隔离缝 —— 与主链同一确定性基线）
    this.walTip = GENESIS;
    this.walSeq = 0;
    // ΝΩ-45：组提交统计随会话/测试隔离归零（磁盘行不回滚 —— 缓冲行留待
    // flusher 落盘，与旧 diskTail 在途行跨 reset 落盘同律）
    this.diskCounters = { flushes: 0, fsyncs: 0, linesWritten: 0, rotations: 0, droppedLines: 0 };
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
    // ΝΩ-24：防御 catch —— canonical 守卫（环/深度）之外的残余病态向量
    //（BigInt 值、抛错 getter 等 JSON.stringify 硬拒值）在哈希域炸出时，
    // args 降级为安全字符串后重铸；重铸仍败 ⇒ 弃条。观察位通道 fail-open
    //（appendPreDispatch 的 fail-closed 立法见其注记 —— 审计行缺席优于
    // 击穿宿主事件层；弃条时链上前滚从未发生，内存态零残留）。
    try {
      entry.hash = chainHash(this.chainTip, entry);
    } catch (e: any) {
      try {
        entry.args = { degraded: `unserializable args (${String(e?.message ?? e).slice(0, 160)})` };
        entry.hash = chainHash(this.chainTip, entry);
      } catch {
        return;
      }
    }
    this.chainTip = entry.hash;
    this.entries.push(entry);
    if (this.entries.length > this.capacity) {
      const evicted = this.entries.shift()!;
      this.chainBase = evicted.hash ?? GENESIS; // 链基前滚：被驱逐哈希成为新起点
      // 切片边界同步前移：否则 sinceTaskStart 会越界漂移进旧任务区
      this.taskStartIndex = Math.max(0, this.taskStartIndex - 1);
    }

    if (this.filePath) {
      this.enqueueDisk(entry);
    }
  }

  /**
   * ΝΩ-45（组提交）：主 JSONL 行缓冲的入队原语（append 与 appendPreDispatch 共用 ——
   * 后者只是主 JSONL 取证副本入队，其 WAL 先行落盘仍走 appendFileSync 同步通道，
   * W2-2 fail-closed 语义零变化）。入队时快照 filePath（configure 换路径后在途行
   * 不得写进新路径）；序列化失败弃行（旁路义务）。
   *
   * 触发策略（三重，任一先到）：① 缓冲达 QUEUE_LIMIT（256）⇒ 立即同步冲刷（防涨
   * 硬上限）；② 达 FLUSH_BATCH（32）⇒ 本条并入当批立即同步提交；③ 否则排 50ms
   * 周期计时器（unref）。每批一次 open/write/fsync/close —— 旧路径每条 4 syscall，
   * 32 条一批后摊销为 1/32。
   *
   * ── 崩溃窗口论证（选定方案：内存行缓冲 + 组提交，否决 writeSync+定期 fsync 折中）──
   * 取舍面：窗口内进程崩溃 ⇒ 缓冲中 ≤ 上界条数的**主 JSONL 行**丢失（正常上界 32、
   * 防涨上界 256），对照旧路径的每条 fsync（零丢失但每条 4 syscall + 一次 fsync
   * 延迟，高频动作流上不可持续）。为什么有界丢失可接受：
   *   1. 审计底线不由主 JSONL 承担 —— 全部变更类工具的审计行经 appendPreDispatch
   *      的 WAL（appendFileSync 同步写）**先行**落盘（W2-2 语义绝对不变）；WAL 行
   *      自带主链交叉锚 hash，崩溃后审计史以 .wal 为准对账，主 JSONL 缺席的
   *      AUDIT_PRE 行可从 WAL 复原事实。
   *   2. 内存链由 checkpoint 随行持久化；index.ts 卸载链在 saveCheckpoint（collect
   *      前）与 journal.reset（清理前）之间显式 flushJournal()，优雅关闭零丢失。
   *   3. 主 JSONL 的角色是吞吐导向的磁盘取证副本（W2-2 注记原文：「主 JSONL 是
   *      异步批写……吞吐导向，不满足先行性」——组提交正是该立法的兑现）。
   * 否决折中方案（每条 writeSync 进页缓存 + 定期 fsync）：它挡得住进程崩溃、挡不住
   * 断电（页缓存不承诺持久），只省 fsync 不省 open/close，且把「丢行边界」从本处
   * 显式有界的 32/256 行换成 OS 页缓存的隐式承诺 —— 显式有界窗口 + WAL 同步底线
   * 的组合更可论证、可测试（journalDiskStats().buffered 即窗口深度的观测面）。
   */
  private enqueueDisk(entry: JournalEntry): void {
    const filePath = this.filePath;
    let line: string;
    try {
      line = JSON.stringify(entry) + '\n';
    } catch {
      return; // 序列化失败：弃行（与旧实现 write 失败吞错同律的旁路义务）
    }
    this.pendingLines.push({ filePath, line });
    if (this.pendingLines.length >= QUEUE_LIMIT) {
      this.flushDisk(); // 防涨上限：同步清账（批阈值先执法 ⇒ 正常不可达的防御缝）
      return;
    }
    if (this.pendingLines.length >= FLUSH_BATCH) {
      this.flushDisk(); // 批阈值：本条并入当批同步提交
      return;
    }
    if (this.flushTimer === null) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        try {
          this.flushDisk();
        } catch { /* 计时器回调绝不抛（flushDisk 自身全守卫，双保险） */ }
      }, FLUSH_INTERVAL_MS);
      // unref：不阻进程退出；node:test mock.timers 的句柄可能无 unref 面 —— 防御式探测
      if (typeof this.flushTimer.unref === 'function') this.flushTimer.unref();
    }
  }

  /**
   * ΝΩ-45（组提交）：同步成批落盘 —— 取走全部缓冲行，按 filePath 快照分段
   * （configure 换路径的在途行各归各路径，段序 = 入队序），每段一次
   * mkdir（受 ensuredDirs 标志门控）+ 轮转判定 + open('a')/write/fsync/close。
   * 全程无 await ⇒ 无完成倒置窗口，磁盘行序 = 链序（J 纪元不变量）。
   * 绝不抛（每段独立 try/catch，失败弃段并 warn —— 旁路义务不炸调用方，
   * appendPreDispatch 的 fail-closed 只针对其 WAL 步，本方法在其 try 域内
   * 也恒不抛）。返回本次成功落盘行数。
   */
  flushDisk(): number {
    if (this.pendingLines.length === 0) return 0;
    const batch = this.pendingLines;
    this.pendingLines = [];
    let written = 0;
    let i = 0;
    while (i < batch.length) {
      const filePath = batch[i]!.filePath;
      let text = '';
      let lines = 0;
      while (i < batch.length && batch[i]!.filePath === filePath) {
        text += batch[i]!.line;
        lines++;
        i++;
      }
      try {
        // Δ-6：目录保证一次化（按路径记账）—— 每条路径首写建立后入集；
        // mkdir 失败不入集（下次冲刷重试）；追加失败不阻断主流程（旁路义务）
        if (!this.ensuredDirs.has(filePath)) {
          mkdirSync(path.dirname(filePath), { recursive: true });
          this.ensuredDirs.add(filePath);
        }
        // ΝΩ-45：轮转判定先于追加（超限代降为 .1 后新代从本批起算）
        this.rotateIfNeeded(filePath, Buffer.byteLength(text, 'utf8'));
        // 崩溃一致性：fsync 落盘的追加写 —— 页缓存不算落盘；整批一次
        // open/write/fsync/close（组提交摊销），句柄必经 finally 关闭（无泄漏）。
        const fd = openSync(filePath, 'a');
        try {
          writeSync(fd, text, null, 'utf8');
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        written += lines;
        this.diskCounters.flushes += 1;
        this.diskCounters.fsyncs += 1;
        this.diskCounters.linesWritten += lines;
      } catch (e: any) {
        this.diskCounters.droppedLines += lines;
        console.warn(`[Journal] write failed: ${e?.message ?? e}`);
      }
    }
    return written;
  }

  /**
   * ΝΩ-45（JSONL rotation）：size-based 轮转 —— 当前代追加后总字节将超
   * ROTATION_LIMIT_BYTES（5MB）⇒ 先右移一代再追加：.2 出局（unlink）、.1 递补
   * 为 .2、当前代降为 .1，保留 ROTATION_GENERATIONS（2）代。
   *
   * ── 边界诚实注记（只盖当前代）──
   *   · journal.verify() 走内存存活窗口 —— 轮转对其零影响；
   *   · notary 的 journalDisk 磁盘指纹锚（ΝΩ-21）与 R21 复核端只读 journalPath
   *     本尊 ⇒ 锚与指纹**只盖当前代**：轮转后旧誓言前缀迁移进 .1/.2，复核端对
   *     当前代重算只见更少完整行 ⇒ fewer-lines drift 注记（诚实边界，非伪造）；
   *     当前代之外的磁盘取证由 .1/.2 文件本体承载（运维保管面）；
   *   · processScore 等 CLI 消费者按显式路径读 —— 读到的是当前代。
   * 轮转是旁路义务：任何一步失败 ⇒ 照常追加当前代（诚实降级为不轮转），绝不抛。
   */
  private rotateIfNeeded(filePath: string, incomingBytes: number): void {
    try {
      let size = 0;
      try {
        size = statSync(filePath).size;
      } catch {
        return; // 无当前代文件 ⇒ 首写新档，无需轮转
      }
      if (size + incomingBytes <= ROTATION_LIMIT_BYTES) return;
      const oldest = filePath + '.' + ROTATION_GENERATIONS;
      const prev = filePath + '.' + (ROTATION_GENERATIONS - 1);
      try { unlinkSync(oldest); } catch { /* .2 缺席 = 历史更短，右移照常 */ }
      try { renameSync(prev, oldest); } catch { /* .1 缺席同上 */ }
      renameSync(filePath, prev); // 本步失败 ⇒ 外层 catch ⇒ 追加照旧写当前代
      this.diskCounters.rotations += 1;
    } catch {
      /* rotation 失败 ⇒ 不轮转照常追加（旁路义务） */
    }
  }

  /** ΝΩ-45（观测/测试面）：组提交统计快照 + 当前缓冲深度（崩溃窗口的观测面） */
  diskStats(): JournalDiskStats & { buffered: number } {
    return { ...this.diskCounters, buffered: this.pendingLines.length };
  }

  // ── W2-2（S4）：先行审计 WAL —— 派发前 fail-closed 提交通道 ──
  //
  // 语义（write-ahead audit）：变更类工具（click/drag/scroll/type/hotkey）的
  // 审计行必须在**物理派发之前**成为既成事实 —— 「动作可执行」以「审计已入链」
  // 为前提。三步提交，任一步失败 ⇒ ok=false（调用方拒派该动作，fail-closed）：
  //   1. 铸造：AUDIT_PRE 标记 + 主链哈希计算（canonical 序列化可在病态载荷上
  //      抛出 —— 深嵌套/环形参数是对审计面的注入向量，抛出即拒绝，绝不下沉）；
    //   2. WAL 同步落盘：单行 appendFileSync（journalPath + '.wal'，独立轻量通道
    //      —— 主 JSONL 是异步批写（ΝΩ-45 组提交：行缓冲 + 按批 fsync），吞吐导向，
    //      不满足先行性；WAL 是
  //      数据库 write-ahead log 的标准形态：一条小行、同步写、派发前返回）。
  //      无磁盘路径（内存态 journal）⇒ 跳过本步（内存链即事实源）；
  //   3. 内存提交：主链尖端前滚 + entries.push（与 append() 同律，含容量驱逐）
  //      + 异步入队主 JSONL（磁盘取证副本，旁路义务）。
  // 诚实边界：enableJournal=false 是部署配置态而非故障 —— 返回 ok:true +
  //  skipped:'journal-disabled'（审计子系统整体未武装时不得瘫痪全部动作；
  //  fail-closed 只针对「已武装通道的失败」）。绝不抛（防御式：任何意外
  //  异常捕获为 ok:false —— 拒绝派发，把故障暴露给调用方而非静默放行）。
  appendPreDispatch(tool: string, args?: Record<string, unknown>): PreDispatchAuditResult {
    if (!this.enabled) return { ok: true, skipped: 'journal-disabled' };
    try {
      // 步骤 1：铸造 + 主链哈希（不提交 —— WAL 成功后才前滚内存态）
      const entry: JournalEntry = {
        ts: Date.now(), tool: 'AUDIT_PRE',
        args: { tool, ...(args !== undefined ? { args } : {}) },
        status: 'MARKER',
      };
      const hash = chainHash(this.chainTip, entry); // 病态载荷在此抛出 ⇒ fail-closed

      // 步骤 2：WAL 同步落盘（先行性保证：appendFileSync 返回即已交割 OS）
      if (this.filePath) {
        const walPath = this.filePath + '.wal';
        if (!this.ensuredWalDirs.has(walPath)) {
          mkdirSync(path.dirname(walPath), { recursive: true });
          this.ensuredWalDirs.add(walPath);
        }
        this.walSeq += 1;
        const record = {
          v: 1, seq: this.walSeq, ts: entry.ts, tool,
          main_tip_before: this.chainTip,
          prev_wal: this.walTip,
          hash, // 主链将采用的哈希（WAL 行与主链行的交叉锚）
          args: entry.args.args ?? null,
        };
        const walHash = sha256(this.walTip + canonical(record));
        appendFileSync(walPath, JSON.stringify({ ...record, wal_hash: walHash }) + '\n', 'utf8');
        this.walTip = walHash;
      }

      // 步骤 3：内存提交（WAL 既已成功，此处与 append() 的链语义完全同律）
      entry.hash = hash;
      this.chainTip = hash;
      this.entries.push(entry);
      if (this.entries.length > this.capacity) {
        const evicted = this.entries.shift()!;
        this.chainBase = evicted.hash ?? GENESIS;
        this.taskStartIndex = Math.max(0, this.taskStartIndex - 1);
      }
      if (this.filePath) this.enqueueDisk(entry); // 主 JSONL 取证副本（旁路；无磁盘路径 no-op）
      return { ok: true, hash };
    } catch (e: any) {
      // fail-closed 的唯一出口：任何提交失败（哈希抛出/WAL 磁盘错误/…）⇒ ok=false。
      // 内存态在此步之后才前滚 ⇒ 失败路径链上绝无半提交残留。
      return { ok: false, error: String(e?.message ?? e) };
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

  // ── Q 纪元（Q-1 证明层）：MMR 包含证明面（叶值 = 链哈希；纯计算零存储）──
  /** 行动流 MMR 根（O(n) 计算 —— 审计方凭根 + 单条证明即可核验，免整链重放） */
  mmrRoot(): string | null {
    const leaves = this.entries.map(e => e.hash).filter((h): h is string => typeof h === 'string');
    return leaves.length > 0 ? mmrRoot(leaves) : null;
  }

  /** 第 index 条行动的 MMR 包含证明（O(log n) 路径；与 mmrRoot 配对验证） */
  mmrProof(index: number): InclusionProof | null {
    const leaves = this.entries.map(e => e.hash).filter((h): h is string => typeof h === 'string');
    return mmrInclusionProof(leaves, index);
  }

  /** checkpoint 恢复：连同链尖端与链基一起还原（否则后续 append/verify 会误判断链） */
  restoreChain(entries: JournalEntry[], chainTip?: string, chainBase?: string): void {
    this.entries = entries;
    this.chainTip = chainTip ?? entries.at(-1)?.hash ?? GENESIS;
    this.chainBase = chainBase ?? GENESIS;
    this.taskStartIndex = 0;
    // Δ-6 同律：checkpoint 不随行任务语境 —— 残留旧任务的描述会毒化恢复后
    // currentTask() 的失败记忆 query 源与因果桥观察（诚实态 = 无任务语境）
    this.taskDescription = '';
    this.lastObserved = '';
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
      // T 纪元（T-5）：路线率 + 效应量 —— 同场景全池（非切片）统计每条异路线的
      // Laplace 成功率，最优异路线 vs 本路线的 Cohen's h（R-6 器官传播）——
      // 「换这条路好多少」从定性变定量（|h|≥0.5 中效应、≥0.8 大效应）。
      const sameScenePool = scene
        ? this.entries.filter(e => e !== entry && e.observe === scene && ACTION_TOOLS.includes(e.tool))
        : [];
      const alternatives: CounterfactualAlternative[] = sameScenePool
            .slice(-5)
            .map(e => {
              const routeKey = e.tool;
              const route = sameScenePool.filter(x => x.tool === routeKey);
              const wins = route.filter(x => x.status === 'SUCCESS' && x.effect_detected !== false).length;
              const routeRate = (wins + 1) / (route.length + 2); // Laplace 后验
              return {
                action: `${e.tool} ${JSON.stringify(e.args).slice(0, 80)}`,
                historicalOutcome: e.status === 'SUCCESS'
                  ? (e.effect_detected === false ? 'UNKNOWN' : 'SUCCESS')
                  : e.status === 'FAILED' ? 'FAILED' : 'UNKNOWN',
                evidence: `journal: same scene (${(scene ?? '').slice(0, 40)}...) → ${e.status}` +
                  (e.effect_detected === false ? ' (no visual effect)' : '') +
                  ` | route rate ${(routeRate * 100).toFixed(0)}% (n=${route.length}, Laplace)`,
                routeRate: Math.round(routeRate * 1000) / 1000,
                routeN: route.length,
              } as CounterfactualAlternative;
            });
      // 本路线率（同场景同工具）与最优异路线的 h
      let effectH: number | null = null;
      if (scene) {
        const sameTool = sameScenePool.filter(x => x.tool === entry.tool);
        const curWins = sameTool.filter(x => x.status === 'SUCCESS' && x.effect_detected !== false).length + 1;
        const curRate = curWins / (sameTool.length + 2);
        const bestAlt = alternatives.reduce<CounterfactualAlternative | null>(
          (best, a) => (a.routeRate !== undefined && (!best || a.routeRate > (best.routeRate ?? 0)) ? a : best), null);
        if (bestAlt?.routeRate !== undefined) {
          effectH = cohensH(bestAlt.routeRate, curRate);
        }
      }
      return {
        index: actionIndex,
        entry,
        thought: entry.thought ?? null,
        alternatives,
        /** T-5：最优异路线 vs 本路线的 Cohen's h（null = 任一侧证据不足） */
        effectH,
      };
    });
  }
}

export const journal = new ActionJournal();

// ─── ΝΩ-45：组提交的显式冲刷与观测面 ───

/**
 * ΝΩ-45：显式冲刷 API —— 组提交窗口的确定性清账点。生产接入位（index.ts 卸载链）：
 * notary 磁盘旁链锚与 saveCheckpoint（collect 读内存链）之前、journal.reset（清理）
 * 之前 —— 保证磁盘取证副本与锚/快照看到同一份链尾。返回本次落盘行数；绝不抛
 * （flushDisk 全守卫，此处防御式双保险）。
 */
export function flushJournal(): number {
  try {
    return journal.flushDisk();
  } catch {
    return 0;
  }
}

/** ΝΩ-45（观测/测试面）：组提交统计快照（含缓冲深度 —— 崩溃窗口上界的观测锚点） */
export function journalDiskStats(): JournalDiskStats & { buffered: number } {
  try {
    return journal.diskStats();
  } catch {
    return { flushes: 0, fsyncs: 0, linesWritten: 0, rotations: 0, droppedLines: 0, buffered: 0 };
  }
}

// ─── W4-0（E 接线）：动作验证实证三字段的防御提取 ───

/**
 * W4-0（E）：从工具返回的 state_anchor.effect 防御直录 scale / intent /
 * phashCorroborates（缺席 ⇒ 三键不落 —— 旧工具/验证关闭的面零污染）。任何
 * 解析故障 ⇒ 空对象（旁路义务：实证提取绝不炸日志管线）。
 */
function verifyEvidenceOf(result: unknown): Pick<JournalEntry, 'scale' | 'intent' | 'phashCorroborates'> {
  const out: Pick<JournalEntry, 'scale' | 'intent' | 'phashCorroborates'> = {};
  try {
    if (typeof result !== 'string') return out;
    const obj = JSON.parse(result) as {
      state_anchor?: { effect?: Record<string, unknown> | string };
    };
    const eff = obj?.state_anchor?.effect;
    if (!eff || typeof eff !== 'object' || Array.isArray(eff)) return out;
    if (eff.scale === 'page-level' || eff.scale === 'element-level' || eff.scale === 'none') {
      out.scale = eff.scale;
    }
    const it = eff.intent;
    if (it && typeof it === 'object' && !Array.isArray(it)) {
      const r = it as { expected?: unknown; satisfied?: unknown; evidence?: unknown };
      if (typeof r.satisfied === 'boolean') {
        out.intent = {
          expected: typeof r.expected === 'string' ? r.expected : '',
          satisfied: r.satisfied,
          evidence: typeof r.evidence === 'string' ? r.evidence : '',
        };
      }
    }
    if (typeof eff.phashCorroborates === 'boolean') out.phashCorroborates = eff.phashCorroborates;
    return out;
  } catch {
    return out;
  }
}

/** 以观察者身份挂进工具管线：记录一切动作类调用 */
export function registerJournalGuard(ctx: Context, config: Config): void {
  journal.configure(config.enableJournal, config.journalPath, 1000);
  onToolPost(ctx, async (call, result, next) => {
    // ΝΩ-24：观察位守卫防御收口 —— 记录路径的任何异常（残余病态 args、
    // 契约外形状）就地吞除，绝不击穿到宿主事件层；next 在 try 之外：守卫
    // 自身失败也必须原样透传工具结果（纯观察的旁路义务 —— 旧实现异常时
    // next 不被调用，管线被观察者带崩）。
    try {
      const c = classifyResult(result); // B-2：统一契约解析
      // C-3 因果链注入：思考来自模型行动前的出声思考，观察来自最近截图锚点
      // W4-0（E）：动作验证实证三字段顶层直录（state_anchor.effect → 链上行）
      await journal.append({
        ts: Date.now(), tool: call.name, args: call.args,
        status: c.status, effect_detected: c.effectDetected,
        ...verifyEvidenceOf(result),
        thought: typeof call.args?.reasoning === 'string' && call.args.reasoning.trim()
          ? call.args.reasoning.trim().slice(0, 500) // 思考预算：防长篇推理反噬 Token
          : undefined,
        observe: journal.lastObservation(),
      });
    } catch {
      /* 弃条降级：审计行缺席，工具结果不受影响 */
    }
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
  /** T-5：该异路线在同场景的 Laplace 成功率（同场景全池统计） */
  routeRate?: number;
  /** T-5：该路线的同场景样本数 */
  routeN?: number;
}

export interface DecisionPoint {
  /** 存活窗口内的条目索引（时光倒流的重放起点） */
  index: number;
  entry: JournalEntry;
  /** 当时的思考（可能缺失 —— 模型未声明 reasoning 时证据降级） */
  thought: string | null;
  alternatives: CounterfactualAlternative[];
  /** T-5：最优异路线 vs 本路线的 Cohen's h（null = 任一侧证据不足） */
  effectH?: number | null;
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
 * n < 4 ⇒ null（统计诚实下限）；α < 2（单字母表）⇒ 0（周期 1 极限态，
 * log₂(1)=0 的除零安全等价 —— 见下行实现注释）。
 */
export function normalizedActionComplexity(seq: readonly string[]): number | null {
  const n = seq.length;
  if (n < 4) return null;
  const alpha = new Set(seq).size;
  if (alpha < 2) return 0; // 单字母表 = 完全确定（熵率恒 0 —— 周期 1 的极限态）
  const c = lempelZivComplexity(seq);
  return Math.round((c * Math.log2(n)) / (n * Math.log2(alpha)) * 1000) / 1000;
}
