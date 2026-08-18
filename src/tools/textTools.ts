// src/tools/textTools.ts
// 第四轮创新的工具面（OCR）：
//   read_text  — 区域文字读取：文本替代截图，Token 数量级下降
//   find_text  — 文字→坐标定位：带文字标签的元素获得精确 ground truth，
//                彻底消灭「按按钮文字估坐标」的幻觉源
import { defineTool } from '@deepseek-ai/dsh-tools';
import sharp from 'sharp';
import type { Config } from '../config';
import { system } from '../system';
import { readText } from '../textReader';

/** 截一张无叠加层的干净屏（OCR 不受网格线干扰），降采样到 OCR 友好宽度 */
async function cleanShot(): Promise<Buffer> {
  const raw = await system.captureScreen();
  return sharp(raw).resize({ width: 1600 }).jpeg({ quality: 85 }).toBuffer();
}

export function createReadTextTool(config: Config) {
  return defineTool({
    name: 'read_text',
    description:
      'Reads text from the screen (or a region around a point) via local OCR. ' +
      'Use this instead of take_screenshot when you only need TEXT content — it costs far fewer tokens. ' +
      'Returned coordinates are full-screen normalized (0.0-1.0).',
    parameters: {
      x: { type: 'number', required: false, description: 'Optional center X of the region to read (0.0-1.0). Default: full screen.' },
      y: { type: 'number', required: false, description: 'Optional center Y of the region to read (0.0-1.0).' },
      half_size: { type: 'number', required: false, description: 'Optional region half-size (fraction). Default 0.25.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      try {
        const shot = await cleanShot();

        let target = shot;
        let cropNote = 'full_screen';
        if (typeof args.x === 'number' && typeof args.y === 'number') {
          const half = args.half_size ?? 0.25;
          if (args.x < 0 || args.x > 1 || args.y < 0 || args.y > 1 || half <= 0 || half > 0.5) {
            return `[Error]: Invalid region. x/y in 0.0-1.0, half_size in (0, 0.5].`;
          }
          const meta = await sharp(shot).metadata();
          const W = meta.width!, H = meta.height!;
          const left = Math.max(0, Math.round((args.x - half) * W));
          const top = Math.max(0, Math.round((args.y - half) * H));
          const width = Math.min(W - left, Math.round(half * 2 * W));
          const height = Math.min(H - top, Math.round(half * 2 * H));
          // 区域裁剪 + 放大：OCR 对小文字的准确率关键
          target = await sharp(shot).extract({ left, top, width, height }).resize({ width: 1400 }).toBuffer();
          cropNote = `region_center=(${args.x}, ${args.y}) half=${half}`;
        }

        const { text } = await readText(target, config.ocrLang);
        const clean = text.replace(/\n{3,}/g, '\n\n').trim();
        if (!clean) {
          return JSON.stringify({
            status: 'SUCCESS',
            state_anchor: { scope: cropNote, text_found: false },
            next_step: 'No readable text in scope. If the area contains text, it may be too small — try zoom_inspect or a larger half_size.',
          }, null, 2);
        }
        return JSON.stringify({
          status: 'SUCCESS',
          state_anchor: {
            scope: cropNote,
            text_found: true,
            char_count: clean.length,
            // 文本本身也做预算：超长截断
            text: clean.length > 1500 ? clean.slice(0, 1500) + '...[truncated]' : clean,
          },
          next_step: 'Use the text content for your reasoning. Call find_text when you need clickable coordinates for any label.',
        }, null, 2);
      } catch (error: any) {
        return `[Error]: OCR failed (${error.message}). The language pack may need to be downloaded on first use; check network, or fall back to take_screenshot.`;
      }
    },
  });
}

export function createFindTextTool(config: Config) {
  return defineTool({
    name: 'find_text',
    description:
      'Locates on-screen text and returns PRECISE normalized coordinates for each match. ' +
      'This is the most reliable way to ground any element that has a visible text label — ' +
      'prefer it over estimating coordinates from a screenshot.',
    parameters: {
      keyword: {
        type: 'string', required: true,
        description: 'The text to find (case-insensitive), e.g., "登录", "Sign in", "Submit".',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      try {
        const shot = await cleanShot();
        const { words } = await readText(shot, config.ocrLang);
        const needle = args.keyword.toLowerCase().trim();
        const hits = words.filter(w => w.text.toLowerCase().includes(needle));

        if (hits.length === 0) {
          return JSON.stringify({
            status: 'SUCCESS',
            state_anchor: { keyword: args.keyword, matches: 0 },
            next_step: 'No match on screen. The text may be off-screen (scroll_page), inside an unopened menu, or rendered as an image/icon. Fall back to visual search via take_screenshot.',
          }, null, 2);
        }

        const lines = hits.slice(0, 8).map(w =>
          `- "${w.text}" center=(${w.center_normalized.x.toFixed(3)}, ${w.center_normalized.y.toFixed(3)}) confidence=${Math.round(w.confidence)}`,
        );
        return JSON.stringify({
          status: 'SUCCESS',
          state_anchor: {
            keyword: args.keyword,
            matches: hits.length,
            locations: lines,
          },
          next_step: `Click the most relevant match with click_mouse using its EXACT center coordinates. ` +
            `If multiple matches exist, disambiguate by their vertical/horizontal position before clicking.`,
        }, null, 2);
      } catch (error: any) {
        return `[Error]: OCR failed (${error.message}). Fall back to visual grounding via take_screenshot + zoom_inspect.`;
      }
    },
  });
}
