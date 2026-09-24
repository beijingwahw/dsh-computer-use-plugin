// src/perceptualHash.ts
// 突破一的地基：dHash（差值感知哈希）。
// 纯视觉 Agent 最大的隐性失败模式是「盲点」—— 点击落空但模型以为成功了。
// dHash 把整屏缩到 9x8 灰度并比较水平相邻像素，对鼠标箭头这类微小局部变化
// 天然鲁棒（下采样后几乎不改变指纹），而菜单弹出/页面切换等真实 UI 变化
// 会产生大汉明距离 —— 这正好是「操作是否产生效果」的理想判据。
// 批次 E 迁移：sharp 从 dependencies 移除，改为懒动态导入（_legacyDeps.getSharp）。
import { getSharp } from './_legacyDeps.js';
const HASH_BITS = 64; // 8x8 有效比较位
/**
 * 服务端指纹（D-5 Python 端计算的 16 位 hex）→ Node 位串域。
 * 物理/逻辑位序与 dhash() 一致由「同一进制展开」保证 —— 所有服务端指纹
 * 经同一函数转换后，与本地指纹共用 hammingDistance/similarity 比较器。
 * 已是位串（64×'0'/'1'）则原样透传（混合部署时的宽容性）。
 */
export function hexToBits(hex) {
    if (/^[01]+$/.test(hex) && hex.length === HASH_BITS)
        return hex;
    let n;
    try {
        n = BigInt(`0x${hex}`);
    }
    catch {
        return '0'.repeat(HASH_BITS);
    }
    return n.toString(2).padStart(hex.length * 4, '0');
}
/** 宽容归一：本地 dhash 位串 / 服务端 hex 统一进位串域 */
export function normalizeHash(h) {
    return /^[01]+$/.test(h) ? h : hexToBits(h);
}
/**
 * 计算图像 dHash 指纹，返回 64 位 '0'/'1' 字符串。
 * 缩放到 (hashSize+1) x hashSize：每行比较左右相邻像素，右 > 左 记 1。
 */
export async function dhash(buffer, hashSize = 8) {
    const sharp = await getSharp();
    const res = await sharp(buffer)
        .grayscale()
        .resize(hashSize + 1, hashSize, { fit: 'fill' })
        .raw()
        .toBuffer({ resolveWithObject: true });
    const { data, info } = res;
    let bits = '';
    for (let row = 0; row < info.height; row++) {
        for (let col = 0; col < info.width - 1; col++) {
            const left = data[row * info.width + col];
            const right = data[row * info.width + col + 1];
            bits += right > left ? '1' : '0';
        }
    }
    return bits;
}
/** 汉明距离：位数差异越多，两图差异越大。长度不齐时返回最大距离。 */
export function hammingDistance(a, b) {
    if (a.length !== b.length)
        return Math.max(a.length, b.length);
    let dist = 0;
    for (let i = 0; i < a.length; i++)
        if (a[i] !== b[i])
            dist++;
    return dist;
}
/**
 * 区域指纹（第三轮创新的地基）：以归一化坐标为中心裁剪正方形邻域再取 dHash。
 * 动机：全屏指纹对局部小变化（光标出现/短文本输入）不敏感 —— 64 位里只有几位翻转，
 * 相似度仍 >0.99，会被误判为「没点中」。区域指纹把变化放大：同一变化在小区块里
 * 占比极高，距离陡增。双尺度互补：全屏管「页面级跳转」，区域管「元素级反馈」。
 */
export async function regionDhash(buffer, cxPct, cyPct, radiusPct = 0.15, hashSize = 8) {
    const sharp = await getSharp();
    const meta = await sharp(buffer).metadata();
    const W = meta.width, H = meta.height;
    const cx = Math.round(cxPct * W);
    const cy = Math.round(cyPct * H);
    const rx = Math.max(8, Math.round(radiusPct * W));
    const ry = Math.max(8, Math.round(radiusPct * H));
    const left = Math.max(0, cx - rx);
    const top = Math.max(0, cy - ry);
    const width = Math.min(W - left, rx * 2);
    const height = Math.min(H - top, ry * 2);
    const crop = await sharp(buffer)
        .extract({ left, top, width, height })
        .toBuffer();
    return dhash(crop, hashSize);
}
/** 相似度 0~1：1 - distance/hashBits。
 *  J 纪元修正：分母取实际哈希长度而非硬编码 64 —— regionDhash 的 hashSize
 *  是暴露参数（≠8 时旧实现会算出错误值甚至深度负数）。长度不等时
 *  hammingDistance 已返回 max(len)（保守最大距离），这里自然收敛到最小相似度。 */
export function similarity(a, b) {
    const bits = Math.max(a.length, b.length, 1);
    return Math.max(0, 1 - hammingDistance(a, b) / bits);
}
// ─── Q 纪元（Q-2 感知层）：pHash —— DCT-II 低频谱第二指纹 ───
//
// 理论根基（Zauner 2010《Implementation and Benchmarking of Perceptual Hash
// Algorithms》；DCT 源于 Ahmed et al. 1974）：
//   dHash 在**像素梯度域**敏感（亮度/对比度微扰稳健，但对轻微重采样/
//   缩放边界的结构漂移有相位敏感盲区）；pHash 在**频谱域**取低频块 ——
//   能量集中在低频，对几何微扰与伽马校正更稳健。两把指纹的失效模式
//   近似正交 ⇒ 双指纹融合把「同图判同」的稳健性与「异图判异」的分辨力
//   同时抬高（证据独立 ⇒ 漏判概率乘积律）。
// 实现：32×32 灰度 → 二维 DCT-II（行/列两趟一维 DCT 的可分离性）→ 取
//   左上 8×8（含 DC 排除）中位阈值 → 64 位。
/** 一维 DCT-II（O(n²) 直接形 —— n=32 的代价可忽略；量化误差由中位阈值吸收） */
function dct1d(v) {
    const n = v.length;
    const out = new Array(n).fill(0);
    for (let k = 0; k < n; k++) {
        let s = 0;
        for (let i = 0; i < n; i++)
            s += v[i] * Math.cos(((2 * i + 1) * k * Math.PI) / (2 * n));
        out[k] = s * (k === 0 ? Math.SQRT1_2 : 1);
    }
    return out;
}
/** pHash：64 位 '0'/'1'（低频 8×8 块 > 块中位，排除 DC —— 亮度不变性） */
export async function phash(buffer, gridSize = 32) {
    const sharp = await getSharp();
    const N = gridSize;
    const raw = (await sharp(buffer)
        .grayscale()
        .resize(N, N, { fit: 'fill' })
        .raw()
        .toBuffer({ resolveWithObject: true }));
    const data = raw.data;
    // 行 DCT → 列 DCT（可分离性：二维 DCT = 两趟一维）
    const rows = [];
    for (let y = 0; y < N; y++) {
        rows.push(dct1d(Array.from(data.subarray(y * N, (y + 1) * N), (b) => b)));
    }
    const cols = [];
    for (let x = 0; x < N; x++) {
        cols.push(dct1d(rows.map(r => r[x])));
    }
    // 左上 8×8 低频块（跳过 [0][0] DC —— 直流分量载平均亮度，非结构信号）
    const K = 8;
    const block = [];
    for (let y = 0; y < K; y++) {
        for (let x = 0; x < K; x++) {
            if (x === 0 && y === 0)
                continue;
            block.push(cols[y][x]);
        }
    }
    const sorted = [...block].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    let bits = '';
    for (let y = 0; y < K; y++) {
        for (let x = 0; x < K; x++) {
            if (x === 0 && y === 0) {
                bits += '0';
                continue;
            } // DC 位恒 0（不参与判决）
            bits += cols[y][x] > median ? '1' : '0';
        }
    }
    return bits;
}
/** 双指纹融合相似度：min(dHash 相似度, pHash 相似度) —— 保守融合
 *  （两把尺子都说像才算像；任一说不像即不像 —— 验证语义下防漏判优先）。 */
export async function dualSimilarity(bufA, bufB) {
    const [da, db, pa, pb] = await Promise.all([dhash(bufA), dhash(bufB), phash(bufA), phash(bufB)]);
    return {
        dhash: similarity(da, db),
        phash: similarity(pa, pb),
        fused: Math.min(similarity(da, db), similarity(pa, pb)),
    };
}
// ─── U 纪元（U-1 感知层）：环形旋转不变指纹（ringHash 第三指）───
//
// 理论根基：dHash（梯度域）与 pHash（低频谱）对**旋转**双双失明——旋转 90°
// 后两者都判"完全不同的图"。旋转不变的经典路线：以质心为原点的**同心环带
// 强度分布**（annular histogram）—— 旋转不改变环带内像素集合，只重排环内
// 相位；取每环均值（相位无关统计量）⇒ 特征对任意角度旋转不变。
// 8 环 × 8 位中位阈值 = 64 位。与双指的分工：前两尺管"平移/亮度/重采样"，
// 环指专管"转没转" —— 三指覆盖正交的几何扰动族。
// 诚实边界：不变域 = **90° 整数倍**（画布保持旋转，实测 sim=1.0）；小角
// 重采样与补角已与环带宽度量化同阶（8°≈0.67、37°≈0.52）—— 小角判读用
// pHash/dHash，环指专职「转没转 90°」的整数倍判定（监控竖屏/横屏切换、
// 旋转锁定等真实场景）。
/** 环形指纹：64 位 '0'/'1'（质心起 8 等面积环带的强度均值中位阈值） */
export async function ringHash(buffer) {
    const sharp = await getSharp();
    const N = 64;
    const raw = (await sharp(buffer)
        .grayscale()
        .resize(N, N, { fit: 'fill' })
        .raw()
        .toBuffer({ resolveWithObject: true }));
    const data = raw.data;
    // 质心（像素强度加权 —— 内容质心，比几何中心对偏移更鲁棒）
    let mSum = 0, cx = 0, cy = 0;
    for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
            const m = data[y * N + x];
            mSum += m;
            cx += m * x;
            cy += m * y;
        }
    }
    cx = mSum > 0 ? cx / mSum : (N - 1) / 2;
    cy = mSum > 0 ? cy / mSum : (N - 1) / 2;
    const maxR = Math.hypot(Math.max(cx, N - 1 - cx), Math.max(cy, N - 1 - cy));
    const K = 8;
    // 等宽半径环带（8 环）的均值收集
    const rings = Array.from({ length: K }, () => []);
    for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
            const r = Math.hypot(x - cx, y - cy) / Math.max(1e-9, maxR);
            const idx = Math.min(K - 1, Math.floor(r * K));
            rings[idx].push(data[y * N + x]);
        }
    }
    const means = rings.map(rs => (rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : 0));
    const sorted = [...means].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    // 环均值位 × 8（每环再取高于/低于中位的细分位）—— 简形：环均值 > 全局中位
    // 的环记 1；每环内再以环内中位二值化 8 位 ⇒ 8×8=64 位
    let bits = '';
    for (let k = 0; k < K; k++) {
        bits += means[k] > median ? '1' : '0';
        const inner = [...rings[k]].sort((a, b) => a - b);
        const innerMed = inner[Math.floor(inner.length / 2)] ?? 0;
        const above = rings[k].filter(v => v > innerMed).length;
        bits += above > rings[k].length / 2 ? '1' : '0';
        // 再取环内上下四分位差（对比度签名，同样旋转不变）
        const q3 = inner[Math.floor(inner.length * 0.75)] ?? 0;
        const q1 = inner[Math.floor(inner.length * 0.25)] ?? 0;
        bits += (q3 - q1) > 24 ? '1' : '0';
        // 环带能量占比（相对总能量）
        const energy = rings[k].reduce((a, b) => a + b * b, 0);
        const total = rings.reduce((a, rs) => a + rs.reduce((x, y2) => x + y2 * y2, 0), 0) || 1;
        bits += energy / total > 1 / K ? '1' : '0';
        void above;
        void q3;
    }
    // 8 环 × 8 位 = 64：目前每环 4 位 × 8 = 32 —— 补 32 位：环间差分符号
    for (let k = 0; k < K; k++) {
        for (const d of [1, 2, 3, 4]) {
            const prev = means[(k - d + K) % K];
            bits += means[k] > prev ? '1' : '0';
        }
    }
    return bits.slice(0, 64);
}
