#!/usr/bin/env node
// W9-4(D-A5 实证探针):独立 barrier 客户端进程 —— 真 socket 双进程实证的最小件。
//
// 与 test/w5cross.test.ts ⑧ 的分野:⑧ 的「双 HTTP 客户端」活在**同一测试进程**
// 内(两 client 对象,环回参考口径);本件把每个参与者放进**独立 OS 进程**——
// federation-server(第三进程)与两个客户端进程之间只有 127.0.0.1 上的真
// socket HTTP 往返,无任何进程内共享/内存 hub —— D-A5 的「多真机 barrier
// 往返」在软件在环层面升到「真三进程 · 真 socket · 独立调度域」。
//
// 与 server 同源:经 dist/crossMachine.js 直连 createBarrierCore 单源权威
// (src↔dist 漂移由 ⑧ 的逐字段对账把守,本件不重复该把守)。
//
// 用法:
//   node scripts/w9real-barrier-client.mjs --endpoint http://127.0.0.1:PORT \
//        --peer A --name w9-real [--n 2] [--poll-ms 25] [--timeout-ms 8000]
// 输出:恰一行 "RESULT <json>"(ok/seq/peers/ackOk/waitedMs/pid);退出码 0=放行。
import { createBarrierClient, makeHttpBarrierTransport } from '../dist/crossMachine.js';

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : dflt;
}

const endpoint = arg('endpoint', '');
const peer = arg('peer', '');
const name = arg('name', '');
const n = Number(arg('n', '2'));
const pollMs = Number(arg('poll-ms', '25'));
const timeoutMs = Number(arg('timeout-ms', '8000'));

if (!endpoint || !peer || !name) {
  console.error('usage: w9real-barrier-client.mjs --endpoint URL --peer P --name N');
  process.exit(2);
}

const client = createBarrierClient({
  peer,
  transport: makeHttpBarrierTransport({ endpoint }),
  pollMs,
  timeoutMs,
});
const res = await client.arriveAndWait(name, n);
console.log(`RESULT ${JSON.stringify({
  ok: res.ok === true,
  peer,
  name,
  seq: res.seq ?? null,
  peers: Array.isArray(res.peers) ? res.peers : null,
  ackOk: res.ack ? res.ack.ok === true : null,
  reason: res.reason ?? null,
  waitedMs: res.waitedMs ?? null,
  pid: process.pid,
})}`);
process.exit(res.ok === true ? 0 : 1);
