// test/genesis.test.ts
// 创世纪回归测试：B-1 链基前滚 / B-2 契约解析 / B-3 两阶段令牌 /
// B-4 锚点工厂 / B-6 墓志铭降级 / B-7 双预算驱逐。
// 每个用例对应诊断书中的一个「致命缺陷」—— 防其借尸还魂。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { classifyResult } from '../src/resultContract.ts';
import { approval } from '../src/approval.ts';
import { toolOk, toolErr } from '../src/toolResult.ts';
import { contextManager } from '../src/contextManager.ts';
import { journal } from '../src/journal.ts';

// ─── B-2：统一契约解析 ───

test('B-2: JSON 主通道 —— 强类型 status 与缩进格式解耦', () => {
  // 紧凑格式（无空格）：旧的字符串嗅探在此静默失明，契约解析器必须免疫
  const compact = JSON.stringify({ status: 'FAILED', error: 'boom' });
  assert.equal(classifyResult(compact).status, 'FAILED');

  const pretty = JSON.stringify({ status: 'SUCCESS', state_anchor: {} }, null, 2);
  assert.equal(classifyResult(pretty).status, 'SUCCESS');

  assert.equal(classifyResult('{"status":"ACTION_REQUIRED"}').status, 'ACTION_REQUIRED');
  assert.equal(classifyResult('{"status":"PENDING_USER_CONSENT"}').status, 'PENDING_USER_CONSENT');
  assert.equal(classifyResult('{"status":"WEIRD"}').status, 'UNKNOWN');
});

test('B-2: noop 判定 —— SUCCESS 且 effect.detected === false', () => {
  const noop = JSON.stringify({
    status: 'SUCCESS',
    state_anchor: { effect: { detected: false } },
  });
  const c = classifyResult(noop);
  assert.equal(c.status, 'SUCCESS');
  assert.equal(c.noop, true);
  assert.equal(c.effectDetected, false);

  const effective = JSON.stringify({
    status: 'SUCCESS',
    state_anchor: { effect: { detected: true } },
  });
  assert.equal(classifyResult(effective).noop, false);
});

test('B-2: 前缀协议回退 —— 历史工具格式与非法输入', () => {
  assert.equal(classifyResult('[Error]: something broke').status, 'FAILED');
  assert.equal(classifyResult('[System]: done').status, 'SUCCESS');
  assert.equal(classifyResult('plain text without protocol').status, 'UNKNOWN');
  assert.equal(classifyResult(42).status, 'UNKNOWN');
  assert.equal(classifyResult(null).status, 'UNKNOWN');
});

// ─── B-3：两阶段审批令牌 ───

test('B-3: validate 不消费 —— 闸门检查可重复，失败重试不烧令牌', () => {
  const pa = approval.request('send payment of $100');
  // 阶段一可反复校验（pre-action gate 每次进入都查）
  assert.equal(approval.validate(pa.token), true);
  assert.equal(approval.validate(pa.token), true);
  // 未 consume 前，consume 依然可用（真授权没有被偷走）
  assert.equal(approval.consume(pa.token), true);
});

test('B-3: consume 用后即焚 —— 一次性语义', () => {
  const pa = approval.request('delete all records');
  assert.equal(approval.consume(pa.token), true);
  assert.equal(approval.consume(pa.token), false); // 第二次必败
  assert.equal(approval.validate(pa.token), false);
});

test('B-3: revoke 立即作废；垃圾令牌恒 false', () => {
  const pa = approval.request('format disk');
  approval.revoke(pa.token);
  assert.equal(approval.validate(pa.token), false);
  assert.equal(approval.consume(pa.token), false);

  assert.equal(approval.validate(''), false);
  assert.equal(approval.validate('APR-DOES-NOT-EXIST'), false);
});

// ─── B-4：锚点工厂产物可被 B-2 解析（工厂 ⇄ 契约闭环） ───

test('B-4: toolOk/toolErr 产物满足反幻觉锚点协议', () => {
  const ok = classifyResult(toolOk('click_mouse', { screenshot_id: 1 }, 'verify'));
  assert.equal(ok.status, 'SUCCESS');

  const err = classifyResult(toolErr('click_mouse', 'out of bounds', 'retry'));
  assert.equal(err.status, 'FAILED');

  // 结构三要素：没有锚点的返回等于没有记忆
  const parsed = JSON.parse(toolOk('a', { x: 1 }, 'n'));
  assert.ok(parsed.state_anchor && parsed.next_step && parsed.status);
});

// ─── B-6 / B-7：滑动窗口双预算与降级 ───

const fakeImage = (kb: number) => `data:image/jpeg;base64,${'A'.repeat(kb * 1024)}`;

beforeEach(() => contextManager.reset());

test('B-7: 张数谓词 —— 超窗驱逐最旧图，降级为文字占位', async () => {
  contextManager.configure(2, 1_000_000, false);
  await contextManager.addScreenshot(fakeImage(1));
  await contextManager.addScreenshot(fakeImage(1));
  await contextManager.addScreenshot(fakeImage(1)); // 第 3 张 ⇒ 第 1 张被驱逐

  assert.equal(contextManager.imageCount(), 2);
  const view = contextManager.getContextForModel();
  const images = view.filter(b => b.type === 'image');
  const texts = view.filter(b => b.type === 'text');
  assert.equal(images.length, 2);
  assert.equal(texts.length, 1); // 墓志铭留在历史时间线原位
  assert.match((texts[0] as any).text, /has been cleared/);
});

test('B-7: 体积谓词 —— 张数未超但累计 KB 超标，依然驱逐', async () => {
  // fakeImage(2) 实际 ≈2.02KB（data-url 前缀 23 字符）；预算 3KB：单图合规、双图必超
  contextManager.configure(3, 3);
  await contextManager.addScreenshot(fakeImage(2));
  await contextManager.addScreenshot(fakeImage(2)); // 累计 ≈4.04KB > 3KB ⇒ 驱逐第 1 张

  assert.equal(contextManager.imageCount(), 1); // 张数上限是 3，体积先触发
  assert.ok(contextManager.imageKb() <= 3, `imageKb=${contextManager.imageKb()} 应回到预算内`);
});

test('B-6: OCR 关闭时遗像退化为通用墓志铭（零行为回归）', async () => {
  contextManager.configure(1, 1_000_000, true, 200, false); // legacySummary=true 但 enableOcr=false
  await contextManager.addScreenshot(fakeImage(1));
  await contextManager.addScreenshot(fakeImage(1));

  const texts = contextManager.getContextForModel().filter(b => b.type === 'text');
  assert.equal(texts.length, 1);
  assert.doesNotMatch((texts[0] as any).text, /Last visible text/); // 无 OCR 遗像
  assert.match((texts[0] as any).text, /has been cleared/);          // 墓志铭仍在
});

test('B-7: 驱逐通告透明 —— 模型收到收缩提示', async () => {
  contextManager.configure(1, 1_000_000, false);
  const first = await contextManager.addScreenshot(fakeImage(1));
  assert.ok(!first.message.includes('cleared'));
  const second = await contextManager.addScreenshot(fakeImage(1));
  assert.ok(second.message.includes('cleared'), '驱逐必须对模型透明');
});

// ─── B-1：审计链基前滚（修复「驱逐即断链」的自毁缺陷） ───

test('B-1: 容量驱逐后链基前滚，verify 依然全绿', async () => {
  journal.reset();
  journal.configure(true, '', 3); // 容量 3：append 5 条 ⇒ 驱逐 2 条
  for (let i = 0; i < 5; i++) {
    await journal.append({ ts: i, tool: 'click_mouse', args: { x: i / 10 }, status: 'SUCCESS' });
  }
  const v = journal.verify();
  assert.equal(v.ok, true, '驱逐最旧条目不得断链（链基已前滚）');
  assert.equal(v.length, 3); // 滑动窗口语义
  assert.notEqual(journal.base, 'GENESIS'); // 链基 = 被驱逐条的哈希
});

test('B-1: 存活窗口内篡改仍被精确定位', async () => {
  journal.reset();
  journal.configure(true, '', 3);
  for (let i = 0; i < 5; i++) {
    await journal.append({ ts: i, tool: 'type_text', args: { text: `v${i}` }, status: 'SUCCESS' });
  }
  const entries = (journal as any).entries as any[];
  entries[1].args.text = 'TAMPERED'; // 窗口内第 2 条

  const v = journal.verify();
  assert.equal(v.ok, false);
  assert.equal(v.brokenAt, 1);
});
