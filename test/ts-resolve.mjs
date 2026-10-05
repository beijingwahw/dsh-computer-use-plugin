// test/ts-resolve.mjs
// resolve hook：相对导入解析失败 ⇒ 补 .ts 重试（源码遵循 bundler 无扩展名约定）。
// 同时处理 .js → .ts 的改写（TS 源码内 import './foo.js' 实指 './foo.ts'）。
// ΠΑΝ 修复潮（F2-3 协调注记）：增补目录导入回退 —— ΠΑΝ-46/49 波引入的
// `from '../dialects'`（桶文件目录导入）在 Node ESM 下抛 ERR_UNSUPPORTED_
// DIR_IMPORT（tsc 可解析、Node 原生不可）。回退到 '<dir>/index.ts' 与 TS 的
// 目录模块解析语义一致，纯增补不改既有两条路径。
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (err) {
    if (err?.code === 'ERR_UNSUPPORTED_DIR_IMPORT' &&
        (specifier.startsWith('./') || specifier.startsWith('../'))) {
      // 情况 3：./dir → ./dir/index.ts（TS 目录模块解析的运行时对偶）
      return next(specifier + '/index.ts', context);
    }
    if (err?.code === 'ERR_MODULE_NOT_FOUND' &&
        (specifier.startsWith('./') || specifier.startsWith('../'))) {
      // 情况 1：./foo.js → ./foo.ts（TS bundler 约定的 .js 指向 .ts）
      if (specifier.endsWith('.js')) {
        const tsSpec = specifier.slice(0, -3) + '.ts';
        try {
          return await next(tsSpec, context);
        } catch (err2) {
          if (err2?.code !== 'ERR_MODULE_NOT_FOUND') throw err2;
        }
      }
      // 情况 2：./foo → ./foo.ts（无扩展名约定）
      return next(specifier + '.ts', context);
    }
    throw err;
  }
}
