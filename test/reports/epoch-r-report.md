# Epoch R — 开天辟地第二击战报

日期：2026-09-20 · 执法册：`test/epochR.test.ts`（6 项器官级测试）· 新器官：`src/fuzzy.ts`、`src/elementTracker.ts`

## 六件新器官

| 层 | 器官 | 数学根基 | 执法 |
| --- | --- | --- | --- |
| 模糊 | **近似子串搜索**（fuzzy.ts，textReader 接线） | Wagner–Fischer 子串形态 DP；Myers 位向量 O(⌈m/w⌉n) 界备案、审计性优先 | R-1：l→1/O→0/吞空格容错命中；远文拒判；子串语义（任意起点免费起跑） |
| 检索 | **BM25**（knowledgeBase 词法通道） | Robertson & Spärck Jones 血统；IDF=ln((N−df+.5)/(df+.5)+1)，k1=1.2/b=0.75 | R-2：稀有词（df=1）条目压倒三条常见词（df=3）条目 |
| 熔断 | **Beta-Bernoulli 序贯后验臂** | Beta(f+1,s+1) 上尾质量；正则化不完全 Beta（Lentz 连分式）+ Lanczos lnΓ | R-3：6败2胜=0.91 不熔；8败2胜=0.967 熔；2败8胜<0.05；I_x 地标 |
| 快照 | **v4 证据锚**（checkpoint 双 MMR 根） | 快照-证据一致性：锚=保存时刻重算根，恢复对照 | R-4：v3→v4 幂等迁移（null 诚实补位）；真档锚==重算根；篡改即不等 |
| 视觉 | **跨帧稳定元素 ID**（elementTracker.ts，takeScreenshot 接线） | IoU 贪心二部匹配（0.4 阈值，O(n²) 微秒级）；≤5 帧缺席续号 | R-5：微移保号；新者领新号；短暂消失回归续号；>5 帧退役防误连 |
| 召回 | **RRF 倒数排名融合**（failureMemory） | Cormack TREC 2003：Σ 1/(60+rankᵢ) —— 排名无量纲 | R-6：词面命中居首；换述经压缩通道召回；旧加权和并存 score2 零回归 |

## 顺手根除的一只（第十七只）

checkpoint 迁移链断裂：v3 早期幂等守卫（`version===3 return`）挡住 v4 升级分支，且 v1/v2 分支丢失版本跃迁衔接 ⇒ v1/v2 档迁移返回 null（拒绝恢复）。修为单条件 1≤v≤3 → v4 幂等归一。

## 验证

- 套件 **373 测试 / 368 过 / 0 败 / 5 skip**（epochR 6/6；全纪元零回归）
- `tsc --noEmit` clean · dist 重建（**118 模块**导入清洁）· `verify` 23/23 + BCR 零命中
