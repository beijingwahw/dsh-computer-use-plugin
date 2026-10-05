// src/physicalExecution/capToken.ts
// D-5 Cap Token 铸造 —— Node 端自铸（信任根在文件系统，Python 端不持铸造权）。
// 镜像 Python 端 auth.mint_token / parse_token 的字节级一致实现 —— 跨进程契约铁律。
//
// 格式：base64url(payload).base64url(hmac_sha256(payload, key))
// payload = { pid, exp, caps[] } —— 无敏感信息（caps 是声明而非密钥），但仍签名以防篡改。
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname } from 'path';
import type { Capability } from './contracts.js';

/** JWT-style 容错 base64url 编码（去掉 = padding，URL 安全） */
function b64urlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function b64urlDecode(s: string): Uint8Array {
  // base64url 自动补 padding（Buffer.from 支持 base64url 但不容错缺省 padding）
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  return new Uint8Array(Buffer.from(s + pad, 'base64url'));
}

/**
 * 加载或生成 HMAC 密钥（与 Python 端 auth.ensure_key 字节级一致）。
 * 加载层方法：失败 throw —— 拒绝带病上线（异常诚实第一条）。
 *
 * 字节一致性铁律：Python 端 ``secrets.token_bytes(32)`` 与 Node 端 ``randomBytes(32)``
 * 都是 CSPRNG；只要落盘文件被其中一端创建，另一端读取即可，不需两端各自生成。
 *
 * ΠΑΝ-129: **写后回读复核**（对齐 F1-7 在 Python 侧发现的同款地雷 —— Python 端
 * 实测 raw write 约 1 成概率落盘字节漂移，且不回读则首启即"神秘 invalid signature"
 * 且不可自愈）。Node 端 ``writeFile`` 为缓冲写，理论不受该 raw-write 漂移影响；
 * 但两端共享同一密钥文件，防御必须对称：写后立即回读，失配 ⇒ 删掉重写，3 次
 * 不成 ⇒ 加载层 throw（密钥落盘不稳定 = 拒绝带病上线）。顺带兑现 O_EXCL 竞态
 * （``wx`` flag 撞上他进程刚建好的文件 ⇒ EEXIST ⇒ 重读即得合法密钥，不再抛）。
 */
export async function ensureKey(path: string): Promise<Uint8Array> {
  if (existsSync(path)) {
    const data = await readFile(path);
    if (data.length < 32) {
      throw new Error(`auth key ${path} too short (${data.length} bytes, need ≥32)`);
    }
    return new Uint8Array(data);
  }

  // 生成 32 字节随机密钥
  const key = randomBytes(32);
  await mkdir(dirname(path), { recursive: true });
  // 父目录权限收口（与 Python 端一致）
  try {
    const { chmod } = await import('fs/promises');
    await chmod(dirname(path), 0o700);
  } catch {
    // 父目录非己有：只读使用，不强制改权限（CI 容器场景）
  }
  // ΠΑΝ-129: 写后回读复核 —— 最多 3 轮「O_EXCL 写 + 回读比对」，失配删掉诚实
  // 重写，绝不静默用漂移字节（对齐 Python 端 ensure_key 的 3 轮方言）。
  const { unlink } = await import('fs/promises');
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // O_EXCL 等价：用 'wx' flag（写入时文件必须不存在）
      await writeFile(path, key, { mode: 0o600, flag: 'wx' });
    } catch (e: any) {
      if (e?.code === 'EEXIST') {
        // O_EXCL 竞态：他进程刚建好密钥 —— 重读即得合法密钥（与 Python 端同款）
        const raced = await readFile(path);
        if (raced.length < 32) {
          throw new Error(`auth key ${path} too short (${raced.length} bytes, need ≥32)`);
        }
        return new Uint8Array(raced);
      }
      throw e;
    }
    // 写后回读：盘上字节必须与内存副本逐字节一致
    const onDisk = await readFile(path);
    if (onDisk.length === key.length && timingSafeEqual(onDisk, key)) {
      return new Uint8Array(key);
    }
    // 漂移落盘：删掉诚实重写
    try {
      await unlink(path);
    } catch {
      // 删除失败（如竞态被他进程接管）：下一轮 wx 会再撞 EEXIST 走重读路径
    }
  }
  throw new Error(
    `auth key ${path} persisted bytes diverge from generated key after 3 attempts — `
    + 'refusing to start with a key whose on-disk form is unstable',
  );
}

/** Cap Token 载荷 —— 与 Python 端 auth.mint_token payload 结构严格一致 */
export interface CapTokenPayload {
  pid: number;
  exp: number;        // Unix 秒
  caps: Capability[];
}

/**
 * 铸造 Capability Token。
 * 运行层方法：永不抛错 —— 失败时返回空串，调用方降级（仅诊断模式）。
 */
export function mintToken(
  key: Uint8Array,
  pid: number,
  caps: readonly Capability[],
  ttlSeconds: number,
): string {
  const payload: CapTokenPayload = {
    pid,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
    caps: [...caps],
  };
  const payloadBytes = new Uint8Array(
    Buffer.from(JSON.stringify(payload), 'utf-8'),
  );
  const sig = createHmac('sha256', Buffer.from(key)).update(payloadBytes).digest();
  return b64urlEncode(payloadBytes) + '.' + b64urlEncode(new Uint8Array(sig));
}

/**
 * 解析 Cap Token —— 镜像 Python 端 parse_token。
 * 仅供诊断/调试使用（Node 端自铸后通常无需自验）。
 * 运行层方法：永不抛错。
 */
export function parseToken(
  key: Uint8Array,
  token: string,
): { ok: true; payload: CapTokenPayload } | { ok: false; reason: string } {
  if (!token || !token.includes('.')) {
    return { ok: false, reason: 'malformed token: missing . separator' };
  }
  // 恰好两段：多出的 '.' 段不静默丢弃 —— Python 端 split('.', 1) 会把多段签名
  // 判为签名失配而拒绝，Node 端忽略尾段会把 "payload.sig.junk" 形态错放行。
  const parts = token.split('.');
  if (parts.length !== 2) {
    return { ok: false, reason: 'malformed token: expected exactly one . separator' };
  }
  const [payloadB64, sigB64] = parts;
  if (!payloadB64 || !sigB64) {
    return { ok: false, reason: 'malformed token: empty segments' };
  }
  let payloadBytes: Uint8Array;
  let sig: Uint8Array;
  try {
    payloadBytes = b64urlDecode(payloadB64);
    sig = b64urlDecode(sigB64);
  } catch (e: any) {
    return { ok: false, reason: `base64 decode failed: ${e.message}` };
  }

  const expectedSig = createHmac('sha256', Buffer.from(key)).update(payloadBytes).digest();
  const expected = new Uint8Array(expectedSig);
  if (expected.length !== sig.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) {
    return { ok: false, reason: 'invalid signature' };
  }

  let payload: CapTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(payloadBytes).toString('utf-8'));
  } catch (e: any) {
    return { ok: false, reason: `payload JSON parse failed: ${e.message}` };
  }
  if (typeof payload?.pid !== 'number') {
    return { ok: false, reason: 'payload.pid is not number' };
  }
  if (typeof payload?.exp !== 'number' || Date.now() / 1000 > payload.exp) {
    return { ok: false, reason: 'token expired' };
  }
  if (!Array.isArray(payload?.caps)) {
    return { ok: false, reason: 'payload.caps is not array' };
  }
  return { ok: true, payload };
}

/** Nonce 生成（X-Request-Id 防重放） */
export function mintNonce(): string {
  return randomBytes(16).toString('hex');
}
