// test/r18.popupSessionIsolation.test.ts — R1-8 回归：弹窗信念滤波器的会话隔离
//
// 病灶（R1-8 冒烟实测）：Schmitt 滤波器曾是模块级单例 —— 会话 A 的一帧几何
// 误报（+4.0 nats ⇒ ON）把迟滞态推到高位后会话结束;会话 B 在干净桌面上开跑,
// 单帧清洁 −1.5 nats 不够跌破 OFF 线,B 的一切动作在 popup_evidence='none'
// 状态下被全拦（实测两帧后 popup_detected=true 而 popup_evidence='none'）。
// 守卫侧 ΑΩ-R24 已按会话分键,但滤波器全局单例让该隔离形同虚设 —— R1-8
// 补全同律：按会话分滤波器（LRU 32 + 10min 惰性过期 + default 镜像,与
// popupGuard.ts 同款结构）。
//
// 几何证据走生产同路径:mock physicalBackend 适配器的 frameStats（服务端帧
// 环统计 —— 真机冒烟里命中几何通道的正是这条路径）;语义通道整体关闭
// （enableOcr:false）,断言只对几何证据敏感。
//   · popupLike:全图 {mean:80,stdev:46} vs 中心 {mean:240,stdev:1}
//     ⇒ cStd<gStd×0.55 ∧ cMean>gMean×1.15（生产缺省阈值下必然命中）;
//   · cleanish:两区同为 {mean:128,stdev:3} ⇒ 两条件均不满足。
import test from 'node:test';
import assert from 'node:assert/strict';

type Stats = { mean: number | null; stdev: number | null };

test('R1-8: 弹窗信念滤波器按会话隔离 —— A 的误报迟滞态不污染 B 的首帧判定', async () => {
  const { detectPopup, resetPopupBelief } = await import('../src/popupDetector.ts');
  const backend = await import('../src/physicalBackend.ts');

  let mode: 'popupLike' | 'cleanish' = 'popupLike';
  backend._setAdapterForTests({
    frameStats: async (_frameId: number, regions: Array<object>) => {
      const stats: Stats[] = regions.length === 0
        ? [mode === 'popupLike' ? { mean: 80, stdev: 46 } : { mean: 128, stdev: 3 }]
        : [mode === 'popupLike' ? { mean: 240, stdev: 1 } : { mean: 128, stdev: 3 }];
      return { ok: true as const, value: { frame_id: 1, stats } };
    },
  } as never);

  const opts = { enableOcr: false, popupKeywords: '', ocrLang: 'eng' };
  resetPopupBelief();
  try {
    // ① A 会话：一帧几何强证据 ⇒ 立即 ON（与旧单例行为一致 —— 灵敏度零回归）
    mode = 'popupLike';
    const a1 = await detectPopup(null, opts, 101, 'session-A');
    assert.equal(a1.geometric, true, 'mock 帧必须命中几何通道（测试自校验）');
    assert.equal(a1.popup, true, 'A 单帧强证据立即 ON');
    // ② B 会话：首帧 cleanish ⇒ 从先验出发,不受 A 迟滞态污染（R1-8 修复面）
    mode = 'cleanish';
    const b1 = await detectPopup(null, opts, 102, 'session-B');
    assert.equal(b1.geometric, false, 'cleanish 帧几何通道必须静默（测试自校验）');
    assert.equal(b1.popup, false, 'B 的首帧判定不受 A 的误报污染');
    // ③ A 会话自身迟滞保持：一帧清洁只入迟滞带不退出（原语义零回归）
    const a2 = await detectPopup(null, opts, 103, 'session-A');
    assert.equal(a2.popup, true, 'A 会话一帧清洁仍 ON（迟滞带保持 —— 既有语义）');
    // ④ 无会话调用（default 键）:与旧单例逐字节一致 —— 同键连续喂帧有记忆
    mode = 'popupLike';
    const d1 = await detectPopup(null, opts, 104);
    assert.equal(d1.popup, true, 'default 键单帧强证据立即 ON');
    mode = 'cleanish';
    const d2 = await detectPopup(null, opts, 105);
    assert.equal(d2.popup, true, 'default 键一帧清洁保持 ON（旧单例同语义）');
    // ⑤ 会话再切回 B:B 的滤波器只吃过一帧清洁 —— 单帧强证据尚差一步到 ON 线
    //（logit 域 −4.44+4.0=−0.44 < logit(0.6)）,再来一帧强证据 ⇒ ON:
    // 隔离不吞证据,B 自己的敏感度与全新滤波器逐字节一致。
    mode = 'popupLike';
    const b2 = await detectPopup(null, opts, 106, 'session-B');
    assert.equal(b2.popup, false, 'B:先验低 + 一清洁 + 一强证据 = −0.44 nats,未越 ON 线（迟滞语义自洽）');
    const b3 = await detectPopup(null, opts, 107, 'session-B');
    assert.equal(b3.popup, true, 'B:第二帧强证据 ⇒ ON（隔离不吞证据,敏感度零回归）');
  } finally {
    backend._setAdapterForTests(null);
    resetPopupBelief();
  }
});
