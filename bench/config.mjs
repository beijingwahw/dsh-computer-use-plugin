// bench/config.mjs — ΑΩ-R30: bench 基础设施环境硬编码配置化
//
// 此前 battery.mjs/dsh-drive.mjs/suite-*.json 内嵌 D:\dsh3\test-runs\playground、
// 127.0.0.1:3080、固定模型名 glm-4.5v;sync-and-restart.sh 的 SRC 写死 /d/dsh3/... —— 换机即失效。
// 现在机器相关值全部集中到本文件:环境变量优先(前缀统一 DSH_BENCH_),当前部署值作缺省。
//
// 可用环境变量(均可在跑 battery/dsh-drive 前 export 覆盖,一行代码不用改):
//   DSH_BENCH_ENDPOINT    DSH 服务 HTTP 端点        缺省 http://127.0.0.1:3080
//   DSH_BENCH_PROVIDER    模型 provider             缺省 zai-coding-cn
//   DSH_BENCH_MODEL       模型名                    缺省 glm-4.5v
//   DSH_BENCH_TEST_RUNS   测试根目录(派生缺省源)   缺省 D:\dsh3\test-runs
//   DSH_BENCH_PLAYGROUND  桌面任务操场目录          缺省 <TEST_RUNS>\playground
//   DSH_BENCH_RESULTS     旧版 battery 输出目录     缺省 <TEST_RUNS>/results
//
// 说明:
//   - path 类值统一归一为 Windows 反斜杠形态,与 suite prompt 里的路径风格一致;
//   - suite-*.json 保持纯场景定义不改动:文件里内嵌的缺省字面量(见
//     SUITE_LITERAL_SUBSTITUTIONS)在 battery 装载时深替换为配置值,机器相关值外提;
//   - sync-and-restart.sh 的 SRC/INSTS/DSH_ROOT 等同名前缀变量见该脚本头注释。

// 当前部署的测试根目录(缺省)。换机时 export DSH_BENCH_TEST_RUNS=C:\x\test-runs 即整体迁移,
// playground/results 未显式覆盖时会随之派生。
const DEFAULT_TEST_RUNS = 'D:\\dsh3\\test-runs';

// 统一为反斜杠形态(suite 字面量替换要保持与原 prompt 一致的 Windows 路径风格)
const normWin = (p) => p.replace(/\//g, '\\');

const endpoint = (process.env.DSH_BENCH_ENDPOINT ?? 'http://127.0.0.1:3080').replace(/\/+$/, '');
const testRuns = normWin(process.env.DSH_BENCH_TEST_RUNS ?? DEFAULT_TEST_RUNS);
const playground = normWin(process.env.DSH_BENCH_PLAYGROUND ?? `${testRuns}\\playground`);
const resultsDir = process.env.DSH_BENCH_RESULTS ?? `${testRuns}/results`; // node fs 在 Windows 两种分隔符均接受

export const config = {
  endpoint,                                          // DSH 服务端点(无尾斜杠)
  apiBase: `${endpoint}/api/`,                       // battery/dsh-drive 的 RPC 前缀
  provider: process.env.DSH_BENCH_PROVIDER ?? 'zai-coding-cn',
  model: process.env.DSH_BENCH_MODEL ?? 'glm-4.5v',
  testRuns,                                          // 测试根目录(反斜杠形态)
  playground,                                        // 桌面任务操场目录
  resultsDir,                                        // 旧版 battery-final/partial 输出目录
  // battery 传给 session.selectModel 的载荷形状与旧硬编码 {provider, model} 保持一致
  modelSelector: {
    provider: process.env.DSH_BENCH_PROVIDER ?? 'zai-coding-cn',
    model: process.env.DSH_BENCH_MODEL ?? 'glm-4.5v',
  },
};

// ΑΩ-R30: suite 内嵌机器字面量 → 配置值。以「当前部署缺省值」为令牌做整串替换:
// 长字面量(playground)必须排在前面,否则会被 test-runs 根前缀先截胡替换成错误嵌套。
const SUITE_LITERAL_SUBSTITUTIONS = [
  [`${DEFAULT_TEST_RUNS}\\playground`, playground],
  [DEFAULT_TEST_RUNS, testRuns],
];

/** 深遍历任务对象,把内嵌的缺省机器字面量替换为当前配置值(字符串/数组/对象递归) */
export function applySuiteSubstitutions(value) {
  if (typeof value === 'string') {
    let s = value;
    for (const [lit, rep] of SUITE_LITERAL_SUBSTITUTIONS) {
      if (s.includes(lit)) s = s.split(lit).join(rep);
    }
    return s;
  }
  if (Array.isArray(value)) return value.map(applySuiteSubstitutions);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, applySuiteSubstitutions(v)]));
  }
  return value;
}

/** 配置摘要(一行),供 battery 启动横幅/--list 打印,便于核对覆盖是否生效 */
export function configSummary() {
  return `endpoint=${config.endpoint} model=${config.modelSelector.provider}/${config.modelSelector.model} playground=${config.playground} results=${config.resultsDir}`;
}
