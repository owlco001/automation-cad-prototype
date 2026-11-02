// B-Rep 面级运动副识别原型（spike，非产品代码）。
// 用法：./brep_joints <file.stp|file.brep> [--json] [--quiet]
//
// 流程：
//   1. XCAF 读 STEP（保留零件名 / 装配变换），逐零件遍历 Solid→Face
//   2. 面分类：GeomAbs_Plane / Cylinder / Cone / Sphere / Torus / BSpline…，取面积、
//      圆柱轴线+半径+包角+轴向跨度、平面法向
//   3. 规则：
//      R1 两零件各有一个同轴圆柱面（轴夹角 ~0、轴距 ~0、半径差小）→ 转动/移动副候选
//         判定：该零件对上若有「法向 ∥ 轴」的平面接触 → 轴向被限位 → 转动副
//               若有「法向 ⊥ 轴」的平面接触 → 防转 → 移动副
//               都没有 → 圆柱副（2 DOF，轴确定、类型未定）
//      R2 一零件平面与另一零件平面共面贴合（法向反平行、间距 < 0.5mm、重叠面积达标），
//         且贴合面内存在长条形包围盒（长宽比 > 1.5）→ 移动副候选，轴 = 面内长边
//   4. 输出候选（零件对、类型、轴、置信度、证据）+ 零件面清单
//
// 口径：只给候选与置信度，不做可行性/自由度求解，不做装配约束推断。
#include <BRepAdaptor_Surface.hxx>
#include <BRepAlgoAPI_Common.hxx>
#include <BRepBuilderAPI_Transform.hxx>
#include <gp_Trsf.hxx>
#include <BRepPrimAPI_MakePrism.hxx>
#include <BRepBuilderAPI_MakeSolid.hxx>
#include <TopoDS_Shell.hxx>
#include <gp_Vec.hxx>
#include <functional>
#include <BRepBndLib.hxx>
#include <BRepGProp.hxx>
#include <BRepTools.hxx>
#include <Bnd_Box.hxx>
#include <GProp_GProps.hxx>
#include <GeomAbs_SurfaceType.hxx>
#include <IFSelect_ReturnStatus.hxx>
#include <STEPCAFControl_Reader.hxx>
#include <TDF_ChildIterator.hxx>
#include <TDataStd_Name.hxx>
#include <TDocStd_Document.hxx>
#include <TopExp_Explorer.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Face.hxx>
#include <TopoDS_Shape.hxx>
#include <XCAFApp_Application.hxx>
#include <XCAFDoc_DocumentTool.hxx>
#include <XCAFDoc_ShapeTool.hxx>
#include <gp_Ax1.hxx>
#include <gp_Dir.hxx>
#include <gp_Lin.hxx>
#include <gp_Pln.hxx>
#include <gp_Pnt.hxx>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <cstdarg>
#include <algorithm>
#include <iostream>
#include <string>
#include <vector>

namespace {

constexpr double kTolAngleDeg = 1.0;     // 轴/法向平行判据
constexpr double kTolAxisDist = 0.30;    // 同轴判据：轴线间距 (mm)
constexpr double kTolRadiusDiff = 0.50;  // 配合半径差 (mm)
constexpr double kTolPlaneGap = 0.50;    // 平面贴合间隙 (mm)
constexpr double kMinContactArea = 20.0; // 有效接触面积 (mm²)
constexpr double kMinOverlapLen = 1.0;   // 同轴圆柱轴向重叠 (mm)

struct Vec3 {
  double x = 0, y = 0, z = 0;
  Vec3() = default;
  Vec3(double a, double b, double c) : x(a), y(b), z(c) {}
  Vec3 operator-(const Vec3& o) const { return {x - o.x, y - o.y, z - o.z}; }
  Vec3 operator+(const Vec3& o) const { return {x + o.x, y + o.y, z + o.z}; }
  Vec3 operator*(double s) const { return {x * s, y * s, z * s}; }
  double dot(const Vec3& o) const { return x * o.x + y * o.y + z * o.z; }
  Vec3 cross(const Vec3& o) const {
    return {y * o.z - z * o.y, z * o.x - x * o.z, x * o.y - y * o.x};
  }
  double norm() const { return std::sqrt(dot(*this)); }
  Vec3 unit() const {
    const double n = norm();
    return n > 1e-12 ? Vec3{x / n, y / n, z / n} : Vec3{0, 0, 0};
  }
};
static Vec3 V(const gp_Pnt& p) { return {p.X(), p.Y(), p.Z()}; }
static Vec3 V(const gp_Dir& d) { return {d.X(), d.Y(), d.Z()}; }
static double angleDeg(const Vec3& a, const Vec3& b) {
  double c = std::fabs(a.unit().dot(b.unit()));
  if (c > 1.0) c = 1.0;
  return std::acos(c) * 180.0 / M_PI;
}

struct CylinderFace {
  Vec3 origin, axis;
  double radius = 0, arcDeg = 0, height = 0, area = 0;
  int faceIdx = 0;
};

struct PlaneFace {
  Vec3 point, normal;
  double area = 0;
  int faceIdx = 0;
};

struct BBox {
  Vec3 lo{1e30, 1e30, 1e30}, hi{-1e30, -1e30, -1e30};
  bool valid = false;
  void add(const gp_Pnt& p) {
    valid = true;
    lo.x = std::min(lo.x, p.X()); lo.y = std::min(lo.y, p.Y()); lo.z = std::min(lo.z, p.Z());
    hi.x = std::max(hi.x, p.X()); hi.y = std::max(hi.y, p.Y()); hi.z = std::max(hi.z, p.Z());
  }
  Vec3 size() const { return valid ? Vec3{hi.x - lo.x, hi.y - lo.y, hi.z - lo.z} : Vec3{}; }
  Vec3 center() const { return valid ? Vec3{(hi.x + lo.x) / 2, (hi.y + lo.y) / 2, (hi.z + lo.z) / 2} : Vec3{}; }
  double diagonal() const { return size().norm(); }
};

struct Part {
  int id = -1;
  std::string name;
  std::string path;  // 装配路径，root/child
  TopoDS_Shape shape;
  BBox bbox;
  int faceCount = 0, solidCount = 0;
  std::vector<CylinderFace> cylinders;
  std::vector<PlaneFace> planes;
  int counts[12] = {0};
  double totalArea = 0;
};

struct Evidence {
  std::string kind;
  std::string detail;
  double value = 0;
};

struct Candidate {
  int a = -1, b = -1;
  std::string type;  // revolute | prismatic | cylindrical | 'prismatic?'
  Vec3 axisOrigin, axisDir;
  double confidence = 0;
  double radius = 0, radiusDiff = 0, overlapLen = 0, contactArea = 0;
  std::vector<Evidence> evidence;
};

const char* surfaceTypeName(GeomAbs_SurfaceType t) {
  switch (t) {
    case GeomAbs_Plane: return "plane";
    case GeomAbs_Cylinder: return "cylinder";
    case GeomAbs_Cone: return "cone";
    case GeomAbs_Sphere: return "sphere";
    case GeomAbs_Torus: return "torus";
    case GeomAbs_BezierSurface: return "bezier";
    case GeomAbs_BSplineSurface: return "bspline";
    case GeomAbs_SurfaceOfRevolution: return "revolution";
    case GeomAbs_SurfaceOfExtrusion: return "extrusion";
    case GeomAbs_OffsetSurface: return "offset";
    default: return "other";
  }
}

int surfaceTypeIndex(GeomAbs_SurfaceType t) {
  switch (t) {
    case GeomAbs_Plane: return 0;
    case GeomAbs_Cylinder: return 1;
    case GeomAbs_Cone: return 2;
    case GeomAbs_Sphere: return 3;
    case GeomAbs_Torus: return 4;
    case GeomAbs_BezierSurface: return 5;
    case GeomAbs_BSplineSurface: return 6;
    case GeomAbs_SurfaceOfRevolution: return 7;
    case GeomAbs_SurfaceOfExtrusion: return 8;
    case GeomAbs_OffsetSurface: return 9;
    default: return 10;
  }
}

std::string labelName(const TDF_Label& label) {
  Handle(TDataStd_Name) attr;
  if (label.FindAttribute(TDataStd_Name::GetID(), attr)) {
    TCollection_AsciiString s(attr->Get().ToExtString());
    return std::string(s.ToCString());
  }
  return std::string();
}

// 面法向必须结合 face 的 orientation：BRepAdaptor_Surface::Plane() 给的是底层曲面的法向，
// 不反映 TopAbs_REVERSED。漏了这一步，贴合的两个平面永远算不出「法向反平行」。
Vec3 orientedNormal(const TopoDS_Face& f, const gp_Pln& pln) {
  Vec3 n = V(pln.Axis().Direction());
  if (f.Orientation() == TopAbs_REVERSED) n = n * -1.0;
  return n;
}

double faceArea(const TopoDS_Face& f) {
  GProp_GProps props;
  BRepGProp::SurfaceProperties(f, props);
  return std::fabs(props.Mass());
}

// 平面-平面重叠面积。
// 直接对两个共面/近共面 face 做 Common 是退化的（二维交集，OCCT 常返回空），
// 改成：各自沿法向朝对方挤出薄棱柱 → 布尔交 → 体积/重叠厚度，得到真实的贴合面积。
// 厚度取 1mm，重叠厚度 = t - 间隙，所以间隙 < 0.5mm 时仍有余量。
constexpr double kPrismT = 1.0;

// 挤出结果可能是 SHELL / SOLID / COMPOUND，统一成 SOLID（体积计算需要封闭实体）
TopoDS_Shape toSolid(const TopoDS_Shape& s) {
  if (s.IsNull()) return s;
  if (s.ShapeType() == TopAbs_SOLID) return s;
  if (s.ShapeType() == TopAbs_SHELL) {
    BRepBuilderAPI_MakeSolid ms(TopoDS::Shell(s));
    return ms.IsDone() ? ms.Shape() : s;
  }
  for (TopExp_Explorer e(s, TopAbs_SOLID); e.More(); e.Next()) return e.Current();
  for (TopExp_Explorer e(s, TopAbs_SHELL); e.More(); e.Next()) {
    BRepBuilderAPI_MakeSolid ms(TopoDS::Shell(e.Current()));
    if (ms.IsDone()) return ms.Shape();
  }
  return s;
}
double contactArea(const TopoDS_Face& a, const TopoDS_Face& b, double gap) {
  BRepAdaptor_Surface sa(a, true);
  BRepAdaptor_Surface sb(b, true);
  if (sa.GetType() != GeomAbs_Plane || sb.GetType() != GeomAbs_Plane) return 0.0;
  // 必须用「带 orientation 的法向」：MakeBox 等构造器给所有面的底层平面同一朝向，
  // 只看 raw 法向会把贴合面判成同向，挤出方向错边，布尔交恒空。
  const Vec3 naV = orientedNormal(a, sa.Plane());
  const Vec3 nbV = orientedNormal(b, sb.Plane());
  const gp_Dir na(naV.x, naV.y, naV.z);

  // 步骤 1：把 B 沿 na 平移 gap，落到 A 所在平面上（此时两 face 严格共面）。
  // 步骤 2：两个共面 face 直接布尔交是二维退化运算，OCCT 返回空/碎片；
  //         所以把两个面各加厚成 1mm 薄棱柱（同向 +na）再做 3D 布尔，体积即面积。
  gp_Trsf shift;
  shift.SetTranslation(gp_Vec(na) * gap);
  const TopoDS_Shape bMoved = BRepBuilderAPI_Transform(b, shift, true).Shape();

  const TopoDS_Shape pa = toSolid(BRepPrimAPI_MakePrism(a, gp_Vec(na) * kPrismT).Shape());
  const TopoDS_Shape pb =
      toSolid(BRepPrimAPI_MakePrism(TopoDS::Face(bMoved), gp_Vec(na) * kPrismT).Shape());
  BRepAlgoAPI_Common op(pa, pb);
  op.SetFuzzyValue(1e-5);
  op.Build();
  if (getenv("SPIKE_DEBUG_PLANES")) {
    GProp_GProps v1, v2;
    BRepGProp::VolumeProperties(pa, v1);
    BRepGProp::VolumeProperties(pb, v2);
    fprintf(stderr, "      [prism] typeA=%d typeB=%d volA=%.1f volB=%.1f done=%d empty=%d commonType=%d\n",
            (int)pa.ShapeType(), (int)pb.ShapeType(), std::fabs(v1.Mass()), std::fabs(v2.Mass()),
            (int)op.IsDone(), (int)op.Shape().IsNull(), (int)op.Shape().ShapeType());
  }
  if (!op.IsDone() || op.Shape().IsNull()) return 0.0;
  GProp_GProps vol;
  BRepGProp::VolumeProperties(op.Shape(), vol);
  // B 已平移到 A 平面，两棱柱占用同一个 1mm 厚板 → 交集体积 = 贴合面积 × 1mm
  return std::fabs(vol.Mass()) / kPrismT;
}

BBox shapeBBox(const TopoDS_Shape& shape) {
  Bnd_Box box;
  BRepBndLib::Add(shape, box);
  BBox out;
  if (box.IsVoid()) return out;
  double x0, y0, z0, x1, y1, z1;
  box.Get(x0, y0, z0, x1, y1, z1);
  out.add(gp_Pnt(x0, y0, z0));
  out.add(gp_Pnt(x1, y1, z1));
  return out;
}

// 沿给定轴投影 face 包围盒 8 角点，取跨度（圆柱轴向长度用）
double spanAlong(const BBox& box, const Vec3& axis) {
  double lo = 1e30, hi = -1e30;
  for (int i = 0; i < 8; ++i) {
    const gp_Pnt p((i & 1) ? box.hi.x : box.lo.x, (i & 2) ? box.hi.y : box.lo.y,
                   (i & 4) ? box.hi.z : box.lo.z);
    const double t = V(p).dot(axis);
    lo = std::min(lo, t);
    hi = std::max(hi, t);
  }
  return hi - lo;
}

std::vector<Part> readStep(const std::string& path, bool verbose) {
  std::vector<Part> parts;
  Handle(TDocStd_Document) doc;
  XCAFApp_Application::GetApplication()->NewDocument("MDTV-XCAF", doc);
  STEPCAFControl_Reader reader;
  reader.SetNameMode(true);
  reader.SetColorMode(true);
  if (reader.ReadFile(path.c_str()) != IFSelect_RetDone) {
    std::cerr << "read failed: " << path << std::endl;
    return parts;
  }
  if (!reader.Transfer(doc)) {
    std::cerr << "transfer failed: " << path << std::endl;
    return parts;
  }
  Handle(XCAFDoc_ShapeTool) shapeTool = XCAFDoc_DocumentTool::ShapeTool(doc->Main());

  // 装配递归：只从自由形状入口向下走组件，避免「形状标签 + 组件引用」同一零件被算两次。
  // 变换按 parent * child 累积，叶子处统一 Moved（单层装配已验证，深层嵌套未验证）。
  int nextId = 0;
  std::function<void(const TDF_Label&, const TopLoc_Location&, const std::string&)> walk;
  walk = [&](const TDF_Label& label, const TopLoc_Location& loc, const std::string& parentPath) {
    if (shapeTool->IsAssembly(label)) {
      TDF_LabelSequence comps;
      shapeTool->GetComponents(label, comps);
      std::string p = parentPath;
      const std::string n = labelName(label);
      if (!n.empty()) p += n + "/";
      for (Standard_Integer i = 1; i <= comps.Length(); ++i) {
        const TDF_Label c = comps.Value(i);
        walk(c, loc * shapeTool->GetLocation(c), p);
      }
      return;
    }
    TopoDS_Shape shape;
    bool isRef = shapeTool->IsReference(label);
    if (isRef) {
      TDF_Label ref;
      if (!shapeTool->GetReferredShape(label, ref)) return;
      // 引用到「子装配」：必须继续下钻，否则整个子装配被当成一个零件（层级丢失）
      if (shapeTool->IsAssembly(ref)) {
        std::string p2 = parentPath;
        const std::string n = labelName(label);
        if (!n.empty()) p2 += n + "/";
        walk(ref, loc * shapeTool->GetLocation(label), p2);
        return;
      }
      shape = shapeTool->GetShape(ref);
    } else if (shapeTool->IsSimpleShape(label)) {
      shape = shapeTool->GetShape(label);
    } else {
      return;
    }
    if (shape.IsNull()) return;
    if (!loc.IsIdentity()) shape = shape.Moved(loc);

    Part part;
    part.id = nextId++;
    part.name = labelName(label);
    // 装配实例名常为空或合成名 "=>[0:1:1:2]"，回落到引用件名
    if (part.name.rfind("=>[", 0) == 0) part.name.clear();
    if (part.name.empty() && isRef) {
      TDF_Label ref;
      if (shapeTool->GetReferredShape(label, ref)) part.name = labelName(ref);
    }
    if (part.name.empty()) part.name = "Part" + std::to_string(part.id + 1);
    part.path = parentPath;
    part.shape = shape;
    part.bbox = shapeBBox(shape);

    for (TopExp_Explorer e(shape, TopAbs_SOLID); e.More(); e.Next()) part.solidCount++;

    int faceIdx = 0;
    for (TopExp_Explorer e(shape, TopAbs_FACE); e.More(); e.Next(), ++faceIdx) {
      const TopoDS_Face face = TopoDS::Face(e.Current());
      BRepAdaptor_Surface surf(face, true);
      const GeomAbs_SurfaceType type = surf.GetType();
      part.faceCount++;
      part.counts[surfaceTypeIndex(type)]++;
      const double area = faceArea(face);
      part.totalArea += area;

      if (type == GeomAbs_Plane) {
        const gp_Pln pln = surf.Plane();
        PlaneFace pf;
        pf.faceIdx = faceIdx;
        pf.point = V(pln.Location());
        pf.normal = orientedNormal(face, pln);
        pf.area = area;
        part.planes.push_back(pf);
      } else if (type == GeomAbs_Cylinder) {
        const gp_Cylinder cyl = surf.Cylinder();
        CylinderFace cf;
        cf.faceIdx = faceIdx;
        cf.origin = V(cyl.Axis().Location());
        cf.axis = V(cyl.Axis().Direction());
        cf.radius = cyl.Radius();
        cf.area = area;
        const double u1 = surf.FirstUParameter(), u2 = surf.LastUParameter();
        cf.arcDeg = std::fabs(u2 - u1) * 180.0 / M_PI;
        cf.height = std::fabs(surf.LastVParameter() - surf.FirstVParameter());
        if (cf.height < 1e-9) cf.height = spanAlong(shapeBBox(face), cf.axis);
        part.cylinders.push_back(cf);
      }
    }
    parts.push_back(part);
  };

  TDF_LabelSequence freeShapes;
  shapeTool->GetFreeShapes(freeShapes);
  for (Standard_Integer i = 1; i <= freeShapes.Length(); ++i) {
    const TDF_Label l = freeShapes.Value(i);
    walk(l, shapeTool->GetLocation(l), "");
  }
  if (verbose) {
    std::cerr << "parts=" << parts.size() << std::endl;
  }
  return parts;
}

// 圆柱面（含包角）沿轴的实际跨度：用面 bbox 投影更稳（参数域对锥面/裁剪不总可靠）
double axialSpan(const std::vector<Part>& parts, int partIdx, int cylIdx) {
  const TopoDS_Shape& shape = parts[partIdx].shape;
  int faceIdx = 0;
  for (TopExp_Explorer e(shape, TopAbs_FACE); e.More(); e.Next(), ++faceIdx) {
    if (faceIdx != parts[partIdx].cylinders[cylIdx].faceIdx) continue;
    return spanAlong(shapeBBox(TopoDS::Face(e.Current())), parts[partIdx].cylinders[cylIdx].axis);
  }
  return 0.0;
}

double intervalOverlap(double a0, double a1, double b0, double b1) {
  const double lo = std::max(std::min(a0, a1), std::min(b0, b1));
  const double hi = std::min(std::max(a0, a1), std::max(b0, b1));
  return hi - lo;
}

struct PlaneContact {
  double area = 0;
  Vec3 normal;
  Vec3 point;
};

// 两零件之间所有共面贴合（法向反平行 + 间隙小），返回面积最大的几条
std::vector<PlaneContact> planeContacts(const Part& a, const Part& b, int maxKeep = 4) {
  std::vector<PlaneContact> out;
  TopExp_Explorer ea(a.shape, TopAbs_FACE);
  std::vector<TopoDS_Face> fa;
  for (; ea.More(); ea.Next()) fa.push_back(TopoDS::Face(ea.Current()));
  std::vector<TopoDS_Face> fb;
  for (TopExp_Explorer eb(b.shape, TopAbs_FACE); eb.More(); eb.Next())
    fb.push_back(TopoDS::Face(eb.Current()));

  const bool dbg = getenv("SPIKE_DEBUG_PLANES") != nullptr;
  for (size_t i = 0; i < fa.size(); ++i) {
    BRepAdaptor_Surface sa(fa[i], true);
    if (sa.GetType() != GeomAbs_Plane) continue;
    const gp_Pln pa = sa.Plane();
    const Vec3 na = orientedNormal(fa[i], pa);
    for (size_t j = 0; j < fb.size(); ++j) {
      BRepAdaptor_Surface sb(fb[j], true);
      if (sb.GetType() != GeomAbs_Plane) continue;
      const gp_Pln pb = sb.Plane();
      const Vec3 nb = orientedNormal(fb[j], pb);
      const double dot = na.dot(nb);
      const double gap = std::fabs((V(pb.Location()) - V(pa.Location())).dot(na));
      if (dbg && gap <= kTolPlaneGap + 0.5)
        fprintf(stderr, "  [raw] %s#%zu / %s#%zu dot=%.3f gap=%.3f\n", a.name.c_str(), i, b.name.c_str(), j, dot, gap);
      if (dot > -0.999) continue;  // 需反平行
      if (gap > kTolPlaneGap) continue;
      const double area = contactArea(fa[i], fb[j], gap);
      if (dbg)
        fprintf(stderr, "  [plane] %s#%zu n=(%.2f,%.2f,%.2f) / %s#%zu gap=%.3f area=%.1f\n",
                a.name.c_str(), i, na.x, na.y, na.z, b.name.c_str(), j, gap, area);
      if (area < kMinContactArea) continue;
      PlaneContact pc;
      pc.area = area;
      pc.normal = na;
      pc.point = V(pa.Location());
      out.push_back(pc);
    }
  }
  std::sort(out.begin(), out.end(), [](const PlaneContact& x, const PlaneContact& y) { return x.area > y.area; });
  if ((int)out.size() > maxKeep) out.resize(maxKeep);
  return out;
}

std::string fmt(const char* f, ...) {
  char buf[512];
  va_list ap;
  va_start(ap, f);
  vsnprintf(buf, sizeof(buf), f, ap);
  va_end(ap);
  return std::string(buf);
}

}  // namespace

int main(int argc, char** argv) {
  if (argc < 2) {
    std::cerr << "usage: brep_joints <file.stp> [--json] [--quiet]" << std::endl;
    return 2;
  }
  const std::string file = argv[1];
  bool json = false, quiet = false;
  int maxParts = 400;  // 与 spike/brep-interference 同一上限口径：超限直接拒绝，不硬扛 O(n²)
  for (int i = 2; i < argc; ++i) {
    if (!strcmp(argv[i], "--json")) json = true;
    if (!strcmp(argv[i], "--quiet")) quiet = true;
    if (!strcmp(argv[i], "--max-parts") && i + 1 < argc) maxParts = atoi(argv[++i]);
  }

  const auto t0 = std::chrono::steady_clock::now();
  std::vector<Part> parts = readStep(file, false);
  const auto t1 = std::chrono::steady_clock::now();
  if (parts.empty()) {
    std::cerr << "no parts" << std::endl;
    return 1;
  }

  if ((int)parts.size() > maxParts) {
    printf("{\"ok\": false, \"code\": \"TOO_MANY_PARTS\", \"parts\": %zu, \"maxParts\": %d}\n",
           parts.size(), maxParts);
    return 3;
  }

  int totalFaces = 0, totalCyl = 0, totalPlane = 0;
  for (const auto& p : parts) {
    totalFaces += p.faceCount;
    totalCyl += (int)p.cylinders.size();
    totalPlane += (int)p.planes.size();
  }

  std::vector<Candidate> cands;
  long planePairChecks = 0, cylPairChecks = 0;

  for (size_t a = 0; a < parts.size(); ++a) {
    for (size_t b = a + 1; b < parts.size(); ++b) {
      const Part& pa = parts[a];
      const Part& pb = parts[b];

      // ---- 规则 R1：同轴圆柱对 ----
      // 一个零件对里可能有多个同轴面对（圆柱面被裁成多片/轴环），取轴向重叠最大的那对做代表。
      bool pairHasCoax = false;
      double bestOverlap = 0, bestRDiff = 0, bestAxisDist = 0, bestR = 0, bestArcA = 0, bestArcB = 0;
      Vec3 bestOrigin, bestAxis;
      for (size_t ia = 0; ia < pa.cylinders.size(); ++ia) {
        for (size_t ib = 0; ib < pb.cylinders.size(); ++ib) {
          const CylinderFace& ca = pa.cylinders[ia];
          const CylinderFace& cb = pb.cylinders[ib];
          if (ca.radius < 0.5 || cb.radius < 0.5) continue;
          cylPairChecks++;
          if (angleDeg(ca.axis, cb.axis) > kTolAngleDeg) continue;
          gp_Lin la(gp_Pnt(ca.origin.x, ca.origin.y, ca.origin.z),
                    gp_Dir(ca.axis.x, ca.axis.y, ca.axis.z));
          gp_Lin lb(gp_Pnt(cb.origin.x, cb.origin.y, cb.origin.z),
                    gp_Dir(cb.axis.x, cb.axis.y, cb.axis.z));
          const double axisDist = la.Distance(lb);
          if (axisDist > kTolAxisDist) continue;
          const double rDiff = std::fabs(ca.radius - cb.radius);
          if (rDiff > kTolRadiusDiff) continue;
          const double sa = axialSpan(parts, (int)a, (int)ia);
          const double sb = axialSpan(parts, (int)b, (int)ib);
          // 投影到同一轴上求轴向重叠
          const Vec3 ax = ca.axis.unit();
          const double ta = (ca.origin - (ca.origin)).dot(ax);
          const double tb = (cb.origin - ca.origin).dot(ax);
          const double overlap = intervalOverlap(ta, ta + sa, tb, tb + sb);
          if (overlap < kMinOverlapLen) continue;

          if (overlap > bestOverlap) {
            bestOverlap = overlap;
            bestRDiff = rDiff;
            bestAxisDist = axisDist;
            bestR = std::max(ca.radius, cb.radius);
            bestArcA = ca.arcDeg;
            bestArcB = cb.arcDeg;
            bestOrigin = ca.origin;
            bestAxis = ax;
            bestOverlap = overlap;
            pairHasCoax = true;
          }
        }
      }

      if (pairHasCoax) {
        Candidate c;
        c.a = pa.id;
        c.b = pb.id;
        c.axisOrigin = bestOrigin;
        c.axisDir = bestAxis;
        c.radius = bestR;
        c.radiusDiff = bestRDiff;
        c.overlapLen = bestOverlap;
        c.evidence.push_back(
            {"coaxial", fmt("R=%.2f dR=%.2f axisDist=%.3f overlap=%.1fmm arc=%.0f/%.0fdeg", bestR,
                            bestRDiff, bestAxisDist, bestOverlap, bestArcA, bestArcB),
             0});

        // 类型判别：法向 ∥ 轴 → 轴向止推（转动副）；法向 ⊥ 轴 → 防转平面（移动副）
        const auto contacts = planeContacts(pa, pb);
        planePairChecks += 1;
        double axialStopArea = 0, antiRotArea = 0;
        for (const auto& pc : contacts) {
          const double par = angleDeg(pc.normal, bestAxis);
          if (par < 15.0) axialStopArea = std::max(axialStopArea, pc.area);
          else if (par > 75.0) antiRotArea = std::max(antiRotArea, pc.area);
        }
        if (axialStopArea >= kMinContactArea && axialStopArea >= antiRotArea) {
          c.type = "revolute";
          c.confidence = 0.90;
          c.evidence.push_back({"planar-axial-stop", fmt("area=%.0fmm2", axialStopArea), axialStopArea});
        } else if (antiRotArea >= kMinContactArea) {
          c.type = "prismatic";
          c.confidence = 0.88;
          c.evidence.push_back({"planar-anti-rotation", fmt("area=%.0fmm2", antiRotArea), antiRotArea});
        } else {
          c.type = "cylindrical";  // 2 DOF：轴确定，转/移未定
          c.confidence = 0.55;
          c.evidence.push_back({"no-planar-discriminator", "同轴圆柱无平面止推/防转证据", 0});
        }
        cands.push_back(c);
      }

      // ---- 规则 R2：平面贴合 + 长条包围盒 → 移动副 ----
      if (!pairHasCoax) {
        const auto contacts = planeContacts(pa, pb);
        planePairChecks += 1;
        if (!contacts.empty()) {
          const PlaneContact& best = contacts.front();
          // 贴合面内、两块板沿哪个方向相对滑：取较小件的包围盒长轴投影到贴合面
          const bool aSmaller = pa.bbox.diagonal() <= pb.bbox.diagonal();
          const Part& mover = aSmaller ? pa : pb;
          const Part& holder = aSmaller ? pb : pa;
          const Vec3 n = best.normal.unit();
          const Vec3 size = mover.bbox.size();
          // 候选方向：世界 X/Y/Z 中与 n 最不平行的，按该方向伸长量取最大
          Vec3 axes[3] = {{1, 0, 0}, {0, 1, 0}, {0, 0, 1}};
          double len[3] = {size.x, size.y, size.z};
          int bestI = -1;
          for (int i = 0; i < 3; ++i) {
            if (std::fabs(axes[i].dot(n)) > 0.5) continue;  // 落在贴合面内
            if (bestI < 0 || len[i] > len[bestI]) bestI = i;
          }
          if (bestI < 0) continue;
          double second = 0;
          for (int i = 0; i < 3; ++i) {
            if (i == bestI || std::fabs(axes[i].dot(n)) > 0.5) continue;
            second = std::max(second, len[i]);
          }
          const double aspect = second > 1e-6 ? len[bestI] / second : 99.0;
          if (aspect < 1.5) continue;
          const double ratio = mover.bbox.diagonal() > 1e-6
                                   ? std::min(1.0, best.area / (mover.bbox.diagonal() * mover.bbox.diagonal()))
                                   : 0.0;
          Candidate c;
          c.a = pa.id;
          c.b = pb.id;
          c.type = "prismatic";
          c.axisDir = axes[bestI];
          c.axisOrigin = best.point;
          c.contactArea = best.area;
          c.confidence = 0.60 + 0.25 * std::min(1.0, (aspect - 1.5) / 2.0) + 0.05 * ratio;
          if (c.confidence > 0.92) c.confidence = 0.92;
          c.evidence.push_back({"planar-contact", fmt("area=%.0fmm2 gap<%.1fmm", best.area, kTolPlaneGap), best.area});
          c.evidence.push_back({"elongated-bbox",
                                fmt("mover=%s len=%.1fmm cross=%.1fmm aspect=%.2f", mover.name.c_str(), len[bestI], second, aspect),
                                aspect});
          if (holder.bbox.diagonal() > mover.bbox.diagonal() * 1.5) {
            c.confidence += 0.03;
            c.evidence.push_back({"size-contrast", "承导件明显大于动件", 0});
          }
          if (c.confidence > 0.95) c.confidence = 0.95;
          cands.push_back(c);
        }
      }
    }
  }

  // 去重：同一零件对保留置信度最高的候选
  std::sort(cands.begin(), cands.end(), [](const Candidate& x, const Candidate& y) {
    return x.confidence > y.confidence;
  });
  std::vector<Candidate> kept;
  for (const auto& c : cands) {
    bool dup = false;
    for (const auto& k : kept)
      if ((k.a == c.a && k.b == c.b) || (k.a == c.b && k.b == c.a)) dup = true;
    if (!dup) kept.push_back(c);
  }
  std::sort(kept.begin(), kept.end(), [](const Candidate& x, const Candidate& y) {
    return x.a != y.a ? x.a < y.a : x.b < y.b;
  });

  const auto t2 = std::chrono::steady_clock::now();
  const double readMs = std::chrono::duration<double, std::milli>(t1 - t0).count();
  const double analyzeMs = std::chrono::duration<double, std::milli>(t2 - t1).count();

  if (json) {
    printf("{\n");
    printf("  \"file\": \"%s\",\n", file.c_str());
    printf("  \"parts\": %zu, \"faces\": %d, \"planeFaces\": %d, \"cylinderFaces\": %d,\n", parts.size(),
           totalFaces, totalPlane, totalCyl);
    printf("  \"readMs\": %.1f, \"analyzeMs\": %.1f,\n", readMs, analyzeMs);
    printf("  \"partList\": [\n");
    for (size_t i = 0; i < parts.size(); ++i) {
      const Part& p = parts[i];
      printf("    {\"id\": %d, \"name\": \"%s\", \"faces\": %d, \"solids\": %d, \"cyl\": %zu, \"plane\": %zu, \"area\": %.1f,\n",
             p.id, p.name.c_str(), p.faceCount, p.solidCount, p.cylinders.size(), p.planes.size(), p.totalArea);
      printf("     \"bbox\": [%.2f,%.2f,%.2f,%.2f,%.2f,%.2f],\n", p.bbox.lo.x, p.bbox.lo.y, p.bbox.lo.z,
             p.bbox.hi.x, p.bbox.hi.y, p.bbox.hi.z);
      printf("     \"types\": {");
      const char* names[] = {"plane", "cylinder", "cone", "sphere", "torus", "bezier", "bspline",
                             "revolution", "extrusion", "offset", "other"};
      bool firstType = true;
      for (int t = 0; t < 11; ++t) {
        if (!p.counts[t]) continue;
        printf("%s\"%s\": %d", firstType ? "" : ", ", names[t], p.counts[t]);
        firstType = false;
      }
      printf("}}%s\n", i + 1 < parts.size() ? "," : "");
    }
    printf("  ],\n");
    printf("  \"cylinders\": [\n");
    std::vector<std::string> cylLines;
    for (const auto& p : parts) {
      for (const auto& c : p.cylinders) {
        cylLines.push_back(fmt("    {\"part\": %d, \"name\": \"%s\", \"R\": %.3f, "
                               "\"axis\": [%.4f,%.4f,%.4f], \"origin\": [%.2f,%.2f,%.2f], "
                               "\"arcDeg\": %.1f, \"h\": %.2f, \"area\": %.1f}",
                               p.id, p.name.c_str(), c.radius, c.axis.x, c.axis.y, c.axis.z,
                               c.origin.x, c.origin.y, c.origin.z, c.arcDeg, c.height, c.area));
      }
    }
    for (size_t i = 0; i < cylLines.size(); ++i)
      printf("%s%s\n", cylLines[i].c_str(), i + 1 < cylLines.size() ? "," : "");
    printf("  ],\n");
    printf("  \"candidates\": [\n");
    for (size_t i = 0; i < kept.size(); ++i) {
      const Candidate& c = kept[i];
      printf("    {\"a\": %d, \"b\": %d, \"nameA\": \"%s\", \"nameB\": \"%s\", \"type\": \"%s\", "
             "\"axis\": [%.3f,%.3f,%.3f], \"origin\": [%.2f,%.2f,%.2f], \"confidence\": %.2f, "
             "\"radius\": %.2f, \"radiusDiff\": %.2f, \"overlap\": %.2f, \"contactArea\": %.1f, \"evidence\": [",
             c.a, c.b, parts[c.a].name.c_str(), parts[c.b].name.c_str(), c.type.c_str(), c.axisDir.x,
             c.axisDir.y, c.axisDir.z, c.axisOrigin.x, c.axisOrigin.y, c.axisOrigin.z, c.confidence,
             c.radius, c.radiusDiff, c.overlapLen, c.contactArea);
      for (size_t k = 0; k < c.evidence.size(); ++k)
        printf("%s\"%s: %s\"", k ? ", " : "", c.evidence[k].kind.c_str(), c.evidence[k].detail.c_str());
      printf("]}%s\n", i + 1 < kept.size() ? "," : "");
    }
    printf("  ],\n");
    printf("  \"stats\": {\"pairChecks\": %ld, \"cylPairChecks\": %ld}\n", planePairChecks, cylPairChecks);
    printf("}\n");
    return 0;
  }

  if (!quiet) {
    printf("== %s ==\n", file.c_str());
    printf("parts=%zu faces=%d (plane %d / cylinder %d)  read=%.1fms analyze=%.1fms\n\n", parts.size(),
           totalFaces, totalPlane, totalCyl, readMs, analyzeMs);
    printf("-- 零件面清单 --\n");
    for (const auto& p : parts) {
      printf("[%d] %-10s faces=%-4d cyl=%-2zu plane=%-3zu bbox=[%.1f,%.1f,%.1f]-[%.1f,%.1f,%.1f]\n", p.id,
             p.name.c_str(), p.faceCount, p.cylinders.size(), p.planes.size(), p.bbox.lo.x, p.bbox.lo.y,
             p.bbox.lo.z, p.bbox.hi.x, p.bbox.hi.y, p.bbox.hi.z);
      for (const auto& c : p.cylinders)
        printf("      cyl R=%.3f axis=(%.2f,%.2f,%.2f) origin=(%.1f,%.1f,%.1f) arc=%.0fdeg h=%.1f\n",
               c.radius, c.axis.x, c.axis.y, c.axis.z, c.origin.x, c.origin.y, c.origin.z, c.arcDeg,
               c.height);
    }
    printf("\n-- 运动副候选（%zu）--\n", kept.size());
  }
  for (const auto& c : kept) {
    printf("  %-9s <-> %-9s %-12s axis=(%+.2f,%+.2f,%+.2f) conf=%.2f\n", parts[c.a].name.c_str(),
           parts[c.b].name.c_str(), c.type.c_str(), c.axisDir.x, c.axisDir.y, c.axisDir.z, c.confidence);
    for (const auto& e : c.evidence) printf("        · %s: %s\n", e.kind.c_str(), e.detail.c_str());
  }
  return 0;
}
