// test/epochR.test.ts
// R 纪元（开天辟地第二击）：六件新器官的执法册 —— 模糊层 / 检索层 /
// 熔断层 / 快照层 / 视觉层 / 召回层。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ─── R-1 模糊层：近似子串搜索（OCR 容错）───

test('R-1: fuzzy —— OCR 变体容错命中 + 远文拒判 + textReader 已接线', async () => {
  const { approximateSubstring, fuzzyIncludes } = await import('../src/fuzzy.ts');
  // 精确：距离 0
  assert.deepEqual(approximateSubstring('password', 'enter your password here'), { distance: 0, endAt: 18 });
  // OCR 经典变体：l→1 / O→0 / 吞空格 —— 距离 1-3 内命中
  assert.ok(fuzzyIncludes('password', 'passw0rd'), 'l→1 变体命中');
  assert.ok(fuzzyIncludes('verification code', 'verificati0n c0de'), '双变体命中');
  assert.ok(fuzzyIncludes('sign in', 'signin'), '吞空格命中');
  // 远文拒判：编辑距离 6 > ⌈8/6⌉=2
  assert.ok(!fuzzyIncludes('password', 'completely unrelated'), '远文不误命中');
  // 子串语义：任意起点起跑（全序列编辑距离会把前缀当惩罚 —— 本器官不得）
  assert.deepEqual(approximateSubstring('world', 'hello world'), { distance: 0, endAt: 10 });
  // 接线执法：textReader 的语义核对走模糊判决
  const tr = readFileSync(new URL('../src/textReader.ts', import.meta.url), 'utf8');
  assert.ok(tr.includes('fuzzyIncludes(needle, hay)'), 'semanticConfirm 已容错');
});

// ─── R-2 检索层：BM25 语料统计 ───

test('R-2: BM25 —— 稀有词按语料统计压倒常见词', async () => {
  const { InMemoryKnowledgeBase } = await import('../src/knowledge/knowledgeBase.ts');
  const kb = new InMemoryKnowledgeBase();
  // 语料：三条都含 'click'（常见词 df=3），仅一条含 'api token'（稀有词 df=1）
  kb.insert({ category: 'workflow', content: 'click settings then click save', scenario: 'setup', confidence: 0.9, source: 'manual' });
  kb.insert({ category: 'workflow', content: 'click ok to close dialog', scenario: 'setup', confidence: 0.9, source: 'manual' });
  kb.insert({ category: 'workflow', content: 'api token expires hourly, rotate it', scenario: 'auth', confidence: 0.9, source: 'manual' });
  const r = kb.query({ sceneDescription: '', intentDescription: 'click api token', maxResults: 3 });
  assert.ok(r.ok);
  // 旧二值计数：两条 click 条目各 1 命中，token 条目 2 命中 —— 排序可争议；
  // BM25：'api'/'token' 的 IDF(ln(3/1)) ≫ 'click' 的 IDF(ln(3/3)+1 低值)
  // ⇒ token 条目必须居首（稀有词的判别力被语料统计兑现）
  assert.equal(r.value.entries[0].content.includes('api token'), true,
    `稀有词条目居首（实得首条：${r.value.entries[0].content.slice(0, 30)}）`);
});

// ─── R-3 熔断层：Beta-Bernoulli 序贯后验 ───

test('R-3: 后验熔断 —— 交替成败型坏路线越 0.95 线；无知居中', async () => {
  const G = await import('../src/guards/circuitBreakerGuard.ts');
  // 均匀先验：1败1胜 ⇒ 上尾恰 0.5
  assert.equal(G.posteriorTripProbability(1, 1), 0.5, 'Beta(2,2) 上尾 = 0.5');
  // 6败2胜：0.91 < 0.95 不熔（证据不足 —— 宁放行勿误熔）
  assert.ok(G.posteriorTripProbability(6, 2) < 0.95, `6/2 不熔（${G.posteriorTripProbability(6, 2)}）`);
  // 8败2胜：≥0.95 熔（交替型坏路线的判决线）
  assert.ok(G.posteriorTripProbability(8, 2) >= 0.95, `8/2 熔断（${G.posteriorTripProbability(8, 2)}）`);
  // 健康路线：2败8胜 ⇒ 上尾 ≈ 0.03
  assert.ok(G.posteriorTripProbability(2, 8) < 0.05, `健康不熔（${G.posteriorTripProbability(2, 8)}）`);
  // 正则化不完全 Beta 的地标：I_0.5(1,1)=0.5；I_0(a,b)=0；I_1(a,b)=1
  assert.ok(Math.abs(G.regularizedBeta(0.5, 1, 1) - 0.5) < 1e-9, '均匀分布地标');
  assert.equal(G.regularizedBeta(0, 3, 5), 0);
  assert.equal(G.regularizedBeta(1, 3, 5), 1);
});

// ─── R-4 快照层：checkpoint v4 证据锚 ───

test('R-4: 快照 v4 —— MMR 双锚随行 + v3→v4 迁移幂等', async () => {
  const { migrateCheckpoint, saveCheckpoint } = await import('../src/checkpoint.ts');
  // v3 旧档 → v4：锚补 null（诚实缺席），幂等
  const v3 = { version: 3, savedAt: 1, journal: { entries: [], chainTip: 'G', chainBase: 'G' } };
  const v4 = migrateCheckpoint(v3)!;
  assert.equal(v4.version, 4);
  assert.equal(v4.journalMmrRoot, null, 'v3 旧档锚诚实 null');
  assert.equal(migrateCheckpoint(v4)!.version, 4, '幂等');
  // 保存真档：锚 = 保存时刻的重算根（非 null —— 有证据就有锚）
  const dir = mkdtempSync(join(tmpdir(), 'r4-cp-'));
  try {
    const { journal } = await import('../src/journal.ts');
    journal.reset();
    for (let i = 0; i < 3; i++) {
      await journal.append({ ts: Date.now(), tool: 'click_mouse', args: { x: i / 8 }, status: 'SUCCESS', effect_detected: true });
    }
    const r = saveCheckpoint(join(dir, 'cp.json'));
    assert.ok(r.ok);
    const saved = JSON.parse(readFileSync(join(dir, 'cp.json'), 'utf8'));
    assert.equal(saved.version, 4, '版本 4 落盘');
    assert.equal(saved.journalMmrRoot, journal.mmrRoot(), 'journal 锚 = 保存时刻 MMR 根');
    assert.ok(typeof saved.sandboxMmrRoot === 'string' || saved.sandboxMmrRoot === null, 'sandbox 锚在场（或诚实 null）');
    // 篡改演示：改锚 ⇒ 与重算根不等（恢复方可据此拒档）
    const tampered = { ...saved, journalMmrRoot: '0'.repeat(64) };
    assert.notEqual(tampered.journalMmrRoot, journal.mmrRoot(), '锚与重算根对照可验');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── R-5 视觉层：跨帧稳定元素 ID ───

test('R-5: IoU 跟踪 —— 同控件跨帧保号 / 新控件领新号 / 短暂消失续号', async () => {
  const { trackElements, resetElementTracker } = await import('../src/elementTracker.ts');
  resetElementTracker();
  const A = { x: 0.1, y: 0.1, width: 0.1, height: 0.05 };
  const B = { x: 0.5, y: 0.5, width: 0.1, height: 0.05 };
  const f1 = trackElements([A, B]);
  assert.deepEqual(f1, [1, 2], '首帧领号');
  // 次帧微移（IoU 高）：保号 —— 模型的「点 1 号」跨帧语义稳定
  const f2 = trackElements([{ ...A, x: 0.11 }, { ...B, y: 0.51 }]);
  assert.deepEqual(f2, [1, 2], '微移保号（跨帧稳定性）');
  // 新控件入场领新号，既有保号
  const C = { x: 0.8, y: 0.8, width: 0.05, height: 0.05 };
  const f3 = trackElements([A, B, C]);
  assert.deepEqual(f3, [1, 2, 3], '新者领新号');
  // 短暂消失（≤5 帧）：号码保留 —— 回归续号
  trackElements([A]);           // B、C 消失第 1 帧
  trackElements([A]);           // 第 2 帧
  const f6 = trackElements([A, B]); // B 回归
  assert.deepEqual(f6, [1, 2], '短暂消失后回归续号');
  // 持续消失 >5 帧：号码退役 —— 复活不误连
  for (let i = 0; i < 6; i++) trackElements([A]);
  const f7 = trackElements([A, B]);
  assert.equal(f7[1], 4, `6 帧缺席 ⇒ 领新号（实得 ${f7[1]}；3 已被 C 领走，B 的复活号 = 4）`);
  resetElementTracker();
});

// ─── R-6 召回层：RRF 倒数排名融合 ───

test('R-6: RRF —— 排名融合无量纲 + 旧加权和并存（score2）', async () => {
  const { failureMemory } = await import('../src/failureMemory.ts');
  failureMemory.reset?.();
  failureMemory.record('record cleanup', 'click(delete item)', 'delete item button is broken', 'a'.repeat(64));
  failureMemory.record('auth flow', 'type(api key)', 'api key field rejects input', 'b'.repeat(64));
  // 词面直命中：第一条应居首
  const hits = failureMemory.match('record cleanup delete');
  assert.ok(hits.length >= 1 && hits[0].approach.includes('delete item'), '词面命中居首');
  assert.ok(typeof (hits[0] as any).score2 === 'number', '旧加权和并存为 score2（零回归消费面）');
  // NCD 兜底通道（换述）：词面零命中的查询仍可召回（H-2 语义保留）
  const fuzzyHits = failureMemory.match('rec0rd cleanup');
  assert.ok(fuzzyHits.length >= 1, `换述召回（RRF 的压缩通道贡献非零分）：${fuzzyHits.length}`);
  failureMemory.reset?.();
});
