"""FastAPI app 工厂 + 中间件 + UDS 监听。

启动流程：
  1. ``load_config_from_env()`` 加载配置（加载层 throw 合法）
  2. ``ensure_key()`` 生成或加载 HMAC 密钥（加载层 throw 合法）
  3. 注入控制器到 routes
  4. ``init_uds_file()`` 初始化 UDS 文件（加载层 throw 合法）
  5. ``create_app()`` 创建 FastAPI 实例，挂载中间件
  6. ``uvicorn.run()`` 启动（uds 或 tcp）

中间件栈（执行顺序从外到内 —— Starlette 语义：**后注册者在最外层**）：
  1. ``unhandled_exception_middleware``：兜底（最后注册 = 最外层，
     连 auth/logging 自身的异常也能转 200+failure —— J 纪元修正：
     旧注册序把它放在最内层，中间件自己的异常会漏成真 500）
  2. ``request_logging_middleware``：请求/响应日志（telemetry 喂料）。
     ΠΑΝ-26: 从最内层挪到 unhandled 之内第二层 —— 旧执行序
     （unhandled → drain → auth → logging）使 auth 的 401 与 drain 的
     503 不经过 logging ⇒ 暴力探测/nonce 重放拒绝在 JSON-lines 日志
     零痕迹（C2-5 M-2）。新序下**每个**到达请求（含 401/503 拒绝）都
     落一行请求日志 —— 审计留痕。
  3. ``auth_middleware``：三层纵深认证（UDS+PID+Cap Token）
  4. 路由（含 safe_call 的业务信封）
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import time
import traceback
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from . import routes, shm as shm_module
from .auth import (
    ALL_CAPS, ENDPOINT_CAPABILITY, attest_pid, attest_pid_supported,
    attestation_mode, check_and_consume_nonce, chmod_uds_file, ensure_key,
    init_uds_file, parse_token,
)
from .config import AppConfig, load_config_from_env
from .errors import ErrorKind, failure, success, unhandled_exception_middleware
from . import executors as executors_module  # ΑΩ-R25 专属执行器生命周期
from .hid import HidController, load_hid_config_from_env
from .input import InputController
from .screen import ScreenCapture
from .ui_tree import UIFunnel
from .uvc import UvcController, load_uvc_config_from_env
from .window import WindowManager
from .android import AndroidController


# ─── 全局单例（被 create_app / shutdown 共享）───

_app_state: dict = {}

# ─── ΝΩ-36：JSON-lines 结构化日志（手写 ~25 行，零三方依赖）───
# 字段名对齐 OTel 语义约定的短名形态（http.method/http.route/http.status ≡
# http.request.method / http.route / http.response.status_code 族）—— 采集端
# 无需 OTel SDK 即可按约定消费。输出面 = stderr 单行（与启动期 print 同一
# 通道，uvicorn 的 stderr 捕获面不变）。

_SERVICE_NAME = "dsh-physical"


def request_log_record(
    method: str, route: str, status: int, duration_ms: int, request_id: str,
) -> dict:
    """ΝΩ-36：HTTP 请求日志的字段组（纯函数 —— 单测锚点）。

    ``request.id`` = X-Request-Id 回显（token 认证下为强制头；缺头/免认证
    面诚实空串）。``ts`` = RFC3339 UTC 毫秒。
    """
    now = time.time()
    return {
        "ts": f"{time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime(now))}"
              f".{int(now * 1000) % 1000:03d}Z",
        "service": _SERVICE_NAME,
        "http.method": method,
        "http.route": route,
        "http.status": int(status),
        "duration_ms": int(duration_ms),
        "request.id": request_id,
    }


def log_json(record: dict) -> None:
    """ΝΩ-36：单行 JSON 写 stderr。防御式绝不抛（日志失败不得击穿请求）。"""
    try:
        sys.stderr.write(json.dumps(record, separators=(",", ":"), default=str) + "\n")
        sys.stderr.flush()
    except Exception:  # noqa: BLE001 —— 日志面铁律：绝不抛
        pass


def create_app(config: AppConfig | None = None) -> FastAPI:
    """FastAPI app 工厂。

    加载层方法：失败 ``raise`` —— 拒绝带病上线（异常诚实第一条）。
    """
    if config is None:
        config = load_config_from_env()

    # 加载 HMAC 密钥（启动期一次性）
    key = ensure_key(config.auth.key_path)

    # 初始化控制器
    input_ctrl = InputController(config.actions)
    # W4-5 移动 Surface：android 控制器（adb/scrcpy 子进程全经可注入 runner）
    # 先造 —— ScreenCapture 的 android 帧源由它提供（同一实例 ⇒ /v1/devices
    # 的清单与截图的帧源出自同一控制器，serial 语义一致）。
    android_ctrl = AndroidController(config.android)
    screen_ctrl = ScreenCapture(config.screenshot, surface_source=android_ctrl.grab_frame)
    funnel_ctrl = UIFunnel(config.funnel)
    window_ctrl = WindowManager(config.window)

    # W5-1（W4-6 落盘）：L2 零 API 设备面控制器 —— UVC 采集卡（眼睛）+
    # HID 棒（手）。构造零硬件副作用（帧源懒解析 / 串口懒打开），env 配置
    # 装载走加载层方言（非法值 raise 拒绝带病上线；硬件/依赖缺席不影响启动
    # —— 缺席事实由端点调用时诚实信封化，mock 源可经 env 显式选择）。
    uvc_ctrl = UvcController(load_uvc_config_from_env())
    hid_ctrl = HidController(load_hid_config_from_env())

    # 注入到 routes 模块
    routes.set_controllers(
        input_ctrl, screen_ctrl, funnel_ctrl, window_ctrl, config,
        android_ctrl, uvc=uvc_ctrl, hid=hid_ctrl,
    )

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        # 启动：UDS 文件初始化
        if config.server.transport == "uds":
            init_uds_file(config.server.uds_path)
            # Layer 1 收口：uvicorn 在 lifespan startup 之后才 bind UDS socket，
            # chmod 必须等文件出现再执行。旧实现（run() 里的 on_event 版本）
            # 双重失效：FastAPI 传入 lifespan= 参数后不再派发 on_event 处理器
            # （chmod 从未执行，socket 权限停留 umask 缺省）；且其固定 sleep(0.1)
            # 早于 bind（对不存在的文件 chmod → ENOENT）。
            async def _chmod_when_bound() -> None:
                for _ in range(200):  # ≤10s
                    if os.path.exists(config.server.uds_path):
                        chmod_uds_file(config.server.uds_path)
                        return
                    await asyncio.sleep(0.05)
                print(
                    f"[warn] UDS {config.server.uds_path} not bound within 10s; "
                    "chmod 0600 skipped (Layer 2+3 still armed)",
                    file=sys.stderr,
                )

            _app_state["chmod_task"] = asyncio.create_task(_chmod_when_bound())
        # ΑΩ-R25 专属执行器隔离：启动期按 config 建四池（input/screen/device/
        # tree，容量论证见 executors.py 头注）。eager 建池使容量错误（env 配置
        # 非法值在 load 层已被拒）在启动日志现形，而非首请求时才暴露。
        pool_sizes = executors_module.startup(config.executors)
        print(
            "[dsh-physical] dedicated executor pools started (ΑΩ-R25): "
            f"{pool_sizes}",
            file=sys.stderr,
        )
        _app_state.update({
            "config": config,
            "key": key,
            "input": input_ctrl,
            "screen": screen_ctrl,
            "funnel": funnel_ctrl,
            "window": window_ctrl,
            "android": android_ctrl,  # W4-5 移动 Surface
            "uvc": uvc_ctrl,          # W5-1（W4-6）：UVC 采集卡面
            "hid": hid_ctrl,          # W5-1（W4-6）：HID 棒面
        })
        try:
            yield
        finally:
            task = _app_state.get("chmod_task")
            if task is not None and not task.done():
                task.cancel()
            # 关闭：清理 shm + 移动 Surface 缓存归零 + L2 设备面句柄收口 + 退出日志
            try:
                android_ctrl.close()  # W4-5：清设备/分辨率缓存（帧源为一次性子进程，无常驻句柄）
            except Exception:  # noqa: BLE001 —— 关闭路径不得掩盖其他清理
                pass
            # W5-1：UVC 帧源（cv2 捕获句柄）优雅收口 —— 未解析/未打开时为无害 no-op
            try:
                await uvc_ctrl.close()
            except Exception:  # noqa: BLE001
                pass
            # W5-1：HID 串口句柄收口（W6-R-A3 封装修复：改走 HidController.close
            # 公有门面 —— 不再穿刺 ``_transport`` 私有属性；未写过帧 ⇒ 未开串口
            # ⇒ no-op）
            try:
                await hid_ctrl.close()
            except Exception:  # noqa: BLE001
                pass
            # W5-1（W4-8）：声学通道后台采集线程收口（未建链 ⇒ no-op）
            try:
                from . import audio as audio_module

                audio_module.get_shared_monitor().stop()
            except Exception:  # noqa: BLE001
                pass
            # ΑΩ-R25 专属执行器收口：必须放在上述控制器 close 之后 —— uvc/hid
            # 的 close 仍要向 device 池提交串口/句柄收口任务；此后
            # shutdown(wait=False)+cancel_futures：在飞动作不等待（adb 15s
            # 超时不得拖住下线）、排队未启动任务取消。atexit 兜底见
            # executors.py（lifespan 未走到的异常退出路径）。
            try:
                executors_module.shutdown_all()
            except Exception:  # noqa: BLE001 —— 关闭路径不得掩盖其他清理
                pass
            shm_module.cleanup_all()
            _app_state.clear()

    app = FastAPI(
        title="D-5 Physical Execution Microservice",
        version="0.1.0",
        lifespan=lifespan,
        # 关闭 OpenAPI 文档（生产环境减少攻击面）
        openapi_url=None if config.server.allow_external else "/openapi.json",
        docs_url=None if config.server.allow_external else "/docs",
    )

    # ─── 中间件注册（Starlette：后注册者最外层）───
    # 注册序 = auth → drain → logging → unhandled ⇒ 执行序（外→内）=
    # unhandled → logging → drain → auth。
    # ΠΑΝ-26: logging 从最内层挪到 drain 之外 —— 401（auth）/503（drain）
    # 同样落一行 JSON-lines 请求日志（C2-5 M-2：旧序下暴力探测零痕迹）。
    # unhandled 仍居最外层（J 纪元保证不回退：连 logging 自身的异常也兜）。

    # ─── 中间件：认证（三层纵深）───
    # W6-R-A3 错误码修正：认证失败是传输/安全层判决（非业务层），返回
    # HTTP 401（信封 JSON 结构不变 —— ``{status:'failure', error:{...}}``）。
    # 业务失败仍走 HTTP 200 + failure 信封（errors.py 的既有契约，不动）。
    @app.middleware("http")
    async def auth_middleware(request: Request, call_next):
        # 免认证面 = allow_no_token_endpoints **显式配置**（缺省仅 /v1/health）。
        # ΠΑΝ-26: /docs*、/openapi.json、/favicon.ico 不再硬编码免认证
        # （C2-5 M-1：旧实现在非 allow_external 模式下默认放行完整 OpenAPI
        # schema —— 本机任何进程可免 token 枚举攻击面）。docs 家族现在走
        # 完整三层校验，能力位归 observe（见 _match_capability）。
        path = request.url.path
        if path in config.auth.allow_no_token_endpoints:
            return await call_next(request)

        # Layer 1: 传输绑定（TCP 只听 127.0.0.1 / UDS 0600，见 config + run()）
        # Layer 3 先行：Capability Token（Layer 2 的比较对象来自令牌 ——
        # 令牌未解析前无从比较；P 纪元修正：M 纪元把 Layer 2 块放在 parse_token
        # 之前 ⇒ UDS+Linux+peercred 路径落地即 UnboundLocalError 崩溃 ——
        # BC-2 虫型（闭包/先读后赋），M-4 源级执法从未运行故未现形）。
        token = request.headers.get("X-Cap-Token", "")
        if not token:
            return JSONResponse(
                status_code=401,
                content=failure(
                    ErrorKind.UNAUTHORIZED,
                    "missing X-Cap-Token header",
                    latency_ms=0,
                ),
            )

        auth_result = parse_token(key, token)
        if not auth_result.ok:
            return JSONResponse(
                status_code=401,
                content=failure(
                    ErrorKind.UNAUTHORIZED,
                    f"token invalid: {auth_result.reason}",
                    latency_ms=0,
                ),
            )

        # Layer 2: PID Attestation —— M 纪元兑现：UDS+Linux 下 peercred 协议把
        # 对端 PID 注入 scope；在场 ⇒ token.pid 必须逐位相等（auth.py 头注承诺的
        # 校验落地）。scope 无 peer_pid（TCP/非 Linux）⇒ 既有 /proc 白名单路径。
        scope_pid = request.scope.get("peer_pid")
        if scope_pid is not None and auth_result.pid != scope_pid:
            return JSONResponse(
                status_code=401,
                content=failure(
                    ErrorKind.UNAUTHORIZED,
                    f"token pid {auth_result.pid} != SO_PEERCRED peer pid {scope_pid}",
                    latency_ms=0,
                ),
            )

        # Nonce 防重放（exp 直接取自 parse_token —— J 纪元修正：旧实现手工
        # 二次 base64 解码 payload，双解析浪费且易漂移）。
        # W6-R-A3 重放修复：token 认证一旦启用，X-Request-Id（单次性 nonce）
        # 即为**强制头** —— 旧实现只在头在场时才校验，缺头请求在 60s TTL 内
        # 可无限重放（防重放层形同虚设）。缺头 = 拒绝（401），无静默豁免。
        nonce = request.headers.get("X-Request-Id", "")
        if not nonce:
            return JSONResponse(
                status_code=401,
                content=failure(
                    ErrorKind.UNAUTHORIZED,
                    "missing X-Request-Id header (single-use nonce required; "
                    "requests are one-shot, replays are rejected)",
                    latency_ms=0,
                ),
            )
        if not check_and_consume_nonce(nonce, auth_result.exp):
            return JSONResponse(
                status_code=401,
                content=failure(
                    ErrorKind.UNAUTHORIZED,
                    "nonce already consumed (replay attack?)",
                    latency_ms=0,
                ),
            )

        # 端点能力校验
        # ΠΑΝ-25: fail-closed —— 旧实现对无映射端点返回 None ⇒ 跳过能力校验
        # 直接放行（C2-5 H-3：shutdown/stats/input_events/devices 等管理面与
        # 一切未知路径整体游离于能力位图外，单能力 token 亦可关停服务）。
        # 现管理端点已入 ENDPOINT_CAPABILITY（shutdown→admin、观测族→observe），
        # 无映射路径默认 403 拒绝（结构化信封）。kind 沿用 unauthorized ——
        # errors.py 的 ErrorKind 闭集归他人文件管，不私加 FORBIDDEN 位。
        capability = _match_capability(path, request.method)
        if capability is None:
            return JSONResponse(
                status_code=403,
                content=failure(
                    ErrorKind.UNAUTHORIZED,
                    f"endpoint {path!r} ({request.method}) has no capability mapping; "
                    "fail-closed default deny (ΠΑΝ-25)",
                    latency_ms=0,
                ),
            )
        if capability not in auth_result.caps:
            return JSONResponse(
                status_code=401,
                content=failure(
                    ErrorKind.UNAUTHORIZED,
                    f"token lacks capability: {capability!r} (has: {list(auth_result.caps)})",
                    latency_ms=0,
                ),
            )

        # PID Attestation（Linux /proc；ΠΑΝ-27: Windows 可得内核信号同门）
        # 旧硬条件 ``sys.platform == "linux"`` 使 Windows 即便显式
        # DSH_PHYSICAL_PID_ATTESTATION=true 也恒跳过（C2-4 M-4：主平台
        # 三层纵深退化为「同用户全信」）。现按平台支持度判决
        # （attest_pid_supported：linux/win32）；attest_pid 内部按平台取真实
        # 信号（存在性/可执行路径/创建时间），信号不可得则诚实降级为
        # 「仅回环+HMAC」（拒绝信封携带 attestation_mode 标注）。
        if (
            config.auth.enable_pid_attestation
            and attest_pid_supported()
            and auth_result.pid
            and not attest_pid(auth_result.pid)
        ):
            return JSONResponse(
                status_code=401,
                content=failure(
                    ErrorKind.UNAUTHORIZED,
                    f"pid {auth_result.pid} failed attestation "
                    f"(mode={attestation_mode()})",
                    latency_ms=0,
                ),
            )

        return await call_next(request)

    # ─── 中间件：drain 拒新（ΝΩ-27 优雅关停）───
    # 注册序在 auth 之后 ⇒ 执行序比 auth 更外（unhandled → logging → drain
    # → auth）：draining 期的新请求在鉴权之前即被 503+failure 信封拒绝
    # （不消耗 nonce、不占在飞）。ΠΑΝ-26: logging 已在 drain 之外 ⇒ 503
    # 同样落请求日志（draining 期扰动可审计）。/v1/shutdown 自身放行
    # （幂等）。在飞计数（enter/leave）供 drain_and_exit 排空等待。
    @app.middleware("http")
    async def drain_middleware(request: Request, call_next):
        if routes.drain_should_reject(request.url.path):
            return JSONResponse(
                status_code=503,
                content=failure(
                    ErrorKind.INTERNAL_ERROR,
                    "service draining for shutdown: new requests rejected; "
                    "in-flight completes within "
                    f"{routes.SHUTDOWN_DRAIN_MAX_WAIT_S:.0f}s",
                    latency_ms=0,
                ),
            )
        routes.drain_enter()
        try:
            return await call_next(request)
        finally:
            routes.drain_leave()

    # ─── 中间件：请求日志（telemetry 喂料；ΠΑΝ-26: drain 之外 —— 401/503
    # 同样留痕）───
    @app.middleware("http")
    async def logging_middleware(request: Request, call_next):
        started = time.perf_counter()
        response = await call_next(request)
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        # ΝΩ-36：print → JSON-lines 结构化日志（ts/service/http.method/
        # http.route/http.status/duration_ms/request.id 回显）。
        # ΠΑΝ-26: auth 的 401 / drain 的 503 也走这里 —— 暴力探测（token
        # 枚举、nonce 重放）对审计可见，事后可查。
        log_json(request_log_record(
            request.method, request.url.path, response.status_code, elapsed_ms,
            request.headers.get("X-Request-Id", ""),
        ))
        return response

    # ─── 中间件：兜底（最后注册 = 最外层；连 auth/logging 的异常也兜住）───
    @app.middleware("http")
    async def _unhandled(request: Request, call_next):
        return await unhandled_exception_middleware(request, call_next)

    # ─── 路由挂载 ──
    app.include_router(routes.router)

    return app


def _match_capability(path: str, method: str) -> str | None:
    """根据请求路径与方法匹配所需 capability。

    ΠΑΝ-25: 返回 ``None`` = 无映射 —— 调用方（auth 中间件）**fail-closed
    默认拒绝**（403 结构化信封），不再跳过校验放行。管理端点映射见
    ``auth.ENDPOINT_CAPABILITY``（shutdown→admin；stats/input_events/
    devices→observe）。
    ΠΑΝ-26: docs 家族（/docs*、/openapi.json、/favicon.ico）不再硬编码
    免认证，归 observe 位 —— 与管理观测面同方言（非 allow_external 模式
    下 FastAPI 默认挂载这些路由）。
    """
    # 精确匹配
    if path in ENDPOINT_CAPABILITY:
        return ENDPOINT_CAPABILITY[path]
    # 模糊匹配（如 /v1/shm/{name}）
    if path.startswith("/v1/shm/") and method == "DELETE":
        return "shm_delete"
    # ΠΑΝ-26: docs 家族（其余未映射路径 ⇒ None ⇒ 中间件 403 fail-closed）
    if path.startswith("/docs") or path in ("/openapi.json", "/favicon.ico"):
        return "observe"
    return None


# ─── UDS 监听启动 ───


def run() -> None:
    """启动入口 —— 由 ``__main__.py`` 调用。

    加载层方法：失败 ``raise`` —— 拒绝带病上线。
    """
    config = load_config_from_env()
    app = create_app(config)

    import uvicorn

    # W6-R-B8（集成校验补）+ ΠΑΝ-27：Layer 2 状态启动期诚实标注 —— TS 端
    # serviceManager 已不再强制 DSH_PHYSICAL_PID_ATTESTATION=false，开关回到
    # 本端按平台决定；实际形态（武装 / 平台性降级）须在服务日志可见，而非
    # 静默缺席。ΠΑΝ-27: Windows 不再一律报降级 —— 内核信号（进程存在性/
    # 可执行路径/创建时间）武装即报 armed；单次信号不可得的诚实降级
    # （loopback+HMAC only）由 auth.attestation_mode 按最近事实申报。
    if config.auth.enable_pid_attestation and attest_pid_supported():
        print(
            f"[dsh-physical] PID attestation: armed (platform={sys.platform}, "
            f"mode={attestation_mode()}); windows = 进程存在性/可执行路径/创建"
            "时间信号（信号不可得时按请求诚实降级为 loopback+HMAC）；linux/UDS "
            "additionally captures SO_PEERCRED peer pid",
            file=sys.stderr,
        )
    else:
        print(
            f"[dsh-physical] PID attestation: degraded (platform={sys.platform}, "
            f"enable_pid_attestation={config.auth.enable_pid_attestation}) — "
            "no real PID signals on this platform; Layer 1 (transport binding) "
            "+ Layer 3 (HMAC Cap Token + nonce) carry authentication "
            "(loopback+HMAC only)",
            file=sys.stderr,
        )

    if config.server.transport == "uds":
        # M 纪元（留白兑现）：UDS + Linux ⇒ SO_PEERCRED 协议子类（peer_pid 入
        # scope；auth 刻度 token.pid 逐位相等）。非 Linux/工厂缺席 ⇒ None 原样。
        from .peercred import make_peercred_protocol
        _peercred_http = make_peercred_protocol()
        if _peercred_http is not None:
            print("[dsh-physical] SO_PEERCRED peer-pid capture armed (UDS).", file=sys.stderr)
        # UDS 模式：uvicorn 原生支持 ``--uds``。
        # socket 文件权限 0600 收口由 create_app 的 lifespan 里
        # ``_chmod_when_bound`` 任务负责（uvicorn bind 后文件才出现；
        # 注意：app 已传 ``lifespan=`` ⇒ FastAPI 不再派发 on_event 处理器，
        # 此处不能再挂 startup 钩子）。
        uv_config = uvicorn.Config(
            app,
            http=_peercred_http,  # type: ignore[arg-type]
            uds=config.server.uds_path,
            log_level="info",
            # 生产环境：单 worker（多 worker 会导致 UDS 抢占）
            workers=1,
        )
    else:
        # TCP 模式：仅绑定 127.0.0.1（绝不开 0.0.0.0，铁律）
        if config.server.allow_external:
            print("[WARN] DSH_PHYSICAL_ALLOW_EXTERNAL=true: binding to all interfaces!", file=sys.stderr)
            host = "0.0.0.0"
        else:
            host = config.server.tcp_host

        uv_config = uvicorn.Config(
            app,
            host=host,
            port=config.server.tcp_port,
            log_level="info",
            workers=1,
        )

    # ΝΩ-27：程序化装配 Server（uvicorn.run 内部即 Config+Server+run()，
    # workers=1 单进程形态下行为等价）—— /v1/shutdown 的退出钩子需要翻转
    # Server.should_exit（优雅：停收新连接、等存量）或 force_exit（排空上限
    # 已到：立即断）。翻转后 lifespan finally 链（shm 清理/UVC/HID/执行器池
    # 收口）随 uvicorn 关停执行，进程自退 —— 不再依赖平台上并不可靠的
    # SIGTERM（Windows 上即 TerminateProcess 硬杀，3s 优雅窗形同虚设）。
    server = uvicorn.Server(uv_config)

    def _request_exit(force: bool) -> None:
        if force:
            server.force_exit = True
        else:
            server.should_exit = True

    routes.register_shutdown_hook(_request_exit)
    server.run()
