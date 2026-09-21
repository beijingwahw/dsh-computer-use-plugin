# Epoch P — 灭虫圣战报告

日期：2026-09-20 · 执法册：`test/epochP.test.ts`（13 项属性/执法测试）· 免疫闸：`scripts/bug_class_lint.py`（接入 `npm run verify`）

## 猎杀总账：7 只新根除（本纪元）+ 免疫机制 2 件

| # | 虫 | 严重度 | 虫型类 | 根除方式 |
| --- | --- | --- | --- | --- |
| 8 | `auth_middleware` 顺序倒置（peer 比对先于令牌解析） | **严重**（UDS+peercred 路径落地即崩） | 闭包/先读后赋（BC-2） | 层序重排：Layer 3 先解析、Layer 2 后比对（P-9 执法） |
| 9 | A² 的 GPD CDF **反号 ξ 约定**（MC 临界表 78–160 vs 文献 0.5–1.1） | **严重**（标定值全错） | 公式代数（BC 类 III） | 正号约定 + PWM/A² 公式体单一事实源（P-5 回归闸） |
| 10 | 标定器 NaN 静默泄漏 + `predicted` 装饰字段（从未参与估计） | 中 | NaN 免疫 / API 诚实 | 非有限样本过滤 + 真互补滤波 `ŷ = k·obs + (1−k)·pred` |
| 11 | swarm `restore()` 静默丢弃持久化的 `consumedWatermark`（N-1 名存实亡） | **严重**（跨会话双计回归） | 状态恢复洞 | 水位置入 + 武装位（P-11 ①：新对象前缀跳过零二次入账） |
| 12 | 水位基于 journal 滑窗**位置**（容量饱和后 plateau ⇒ 会话中途永久失聪） | **严重** | 序号稳定性假设 | 武装水位律：恢复首轮前缀跳过即标记进 WeakSet，会话内纯身份游标（P-11 ②） |
| 13 | `recombine` 去重强化路径漏 `save()`（崩溃窗口丢计数） | 低 | 出口跳过清理 | bump 即落盘（P-13） |
| 14 | 多显示器准星钉边（全局虚拟屏坐标混入截图本地域） | 低（多屏环境高） | 坐标域混用 | 域外诚实缺席——不画 > 自信错位（P-14 像素级执法） |
| + | `verify` V2c 环境假设（pyautogui 装机后"无显示"模拟恒假） | 中（工具链） | 环境假设 | 毒性模块注入 `sys.modules`——任何机器确定性执法 |


## 免疫机制（世界性创新）

### 1. Bug 类注册表（BCR）—— `scripts/bug_class_lint.py`
每类历史虫型铸成**机械检测器**，全库扫描签名形状，命中即构建闸报错（`--strict`）：
- **BC-1 PS 引号律**：PS 命令串含 `\"`（PS 双引号串内不是转义——execFile 真机必炸）。
- **BC-2 闭包重赋值**：AST 语句序分析——嵌套函数对名字「先读后赋」（UnboundLocalError 形状）。**本纪元用它直接抓到 #8。**
- **BC-3 时钟单调假设**：裸 `Date.now()` 作 id/序键（同毫秒碰撞 + 回拨倒序）。
接入 `npm run verify`（`verify_fatal_fixes.py && bug_class_lint.py --strict`）—— 虫型免疫从此是构建闸，不是记忆负担。

### 2. 属性测试炮台 —— `test/epochP.test.ts`（13 项）
全部统计/数学引擎过「**已知参数恢复 + 闭式对齐 + 不变量**」关：
- Hurst：iid 均值 → 0.5；持续性序列显著更高
- 置换检验：精确 p ≡ Fisher 超几何闭式（1/C(15,9)）；组序可交换
- 贝叶斯信念：后验归一（和=1）、值域、全缺席诚实 null
- NCD：对称 / [0,1] / 同串恒 0 / 同构 < 无关
- A² MC 临界表：文献带 [0.2, 3]（#9 的回归闸——约定错配即刻现形）
- Kalman 稳态递推 ≡ DARE 闭式解（1e-9）
- 汉明：度量律（恒等 0/对称/三角不等式）
- LTLf：空迹空真 / 强 X 末位诚实假 / U 的弱化语义
- auth 层序（#8）· BCR 零命中 · swarm 水位双景（#11/12）· recombine 落盘（#13）· 准星缺席（#14，像素级）

**教训成文**：示例断言抓不住约定错配（O-#13 的确定性与单调性断言放行了 #9）——参数恢复能。

## 深审清白名单（逐行验证过，零发现）

actionVerifier / perceptualHash / uiMemory / focusTracker / checkpoint / oscillationTracker / **phaseHmm**（对 Rabiner 逐式验证 forward/backward/γ/ξ/M-step/Viterbi + log-sum-exp 守卫）/ **sequitur**（含 ABAB* 边角）/ semanticHash / quantumSense / input.py / window.py / shm.py。

## 验证

- 套件 **359 测试 / 354 过 / 0 败 / 5 skip**（epochP 13 项全绿；全纪元零回归）
- `npm run verify` = 23/23 证据 + BCR 全库零命中
- `tsc --noEmit` clean；`python compileall` clean；dist 重建；115 模块导入清洁
- 基准套件 13/0/5（灭虫前全绿，灭虫后未触碰其域）
