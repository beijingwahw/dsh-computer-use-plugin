// src/tools/switchTab.ts
// 修复原版两 bug：defineTool 未导入、direction 参数被解析后丢弃。
// 用 ctrl+tab / ctrl+shift+tab：Mac 浏览器同样接受 ctrl 系标签切换，规避 cmd+tab 的 OS 语义。
// B-4：返回值统一走 toolResult 工厂（反幻觉锚点全覆盖）。
//
// ΝΩ-31（闭环验证）：切换从「盲发」升维为「发射后测量」—— 前后帧行指纹
// （dHash，metaOnly 截屏，零图像字节传输）轻量对照：变化 ⇒ SUCCESS 附证据；
// 未变 ⇒ 注记（不判 FAIL —— 切换可能视觉无差：两个标签页长得一样，或浏览器
// 无焦点压根没切；诚实 next_step 提示用 take_screenshot / switch_window 确认）。
// 证据链任何一环缺席（后端不在场/截屏失败/指纹缺失）⇒ 降级为旧行为形状
// （state_anchor 逐字节 = {direction, shortcut}，next_step 不变）—— 降级红律。
import { defineTool } from '@deepseek-ai/dsh-tools';
import { system } from '../system';
import * as backend from '../physicalBackend';
import { sleep } from '../actionVerifier';
import { normalizeHash, hammingDistance } from '../perceptualHash';
import { toolOk, toolErr } from '../toolResult';

/** ΝΩ-31：切换判决的指纹距离阈 —— 与 config.stableScreenDistance 缺省（3）同值
 *  同义（dHash 距离 ≤ 阈 ⇒ 视觉未变）。本工具是模块级 const（无 config 注入面），
 *  就地镜像缺省值；导出供测试钉住。 */
export const TAB_SWITCH_STABLE_DISTANCE = 3;

/** ΝΩ-31：切换后绘制安定窗（毫秒）—— 标签页内容重绘需要一拍；与 switchWindow
 *  的 sleep(400) 同律取下限档。 */
export const TAB_SWITCH_SETTLE_MS = 300;

/** ΝΩ-31：切换判决（纯函数 —— 测试的确定性事实源）。指纹缺席 ⇒ null（证据
 *  诚实缺席，消费方走降级路径）；否则距离 ≤ 阈 ⇒ 未变（false），> 阈 ⇒ 变化（true）。 */
export function judgeTabSwitch(
  hashBefore: string | null | undefined,
  hashAfter: string | null | undefined,
  stableDistance: number = TAB_SWITCH_STABLE_DISTANCE,
): boolean | null {
  if (!hashBefore || !hashAfter) return null;
  try {
    return hammingDistance(normalizeHash(hashBefore), normalizeHash(hashAfter)) > stableDistance;
  } catch {
    return null; // 判读绝不抛（运行层铁律）
  }
}

/** ΝΩ-31：帧指纹采集面 —— 测试注入缝（缺省 null 走生产门）。 */
let tabHashCaptureOverride: (() => Promise<string | null>) | null = null;

/** ΝΩ-31：测试注入帧指纹采集（离线假指纹序列；传 null 复位）。 */
export function _setTabHashCaptureForTest(fn: (() => Promise<string | null>) | null): void {
  tabHashCaptureOverride = fn;
}

/**
 * ΝΩ-31：前后帧指纹采集（metaOnly —— 只取指纹不取图像字节）。
 *  生产门：**后端已在场才取证**（healthSnapshot 非空）—— 观察旁路绝不触发
 *  ensureBackend 的懒启动（单元测试/未起服务的会话里调 switch_tab 不得派生
 *  Python 进程；取屏的代价由真正的截屏工具承担）。任何失败 ⇒ null。
 */
async function captureTabHash(): Promise<string | null> {
  if (tabHashCaptureOverride) {
    try {
      return await tabHashCaptureOverride();
    } catch {
      return null;
    }
  }
  if (backend.healthSnapshot() === null) return null;
  try {
    const cap = await backend.captureProcessed({ metaOnly: true, wantHashes: true });
    return cap?.dhash ?? null;
  } catch {
    return null; // 端点故障 = 证据缺席（诚实降级，不阻断切换）
  }
}

export const switchTabTool = defineTool({
  name: 'switch_tab',
  description: 'Switches to the next or previous browser tab. Useful for multitasking within the browser.',
  parameters: {
    direction: {
      type: 'string',
      required: true,
      description: 'Direction to switch tabs. Options: "next", "previous".',
    },
  },
  output: {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: value }],
  },
  async execute(args) {
    const { direction } = args;
    if (direction !== 'next' && direction !== 'previous') {
      return toolErr('Tab switch validation failed.', 'Invalid direction.',
        'Retry with direction "next" or "previous".');
    }

    try {
      // ΝΩ-31：前帧行指纹（切换动作之前的世界状态锚）
      const hashBefore = await captureTabHash();

      // 平台分叉在 system 层抽象；方向真正参与按键组合（原版丢弃了此参数）
      await system.pressHotkey(direction === 'next' ? ['ctrl', 'tab'] : ['ctrl', 'shift', 'tab']);

      // ΝΩ-31：后帧行指纹 + 判决（证据缺席 ⇒ undefined —— 降级为旧行为形状）
      let changed: boolean | null = null;
      if (hashBefore !== null) {
        await sleep(TAB_SWITCH_SETTLE_MS);
        const hashAfter = await captureTabHash();
        changed = judgeTabSwitch(hashBefore, hashAfter);
      }

      if (changed === null) {
        // 降级红律：证据缺席 ⇒ 与旧实现逐字节同形（盲发 + 截图复查指引）
        return toolOk(
          `Switched to the ${direction} tab.`,
          { direction, shortcut: direction === 'next' ? 'ctrl+tab' : 'ctrl+shift+tab' },
          "Call 'take_screenshot' to verify the new tab content matches your expectation.",
        );
      }
      if (changed) {
        return toolOk(
          `Switched to the ${direction} tab.`,
          {
            direction,
            shortcut: direction === 'next' ? 'ctrl+tab' : 'ctrl+shift+tab',
            tab_switch_evidence: { screen_changed: true },
          },
          "CLOSED-LOOP: the screen CHANGED after the switch (frame fingerprint distance above threshold) — " +
            "the new tab content is most likely visible. Call 'take_screenshot' to ground on it.",
        );
      }
      return toolOk(
        `Switched to the ${direction} tab.`,
        {
          direction,
          shortcut: direction === 'next' ? 'ctrl+tab' : 'ctrl+shift+tab',
          tab_switch_evidence: { screen_changed: false },
        },
        'NOTE (not a failure): the screen did NOT change after the switch (frame fingerprint distance below ' +
          'threshold). Possible causes: the two tabs look identical, only one tab is open, or the browser is not ' +
          'focused so the shortcut never landed. Call take_screenshot to check which tab is active; if the wrong ' +
          'app is focused, use switch_window to bring the browser to the foreground first.',
      );
    } catch (error: any) {
      return toolErr(`Tab switch (${direction}) failed.`, error.message,
        "The browser may not be focused. Click inside the browser area first, or retry after 'take_screenshot'.");
    }
  },
});
