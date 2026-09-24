// src/guards/repeatActionGuard.ts
// 第二轮创新：防死循环守卫（动作幂等性检查）。
// 真实失败模式：模型对失败动作「原样重试」—— 同坐标再点一次、同文本再输一遍。
// 规则（两档）：
//   上次同签名动作已被验证为无效（盲点/失败）⇒ 立即拦截并给出换策略指引；
//   无效果信息时，第 3 次相同调用拦截（容忍合理的幂等重试）。
// J 纪元修正：结果判定改走 B-2 统一契约 classifyResult —— 旧实现嗅探
// `'"status": "FAILED"'` 精确依赖 pretty-print 缩进空格（resultContract 头注
// 点名过的格式巧合，本守卫自己就是违例者）；紧凑 JSON 会静默失明。
import type { Context } from '@deepseek-ai/cordis';
import { onToolPre, onToolPost } from './hooks';
import { ACTION_TOOLS } from '../journal';
import { classifyResult } from '../resultContract';

export function registerRepeatActionGuard(ctx: Context): void {
  // Y6 会话隔离：守卫挂在进程级工具管线上，看见所有会话的调用。旧实现的
  // 记忆是单一闭包变量 —— 上一会话末尾的失败签名会拦住新会话的第一次同
  // 签名调用（新会话的模型对"上次失败"一无所知，拦截信息不可达也不公平；
  // 电池测试里相邻任务同签名开场动作很常见，曾被随机误杀）。状态按会话
  // 分键；无会话标识的旧表面退化为 '_anon'（与旧行为一致）。
  interface SessionRepeatState {
    lastSig: string;
    lastNoEffect: boolean;
    repeatCount: number;
    pendingSig: string;
    pendingTool: string;
  }
  const MAX_TRACKED_SESSIONS = 16;
  const bySession = new Map<string, SessionRepeatState>();
  const stateFor = (sessionId: string): SessionRepeatState => {
    let s = bySession.get(sessionId);
    if (!s) {
      // 容量上限：Map 保插入序，超限时逐出最旧会话（活跃会话的 get 会刷新不到
      // 插入序 —— 但 16 个并发会话已远超本插件的真实部署形态，简单逐出够用）
      if (bySession.size >= MAX_TRACKED_SESSIONS) {
        const oldest = bySession.keys().next().value;
        if (oldest !== undefined) bySession.delete(oldest);
      }
      s = { lastSig: '', lastNoEffect: false, repeatCount: 0, pendingSig: '', pendingTool: '' };
      bySession.set(sessionId, s);
    }
    return s;
  };

  onToolPre(ctx, async (call, next) => {
    // 只管动作类工具；dismiss_popup 是幂等元工具，放行
    if (!ACTION_TOOLS.includes(call.name) || call.name === 'dismiss_popup') return next();

    const st = stateFor(call.sessionId ?? '_anon');
    // T 纪元（T-1）：量化相似签名 —— 数值参数四舍五入到 0.01 网格后铸签。
    // 旧逐字节签名对坐标抖动（0.501 vs 0.500）失明 —— 同一按钮的微移重试
    // 不算「重复」，防死循环守卫被抖动绕过。量化后抖动同签（物理分辨率
    // 0.01 ≈ 屏上 ~20px@1080p —— 低于此差的两次点击本就是同一意图）。
    const sig = call.name + ':' + JSON.stringify(call.args ?? {}, (_k, v) =>
      typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) / 100 : v);
    if (sig === st.lastSig) {
      st.repeatCount++;
      if ((st.lastNoEffect && st.repeatCount >= 1) || st.repeatCount >= 2) {
        st.repeatCount = 0;
        st.lastSig = ''; // 重置：拦截后若模型仍发同签名，再走计数
        return `[Guard Blocked]: Repeated identical action ('${call.name}') with no effect last time. ` +
          `Repeating it will likely fail again. Change strategy: 'zoom_inspect' to refine coordinates, ` +
          `'recall_ui' for remembered locations, keyboard navigation via 'press_hotkey', or 'scroll_page' if the target may be off-screen.`;
      }
    } else {
      st.repeatCount = 0;
    }
    st.pendingSig = sig;
    st.pendingTool = call.name;
    return next();
  });

  onToolPost(ctx, async (call, result, next) => {
    const st = bySession.get(call.sessionId ?? '_anon');
    if (typeof result === 'string' && st?.pendingSig) {
      // J 纪元修正（stale 签名防线）：上一个调用的 post 缺席（工具抛错）时，
      // 本 post 属于别的工具 —— 签名与结果不配对，宁丢弃勿错配
      // （旧实现会把上一调用的签名与本结果张冠李戴，lastNoEffect 污染）。
      if (call.name !== st.pendingTool) {
        st.pendingSig = '';
        st.pendingTool = '';
        return next(result);
      }
      st.lastSig = st.pendingSig;
      st.pendingSig = '';
      st.pendingTool = '';
      const c = classifyResult(result);
      const noEffect = c.status === 'FAILED' || c.noop; // 失败或盲点（SUCCESS 但无效果）
      st.lastNoEffect = noEffect;
    }
    return next(result);
  });
}
