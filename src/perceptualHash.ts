// src/perceptualHash.ts
// 突破一的地基：dHash（差值感知哈希）。
// 纯视觉 Agent 最大的隐性失败模式是「盲点」—— 点击落空但模型以为成功了。
// dHash 把整屏缩到 9x8 灰度并比较水平相邻像素，对鼠标箭头这类微小局部变化
// 天然鲁棒（下采样后几乎不改变指纹），而菜单弹出/页面切换等真实 UI 变化
// 会产生大汉明距离 —— 这正好是「操作是否产生效果」的理想判据。
import sharp from 'sharp';

const HASH_BITS = 64; // 8x8 有效比较位

/**
 * 计算图像 dHash 指纹，返回 64 位 '0'/'1' 字符串。
 * 缩放到 (hashSize+1) x hashSize：每行比较左右相邻像素，右 > 左 记 1。
 */
export async function dhash(buffer: Buffer, hashSize = 8): Promise<string> {
  const { data, info } = await sharp(buffer)
    .grayscale()
    .resize(hashSize + 1, hashSize, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });

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
export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) return Math.max(a.length, b.length);
  let dist = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) dist++;
  return dist;
}

/** 相似度 0~1：1 - distance/64 */
export function similarity(a: string, b: string): number {
  return 1 - hammingDistance(a, b) / HASH_BITS;
}
