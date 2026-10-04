// test/journal.test.ts
// 哈希链审计：正常链完整 / 单点篡改被定位 / 恢复后续链不断。
// ΝΩ-45 增补：主 JSONL 组提交（假 timer 下 fsync 按批计数下降）+ 防涨上限 + rotation。
import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { journal, flushJournal, journalDiskStats } from '../src/journal.ts';

beforeEach(() => journal.reset());

test('append 封链：verify 全绿', async () => {
  await journal.append({ ts: 1, tool: 'click_mouse', args: { x: 0.5, y: 0.5 }, status: 'SUCCESS' });
  await journal.append({ ts: 2, tool: 'type_text', args: { text: 'hi' }, status: 'SUCCESS' });
  await journal.append({ ts: 3, tool: 'click_mouse', args: { x: 0.1, y: 0.1 }, status: 'FAILED' });
  const v = journal.verify();
  assert.equal(v.ok, true);
  assert.equal(v.length, 3);
});

test('篡改检测：改一条历史记录 ⇒ 链在断点报 警', async () => {
  await journal.append({ ts: 1, tool: 'click_mouse', args: { x: 0.5 }, status: 'SUCCESS' });
  await journal.append({ ts: 2, tool: 'type_text', args: { text: 'original' }, status: 'SUCCESS' });
  await journal.append({ ts: 3, tool: 'scroll_page', args: {}, status: 'SUCCESS' });

  // 模拟事后篡改：改写第 2 条的参数（绕过 append 直接动内存）
  const all = (journal as any).entries as any[];
  all[1].args.text = 'TAMPERED';

  const v = journal.verify();
  assert.equal(v.ok, false);
  assert.equal(v.brokenAt, 1); // 精确定位第一个断点
});

test('恢复续链：restoreChain 后继续 append，verify 仍全绿', async () => {
  await journal.append({ ts: 1, tool: 'click_mouse', args: {}, status: 'SUCCESS' });
  const entries = journal.list(false);
  const tip = journal.tip;

  journal.reset(); // 模拟崩溃重启
  journal.restoreChain(entries, tip);
  await journal.append({ ts: 2, tool: 'press_hotkey', args: { keys: ['enter'] }, status: 'SUCCESS' });

  const v = journal.verify();
  assert.equal(v.ok, true); // 恢复后追加不断链
  assert.equal(v.length, 2);
});

// ─── ΝΩ-24：canonical 病态载荷守卫 + append/守卫回调防御收口 ───

test('ΝΩ-24: 环形 args 不炸 —— 哨兵降级入链，verify 仍绿', async () => {
  const circular: any = { x: 0.5, y: 0.5 };
  circular.self = circular; // 真环：旧实现无限递归栈溢出击穿 append
  await assert.doesNotReject(() =>
    journal.append({ ts: 1, tool: 'click_mouse', args: circular, status: 'SUCCESS' }));
  const v = journal.verify();
  assert.equal(v.ok, true, '环形载荷哈希确定性一致（哨兵串稳定，重算同指纹）');
  assert.equal(journal.list(false).length, 1);
});

test('ΝΩ-24: 深嵌套 args（>64 层）不炸 —— 深度上限哨兵入链', async () => {
  let deep: any = { leaf: true };
  for (let i = 0; i < 200; i++) deep = { nested: deep };
  await assert.doesNotReject(() =>
    journal.append({ ts: 1, tool: 'click_mouse', args: deep, status: 'SUCCESS' }));
  assert.equal(journal.verify().ok, true, '超深载荷截断于深度 64 哨兵，链仍可验');
});

test('ΝΩ-24: DAG 载荷（同子对象两处引用）不误伤 —— 仍逐处展开', async () => {
  const shared = { x: 1 };
  await journal.append({ ts: 1, tool: 'click_mouse', args: { a: shared, b: shared }, status: 'SUCCESS' });
  const e = journal.list(false)[0]!;
  assert.equal((e.args as any).a.x, 1, '数据面原样（seen 只记递归路径 —— 只有真环才降级）');
  assert.equal(journal.verify().ok, true);
});

test('ΝΩ-24: BigInt args 在哈希域炸出 ⇒ append 降级为安全字符串后入链', async () => {
  // canonical 守卫（环/深度）之外的残余向量：BigInt 是 JSON.stringify 硬拒值
  await assert.doesNotReject(() =>
    journal.append({ ts: 1, tool: 'type_text', args: { n: 10n }, status: 'SUCCESS' }));
  const entries = journal.list(false);
  assert.equal(entries.length, 1);
  assert.equal(typeof entries[0]!.args.degraded, 'string', 'args 降级为安全字符串（审计事实保留）');
  assert.equal(journal.verify().ok, true, '降级条目的哈希域干净可验');
});

test('ΝΩ-24: 守卫回调防御收口 —— 病态 args 不击穿宿主事件层且结果透传', async () => {
  const { registerJournalGuard } = await import('../src/journal.ts');
  type PostHook = (exec: unknown, result: unknown, next: () => Promise<unknown>) => Promise<unknown>;
  let hook: PostHook | undefined; // 无初始化器 —— 跨闭包赋值不被 TS 收窄为 null
  const fakeCtx = { on: (ev: string, cb: PostHook) => { if (ev === 'tools/post-execute') hook = cb; } };
  registerJournalGuard(fakeCtx as never, { enableJournal: true, journalPath: '' } as never);
  assert.ok(hook, '观察者挂载成功（假 ctx 捕获）');
  const circular: any = { x: 0.5 };
  circular.self = circular;
  let passthrough = 0;
  // 环形载荷（哨兵路径）与 BigInt 载荷（降级路径）都不炸、都透传
  for (const args of [circular, { n: 5n }]) {
    await assert.doesNotReject(() => hook!(
      { name: 'click_mouse', arguments: args },
      { value: JSON.stringify({ status: 'SUCCESS' }) },
      async () => { passthrough++; return 'passthrough'; },
    ));
  }
  assert.equal(passthrough, 2, 'next 每次都被调用（守卫失败不影响管线透传）');
  assert.equal(journal.list(false).length, 2, '两条都入链（环形走哨兵、BigInt 走降级）');
  assert.equal(journal.verify().ok, true);
});

// ─── ΝΩ-45：主 JSONL 组提交（行缓冲 + flusher）+ 防涨上限 + rotation ───

test('ΝΩ-45: 组提交 —— 假 timer 窗口内零 fsync，tick 后一批一次（fsync 计数较逐条下降）', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'no45-group-'));
  try {
    journal.reset();
    journal.configure(true, path.join(dir, 'j.jsonl'), 1000);
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      for (let i = 0; i < 10; i++) {
        await journal.append({ ts: i, tool: 'click_mouse', args: { x: i / 10, y: 0.5 }, status: 'SUCCESS' });
      }
      let s = journalDiskStats();
      assert.equal(s.buffered, 10, '窗口内行缓冲持有 10 行（崩溃窗口上界 = 缓冲深度）');
      assert.equal(s.fsyncs, 0, '旧路径此时已 10 次 fsync（每条 4 syscall）；组提交窗口内 0 次');
      assert.equal(existsSync(path.join(dir, 'j.jsonl')), false, '文件尚未开（open 亦按批下降）');
      mock.timers.tick(50); // flusher 周期到期
      s = journalDiskStats();
      assert.equal(s.fsyncs, 1, '10 行一批：open/write/fsync/close 各 1 次（旧路径 10×4 syscall）');
      assert.equal(s.linesWritten, 10);
      assert.equal(s.droppedLines, 0);
      const lines = readFileSync(path.join(dir, 'j.jsonl'), 'utf8').trim().split('\n');
      assert.equal(lines.length, 10, '10 行完整落盘');
      assert.equal(journal.verify().ok, true, '内存链不受组提交影响');
      // 新窗口：后续行缓冲、再 tick 再一批
      await journal.append({ ts: 99, tool: 'type_text', args: { text: 'x' }, status: 'SUCCESS' });
      assert.equal(journalDiskStats().buffered, 1, '第 11 行进入新窗口');
      mock.timers.tick(50);
      s = journalDiskStats();
      assert.equal(s.fsyncs, 2, '第二窗一批一次（计数按批不按行）');
      assert.equal(readFileSync(path.join(dir, 'j.jsonl'), 'utf8').trim().split('\n').length, 11);
      // 磁盘行序 = 链序（J 纪元不变量在组提交下保持）
      const disk = readFileSync(path.join(dir, 'j.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
      assert.deepEqual(disk.map((e: any) => e.hash), journal.list(false).map(e => e.hash), '行序 = 链序');
    } finally {
      mock.timers.reset();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    journal.configure(true, '', 1000);
  }
});

test('ΝΩ-45: 批阈值（32 条）⇒ 同步组提交不等 timer；appendMarker 同走队列', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'no45-batch-'));
  try {
    journal.reset();
    journal.configure(true, path.join(dir, 'j.jsonl'), 1000);
    for (let i = 0; i < 32; i++) {
      await journal.append({ ts: i, tool: 'click_mouse', args: { x: 0.5 }, status: 'SUCCESS' });
    }
    const s = journalDiskStats();
    assert.equal(s.buffered, 0, '第 32 条触批阈值：缓冲同步清账');
    assert.equal(s.fsyncs, 1, '一批一次 fsync');
    assert.equal(readFileSync(path.join(dir, 'j.jsonl'), 'utf8').trim().split('\n').length, 32);
    await journal.appendMarker({ kind: 'ENV_SHAPED', action: 'set_zoom' });
    assert.equal(journalDiskStats().buffered, 1, 'appendMarker（标记行）同走组提交队列');
    assert.equal(flushJournal(), 1, '显式冲刷 API 清账第 33 行');
    const disk = readFileSync(path.join(dir, 'j.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.equal(disk.length, 33);
    assert.equal(disk[32]!.tool, 'ENV_SHAPED', '标记行按序落盘');
    assert.equal(journal.verify().ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    journal.configure(true, '', 1000);
  }
});

test('ΝΩ-45: 防涨硬上限（256 行）⇒ 同步冲刷（批阈值先行下正常不可达的防御缝）', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'no45-queue-'));
  try {
    journal.reset();
    journal.configure(true, path.join(dir, 'j.jsonl'), 10000);
    // 单元缝：直接灌注 255 行到缓冲（绕过批阈值的注入面 —— 防涨检查独立执法）
    const pending = (journal as any).pendingLines as Array<{ filePath: string; line: string }>;
    for (let i = 0; i < 255; i++) {
      pending.push({ filePath: path.join(dir, 'j.jsonl'), line: JSON.stringify({ filler: i }) + '\n' });
    }
    await journal.append({ ts: 1, tool: 'click_mouse', args: { x: 0.5 }, status: 'SUCCESS' }); // 第 256 行
    const s = journalDiskStats();
    assert.equal(s.buffered, 0, '上限触发 ⇒ 同步清账（缓冲永不超过 256 —— 有界崩溃窗口）');
    const lines = readFileSync(path.join(dir, 'j.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 256, '255 灌注行 + 1 审计行全数落盘');
    assert.equal(JSON.parse(lines[255]!).tool, 'click_mouse', '链上行走最末（行序 = 入队序）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    journal.configure(true, '', 1000);
  }
});

test('ΝΩ-45: rotation —— 当前代超 5MB ⇒ 降为 .1 并右移保留两代；verify 零影响', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'no45-rot-'));
  const jpath = path.join(dir, 'j.jsonl');
  try {
    journal.reset();
    journal.configure(true, jpath, 1000);
    // 预置两代历史（轮转后 .1 应递补为 .2，旧 .2 出局）
    writeFileSync(jpath + '.2', 'GEN2-OLD\n', 'utf8');
    writeFileSync(jpath + '.1', 'GEN1-OLD\n', 'utf8');
    // 预置超限当前代（5MB 巨行 —— 触发阈值不走 5 万次 append 的慢路）
    const fat = '{"pad":"' + 'x'.repeat(5 * 1024 * 1024) + '"}\n';
    writeFileSync(jpath, fat, 'utf8');
    await journal.append({ ts: 1, tool: 'click_mouse', args: { x: 0.5 }, status: 'SUCCESS' });
    assert.equal(flushJournal(), 1, '显式冲刷 ⇒ 轮转判定在追加前执行（size+incoming > 5MB）');
    assert.equal(readFileSync(jpath + '.2', 'utf8'), 'GEN1-OLD\n', '旧 .1 递补为 .2（旧 .2 出局）');
    assert.equal(readFileSync(jpath + '.1', 'utf8'), fat, '超限当前代降为 .1（字节保全）');
    const cur = readFileSync(jpath, 'utf8').trim().split('\n');
    assert.equal(cur.length, 1, '新当前代从本批起算');
    assert.equal(JSON.parse(cur[0]!).tool, 'click_mouse');
    assert.equal(journalDiskStats().rotations, 1, '轮转计数入账');
    assert.equal(journal.verify().ok, true, '轮转对内存链 verify 零影响');
    // 未超限的追加不再轮转（新当前代从零起算）
    await journal.append({ ts: 2, tool: 'type_text', args: { text: 'hi' }, status: 'SUCCESS' });
    flushJournal();
    assert.equal(journalDiskStats().rotations, 1, '远低于阈值 ⇒ 不轮转');
    // 边界诚实注记（源契约）：notary/磁盘指纹锚只盖当前代 —— 注记在场执法
    const src = readFileSync(new URL('../src/journal.ts', import.meta.url), 'utf8');
    assert.ok(src.includes('只盖当前代'), '「只盖当前代」边界注记在场（ΝΩ-21/R21 指纹锚的诚实边界）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    journal.configure(true, '', 1000);
  }
});
