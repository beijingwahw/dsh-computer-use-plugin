// scripts/gen_config_docs.d.mts
// gen_config_docs.mjs 的类型签名（供 test/configDocs.test.ts 的 TS 导入消费；
// 纯 JS 脚本本体零依赖，本声明不参与 dist 构建）。
export interface ConfigDocRow {
  key: string;
  type: string;
  default: unknown;
  description: string;
}
export declare function buildRows(schema: unknown): ConfigDocRow[];
export declare function renderMarkdown(rows: ConfigDocRow[]): string;
