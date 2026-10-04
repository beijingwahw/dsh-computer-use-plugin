// src/sleep/dreamFeed.ts
// W8（D-B4 梦回放失败源接线）：组合根供源工装 —— 把失败记忆单例的 dump 面
// 适配为 SleepDeps.dream 的注入形状。兑现 sleepTypes 的集成契约（原文）：
//   「组合根投 `dream: { failures: () => failureMemory.dump().records, evolution:
//    <生产 EXP4 面>, spectrum: surpriseSpectrum(生产 worldModel) }`」
// 的 failures 腿 —— DEBTS D-B4 的缝隙正在于此：SleepDeps.dream 注入缝与执法册
// 就位，但 src/index.ts 卸载路径的 sleep deps 未投 dream ⇒ 六幕零漂移、梦恒不亮。
//
// 供源纪律（与 sleep 包同源）：
//   · 相对导入全部 type-only —— 本模块零运行期依赖，装载器零耦合（index.ts
//     「type-only 律」不破）；
//   · 防御式数据净化绝不抛：dump 返回 {records:数组} 取 records、裸数组原样、
//     其余垃圾 ⇒ 空失败集（梦内注记「无失败轨迹」—— 垃圾数据不是故障）；
//   · 故障归因保持诚实：dumpFailures 自身抛错 ⇒ 原样上抛 —— dreamSidecar 的
//     '失败轨迹源故障（旁路吸收）' 注记臂是梦管线为供给口故障预留的执法面，
//     供源不得吞掉真故障谎报空集（故障 ≠ 空集，两种决策）；
//   · evolution / spectrum / budget 面可选透传：生产 EXP4 单例在 tools 层
//     （autonomousRun 模块私有）、worldModel 在 D-7 知识插件内部 —— 组合根
//     拿不到就诚实缺席（梦内注记「evolution 面缺席」、PER 惊异回落先验），
//     绝不伪造双写面。
import type { DreamEvolutionLike } from './dreamReplay';
import type { SleepDreamDeps } from './sleepTypes';

/** 失败记忆 dump 面的结构子集（生产：failureMemory.dump —— {records, nextId}） */
export interface DreamFeedFaces {
  /** 失败记忆的 dump 面（同步 —— failureMemory 是同步单例；测试投假件） */
  dumpFailures: () => unknown;
  /** EXP4 面（可选透传 —— 生产单例缺席 ⇒ 梦内诚实注记双写缺席） */
  evolution?: DreamEvolutionLike;
  /** 惊异谱（可选透传 —— 生产 worldModel 缺席 ⇒ PER 惊异回落先验 bits） */
  spectrum?: Record<string, number>;
  /** 梦预算覆写（可选 —— 缺省梦模块 DREAM_BUDGET_DEFAULTS：3 条 × 8 步） */
  budget?: { maxDreams?: number; maxStepsPerDream?: number };
}

/**
 * dump 返回值 → 失败记录数组（纯函数，绝不抛）：双方言防御 ——
 * {records: 数组}（failureMemory.dump 的形状）取 records；裸数组（测试直投
 * FailureRecord[]/DreamFailureTrajectory[]）原样；其余垃圾 ⇒ []。
 * 记录条目自身的净化归 dreamTrajectories（同一净化律 —— 无 id 的轨迹不成梦）。
 */
function recordsOf(dump: unknown): unknown[] {
  if (Array.isArray(dump)) return dump;
  if (dump && typeof dump === 'object') {
    const rs = (dump as { records?: unknown }).records;
    if (Array.isArray(rs)) return rs;
  }
  return [];
}

/**
 * W8（D-B4）: 梦 deps 铸造 —— 组合根一行接线的可复用面：
 *
 *   dream: createDreamDeps({ dumpFailures: () => failureMemory.dump() })
 *
 * 缺省零漂移：本工装只有被组合根接进 SleepDeps 才生效；生产接线位于
 * src/index.ts 卸载路径的 enableSleepCycle（缺省 false）块内 —— 开关关 ⇒
 * 投喂永不发生（六幕零漂移的现状逐字节保持），开关开且失败记忆非空 ⇒
 * 梦回放激活（D-B4 的点亮语义：「enableSleepCycle 开且投喂后激活」）。
 */
export function createDreamDeps(faces: DreamFeedFaces): SleepDreamDeps {
  const f = faces && typeof faces === 'object' ? faces : ({} as DreamFeedFaces);
  return {
    // 失败轨迹源：dump 故障原样上抛（诚实归因）；数据垃圾 ⇒ 空集（净化归梦管线）
    failures: () => recordsOf(f.dumpFailures()),
    ...(f.evolution ? { evolution: f.evolution } : {}),
    ...(f.spectrum ? { spectrum: f.spectrum } : {}),
    ...(f.budget ? { budget: f.budget } : {}),
  };
}
