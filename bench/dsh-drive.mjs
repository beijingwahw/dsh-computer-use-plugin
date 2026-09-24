#!/usr/bin/env node
// DSH 测试驱动：通过 127.0.0.1:3080 的 /api/<method> RPC 通道驱动 DSH 会话。
// 用法:
//   node dsh-drive.mjs new <name>                 创建会话
//   node dsh-drive.mjs send <sessionId> <text>    发送任务并等待完成
//   node dsh-drive.mjs wait <sessionId> [ms]      等待会话空闲
//   node dsh-drive.mjs hist <sessionId>           导出精简历史(JSONL: 工具调用/结果/助手文本)
//   node dsh-drive.mjs running <sessionId>        查询运行状态
//   node dsh-drive.mjs cancel <sessionId>         取消当前轮

const BASE = 'http://127.0.0.1:3080/api/';

async function rpc(method, payload) {
  const r = await fetch(BASE + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} on ${method}`);
  const j = await r.json();
  if (!j.result?.ok) throw new Error(`rpc ${method} failed: ${JSON.stringify(j.result).slice(0, 400)}`);
  return j.result.value;
}

async function isRunning(sessionId) {
  const v = await rpc('session.list', {});
  const s = v.items.find((i) => i.sessionId === sessionId);
  if (!s) throw new Error('session not found: ' + sessionId);
  return !!s.running;
}

async function waitDone(sessionId, timeoutMs = 300000, pollMs = 3000) {
  const t0 = Date.now();
  // 先给一点启动缓冲
  await sleep(1500);
  while (Date.now() - t0 < timeoutMs) {
    let running;
    try { running = await isRunning(sessionId); } catch { running = true; }
    if (!running) return { ok: true, waitedMs: Date.now() - t0 };
    await sleep(pollMs);
  }
  return { ok: false, waitedMs: Date.now() - t0 };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function compactHistory(value) {
  const out = [];
  let lastTurnAssistant = [];
  for (const entry of value.events) {
    const e = entry.event;
    if (!e || !e.type) continue;
    if (e.type === 'tool/call') {
      out.push({ kind: 'call', seq: e.seq, name: e.data.name, args: e.data.arguments, turn: e.data.turn, step: e.data.step });
    } else if (e.type === 'tool/result') {
      const c = e.data.message?.content?.[0];
      const text = c?.content?.map((p) => p.text || '').join('\n') ?? '';
      out.push({
        kind: 'result', seq: e.seq, callId: c?.toolCallId, isError: !!c?.isError,
        text: text.length > 6000 ? text.slice(0, 6000) + '…[truncated]' : text,
        turn: e.data.turn, step: e.data.step,
      });
    } else if (e.type === 'assistant/message') {
      const text = (e.data?.content ?? []).map((p) => p.text || '').join('');
      if (text.trim()) lastTurnAssistant.push({ kind: 'assistant', seq: e.seq, text: text.slice(0, 4000) });
    } else if (e.type === 'user/message') {
      const text = (e.data?.content ?? []).map((p) => p.text || '').join('');
      out.push({ kind: 'user', seq: e.seq, text: text.slice(0, 500) });
    }
  }
  // 把 assistant 文本按 seq 顺序合并进输出流
  const all = [...out, ...lastTurnAssistant].sort((a, b) => a.seq - b.seq);
  return all;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'new') {
    const v = await rpc('session.create', {});
    console.log(JSON.stringify(v));
  } else if (cmd === 'send') {
    const [sessionId, ...textParts] = rest;
    const text = textParts.join(' ');
    const v = await rpc('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text }], clientTimeZone: 'Asia/Shanghai' });
    console.log(JSON.stringify(v));
  } else if (cmd === 'wait') {
    const [sessionId, timeout] = rest;
    const v = await waitDone(sessionId, Number(timeout || 300000));
    console.log(JSON.stringify(v));
    process.exit(v.ok ? 0 : 2);
  } else if (cmd === 'running') {
    console.log(JSON.stringify({ running: await isRunning(rest[0]) }));
  } else if (cmd === 'cancel') {
    console.log(JSON.stringify(await rpc('session.cancel', { sessionId: rest[0] })));
  } else if (cmd === 'hist') {
    const v = await rpc('session.history', { sessionId: rest[0] });
    const rows = compactHistory(v);
    for (const r of rows) console.log(JSON.stringify(r));
  } else if (cmd === 'hist-json') {
    const v = await rpc('session.history', { sessionId: rest[0] });
    console.log(JSON.stringify(compactHistory(v), null, 1));
  } else {
    console.error('unknown command: ' + cmd);
    process.exit(1);
  }
}

main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
