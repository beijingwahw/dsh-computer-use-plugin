// src/popupDetector.ts
// 弹窗启发式检测 —— 替换原版未定义的伪代码 checkForActivePopup()。
// 演示级规则：模态弹窗通常在屏幕中央形成一块「更亮、更均匀（低方差）」的面板。
// 生产环境应替换为本地视觉模型（OmniParser 类），接口不变、即插即换。
import sharp from 'sharp';

function avg(nums: number[]): number {
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

export async function detectPopupHeuristic(imageBuffer: Buffer): Promise<boolean> {
  try {
    const meta = await sharp(imageBuffer).metadata();
    const w = meta.width!;
    const h = meta.height!;

    // 中央 40% 区域 vs 全图：亮度对比 + 方差对比
    const region = {
      left: Math.round(w * 0.3),
      top: Math.round(h * 0.3),
      width: Math.round(w * 0.4),
      height: Math.round(h * 0.4),
    };

    const [globalStats, centerStats] = await Promise.all([
      sharp(imageBuffer).stats(),
      sharp(imageBuffer).extract(region).stats(),
    ]);

    const gStd = avg(globalStats.channels.map(c => c.stdev));
    const cStd = avg(centerStats.channels.map(c => c.stdev));
    const gMean = avg(globalStats.channels.map(c => c.mean));
    const cMean = avg(centerStats.channels.map(c => c.mean));

    // 中央更均匀（方差显著低于全局）且更亮（弹窗多为高亮底色）-> 判定为弹窗
    return cStd < gStd * 0.55 && cMean > gMean * 1.15;
  } catch {
    // 检测失败不应阻断截图主流程：宁可漏报，不可误杀
    return false;
  }
}
