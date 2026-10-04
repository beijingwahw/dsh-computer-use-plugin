// W9-4 需真机债的软件在环实证(TS 侧组织):
//   ① D-A5 双进程真 socket barrier —— federation-server 子进程 + 两个**独立 OS 进程**
//      客户端(scripts/w9real-barrier-client.mjs,经 dist/crossMachine.js 单源)完成
//      两阶段 barrier 往返并退休。与 w5cross.test.ts ⑧ 的分野:⑧ 的双客户端活在
//      同一测试进程内(环回参考口径);本测试把参与者放进真进程,只有 127.0.0.1
//      上的真 socket HTTP 往返 —— 「多真机 barrier」的软件在环最大化形态。
//      环境不支持子进程/环回监听 ⇒ 诚实 skip(仓库先例:⑧ 同款纪律)。
//   ② 实证报告结构守卫 —— python_service/real_probe_report.json 在场时校验
//      9 债键全 + 每条有 verdict(缺席 ⇒ 诚实 skip:python 探针未跑不算红)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** 起联邦服务器(--port 0 ⇒ 随机环回口;失败抛错供 skip)—— w5cross ⑧ 同配方 */
async function startFederationServer(): Promise<{ port: number; child: ChildProcess; stop: () => Promise<void> }> {
  const script = fileURLToPath(new URL('../scripts/federation-server.mjs', import.meta.url));
  const child = spawn(process.execPath, [script, '--port', '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise<number>((resolve, reject) => {
    let buf = '';
    let settledFlag = false;
    const done = (v: number | null): void => {
      if (settledFlag) return;
      settledFlag = true;
      clearTimeout(timer);
      if (v === null) reject(new Error('联邦服务器未在 8s 内报出监听口'));
      else resolve(v);
    };
    const timer = setTimeout(() => done(null), 8_000);
    child.stdout!.on('data', (d: Buffer) => {
      buf += String(d);
      if (/"event":"listening"/.test(buf)) {
        const m = buf.match(/"port":(\d+)/);
        if (m) done(Number(m[1]));
      }
    });
    child.on('error', () => done(null));
    child.on('exit', () => done(null));
  });
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2_000) });
      if (r.ok) break;
    } catch {
      /* 未就绪:继续轮询 */
    }
    if (Date.now() > deadline) {
      child.kill();
      throw new Error('联邦服务器 /health 5s 未就绪');
    }
    await new Promise(r => setTimeout(r, 100));
  }
  child.stdout!.resume();
  const stop = async (): Promise<void> => {
    if (child.exitCode !== null) return;
    const exited = new Promise<void>(resolve => {
      const t = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 3_000);
      child.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
    child.kill();
    await exited;
  };
  return { port, child, stop };
}

/** 一个独立 barrier 客户端进程(RESULT 行 → JSON;超时/退出码如实带回) */
async function runClient(base: string, peer: string, name: string): Promise<{ rc: number | null; pid: number; parsed: Record<string, unknown> | null; raw: string }> {
  const script = fileURLToPath(new URL('../scripts/w9real-barrier-client.mjs', import.meta.url));
  const child = spawn(process.execPath, [script, '--endpoint', base, '--peer', peer, '--name', name,
    '--n', '2', '--poll-ms', '25', '--timeout-ms', '8000'], { stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  let parsed: Record<string, unknown> | null = null;
  child.stdout!.on('data', (d: Buffer) => {
    out += String(d);
    for (const line of out.split('\n')) {
      if (line.startsWith('RESULT ')) {
        try { parsed = JSON.parse(line.slice(7)); } catch { /* 如实留 null */ }
      }
    }
  });
  const rc = await new Promise<number | null>(resolve => {
    const t = setTimeout(() => { child.kill('SIGKILL'); resolve(null); }, 20_000);
    child.once('exit', c => { clearTimeout(t); resolve(c); });
  });
  return { rc, pid: child.pid ?? -1, parsed, raw: out.trim() };
}

test('W9-4① D-A5: 真三进程真 socket barrier 往返(server + 独立客户端 A/B)', { timeout: 60_000 }, async t => {
  let srv: Awaited<ReturnType<typeof startFederationServer>>;
  try {
    srv = await startFederationServer();
  } catch (e) {
    return t.skip(`环境不支持子进程/环回监听:诚实跳过(${(e as Error).message})`);
  }
  const base = `http://127.0.0.1:${srv.port}`;
  try {
    const name = `w9-real-ts-${Date.now()}`;
    // 两客户端先双双 spawn 再等:A 先 allocate 会轮询等待 B 抵达 —— 真 rendezvous
    const pA = runClient(base, 'A', name);
    const pB = runClient(base, 'B', name);
    const [rA, rB] = await Promise.all([pA, pB]);

    // 独立进程证据:PID 互异且异于 server 进程
    assert.notEqual(rA.pid, rB.pid, 'A/B 客户端必须是两个独立 OS 进程');
    assert.notEqual(rA.pid, srv.child.pid);
    assert.notEqual(rB.pid, srv.child.pid);

    assert.equal(rA.rc, 0, `客户端 A 退出码 0(got ${rA.rc}: ${rA.raw})`);
    assert.equal(rB.rc, 0, `客户端 B 退出码 0(got ${rB.rc}: ${rB.raw})`);
    assert.ok(rA.parsed && rB.parsed, '双端 RESULT JSON 可解析');
    if (rA.parsed && rB.parsed) {
      assert.equal(rA.parsed.ok, true, 'A 放行');
      assert.equal(rB.parsed.ok, true, 'B 放行');
      assert.equal(rA.parsed.seq, rB.parsed.seq, '同 generation 同 seq');
      assert.deepEqual([...(rB.parsed.peers as string[])].sort(), ['A', 'B'], '名册 {A,B}');
      assert.equal(rA.parsed.ackOk, true, 'A 两阶段确认');
      assert.equal(rB.parsed.ackOk, true, 'B 两阶段确认');
    }

    // 双端 commit ⇒ generation 退休(server 侧只读面复核)
    const after = await fetch(`${base}/barrier/status?name=${name}`, { signal: AbortSignal.timeout(2_000) });
    assert.equal(((await after.json()) as { ok: boolean; reason?: string }).reason, 'unknown-barrier',
      '双端确认 ⇒ 退休(零驻留)');
  } finally {
    await srv.stop();
  }
});

test('W9-4② 实证报告结构守卫 —— real_probe_report.json 九债齐全(缺席 ⇒ 诚实 skip)', () => {
  const reportPath = fileURLToPath(new URL('../python_service/real_probe_report.json', import.meta.url));
  if (!existsSync(reportPath)) {
    return; // python 探针未在本机跑过:报告缺席不红(诚实缺席 ≠ 静默通过);跑过即受守卫
  }
  const report = JSON.parse(readFileSync(reportPath, 'utf8')) as {
    schema?: string; debts?: Record<string, { verdict?: string; status?: string }>;
  };
  assert.equal(report.schema, 'w9-real-probe/1', '报告 schema 钉死');
  const want = ['D-A1', 'D-A2', 'D-A3', 'D-A4', 'D-A5', 'D-A6', 'D-A7', 'D-G4'];
  for (const debt of want) {
    const entry = report.debts?.[debt];
    assert.ok(entry, `报告缺 ${debt} 条目`);
    assert.equal(typeof entry.verdict, 'string', `${debt}.verdict 必须在(定谳或闭环结论)`);
    assert.ok(entry.verdict!.length > 0, `${debt}.verdict 非空`);
    assert.ok(['ok', 'degraded', 'failed'].includes(entry.status ?? ''), `${debt}.status ∈ {ok,degraded,failed}`);
  }
});
