// src/checkpoint.ts
// 第七轮创新之三：全认知状态快照（可恢复支柱）。
// 前六轮建造了四个记忆系统（UI 记忆 / 技能库 / 失败记忆 / 行动日志链），
// 但它们各自为政 —— 进程一崩，会话级认知全部蒸发（技能库虽有落盘，其余没有）。
// 本模块把全部认知态收敛为单一版本化 JSON 快照：
//   saveCheckpoint   —— 原子写（tmp + rename）：要么完整旧档，要么完整新档，绝无半档
//   loadCheckpoint   —— 版本校验 + 逐子系统恢复；单字段损坏不拖垮整档（防御性恢复）
// 接线：启动时自动恢复（checkpointPath 配置时）+ 卸载时自动保存 + save_checkpoint 手动档。
// 价值：崩溃/重启后，Agent 的「肌肉记忆」原地满血 —— 会话可中断，认知不回零。
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync, openSync, writeSync, fsyncSync, closeSync } from 'fs';
import path from 'path';
import { uiMemory } from './uiMemory';
import { probeMemory } from './probeMemory';
import { skillLibrary } from './skillLibrary';
import { failureMemory } from './failureMemory';
import { telemetry } from './telemetry';
import { journal } from './journal';
import { contextManager } from './contextManager';
import { swarm } from './swarm';
import { coordinator } from './subAgent';
import { shaper } from './environmentShaper';
import { quantum } from './quantumSense';
import type { JournalEntry } from './journal';
import type { SubAgentState } from './subAgent';
import type { UndoRecord } from './environmentShaper';
import type { QuantumSnapshot } from './quantumSense';
import { sandboxLog } from './sandbox/log';
import { selfModel } from './selfmodel/index';
import { approvalQueue } from './approval';
import type { QueuedApprovalEntry } from './approval';
// W3-6（H3）：岔路账采集面 —— 每步决策的 Top-K 候选环形账（见 src/branchCards.ts）
import { branchLedger } from './branchCards';
import type { BranchLedgerSnapshot } from './branchCards';

// v3：新增 swarmAgents section（D-1 子代理花名册 + 报告 —— 崩溃后团队原地满血复活）。
// v2：新增 contextManager（潜意识池）与 swarm（经验晶体/漂移模型）section。
// 加载兼容 v1/v2 旧档：migrateCheckpoint 幂等归一化（见其注释），缺省 section 防御性跳过。
// 纪元 Ζ 缝隙闭合（自我模型未持久化）：selfModel 段为**第四次原地扩展**（D-1/D-2/D-3
// 同律 —— 加性可选段 + 防御水合免版本跃迁；shaper/quantum 先例在案）。版本字段
// 保持在 4 的另一面是契约现实：epochR/agency 执法册逐字节钉住「v4 落盘」与
// migrate(v3)=v4（本纪元禁改测试），而旧引擎读到多出的 selfModel 键只会静默
// 忽略（sections 表只触已知键）—— 原地扩展双向兼容，版本跃迁反而撕裂契约。
const CHECKPOINT_VERSION = 4;

interface Checkpoint {
  version: number;
  savedAt: number;
  uiMemory: ReturnType<typeof uiMemory.dump>;
  /** Z-1d 判决记忆（原地扩展：快照存活 ⇒ 崩溃后免重实验） */
  probeMemory?: ReturnType<typeof probeMemory.dump>;
  skillLibrary: ReturnType<typeof skillLibrary.dump>;
  failureMemory: ReturnType<typeof failureMemory.dump>;
  journal: { entries: JournalEntry[]; chainTip: string; chainBase: string };
  telemetry: ReturnType<typeof telemetry.dump>;
  // ── v2 ──
  contextManager?: { subconscious: ReturnType<typeof contextManager.dumpSubconscious> };
  swarm?: ReturnType<typeof swarm.dump>;
  // ── v3 ──
  swarmAgents?: SubAgentState[];
  /** D-2 撤销日志（原地扩展：v3 刚诞生无存量档案，免版本跃迁；迁移函数零改动） */
  shaper?: { undoLog: UndoRecord[] };
  /** D-3 感知相位（第三次原地扩展：叠加态跨崩溃存活 —— 急救未完不中断） */
  quantum?: QuantumSnapshot;
  // ── v4（R 纪元 R-4 快照层）──
  /** 证据锚：journal MMR 根（快照时刻的行动流默克尔根 —— 恢复时与重算根
   * 对照 = 快照-证据一致性的防篡改锚；v3 旧档无此字段 ⇒ 迁移补 null） */
  journalMmrRoot?: string | null;
  /** 证据锚：排练链 MMR 根（同律） */
  sandboxMmrRoot?: string | null;
  // ── 纪元 Ζ（原地扩展）──
  /** 自我模型账本（Ι 单例的纯数据快照 —— 经验胜任度后验跨崩溃存活）：
   * 旧档缺段 = 诚实冷启动（空账本）；结构坏段 = SKIPPED + 空模型（坏段隔离
   * 不连坐）；段内坏行 = 半水合（好行入账，Ι 纪元 restore 语义） */
  selfModel?: ReturnType<typeof selfModel.dump>;
  /** W2-1（H4 暂存式离线批准队列·第五次原地扩展）：待批/已批未续跑条目随档
   * 存活 —— 崩溃后晨报照常列出待批清单、已批条目照常可续跑。会话恢复主源
   * （队列另有独立的文件持久化面 —— 见 approval.ts W2-1 段两层互补注记）；
   * 缺段 = 队列不动（W2-1 前旧档 / 未武装）；结构坏段 = 归零冷启动；
   * 段内坏条目 = 弃置保好（防御性恢复，垃圾值归零不连坐）。 */
  approvalQueue?: { entries: QueuedApprovalEntry[] };
  /** W3-6（H3 反事实岔路账·第六次原地扩展）：每步决策的 Top-K 候选岔路环形账
   *  —— goal 失败/中止后由 branchCards.generateBranchCard 铸岔路卡、
   *  applyBranchChoice 换支重放（Ghost Replay 纠偏）。缺段 = 空账（W3-6 前
   *  旧档 / 未武装 ⇒ 卡片诚实缺席）；结构坏段 = 归零 + SKIPPED；段内坏步 =
   *  弃置保好（防御性恢复，与 approvalQueue 同律）。
   *  版本钉决议：沿 W2-1 原地扩展律保持 CHECKPOINT_VERSION=4 —— epochR/agency
   *  执法册逐字节钉「v4 落盘」与 migrate 幂等靶（本纪元禁改测试），升版撕裂
   *  契约；旧引擎读到多出的 branchLedger 键只会静默忽略。段结构自带版本钉
   *  （BranchLedgerSnapshot.version），段内演化只升段钉。 */
  branchLedger?: BranchLedgerSnapshot;
}

/**
 * 幂等迁移管线（架构师指令 #3）：v? → v3。
 * 每步先查版本字段再动手；字段已存在 = no-op；重复执行（对迁移结果再迁移）永不报错。
 * 未知版本返回 null —— 由调用方以版本不匹配拒绝（拒绝恢复的既有语义保留）。
 */
export function migrateCheckpoint(raw: unknown): Checkpoint | null {
  if (!raw || typeof raw !== 'object') return null;
  let r = raw as Record<string, any>;
  if (r.version === 4) return r as Checkpoint; // 已是目标形态：原样透传（幂等性根基）
  if (r.version === 1 || r.version === 2) {
    // 缺省字段补默认而非报错：v1 无 contextManager/swarm、v2 无 swarmAgents —— 全部 no-op 填充。
    // 结构性收窄由调用方的防御性恢复兜底（单 section 损坏不拖垮整档）。
    r = { ...r, swarmAgents: Array.isArray(r.swarmAgents) ? r.swarmAgents : [] };
  }
  if (r.version >= 1 && r.version <= 3) {
    // v1/v2/v3 → v4（R-4）：缺省字段补默认（swarmAgents 等）+ 证据锚补 null
    //（旧档无 MMR 根 —— 诚实缺席不虚造）；幂等 —— 重复迁移结构不变。
    return { ...r, version: 4, journalMmrRoot: r.journalMmrRoot ?? null, sandboxMmrRoot: r.sandboxMmrRoot ?? null } as Checkpoint;
  }
  return null;
}

/**
 * 收集全认知态。日志链尖端与链基随行 —— 恢复后 append 续链、verify 不误报。
 * 纪元 Ζ 旁路律：selfModel 段以独立 try/catch 采集 —— 单例 dump 面（按 Ι 纪元
 * 立法永不抛）万一故障，只记入 warnings 诚实跳过，绝不炸 checkpoint 主流程
 * （持久化是旁路：失败 = 诚实跳过，绝不炸睡眠/卸载路径的保存链）。
 */
function collect(): { cp: Checkpoint; warnings: string[] } {
  const warnings: string[] = [];
  let selfModelSnap: Checkpoint['selfModel'];
  try {
    selfModelSnap = selfModel.dump();
  } catch (e: any) {
    selfModelSnap = undefined; // 缺段落盘 = 恢复时诚实冷启动
    warnings.push(`selfModel: SKIPPED (dump 故障旁路吸收: ${e?.message ?? e})`);
  }
  // W2-1（H4）：待批队列随档 —— 采集面自带防御（dumpQueue 绝不抛），
  // try/catch 与 selfModel 同律（旁路故障 = 缺段诚实跳过，绝不炸保存链）
  let approvalQueueSnap: Checkpoint['approvalQueue'];
  try {
    approvalQueueSnap = { entries: approvalQueue.dumpQueue() };
  } catch (e: any) {
    approvalQueueSnap = undefined; // 缺段落盘 = 恢复时队列不动
    warnings.push(`approvalQueue: SKIPPED (dump 故障旁路吸收: ${e?.message ?? e})`);
  }
  // W3-6（H3）：岔路账随档 —— 同律旁路采集（dump 恒出深拷贝，绝不抛；
  // 万一故障 = 缺段诚实跳过，恢复时空账冷启动）
  let branchLedgerSnap: Checkpoint['branchLedger'];
  try {
    branchLedgerSnap = branchLedger.dump();
  } catch (e: any) {
    branchLedgerSnap = undefined; // 缺段落盘 = 恢复时空账（卡片诚实缺席）
    warnings.push(`branchLedger: SKIPPED (dump 故障旁路吸收: ${e?.message ?? e})`);
  }
  return {
    cp: {
      version: CHECKPOINT_VERSION,
      savedAt: Date.now(),
      uiMemory: uiMemory.dump(),
      probeMemory: probeMemory.dump(),
      skillLibrary: skillLibrary.dump(),
      failureMemory: failureMemory.dump(),
      journal: { entries: journal.list(false), chainTip: journal.tip, chainBase: journal.base },
      telemetry: telemetry.dump(),
      // v2：群体经验先行结晶再入档（结晶是纯内存聚合，同步微秒级）
      contextManager: { subconscious: contextManager.dumpSubconscious() },
      swarm: (() => { swarm.crystalize(); return swarm.dump(); })(),
      // v3：D-1 子代理花名册 + 报告 —— 崩溃后团队原地满血复活
      swarmAgents: coordinator.dump(),
      // D-2：撤销日志随行 —— 崩溃后复原义务不蒸发
      shaper: { undoLog: shaper.dumpUndoLog() },
      // D-3：感知相位随行 —— 叠加态急救跨崩溃续行
      quantum: quantum.dump(),
      // R-4：证据锚 —— 快照与证据链的一致性锚（恢复时可验：重算 MMR 根 == 锚）
      journalMmrRoot: journal.mmrRoot(),
      sandboxMmrRoot: sandboxLog.mmrRoot(),
      // 纪元 Ζ：自我模型账本随行 —— 经验胜任度后验跨崩溃存活（重启不清零）
      selfModel: selfModelSnap,
      // W2-1（H4）：待批/已批未续跑条目随行 —— 崩溃后队列原地满血（晨报照常
      // 列待批清单、已批条目照常续跑）
      approvalQueue: approvalQueueSnap,
      // W3-6（H3）：岔路账随行 —— 崩溃后岔路账原地满血（失败铸卡/换支重放
      // 不因重启而失去支点）
      branchLedger: branchLedgerSnap,
    },
    warnings,
  };
}

/** 原子写：先写临时文件再改名。写一半崩溃 ⇒ 旧档完好，新档不存在，绝无损坏的半档 */
export function saveCheckpoint(filePath: string): { ok: boolean; steps?: number; error?: string; warnings?: string[] } {
  if (!filePath) return { ok: false, error: 'checkpointPath is not configured' };
  const { cp, warnings } = collect();
  const tmp = filePath + '.tmp';
  try {
    mkdirSync(path.dirname(filePath), { recursive: true });
    // fsync 落盘后再换名：rename 可先于数据块持久化 —— 崩溃后可能读到空/截断档
    //（与 journal.ts 磁盘写的崩溃一致性同律：页缓存不算落盘）
    const fd = openSync(tmp, 'w');
    try {
      writeSync(fd, Buffer.from(JSON.stringify(cp), 'utf8'));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, filePath); // 原子换名
    // 纪元 Ζ：旁路 warnings（如 selfModel dump 故障）随行上报 —— 保存照常 ok
    return { ok: true, steps: cp.journal.entries.length, ...(warnings.length > 0 ? { warnings } : {}) };
  } catch (e: any) {
    try { unlinkSync(tmp); } catch { /* tmp 可能未创建 */ }
    return { ok: false, error: e.message };
  }
}

/** 防御性恢复：逐子系统独立 try-catch，单点损坏不拖垮整档；返回逐项恢复报告 */
export function loadCheckpoint(filePath: string): { restored: boolean; report: string[] } {
  if (!filePath || !existsSync(filePath)) return { restored: false, report: ['no checkpoint file'] };
  const report: string[] = [];
  let cp: Checkpoint;
  try {
    cp = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (e: any) {
    return { restored: false, report: [`checkpoint unreadable: ${e.message}`] };
  }
  if (cp.version !== CHECKPOINT_VERSION) {
    // 版本策略：v1/v2 旧档经幂等迁移归一为 v3；未知版本拒绝（拒绝恢复的既有语义）
    const migrated = migrateCheckpoint(cp);
    if (!migrated) {
      return { restored: false, report: [`version mismatch: file=${cp.version} engine=${CHECKPOINT_VERSION}`] };
    }
    cp = migrated;
  }

  const sections: Array<[string, () => void]> = [
    ['uiMemory', () => uiMemory.restore(cp.uiMemory)],
    ['probeMemory', () => probeMemory.restore(cp.probeMemory)],
    ['skillLibrary', () => skillLibrary.restore(cp.skillLibrary)],
    ['failureMemory', () => failureMemory.restore(cp.failureMemory)],
    ['journal', () => {
      // S 纪元（S-1）：证据锚验证（R-4 的另一半）—— 恢复后重算 MMR 根与锚对照；
      // 不等 ⇒ 条目被改/锚错配（篡改或档案损坏），响亮报告（防御性恢复策略：
      // 照常恢复但报告置顶 —— 单 section 报告不阻断其余恢复）。
      journal.restoreChain(cp.journal.entries, cp.journal.chainTip, cp.journal.chainBase);
      if (typeof cp.journalMmrRoot === 'string' && journal.mmrRoot() !== cp.journalMmrRoot) {
        report.unshift(`EVIDENCE ANCHOR MISMATCH: journal MMR root after restore != snapshot anchor (entries tampered or stale anchor) — evidence chain integrity untrusted`);
      }
    }],
    ['telemetry', () => telemetry.restore(cp.telemetry)],
    // v2 sections：v1 旧档缺省时静默跳过（防御性恢复的红利）
    ['contextManager', () => contextManager.restoreSubconscious(cp.contextManager?.subconscious)],
    ['swarm', () => swarm.restore(cp.swarm)],
    // v3 section：子代理团队复活
    ['subAgents', () => coordinator.restore(cp.swarmAgents)],
    // D-2 section：撤销义务复活（未复原条目重新领责）
    ['shaper', () => shaper.restoreUndoLog(cp.shaper?.undoLog)],
    // D-3 section：感知相位复活
    ['quantum', () => quantum.restore(cp.quantum)],
    // 纪元 Ζ section：自我模型账本复活（坏段隔离不连坐 —— 沿本表防御水合风格）：
    //   缺段（Ζ 前旧档）⇒ 不触账本（新进程即空模型 = 诚实冷启动，非错误）；
    //   结构坏段（非对象/cells 非数组）⇒ 清账 + 上抛 ⇒ 本表 catch 记 SKIPPED（空模型）；
    //   段内坏行 ⇒ Ι 单例 restore 的半水合语义（好行入账、坏行弃置）。
    ['selfModel', () => {
      if (cp.selfModel === undefined) return;
      const snap = cp.selfModel as unknown;
      if (!snap || typeof snap !== 'object' || !Array.isArray((snap as { cells?: unknown }).cells)) {
        selfModel.reset(); // 坏段 ⇒ 空模型（不残留进程内旧账冒充恢复产物）
        throw new Error('selfModel 段结构非法（弃置 ⇒ 空模型冷启动）');
      }
      selfModel.restore(cp.selfModel);
    }],
    // W2-1（H4）section：待批队列复活（防御性恢复 —— 垃圾值归零）：
    //   缺段（W2-1 前旧档）⇒ 不触队列（新进程即空队列，非错误）；
    //   结构坏段（非对象 / entries 非数组）⇒ 队列归零 + 上抛 ⇒ SKIPPED 注记；
    //   段内坏条目 ⇒ 弃置保好（dropped 计数进报告 —— 好条目照常恢复）。
    ['approvalQueue', () => {
      if (cp.approvalQueue === undefined) return;
      const snap = cp.approvalQueue as unknown as { entries?: unknown } | null;
      if (!snap || typeof snap !== 'object' || !Array.isArray(snap.entries)) {
        approvalQueue.restoreQueue([]); // 垃圾段 ⇒ 归零（不残留进程内旧账冒充恢复产物）
        throw new Error('approvalQueue 段结构非法（弃置 ⇒ 空队列冷启动）');
      }
      const r = approvalQueue.restoreQueue(snap.entries);
      if (r.dropped > 0) {
        report.push(`approvalQueue: DROPPED ${r.dropped} malformed entr${r.dropped === 1 ? 'y' : 'ies'} (defensive restore, garbage zeroed)`);
      }
    }],
    // W3-6（H3）section：岔路账复活（防御性恢复 —— 垃圾归零、坏步弃置保好）：
    //   缺段（W3-6 前旧档）⇒ 不触账（新进程即空账 = 诚实冷启动，非错误）；
    //   结构坏段（非对象 / entries 非数组）⇒ 归零 + 上抛 ⇒ SKIPPED 注记；
    //   段内坏步 ⇒ 弃置保好（dropped 计数进报告 —— 好步照常恢复）。
    //   注：restore 收**段对象**（BranchLedgerSnapshot 形状）—— 与
    //   approvalQueue.restoreQueue 收条目数组的约定不同，错配会静默 no-op。
    ['branchLedger', () => {
      if (cp.branchLedger === undefined) return;
      const snap = cp.branchLedger as unknown as { entries?: unknown } | null;
      if (!snap || typeof snap !== 'object' || !Array.isArray(snap.entries)) {
        branchLedger.restore(null); // 垃圾段 ⇒ 归零（不残留进程内旧账冒充恢复产物）
        throw new Error('branchLedger 段结构非法（弃置 ⇒ 空账冷启动）');
      }
      const r = branchLedger.restore(snap);
      if (r.dropped > 0) {
        report.push(`branchLedger: DROPPED ${r.dropped} malformed step${r.dropped === 1 ? '' : 's'} (defensive restore, garbage zeroed)`);
      }
    }],
  ];
  for (const [name, fn] of sections) {
    try {
      fn();
      report.push(`${name}: OK`);
    } catch (e: any) {
      report.push(`${name}: SKIPPED (${e.message})`);
    }
  }
  return { restored: true, report };
}
