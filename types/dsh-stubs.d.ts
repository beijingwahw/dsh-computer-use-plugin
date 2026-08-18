// types/dsh-stubs.d.ts
// 本地类型检查专用 stub：DSH 宿主环境（@deepseek-ai/*）与原生依赖（nut-js/sharp/...）
// 在沙箱中不可安装（私有 registry / 平台二进制），此处按项目实际使用面声明最小接口。
// 仅用于 `tsc --noEmit` 类型检查；运行时由宿主提供真实实现。
// 换 DSH 版本时：以各子系统页 cordis-surface 生成清单为准更新此处。

// ─── @deepseek-ai/cordis ───
declare module '@deepseek-ai/cordis' {
  export interface Context {
    /** 按名查询服务；可选服务不存在时返回 undefined */
    get<T = any>(name: string): T | undefined;
    /** 声明生命周期效果：回调可返回清理函数（注册即效果模型） */
    effect(fn: () => void | Promise<void> | (() => void)): void;
    /** 事件挂载 */
    on(event: string, handler: (...args: any[]) => any): void;
    /** 工具注册服务（inject 声明的必需依赖） */
    tools: { register(tool: any): void };
    /** 日志服务 */
    logger?: { info(...a: any[]): void; warn(...a: any[]): void; error(...a: any[]): void };
  }
}

// ─── @deepseek-ai/dsh-tools ───
declare module '@deepseek-ai/dsh-tools' {
  /** 工具 DSL：参数 schema + 输出 schema/render + execute（render/execute 参数由本接口提供上下文类型） */
  export interface ToolDefinition {
    name: string;
    description?: string;
    parameters: Record<string, any>;
    output?: {
      schema?: any;
      render?: (args: any, value: any) => Array<{ type: string; text?: any }>;
    };
    execute(args: any): Promise<string> | string;
  }
  export function defineTool<T extends ToolDefinition>(tool: T): T;
}

// ─── @deepseek-ai/schemastery ───
declare module '@deepseek-ai/schemastery' {
  interface SchemaNode {
    default(v: any): this;
    description(s: string): this;
  }
  // 类型空间：Schema<T>（config.ts 中 `const Config: Schema<Config>` 的类型用法）。
  // const + interface 同名合并后 export = 同一实体，值与类型双身份随绑定一起导出。
  interface Schema<T = any> extends SchemaNode {
    __typed?: T;
  }
  const Schema: {
    object(shape: Record<string, SchemaNode>): Schema & Record<string, any>;
    string(): SchemaNode;
    number(): SchemaNode;
    boolean(): SchemaNode;
  };
  export = Schema;
}

// ─── @nut-tree/nut-js ───
declare module '@nut-tree/nut-js' {
  export enum Button { LEFT = 0, MIDDLE = 1, RIGHT = 2 }
  export enum Key {
    LeftControl = 'LeftControl', LeftSuper = 'LeftSuper', LeftAlt = 'LeftAlt', LeftShift = 'LeftShift',
    Enter = 'Enter', Tab = 'Tab', Space = 'Space', Backspace = 'Backspace', Delete = 'Delete',
    Escape = 'Escape', F1 = 'F1', F2 = 'F2', F3 = 'F3', F4 = 'F4', F5 = 'F5',
    F11 = 'F11', F12 = 'F12', A = 'A', C = 'C', V = 'V', Z = 'Z',
  }
  export const mouse: {
    config: { mouseSpeed: number };
    getPosition(): Promise<{ x: number; y: number }>;
    move(points: Array<{ x: number; y: number }>): Promise<void>;
    click(btn: Button): Promise<void>;
    pressButton(btn: Button): Promise<void>;
    releaseButton(btn: Button): Promise<void>;
    scrollUp(n: number): Promise<void>;
    scrollDown(n: number): Promise<void>;
    scrollLeft(n: number): Promise<void>;
    scrollRight(n: number): Promise<void>;
  };
  export const keyboard: {
    pressKey(...keys: Key[]): Promise<void>;
    releaseKey(...keys: Key[]): Promise<void>;
    type(text: string): Promise<void>;
  };
  export const screen: {
    width(): Promise<number>;
    height(): Promise<number>;
    getAllDisplays(): Promise<Array<{ name?: string; x: number; y: number; width: number; height: number }>>;
  };
}

// ─── screenshot-desktop ───
declare module 'screenshot-desktop' {
  const screenshot: () => Promise<Buffer>;
  export default screenshot;
}

// ─── tesseract.js ───
declare module 'tesseract.js' {
  export interface RecognizeResult {
    data: {
      text: string;
      words?: any[];
      lines?: Array<{ words?: any[] }>;
    };
  }
  export interface Worker {
    recognize(image: Buffer | string): Promise<RecognizeResult>;
    terminate(): Promise<void>;
  }
  export function createWorker(lang: string): Promise<Worker>;
}

// 注：sharp 已真实安装于 node_modules（类型与运行时都走真实包），无需 stub。
