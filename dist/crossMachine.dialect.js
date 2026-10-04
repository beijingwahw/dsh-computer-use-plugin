// src/crossMachine.dialect.ts
// W6-2（doctor smell.over-engineering 清偿）：自 crossMachine.ts 低风险分区提取
// （>500 行拆分信号）—— 传输方言（纯类型面，零运行时代码）整体搬迁，行为零变化。
// crossMachine.ts 以 export * 再分发，导入面不变（orchestrator / w5cross 测试零改动）；
// 立法常量按「立法在源」测试（w5cross ⑩）锁定留守 crossMachine.ts。
export {};
