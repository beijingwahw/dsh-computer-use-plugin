// src/checkpoint.ts
// 第七轮创新之三：全认知状态快照（可恢复支柱）。
// 前六轮建造了四个记忆系统（UI 记忆 / 技能库 / 失败记忆 / 行动日志链），
// 但它们各自为政 —— 进程一崩，会话级认知全部蒸发（技能库虽有落盘，其余没有）。
// 本模块把全部认知态收敛为单一版本化 JSON 快照：
//   saveCheckpoint   —— 原子写（tmp + rename）：要么完整旧档，要么完整新档，绝无半档
//   loadCheckpoint   —— 版本校验 + 逐子系统恢复；单字段损坏不拖垮整档（防御性恢复）
// 接线：启动时自动恢复（checkpointPath 配置时）+ 卸载时自动保存 + save_checkpoint 手动档。
// 价值：崩溃/重启后，Agent 的「肌肉记忆」原地满血 —— 会话可中断，认知不回零。
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from 'fs';
import path from 'path';
import { uiMemory } from './uiMemory';
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

// v3：新增 swarmAgents section（D-1 子代理花名册 + 报告 —— 崩溃后团队原地满血复活）。
// v2：新增 contextManager（潜意识池）与 swarm（经验晶体/漂移模型）section。
// 加载兼容 v1/v2 旧档：migrateCheckpoint 幂等归一化（见其注释），缺省 section 防御性跳过。
const CHECKPOINT_VERSION = 3;

interface Checkpoint {
  version: number;
  savedAt: number;
  uiMemory: ReturnType<typeof uiMemory.dump>;
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
}

/**
 * 幂等迁移管线（架构师指令 #3）：v? → v3。
 * 每步先查版本字段再动手；字段已存在 = no-op；重复执行（对迁移结果再迁移）永不报错。
 * 未知版本返回 null —— 由调用方以版本不匹配拒绝（拒绝恢复的既有语义保留）。
 */
export function migrateCheckpoint(raw: unknown): Checkpoint | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, any>;
  if (r.version === 3) return r as Checkpoint; // 已是目标形态：原样透传（幂等性根基）
  if (r.version === 1 || r.version === 2) {
    // 缺省字段补默认而非报错：v1 无 contextManager/swarm、v2 无 swarmAgents —— 全部 no-op 填充。
    // 结构性收窄由调用方的防御性恢复兜底（单 section 损坏不拖垮整档）。
    return { ...r, version: 3, swarmAgents: Array.isArray(r.swarmAgents) ? r.swarmAgents : [] } as Checkpoint;
  }
  return null;
}

/** 收集全认知态。日志链尖端与链基随行 —— 恢复后 append 续链、verify 不误报 */
function collect(): Checkpoint {
  return {
    version: CHECKPOINT_VERSION,
    savedAt: Date.now(),
    uiMemory: uiMemory.dump(),
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
  };
}

/** 原子写：先写临时文件再改名。写一半崩溃 ⇒ 旧档完好，新档不存在，绝无损坏的半档 */
export function saveCheckpoint(filePath: string): { ok: boolean; steps?: number; error?: string } {
  if (!filePath) return { ok: false, error: 'checkpointPath is not configured' };
  const cp = collect();
  const tmp = filePath + '.tmp';
  try {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(tmp, JSON.stringify(cp), 'utf8');
    renameSync(tmp, filePath); // 原子换名
    return { ok: true, steps: cp.journal.entries.length };
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
    ['skillLibrary', () => skillLibrary.restore(cp.skillLibrary)],
    ['failureMemory', () => failureMemory.restore(cp.failureMemory)],
    ['journal', () => journal.restoreChain(cp.journal.entries, cp.journal.chainTip, cp.journal.chainBase)],
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
