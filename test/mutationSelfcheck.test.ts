// test/mutationSelfcheck.test.ts
// ΝΩ-40 变异器回归自检（scripts/mutation_lint.mjs 的护栏自证）。
// 默认跳过 —— 变异器会临时改写 src/ 目标文件，绝不能与并行测试同跑；
// 显式单跑（独占进程）：
//   MUTATION_LINT_SELFCHECK=1 node --test --import ./test/register.mjs test/mutationSelfcheck.test.ts
// 校验点：小预算跑通、进程退出码 0、输出含 RESTORE-OK、目标文件 sha256 前后一致、
// 弱测试临时文件不残留 —— 即「写回-测试-字节级恢复」机制本身不欠债。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const enabled = process.env.MUTATION_LINT_SELFCHECK === '1';

test(
  'mutation_lint：小预算执法跑通 + 字节级还原（需 MUTATION_LINT_SELFCHECK=1 独占显式启用）',
  { skip: enabled ? false : '默认跳过：变异器临时改写 src/，禁止与并行测试同跑（见文件头注释）' },
  () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const targetAbs = path.join(root, 'src', 'dialects', 'hashing.ts');
    const before = createHash('sha256').update(fs.readFileSync(targetAbs)).digest('hex');
    const r = spawnSync(
      process.execPath,
      [
        path.join(root, 'scripts', 'mutation_lint.mjs'),
        '--target', 'src/dialects/hashing.ts',
        '--tests', 'test/autonomy.sceneSemantics.test.ts',
        '--budget', '4',
        '--seed', '7',
      ],
      { cwd: root, encoding: 'utf8', timeout: 300_000 },
    );
    assert.equal(r.status, 0, `变异器非零退出\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
    assert.match(r.stdout, /RESTORE-OK/);
    assert.doesNotMatch(r.stdout, /RESTORE-FAIL/);
    const after = createHash('sha256').update(fs.readFileSync(targetAbs)).digest('hex');
    assert.equal(after, before, '目标文件字节级还原（sha256 前后一致）');
    assert.ok(!fs.existsSync(path.join(root, 'test', '.mutation_lint_weak.tmp.ts')), '弱测试临时文件不残留');
  },
);
