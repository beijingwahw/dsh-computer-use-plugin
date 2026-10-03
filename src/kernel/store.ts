// src/kernel/store.ts
// 纪元 Ξ（Ξ-A 进化存档）：内核进化成果（值 / 证据计数 / 代际）的跨会话存档。
//
// 三条先例律（本器官一字不违）：
//   · 原子写照 src/checkpoint.ts 的 saveCheckpoint（tmp + rename）——
//     写一半崩溃 ⇒ 旧档完好、新档不存在，绝无损坏的半档；
//   · 目录一次化照 src/journal.ts 的 dirEnsured（Δ-6）—— 首写 recursive mkdir
//     一次建立后置位（失败不置位下次重试），高频保存不做重复系统调用；
//   · 垃圾输入静默降级、绝不抛 —— load 读失败 / 坏 JSON 一律 null，
//     applyTo 对未注册 key / 畸形值静默跳过（与 registry.restore 同律：
//     存档可含历史残迹，恢复面只认当前注册表）。
//
// 与 checkpoint（全认知态快照）的分工：checkpoint 管会话级认知（记忆 / 技能 /
// 日志链），本档只管内核注册表的进化三账（params / evidence / generations）——
// 证据账本（EvidenceLedger）的 200 条滑窗是运行时证据流，不含逐条 outcome 的
// 存档无法也不应重建它（ledger 参数仅为与 save/applyTo 接线对称而在场，见 JSDoc）。
// 纯同步 fs（与 checkpoint 同律 —— 落盘是低频旁路，不值得异步化）。

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from 'fs';
import path from 'path';
import type { KernelRegistry, EvidenceLedger, KernelParam } from './registry.js';

/**
 * 存档文件形态：全册三账的平面快照（key → 数值）。
 *   - params：现值（applyTo 经 registry.set 夹取回放 —— 区间不变式在恢复侧续存）；
 *   - evidence：证据累计计数（applyTo 经 addEvidence 增量补 —— 计数是历史，不重置）；
 *   - generations：演化代际（**只存不回放** —— registry 无公开写 API，见 applyTo JSDoc）。
 */
export interface KernelStateFile {
  /** 存档时刻（epoch ms；save 的 now 参数可注入） */
  savedAt: number;
  /** key → 现值 */
  params: Record<string, number>;
  /** key → 证据累计计数 */
  evidence: Record<string, number>;
  /** key → 演化代际（审计面；加载侧不回放） */
  generations: Record<string, number>;
}

/** 平面数值账的消毒：只保留「非空字符串 key → 有限数值」的条目（其余静默剔除） */
function sanitizeRecord(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k === '') continue;
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/**
 * 内核进化存档：save（原子落盘）/ load（防御读档）/ applyTo（回放进注册表）。
 * 空 filePath = 纯内存模式：save 是 no-op（ok:true）、load 恒 null —— 缺省
 * config（kernelStatePath ''）下零 IO、零行为变化。
 */
export class KernelStore {
  /** 存档路径（构造即定，不可变 —— 空串/非字符串归一为 null = 纯内存） */
  private readonly _filePath: string | null;
  /** 目录一次保证标志（journal Δ-6 律：首写建立后置位；mkdir 失败不置位下次重试） */
  private dirEnsured = false;

  constructor(filePath?: string) {
    this._filePath = typeof filePath === 'string' && filePath !== '' ? filePath : null;
  }

  /** 存档路径（纯内存 ⇒ null） */
  get filePath(): string | null {
    return this._filePath;
  }

  /**
   * 落盘（tmp + rename 原子写，checkpoint 同律）：
   *   - 纯内存（空路径）⇒ { ok: true } 的 no-op —— 不触盘；
   *   - 三账取自 registry.list() 的防御副本（key 非空、数值非有限者静默剔除）；
   *   - ledger 在场不消费：滑窗不可序列化为平面数值账（接口对称性保留 ——
   *     宿主接线 save(registry, ledger) 无需条件分支）；
   *   - now 可注入（确定性测试）；缺省 Date.now；
   *   - 目录一次化：首次 save recursive mkdir 后置位，此后直写；
   *   - 任何 IO 故障 ⇒ { ok: false, error }（tmp 尽力清理，绝不抛）。
   */
  save(registry: KernelRegistry, ledger: EvidenceLedger, now?: number): { ok: boolean; error?: string } {
    if (!this._filePath) return { ok: true }; // 纯内存：诚实 no-op（无档可写不是错误）
    const tmp = this._filePath + '.tmp';
    try {
      const state: KernelStateFile = {
        savedAt: typeof now === 'number' && Number.isFinite(now) ? now : Date.now(),
        params: {},
        evidence: {},
        generations: {},
      };
      const params = registry?.list?.() ?? [];
      for (const p of params) {
        if (!p || typeof p.key !== 'string' || p.key === '') continue;
        state.params[p.key] = Number.isFinite(p.value) ? p.value : 0;
        state.evidence[p.key] = Number.isFinite(p.evidence) ? p.evidence : 0;
        state.generations[p.key] = Number.isFinite(p.generation) ? p.generation : 0;
      }
      try {
        if (!this.dirEnsured) {
          mkdirSync(path.dirname(this._filePath), { recursive: true });
          this.dirEnsured = true; // 建立一次即置位；失败走 catch 不置位（下次重试）
        }
      } catch {
        /* mkdir 失败不在此报错：交给 writeFileSync 以真实 IO 错误落案 */
      }
      try {
        writeFileSync(tmp, JSON.stringify(state), 'utf8');
        renameSync(tmp, this._filePath); // 原子换名（checkpoint 同律）
      } catch (e) {
        try { unlinkSync(tmp); } catch { /* tmp 可能未创建 */ }
        throw e;
      }
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  }

  /**
   * 读档：文件不存在 / 读失败 / 坏 JSON / 形状全坏 ⇒ null（**绝不抛**）。
   * 部分损坏防御性降级：三账逐条消毒（非有限值 / 空 key 剔除），健全条目照常返回；
   * 纯内存（空路径）⇒ null（无档可读的诚实面）。
   */
  load(): KernelStateFile | null {
    if (!this._filePath) return null;
    try {
      if (!existsSync(this._filePath)) return null;
      const raw = JSON.parse(readFileSync(this._filePath, 'utf8'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
      const r = raw as Partial<KernelStateFile>;
      return {
        savedAt: typeof r.savedAt === 'number' && Number.isFinite(r.savedAt) ? r.savedAt : 0,
        params: sanitizeRecord(r.params),
        evidence: sanitizeRecord(r.evidence),
        generations: sanitizeRecord(r.generations),
      };
    } catch {
      return null; // 读失败 / 坏 JSON ⇒ null（绝不抛）
    }
  }

  /**
   * 回放进注册表（恢复面只认当前注册表）：只应用**已注册** key ——
   *   - 值：经 registry.set 回放（set 自带夹取 ⇒ 旧档宽区间的值重夹现区间，
   *     区间不变式在恢复侧续存）；
   *   - 证据：经 registry.addEvidence **增量补**（delta = 存档计数 − 现计数；
   *     负增量合法 —— addEvidence 地板 0 恰落到目标值；无档证据的 key 不动）；
   *   - 代际：**跳过** —— KernelRegistry 无公开写代际 API（generation 只经
   *     promoteFrom 演进 +1，set/restore 皆不动它），存档的 generations 只作
   *     审计面，不伪造「晋升过」的世系痕迹；
   *   - ledger 参数在场不消费（滑窗不可从平面账重建，同 save 的分工注记）；
   *   - 返回回放清单 [{ key, from, to }]（to = 夹取后实际落值；值未变也入清单
   *     —— 证据计数已补，这是一次真实的恢复事件，promoteFrom 同律）。
   * 无档 / 纯内存 / 注册表故障 ⇒ 空清单（绝不抛）。
   */
  applyTo(registry: KernelRegistry, ledger?: EvidenceLedger): Array<{ key: string; from: number; to: number }> {
    const applied: Array<{ key: string; from: number; to: number }> = [];
    let state: KernelStateFile | null = null;
    try {
      state = this.load();
    } catch {
      return applied; // load 契约已绝不抛，此为注入 mock 的双保险
    }
    if (!state || !registry || typeof registry.set !== 'function') return applied;
    try {
      const current = new Map<string, KernelParam>();
      for (const p of registry.list() ?? []) {
        if (p && typeof p.key === 'string' && p.key !== '') current.set(p.key, p);
      }
      for (const [key, value] of Object.entries(state.params)) {
        const cur = current.get(key);
        if (!cur) continue; // 未注册 key 静默忽略（存档可含历史残迹 —— restore 同律）
        const res = registry.set(key, value); // 夹取是成功（registry 契约）
        if (!res || res.ok !== true) continue; // set 被拒（理论不可达：值已消毒有限）
        const to = typeof res.clampedTo === 'number' && Number.isFinite(res.clampedTo) ? res.clampedTo : value;
        const targetEvidence = state.evidence[key];
        if (typeof targetEvidence === 'number') {
          registry.addEvidence(key, targetEvidence - cur.evidence); // 增量补（可为负）
        }
        applied.push({ key, from: cur.value, to });
      }
    } catch {
      return applied; // 部分应用即诚实上报（绝不抛）
    }
    return applied;
  }

  /** 复位目录一次化标志（测试隔离用；filePath 是构造事实，不可复位） */
  reset(): void {
    this.dirEnsured = false;
  }
}
