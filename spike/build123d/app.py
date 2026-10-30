"""build123d sidecar 原型（P9 选用内核）：HTTP + Bearer，声明式特征树 → 实体 → STEP/STL。

启动：python app.py --port 7412 --token <token>
"""
from __future__ import annotations

import argparse, json, math, os, secrets, tempfile, threading, time, traceback
from typing import Any
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# 内核导入要 6~7 秒（OCCT + 大量 Python 依赖）。导入放在后台线程里完成，
# 先把 HTTP 端口绑上并回答 /health，否则调用方的健康检查（3 秒）必然超时。
bd: Any = None
VERSION = "unavailable"
TOKEN = ""
_KERNEL_LOCK = threading.Lock()
_KERNEL_ERROR = ""


def load_kernel(wait: bool = True) -> bool:
    """导入 build123d；wait=False 时只尝试一次，失败不抛。返回是否可用。"""
    global bd, VERSION, _KERNEL_ERROR
    with _KERNEL_LOCK:
        if bd is not None:
            return True
        try:
            import build123d as _bd
        except Exception as exc:  # noqa: BLE001
            _KERNEL_ERROR = str(exc)
            return False
        bd = _bd
        VERSION = getattr(_bd, "__version__", "unknown")
        _KERNEL_ERROR = ""
        return True
# 整机级装配不止 50 件：立体缓存（3 层 × 4 位）56 件、光伏缓存堆叠单元 94 件。
# 上限按"分钟级建模"给：200 件实测仍在 180 s 预算内，再多应拆子装配。
MAX_INSTANCES = 200


def _num(value, name: str, minimum: float = 0.0) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} 必须是数字")
    if value <= minimum:
        raise ValueError(f"{name} 必须大于 {minimum}")
    return float(value)


def build(ops: list[dict]):
    if not isinstance(ops, list) or not ops:
        raise ValueError("ops 必须是非空数组")
    shape = None
    for index, op in enumerate(ops, 1):
        if not isinstance(op, dict):
            raise ValueError(f"第 {index} 个操作必须是对象")
        kind = op.get("op")
        if kind == "box":
            L, W, H = (_num(op.get(k), k) for k in ("length", "width", "height"))
            # anchor：min（默认，x/y 从 0 起）/ center（几何中心在原点）。
            # 复核带转角的零件时必须用 center：绕原点转 Z 时，只有中心在原点才是绕自身转。
            anchor = str(op.get("anchor") or "min").lower()
            if anchor not in ("min", "center"):
                raise ValueError(f"box.anchor 只支持 min/center，收到：{anchor}")
            centered = bool(op.get("centered", True))
            z = 0.0 if centered else H / 2
            base = bd.Pos(0, 0, z) * bd.Box(L, W, H)
            if anchor == "center":
                base = bd.Pos(-L / 2, -W / 2, -H / 2 if centered else 0) * base
            shape = base if shape is None else shape + base
        elif kind == "rotate":
            # 绕原点转 Z（度）。配合 box.anchor=center 使用即为绕零件自身中心旋转。
            if shape is None:
                raise ValueError("rotate 之前必须有实体")
            deg = op.get("deg")
            if isinstance(deg, bool) or not isinstance(deg, (int, float)):
                raise ValueError("rotate.deg 必须是数字")
            shape = bd.Rot(0, 0, float(deg)) * shape
        elif kind == "move":
            if shape is None:
                raise ValueError("move 之前必须有实体")
            x, y, z = (float(v) for v in (op.get("x", 0), op.get("y", 0), op.get("z", 0)))
            shape = bd.Pos(x, y, z) * shape
        elif kind == "cylinder":
            # 圆柱可以作为零件的第一个操作（滚筒、螺杆、销轴这类本身就是回转体）
            d = _num(op.get("diameter"), "diameter")
            h = _num(op.get("height"), "height")
            x, y, z = (op.get("at") or [0, 0, 0])[:3]
            # axis：圆柱默认沿 +Z；滚筒/横轴类零件需要 x/y 方向，这里按绕轴旋转展开。
            axis = str(op.get("axis") or "z").lower()
            if axis not in ("x", "y", "z"):
                raise ValueError(f"cylinder.axis 只支持 x/y/z，收到：{axis}")
            base = bd.Cylinder(d / 2, h)
            if axis == "x":
                base = bd.Rot(0, 90, 0) * base
            elif axis == "y":
                base = bd.Rot(90, 0, 0) * base
            placed = bd.Pos(float(x), float(y), float(z)) * base
            shape = placed if shape is None else shape + placed
        elif kind == "holes":
            if shape is None:
                raise ValueError("holes 之前必须有实体")
            d = _num(op.get("diameter"), "diameter")
            positions = op.get("positions") or []
            if not positions:
                raise ValueError("holes.positions 不能为空")
            depth = op.get("depth")
            top = shape.bounding_box().max.Z
            for x, y in positions:
                if depth in (None, "through"):
                    shape = shape - (bd.Pos(float(x), float(y), -1.0) * bd.Cylinder(d / 2, 1e3))
                else:
                    # 盲孔/螺纹底孔：从顶面向下切，孔深 = depth（与工程图「深<depth>」标注一致；顶面上方多切 1mm 保证切净）
                    dep = _num(depth, "depth")
                    shape = shape - (bd.Pos(float(x), float(y), top - dep / 2 + 0.5) * bd.Cylinder(d / 2, dep + 1))
        elif kind == "counterbore":
            if shape is None:
                raise ValueError("counterbore 之前必须有实体")
            d = _num(op.get("diameter"), "diameter")
            cbd = _num(op.get("cbDiameter"), "cbDiameter")
            cbdepth = _num(op.get("cbDepth"), "cbDepth")
            if cbd <= d:
                raise ValueError(f"cbDiameter（{cbd}）必须大于 diameter（{d}）")
            positions = op.get("positions") or []
            if not positions:
                raise ValueError("counterbore.positions 不能为空")
            depth = op.get("depth")
            top = shape.bounding_box().max.Z
            for x, y in positions:
                # 通孔：从顶面上方 1mm 一路切下去
                # 定深时孔深从顶面量起 = depth（与工程图标注一致）
                height = 1e3 if depth in (None, "through") else _num(depth, "depth") + 1
                shape = shape - (bd.Pos(float(x), float(y), top - height / 2 + 1) * bd.Cylinder(d / 2, height))
                # 沉窝：从顶面上方 0.5mm 起切 cbDepth（多切 0.5 保证顶面切净，不吃到台阶以下）
                shape = shape - (
                    bd.Pos(float(x), float(y), top - cbdepth / 2 + 0.5) * bd.Cylinder(cbd / 2, cbdepth + 1)
                )
        elif kind == "slot":
            if shape is None:
                raise ValueError("slot 之前必须有实体")
            length = _num(op.get("length"), "length")
            width = _num(op.get("width"), "width")
            cut = bd.extrude(bd.SlotOverall(length, width), amount=1e3)
            # 腰形槽为通槽：从实体底面下方 1mm 起切（原来从 z=-1 起切，居中板只切穿上半部分）
            shape = shape - (bd.Pos(0, 0, shape.bounding_box().min.Z - 1) * cut)
        elif kind == "fillet":
            if shape is None:
                raise ValueError("fillet 之前必须有实体")
            radius = _num(op.get("radius"), "radius")
            selector = str(op.get("edges") or "|Z")
            edges = shape.edges().filter_by(bd.Axis.Z) if selector == "|Z" else shape.edges()
            shape = bd.fillet(edges, radius)
        else:
            raise ValueError(f"第 {index} 个操作未知：{kind}")
    return shape


def _instance_transform(value, index: int) -> tuple[float, float, float, float]:
    label = f"第 {index} 个实体"
    if not isinstance(value, dict):
        raise ValueError(f"{label}：transform 必须是对象")
    x, y, z = value.get("x"), value.get("y"), value.get("z")
    rz = value.get("rz", 0)
    for name, item in (("x", x), ("y", y), ("z", z), ("rz", rz)):
        if isinstance(item, bool) or not isinstance(item, (int, float)) or not math.isfinite(item):
            raise ValueError(f"{label}：transform.{name} 必须是数字")
    return float(x), float(y), float(z), float(rz)


def build_assembly(instances) -> tuple[object, list[dict]]:
    if not isinstance(instances, list) or not instances:
        raise ValueError("instances 必须是非空数组")
    if len(instances) > MAX_INSTANCES:
        raise ValueError(f"装配最多支持 {MAX_INSTANCES} 个实体（当前 {len(instances)} 个）")
    seen: set[str] = set()
    shapes = []
    volumes: list[dict] = []
    for index, instance in enumerate(instances, 1):
        if not isinstance(instance, dict):
            raise ValueError(f"第 {index} 个实体：必须是对象")
        instance_id = instance.get("id")
        if not isinstance(instance_id, str) or not instance_id.strip():
            raise ValueError(f"第 {index} 个实体：缺少实体 id")
        instance_id = instance_id.strip()
        if instance_id in seen:
            raise ValueError(f"第 {index} 个实体：id「{instance_id}」重复")
        seen.add(instance_id)
        x, y, z, rz = _instance_transform(instance.get("transform"), index)
        shape = build(instance.get("ops") or [])
        placed = bd.Pos(x, y, z) * (bd.Rot(0, 0, rz) * shape)
        shapes.append(placed)
        volumes.append({
            "id": instance_id,
            "name": str(instance.get("name") or instance_id),
            "volumeMm3": round(shape.volume, 1),
        })
    combined = shapes[0]
    for shape in shapes[1:]:
        combined = combined + shape
    return combined, volumes, shapes


def describe(shape, instances: list[dict] | None = None) -> dict:
    bb = shape.bounding_box()
    stats = {
        "volumeMm3": round(shape.volume, 1),
        "bbox": [round(bb.size.X, 2), round(bb.size.Y, 2), round(bb.size.Z, 2)],
        "faces": len(shape.faces()),
        "edges": len(shape.edges()),
        "solids": len(shape.solids()),
    }
    if instances is not None:
        stats["instances"] = instances
    return stats


class Handler(BaseHTTPRequestHandler):
    server_version = "Build123dSidecar/0.1"

    def _send(self, code: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self) -> bool:
        return self.headers.get("Authorization", "") == f"Bearer {TOKEN}"

    def log_message(self, fmt, *args):
        pass

    def do_GET(self):
        if self.path == "/health":
            ready = bd is not None
            self._send(200, {
                "ok": True,
                "kernel": "build123d",
                "kernelState": "ready" if ready else ("failed" if _KERNEL_ERROR else "loading"),
                "version": VERSION,
                "error": _KERNEL_ERROR or None,
                "pid": os.getpid()
            })
        else:
            self._send(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        if not self._authorized():
            self._send(401, {"ok": False, "error": "unauthorized"})
            return
        if self.path != "/build":
            self._send(404, {"ok": False, "error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > 1_000_000:
                raise ValueError("请求体为空或超过 1 MB")
            if not load_kernel():
                self._send(503, {"ok": False, "error": f"建模内核加载失败：{_KERNEL_ERROR}"})
                return
            payload = json.loads(self.rfile.read(length))
            wants = payload.get("exports") or ["step"]
            for item in wants:
                if item not in ("step", "stl"):
                    raise ValueError(f"不支持的导出格式：{item}")
            started = time.perf_counter()
            instances = payload.get("instances")
            per_part = bool(payload.get("perPart"))
            placed_shapes: list = []
            if instances is not None:
                shape, instance_volumes, placed_shapes = build_assembly(instances)
            else:
                shape, instance_volumes = build(payload.get("ops") or []), None
            built_ms = (time.perf_counter() - started) * 1000
            outdir = tempfile.mkdtemp(prefix="b123d-build-")
            files = {}
            for fmt in wants:
                path = os.path.join(outdir, f"part.{fmt}")
                t = time.perf_counter()
                if fmt == "step":
                    bd.export_step(shape, path)
                else:
                    bd.export_stl(shape, path, tolerance=0.1)
                files[fmt] = {"path": path, "bytes": os.path.getsize(path), "ms": round((time.perf_counter() - t) * 1000, 1)}
            # 逐件导出：干涉检查/运动学/零件树都需要独立实体，合并体只有一个网格
            if per_part and instances:
                parts_meta = []
                for index, (item, placed) in enumerate(zip(instances, placed_shapes)):
                    raw_id = str(item.get("id") or f"part-{index + 1}")
                    safe = "".join(ch if ch.isalnum() or ch in "-_" else "-" for ch in raw_id)[:40]
                    part_path = os.path.join(outdir, f"{index + 1:02d}-{safe}.stl")
                    bd.export_stl(placed, part_path, tolerance=0.1)
                    bb = placed.bounding_box()
                    parts_meta.append({
                        "id": raw_id,
                        "name": str(item.get("name") or raw_id),
                        "stl": {"path": part_path, "bytes": os.path.getsize(part_path)},
                        "volumeMm3": round(placed.volume, 1),
                        "bbox": [round(bb.size.X, 2), round(bb.size.Y, 2), round(bb.size.Z, 2)],
                        "bboxMin": [round(bb.min.X, 2), round(bb.min.Y, 2), round(bb.min.Z, 2)],
                        "bboxMax": [round(bb.max.X, 2), round(bb.max.Y, 2), round(bb.max.Z, 2)]
                    })
                files["parts"] = parts_meta
            self._send(200, {"ok": True, "kernel": "build123d", "stats": describe(shape, instance_volumes), "buildMs": round(built_ms, 1), "files": files})
        except Exception as exc:  # noqa: BLE001
            self._send(400, {"ok": False, "error": str(exc), "trace": traceback.format_exc(limit=2)})


def main() -> None:
    global TOKEN
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=7412)
    ap.add_argument("--token", default="")
    args = ap.parse_args()
    TOKEN = args.token or secrets.token_urlsafe(24)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    # 先监听端口：调用方的健康检查只有 3 秒，而内核导入需要 6~7 秒。
    print(json.dumps({"ok": True, "port": args.port, "token": TOKEN, "kernel": "build123d", "version": VERSION}), flush=True)
    threading.Thread(target=load_kernel, daemon=True).start()
    server.serve_forever()


if __name__ == "__main__":
    main()
