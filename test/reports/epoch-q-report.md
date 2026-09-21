# Epoch Q — 开天辟地战报

日期：2026-09-20 · 执法册：`test/epochQ.test.ts`（8 项器官级测试）· 新器官：`src/proof.ts`

## 八件新器官（每模块簇一件）

| 层 | 器官 | 数学根基 | 执法 |
| --- | --- | --- | --- |
| 证明 | **MMR 默克尔山**（`proof.ts` 新器官，journal + sandboxLog 接线） | Merkle 1979；山峰叶数 = 2 的幂（二进制分解），峰袋根，O(log n) 包含证明 | Q-1：1..1000 全尺寸全索引可证可验；任一叶篡改 ⇒ 全部旧证明失效 |
| 感知 | **pHash 第二指纹**（DCT-II 低频谱 + dualSimilarity + phashCorroborates） | Zauner 2010；DC 排除 ⇒ 亮度不变；与 dHash 失效模式正交 ⇒ 保守融合抬双指标 | Q-2：亮度 1.06× 微扰逐位不变；异布局 < 0.85 |
| 决策 | **Wald SPRT**（SprtPopupFilter，与 Schmitt 并存） | Wald 1945 / Wald–Wolfowitz 1948 最优性：同 (α,β) 期望样本量全类最小 | Q-3：语义单帧即判（ln45>ln19）；几何 3 帧；双清洁 2 帧；终判锁定 |
| 知识 | **Dirichlet 预测熵**（entropyBits + posteriorConcentration） | 平滑预测熵 H = −Σ p̂ log₂ p̂（含未见漏斗）；集中度 n/(n+2) | Q-4：确定转移 < 0.6 bits；混合 +0.5 bits 以上；证据升 ⇒ 集中升/熵降 |
| 记忆 | **技能系谱**（parents/generation + lineage + 灭绝剪枝感知） | 演化谱系：世代深度 = 组合复杂度；谱系存续 = 基因在后代中表达 | Q-5：链回溯 s4→s3→r1；自环守卫截断；字段持久化往返 |
| 证据 | **效应量**（cohensH + mannWhitney） | Cohen's h（反正弦尺）；Mann–Whitney U（并列校正 + 连续性修正 + A–S 7.1.26 正态 CDF） | Q-6：h(1,0)=π、h(.8,.2)≈1.287 地标；8v8 全分离 U1=0 p<0.01；可交换性 |
| 探索 | **Thompson 晶体**（thompsonTopRoutes） | Beta(s+1, f+1) 后验抽样（H-3 同律）：探索按证据不足程度成比例 | Q-7：60 轮播种 —— 高证据真值主导（≥30 居首）且低证据 2/2 获探索配额（≥1） |
| 运动 | **焦点速度外推**（focusTracker.predicted） | 两点一阶差分速度 + 线性外推（钳半屏 —— 外推不确定度超线性） | Q-8：+x 漂移外推外推在场；单帧/时间倒流诚实回退原点 |

## 顺手根除的两只新虫（开天辟地也验了地）

- **第十五只**：MMR 首版把**节点计数（2^k−1）与叶计数（2 的幂）混谈**——山峰切分与完全树切分数学不相容（4/37 证明失败即暴露）。修正为二进制分解 + 完美树对半切。
- **第十六只**：构造器参数属性（`public readonly α = 0.05`）是 transform 语法——**Node strip-only 拒载**（J 纪元"类型即值地雷"同族，BCR 候选新虫型）。改显式字段。

## 模块簇认证（已达前沿、本轮不无谓搅动）

phaseHmm（Rabiner 逐式验证过）· sequitur（ABAB* 边角过）· 贝叶斯皮层（M 标定 + P 属性炮台）· GPD 双估计器（PWM+一致性）· 双边 CUSUM（终身基线）· LTLf（挖掘器 + 语义不变量）· 虚拟屏（K/N/O 四类证据 + 标签栈 + 场景 OCR）· 物理执行（UDS 客户端半 + SO_PEERCRED 服务端）· BCR 免疫闸 —— 以上器官在 P 纪元已过属性/执法双关，本轮认证而非重写（不为改而改是同一纪律）。

## 验证

- 套件 **367 测试 / 362 过 / 0 败 / 5 skip**（epochQ 8/8；全纪元零回归）
- `tsc --noEmit` clean · dist 重建（**116 模块**导入清洁）· `verify` 23/23 + BCR 零命中
