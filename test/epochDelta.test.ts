// test/epochDelta.test.ts
// 纪元 Δ（全库跃迁）：感知/验证/记忆簇七项修复的执法册。
//   Δ-1 BM25 语料统计单遍化（O(N²) → O(N)）
//   Δ-2 failureMemory 相关性闸门回归证据域（RRF 分恒过闸缺陷根除）
//   Δ-3 潜意识 scenePhash = victim 自己的 pHash（错帧根除）
//   Δ-4 遗像摘要走 textReader 双路径（不再直连 devDeps，生产存活）
//   Δ-5 readTextAny legacy 探针前置于截屏（免付整帧往返）
//   Δ-6 journal.reset 归零 taskDescription + 目录一次保证
//   Δ-7 reportEffect 指纹退化三态 null 降级（边界假信号根除）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SharpLike } from '../src/_legacyDeps.ts';

// ─── Δ-1 BM25：语料统计单遍化的行为等价（长度归一 + 稀有词判别力保持） ───

test('Δ-1: BM25 单遍化等价 —— 长度归一执法 + 空库零回归 + 结果确定性', async () => {
  const { InMemoryKnowledgeBase } = await import('../src/knowledge/knowledgeBase.ts');
  // 空库检索：ok 且空集（域执法零回归）
  const empty = new InMemoryKnowledgeBase();
  const er = empty.query({ sceneDescription: 's', intentDescription: 'anything at all' });
  assert.ok(er.ok);
  assert.equal(er.value.entries.length, 0);

  const kb = new InMemoryKnowledgeBase();
  // 同一稀有词 'zephyr' 各命中一次：短文档必须排在长文档前
  //（avgdl 长度归一路径 —— 统计搬进 bm25Corpus 后仍是判决事实源）
  kb.insert({ category: 'workflow', content: 'zephyr', scenario: 'short doc', confidence: 0.9, source: 'manual' });
  kb.insert({ category: 'workflow', content: `zephyr ${'filler word '.repeat(40)}`, scenario: 'long doc', confidence: 0.9, source: 'manual' });
  const r = kb.query({ sceneDescription: '', intentDescription: 'zephyr', maxResults: 2 });
  assert.ok(r.ok);
  assert.equal(r.value.entries.length, 2);
  assert.equal(r.value.entries[0].scenario, 'short doc', '短文档同词命中排序在前（BM25 长度归一）');
  // 重复检索结果稳定（统计确定性 —— 单遍统计无跨调用状态）
  const r2 = kb.query({ sceneDescription: '', intentDescription: 'zephyr', maxResults: 2 });
  assert.ok(r2.ok);
  assert.deepEqual(r2.value.entries.map(e => e.scenario), ['short doc', 'long doc'], '检索幂等');
  // insert 后统计即时生效（无缓存陈化）：新稀有词条目可被检索
  kb.insert({ category: 'workflow', content: 'quokka habitat', scenario: 'fauna doc', confidence: 0.9, source: 'manual' });
  const r3 = kb.query({ sceneDescription: '', intentDescription: 'quokka' });
  assert.ok(r3.ok && r3.value.entries.length === 1 && r3.value.entries[0].scenario === 'fauna doc');
});

// ─── Δ-2 failureMemory：无关查询零召回（RRF 分恒过闸缺陷根除） ───

test('Δ-2: failureMemory 相关性闸门 —— 无关查询零召回，相关查询照常', async () => {
  const { failureMemory } = await import('../src/failureMemory.ts');
  failureMemory.reset();
  failureMemory.record('login flow', 'type_text(user field)', 'login button not found');
  failureMemory.record('export report', 'click(export menu)', 'export dialog never opens');
  // 词面命中照常召回且居首（过滤与排序语义分离：排序仍用 RRF 分）
  const hit = failureMemory.match('login button missing');
  assert.ok(hit.length >= 1 && hit[0].approach.includes('type_text'), '相关查询照常召回');
  // 无关查询：旧实现 RRF 分恒 ≥ 1000/(60+N)（filter(score>0.2) 恒真）必召回
  // 全部无关失败；新闸门用 score2（词面/压缩/场景三证据加权和）—— 零证据即零召回
  const miss = failureMemory.match('煮一碗意大利面需要多少分钟');
  assert.equal(miss.length, 0, `无关查询零召回（实得 ${miss.length}）`);
  failureMemory.reset();
});

// ─── Δ-3 潜意识双指纹：scenePhash 必须是 victim 自己的 ───

let _sharp: SharpLike | null = null;
async function requireSharp(): Promise<SharpLike> {
  if (!_sharp) _sharp = await (await import('../src/_legacyDeps.ts')).getSharp();
  return _sharp;
}

/** 合成灰度 PNG（确定性，无外部 fixture） */
async function grayPng(gray: (x: number, y: number) => number, size = 64): Promise<Buffer> {
  const s = await requireSharp();
  const buf = Buffer.alloc(size * size * 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = Math.min(255, Math.max(0, gray(x, y)));
      const i = (y * size + x) * 3;
      buf[i] = buf[i + 1] = buf[i + 2] = v;
    }
  }
  return s(buf, { raw: { width: size, height: size, channels: 3 } }).png().toBuffer();
}

test('Δ-3: 潜意识 scenePhash = victim 自己的 pHash（非驱逐时刻新入帧）', async (t) => {
  let sharp: SharpLike;
  try {
    sharp = await requireSharp();
  } catch (e: any) {
    t.skip(`[batch-E] sharp not installed — ${e?.message?.slice(0, 240) ?? ''}`);
    return;
  }
  void sharp;
  const { contextManager } = await import('../src/contextManager.ts');
  const { phash } = await import('../src/perceptualHash.ts');
  // 平面帧（pHash 全零位图）与线性渐变帧（低频能量在场）—— 两帧 pHash 必然不同
  const flatBuf = await grayPng(() => 128);
  const gradBuf = await grayPng(x => x * 4);
  const flatPhash = await phash(flatBuf);
  const gradPhash = await phash(gradBuf);
  assert.notEqual(flatPhash, gradPhash, '测试前提：两帧 pHash 可区分');

  contextManager.reset();
  contextManager.configure(1, 1_000_000, false);
  contextManager.configureFocus(false, 0, 32, 6);
  await contextManager.addScreenshot(flatBuf.toString('base64'), '0'.repeat(64));
  await contextManager.addScreenshot(gradBuf.toString('base64'), '1'.repeat(64)); // 驱逐 flat

  const sub = contextManager.dumpSubconscious();
  assert.equal(sub.length, 1);
  assert.equal(sub[0].sceneHash, '0'.repeat(64), 'dHash 是 victim 的（既有语义保持）');
  assert.equal(sub[0].scenePhash, flatPhash, 'pHash 是 victim 自己的（入窗时铸）');
  assert.notEqual(sub[0].scenePhash, gradPhash,
    '旧缺陷执法：不得存驱逐时刻新入帧（grad）的 pHash —— 遗像指纹取自死者而非目击者');
  contextManager.reset();
});

// ─── Δ-4 / Δ-5：OCR 双路径的生产存活契约 ───

test('Δ-4: makeLegacySummary 走 textReader 双路径 —— 不再直连 sharp/tesseract', async () => {
  const cm = readFileSync(new URL('../src/contextManager.ts', import.meta.url), 'utf8');
  assert.ok(!cm.includes("import('sharp')"), 'contextManager 不再直接 import sharp（devDeps，生产必挂）');
  assert.ok(!cm.includes('readText(crop)'), '不再私接 tesseract buffer 通道');
  assert.ok(cm.includes('readTextAny'), '遗像摘要改走 readTextAny（服务端 L2 优先 + 既有降级律）');
});

test('Δ-5: readTextAny legacy 探针前置于截屏 —— tesseract 缺席免付整帧往返', async () => {
  const tr = readFileSync(new URL('../src/textReader.ts', import.meta.url), 'utf8');
  const fn = tr.indexOf('export async function readTextAny');
  assert.ok(fn >= 0, 'readTextAny 在场');
  const probe = tr.indexOf('await getTesseract();', fn);
  const capture = tr.indexOf('captureCleanPng(region)', fn);
  assert.ok(probe >= 0, 'legacy 分支有 tesseract 探针');
  assert.ok(capture > probe, '探针在截屏之前（探针错误有记忆缓存 = legacy 负缓存语义）');
});

// ─── Δ-6 journal：reset 归零任务描述 + 目录一次保证 ───

test('Δ-6: journal.reset 归零 taskDescription + 目录保证一次化', async () => {
  const { journal } = await import('../src/journal.ts');
  journal.reset();
  journal.markTaskStart('上个任务：清理回收站');
  assert.equal(journal.currentTask(), '上个任务：清理回收站');
  journal.reset();
  assert.equal(journal.currentTask(), '', 'reset 归零任务描述（旧实现残留毒化新会话的失败记忆 query 源）');

  // 目录保证：不存在的嵌套目录首写自动建立，JSONL 逐条一行（行为不回归）
  const dir = mkdtempSync(join(tmpdir(), 'delta-journal-'));
  try {
    const filePath = join(dir, 'a', 'b', 'journal.jsonl'); // a/b 嵌套目录不存在
    journal.configure(true, filePath, 100);
    await journal.append({ ts: 1, tool: 'click_mouse', args: {}, status: 'SUCCESS' });
    await journal.append({ ts: 2, tool: 'type_text', args: {}, status: 'SUCCESS' });
    await new Promise(r => setTimeout(r, 100)); // 落盘走异步尾链，等一拍
    assert.ok(existsSync(filePath), '嵌套目录首写自动建立');
    const lines = readFileSync(filePath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2, '两条 append 两行 JSONL（尾链保序）');
    // 源契约：目录建立受标志门控（每条 append 不再重复 mkdir）
    const src = readFileSync(new URL('../src/journal.ts', import.meta.url), 'utf8');
    assert.ok(src.includes('ensuredDirs'), '一次保证标志在场');
    assert.ok(src.includes('if (!this.ensuredDirs.has(filePath))'), 'mkdir 受标志门控');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    journal.configure(true, '', 1000); // 还原无盘测试缺省
    journal.reset();
  }
});

// ─── Δ-7 reportEffect：指纹退化三态 null 降级（边界假信号根除） ───

test('Δ-7: reportEffect 指纹退化 ⇒ effect_detected=null（无法判定）', async () => {
  const { reportEffect } = await import('../src/actionVerifier.ts');
  const { hexToBits } = await import('../src/perceptualHash.ts');
  const H1 = '0'.repeat(63) + '1';
  const H2 = '1'.repeat(64); // 与 H1 距离 63 —— 截然不同

  // 正常域回归：同指纹 ⇒ 无变化；异指纹 ⇒ 有变化（阈值语义不动）
  assert.equal(reportEffect(H1, H1, 0.98).effect_detected, false, '同指纹 ⇒ 无变化');
  assert.equal(reportEffect(H1, H2, 0.98).effect_detected, true, '异指纹 ⇒ 有变化');

  // ① absent：before 指纹缺席 —— 旧实现 sim=0 ⇒ 假阳性「检测到变化」
  //   （焚毁审批令牌/写假地标的世界回击伪证）
  const absent = reportEffect('', H2, 0.98);
  assert.equal(absent.effect_detected, null, '空指纹 ⇒ 无法判定');
  assert.equal(absent.unverifiable, 'absent');
  assert.equal(reportEffect(H2, '', 0.98).unverifiable, 'absent', 'after 缺席同律');

  // ② zero：损坏 hex 经 hexToBits 回退全零 —— 两全零旧判 sim=1「同图」、
  //    全零 vs 真指纹旧判 sim=0「剧变」，全是边界假信号
  assert.equal(hexToBits('not-hex!'), '0'.repeat(64), '测试前提：损坏 hex → 全零回退');
  const zeroPair = reportEffect('not-hex!', 'not-hex!', 0.98);
  assert.equal(zeroPair.effect_detected, null, '两全零（损坏 hex 对）⇒ 无法判定（旧判 sim=1 同图）');
  assert.equal(zeroPair.unverifiable, 'zero');
  const zeroVsReal = reportEffect('0'.repeat(64), H2, 0.98);
  assert.equal(zeroVsReal.effect_detected, null, '全零 vs 真指纹 ⇒ 无法判定（旧判 sim=0 剧变假阳性）');
  assert.equal(zeroVsReal.unverifiable, 'zero');

  // ③ length：异构指纹不可比 —— 旧 sim=0 ⇒ 假阳性
  //   （两侧都非全零、非空 —— 隔离出纯长度不等态）
  const lenMismatch = reportEffect('0'.repeat(63) + '1', '01'.repeat(8), 0.98); // 64 位 vs 16 位
  assert.equal(lenMismatch.effect_detected, null, '长度不等 ⇒ 无法判定');
  assert.equal(lenMismatch.unverifiable, 'length');

  // 混合进制合法域：位串 vs 服务端 hex（同长 64 位）仍可正常判决 —— 降级不误伤
  //   （hex 选全 f 位：避开 hexToBits 的 0/1 歧义 —— 只含 0/1 的 hex 会被当位串）
  const mixed = reportEffect(H2, 'f'.repeat(16), 0.98);
  assert.equal(mixed.effect_detected, false, '位串 vs 等价 hex（可归一可比）⇒ 正常判决');
  assert.equal(mixed.unverifiable, undefined);
});

test('Δ-7: settleAndVerify 保守派生 —— null 不上浮 CombinedEffect.detected', async () => {
  const av = readFileSync(new URL('../src/actionVerifier.ts', import.meta.url), 'utf8');
  // quantumSense.recordEffect 的调用方契约（纯 boolean + undefined 直通锁）决定
  // EffectReport 的 null 只能以保守 false + 注记的形式上浮 —— 详见源内注记
  assert.ok(av.includes('screen.effect_detected === true || region?.effect_detected === true'),
    'unknown ⇒ 保守 false（绝不当变化采信）');
  assert.ok(av.includes('unverifiable'), '降级注记在场（「未验证」≠「判定无变化」）');
});
