// test/tools.probeInteractivity.test.ts
// W6R-B7 补强：src/tools/probeInteractivity.ts 工具层直测（此前零直接覆盖）。
// 全离线确定性：假 adapter 经 physicalBackend._setAdapterForTests 注入 ——
// UIA hitTest / 光标形态 / moveMouse 复位全部落网，绝不触发 D-5 微服务。
// 覆盖面：坐标域校验、UIA 判决双态（control/text）回执结构、悬停物理实验
// （决定性 hand 光标 + 原位复位）、纪元 Ν 经济学透明注记、全通道失败的诚实错误。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as backend from '../src/physicalBackend.ts';
import { createProbeInteractivityTool } from '../src/tools/probeInteractivity.ts';
import type { Config } from '../src/config.ts';

type Exec = (a: unknown) => Promise<string>;
const exec = (t: unknown): Exec => (t as unknown as { execute: Exec }).execute;

after(() => {
  backend._setAdapterForTests(null);
});

const baseCfg = {
  dryRun: false,
  enableProbeMemory: false, // 关判决记忆：不走 captureProcessed 场景指纹通道
  enableProbeEconomy: false,
  probeDwellMs: 300,
  probeRegionRadius: 0.02,
  probeRepaintThreshold: 0.97,
} as unknown as Config;

const probeTool = createProbeInteractivityTool(baseCfg);

/** UIA hitTest 假面：按 classification 回放（悬停面仍供给 —— W8 起 UIA 全
 *  判决时 probeLegacy 不再触发悬停准备，调用序执法见 interactivityProbe.economy.test.ts） */
function uiaAdapter(classification: 'control' | 'text' | 'unknown' | 'unavailable', extra?: {
  control_type?: string; matched_depth?: number | null; name?: string;
}) {
  return {
    hitTest: async () => ({
      ok: true as const,
      value: {
        available: true,
        classification,
        control_type: extra?.control_type ?? null,
        name: extra?.name ?? '',
        matched_depth: extra?.matched_depth ?? null,
      },
    }),
    getCursor: async () => ({ ok: true as const, value: { x: 960, y: 540 } }),
    moveMouse: async () => ({ ok: true as const, value: { pixel: { x: 960, y: 540 } } }),
    health: async () => ({
      ok: true as const,
      value: {
        status: 'ok' as const, version: '0.4.0', platform: 'win32' as const, python: '3.12',
        screen: { width: 1920, height: 1080 }, capabilities: [], switch_window_method: 'native' as const,
        ui_funnel: { l1_tree: 'available' as const, l2_ocr: 'available' as const, l3_vlm: '', l3_arbitration_enabled: false },
        screenshot_transport: 'base64' as const, auth: { pid_attestation: false, capability_token: false },
      },
    }),
  };
}

/** 悬停通道假面：getCursorKind 决定性形态 + moveMouse 全记录 */
function hoverAdapter(cursorKind: string) {
  const moves: Array<{ x: number; y: number }> = [];
  const regionHashes: number[] = [];
  return {
    moves, regionHashes,
    adapter: {
      // UIA 通道缺席 ⇒ 降级悬停双通道
      hitTest: async () => ({ ok: true as const, value: { available: false, classification: 'unavailable' } }),
      getCursor: async () => ({ ok: true as const, value: { x: 960, y: 540 } }),
      getScreenSize: async () => ({ ok: true as const, value: { screen: { width: 1920, height: 1080 } } }),
      health: async () => ({
        ok: true as const,
        value: {
          status: 'ok' as const, version: '0.4.0', platform: 'win32' as const, python: '3.12',
          screen: { width: 1920, height: 1080 }, capabilities: [], switch_window_method: 'native' as const,
          ui_funnel: { l1_tree: 'available' as const, l2_ocr: 'available' as const, l3_vlm: '', l3_arbitration_enabled: false },
          screenshot_transport: 'base64' as const, auth: { pid_attestation: false, capability_token: false },
        },
      }),
      moveMouse: async (args: { x: number; y: number }) => {
        moves.push({ x: args.x, y: args.y });
        return { ok: true as const, value: { pixel: { x: args.x * 1920, y: args.y * 1080 } } };
      },
      // 区域指纹恒同值：重绘通道读不到变化（决定性光标也无需它）
      takeScreenshot: async (args?: { wantRegionHash?: { x: number; y: number; r: number } }) => {
        regionHashes.push(args?.wantRegionHash?.r ?? -1);
        return {
          ok: true as const,
          value: {
            transport: 'base64' as const, name: '', size: 0, shape: [1, 1, 3] as [number, number, number],
            dtype: 'uint8', stride: 0, format: 'png', width: 1, height: 1, captured_at: 1,
            image_base64: '', dhash: '00', phash: null, region_dhash: 'ff', unchanged: false,
          },
        };
      },
      getCursorKind: async () => ({ ok: true as const, value: { kind: cursorKind } }),
    },
  };
}

test('probe_interactivity: 坐标越界 —— 诚实错误（x=1.5）', async () => {
  const out = await exec(probeTool)({ x: 1.5, y: 0.5 });
  assert.equal(out, '[Error]: Coordinates must be in 0.0-1.0 (normalized).');
});

test('probe_interactivity: 坐标越界 —— 负 y 同拒', async () => {
  const out = await exec(probeTool)({ x: 0.5, y: -0.01 });
  assert.equal(out, '[Error]: Coordinates must be in 0.0-1.0 (normalized).');
});

test('probe_interactivity: 非数坐标在协议层被拒（ToolArgsError）', async () => {
  await assert.rejects(
    exec(probeTool)({ x: 'left', y: 0.5 }),
    (e: Error) => e.constructor.name.includes('ToolArgsError'),
  );
});

test('probe_interactivity: UIA control 判决 —— 判别力天花板回执（0.97 / via=uia）', async () => {
  backend._setAdapterForTests(uiaAdapter('control', { control_type: 'Button', matched_depth: 2, name: 'Submit' }) as never);
  const out = JSON.parse(await exec(probeTool)({ x: 0.5, y: 0.3 }));
  assert.equal(out.status, 'SUCCESS');
  assert.equal(out.state_anchor.probed_point, '(0.5, 0.3)');
  assert.equal(out.state_anchor.verdict, 'control');
  assert.equal(out.state_anchor.confidence, 0.97);
  assert.equal(out.state_anchor.evidence.via, 'uia');
  assert.deepEqual(out.state_anchor.evidence.hit_test, {
    control_type: 'Button', name: 'Submit', classification: 'control', matched_depth: 2,
  });
  assert.match(out.next_step, /The OS confirms this is an interactive element/);
  assert.equal('economics' in out.state_anchor, false, '经济关闭 ⇒ Z 纪元原形状（无注记）');
});

test('probe_interactivity: UIA text 判决 —— I-beam 语义话术（正文非入口）', async () => {
  backend._setAdapterForTests(uiaAdapter('text', { control_type: 'Text', matched_depth: null, name: 'chat body' }) as never);
  const out = JSON.parse(await exec(probeTool)({ x: 0.2, y: 0.8 }));
  assert.equal(out.state_anchor.verdict, 'text');
  assert.equal(out.state_anchor.confidence, 0.93);
  assert.match(out.next_step, /selectable TEXT/);
  assert.match(out.next_step, /NOT a clickable entry/);
});

test('probe_interactivity: UIA 缺席 ⇒ 悬停物理实验 —— hand 决定性即判 + 原位复位', async () => {
  const { adapter, moves } = hoverAdapter('hand');
  backend._setAdapterForTests(adapter as never);
  const out = JSON.parse(await exec(probeTool)({ x: 0.4, y: 0.6 }));
  assert.equal(out.state_anchor.verdict, 'control');
  assert.equal(out.state_anchor.confidence, 0.95, 'hand 无重绘旁证 = 0.95（低于 UIA 0.97 天花板）');
  assert.equal(out.state_anchor.evidence.via, 'hover');
  assert.equal(out.state_anchor.evidence.cursor_kind, 'hand');
  assert.equal(out.state_anchor.evidence.repaint_similarity, null, '决定性形态早退：不测重绘');
  // 悬停到点 → 复位（960/1080=0.5, 540/1080=0.5 —— 像素域→归一化）
  assert.deepEqual(moves[0], { x: 0.4, y: 0.6 }, '鼠标移动到被探点');
  assert.deepEqual(moves[1], { x: 0.5, y: 0.5 }, '实验后复位原位');
  assert.match(out.next_step, /Safe to click/);
});

test('probe_interactivity: 纪元 Ν 经济模式 —— 判决附通道经济学注记', async () => {
  backend._setAdapterForTests(uiaAdapter('control', { control_type: 'Button', matched_depth: 1 }) as never);
  const econTool = createProbeInteractivityTool({ ...baseCfg, enableProbeEconomy: true } as Config);
  const out = JSON.parse(await exec(econTool)({ x: 0.5, y: 0.5 }));
  assert.equal(out.state_anchor.verdict, 'control');
  const econ = out.state_anchor.economics;
  assert.ok(econ, '经济模式开启 ⇒ economics 注记在场');
  assert.deepEqual(econ.channel_order, ['uia', 'cursor', 'repaint'], '冷启动通道序 = 先验判别力降序');
  assert.equal(econ.stopped_early, true, 'UIA 决定性判决熵减足额 ⇒ 停止法则砍掉剩余通道');
  assert.ok(typeof econ.spent_ms === 'number' && econ.spent_ms >= 0);
  assert.ok(econ.bits_per_ms && typeof econ.bits_per_ms.uia === 'number');
  // 判决语义零变化：仍是 UIA 0.97
  assert.equal(out.state_anchor.evidence.via, 'uia');
  assert.equal(out.state_anchor.confidence, 0.97);
});

test('probe_interactivity: 全通道失败 —— 诚实 [Error] + 旧服务版本降级指引', async () => {
  backend._setAdapterForTests({
    hitTest: async () => ({ ok: false as const, error: { kind: 'internal_error', detail: 'COM boom' } }),
    getCursor: async () => ({ ok: false as const, error: { kind: 'transport_error', detail: 'down' } }),
    getCursorKind: async () => ({ ok: false as const, error: { kind: 'transport_error', detail: 'down' } }),
    getScreenSize: async () => ({ ok: false as const, error: { kind: 'transport_error', detail: 'down' } }),
  } as never);
  const out = await exec(probeTool)({ x: 0.5, y: 0.5 });
  assert.match(out, /^\[Error\]: Probe failed \(/);
  assert.match(out, /older version without \/move_mouse and \/cursor_kind/);
  assert.match(out, /zoom_inspect/);
});
