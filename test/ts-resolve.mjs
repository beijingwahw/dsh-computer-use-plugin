// test/ts-resolve.mjs
// resolve hook：相对导入解析失败 ⇒ 补 .ts 重试（源码遵循 bundler 无扩展名约定）。
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND' &&
        (specifier.startsWith('./') || specifier.startsWith('../'))) {
      return next(specifier + '.ts', context);
    }
    throw err;
  }
}
