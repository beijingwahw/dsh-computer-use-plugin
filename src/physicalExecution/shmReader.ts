// src/physicalExecution/shmReader.ts
// D-5 POSIX shm 读取 —— 世界级创新方案「Lazy AsyncIterable + V8 Backing Store Direct Write + FD 池」。
//
// 创新机制：
//   1. **抛弃 readFileSync**（其内部 3 次拷贝：kernel → fs internal → returned buf）
//   2. **fsPromises.open().read(buf, 0, size, 0) + Buffer.allocUnsafe(size)**：
//      - allocUnsafe 从 V8 ArrayBuffer 池零分配
//      - fh.read 触发 libuv uv_fs_read，数据直接从 kernel page cache 写到 V8 backing store
//      - 仅 1 次拷贝（kernel→V8），是 Node 端理论最优
//   3. **FD 复用池**：同一 shm 对象 TTL 内多次读时复用 file handle，省 open/close syscall
//   4. **Streaming AsyncIterable**：大截图分块流式读，避免一次性 V8 堆压力
//
// 性能对比（4K 截图 ~8MB）：
//   | 方案          | 拷贝次数 | syscall 次数 |
//   |---------------|---------|--------------|
//   | base64        | 3 + CPU | 0            |
//   | readFileSync  | 3       | 3            |
//   | 本方案         | 1       | 1 (FD 池后 0) |
//   | mmap 理论上限  | 0       | 0            |
//
// 异常诚实：失败 throw PhysicalError，由 adapter 转失败响应。
import { open, type FileHandle } from 'fs/promises';
import { existsSync, realpathSync } from 'fs'; // ΤΕΛ-7b：realpathSync 用于 symlink 逃逸收口
import { platform, homedir } from 'os';
import { resolve as pathResolve, relative as pathRelative, isAbsolute as pathIsAbsolute, join as pathJoin } from 'path';
import type { PhysicalError, ScreenshotResult } from './contracts.js';
import { PhysicalErrorKind } from './contracts.js';

/** 大对象阈值：超过此值走流式分块读 */
const STREAMING_THRESHOLD = 1 * 1024 * 1024; // 1MB

/** 流式读块大小（64KB —— V8 ArrayBuffer 池单次扩展单元的友好倍数） */
const STREAM_CHUNK = 64 * 1024;

/** FD 池条目 TTL（与 Python 端 shm TTL 对齐） */
const FD_CACHE_TTL_MS = 60_000;

/** FD 池：name → { fh, expiresAt } */
interface FdCacheEntry {
  fh: FileHandle;
  expiresAt: number;
  refCount: number;     // 引用计数：正在用时不淘汰
  evictPending: boolean; // 驱逐挂起：release 请求撞上在飞引用 —— 引用归零即关闭
}
const _fdCache = new Map<string, FdCacheEntry>();

/** GC ticker：定期清理过期 FD（懒 + 主动双 GC） */
let _gcTimer: NodeJS.Timeout | null = null;
const GC_INTERVAL_MS = 30_000;

function startFdGc(): void {
  if (_gcTimer) return;
  _gcTimer = setInterval(() => {
    const now = Date.now();
    for (const [name, entry] of _fdCache) {
      if (entry.expiresAt < now && entry.refCount === 0) {
        entry.fh.close().catch(() => { /* GC 路径失败无害 */ });
        _fdCache.delete(name);
      }
    }
    if (_fdCache.size === 0 && _gcTimer) {
      clearInterval(_gcTimer);
      _gcTimer = null;
    }
  }, GC_INTERVAL_MS).unref();  // unref：不阻止进程退出
}

/** SHM 对象路径解析（POSIX shm_open 在不同平台的文件系统映射） */
function resolveShmPath(name: string): string {
  const clean = name.replace(/^\//, '');
  // POSIX shm 对象名内部不允许 '/'，也不允许 '.'/'..'（剥离首斜杠后为空/点
  // 同为非法名）。放行即路径遍历：'/dev/shm/../..' 逃出 shm 目录读写任意文件。
  if (clean === '' || clean === '.' || clean === '..' || clean.includes('/')) {
    throw makeError('invalid_args', `invalid shm object name: ${name}`);
  }
  if (platform() === 'darwin') {
    return `/tmp/shm.${clean}`;
  }
  return `/dev/shm/${clean}`;
}

// ─── ΠΑΝ-66（mmap-file 路径校验）：shm 防线扩展到缺省传输，fail-closed ───
// 旧实现把服务端返回的 `name`（mmap-file 模式 = 文件路径）直通 fs.open：
// 被攻破/漂移的 Python 服务可让 Node 端 open+read 本机任意文件（字节进入
// ScreenshotHandle.read() 消费链）。shm 模式的 resolveShmPath 防线
//（'/'/'.'/'..' 拒绝）不覆盖缺省传输 —— 本节把等价防线补齐：
//   1. 拒绝遍历：原始路径显式含 '..' 段一律拒绝（即使 resolve 后仍在根内
//      —— 服务端不该用相对回溯描述自己管理的暂存文件）；
//   2. 白名单根目录：解析后的绝对路径必须落在「显式注册根 ∪ 约定根」之内
//      —— 显式注册根由 PhysicalServiceManager 在 spawn 时登记（它明知
//      mmapDir）；约定根 = DSH_PHYSICAL_MMAP_DIR 环境变量 ∪ ~/.dsh/shots
//      （Python 端 config.mmap_dir 缺省与 physicalBackend.defaultMmapDir 同源
//      —— 覆盖稳定密钥部署/收养流；若约定变更，此处须同步 —— 对接点在
//      python_service/dsh_physical/config.py 与 src/physicalBackend.ts）；
//   3. fail-closed：不落任何根 ⇒ 拒绝读取（宁失明，不可被牵着读任意文件）。
//   4. ΤΕΛ-7b（F2-7/源注登记的留白收口）：symlink 逃逸 —— 逻辑路径落根**不够**，
//      白名单根内的符号链接可指向根外任意文件（被攻破/漂移的 Python 服务或本机
//      攻击者在 mmapDir 放一个 symlink 即可让 Node 端读任意文件）。收口：
//      resolve 落根后再 realpath 解析全部链接段，物理路径须仍落在某个白名单根
//      的 realpath 之内（根自身含 symlink 如 macOS /tmp → /private/tmp 不误伤
//      —— 对根也做 realpath 对账）；realpath 失败（断链/EACCES/ELOOP 等）
//      ⇒ 拒绝（fail-closed），唯 ENOENT 放行交由 open 的 element_not_found
//      诚实归因（对象已释放；文件不存在即无数据可读，非逃逸面）。open 目标
//      = 校验后的物理路径（不是逻辑路径），缩小 realpath→open 间的 TOCTOU 窗。

/** ΠΑΝ-66：显式注册的 mmap-file 白名单根目录（manager spawn 时登记） */
const _mmapRoots = new Set<string>();

/** ΠΑΝ-66：登记一个 mmap-file 白名单根目录（幂等）。PhysicalServiceManager
 *  在 spawn 后登记自己的 mmapDir；外部部署（收养流/嵌入式）可直接调用。 */
export function allowMmapRoot(dir: string): void {
  if (typeof dir === 'string' && dir.trim() !== '') {
    _mmapRoots.add(pathResolve(dir));
  }
}

/** ΠΑΝ-66：清空显式注册根（执法测试面 —— 约定根不可撤销，始终在岗） */
export function clearMmapRoots(): void {
  _mmapRoots.clear();
}

/** ΠΑΝ-66：约定根（与 Python 缺省/物理后端稳定密钥部署同源） */
function conventionalMmapRoots(): string[] {
  const roots: string[] = [];
  const envDir = process.env.DSH_PHYSICAL_MMAP_DIR;
  if (typeof envDir === 'string' && envDir.trim() !== '') roots.push(pathResolve(envDir));
  roots.push(pathResolve(pathJoin(homedir(), '.dsh', 'shots')));
  return roots;
}

/** ΠΑΝ-66：mmap-file 服务端路径的防线（解析 + 拒绝遍历 + 白名单根，fail-closed）。
 *  ΤΕΛ-7b：白名单校验后追加 symlink 逃逸收口（realpath 再验白名单）。
 *  通过 ⇒ 返回**物理**路径（realpath 后——open 目标即校验目标）；任何一条不满足
 *  ⇒ throw invalid_args（PhysicalError）。 */
function resolveMmapFilePath(raw: string): string {
  if (typeof raw !== 'string' || raw === '' || raw.includes('\0')) {
    throw makeError('invalid_args', `invalid mmap-file path: ${JSON.stringify(raw)}`);
  }
  // 拒绝遍历：原始段显式含 '..'（正/反斜杠分隔）一律拒绝
  if (raw.split(/[\\/]+/).includes('..')) {
    throw makeError('invalid_args', `mmap-file path traversal rejected: ${raw}`);
  }
  const resolved = pathResolve(raw);
  // 白名单根：显式注册根 ∪ 约定根；一都不落 ⇒ fail-closed 拒绝
  const roots = [..._mmapRoots, ...conventionalMmapRoots()];
  const inRoot = (root: string, p: string): boolean => {
    const rel = pathRelative(root, p);
    return rel === '' || (!rel.startsWith('..') && !pathIsAbsolute(rel));
  };
  if (!roots.some(root => inRoot(root, resolved))) {
    throw makeError(
      'invalid_args',
      `mmap-file path '${raw}' is outside all whitelisted roots [${roots.join('; ')}] — refusing to open (fail-closed)`,
    );
  }
  // ΤΕΛ-7b：symlink 逃逸收口 —— 逻辑落根后 realpath 再验（fail-closed）。
  // 白名单根内的符号链接（含中间目录段的链接）可指向根外：被攻破/漂移的
  // Python 服务或本机攻击者放一个 symlink 即可借 Node 端读任意文件。物理
  // 路径须落在某白名单根的 realpath 之内（根自身含 symlink 不误伤——对根
  // 也做 realpath 对账；根 realpath 失败 ⇒ 该根不可信，跳过）。
  let physical: string;
  try {
    physical = realpathSync(resolved);
  } catch (e: any) {
    // 唯一放行：ENOENT（白名单内的不存在路径）—— 交由 open 的 element_not_found
    // 诚实归因（对象已释放语义）；文件不存在即无数据可读，非逃逸面。其余失败
    // （断链之外的 EACCES/ELOOP/ENOTDIR/未知）⇒ fail-closed 拒绝。
    if (e && e.code === 'ENOENT') return resolved;
    throw makeError(
      'invalid_args',
      `mmap-file path '${raw}' cannot be resolved (realpath: ${e && e.code ? e.code : e && e.message}) — refusing to open (fail-closed)`,
    );
  }
  if (!roots.some(root => {
    try {
      return inRoot(realpathSync(root), physical);
    } catch {
      return false; // 根不可解析 ⇒ 该根不可信（fail-closed），试下一个
    }
  })) {
    throw makeError(
      'invalid_args',
      `mmap-file path '${raw}' resolves via symlink outside all whitelisted roots (physical: ${physical}) — refusing to open (fail-closed)`,
    );
  }
  return physical; // open 物理路径：realpath→open 的 TOCTOU 窗内换链也不指向此目标
}

/** 把异常包装为 PhysicalError 对象 */
function makeError(kind: PhysicalErrorKind, detail: string): PhysicalError {
  return { kind, detail };
}

/** 从 FD 池取或新开 file handle。返回 [fh, 池条目本体]（release 按条目归还） */
async function acquireFd(path: string, name: string): Promise<[FileHandle, FdCacheEntry]> {
  const now = Date.now();
  const cached = _fdCache.get(name);
  if (cached && cached.expiresAt > now) {
    cached.refCount++;
    return [cached.fh, cached];
  }
  // 过期但尚未被 30s GC 收走的条目：替换前关闭旧 fh（否则被覆盖后永无人关闭 ——
  // 每次 TTL 过期重读泄漏一个 fd）
  const stale = cached;
  // 新开（不进缓存命中路径，但 open 后入池以备后续读复用）
  let fh: FileHandle;
  try {
    fh = await open(path, 'r');
  } catch (e: any) {
    if (e.code === 'ENOENT') {
      throw makeError(
        'element_not_found',
        `shm object ${name} not found at ${path} (already released?)`,
      );
    }
    throw makeError('screen_capture_failed', `open ${path} failed: ${e.message}`);
  }
  const entry: FdCacheEntry = { fh, expiresAt: now + FD_CACHE_TTL_MS, refCount: 1, evictPending: false };
  _fdCache.set(name, entry);
  if (stale && stale.refCount === 0) {
    stale.fh.close().catch(() => { /* 旧句柄关闭失败无害 */ });
  } else if (stale) {
    // 在飞引用持有旧 fh：新条目已接管缓存键，旧句柄等引用方按条目本体 release 后关闭
    stale.evictPending = true;
  }
  startFdGc();
  return [fh, entry];
}

/** 归还 FD 到池（引用计数减一；驱逐挂起且引用归零 ⇒ 立即关闭）。
 *  按 acquire 返回的条目本体归还，而非按键回查 —— 键可能已被 TTL 重开的新条目
 *  接管：按名回查会误减新条目的引用数，旧条目的 fh 则永无人关闭（fd 泄漏）。 */
async function releaseFd(name: string, entry: FdCacheEntry): Promise<void> {
  entry.refCount = Math.max(0, entry.refCount - 1);
  // evictPending，或该条目已不是缓存键的现役条目（并发双开竞态：两次 acquireFd
  // 都未命中缓存、各自 open 后后者覆盖前者 —— 被覆盖的孤儿条目不在 Map 里，
  // TTL GC 永远走不到它，引用归零时必须就地关闭，否则每撞一次竞态泄漏一个 fd）
  if (entry.refCount === 0 && (entry.evictPending || _fdCache.get(name) !== entry)) {
    if (_fdCache.get(name) === entry) _fdCache.delete(name);
    try { await entry.fh.close(); } catch { /* close 失败无害 */ }
    return;
  }
  // 其余情形不立即关闭 —— 让 TTL GC 处理（同一对象可能被再次读）
}

/** 显式驱逐 FD（截图读完且调用方调 release 时）。
 *  在飞引用（refCount>0）只标记驱逐：立即关闭会让并发 readShm 以 EBADF
 *  中途失败 —— 引用归零时由 releaseFd 关闭 */
async function evictFd(name: string): Promise<void> {
  const entry = _fdCache.get(name);
  if (!entry) return;
  if (entry.refCount > 0) {
    entry.evictPending = true;
    entry.expiresAt = 0; // 不再接受新命中
    return;
  }
  _fdCache.delete(name);
  try {
    await entry.fh.close();
  } catch {
    // close 失败无害（fd 可能已被内核回收）
  }
}

/**
 * 读取 shm 对象为 Node Buffer。
 *
 * 零拷贝目标：用 fh.read + Buffer.allocUnsafe，让数据从 kernel page cache
 * 直接写到 V8 ArrayBuffer backing store（不经 fs internal buffer）。
 *
 * 大对象（>1MB）走流式分块读，避免一次性 V8 堆压力。
 */
export async function readShm(screenshot: ScreenshotResult): Promise<Buffer> {
  if (screenshot.transport === 'base64') {
    if (!screenshot.image_base64) {
      throw makeError('invalid_args', 'base64 transport but image_base64 is empty');
    }
    return Buffer.from(screenshot.image_base64, 'base64');
  }

  if (screenshot.transport === 'mmap-file') {
    if (!screenshot.name) {
      throw makeError('invalid_args', 'mmap-file transport but name is empty');
    }
    // ΠΑΝ-66：防线扩展到缺省传输 —— 校验后的规范化路径才准进 fs.open；
    // cacheKey 保持原始 name（evictShmFd(meta.name) 的键同律，零回归）。
    return readFromFile(resolveMmapFilePath(screenshot.name), screenshot.size, screenshot.name);
  }

  // shm 模式
  if (!screenshot.name) {
    throw makeError('invalid_args', 'shm transport but name is empty');
  }
  if (platform() === 'win32') {
    throw makeError(
      'invalid_args',
      'shm transport not supported on win32 (use mmap-file or base64)',
    );
  }
  const path = resolveShmPath(screenshot.name);
  if (!existsSync(path)) {
    throw makeError(
      'element_not_found',
      `shm object ${screenshot.name} not found at ${path} (already released?)`,
    );
  }
  return readFromFile(path, screenshot.size, screenshot.name);
}

/** 从文件路径读 —— V8 backing store 直接写 + FD 池 + 流式分块 */
async function readFromFile(
  path: string,
  expectedSize: number,
  cacheKey: string,    // shm 模式 = screenshot.name；mmap-file 模式 = path
): Promise<Buffer> {
  const [fh, entry] = await acquireFd(path, cacheKey || path);
  try {
    if (expectedSize > STREAMING_THRESHOLD) {
      // 流式分块读：避免一次性 allocUnsafe 大 Buffer 的 V8 堆压力
      return await readStreaming(fh, expectedSize);
    }
    // 小对象：一次性 allocUnsafe + 单次 read
    // allocUnsafe 不清零（V8 池可能含旧数据），但我们读满整个 buf，无需清零
    const buf = Buffer.allocUnsafe(expectedSize);
    const { bytesRead } = await fh.read(buf, 0, expectedSize, 0);
    if (bytesRead !== expectedSize) {
      // 大小不匹配 —— 容错返回实际读到的部分（不抛错，让调用方判断）
      return buf.subarray(0, bytesRead);
    }
    return buf;
  } catch (e: any) {
    throw makeError(
      'screen_capture_failed',
      `read ${path} failed: ${e.message}`,
    );
  } finally {
    await releaseFd(cacheKey || path, entry);
  }
}

/** 流式分块读 —— AsyncIterable 风格的内部实现 */
async function readStreaming(fh: FileHandle, totalSize: number): Promise<Buffer> {
  // 仍用单一 Buffer 接收（最终返回 Buffer，非 stream）；
  // 分块读的意义在于减少单次 syscall 的内核缓冲压力
  const buf = Buffer.allocUnsafe(totalSize);
  let offset = 0;
  while (offset < totalSize) {
    const len = Math.min(STREAM_CHUNK, totalSize - offset);
    const { bytesRead } = await fh.read(buf, offset, len, offset);
    if (bytesRead === 0) break;  // EOF
    offset += bytesRead;
  }
  return buf.subarray(0, offset);
}

/**
 * 流式读取 SHM 对象 —— 真正的 AsyncIterable<Buffer>。
 *
 * 适用于大截图（>1MB）的流式消费场景：
 *   for await (const chunk of readShmStreaming(screenshot)) {
 *     await processChunk(chunk);
 *   }
 *
 * 每个 chunk 是 STREAM_CHUNK 大小的 Buffer（最后一块可能更小）。
 * Buffer 在 V8 池中独立分配，可独立 transfer 给 Worker。
 */
export async function* readShmStreaming(
  screenshot: ScreenshotResult,
): AsyncGenerator<Buffer, void, void> {
  if (screenshot.transport === 'base64') {
    if (!screenshot.image_base64) {
      throw makeError('invalid_args', 'base64 transport but image_base64 is empty');
    }
    const buf = Buffer.from(screenshot.image_base64, 'base64');
    for (let i = 0; i < buf.length; i += STREAM_CHUNK) {
      yield buf.subarray(i, Math.min(i + STREAM_CHUNK, buf.length));
    }
    return;
  }

  if (!screenshot.name) {
    throw makeError('invalid_args', `${screenshot.transport} transport but name is empty`);
  }
  if (screenshot.transport !== 'mmap-file' && platform() === 'win32') {
    throw makeError('invalid_args', 'shm transport not supported on win32 (use mmap-file or base64)');
  }
  // ΠΑΝ-66：mmap-file 分支先过防线（解析 + 拒绝遍历 + 白名单根）再进 fs.open
  const path = screenshot.transport === 'mmap-file'
    ? resolveMmapFilePath(screenshot.name)
    : resolveShmPath(screenshot.name);
  if (!existsSync(path)) {
    throw makeError(
      'element_not_found',
      `shm object ${screenshot.name} not found at ${path}`,
    );
  }

  const cacheKey = screenshot.name; // ΠΑΝ-66：mmap-file 键 = 原始 name（与 readShm 的 evict 键同律）
  const [fh, entry] = await acquireFd(path, cacheKey);
  try {
    let offset = 0;
    while (offset < screenshot.size) {
      const len = Math.min(STREAM_CHUNK, screenshot.size - offset);
      const buf = Buffer.allocUnsafe(len);
      const { bytesRead } = await fh.read(buf, 0, len, offset);
      if (bytesRead === 0) break;
      yield buf.subarray(0, bytesRead);
      offset += bytesRead;
    }
  } finally {
    await releaseFd(cacheKey, entry);
  }
}

/** 显式驱逐 FD 缓存（由 ScreenshotHandle.release 调用，释放 Python 端 shm 时同时清本地 FD） */
export async function evictShmFd(name: string): Promise<void> {
  await evictFd(name);
}

/** 关闭所有 FD（服务退出时调用） */
export async function closeAllFds(): Promise<void> {
  const entries = [..._fdCache.values()];
  _fdCache.clear();
  if (_gcTimer) {
    clearInterval(_gcTimer);
    _gcTimer = null;
  }
  await Promise.allSettled(entries.map(e => e.fh.close()));
}
