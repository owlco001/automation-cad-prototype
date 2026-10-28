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
