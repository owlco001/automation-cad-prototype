"""build123d sidecar 原型（P9 选用内核）：HTTP + Bearer，声明式特征树 → 实体 → STEP/STL。

启动：python app.py --port 7412 --token <token>
"""
from __future__ import annotations

import argparse, copy, json, math, os, secrets, shutil, tempfile, threading, time, traceback
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
                # build123d 的 Box 默认就是几何中心在原点（align=CENTER），
                # 所以这里**不需要**再平移半个尺寸——之前多移了一次，
                # 导致带转角的复核件整体偏了 (L/2, W/2, H/2)，凭空造出交集体积。
                pass
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


def build_assembly(instances) -> tuple[object, list[dict], list, dict]:
    """逐件建模 → 整机合并。返回 (整机形状, 逐件体积表, 逐件形状, 合并元数据)。"""
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
        solid_count = len(placed.solids())
        shapes.append(placed)
        volumes.append({
            "id": instance_id,
            "name": str(instance.get("name") or instance_id),
            "volumeMm3": round(shape.volume, 1),
            # 逐件实体数：整机 STEP 的 MANIFOLD_SOLID_BREP 应当与「逐件合计」对得上，
            # 门禁据此判断整机导出有没有丢件（旧累计 fuse 会少一半）。
            "solids": solid_count,
        })
    combined, merge_meta = merge(shapes)
    return combined, volumes, shapes, merge_meta


def _identity_labels(instances: list[dict]) -> list[str]:
    """件号：统一取 instance.id（**不是** name / partId），与 `files.parts[].id` 同一表达式、同一字符串。

    不做字符替换（STL 文件名那套 safe 规则）：替换会让 label 与件表 id 漂移，
    回读门禁「件号 ↔ 实体」的严格交叉核对就失去意义；非 ASCII 由 OCCT 写成 `\\X2\\` 转义，
    回读时还原成原文，导出侧不需要也不应该改写字符。

    件号**不兜底、也不归一化**：旧实现 `str(item.get("id") or f"part-{index + 1}")` 会把空件号编造成
    `part-1`，而 `part-1` 可能恰好与真件号撞名，让「丢件」被读成「改名」——三方核对照样过。
    入口（`identity_request_error`）已拦过一次；本函数也被单测直接调用，所以自己再拦一次，
    **口径与入口逐条一致**（非字符串 / strip 后为空 / 首尾有填充空白 都抛）。
    """
    labels = []
    for index, item in enumerate(instances):
        raw = item.get("id") if isinstance(item, dict) else None
        if not isinstance(raw, str) or not raw.strip():
            raise ValueError(f"identity 导出：instances[{index}].id 必须是字符串且非空，不得伪造件号")
        if raw != raw.strip():
            raise ValueError(
                f"identity 导出：instances[{index}].id 首尾不得有空白（当前「{raw}」），请修正源件号"
            )
        labels.append(raw)
    return labels


def identity_request_error(payload: Any) -> str | None:
    """`identityStep` 的前置条件。缺省/false/非布尔一律返回 None —— 既有路径逐字不变。

    只接受 JSON `true`（Python `True`）：`"true"`/1 之类一律按「未要求」处理，
    失败方向是**没有** identity 文件（门禁判红），不会产生假绿。
    """
    if not isinstance(payload, dict) or payload.get("identityStep") is not True:
        return None
    instances = payload.get("instances")
    if not isinstance(instances, list) or not instances:
        return "identityStep 需要非空 instances（逐件装配）"
    if payload.get("perPart") is not True:
        return "identityStep 需要 perPart: true（逐件元数据是身份核对的前提）"
    exports = payload.get("exports") or ["step"]
    if not isinstance(exports, list) or "step" not in exports:
        return "identityStep 需要 exports 包含 step"
    # 件号是身份核对的第一性输入：必须在这里（**早于** mkdtemp 与建模）就拒绝，
    # 而不是留到 _identity_labels 里编造 `part-{i+1}`。规则是：必须字符串 / 不能空或纯空白 /
    # 首尾不得有填充空白（不自动 trim，让调用方修源件号）/ 不得重号。
    # 前三条与 `_identity_labels` 逐条一致（那边是绕过入口时的最后一道）；
    # 报错口径统一是 `instances[i]`：这是唯一能让调用方一眼定位到请求体哪个位置的说法。
    seen: dict[str, int] = {}
    for index, item in enumerate(instances):
        raw = item.get("id") if isinstance(item, dict) else None
        if not isinstance(raw, str):
            return f"identityStep 需要 instances[{index}].id 是字符串（当前 {type(raw).__name__}）"
        if not raw.strip():
            return f"identityStep 需要 instances[{index}].id 非空（空串或纯空白都不许当件号）"
        # 首尾填充空白**不是**这里能替调用方归一化的东西：自动 strip 会让「工程文档里的件号」
        # 与「回执/identity label 里的件号」变成两个不同的字符串，按精确串 join 的下游就断了。
        # 所以直接拒绝并点名，让调用方去修**源件号**；入口、`_identity_labels`、desktop 三层
        # 都不改写字符（内部空格 / 非 ASCII 照原样透传）。
        if raw != raw.strip():
            return (
                f"identityStep 需要 instances[{index}].id 首尾无空白（当前「{raw}」）："
                f"请修正源件号，内核不自动 trim"
            )
        # 到这里的 id 已经是「原值 == strip 后」，判重就按原样字符串比：同一个件号才是重号。
        if raw in seen:
            return f"identityStep 需要 instances[{index}].id 唯一：与 instances[{seen[raw]}] 重复（「{raw}」）"
        seen[raw] = index
    return None


def write_identity_step(outdir: str, parts: list, labels: list[str]) -> dict:
    """导出伴随身份 STEP：独立复制体 + 非融合 `Compound(children=...)`，根 label = assembly。

    边界（写清，别升级成验收）：这是**另一次**导出，不是制造 STEP 的替代或证明。
    即使件号、实体计数、包络全对，也不证明两者内部拓扑/形状等价。它只支持
    「导出侧身份」核对，不是制造认证、也不是逐实体拓扑认证。

    两条硬约束：
      1) 必须在制造导出**之后**调用。`fuse` 会继承 `parts[0].label`（实测），label 若早于
         合并，制造 STEP 会凭空长出一个冒名 PRODUCT；
      2) 只给 `deepcopy` 出来的复制体打 label，绝不回写 `placed_shapes` —— 那些形状还被
         逐件 STL 与合并体共用，打标签会污染制造侧产物。
    失败一律抛异常（调用方已有 400 路径），**不返回** `ok:true` 缺文件。
    """
    if len(parts) != len(labels):
        raise ValueError("identity 导出：件与件号数量不一致")
    children = []
    for part, label in zip(parts, labels):
        if not label:
            raise ValueError("identity 导出：件号不能为空")
        clone = copy.deepcopy(part)
        clone.label = label
        children.append(clone)
    compound = bd.Compound(children=children)
    compound.label = "assembly"
    path = os.path.join(outdir, "identity.step")
    started = time.perf_counter()
    bd.export_step(compound, path)
    ms = round((time.perf_counter() - started) * 1000, 1)
    size = os.path.getsize(path) if os.path.exists(path) else 0
    if size <= 0:
        raise ValueError(f"identity.step 导出失败或为空文件：{path}")
    with open(path, encoding="utf-8", errors="replace") as handle:
        text = handle.read()
    # products/solids 只是**说明性自报统计**（门禁必须回读文件，不得据此判绿）。
    return {
        "path": path,
        "bytes": size,
        "ms": ms,
        "products": text.count("PRODUCT("),
        "solids": text.count("MANIFOLD_SOLID_BREP"),
    }


def _extent(shape) -> tuple[float, float, float, float, float, float]:
    """(minX, minY, minZ, maxX, maxY, maxZ)，用于合并前后的包络校验。"""
    bb = shape.bounding_box()
    return (bb.min.X, bb.min.Y, bb.min.Z, bb.max.X, bb.max.Y, bb.max.Z)


def merge(parts: list) -> tuple[object, dict]:
    """整机合并：**一次性** fuse + 包络/体积校验，校验不过回退 Compound。

    为什么必须改（实测，不是推测）：旧实现 `combined = combined + shape` 是**逐件累计**
    布尔并，OCCT 的 BOP 在长链累计里会静默返回丢了若干实体的形状，build123d 不抛错：

      | 装配 | 件数 | 累计 fuse 结果 | 正确包络（逐件 STL 并集） |
      |---|---|---|---|
      | PV 缓存 8 层 | 90 | 47 实体、顶点 z 仅到 2196 | z 0..2400 |
      | 缓存塔 16 层 | 146 | 86 实体、z 仅到 3636、z 最小 770 | z 0..3840 |

    丢的是顶层/底部结构，而 byte 数（781,970 B）、面数、实体数下限这些门禁照样过——
    「已验收」的 8 层 STEP 就是这么来的。
    一次性 `shapes[0].fuse(*shapes[1:])` 实测三个装配包络都完整；但版本/几何组合会变，
    所以合并后再量一次包络与体积，对不上就回退 `Compound`——复合体不做布尔，
    按定义不可能丢件（代价：重叠体积不去重，相邻件的实体不合并）。

    返回 (shape, meta)；meta 进 `stats.merge`，调用方与门禁据此判断走的是哪条路。
    """
    if len(parts) == 1:
        return parts[0], {"mode": "single", "solids": len(parts[0].solids())}
    extents = [_extent(item) for item in parts]
    want_min = [min(item[axis] for item in extents) for axis in range(3)]
    want_max = [max(item[axis + 3] for item in extents) for axis in range(3)]
    volume_sum = sum(item.volume for item in parts)
    reason = ""
    try:
        fused = parts[0].fuse(*parts[1:])
        got = _extent(fused)
        drift = max(
            max(abs(got[axis] - want_min[axis]) for axis in range(3)),
            max(abs(got[axis + 3] - want_max[axis]) for axis in range(3)),
        )
        if drift > 0.5:
            reason = f"fuse 包络偏移 {drift:.2f}mm（>0.5），判定丢件"
        elif volume_sum > 0 and fused.volume < volume_sum * 0.9:
            reason = f"fuse 体积 {fused.volume:.0f} < 逐件合计 {volume_sum:.0f}×0.9，判定丢件"
        else:
            return fused, {"mode": "fuse", "driftMm": round(drift, 3),
                           "solids": len(fused.solids())}
    except Exception as exc:  # noqa: BLE001 —— 内核布尔失败也必须出图（回退不丢件）
        reason = f"fuse 抛错：{exc}"
    compound = bd.Compound(children=parts)
    return compound, {"mode": "compound", "fallback": True, "reason": reason,
                      "solids": len(compound.solids())}


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
            identity_error = identity_request_error(payload)
            if identity_error:
                raise ValueError(identity_error)
            identity_wanted = isinstance(payload, dict) and payload.get("identityStep") is True
            started = time.perf_counter()
            instances = payload.get("instances")
            per_part = bool(payload.get("perPart"))
            placed_shapes: list = []
            merge_meta: dict | None = None
            if instances is not None:
                shape, instance_volumes, placed_shapes, merge_meta = build_assembly(instances)
            else:
                shape, instance_volumes = build(payload.get("ops") or []), None
            built_ms = (time.perf_counter() - started) * 1000
            outdir = tempfile.mkdtemp(prefix="b123d-build-")
            # 失败路径必须自己收拾：mkdtemp 在建完模型之后、任何导出之前，
            # 导出任一步抛错，这个目录里只剩半份产物（part.step + 逐件 STL），
            # 而响应是 400、**没有 files** —— 客户端拿不到也不会来取，留着就是永久垃圾
            # （本机实测曾积 145 个目录 / 142 MB）。成功路径**不删**：files[*].path
            # 直接交给客户端去 copy，删除需要协议层配合（独立登记项，不在本轮）。
            try:
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
                # 身份件号只在**制造导出完成之后**使用（见 write_identity_step）：这里只算字符串，不碰形状。
                identity_labels = _identity_labels(instances) if identity_wanted and isinstance(instances, list) else []
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
                            "solids": len(placed.solids()),
                            "faces": len(placed.faces()),
                            "bbox": [round(bb.size.X, 2), round(bb.size.Y, 2), round(bb.size.Z, 2)],
                            "bboxMin": [round(bb.min.X, 2), round(bb.min.Y, 2), round(bb.min.Z, 2)],
                            "bboxMax": [round(bb.max.X, 2), round(bb.max.Y, 2), round(bb.max.Z, 2)]
                        })
                    files["parts"] = parts_meta
                if identity_wanted:
                    # 制造 STEP/STL 已经导出（上面那一轮），此刻才给**独立复制体**打件号做非融合导出。
                    if len(placed_shapes) != len(identity_labels):
                        raise ValueError("identity 导出：实例数与逐件形状数不一致")
                    files["identity"] = write_identity_step(outdir, placed_shapes, identity_labels)
                stats = describe(shape, instance_volumes)
                if merge_meta is not None:
                    stats["merge"] = merge_meta
                    # 逐件实体数只在 perPart 导出时才有；非 perPart 时**不要**写 0/null 冒充
                    # 「逐件实体合计 = 0」——那会让门禁的实体数上限变成 2，日志里的
                    # `partSolids=0` 也会被误读成「一块实体都没有」。
                    part_solids = [item.get("solids") for item in (files.get("parts") or [])]
                    if part_solids and all(isinstance(value, int) for value in part_solids):
                        stats["partSolids"] = sum(part_solids)
            except Exception:
                # 与下面统一的 400 分支同一条路：先收拾目录再抛，响应里依旧没有 files。
                shutil.rmtree(outdir, ignore_errors=True)
                raise
            self._send(200, {"ok": True, "kernel": "build123d", "stats": stats, "buildMs": round(built_ms, 1), "files": files})
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
