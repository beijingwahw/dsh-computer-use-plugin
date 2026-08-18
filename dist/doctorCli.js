// src/doctorCli.ts
// D-4 副通道：npm run doctor —— pre-commit / CI 的体检入口（蓝图 §2 触发机制）。
// 退出码：0 = 健康；1 = strict 模式下铁律违规；2 = 装配失败。
import { runDoctorCli } from './qualityDoctor.js';
runDoctorCli(process.argv.slice(2)).then(code => process.exit(code));
