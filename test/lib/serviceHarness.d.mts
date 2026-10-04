// test/lib/serviceHarness.d.mts
// ΝΩ-49 共享基建的类型面（先例：scripts/gen_config_docs.d.mts —— .mjs 旁座声明）。
import type { ChildProcess } from 'node:child_process';

/** 仓库根（test/lib → 上两级） */
export declare const REPO_ROOT: string;

/** 探活上限缺省（25s —— 上限非耗时：实际启动 ~2s） */
export declare const DEFAULT_PROBE_TIMEOUT_MS: number;

/** 随机空闲端口（listen(0) 后即释放 —— 与绑定之间存在理论竞态窗，仓库先例接受） */
export declare function freePort(): Promise<number>;

/** 一次性 HMAC 密钥 tmp 文件（32B 熵 hex 落盘，mode 0600）；调用方负责 cleanup */
export declare function makeTempKey(prefix?: string): {
  dir: string;
  keyPath: string;
  cleanup: () => void;
};

/** 起服务的回执形态（与 epochSigma.display 的 PyService 同形） */
export interface PyService {
  proc: ChildProcess;
  port: number;
  keyPath: string;
  tmpDir: string;
  baseUrl: string;
  pyOut: string;
  /** 累计的 stdout/stderr 尾迹（快照读） */
  readonly output: string;
}

/** 起真实 Python 微服务：随机空闲端口 + 一次性密钥 + 探活。
 *  env 可为静态对象（合并于 process.env 之上）或构建函数（收动态 port/keyPath）。
 *  探活失败/启动即退 ⇒ 返回 null 并清场（调用方按仓库先例 skip，不判 fail）。 */
export declare function startPythonService(opts?: {
  env?: Record<string, string> | ((ctx: { port: number; keyPath: string; baseUrl: string }) => Record<string, string>);
  probeTimeoutMs?: number;
  bin?: string;
  cwd?: string;
}): Promise<PyService | null>;

/** 关停 + 清场（kill + 删密钥 tmp 目录；幂等，不抛） */
export declare function stopPythonService(svc: PyService | null): void;
