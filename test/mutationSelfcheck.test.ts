// test/mutationSelfcheck.test.ts
// ΝΩ-40 变异器回归自检（scripts/mutation_lint.mjs 的护栏自证）。
// ΠΑΝ-87（C2-6/M-1）：自检默认化——--selfcheck-weak 全程只读写一次性沙箱探针
// （src/.mutation_lint_probe.tmp.ts + 弱测试临时文件，跑完即删 + 清理校验），
// 绝不改真实源码 ⇒ 不再需要 MUTATION_LINT_SELFCHECK=1 独占显式环境变量
// （旧门槛 = 自检本身无执法的治理缺口）。校验点：进程退出 0、弱测试得低分
// （只断言导出的测试近乎全盲）、算子登记册在报告可见、等价变异豁免按类列示
// （显式理由、不计分母）、沙箱探针与弱测试零残留。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROBE = path.join(root, 'src', '.mutation_lint_probe.tmp.ts');
const WEAK = path.join(root, 'test', '.mutation_lint_weak.tmp.ts');

test('ΠΑΝ-87 mutation_lint 自检默认化：沙箱探针跑通 + 弱测试低分 + 豁免登记可见 + 零残留（无需环境变量）', { timeout: 240_000 }, () => {
  assert.ok(!fs.existsSync(PROBE), '探针不预存在（一次性语义）');
  const r = spawnSync(
    process.execPath,
    [
      path.join(root, 'scripts', 'mutation_lint.mjs'),
      '--selfcheck-weak',
      '--budget', '8',
      '--seed', '42',
    ],
    { cwd: root, encoding: 'utf8', timeout: 220_000 },
  );
  assert.equal(r.status, 0, `自检非零退出\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  // 弱测试近乎全盲 ⇒ 低分（自检语义核心：弱测试应得低分）
  assert.match(r.stdout, /自检判定：弱测试分数 [0-9.]+%（期望 ≤ 40 —— 只断言导出的测试应近乎全盲） ✓/);
  // ΠΑΝ-87 治理面：算子登记册 + 豁免登记（显式理由）在报告可见
  assert.match(r.stdout, /变异算子登记册 8 算子：/);
  assert.match(r.stdout, /豁免 \[const-data\] ×\d+ —— /, 'const-data 豁免按类列示（显式理由，不计分母）');
  assert.match(r.stdout, /豁免 \[timing-const\] ×\d+ —— /);
  assert.match(r.stdout, /豁免 \[log-stmt\] ×\d+ —— /);
  assert.match(r.stdout, /治理面：不在 package\.json。接线建议/, 'CLI 接线建议写明（不代改 package.json）');
  // 沙箱清理：一次性探针与弱测试零残留
  assert.match(r.stdout, /沙箱探针清理：REMOVED（一次性探针已删）/);
  assert.ok(!fs.existsSync(PROBE), '探针不残留');
  assert.ok(!fs.existsSync(WEAK), '弱测试临时文件不残留');
});

test('ΠΑΝ-87 dry-run 面：豁免位在 dry-run 列示（等价变异豁免可见性）', { timeout: 60_000 }, () => {
  const r = spawnSync(
    process.execPath,
    [path.join(root, 'scripts', 'mutation_lint.mjs'), '--selfcheck-weak', '--dry-run', '--seed', '7'],
    { cwd: root, encoding: 'utf8', timeout: 50_000 },
  );
  assert.equal(r.status, 0, `dry-run 非零退出\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /候选变异体 \d+ 个 = 计分 \d+ \+ 等价豁免 \d+/);
  assert.match(r.stdout, /等价变异豁免 \d+ 处（不计分母；逐类理由）/);
  assert.match(r.stdout, /--dry-run：未写盘、未跑测试。/);
  assert.ok(!fs.existsSync(PROBE), 'dry-run 后探针同样清理');
});
