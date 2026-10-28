// AutomationCAD Qt 客户端入口 v0.1（壳子）。
// 启动前需先启动 FeatureTree 契约服务（featuretree-service/server.mjs，默认 127.0.0.1:18080），
// 否则主窗口状态栏会显示“服务未连接”，这是预期行为，不是崩溃。
#include "MainWindow.h"
#include <QApplication>
#include <QDebug>
#include <QStringList>

int main(int argc, char *argv[]) {
    QApplication app(argc, argv);
    const QStringList args = QCoreApplication::arguments();

    // 无人值守自检：--selftest [--base http://127.0.0.1:PORT]
    // 用于 CI / 脚本验证「Qt 客户端 ↔ 契约服务」链路，不需要人去点界面。
    if (args.contains(QStringLiteral("--selftest"))) {
        QString base = QStringLiteral("http://127.0.0.1:18080");
        const int baseIndex = args.indexOf(QStringLiteral("--base"));
        if (baseIndex >= 0 && baseIndex + 1 < args.size()) base = args.at(baseIndex + 1);
        MainWindow window;
        int revision = -1;
        double height = -1;
        QString error;
        if (!window.runSelfTest(base, &revision, &height, &error)) {
            qCritical().noquote() << "FT_QT_SELFTEST_FAIL" << error;
            return 1;
        }
        qInfo().noquote() << QStringLiteral("FT_QT_SELFTEST_OK revision=%1 height=%2").arg(revision).arg(height);
        return 0;
    }

    MainWindow window;
    window.show();
    return app.exec();
}
