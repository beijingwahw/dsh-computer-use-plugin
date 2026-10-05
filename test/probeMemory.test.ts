// test/probeMemory.test.ts
// Z 纪元（Z-1d）：探针判决记忆 —— 入册/召回/失效/降级律全矩阵。
// 64 位 dHash hex：相似度 = 1 - 汉明/64 —— 用已知距离的指纹构造场景。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { probeMemory, isDecisive } from '../src/probeMemory.ts';
import { gateTextClick, TEXT_CLICK_REFUSE_FLOOR } from '../src/interactivityProbe.ts';
import type { ProbeResult } from '../src/interactivityProbe.ts';

const CFG = {
  probeMemoryTtlMs: 300_000,
  probeMemoryCapacity: 128,
  probeMemorySceneSimilarity: 0.9,   // ⇒ 汉明距离 ≤ 6 可召回
  probeRecallRadius: 0.015,
};

// 16-hex 指纹构造器：与 base 恰差 n 个 hex 位（每 hex 位翻转若干 bit，
// 用可控不同的字符保证 hex 级差异；距离上界 = n×4，下界 ≥1 —— 测试只
// 用「同指纹」与「大差异指纹」两个确定极端 + 一个中等差异的拒配向。
const FP_A = '0123456789abcdef';
const FP_FAR = 'fedcba9876543210';   // 全位不同 —— 必然远超阈值

function result(x: number, y: number, verdict: 'control' | 'text' | 'inconclusive',
                via: 'uia' | 'hover' = 'uia'): ProbeResult {
  return {
    point: { x, y },
    verdict,
    confidence: verdict === 'control' ? 0.97 : verdict === 'text' ? 0.93 : 0.3,
    evidence: {
      via,
      cursor_kind: via === 'hover' ? 'ibeam' : 'n/a',
      hover_repaint: false,
      repaint_similarity: null,
      dwell_ms: 0,
      ...(verdict !== 'inconclusive' ? {
        hit_test: {
          control_type: verdict === 'control' ? 'Button' : 'Text',
          name: '',
          classification: verdict,
          matched_depth: null,
        },
      } : {}),
    },
  };
}

beforeEach(() => probeMemory.reset());

test('Z-1d-a: 判决性结论入册，同场景邻近点召回（via=memory + 降级律）', () => {
  probeMemory.store(FP_A, result(0.5, 0.5, 'control'), CFG);
  // 邻近点（距离 0.01 ≤ 0.015）：OCR bbox 微抖容忍带内
  const hit = probeMemory.recall(FP_A, { x: 0.505, y: 0.505 }, CFG);
  assert.ok(hit);
  assert.equal(hit.verdict, 'control');
  assert.equal(hit.evidence.via, 'memory');
  assert.equal(hit.confidence, 0.89);                    // ΠΑΝ-131 降级律 -0.03 后封顶 0.89（先减后夹；
                                                          // 旧封顶 0.9 使 UIA text 0.93 召回恰落地板 0.90）
  assert.ok(hit.note?.includes('hits=2'));               // 召回即续期计数
});

test('Z-1d-b: inconclusive 不入册 —— 「不知道」不是证据', () => {
  probeMemory.store(FP_A, result(0.5, 0.5, 'inconclusive'), CFG);
  assert.equal(probeMemory.size, 0);
  assert.equal(probeMemory.recall(FP_A, { x: 0.5, y: 0.5 }, CFG), null);
  assert.equal(isDecisive('inconclusive'), false);
  assert.equal(isDecisive('control'), true);
  assert.equal(isDecisive('text'), true);
});

test('Z-1d-c: 场景不匹配不召回（聊天滚动/换界面 ⇒ 指纹漂移 ⇒ 重实验）', () => {
  probeMemory.store(FP_A, result(0.5, 0.5, 'text'), CFG);
  assert.equal(probeMemory.recall(FP_FAR, { x: 0.5, y: 0.5 }, CFG), null);
});

test('Z-1d-d: 点距超半径不召回（不同控件不共享判决）', () => {
  probeMemory.store(FP_A, result(0.5, 0.5, 'control'), CFG);
  assert.equal(probeMemory.recall(FP_A, { x: 0.6, y: 0.5 }, CFG), null); // 距离 0.1
});

test('Z-1d-e: TTL 过期不召回（时间维失效）', () => {
  probeMemory.store(FP_A, result(0.5, 0.5, 'control'), CFG);
  // 直接改内部时钟不可取；用极小 TTL 语义等价验证
  const tiny = { ...CFG, probeMemoryTtlMs: -1 };
  assert.equal(probeMemory.recall(FP_A, { x: 0.5, y: 0.5 }, tiny), null);
});

test('Z-1d-f: 就近强化不重复入册（同场景同区域 ⇒ hits 滚动）', () => {
  probeMemory.store(FP_A, result(0.5, 0.5, 'control'), CFG);
  probeMemory.store(FP_A, result(0.51, 0.51, 'control'), CFG);
  assert.equal(probeMemory.size, 1);
  probeMemory.store(FP_A, result(0.5, 0.5, 'text'), CFG);   // 判决以新覆旧
  const hit = probeMemory.recall(FP_A, { x: 0.5, y: 0.5 }, CFG);
  assert.ok(hit);
  assert.equal(hit.verdict, 'text');                       // 新事实覆盖旧判决
});

test('Z-1d-g: 容量 LRU 驱逐 —— 最旧先走', async () => {
  const small = { ...CFG, probeMemoryCapacity: 2, probeRecallRadius: 0 };
  probeMemory.configure(2);
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
  probeMemory.store(FP_A, result(0.1, 0.1, 'control'), small);
  await sleep(3);                                        // 保证时间戳严格递增（LRU 确定性）
  probeMemory.store(FP_A + '0', result(0.2, 0.2, 'control'), small);
  await sleep(3);
  probeMemory.store(FP_A + '1', result(0.3, 0.3, 'control'), small);  // 第三条 ⇒ 驱逐最旧
  assert.equal(probeMemory.size, 2);
  assert.equal(probeMemory.recall(FP_A, { x: 0.1, y: 0.1 }, small), null);      // 已驱逐
  assert.ok(probeMemory.recall(FP_A + '1', { x: 0.3, y: 0.3 }, small));          // 幸存
  probeMemory.configure(128);
});

test('Z-1d-h: dump/restore 往返保真（checkpoint 存活）', () => {
  probeMemory.store(FP_A, result(0.5, 0.5, 'text', 'hover'), CFG);
  const dump = probeMemory.dump();
  probeMemory.reset();
  assert.equal(probeMemory.recall(FP_A, { x: 0.5, y: 0.5 }, CFG), null);
  probeMemory.restore(dump);
  const hit = probeMemory.recall(FP_A, { x: 0.5, y: 0.5 }, CFG);
  assert.ok(hit);
  assert.equal(hit.verdict, 'text');
  assert.ok(hit.evidence.hit_test);                       // hover 通道的 text 判决保留证据面
});

// ─── ΠΑΝ-131：召回封顶 0.89 —— 诚实召回不再被点击拦截地板执法 ───
//
// 病灶（F3-11 复核件移交）：旧封顶 min(0.9, conf−0.03) 下，UIA text 0.93
// 存档召回恰为 0.90 == TEXT_CLICK_REFUSE_FLOOR(0.9)（0.93−0.03 浮点恰等于
// 0.9，实测锁定），gateTextClick 的「verdict=text 且 conf ≥ 地板 ⇒ 拦」在
// 等值边界照拦 ⇒ −0.03 降级对该通道是装饰性的（陈旧记忆拦住合法点击）。
// 修法：封顶 0.89（低于地板）—— 记忆只标注、不执法；新鲜判决不经封顶，
// 地板语义方向零变化。

test('ΠΑΝ-131-a: UIA text 0.93 存档召回 0.89 < 地板 —— 点击闸门放行（0.90 边界误拦消除）', () => {
  probeMemory.store(FP_A, result(0.5, 0.5, 'text'), CFG);   // UIA text 0.93（Text 控件）
  const hit = probeMemory.recall(FP_A, { x: 0.5, y:0.5 }, CFG);
  assert.ok(hit);
  assert.equal(hit.evidence.via, 'memory');
  // 0.93−0.03 === 0.9（浮点恰等），min(0.89, 0.9) = 0.89 —— 召回恒低于地板
  assert.equal(hit.confidence, 0.89);
  assert.ok(hit.confidence < TEXT_CLICK_REFUSE_FLOOR);
  // 端到端：召回判决喂给点击闸门不再拦截（记忆是先验，只标注不执法）
  const gate = gateTextClick(hit);
  assert.equal(gate.blocked, false);
});

test('ΠΑΝ-131-b: 地板语义方向不变 —— 新鲜决定性 text 0.91 仍拦、恰 0.90 等值仍拦', () => {
  // 0.91 的新鲜 UIA text 判决：地板照拦（封顶只作用于召回路径，不软化闸门）
  const fresh91 = result(0.5, 0.5, 'text');
  fresh91.confidence = 0.91;
  assert.deepEqual(gateTextClick(fresh91).blocked, true);
  // 恰 0.90 的等值边界：闸门自身语义零变化（≥ 地板即拦 —— 等值属于拦截侧）
  const fresh90 = result(0.5, 0.5, 'text');
  fresh90.confidence = 0.90;
  assert.deepEqual(gateTextClick(fresh90).blocked, true);
  // 对照：0.89（< 地板）放行 —— 单调性锚
  const fresh89 = result(0.5, 0.5, 'text');
  fresh89.confidence = 0.89;
  assert.deepEqual(gateTextClick(fresh89).blocked, false);
});

test('ΠΑΝ-131-c: ibeam 0.92 通道召回 0.89 不拦（降级有效性保持，零回归）', () => {
  const ibeam = result(0.5, 0.5, 'text', 'hover');          // ibeam 0.92
  ibeam.confidence = 0.92;
  probeMemory.store(FP_A, ibeam, CFG);
  const hit = probeMemory.recall(FP_A, { x: 0.5, y: 0.5 }, CFG);
  assert.ok(hit);
  assert.equal(hit.confidence, 0.89);                       // min(0.89, 0.92−0.03) = 0.89
  assert.equal(gateTextClick(hit).blocked, false);          // 旧行为已不拦，新行为一致
});
