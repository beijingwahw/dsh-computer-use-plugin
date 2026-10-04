// test/tools.dismissPopup.test.ts
// W6R-B7 补强：src/tools/dismissPopup.ts 工具层直测（此前零直接覆盖）。
// 零副作用元工具：execute 与 popupGuard 的 TACTICAL_PAUSE 常量逐字一致 ——
// 拦截路径与自救路径收到统一战术暂停指令是本工具的存在理由。
// 纯离线：无任何 IO（不触 system / physicalBackend）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TACTICAL_PAUSE } from '../src/guards/popupGuard.ts';
import { dismissPopupTool } from '../src/tools/dismissPopup.ts';

type Exec = (a: unknown) => Promise<string>;
const exec = (t: unknown): Exec => (t as unknown as { execute: Exec }).execute;
const tool = dismissPopupTool as unknown as {
  name: string;
  execute: Exec;
  output: { render: (a: unknown, v: string) => Array<{ type: string; text: string }> };
};

test('dismiss_popup: 返回 popupGuard 的 TACTICAL_PAUSE 逐字一致（单一事实源）', async () => {
  const out = await exec(tool)({});
  assert.equal(out, TACTICAL_PAUSE, '拦截话术与自救话术必须逐字节一致');
});

test('dismiss_popup: ACTION_REQUIRED 态 —— 非成功非失败的第三种状态', async () => {
  const out = JSON.parse(await exec(tool)({}));
  assert.equal(out.status, 'ACTION_REQUIRED');
});

test('dismiss_popup: state_anchor 报告弹窗阻塞事实 + 强制重分析动作', async () => {
  const out = JSON.parse(await exec(tool)({}));
  assert.equal(out.state_anchor.current_state, 'Screen is blocked by an unexpected popup or modal.');
  assert.equal(out.state_anchor.required_action, 'Re-analyze the current screenshot.');
});

test('dismiss_popup: next_step 指向 click_mouse + 关闭按钮定位指引', async () => {
  const out = JSON.parse(await exec(tool)({}));
  assert.match(out.next_step, /MANDATORY/);
  assert.match(out.next_step, /'click_mouse'/);
  assert.match(out.next_step, /'X'|Close|Cancel/);
});

test('dismiss_popup: 确定性 —— 两次调用结果逐字节相同（不猜按钮、不读屏）', async () => {
  const a = await exec(tool)({});
  const b = await exec(tool)({});
  assert.equal(a, b);
});

test('dismiss_popup: 工具元数据 —— 名称与 render 契约', async () => {
  assert.equal(tool.name, 'dismiss_popup');
  const blocks = tool.output.render({}, 'x');
  assert.deepEqual(blocks, [{ type: 'text', text: 'x' }]);
});
