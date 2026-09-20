// src/doctorCli.ts
// D-4 副通道：npm run doctor —— pre-commit / CI 的体检入口（蓝图 §2 触发机制）。
// 退出码：0 = 健康；1 = strict 模式下铁律违规；2 = 装配失败。
// J 纪元修正：补 .catch —— 无 rejection 处理时任何意外 reject 会以
// unhandledRejection 崩掉而非给出语义化退出码。
import { runDoctorCli } from './qualityDoctor.js';
runDoctorCli(process.argv.slice(2))
    .then(code => process.exit(code))
    .catch(e => {
    console.error('[doctor-cli] unexpected failure:', e);
    process.exit(2);
});
