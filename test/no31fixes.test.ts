// test/no31fixes.test.ts
// ΝΩ-31（工具面正确性与人体工学八件）—— 本册覆盖四件的直测面：
//   ① zoom_inspect NaN 卫兵：NaN 与任何比较皆 false，旧判 x<0||x>1 全放行；
//   ② press_hotkey schema 键枚举：白名单键集进 schema（协议层即拒，模型不再
//      先错一次）+ 与 system.ts fallbackMap 的漂移防线（源级对照）；
//   ③ scroll_page amount 校验：负数/NaN/Infinity/超上限拒（对齐沙箱口径）；
//   ④ remember_ui 坐标校验：非有限/[0,1] 外坐标拒（长期记忆不吃毒先验）；
//   ⑤ replay_actions 假 affordance 修：ACTION_REQUIRED next_step 不再引用不存在
//      的 dry-run report，改指 save_skill → run_skill 沙箱排练；索引语义立法
//      （全局行动日志索引 + current_task_start_index 换算物料）。
// 全离线确定性：monkey-patch system（可变对象字面量）、journal.reset、
// uiMemory.reset —— 零后端、零网络、零真实物理设备。
// 其余四件（switch_tab 闭环 / find_text shape / ask_screen 复用 / 文案细节）在
// 各自工具的家测文件（tools.switchTab / tools.textTools / vlm.integration）。
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import type { Config } from '../src/config.ts';
import { system } from '../src/system.ts';
import { journal } from '../src/journal.ts';
import { uiMemory } from '../src/uiMemory.ts';
import { createZoomInspectTool } from '../src/tools/zoomInspect.ts';
import { createPressHotkeyTool, HOTKEY_WHITELIST_KEYS } from '../src/tools/pressHotkey.ts';
import { createScrollPageTool, MAX_SCROLL_AMOUNT } from '../src/tools/scrollPage.ts';
import { createRememberUiTool } from '../src/tools/uiMemoryTools.ts';
import { createReplayActionsTool } from '../src/tools/replayActions.ts';

type Exec = (a: unknown) => Promise<string>;
const exec = (t: unknown): Exec => (t as unknown as { execute: Exec }).execute;
const runJson = async (t: unknown, a: unknown): Promise<Record<string, any>> =>
  JSON.parse(await exec(t)(a)) as Record<string, any>;

beforeEach(() => {
  journal.reset();
  uiMemory.reset();
});
after(() => {
  journal.reset();
  uiMemory.reset();
});

// ═══ ① zoom_inspect NaN 卫兵 ═══

test('ΝΩ-31①: zoom_inspect 非有限坐标被拒（协议层 finite-number 闸 + 工具层卫兵双保险）', async () => {
  const tool = createZoomInspectTool({} as Config);
  // 非有限数（NaN/Infinity）：协议层即拒（JSON 数必须有限 —— ToolArgsError）
  for (const bad of [
    { x: NaN, y: 0.5 },
    { x: 0.5, y: NaN },
    { x: Infinity, y: 0.5 },
    { x: 0.5, y: 0.5, half_size: NaN },
  ]) {
    await assert.rejects(
      exec(tool)(bad),
      (e: Error) => e.constructor.name.includes('ToolArgsError') || /finite JSON number/.test(e.message),
      `非有限数必须在任何坐标运算前被拒（args=${JSON.stringify(bad)}）`,
    );
  }
  // 有限越界值：过协议层，工具层卫兵执法（[Error]: 方言 —— 与 dragMouse 同律）
  for (const bad of [{ x: 1.5, y: 0.5 }, { x: -0.1, y: 0.5 }, { x: 0.5, y: 0.5, half_size: 0.6 }]) {
    assert.match(await exec(tool)(bad), /^\[Error\]: Invalid arguments/, `越界必须被拒（${JSON.stringify(bad)}）`);
  }
  // 工具层卫兵对直接程序化调用（绕过协议层的 bench/harness 面）同样执法 ——
  // NaN 与任何比较皆 false，旧判会放行；Number.isFinite 补位后拒绝。
  // 注：协议层已拦 NaN，此卫兵是纵深防御（dragMouse.ts NaN 卫兵同律）。
});

// ═══ ② press_hotkey schema 键枚举 ═══

test('ΝΩ-31②: press_hotkey keys 枚举进 schema —— 白名单键集对模型可见（协议层即拒）', async () => {
  const tool = createPressHotkeyTool();
  const params = (tool as unknown as { parameters: Record<string, any> }).parameters;
  // dsh-tools 编译为 JSON Schema：{type:'object', properties:{keys:{items:{enum}}}}
  const keys = params?.properties?.keys ?? params?.keys;
  assert.ok(keys, 'parameters.properties.keys 在场');
  // dsh-tools 编译为 JSON Schema：items.enum（作者面为 items: { type, enum }）
  const en: unknown[] = keys?.items?.enum ?? keys?.enum;
  assert.ok(Array.isArray(en) && en.length >= 20, `枚举必须呈现（实测 ${JSON.stringify(en).slice(0, 60)}...）`);
  for (const k of ['ctrl', 'cmd', 'alt', 'shift', 'enter', 'tab', 'space', 'backspace', 'delete', 'esc', 'f1', 'f12', 'a', 'c', 'v', 'z',
    // R2-2: 全字母表 + 导航键入枚举（ctrl+s 保存 / ctrl+home·ctrl+end 行级导航 /
    // shift+end 选整行 —— suite-full 编辑任务主路径）
    's', 'l', 't', 'home', 'end', 'up', 'down', 'left', 'right']) {
    assert.ok(en.includes(k), `合法键 ${k} 必须在枚举里`);
  }
  // R2-2: 立法变更——字母键属应用内安全面（OS 壳层逃逸和弦仍由黑名单独立执法），
  // x/q 不再是"白名单外"样本；not-in-enum 样本改为仍刻意排除的 OS 壳层别名与
  // 无需求面的键（win/meta/printscreen/insert/capslock/数字）。
  for (const k of ['meta', 'win', 'printscreen', 'insert', 'capslock', '7']) {
    assert.ok(!en.includes(k), `白名单外键 ${k} 不得进枚举`);
  }
  assert.deepEqual([...en].sort(), [...HOTKEY_WHITELIST_KEYS].sort(), '枚举 = 导出白名单键集');
  // 协议层即拒：白名单外键名 ToolArgsError（不再先派发再由 system 层拒绝）
  // R2-2: 样本键从 x（现已合法）换成仍被排除的 win
  await assert.rejects(
    exec(tool)({ keys: ['ctrl', 'win'] }),
    (e: Error) => e.constructor.name.includes('ToolArgsError'),
    'schema 枚举在协议层执法',
  );
});

test('ΝΩ-31②: 白名单键集与 system.ts fallbackMap 同源（漂移防线 —— system 改键集此处红）', () => {
  const src = readFileSync(new URL('../src/system.ts', import.meta.url), 'utf8');
  const m = src.match(/const fallbackMap[^{]*\{([\s\S]*?)\}/);
  assert.ok(m, 'system.ts 的 _getKey fallbackMap 块必须可定位');
  // 键后随引号值（fallbackMap 的值全部是字符串字面）—— 多键同行亦可全提
  const systemKeys = [...m[1].matchAll(/([a-z0-9]+)(?=\s*:\s*')/g)].map(x => x[1]);
  assert.ok(systemKeys.length >= 20, 'fallbackMap 键提取成立（防正则空匹配假绿）');
  assert.deepEqual(
    [...systemKeys].sort(),
    [...HOTKEY_WHITELIST_KEYS].sort(),
    'schema 枚举必须逐键镜像 system 层白名单（单一执法事实源的呈现面）',
  );
});

// ═══ ③ scroll_page amount 校验 ═══

/** system.scroll monkey-patch（w7wire patchScroll 同法 —— 可变对象字面量） */
function patchScroll(): () => void {
  const host = system as unknown as { scroll: unknown };
  const saved = host.scroll;
  host.scroll = async () => { /* 假世界：滚动即生效 */ };
  return () => { host.scroll = saved; };
}

test('ΝΩ-31③: scroll_page 负数/超上限被拒 —— 结构化 FAILED + 正数指引（非有限数协议层即拒）', async () => {
  const restore = patchScroll();
  try {
    const tool = createScrollPageTool({} as Config);
    // 非有限数：协议层 finite-number 闸（ToolArgsError）
    for (const amount of [NaN, Infinity, -Infinity]) {
      await assert.rejects(
        exec(tool)({ direction: 'down', amount }),
        (e: Error) => e.constructor.name.includes('ToolArgsError') || /finite JSON number/.test(e.message),
        `amount=${amount} 非有限必须在任何滚动派发前被拒`,
      );
    }
    // 有限非法值：工具层校验执法（负数反向滚的旧漏洞在此闭合）
    for (const amount of [-3, -0.1]) {
      const out = await runJson(tool, { direction: 'down', amount });
      assert.equal(out.status, 'FAILED', `amount=${amount} 必须被拒`);
      assert.equal(out.action, 'Scroll validation failed.');
      assert.match(out.state_anchor.error, /finite positive number/, `错误事实（amount=${amount}）`);
      assert.match(out.next_step, /positive amount/, '恢复指引：正数 + 方向由 direction 决定');
      assert.match(out.next_step, /direction/, '指明负号不反向滚');
    }
    const over = await runJson(tool, { direction: 'down', amount: MAX_SCROLL_AMOUNT + 1 });
    assert.equal(over.status, 'FAILED');
    assert.match(over.state_anchor.error, new RegExp(`exceeds the limit ${MAX_SCROLL_AMOUNT}`));
    // 合法正数照常放行（回归）
    const okOut = await runJson(tool, { direction: 'down', amount: 5 });
    assert.equal(okOut.status, 'SUCCESS');
    // 缺省 amount=5 合法（回归）
    const defOut = await runJson(tool, { direction: 'up' });
    assert.equal(defOut.status, 'SUCCESS');
  } finally {
    restore();
  }
});

// ═══ ④ remember_ui 坐标校验 ═══

test('ΝΩ-31④: remember_ui 越界/非有限坐标被拒 —— 拒绝铸入长期记忆', async () => {
  const tool = createRememberUiTool();
  // 非有限数：协议层 finite-number 闸（ToolArgsError）
  for (const bad of [
    { x: NaN, y: 0.5 },
    { x: 0.5, y: Infinity },
  ]) {
    await assert.rejects(
      exec(tool)({ description: '毒先验', ...bad }),
      (e: Error) => e.constructor.name.includes('ToolArgsError') || /finite JSON number/.test(e.message),
      `坐标 ${JSON.stringify(bad)} 非有限必须被拒`,
    );
  }
  // 有限越界值：工具层校验执法
  for (const bad of [
    { x: 1.5, y: 0.5 },
    { x: -0.1, y: 0.5 },
    { x: 0.5, y: 2 },
  ]) {
    const out = await runJson(tool, { description: '毒先验', ...bad });
    assert.equal(out.status, 'FAILED', `坐标 ${JSON.stringify(bad)} 必须被拒`);
    assert.equal(out.action, 'Landmark validation failed.');
    assert.match(out.state_anchor.error, /finite numbers within 0.0-1.0/);
    assert.match(out.next_step, /VERIFIED positions/, '指引：坐标取自验证锚点而非估算');
  }
  assert.equal(uiMemory.size, 0, '非法坐标零入账（长期记忆不吃毒）');
  // 合法坐标照常入账（回归）
  const ok = await runJson(tool, { description: '合法按钮', x: 0.5, y: 0.5 });
  assert.equal(ok.status, 'SUCCESS');
  assert.equal(uiMemory.size, 1);
});

// ═══ ⑤ replay_actions 假 affordance 修 + 索引语义 ═══

const replayCfg = { enableJournal: true, replayMaxSteps: 100 } as unknown as Config;

test('ΝΩ-31⑤: replay_actions ACTION_REQUIRED —— next_step 无幽灵 dry-run，改指 save_skill→run_skill 沙箱排练', async () => {
  await journal.append({ ts: 1, tool: 'click_mouse', args: { x: 0.5, y: 0.5 }, status: 'SUCCESS' });
  const out = await runJson(createReplayActionsTool(replayCfg), { confirm: false });
  assert.equal(out.status, 'ACTION_REQUIRED');
  assert.ok(!/dry-run report/.test(out.next_step), '幽灵出口（不存在的 dry-run report）必须消失');
  assert.match(out.next_step, /save_skill/, '真实排练路径：先固化成技能');
  assert.match(out.next_step, /run_skill/, '再技能执行（沙箱排练闸在其上）');
  assert.match(out.next_step, /confirm=true/, '直接执行通道仍在场');
});

test('ΝΩ-31⑤: 索引语义立法 —— ACTION_REQUIRED 锚点给全局索引域 + 任务起点换算物料', async () => {
  // 两段任务：[0,1] 属前一任务；markTaskStart 后 [2,3] 属当前任务
  await journal.append({ ts: 1, tool: 'click_mouse', args: { x: 0.1, y: 0.1 }, status: 'SUCCESS' });
  await journal.append({ ts: 2, tool: 'type_text', args: { text: 'a' }, status: 'SUCCESS' });
  journal.markTaskStart('当前任务');
  await journal.append({ ts: 3, tool: 'scroll_page', args: { direction: 'down' }, status: 'SUCCESS' });
  await journal.append({ ts: 4, tool: 'click_mouse', args: { x: 0.2, y: 0.2 }, status: 'SUCCESS' });

  const out = await runJson(createReplayActionsTool(replayCfg), { confirm: false });
  assert.equal(out.status, 'ACTION_REQUIRED');
  assert.equal(out.state_anchor.journal_actions, 4, '全局行动流长度（marker/观察不计）');
  assert.equal(out.state_anchor.current_task_start_index, 2, '任务起点 = markTaskStart 边界的全局索引');
  assert.match(out.state_anchor.index_space, /global action journal/, '索引域声明：全局而非任务内');
  // 换算语义自证：任务内偏移 0/1 ⇔ 全局 2/3
  assert.equal(out.state_anchor.current_task_start_index + 0, 2);
  assert.equal(out.state_anchor.current_task_start_index + 1, 3);
});
