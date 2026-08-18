// src/guards/circuitBreakerGuard.ts
// 熔断守卫。pre 拦截 + post 计数的两点布控，用最小字符串协议实现跨工具聚合统计。
// 融合修复：
//   1. 模块级状态 -> 闭包状态：随插件卸载一并消亡，HMR 重载即重置（符合注册即效果模型）；
//   2. 阈值硬编码 3 -> 由 Config 注入；
//   3. 失败判定：统一走 resultContract（B-2），锚点 JSON 强类型字段 + 前缀协议回退。
// 第六轮：失败记忆自动接线 —— 每次失败即时写入 failureMemory（场景指纹随行），
//   熔断触发时再补记一条聚合症状。技能库只学「什么有效」，此处补全「什么无效」的对称面。
import type { Context } from '@deepseek-ai/cordis';
import { onToolPre, onToolPost } from './hooks';
import { failureMemory } from '../failureMemory';
import { journal } from '../journal';
import { contextManager } from '../contextManager';
import { classifyResult, isFailure, isSuccess } from '../resultContract';

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

/** 失败症状提炼：锚点 JSON 取 status/next_step 首句；前缀协议取首行 */
function extractSymptom(result: string): string {
  try {
    const obj = JSON.parse(result);
    if (obj?.status) {
      const step = typeof obj.next_step === 'string' ? obj.next_step.split(/[.\n]/)[0] : '';
      return `${obj.status}${step ? ': ' + step : ''}`;
    }
  } catch { /* 非锚点格式 */ }
  return result.split('\n')[0].slice(0, 120);
}

/** 动作签名：工具名 + 关键参数摘要（失败记忆的 approach 字段） */
function actionSignature(name: string, args: Record<string, any>): string {
  const keys = ['x', 'y', 'text', 'hotkey', 'direction', 'title', 'index', 'query', 'target_description'];
  const parts = keys.filter(k => args[k] !== undefined).map(k => `${k}=${String(args[k]).slice(0, 40)}`);
  return `${name}(${parts.join(', ')})`;
}

/** 写入失败记忆：query 取当前任务语境（无复杂任务则标注交互态），sceneHash 随行供场景加成 */
function rememberFailure(name: string, args: Record<string, any>, symptom: string): void {
  const query = journal.currentTask() || 'interactive session (no complex task)';
  failureMemory.record(query, actionSignature(name, args), symptom, contextManager.lastImageRecord()?.hash);
}

export function registerCircuitBreakerGuard(ctx: Context, maxFailures: number): void {
  let recentFailures = 0;

  // 1. 执行前：连续失败达到阈值 -> 熔断一轮（重置计数器 = 强制冷静后还给机会，而非永久锁死）
  onToolPre(ctx, async (toolCall, next) => {
    if (recentFailures >= maxFailures) {
      // 聚合症状补记一条：这批连续失败已被熔断，match_skill 检索时会作为强负向信号
      rememberFailure(toolCall.name, toolCall.args,
        `circuit-breaker: ${maxFailures} consecutive failures triggered a forced pause`);
      recentFailures = 0;
      return `[Guard Blocked]: Circuit Breaker triggered! The agent has failed ${maxFailures} times consecutively. ` +
        `Please STOP and re-evaluate the overall strategy or ask the user for help.`;
    }
    return next();
  });

  // 2. 执行后：经统一契约解析器判定成败（B-2：不再依赖序列化格式巧合）；
  //    第 1/2 次失败注入递进式恢复提示（waterfall 允许改写透传值）
  onToolPost(ctx, async (toolCall, result, next) => {
    if (typeof result === 'string') {
      const c = classifyResult(result);

      if (isFailure(c)) {
        recentFailures++;
        // 失败即时入记忆：下一次 match_skill 即可召回「这条路走不通」
        rememberFailure(toolCall.name, toolCall.args, extractSymptom(result));
        // 递进式恢复策略：第一次失败教「放大精定位」，第二次教「换模态」
        if (recentFailures === 1 || recentFailures === 2) {
          const hint = recentFailures === 1
            ? "Recovery hint: call 'zoom_inspect' around the target to refine coordinates before retrying."
            : 'Recovery hint: switch modality — try keyboard navigation via press_hotkey (tab/enter), ' +
              "or scroll_page if the target may be off-screen. Also try recall_ui for remembered locations.";
          return next(appendHint(result, hint));
        }
      } else if (isSuccess(c)) {
        recentFailures = 0; // 成功即重置
      }
    }
    return next(result); // 必须把 result 透传给下一个
  });
}
