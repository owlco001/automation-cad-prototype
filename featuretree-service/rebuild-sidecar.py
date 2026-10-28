#!/usr/bin/env python3
"""FeatureTree 重建 sidecar（build123d / OCCT）。

给 featuretree-service 提供真实几何结果：按契约算子（box/cylinder/holes/counterbore/slot/fillet）
建实体，返回体积（mm³）、包围盒与质量（按密度，默认钢 7.85 g/cm³——密度是输入，不是猜的）。

用法（需要带 build123d 的 Python）：
    FT_BUILD_PORT=17999 /path/to/python rebuild-sidecar.py
服务端把它接上：
    FT_BUILD_URL=http://127.0.0.1:17999 node server.mjs

契约：
    POST /rebuild {"ops":[...], "densityGPerCm3": 7.85}
      -> {"ok":true,"volumeMm3":95306.9,"bboxMm":{"x":90,"y":90,"z":12},"massKg":0.748,"fingerprint":"..."}
      -> {"ok":false,"message":"..."}
    GET /health -> {"ok":true,"kernel":"build123d 0.13.0"}
"""
import hashlib
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from build123d import Align, Box, Cylinder, Pos, fillet  # noqa: F401

# 板体按「底面贴 z=0、向上生长」建，和画布/装配的坐标口径一致；
# build123d 的 Box 默认以原点为中心，直接用会让孔深与板厚错位（实测体积差 8%）。
BOX_ALIGN = (Align.CENTER, Align.CENTER, Align.MIN)

MAX_OPS = 64
LAST_SOLID = None  # 最近一次成功重建的实体，供 /stl 导出给客户端渲染
DEFAULT_DENSITY = 7.85  # g/cm³，结构钢；调用方可以传入别的密度


def build(ops, density):
    if not isinstance(ops, list) or not ops:
        return {"ok": False, "message": "没有可构建的算子"}
    if len(ops) > MAX_OPS:
        return {"ok": False, "message": f"算子数量 {len(ops)} 超过上限 {MAX_OPS}"}

    solid = None
    for op in ops:
        kind = op.get("op")
        if kind == "box":
            length = float(op.get("length", 0))
            width = float(op.get("width", 0))
            height = float(op.get("height", 0))
            if min(length, width, height) <= 0:
                return {"ok": False, "message": "box 的 length/width/height 必须大于 0"}
            box = Box(length, width, height, align=BOX_ALIGN)
            solid = box if solid is None else solid + box
        elif kind in ("holes", "counterbore"):
            if solid is None:
                return {"ok": False, "message": "孔特征缺少基体（先有 box）"}
            positions = op.get("positions") or []
            if not isinstance(positions, list) or not positions:
                return {"ok": False, "message": "孔特征缺少 positions"}
            top_z = solid.bounding_box().max.Z  # 板体已按 align=MIN 建，这里就是板厚
            for position in positions:
                if not (isinstance(position, list) and len(position) == 2):
                    return {"ok": False, "message": "positions 必须是 [x, y] 二元数组"}
                x, y = float(position[0]), float(position[1])
                if kind == "holes":
                    diameter = float(op.get("diameter", 0))
                    depth = op.get("depth")
                    cut_len = top_z + 2 if depth == "through" else float(depth)
                    z_center = top_z / 2 if depth == "through" else top_z - float(depth) / 2
                    cutter = Pos(x, y, z_center) * Cylinder(diameter / 2, cut_len)
                else:
                    diameter = float(op.get("diameter", 0))
                    cb_diameter = float(op.get("cbDiameter", 0))
                    cb_depth = float(op.get("cbDepth", 0))
                    through = Pos(x, y, top_z / 2) * Cylinder(diameter / 2, top_z + 2)  # 通孔贯穿整板
                    counterbore = Pos(x, y, top_z - cb_depth / 2) * Cylinder(cb_diameter / 2, cb_depth)
                    cutter = through + counterbore
                solid = solid - cutter
        elif kind == "fillet":
            radius = float(op.get("radius", 0))
            if radius <= 0:
                return {"ok": False, "message": "fillet 半径必须大于 0"}
            if solid is None:
                return {"ok": False, "message": "圆角特征缺少基体（先有 box）"}
            edges = [e for e in solid.edges() if abs(e.tangent_at(0.5).Z) > 0.99]
            if edges:
                solid = fillet(edges, radius)
        elif kind == "slot":
            return {"ok": False, "message": "slot 重建尚未实现（先只支持 box/holes/counterbore/fillet）"}
        elif kind == "cylinder":
            diameter = float(op.get("diameter", 0))
            height = float(op.get("height", 0))
            if min(diameter, height) <= 0:
                return {"ok": False, "message": "cylinder 的 diameter/height 必须大于 0"}
            solid = Cylinder(diameter / 2, height)
        else:
            return {"ok": False, "message": f"未知算子：{kind}"}

    if solid is None:
        return {"ok": False, "message": "没有任何实体"}

    global LAST_SOLID
    LAST_SOLID = solid
    volume = float(solid.volume)
    bbox = solid.bounding_box()
    size = bbox.size
    mass_kg = volume / 1000.0 * float(density) / 1000.0  # mm³ → cm³ → g → kg
    fingerprint = hashlib.sha256(
        json.dumps([volume, round(size.X, 3), round(size.Y, 3), round(size.Z, 3)]).encode()
    ).hexdigest()[:16]
    return {
        "ok": True,
        "volumeMm3": round(volume, 1),
        "bboxMm": {"x": round(size.X, 2), "y": round(size.Y, 2), "z": round(size.Z, 2)},
        "massKg": round(mass_kg, 4),
        "densityGPerCm3": float(density),
        "fingerprint": fingerprint,
        "ops": len(ops),
    }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # 静音默认访问日志
        sys.stderr.write("[rebuild] " + (fmt % args) + "\n")

    def _send(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/stl":
            # 把最近一次重建的实体导出成二进制 STL，客户端（Qt/OCCT）直接读来显示，
            # 不在客户端重算几何——几何只有一个来源：服务端 sidecar。
            if LAST_SOLID is None:
                self._send(409, {"ok": False, "message": "还没有成功重建过，无几何可导出"})
                return
            import tempfile
            from build123d import export_stl
            with tempfile.NamedTemporaryFile(suffix=".stl", delete=True) as handle:
                export_stl(LAST_SOLID, handle.name)
                handle.seek(0)
                data = handle.read()
            self.send_response(200)
            self.send_header("Content-Type", "model/stl")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        if self.path == "/health":
            import build123d
            self._send(200, {"ok": True, "kernel": f"build123d {build123d.__version__}"})
            return
        self._send(404, {"ok": False, "message": f"未知路径：{self.path}"})

    def do_POST(self):
        if self.path != "/rebuild":
            self._send(404, {"ok": False, "message": f"未知路径：{self.path}"})
            return
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > 2_000_000:
            self._send(413, {"ok": False, "message": "请求体为空或过大"})
            return
        try:
            body = json.loads(self.rfile.read(length).decode("utf-8"))
        except Exception as error:  # noqa: BLE001
            self._send(400, {"ok": False, "message": f"JSON 解析失败：{error}"})
            return
        density = body.get("densityGPerCm3", DEFAULT_DENSITY)
        try:
            result = build(body.get("ops") or [], density)
        except Exception as error:  # noqa: BLE001
            self._send(200, {"ok": False, "message": f"重建失败：{error}"})
            return
        self._send(200, result)


if __name__ == "__main__":
    port = int(os.environ.get("FT_BUILD_PORT", "17999"))
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    actual = server.server_address[1]  # FT_BUILD_PORT=0 时由系统分配，必须打印真实端口
    print(f"rebuild sidecar listening http://127.0.0.1:{actual}（build123d）", flush=True)
    server.serve_forever()
