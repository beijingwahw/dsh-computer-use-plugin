// src/kernel/conductor.ts
// 纪元 Ξ（Ξ-A 进化编排）：生产进化的总开关 + 节流指挥棒。
//
// 与 Θ-2 KernelCalibrator 的分工：校准器是「一次 tick 怎么进化」的执法者
//（证据门 / 候选阈 / 步长上限 / 回归守卫）；本模块是「何时允许 tick」的守门人 ——
//   · enabled（缺省 false）：生产进化总开关的运行时面。false ⇒ maybeTick 恒空
//     （只记账不进化 —— 宿主 kernelEvolutionEnabled=false 的缺省行为零变化）；
//   · 节流窗（minIntervalMs，缺省 5 分钟）：距上次成功 tick 不足窗长 ⇒ 恒空。
//     用户消息钩子逐条触发，无节流则每条消息都全册执法一遍 —— 窗是进化侧的
//     稳定器，不是性能补丁（参数换血需要窗后的新证据，窗内重试是空转）。
// 纯离线、零 IO、全确定性（now 可注入）、绝不抛（校准器故障静默降级且不推进
// 节流账 —— 下次 maybeTick 重试）。

import type { KernelRegistry, EvidenceLedger } from './registry.js';
import type { KernelCalibrator, CalibrationReport } from './calibrator.js';

/** 缺省节流窗：5 分钟（进化 tick 的最小间隔 —— 高频用户消息只记账不进化） */
export const DEFAULT_TICK_INTERVAL_MS = 300000;

/** 编排器运行报表（审计面：tick 计数 / 最后 tick 时刻 / 最后一次 tick 的校准报告） */
export interface ConductorReport {
  /** 成功 tick 次数（校准器故障不计） */
  ticks: number;
  /** 最后一次成功 tick 的时钟读数（epoch ms；从未 tick ⇒ 0） */
  lastTickAt: number;
  /** 最后一次成功 tick 的校准报告（防御副本） */
  lastCalibrations: CalibrationReport[];
}

/** 编排器构造选项（registry / ledger / calibrator 必给 —— 前两者是接线的氧气，后者是执法者） */
export interface ConductorOptions {
  /** 生产注册表（接线对称持有 —— 执法经 calibrator，本类不直接写它） */
  registry: KernelRegistry;
  /** 证据账本（接线对称持有 —— 同上，滑窗是校准器的氧气） */
  ledger: EvidenceLedger;
  /** 在线校准器（tick 的实际执行者） */
  calibrator: KernelCalibrator;
  /** 节流窗（ms；缺省 300000；非有限 / 负值静默回落缺省） */
  minIntervalMs?: number;
  /** 时钟注入（确定性测试用；缺省 Date.now） */
  now?: () => number;
}

/**
 * 进化编排器：enabled + 节流窗双闸的 tick 指挥棒。
 * 缺省 disabled —— 生产进化是显式 opt-in（kernelEvolutionEnabled），
 * 关闭时一切方法零副作用（maybeTick 恒空、report 恒零账）。
 */
export class EvolutionConductor {
  /** 生产进化总开关（缺省 false —— 关 = 只记账不进化） */
  private _enabled = false;
  private readonly calibrator: KernelCalibrator | null;
  private readonly minIntervalMs: number;
  private readonly now: () => number;
  private tickCount = 0;
  private lastTickAt = 0;
  private lastCalibrations: CalibrationReport[] = [];

  constructor(opts?: ConductorOptions) {
    this.calibrator = opts?.calibrator ?? null;
    const m = opts?.minIntervalMs;
    this.minIntervalMs = typeof m === 'number' && Number.isFinite(m) && m >= 0 ? m : DEFAULT_TICK_INTERVAL_MS;
    this.now = typeof opts?.now === 'function' ? opts.now : () => Date.now();
  }

  /** 生产进化总开关的运行时面（缺省 false；宿主以 config.kernelEvolutionEnabled 铸初值） */
  get enabled(): boolean {
    return this._enabled;
  }

  set enabled(v: boolean) {
    this._enabled = v === true;
  }

  /**
   * 节流 tick（用户消息钩子的内嵌调用点）：
   *   - enabled=false ⇒ []（零副作用 —— 缺省行为的锚）；
   *   - 距上次**成功** tick < minIntervalMs ⇒ []（首次调用无窗：从未 tick 即放行）；
   *   - 否则 calibrator.tick() 并记账：tickCount+1、lastTickAt=当时钟、
   *     lastCalibrations=报告副本，返回报告防御副本；
   *   - 校准器抛异常 / 缺位 ⇒ [] 且**不推进节流账**（故障不是进化 ——
   *     下次 maybeTick 原地重试，不罚窗）。
   */
  maybeTick(): CalibrationReport[] {
    if (!this._enabled) return [];
    if (!this.calibrator) return []; // 缺位与故障同律：恒空且不推进节流账（缺位不是成功 tick）
    const t = this.now();
    if (this.tickCount > 0 && t - this.lastTickAt < this.minIntervalMs) return [];
    let reports: CalibrationReport[] = [];
    try {
      const r = this.calibrator ? this.calibrator.tick() : [];
      if (Array.isArray(r)) reports = r;
    } catch {
      return []; // 校准器故障：静默降级，不记账（绝不抛）
    }
    this.tickCount++;
    this.lastTickAt = t;
    this.lastCalibrations = reports.slice();
    return reports.slice(); // 防御副本：篡改返回值不穿透内部账
  }

  /** 运行报表（防御副本 —— ticks / lastTickAt / 最后一次 tick 的校准报告） */
  report(): ConductorReport {
    return {
      ticks: this.tickCount,
      lastTickAt: this.lastTickAt,
      lastCalibrations: this.lastCalibrations.slice(),
    };
  }

  /**
   * 清零节流账（tickCount / lastTickAt / lastCalibrations —— 测试隔离用）。
   * enabled 不动：开关面归构造与宿主管（reset 不替宿主关停生产进化）。
   */
  reset(): void {
    this.tickCount = 0;
    this.lastTickAt = 0;
    this.lastCalibrations = [];
  }
}
