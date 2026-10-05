# suite-full 实战批跑梯次计划(R2-6)

schema `r26-ladder-plan/1` · 任务 26 个 · 批 3 个 · 名义时长 ≈ 2.5h · 最坏 3.9h(=Σ任务超时+每任务 45s 采集开销+每批 240s 固定流)。

执行纪律:**严格串行**(一套鼠标键盘,drive-desktop pid 锁);编排器不直接跑 GUI——由持 GUI 锁的执行工位调用;每任务一次 drive-desktop 调用(单任务套件),批内保持 suite 序(依赖链)。

## 批1(3 任务 · 难度均值 1.67 · 名义 18min / 最坏 29min)

| # | id | 族 | 难度 | estSteps | 超时 | E2 | 播种前置 |
|---|----|----|------|----------|------|----|----------|
| 1 | full-setup-clean | 窗口管理/清理 | 1 | 6 | 7min | verify | - |
| 2 | full-seed-report | 精确操作(打字/ctrl+s/保存对话框) | 2 | 12 | 8min | verify | full-setup-clean |
| 3 | full-hotkey-undo-save | 热键(安全键 ctrl+z/ctrl+end/ctrl+s) | 2 | 10 | 8min | verify | full-seed-report |

- **门槛**:≥ 2/3 pass 才进下一批 —— 冒烟批 <2/3 ⇒ 链路/环境未就绪,继续烧真机预算无意义
- **族构成**:`窗口管理/清理` · `精确操作(打字/ctrl+s/保存对话框)` · `热键(安全键 ctrl+z/ctrl+end/ctrl+s)`
- **时长口径**:Σ任务超时=23min;nominal=min(超时, estSteps×25s) 之和+开销(启发式预估,不进门槛)。

## 批2(9 任务 · 难度均值 2.33 · 名义 52min / 最坏 80min)

| # | id | 族 | 难度 | estSteps | 超时 | E2 | 播种前置 |
|---|----|----|------|----------|------|----|----------|
| 1 | full-seed-extras | 精确操作(多窗口播种+关窗纪律) | 2 | 18 | 9min | verify | full-seed-report |
| 2 | full-ocr-locate | 视觉感知(OCR 找字/读区) | 2 | 6 | 6min | verify | full-seed-report |
| 3 | full-zoom-tray | 视觉感知(缩放检查) | 2 | 6 | 6min | absent | full-seed-report |
| 4 | full-probe-interactivity | 视觉感知(交互性探针) | 1 | 5 | 5min | absent | full-seed-report |
| 5 | full-edit-precision | 精确操作(行级编辑) | 3 | 12 | 8min | verify | full-hotkey-undo-save |
| 6 | full-scroll-deep | 滚动翻页(闭环滚动) | 3 | 14 | 9min | verify | full-edit-precision |
| 7 | full-form-html-author | 文件创作(HTML 表单播种) | 3 | 12 | 9min | verify | full-scroll-deep |
| 8 | full-edge-open-form | 浏览器(本地表单:复选框/输入框/按钮) | 3 | 16 | 9min | verify | full-form-html-author |
| 9 | full-open-url-nav | 浏览器(open_url 导航+页面断言+标签切换) | 2 | 10 | 8min | verify | full-edge-open-form |

- **门槛**:≥ 6/9 pass 才进下一批 —— 2/3 同率;批3 全是 d4 高危族(审批/宏/自主/编排),放行前要多数证据
- **族构成**:`精确操作(多窗口播种+关窗纪律)` · `视觉感知(OCR 找字/读区)` · `视觉感知(缩放检查)` · `视觉感知(交互性探针)` · `精确操作(行级编辑)` · `滚动翻页(闭环滚动)` · `文件创作(HTML 表单播种)` · `浏览器(本地表单:复选框/输入框/按钮)` · `浏览器(open_url 导航+页面断言+标签切换)`
- **时长口径**:Σ任务超时=69min;nominal=min(超时, estSteps×25s) 之和+开销(启发式预估,不进门槛)。

## 批3(14 任务 · 难度均值 2.79 · 名义 77min / 最坏 2.0h)

| # | id | 族 | 难度 | estSteps | 超时 | E2 | 播种前置 |
|---|----|----|------|----------|------|----|----------|
| 1 | full-ask-screen | 视觉感知(云脑问答 ask_screen) | 2 | 4 | 5min | absent | full-edge-open-form |
| 2 | full-drag-file-move | 拖拽(文件搬迁,磁盘可证) | 3 | 12 | 9min | verify | full-seed-extras,full-open-url-nav |
| 3 | full-triple-window-switch | 窗口管理(三窗切换+focus 取证) | 3 | 10 | 8min | verify | full-open-url-nav |
| 4 | full-calc-element | 精确操作(元素 ID 寻址点击) | 3 | 14 | 9min | verify | full-triple-window-switch |
| 5 | full-diff-action-locate | diff/what_if 观测面(diff_view) | 2 | 7 | 7min | absent | full-calc-element |
| 6 | full-memory-landmark | 记忆(remember_ui/recall_ui) | 2 | 6 | 6min | absent | full-calc-element |
| 7 | full-approval-delete-file | 审批流(危险词触发,操场内可恢复) | 4 | 14 | 9min | verify | full-drag-file-move |
| 8 | full-macro-record-replay | 宏(录制+replay_actions 重放) | 4 | 16 | 9min | verify | - |
| 9 | full-skill-lifecycle | 记忆(技能库 save/match/run) | 3 | 12 | 9min | verify | full-macro-record-replay |
| 10 | full-autonomous-goal | 自主环(autonomous_run 简单目标) | 4 | 20 | 8min | verify | full-skill-lifecycle |
| 11 | full-orchestration-file | 多步组合(start_complex_task 编排) | 4 | 18 | 9min | verify | full-autonomous-goal |
| 12 | full-cognition-whatif | diff/what_if 观测面(反事实+群体智慧) | 2 | 4 | 6min | absent | full-drag-file-move |
| 13 | full-observability-panel | 观测面板(get_metrics/metrics_dashboard/self_diagnose) | 2 | 6 | 6min | absent | full-cognition-whatif |
| 14 | full-final-cleanup | 窗口管理(终局清理) | 1 | 8 | 8min | verify | - |

- **门槛**:无(终批只出报告) —— 终批无下游,门槛无拦截对象;失败全部进 analyze 工单
- **族构成**:`视觉感知(云脑问答 ask_screen)` · `拖拽(文件搬迁,磁盘可证)` · `窗口管理(三窗切换+focus 取证)` · `精确操作(元素 ID 寻址点击)` · `diff/what_if 观测面(diff_view)` · `记忆(remember_ui/recall_ui)` · `审批流(危险词触发,操场内可恢复)` · `宏(录制+replay_actions 重放)` · `记忆(技能库 save/match/run)` · `自主环(autonomous_run 简单目标)` · `多步组合(start_complex_task 编排)` · `diff/what_if 观测面(反事实+群体智慧)` · `观测面板(get_metrics/metrics_dashboard/self_diagnose)` · `窗口管理(终局清理)`
- **时长口径**:Σ任务超时=1.8h;nominal=min(超时, estSteps×25s) 之和+开销(启发式预估,不进门槛)。

## 批划分理由

1. **依赖链全序(R1-3 §2)**:批划分 = suite 序的保持性切分。跨批前置(如批2 的 full-edit-precision 吃批1 热键任务的落盘产物)由编排器播种检查按 checkpoint 终态核放行。
2. **风险递增**:批1 冒烟钉「清场→播种→保存链+热键撤销」——R1-8 九次失败的正是保存链(无 ctrl+s 白名单须走菜单),链路不通时 3 任务内止损;批2 加精确编辑/滚动/表单制作/浏览器 DOM(窗口/浏览器族聚合,共享 Edge/explorer 场);批3 集中全部 d4 高危族(审批真实删除、宏重放、自主环、编排)+三窗马拉松+终局清理。难度均值 1.67 → 2.33 → 2.79 单调递增。
3. **任务书"难度1×2+1热键"的落地修正**:两个 d1 任务(clean/probe)中 probe 依赖 T2 播种的记事本 GUI 态(不可 fs 代播),故冒烟批取 {clean(d1), seed-report(d2,硬前置), hotkey-undo-save(热键)}——依赖链上唯一合法的 3 任务含热键组合;probe 归批2。
4. **审批类单独批**:full-approval-delete-file(真实删除,回收站可恢复)落在批3——两道门槛之后才放行危险词链路;宏/自主/编排同为 d4 一并后置。

## 通过门槛与放行规则

| 批 | 门槛 | 未过后果 |
|----|------|----------|
| 批1 | ≥2/3 | 编排器停止,状态 gate-failed,待人工(--retry-failed 重评或放弃) |
| 批2 | ≥6/9 | 编排器停止,状态 gate-failed,待人工(--retry-failed 重评或放弃) |
| 批3 | - | 终批:失败全部进 analyze 工单 |

计数口径:批内调度任务的 last-attempt 终态;unknown/blocked 计为未过;harnessError/stopfile/健康巡检异常 ⇒ 批级 stopped/infra-stopped/health-stopped(不判门槛,处置后续跑)。

## 回滚预案

1. **任意时刻急停**:`touch <root>/suite-full/STOP`(drive 与编排器同一 stopfile;启动闸拒绝复跑直至人工删除);失控时 R1-6 `emergency-stop.mjs`(须 `DSH_BENCH_ENDPOINT=http://127.0.0.1:19387`),现场恢复 `recover-scene.ps1`。
2. **批内断点续跑**:中断后 `run --batch N` 自动只跑 pending 任务(checkpoint 逐任务持久);drive 侧 resume-state 僵尸会话由其 --resume 语义认领(编排器逐任务调用天然携带)。
3. **门槛未过回滚**:`run --batch N --retry-failed` 只重跑 fail/unknown/blocked(失败任务从 drive resume-state 摘除后真机重跑),完成后重评门槛;播种 blocked 的任务在前置转 pass 后自动解除。
4. **整役重置(最后手段)**:停机后清 `<root>/suite-full/`(证据先归档)+ playground 产物(full-report.md/drag-me.txt/trash-me.txt/form.html/full-drag-dst/calc-elem.txt/macro-proof.txt/auto-goal.txt/orch-proof.txt)→ 从批1 重播。操场外零残留(R1-3 圈禁纪律)。
5. **基线回滚**:analyze-run 首轮自动固化 `bench/baselines/suite-full.analysis.json`;批间对比污染时 `--refresh-baseline`(旧档自动归档 archive/)。

## 运行手册(执行工位)

```bash
export PATH="/c/Program Files/nodejs:$PATH"
export DSH_BENCH_TEST_RUNS='C:\dsh3\test-runs'   # R1-2:不 export 则缺省 D: 盘,真跑 mkdir 处 fail-fast
export DSH_DESKTOP_TOKEN=<本次宿主启动日志 token> # 或 --token 传参
node bench/batch-orchestrator.mjs plan                     # 梯次计划 JSON(确定性)
node bench/batch-orchestrator.mjs run --batch 1            # 冒烟(3 任务;前置健康巡检)
node bench/batch-orchestrator.mjs status                   # 断点状态/下一步动作
node bench/batch-orchestrator.mjs run --batch 2            # 门槛过后放行
node bench/batch-orchestrator.mjs run --batch 3            # 终批
```

每批收口自动:enrich-evidence → analyze-run(该批分析/工单/基线对比)→ 下一批开跑前健康巡检(RPC 活性/python 8421-8428/磁盘 ≥5GB,异常即写 STOP 停机)。
