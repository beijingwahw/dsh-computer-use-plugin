// src/actionVerifier.shared.ts
// ΠΑΝ-127（D-F5 清偿）：动作验证共享基元下沉叶 —— 卫星 actionVerifier.stable.ts
// 回借桶（actionVerifier.ts）的 sleep 一行器构成桶-卫星 value 二环（W6-2 分区
// 提取残留互指）。按「共享基元下沉零出边基座」方言拆环：sleep 入住本叶（零
// 出边、实现逐字保留）；桶与卫星皆改 import 本叶；桶面 re-export 保导入面零
// 破坏（tools/dragMouse 等消费点零改动）。行为零变化。
export const sleep = (ms) => new Promise(r => setTimeout(r, ms));
