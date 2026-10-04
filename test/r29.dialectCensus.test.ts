// test/r29.dialectCensus.test.ts
// ΑΩ-R29（老工具输出方言整治）方言普查执法册。
//
// 立法背景：clickMouse/clickElement/typeText/dragMouse/takeScreenshot 等老工具
// 曾直接 JSON.stringify 手拼回执，未走 src/toolResult.ts 的 toolOk/toolErr/
// toolActionRequired 四件套工厂 —— 两套方言并存、形状漂移无执法。本册把
//「每个工具必须说锚点方言」立成机械执法：
//   ① 静态普查：src/tools/*.ts 全部手拼状态回执（JSON.stringify 字面量携带
//      顶层 status 键）必须至少含 {status, state_anchor, next_step} 三键，且
//      status 字面 ∈ resultContract 登记词表（classifyResult ≠ UNKNOWN ——
//      词表唯一事实源，新增状态只在 resultContract 登记）。历史差异方言
//      （ΑΩ-R29 各文件头注在册的不收编清单 + 范围外在册差异）进入下方
//      LEDGER 豁免册：按（文件, status 字面, 缺键集）三元组精确匹配 ——
//      新工具漏锚点 / 造未登记状态字面 ⇒ 不在册 ⇒ 普查即红；
//      修掉一个在册差异 ⇒ 对应豁免条目必须同步删除（册不留幽灵条目 ——
//      每条豁免必须命中至少一张真实回执）。
//   ② 运行时普查：R29 审计的工具离线驱动实测回执（假 system / 假 accessibility
//      provider），断言运行时真实输出（而非源码形状）同样守方言律；收编
//      toolOk 的两处（type_text / drag_mouse SUCCESS）钉死顶层键序 = 工厂方言；
//      在册差异（无锚 FAILED）与 [Error]: 前缀方言按册钉死且 classifyResult
//      仍可判（普查兼容面）。
// clickMouse 的 ΑΩ-R11 定谳（不收编）不重审 —— 本册只执法「说锚点方言」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { classifyResult } from '../src/resultContract.ts';
import type { Config } from '../src/config.ts';
import { system } from '../src/system.ts';
import { setAccessibilityProvider } from '../src/uiExtractor.ts';
import { switchTabTool } from '../src/tools/switchTab.ts';
import { switchWindowTool } from '../src/tools/switchWindow.ts';
import { dismissPopupTool } from '../src/tools/dismissPopup.ts';
import { createTypeTextTool } from '../src/tools/typeText.ts';
import { createDragMouseTool } from '../src/tools/dragMouse.ts';
import { createClickElementTool } from '../src/tools/clickElement.ts';
import { createTakeScreenshotTool } from '../src/tools/takeScreenshot.ts';

// ═══ 静态普查：手拼状态回执的形状扫描器（注释/字符串感知的花括号配对）═══

interface Receipt {
  file: string;
  line: number;
  keys: string[];           // 顶层键名（条件展开 ...(...) 的键不计 —— 只记无条件键）
  statusLiterals: string[]; // 顶层 status 值里的字符串字面（三元条件状态全收）
}

/** 与 src[start]='{' 配对的 '}' 下标（跳过字符串与注释；失配 -1） */
function matchBrace(src: string, start: number): number {
  let depth = 0;
  let quote: string | null = null;
  let i = start;
  while (i < src.length) {
    const c = src[i];
    if (quote !== null) {
      if (c === '\\') { i += 2; continue; }
      if (c === quote) quote = null;
      i++; continue;
    }
    if (c === '\'' || c === '"' || c === '`') { quote = c; i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i; }
    i++;
  }
  return -1;
}

/** 对象字面量的顶层形状：顶层键名 + 顶层 status 值的字符串字面集 */
function shapeOf(body: string): { keys: string[]; statusLiterals: string[] } {
  const keys: string[] = [];
  const statusLiterals: string[] = [];
  const end = body.length - 1; // 外层 '}'
  let depth = 0;
  let quote: string | null = null;
  let i = 1;               // 跳过外层 '{'
  let lastSep = '{';       // 顶层最近一次定界（'{' 或 ','）—— 键名只出现在定界之后
  let nameBuf = '';
  let readingName = false;
  let readingStatus = false;
  let statusBuf = '';
  const flushName = (): void => {
    if (nameBuf) {
      keys.push(nameBuf);
      if (nameBuf === 'status') { readingStatus = true; statusBuf = ''; }
    }
    nameBuf = '';
    readingName = false;
  };
  while (i < end) {
    const c = body[i];
    if (quote !== null) {
      if (readingStatus) statusBuf += c;
      if (c === '\\') { i += 2; continue; }
      if (c === quote) quote = null;
      i++; continue;
    }
    if (c === '\'' || c === '"' || c === '`') { quote = c; if (readingStatus) statusBuf += c; i++; continue; }
    if (c === '/' && body[i + 1] === '/') { while (i < end && body[i] !== '\n') i++; continue; }
    if (c === '/' && body[i + 1] === '*') { i += 2; while (i < end && !(body[i] === '*' && body[i + 1] === '/')) i++; i += 2; continue; }
    if (c === '{' || c === '[' || c === '(') { depth++; i++; continue; }
    if (c === '}' || c === ']' || c === ')') { depth--; i++; continue; }
    if (depth === 0) {
      if (readingName) {
        if (/[A-Za-z0-9_$]/.test(c)) { nameBuf += c; i++; continue; }
        flushName();
        continue; // 当前字符重新判定（不 i++）
      }
      if (readingStatus) {
        if (c === ',') {
          readingStatus = false;
          for (const m of statusBuf.matchAll(/'([^']*)'/g)) statusLiterals.push(m[1]);
          statusBuf = '';
          lastSep = ',';
          i++; continue;
        }
        statusBuf += c; i++; continue;
      }
      if ((lastSep === '{' || lastSep === ',') && /[A-Za-z_$]/.test(c)) {
        readingName = true; nameBuf = c; i++; continue;
      }
      if (c === ',') lastSep = ',';
    }
    i++;
  }
  if (readingName) flushName();
  if (readingStatus) for (const m of statusBuf.matchAll(/'([^']*)'/g)) statusLiterals.push(m[1]);
  return { keys, statusLiterals };
}

const TOOLS_DIR = fileURLToPath(new URL('../src/tools/', import.meta.url));

/** 单文件收单：全部 JSON.stringify({…status…}) 字面量回执 */
function collectReceipts(file: string, src: string): Receipt[] {
  const receipts: Receipt[] = [];
  const re = /JSON\.stringify\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    let i = m.index + m[0].length;
    while (i < src.length && /\s/.test(src[i])) i++;
    if (src[i] !== '{') continue; // stringify(变量) 非字面量 —— 非本普查面
    const close = matchBrace(src, i);
    if (close < 0) continue;
    const shape = shapeOf(src.slice(i, close + 1));
    if (!shape.keys.includes('status')) continue; // 非状态回执（无顶层 status 键）
    receipts.push({ file, line: src.slice(0, i).split('\n').length, keys: shape.keys, statusLiterals: shape.statusLiterals });
  }
  return receipts;
}

function collectAllReceipts(): Receipt[] {
  const out: Receipt[] = [];
  for (const f of readdirSync(TOOLS_DIR)) {
    if (!f.endsWith('.ts')) continue;
    out.push(...collectReceipts(f, readFileSync(path.join(TOOLS_DIR, f), 'utf8')));
  }
  return out;
}

// ═══ 豁免册：在册差异方言（与各文件头注互为镜像 —— 修差异须同步删条目）═══

interface LedgerEntry {
  file: string;
  statuses: string[]; // 顶层 status 字面（排序后比对；三元多字面全列）
  missing: string[];  // 缺键（排序后比对；空 = 三键齐全但状态字面未登记词表）
  why: string;
  hits: number;       // 本轮普查命中数（册不留幽灵条目 —— 每条须 ≥1）
}

const REQUIRED_KEYS = ['status', 'state_anchor', 'next_step'];

const LEDGER: LedgerEntry[] = [
  {
    file: 'typeText.ts', statuses: ['FAILED'], missing: ['state_anchor'],
    why: 'catch FAILED {status,error,next_step} —— error 在顶层、无 action/state_anchor（toolErr 产 state_anchor.error）；ΑΩ-R29 头注在册不收编',
    hits: 0,
  },
  {
    file: 'takeScreenshot.ts', statuses: ['FAILED'], missing: ['state_anchor'],
    why: 'catch FAILED 同律 —— error 在顶层、无 action/state_anchor；ΑΩ-R29 头注在册不收编',
    hits: 0,
  },
  {
    file: 'zoomInspect.ts', statuses: ['FAILED'], missing: ['state_anchor'],
    why: 'catch FAILED 同律（ΑΩ-R29 范围外老方言，同族在册：与 typeText/takeScreenshot catch 方言逐键同形）',
    hits: 0,
  },
  {
    file: 'observabilityTools.ts', statuses: ['SUCCESS'], missing: ['state_anchor', 'next_step'],
    why: 'get_metrics 指标报告方言 —— 顶层键为 metrics/insights 等仪表盘键，非动作回执四件套（ΑΩ-R29 范围外，头注仅修路径）',
    hits: 0,
  },
  {
    file: 'qualityCheckup.ts', statuses: ['FAILED'], missing: ['state_anchor', 'next_step'],
    why: 'doctor 出诊报告方言 {status,reason} —— 报告体非动作回执（ΑΩ-R29 范围外；catch 路径已走 toolErr）',
    hits: 0,
  },
  {
    file: 'qualityCheckup.ts', statuses: ['SUCCESS'], missing: ['state_anchor', 'next_step'],
    why: 'doctor 出诊报告方言（diagnose/heal/lessons/self_audit 四路同族：报告键在顶层）—— ΑΩ-R29 范围外',
    hits: 0,
  },
  {
    file: 'skillTools.ts', statuses: ['REHEARSAL_GATE_REJECTED'], missing: [],
    why: '排练闸门拒绝字面未登记 resultContract（classifyResult=UNKNOWN，熔断/遥测对其失明）—— ΑΩ-R29 范围外在册待收编：三键齐全，仅词表未登记',
    hits: 0,
  },
  {
    file: 'skillTools.ts', statuses: ['SUCCESS', 'SUCCESS_UNVERIFIED', 'PARTIAL_FAILURE'], missing: [],
    why: 'run_skill 三态回执：SUCCESS/PARTIAL_FAILURE 已登记，SUCCESS_UNVERIFIED 未登记 resultContract（熔断/遥测对未验证成功失明）—— ΑΩ-R29 范围外在册待收编：三键齐全，仅词表未登记',
    hits: 0,
  },
  {
    file: 'approvalTools.ts', statuses: ['NOTHING_TO_ADJUDICATE', 'ADJUDICATED'], missing: [],
    why: '审批队列裁决回执双态字面未登记 resultContract（classifyResult=UNKNOWN）—— ΑΩ-R29 范围外在册待收编：三键齐全，仅词表未登记',
    hits: 0,
  },
];

// ═══ ① 静态方言普查 ═══

test('ΑΩ-R29①: 静态普查 —— 手拼状态回执全数说锚点方言（三键 + resultContract 词表），差异须在册', () => {
  const receipts = collectAllReceipts();
  assert.ok(
    receipts.length >= 40,
    `普查覆盖面：实测 ${receipts.length} 张手拼状态回执（<40 ⇒ 扫描器失明嫌疑，先修扫描器再谈执法）`,
  );
  const sig = (xs: string[]): string => [...xs].sort().join('|');
  const unlisted: string[] = [];
  for (const r of receipts) {
    const missing = REQUIRED_KEYS.filter(k => !r.keys.includes(k));
    const unregistered = r.statusLiterals.filter(
      s => classifyResult(JSON.stringify({ status: s })).status === 'UNKNOWN');
    if (missing.length === 0 && unregistered.length === 0) continue; // 守方言律
    const hit = LEDGER.find(e =>
      e.file === r.file && sig(e.statuses) === sig(r.statusLiterals) && sig(e.missing) === sig(missing));
    if (hit) { hit.hits++; continue; }
    unlisted.push(
      `${r.file}:${r.line} status=[${r.statusLiterals.join(',')}] missing=[${missing.join(',')}] ` +
      `unregistered=[${unregistered.join(',')}]`);
  }
  assert.deepEqual(
    unlisted, [],
    '方言漂移：以下手拼状态回执缺锚点三键或缺登记状态字面，且不在豁免册 —— ' +
    '要么补齐 {status, state_anchor, next_step} 并走 toolResult 工厂，要么在豁免册登记差异原因');
  const ghosts = LEDGER.filter(e => e.hits === 0).map(e => `${e.file} status=[${e.statuses.join(',')}]`);
  assert.deepEqual(
    ghosts, [],
    '豁免册幽灵条目：以下差异已不存在（被修掉）—— 须同步删除册条目，豁免册只记真实差异');
});

test('ΑΩ-R29①b: 普查面逐文件在场（防扫描器静默失明）', () => {
  const byFile = new Map<string, number>();
  for (const r of collectAllReceipts()) byFile.set(r.file, (byFile.get(r.file) ?? 0) + 1);
  // 已知的手拼方言产地：任一文件归零 ⇒ 扫描器破损或方言面已整体迁移（须同步本册）
  for (const f of [
    'clickMouse.ts', 'clickElement.ts', 'typeText.ts', 'takeScreenshot.ts', 'dragMouse.ts',
    'observabilityTools.ts', 'qualityCheckup.ts', 'skillTools.ts', 'replayActions.ts',
    'scrollPage.ts', 'cognitions.ts', 'approvalTools.ts', 'zoomInspect.ts',
  ]) {
    assert.ok(
      (byFile.get(f) ?? 0) >= 1,
      `${f} 应至少有 1 张手拼状态回执（实测 0 ⇒ 扫描器失明或方言已迁工厂 —— 须同步普查册）`);
  }
});

// ═══ ② 运行时普查：R29 审计工具离线驱动实测回执 ═══

type Exec = (a: unknown) => Promise<string>;
const exec = (t: unknown): Exec => (t as unknown as { execute: Exec }).execute;

/** 锚点方言执法：回执至少含三键且 status ∈ resultContract 词表 */
function assertAnchorDialect(label: string, raw: string): void {
  const out = JSON.parse(raw) as Record<string, unknown>;
  assert.equal(typeof out.status, 'string', `${label}: status 须为字符串字面`);
  assert.ok('state_anchor' in out, `${label}: 回执缺 state_anchor（锚点方言三键之一）`);
  assert.ok('next_step' in out, `${label}: 回执缺 next_step（锚点方言三键之一）`);
  assert.notEqual(
    classifyResult(raw).status, 'UNKNOWN',
    `${label}: status="${String(out.status)}" 未登记 resultContract 词表`);
}

/** 与 epochDelta.safety 的 clickCfg 同族：闸门语义开、验证/OCR/探针全关（离线确定性） */
const censusCfg = {
  enableApprovalGate: true,
  dangerPatterns: 'send,发送,delete,删除,pay,支付',
  enableRiskGate: true,
  riskPatterns: '',
  maxTextLength: 1000,
  focusMaxAgeMs: 60_000,
  enableNotarizationLock: false,
  verifyActions: false,
  dryRun: false,
  enableOcr: false,
  enableInteractivityProbe: false,
  intentVerify: false,
  adaptiveSettle: false,
  actionSettleMs: 1,
  noopSimilarityThreshold: 0.97,
  regionVerifyRadius: 0.15,
  physicsRules: '',
} as unknown as Config;

test('ΑΩ-R29②: 运行时普查 —— 审计工具离线驱动实测，成功/拦截/失败三路全说锚点方言', async () => {
  const host = system as unknown as Record<string, unknown>;
  const saved: Record<string, unknown> = {
    pressHotkey: host.pressHotkey, typeText: host.typeText, getScreenSize: host.getScreenSize,
    dragMouse: host.dragMouse, clickMouse: host.clickMouse, switchWindowByTitle: host.switchWindowByTitle,
    getActiveDisplay: host.getActiveDisplay, getMousePosition: host.getMousePosition,
  };
  host.pressHotkey = async (): Promise<void> => { /* 假和弦 */ };
  host.typeText = async (): Promise<void> => { /* 假输入 */ };
  host.getScreenSize = async (): Promise<{ width: number; height: number }> => ({ width: 1920, height: 1080 });
  host.dragMouse = async (): Promise<void> => { /* 假拖拽 */ };
  host.clickMouse = async (): Promise<void> => { /* 假点击 */ };
  host.switchWindowByTitle = async (): Promise<{ method: string; matched: string | null }> =>
    ({ method: 'native', matched: '无标题 - 记事本' });
  host.getActiveDisplay = async (): Promise<{ name: string; x: number; y: number; width: number; height: number }> =>
    ({ name: 'Primary', x: 0, y: 0, width: 1920, height: 1080 });
  host.getMousePosition = async (): Promise<{ x: number; y: number }> => ({ x: 960, y: 540 });
  try {
    // switch_tab：非法方向（工厂 toolErr）+ 正常切换（工厂 toolOk）
    assertAnchorDialect('switch_tab 非法方向', await exec(switchTabTool)({ direction: 'sideways' }));
    assertAnchorDialect('switch_tab 成功', await exec(switchTabTool)({ direction: 'next' }));
    // switch_window：native-title 取证命中（工厂 toolOk）
    assertAnchorDialect('switch_window 成功', await exec(switchWindowTool)({ titleKeyword: '记事本' }));
    // dismiss_popup：TACTICAL_PAUSE 共享常量（ΑΩ-R29 在册不收编，但说的是锚点方言）
    assertAnchorDialect('dismiss_popup 战术暂停', await exec(dismissPopupTool)({}));
    // type_text：敏感拦截（在册 ACTION_REQUIRED 方言）+ 成功（ΑΩ-R29 收编 toolOk）
    assertAnchorDialect('type_text 敏感输入拦截', await exec(createTypeTextTool(censusCfg))({ text: '验证码 123456 请查收' }));
    const typedOk = await exec(createTypeTextTool(censusCfg))({ text: 'hello world' });
    assertAnchorDialect('type_text 成功（收编 toolOk）', typedOk);
    assert.deepEqual(
      Object.keys(JSON.parse(typedOk)), ['status', 'action', 'state_anchor', 'next_step'],
      'type_text SUCCESS 顶层键序 = toolOk 工厂方言（ΑΩ-R29 收编后的形状铁律）');
    // drag_mouse：危险目的地拦截（在册 ACTION_REQUIRED 方言）+ 成功（ΑΩ-R29 收编 toolOk）
    assertAnchorDialect('drag_mouse 危险目的地拦截', await exec(createDragMouseTool(censusCfg))(
      { startX: 0.1, startY: 0.1, endX: 0.9, endY: 0.9, target_description: '拖进删除区' }));
    const dragOk = await exec(createDragMouseTool(censusCfg))({ startX: 0.1, startY: 0.1, endX: 0.9, endY: 0.9 });
    assertAnchorDialect('drag_mouse 成功（收编 toolOk）', dragOk);
    assert.deepEqual(
      Object.keys(JSON.parse(dragOk)), ['status', 'action', 'state_anchor', 'next_step'],
      'drag_mouse SUCCESS 顶层键序 = toolOk 工厂方言（ΑΩ-R29 收编后的形状铁律）');
    // click_element：未知 ID（工厂 toolErr）+ 安全元素点击（工厂 toolOk）—— 假元素树
    setAccessibilityProvider(async () => ({
      children: [{ role: 'button', name: '保存设置', rect: { x: 700, y: 500, width: 100, height: 40 } }],
    }));
    try {
      assertAnchorDialect('click_element 未知 ID', await exec(createClickElementTool(censusCfg))({ id: 999 }));
      assertAnchorDialect('click_element 安全元素点击', await exec(createClickElementTool(censusCfg))({ id: 1 }));
    } finally {
      setAccessibilityProvider(null as never);
    }
    // take_screenshot：物理取屏缺席 ⇒ catch FAILED（在册无锚差异 —— 按册钉死）
    host.getScreenSize = async (): Promise<{ width: number; height: number }> => {
      throw new Error('census: 物理取屏缺席');
    };
    const shotFail = await exec(createTakeScreenshotTool({} as unknown as Config))({});
    const sf = JSON.parse(shotFail) as Record<string, unknown>;
    assert.equal(sf.status, 'FAILED');
    assert.ok('next_step' in sf, '在册差异也有 next_step（恢复指引不缺席）');
    assert.ok(!('state_anchor' in sf), '在册差异钉死：FAILED 无 state_anchor —— 修差异须同步删豁免册条目');
    assert.equal(classifyResult(shotFail).status, 'FAILED', '无锚 FAILED 仍可判（顶层 status 主通道）');
    // type_text 派发异常 ⇒ catch FAILED（同族在册差异）
    host.typeText = async (): Promise<void> => { throw new Error('census: 输入派发失败'); };
    const typeFail = await exec(createTypeTextTool(censusCfg))({ text: 'hello again' });
    const tf = JSON.parse(typeFail) as Record<string, unknown>;
    assert.equal(tf.status, 'FAILED');
    assert.ok(!('state_anchor' in tf), '在册差异钉死：FAILED 无 state_anchor —— 修差异须同步删豁免册条目');
    assert.equal(classifyResult(typeFail).status, 'FAILED');
  } finally {
    Object.assign(host, saved); // 恢复器：假 system 还原原样（switchTab 测试同律）
  }
});

test('ΑΩ-R29③: 前缀方言（[Error]:）—— classifyResult 回退通道可判（普查兼容面，非状态回执）', async () => {
  const badDrag = await exec(createDragMouseTool(censusCfg))({ startX: -1, startY: 0.1, endX: 0.9, endY: 0.9 });
  assert.match(badDrag, /^\[Error\]: Invalid drag coordinates/, '越界拒绝 = 前缀方言（ΑΩ-R29 在册不收编）');
  assert.equal(classifyResult(badDrag).status, 'FAILED', '前缀协议回退通道：仍被判 FAILED');
  const tooLong = await exec(createTypeTextTool(censusCfg))({ text: 'x'.repeat(1001) });
  assert.match(tooLong, /^\[Error\]: Text too long/, '超长拒绝 = 前缀方言（ΑΩ-R29 在册不收编）');
  assert.equal(classifyResult(tooLong).status, 'FAILED', '前缀协议回退通道：仍被判 FAILED');
});
