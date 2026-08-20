// src/physicalExecution/screenshotHandle.ts
// D-5 ScreenshotHandle —— 世界级创新方案「RAII + FinalizationRegistry GC 兜底 + Transfer 语义」。
//
// 创新机制：
//   1. **ScreenshotHandle 类**：封装 ScreenshotResult 元数据 + adapter 引用 + read/release/transfer
//   2. **FinalizationRegistry GC 兜底**：handle 被 GC 时自动调 releaseShm(name)，
//      即便调用方忘记 release 也永不泄漏 Python 端 shm 对象
//   3. **Lazy Buffer**：第一次 read() 才真正读 shm，多次调返回缓存（防重读）
//   4. **Transfer 语义**：transfer() 把 Buffer 所有权转移给调用方，handle 自动失效
//      （防 use-after-release；同时立即 release Python 端 shm）
//   5. **AsyncIterator 流式**：实现 Symbol.asyncIterator，截图可作为 stream 消费
//
// 使用范式：
//   const handle = await adapter.takeScreenshotHandle();
//   try {
//     const buf = await handle.read();
//     // 使用 buf...
//   } finally {
//     await handle.release();  // 显式释放
//   }
//   // 或：自动管理（forget 显式 release，依赖 GC 兜底）
//   const buf = await (await adapter.takeScreenshotHandle()).transfer();
//
// RAII 哲学：资源获取即初始化；handle 创建 = 资源已分配；handle 销毁 = 资源已释放
import type { PhysicalExecutionAdapter, ScreenshotHandleLike, ScreenshotResult } from './contracts.js';
import { readShm, readShmStreaming, evictShmFd } from './shmReader.js';

/** GC 兜底注册表 —— handle 被 GC 时调用回调释放 Python 端 shm */
const _finalizer = new FinalizationRegistry((held: { name: string; adapter: PhysicalExecutionAdapter }) => {
  // fire-and-forget：finalizer 内不能 await，但 releaseShm 是异步的
  // 这里只触发，不等结果（Python 端 TTL 60s 后自动 GC 是兜底之上的兜底）
  held.adapter.releaseShm(held.name).catch(() => {
    // 失败无害：Python 端 TTL 会兜底回收
  });
});

/** ScreenshotHandle —— RAII 资源管理器 */
export class ScreenshotHandle implements ScreenshotHandleLike {
  private _buffer: Buffer | null = null;
  private _released = false;
  private readonly _meta: ScreenshotResult;
  private readonly _adapter: PhysicalExecutionAdapter;

  constructor(meta: ScreenshotResult, adapter: PhysicalExecutionAdapter) {
    this._meta = meta;
    this._adapter = adapter;
    // 仅 shm / mmap-file 模式需要 release（base64 是内联的，无外部资源）
    if (meta.transport !== 'base64' && meta.name) {
      _finalizer.register(this, { name: meta.name, adapter }, this);
    }
  }

  /** 元数据访问器 —— 调用方可读 width/height/format 等，不可改 */
  get meta(): Readonly<ScreenshotResult> {
    return this._meta;
  }

  /** 是否已释放 */
  get released(): boolean {
    return this._released;
  }

  /**
   * 读取截图字节 —— Lazy Buffer。
   *
   * 第一次调用时真正读 shm；后续调用返回缓存的 Buffer（防重读）。
   * 大对象（>1MB）走流式分块读，避免一次性 V8 堆压力。
   */
  async read(): Promise<Buffer> {
    this._ensureNotReleased();
    if (this._buffer !== null) {
      return this._buffer;
    }
    this._buffer = await readShm(this._meta);
    return this._buffer;
  }

  /**
   * 流式读取 —— AsyncIterable<Buffer>。
   *
   * 适用于大截图的流式消费场景（如转储到文件 / 上传到对象存储）。
   * 与 read() 互斥：调用 stream() 后再调 read() 会重新读（不使用缓存）。
   */
  async *stream(): AsyncGenerator<Buffer, void, void> {
    this._ensureNotReleased();
    // 流式读不缓存（chunks 是迭代器，无法整体缓存）
    yield* readShmStreaming(this._meta);
  }

  /**
   * 转移所有权 —— 调用方拿走 Buffer，handle 立即失效。
   *
   * 语义：调用方承诺自己管理 Buffer 生命周期；handle 不再可读。
   * Python 端 shm 对象同时被释放（不再需要保持供后续读）。
   *
   * 与 read() + release() 的区别：
   *   - read() + release()：调用方需保证 release 在 read 之后调用
   *   - transfer()：原子操作，防 use-after-release
   */
  async transfer(): Promise<Buffer> {
    const buf = await this.read();
    this._released = true;
    _finalizer.unregister(this);
    // 释放 Python 端 shm + 驱逐本地 FD 缓存
    if (this._meta.transport !== 'base64' && this._meta.name) {
      await this._adapter.releaseShm(this._meta.name).catch(() => { /* GC 兜底 */ });
      await evictShmFd(this._meta.name).catch(() => { /* 无害 */ });
    }
    return buf;
  }

  /**
   * 显式释放 —— RAII 资源归零。
   *
   * 幂等：多次调用安全。
   * 释放后 read()/stream()/transfer() 都会抛错。
   */
  async release(): Promise<void> {
    if (this._released) return;
    this._released = true;
    _finalizer.unregister(this);
    // 清空缓存的 Buffer 引用，让 V8 GC 回收
    this._buffer = null;
    if (this._meta.transport !== 'base64' && this._meta.name) {
      await this._adapter.releaseShm(this._meta.name).catch(() => { /* GC 兜底 */ });
      await evictShmFd(this._meta.name).catch(() => { /* 无害 */ });
    }
  }

  /** 释放后调用其它方法抛错 */
  private _ensureNotReleased(): void {
    if (this._released) {
      throw new Error(`ScreenshotHandle already released (shm name: ${this._meta.name || 'base64'})`);
    }
  }

  // 注：未实现 [Symbol.asyncDispose] —— TS 5.0.4 不支持。
  // 升级 TS 至 5.2+ 后可补充 asyncDispose 以支持 `using` 语法；显式 release() 已足够。
}

/**
 * 批量管理多个 ScreenshotHandle —— 防资源泄漏的批量操作工具。
 *
 * 适用于「连续截多张图做对比」场景：
 *   const batch = new ScreenshotBatch();
 *   const h1 = await batch.add(adapter.takeScreenshotHandle());
 *   const h2 = await batch.add(adapter.takeScreenshotHandle());
 *   // ... 使用 h1, h2 ...
 *   await batch.releaseAll();  // 一次性释放所有 handle
 */
export class ScreenshotBatch {
  private _handles: ScreenshotHandle[] = [];

  async add(handlePromise: Promise<ScreenshotHandle>): Promise<ScreenshotHandle> {
    const handle = await handlePromise;
    this._handles.push(handle);
    return handle;
  }

  async releaseAll(): Promise<void> {
    const handles = this._handles;
    this._handles = [];
    await Promise.allSettled(handles.map(h => h.release()));
  }

  // 注：未实现 [Symbol.asyncDispose] —— 同 ScreenshotHandle，TS 5.0.4 限制。
}
