// bench/anti-cheat.d.mts
// ΑΝΒ-7: bench/anti-cheat.mjs 的最小类型面 —— test/ 侧（test/anab7.benchDiscipline.
// test.ts 的同源测试锁）import 该 .mjs 时 tsc 的声明来源。只声明被消费的导出
// （名册/分类/纯判决函数）；CLI 面（main/renderMarkdown 等内部函数）不导出、
// 不声明。运行时真身是 anti-cheat.mjs（Node ESM 直载），本文件零运行时足迹。
// 漂移守护：声明与实现的面差由 anab7 测试的运行时断言兜住（声明说 string[]
// 而实现改出 number ⇒ 测试红）。

/** 插件工具名册（50 件闭集 —— src/guards/hostToolPolicy.ts PLUGIN_TOOL_ALLOWLIST 的 bench 侧单源镜像）。 */
export declare const PLUGIN_TOOL_NAMES: readonly string[];
/** 宿主原生工具分类表（七分类之宿主五类；'plugin' 与 'host-unknown' 由判别产生）。 */
export declare const HOST_TOOL_CLASSES: Readonly<Record<string, readonly string[]>>;
/** 工具名 → 工具面分类（'plugin' | 'host-shell' | 'host-file' | 'host-job' | 'host-run-code' | 'host-meta' | fallback；空名 → 'none'）。 */
export declare function classifyToolName(
  name: unknown,
  opts?: { fallback?: string },
): { surface: string; known: boolean };
