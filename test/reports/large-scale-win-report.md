# 大规模真机验证报告（Windows · Data Console）

日期：2026-09-23T21:15:28.564Z · 执法册：`test/largeScaleWin.bench.ts` · 世界：`test/fixtures/complexWorldWin.py`

## 环境

- 真机链路：D-5 物理服务（tcp :8421，mmap-file 截屏）→ tesseract.js 离线 OCR → pyautogui 真鼠标 → tkinter 回调
- 世界复杂度：5 页 × 6 内容控件 + 5 导航（每屏 12+ 文本元素），陷阱族跨 3 页
- 决策脑：ReflexiveDecisionStation 四层（免疫压制 → 脊髓反射（X 纪元：+ 运动反射弧 type/scroll/hotkey）→ 前额叶仿真 → 核证探针），无 LLM 通道
- 任务总量：**66 项任务 / 148 个流水线 run / 149 次真实鼠标点击**

## 准确率总账

| 类别 | 任务 | 通过 | 准确率 |
| --- | --- | --- | --- |
| navigation | 6 | 6 | 100.0% |
| on-page-reflex | 10 | 10 | 100.0% |
| typing | 8 | 8 | 100.0% |
| seeded-trap-avoidance | 4 | 4 | 100.0% |
| learning-curve | 4 | 4 | 100.0% |
| semantic-generalization | 6 | 6 | 100.0% |
| ambiguity-grounding | 2 | 2 | 100.0% |
| impossible-intent | 4 | 4 | 100.0% |
| multi-step-chain | 8 | 8 | 100.0% |
| repeat-stability | 9 | 9 | 100.0% |
| ablation-attribution | 5 | 5 | 100.0% |
| **总计** | **66** | **66** | **100.0%** |

- 墙钟：2.9 分钟 · 真实陷阱点击（设计内学费）：19 次（分布于学习曲线/遗忘症/消融臂 6 项任务）
- 免疫主张：种子陷阱规避与学习 Day2 全部 0 陷阱点击（见 seeded-trap-avoidance / learning-curve 两行）

## 失败明细（如有）

- （无失败任务）

## 诚实边界

- 决策脑为反射纪元（无 LLM 通道；X 纪元笔迹升级后动作词汇 = click_mouse + type_text / scroll_page / press_hotkey）：运动反射弧以引号锚定载荷（信息无损，精确性优先拒绝自由文本）+ 运动序法则（先落点后运笔）发射结构化动作，type_text 生而携带 L4 自证锚；其余动作类（drag_mouse / switch_* 等）仍由执行站如实拒绝。
- 消融臂只归因知识/反射/仿真三层的贡献；L3（VLM）在 stub 后端下不可计费。
- 每任务世界重置（canonical files 页起步）；学习族内跨 run 共享 stateDir（反遗忘水合执法）。

## 感知工程教训（战役战果 —— 每条都翻过车才立法）

1. **行级 OCR 合并**：tesseract 把跨列同基线的导航/内容按钮并成一行（'reports page empty trash'）⇒ 词级分组（x-间隙 ≤45px 聚词成元素，跨列 ≥80px 空隙天然分离）。
2. **文本裁剪**：按钮文本渲染宽 ≥ 按钮宽 ⇒ 首末字母被吃（'network page'→'etwork pag'、'settings page'→conf 3 的 'SEER'）⇒ 单词导航标签 + 按钮宽 ≥ 文本宽 + 50px 余量。
3. **绘制竞态 + 窗口间隙**：世界状态文件先于窗口上屏（tkinter persist 在 mainloop 绘制前落盘），首帧截屏抓到部分绘制的窗口；reset 的 kill→spawn→上屏间隙更长时甚至截到桌面既有窗口的文本 ⇒ 导航不变量重采样（导航词 <3 ⇒ 250ms 后重截，最多 8 次 ≈2s；好路径首轮即返）。
4. **小字误读带**：~17px 字高在 tesseract 偶发误读带边缘（单词整体消失/低置信）⇒ OCR 前 2× lanczos 放大（bbox 折回原域）+ 导航字号 16pt。
5. **IME 击键劫持（X 纪元战果）**：pyautogui.typewrite 的虚拟键码经活动输入法被劫持（'alpha.local'→'alpha。local'、'ada'→'阿达'）⇒ D-5 服务 Windows 侧改 SendInput + KEYEVENTF_UNICODE 直注（与键盘布局/输入法正交的唯一确定性文本注入）。
6. **跨列同基线行腐蚀（X 纪元战果）**：导航词与内容词同排时 tesseract 行分割被大间隙拉伸，单词被腐蚀（'settings'+'format disk' 同排 ⇒ 'setines' conf=0 被置信过滤静默吞掉）⇒ 分条带识别（导航条带 | 内容条带分别识别，跨列行混合在构造上不可能）+ 导航不变量收紧为全六词在场。
