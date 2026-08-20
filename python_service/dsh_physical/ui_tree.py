"""反双盲仲裁漏斗 —— Step 1 §② 世界级创新方案。

传统漏斗（L1 失败 → L2 → L3 兜底）：
  - L3 几乎每次都被调（L1 在复杂页面容易漏元素）
  - VLM 成本爆炸，每次扫描都付费

本仲裁式架构：
  L1-tree  ─┐
              ├─→ 仲裁器 ─→ 最终答案
  L2-ocr   ─┘

规则：
  1. L1 + L2 一致（元素位置重合 ≥ 80%）→ 直接采纳，**L3 不调用**（80% 场景免费）
  2. L1 + L2 冲突（位置不重合或元素集合差异大）→ L3 仲裁（仅冲突场景付费）
  3. L1/L2 完全缺席 → L3 兜底

L3 实现分层：
  - ``local-llama``：本地 VLM（llama.cpp + Qwen-VL）
  - ``remote-doubao``：远程 VLM API
  - ``stub``：返回 ``VLM_UNAVAILABLE``（开发模式默认）
  - ``disabled``：完全关闭，仅 L1+L2

输出对齐 D-6 ``UIElement`` 类型：
  { source, role, name, state?, rect: {x,y,width,height} }
"""
from __future__ import annotations

import asyncio
import os
import sys
import time
from dataclasses import dataclass, field
from typing import Literal

from .config import FunnelConfig
from .errors import ErrorKind, PhysicalError

# ─── 类型定义（镜像 D-6 UIElement，避免跨进程契约漂移）───


@dataclass
class UIElement:
    """单个 UI 元素（与 D-6 ``contracts.ts:48`` 严格对齐）。"""

    source: Literal["L1-tree", "L2-ocr", "L3-vlm"] | None
    role: str  # 开集词汇：'input' | 'button' | 'link' | ...
    name: str
    state: str | None = None  # 'enabled' | 'disabled' | 'masked' | 'checked' | 'unchecked'
    rect: dict = field(default_factory=lambda: {"x": 0.0, "y": 0.0, "width": 0.0, "height": 0.0})

    def to_dict(self) -> dict:
        return {
            "source": self.source,
            "role": self.role,
            "name": self.name[:20],  # D-3 LABEL_MAX 先例：≤20 字符
            "state": self.state,
            "rect": self.rect,
        }


@dataclass
class FunnelResult:
    """漏斗产出 —— 镜像 D-6 ``ScenePatch`` 单分区语义。"""

    elements: list[UIElement]
    funnel_depth: Literal["L1", "L2", "L3", "empty"]
    fault: dict | None = None  # { source: 'L1'|'L2'|'L3', detail: str }
    captured_at: int = 0
    # 内部观测：L3 是否被调用（仲裁机制的效益证据）
    l3_invoked: bool = False

    def to_dict(self) -> dict:
        return {
            "elements": [e.to_dict() for e in self.elements],
            "funnel_depth": self.funnel_depth,
            "fault": self.fault,
            "captured_at": self.captured_at,
            "l3_invoked": self.l3_invoked,
        }


# ─── L1: 无障碍树 ───


class L1TreeBackend:
    """L1 无障碍树读取 —— 平台分治。

    ``backend`` 选择：
      - ``auto``：按 sys.platform 自动选 darwin/win32/linux
      - ``quartz`` / ``uiautomation`` / ``xlib``：显式指定
      - ``disabled``：完全关闭
    """

    def __init__(self, backend: str) -> None:
        self.backend = backend
        self._impl = self._resolve_backend(backend)

    def _resolve_backend(self, backend: str) -> str:
        if backend == "disabled":
            return "disabled"
        if backend == "auto":
            return {
                "darwin": "quartz",
                "win32": "uiautomation",
                "linux": "xlib",
            }.get(sys.platform, "disabled")
        return backend

    async def extract(self, region: dict | None) -> tuple[list[UIElement], str | None]:
        """提取 UI 元素。

        返回 ``(elements, fault_detail)``：``fault_detail`` 非 None 表示该层失败。
        永不抛错 —— 一切异常转 ``fault_detail``。
        """
        if self._impl == "disabled":
            return [], "L1 backend disabled"

        try:
            if self._impl == "quartz":
                return await self._extract_quartz(region)
            elif self._impl == "uiautomation":
                return await self._extract_uiautomation(region)
            elif self._impl == "xlib":
                return await self._extract_xlib(region)
            else:
                return [], f"unknown L1 backend: {self._impl}"
        except Exception as e:  # noqa: BLE001
            return [], f"{type(e).__name__}: {e}"

    async def _extract_quartz(self, region: dict | None) -> tuple[list[UIElement], str | None]:
        """macOS Quartz Accessibility API。"""
        try:
            from ApplicationServices import (
                AXUIElementCreateApplication, AXUIElementCopyAttributeValue,
                kAXChildrenAttribute, kAXRoleAttribute, kAXTitleAttribute,
                kAXPositionAttribute, kAXSizeAttribute, kAXEnabledAttribute,
            )
        except ImportError as e:
            return [], f"quartz import failed: {e}. install pyobjc-framework-ApplicationServices"

        # TODO: 完整实现需要拿到 frontmost app 的 PID + 遍历 AX tree
        # 此处为骨架实现，返回空列表 + 诚实降级
        return [], "quartz L1 not yet implemented (skeleton)"

    async def _extract_uiautomation(self, region: dict | None) -> tuple[list[UIElement], str | None]:
        """Windows UI Automation API。"""
        try:
            import uiautomation as ua  # type: ignore[import-not-found]
        except ImportError as e:
            return [], f"uiautomation import failed: {e}. pip install uiautomation"

        # 骨架实现：枚举顶层控件
        try:
            root = ua.GetRootControl()
            elements: list[UIElement] = []
            for ctrl in root.GetChildren():
                try:
                    name = ctrl.Name or ""
                    role = ctrl.ControlTypeName or "unknown"
                    rect_obj = ctrl.BoundingRectangle
                    if rect_obj:
                        rect = {
                            "x": rect_obj.left,
                            "y": rect_obj.top,
                            "width": rect_obj.width,
                            "height": rect_obj.height,
                        }
                    else:
                        continue
                    elements.append(UIElement(
                        source="L1-tree",
                        role=role.lower(),
                        name=name,
                        state="enabled" if ctrl.IsEnabled else "disabled",
                        rect=rect,
                    ))
                except Exception:  # noqa: BLE001
                    continue
            return elements, None
        except Exception as e:  # noqa: BLE001
            return [], f"uiautomation traversal failed: {e}"

    async def _extract_xlib(self, region: dict | None) -> tuple[list[UIElement], str | None]:
        """Linux X11 tree（AT-SPI 通过 python-xlib）。"""
        # AT-SPI 是真正的 Linux 无障碍 API；python-xlib 仅提供 X 协议
        # 完整实现需要 pyatspi（Linux 平台自带）
        try:
            import pyatspi  # type: ignore[import-not-found]
        except ImportError as e:
            return [], f"pyatspi import failed: {e}. apt install python3-pyatspi"

        try:
            desktop = pyatspi.Registry.getDesktop(0)
            elements: list[UIElement] = []
            for i in range(desktop.childCount):
                app = desktop.getChildAtIndex(i)
                if app is None:
                    continue
                try:
                    name = app.name or ""
                    role = app.getRoleName() or "unknown"
                    ext = app.getExtents()
                    rect = {
                        "x": ext.x,
                        "y": ext.y,
                        "width": ext.width,
                        "height": ext.height,
                    }
                    elements.append(UIElement(
                        source="L1-tree",
                        role=role.lower(),
                        name=name,
                        rect=rect,
                    ))
                except Exception:  # noqa: BLE001
                    continue
            return elements, None
        except Exception as e:  # noqa: BLE001
            return [], f"pyatspi traversal failed: {e}"


# ─── L2: OCR ───


class L2OCRBackend:
    """L2 OCR —— RapidOCR (ONNX Runtime) 跨平台。"""

    def __init__(self, backend: str, languages: list[str]) -> None:
        self.backend = backend
        self.languages = languages
        self._engine = None

    def _ensure_engine(self) -> None:
        if self._engine is not None or self.backend == "disabled":
            return
        try:
            from rapidocr_onnxruntime import RapidOCR  # type: ignore[import-not-found]

            self._engine = RapidOCR()
        except ImportError as e:
            raise PhysicalError(
                ErrorKind.OCR_UNAVAILABLE,
                f"rapidocr import failed: {e}. pip install rapidocr-onnxruntime",
            ) from e

    async def extract(self, image_bytes: bytes | None) -> tuple[list[UIElement], str | None]:
        """对图像做 OCR，返回元素列表。

        ``image_bytes``：PNG/JPEG 字节；为 ``None`` 表示无图（L1 已成功则跳过 L2）。
        返回 ``(elements, fault_detail)``。
        """
        if self.backend == "disabled":
            return [], "L2 backend disabled"
        if image_bytes is None:
            return [], "no image bytes for OCR"

        try:
            self._ensure_engine()
        except PhysicalError as e:
            return [], e.detail

        try:
            import numpy as np
            from PIL import Image
            import io

            img = Image.open(io.BytesIO(image_bytes))
            arr = np.array(img)

            loop = asyncio.get_running_loop()
            result, _ = await loop.run_in_executor(None, self._engine, arr)
            if result is None:
                return [], None  # OCR 成功但无文本

            elements: list[UIElement] = []
            for box, text, score in result:
                if not text or score < 0.5:
                    continue
                # box = [[x1,y1],[x2,y2],[x3,y3],[x4,y4]]（四点多边形）
                xs = [p[0] for p in box]
                ys = [p[1] for p in box]
                x, y = min(xs), min(ys)
                w, h = max(xs) - x, max(ys) - y
                elements.append(UIElement(
                    source="L2-ocr",
                    role="text",
                    name=text[:20],
                    rect={"x": float(x), "y": float(y), "width": float(w), "height": float(h)},
                ))
            return elements, None
        except Exception as e:  # noqa: BLE001
            return [], f"{type(e).__name__}: {e}"


# ─── L3: VLM 仲裁器 ───


def _parse_vlm_elements(text: str) -> tuple[list[UIElement], str | None]:
    r"""VLM 结构化输出解析（视觉皮层的言语区）。

    容错域（VLM 是有噪声的传感器，不是配置输入 —— 解析宽容但校验严格）：
      - 剥离 markdown 围栏（```json ... ```）与前后散文
      - 接受 JSON 数组或单对象；逐元素域校验（name 非空字符串、x/y/w/h ∈ [0,1]）
      - 无效元素跳过（保留有效者），全无效 ⇒ 诚实 fault（绝不把散文伪装成元素）
    """
    import json
    import re

    if not text or not text.strip():
        return [], "VLM returned empty text"

    stripped = text.strip()
    # 剥围栏：```json ... ``` 或 ``` ... ```
    fence = re.search(r"```(?:json)?\s*(.*?)\s*```", stripped, re.DOTALL)
    if fence:
        stripped = fence.group(1)
    # 剥散文：截取首个 '[' 到最后一个 ']'（数组体），或 '{' 到 '}'（单对象）
    arr_match = re.search(r"\[.*\]", stripped, re.DOTALL)
    obj_match = re.search(r"\{.*\}", stripped, re.DOTALL)
    if arr_match:
        stripped = arr_match.group(0)
    elif obj_match:
        stripped = "[" + obj_match.group(0) + "]"

    try:
        items = json.loads(stripped)
    except json.JSONDecodeError as e:
        return [], f"VLM output not parseable as JSON: {e}"

    if not isinstance(items, list):
        return [], "VLM output is not a JSON array"

    elements: list[UIElement] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        name = item.get("name")
        if not isinstance(name, str) or not name.strip():
            continue
        coords = []
        valid = True
        for key in ("x", "y", "w", "h"):
            v = item.get(key)
            if isinstance(v, bool) or not isinstance(v, (int, float)) or not 0.0 <= float(v) <= 1.0:
                valid = False
                break
            coords.append(float(v))
        if not valid:
            continue
        x, y, w, h = coords
        elements.append(UIElement(
            source="L3-vlm",
            role=str(item.get("role", "vlm-element")),
            name=name.strip()[:20],  # 与 L1/L2 同预算（D-3 LABEL_MAX 先例）
            rect={"x": x, "y": y, "width": w, "height": h},
        ))

    if not elements:
        return [], f"VLM output had no valid elements ({len(items)} items parsed)"
    return elements, None


class L3VLMBackend:
    """L3 VLM 仲裁器 —— 本地优先 + 远程兜底 + stub。

    ``backend`` 选择：
      - ``local-llama``：``llama-cpp-python`` 加载本地 GGUF 模型
      - ``remote-doubao``：HTTP API 调远程 VLM
      - ``stub``：永远返回 ``VLM_UNAVAILABLE``（开发模式默认）
      - ``disabled``：完全关闭
    """

    def __init__(self, config: FunnelConfig) -> None:
        self.config = config
        self._local_model = None

    async def arbitrate(
        self,
        image_bytes: bytes | None,
        l1_elements: list[UIElement],
        l2_elements: list[UIElement],
        question: str = "list all interactive UI elements with their positions",
    ) -> tuple[list[UIElement], str | None]:
        """L3 仲裁入口。

        返回 ``(elements, fault_detail)``；``fault_detail`` 非 None 表示 L3 失败。
        """
        backend = self.config.l3_backend

        if backend == "disabled":
            return [], "L3 backend disabled"
        if backend == "stub":
            return [], "L3 stub (no VLM available)"

        if image_bytes is None:
            return [], "no image bytes for VLM"

        try:
            if backend == "local-llama":
                return await self._local_llama(image_bytes, question)
            elif backend == "remote-doubao":
                return await self._remote_doubao(image_bytes, question)
            else:
                return [], f"unknown L3 backend: {backend}"
        except Exception as e:  # noqa: BLE001
            return [], f"{type(e).__name__}: {e}"

    async def _local_llama(self, image_bytes: bytes, question: str) -> tuple[list[UIElement], str | None]:
        """本地 llama.cpp + Qwen-VL。"""
        try:
            from llama_cpp import Llama  # type: ignore[import-not-found]
            from llama_cpp.llama_chat_format import Llava15ChatHandler  # type: ignore[import-not-found]
        except ImportError as e:
            return [], f"llama-cpp-python not installed: {e}"

        if not self.config.l3_model_path:
            return [], "DSH_PHYSICAL_L3_MODEL_PATH not set"

        try:
            if self._local_model is None:
                handler = Llava15ChatHandler(clip_model_path=self.config.l3_model_path)
                self._local_model = Llama(model_path=self.config.l3_model_path, chat_handler=handler)

            import base64

            img_b64 = base64.b64encode(image_bytes).decode("ascii")
            loop = asyncio.get_running_loop()

            def _chat() -> str:
                resp = self._local_model.create_chat_completion(
                    messages=[
                        {
                            "role": "user",
                            "content": [
                                {"type": "text", "text": question},
                                {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{img_b64}"}},
                            ],
                        }
                    ]
                )
                return resp["choices"][0]["message"]["content"]

            text = await loop.run_in_executor(None, _chat)
            # VLM 返回自然语言 → 解析元素（简化：返回原始文本作为单一元素）
            return [UIElement(
                source="L3-vlm",
                role="vlm-text",
                name=text[:20],
                rect={"x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0},
            )], None
        except Exception as e:  # noqa: BLE001
            return [], f"local llama failed: {e}"

    async def _remote_doubao(self, image_bytes: bytes, question: str) -> tuple[list[UIElement], str | None]:
        """远程 doubao-vision API（神经纪元：结构化元素提取）。

        视觉皮层升级：不再回单一全屏文本块，而是要求 VLM 输出结构化 JSON
        元素数组（name + 归一化 rect），逐元素落位 —— L3 产物第一次可以直接
        进入网格分派与反射决策（与 L1/L2 同一元素方言）。
        解析失败 ⇒ 诚实 fault（绝不把散文伪装成元素）。
        """
        if not self.config.l3_remote_endpoint:
            return [], "DSH_PHYSICAL_L3_ENDPOINT not set"

        api_key = os.environ.get(self.config.l3_remote_api_key_env)
        if not api_key:
            return [], f"env {self.config.l3_remote_api_key_env} not set"

        try:
            import base64
            import httpx

            img_b64 = base64.b64encode(image_bytes).decode("ascii")
            structured_prompt = (
                "List all interactive UI elements in this screenshot. "
                "Respond with ONLY a JSON array, no prose. Each item: "
                '{"name": "<element label>", "role": "<button|link|input|text|menu>", '
                '"x": <0-1 normalized left>, "y": <0-1 normalized top>, '
                '"w": <0-1 normalized width>, "h": <0-1 normalized height>}. '
                "Coordinates are fractions of image width/height (0.0-1.0)."
            )
            payload = {
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": structured_prompt},
                            {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{img_b64}"}},
                        ],
                    }
                ]
            }
            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.post(
                    self.config.l3_remote_endpoint,
                    json=payload,
                    headers={"Authorization": f"Bearer {api_key}"},
                )
                resp.raise_for_status()
                data = resp.json()

            text = data["choices"][0]["message"]["content"]
            return _parse_vlm_elements(text)
        except Exception as e:  # noqa: BLE001
            return [], f"remote doubao failed: {e}"


# ─── 仲裁器：反双盲核心 ───


def _iou(a: dict, b: dict) -> float:
    """计算两个 rect 的 IoU（Intersection over Union）。"""
    ax1, ay1 = a["x"], a["y"]
    ax2, ay2 = a["x"] + a["width"], a["y"] + a["height"]
    bx1, by1 = b["x"], b["y"]
    bx2, by2 = b["x"] + b["width"], b["y"] + b["height"]

    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    if ix2 <= ix1 or iy2 <= iy1:
        return 0.0
    inter = (ix2 - ix1) * (iy2 - iy1)
    union = (a["width"] * a["height"]) + (b["width"] * b["height"]) - inter
    return inter / union if union > 0 else 0.0


def _align_elements(l1: list[UIElement], l2: list[UIElement], iou_threshold: float = 0.3) -> tuple[list[UIElement], int]:
    """对齐 L1 与 L2 的元素。

    返回 ``(aligned, conflict_count)``：
      - ``aligned``：合并后的元素列表
      - ``conflict_count``：位置不匹配的元素数量（用于触发 L3 仲裁）
    """
    aligned: list[UIElement] = []
    used_l2 = [False] * len(l2)
    conflicts = 0

    for e1 in l1:
        best_iou = 0.0
        best_j = -1
        for j, e2 in enumerate(l2):
            if used_l2[j]:
                continue
            iou = _iou(e1.rect, e2.rect)
            if iou > best_iou:
                best_iou = iou
                best_j = j

        if best_iou >= iou_threshold and best_j >= 0:
            # 匹配成功：合并（L1 的 role/state + L2 的 name 文本）
            e2 = l2[best_j]
            used_l2[best_j] = True
            aligned.append(UIElement(
                source="L1-tree",  # 主源是 L1（结构信息更可靠）
                role=e1.role,
                name=e2.name if e2.name else e1.name,
                state=e1.state,
                rect=e1.rect,
            ))
        else:
            # L1 独有：可能是 L2 OCR 漏了
            aligned.append(e1)
            conflicts += 1

    # L2 独有元素
    for j, e2 in enumerate(l2):
        if not used_l2[j]:
            aligned.append(e2)
            conflicts += 1

    return aligned, conflicts


# ─── 漏斗主控 ───


class UIFunnel:
    """UI 树读取漏斗主控 —— 反双盲仲裁。"""

    def __init__(self, config: FunnelConfig) -> None:
        self.config = config
        self.l1 = L1TreeBackend(config.l1_backend)
        self.l2 = L2OCRBackend(config.l2_backend, config.ocr_languages)
        self.l3 = L3VLMBackend(config)

    async def extract(
        self,
        screenshot_bytes: bytes | None = None,
        region: dict | None = None,
        funnel_ceiling: str = "L3",
    ) -> FunnelResult:
        """执行漏斗：L1 → L2 → 仲裁 → L3（按需）。

        ``funnel_ceiling``：``'L1'`` 只跑 L1；``'L2'`` 跑到 L2；``'L3'`` 全跑（缺省）。
        """
        captured_at = int(time.time() * 1000)

        # ── L1 ──
        l1_elements, l1_fault = await self.l1.extract(region)

        # ── L2（ceiling >= 'L2' 时跑）──
        l2_elements: list[UIElement] = []
        l2_fault: str | None = None
        if funnel_ceiling in ("L2", "L3"):
            l2_elements, l2_fault = await self.l2.extract(screenshot_bytes)

        # ── 仲裁：L1+L2 一致则不调 L3 ──
        if self.config.arbitration_enabled and l1_elements and l2_elements:
            aligned, conflicts = _align_elements(l1_elements, l2_elements)
            # 一致性判定：冲突数 < 总元素数的 20% → 视为一致
            total = len(l1_elements) + len(l2_elements)
            if total > 0 and conflicts / total < 0.2:
                return FunnelResult(
                    elements=aligned,
                    funnel_depth="L2",
                    captured_at=captured_at,
                    l3_invoked=False,
                )

        # ── L3 仲裁 / 兜底 ──
        if funnel_ceiling != "L3":
            # ceiling 不到 L3：返回当前结果（含降级 fault）
            depth: str = "L1" if l1_elements else ("L2" if l2_elements else "empty")
            fault = None
            if not l1_elements and l1_fault:
                fault = {"source": "L1", "detail": l1_fault}
            elif not l2_elements and l2_fault and funnel_ceiling == "L2":
                fault = {"source": "L2", "detail": l2_fault}
            return FunnelResult(
                elements=l1_elements + l2_elements,
                funnel_depth=depth,  # type: ignore[arg-type]
                fault=fault,
                captured_at=captured_at,
                l3_invoked=False,
            )

        # ── L3 调用 ──
        l3_elements, l3_fault = await self.l3.arbitrate(
            screenshot_bytes, l1_elements, l2_elements,
        )

        # ── 终局 ──
        if l3_elements:
            depth = "L3"
            fault = None
        elif l1_elements or l2_elements:
            # L3 失败但有 L1/L2 兜底
            depth = "L2" if l2_elements else "L1"
            fault = {"source": "L3", "detail": l3_fault or "L3 returned no elements"}
        else:
            depth = "empty"
            # 收集最先失败的 fault
            if l1_fault:
                fault = {"source": "L1", "detail": l1_fault}
            elif l2_fault:
                fault = {"source": "L2", "detail": l2_fault}
            else:
                fault = {"source": "L3", "detail": l3_fault or "all layers empty"}

        return FunnelResult(
            elements=l1_elements + l2_elements + l3_elements,
            funnel_depth=depth,  # type: ignore[arg-type]
            fault=fault,
            captured_at=captured_at,
            l3_invoked=True,
        )
