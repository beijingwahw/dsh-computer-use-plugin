# Epoch O — 28 项清账战役报告

日期：2026-09-20 · 执法册：`test/epochO.test.ts`（20 项 O-#n 测试）· 战役范围：七轮战役后全量待完善清单

## 总账

| 批次 | 项 | 状态 |
| --- | --- | --- |
| 立刻可做 | #3 sharp 装机（7 skip → 全绿/余 4 属物理服务）· #6 vision 服务自荐 · #28 README 刷新 · #10 confusables 全表 · #22 混合逻辑时钟 | ✅ 全绿 |
| 短平快 | #17 set_contrast 真机往返 · #21 restore 三重校验 · #26 首轮串行选项 · #19 核验（N-1）· #27 双边 CUSUM · #11 PID 白名单助手+本机值 | ✅ 全绿 |
| 纯算法 | #12 GPD PWM+反演修正 · #20 worldModel fork/merge · #24 相干瞬移场 · #25 W₁ 信息视图 · #23 LTLf 挖掘器 | ✅ 全绿 |
| 架构 | #14 标签页栈 · #15 场景 OCR（L3 点燃）· #16 UDS 客户端半 · #8 工位自报计量 · #18 schema 必填 | ✅ 全绿 |
| 环境 | #1 Windows 真机基准（4/4）· #4 pyautogui e2e（adapter 6/6 + W2 物理闭环）· #2 Linux CI shm | ✅ 全绿 |
| 标定 | #9 CPT 遥测标定（oracle 换血）· #13 四标定原子（A² MC / Kalman / Schmitt / NCD） | ✅ 全绿 |
| 宿主侧 | #5 服务注册（仓内三注册方齐备，待宿主 set 面）· #7 agents 通道（K-3 双通道执法在册，待宿主后端） | 仓内侧 ✅，宿主侧待决 |

## 真机执法的战果：潜伏 bug 群（六只）

1. **#17①**：Windows `apply()` 无条件要求窗口句柄 —— `set_contrast` 是系统级动作，真机上从未可达（注入式测试的 exec 恒返 '4\n' 掩盖）。
2. **#17②**：PS `\"` 转义在双引号串中非法 —— `USER32_DECL`/`HC_DECL` 经 execFile 真机调用从未编译成功。改 PS 单引号律。
3. **#17③**：`SPI_SET/GETHIGHCONTRAST` 的 pvParam 必须指向 **HIGHCONTRAST 结构体**（cbSize 先置），非 int 引用 —— 旧形状 SET 恒 false。**真机往返 126→127→126 VERIFIED**（`scripts/live_set_contrast.mjs` 可复跑）。
4. **#1①**：`screen.py` JPEG `_encode` 闭包对 `img` 重赋值 ⇒ UnboundLocalError（jpeg 分支在一切平台必炸；Linux 测试恰用 png 掩盖）。
5. **#1②**：Windows DPI 虚拟化使 DPI-unaware tkinter 窗口几何与物理像素错位 —— 夹具加 `SetProcessDpiAwareness(2)`。
6. **#12**：GPD 矩法反演 `(k−1)/(2k−1)` 系代数笔误（正确 `(k−1)/(2k)`；ξ=0 处巧合为零，真值 0.4 被估 0.444 藏在 F-2 ±0.15 容忍带内）—— PWM 双估计器上线后两法系统分歧当场现形。

## 数学器官清单

- **GPD 双估计器**：PWM 主估计（EVT 实践标准；网格 400 点 PWM 0.364 vs MoM 0.242，真值 0.4），矩法降为交叉证人，|Δξ|>0.1 ⇒ `consistent=false` 如实申报。
- **双边 CUSUM**：S⁺恶化臂 + S⁻痊愈臂；基线 = 环前终身史（append-only 计数器，不随 64 环滑动翻转；环刷新 40 步后告警不消失）。RECOVERY 洞见新增。
- **W₁ 信息视图**：`wᵢ ∝ tᵢ·(1−λ+λ·(−ln pᵢ)/ln n)`（λ=0.5）——质量视图（w1）契约不动，`w1Info`/`infoRatio` 加法维度显形「远处小而独特的变化被近处大面积冲刷掩蔽」。
- **I-4 相干瞬移场**：≥2 特征形状守恒（质量窗 [2/3,1.5] + 长宽比 ≤0.35）且位移矢量一致（轴差 ≤0.05）⇒ 刚体重排证据判 persistent；单候选诚实瞬态（I-4 反例律保住）。
- **LTLf 挖掘器**：bounded-response（A 后 ≤maxGap 必 B）/ precedence（B 从未紧邻抢跑）/ repeat-guard（T 从未紧接自身）三族；支持度 ≥3 且零反例才立法。
- **标定回路**（`src/calibration.ts`）：A² 临界表 MC 自举（同种子同表，α 序单调）；Kalman Q/R 网格 MLE（平稳 < 游走 比）；Schmitt 证据分离度；NCD Youden J。数据到位 = 换值一行；数据缺席 = 字面量继续服役。
- **CPT 遥测标定**：`calibrateCptFromTelemetry`（M 纪元接口换血 —— 真实观测分布 × 频次权重 × 规则标签）+ `observeSignalsForCalibration` 推导端。

## Windows 真机基准（`test/realMachineWin.bench.ts`，4/4）

- **W1**：D-5 服务真截屏（mmap-file）→ tesseract.js 离线 OCR（仓根 eng.traineddata）读出双按钮。
- **W2**：**真 pyautogui 物理点击**（真鼠标真光标）→ tkinter 回调 → 世界状态 done=true。
- **W3**：E1b 陷阱改道（种子记忆 ⇒ 0 陷阱点击 + 改道成功；无先验结局如实入账 —— 硬件或有）。
- **W4**：E3 学习曲线（Day1 真实陷阱点击 = 学费 → Day2 旧脑水合改道 0 陷阱 → 遗忘症对照仍失败）。
- 前置：`DSH_PHYSICAL_TRANSPORT=tcp DSH_PHYSICAL_TCP_PORT=8421 DSH_PHYSICAL_PID_ATTESTATION=false DSH_PHYSICAL_KEY_PATH=<key> python -m dsh_physical`。

## 诚实边界（新声明的留白）

- #5/#7：服务注册/agents 通道的**宿主侧**决策（仓内注册方与双通道执法已齐备）。
- #13：Kalman/Schmitt/NCD 的标定**值**仍为字面量 —— 标定回路已立，待生产观测序列积累（A² 表与 CPT 已有真数据流）。
- W3 无先验侧：学费是否发生取决于瞄准序与点击精度（真机硬件或有），免疫侧（种子 ⇒ 0 陷阱）是确定性主张。
- UDS dispatcher：依赖 undici 桥（已随包依赖自动装载；未装 ⇒ transport_error 诚实归因）。

## 验证

- 套件 346 测试 / 341 过 / 0 败 / 5 skip（epochO 20 项逐项执法；全纪元零回归；skip 全为环境性如实申报：4×adapter 密钥错配探针 + 1×POSIX-shm 仅 Linux）
- `tsc --noEmit` clean；`python compileall` clean；dist 重建
- 真机：adapter e2e 6/6（活服务）；Windows 基准 4/4；set_contrast 往返 VERIFIED
