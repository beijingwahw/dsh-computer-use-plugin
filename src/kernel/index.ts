// src/kernel/index.ts
// 纪元 Θ（Θ-4 生产接线）：内核器官桶 —— 五模块 re-export + 生产内核入册单。
//
// 职责边界：
//   · 桶：registry（注册表 + 证据账本）/ calibrator（在线校准器）/ lineage（血统）
//     / store（Ξ-A 进化存档）/ conductor（Ξ-A 进化编排）的统一出口 ——
//     宿主与工具层只 import 本文件即可触达内核全系；
//   · registerProductionKernels()：生产内核读点（Θ-4 + Ξ-D 接线清单）的幂等入册。
//     入册语义零行为变化：register 的 value := 夹取后 defaultValue，而每颗读点
//     的 defaultValue 就是其现行字面量 ⇒ 注册表现值 = 字面量 = 消费方
//     getOrDefault 的 fallback —— 读点行为逐字节不变。入册的意义是把可行区间、
//     器官归属与出处注记立册在案，让 set / promoteFrom / 校准器有合法的落笔处
//     （set 未注册键恒失败 —— 注册是进化通道的门，不是行为开关）。
//
// 与训练营（autonomy/gym.ts LAB_KERNEL_SPECS）的分工：实验室自铸注册表在馆内
// 进化；本单册在**生产单例**上声明同一 key 域（键名与 gym 前批四键逐字一致，
// organ 词表同源：perception / arbitration / policy），晋升走
// kernelRegistry.promoteFrom(gym.lab.registry) —— key 域交集即晋升面。
//
// ΠΑΝ-50：晋升通道自本纪元起全副护栏（步长夹取 / Beta 回归守卫 / 血统记录 /
// 证据只升不降 —— 见 registry.promoteFrom），CLI/脚本入口 = promoteFromCli()
//（本文件导出；接线点见其 JSDoc：doctorCli 或独立脚本 import 即可达）。

// 幂等律：register 对重复 key 保持现值、只更新规格 —— 本函数可无限次重入
// （apply 每会话调一次，多会话/热重载亦无害）。入册本身不设开关（恒入册、
// 值全默认 = 零行为变化）；纪元 Ξ（Ξ-A）起生产进化经 config 双字段接线：
// kernelStatePath（进化成果存档，空 = 仅内存）与 kernelEvolutionEnabled
//（生产进化总开关，缺省 false = 只记账不进化）—— 均缺省零行为。
//
// Ξ-A 新增导出面：
//   · store.ts：KernelStore + KernelStateFile —— 进化三账（值/证据/代际）的
//     tmp+rename 原子存档与防御性回放（只认已注册 key）；
//   · conductor.ts：EvolutionConductor + ConductorReport + ConductorOptions
//     + DEFAULT_TICK_INTERVAL_MS —— enabled 总开关与 minIntervalMs 节流窗的
//     tick 指挥棒（缺省 disabled + 5 分钟窗）。
//
// W6-1（doctor 债清偿·smell.over-engineering）：入册单数据面（PRODUCTION_KERNEL_SPECS，
// R3-3 后 60 键）逐字节搬至 ./productionSpecs（纯数据零逻辑，导入面不变）—— 本文件回归
// 桶职责，552 → 约 90 行。
export * from './registry';
export * from './calibrator';
export * from './lineage';
export * from './store';
export * from './conductor';
import { kernelRegistry, evidenceLedger, KernelRegistry, type PromoteOptions, type PromoteChange } from './registry';
import { KernelLineage } from './lineage';
import { PRODUCTION_KERNEL_SPECS } from './productionSpecs';

/**
 * 生产内核入册（幂等、零行为变化）：把 Θ-4 + Ξ-D 接线的全部读点键注册进生产单例。
 *   - 首次：value = defaultValue（= 各读点现行字面量）⇒ getOrDefault 读数不变；
 *   - 重入：register 保持现值 / 证据 / 代际，只刷新规格 —— 无限次重入无害
 *     （幂等性由 registry.register 的重复注册契约保证，本函数不设标记位 ——
 *     标记位会被 resetKernelRuntime 清册后卡死，register 自身才是唯一权威）；
 *   - 纯同步、绝不抛（垃圾 spec 静默忽略是 registry 的契约；本单册全部合格）。
 * 宿主 apply() 启动调用一次；测试经 resetKernelRuntime() 隔离后自行决定是否入册。
 */
export function registerProductionKernels(): void {
  for (const spec of PRODUCTION_KERNEL_SPECS) {
    kernelRegistry.register({ ...spec });
  }
}

// ─── ΠΑΝ-50：CLI 可达的合法晋升通道 ───

/** ΠΑΝ-50：promoteFromCli 的回执（结构化审计面 —— 人类可读打印/机器可读消费两用） */
export interface PromoteFromCliReport {
  /** ok=true = 通道走完（含「零键晋升」—— 空交集也是合法结局，不是故障） */
  ok: boolean;
  /** 晋升清单（registry.promoteFrom 的护栏后产物 —— 含 step-capped 形态标注） */
  promoted: PromoteChange[];
  /** 护栏跳过项（回归守卫拒绝等 —— registry.promoteSkips 的快照） */
  skipped: ReadonlyArray<{ key: string; reason: string }>;
  /** 血统登记面提示：本次晋升登记进的新血统代数（按 key 计；0 = 无血统登记） */
  lineageGenerations: number;
  /** 故障归因（ok=false 时在场；绝不抛 —— 诚实降级） */
  error?: string;
}

/**
 * ΠΑΝ-50：CLI 可达的显式晋升通道（安全分池键换值的**唯一合法写径**的入口面）。
 *
 * 背景（C1-9 M2）：safetyCritical 键「唯一合法通道 = gym 实验室 → 显式
 * promoteFrom」此前只是注释立法 —— 通道本身零护栏（不限步长、不记血统、覆写
 * 证据计数、不校验回归），是全库约束最弱的写径。registry.promoteFrom 自
 * ΠΑΝ-50 起内置四护栏（步长夹取 / Beta 回归守卫 / 血统记录 / 证据只升不降），
 * 本函数把它包装成 CLI/脚本可直达的通道：
 *   · 目标恒为**生产单例** kernelRegistry（实验室传入 lab registry —— gym 场
 *     即 `gym.lab.registry`）；生产台账恒接 evidenceLedger（血统 fitness 的
 *     诚实来源 + 回归守卫的生产侧对照）；
 *   · 缺省全副武装：maxStepPct=0.1（与校准器同律）、minLabEvidence=30
 *     （labLedger 在场时执法 —— gym 侧证据在 ledger 滑窗）、rollbackPosteriorMass=0.9；
 *   · 血统：未注入 ⇒ 本通道自铸一枚 KernelLineage 记录本次晋升（审计面 ——
 *     生产宿主当前无血统单例，ΠΑΝ-50 先保证「晋升必有血统账」，宿主接线
 *     lineage 单例后经 opts.lineage 透传即并入常驻血统）；
 *   · 绝不抛（一切故障收敛 ok:false + error —— CLI 退出码语义清晰）。
 *
 * 接线点申报（不新增文件的本意形态）：doctorCli（src/doctorCli.ts，npm run
 * doctor 入口）或任何脚本消费方 import 本函数即可 —— 例如
 * `promoteFromCli(gym.lab.registry, { labLedger: gym.lab.ledger })`；
 * 回执的 promoted/skipped/lineageGenerations 三面即人机两读的审计输出。
 */
export function promoteFromCli(
  lab: KernelRegistry,
  opts?: PromoteOptions & { dryRun?: boolean },
): PromoteFromCliReport {
  const empty: PromoteFromCliReport = { ok: false, promoted: [], skipped: [], lineageGenerations: 0 };
  try {
    if (!(lab instanceof KernelRegistry)) return { ...empty, error: 'lab is not a KernelRegistry instance' };
    const lineage = opts?.lineage ?? new KernelLineage(); // 血统恒在场（自铸亦真账）
    const merged: PromoteOptions = {
      maxStepPct: 0.1,
      minLabEvidence: 30,
      rollbackPosteriorMass: 0.9,
      ledger: evidenceLedger,
      ...(opts ?? {}),
      lineage,
    };
    if (opts?.dryRun === true) {
      // 演习面：同一护栏判定但不落值 —— 一次性影子册对照（生产单例分毫不动）
      const shadow = new KernelRegistry();
      for (const p of kernelRegistry.list()) shadow.register(p);
      const dry = shadow.promoteFrom(lab, merged);
      return { ok: true, promoted: dry, skipped: shadow.promoteSkips, lineageGenerations: 0 };
    }
    const promoted = kernelRegistry.promoteFrom(lab, merged);
    const skipped = kernelRegistry.promoteSkips;
    return { ok: true, promoted, skipped, lineageGenerations: promoted.length };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ...empty, error: `promoteFromCli: ${msg}` };
  }
}
