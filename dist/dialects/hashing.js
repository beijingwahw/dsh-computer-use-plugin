// src/dialects/hashing.ts
// ΑΩ-R13（W6-1 债拆 · 汉明距离方言归一）：十六进制指纹（64 位 dHash 等）的
// 汉明距离单一事实源 —— 半字节（nibble）popcount 查表实现。此前 autoPilot 与
// worldSnapshot 各持私有同律副本（各自带表避免跨器官耦合），本文件将其收口为
// 公共方言：null = 不可比（非字符串/空串/长度不等/非十六进制字符），调用方按
// 保守律把不可比当作「不可判」处理；纯函数、绝不抛、零依赖。
//（注意与 autonomy/sceneSemantics.hammingDistanceHex 的哨兵 9999 方言不同 ——
//  那是器官内私有口径，本文件是 null 语义的跨器官方言。）
/** 半字节 popcount 表（0..15 的置位数）：hammingDistanceHex 的查表核 */
const NIBBLE_POPCOUNT = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];
/**
 * ΑΩ-R13：十六进制指纹汉明距离（纯函数，绝不抛）。逐字符 nibble 异或查表
 * 置位数累加；null = 不可比（非字符串/空串/长度不等/非十六进制字符）——
 * 与 autoPilot 原 gateHexHamming、worldSnapshot 私有实现同律。
 */
export function hammingDistanceHex(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length === 0 || a.length !== b.length) {
        return null;
    }
    let dist = 0;
    for (let i = 0; i < a.length; i++) {
        const x = Number.parseInt(a[i], 16);
        const y = Number.parseInt(b[i], 16);
        if (Number.isNaN(x) || Number.isNaN(y))
            return null;
        dist += NIBBLE_POPCOUNT[x ^ y];
    }
    return dist;
}
