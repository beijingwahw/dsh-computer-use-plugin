# bench — 真机验证工作台

在本地 DeepSeek Harness (DSH) 上执行大规模真实任务的电池测试工具链与产物。
每个 suite 是一组真实 GUI 任务（记事本/计算器/画图/资源管理器/Edge 真实开关、
输入、保存、导航），通过 DSH 的 HTTP RPC（默认 `127.0.0.1:3080/api/*`）逐任务
建会话下发，抓取工具轨迹，按 `expect` 正则判定通过。

## 文件

| 文件 | 说明 |
| --- | --- |
| `battery.mjs` | 任务矩阵执行器：`node battery.mjs <suite.json>`，结果写 `results/battery-{partial,final}.json` |
| `dsh-drive.mjs` | 单会话驱动器（new/send/wait/hist/cancel），交互排障用 |
| `suite-1/2/3.json` | Epoch X 及之前的套件（感知/运动/守卫/记忆/OCR/技能首轮） |
| `suite-4.json` | Epoch Y 主电池：26 个真实任务 × 15 类（本轮九处修复的来源） |
| `suite-4b.json` | 修复后复跑（含任务栏边缘点击回归 —— 区域 clamp 修复的首个真机验证） |
| `suite-4c.json` | 终验：切窗取证（focus_handoff）+ 技能切片 + 未命中反馈，4/4 通过 |
| `sync-and-restart.sh` | 构建产物 → DSH 双路径（store 物化源 + profile 加载点）同步 + 重启 + 指纹校验 |
| `battery-suite4*.log` | 三轮电池的逐任务判定日志（PASS/FAIL + 工具轨迹摘要） |
| `journal*.jsonl` | 插件行动日志（动作/效果/场景指纹）—— 真机战果的原始证据 |
| `results/` | 电池判定 JSON（注意：battery-final.json 会被最后一轮覆盖，全量证据以 log 为准） |

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
