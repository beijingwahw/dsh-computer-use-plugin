// test/w5cascade.bench.ts  ——  W5-6 效能基准包 · C2 级联路由省钱命中率与节省率
//
// 被测声明（W2-8，providers/cascade C2 tier cascade）：三因子分诊 + 便宜臂
// 确定性校验 ⇒ 便宜命中省钱（价差 75%）、校验不过升级主力重做（多花 0.25
// 诚实负节省）、高危直行主力。GENESIS 为机制声明（未给数值档），任务书
// 口径：省钱命中率与节省率按 metering 台账对账。
//
// 口径（声明值 vs 实测值，逐项入 console 表）：
//   · 混合工作负载 N=20 次定位请求（离线假 provider，零网络）：
//     12 次易场景且便宜答案过校验（命中）+ 3 次易场景但便宜答案出界
//     （升级重做）+ 5 次高危因子（分诊直行主力）；
//   · 价格：主力 1.0 / 便宜 0.25（缺省相对价格）；
//   · 闭式预期（手算）：eligible=15、cheapHit=12、escalated=3、hitRate=0.8；
//     spent = 15×0.25 + 3×1 = 6.75；baseline = 15×1 = 15；
//     saved = 8.25；savingsRate = 0.55（= 命中率 0.8 × 价差比 0.75 −
//     升级罚 0.2×0.25）；
//   · 台账对账：假 provider 的真实调用计数 ↔ CascadeStats 逐字段互证
//     （cheap.calls = cheapTier.calls；primary.calls = primaryTier.calls +
//     primaryDirect —— 直行主力的钱不在级联队列内，只观测计数）。
//
// 确定性：假 provider 按调用序脚本化回复，无随机无真网络；两次运行同账。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type {
  ProviderTier,
  VisionChatRequest,
  VisionChatResult,
  VisionProvider,
} from '../src/vlm/providers/types.ts';
import { ProviderPool } from '../src/vlm/providers/failover.ts';
import {
  VlmCascade,
  withinBboxValidator,
  schemaValidator,
} from '../src/vlm/providers/cascade.ts';

// ─── 假 VisionProvider（w2cascade.test.ts 同律：脚本化回复 + 调用计数） ───

function fakeBrain(
  id: string,
  replies: string[],
  o: { tier?: ProviderTier } = {},
): VisionProvider & { calls: number } {
  let calls = 0;
  const model = `m-${id}`;
  const self: VisionProvider & { calls: number } = {
    id,
    protocol: 'openai',
    model,
    configured: true,
    ...(o.tier !== undefined ? { tier: o.tier } : {}),
    get calls() { return calls; },
    async chat(r: VisionChatRequest): Promise<VisionChatResult> {
      void r;
      const text = replies[Math.min(calls, replies.length - 1)] ?? `ok@${id}`;
      calls++;
      return { ok: true, text, latencyMs: 7, model, providerId: id };
    },
    async chatJson<T>(r: VisionChatRequest): Promise<{ ok: boolean; value?: T; error?: string; raw: string }> {
      const res = await self.chat(r);
      return res.ok ? { ok: true, value: res.text as T, raw: res.text } : { ok: false, error: res.error, raw: '' };
    },
  };
  return self;
}

function req(): VisionChatRequest {
  return { images: [{ base64: 'QUJD' }], prompt: '定位目标并输出 JSON', timeoutMs: 200, maxRetries: 0 };
}

const TARGET_BBOX = { x0: 100, y0: 50, x1: 200, y1: 150 };
const EASY = { confidence: 0.95, risk: 'low' as const, sceneFamiliar: true };   // danger 0 ⇒ 便宜可试
const RISKY = { confidence: 0.2, risk: 'high' as const, sceneFamiliar: false }; // danger 高 ⇒ 直行主力

const IN_BOX = '{"point":{"x":120,"y":80}}';   // 过 bbox 谓词（便宜命中样本）
const OUT_BOX = '{"point":{"x":500,"y":500}}'; // 出界 ⇒ 升级主力重做

// ─── C2 基准 ───

test('W5-6/C2: 级联路由 —— 混合负载省钱命中率与节省率（台账对账 + 闭式互证）', async () => {
  const HITS = 12, ESCALATIONS = 3, DANGER = 5;
  const CHEAP_PRICE = 0.25, PRIMARY_PRICE = 1;

  // 假脑脚本：便宜脑 12 好答案 + 3 出界；主力脑 3 次升级重做（好答案）+ 5 次直行
  const cheap = fakeBrain('glm-flash', [
    ...Array.from({ length: HITS }, () => IN_BOX),
    ...Array.from({ length: ESCALATIONS }, () => OUT_BOX),
  ], { tier: 'cheap' });
  const primary = fakeBrain('glm-pro', [IN_BOX]);
  const pool = new ProviderPool([primary, cheap]);
  const cascade = new VlmCascade(pool, {
    validators: [schemaValidator({ point: 'object' }), withinBboxValidator(TARGET_BBOX)],
  });

  // 混合负载：12 命中 → 3 升级 → 5 高危直行（级联弃权 ⇒ 调用方主路径走主力）
  let okAnswers = 0;
  for (let i = 0; i < HITS; i++) {
    const r = await cascade.runJson(req(), { factors: EASY });
    if (r && r.ok && r.providerId === 'glm-flash') okAnswers++;
  }
  let escalated = 0;
  for (let i = 0; i < ESCALATIONS; i++) {
    const r = await cascade.runJson(req(), { factors: EASY });
    if (r && r.ok && r.providerId === 'glm-pro' && r.meta.escalated === true) escalated++;
  }
  let directPrimary = 0;
  for (let i = 0; i < DANGER; i++) {
    const r = await cascade.runJson(req(), { factors: RISKY });
    if (r === null) { // 弃权 ⇒ 主路径直行主力（生产同律）
      const p = await pool.chat(req());
      if (p.ok && p.providerId === 'glm-pro') directPrimary++;
    }
  }

  const s = cascade.stats;
  // 闭式预期（手算）
  const eligible = HITS + ESCALATIONS;
  const spentClosed = eligible * CHEAP_PRICE + ESCALATIONS * PRIMARY_PRICE;
  const baselineClosed = eligible * PRIMARY_PRICE;
  const savedClosed = baselineClosed - spentClosed;
  const rateClosed = savedClosed / baselineClosed;

  console.log([
    `── W5-6/C2 级联路由节省率（N=${HITS + ESCALATIONS + DANGER} 次定位，主力 ${PRIMARY_PRICE}/便宜 ${CHEAP_PRICE}）──`,
    `队列: eligible=${s.eligible} cheapHit=${s.cheapHit} escalated=${s.escalated} 高危直行=${s.primaryDirect}`,
    `命中率 hitRate = ${s.hitRate.toFixed(4)}（预期 0.8）`,
    `花费: spent=${s.spentUnits}（cheap ${s.cheapTier.units} + primary ${s.primaryTier.units}）/ 基线 baseline=${s.baselineUnits}`,
    `净节省 saved=${s.savedUnits}（预期 ${savedClosed}）⇒ 节省率 savingsRate=${s.savingsRate.toFixed(4)}（闭式 ${rateClosed.toFixed(4)} = 命中率×价差比 − 升级罚）`,
    `对账: cheap 实拨 ${cheap.calls} = 台账 ${s.cheapTier.calls}；primary 实拨 ${primary.calls} = 台账 ${s.primaryTier.calls}+直行 ${s.primaryDirect}`,
  ].join('\n'));

  // ── 断言（声明值 vs 实测值） ──
  assert.equal(okAnswers, HITS, '12 次便宜命中且采信便宜答案');
  assert.equal(escalated, ESCALATIONS, '3 次出界升级主力重做');
  assert.equal(directPrimary, DANGER, '5 次高危直行主力');
  // 台账对账（假 provider 计数 ↔ 结构化台账逐字段）
  assert.equal(s.eligible, eligible);
  assert.equal(s.cheapHit, HITS);
  assert.equal(s.escalated, ESCALATIONS);
  assert.equal(s.primaryDirect, DANGER);
  assert.equal(cheap.calls, s.cheapTier.calls, '便宜实拨数 = 台账');
  assert.equal(primary.calls, s.primaryTier.calls + s.primaryDirect, '主力实拨数 = 升级重做 + 高危直行');
  // 数值闭式互证
  assert.ok(Math.abs(s.hitRate - HITS / eligible) < 1e-12, `命中率闭式（实测 ${s.hitRate}）`);
  assert.ok(Math.abs(s.spentUnits - spentClosed) < 1e-12, `花费闭式（实测 ${s.spentUnits}）`);
  assert.equal(s.baselineUnits, baselineClosed);
  assert.ok(Math.abs(s.savedUnits - savedClosed) < 1e-12, `净节省闭式（实测 ${s.savedUnits}）`);
  assert.ok(Math.abs(s.savingsRate - rateClosed) < 1e-12, `节省率闭式（实测 ${s.savingsRate}）`);
  // 声明口径：机制省钱成立（混合负载下净节省为正且命中一次省价差 75%）
  assert.ok(s.savedUnits > 0, `混合负载净节省应为正（实测 ${s.savedUnits}）`);
  assert.ok(Math.abs((PRIMARY_PRICE - CHEAP_PRICE) / PRIMARY_PRICE - 0.75) < 1e-12, '单次命中省价差 75%（价格口径）');
});

test('W5-6/C2b: 反事实对照 —— 同负载全主力直行的花费（级联价值的经济下界）', async () => {
  // 同 15 次可级联请求若无级联：15 × 主力价 = 15 单位；有级联：6.75 单位。
  // 该对照即 baselineUnits 的语义 —— 上面一测已闭式对账，此处补独立复算。
  const HITS = 12, ESCALATIONS = 3;
  const noCascadeCost = (HITS + ESCALATIONS) * 1;
  const cascadeCost = (HITS + ESCALATIONS) * 0.25 + ESCALATIONS * 1;
  console.log(`── W5-6/C2b 反事实对照: 全主力 ${noCascadeCost} 单位 vs 级联 ${cascadeCost} 单位 ⇒ 省 ${((1 - cascadeCost / noCascadeCost) * 100).toFixed(1)}% ──`);
  assert.ok(cascadeCost < noCascadeCost, '级联队列花费 < 全主力反事实（价值成立）');
});
