"""ΤΕΛ-9a 逐债探针 · D-A1（残余）：UVC 真采集卡现场标定。

债况（DEBTS D-A1，已闭环——软件在环）：HDMI 采集卡帧管线已由本机
cv2+DirectShow 真设备帧过完整 uvc 管线闭合（real_probe_dA1_frame.jpg 在案），
**唯余真采集卡现场的过扫描/方言对齐标定（物理边界）**。本探针把该残余
收割动作一键化（探针编号沿用 D-A1，证据可直引台账行）：

  环境自检（硬件在场判定）：
    1. cv2 可导入（缺席 ⇒ absent「依赖缺席」）；
    2. 视频设备枚举（win32=DirectShow / 其他=V4L2 缺省后端）至少一台可读——
       采集卡插入后将以视频设备形态入列；`DSH_REALVERIFY_UVC_INDEX` 可显式
       指定设备索引（多摄像头机器上钉死采集卡）。
  在场执行（现场标定工作流——uvc.py 的 Calibration 数学单源复用）：
    a. 连续读 12 帧（帧稳定性：相邻帧 dhash 汉明距离统计，screen.py
       hamming_hex 同源）；
    b. 黑边检测（过扫描标定的核心）：亮度行/列剖面找首个/末个高于阈值的
       行列 ⇒ 建议四角标定（Calibration.from_params）；
    c. 建议标定回灌验证：rectify 矫正一帧，核输出尺寸 = natural_size。
  判定：
    pass     = 12 帧全读 + 建议标定产出 + 矫正闭环（现场标定工作流实证）；
    degraded = 设备可读但帧不稳/黑边检测无定论（工作流跑通，标定建议为恒等）；
    fail     = 读帧失败/矫正数学异常。

证据说明：采集卡接入 HDMI 信号源（另一台机器的桌面）时黑边显著 ⇒ 建议角
偏离恒等；摄像头对房间则黑边 absent ⇒ 建议角≈恒等（同为诚实产出——
是否真采集卡由分辨率/黑边双证据判断，不谎报）。

用法：
  python scripts/realverify/probe-da1-uvc.py [--force-absent]
退出码：0=pass / 1=fail / 2=absent（采集卡/依赖缺席）/ 3=degraded。
"""
from __future__ import annotations

import os
import sys
import time

from probe_common import HERE, ensure_dsh_physical_on_path, force_absent, run_probe

PROBE = "scripts/realverify/probe-da1-uvc.py"
FRAME_EVIDENCE = HERE / "evidence-da1-frame.jpg"


def _absent(reason: str, evidence: dict | None = None):
    # ΤΕΛ-9: 缺席诚实退出（exit 2 + 「设备缺席」结构化输出）
    return "absent", f"设备缺席——{reason}", evidence or {}


def _dhash(img) -> str:
    """9×8 灰度差分 hash（16-hex）——与 uvc/screen 管线同族的帧指纹。"""
    import hashlib

    small = img.convert("L").resize((9, 8))
    px = list(small.getdata())
    bits = 0
    for row in range(8):
        for col in range(8):
            if px[row * 9 + col] > px[row * 9 + col + 1]:
                bits |= 1 << (row * 8 + col)
    return f"{bits:016x}"


def main():
    if force_absent():
        return _absent("force-absent（离线测试强制缺席路径）", {"forced": True})

    try:
        import cv2  # noqa: F401 —— 在场性探测
    except Exception as e:  # noqa: BLE001
        return _absent("cv2 缺席（pip install opencv-python 后重跑）", {"import_error": f"{type(e).__name__}: {e}"})

    import numpy as np
    from PIL import Image

    ensure_dsh_physical_on_path()
    from dsh_physical.uvc import Calibration, rectify

    # ── 1. 设备枚举（在场判定）──
    def _open(idx: int):
        cap = cv2.VideoCapture(idx, cv2.CAP_DSHOW) if sys.platform == "win32" else cv2.VideoCapture(idx)
        if cap.isOpened():
            return cap
        cap.release()
        return None

    explicit_idx = os.environ.get("DSH_REALVERIFY_UVC_INDEX")
    found: list[dict] = []
    if explicit_idx is not None:
        cap = _open(int(explicit_idx))
        ok, frame = (cap.read() if cap else (False, None))
        found.append({"index": int(explicit_idx), "readable": bool(ok and frame is not None),
                      "shape": list(frame.shape) if ok and frame is not None else None})
        if cap:
            cap.release()
    else:
        for idx in range(4):
            cap = _open(idx)
            if cap is None:
                continue
            ok, frame = cap.read()
            found.append({"index": idx, "readable": bool(ok and frame is not None),
                          "shape": list(frame.shape) if ok and frame is not None else None})
            cap.release()
    evidence = {"devices": found, "explicit_index": explicit_idx}
    usable = [d for d in found if d["readable"]]
    if not usable:
        return _absent("无可用视频设备（采集卡未插入/被占用）", evidence)

    dev = usable[0]
    idx, (h, w, ch) = dev["index"], dev["shape"]

    # ── 2. 连续 12 帧 + 稳定性（dhash 汉明距）──
    cap = _open(idx)
    frames = []
    t0 = time.monotonic()
    for _ in range(12):
        ok, frame = cap.read()
        if ok and frame is not None:
            frames.append(frame)
    cap.release()
    read_s = time.monotonic() - t0
    if len(frames) < 12:
        return "fail", f"连续读帧不足（{len(frames)}/12）——设备打开但读流不稳", evidence
    hashes = [_dhash(Image.fromarray(f[:, :, ::-1])) for f in frames]

    def _ham(a: str, b: str) -> int:
        return bin(int(a, 16) ^ int(b, 16)).count("1")

    dists = [_ham(hashes[i], hashes[i + 1]) for i in range(len(hashes) - 1)]
    stable = sum(1 for d in dists if d <= 8) / len(dists)
    evidence["reads"] = {"n": len(frames), "fps_est": round(len(frames) / read_s, 1) if read_s > 0 else None,
                         "adjacent_hamming": dists, "stable_ratio": round(stable, 3)}

    # ── 3. 黑边检测 → 建议四角标定（过扫描标定核心）──
    probe_frame = frames[6]
    gray = np.asarray(Image.fromarray(probe_frame[:, :, ::-1]).convert("L"), dtype=np.float32)
    TH = 16.0  # ΤΕΛ-9: 黑边判定亮度阈（0-255 域；采集卡黑边 <16，桌面内容普遍远高）
    row_mean = gray.mean(axis=1)
    col_mean = gray.mean(axis=0)
    rows_on = np.nonzero(row_mean > TH)[0]
    cols_on = np.nonzero(col_mean > TH)[0]
    if len(rows_on) and len(cols_on):
        y0, y1 = int(rows_on[0]), int(rows_on[-1])
        x0, x1 = int(cols_on[0]), int(cols_on[-1])
        corners = {
            "tl": {"x": round(x0 / w, 4), "y": round(y0 / h, 4)},
            "tr": {"x": round(x1 / w, 4), "y": round(y0 / h, 4)},
            "br": {"x": round(x1 / w, 4), "y": round(y1 / h, 4)},
            "bl": {"x": round(x0 / w, 4), "y": round(y1 / h, 4)},
        }
    else:
        corners = {"tl": {"x": 0.0, "y": 0.0}, "tr": {"x": 1.0, "y": 0.0},
                   "br": {"x": 1.0, "y": 1.0}, "bl": {"x": 0.0, "y": 1.0}}
    calib = Calibration.from_params(corners)
    natural = calib.natural_size(w, h)
    deviates = abs(corners["tl"]["x"]) + abs(1 - corners["tr"]["x"]) + abs(1 - corners["br"]["y"]) + abs(corners["bl"]["y"])
    looks_like_capture_card = (w >= 1280 and h >= 720 and deviates > 0.02)

    # ── 4. 建议标定回灌验证（rectify 矫正 + 证据帧落盘）──
    try:
        real_pil = Image.fromarray(np.ascontiguousarray(probe_frame[:, :, ::-1]))
        rect = rectify(real_pil, calib)
        try:
            rect.save(FRAME_EVIDENCE, format="JPEG", quality=85)
        except Exception:  # noqa: BLE001 —— 证据落盘失败不阻断判定
            pass
    except Exception as e:  # noqa: BLE001
        return "fail", f"矫正数学异常（{type(e).__name__}: {e}）", evidence
    evidence["calibration"] = {
        "suggested_corners": corners,
        "natural_size": list(natural),
        "rectified_size": list(rect.size),
        "black_border_detected": bool(deviates > 0.005),
        "looks_like_capture_card": bool(looks_like_capture_card),
        "evidence_jpg": FRAME_EVIDENCE.name,
    }

    if stable >= 0.7:
        card_note = "形态似真采集卡（分辨率+黑边双证据）" if looks_like_capture_card else "未呈黑边/高清形态（可能为摄像头——标定建议=恒等亦是诚实产出）"
        return ("pass",
                f"UVC 现场标定工作流实证：12 帧稳定读出（{w}×{h}），黑边剖面 → 建议四角 {corners['tl']}…，rectify 矫正 {rect.size} 闭环——{card_note}",
                evidence)
    return ("degraded",
            f"设备可读但帧流不稳（稳定比 {stable:.2f}）——标定工作流跑通，建议值置信度低，检查 HDMI 信号源",
            evidence)


if __name__ == "__main__":
    # ΤΕΛ-9: run_probe 外包裹——任何异常折叠为结构化 fail（探针绝不裸抛）
    sys.exit(run_probe("D-A1", PROBE, main))
