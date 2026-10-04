// test/w8.incremental.test.ts
// W8-A5（DEBTS D-C3 增量编码消费方）执法册。
//   W8-1 关向回归锁：开关关（缺省态）⇒ 投喂被拒、记录无 incrementalDelta、
//      驱逐文本/模型内容/消息与「从未触碰增量 API」的对照运行逐字节一致。
//   W8-2 开向 silent：静默判决随记录入窗，驱逐摘要携带「与前帧视觉恒同」，
//      收益遥测 estVisualTokensPreserved = codec.estimateVlmTokens 精确可复算。
//   W8-3 开向 patch：驱逐摘要逐字消费 codec.patchAnchorText 产物（三系坐标
//      并列锚点）—— 增量编码生产面的文本消费面。
//   W8-4 边界诚实降级：首帧/帧突变（keyframe）⇒ 申报无紧凑差分（回退纯墓志铭
//      语义）；维度缺席 ⇒ 源图像素列举（不伪造归一化）；滚动向量缺席 ⇒ 诚实
//      省略；脏投喂 ⇒ 拒收；脏 base64 / 内部账本自报不可信 ⇒ 不附着。
//   W8-5 内部账本自供（sharp 合成真图）：开 ⇒ 不投喂也真差分 —— 冷启动关键帧 /
//      复帧静默 / 微变补丁的判决序列；乱码帧诚实降级计数。
//   W8-6 开关辖制：中途关 ⇒ 驱逐停发增补段（统计冻结）、投喂面一并拒收。
//   W8-7 纯函数面：cleanIncrementalDelta 规整律 + incrementalEvictionSummary
//      截断律 + reset 归零。
// 铁律：全离线确定性 —— 显式投喂驱动（零 sharp 依赖）+ sharp 现铸真图（懒检
// 缺席即 skip，仓库先例）+ 每用例 finally 复位单例（开关关 + reset）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSharp, type SharpLike } from '../src/_legacyDeps.ts';

// 契约模块经动态 import 加载（Ω-2 铁律：不在测试顶层静态绑定被测模块）
const { contextManager } = await import('../src/contextManager.ts');
const {
  cleanIncrementalDelta, incrementalEvictionSummary, DEFAULT_INCREMENTAL_SUMMARY_CHARS,
} = await import('../src/contextManager.records.ts');
const { patchAnchorText, estimateVlmTokens } = await import('../src/vlm/codec.ts');

// ─── 测试脚手架 ───

/** 单例复位到确定态：窗口 2 / 纯 FIFO / OCR 关（显式投喂路径零 sharp 依赖） */
function primeWindow(): void {
  contextManager.reset();
  contextManager.configure(2, 600, true, 200, false);
  contextManager.configureFocus(false, 1, 32, 6);
  contextManager.configureIncremental(false);
}

/** 合成 data URL（不追求可解码 —— 显式投喂路径不解码像素） */
function fakeFrame(tag: string): string {
  return `data:image/png;base64,${tag.repeat(96)}`;
}

/** id 归一（两次运行的 Date.now id 不同 —— 归一后可逐字节对比） */
function norm(x: string): string {
  return x.replace(/#\d+/g, '#ID');
}

/** 窗口内容里的文本块（驱逐墓志铭的可观测面） */
function textBlocks(): string[] {
  return contextManager.getContextForModel()
    .filter((b: any) => b?.type === 'text')
    .map((b: any) => String(b.text));
}

let sharpCache: SharpLike | null = null;
async function requireSharp(): Promise<SharpLike> {
  if (!sharpCache) sharpCache = await getSharp();
  return sharpCache;
}

/** 懒检查 sharp 是否可用，不可用时 test 直接 SKIP（仓库先例） */
async function withSharp<T>(t: any, fn: (s: SharpLike) => Promise<T>): Promise<T | undefined> {
  let s: SharpLike;
  try {
    s = await requireSharp();
  } catch (e: any) {
    t.skip(`sharp not installed — ${e?.message?.slice(0, 240) ?? ''}`);
    return undefined;
  }
  return fn(s);
}

/** 合成灰度帧：baseV 底 + 块状亮斑（w3incremental.framePng 同构） */
async function framePng(
  s: SharpLike, w: number, h: number, baseV: number,
  blocks: Array<{ x: number; y: number; w: number; h: number; v: number }>,
): Promise<Buffer> {
  const raw = Buffer.alloc(w * h * 3);
  raw.fill(baseV, 0, w * h * 3);
  for (const b of blocks) {
    for (let y = b.y; y < Math.min(h, b.y + b.h); y++) {
      for (let x = b.x; x < Math.min(w, b.x + b.w); x++) {
        const i = (y * w + x) * 3;
        raw[i] = b.v; raw[i + 1] = b.v; raw[i + 2] = b.v;
      }
    }
  }
  return s(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

// ─── W8-1：关向回归锁（逐字节） ───

test('W8-1: 开关关（缺省）⇒ 投喂拒收、记录零触碰、驱逐文本与对照运行逐字节一致', async () => {
  try {
    // 对照运行：从未触碰任何增量 API
    primeWindow();
    const imgs = [fakeFrame('A'), fakeFrame('B'), fakeFrame('C'), fakeFrame('D')];
    const baselineMsgs: string[] = [];
    for (const img of imgs) baselineMsgs.push((await contextManager.addScreenshot(img)).message);
    const baselineContent = JSON.parse(JSON.stringify(contextManager.getContextForModel()));
    const baselineKb = contextManager.imageKb();
    const baselineCount = contextManager.imageCount();

    // 增量噪声运行：同输入 + 开关关状态下穿插投喂（应被拒收）
    primeWindow();
    const noiseMsgs: string[] = [];
    for (let i = 0; i < imgs.length; i++) {
      const fed = contextManager.recordIncrementalDelta({
        kind: 'silent', changedPct: 0, patches: [], generation: 1,
        sourceWidth: 800, sourceHeight: 600,
      });
      assert.equal(fed, false, `关向投喂必须拒收（第 ${i + 1} 次）`);
      noiseMsgs.push((await contextManager.addScreenshot(imgs[i]!)).message);
    }
    const noiseContent = JSON.parse(JSON.stringify(contextManager.getContextForModel()));

    // 逐字节一致（id 归一后）：消息面 + 模型内容面 + 仪表盘
    assert.deepEqual(noiseMsgs.map(norm), baselineMsgs.map(norm), '消息面逐字节一致');
    assert.deepEqual(
      JSON.parse(JSON.stringify(noiseContent.map((b: any) =>
        b?.type === 'text' ? { ...b, text: norm(b.text) } : b))),
      JSON.parse(JSON.stringify(baselineContent.map((b: any) =>
        b?.type === 'text' ? { ...b, text: norm(b.text) } : b))),
      '模型内容面逐字节一致（墓志铭无增补段）',
    );
    assert.equal(contextManager.imageKb(), baselineKb, 'KB 仪表盘一致');
    assert.equal(contextManager.imageCount(), baselineCount, '图片数仪表盘一致');

    // 墓志铭逐字锁（现状字面量 —— 回归锁的绝对基准）
    const tomb = '[System Note: Screenshot #ID was taken earlier and has been cleared ' +
      'from memory to save context space. Rely on the most recent screenshots for current UI state.]';
    const texts = textBlocks();
    assert.equal(texts.length, 2, '4 帧入窗窗口 2 ⇒ 两条墓志铭');
    for (const t of texts) assert.equal(norm(t), tomb, `墓志铭逐字等于现状（got: ${t.slice(0, 80)}…）`);

    // 记录面零触碰：在窗记录无 incrementalDelta；统计全零
    assert.equal(contextManager.lastImageRecord()?.incrementalDelta, undefined, '记录不携带增量字段');
    const st = contextManager.incrementalDeltaStats();
    assert.equal(st.enabled, false);
    assert.equal(st.deltasAttached, 0);
    assert.equal(st.evictionSummaries, 0);
    assert.equal(st.explicitFeeds, 0);
    assert.equal(st.framesIngested, 0);
  } finally {
    contextManager.configureIncremental(false);
    contextManager.reset();
  }
});

// ─── W8-2：开向 silent（显式投喂驱动，确定性） ───

test('W8-2: 开 ⇒ silent 判决入窗，驱逐摘要申报视觉恒同 + token 收益精确可复算', async () => {
  try {
    primeWindow();
    contextManager.configureIncremental(true);
    const feed = () => contextManager.recordIncrementalDelta({
      kind: 'silent', changedPct: 0, patches: [], generation: 2,
      sourceWidth: 1920, sourceHeight: 1080,
    });
    assert.equal(feed(), true, '开向投喂受收');
    const m1 = await contextManager.addScreenshot(fakeFrame('A'));
    feed();
    await contextManager.addScreenshot(fakeFrame('B'));
    feed();
    const m3 = await contextManager.addScreenshot(fakeFrame('C'));

    // 消息面零噪音：增补段只进 textSummary，不进 message（与关向同文）
    assert.equal(norm(m1.message), 'Screenshot #ID captured successfully.');
    assert.equal(
      norm(m3.message),
      'Screenshot #ID captured successfully. (Note: An older screenshot was cleared to prevent context overflow.)',
      '驱逐注记照旧（增量不进消息面）',
    );

    // 驱逐摘要：silent 语义 + changed 0.0%
    const texts = textBlocks();
    assert.equal(texts.length, 1, '第 3 帧驱逐最旧一张');
    assert.match(texts[0]!, /visually identical to the immediately preceding frame/, '静默语义在场');
    assert.match(texts[0]!, /verdict: silent, changed 0\.0%/, '判决与占比随行');
    assert.ok(!texts[0]!.includes('patch@('), '静默帧无补丁锚点');

    // 收益遥测：精确复算（estimateVlmTokens(1920,1080) = ceil(1920*1080/750)）
    const st = contextManager.incrementalDeltaStats();
    assert.equal(st.enabled, true);
    assert.equal(st.framesIngested, 3);
    assert.equal(st.deltasAttached, 3);
    assert.equal(st.byKind.silent, 3);
    assert.equal(st.evictionSummaries, 1);
    assert.equal(st.estVisualTokensPreserved, estimateVlmTokens(1920, 1080));
    assert.equal(st.estVisualTokensPreserved, 2765, '手算锚：ceil(2073600/750)=2765');
    assert.equal(st.degradedIngests, 0);
  } finally {
    contextManager.configureIncremental(false);
    contextManager.reset();
  }
});

// ─── W8-3：开向 patch —— codec 锚点产物的文本消费面 ───

test('W8-3: 开 ⇒ patch 判决驱逐摘要逐字消费 codec.patchAnchorText（三系锚点）', async () => {
  try {
    primeWindow();
    contextManager.configureIncremental(true);
    const delta = {
      kind: 'patch' as const,
      changedPct: 1.7,
      patches: [{ x: 200, y: 120, w: 120, h: 80 }],
      generation: 3,
      sourceWidth: 600,
      sourceHeight: 400,
    };
    const anchor = patchAnchorText(
      { x: 200, y: 120, w: 120, h: 80 },
      { width: 600, height: 400 }, { width: 600, height: 400 },
    );
    assert.ok(anchor.includes('normalized (0.333,0.300)-(0.533,0.500)'), `锚点含归一化系（${anchor}）`);
    for (const tag of ['A', 'B', 'C']) {
      assert.equal(contextManager.recordIncrementalDelta(delta), true);
      await contextManager.addScreenshot(fakeFrame(tag));
    }
    const texts = textBlocks();
    assert.equal(texts.length, 1);
    assert.ok(texts[0]!.includes(anchor), `驱逐摘要逐字包含 codec 锚点产物（${anchor}）`);
    assert.match(texts[0]!, /only 1 region\(s\) changed/, '补丁计数随行');
    assert.match(texts[0]!, /All regions not listed were unchanged/, '未列区域未变申明');
    const st = contextManager.incrementalDeltaStats();
    assert.equal(st.byKind.patch, 3);
    assert.equal(st.evictionSummaries, 1);
    assert.equal(st.estVisualTokensPreserved, estimateVlmTokens(600, 400), 'token 收益 = estimateVlmTokens(600,400)');
  } finally {
    contextManager.configureIncremental(false);
    contextManager.reset();
  }
});

// ─── W8-4：边界诚实降级 ───

test('W8-4a: 首帧无前帧 / 帧突变（keyframe）⇒ 申报无紧凑差分，不伪造几何', async () => {
  try {
    primeWindow();
    contextManager.configureIncremental(true);
    // 首帧：keyframe 判决（冷启动语义）入窗后被驱逐
    assert.equal(contextManager.recordIncrementalDelta({
      kind: 'keyframe', changedPct: 0, patches: [], generation: 1,
      sourceWidth: 800, sourceHeight: 600,
    }), true);
    await contextManager.addScreenshot(fakeFrame('A'));
    // 帧突变：第二个 keyframe（surprise 满 → 重置）
    assert.equal(contextManager.recordIncrementalDelta({
      kind: 'keyframe', changedPct: 87.3, patches: [], generation: 2,
      sourceWidth: 800, sourceHeight: 600,
    }), true);
    await contextManager.addScreenshot(fakeFrame('B'));
    // 帧稳定后 patch，驱逐时 A（keyframe）先走
    assert.equal(contextManager.recordIncrementalDelta({
      kind: 'patch', changedPct: 2, patches: [{ x: 10, y: 10, w: 40, h: 40 }],
      generation: 2, sourceWidth: 800, sourceHeight: 600,
    }), true);
    await contextManager.addScreenshot(fakeFrame('C'));
    const texts = textBlocks();
    assert.equal(texts.length, 1);
    assert.match(texts[0]!, /full-scene change \(keyframe, generation 1, changed 0\.0%\)/, '首帧 keyframe 申报');
    assert.match(texts[0]!, /no compact delta to carry/, '诚实申报：无紧凑差分可携带');
    assert.ok(!texts[0]!.includes('patch@('), '无伪造几何');
    const st = contextManager.incrementalDeltaStats();
    assert.equal(st.byKind.keyframe, 2);
    assert.equal(st.byKind.patch, 1);
  } finally {
    contextManager.configureIncremental(false);
    contextManager.reset();
  }
});

test('W8-4b: 维度缺席 ⇒ 源图像素列举（不伪造归一化）；滚动向量缺席 ⇒ 诚实省略', async () => {
  // 纯函数面直测（incrementalEvictionSummary —— 消费面的铸造核心）
  const noDims = cleanIncrementalDelta({
    kind: 'patch', changedPct: 2, patches: [{ x: 200, y: 120, w: 120, h: 80 }], generation: 1,
  });
  assert.ok(noDims, '无维度投喂受收');
  assert.equal(noDims!.sourceWidth, undefined, '维度诚实缺席');
  const s1 = incrementalEvictionSummary(noDims);
  assert.ok(s1.includes('(200,120) 120x80 source-px'), `源图像素列举（${s1}）`);
  assert.ok(!s1.includes('normalized'), '不伪造归一化坐标');
  assert.ok(!s1.includes('keyframe-encoded-px'), '不伪造编码系坐标');

  const scroll = cleanIncrementalDelta({
    kind: 'scroll', changedPct: 18, patches: [{ x: 0, y: 0, w: 600, h: 40 }],
    scroll: { dyPx: -40 }, generation: 1, sourceWidth: 600, sourceHeight: 400,
  });
  const s2 = incrementalEvictionSummary(scroll);
  assert.match(s2, /scrolled UP by 40px/, '滚动向量随行');
  assert.ok(s2.includes('newly revealed strip'), '条带几何随行');

  const scrollNoVec = cleanIncrementalDelta({ kind: 'scroll', changedPct: 18, generation: 1 });
  const s3 = incrementalEvictionSummary(scrollNoVec);
  assert.match(s3, /vector unavailable — honest omission/, '向量缺席诚实省略');

  // 截断律：maxChars 垫到最小 20
  const long = incrementalEvictionSummary(cleanIncrementalDelta({
    kind: 'silent', changedPct: 0, generation: 1, sourceWidth: 1920, sourceHeight: 1080,
  }), 20);
  assert.ok(long.length <= 21, `截断到预算（${long.length} ≤ 21）`);
  assert.equal(DEFAULT_INCREMENTAL_SUMMARY_CHARS, 480, '缺省预算常量在册（容得下单条三系锚点）');
});

test('W8-4c: 脏投喂拒收 + 脏 base64 / 账本自报不可信 ⇒ 不附着（诚实降级）', async () => {
  try {
    primeWindow();
    contextManager.configureIncremental(true);
    // 脏投喂：非对象 / 未知 kind / 非字符串 kind —— 全拒收
    assert.equal(contextManager.recordIncrementalDelta(null), false);
    assert.equal(contextManager.recordIncrementalDelta({ kind: 'weird' }), false);
    assert.equal(contextManager.recordIncrementalDelta({ kind: 42 }), false);
    // NaN 占比不拒（规整为 0 —— 数值消毒而非结构性拒绝）；受收后占住单槽，
    // 经关-开翻转清槽（configureIncremental 关向即刻弃投喂 —— 开关辖制面）
    assert.equal(contextManager.recordIncrementalDelta({ kind: 'silent', changedPct: NaN }), true);
    contextManager.configureIncremental(false);
    contextManager.configureIncremental(true);
    // 脏 base64（前缀后为空）：无可信判决 ⇒ 不附着、不抛
    const r = await contextManager.addScreenshot('data:image/png;base64,');
    assert.ok(r.currentId > 0, '主路径不崩');
    // 乱码字节（'QUJD' = 3 字节非图）：内部账本分析失败自报 degraded ⇒ 不附着
    await contextManager.addScreenshot('data:image/png;base64,QUJD');
    const st = contextManager.incrementalDeltaStats();
    assert.equal(st.degradedIngests, 2, '两次诚实降级（空 base64 + 不可解码字节）');
    assert.equal(st.deltasAttached, 0, '无可信判决 ⇒ 零附着');
    assert.equal(contextManager.lastImageRecord()?.incrementalDelta, undefined);
  } finally {
    contextManager.configureIncremental(false);
    contextManager.reset();
  }
});

// ─── W8-5：内部账本自供（sharp 真差分） ───

test('W8-5: 开 ⇒ 不投喂也真差分 —— 冷启动关键帧 / 复帧静默 / 微变补丁 / 乱码降级', async (t) => {
  await withSharp(t, async (s) => {
    try {
      primeWindow();
      contextManager.configureIncremental(true);
      const W = 640, H = 360;
      const f1 = await framePng(s, W, H, 100, []);                       // 纯灰底
      const f1again = await framePng(s, W, H, 100, []);                  // 同构复帧（逐像素同内容）
      const f2 = await framePng(s, W, H, 100, [{ x: 300, y: 150, w: 80, h: 50, v: 255 }]); // 微变
      const d = (b: Buffer) => `data:image/png;base64,${b.toString('base64')}`;

      await contextManager.addScreenshot(d(f1));       // 冷启动 ⇒ keyframe（干净判决，附着）
      let st = contextManager.incrementalDeltaStats();
      assert.equal(st.byKind.keyframe, 1, '冷启动关键帧');
      assert.equal(st.degradedIngests, 0, '干净判决不降级');

      await contextManager.addScreenshot(d(f1again));  // 复帧 ⇒ silent
      st = contextManager.incrementalDeltaStats();
      assert.equal(st.byKind.silent, 1, '复帧静默（真差分 identical）');

      await contextManager.addScreenshot(d(f2));       // 微变 ⇒ patch + 驱逐 f1
      st = contextManager.incrementalDeltaStats();
      assert.equal(st.byKind.patch, 1, '微变补丁');
      assert.equal(st.evictionSummaries, 1, 'f1 驱逐时发了增补段');
      assert.equal(st.estVisualTokensPreserved, estimateVlmTokens(W, H), 'token 收益 = estimateVlmTokens(640,360)');
      const texts = textBlocks();
      assert.match(texts[0]!, /full-scene change \(keyframe, generation 1, changed 0\.0%\)/, '冷启动帧的驱逐申报');

      // 乱码帧（真字节但不可解码）：账本自报 degraded ⇒ 降级计数 + 驱逐 f2（silent）仍可发摘要
      await contextManager.addScreenshot('data:image/png;base64,QUJDRA==');
      st = contextManager.incrementalDeltaStats();
      assert.equal(st.degradedIngests, 1, '乱码帧诚实降级');
      assert.equal(st.deltasAttached, 3, '乱码帧不附着（3 = keyframe+silent+patch）');
      const texts2 = textBlocks();
      assert.match(texts2[1]!, /visually identical/, 'f2（silent）驱逐摘要照发 —— 降级只影响当帧');
    } finally {
      contextManager.configureIncremental(false);
      contextManager.reset();
    }
  });
});

// ─── W8-6：开关辖制（中途关） ───

test('W8-6: 中途关 ⇒ 驱逐停发增补段（统计冻结）+ 投喂面一并拒收', async () => {
  try {
    primeWindow();
    contextManager.configureIncremental(true);
    assert.equal(contextManager.recordIncrementalDelta({
      kind: 'silent', changedPct: 0, generation: 1, sourceWidth: 800, sourceHeight: 600,
    }), true);
    await contextManager.addScreenshot(fakeFrame('A'));
    await contextManager.addScreenshot(fakeFrame('B'));
    await contextManager.addScreenshot(fakeFrame('C')); // 驱逐 A ⇒ 1 条摘要
    const stBefore = contextManager.incrementalDeltaStats();
    assert.equal(stBefore.evictionSummaries, 1);
    assert.equal(stBefore.estVisualTokensPreserved, estimateVlmTokens(800, 600));

    // 中途关：后续驱逐不再发增补段 —— 记录里残留的判决休眠（不消费）
    contextManager.configureIncremental(false);
    assert.equal(contextManager.recordIncrementalDelta({
      kind: 'patch', changedPct: 1, patches: [{ x: 1, y: 1, w: 9, h: 9 }], generation: 1,
    }), false, '关向后投喂拒收');
    await contextManager.addScreenshot(fakeFrame('D')); // 驱逐 B（携 silent 判决）⇒ 关 ⇒ 无摘要
    const stAfter = contextManager.incrementalDeltaStats();
    assert.equal(stAfter.evictionSummaries, stBefore.evictionSummaries, '统计冻结');
    assert.equal(stAfter.estVisualTokensPreserved, stBefore.estVisualTokensPreserved);
    assert.equal(stAfter.framesIngested, stBefore.framesIngested, '关向不再入账');
    // 驱逐文本回退纯墓志铭
    const texts = textBlocks();
    assert.equal(norm(texts[1]!), '[System Note: Screenshot #ID was taken earlier and has been cleared ' +
      'from memory to save context space. Rely on the most recent screenshots for current UI state.]',
      '关向后驱逐文本与现状逐字节一致');
  } finally {
    contextManager.configureIncremental(false);
    contextManager.reset();
  }
});

// ─── W8-7：纯函数面（规整律 + reset 归零） ───

test('W8-7: cleanIncrementalDelta 规整律 + reset 归零', async () => {
  // 规整律：占比夹 [0,100]；代数非有限 ⇒ 0；补丁退化拒绝、越界收口；滚动脏向量整体缺席
  const c1 = cleanIncrementalDelta({
    kind: 'patch', changedPct: 250, patches: [
      { x: -10, y: -10, w: 100, h: 100 },   // 越界收口
      { x: 0, y: 0, w: 0, h: 5 },           // 退化拒绝
    ], generation: -3, sourceWidth: 800, sourceHeight: 600,
  })!;
  assert.ok(c1);
  assert.equal(c1.changedPct, 100, '占比夹上界');
  assert.equal(c1.generation, 0, '负代数归零');
  assert.deepEqual(c1.patches, [{ x: 0, y: 0, w: 90, h: 90 }], '越界收口 + 退化拒绝');
  assert.equal(c1.sourceWidth, 800, '维度成对保留');

  const c2 = cleanIncrementalDelta({
    kind: 'scroll', scroll: { dyPx: NaN }, generation: 1,
    sourceWidth: 800,
  })!;
  assert.equal(c2.scrollDyPx, undefined, '脏滚动向量整体缺席');
  assert.equal(c2.sourceWidth, undefined, '单边维度 ⇒ 双边缺席（不成对不如没有）');

  assert.equal(cleanIncrementalDelta(undefined), null);
  assert.equal(cleanIncrementalDelta('silent'), null);
  assert.equal(incrementalEvictionSummary(null), '', '脏 delta ⇒ 空串');

  // reset 归零：增量面与历史同律
  primeWindow();
  contextManager.configureIncremental(true);
  contextManager.recordIncrementalDelta({ kind: 'silent', changedPct: 0, generation: 1 });
  await contextManager.addScreenshot(fakeFrame('Z'));
  assert.ok(contextManager.incrementalDeltaStats().framesIngested > 0, 'reset 前有入账');
  contextManager.reset();
  const st = contextManager.incrementalDeltaStats();
  assert.deepEqual(st, {
    enabled: true, framesIngested: 0, deltasAttached: 0,
    byKind: { keyframe: 0, patch: 0, scroll: 0, silent: 0 },
    explicitFeeds: 0, evictionSummaries: 0, estVisualTokensPreserved: 0, degradedIngests: 0,
  }, 'reset 把增量遥测一并归零（开关位保留 —— configure 的职权归 configure）');
});

// ─── W8-B2：runtime 感知投喂接线（createPerceive 增量段 → recordIncrementalDelta） ───

test('W8-B2: perceive 账本判决直喂 contextManager —— 总闸开 ⇒ 显式投喂受收并优先消费；总闸关 ⇒ 零投喂', async (t) => {
  await withSharp(t, async (s) => {
    // 契约模块经动态 import（本文件 Ω-2 铁律）
    const { createPerceive } = await import('../src/autonomy/runtime.ts');
    const { kernelRegistry } = await import('../src/kernel/registry.ts');
    const { incrementalEncodingEnabled } = await import('../src/visualDiff.ts');
    kernelRegistry.register({
      key: 'visualDiff.incremental', organ: 'perception', defaultValue: 0, min: 0, max: 1,
      note: 'W8-B2 测试注册（生产由宿主 index.ts 铸入，缺省 0=关）',
    });
    try {
      // 两张真 PNG（同底不同亮斑 —— runtime 侧账本可差分出非平凡判决）
      const f1 = await framePng(s, 96, 72, 128, [{ x: 8, y: 8, w: 24, h: 16, v: 230 }]);
      const f2 = await framePng(s, 96, 72, 128, [{ x: 56, y: 40, w: 20, h: 14, v: 20 }]);
      let which = 0;
      const deps = {
        capture: async (): Promise<Buffer> => (which++ === 0 ? f1 : f2),
        readWords: async () => [] as never[],
        dhashOf: async () => null, // 指纹缺席 ⇒ 场景语义/惊异面隔离（只观察投喂面）
      };

      // ① 总闸关（缺省 0）：感知增量段整段跳过 ⇒ 投喂面零触达（零行为回归锁）
      primeWindow();
      contextManager.configureIncremental(true); // 消费开关开也拦不住 —— 总闸是第一闸
      assert.equal(incrementalEncodingEnabled(), false, '总闸缺省关');
      await createPerceive(deps)();
      assert.equal(contextManager.incrementalDeltaStats().explicitFeeds, 0, '总闸关 ⇒ perceive 零投喂');

      // ② 总闸开 + 消费开关开：perceive 把账本判决显式投喂 ⇒ addScreenshot
      //    优先消费显式判决（免内部账本对同帧重复差分 —— degraded 零计数的证据）
      kernelRegistry.set('visualDiff.incremental', 1);
      primeWindow();
      contextManager.configureIncremental(true);
      await createPerceive(deps)(); // 首帧 ⇒ keyframe 判决投喂
      assert.equal(contextManager.incrementalDeltaStats().explicitFeeds, 1, '开向投喂受收（explicitFeeds=1）');
      await contextManager.addScreenshot(fakeFrame('A')); // 垃圾 base64 —— 显式优先 ⇒ 不解码直接消费
      const st = contextManager.incrementalDeltaStats();
      assert.equal(st.deltasAttached, 1, '显式投喂随记录入窗');
      assert.equal(st.byKind.keyframe, 1, '首帧判决 = keyframe（runtime 账本语义原样随行）');
      assert.equal(st.degradedIngests, 0, '显式路径零降级（未走内部账本自算 —— 免重复差分）');
    } finally {
      kernelRegistry.set('visualDiff.incremental', 0);
      contextManager.configureIncremental(false);
      contextManager.reset();
    }
  });
});
