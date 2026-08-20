# 参数级消融对比报告

**日期**：2026-08-19
**对象**：认知子系统登记处的 8 个承重参数（19 收缩到 7 之后的首次全量消融；v4 核证接地纪元新增第 8 个 VERIFY_TRUST_FLOOR）
**基准**：`test/paramAblation.bench.ts`（新增）+ `test/ablation.bench.ts`（机构级对照）+ `test/calibration.bench.ts`（校准对照）
**结果**：三基准全部通过；8 个参数全部被至少一个失效值击穿至少一个权威场景 —— 「承重」从主张变成了可复现的翻红记录。v4 增补见 §10。

---

## 1. 方法论

消融的单位是**参数本身**，与机构级消融（知识/仿真/反射/计费各层断电）互补：

- **失效值选择**：把该参数的机制推到失效边界（阈值顶格、权重归零、步长归零等），而非随机扰动。
- **判据**：7 个权威场景（判据与既有基准一字不改），消融变体必须至少击穿一个场景，否则该参数不承重（应出册）。
- **世界**：确定性模拟世界（陷阱按钮 `delete item` + 活路按钮 `clear log`，执行按命中裁决），零随机，跑一万次结果相同。

## 2. 七个权威场景与基准行为（全缺省）

| 场景 | 判据 | 基准实测 |
|---|---|---|
| S1 改道（E1b-seeded） | 陷阱记忆在场 ⇒ 压制 + 改道：completed、0 陷阱点击、1 次执行 | `completed/exec=1/trap=0` ✓ |
| S2 直扑（E1b-blind） | 无知识 ⇒ 反射直扑：failed、≥3 陷阱点击 | `failed/trap=3` ✓ |
| S3 学习（E3） | Day1 踩坑/活路 → Day2 旧脑改道；遗忘症对照仍失败 | `d1:failed/3t d1s:completed d2:completed/1e/0t 失忆:failed` ✓ |
| S4 静默（E2） | 熟悉世界 surprise 策略零 L3 开销 | `completed/l3=0` ✓ |
| S5 开火（Novelty） | 新世界首遇恰升一次 L3 | `failed/l3=1` ✓ |
| S6 反证（契约） | 失败证据经成功反证 ⇒ 严格下降且绝不归零 | `error 0.30→0.15` ✓ |
| S7 计费带（分离带） | 熟悉底噪不计费（不误报）且 1/20 稀有信号计费（不漏报） | `底噪0.07b静默/信号3.84b计费（阈值 3）` ✓ |

## 3. 参数消融矩阵（核心结果）

✓ = 绿，✗ = 翻红。**击穿数 = 该失效方向击穿的场景数**。

| 消融变体 | S1 改道 | S2 直扑 | S3 学习 | S4 静默 | S5 开火 | S6 反证 | S7 计费带 | 击穿 |
|---|---|---|---|---|---|---|---|---|
| baseline（全缺省） | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0 |
| REFLEX_SUPPRESS_CONFIDENCE=1（免疫失能） | ✗ | ✓ | ✗ | ✓ | ✓ | ✓ | ✓ | 2 |
| DELIB_RELEVANCE_FLOOR=1（证据全出局） | ✗ | ✓ | ✗ | ✗ | ✓ | ✓ | ✓ | 3 |
| DELIB_WORKFLOW_WEIGHT=0（活路无托举） | ✗ | ✓ | ✗ | ✗ | ✓ | ✓ | ✓ | 3 |
| AUTO_LEARN_SUCCESS_CONFIDENCE=0（成功学习失能） | ✓ | ✓ | ✗ | ✓ | ✓ | ✓ | ✓ | 1 |
| REINFORCE_STEP=0（复证失能） | ✓ | ✓ | ✗ | ✓ | ✓ | ✓ | ✓ | 1 |
| DISCONFIRM_DECAY=1（反证不降） | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✓ | 1 |
| DISCONFIRM_DECAY=0（反证归零/销毁证据） | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✓ | 1 |
| L3_ESCALATION_BITS=0（计费误报） | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | 1 |
| L3_ESCALATION_BITS=99（计费漏报） | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | 1 |

## 4. 翻红明细（实测 vs 基准 —— 证词）

```
✗ REFLEX_SUPPRESS_CONFIDENCE=1 [S1改道]  实测 failed/exec=3/trap=3            （基准 completed/exec=1/trap=0）
✗ REFLEX_SUPPRESS_CONFIDENCE=1 [S3学习]  实测 d2:failed/3e/3t                 （基准 d2:completed/1e/0t）
✗ DELIB_RELEVANCE_FLOOR=1      [S1改道]  实测 failed/exec=3/trap=3            （基准 completed/exec=1/trap=0）
✗ DELIB_RELEVANCE_FLOOR=1      [S3学习]  实测 d2:failed/3e/3t                 （基准 d2:completed/1e/0t）
✗ DELIB_RELEVANCE_FLOOR=1      [S4静默]  实测 failed/l3=0                     （基准 completed/l3=0）
✗ DELIB_WORKFLOW_WEIGHT=0      [S1改道]  实测 failed/exec=0/trap=0            （基准 completed/exec=1/trap=0）
✗ DELIB_WORKFLOW_WEIGHT=0      [S3学习]  实测 d2:failed/0e/0t                 （基准 d2:completed/1e/0t）
✗ DELIB_WORKFLOW_WEIGHT=0      [S4静默]  实测 failed/l3=0                     （基准 completed/l3=0）
✗ AUTO_LEARN_SUCCESS_CONFIDENCE=0 [S3学习] 实测 d2:failed/0e/0t              （基准 d2:completed/1e/0t）
✗ REINFORCE_STEP=0             [S3学习]  实测 d2:failed/3e/3t                 （基准 d2:completed/1e/0t）
✗ DISCONFIRM_DECAY=1           [S6反证]  实测 error 0.30→0.30                 （基准 error 0.30→0.15）
✗ DISCONFIRM_DECAY=0           [S6反证]  实测 error 0.30→0.00                 （基准 error 0.30→0.15）
✗ L3_ESCALATION_BITS=0         [S7计费带] 实测 底噪0.07b误报/信号3.84b计费（阈值 0）（基准 底噪0.07b静默/信号3.84b计费（阈值 3））
✗ L3_ESCALATION_BITS=99        [S7计费带] 实测 底噪0.07b静默/信号3.84b漏报（阈值 99）（基准 底噪0.07b静默/信号3.84b计费（阈值 3））
```

## 5. 承重结论（击穿清单 = 参数的承重面向）

| 参数 | 缺省 | 校准可行区间（calibration Part A/B/C） | 消融击穿场景 | 承重语义 |
|---|---|---|---|---|
| REFLEX_SUPPRESS_CONFIDENCE | 0.5 | [0, 0.55] | S1 改道, S3 学习 | 免疫阈值的执法点：拔掉 ⇒ 反射直扑陷阱（trap 0→3），改道与 Day2 学习双双失守 |
| DELIB_RELEVANCE_FLOOR | 0.3 | [0.10, 0.35] | S1 改道, S3 学习, S4 静默 | 前额叶证据闸门：拔掉 ⇒ 证据全出局，改道/学习/静默三场景全灭（击穿面最宽） |
| DELIB_WORKFLOW_WEIGHT | 2 | [0.5, 8] | S1 改道, S3 学习, S4 静默 | 活路托举力：拔掉 ⇒ workflow 证据零效用，知道陷阱也无处可去（exec 1→0 的诚实接地） |
| AUTO_LEARN_SUCCESS_CONFIDENCE | 0.6 | (0, 1] | S3 学习 | 成功经历的立信铸造：拔掉 ⇒ Day1 活路学到零证据，Day2 无路可改 |
| REINFORCE_STEP | 0.3 | [0.2, 1] | S3 学习 | 复证强化：拔掉 ⇒ 置信度永不增长（0.3 恒 < 0.5 压制线），Day2 交 3 次陷阱学费 |
| DISCONFIRM_DECAY | 0.5 | 契约 (0,1) | S6 反证 | 反证经济学：拔掉（任一方向）⇒ 要么证据不可反驳（1），要么一次成功销毁全部失败证据（0） |
| L3_ESCALATION_BITS | 3 | 分离带 (0.415, 3.841] | S7 计费带 | 计费器双向判定：拔低 ⇒ 熟悉世界误报（底噪 0.07b 也计费）；拔高 ⇒ 1/20 稀有信号漏报 |

**结构性观察**：

- 前额叶三参数（FLOOR / WEIGHT / 压制阈值）击穿面最宽 —— 认知带宽的成本经济学（误信/漏信权衡）是系统最重的承重墙。
- 自体学习两参数（AUTO_LEARN / REINFORCE）只击穿 S3 —— 它们的承重面恰好是学习闭环本身（这是它们存在的全部理由）。
- 反证与计费各守一个契约场景 —— 单场景击穿 = 窄而深的承重（结构不变量），与宽而浅的决策参数互补。

## 6. 机构级消融对照（ablation.bench.ts，同世界同判据）

| 消融层 | verdict | executions | trapHits | l3 | 语义 |
|---|---|---|---|---|---|
| full（全层开） | completed | 1 | 0 | 0 | 仿真借 workflow 证据零样本命中活路 |
| no-knowledge（检索/学习断电） | failed | 0 | 0 | 0 | 仿真无米下锅 ⇒ 诚实接地（无隐知识模式失败） |
| no-deliberation（前额叶断电） | failed | 0 | 0 | 0 | 反射无弧直接接地 |
| no-reflex（脊髓断电） | completed | 1 | 0 | 0 | 仿真兜住（本意图零重合 —— 层级冗余的诚实测量） |
| 仅 workflow 证据（无陷阱证据） | completed | 1 | 0 | 0 | 单证据仍够用（本世界冗余，换世界未必） |

E1b 陷阱改道 / E2 计费策略（always 3 L3 vs surprise 0 L3 vs never 0 L3，成功率 3/3 等价）/ E3 学习曲线（Day1 success 0.5 → Day2 success 1.0，遗忘症对照仍失败）全部复现，与参数清理前的历史记录一致 —— **参数清理（19→7 + 12 内联）未改变机构级行为**。

## 7. 校准对照（calibration.bench.ts）

- **Part A 一阶敏感性**：6 个可扫参数的缺省值全部落在实测可行区间内（REFLEX [0,0.55] / FLOOR [0.10,0.35] / WEIGHT [0.5,8] / AUTO_LEARN (0,1] / REINFORCE [0.2,1] / BITS 全域不敏感）。
- **Part B 契约校准**：REINFORCE 3 次学习 ≥ 0.5 的物理约束可行 {0.2..0.8}；反证降而不毁；内联字面量（CONSENSUS_BONUS=0.1、MIN_CLUSTER_SIZE=3、CONFIDENCE_HALF_LIFE_MS）的不变量全部守护。
- **Part C L3 分离带**：底噪上界 0.415 bits < 阈值 3 ≤ 1/20 信号 3.841 bits；流水线 6 重试复核 bits=[0,1,2,3,4,5,6,8] → l3=[5,1,1,1,1,1,1,1]（bits=0 的误报路径需多轮转移才膨胀 —— 默认重试下的场景盲区，由 S7 计费带场景补上）。

## 8. 诚实边界

1. **一阶消融 ≠ 联合标定**：每个参数单独拔掉测的是独立贡献；参数间耦合（如 REINFORCE × REFLEX_SUPPRESS 的联合约束）只被端点场景覆盖，不是全空间搜索。
2. **L3_ESCALATION_BITS 的场景盲区**：Part A 场景扫描显示「全域不敏感」—— 误报方向在默认重试下不可见（需 6 重试膨胀，Part C 已证 l3: 1→5），漏报方向被 novel 直通掩盖（首遇升级走 novel 通道与阈值无关）。S7 计费带场景正是为此补的 WM 直驱判据：阈值只由分离带 (0.415, 3.841] 定标，形式推导 bits=−log₂p（3 ⇔ p≤12.5%）。
3. **消融值是边界值，不是中间值**：只证明「拔到失效边界会翻红」，不刻画中间值的性能曲线 —— 那是校准基准（Part A 扫值）的工作，两者互补。
4. **世界是两按钮的确定性世界**：击穿清单是下界（真实世界只可能更多）；S2 直扑场景在任何消融下都不翻红是设计使然（无知识直扑本来就失败，没有可破坏的机制）。

## 9. 附记（v3 采纳 fail-heavy 向量后的承重结构变化）

采纳联合标定 fail-heavy 归宿（REFLEX 0.55 / WEIGHT 6 / AUTO_LEARN 1）后全量回归，**REINFORCE_STEP 在原 7 场景下零击穿**——结构性变化：W=6 + 顶格铸造的托举证据在**未压制**时也能赢前额叶审议（S3 的 Day2 改道不再依赖置信度越线）。步长的承重面收缩为「无活路世界的压制止血」，新增 **S8 水合场景**守护（判据与 calibration Part A 的 REINFORCE 物理约束同构：Day1 三次执行 0.3 必须越过阈值 ⇒ Day2 压制止血 0 陷阱；step=0 实测 d2 再交 3 次学费翻红）。修复后 7/7 参数全部承重，S8 同时被 REFLEX=1.0 / FLOOR=1.0 击穿（增益击穿面）。这是先例的第二例（第一例：S7 之于 L3_ESCALATION_BITS）——承重性是向量的高阶函数，参数采纳后必须复跑消融。

## 10. v4 增补：VERIFY_TRUST_FLOOR（第 8 参数）与 S9 核证场景

核证接地纪元（信任门控的接地前探针，详见 [joint-calibration-report.md §12](./joint-calibration-report.md)）引入第 8 个登记参数 VERIFY_TRUST_FLOOR（θ）——压制 + 无活路接地终局前的信任地板：压制证据族最高信任（置信度 × 亲证衰减）≥ θ ⇒ 亲证背书诚实接地；< θ（传闻 trust 0 / 陈年亲证）⇒ 放行一针探针。

- **消融行**：`=0`（全信：传闻自背书 ⇒ 不探针）击穿 S9；`=1`（全疑：亲证不背书 ⇒ 逢压制必探针）击穿 S9 + S8（水合后 Day2 亲证 0.3 也被怀疑 ⇒ 再交学费）。
- **S9 核证三态场景**（判据与 calibration Part A 的 θ 定界同构）：传闻压制一针核证（failed + 1 陷阱学费）/ 陈年亲证 + 陷阱已修好 ⇒ 复活探针点击成功（completed —— 死锁的时间出口）/ 新鲜亲证自背书（failed + 0 学费）。
- **登记区间 [0.2, 0.65]**：下界锚点 60 天陈年亲证（trust 0.165）必须复活探针；上界锚点新鲜亲证（0.66）必须自背书。缺省 0.2 = 联合标定四机制稳定归宿 + 初铸亲证（conf 0.3）17.5 天保鲜期锚点（θ=0.3 旧值的「衰减 1 含等号」只在铸造同一毫秒成立——F1 Day2 实测翻红，见 joint 报告 §12.4）。

消融矩阵更新为 8 参数 × 9 场景（S1-S9），基准全绿。
