// src/autonomy/gym.rng.ts
// ΠΑΝ-127（D-F5 清偿）：训练营 rng 立法下沉零出边叶 —— W8-B1 拆分后卫星件
//（noise/world/pcgDerive/pcgWorld/pcgCampaign）回借桶 gym.ts 的 rng 门面
//（mulberry32/fnv1a/r2）构成桶-卫星 value 环族（SCC 7）。按「立法单源下沉零环
// 基座」方言拆环：rng 立法入住本叶（实现逐字保留；流内核仍单源自
// src/dialects/random.ts —— ΑΩ-R14 ②rng 单源纪律不变）；桶与卫星皆改 import
// 本叶；桶面同名符号再导出保导入面零破坏（r14 金样/卫兵律照旧锁定）。
// 任务生立立法（KIND_ORDER/castTask 族）受 w8gymsplit ②「export const
// KIND_ORDER」源级锁定留守桶 gym.ts —— 卫星侧需求（gym.noise 的扫频）经端口
// 注入（GymSweepPorts）。行为零变化 —— 纯结构搬家。
import { mulberry32 as dialectMulberry32 } from '../dialects/random';

// ─── 确定性 PRNG（ΑΩ-R14 起 rng 单源：流实现自 src/dialects/random.ts） ───

/**
 * mulberry32（gym 消费面）：单源流内核 + gym 种子归一卫兵。
 * ΑΩ-R14（方言统一②rng 单源）：流实现退役 —— 单源模块 src/dialects/random.ts
 * （照抄 evolutionPrimitives.ts:77/90 现实现，种子流逐字节同源）。卫兵保 gym
 * 旧方言的种子归一律（有限值 Math.floor / 非有限值按 0 记）：单源内核的
 * `seed >>> 0` 在 ToInt32 下对负小数种子截断（-1.5→-1）而 gym 旧律取 floor
 * （-1.5→-2），卫兵在 gym 边界包一层（dialects/random 头注的分工律）—— gym
 * 全域（含负小数种子）与旧实现逐字节一致，零回归。随机流消费顺序不变。
 */
export function mulberry32(seed: number): () => number {
  return dialectMulberry32(
    typeof seed === 'number' && Number.isFinite(seed) ? Math.floor(seed) : 0,
  );
}

/**
 * FNV-1a 32 位字符串散列（状态戳定位用，非密码学）。两旧方言（gym 私有副本与
 * evolutionPrimitives）逐字节同源 ⇒ 无卫兵直迁：W8-B1 起卫星件（noise/world/
 * pcgDerive/pcgWorld/pcgCampaign）经「立法在源」纪律消费 —— 域分离派生
 * 纪律只此一份。ΑΩ-R14：实现自 src/dialects/random.ts 单源再导出（gym 导入面
 * 零改动），行为零变化。
 */
export { fnv1a } from '../dialects/random';

/** 保留两位小数（总结句里的权重展示）。W8-B1 起加 export：gym.noise.ts 消费（立法在源）。 */
export function r2(x: number): number {
  return Math.round(x * 100) / 100;
}
