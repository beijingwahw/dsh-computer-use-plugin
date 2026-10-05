// scripts/realverify/probe-db1-som.mjs
// ΤΕΛ-9a 逐债探针 · D-B1:稀疏 SoM 在线 A/B（somSparseBudget 翻转开闸证据）。
//
// 债（DEBTS D-B1）：somSparseBudget 缺省 0——调用面已接进 orchestration L3
// 生产管线（D-B3 已闭），但翻转稀疏默认改变标注输出面，留待真机在线 A/B
// 证据。本探针把「真模型 + 真屏帧到手那天」的开闸 A/B 一键化：
//
//   环境自检（在场判定）：
//     1. 真 VLM 密钥（发现序与 D-A6 探针同源：DSH_REALVERIFY_VLM_KEY >
//        GLM_API_KEY > ZHIPUAI_API_KEY > ZAI_API_KEY）——缺席 ⇒ absent；
//     2. 真屏帧：DSH_REALVERIFY_SCREEN 指向一张真实截图 PNG/JPEG——
//        缺席 ⇒ degraded（真模型在场、真屏帧缺席——A/B 需要真实屏幕内容）；
//     3. dist/vlm/som.js 在场（npm run build 产物——renderSomOverlay 与
//        grounding 提示词的 TS 权威源构建件）——缺席 ⇒ degraded。
//   在场执行（在线 A/B——同一帧、两臂、同提示词、交替轮次）：
//     A 臂（现状默认）：原图（无叠加）→ grounding（buildGroundingSystemPrompt
//                      /buildGroundingUserPrompt 同源提示词）→ 元素清单；
//     B 臂（开闸形态）：renderSomOverlay 叠加编号标记（synthetic 网格锚点，
//                      sparseBudget=N 的稀疏选择路径真执行）→ 同问 grounding
//                      → 元素清单 + 模型对标记 id 的引用率；
//     每臂 R 轮交替（缺省各 3 轮，DSH_REALVERIFY_SOM_ROUNDS，上限 50）。
//   判定：
//     pass     = 两臂全部轮合法 JSON + B 臂可观测差异（标记引用率 >0 或元素
//                数中位差 ≠0）——A/B 证据成对可收割；
//     degraded = 两臂合法但无可观测差异（开闸收益未显——负结果如实申报，
//                同样构成「在线 A/B 证据」用于开闸决策）；
//     fail     = 任臂 JSON 全败 / API 全败（对照无法建立——真红）。
//
// 用法：
//   GLM_API_KEY=... DSH_REALVERIFY_SCREEN=/path/shot.png \
//     node scripts/realverify/probe-db1-som.mjs [--force-absent]
// 退出码：0=pass / 1=fail / 2=absent（真模型缺席）/ 3=degraded。

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { finishProbe, forceAbsent, invoked, distModule } from './common.mjs';

const PROBE = 'scripts/realverify/probe-db1-som.mjs';

function discoverKey(env) {
  // ΤΕΛ-9: 密钥发现序与 D-A6 探针同源（单一方言）
  if (env.DSH_REALVERIFY_VLM_KEY) return { key: env.DSH_REALVERIFY_VLM_KEY, via: 'DSH_REALVERIFY_VLM_KEY' };
  for (const name of ['GLM_API_KEY', 'ZHIPUAI_API_KEY', 'ZAI_API_KEY']) {
    if (env[name]) return { key: env[name], via: name };
  }
  return null;
}

async function groundingOnce({ baseUrl, apiKey, model, b64, mime, width, height, question, timeoutMs, som }) {
  // ΤΕΛ-9: 一轮 grounding 调用——提示词经 dist/vlm/som.js 的 TS 权威源（与
  // 生产 grounding 同字面），返回 {ok, ms, elements, raw_len, err}
  const t0 = Date.now();
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: som.buildGroundingSystemPrompt() },
          { role: 'user', content: [
            { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
            { type: 'text', text: som.buildGroundingUserPrompt({ width, height, question }) },
          ] },
        ],
        max_tokens: 2048,
        temperature: 0.1,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const ms = Date.now() - t0;
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, ms, status: res.status, err: body.slice(0, 160), elements: null };
    }
    const data = await res.json().catch(() => null);
    const text = typeof data?.choices?.[0]?.message?.content === 'string' ? data.choices[0].message.content : '';
    let elements = null;
    try {
      const m = text.match(/\[[\s\S]*\]/); // ΤΕΛ-9: 容忍围栏/前后缀——取首个 JSON 数组
      elements = m ? JSON.parse(m[0]) : null;
      if (Array.isArray(elements)) elements = elements.filter(e => e && typeof e === 'object');
      else elements = null;
    } catch { elements = null; }
    return { ok: Array.isArray(elements), ms, status: res.status, elements, raw_len: text.length };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, status: 0, err: `${e?.name ?? 'Error'}: ${(e?.message ?? String(e)).slice(0, 160)}`, elements: null };
  }
}

async function main() {
  const env = process.env;
  if (forceAbsent()) {
    return ['absent', '设备缺席——force-absent（离线测试强制缺席路径）', { forced: true }];
  }
  const found = discoverKey(env);
  if (!found) {
    return ['absent', '设备缺席——真 VLM 密钥缺席（A/B 的在线对照端不可达）', {
      env_seen: ['GLM_API_KEY', 'ZHIPUAI_API_KEY', 'ZAI_API_KEY', 'DSH_REALVERIFY_VLM_KEY'].map(k => ({ k, set: Boolean(env[k]) })),
    }];
  }
  const evidence = { key_via: found.via };

  // ── 真屏帧 + dist 权威源在场判定 ──
  const screenPath = env.DSH_REALVERIFY_SCREEN || env.DSH_REALVERIFY_IMAGE || '';
  let imgBuf = null;
  let mime = 'image/png';
  if (screenPath) {
    try {
      imgBuf = readFileSync(screenPath);
      if (screenPath.toLowerCase().endsWith('.jpg') || screenPath.toLowerCase().endsWith('.jpeg')) mime = 'image/jpeg';
    } catch (e) {
      evidence.screen_read_error = `${e?.message ?? e}`;
    }
  }
  const somPath = distModule('vlm/som.js');
  if (!imgBuf) {
    return ['degraded', `真模型在场（via ${found.via}）但真屏帧缺席——设 DSH_REALVERIFY_SCREEN=<真实截图路径> 后重跑（A/B 需要真实屏幕内容）`, evidence];
  }
  if (!somPath) {
    return ['degraded', 'dist/vlm/som.js 缺席——先 npm run build（renderSomOverlay/提示词的 TS 权威源构建件）', evidence];
  }
  const som = await import(pathToFileURL(somPath).href);

  // ── 图像尺寸嗅探（合成锚点网格的像素几何分母——som.ts sniffPngSize 同律）──
  const dims = sniffPngSize(imgBuf) ?? (await sniffViaSharp(imgBuf));
  if (!dims) {
    return ['degraded', '真屏帧尺寸不可嗅探（请提供 PNG 截图）——锚点网格几何分母缺席', evidence];
  }
  evidence.screen = { path: screenPath, mime, width: dims.width, height: dims.height };

  // ── 合成锚点网格（B 臂叠加标的）+ B 帧渲染（稀疏选择路径真执行）──
  const budget = Math.max(1, parseInt(env.DSH_REALVERIFY_SOM_BUDGET || '12', 10) || 12);
  const overlay = await som.renderSomOverlay(imgBuf, {
    markers: synthMarkers(dims.width, dims.height),
    sparseBudget: budget,
  });
  if (!overlay.ok || !overlay.buffer) {
    return ['degraded', `SoM 叠加渲染失败（${overlay.error || 'no buffer'}）——真屏帧可能非图像`, { ...evidence, overlay_err: overlay.error }];
  }
  evidence.overlay = {
    width: overlay.width, height: overlay.height,
    sparse_budget: budget, selected: (overlay.selected || []).slice(0, 20),
    sparse_fallback: Boolean(overlay.sparseFallback),
  };
  const width = overlay.width ?? dims.width;
  const height = overlay.height ?? dims.height;
  const bB64 = overlay.buffer.toString('base64');
  const aB64 = imgBuf.toString('base64');

  // ── A/B 交替轮（同一帧两形态、同一提示词）──
  const baseUrl = (env.DSH_REALVERIFY_VLM_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4').replace(/\/+$/, '');
  const model = env.DSH_REALVERIFY_VLM_MODEL || 'glm-5.3-flash';
  const perArm = Math.max(1, Math.min(50, parseInt(env.DSH_REALVERIFY_SOM_ROUNDS || '3', 10) || 3));
  const timeoutMs = Math.max(20_000, parseInt(env.DSH_REALVERIFY_VLM_TIMEOUT_MS || '90000', 10) || 90_000);
  evidence.model = model;
  evidence.per_arm_rounds = perArm;

  const armResults = { A: [], B: [] };
  for (let i = 0; i < perArm; i++) {
    const rA = await groundingOnce({ baseUrl, apiKey: found.key, model, b64: aB64, mime, width, height, question: '屏幕中央的主要可交互元素', timeoutMs, som });
    armResults.A.push(rA);
    const rB = await groundingOnce({ baseUrl, apiKey: found.key, model, b64: bB64, mime, width, height, question: '屏幕中央的主要可交互元素（注意图中叠加的编号标记）', timeoutMs, som });
    armResults.B.push(rB);
    process.stderr.write(`[D-B1] round ${i + 1}/${perArm} A:${rA.ok ? rA.elements.length + 'el' : 'FAIL'} ${rA.ms}ms | B:${rB.ok ? rB.elements.length + 'el' : 'FAIL'} ${rB.ms}ms\n`);
  }

  const okA = armResults.A.filter(r => r.ok);
  const okB = armResults.B.filter(r => r.ok);
  const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const markerIds = new Set((overlay.selected || []));
  const refRate = okB.length
    ? okB.reduce((s, r) => s + r.elements.filter(e => markerIds.has(Number(e.id))).length / Math.max(1, r.elements.length), 0) / okB.length
    : 0;
  evidence.arms = {
    A: { ok: okA.length, total: perArm, elements_median: okA.length ? median(okA.map(r => r.elements.length)) : null, ms_median: armResults.A.length ? median(armResults.A.map(r => r.ms)) : null },
    B: { ok: okB.length, total: perArm, elements_median: okB.length ? median(okB.map(r => r.elements.length)) : null, ms_median: armResults.B.length ? median(armResults.B.map(r => r.ms)) : null, marker_ref_rate: Number(refRate.toFixed(4)) },
    raw: { A: armResults.A.map(r => ({ ok: r.ok, status: r.status, ms: r.ms, n: r.elements?.length ?? null })), B: armResults.B.map(r => ({ ok: r.ok, status: r.status, ms: r.ms, n: r.elements?.length ?? null })) },
  };

  if (!okA.length || !okB.length) {
    return ['fail', `对照无法建立：A 臂 ${okA.length}/${perArm}、B 臂 ${okB.length}/${perArm} 合法 JSON——真红（逐轮 status/ms 在案）`, evidence];
  }
  const diffCount = Math.abs(evidence.arms.A.elements_median - evidence.arms.B.elements_median);
  if (refRate > 0 || diffCount !== 0) {
    return ['pass',
      `SoM 在线 A/B 成对可收割：A 臂（无叠加，${evidence.arms.A.elements_median} 元素中位）vs B 臂（sparseBudget=${budget}，${evidence.arms.B.elements_median} 元素中位，标记引用率 ${(refRate * 100).toFixed(1)}%）—— somSparseBudget 翻转的在线证据在案（D-B1 开闸决策可落）`,
      evidence];
  }
  return ['degraded',
    `A/B 两臂合法但无可观测差异（元素中位同=${evidence.arms.A.elements_median}，标记引用率 0）——负结果如实申报，同样构成开闸决策证据`,
    evidence];
}

function synthMarkers(w, h) {
  // ΤΕΛ-9: 4×3 合成锚点网格（B 臂叠加标的——真实 a11y/OCR 种子在编排层由
  // createSomMarkerSeedSupply 供源，探针用确定性网格保持自包含与可复现）
  const markers = [];
  const cols = 4, rows = 3, margin = 0.08;
  let id = 1;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x0 = Math.round((margin + c * (1 - 2 * margin) / (cols - 1) - 0.05) * w);
      const y0 = Math.round((margin + r * (1 - 2 * margin) / (rows - 1) - 0.04) * h);
      const x1 = x0 + Math.round(0.1 * w);
      const y1 = y0 + Math.round(0.08 * h);
      markers.push({ id: id++, bbox: { x0, y0, x1, y1 }, center: { x: Math.round((x0 + x1) / 2), y: Math.round((y0 + y1) / 2) }, text: `anchor-${id - 1}` });
    }
  }
  return markers;
}

function sniffPngSize(buf) {
  // ΤΕΛ-9: PNG IHDR 尺寸嗅探（som.ts sniffPngSize 同律——零依赖）
  if (buf.length < 24 || buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) return null;
  if (buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

async function sniffViaSharp(buf) {
  // ΤΕΛ-9: 非 PNG（JPEG 等）走 sharp 元数据（既有 dependencies——不引新依赖）
  try {
    const mod = await import('sharp');
    const sharp = mod.default ?? mod;
    const meta = await sharp(buf).metadata();
    return meta.width && meta.height ? { width: meta.width, height: meta.height } : null;
  } catch {
    return null;
  }
}

if (invoked(import.meta.url)) {
  const t0 = Date.now();
  try {
    const [verdict, summary, evidence] = await main();
    finishProbe({ debt: 'D-B1', probe: PROBE, verdict, summary, evidence, elapsedMs: Date.now() - t0 });
  } catch (e) {
    // ΤΕΛ-9: 探针绝不裸抛——意外异常折叠为结构化 fail
    finishProbe({ debt: 'D-B1', probe: PROBE, verdict: 'fail', summary: '探针异常（诚实失败码）', evidence: {}, elapsedMs: Date.now() - t0, error: `${e?.stack ?? e}` });
  }
}
