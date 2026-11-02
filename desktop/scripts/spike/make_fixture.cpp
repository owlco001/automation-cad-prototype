// 合成运动副装配夹具（真实解析曲面：圆柱/平面，非 FACETED_BREP）。
// 用法：./make_fixture <输出.stp> [--grid N]
//   --grid N  额外生成 N 个棋盘格零件（面数/耗时爆炸测试用），不改动基准 6 件装配。
//
// 设计意图：零件名全部是不可读的 Part1..Part6（复刻客户 STEP 的现实），
// 每个零件在**自身局部坐标系**建模，再用 XCAF location 摆到世界坐标 —— 逼原型必须处理装配变换。
//
// 真值（写进 docs 报告，夹具里不存）：
//   J1 Part2↔Part1  移动副  轴 +X
//   J2 Part4↔Part3  移动副  轴 +Z（D 形活塞 + 铣扁平面防转）
//   J3 Part6↔Part5  转动副  轴 +Y（轴 + 两端轴环做轴向定位）
#include <BRepAlgoAPI_Cut.hxx>
#include <BRepAlgoAPI_Fuse.hxx>
#include <BRepBuilderAPI_Transform.hxx>
#include <BRepPrimAPI_MakeBox.hxx>
#include <BRepPrimAPI_MakeCylinder.hxx>
#include <BRep_Builder.hxx>
#include <BRepMesh_IncrementalMesh.hxx>
#include <IFSelect_ReturnStatus.hxx>
#include <STEPCAFControl_Writer.hxx>
#include <TDataStd_Name.hxx>
#include <TDF_Label.hxx>
#include <TDocStd_Document.hxx>
#include <TopoDS_Compound.hxx>
#include <XCAFApp_Application.hxx>
#include <XCAFDoc_DocumentTool.hxx>
#include <XCAFDoc_ShapeTool.hxx>
#include <gp_Ax2.hxx>
#include <gp_Pnt.hxx>
#include <gp_Trsf.hxx>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

static TopoDS_Shape box(double x0, double y0, double z0, double x1, double y1, double z1) {
  return BRepPrimAPI_MakeBox(gp_Pnt(x0, y0, z0), gp_Pnt(x1, y1, z1)).Shape();
}

static TopoDS_Shape cylZ(double cx, double cy, double z0, double z1, double r) {
  return BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(cx, cy, z0), gp_Dir(0, 0, 1)), r, z1 - z0).Shape();
}

static TopoDS_Shape cylY(double cx, double cz, double y0, double y1, double r) {
  return BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(cx, y0, cz), gp_Dir(0, 1, 0)), r, y1 - y0).Shape();
}

static TopoDS_Shape cut(const TopoDS_Shape& a, const TopoDS_Shape& b) {
  BRepAlgoAPI_Cut op(a, b);
  op.Build();
  return op.Shape();
}

static TopoDS_Shape fuse(const TopoDS_Shape& a, const TopoDS_Shape& b) {
  BRepAlgoAPI_Fuse op(a, b);
  op.Build();
  return op.Shape();
}

static TopLoc_Location loc(double x, double y, double z) {
  gp_Trsf t;
  t.SetTranslation(gp_Vec(x, y, z));
  return TopLoc_Location(t);
}

int main(int argc, char** argv) {
  if (argc < 2) {
    std::cerr << "usage: make_fixture <out.stp> [--grid N]" << std::endl;
    return 2;
  }
  const std::string out = argv[1];
  int grid = 0;
  for (int i = 2; i < argc; ++i) {
    if (std::string(argv[i]) == "--grid" && i + 1 < argc) grid = std::atoi(argv[++i]);
  }

  // ---- 局部坐标建模（每件以自身中心/端面为原点）----
  // Part1 底座 200x120x15，局部 z -7.5..7.5
  TopoDS_Shape part1 = box(-100, -60, -7.5, 100, 60, 7.5);
  // Part2 滑块 80x40x20，局部居中
  TopoDS_Shape part2 = box(-40, -20, -10, 40, 20, 10);
  // Part3 缸体 50x50x80，局部居中；中心 R10 通孔沿 Z，+Y 侧铣出弦平面 y=+6
  TopoDS_Shape part3 = box(-25, -25, -40, 25, 25, 40);
  // D 形内孔 = 圆柱 ∩ {y < 6}：孔壁上的铣扁平面在 y=6，法向 -Y，材料在 +Y 侧
  TopoDS_Shape bore3 = cylZ(0, 0, -45, 45, 10);
  bore3 = cut(bore3, box(-11, 6, -45, 11, 30, 45));
  part3 = cut(part3, bore3);
  // Part4 活塞 R9.8，局部 z -35..45，同为 D 形截面，扁平面在 y=5.8（与孔壁留 0.2 间隙，法向 +Y）
  TopoDS_Shape part4 = cut(cylZ(0, 0, -35, 45, 9.8), box(-12, 5.8, -50, 12, 30, 60));
  // Part5 轴套 30x30x30，局部居中；中心 R6 通孔沿 Y
  TopoDS_Shape part5 = box(-15, -15, -15, 15, 15, 15);
  part5 = cut(part5, cylY(0, 0, -20, 20, 6));
  // Part6 轴 R5.9 沿 Y，两端轴环 R9（轴向定位 → 转动副）
  TopoDS_Shape part6 = cylY(0, 0, -19, 19, 5.9);
  part6 = fuse(part6, cylY(0, 0, -17.2, -15.2, 9));
  part6 = fuse(part6, cylY(0, 0, 15.2, 17.2, 9));

  struct Item {
    std::string name;
    TopoDS_Shape shape;
    TopLoc_Location where;
  };
  std::vector<Item> items = {
      {"Part1", part1, loc(100, 60, 7.5)},
      {"Part2", part2, loc(100, 60, 25)},     // 底面 z=15 贴合底座顶面
      {"Part3", part3, loc(175, 25, 55)},     // 底面 z=15 落在底座上
      {"Part4", part4, loc(175, 25, 55)},     // 与 Part3 同轴
      {"Part5", part5, loc(35, 45, 30)},      // 底面 z=15 落在底座上
      {"Part6", part6, loc(35, 45, 30)},      // 与 Part5 同轴
  };

  // --grid N：N 个棋盘格小方块（面数放大测试）
  for (int i = 0; i < grid; ++i) {
    const int gx = i % 20, gy = i / 20;
    std::ostringstream name;
    name << "Fill" << (i + 1);
    items.push_back({name.str(), box(-5, -5, -5, 5, 5, 5),
                     loc(10 + gx * 12.0, 200 + gy * 12.0, 5)});
  }

  Handle(TDocStd_Document) doc;
  XCAFApp_Application::GetApplication()->NewDocument("MDTV-XCAF", doc);
  Handle(XCAFDoc_ShapeTool) shapeTool = XCAFDoc_DocumentTool::ShapeTool(doc->Main());
  const TDF_Label asmLabel = shapeTool->NewShape();
  TDataStd_Name::Set(asmLabel, TCollection_ExtendedString("ASM"));
  for (auto& it : items) {
    TDF_Label label = shapeTool->AddShape(it.shape, false);
    TDataStd_Name::Set(label, TCollection_ExtendedString(it.name.c_str()));
    shapeTool->AddComponent(asmLabel, label, it.where);
  }
  shapeTool->UpdateAssemblies();

  STEPCAFControl_Writer writer;
  writer.SetNameMode(true);
  writer.SetColorMode(true);
  if (!writer.Transfer(doc, STEPControl_AsIs)) {
    std::cerr << "transfer failed" << std::endl;
    return 1;
  }
  if (writer.Write(out.c_str()) != IFSelect_RetDone) {
    std::cerr << "write failed" << std::endl;
    return 1;
  }
  std::cout << "wrote " << out << " parts=" << items.size() << std::endl;
  return 0;
}
