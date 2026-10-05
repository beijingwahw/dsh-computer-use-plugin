# scripts/realverify/probe_common.py
# ΤΕΛ-9: 真机验证债公共层（Python 侧）——与 common.mjs 同一的退出码立法与
# REALVERIFY 输出契约（形态模仿 python_service/real_probe.py 先例）。
#
# 退出码：0=pass / 1=fail / 2=absent（设备缺席，诚实退出不红）/ 3=degraded。
# 每个探针 stdout 最后一行 = `REALVERIFY <单行 JSON>`，run-all.mjs 只按该行汇总。
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

SCHEMA = "tel9-realverify/1"

EXIT_PASS = 0
EXIT_FAIL = 1
EXIT_ABSENT = 2
EXIT_DEGRADED = 3

VERDICT_EXIT = {"pass": EXIT_PASS, "fail": EXIT_FAIL, "absent": EXIT_ABSENT, "degraded": EXIT_DEGRADED}

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent.parent
PY_SERVICE = REPO_ROOT / "python_service"


def force_absent() -> bool:
    """ΤΕΛ-9: 离线确定性缺席开关（测试专用；生产收割不受影响）。"""
    raw = os.environ.get("DSH_REALVERIFY_FORCE_ABSENT", "")
    return raw in ("1", "true") or "--force-absent" in sys.argv


def ensure_dsh_physical_on_path() -> None:
    """ΤΕΛ-9: dsh_physical 可导入（real_probe.py 同方言——直跑脚本时补 sys.path）。"""
    sp = str(PY_SERVICE)
    if sp not in sys.path:
        sys.path.insert(0, sp)


def _clean(value):
    """ΤΕΛ-9: 证据净化——字符串换行折叠、Path 转 str，保证单行 JSON 可解析。"""
    if isinstance(value, str):
        return value.replace("\r", " ").replace("\n", " ")[:500]
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, dict):
        return {str(k): _clean(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_clean(v) for v in value]
    if isinstance(value, (bool, int, float)) or value is None:
        return value
    return str(value)[:500]


def emit(debt: str, probe: str, verdict: str, summary: str, evidence: dict | None = None,
         elapsed_ms: int = 0, error: str | None = None) -> int:
    """ΤΕΛ-9: 结构化收口——打印 REALVERIFY 单行 JSON 并返回退出码（绝不抛）。"""
    report = {
        "schema": SCHEMA,
        "debt": debt,
        "probe": probe,
        "verdict": verdict,
        "summary": " ".join(str(summary).split())[:500],
        "evidence": _clean(evidence or {}),
        "elapsed_ms": int(elapsed_ms),
    }
    if error is not None:
        report["error"] = " ".join(str(error).split())[:500]
    print("REALVERIFY " + json.dumps(report, ensure_ascii=False))
    return VERDICT_EXIT.get(verdict, EXIT_FAIL)


def run_probe(debt: str, probe: str, main) -> int:
    """ΤΕΛ-9: 探针外包裹——计时 + 异常折叠为结构化 fail（探针绝不裸抛）。

    main() 返回 (verdict, summary, evidence) 三元组；任何异常 ⇒ fail 判决
    （探针自身故障是诚实红，不是缺席）。
    """
    t0 = time.monotonic()
    try:
        verdict, summary, evidence = main()
    except Exception as e:  # noqa: BLE001 —— 探针级诚实失败（不静默，不裸栈）
        import traceback

        traceback.print_exc()
        return emit(debt, probe, "fail", "探针异常（诚实失败码）",
                    {}, int((time.monotonic() - t0) * 1000), error=f"{type(e).__name__}: {e}")
    return emit(debt, probe, verdict, summary, evidence or {}, int((time.monotonic() - t0) * 1000))
