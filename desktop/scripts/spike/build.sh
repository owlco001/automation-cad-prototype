#!/bin/sh
# 编译 spike 原型（OCCT 7.6 系统库，无新增依赖）。
# /usr/local/include/opencascade 只做 7.6.3 缺失头（NCollection_AliasedArray.hxx）的兜底。
set -e
cd "$(dirname "$0")"
INC="-I/usr/include/opencascade -I/usr/local/include/opencascade"
LIBS="-lTKPrim -lTKMath -lTKBRep -lTKTopAlgo -lTKBO -lTKSTEP -lTKXSBase -lTKShHealing \
-lTKG3d -lTKGeomBase -lTKGeomAlgo -lTKXCAF -lTKCAF -lTKLCAF -lTKVCAF -lTKSTEPBase -lTKSTEPAttr -lTKXDESTEP -lTKXDEIGES -lTKCDF -lTKernel"
g++ -std=c++17 -O2 -w $INC make_fixture.cpp $LIBS -o make_fixture
g++ -std=c++17 -O2 -w $INC brep_joints.cpp $LIBS -o brep_joints
echo "built: $(pwd)/make_fixture $(pwd)/brep_joints"
