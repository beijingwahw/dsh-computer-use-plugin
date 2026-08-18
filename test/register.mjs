// test/register.mjs
// 测试引导：注册 TS 无扩展名解析 hook。
// 源码内部导入遵循宿主 bundler 约定（'./journal' 无扩展名），Node 原生 ESM 不认 ——
// 此 hook 在解析失败时补 .ts 后缀重试。仅测试环境使用；宿主运行时用自己的加载器。
import { register } from 'node:module';

register('./ts-resolve.mjs', import.meta.url);
