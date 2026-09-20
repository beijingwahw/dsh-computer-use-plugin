// src/physicalExecution/pythonBin.ts
// Python 可执行文件解析：统一 Windows / Unix 差异。
//
// 背景：硬编码 `python3` 在 Windows 上命中的是 Microsoft Store 的别名占位符
// （WindowsApps\python3.exe），非交互场景直接以 9009 退出 —— 真实解释器叫 `python`。
// 解析顺序：
//   1. DSH_PYTHON 环境变量（显式指定，最高优先级）
//   2. Windows → `python`；其余平台 → `python3`
export function resolvePythonBin(): string {
  const fromEnv = process.env.DSH_PYTHON?.trim();
  if (fromEnv) return fromEnv;
  return process.platform === 'win32' ? 'python' : 'python3';
}
