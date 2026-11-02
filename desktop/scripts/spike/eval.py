#!/usr/bin/env python3
"""运动副识别 spike 评测：拿 brep_joints 的 JSON 输出对真值表逐条比对。

用法：
  python3 eval.py truth/kinematics-analytic.json
  python3 eval.py truth/repo-fixture.json --bin ./brep_joints

输出：
  - 逐条「真值 vs 估测」表（零件对、类型、轴夹角误差、置信度）
  - precision / recall / 类型命中率
  - 面数、耗时（读 STEP / 分析）

判定口径：
  - 候选与真值按「零件对」匹配（无序），一个候选最多匹配一条真值。
  - 型别一致才算 type 命中；轴夹角 < 15° 才记轴命中（移动副/转动副都要轴）。
  - 真值有、候选没有 → 漏检；候选有、真值没有 → 误报。
"""
from __future__ import annotations

import argparse
import json
import math
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def unit(v):
    n = math.sqrt(sum(x * x for x in v)) or 1.0
    return [x / n for x in v]


def axis_err_deg(a, b):
    d = abs(sum(x * y for x, y in zip(unit(a), unit(b))))
    return math.degrees(math.acos(min(1.0, d)))


def fmt_axis(v):
    return "(%+.0f,%+.0f,%+.0f)" % tuple(v)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("truth")
    ap.add_argument("--bin", default=os.path.join(HERE, "brep_joints"))
    ap.add_argument("--json-out", default=None)
    args = ap.parse_args()

    with open(args.truth, "r", encoding="utf-8") as fh:
        spec = json.load(fh)
    step = os.path.normpath(os.path.join(HERE, spec["file"]))
    if not os.path.exists(step):
        print("缺 STEP：%s（先跑 make_fixture 或检查路径）" % step, file=sys.stderr)
        return 1

    proc = subprocess.run([args.bin, step, "--json"], capture_output=True, text=True)
    if proc.returncode != 0:
        print(proc.stderr, file=sys.stderr)
        return proc.returncode
    data = json.loads(proc.stdout)
    cands = data["candidates"]
    truth = spec["joints"]

    def key(a, b):
        return tuple(sorted((a, b)))

    used = set()
    rows = []
    for t in truth:
        ta, tb = t["parts"]
        hit = None
        for i, c in enumerate(cands):
            if i in used:
                continue
            if key(c["nameA"], c["nameB"]) == key(ta, tb):
                hit = (i, c)
                break
        if hit is None:
            rows.append({"truth": t, "cand": None, "typeOk": False, "angErr": None})
            continue
        idx, c = hit
        used.add(idx)
        ang = axis_err_deg(c["axis"], t["axis"])
        rows.append({"truth": t, "cand": c, "typeOk": c["type"] == t["type"], "angErr": ang})

    print("== %s ==" % os.path.relpath(step, HERE))
    print(
        "零件 %d · 面 %d（平面 %d / 圆柱 %d） · 读 STEP %.1fms · 分析 %.1fms"
        % (
            data["parts"],
            data["faces"],
            data["planeFaces"],
            data["cylinderFaces"],
            data["readMs"],
            data["analyzeMs"],
        )
    )
    print()
    header = "%-34s %-10s %-10s %-6s %-6s %s" % ("真值零件对", "真值型别", "估测型别", "轴误差", "置信度", "结论")
    print(header)
    print("-" * len(header))
    matched = type_ok = axis_ok = 0
    for r in rows:
        t = r["truth"]
        pair = "%s ↔ %s" % (t["parts"][0], t["parts"][1])
        if r["cand"] is None:
            print("%-34s %-10s %-10s %-6s %-6s 漏检" % (pair[:34], t["type"], "—", "—", "—"))
            continue
        c = r["cand"]
        matched += 1
        verdict = "命中"
        if r["typeOk"]:
            type_ok += 1
        else:
            verdict = "型别错"
        if r["angErr"] is not None and r["angErr"] <= 15.0:
            axis_ok += 1
        else:
            verdict += "/轴错" if r["typeOk"] else ""
        print(
            "%-34s %-10s %-10s %5.1f° %5.2f  %s（轴 %s vs 真值 %s）"
            % (
                pair[:34],
                t["type"],
                c["type"],
                r["angErr"] if r["angErr"] is not None else -1,
                c["confidence"],
                verdict,
                fmt_axis(c["axis"]),
                fmt_axis(t["axis"]),
            )
        )

    extra = [c for i, c in enumerate(cands) if i not in used]
    for c in extra:
        print(
            "%-34s %-10s %-10s %-6s %5.2f  误报"
            % ("%s ↔ %s" % (c["nameA"], c["nameB"])[:34], "—", c["type"], "—", c["confidence"])
        )

    n_truth = len(truth)
    n_cand = len(cands)
    print()
    print(
        "命中 %d/%d（型别对 %d，轴对 %d）· 候选 %d 条，误报 %d 条 · precision %.0f%% · recall %.0f%%"
        % (
            matched,
            n_truth,
            type_ok,
            axis_ok,
            n_cand,
            len(extra),
            100.0 * (n_cand - len(extra)) / n_cand if n_cand else 0.0,
            100.0 * matched / n_truth if n_truth else 0.0,
        )
    )
    strict = sum(
        1
        for r in rows
        if r["cand"] is not None and r["typeOk"] and r["angErr"] is not None and r["angErr"] <= 15.0
    )
    print("严格正确（型别 + 轴 ≤15°）：%d/%d" % (strict, n_truth))

    if args.json_out:
        with open(args.json_out, "w", encoding="utf-8") as fh:
            json.dump(
                {
                    "file": os.path.relpath(step, HERE),
                    "parts": data["parts"],
                    "faces": data["faces"],
                    "cylinderFaces": data["cylinderFaces"],
                    "readMs": data["readMs"],
                    "analyzeMs": data["analyzeMs"],
                    "truth": n_truth,
                    "candidates": n_cand,
                    "matched": matched,
                    "typeOk": type_ok,
                    "strict": strict,
                    "falsePositives": len(extra),
                    "rows": [
                        {
                            "pair": r["truth"]["parts"],
                            "truthType": r["truth"]["type"],
                            "estType": r["cand"]["type"] if r["cand"] else None,
                            "axisErrDeg": r["angErr"],
                            "confidence": r["cand"]["confidence"] if r["cand"] else None,
                        }
                        for r in rows
                    ],
                },
                fh,
                ensure_ascii=False,
                indent=2,
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
