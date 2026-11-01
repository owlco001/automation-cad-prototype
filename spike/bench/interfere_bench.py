#!/usr/bin/env python3
"""布尔复核 sidecar 压测：量「首次 vs 后续」与每对成本。

为什么要这个脚本：文档里“布尔复核要 60~180 s、要常驻 daemon 省冷启动”的说法，
在我们真实案例上一直没被验证过。这个脚本用正确的 /interfere 契约
（members[].ops/offset + 全组合布尔）直接打 sidecar，给出可复现的数字。

用法：
    FT_BUILD_PORT=17998 python featuretree-service/rebuild-sidecar.py &
    python spike/bench/interfere_bench.py --url http://127.0.0.1:17998 --members 20 --runs 3

2026-10-31 实测（20 成员 = 190 对，box 40mm，间距 25mm）：
    n=20 pairs=19 checked=20 total=374ms per-pair=1.97ms
    n=20 pairs=19 checked=20 total=328ms per-pair=1.73ms
    n=20 pairs=19 checked=20 total=323ms per-pair=1.70ms
→ 首次与后续差 < 20%，没有可观的冷启动可省；成本主要在每对布尔（~1.7 ms）。

结论：想提速应该减「对」（BVH/AABB 剪枝、配合面豁免），而不是先做常驻 daemon。
"""

from __future__ import annotations

import argparse
import json
import time
import urllib.request


def members(count: int, step_mm: float) -> list[dict]:
    return [
        {"ops": [{"op": "box", "length": 40, "width": 40, "height": 40}], "offset": [i * step_mm, 0, 0]}
        for i in range(count)
    ]


def call(url: str, body: dict, timeout: float = 120.0) -> tuple[float, dict]:
    payload = json.dumps(body).encode("utf-8")
    request = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"})
    started = time.perf_counter()
    with urllib.request.urlopen(request, timeout=timeout) as response:
        data = json.loads(response.read())
    return (time.perf_counter() - started) * 1000, data


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:17998/interfere")
    parser.add_argument("--members", type=int, default=20)
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--step", type=float, default=25.0)
    args = parser.parse_args()

    for run in range(1, args.runs + 1):
        ms, data = call(args.url, {"members": members(args.members, args.step)})
        if not data.get("ok"):
            print(f"run{run} FAILED {str(data.get('message'))[:160]}")
            return 1
        pairs = args.members * (args.members - 1) // 2
        print(
            f"run{run} members={data['checked']} pairs={pairs} hits={len(data['pairs'])} "
            f"total={ms:.0f}ms per-pair={ms / max(1, pairs):.2f}ms"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
