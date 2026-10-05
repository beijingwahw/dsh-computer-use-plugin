// test/pan128.capContract.test.ts
// ΠΑΝ-128/129 执法册：TS↔Python 能力位与错误 kind 契约同源对账 + capToken
// 密钥写后回读复核。
//
//   - ΠΑΝ-128（F3-6 §二.1 登记的 src 待修，根因 w4mobile W4-5④a 401）：
//     Python auth.py 的 ALL_CAPS / Capability Literal / ENDPOINT_CAPABILITY
//     与 TS contracts.ts 的 Capability 联合 / ALL_CAPS 数组做**程序化对账**
//     （直接读两侧源文件解析，不硬编码快照 —— 两侧任一漂移即红）。
//     镜像 ΠΑΝ-93/95：errors.py ErrorKind 闭集 ⊆ TS PhysicalErrorKind。
//   - ΠΑΝ-129：ensureKey 写后回读复核（对齐 F1-7 在 Python 侧实测发现的
//     「落盘字节漂移 + 不回读 ⇒ 首启神秘 invalid signature 且不可自愈」地雷
//     的 TS 同款防御）。生成→重读恒等 ×15 轮（锁死漂移回归）。
//
// 全离线确定性：只读两侧源文件 + 临时目录，零网络零子进程。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_CAPS, PhysicalErrorKind } from '../src/physicalExecution/contracts.ts';
import { ensureKey, mintToken, parseToken } from '../src/physicalExecution/capToken.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string): string => readFileSync(join(repoRoot, rel), 'utf-8');

// ─── 两侧源文件解析（程序化对账：不硬编码快照，读事实源）───

/** 提取 Python 源文本某赋值块内全部字符串字面量（按出现序） */
function pyStrings(src: string, declHead: string): string[] {
  const idx = src.indexOf(declHead);
  assert.ok(idx >= 0, `Python 源缺少声明 ${declHead}`);
  // 声明头之后的首个 '='/':' 到块尾（闭括号/换行空行）之间的文本
  const rest = src.slice(idx);
  const out: string[] = [];
  // 逐行剥注释（# ...），再收 "..." / '...' 字面量 —— 与 auth.py 手写风格匹配
  for (const rawLine of rest.split('\n')) {
    const line = rawLine.split('#')[0];
    for (const m of line.matchAll(/"([^"]+)"|'([^']+)'/g)) {
      out.push(m[1] ?? m[2] ?? '');
    }
    // ALL_CAPS 元组与 ENDPOINT_CAPABILITY 字典都以闭括号收尾；
    // 字典条目行含 "..." 形式键值；遇空行且已收集 ⇒ 块尽（防御性，不依赖）
    if (out.length > 0 && /^\s*[)\]}]\s*$/.test(line)) break;
  }
  return out;
}

/** Python auth.py: Capability Literal 字面量（过滤注释行干扰） */
function pyCapabilityLiteral(src: string): string[] {
  const idx = src.indexOf('Capability = Literal[');
  assert.ok(idx >= 0, 'auth.py 缺少 Capability Literal 声明');
  const rest = src.slice(idx, src.indexOf(']', idx));
  const out: string[] = [];
  for (const m of rest.matchAll(/"([^"]+)"/g)) out.push(m[1]);
  return out;
}

/** Python auth.py: ENDPOINT_CAPABILITY 字典 —— path → cap 条目（按出现序） */
function pyEndpointCapability(src: string): Array<[string, string]> {
  const idx = src.indexOf('ENDPOINT_CAPABILITY: dict');
  assert.ok(idx >= 0, 'auth.py 缺少 ENDPOINT_CAPABILITY 声明');
  const close = src.indexOf('\n}', idx); // 字典以行首 } 收尾（auth.py 手写方言）
  assert.ok(close > idx, 'ENDPOINT_CAPABILITY 字典未闭括号');
  const out: Array<[string, string]> = [];
  for (const m of src.slice(idx, close).matchAll(/"([^"]+)":\s*"([^"]+)"/g)) {
    out.push([m[1], m[2]]);
  }
  // 去掉误入的字典类型注解片段（正则只匹配 "k": "v" 形态，注解不误入）
  return out.filter(([k]) => k.startsWith('/'));
}

/** TS 源文本：剥 // 注释后按行返回（保序） */
function tsLines(block: string): string[] {
  return block.split('\n').map((l) => l.replace(/\/\/.*$/, ''));
}

/** TS contracts.ts: Capability 联合成员（源级静态解析 —— 类型层无法运行时自省） */
function tsCapabilityUnion(src: string): string[] {
  const idx = src.indexOf('export type Capability =');
  assert.ok(idx >= 0, 'contracts.ts 缺少 Capability 联合声明');
  const stop = src.indexOf('export const ALL_CAPS', idx);
  assert.ok(stop > idx, 'contracts.ts ALL_CAPS 紧随 Capability 联合（方言锚）');
  const out: string[] = [];
  for (const line of tsLines(src.slice(idx, stop))) {
    for (const m of line.matchAll(/'([^']+)'/g)) out.push(m[1]);
  }
  return out;
}

/** TS contracts.ts: ALL_CAPS 数组成员（按出现序；块以 "] as const" 收尾） */
function tsAllCapsArray(src: string): string[] {
  const idx = src.indexOf('export const ALL_CAPS: readonly Capability[] = [');
  assert.ok(idx >= 0, 'contracts.ts 缺少 ALL_CAPS 数组声明');
  const rest = src.slice(idx);
  const end = rest.indexOf('] as const');
  assert.ok(end > 0, 'contracts.ts ALL_CAPS 数组未以 ] as const 收尾（方言锚）');
  const out: string[] = [];
  for (const line of tsLines(rest.slice(0, end))) {
    for (const m of line.matchAll(/'([^']+)'/g)) out.push(m[1]);
  }
  return out;
}

// ─── ΠΑΝ-128 ①：能力位闭集两侧同源 ───

test('ΠΑΝ-128①: TS ALL_CAPS 运行时数组 === TS Capability 联合 === Python ALL_CAPS（序与集逐字节同源）', () => {
  const pySrc = read('python_service/dsh_physical/auth.py');
  const tsSrc = read('src/physicalExecution/contracts.ts');

  const pyAllCaps = pyStrings(pySrc, 'ALL_CAPS: tuple[Capability, ...] = (');
  const pyLiteral = pyCapabilityLiteral(pySrc);
  const tsUnion = tsCapabilityUnion(tsSrc);
  const tsArr = tsAllCapsArray(tsSrc);

  // 四方闭集逐一断言（含顺序 —— 镜像方言是字节级的，不只集合相等）
  assert.deepEqual([...ALL_CAPS], pyAllCaps, 'TS 运行时 ALL_CAPS 必须与 Python auth.ALL_CAPS 同序同集');
  assert.deepEqual([...ALL_CAPS], tsArr, 'TS 运行时 ALL_CAPS 必须与其源码数组字面同序同集');
  assert.deepEqual([...ALL_CAPS], tsUnion, 'TS Capability 联合必须与 ALL_CAPS 数组同集（闭集自洽）');
  assert.deepEqual([...ALL_CAPS], pyLiteral, 'TS ALL_CAPS 必须与 Python Capability Literal 同序同集');
});

test('ΠΑΝ-128①: 旧九位语义零回归锚点（additive 铁律）', () => {
  const legacyNine = [
    'click', 'type', 'scroll', 'hotkey', 'drag',
    'screenshot', 'ui_tree', 'switch_window', 'shm_delete',
  ];
  const caps: string[] = [...ALL_CAPS];
  for (const c of legacyNine) {
    assert.ok(caps.includes(c), `既有能力位 ${c} 不得丢失（additive）`);
  }
  // ΠΑΝ-25 新位（本工单镜像的根因位）
  assert.ok(caps.includes('admin'), 'admin 位必须入 TS 闭集（/v1/shutdown）');
  assert.ok(caps.includes('observe'), 'observe 位必须入 TS 闭集（/v1/stats、/v1/input_events、/v1/devices）');
});

test('ΠΑΝ-128①: Python ENDPOINT_CAPABILITY 每个映射值 ∈ TS ALL_CAPS 闭集（TS 可铸任意端点合法 token）', () => {
  const pySrc = read('python_service/dsh_physical/auth.py');
  const caps = new Set<string>(ALL_CAPS);
  const mapping = pyEndpointCapability(pySrc);
  assert.ok(mapping.length >= 24, `端点映射条数异常（${mapping.length} < 24 —— 解析器或映射被删）`);
  for (const [ep, cap] of mapping) {
    assert.ok(caps.has(cap), `端点 ${ep} 要求的能力位 '${cap}' 不在 TS ALL_CAPS 闭集 —— Node 端铸不出合法 token（ΠΑΝ-128 漂移）`);
  }
});

test('ΠΑΝ-128①: 管理面四条映射锚点（ΠΑΝ-25 目标态，w4mobile W4-5④a 根因验证源）', () => {
  const pySrc = read('python_service/dsh_physical/auth.py');
  const mapping = new Map(pyEndpointCapability(pySrc));
  assert.equal(mapping.get('/v1/shutdown'), 'admin', '/v1/shutdown → admin');
  assert.equal(mapping.get('/v1/stats'), 'observe', '/v1/stats → observe');
  assert.equal(mapping.get('/v1/input_events'), 'observe', '/v1/input_events → observe');
  assert.equal(mapping.get('/v1/devices'), 'observe', '/v1/devices → observe（W4-5④a 401 根因位）');
});

// ─── ΠΑΝ-128 ②：错误 kind 闭集对齐（镜像 ΠΑΝ-93/95）───

test('ΠΑΝ-128②: Python ErrorKind 枚举 ⊆ TS PhysicalErrorKind（含 busy / device_unreachable）', () => {
  const pyErr = read('python_service/dsh_physical/errors.py');
  // ErrorKind 枚举体：NAME = "value" 形态
  const enumIdx = pyErr.indexOf('class ErrorKind(str, Enum):');
  assert.ok(enumIdx >= 0, 'errors.py 缺少 ErrorKind 枚举');
  const enumBody = pyErr.slice(enumIdx, pyErr.indexOf('\n@dataclass', enumIdx));
  const pyKinds = new Map<string, string>();
  for (const m of enumBody.matchAll(/^\s*(\w+)\s*=\s*"([^"]+)"/gm)) pyKinds.set(m[1], m[2]);

  const tsKinds = new Set<string>(Object.values(PhysicalErrorKind));
  // Node 端独有：transport_error / client_timeout（Python 端没有 —— 合法差集）
  const nodeOnly = new Set(['transport_error', 'client_timeout']);
  for (const [name, value] of pyKinds) {
    assert.ok(tsKinds.has(value),
      `Python ErrorKind.${name}='${value}' 不在 TS PhysicalErrorKind —— 镜像漂移`);
  }
  // ΠΑΝ-93/95 新 kind 双侧锁定
  assert.ok(pyKinds.get('BUSY') === 'busy' && tsKinds.has('busy'), 'busy kind 双侧必须在位（池背压，退避重试）');
  assert.ok(pyKinds.get('DEVICE_UNREACHABLE') === 'device_unreachable' && tsKinds.has('device_unreachable'),
    'device_unreachable kind 双侧必须在位（设备级失败，与 internal_error 区分）');
  // 差集恰为 Node 独有两位（反向漂移检测：TS 不得私加 Python 没有的"镜像"位）
  for (const k of tsKinds) {
    if (!nodeOnly.has(k)) {
      assert.ok([...pyKinds.values()].includes(k), `TS kind '${k}' 在 Python ErrorKind 无对应（非声明独有位）`);
    }
  }
});

// ─── ΠΑΝ-129：ensureKey 写后回读复核 ───

test('ΠΑΝ-129①: 新生成密钥 —— 返回值与盘上字节逐字节一致（写后回读复核的可见面）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pan129-key-'));
  try {
    const keyPath = join(dir, 'hmac.key');
    const key = await ensureKey(keyPath);
    assert.equal(key.length, 32, '密钥恰 32 字节');
    const onDisk = readFileSync(keyPath);
    assert.equal(onDisk.length, 32, `盘上密钥长度漂移：${onDisk.length}B（写后回读复核失效）`);
    assert.ok(onDisk.equals(Buffer.from(key)), '盘上字节必须与返回密钥逐字节一致（ΠΑΝ-129）');
    // 二次加载：与首次内存副本恒等（跨调用稳定 —— Python 端可接力）
    const again = await ensureKey(keyPath);
    assert.ok(Buffer.from(again).equals(Buffer.from(key)), '重读恒等');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ΠΑΝ-129①: 15 轮生成→重读恒等（锁死落盘漂移回归 —— 对齐 Python KeyPermissionTests 方言）', async () => {
  for (let i = 0; i < 15; i++) {
    const dir = mkdtempSync(join(tmpdir(), `pan129-round${i}-`));
    try {
      const keyPath = join(dir, 'nested', 'hmac.key'); // 带父目录创建路径
      const a = await ensureKey(keyPath);
      const b = await ensureKey(keyPath);
      assert.ok(Buffer.from(a).equals(Buffer.from(b)), `第 ${i + 1} 轮生成→重读失配（落盘漂移）`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('ΠΑΝ-129①: 既有短文件拒绝（异常诚实第一条不变）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pan129-short-'));
  try {
    const keyPath = join(dir, 'hmac.key');
    writeFileSync(keyPath, Buffer.alloc(16)); // 16B < 32B
    await assert.rejects(() => ensureKey(keyPath), /too short/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ΠΑΝ-129①: 全权 token（ALL_CAPS）可携带 admin/observe —— 管理端点对接面（W4-5④a 根因验证）', async () => {
  // 与 w4mobile.test.ts authHeaders 同款方言：mintToken(key, pid, ALL_CAPS, 60)
  const key = new Uint8Array(Buffer.from('k'.repeat(64), 'utf-8'));
  const token = mintToken(key, process.pid, ALL_CAPS, 60);
  const parsed = parseToken(key, token);
  assert.ok(parsed.ok, `自铸 token 必须可自验：${parsed.ok ? '' : parsed.reason}`);
  const caps = new Set(parsed.payload.caps);
  assert.ok(caps.has('observe'), '全权 token 必须含 observe（/v1/devices、/v1/stats、/v1/input_events）');
  assert.ok(caps.has('admin'), '全权 token 必须含 admin（/v1/shutdown）');
  // mint→parse 闭环的 caps 数与 ALL_CAPS 恒等（铸不出闭集外能力）
  assert.equal(parsed.payload.caps.length, ALL_CAPS.length, 'caps 逐位无损');
});
