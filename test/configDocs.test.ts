// test/configDocs.test.ts
// ΝΩ-42（配置治理）小测试：docs/config-schema.md 生成器的确定性与覆盖面，
// 以及 Config Schema 树的可遍历性（schemastery 节点 = 可调用函数，携带 type/dict/meta）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Config } from '../src/config';
// 纯 JS 脚本经 scripts/gen_config_docs.d.mts 获得 TS 签名（零依赖本体不动）
import { buildRows, renderMarkdown } from '../scripts/gen_config_docs.mjs';

test('buildRows: 遍历 Config Schema 全量字段（声明序、键唯一）', () => {
  const rows = buildRows(Config);
  assert.ok(rows.length >= 150, `字段数 ${rows.length} 应 ≥150`);
  assert.equal(rows[0]?.key, 'mouseSpeed'); // 声明序保真（首键 = Schema 首字段）
  const keys = rows.map((r) => r.key);
  assert.equal(new Set(keys).size, keys.length, '键不得重复');
  for (const row of rows) {
    assert.match(
      row.type,
      /^(number|string|boolean|any|object|array<|dict<|union|intersect|lazy)/,
      `键 ${row.key} 类型标签异常: ${row.type}`,
    );
  }
});

test('renderMarkdown: 确定性（两次渲染逐字节一致）+ 表格结构 + 管道转义', () => {
  const rows = buildRows(Config);
  const a = renderMarkdown(rows);
  const b = renderMarkdown(buildRows(Config));
  assert.equal(a, b, '同树两次渲染必须幂等');
  assert.match(a, /^# 配置字段总表/);
  assert.match(a, /\| 键 \| 类型 \| 缺省 \| 描述 \|/);
  const lineCount = a.split('\n').length;
  assert.ok(lineCount >= 150, `生成 ${lineCount} 行应 ≥150`);
  // 每个数据行的未转义管道列数 = 5（4 列 + 首尾定界）—— 转义 \| 不计入
  const dataLines = a
    .split('\n')
    .filter((l: string) => l.startsWith('| ') && !l.startsWith('| ---') && l !== '| 键 | 类型 | 缺省 | 描述 |');
  assert.equal(dataLines.length, rows.length);
  for (const line of dataLines) {
    const unescaped = line.replace(/\\\|/g, '');
    assert.equal((unescaped.match(/\|/g) ?? []).length, 5, `行列数异常: ${line.slice(0, 60)}`);
  }
});

// ═══ ΤΕΛ-8（配置面治理收口）：沙箱开关三态 / ε 域单源 / 热键缺省补齐 ═══
// 独占域 src/config.ts 的执法面 —— 与 pan105（域墙）、pan39-42 39c（挂线金丝雀）
// 互补：本节锁「开关语义契约」「单源律」「缺省串收敛」三件事。

type ResolveFn = (input?: Record<string, unknown>) => Record<string, unknown>;
const resolve = (v?: Record<string, unknown>): Record<string, unknown> =>
  (Config as unknown as ResolveFn)(v);
// ΤΕΛ-8b 单源律的对照面（federation 判据）+ ΤΕΛ-8c 收敛判据（装载期生效缺省）
import { PRIVACY_BUDGET_EPSILON_TOTAL, validFederationEpsilon } from '../src/federation/digest.ts';
import { getHotkeyBlacklistCsv } from '../src/system.hotkeyPolicy.ts';

test('ΤΕΛ-8a: enableSandboxStack 三态契约 —— 缺省 undefined 穿透（回退旧门控），显式设置优先，垃圾值 fail-loud', () => {
  // (a) 未设置 ⇒ 键缺席（undefined）：组合根 `?? autonomyEnabled` 回退的契约前提。
  //     schema 侧刻意不设 .default() —— 设了 false 会把「未设=跟随旧门控」静默
  //     折叠成「未设=恒关」，破坏 autonomyEnabled=true 既有部署的兼容律。
  const unset = resolve({});
  assert.equal('enableSandboxStack' in unset, false, '未设置时键必须缺席（三态判别的载体）');
  assert.equal(unset.enableSandboxStack, undefined, 'undefined 穿透（非 false）');
  const node = (Config as unknown as { dict: Record<string, { type?: string; meta?: { default?: unknown } }> })
    .dict.enableSandboxStack;
  assert.equal(node?.type, 'boolean', '布尔开关');
  assert.equal(node?.meta?.default, undefined, 'schema 不得携带缺省（缺省即「未设置」，三态语义立法位）');
  // (b) 显式 true / false 逐字保留（显式设置优先）
  assert.equal(resolve({ enableSandboxStack: true }).enableSandboxStack, true, '显式开');
  assert.equal(resolve({ enableSandboxStack: false }).enableSandboxStack, false, '显式关（即使 autonomyEnabled=true 也不挂线）');
  // (c) 非布尔垃圾 ⇒ 装载期即抛（配置面不撒谎）
  assert.throws(() => resolve({ enableSandboxStack: 'yes' }), /expected boolean/, '字符串垃圾被拒');
  // (d) 文档面同步：无字面缺省渲染为「—」——ΤΕΛ-8a 顺带修正生成器 metaOf 的
  //     `?? node?.default` 兜底（schemastery 方法函数泄漏进单元格的病灶）。
  const row = buildRows(Config).find((r) => r.key === 'enableSandboxStack');
  assert.ok(row, '文档行在场');
  assert.equal(row.default, undefined, '文档行缺省列 = 无字面缺省（undefined，非方法函数泄漏）');
  assert.ok(renderMarkdown([row]).includes('| enableSandboxStack | boolean | — |'), '渲染为「—」');
});

test('ΤΕΛ-8b: federationEpsilon 域单源 —— schema 上界 = federation 的 PRIVACY_BUDGET_EPSILON_TOTAL（防两处立法漂移）', () => {
  const node = (Config as unknown as { dict: Record<string, { type?: string; meta?: { min?: number; max?: number; default?: number } }> })
    .dict.federationEpsilon;
  assert.equal(node?.type, 'number', '数值字段');
  assert.equal(node?.meta?.max, PRIVACY_BUDGET_EPSILON_TOTAL, '上界单源对接（D-G25①：与 ΠΑΝ-70 fail-closed 判据共用同一常量）');
  // 域自洽：schema 闭域 [0.001, cap] 整体落在 validFederationEpsilon 开域 (0, cap] 内
  assert.equal(validFederationEpsilon(node?.meta?.min), true, '下界近似值必须在 federation 合法域内');
  assert.equal(validFederationEpsilon(node?.meta?.max), true, '上界（含）合法');
  assert.equal(validFederationEpsilon(node?.meta?.default), true, '缺省 1 合法');
  // 装载期执法：域外值 fail-loud（前置校验；federation 侧 ΠΑΝ-70 照旧 fail-closed）
  assert.throws(() => resolve({ federationEpsilon: PRIVACY_BUDGET_EPSILON_TOTAL + 1 }), /expected number/, '超总预算被拒');
  assert.throws(() => resolve({ federationEpsilon: 0 }), /expected number/, 'ε=0 被拒（开区间下界）');
  assert.equal(resolve({ federationEpsilon: PRIVACY_BUDGET_EPSILON_TOTAL }).federationEpsilon, PRIVACY_BUDGET_EPSILON_TOTAL, '上界（含）放行');
});

test('ΤΕΛ-8c: hotkeyBlacklist 缺省串收敛 —— ctrl+shift+esc / alt+space 入册（D-G30），与装载期补全幂等合流', () => {
  const d = resolve({});
  assert.ok(typeof d.hotkeyBlacklist === 'string' && d.hotkeyBlacklist.includes('ctrl+shift+esc'), '任务管理器和弦入缺省');
  assert.ok(d.hotkeyBlacklist.includes('alt+space'), '窗口系统菜单和弦入缺省');
  // 与 system.hotkeyPolicy 的降级镜像逐字节一致 ⇒ 装载期补全 withPan10DefaultAdditions
  // 对缺省路径自动变 no-op（两条初始路径收敛同一生效缺省，D-G30 的收敛判据）
  assert.equal(getHotkeyBlacklistCsv(), d.hotkeyBlacklist, 'schema 缺省 = 装载期生效缺省（补全已 no-op）');
});
