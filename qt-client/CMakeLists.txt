cmake_minimum_required(VERSION 3.16)
project(AutomationCAD-QtClient VERSION 0.5.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_AUTOMOC ON)
set(CMAKE_AUTOUIC ON)
set(CMAKE_AUTORCC ON)

# 本机（Linux 虚拟机）暂无 Qt6 工具链：本工程在此环境下未编译，
# 需在装有 Qt6（Widgets + Network）的 Windows / Linux 机器上构建验证。
# 视口 v1 为占位 QWidget；OCCT AIS Viewer 接入是后续里程碑，不在本壳子里假装已接。
find_package(Qt6 REQUIRED COMPONENTS Widgets Network OpenGLWidgets)

add_compile_definitions(AUTOMATIONCAD_VERSION="${PROJECT_VERSION}")

add_executable(automationcad-qt
    src/main.cpp
    src/MainWindow.cpp
    src/StlViewport.cpp
    src/FeatureDialog.cpp
    src/MachineCaseDialog.cpp
    src/LinkageDialog.cpp
    src/LinkageDialog.h
    src/MainWindow.h
)
target_link_libraries(automationcad-qt PRIVATE Qt6::Widgets Qt6::Network Qt6::OpenGLWidgets)

# OCCT AIS 视口（可选）：运行时库本来就在，缺的是头文件。
# 本机 Debian 12/13 混源时 libocct-{data-exchange,visualization}-dev 被 libfreetype-dev
# 版本冲突卡住，可以把这两个 dev 包的头文件解到 /usr/local/include/opencascade。
# 只有找到 Standard.hxx + AIS_InteractiveContext.hxx 才启用，否则回退到 OpenGL STL 视口。
# -DAUTOMATIONCAD_OCCT=OFF 可以强制走「没有 OCCT」的构建路径，
# 用来在本机复现 CI（CI 只装 Qt，没有 OCCT 头文件）。
option(AUTOMATIONCAD_OCCT "启用 OCCT AIS 视口（找不到头文件时自动回退）" ON)

# Windows 预编译 OCCT（conda-forge occt --no-deps，头文件在 include/opencascade、
# 导入库 .lib 在 lib、运行库 .dll 在 bin）没有往系统里装，用 OCCT_ROOT 指过去；
# Linux 继续按原来 /usr/include 找。
set(OCCT_ROOT "" CACHE PATH "OCCT 根目录（其下应有 include/opencascade 与 lib）")
find_path(OCCT_INCLUDE_FOUNDATION NAMES Standard.hxx
    HINTS ${OCCT_ROOT}/include/opencascade ${OCCT_ROOT}/inc
    PATHS /usr/include/opencascade /usr/local/include/opencascade)
find_path(OCCT_INCLUDE_AIS NAMES AIS_InteractiveContext.hxx
    HINTS ${OCCT_ROOT}/include/opencascade ${OCCT_ROOT}/inc
    PATHS /usr/local/include/opencascade /usr/include/opencascade)
find_path(OCCT_LIB_DIR NAMES TKernel.lib TKernel.so
    HINTS ${OCCT_ROOT}/lib ${OCCT_ROOT}/win64/vc14/lib
    PATHS /usr/lib/x86_64-linux-gnu /usr/local/lib /usr/lib)

if(AUTOMATIONCAD_OCCT AND OCCT_INCLUDE_FOUNDATION AND OCCT_INCLUDE_AIS)
  message(STATUS "OCCT AIS 视口：启用（${OCCT_INCLUDE_FOUNDATION}; ${OCCT_INCLUDE_AIS}）")
  target_sources(automationcad-qt PRIVATE src/OcctViewport.cpp src/OcctViewport.h)
  target_include_directories(automationcad-qt PRIVATE ${OCCT_INCLUDE_FOUNDATION} ${OCCT_INCLUDE_AIS})
  if(OCCT_LIB_DIR)
    target_link_directories(automationcad-qt PRIVATE ${OCCT_LIB_DIR})
  endif()
  target_compile_definitions(automationcad-qt PRIVATE AUTOMATIONCAD_HAVE_OCCT=1)
  # OCCT 8.0 把 STL 读写从 TKSTL 拆到了 TKDESTL；7.x 还是 TKSTL。
  # 按实际存在的库名挑，不写死版本。
  find_library(OCCT_STL_LIB NAMES TKSTL TKDESTL HINTS ${OCCT_LIB_DIR})
  if(NOT OCCT_STL_LIB)
    message(STATUS "OCCT STL 库：未找到 TKSTL/TKDESTL，跳过 STL 导出链接")
  endif()
  target_link_libraries(automationcad-qt PRIVATE
      TKOpenGl TKV3d TKService TKMath TKBRep TKTopAlgo TKPrim TKBO ${OCCT_STL_LIB} TKernel TKG3d TKGeomBase)
else()
  message(STATUS "OCCT AIS 视口：未启用（缺头文件），回退到 OpenGL STL 视口")
endif()
