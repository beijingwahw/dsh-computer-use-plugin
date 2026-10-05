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
//
// ΑΝΒ-3(D-E3 源头消红,决策 D3 B 案):退出协议升维为**版本无关的优雅退出**——
// 全文件零 process.exit,只设 process.exitCode 后让事件循环自然排空。原
// `process.exit(rc)` 在 node v24/Windows 与 libuv 异步句柄关闭(未决 undici
// keep-alive socket / AbortSignal 定时器)竞态 ⇒ 0xC0000409 fastfail
// (src\win\async.c:94 断言):barrier 协议本身已成功(RESULT ok:true)而退出码
// 变 3221226505,测试断言「退出码 0」确定性红。自然排空退出下,所有 handle 的
// close 回调跑完进程才退 ⇒ 竞态面消除;退出码语义(0=放行/1=未放行/2=用法错)
// 在任何 node 版本下不变;残留 handle 至多为 transport 每请求的 5s
// AbortSignal.timeout 定时器(≤5s 内自然退,远低于编排侧 20s SIGKILL 护栏)。
// 附带收益:stdout 管道在自然退出前必然冲刷(process.exit 截断管道缓冲的经典
// flake 面一并消除)。
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
  // ΑΝΒ-3: 用法错同样零 process.exit —— 本路径尚无任何 handle,设 exitCode 后
  // 模块自然终结、进程立即以 2 退出(语义与原 process.exit(2) 逐字节同)。
  process.exitCode = 2;
} else {
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
  // ΑΝΒ-3: 优雅退出协议核心 —— 只设退出码,绝强杀事件循环。fetch/undici 的
  // keep-alive socket 与 AbortSignal 定时器由 node 自身的排空纪律收敛后再退
  // (v24/Windows 的 libuv async.c:94 竞态无从触发;老版本行为不变)。
  process.exitCode = res.ok === true ? 0 : 1;
}
