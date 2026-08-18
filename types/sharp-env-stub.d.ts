// types/sharp-env-stub.d.ts
// 沙箱环境补丁（非 D-5 代码）：sharp 是平台二进制包，沙箱私有 registry 不可安装。
// dsh-stubs.d.ts 的既定前提是「sharp 已真实安装于 node_modules」—— 真机环境满足该前提时
// 本文件因模块已被真实包解析而自然失效；仅在此类无网沙箱中提供最小类型面。
// 按项目实际使用面声明（dsh-stubs 同方言）；运行时由宿主环境提供真实实现。
declare module 'sharp' {
  interface Sharp {
    grayscale(): Sharp;
    /** 位置参数形式：resize(w, h?, fit?) */
    resize(width: number, height?: number, opts?: { fit?: string }): Sharp;
    /** 对象参数形式：resize({ width }) / resize({ width, height, fit }) —— 项目内主流用法 */
    resize(options: { width?: number; height?: number; fit?: string }): Sharp;
    extract(region: { left: number; top: number; width: number; height: number }): Sharp;
    raw(): Sharp;
    /** 通道统计（亮度均值/标准差）：intent 规则与 popupDetector 几何证据的消费面 */
    stats(): Promise<{ channels: Array<{ mean: number; stdev: number }> }>;
    toBuffer(opts?: { resolveWithObject?: boolean }): Promise<any>;
    metadata(): Promise<{ width?: number; height?: number; format?: string }>;
    composite(layers: Array<{ input: any; top?: number; left?: number }>): Sharp;
    jpeg(opts?: { quality?: number }): Sharp;
    png(opts?: Record<string, unknown>): Sharp;
    toFile(path: string): Promise<any>;
  }
  /** 第二参数：raw 像素缓冲输入（合成测试图的铸造面） */
  function sharp(
    input?: any,
    options?: { raw?: { width: number; height: number; channels: number } },
  ): Sharp;
  export default sharp;
}
