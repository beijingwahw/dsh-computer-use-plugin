import { readShm, readShmStreaming, evictShmFd } from './shmReader.js';
/** GC 兜底注册表 —— handle 被 GC 时调用回调释放 Python 端 shm */
const _finalizer = new FinalizationRegistry((held) => {
    // fire-and-forget：finalizer 内不能 await，但 releaseShm 是异步的
    // 这里只触发，不等结果（Python 端 TTL 60s 后自动 GC 是兜底之上的兜底）
    held.adapter.releaseShm(held.name).catch(() => {
        // 失败无害：Python 端 TTL 会兜底回收
    });
});
/** ScreenshotHandle —— RAII 资源管理器 */
export class ScreenshotHandle {
    _buffer = null;
    _released = false;
    _meta;
    _adapter;
    constructor(meta, adapter) {
        this._meta = meta;
        this._adapter = adapter;
        // 仅 shm / mmap-file 模式需要 release（base64 是内联的，无外部资源）
        if (meta.transport !== 'base64' && meta.name) {
            _finalizer.register(this, { name: meta.name, adapter }, this);
        }
    }
    /** 元数据访问器 —— 调用方可读 width/height/format 等，不可改 */
    get meta() {
        return this._meta;
    }
    /** 是否已释放 */
    get released() {
        return this._released;
    }
    /**
     * 读取截图字节 —— Lazy Buffer。
     *
     * 第一次调用时真正读 shm；后续调用返回缓存的 Buffer（防重读）。
     * 大对象（>1MB）走流式分块读，避免一次性 V8 堆压力。
     */
    async read() {
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
    async *stream() {
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
    async transfer() {
        const buf = await this.read();
        this._released = true;
        _finalizer.unregister(this);
        // 释放 Python 端 shm + 驱逐本地 FD 缓存
        if (this._meta.transport !== 'base64' && this._meta.name) {
            await this._adapter.releaseShm(this._meta.name).catch(() => { });
            await evictShmFd(this._meta.name).catch(() => { });
        }
        return buf;
    }
    /**
     * 显式释放 —— RAII 资源归零。
     *
     * 幂等：多次调用安全。
     * 释放后 read()/stream()/transfer() 都会抛错。
     */
    async release() {
        if (this._released)
            return;
        this._released = true;
        _finalizer.unregister(this);
        // 清空缓存的 Buffer 引用，让 V8 GC 回收
        this._buffer = null;
        if (this._meta.transport !== 'base64' && this._meta.name) {
            await this._adapter.releaseShm(this._meta.name).catch(() => { });
            await evictShmFd(this._meta.name).catch(() => { });
        }
    }
    /** 释放后调用其它方法抛错 */
    _ensureNotReleased() {
        if (this._released) {
            throw new Error(`ScreenshotHandle already released (shm name: ${this._meta.name || 'base64'})`);
        }
    }
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
    _handles = [];
    async add(handlePromise) {
        const handle = await handlePromise;
        this._handles.push(handle);
        return handle;
    }
    async releaseAll() {
        const handles = this._handles;
        this._handles = [];
        await Promise.allSettled(handles.map(h => h.release()));
    }
}
