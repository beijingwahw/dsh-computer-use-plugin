// scripts/realverify/probe-da6-vlm.mjs
// ΤΕΛ-9a 逐债探针 · D-A6:真 VLM 模型长跑稳定性（配置密钥后 N 轮）。
//
// 债（DEBTS D-A6）：七项效能数字全部为离线确定性基准；inset 的真 VLM IoU
// 在线 A/B 与 SoM 锚点真模型增益同族——待真模型/长跑在线对照。本探针把
// 「密钥到手那天」的收割动作一键化（配置密钥 → N 轮稳定性长跑）：
//
//   环境自检（硬件在场判定 = 真模型可达）：
//     密钥发现序：DSH_REALVERIFY_VLM_KEY > GLM_API_KEY > ZHIPUAI_API_KEY >
//     ZAI_API_KEY（与 src/config.ts 纪元 Ω 的环境变量方言同源）。
//     缺席 ⇒ absent（真模型缺席——exit 2，不红）。
//   在场执行（真模型在线长跑）：
//     a. N 轮文本 chat/completions（缺省 8 轮，DSH_REALVERIFY_VLM_ROUNDS，
//        上限 500——长跑预算由收割者定）；
//     b. 1 轮视觉冒烟（内嵌 96×96 PNG 帧走 image_url 多模态消息——与
//        glmClient 的 OpenAI 兼容消息形状同构；DSH_REALVERIFY_VLM_VISION=0 关）；
//     c. 逐轮记录 {ok, status, ms, tokens, err}——绝不因单轮失败中断长跑。
//   判定：
//     pass     = 全部轮 ok（成功率 100%——长跑稳定性的收款标准）；
//     degraded = 成功率 ≥80% 但 <100%（服务可达、稳定性未满——长跑数据在
//                案，结论「不稳」如实申报）；
//     fail     = 成功率 <80%，或全部轮 401/403（密钥无效/无权限——在场断言
//                不成立，真红）。
//
// 用法：
//   GLM_API_KEY=... node scripts/realverify/probe-da6-vlm.mjs [--force-absent]
// 退出码：0=pass / 1=fail / 2=absent（真模型缺席）/ 3=degraded。

import { finishProbe, forceAbsent, invoked } from './common.mjs';

const PROBE = 'scripts/realverify/probe-da6-vlm.mjs';

// ΤΕΛ-9: 内嵌 96×96 冒烟帧（浅底蓝框 "OK"——视觉轮的最小可信载荷，零外部文件依赖）
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAIAAABt+uBvAAACRklEQVR4nO3bMUvjYBzH8X9SbfFqEO4K'
  + 'erMucXETxVdR6uAgOOjgbnXu5KSzgwiCIIoovghfQ510tUOO84iJlGpz9Hqn0/lTab30+v1MaVNo++V5'
  + 'kvZp40RRZPg794V9IJDGCBIIJBBIIJBAIIFAAoEEAgkEEggkEEggkEAggUACgQQCCQQSCCQQSCCQQCC'
  + 'BQAKBBAIJBBIIJBBIIJBAIIFAAoEEAgkEEggkEEggkEAggUACgQQCCQQSCCQQSCCQQCCBQAKBBAIJBB'
  + 'IG7I18/8Z63OXl19c/mBEkEKjTU+x9AzUN3ndwYAQJBBIIJBBIIJBAIIFAAoEEAgkE+qeBzs7iUilYW'
  + 'AhKpeD8/L595/R0rb1Rqz0Wi0EQNO2//C4mXVzUT0/v9/c/e54bhs3V1e+jo+7sbK69t15P1tZuK5WR'
  + 'QiHVo7iLL25vL1pf9zyv9RSe55bL3u7u83UhlcqPYnFoamrQ0q2Lga6vH3z/+f1PTg5eXT20tw8OolzO'
  + 'mZ//ZKn3ccM7ScxxWhuNhh0exik/9HxEoPHxgWq18XSzWm1MTLQOea5rJyeFOE6OjmLr50DLy/mtrTA'
  + 'MEzMLw+b2driykjezTMaGh53NzZGdnbunSdePZ7G5uVyt9ri09C2bbU2rxcX8zMzvU5iZjY1lNja8cv'
  + 'l2+PhLNvtr7qWS89YrDv0/C5e9u+TKrxqdlOoPaWlAIIFAAoEEAgkEEggkEEggkEAggUACgQQCCQTq2'
  + 'oKZ3/t/d30NRpBAoE4vufYbRpBAIIFAAoEEAgkEEggkEEggkEAggUACgQQCCQQSCCQQSCCQQCCBQAKB'
  + 'BAIJBBIIJBBIIJBAIHvZT3hOgH6EkMIqAAAAAElFTkSuQmCC';

function discoverKey(env) {
  // ΤΕΛ-9: 密钥发现序与 src/config.ts（vlmApiKey 描述）同源
  if (env.DSH_REALVERIFY_VLM_KEY) return { key: env.DSH_REALVERIFY_VLM_KEY, via: 'DSH_REALVERIFY_VLM_KEY' };
  for (const name of ['GLM_API_KEY', 'ZHIPUAI_API_KEY', 'ZAI_API_KEY']) {
    if (env[name]) return { key: env[name], via: name };
  }
  return null;
}

async function callOnce({ baseUrl, apiKey, model, vision, timeoutMs }) {
  // ΤΕΛ-9: 单轮真调用——OpenAI 兼容 chat/completions（glmClient 消息形状同构），
  // 任何异常（网络/超时/非 2xx）折叠为 {ok:false,...}，绝不抛出中断长跑。
  const t0 = Date.now();
  try {
    const content = vision
      ? [
        { type: 'text', text: '图中有什么形状和文字？一句话中文回答。' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${TINY_PNG_B64}` } },
      ]
      : '回显探针轮次：请只回复 JSON {"ok":true}，不要多余文字。';
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content }],
        max_tokens: vision ? 256 : 64,
        temperature: 0.1,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const ms = Date.now() - t0;
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, status: res.status, ms, err: body.slice(0, 160) };
    }
    const data = await res.json().catch(() => null);
    const content2 = data?.choices?.[0]?.message?.content;
    return {
      ok: typeof content2 === 'string' && content2.length > 0,
      status: res.status,
      ms,
      tokens: data?.usage?.total_tokens ?? null,
      content_len: typeof content2 === 'string' ? content2.length : 0,
    };
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - t0, err: `${e?.name ?? 'Error'}: ${(e?.message ?? String(e)).slice(0, 160)}` };
  }
}

async function main() {
  const env = process.env;
  if (forceAbsent()) {
    return ['absent', '设备缺席——force-absent（离线测试强制缺席路径）', { forced: true }];
  }
  const found = discoverKey(env);
  if (!found) {
    return ['absent', '设备缺席——真 VLM 密钥缺席（GLM_API_KEY/ZHIPUAI_API_KEY/ZAI_API_KEY 或 DSH_REALVERIFY_VLM_KEY 任一）', {
      env_seen: ['GLM_API_KEY', 'ZHIPUAI_API_KEY', 'ZAI_API_KEY', 'DSH_REALVERIFY_VLM_KEY'].map(k => ({ k, set: Boolean(env[k]) })),
    }];
  }
  const baseUrl = (env.DSH_REALVERIFY_VLM_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4').replace(/\/+$/, '');
  const model = env.DSH_REALVERIFY_VLM_MODEL || 'glm-5.3-flash';
  const rounds = Math.max(1, Math.min(500, parseInt(env.DSH_REALVERIFY_VLM_ROUNDS || '8', 10) || 8));
  const vision = env.DSH_REALVERIFY_VLM_VISION !== '0';
  const timeoutMs = Math.max(10_000, parseInt(env.DSH_REALVERIFY_VLM_TIMEOUT_MS || '60000', 10) || 60_000);

  const evidence = { key_via: found.via, base_url: baseUrl, model, rounds, vision_round: vision, timeout_ms: timeoutMs };
  const roundsOut = [];
  for (let i = 0; i < rounds; i++) {
    const r = await callOnce({ baseUrl, apiKey: found.key, model, vision: false, timeoutMs });
    roundsOut.push({ i: i + 1, ...r });
    process.stderr.write(`[D-A6] round ${i + 1}/${rounds} ${r.ok ? 'ok' : `FAIL(${r.status})`} ${r.ms}ms\n`);
  }
  let visionOut = null;
  if (vision) {
    visionOut = await callOnce({ baseUrl, apiKey: found.key, model, vision: true, timeoutMs });
    process.stderr.write(`[D-A6] vision ${visionOut.ok ? 'ok' : `FAIL(${visionOut.status})`} ${visionOut.ms}ms\n`);
  }
  const okCount = roundsOut.filter(r => r.ok).length;
  const all = vision ? [...roundsOut, visionOut] : roundsOut;
  const okAll = all.filter(r => r.ok).length;
  const authFail = all.length > 0 && all.every(r => r.status === 401 || r.status === 403);
  evidence.rounds = roundsOut.map(r => ({ i: r.i, ok: r.ok, status: r.status, ms: r.ms, tokens: r.tokens ?? null }));
  evidence.vision = visionOut;
  evidence.stats = {
    total: all.length, ok: okAll, success_rate: Number((okAll / all.length).toFixed(4)),
    p50_ms: median(all.map(r => r.ms)), max_ms: Math.max(...all.map(r => r.ms)),
    total_tokens: all.reduce((s, r) => s + (r.tokens ?? 0), 0),
  };

  if (authFail) {
    return ['fail', `密钥无效/无权限（全部轮 401/403，via ${found.via}）——在场断言不成立`, evidence];
  }
  if (okAll === all.length) {
    return ['pass', `真 VLM 长跑稳定：${okAll}/${all.length} 轮全过（${rounds} 文本${vision ? '+1 视觉' : ''}，p50 ${evidence.stats.p50_ms}ms，模型 ${model}）—— D-A6 长跑证据可收割`, evidence];
  }
  if (okAll / all.length >= 0.8) {
    return ['degraded', `服务可达但稳定性未满：${okAll}/${all.length}（成功率 ${(100 * okAll / all.length).toFixed(1)}%）——长跑数据在案，结论「不稳」如实申报`, evidence];
  }
  return ['fail', `真模型长跑失败面超阈：${okAll}/${all.length} 成功——真红（网络/配额/模型名逐轮证据在案）`, evidence];
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

if (invoked(import.meta.url)) {
  const t0 = Date.now();
  try {
    const [verdict, summary, evidence] = await main();
    finishProbe({ debt: 'D-A6', probe: PROBE, verdict, summary, evidence, elapsedMs: Date.now() - t0 });
  } catch (e) {
    // ΤΕΛ-9: 探针绝不裸抛——意外异常折叠为结构化 fail
    finishProbe({ debt: 'D-A6', probe: PROBE, verdict: 'fail', summary: '探针异常（诚实失败码）', evidence: {}, elapsedMs: Date.now() - t0, error: `${e?.stack ?? e}` });
  }
}
