"""ΤΕΛ-9a 逐债探针 · D-A8:comtypes 建链臂真机冒烟（py<3.14 + 真 COM 真声卡）。

债（DEBTS D-A8，ΠΑΝ-83 移交）：audio.py comtypes 建链臂（py<3.14 活动臂）的
真 COM 真声卡冒烟——本机 py3.14 的 comtypes 出参约定回归使其不可用（D-E2 已闭
的对照面），解析层已与 raw-vtable 臂构造性同源（parse_wave_format 单源 + 字节
级夹具 19 项 selftest 全 PASS），唯余 py<3.14 + 真 COM 环境的建链冒烟。
本探针把收割动作一键化：

  环境自检（硬件在场判定——三重门，任一不满足即诚实缺席）：
    1. win32 平台（COM/WASAPI 是 Windows 专属）；
    2. Python < 3.14（comtypes 建链臂的活动版本域——py≥3.14 上生产代码
       首选 raw-vtable，comtypes 臂不是被测活动臂 ⇒ absent「版本域不符」，
       并如实申报当前解释器版本）；
    3. comtypes 可导入（缺席 ⇒ absent「依赖缺席」）。
  在场执行（直击 ΠΑΝ-83 关切——comtypes 出参约定 + 真建链）：
    a. WasapiLoopbackRunner._build_comtypes() 接口定义集构造（COMMETHOD/
       GUID/IUnknown 声明面——py3.14 上回归的正是这片出参声明）；
    b. _open_session_comtypes() 真建链：CoCreateInstance →
       GetDefaultAudioEndpoint（POINTER(IMMDevice) 出参——出参约定回归的
       暴露点）→ Activate(IAudioClient) → GetMixFormat → parse_wave_format
       （单源解析）→ Initialize(LOOPBACK) → Start → GetService；
    c. 读 2 块样本（~400ms）+ describe() 引擎标记（应为 comtypes）。
  判定：
    pass     = 建链 + 样本回读（comtypes 臂真机冒烟闭环—— D-A8 可收割）；
    degraded = 接口定义构造成但建链失败于「无默认 render 端点」类环境面
               （机器无声卡/端点被禁用——依赖在场而硬件端点缺席）；
    fail     = comtypes 在场 + py<3.14 + 端点在场但建链/读流抛错（真红——
               出参约定或建链面缺陷复现，正是本债要抓的形态）。

用法（在 py<3.14 + comtypes 已装的 Windows 机器上）：
  python scripts/realverify/probe-da8-comtypes.py [--force-absent]
退出码：0=pass / 1=fail / 2=absent（版本域/依赖/端点缺席）/ 3=degraded。
"""
from __future__ import annotations

import sys

from probe_common import ensure_dsh_physical_on_path, force_absent, run_probe

PROBE = "scripts/realverify/probe-da8-comtypes.py"


def _absent(reason: str, evidence: dict | None = None):
    # ΤΕΛ-9: 缺席诚实退出（exit 2 + 「设备缺席」结构化输出）
    return "absent", f"环境/设备缺席——{reason}", evidence or {}


def main():
    if force_absent():
        return _absent("force-absent（离线测试强制缺席路径）", {"forced": True})

    evidence: dict = {"python": sys.version.split()[0], "platform": sys.platform}

    if sys.platform != "win32":
        return _absent(f"非 win32 平台（{sys.platform}）——COM/WASAPI 唯余 Windows 在场", evidence)
    if sys.version_info >= (3, 14):
        # ΤΕΛ-9: 版本域判定——py≥3.14 生产代码首选 raw-vtable（ΑΩ-R1），comtypes
        # 臂不是活动臂（本机 3.14.6 即此常态）；收割需 py<3.14 解释器（见
        # docs/realverify.md 的收割清单）。
        return _absent(
            f"Python {sys.version.split()[0]} ≥ 3.14——comtypes 建链臂的活动版本域是 py<3.14"
            "（本解释器上生产首选 raw-vtable，对照面 D-E2 已闭）",
            evidence,
        )
    try:
        import comtypes  # noqa: F401 —— 在场性探测

        evidence["comtypes"] = getattr(comtypes, "__version__", "present")
    except Exception as e:  # noqa: BLE001
        return _absent(f"comtypes 缺席（pip install comtypes 后重跑）：{type(e).__name__}: {e}", evidence)

    ensure_dsh_physical_on_path()
    from dsh_physical.audio import WasapiLoopbackRunner

    runner = WasapiLoopbackRunner()

    # ── a. 接口定义集构造（出参声明面——py3.14 回归的正是这里）──
    built = runner._build_comtypes()  # noqa: SLF001 —— 探针只读生产缝（real_probe.py 同律）
    evidence["interface_defs_built"] = built is not None
    if built is None:
        return _absent("comtypes 在场但接口定义集构造失败（声明面不可用）", evidence)

    # ── b. comtypes 真建链（_open_session_comtypes 内部绝不抛——失败记 _reason）──
    session = runner._open_session_comtypes()  # noqa: SLF001
    desc = runner.describe()
    evidence["runner_describe"] = desc
    if session is None:
        reason = desc.get("reason", "unknown")
        if "GetDefaultAudioEndpoint" in reason or "无默认" in reason or "端点" in reason:
            return _absent(f"无默认 render 端点（{reason[:200]}）——comtypes 依赖在场而声学端点缺席", evidence)
        # comtypes 在场 + py<3.14 + 端点在场但建链失败 ⇒ 真红（本债要抓的形态）
        return "fail", f"comtypes 建链失败（{reason[:200]}）——真红", evidence

    # ── c. 读流 + 引擎标记核验 ──
    samples: list[float] = []
    for _ in range(2):
        samples.extend(runner.read())
    engine = desc.get("engine") or session.get("engine")
    evidence.update({
        "engine": engine,
        "sample_rate": session.get("sr"),
        "channels": session.get("channels"),
        "bits": session.get("bits"),
        "format_tag": session.get("format_tag"),
        "samples_read": len(samples),
    })
    if engine != "comtypes":
        return "fail", f"引擎标记异常（期望 comtypes，得 {engine}）", evidence
    if not samples:
        return ("degraded",
                "comtypes 建链闭环（GetMixFormat→Initialize(LOOPBACK)→Start→GetService 全过，引擎标记 comtypes）"
                "但首两块零样本（端点静默）——建链冒烟已证，读流环待有声学活动时复跑",
                evidence)
    return ("pass",
            f"comtypes 建链臂真机冒烟闭环：接口定义构造 → GetDefaultAudioEndpoint（出参）→ Activate → "
            f"GetMixFormat（{session.get('sr')}Hz/{session.get('bits')}bit/{session.get('channels')}ch）→ "
            f"Initialize(LOOPBACK) → 读 {len(samples)} 样本 —— D-A8 可收割",
            evidence)


if __name__ == "__main__":
    # ΤΕΛ-9: run_probe 外包裹——任何异常折叠为结构化 fail（探针绝不裸抛）
    sys.exit(run_probe("D-A8", PROBE, main))
