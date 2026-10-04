// src/dialects/random.ts
// ΑΩ-R10（方言三重复制单源化）：确定性 PRNG 与字符串散列的单一事实源。
// 此前 evolutionPrimitives.ts（本任务迁移）与 gym.ts（并行工单迁移）各持一份
// 逐位相同的 mulberry32 / FNV-1a 副本（「零依赖铁律自带副本」），漂移风险真实
// 存在，今起归源于此。实现逐字节取自 evolutionPrimitives.ts 现实现（种子流与
// 散列值逐位一致 ⇒ 确定性回放不变）。
// 纪律：纯函数、零副作用、零异常、零依赖。
// ΝΩ-41（方言克隆律）：表面扩为四原语 —— mulberry32 / fnv1a / fnv1aSeeded（滚动
// 续算，federation 摘要指纹共用）/ fnv1aBase36（skillFederation 的 string 返回
// 方言）。六个方言副本（semanticHash / skillFederation / dreamReplayCore /
// som.layout / federation/digest / knowledge/memoryOps.random）退役改 import，
// 各自金样见 test/no41.dialectClones.test.ts（同 seed 同序列前后一致执法）。
/**
 * mulberry32 —— 32 位确定性 PRNG（种子钉死 ⇒ 序列钉死）。均匀输出 [0,1)。
 * 注意：种子仅做 `>>> 0` 归一（与 evolutionPrimitives 原实现逐位一致）；需要
 * floor/有限性卫兵的调用方（如 gym 方言）在自家边界包一层，不在本源内改语义。
 */
export function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
/**
 * FNV-1a 32 位字符串哈希（>>>0 归一）——类别标签进桶/域分离派生的确定性锚。
 * ΝΩ-41（方言克隆律）：实现体下沉为 fnv1aSeeded 的偏移基特例（单一循环字面量
 * —— 滚动续算消费方 federation/digest.fnv1a32 与本源共享同一循环，行为逐位不变）。
 */
export function fnv1a(input) {
    return fnv1aSeeded(0x811c9dc5, input);
}
/**
 * ΝΩ-41：FNV-1a 续算（滚动哈希）—— 从任意 32 位累积器 h 续吞 input。
 * 与 fnv1a 偏移基起步逐位同构（h = 0x811c9dc5 时即 fnv1a）；种子消毒
 * （floor / 非有限回落）由消费方在自家边界包一层（本源零卫兵纪律不变）。
 */
export function fnv1aSeeded(h, input) {
    let acc = h >>> 0;
    for (let i = 0; i < input.length; i++) {
        acc ^= input.charCodeAt(i);
        acc = Math.imul(acc, 0x01000193);
    }
    return acc >>> 0;
}
/**
 * ΝΩ-41：FNV-1a → base36 短串（`(h >>> 0).toString(36)` 的命名承接）。
 * skillFederation 技能指纹的 string 返回方言 —— 逐字节取自其退役本地副本
 * （fnv1a 数值域同源，仅出口编码不同）。
 */
export function fnv1aBase36(input) {
    return fnv1a(input).toString(36);
}
