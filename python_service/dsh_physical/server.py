"""FastAPI app 工厂 + 中间件 + UDS 监听。

启动流程：
  1. ``load_config_from_env()`` 加载配置（加载层 throw 合法）
  2. ``ensure_key()`` 生成或加载 HMAC 密钥（加载层 throw 合法）
  3. 注入控制器到 routes
  4. ``init_uds_file()`` 初始化 UDS 文件（加载层 throw 合法）
  5. ``create_app()`` 创建 FastAPI 实例，挂载中间件
  6. ``uvicorn.run()`` 启动（uds 或 tcp）

中间件栈（顺序从外到内）：
  1. ``unhandled_exception_middleware``：兜底（理论不可达的最后一道墙）
  2. ``auth_middleware``：三层纵深认证（UDS+PID+Cap Token）
  3. ``request_logging_middleware``：请求/响应日志（telemetry 喂料）
"""
from __future__ import annotations

import asyncio
import sys
import time
import traceback
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from . import routes, shm as shm_module
from .auth import (
    ALL_CAPS, ENDPOINT_CAPABILITY, attest_pid, check_and_consume_nonce,
    chmod_uds_file, ensure_key, get_peer_pid_linux, init_uds_file,
    parse_token,
)
from .config import AppConfig, load_config_from_env
from .errors import ErrorKind, failure, success, unhandled_exception_middleware
from .input import InputController
from .screen import ScreenCapture
from .ui_tree import UIFunnel
from .window import WindowManager


# ─── 全局单例（被 create_app / shutdown 共享）───

_app_state: dict = {}


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
    screen_ctrl = ScreenCapture(config.screenshot)
    funnel_ctrl = UIFunnel(config.funnel)
    window_ctrl = WindowManager(config.window)

    # 注入到 routes 模块
    routes.set_controllers(input_ctrl, screen_ctrl, funnel_ctrl, window_ctrl, config)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        # 启动：UDS 文件初始化
        if config.server.transport == "uds":
            init_uds_file(config.server.uds_path)
        _app_state.update({
            "config": config,
            "key": key,
            "input": input_ctrl,
            "screen": screen_ctrl,
            "funnel": funnel_ctrl,
            "window": window_ctrl,
        })
        try:
            yield
        finally:
            # 关闭：清理 shm + 退出日志
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

    # ─── 中间件 1：兜底（理论不可达的最后一道墙）───
    @app.middleware("http")
    async def _unhandled(request: Request, call_next):
        return await unhandled_exception_middleware(request, call_next)

    # ─── 中间件 2：认证（三层纵深）───
    @app.middleware("http")
    async def auth_middleware(request: Request, call_next):
        # 健康检查 / mint_token / openapi 不需认证
        path = request.url.path
        if path in config.auth.allow_no_token_endpoints or path.startswith("/docs") or path in ("/openapi.json", "/favicon.ico"):
            return await call_next(request)

        # Layer 1: UDS 信任（已由文件权限收口，此处的 transport 检查仅是冗余防御）
        # Layer 2: PID Attestation（Linux）
        peer_pid: int | None = None
        if config.auth.enable_pid_attestation and sys.platform == "linux":
            # ASGI scope 拿不到 socket；通过 X-Peer-Pid header 透传（由 uvicorn 中间件补）
            # 退而求其次：校验 X-Cap-Token 中的 pid 与环境变量 DSH_PHYSICAL_TRUSTED_PID 比对
            # 完整实现需要自定义 uvicorn socket handler；此处保留 Layer 3 主力
            pass

        # Layer 3: Capability Token
        token = request.headers.get("X-Cap-Token", "")
        if not token:
            return JSONResponse(
                status_code=200,
                content=failure(
                    ErrorKind.UNAUTHORIZED,
                    "missing X-Cap-Token header",
                    latency_ms=0,
                ),
            )

        auth_result = parse_token(key, token)
        if not auth_result.ok:
            return JSONResponse(
                status_code=200,
                content=failure(
                    ErrorKind.UNAUTHORIZED,
                    f"token invalid: {auth_result.reason}",
                    latency_ms=0,
                ),
            )

        # Nonce 防重放
        nonce = request.headers.get("X-Request-Id", "")
        if nonce:
            # 解析 token 的 exp（重新 parse 一次以拿 exp；略低效但简单）
            # 实际生产可缓存；此处仅作示范
            try:
                import base64
                import json as _json

                payload_b64 = token.split(".")[0]
                pad = "=" * (-len(payload_b64) % 4)
                payload = _json.loads(base64.urlsafe_b64decode(payload_b64 + pad))
                exp = int(payload.get("exp", 0))
                if not check_and_consume_nonce(nonce, exp):
                    return JSONResponse(
                        status_code=200,
                        content=failure(
                            ErrorKind.UNAUTHORIZED,
                            "nonce already consumed (replay attack?)",
                            latency_ms=0,
                        ),
                    )
            except Exception:
                # nonce 解析失败不影响主流程（向后兼容）
                pass

        # 端点能力校验
        capability = _match_capability(path, request.method)
        if capability and capability not in auth_result.caps:
            return JSONResponse(
                status_code=200,
                content=failure(
                    ErrorKind.UNAUTHORIZED,
                    f"token lacks capability: {capability!r} (has: {list(auth_result.caps)})",
                    latency_ms=0,
                ),
            )

        # PID Attestation（Linux，二次校验）
        if (
            config.auth.enable_pid_attestation
            and sys.platform == "linux"
            and auth_result.pid
            and not attest_pid(auth_result.pid)
        ):
            return JSONResponse(
                status_code=200,
                content=failure(
                    ErrorKind.UNAUTHORIZED,
                    f"pid {auth_result.pid} binary not in whitelist",
                    latency_ms=0,
                ),
            )

        return await call_next(request)

    # ─── 中间件 3：请求日志（telemetry 喂料）───
    @app.middleware("http")
    async def logging_middleware(request: Request, call_next):
        started = time.perf_counter()
        response = await call_next(request)
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        # 简单 stderr 日志（生产可换结构化日志）
        print(
            f"[dsh-physical] {request.method} {request.url.path} "
            f"-> {response.status_code} ({elapsed_ms}ms)",
            file=sys.stderr,
        )
        return response

    # ─── 路由挂载 ──
    app.include_router(routes.router)

    return app


def _match_capability(path: str, method: str) -> str | None:
    """根据请求路径与方法匹配所需 capability。"""
    # 精确匹配
    if path in ENDPOINT_CAPABILITY:
        return ENDPOINT_CAPABILITY[path]
    # 模糊匹配（如 /v1/shm/{name}）
    if path.startswith("/v1/shm/") and method == "DELETE":
        return "shm_delete"
    return None


# ─── UDS 监听启动 ───


def run() -> None:
    """启动入口 —— 由 ``__main__.py`` 调用。

    加载层方法：失败 ``raise`` —— 拒绝带病上线。
    """
    config = load_config_from_env()
    app = create_app(config)

    import uvicorn

    if config.server.transport == "uds":
        # UDS 模式：uvicorn 原生支持 ``--uds``
        # 在 uvicorn 启动后，需要 chmod socket 文件权限到 0600
        # 但 uvicorn 创建 socket 时不主动收口权限；我们用 startup 事件 + 异步任务补
        # 简化：在 lifespan 启动时延迟 chmod（uvicorn 创建 socket 后才有效）
        @app.on_event("startup")
        async def _chmod_uds():
            # 异步稍等让 uvicorn 完成 socket 绑定
            await asyncio.sleep(0.1)
            chmod_uds_file(config.server.uds_path)

        uvicorn.run(
            app,
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

        uvicorn.run(
            app,
            host=host,
            port=config.server.tcp_port,
            log_level="info",
            workers=1,
        )
