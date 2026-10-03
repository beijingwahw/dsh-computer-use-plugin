// test/vlm.som.test.ts
// 纪元 Ω（Ω-3 · GLM-5.3-Flash 云脑皮层）：SoM 云端视觉锚定层测试。
// 纯函数（markerCentroid + 四个提示词构造器）全部离线测；
// renderSomOverlay 的 plain 路径用手搓 PNG（node:zlib，零依赖）离线测，
// sharp 合成路径按仓库惯例懒加载 sharp（批次 E：未安装则 t.skip，不红）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { getSharp, type SharpLike } from '../src/_legacyDeps.ts';
import type { SomMarker } from '../src/vlm/som.ts';

const {
  markerCentroid, renderSomOverlay,
  buildGroundingSystemPrompt, buildGroundingUserPrompt,
  buildVerdictPrompt, buildOcrPrompt,
} = await import('../src/vlm/som.ts');

// ─── 手搓 PNG（离线 fixture，零外部依赖）─────────────────────────

/** CRC32（PNG 块校验用；IEEE 802.3 反射多项式） */
function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

/** 组装单个 PNG 块：长度 + 类型 + 数据 + CRC */
function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** 纯色 8-bit RGB PNG（w×h）：离线生成确定性小图，不依赖 sharp */
function solidPng(w: number, h: number, rgb: [number, number, number]): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // 位深
  ihdr[9] = 2;  // 颜色类型 2 = RGB
  const row = Buffer.alloc(1 + w * 3); // 首字节 filter=0
  for (let x = 0; x < w; x++) {
    row[1 + x * 3] = rgb[0];
    row[2 + x * 3] = rgb[1];
    row[3 + x * 3] = rgb[2];
  }
  const idat = zlib.deflateSync(Buffer.concat(Array.from({ length: h }, () => row)));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ─── 纯函数：markerCentroid ──────────────────────────────────────

test('markerCentroid: 中心点数值正确（整数与半像素）', () => {
  assert.deepEqual(markerCentroid({ x0: 0, y0: 0, x1: 100, y1: 50 }), { x: 50, y: 25 });
  assert.deepEqual(markerCentroid({ x0: 10, y0: 20, x1: 30, y1: 60 }), { x: 20, y: 40 });
  // 奇数宽度 → 半像素中心（点击目标的精确语义）
  assert.deepEqual(markerCentroid({ x0: 1, y0: 3, x1: 2, y1: 4 }), { x: 1.5, y: 3.5 });
});

// ─── 纯函数：提示词构造器（离线）─────────────────────────────────

test('buildGroundingSystemPrompt: 契约字段齐全且 ≤300 字', () => {
  const p = buildGroundingSystemPrompt();
  assert.equal(typeof p, 'string');
  assert.ok(p.length <= 300, `系统提示词超长：${p.length} 字`);
  // 严格 JSON + 五个字段名
  assert.ok(p.includes('JSON'), '须要求 JSON 输出');
  for (const f of ['id', 'label', 'role', 'bbox', 'confidence']) {
    assert.ok(p.includes(f), `缺少字段名 ${f}`);
  }
  // role 枚举全集
  for (const r of ['button', 'link', 'input', 'select', 'text', 'icon', 'menu', 'other']) {
    assert.ok(p.includes(r), `缺少 role 枚举 ${r}`);
  }
  // 三条铁律：像素绝对坐标 / 图外非法 / 不臆造
  assert.ok(p.includes('像素绝对坐标'));
  assert.ok(p.includes('图外坐标非法'));
  assert.ok(p.includes('不要臆造'));
});

test('buildGroundingUserPrompt: 尺寸、任务与聚焦问题', () => {
  const p = buildGroundingUserPrompt({ width: 1920, height: 1080 });
  assert.ok(p.length <= 300, `用户提示词超长：${p.length} 字`);
  assert.ok(p.includes('1920') && p.includes('1080'), '须注入图像宽高');
  assert.ok(p.includes('可交互元素') && p.includes('文字块'), '须描述 grounding 任务');
  assert.ok(!p.includes('聚焦'), '无问题时不应有聚焦段');

  const q = buildGroundingUserPrompt({ width: 800, height: 600, question: '购物车入口在哪里' });
  assert.ok(q.includes('购物车入口在哪里'), '问题文本须透传');
  assert.ok(q.length <= 300, `聚焦版超长：${q.length} 字`);
});

test('buildVerdictPrompt: 判决枚举、explanation 与 expectation 透传', () => {
  const p = buildVerdictPrompt('页面出现登录成功提示');
  assert.ok(p.length <= 300, `verdict 提示词超长：${p.length} 字`);
  assert.ok(p.includes('登录成功提示'), 'expectation 须透传');
  for (const k of ['verdict', 'confirmed', 'refuted', 'uncertain',
    'scale', 'page', 'element', 'none', 'explanation', 'confidence']) {
    assert.ok(p.includes(k), `缺少关键字 ${k}`);
  }
  assert.ok(p.includes('一句中文'), 'explanation 须限定一句中文');
  assert.ok(p.includes('像素'), '判断须锚定实际像素');
});

test('buildOcrPrompt: words 契约、lang 与 findQuery 注入', () => {
  const bare = buildOcrPrompt({});
  assert.ok(bare.length <= 300, `OCR 提示词超长：${bare.length} 字`);
  for (const k of ['words', 'text', 'bbox', 'confidence']) {
    assert.ok(bare.includes(k), `缺少关键字 ${k}`);
  }
  assert.ok(bare.includes('不翻译'), 'text 须保持原文语言');

  const p = buildOcrPrompt({ lang: 'eng', findQuery: '提交订单' });
  assert.ok(p.includes('eng'), 'lang 须注入');
  assert.ok(p.includes('提交订单'), 'findQuery 须注入');
  assert.ok(p.length <= 300, `带参版超长：${p.length} 字`);
});

// ─── renderSomOverlay：plain 路径（离线，手搓 PNG）────────────────

test('renderSomOverlay: markers 空 = plain 原样返回并嗅探尺寸（离线）', async () => {
  const png = solidPng(8, 6, [200, 30, 30]);
  // 缺省 markers 与空数组等价：原样透传
  const r1 = await renderSomOverlay(png);
  assert.equal(r1.ok, true);
  assert.ok(r1.buffer!.equals(png), 'plain 路径必须原样返回（不重编码）');
  assert.equal(r1.width, 8);
  assert.equal(r1.height, 6);
  const r2 = await renderSomOverlay(png, { markers: [] });
  assert.equal(r2.ok, true);
  assert.ok(r2.buffer!.equals(png));
  assert.deepEqual([r2.width, r2.height], [8, 6]);
  // 非 PNG 输入：仍原样透传，但尺寸嗅探缺席（不猜）
  const notPng = Buffer.from('not a png at all');
  const r3 = await renderSomOverlay(notPng, { markers: [] });
  assert.equal(r3.ok, true);
  assert.ok(r3.buffer!.equals(notPng));
  assert.equal(r3.width, undefined);
  assert.equal(r3.height, undefined);
});

test('renderSomOverlay: 非法输入 ok:false，永不抛异常（离线）', async () => {
  const r1 = await renderSomOverlay(null as unknown as Buffer);
  assert.equal(r1.ok, false);
  assert.equal(typeof r1.error, 'string');
  assert.ok((r1.error ?? '').length > 0);
  const r2 = await renderSomOverlay(Buffer.alloc(0), { markers: [] });
  assert.equal(r2.ok, false);
  assert.equal(typeof r2.error, 'string');
});

// ─── renderSomOverlay：sharp 合成路径（sharp 缺席则 skip）─────────

test('renderSomOverlay: sharp 合成两个 marker + 网格，尺寸不变、像素已改写', async (t) => {
  let s: SharpLike;
  try {
    s = await getSharp();
  } catch (e: unknown) {
    // 批次 E 迁移：sharp 默认不装 —— 云端合成用例 SKIP，不红
    const msg = e instanceof Error ? e.message : String(e);
    return t.skip(`[batch-E] sharp 不可用 — ${msg.slice(0, 200)}`);
  }

  const w = 64, h = 48;
  const raw = Buffer.alloc(w * h * 3, 40); // 深灰纯色底
  const png = await s(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();

  const markers: SomMarker[] = [
    { id: 1, bbox: { x0: 4, y0: 4, x1: 24, y1: 16 }, center: markerCentroid({ x0: 4, y0: 4, x1: 24, y1: 16 }) },
    { id: 2, bbox: { x0: 32, y0: 24, x1: 60, y1: 44 }, center: markerCentroid({ x0: 32, y0: 24, x1: 60, y1: 44 }) },
  ];
  const res = await renderSomOverlay(png, { markers, gridDensity: 4, strokeWidth: 3 });
  assert.equal(res.ok, true, `res.error=${res.error ?? ''}`);
  assert.equal(res.width, w, '输出宽度须与输入一致');
  assert.equal(res.height, h, '输出高度须与输入一致');
  assert.ok(res.buffer && res.buffer.length > 0, '输出 buffer 非空');
  assert.ok(!res.buffer!.equals(png), '叠加必须改写像素（描边+标签）');
  // 输出仍是一张可解码的同尺寸 PNG
  const meta = await s(res.buffer!).metadata();
  assert.equal(meta.width, w);
  assert.equal(meta.height, h);
  assert.equal(meta.format, 'png');
});

test('renderSomOverlay: 非法 marker 只跳过自身，不毒化整图（sharp 缺席则 skip）', async (t) => {
  let s: SharpLike;
  try {
    s = await getSharp();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return t.skip(`[batch-E] sharp 不可用 — ${msg.slice(0, 200)}`);
  }
  const w = 40, h = 30;
  const png = await s(Buffer.alloc(w * h * 3, 90), { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
  const bad: SomMarker[] = [
    { id: 7, bbox: { x0: Number.NaN, y0: 0, x1: 10, y1: 10 }, center: { x: 0, y: 0 } },   // NaN → 跳过
    { id: 8, bbox: { x0: 20, y0: 5, x1: 2, y1: 25 }, center: { x: 0, y: 0 } },            // 非正尺寸 → 跳过
    { id: 9, bbox: { x0: 500, y0: 500, x1: 900, y1: 900 }, center: { x: 0, y: 0 } },      // 完全越界 → 跳过
    { id: 3, bbox: { x0: 2, y0: 2, x1: 18, y1: 12 }, center: { x: 10, y: 7 } },           // 合法 → 保留
  ];
  const res = await renderSomOverlay(png, { markers: bad });
  assert.equal(res.ok, true, `res.error=${res.error ?? ''}`);
  assert.equal(res.width, w);
  assert.equal(res.height, h);
  assert.ok(res.buffer && !res.buffer.equals(png), '合法 marker 仍应画出');
});
