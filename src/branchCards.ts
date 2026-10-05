// src/branchCards.ts
// W3-6（H3 反事实岔路卡 · Ghost Replay 纠偏）：失败之后，「如果当时走了另一条
// 路」不该是一句空话 —— 本模块把它铸成可一键执行的岔路卡。
//
// 既有事实：counterfactual（Φ-9）每步都对候选集做了完整的效用预演，但择优后
// 即弃全部落选者 —— 「当时第二好的路」这个最贵的反事实信息被白白扔掉。本
// 模块把它落账、铸卡、供一键换支重放：
//
//   ① 岔路账（BranchLedgerBook）：每步决策后按 Top-3 落盘（含预测效用、动作
//      形状、关键参数），有界环形缓冲只保最近 capacity 步 —— 内存账随
//      checkpoint 第六段 branchLedger 持久化（见 checkpoint.ts W3-6 注记）。
//   ② 岔路卡（generateBranchCard）：goal 进入 failed/aborted 终局相时自动取
//      失败前最近的可岔步铸卡 —— 三候选各附诚实预测效用 + 该步失败归因
//      （只读消费 diagnosis 的 R1 根因报告与 W2-5 恢复梯）+ 支点引用
//      （checkpoint 步账位置：journal 条数 + 链尖）。卡片结构化、可序列化。
//   ③ 换支重放（applyBranchChoice + BranchReplayController）：用户 steer(k)
//      一键选第 k 候选 —— 支点防御校验（锚不匹配/账无支点 ⇒ 诚实拒绝）后，
//      经 counterfactual 的 ScoringContext.preferredActionKeys 注入缝铸「改选
//      偏置」（偏置只改选择不改预测）；重放有步数预算，超支诚实终止。
//
// 防御律（与库内记忆系统同律）：无账 ⇒ 卡片缺席（诚实降级，不伪造岔路）；
// 垃圾账 ⇒ 归零；坏步 ⇒ 弃置保好；一切脏输入卫兵式收敛，公开面绝不抛异常。
// 纪律：纯内存 + 纯函数（checkpoint 采集面除外），全离线可测；时钟可注入。
//
// ΠΑΝ-127（D-F5 清偿）：岔路账域（类型/常量/防御工具/BranchLedgerBook/
// branchLedger 单例）下沉至零环基座 branchCards.ledger.ts —— W6-2 分区提取后
// 卫星 branchCards.card.ts 回借桶面这些符号构成桶-卫星 value 二环。桶面现为
// 纯再分发门面（export * 自叶与卫星）；导入面零破坏（checkpoint/index/
// steerTools/rollbackPlanner 等消费点零改动），行为零变化。
export * from './branchCards.ledger';
export type {
  BranchCandidateRecord,
  BranchStepRecord,
  BranchLedgerSnapshot,
  BranchStepMeta,
} from './branchCards.ledger';

// W6-2（doctor smell.over-engineering 清偿）：岔路卡 + 换支重放已分区提取至
// branchCards.card.ts（行为零变化）；导入面不变 —— export * 再分发。
export * from './branchCards.card';
