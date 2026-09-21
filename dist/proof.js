// src/proof.ts
// Q 纪元（证明层）：Merkle Mountain Range —— 任意追加型证据流的包含证明器官。
//
// 理论根基（Merkle 1979；MMR 形态 Sliği/Grin 生态标准）：
//   - 追加型结构（append-only）：山峰 = 高度为 2^k−1 的完全二叉树；追加触发
//     进位合并（二进制计数器同构）—— 无需预知总量的增量默克尔化。
//   - 根 = 峰袋（peak bagging）：bag = peaks[last]; for p in 前序倒推
//     bag = H(p ‖ bag) —— 多峰折叠为单根。
//   - 包含证明：叶 → 所在山峰峰顶的兄弟路径（O(log n)）+ 全部山峰哈希；
//     验证 = 路径重算该峰 + 重袋 + 比根。验证者只信根（峰不可伪造 —— 峰
//     参与袋哈希）。
// 与哈希链的分工：链证明「顺序与连续性」（断链即定位），MMR 证明「单条
// 记录在册」且**免整链重放**（O(log n) vs O(n)）—— 审计从线性升级到对数。
// 纯函数 + 类双形态：类管增量，纯函数管验证（跨进程/跨会话可独立复核）。
import { createHash } from 'crypto';
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
/** 叶节点哈希（域分离前缀 '0' —— 防叶/内部节点歧义拼接） */
export function leafHash(leaf) {
    return sha256('0' + leaf);
}
/** 内部节点：左 ‖ 右（前缀 '1'） */
function nodeHash(left, right) {
    return sha256('1' + left + right);
}
/** 山峰切分：二进制分解（从最大幂往下切 —— 与追加进位同构） */
function cutMountains(leafHashes) {
    const out = [];
    let rest = leafHashes.length;
    let offset = 0;
    while (rest > 0) {
        const k = Math.floor(Math.log2(rest));
        const size = 2 ** k;
        out.push({ hash: hashPerfectTree(leafHashes, offset, size), size });
        offset += size;
        rest -= size;
    }
    return out;
}
/** 完美二叉默克尔树哈希：leaves[offset..offset+size)，size = 2^k，对半递归 */
function hashPerfectTree(leaves, offset, size) {
    if (size === 1)
        return leaves[offset];
    const half = size / 2;
    return nodeHash(hashPerfectTree(leaves, offset, half), hashPerfectTree(leaves, offset + half, half));
}
/** 峰袋根：右起折叠（多峰 → 单根） */
export function bagPeaks(peaks) {
    if (peaks.length === 0)
        return sha256('E'); // 空流诚实根（域分离 'E'）
    let bag = peaks[peaks.length - 1];
    for (let i = peaks.length - 2; i >= 0; i--)
        bag = nodeHash(peaks[i], bag);
    return bag;
}
/** 生成包含证明（O(n) 重建 + O(log n) 路径 —— n 为流长；验证侧恒 O(log n)） */
export function mmrInclusionProof(leafValues, index) {
    if (index < 0 || index >= leafValues.length)
        return null;
    const hashes = leafValues.map(leafHash);
    const mountains = cutMountains(hashes);
    // 定位叶所在山峰
    let acc = 0, peakIndex = -1;
    for (let i = 0; i < mountains.length; i++) {
        if (index < acc + mountains[i].size) {
            peakIndex = i;
            break;
        }
        acc += mountains[i].size;
    }
    if (peakIndex < 0)
        return null;
    const local = index - acc;
    // 在该山峰内下钻提取兄弟路径
    const path = [];
    let lo = 0, size = mountains[peakIndex].size;
    while (size > 1) {
        const half = size / 2;
        if (local - lo < half) { // 叶在左子树 —— 兄弟 = 右子树根
            path.push({ hash: hashPerfectTree(hashes, acc + lo + half, half), leafIsLeft: true });
            size = half;
        }
        else { // 叶在右子树 —— 兄弟 = 左子树根
            path.push({ hash: hashPerfectTree(hashes, acc + lo, half), leafIsLeft: false });
            lo += half;
            size = half;
        }
    }
    // 下钻自顶向下收集兄弟，验证自底向上折叠 —— 逆转为叶邻先序
    path.reverse();
    const peaks = mountains.map(m => m.hash);
    return { index, leaf: hashes[index], path, peaks, peakIndex };
}
/** 验证包含证明（O(log n)：路径重算该峰 + 重袋比根） */
export function mmrVerify(proof, root) {
    let h = proof.leaf;
    for (const { hash, leafIsLeft } of proof.path) {
        h = leafIsLeft ? nodeHash(h, hash) : nodeHash(hash, h);
    }
    if (proof.peakIndex < 0 || proof.peakIndex >= proof.peaks.length)
        return false;
    const peaks = [...proof.peaks];
    peaks[proof.peakIndex] = h; // 叶所在峰以重算值代入
    return bagPeaks(peaks) === root;
}
// ─── 增量类（追加型证据流的活体壳）───
/** 流的 MMR 根（从原始叶值计算 —— 叶值本身已是域哈希前的稳定串） */
export function mmrRoot(leafValues) {
    return bagPeaks(cutMountains(leafValues.map(leafHash)).map(m => m.hash));
}
/** 纯度证明（确定性）：同流同根 —— 跨进程/跨会话独立复核的前提 */
export function mmrDeterministic(a, b) {
    return a.length === b.length && mmrRoot(a) === mmrRoot(b);
}
