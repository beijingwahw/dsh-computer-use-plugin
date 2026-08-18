// src/guards/circuitBreakerGuard.ts
// 熔断守卫。pre 拦截 + post 计数的两点布控，用最小字符串协议实现跨工具聚合统计。
// 融合修复：
//   1. 模块级状态 -> 闭包状态：随插件卸载一并消亡，HMR 重载即重置（符合注册即效果模型）；
//   2. 阈值硬编码 3 -> 由 Config 注入；
//   3. 失败判定兼容两种地层协议：[Error] 前缀 与 锚点 JSON 的 "FAILED"。
import type { Context } from '@deepseek-ai/cordis';
import { onToolPre, onToolPost } from './hooks';

/** 把恢复提示附加到结果字符串：锚点 JSON 注入 recovery_hint 字段；非 JSON 则换行追加 */
function appendHint(result: string, hint: string): string {
  try {
    const obj = JSON.parse(result);
    if (obj && typeof obj === 'object') {
      obj.recovery_hint = hint;
      return JSON.stringify(obj, null, 2);
    }
  } catch { /* 前缀协议字符串，走下方追加 */ }
  return `${result}\n[${hint}]`;
}

export function registerCircuitBreakerGuard(ctx: Context, maxFailures: number): void {
  let recentFailures = 0;

  // 1. 执行前：连续失败达到阈值 -> 熔断一轮（重置计数器 = 强制冷静后还给机会，而非永久锁死）
  onToolPre(ctx, async (_toolCall, next) => {
    if (recentFailures >= maxFailures) {
      recentFailures = 0;
      return `[Guard Blocked]: Circuit Breaker triggered! The agent has failed ${maxFailures} times consecutively. ` +
        `Please STOP and re-evaluate the overall strategy or ask the user for help.`;
    }
    return next();
  });

  // 2. 执行后：按字符串契约统计成败；第 1/2 次失败注入递进式恢复提示（waterfall 允许改写透传值）
  onToolPost(ctx, async (_toolCall, result, next) => {
    if (typeof result === 'string') {
      const failed = result.includes('[Error]') || result.includes('"status": "FAILED"');
      const succeeded = result.includes('[System]') || result.includes('"status": "SUCCESS"');

      if (failed) {
        recentFailures++;
        // 递进式恢复策略：第一次失败教「放大精定位」，第二次教「换模态」
        if (recentFailures === 1 || recentFailures === 2) {
          const hint = recentFailures === 1
            ? "Recovery hint: call 'zoom_inspect' around the target to refine coordinates before retrying."
            : 'Recovery hint: switch modality — try keyboard navigation via press_hotkey (tab/enter), ' +
              "or scroll_page if the target may be off-screen. Also try recall_ui for remembered locations.";
          return next(appendHint(result, hint));
        }
      } else if (succeeded) {
        recentFailures = 0; // 成功即重置
      }
    }
    return next(result); // 必须把 result 透传给下一个
  });
}
