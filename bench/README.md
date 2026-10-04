# bench — 真机验证工作台

在本地 DeepSeek Harness (DSH) 上执行大规模真实任务的电池测试工具链与产物。
每个 suite 是一组真实 GUI 任务（记事本/计算器/画图/资源管理器/Edge 真实开关、
输入、保存、导航），通过 DSH 的 HTTP RPC（默认 `127.0.0.1:3080/api/*`）逐任务
建会话下发，抓取工具轨迹，按 `expect` 正则判定通过。

## 文件

| 文件 | 说明 |
| --- | --- |
| `battery.mjs` | 任务矩阵执行器：`node battery.mjs <suite.json>`，结果写 `results/battery-{partial,final}.json`；W2-3 起内建 E2 独立核查 + E3 SPRT 回归门 |
| `dsh-drive.mjs` | 单会话驱动器（new/send/wait/hist/cancel），交互排障用 |
| `suite-1/2/3.json` | Epoch X 及之前的套件（感知/运动/守卫/记忆/OCR/技能首轮） |
| `suite-4.json` | Epoch Y 主电池：26 个真实任务 × 15 类（本轮九处修复的来源） |
| `suite-4b.json` | 修复后复跑（含任务栏边缘点击回归 —— 区域 clamp 修复的首个真机验证） |
| `suite-4c.json` | 终验：切窗取证（focus_handoff）+ 技能切片 + 未命中反馈，4/4 通过 |
| `suite-w2.json` | W2-3 示范套件：任务带 `verify` 块（文件哈希/进程/窗口/注册表谓词） |
| `verifyCore.mjs` | W2-3 E2 契约核查器核心：谓词 DSL + 可注入观察 world + 证据落盘 + doctor 规则候选草稿 |
| `sprtCore.mjs` | W2-3 E3 统计核心：Wald SPRT（伯努利通过率）+ Wilson CI + 两比例 z 检验 + McNemar 精确；ΝΩ-39 起+ normalInv（Acklam 分位）/ mder（双比例最小可检差异）/ Beta 共轭后验（logGamma + 正则化不完全 Beta，全手写零依赖） |
| `verify.selftest.mjs` | W2-3 离线自检：`node bench/verify.selftest.mjs`，200 断言全过 exit 0（无网络/无 DSH；含 ΝΩ-39 的 MDER/Beta/覆写/n<20/glob 断言） |
| `sync-and-restart.sh` | 构建产物 → DSH 双路径（store 物化源 + profile 加载点）同步 + 重启 + 指纹校验 |
| `battery-suite4*.log` | 三轮电池的逐任务判定日志（PASS/FAIL + 工具轨迹摘要） |
| `journal*.jsonl` | 插件行动日志（动作/效果/场景指纹）—— 真机战果的原始证据 |
| `results/` | 电池判定 JSON（注意：battery-final.json 会被最后一轮覆盖，全量证据以 log 为准） |
| `reports/` | W2-3 电池报告根：每轮 `<runId>/report.json` + `evidence/`（逐谓词原始观察）+ `screenshots/` + `doctor-rule-candidates/` |

## W2-3：bench 可信度包（E2 契约核查 + E3 SPRT 回归门）

**E2 独立契约核查器** —— 旧 `expect` 正则只看 agent 自己的工具轨迹（自报通道）。
任务现可声明 `verify` 块，会话结束后由**独立通道**（直查文件系统 / tasklist /
注册表 / 窗口枚举 / 截图，不经 agent、不信自报）终判；终判 = 轨迹 ∧ 核查。
谓词登记表（未登记 kind 拒绝，resultContract 同律）：`fileExists`（contains /
containsRegex / sha256 / min·maxBytes）、`fileAbsent`、`dirExists`、`processRunning` /
`processAbsent`（name|names）、`windowExists` / `windowAbsent`（titleRegex）、
`registryKey`（exists=false 断言缺席）、`registryValue`（equals/contains）、`envVar`、
组合子 `not` / `allOf` / `anyOf` 与块级 `mode: all|any`。路径支持 `%VAR%` 展开。
「查了但不成立」（fail）与「核查通道坏了」（error）严格分离 —— 通道坏则整体不放行。
中文 Windows 控制台输出按 OEM/GBK 还原（`reg` 的「键不存在」是合法观察而非通道错误）。
证据落盘 `bench/reports/<runId>/`：逐谓词原始观察 txt + verify.json + 截图引用；
核查失败的任务自动产出 doctor 规则候选草稿（`needs-human-distillation`，不自动入库）。

**E3 方差感知 SPRT 回归门** —— FAIL 触发复跑（上限 5 次），Wald SPRT 序贯收口三态：
`deterministic-pass`（零失败观测）/ `flaky`（p̂ + Wilson 95% CI；分 high-rate 与
indifference-zone 两味）/ `deterministic-fail`（SPRT 接受 H0: p≤0.30）。α=β=0.05、
H1: p≥0.80 为模块常量；边界公式与 `src/popupDetector.ts` 的 SprtPopupFilter 同式
（A=ln((1−β)/α)、B=ln(β/(1−α))；popupDetector 的证据模型是弹窗传感帧而非伯努利
通过率，且 bench 是纯 .mjs 不能加载 src/*.ts，故按任务指示实现等价小 SPRT）。
`--compare <prev-report.json>` 输出跨版本通过率比例差检验（两比例合并 z 检验 p 值，
配对任务集另附 McNemar 精确检验）。

## ΝΩ-39：基准统计功效（跑之前先知道自己看不见什么）

**MDER 功效前置** —— `sprtCore.mjs` 的 `mder(n1, n2, α=0.05, power=0.8)`：双比例
最小可检差异（正态近似闭式，方差取最保守 p(1−p)=1/4，结果夹 [0,1]）。battery 在
suite 装载 / `--list` / `--compare` 时打印「本 suite 尺寸 MDER=x.xx」：装载时按
同尺寸对照（`mder(n,n)`），`--compare` 按实际两侧 n 重算。锚点值：26 vs 26 ⇒
0.3885，26 vs 4 ⇒ 0.7523，100 vs 100 ⇒ 0.1981，n=3 vs 2 ⇒ 夹上限 1（只有
全过/全表的差异可见）。任一侧 n<20（`MDER_MIN_N`）时 `--compare` 拒判
verdictHint：样本不足，仅记录不判定 —— 不把功效不足当「无差异」的证据。

**flaky 态 Beta 后验一行** —— 收口为 flaky 时附 `P(p>0.8|data)`：均匀先验
Beta(1,1) ⇒ 后验 Beta(过+1, 败+1) 的上尾（`betaTailProb`，手写 logGamma +
正则化不完全 Beta 连分式）。锚点：1 败 5 过 ⇒ Beta(6,2) 上尾 0.4233。
deterministic-pass/fail 不附（零失败/比例塌缩时后验无信息量）。

**suite 覆写 SPRT 假设域** —— suite json 支持新格式（数组旧格式不受影响）：

```json
{ "sprt": { "p0": 0.60, "p1": 0.90 }, "tasks": [ ... ] }
```

缺省保持 0.30/0.80。**建议值 0.60/0.90**（对高通过率电池更严苛的域）：H0 从
p≤0.30 提到 p≤0.60 —— 中低通过率（0.3–0.6）的任务更快收口到 deterministic-fail
而不是在无差别区烧尽复跑预算（真实率 0.5 时向 H0 的期望漂移约快 3.6 倍）；代价是
把 0.6–0.7 通过率的边缘任务也推向 fail 侧，且 H1 侧收敛变慢（单过步长
ln(0.9/0.6)≈0.405 vs ln(0.8/0.3)≈0.981）。按电池健康度选择，无普适最优。
未登记键拒绝（resultContract 同律），非法域跑前 fail-fast。

**Wilson CI 接入计数类指标** —— `--compare` 输出两侧通过率的 Wilson 95% CI；
`scripts/bench_gate.mjs` 的基线与现跑摘要附通过率 Wilson 95% CI（小样本不塌缩）。

**bench_gate glob 白名单扩容 + 计数硬门** —— `BENCH_WHITELIST` 从 `test/w5*.bench.ts`
扩为全部确定性离线基准（+ablation / calibration / jointCalibration /
paramAblation / organAblation / fovea.ab）。排除并注释：真机类
`realMachine*` / `largeScale*`（Linux Xvfb+xdotool 或 D-5 物理服务 tcp :8421，
非确定性）；`autonomy.closedloop`（确定性但当前 B3 红，基线必须全绿）；
jointCalibration 的「真机复测」子测经 `--test-skip-pattern 真机复测` 整体剔除
（其自跳过在 TAP 记 SKIP ⇒ 按未通过计，会卡死 `--update`）。确定性计数类指标
±15% 从告警升**硬门**（缺省；`DSH_BENCH_GATE_COUNT_HARD=0` 恢复旧告警口径）；
时间类 duration 恒仅告警。纯函数 `compareBenchmarks` 缺省保持历史口径
（`test/w7gate.test.ts` 门h 锁定），升硬经 CLI 策略层接线，零回归。

```bash
# 带核查与回归门的一轮电池
node bench/battery.mjs bench/suite-w2.json --compare bench/reports/<旧runId>/report.json

# 离线自检（可信度包自身的测试证据）
node bench/verify.selftest.mjs

# 性能回归门（ΝΩ-39 扩容后白名单，含 jointCalibration 约 4–5 分钟）
node scripts/bench_gate.mjs --check
```

## 轮次结果

| 轮次 | 任务数 | 结果 | 挖出的缺陷 |
| --- | --- | --- | --- |
| suite-4 | 26 | 23 PASS / 3 FAIL | 区域裁剪越界误杀边缘动作、fail-safe 误触发、切窗大小写/别名/降级链、focus_handoff 取证缺席、技能切片过宽、技能回放过匹配、OCR 小图乱码 |
| suite-4b | 6 | 4 PASS / 2 FAIL* | *两项均因当时修复未部署到实际加载路径（profile 副本），非代码问题 |
| suite-4c | 4 | 4 PASS / 0 FAIL | —— |

## 使用

```bash
# 1. 构建 + 同步到本机 DSH 并重启（先改脚本顶部的路径）
npm run build && bash bench/sync-and-restart.sh

# 2. 跑一轮电池（每个任务独立会话，真实操作桌面）
node bench/battery.mjs bench/suite-4.json
```

注意：suite 会真实操作运行机器的桌面（开关应用、输入、保存文件到
`D:\dsh3\test-runs\playground`）。仅在可以承受这些副作用的机器上执行。
