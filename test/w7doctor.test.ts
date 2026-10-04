// test/w7doctor.test.ts
// W7-1 回归：over-engineering 官方豁免机制（中央注册表 + fail-fast + 可观测）。
// 世界级标准的测试面：豁免必须显式登记、带理由、可审计 —— 绝不静默跳过；
// 未登记文件照判；genesis/critical/major 永不受豁免；注册表带病即启动失败。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  doctor, DOCTOR_RULES, EXEMPTABLE_RULE_ID, OVER_ENGINEERING_EXEMPTIONS,
  assertExemptionRegistryValid, formatDoctorSummary,
} from '../src/qualityDoctor.ts';
import type { DiagnosisReport, DoctorConfig, OverEngineeringExemption } from '../src/doctorTypes.ts';

const REAL_SRC_ANCHOR = resolve(dirname(fileURLToPath(import.meta.url)), '../src');

function makeFixture(): { root: string; cfg: DoctorConfig } {
  const root = mkdtempSync(join(tmpdir(), 'w7doctor-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  const cfg = {
    sourceRoot: join(root, 'src'),
    memoryPath: join(root, 'doctor-memory.json'),
    strict: false,
  };
  return { root, cfg };
}

function put(root: string, rel: string, content: string): void {
  const full = join(root, 'src', rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, 'utf8');
}

/** 501+ 行合成文件（触发 smell.over-engineering 的 >500 行阈值） */
const bigFile = (n = 520): string => Array.from({ length: n }, (_, i) => `// padding line ${i}`).join('\n');

const CLEAN = 'export function ok(x: number): boolean { return x > 0; }\n';

beforeEach(() => {
  doctor.resetMemory();
  doctor.resetConfig();
});

// ─── ① 豁免命中：降级为 registered-retention（可见、不扣分） ───

test('W7-1 豁免命中：注册表文件的 over-engineering 降级为 registered-retention，不扣分仍可见', async () => {
  const { root, cfg } = makeFixture();
  put(root, 'autonomy/gym.ts', bigFile());       // 注册表在案（W6-1）
  put(root, 'clean.ts', CLEAN);
  await doctor.configure(cfg);

  const r = await doctor.diagnose();
  const f = r.findings.find(x => x.ruleId === 'smell.over-engineering');
  assert.ok(f, '豁免件仍出现在 findings 列表（可见性）');
  assert.equal(f!.location.file, 'autonomy/gym.ts');
  assert.ok(f!.exempted, '命中注册表 ⇒ finding 标记 exempted');
  assert.equal(f!.exempted!.epoch, 'W6-1');
  assert.match(f!.evidence, /\[registered-retention:W6-1\]/, 'evidence 前缀标注登记纪元');
  assert.match(f!.evidence, /训练营/, 'evidence 携带登记理由');
  assert.deepEqual(r.exemptions, { registered: 24, applied: 1 }, '统计行数据：24 件登记（W9-3 新增 confusables.generated 生成物 + skillLibrary/subAgent 器官主体残余）、1 件命中');
  assert.equal(r.score, 100, '唯一 finding 是豁免件 ⇒ 零扣分');

  // 报告落盘含豁免标记（可审计）
  const onDisk = JSON.parse(readFileSync(doctor.reportPath()!, 'utf8'));
  assert.equal(onDisk.exemptions.applied, 1);
  assert.ok(onDisk.findings.some((x: any) => x.exempted?.epoch === 'W6-1'));

  rmSync(root, { recursive: true, force: true });
});

test('W7-1 豁免与未登记并存：分数只反映未登记件（对不上号保留原判）', async () => {
  const { root, cfg } = makeFixture();
  put(root, 'vlm/codec.ts', bigFile());          // 注册表在案（W6-2）
  put(root, 'unregistered.ts', bigFile());       // 未登记 ⇒ 照判
  await doctor.configure(cfg);

  const r = await doctor.diagnose();
  const ex = r.findings.find(x => x.location.file === 'vlm/codec.ts')!;
  const plain = r.findings.find(x => x.location.file === 'unregistered.ts')!;
  assert.ok(ex.exempted, 'codec.ts 命中 W6-2 登记');
  assert.equal(ex.exempted!.epoch, 'W6-2');
  assert.equal(plain.exempted, undefined, '未登记文件无豁免标记');
  // 1 × info(1) × weight(0.5) = 0.5 扣分，豁免件零贡献
  assert.equal(r.score, 99.5);
  assert.deepEqual(r.exemptions, { registered: 24, applied: 1 }); // W9-3: 登记数 21→24（生成物一件 + 器官主体残余两件）

  rmSync(root, { recursive: true, force: true });
});

// ─── ② 豁免语法域：只作用于 smell.over-engineering，其他规则照判 ───

test('W7-1 genesis 不受豁免：注册表文件的 critical 违规照判照扣、一票否决', async () => {
  const { root, cfg } = makeFixture();
  // gym.ts 在豁免注册表，但 nut-js 穿孔是 genesis.io-mutex（critical）—— 豁免语法域之外
  put(root, 'autonomy/gym.ts',
    "import { mouse } from '@nut-tree/nut-js';\n" + bigFile());
  await doctor.configure(cfg);

  const r = await doctor.diagnose();
  const genesis = r.findings.find(x => x.ruleId === 'genesis.io-mutex')!;
  assert.ok(genesis, 'genesis 违规仍被发现');
  assert.equal(genesis.severity, 'critical');
  assert.equal(genesis.exempted, undefined, 'critical 类规则绝不被豁免降级');
  assert.equal(r.genesisVerdict, 'violated');
  assert.ok(r.score < 100, 'genesis 违规照扣分（25 × 2 权重）');

  rmSync(root, { recursive: true, force: true });
});

test('W7-1 magic-number 不受豁免：注册表文件的 minor 违规照判照扣', async () => {
  const { root, cfg } = makeFixture();
  put(root, 'vlm/codec.ts', `if (tokens >= 4096) shrink();\n` + bigFile());
  await doctor.configure(cfg);

  const r = await doctor.diagnose();
  const magic = r.findings.find(x => x.ruleId === 'smell.magic-number')!;
  assert.ok(magic, 'magic-number 仍被发现');
  assert.equal(magic.exempted, undefined, '豁免只作用于 over-engineering');
  const over = r.findings.find(x => x.ruleId === 'smell.over-engineering')!;
  assert.ok(over.exempted, '同文件的 over-engineering 被豁免');
  // minor(4) × 0.5 = 2；豁免件零贡献
  assert.equal(r.score, 98);
  assert.deepEqual(r.exemptions, { registered: 24, applied: 1 }); // W9-3: 登记数 21→24（生成物一件 + 器官主体残余两件）

  rmSync(root, { recursive: true, force: true });
});

// ─── ③ 防滥用执法：注册表带病 ⇒ fail-fast ───

test('W7-1 fail-fast：缺 reason / 缺 epoch / 幽灵文件 / 重复条目 ⇒ 校验即 throw', () => {
  const anchor = mkdtempSync(join(tmpdir(), 'w7anchor-'));
  writeFileSync(join(anchor, 'real.ts'), 'export const a = 1;\n', 'utf8');
  const good = (over: Partial<OverEngineeringExemption> = {}): OverEngineeringExemption =>
    ({ file: 'real.ts', reason: 'r', epoch: 'W6-2', ...over });

  assert.throws(() => assertExemptionRegistryValid([good({ reason: '' })], anchor), /missing reason/);
  assert.throws(() => assertExemptionRegistryValid([{ file: 'real.ts' } as OverEngineeringExemption], anchor), /missing reason/);
  assert.throws(() => assertExemptionRegistryValid([good({ epoch: '' })], anchor), /missing epoch/);
  assert.throws(() => assertExemptionRegistryValid([good({ file: 'ghost.ts' })], anchor), /non-existent file/);
  assert.throws(() => assertExemptionRegistryValid([good(), good()], anchor), /duplicate/);
  // 合法条目静默通过
  assert.doesNotThrow(() => assertExemptionRegistryValid([good()], anchor));
  rmSync(anchor, { recursive: true, force: true });
});

test('W7-1 fail-fast 接线：注册表带病 ⇒ doctor.configure 启动即报错', async () => {
  const { cfg } = makeFixture();
  const bad: OverEngineeringExemption = { file: 'ghost.ts', reason: 'no such file', epoch: 'W6-2' };
  OVER_ENGINEERING_EXEMPTIONS.push(bad); // 临时污染真实注册表（模拟腐化）
  try {
    await assert.rejects(() => doctor.configure(cfg), /W7-1 exemption for non-existent file/);
  } finally {
    OVER_ENGINEERING_EXEMPTIONS.pop(); // 恢复 —— 测试不留副作用
  }
  await assert.doesNotReject(() => doctor.configure(cfg), '恢复后装配正常');
  rmSync(cfg.memoryPath, { force: true });
});

// ─── ④ 真实注册表本身的完整性与溯源 ───

test('W7-1 真实注册表：24 件（W6-1 三件 + W6-2 十八件 + W9-3 三件），三要素齐全且文件真实存在', () => {
  // W9-3（D-F4）：登记数 21→24 —— 生成物一件 + 器官主体残余两件入册
  assert.equal(OVER_ENGINEERING_EXEMPTIONS.length, 24);
  assert.doesNotThrow(() => assertExemptionRegistryValid(OVER_ENGINEERING_EXEMPTIONS));
  for (const e of OVER_ENGINEERING_EXEMPTIONS) {
    assert.ok(existsSync(join(REAL_SRC_ANCHOR, e.file)), `${e.file} 必须真实存在于源码树`);
    assert.ok(e.reason.length >= 10, `${e.file} 理由必须实质（非敷衍单词）`);
  }
  const byEpoch = OVER_ENGINEERING_EXEMPTIONS.reduce<Record<string, number>>((acc, e) => {
    acc[e.epoch] = (acc[e.epoch] ?? 0) + 1; return acc;
  }, {});
  assert.deepEqual(byEpoch, { 'W6-1': 3, 'W6-2': 18, 'W9-3': 3 }, '登记波次溯源：W6-1 三件 + W6-2 十八件 + W9-3 三件（生成物一件 + 器官主体残余两件）');
});

test('W7-1 溯源执法：注册条目的理由与源内 W6 注记对得上号（抽验三锚点）', () => {
  const reg = new Map(OVER_ENGINEERING_EXEMPTIONS.map(e => [e.file, e]));
  const probe = (file: string, marker: RegExp) => {
    const src = readFileSync(join(REAL_SRC_ANCHOR, file), 'utf8');
    assert.match(src.split('\n').slice(0, 5).join('\n'), marker, `${file} 头部应有 W6 保留注记`);
    assert.ok(reg.has(file), `${file} 应在注册表`);
  };
  probe('autonomy/gym.ts', /W6-1 结构性保留登记/);
  probe('autonomy/runtime.ts', /W6-1 结构性保留登记/);
  probe('autonomy/autoPilot.ts', /W6-1 结构性保留登记/);
  probe('vlm/codec.ts', /W6-2 结构性保留/);
  // 未登记的千行文件保留原判：DEBTS.md D-F2 在案但无保留注记 ⇒ 不替别人发明理由。
  // W9-3（D-F4 决策执行）：skillLibrary/subAgent 经真拆分（纯函数区提卫星件）
  // 后登记器官主体残余豁免（理由如实申报卫星件与残余行数）—— 从未登记转已登记。
  assert.equal(reg.has('index.ts'), false);
  assert.equal(reg.has('skillLibrary.ts'), true);
  assert.equal(reg.has('subAgent.ts'), true);
});

test('W7-1 豁免语法域立法：EXEMPTABLE_RULE_ID 是 info 级 smell 规则（critical/major 永不可豁免）', () => {
  const rule = DOCTOR_RULES.find(r => r.id === EXEMPTABLE_RULE_ID)!;
  assert.equal(rule.severity, 'info', '唯一可豁免规则必须是 info 级');
  assert.equal(rule.category, 'smell');
  // 注册表只对 over-engineering 生效的静态保证：豁免降级函数按键 ruleId 过滤（引擎层），
  // 此处以规则等级立法锁底：critical/major 规则不在豁免语法域。
  for (const r of DOCTOR_RULES) {
    if (r.severity === 'critical' || r.severity === 'major') {
      assert.notEqual(r.id, EXEMPTABLE_RULE_ID);
    }
  }
});

// ─── ⑤ 可观测：统计行输出与手术提案隔离 ───

test('W7-1 统计行：formatDoctorSummary 输出 exemptions 行；老报告形状不伪造', () => {
  const base: DiagnosisReport = {
    timestamp: 0, incremental: false, score: 88.5, genesisVerdict: 'intact',
    findings: [], byCategory: { genesis: 0, smell: 0, security: 0, chain: 0 },
    effectiveWeights: {}, trend: null, warnings: [], scannedFiles: 242, chainAudited: true,
  };
  const withEx = formatDoctorSummary({ ...base, exemptions: { registered: 21, applied: 21 } });
  assert.match(withEx, /score=88\.5/);
  assert.match(withEx, /exemptions: 21\/21 over-engineering structural retentions/);
  assert.match(withEx, /never exempted/);
  // 老报告（无 exemptions 字段）：首行照常、无豁免行、不炸
  const legacy = formatDoctorSummary(base);
  assert.match(legacy, /score=88\.5/);
  assert.equal(/exemptions/.test(legacy), false);
});

test('W7-1 手术隔离：豁免件不进 heal 提案（官方保留 ≠ 待手术病灶）', async () => {
  const { root, cfg } = makeFixture();
  put(root, 'autonomy/gym.ts', bigFile());
  await doctor.configure(cfg);
  const report = await doctor.diagnose();
  const exemptId = report.findings.find(f => f.ruleId === 'smell.over-engineering')!.id;

  const res = await doctor.heal(report, { maxRisk: 'mechanical', authorized: true, dryRun: true });
  assert.equal(res.applied.length, 0);
  assert.equal(res.proposed.some(p => p.findingId === exemptId), false, '豁免件不产手术提案');
  assert.equal(readFileSync(join(root, 'src', 'autonomy/gym.ts'), 'utf8').includes('DOCTOR'), false);

  rmSync(root, { recursive: true, force: true });
});

// ─── ⑥ 规则纯度回归：豁免是引擎层政策，规则扫描本身不变 ───

test('W7-1 规则纯度：smell.over-engineering 扫描不查注册表（豁免在引擎层，规则可独立测试）', async () => {
  const rule = DOCTOR_RULES.find(r => r.id === 'smell.over-engineering')!;
  const out = await rule.scan({
    sources: [{ path: 'autonomy/gym.ts', content: bigFile() }],
    chain: { entries: [], chainIntact: true },
    snapshot: null,
    config: {} as any,
    warn: () => {},
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].exempted, undefined, '规则层产出原始 finding —— 降级只发生在引擎层');
});
