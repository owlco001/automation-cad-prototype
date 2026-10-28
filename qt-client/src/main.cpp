// AutomationCAD Qt 客户端入口 v0.1（壳子）。
// 启动前需先启动 FeatureTree 契约服务（featuretree-service/server.mjs，默认 127.0.0.1:18080），
// 否则主窗口状态栏会显示“服务未连接”，这是预期行为，不是崩溃。
#include "MainWindow.h"
#include <QApplication>
#include <QSurfaceFormat>
#include <QDebug>
#include <QStringList>
#include <QTimer>

#include <cstdio>
#include <cstdlib>

int main(int argc, char *argv[]) {
    // QOpenGLWidget + #version 330 core 需要 3.3 core 上下文；不设默认格式会拿到 2.1 兼容上下文
    QSurfaceFormat format;
    format.setRenderableType(QSurfaceFormat::OpenGL);
    format.setVersion(3, 3);
    format.setProfile(QSurfaceFormat::CoreProfile);
    format.setDepthBufferSize(24);
    format.setSamples(4);
    QSurfaceFormat::setDefaultFormat(format);

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

    // 撤销/重做自检：--history-selftest [--base URL]
    if (args.contains(QStringLiteral("--history-selftest"))) {
        QString base = QStringLiteral("http://127.0.0.1:18080");
        const int baseIndex = args.indexOf(QStringLiteral("--base"));
        if (baseIndex >= 0 && baseIndex + 1 < args.size()) base = args.at(baseIndex + 1);
        MainWindow window;
        int undoRevision = -1;
        int redoRevision = -1;
        double height = -1;
        QString error;
        if (!window.runHistorySelfTest(base, &undoRevision, &redoRevision, &height, &error)) {
            qCritical().noquote() << "FT_QT_HISTORY_FAIL" << error;
            return 1;
        }
        qInfo().noquote() << QStringLiteral("FT_QT_HISTORY_OK undo=r%1 redo=r%2 height=%3").arg(undoRevision).arg(redoRevision).arg(height);
        return 0;
    }

    // 自动刷新自检：--watch-selftest [--base URL]
    // 读一次 → 打印 WATCH_READY → 外部改一次树 → 客户端应在 1.5s 内检测到新 revision 并打印 REFRESH_OK。
    if (args.contains(QStringLiteral("--watch-selftest"))) {
        QString base = QStringLiteral("http://127.0.0.1:18080");
        const int baseIndex = args.indexOf(QStringLiteral("--base"));
        if (baseIndex >= 0 && baseIndex + 1 < args.size()) base = args.at(baseIndex + 1);
        MainWindow window;
        window.setServiceBase(base);
        int seen = -1;
        bool firstSeen = false;
        QObject::connect(&window, &MainWindow::envelopeRefreshed, &app, [&](int revision) {
            if (!firstSeen) {
                firstSeen = true;
                seen = revision;
                qInfo().noquote() << QStringLiteral("FT_QT_WATCH_READY revision=%1").arg(revision);
                return;
            }
            if (revision != seen) {
                qInfo().noquote() << QStringLiteral("FT_QT_REFRESH_OK revision=%1").arg(revision);
                // 自检进程必须立刻、确定地退出：exit(0) 在嵌套事件循环里可能被推迟，
                // 这里先刷 stdout 再直接结束进程，避免 CI 里等 5s 超时。
                std::fflush(stdout);
                std::_Exit(0);
            }
        });
        window.startAutoRefresh(1500);
        window.refreshNow();
        QTimer::singleShot(20000, &app, []() {
            qCritical().noquote() << QStringLiteral("FT_QT_WATCH_TIMEOUT");
            QCoreApplication::exit(1);
        });
        return app.exec();
    }

    QString base = QStringLiteral("http://127.0.0.1:18080");
    const int baseIndex = args.indexOf(QStringLiteral("--base"));
    if (baseIndex >= 0 && baseIndex + 1 < args.size()) base = args.at(baseIndex + 1);
    MainWindow window;
    window.setServiceBase(base);
    window.show();
    // 普通启动也要真的去读一次树，并开启自动刷新；否则界面永远显示「服务未连接」
    window.refreshNow();
    window.startAutoRefresh(1500);
    return app.exec();
}
