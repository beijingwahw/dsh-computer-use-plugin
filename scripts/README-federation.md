# federation-server 部署指南（W9-2 · DEBTS D-C2/D-C5 落锤）

`scripts/federation-server.mjs` 是纪元 Μ2/W5-3 的联邦聚合 + barrier 中继服务。
参考实现口径：仅绑定 `127.0.0.1`、无限速、无 TLS。本文是生产化部署面 ——
**全部 env 可选，缺席时行为与参考实现逐字节一致**（生产化是能力，不是缺省切换）。

## 运行

```bash
node scripts/federation-server.mjs [--port N]
```

## 环境变量

| env | 缺省 | 说明 |
| --- | --- | --- |
| `DSH_FED_PORT` | `18433` | 监听口。`--port` 参数优先；`--port 0` = 随机可用口。 |
| `DSH_FED_MAX_BODY_BYTES` | `1048576`（1MB） | 请求体上限（超限 413）。上界 64MB。 |
| `DSH_FEDERATION_TOKEN` | 未设置 | HMAC-SHA256 共享密钥。**设置后** `/aggregate` 与 barrier 三端点（`allocate`/`commit`/`status`）缺省强制请求签名（生产姿态）。 |
| `FED_ALLOW_OPEN_BARRIER` | 未设置 | `=1` 且已设密钥时，barrier 三端点保持开放（参考拓扑兼容模式 —— 部署方显式声明该面由反代/网络层收口时的过渡姿势）。`/aggregate` 仍要求签名。 |
| `DSH_FED_BARRIER_TTL_MS` | TS 立法缺省 120s | barrier generation 驻留 TTL（超时 ⇒ tombstone 退休，轮询者自愈重建）。 |
| `DSH_FED_PERSIST_DIR` | 未设置 | 摘要环落盘目录（`<dir>/federation-digests.json`，tmp+fsync+rename 原子写）。**权衡**：参考实现的「不落盘」是信任姿态（摘要不留宿主盘）；设置此值 = 以「摘要落盘」换重启环连续性 —— 部署方拍板。起动防御回读：坏档 ⇒ 空环起步不炸服务。 |
| `DSH_FED_DRAIN_MS` | `1500` | 优雅关停排空上限。 |

非法 env 值（非区间内整数）⇒ 忽略并回缺省，启动日志 `envWarnings` 明示。

## 请求签名（token 模式）

设置 `DSH_FEDERATION_TOKEN` 后，`POST /aggregate`、`POST /barrier/{allocate,commit,status}`、
`GET /barrier/status` 要求头：

- `x-dsh-fed-timestamp`：epoch 毫秒（±30s 容差 —— ΠΑΝ-88 起自 ±5 分钟收窄，v1/v2 同受此窗）
- `x-dsh-fed-signature`：hex `HMAC-SHA256("<timestamp>.<body>", <token>)`
- `x-dsh-fed-nonce`（**推荐，协议 v2**）：一次性随机串（8~128 字符）。在场 ⇒ 签名输入升格
  `"<timestamp>.<nonce>.<body>"`，且服务端在时钟窗 + 滞留窗内按 **nonce 本身** 重放拒绝 ——
  截获原样重放不再可行。缺席 = 兼容协议 v1（签名级去重，向后兼容——老客户端零变化可用）。

GET 请求正文为空 ⇒ 签名输入是 `"<timestamp>."`（v2：`"<timestamp>.<nonce>."`）。验签在
JSON 解析之前 —— 中间人换体即失配。
TS 侧等价客户端：`src/federation/index.ts` 的 `federationAuthHeaders(body, token, Date.now())`
（v1）／ `federationAuthHeaders(body, token, Date.now(), nonce)`（v2）；联邦同步臂开 v2 只需
`federationSync({ ..., authNonce: true })`（ΤΕΛ-6/D-G29 客户端半边）。

### curl 示例（barrier allocate）

```bash
export DSH_FEDERATION_TOKEN='deploy-secret'
ENDPOINT='http://127.0.0.1:18433'
body='{"name":"dial","peer":"A","n":2}'
ts=$(date +%s%3N)   # epoch ms（BSD date：date +%s000）
nonce=$(openssl rand -hex 16)   # 协议 v2 推荐：一次性 nonce（8~128 字符）
sig=$(printf '%s.%s.%s' "$ts" "$nonce" "$body" | openssl dgst -sha256 -hmac "$DSH_FEDERATION_TOKEN" -hex | sed 's/^.* //')
curl -sS -X POST "$ENDPOINT/barrier/allocate" \
  -H 'content-type: application/json' \
  -H "x-dsh-fed-timestamp: $ts" \
  -H "x-dsh-fed-nonce: $nonce" \
  -H "x-dsh-fed-signature: $sig" \
  -d "$body"
```

（v1 兼容姿势：去掉 nonce 行，签名输入 `printf '%s.%s' "$ts" "$body"`，其余同。）

GET status（空正文签名；v2 形态）：

```bash
ts=$(date +%s%3N)
nonce=$(openssl rand -hex 16)
sig=$(printf '%s.%s.' "$ts" "$nonce" | openssl dgst -sha256 -hmac "$DSH_FEDERATION_TOKEN" -hex | sed 's/^.* //')
curl -sS "$ENDPOINT/barrier/status?name=dial" \
  -H "x-dsh-fed-timestamp: $ts" -H "x-dsh-fed-nonce: $nonce" -H "x-dsh-fed-signature: $sig"
```

### crossMachine 客户端加签（无需改源码）

`src/crossMachine.ts` 的 `makeHttpBarrierTransport({ endpoint, fetchImpl })` 接受注入
fetch —— 生产部署以加签 fetchImpl 包装即可（W9-2 落锤姿势）：

```ts
import { makeHttpBarrierTransport, type BarrierFetch } from './crossMachine.ts';
import { federationAuthHeaders } from './federation/index.ts';
import { randomUUID } from 'node:crypto';

const secret = process.env.DSH_FEDERATION_TOKEN!;
// v2 推荐协议：每次请求一次性 nonce（重放拒绝）；v1 = 去掉第三参即可
const signedFetch: BarrierFetch = async (url, init) =>
  fetch(url, { ...init, headers: { ...init.headers, ...federationAuthHeaders(init.body, secret, Date.now(), randomUUID()) } });
const transport = makeHttpBarrierTransport({ endpoint: 'http://127.0.0.1:18433', fetchImpl: signedFetch });
```

（后续如需一等支持，可给 `makeHttpBarrierTransport` 加 `authToken` 选项 —— 接线层决策，见 W9-2 报告。）

## 优雅关停

`SIGTERM`/`SIGINT` ⇒ 停收新连接 → `closeIdleConnections()`（收掉 keep-alive 空闲连接）
→ 等待在途请求完成 → 持久化落盘（如开 `DSH_FED_PERSIST_DIR`）→ `DSH_FED_DRAIN_MS`
上限内 `exit 0`。systemd `KillSignal=SIGTERM` / Docker `docker stop` 直接兼容。

> Windows 注意：win32 不支持向子进程投递 SIGTERM（kill 即硬终断，处理器不运行）。
> 优雅关停语义在 POSIX 拓扑生效；Windows 服务化请用进程监控器监听 stdout 的
> `{"event":"listening"...}` 行做就绪探针。

## 部署清单（本件不假装具备，由部署方负责）

- TLS 终结与跨网暴露：反代（nginx/caddy）收口，本件恒绑 127.0.0.1；
- 速率限制、入站白名单、审计日志；
- 密钥轮换：`DSH_FEDERATION_TOKEN` 经 secret manager 注入，绝不进日志/错误面（本件执法同律）；
- 持久化目录的磁盘加密与备份（若开启 `DSH_FED_PERSIST_DIR`）；
- dist 构建滞后闸：`test/w5cross.test.ts` ⑧ 对账 src↔dist —— 升级后先 `npm run build` 再起服。
