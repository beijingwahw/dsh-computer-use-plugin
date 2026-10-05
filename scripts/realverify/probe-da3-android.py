"""ΤΕΛ-9a 逐债探针 · D-A3:Android 真机 adb/scrcpy 端到端（mini 套件）。

债（DEBTS D-A3）：Android 设备入列的真 adb/scrcpy 端到端——离线契约已由
test/w4mobile.test.ts 以注入桩闭（无设备 CI 的诚实 skip 通道），唯余真设备。
本探针把收割动作一键化（走仓库自己的 android.py 生产控制器，不另造协议）：

  环境自检（硬件在场判定）：
    1. adb 可执行在场（PATH / ANDROID_HOME platform-tools / DSH_REALVERIFY_ADB）；
    2. `adb devices` 至少一台 state=device 的设备（offline/unauthorized 如实
       列出但不算在场——它们无法执行套件）。
  在场执行（mini 套件，AndroidController 真路径）：
    a. list_devices() 清单 + 分辨率（wm size 缓存穿透）；
    b. resolution_or_raise(serial)——归一化换算分母；
    c. grab_frame(serial)——帧源降级链真执行（常驻流 → scrcpy --screenshot
       → adb exec-out screencap），帧证据 PNG 落盘；
    d. （可选，默认关）注入面冒烟：key/tap/type_text——设备状态会被改变，
       需 DSH_REALVERIFY_ANDROID_INJECT=1 显式同意（默认只做无副作用的读面）。
  判定：
    pass     = a+b+c 全成（帧拿到且尺寸>0）；
    degraded = 清单/分辨率成但帧降级到 adb screencap（scrcpy 缺席——降级链
               语义正确，带宽优选未证）；
    fail     = 任一步真败（PhysicalError 信封）。

用法：
  python scripts/realverify/probe-da3-android.py [--force-absent]
退出码：0=pass / 1=fail / 2=absent（设备缺席）/ 3=degraded。
"""
from __future__ import annotations

import os
import shutil
import sys

from probe_common import HERE, ensure_dsh_physical_on_path, force_absent, run_probe

PROBE = "scripts/realverify/probe-da3-android.py"
FRAME_EVIDENCE = HERE / "evidence-da3-frame.png"


def _find_adb() -> str | None:
    # ΤΕΛ-9: adb 发现——env 覆盖 > PATH > ANDROID_HOME/platform-tools
    cand = os.environ.get("DSH_REALVERIFY_ADB")
    if cand and os.path.isfile(cand):
        return cand
    on_path = shutil.which("adb")
    if on_path:
        return on_path
    ah = os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT")
    if ah:
        for sub in ("platform-tools/adb.exe", "platform-tools/adb"):
            p = os.path.join(ah, sub)
            if os.path.isfile(p):
                return p
    return None


def _absent(reason: str, evidence: dict | None = None):
    # ΤΕΛ-9: 缺席诚实退出（exit 2 + 「设备缺席」结构化输出）
    return "absent", f"设备缺席——{reason}", evidence or {}


def main():
    if force_absent():
        return _absent("force-absent（离线测试强制缺席路径）", {"forced": True})

    adb = _find_adb()
    if not adb:
        return _absent("adb 缺席（PATH/ANDROID_HOME 未命中——装 platform-tools 后重跑）", {"adb": None})
    os.environ["PATH"] = os.path.dirname(adb) + os.pathsep + os.environ.get("PATH", "")

    ensure_dsh_physical_on_path()
    from dsh_physical.config import AndroidConfig
    from dsh_physical.errors import PhysicalError

    cfg = AndroidConfig(enabled=True, adb_path=adb)
    from dsh_physical.android import AndroidController  # ΤΕΛ-9: 仓库生产控制器（真端到端，不另造协议）

    evidence: dict = {"adb": adb, "scrcpy": shutil.which("scrcpy")}

    # ── a. 设备清单（在场判定的权威源：adb devices 事实）──
    try:
        ctl = AndroidController(cfg)
        inv = ctl.list_devices()
    except Exception as e:  # noqa: BLE001 —— 探针绝不抛，结构化 fail
        return "fail", f"AndroidController 构造/清单失败：{type(e).__name__}: {e}", evidence
    evidence["inventory"] = {"degraded": inv.get("degraded"), "reason": inv.get("reason"),
                             "devices": inv.get("devices", [])[:4]}
    ready = [d for d in inv.get("devices", []) if d.get("state") == "device"]
    if not ready:
        others = [(d.get("serial"), d.get("state")) for d in inv.get("devices", [])]
        reason = inv.get("reason") or (f"有设备但无就绪态（{others}——offline/unauthorized 需在设备端授权）" if others else "adb devices 空")
        ctl.close()
        return _absent(f"无就绪 Android 设备（{reason}）", evidence)
    serial = os.environ.get("DSH_REALVERIFY_ANDROID_SERIAL") or ready[0]["serial"]
    evidence["serial"] = serial

    # ── b. 分辨率（归一化契约的分母锚点）──
    try:
        w, h = ctl.resolution_or_raise(serial)
    except PhysicalError as e:
        ctl.close()
        return "fail", f"分辨率解析失败（{e.detail[:160]}）", evidence
    evidence["resolution"] = {"width": w, "height": h}

    # ── c. 帧源降级链真执行（scrcpy → adb screencap）──
    try:
        img, note = ctl.grab_frame(serial)
    except PhysicalError as e:
        ctl.close()
        return "fail", f"取帧失败（{e.detail[:160]}）", evidence
    except Exception as e:  # noqa: BLE001
        ctl.close()
        return "fail", f"取帧异常：{type(e).__name__}: {e}", evidence
    try:
        img.save(FRAME_EVIDENCE)  # ΤΕΛ-9: 帧证据落盘（收割时随台账行引用）
    except Exception:  # noqa: BLE001 —— 证据落盘失败不阻断判定
        pass
    evidence["frame"] = {"size": list(img.size), "note": note, "evidence_png": str(FRAME_EVIDENCE.name)}
    if img.size[0] < 1 or img.size[1] < 1:
        ctl.close()
        return "fail", "帧尺寸非法（{}×{}）".format(*img.size), evidence

    # ── d. 注入面冒烟（默认关——设备状态改变的显式同意门）──
    injected: list[str] = []
    if os.environ.get("DSH_REALVERIFY_ANDROID_INJECT") == "1":
        try:
            ctl.key(serial, ["home"])  # ΤΕΛ-9: home 键——最弱副作用的注入面代表
            injected.append("key:home")
        except PhysicalError as e:
            ctl.close()
            return "fail", f"注入冒烟失败（key home：{e.detail[:160]}）", evidence
    evidence["injected"] = injected
    ctl.close()

    src = note or ""
    if "degraded" in src:
        return ("degraded",
                f"Android 真机在环：清单+分辨率+帧全成（{w}×{h}），但帧降级 adb screencap（{src}）——降级链语义正确，scrcpy 带宽优选未证",
                evidence)
    return ("pass",
            f"Android 真机端到端：清单+分辨率（{w}×{h}）+帧源链全成（{src or 'scrcpy/adb 直取'}）—— D-A3 可收割"
            + ("（含注入冒烟）" if injected else ""),
            evidence)


if __name__ == "__main__":
    # ΤΕΛ-9: run_probe 外包裹——任何异常折叠为结构化 fail（探针绝不裸抛）
    sys.exit(run_probe("D-A3", PROBE, main))
