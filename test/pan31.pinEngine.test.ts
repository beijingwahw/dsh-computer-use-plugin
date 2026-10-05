// test/pan31.pinEngine.test.ts
// ΠΑΝ-31（钉扎引擎数值修复）执法册 —— 批判 C1-1 M2 实证的两条数值死亡线：
//   ① 在窗图片无 textSummary（遗像仅驱逐时铸造）⇒ 旧实现 relevance 恒 0.5 ⇒
//     基线显著度上限 0.8×0.5×1.0 = 0.4 < 0.8 钉扎线 —— 任务目标**永不可能被
//     钉扎**（C-4「核心目标钉扎永生」名存实亡，语义接地链 embed/cosine 整条
//     死重）。修法：assessSalience 无 textSummary 时回退任务锚点语义通道
//     （recordTaskAnchor 的锚文本/区域与图的关联），合成公式提炼为
//     records.composeSalience 纯函数。
//   ② 旧实现惊异加成是常数 +0.45（不随时间衰减）⇒ 完全衰减后 0.16+0.45 =
//     0.61 > 0.5 解钉线 —— 惊异帧一旦钉住**永不释放**（pinBudget=1 名额被
//     首个惊异帧锁死）。修法：惊异加成乘同一新近度包络，钉扎(0.8)/解钉(0.5)
//     施密特滞回带对两类候选都真正可达。
// 全离线确定性：contextManager 单例 reset/configure 隔离 + 纯函数数值锚定。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { contextManager } from '../src/contextManager.ts';
import { journal } from '../src/journal.ts';
import {
  composeSalience,
  SALIENCE_PIN_THRESHOLD, SALIENCE_UNPIN_THRESHOLD,
  SURPRISE_SALIENCE_BONUS, SALIENCE_ANCHOR_TEXT_GATE,
} from '../src/contextManager.records.ts';

const fakeImage = (kb = 1) => `data:image/jpeg;base64,${'A'.repeat(kb * 1024)}`;
/** 帧间 3ms：锚定时刻与后续帧的时间戳必须严格分界（时间窗关联的判别面） */
const tick = () => new Promise(r => setTimeout(r, 3));
/**
 * 相邻指纹族（汉明距离 1~2 << 惊异地板 24 位）—— 控制变量：本册只验锚点通道，
 * 不让 E-4 惊异加成混进钉扎名额（epochE 已覆盖惊异路径）。
 */
const N0 = '0'.repeat(64);
const N1 = '0'.repeat(63) + '1';
const N2 = '0'.repeat(62) + '10';
const M0 = '1'.repeat(64);
const M1 = '1'.repeat(63) + '0';
const M2 = '1'.repeat(62) + '01';

beforeEach(() => {
  contextManager.reset();
  contextManager.clearTaskAnchor();
  journal.reset();
});

// ═══ ① 合成公式数值契约（纯函数唯一事实源 —— 可达域执法）═══

test('ΠΑΝ-31①a: 任务目标可钉 —— 满相关 + 满新近度恰过钉扎线（旧实现恒 0.4 不可钉）', () => {
  const s = composeSalience({ typeWeight: 0.8, relevance: 1, recency: 1 });
  assert.equal(s, 0.8, '0.8×1.0×1.0 = 0.8 恰过线（>= 语义成立）');
  assert.ok(s >= SALIENCE_PIN_THRESHOLD, '锚点关联帧的基线显著度可达钉扎线');
  // 旧死亡线复现对照：relevance 恒 0.5 ⇒ 0.4 < 0.8 永不可钉
  const legacy = composeSalience({ typeWeight: 0.8, relevance: 0.5, recency: 1 });
  assert.ok(legacy < SALIENCE_PIN_THRESHOLD, '中性相关帧不过线（钉扎名额留给任务目标/惊异）');
});

test('ΠΑΝ-31①b: 滞回有效 —— 解钉线在真实值域内可达（带可穿越）', () => {
  // 满相关帧随新近度衰减：0.8 → 0.32，穿越滞回带 [0.5, 0.8)
  const fresh = composeSalience({ typeWeight: 0.8, relevance: 1, recency: 1 });
  const mid = composeSalience({ typeWeight: 0.8, relevance: 1, recency: 0.8 });
  const stale = composeSalience({ typeWeight: 0.8, relevance: 1, recency: 0 });
  assert.ok(fresh >= SALIENCE_PIN_THRESHOLD, '新鲜锚定帧过钉扎线');
  assert.ok(mid < SALIENCE_PIN_THRESHOLD && mid >= SALIENCE_UNPIN_THRESHOLD,
    `滞回带可穿越（中段 ${mid} ∈ [${SALIENCE_UNPIN_THRESHOLD}, ${SALIENCE_PIN_THRESHOLD})）`);
  assert.ok(stale < SALIENCE_UNPIN_THRESHOLD, '完全衰减后落解钉线之下（0.32 < 0.5）');
  assert.ok(SALIENCE_UNPIN_THRESHOLD < SALIENCE_PIN_THRESHOLD, '施密特结构序：解钉 < 钉扎');
});

test('ΠΑΝ-31①c: 惊异帧衰减下限落解钉线之下（旧实现 0.61 > 0.5 永不解钉）', () => {
  const fresh = composeSalience({ typeWeight: 0.8, relevance: 0.5, recency: 1, surpriseBits: 64 });
  assert.equal(fresh, 0.85, `满新近度惊异加成恰抬过钉扎线（0.4 + ${SURPRISE_SALIENCE_BONUS}）`);
  assert.ok(fresh >= SALIENCE_PIN_THRESHOLD, '惊异帧可钉（E-4 语义保留）');
  const stale = composeSalience({ typeWeight: 0.8, relevance: 0.5, recency: 0, surpriseBits: 64 });
  assert.equal(stale, 0.16, '加成随包络衰减 ⇒ 完全衰减后 0.16 < 0.5（解钉可达）');
  assert.ok(stale < SALIENCE_UNPIN_THRESHOLD, '旧实现 0.61 永不解钉的死亡线已拆除');
  // 阈值下惊异不触发（< 24 位不上加成）
  assert.equal(
    composeSalience({ typeWeight: 0.8, relevance: 0.5, recency: 1, surpriseBits: 23 }),
    composeSalience({ typeWeight: 0.8, relevance: 0.5, recency: 1 }),
    '元素级残差（< 24 位）不享页面级加成',
  );
});

// ═══ ② 锚点语义通道集成（recordTaskAnchor ↔ 在窗图关联 → 钉扎可达）═══

test('ΠΑΝ-31②a: 任务锚点关联帧被钉扎 —— 窗口收缩时核心目标存活（时间窗关联）', async () => {
  contextManager.configure(2, 10_000_000, false, 0, false);
  contextManager.configureFocus(true, 1, 0, 6);
  const x = await contextManager.addScreenshot(fakeImage(), N0); await tick();
  // 无锚无惊异：基线 0.4，无人钉扎（旧新同律 —— 名额留给任务目标/惊异）
  // 记录任务锚点（生产调用方形态：不带 screenshotId —— 时间窗关联回退）
  const okAnchor = contextManager.recordTaskAnchor({
    bbox: { x0: 100, y0: 200, x1: 300, y1: 260 },
    viewport: { width: 1920, height: 1080 },
    route: 'grounding',
  });
  assert.equal(okAnchor, true, '锚点登记成功');
  await tick(); // 锚定时刻 < 后续帧时间戳（时间窗关联的判别前提）
  const y = await contextManager.addScreenshot(fakeImage(), N1);
  const z = await contextManager.addScreenshot(fakeImage(), N2); // 触发收缩
  // X 是锚定时刻的最新在窗图 ⇒ 关联 ⇒ relevance 1 ⇒ 0.8 过线钉扎；
  // 窗口 2：Z 入窗时未钉扎池 = {Y}（最低显著度最旧优先）⇒ Y 被逐，X 存活
  const imgs = contextManager.recentImages(2);
  assert.equal(imgs.length, 2);
  assert.ok(imgs.some(i => i.id === x.currentId), '任务目标锚点帧钉扎存活（旧实现：0.4 永不可钉 ⇒ X 先被逐）');
  assert.ok(imgs.some(i => i.id === z.currentId), '最新帧在场');
  assert.ok(!imgs.some(i => i.id === y.currentId), '未关联的中间帧让位');
});

test('ΠΑΝ-31②b: 显式 screenshotId 挂钩 —— 精确关联（时间窗之外的强关联路）', async () => {
  contextManager.configure(2, 10_000_000, false, 0, false);
  contextManager.configureFocus(true, 1, 0, 6);
  const x = await contextManager.addScreenshot(fakeImage(), N0); await tick();
  const y = await contextManager.addScreenshot(fakeImage(), N1); await tick();
  // 锚点显式挂到 X（不是时间窗最新的 Y）
  contextManager.recordTaskAnchor({
    bbox: { x0: 0, y0: 0, x1: 10, y1: 10 },
    screenshotId: x.currentId,
  });
  await tick();
  const z = await contextManager.addScreenshot(fakeImage(), N2);
  const imgs = contextManager.recentImages(2);
  assert.ok(imgs.some(i => i.id === x.currentId), '显式挂钩的 X 钉扎存活');
  assert.ok(imgs.some(i => i.id === z.currentId), '最新帧在场');
  assert.ok(!imgs.some(i => i.id === y.currentId), '未挂钩的 Y 让位');
});

test('ΠΑΝ-31②c: 锚文本语义门 —— 旧任务遗物（与当前任务正交）不让路即回退中性', async () => {
  // 当前任务 = 「整理下载文件夹」；锚文本 = 完全正交的旧目标 ⇒ 余弦 < 门 ⇒
  // 锚点通道让路（relevance 回 0.5 ⇒ 0.4 不过线，不冒充当前任务目标）
  journal.markTaskStart('整理下载文件夹 clean up downloads');
  contextManager.configure(2, 10_000_000, false, 0, false);
  contextManager.configureFocus(true, 1, 0, 6);
  const x = await contextManager.addScreenshot(fakeImage(), N0); await tick();
  contextManager.recordTaskAnchor({
    bbox: { x0: 100, y0: 200, x1: 300, y1: 260 },
    text: 'zzz qqq xxx vvv unrelated legacy target', // 与任务描述零共享词
  });
  await tick();
  await contextManager.addScreenshot(fakeImage(), N1);
  await contextManager.addScreenshot(fakeImage(), N2);
  const imgs = contextManager.recentImages(2);
  assert.ok(!imgs.some(i => i.id === x.currentId),
    `正交锚文本（门 ${SALIENCE_ANCHOR_TEXT_GATE}）不钉扎 ⇒ FIFO 让 X 先走`);
  // 对照：锚文本与任务同源 ⇒ 通道放行 ⇒ X 钉扎存活
  contextManager.reset();
  journal.markTaskStart('登录企业邮箱 login corporate mailbox');
  contextManager.configure(2, 10_000_000, false, 0, false);
  contextManager.configureFocus(true, 1, 0, 6);
  const x2 = await contextManager.addScreenshot(fakeImage(), M0); await tick();
  contextManager.recordTaskAnchor({
    bbox: { x0: 100, y0: 200, x1: 300, y1: 260 },
    text: '登录企业邮箱 login corporate mailbox', // 与任务描述同文 ⇒ 余弦 1
  });
  await tick();
  await contextManager.addScreenshot(fakeImage(), M1);
  await contextManager.addScreenshot(fakeImage(), M2);
  const imgs2 = contextManager.recentImages(2);
  assert.ok(imgs2.some(i => i.id === x2.currentId), '同源锚文本 ⇒ 任务目标钉扎存活');
});

test('ΠΑΝ-31②d: 清锚即解钉 —— 焦点随任务漂移（任务目标切换后名额让渡）', async () => {
  contextManager.configure(2, 10_000_000, false, 0, false);
  contextManager.configureFocus(true, 1, 0, 6);
  const x = await contextManager.addScreenshot(fakeImage(), N0); await tick();
  contextManager.recordTaskAnchor({ bbox: { x0: 1, y0: 1, x1: 9, y1: 9 }, screenshotId: x.currentId });
  await tick();
  await contextManager.addScreenshot(fakeImage(), N1);
  assert.ok(contextManager.recentImages(2).some(i => i.id === x.currentId), '锚定期间 X 钉扎在场');
  // 任务完成/切换 ⇒ 清锚 ⇒ 下一帧入窗时 refreshPins 重估：无锚 relevance 0.5
  // ⇒ 0.4 < 0.5 解钉线 ⇒ X 解钉 ⇒ 收缩时按最低显著度让位
  contextManager.clearTaskAnchor();
  await contextManager.addScreenshot(fakeImage(), N2);
  await contextManager.addScreenshot(fakeImage(), N0);
  const imgs = contextManager.recentImages(2);
  assert.ok(!imgs.some(i => i.id === x.currentId), '清锚后 X 解钉让位（滞回的下行半边真实可达）');
});

test('ΠΑΝ-31②e: recordTaskAnchor 防御面 —— 锚文本非串/空白拒收为缺席；getTaskAnchor 防御副本', () => {
  contextManager.recordTaskAnchor({
    bbox: { x0: 1, y0: 1, x1: 9, y1: 9 },
    text: '   ',
  });
  assert.equal(contextManager.getTaskAnchor()?.text, undefined, '空白锚文本视为缺席');
  contextManager.recordTaskAnchor({
    bbox: { x0: 1, y0: 1, x1: 9, y1: 9 },
    text: 42 as unknown as string,
  });
  assert.equal(contextManager.getTaskAnchor()?.text, undefined, '非串锚文本拒收');
  const long = 'x'.repeat(500);
  contextManager.recordTaskAnchor({ bbox: { x0: 1, y0: 1, x1: 9, y1: 9 }, text: long });
  assert.equal(contextManager.getTaskAnchor()?.text?.length, 120, '锚文本截 120 字符');
  assert.equal(contextManager.recordTaskAnchor(null as never), false, '非对象拒收（防御式）');
});
