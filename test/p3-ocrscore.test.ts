// test/p3-ocrscore.test.ts
// 纪元 P3（PyS：OCR 词级真值跨线）—— 三波创新登记缝隙的闭合执法测试。
// 缝隙出处（遍历 + P2a 在册）：python_service/dsh_physical/ui_tree.py 的 L2
// RapidOCR 词级分数 score_f 仅用于 <0.5 剔除后即被丢弃，序列化 UIElement 只有
// source/role/name/state/rect —— 真值未跨线；TS 侧 textReader 服务端 OCR 路径
// 因此恒填 confidence:90，P2a-3 只能加 confidenceAssumed:true 诚实标记并声明
// 「python 端加 score 字段后此语义位可接真值」。本纪元兑现该声明：
//   1. python 端 UIElement 增可选 score（L2 填真值夹 [0,1]，L1/L3 None 缺席）；
//   2. wire 契约（physicalExecution/contracts.ts UIElement）增 score?: number；
//   3. TS 消费双态语义：真值在场且有限 ⇒ 换算 0-100 方言 + assumed 缺席；
//      缺席/非法 ⇒ 90 + assumed:true 旧方言逐字节（P2a-3 回归锁）。
// 铁律：全离线（假 adapter 经 _setAdapterForTests 注入，绝不触发 D-5 微服务）。
// 职权声明：真端到端（python 微服务真起 + RapidOCR 真识图 + HMAC wire 全链）属
// 真机 bench 职权，本文件以「假 adapter 行为级 + python 源码取证级」双证据离线
// 证明跨线通道已通。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const textReader = await import('../src/textReader.ts');
const backend = await import('../src/physicalBackend.ts');

after(() => {
  backend._setAdapterForTests(null);
  textReader._setServerOcrFailedAt_forTest(0);
});

/** 假 adapter：getUiTree 返回受控元素表（离线 —— 绝不触真微服务） */
function fakeUiTreeAdapter(elements: Array<Record<string, unknown>>): void {
  backend._setAdapterForTests({
    getUiTree: async () => ({
      ok: true as const,
      value: {
        elements,
        funnel_depth: 'L2', fault: null, captured_at: 1, l3_invoked: false,
      },
    }),
  } as never);
}

/** 假 L2 元素（与 p2a-fixes.test.ts P2a-3 同形，可携带 score 真值；
 *  rect 取二进精确值 —— bbox/center 断言免浮点和噪声） */
function l2(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { source: 'L2-ocr', role: 'text', name, rect: { x: 0.25, y: 0.5, width: 0.25, height: 0.25 }, ...extra };
}

// ═══ PyS-1：真值态 —— 词对象取真值且无 assumed 标记；消毒律 ═══

test('PyS-1: score 真值在场 ⇒ confidence 取真值（×100 换算 0-100 方言）且 confidenceAssumed 键缺席', async () => {
  textReader._setServerOcrFailedAt_forTest(0); // 清服务端负缓存（离线前置）
  fakeUiTreeAdapter([
    l2('Alpha', { score: 0.75 }),
    l2('Beta', { score: 0.5 }),
  ]);
  const r = await textReader.readTextAny(undefined);
  assert.equal(r.words.length, 2);
  const [a, b] = r.words;
  // 真值态：score [0,1] ×100 换算到 confidence 的 0-100 方言（tesseract 同尺度；
  // autonomy/runtime.ts 消费按 confidence/100 归一 —— 不换算会破坏下游语义）
  assert.equal(a!.confidence, 75, 'score=0.75 ⇒ confidence=75（真值换算非假设 90）');
  assert.equal(b!.confidence, 50, 'score=0.5 ⇒ confidence=50');
  // P2a-3 语义位兑现：有真值就不标假设 —— 键必须**缺席**（非 false）
  assert.equal('confidenceAssumed' in a!, false, '真值态：assumed 键缺席（不是 false）');
  assert.equal(a!.confidenceAssumed, undefined);
  assert.deepEqual(
    Object.keys(a!).sort(),
    ['bbox_normalized', 'center_normalized', 'confidence', 'text'],
    '真值态词对象形状：无 confidenceAssumed 键',
  );
  assert.deepEqual(a!.bbox_normalized, { x0: 0.25, y0: 0.5, x1: 0.5, y1: 0.75 }, 'bbox 语义零变化');
  assert.deepEqual(a!.center_normalized, { x: 0.375, y: 0.625 }, 'center 语义零变化');
});

test('PyS-1: 消毒律 —— 有限越界值夹取 [0,1]（负→0 / 超1→100 仍真值态）', async () => {
  textReader._setServerOcrFailedAt_forTest(0);
  fakeUiTreeAdapter([
    l2('Over', { score: 1.7 }),   // 超 1：有限 ⇒ 夹取（防御纵深 —— python 端已夹）
    l2('Under', { score: -0.4 }), // 负：有限 ⇒ 夹取
  ]);
  const r = await textReader.readTextAny(undefined);
  const [over, under] = r.words;
  assert.equal(over!.confidence, 100, 'score=1.7 ⇒ 夹 1 ⇒ confidence=100（真值态）');
  assert.equal('confidenceAssumed' in over!, false, '夹取后仍是测量值臂 —— assumed 缺席');
  assert.equal(under!.confidence, 0, 'score=-0.4 ⇒ 夹 0 ⇒ confidence=0（真值态）');
  assert.equal('confidenceAssumed' in under!, false);
});

test('PyS-1: 消毒律 —— 非有限（NaN/±∞）与非数（字符串）⇒ 回退 90+assumed 旧方言', async () => {
  textReader._setServerOcrFailedAt_forTest(0);
  fakeUiTreeAdapter([
    l2('Nan', { score: NaN }),
    l2('Inf', { score: Infinity }),
    l2('Str', { score: '0.9' }), // 旧服务/畸形帧：非数（防御解析容忍）
  ]);
  const r = await textReader.readTextAny(undefined);
  assert.equal(r.words.length, 3);
  for (const w of r.words) {
    assert.equal(w.confidence, 90, `非有限/非数（${w.text}）⇒ 回退 90 假设值`);
    assert.equal(w.confidenceAssumed, true, `非有限/非数（${w.text}）⇒ assumed:true 在场`);
  }
});

// ═══ PyS-2：旧态回归锁（P2a-3 方言逐字节） ═══

test('PyS-2: score 缺席 ⇒ 90 + confidenceAssumed:true（P2a-3 旧方言逐字节回归锁）', async () => {
  textReader._setServerOcrFailedAt_forTest(0);
  fakeUiTreeAdapter([
    l2('Settings'), // 无 score 键 —— 旧服务 / L1·L3 混排元素（无分数路径）
    { source: 'L1-tree', role: 'button', name: 'OK', rect: { x: 0.1, y: 0.1, width: 0.1, height: 0.1 } },
  ]);
  const r = await textReader.readTextAny(undefined);
  assert.equal(r.words.length, 1, '只有 L2-ocr 元素映射为词（L1-tree 不入 OCR 词表）');
  const w = r.words[0]!;
  assert.equal(w.text, 'Settings');
  assert.equal(w.confidence, 90, '真值缺席 ⇒ 保持 90（P2a-3 旧方言）');
  assert.equal(w.confidenceAssumed, true, '真值缺席 ⇒ 假设值标记在场');
  assert.deepEqual(
    Object.keys(w).sort(),
    ['bbox_normalized', 'center_normalized', 'confidence', 'confidenceAssumed', 'text'],
    '旧态词对象形状：与 P2a-3 完全一致（含 assumed 键）',
  );
});

// ═══ PyS-3：python 源码取证 —— 跨线通道在场的离线证明 ═══

test('PyS-3: ui_tree.py 源码取证 —— score 字段/序列化/赋值点/剔除律原样在册', () => {
  const py = readFileSync(new URL('../python_service/dsh_physical/ui_tree.py', import.meta.url), 'utf8');
  // 1) dataclass 字段：可选 None 缺席方言
  assert.match(py, /score:\s*float\s*\|\s*None\s*=\s*None/, 'UIElement dataclass 增可选 score 字段');
  // 2) 序列化出键点：None ⇒ 键缺席（真值在场才跨线）
  assert.match(py, /if self\.score is not None:\s*\r?\n\s*d\["score"\]\s*=\s*self\.score/, 'to_dict 条件出键：真值在场才序列化');
  // 3) L2 真值赋值点：score_f 夹 [0,1] 后随元素跨线
  assert.match(py, /score=score_out/, 'L2 路径 UIElement 构造携带真值');
  assert.match(py, /min\(max\(score_f,\s*0\.0\),\s*1\.0\)/, '真值夹取 [0,1] 的消毒律在场');
  // 4) 既有剔除律原样未动（<0.5 丢弃照旧先行）
  assert.match(py, /if not text or score_f < 0\.5:\s*\r?\n\s*continue/, '剔除律（<0.5 丢弃）原样在册');
  // 5) TS 侧接线取证：wire 契约可选字段 + 双态消费
  const contracts = readFileSync(new URL('../src/physicalExecution/contracts.ts', import.meta.url), 'utf8');
  assert.match(contracts, /score\?:\s*number/, 'wire 契约 UIElement 增 score?: number（容忍缺席）');
  const tr = readFileSync(new URL('../src/textReader.ts', import.meta.url), 'utf8');
  assert.match(tr, /Number\.isFinite\(s\)/, 'TS 消毒律：有限性判定在场');
  assert.match(tr, /\.\.\.\(truth === null \? \{ confidenceAssumed: true \} : \{\}\)/, '双态语义：assumed 仅旧态在场');
  // 真端到端（微服务真起 + RapidOCR 真识图 + HMAC wire）属真机 bench 职权，
  // 本文件以「假 adapter 行为级 + 源码取证级」双证据离线证明通道已通。
});
