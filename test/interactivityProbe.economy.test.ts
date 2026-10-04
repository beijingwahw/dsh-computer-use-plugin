// test/interactivityProbe.economy.test.ts
// W8 执法：probeLegacy（固定序路径）的探针经济 —— UIA 第一遍已全判决
// （pending 为空）时，第二遍悬停准备整体缺席：不再白付 getCursor+
// getScreenSize 两次只读往返与 finally 的一次 no-op 复位 moveMouse（移动
// 本身是可观察的物理副作用）。有残余点时行为逐字节不变（悬停准备照做、
// 原位复位照做）。全离线确定性：假 adapter 经 physicalBackend.
// _setAdapterForTests 注入，调用序列全部落网。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as backend from '../src/physicalBackend.ts';
import { probePoints } from '../src/interactivityProbe.ts';
import type { Config } from '../src/config.ts';

after(() => {
  backend._setAdapterForTests(null);
});

const cfg = {
  dryRun: false,
  enableProbeMemory: false, // 关判决记忆：不走场景指纹通道，只看实验通道调用序
  enableProbeEconomy: false, // 固定三通道降序路径（probeLegacy —— 本修复的目标路径）
  probeDwellMs: 300,
  probeRegionRadius: 0.02,
  probeRepaintThreshold: 0.97,
} as unknown as Config;

/**
 * 调用序列假世界：hitTest 按脚本回放 classification；悬停面（getCursor/
 * getScreenSize/moveMouse/getCursorKind）全部记录调用名与坐标。
 */
function world(hit: (p: { x: number; y: number }) => 'control' | 'text' | 'unavailable', cursorKind = 'hand') {
  const calls: string[] = [];
  const moves: Array<{ x: number; y: number }> = [];
  return {
    calls, moves,
    adapter: {
      hitTest: async (args: { x: number; y: number }) => {
        calls.push('hit_test');
        return {
          ok: true as const,
          value: {
            available: true,
            classification: hit(args),
            control_type: null, name: '', matched_depth: null,
          },
        };
      },
      getCursor: async () => { calls.push('get_cursor'); return { ok: true as const, value: { x: 960, y: 540 } }; },
      // 注：physicalBackend.getScreenSize 不走 adapter.getScreenSize —— 走 health()
      // 并进程级缓存（state.screen）。此处按真实行为供给 health 面。
      getScreenSize: async () => {
        calls.push('get_screen_size');
        return { ok: true as const, value: { screen: { width: 1920, height: 1080 } } };
      },
      moveMouse: async (args: { x: number; y: number }) => {
        calls.push('move_mouse');
        moves.push({ x: args.x, y: args.y });
        return { ok: true as const, value: { pixel: { x: args.x * 1920, y: args.y * 1080 } } };
      },
      getCursorKind: async () => { calls.push('cursor_kind'); return { ok: true as const, value: { kind: cursorKind } }; },
      takeScreenshot: async () => {
        calls.push('take_screenshot');
        return {
          ok: true as const,
          value: {
            transport: 'base64' as const, name: '', size: 0, shape: [1, 1, 3] as [number, number, number],
            dtype: 'uint8', stride: 0, format: 'png', width: 1, height: 1, captured_at: 1,
            image_base64: '', dhash: '00', phash: null, region_dhash: 'ff', unchanged: false,
          },
        };
      },
      health: async () => {
        calls.push('health');
        return {
          ok: true as const,
          value: {
            status: 'ok' as const, version: '0.4.0', platform: 'win32' as const, python: '3.12',
            screen: { width: 1920, height: 1080 }, capabilities: [], switch_window_method: 'native' as const,
            ui_funnel: { l1_tree: 'available' as const, l2_ocr: 'available' as const, l3_vlm: '', l3_arbitration_enabled: false },
            screenshot_transport: 'base64' as const, auth: { pid_attestation: false, capability_token: false },
          },
        };
      },
    },
  };
}

test('W8-1: UIA 全判决（pending 空）—— 悬停准备整体缺席，零物理副作用', async () => {
  const w = world(() => 'control');
  backend._setAdapterForTests(w.adapter as never);
  const results = await probePoints(cfg, [{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.5 }, { x: 0.9, y: 0.9 }]);
  // 判决语义零变化：三点仍为 UIA control 0.97
  for (const r of results) {
    assert.equal(r.verdict, 'control');
    assert.equal(r.confidence, 0.97);
    assert.equal(r.evidence.via, 'uia');
  }
  // 经济执法：第一遍逐点 hitTest 之后没有任何悬停准备调用
  assert.deepEqual(w.calls, ['hit_test', 'hit_test', 'hit_test'],
    'UIA 全判决 ⇒ 不取光标原位、不取屏幕尺寸、不移动鼠标（旧行为白付 getCursor+getScreenSize+复位 moveMouse）');
  assert.deepEqual(w.moves, []);
});

test('W8-1: UIA 全判决（text 判决混合批）—— 同律缺席', async () => {
  const w = world(p => (p.x < 0.5 ? 'text' : 'control'));
  backend._setAdapterForTests(w.adapter as never);
  const results = await probePoints(cfg, [{ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.8 }]);
  assert.deepEqual(results.map(r => [r.verdict, r.confidence]), [['text', 0.93], ['control', 0.97]]);
  assert.deepEqual(w.calls, ['hit_test', 'hit_test'], 'text 判决同样有决定性 ⇒ pending 空 ⇒ 第二遍缺席');
});

test('W8-1: 有 pending（UIA unavailable）—— 悬停实验行为不变：准备照做 + 探点 + 原位复位', async () => {
  const w = world(() => 'unavailable', 'hand');
  backend._setAdapterForTests(w.adapter as never);
  const [r] = await probePoints(cfg, [{ x: 0.4, y: 0.6 }]);
  // 判决语义不变：hand ⇒ control 0.95（via hover）
  assert.equal(r.verdict, 'control');
  assert.equal(r.confidence, 0.95);
  assert.equal(r.evidence.via, 'hover');
  assert.equal(r.evidence.cursor_kind, 'hand');
  // 调用序列与旧行为一致：hitTest（缺席判决）→ 存档原位（getCursor +
  // getScreenSize——经 health 且进程级缓存，故从严格序中剔除）→ 区域指纹
  // 基线 → moveMouse 到点 → 读形态 → finally 复位原位（960/1920=0.5, 540/1080=0.5）
  const seq = w.calls.filter(c => c !== 'health');
  assert.deepEqual(seq, ['hit_test', 'get_cursor', 'take_screenshot', 'move_mouse', 'cursor_kind', 'move_mouse']);
  assert.ok(w.calls.includes('health'), 'getScreenSize 经 health 取屏幕尺寸（存档原位的第二半）');
  assert.deepEqual(w.moves, [{ x: 0.4, y: 0.6 }, { x: 0.5, y: 0.5 }], '探点到点 → 复位原位（像素域→归一化）');
});

test('W8-1: 混合批 —— UIA 判决点不被悬停，仅残余点进悬停实验', async () => {
  // 点 A（y=0.2）UIA 判 control；点 B（y=0.8）UIA unavailable ⇒ 悬停
  const w = world(p => (p.y < 0.5 ? 'control' : 'unavailable'), 'ibeam');
  backend._setAdapterForTests(w.adapter as never);
  const results = await probePoints(cfg, [{ x: 0.5, y: 0.2 }, { x: 0.5, y: 0.8 }]);
  assert.deepEqual(results.map(r => [r.verdict, r.evidence.via]), [['control', 'uia'], ['text', 'hover']]);
  assert.deepEqual(w.moves, [{ x: 0.5, y: 0.8 }, { x: 0.5, y: 0.5 }],
    '只有残余点 B 被悬停；UIA 已判的 A 点零鼠标接触');
});
