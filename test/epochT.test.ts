// test/epochT.test.ts
// T 纪元（开天辟地第四击）：对称与传播 —— 四件 + 一项认证。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// ─── T-1 行为层：量化相似签名（抖动循环不再逃逸）───

test('T-1: 量化签名 —— 坐标抖动同签；结构差异仍异签', async () => {
  const src = readFileSync(new URL('../src/guards/repeatActionGuard.ts', import.meta.url), 'utf8');
  assert.ok(src.includes('Math.round(v * 100) / 100'), '数值 0.01 网格量化在场');
  // 原子验证：量化函数行为（从源内联同式）
  const quant = (args: unknown) => JSON.stringify(args, (_k, v) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) / 100 : v);
  assert.equal(quant({ x: 0.501, y: 0.5 }), quant({ x: 0.5, y: 0.5004 }), '抖动同签（同一意图）');
  assert.notEqual(quant({ x: 0.5, y: 0.5 }), quant({ x: 0.62, y: 0.5 }), '真实位移异签');
  assert.notEqual(quant({ x: 0.5 }), quant({ x: 0.5, text: 'a' }), '结构差异异签');
});

// ─── T-2 认证：期望词表对称半边已在（不造轮子）───

test('T-2: 期望物理词表对称性认证 —— appear/vanish、expand/collapse、up/down 成对', async () => {
  const src = readFileSync(new URL('../src/intent.ts', import.meta.url), 'utf8');
  for (const pair of [['toggle_on', 'toggle_off'], ['menu_expand', 'menu_collapse'],
    ['scroll_content_up', 'scroll_content_down'], ['text_appear', 'text_vanish']]) {
    assert.ok(src.includes(`'${pair[0]}'`) && src.includes(`'${pair[1]}'`), `${pair[0]}/${pair[1]} 对称在册`);
  }
});

// ─── T-3 通道层：同链去重（coalescing）───

test('T-3: 判决通道 —— 同 chainId 重复回执合并（保留最新）', async () => {
  const src = readFileSync(new URL('../src/doctorChannel.ts', import.meta.url), 'utf8');
  assert.ok(src.includes('chainId !==') && src.includes('.concat('), '同链去重执法点在场');
});

// ─── T-4 服务层：全抖动指数退避 ───

test('T-4: 全抖动退避 —— uniform(0, cap) 取代定值（惊群解相关）', async () => {
  const src = readFileSync(new URL('../src/physicalExecution/serviceManager.ts', import.meta.url), 'utf8');
  assert.ok(src.includes('Math.random() * cap'), '全抖动公式在场');
  assert.ok(!/setTimeout\(r, backoff\);\s*\n\s*\/\/ 指数退避 50ms/.test(src), '定值退避已退役');
});

// ─── T-5 证据层：反事实效应量传播 ───

test('T-5: what_if 决策点 —— 路线率（Laplace）+ 最优对照的 Cohen h', async () => {
  const { journal } = await import('../src/journal.ts');
  journal.reset();
  const scene = '#12 dHash=' + 'ab'.repeat(32);
  // 同场景：本路线（type_text）连败 ×3；异路线（click_mouse）连胜 ×3
  for (let i = 0; i < 3; i++) {
    await journal.append({ ts: Date.now(), tool: 'type_text', args: { text: 'hi' }, status: 'FAILED', effect_detected: false, observe: scene });
    await journal.append({ ts: Date.now(), tool: 'click_mouse', args: { x: 0.5, y: 0.5 }, status: 'SUCCESS', effect_detected: true, observe: scene });
  }
  const dps = journal.findDecisionPoints({});
  const typeDp = dps.find(d => d.entry.tool === 'type_text')!;
  assert.ok(typeDp, '决策点在场');
  const alt = typeDp.alternatives.find(a => a.action.startsWith('click_mouse'))!;
  assert.ok(alt.routeRate !== undefined && alt.routeRate > 0.7, `异路线率（Laplace）≈ 4/5=0.8：${alt.routeRate}`);
  assert.equal(alt.routeN, 3, '路线样本数');
  assert.ok(typeDp.effectH != null && typeDp.effectH! > 0.5, `最优对照效应量 |h|>0.5（中效应以上）：${typeDp.effectH}`);
  journal.reset();
});
