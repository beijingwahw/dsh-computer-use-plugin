"""ΤΕΛ-9a 逐债探针 · D-A4:WASAPI 声学真环（真麦克风/系统提示音采集）。

债（DEBTS D-A4）：真麦克风/系统提示音采集——合成波形桥只证分类器，唯余
真声学输出→回环→分类的整环在生产环境长跑。本探针把收割动作一键化
（audio.py 生产 runner 单源复用，ΑΩ-R1 双引擎分治下引擎形态如实申报）：

  环境自检（硬件在场判定）：
    1. win32 平台（WASAPI loopback 是 Windows 专属——非 win32 ⇒ absent）；
    2. WasapiLoopbackRunner（运行层绝不抛）read() 建链——describe() 诚实
       能力声明：available=false ⇒ absent（无 render 端点/引擎不可用，
       reason 逐字带回）。
  在场执行（真声学在环闭环——real_probe D-A4 同语义，走生产 runner）：
    a. runner.read() 暖机 + 连续采集 ~2s 单声道样本（引擎标记：
       raw-vtable（py≥3.14）/ comtypes（py<3.14）如实入证据）；
    b. winsound 真播放合成叮声（synth_notification_ding 同源合成——走系统
       render 路径，与回环捕获同一 mix bus）；
    c. 采后窗喂 classify_window 纯函数分类器 → 5 类判决。
  判定：
    pass     = 建链 + 播放 + 回环采到样本 + 分类非静默（真声学整环闭环）；
    degraded = 建链 + 样本在但静默（播放路径缺席或窗口未检出非静默——
               部分实证）；
    fail     = runner 在场声明 available 但读流中途死亡（describe 申报）。

用法：
  python scripts/realverify/probe-da4-audio.py [--force-absent]
退出码：0=pass / 1=fail / 2=absent（声学端点缺席）/ 3=degraded。
"""
from __future__ import annotations

import sys
import time

from probe_common import ensure_dsh_physical_on_path, force_absent, run_probe

PROBE = "scripts/realverify/probe-da4-audio.py"


def _absent(reason: str, evidence: dict | None = None):
    # ΤΕΛ-9: 缺席诚实退出（exit 2 + 「设备缺席」结构化输出）
    return "absent", f"设备缺席——{reason}", evidence or {}


def _write_wav(path, samples, sr: int) -> None:
    # ΤΕΛ-9: 合成叮声落 wav（winsound 播放的载体）——real_probe.py 同配方
    import array
    import wave

    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(array.array("h", (max(-32767, min(32767, int(x * 32767))) for x in samples)).tobytes())


def main():
    if force_absent():
        return _absent("force-absent（离线测试强制缺席路径）", {"forced": True})

    if sys.platform != "win32":
        return _absent(f"非 win32 平台（{sys.platform}）——WASAPI 唯余 Windows 在场", {"platform": sys.platform})

    ensure_dsh_physical_on_path()
    from dsh_physical.audio import WasapiLoopbackRunner, classify_window, synth_notification_ding

    # ── 1. 建链在场判定（runner 绝不抛——describe 是诚实权威）──
    runner = WasapiLoopbackRunner()
    warmup = runner.read()  # ΤΕΛ-9: 首读触发 _ensure_session（COM 延迟建链）
    desc = runner.describe()
    evidence = {"runner": desc, "warmup_samples": len(warmup)}
    if not desc.get("available"):
        reason = desc.get("reason", "unknown")
        # py3.14+ 的 comtypes 出参约定回归属已知环境事实（D-E2/D-A8 在案）——
        # raw-vtable 是该侧的首选路径，二者皆缺席才落到这里 ⇒ 诚实缺席。
        return _absent(f"WASAPI 回环不可用（{reason[:200]}）", evidence)

    # ── 2. 真播放 → 回环采集 ~2.5s ──
    played, play_note = False, ""
    sr = int(desc.get("sample_rate") or 48000)
    wav_path = None
    try:
        import os
        import tempfile

        import winsound  # type: ignore[import-not-found]

        # ΤΕΛ-9 终验小修：临时 wav 不经上下文管理器删除——SND_ASYNC 播放期间
        # 系统仍持文件句柄，删早了撞 WinError 32，把「播放成功」误记成播放
        # 异常（污染 playback.note 的诚实性）。改为：mkstemp 落 wav → 异步播
        # 放 → 采集窗结束后（句柄早已释放）best-effort 清理（PURGE+unlink，
        # 失败即留给 OS 临时目录回收，绝不影响判定）。
        fd, wav_path = tempfile.mkstemp(suffix=".wav")
        os.close(fd)
        _write_wav(wav_path, synth_notification_ding(48_000), 48_000)
        winsound.PlaySound(wav_path, winsound.SND_FILENAME | winsound.SND_ASYNC)
        played = True
    except Exception as e:  # noqa: BLE001 —— 播放路径缺席 = 诚实降级，不阻断采集
        play_note = f"{type(e).__name__}: {e}"
    evidence["playback"] = {"played": played, "note": play_note}

    samples: list[float] = list(warmup)
    t0 = time.monotonic()
    while time.monotonic() - t0 < 2.5:
        block = runner.read()  # ΤΕΛ-9: 生产 runner 的真读路径（≤200ms/块）
        samples.extend(block)
        if not block and not runner.describe().get("available"):
            break
    # ΤΕΛ-9 终验小修：播放句柄此刻已释放（采集窗 2.5s ≫ 叮声时长）——清理
    if wav_path is not None:
        try:
            import winsound  # type: ignore[import-not-found]

            winsound.PlaySound(None, winsound.SND_PURGE)
        except Exception:  # noqa: BLE001
            pass
        try:
            import os

            os.unlink(wav_path)
        except Exception:  # noqa: BLE001
            pass
    desc_after = runner.describe()
    evidence["capture"] = {"samples": len(samples), "seconds": round(len(samples) / max(1, sr), 2),
                           "sample_rate": sr, "runner_after": desc_after}
    if not desc_after.get("available"):
        return "fail", f"读流中途通道死亡（{desc_after.get('reason', '')[:160]}）——真红", evidence

    # ── 3. 分类器判决（真回环样本喂纯函数）──
    window = samples[-int(sr * 2.0):] if len(samples) > sr else samples
    verdict = classify_window(window, sr) if window else {"event": "no-samples", "confidence": 0.0}
    evidence["classifier"] = verdict

    if verdict.get("event") == "no-samples":
        return "degraded", "建链在但零样本回读（render 混音总线静默且无声学输出）——部分实证", evidence
    if played and verdict.get("event") != "silence":
        engine = desc.get("engine", "unknown")
        return ("pass",
                f"真声学整环闭环：播放合成叮声 → WASAPI 回环 → 分类 = {verdict.get('event')}（conf {verdict.get('confidence')}，引擎 {engine}）—— D-A4 可收割",
                evidence)
    return ("degraded",
            f"回环样本在（{len(samples)} 帧）但分类为 {verdict.get('event')}（播放 {'缺席:' + play_note if not played else '已发'}）——采集臂实证，整环未闭合",
            evidence)


if __name__ == "__main__":
    # ΤΕΛ-9: run_probe 外包裹——任何异常折叠为结构化 fail（探针绝不裸抛）
    sys.exit(run_probe("D-A4", PROBE, main))
