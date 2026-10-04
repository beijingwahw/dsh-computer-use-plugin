import { DOCTOR_RULES_CORE } from './doctorRules.core.js';
import { DOCTOR_RULES_SECURITY } from './doctorRules.security.js';
export { EMPTY_CATCH_FIX, lines } from './doctorRules.helpers.js';
export { EXEMPTABLE_RULE_ID, OVER_ENGINEERING_EXEMPTIONS } from './doctorRules.exemptions.js';
/** 全量规则注册表（数据驱动静态配置 —— 进化记忆绝不反向修改；拼接序 = 报告检出序，
 *  与拆分前的单文件数组顺序逐位一致） */
export const DOCTOR_RULES = [...DOCTOR_RULES_CORE, ...DOCTOR_RULES_SECURITY];
