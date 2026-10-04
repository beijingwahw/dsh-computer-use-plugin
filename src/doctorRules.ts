// src/doctorRules.ts
// D-4 质量医生的抗体库：装配门面（规则 id 与注册表 API 恒定不变）。
// 历史沿革：13 条规则时期是单文件；W6R-B9 增补 7 条 sec.* 安全不变量后膨胀至
// 636 行，自身触发 smell.over-engineering（>500 行阈值）—— 医生吃自己的处方，
// W8-A9 按职责拆分（阈值按文件计，拆分即自愈，无需豁免扩条）：
//   · doctorRules.helpers.ts    —— 规则公共辅助（finding/lines/注释行判定/工件读取）
//   · doctorRules.exemptions.ts —— W7-1 中央豁免注册表（21 件结构性保留）
//   · doctorRules.core.ts       —— 既有 13 条（genesis×4 / smell×3 / sec×2 / chain×4）
//   · doctorRules.security.ts   —— W6R-B9 七条安全不变量守护（sec.*）
// 本文件只做聚合与 re-export：消费面（qualityDoctor.ts / 测试）import 路径零改动。
// 规则是纯函数对象：绝不持有状态；进化记忆只在外部计算生效权重，绝不反向修改。
import type { DoctorRule } from './doctorTypes';
import { DOCTOR_RULES_CORE } from './doctorRules.core';
import { DOCTOR_RULES_SECURITY } from './doctorRules.security';

export { EMPTY_CATCH_FIX, lines } from './doctorRules.helpers';
export { EXEMPTABLE_RULE_ID, OVER_ENGINEERING_EXEMPTIONS } from './doctorRules.exemptions';

/** 全量规则注册表（数据驱动静态配置 —— 进化记忆绝不反向修改；拼接序 = 报告检出序，
 *  与拆分前的单文件数组顺序逐位一致） */
export const DOCTOR_RULES: DoctorRule[] = [...DOCTOR_RULES_CORE, ...DOCTOR_RULES_SECURITY];
