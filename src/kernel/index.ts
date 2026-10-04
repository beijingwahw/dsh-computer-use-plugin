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
// 55 键）逐字节搬至 ./productionSpecs（纯数据零逻辑，导入面不变）—— 本文件回归
// 桶职责，552 → 约 90 行。
export * from './registry';
export * from './calibrator';
export * from './lineage';
export * from './store';
export * from './conductor';
import { kernelRegistry } from './registry';
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
