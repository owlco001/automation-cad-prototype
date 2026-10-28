cmake_minimum_required(VERSION 3.16)
project(AutomationCAD-QtClient VERSION 0.1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_AUTOMOC ON)
set(CMAKE_AUTOUIC ON)
set(CMAKE_AUTORCC ON)

# 本机（Linux 虚拟机）暂无 Qt6 工具链：本工程在此环境下未编译，
# 需在装有 Qt6（Widgets + Network）的 Windows / Linux 机器上构建验证。
# 视口 v1 为占位 QWidget；OCCT AIS Viewer 接入是后续里程碑，不在本壳子里假装已接。
find_package(Qt6 REQUIRED COMPONENTS Widgets Network OpenGLWidgets)

add_executable(automationcad-qt
    src/main.cpp
    src/MainWindow.cpp
    src/StlViewport.cpp
    src/FeatureDialog.cpp
    src/MainWindow.h
)
target_link_libraries(automationcad-qt PRIVATE Qt6::Widgets Qt6::Network Qt6::OpenGLWidgets)

# OCCT AIS 视口（可选）：运行时库本来就在，缺的是头文件。
# 本机 Debian 12/13 混源时 libocct-{data-exchange,visualization}-dev 被 libfreetype-dev
# 版本冲突卡住，可以把这两个 dev 包的头文件解到 /usr/local/include/opencascade。
# 只有找到 Standard.hxx + AIS_InteractiveContext.hxx 才启用，否则回退到 OpenGL STL 视口。
find_path(OCCT_INCLUDE_FOUNDATION NAMES Standard.hxx
    PATHS /usr/include/opencascade /usr/local/include/opencascade)
find_path(OCCT_INCLUDE_AIS NAMES AIS_InteractiveContext.hxx
    PATHS /usr/local/include/opencascade /usr/include/opencascade)

if(OCCT_INCLUDE_FOUNDATION AND OCCT_INCLUDE_AIS)
  message(STATUS "OCCT AIS 视口：启用（${OCCT_INCLUDE_FOUNDATION}; ${OCCT_INCLUDE_AIS}）")
  target_sources(automationcad-qt PRIVATE src/OcctViewport.cpp src/OcctViewport.h)
  target_include_directories(automationcad-qt PRIVATE ${OCCT_INCLUDE_FOUNDATION} ${OCCT_INCLUDE_AIS})
  target_compile_definitions(automationcad-qt PRIVATE AUTOMATIONCAD_HAVE_OCCT=1)
  target_link_libraries(automationcad-qt PRIVATE
      TKOpenGl TKV3d TKService TKMath TKBRep TKTopAlgo TKPrim TKSTL TKernel TKG3d TKGeomBase)
else()
  message(STATUS "OCCT AIS 视口：未启用（缺头文件），回退到 OpenGL STL 视口")
endif()
