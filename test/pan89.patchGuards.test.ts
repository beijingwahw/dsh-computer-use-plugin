// test/pan89.patchGuards.test.ts
// ΠΑΝ-89（C2-6/M-5）：一次性纪元 patcher（scripts/_patch_*.py）的守卫回归——
// 它们是只对历史有效的可执行文物，却保持着可执行的伤害能力（__pycache__ 实证
// 曾被误当模块导入 ⇒ 模块级全量改写）。三重守卫执法：
//   ① import 零副作用（旧版 import 即崩在锚点断言/直接改盘——能被 import 本身就是证明）；
//   ② dry-run 缺省：无 --write 只打印计划不落盘；--write 才执行；
//   ③ 立法在源：`if __name__ == '__main__'` 守卫 + __file__ 定根（DSH_PATCH_ROOT 沙箱缝）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PATCHERS = ['_patch_L.py', '_patch_M.py', '_patch_k4to8.py'] as const;

test('ΠΑΝ-89 ① import 零副作用：三 patcher 可被 import 而不执行任何改写', () => {
  // 旧版在此就会执行模块级 patch() —— 锚点早已不在 ⇒ AssertionError；即便在，
  // 也会改写真实 src/。能成功 import 且源文件不动 = 守卫在位的直接证明。
  const probe = `
import importlib.util, sys
spec = importlib.util.spec_from_file_location(sys.argv[1], sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
assert hasattr(mod, 'run') and hasattr(mod, 'main'), 'run/main 结构在位'
print('IMPORT-CLEAN')
`;
  const dir = mkdtempSync(path.join(tmpdir(), 'pan89i-'));
  try {
    const py = path.join(dir, 'probe.py');
    writeFileSync(py, probe, 'utf8');
    for (const p of PATCHERS) {
      const out = execFileSync('python', [py, path.join(root, 'scripts', p)], {
        encoding: 'utf8', timeout: 30_000,
      });
      assert.match(out, /IMPORT-CLEAN/, `${p} import 零副作用`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ΠΑΝ-89 ②③ dry-run 缺省不落盘 / --write 落盘 / 立法在源（沙箱 DSH_PATCH_ROOT）', () => {
  // 立法在源：守卫 + dry-run 门 + 沙箱根
  for (const p of PATCHERS) {
    const src = readFileSync(path.join(root, 'scripts', p), 'utf8');
    assert.match(src, /if __name__ == '__main__':/, `${p} main 守卫在场`);
    assert.match(src, /DRY = '--write' not in argv/, `${p} dry-run 缺省门在场`);
    assert.match(src, /DSH_PATCH_ROOT/, `${p} 沙箱根缝在场`);
  }
  // 行为面（_patch_L 首锚点 fixture）：dry 只打印计划；--write 真落盘
  const sb = mkdtempSync(path.join(tmpdir(), 'pan89b-'));
  try {
    mkdirSync(path.join(sb, 'types'), { recursive: true });
    const anchor = '    /** 按名查询服务；可选服务不存在时返回 undefined */\n    get<T = any>(name: string): T | undefined;\n';
    const f1 = path.join(sb, 'types', 'dsh-stubs.d.ts');
    const original = `declare module "x" {\n${anchor}}\n`;
    writeFileSync(f1, original, 'utf8');
    const env = { ...process.env, DSH_PATCH_ROOT: sb };
    // dry-run：计划可见、目标文件不动（后续锚点缺席的诚实失败属预期——一次性文物）
    const dry = spawnSync('python', [path.join(root, 'scripts', '_patch_L.py')], {
      encoding: 'utf8', timeout: 30_000, env,
    });
    assert.ok((dry.stdout ?? '').includes('[dry-run] 将写入 types/dsh-stubs.d.ts'), 'dry-run 打印写入计划');
    assert.equal(readFileSync(f1, 'utf8'), original, 'dry-run 绝不落盘（ΠΑΝ-89 核心）');
    assert.match(dry.stdout ?? '', /dry-run 计划模式/);
    // --write：首锚点真实改写
    const wet = spawnSync('python', [path.join(root, 'scripts', '_patch_L.py'), '--write'], {
      encoding: 'utf8', timeout: 30_000, env,
    });
    assert.ok(readFileSync(f1, 'utf8').includes('set?<T>(name: string, instance: T): void;'), '--write 落盘生效');
    assert.notEqual(wet.status, 0, '沙箱缺后续锚点 ⇒ 诚实非零退出（半应用状态可见，非事务——历史文物的已知边界）');
    // --help
    const help = spawnSync('python', [path.join(root, 'scripts', '_patch_L.py'), '--help'], {
      encoding: 'utf8', timeout: 30_000, env,
    });
    assert.equal(help.status, 0);
    assert.match(help.stdout ?? '', /--write/);
  } finally {
    rmSync(sb, { recursive: true, force: true });
  }
});

test('ΠΑΝ-89 真实仓库零接触：dry-run 对正本不产生任何写（无法定位锚点也不落盘）', () => {
  const snapshot = PATCHERS.map((p) => path.join(root, 'scripts', p))
    .concat([path.join(root, 'src', 'diagnosis.ts'), path.join(root, 'src', 'riskGate.ts')])
    .map((f) => `${f}:${readFileSync(f, 'utf8').length}`);
  for (const p of PATCHERS) {
    spawnSync('python', [path.join(root, 'scripts', p)], { encoding: 'utf8', timeout: 30_000 });
  }
  const after = PATCHERS.map((p) => path.join(root, 'scripts', p))
    .concat([path.join(root, 'src', 'diagnosis.ts'), path.join(root, 'src', 'riskGate.ts')])
    .map((f) => `${f}:${existsSync(f) ? readFileSync(f, 'utf8').length : -1}`);
  assert.deepEqual(after, snapshot, 'dry-run 对真实仓库零写入（缺省即安全）');
});
