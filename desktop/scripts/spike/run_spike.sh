#!/bin/sh
# 一键复现：编译 → 生成合成夹具 → 两条规则跑真值对照 → 网格 PCA 取样 → 规模/耗时。
# 只依赖本机已有 OCCT 7.6 系统库 + g++ + node(occt-import-js) + python3。不装新包。
set -e
cd "$(dirname "$0")"

echo "### 0. 编译"
./build.sh

echo
echo "### 1. 生成合成装配（真实解析曲面：圆柱/平面，零件名 Part1..Part6）"
mkdir -p fixture
./make_fixture fixture/kinematics-analytic.stp | tail -1
./make_fixture /tmp/spike-grid46.stp --grid 40 >/dev/null

echo
echo "### 2. 候选清单（人读）"
./brep_joints fixture/kinematics-analytic.stp | sed -n '/运动副候选/,$p'

echo
echo "### 3. 真值 vs 估测"
python3 eval.py truth/kinematics-analytic.json
echo
echo "--- 仓库自带夹具（FACETED_BREP，圆柱被 16 棱柱化）---"
python3 eval.py truth/repo-fixture.json

echo
echo "### 4. 网格 PCA 在同一夹具上的信息量（对照 B-Rep）"
node pca_mesh.mjs fixture/kinematics-analytic.stp | head -10

echo
echo "### 5. 规模与耗时（零件数 → 零件对布尔次数 → 墙钟）"
for n in 0 20 40 100; do
  ./make_fixture /tmp/spike-scale.stp --grid "$n" >/dev/null
  printf "grid=%-4s " "$n"
  ./brep_joints /tmp/spike-scale.stp --json | python3 -c 'import json,sys; d=json.load(sys.stdin); print("parts=%d faces=%d pairs=%d read=%.0fms analyze=%.0fms" % (d["parts"], d["faces"], d["parts"]*(d["parts"]-1)//2, d["readMs"], d["analyzeMs"]))'
done

echo
echo "### 6. 代码量"
wc -l brep_joints.cpp make_fixture.cpp eval.py pca_mesh.mjs build.sh | tail -6
