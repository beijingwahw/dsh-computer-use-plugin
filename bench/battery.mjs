#!/usr/bin/env node
// 任务矩阵执行器：逐任务建会话（隔离上下文）→ 下发 → 等完成 → 抓工具轨迹
// 用法: node battery.mjs <suite-file.json> [concurrent=1]
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';

const BASE = 'http://127.0.0.1:3080/api/';
const MODEL = { provider: 'zai-coding-cn', model: 'glm-4.5v' };

async function rpc(method, payload) {
  const r = await fetch(BASE + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} on ${method}`);
  const j = await r.json();
  if (!j.result?.ok) throw new Error(`rpc ${method}: ${JSON.stringify(j.result).slice(0, 300)}`);
  return j.result.value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitDone(sessionId, timeoutMs = 420000) {
  await sleep(2000);
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const v = await rpc('session.list', {});
      const s = v.items.find((i) => i.sessionId === sessionId);
      if (s && !s.running) return { ok: true, waitedMs: Date.now() - t0 };
    } catch { /* transient */ }
    await sleep(3000);
  }
  await rpc('session.cancel', { sessionId }).catch(() => {});
  return { ok: false, waitedMs: Date.now() - t0 };
}

function compact(history) {
  const calls = new Map();
  const out = [];
  for (const entry of history.events) {
    const e = entry.event;
    if (!e?.type) continue;
    if (e.type === 'tool/call') {
      calls.set(e.data.callId, { name: e.data.name, args: e.data.arguments });
      out.push({ ev: 'call', name: e.data.name, args: String(e.data.arguments).slice(0, 300) });
    } else if (e.type === 'tool/result') {
      const c = e.data.message?.content?.[0];
      const text = c?.content?.map((p) => p.text || '').join('\n') ?? '';
      out.push({
        ev: 'result', name: calls.get(c?.toolCallId)?.name ?? '?',
        isError: !!c?.isError,
        text: text.length > 1600 ? text.slice(0, 1600) + '…' : text,
      });
    } else if (e.type === 'assistant/message') {
      const text = (e.data?.content ?? []).map((p) => p.text || '').join('');
      if (text.trim()) out.push({ ev: 'assistant', text: text.slice(0, 1200) });
    } else if (e.type === 'turn/end' && e.data?.reason?.kind === 'error') {
      out.push({ ev: 'turn_error', error: JSON.stringify(e.data.reason.error).slice(0, 300) });
    }
  }
  return out;
}

async function runTask(t, idx, results) {
  const rec = { id: t.id, category: t.category, prompt: t.prompt.slice(0, 120), startedAt: new Date().toISOString() };
  try {
    const s = await rpc('session.create', {});
    rec.sessionId = s.sessionId;
    await rpc('session.selectModel', { sessionId: s.sessionId, ...MODEL });
    await rpc('session.prompt', { sessionId: s.sessionId, mode: 'queue', content: [{ type: 'text', text: t.prompt }], clientTimeZone: 'Asia/Shanghai' });
    const w = await waitDone(s.sessionId, t.timeoutMs ?? 420000);
    rec.timedOut = !w.ok;
    rec.waitedMs = w.waitedMs;
    const h = await rpc('session.history', { sessionId: s.sessionId });
    rec.events = compact(h);
    rec.toolCalls = rec.events.filter((e) => e.ev === 'call').map((e) => e.name);
    rec.toolErrors = rec.events.filter((e) => e.ev === 'result' && e.isError).length;
    rec.turnErrors = rec.events.filter((e) => e.ev === 'turn_error').length;
    // 简单判定：任务定义的 pass 条件（对工具轨迹/回复的正则）
    if (t.expect) {
      const hay = JSON.stringify(rec.events);
      rec.pass = t.expect.every((re) => new RegExp(re, 'i').test(hay));
      rec.failedExpectations = t.expect.filter((re) => !new RegExp(re, 'i').test(hay));
    }
  } catch (e) {
    rec.harnessError = e.message;
  }
  rec.finishedAt = new Date().toISOString();
  results.push(rec);
  const status = rec.pass === undefined ? '?' : rec.pass ? 'PASS' : 'FAIL';
  console.log(`[${idx + 1}] ${status} ${t.category}/${t.id} tools=[${rec.toolCalls?.join(',') || '-'}] errors=${rec.toolErrors ?? '-'}/${rec.turnErrors ?? '-'}`);
  return rec;
}

async function main() {
  const suiteFile = process.argv[2];
  const suite = JSON.parse(readFileSync(suiteFile, 'utf8'));
  const outDir = 'D:/dsh3/test-runs/results';
  mkdirSync(outDir, { recursive: true });
  const results = [];
  for (let i = 0; i < suite.length; i++) {
    await runTask(suite[i], i, results);
    writeFileSync(`${outDir}/battery-partial.json`, JSON.stringify(results, null, 1));
    await sleep(1500);
  }
  const summary = {
    total: results.length,
    pass: results.filter((r) => r.pass === true).length,
    fail: results.filter((r) => r.pass === false).length,
    unknown: results.filter((r) => r.pass === undefined).length,
    byCategory: {},
  };
  for (const r of results) {
    summary.byCategory[r.category] = summary.byCategory[r.category] || { total: 0, pass: 0, fail: 0 };
    summary.byCategory[r.category].total++;
    if (r.pass === true) summary.byCategory[r.category].pass++;
    if (r.pass === false) summary.byCategory[r.category].fail++;
  }
  writeFileSync(`${outDir}/battery-final.json`, JSON.stringify({ summary, results }, null, 1));
  console.log('\n==== SUMMARY ====');
  console.log(JSON.stringify(summary, null, 1));
}

main().catch((e) => { console.error('BATTERY ERROR:', e); process.exit(1); });
