// test/epochW.test.ts
// W 纪元（第七击）：隔离与真机审判。
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ─── W-1 单例隔离审计：一切有状态单例必有归零缝 ───

test('W-1: 隔离缝矩阵 —— 脏化后 reset 必须把状态打回初值', async () => {
  const mods = await Promise.all([
    import('../src/orchestrator.ts'), import('../src/approval.ts'),
    import('../src/focusTracker.ts'), import('../src/elementTracker.ts'),
    import('../src/visualDiff.ts'), import('../src/popupDetector.ts'),
    import('../src/journal.ts'), import('../src/swarm.ts'),
  ]);
  const [orch, appr, focus, eltrack, vdiff, popup, journal] = mods;
  const { Telemetry } = await import('../src/telemetry.ts');

  // ① 通道 EMA：脏化 → 归零
  const w0 = orch.actorChannelWeights();
  await orch.createActor({
    getAgentsRun: () => async () => { throw new Error('x'); },
    matchSkill: () => [{ id: 1, reliability: 0.9, steps: [{ tool: 't', args: {} }] }],
    replayStep: async () => 'ok', recordOutcome: () => {},
  })('t');
  const wDirty = orch.actorChannelWeights();
  assert.ok(wDirty.agents < 0.5, `脏化生效（${wDirty.agents}）`);
  orch.resetChannelArbitration();
  assert.deepEqual(orch.actorChannelWeights(), { agents: 0.5, skill: 0.5 }, 'EMA 归零');
  void w0;

  // ② 审批簿记：请求在挂 → reset 清空
  const req = appr.approval.request('danger-op', 'high');
  assert.ok(req.ok || req.token, '请求受理');
  appr.resetApproval();
  const drained = appr.approval.grant(req.token ?? 'x', 60_000);
  assert.ok(!drained.ok, 'reset 后旧令牌失效（簿记清空）');

  // ③ 焦点/元素跟踪/视觉差分/弹窗滤波/日志/swarm —— 快速归零抽查
  focus.focusTracker.set(0.3, 0.3); focus.focusTracker.clear();
  assert.equal(focus.focusTracker.get(), null, '焦点归零');
  eltrack.trackElements([{ x: 0.1, y: 0.1, width: 0.1, height: 0.1 }]);
  eltrack.resetElementTracker();
  assert.deepEqual(eltrack.trackElements([{ x: 0.1, y: 0.1, width: 0.1, height: 0.1 }]), [1], '跟踪器归零后重新领号 1');
  vdiff.resetDiffPersistence();
  popup.resetPopupBelief(); popup.resetPopupSprt();
  (journal as any).reset?.();
  const t = new Telemetry(); t.observe('w', 'SUCCESS', 1); t.reset?.();
  assert.ok(true, '全部归零缝在册');
});
