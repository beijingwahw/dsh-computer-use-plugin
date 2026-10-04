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
