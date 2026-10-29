// AutomationCAD Qt 客户端入口 v0.1（壳子）。
// 启动前需先启动 FeatureTree 契约服务（featuretree-service/server.mjs，默认 127.0.0.1:18080），
// 否则主窗口状态栏会显示“服务未连接”，这是预期行为，不是崩溃。
#include "MainWindow.h"
#include "MachineCaseDialog.h"
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

    // 多文档自检：--document-selftest [--base URL]
    if (args.contains(QStringLiteral("--document-selftest"))) {
        QString base = QStringLiteral("http://127.0.0.1:18080");
        const int baseIndex = args.indexOf(QStringLiteral("--base"));
        if (baseIndex >= 0 && baseIndex + 1 < args.size()) base = args.at(baseIndex + 1);
        MainWindow window;
        int newRevision = -1;
        double defaultHeight = -1;
        QString error;
        if (!window.runDocumentSelfTest(base, &newRevision, &defaultHeight, &error)) {
            qCritical().noquote() << "FT_QT_DOCUMENT_FAIL" << error;
            return 1;
        }
        qInfo().noquote() << QStringLiteral("FT_QT_DOCUMENT_OK newRevision=%1 defaultHeight=%2").arg(newRevision).arg(defaultHeight);
        return 0;
    }

    // SSE 自检：--sse-selftest [--base URL]（外部脚本负责改树，这里只等事件）
    if (args.contains(QStringLiteral("--sse-selftest"))) {
        QString base = QStringLiteral("http://127.0.0.1:18080");
        const int baseIndex = args.indexOf(QStringLiteral("--base"));
        if (baseIndex >= 0 && baseIndex + 1 < args.size()) base = args.at(baseIndex + 1);
        MainWindow window;
        window.setServiceBase(base);
        window.startAutoRefresh(30'000); // 自检期间把轮询调到很慢，确保刷新来自 SSE 而不是轮询
        int revision = -1;
        QString error;
        if (!window.runSseSelfTest(base, &revision, &error)) {
            qCritical().noquote() << "FT_QT_SSE_FAIL" << error;
            return 1;
        }
        qInfo().noquote() << QStringLiteral("FT_QT_SSE_OK revision=%1").arg(revision);
        return 0;
    }

    // 新建特征自检：--create-feature-selftest [--base URL]
    if (args.contains(QStringLiteral("--create-feature-selftest"))) {
        QString base = QStringLiteral("http://127.0.0.1:18080");
        const int baseIndex = args.indexOf(QStringLiteral("--base"));
        if (baseIndex >= 0 && baseIndex + 1 < args.size()) base = args.at(baseIndex + 1);
        MainWindow window;
        double withHole = -1;
        double restored = -1;
        QString error;
        if (!window.runCreateFeatureSelfTest(base, &withHole, &restored, &error)) {
            qCritical().noquote() << "FT_QT_CREATEFEATURE_FAIL" << error;
            return 1;
        }
        qInfo().noquote() << QStringLiteral("FT_QT_CREATEFEATURE_OK withHole=%1 restored=%2").arg(withHole).arg(restored);
        return 0;
    }

    // 特征操作自检：--feature-ops-selftest [--base URL]
    if (args.contains(QStringLiteral("--feature-ops-selftest"))) {
        QString base = QStringLiteral("http://127.0.0.1:18080");
        const int baseIndex = args.indexOf(QStringLiteral("--base"));
        if (baseIndex >= 0 && baseIndex + 1 < args.size()) base = args.at(baseIndex + 1);
        MainWindow window;
        double suppressedVolume = -1;
        double restoredVolume = -1;
        QString error;
        if (!window.runFeatureOpsSelfTest(base, &suppressedVolume, &restoredVolume, &error)) {
            qCritical().noquote() << "FT_QT_FEATUREOPS_FAIL" << error;
            return 1;
        }
        qInfo().noquote() << QStringLiteral("FT_QT_FEATUREOPS_OK suppressed=%1 restored=%2").arg(suppressedVolume).arg(restoredVolume);
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

    // 从 brief 生成整机方案自检：--brief-selftest "一句话"（要求 node + desktop 管线可执行）
    {
        const int briefIndex = args.indexOf(QStringLiteral("--brief-selftest"));
        if (briefIndex >= 0 && briefIndex + 1 < args.size()) {
            MainWindow window;
            QJsonObject document;
            QString error;
            if (!window.designMachineFromBrief(args.at(briefIndex + 1), &document, &error)) {
                qCritical().noquote() << "FT_QT_BRIEF_FAIL" << error;
                return 1;
            }
            qInfo().noquote() << "FT_QT_BRIEF_OK" << MachineCaseDialog::summarize(document);
            return 0;
        }
    }

    // 整机方案自检：--machine-case <path>，只读解析并打印摘要（人肉核对/CI 都能用）
    {
        const int caseIndex = args.indexOf(QStringLiteral("--machine-case"));
        if (caseIndex >= 0 && caseIndex + 1 < args.size()) {
            QJsonObject document;
            QString error;
            if (!MachineCaseDialog::loadFile(args.at(caseIndex + 1), &document, &error)) {
                qCritical().noquote() << "FT_QT_MACHINECASE_FAIL" << error;
                return 1;
            }
            qInfo().noquote() << "FT_QT_MACHINECASE_OK" << MachineCaseDialog::summarize(document);
            return 0;
        }
    }

    // brief → 方案窗口：--brief-ui "一句话"（截图/人肉核对用）
    {
        const int uiBrief = args.indexOf(QStringLiteral("--brief-ui"));
        if (uiBrief >= 0 && uiBrief + 1 < args.size()) {
            MainWindow window;
            window.show();
            QJsonObject document;
            QString error;
            if (!window.designMachineFromBrief(args.at(uiBrief + 1), &document, &error)) {
                qCritical().noquote() << "FT_QT_BRIEF_FAIL" << error;
                return 1;
            }
            qInfo().noquote() << "FT_QT_BRIEF_UI_OPEN" << MachineCaseDialog::summarize(document);
            MachineCaseDialog dialog(document, nullptr);
            dialog.exec();
            return 0;
        }
    }

    // 整机方案窗口：--machine-case-ui <path>（给截图/人肉核对用，会停在窗口上）
    {
        const int uiIndex = args.indexOf(QStringLiteral("--machine-case-ui"));
        if (uiIndex >= 0 && uiIndex + 1 < args.size()) {
            QJsonObject document;
            QString error;
            if (!MachineCaseDialog::loadFile(args.at(uiIndex + 1), &document, &error)) {
                qCritical().noquote() << "FT_QT_MACHINECASE_FAIL" << error;
                return 1;
            }
            MainWindow window;
            window.show();
            MachineCaseDialog dialog(document, nullptr);
            qInfo().noquote() << "FT_QT_MACHINECASE_UI_OPEN" << MachineCaseDialog::summarize(document);
            dialog.exec();
            return 0;
        }
    }

    // 导出 STL 自检：--export-selftest --out <path> [--base URL] [assembly=DOC]
    if (args.contains(QStringLiteral("--export-selftest"))) {
        QString base = QStringLiteral("http://127.0.0.1:18781");
        const int baseIndex = args.indexOf(QStringLiteral("--base"));
        if (baseIndex >= 0 && baseIndex + 1 < args.size()) base = args.at(baseIndex + 1);
        const int outIndex = args.indexOf(QStringLiteral("--out"));
        const QString out = outIndex >= 0 && outIndex + 1 < args.size()
            ? args.at(outIndex + 1) : QStringLiteral("/tmp/export-selftest.stl");
        MainWindow window;
        window.setServiceBase(base);
        const QString assemblyId = qEnvironmentVariable("AUTOMATIONCAD_QT_ASSEMBLY");
        if (!assemblyId.isEmpty()) window.openAssembly(assemblyId);
        int bytes = 0;
        QString error;
        if (!window.exportStl(out, &bytes, &error)) {
            qCritical().noquote() << "FT_QT_EXPORT_FAIL" << error;
            return 1;
        }
        qInfo().noquote() << QStringLiteral("FT_QT_EXPORT_OK path=%1 bytes=%2 triangles=%3")
                                 .arg(out).arg(bytes).arg((bytes - 84) / 50);
        return 0;
    }

    // 装配清单自检：--bom-selftest [--base URL]，直接把 Ctrl+B 的窗口弹出来（人肉截图/核对用）
    if (args.contains(QStringLiteral("--bom-selftest"))) {
        QString base = QStringLiteral("http://127.0.0.1:18781");
        const int baseIndex = args.indexOf(QStringLiteral("--base"));
        if (baseIndex >= 0 && baseIndex + 1 < args.size()) base = args.at(baseIndex + 1);
        QString assemblyId = qEnvironmentVariable("AUTOMATIONCAD_QT_ASSEMBLY");
        MainWindow window;
        window.setServiceBase(base);
        if (!assemblyId.isEmpty()) window.openAssembly(assemblyId);
        QTimer::singleShot(1200, &window, [&window]() {
            window.runAssemblyBom();
            qInfo().noquote() << "FT_QT_BOM_DIALOG_OPEN";
        });
        window.show();
        return app.exec();
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
    // 普通启动也要真的去读一次树；SSE 为主、轮询（10s）兜底，断线自动重连
    window.refreshNow();
    window.startEventStream();
    window.startAutoRefresh(10'000);
    // 截图用：AUTOMATIONCAD_QT_ASSEMBLY=<id> 启动后打开装配视图
    if (qEnvironmentVariableIsSet("AUTOMATIONCAD_QT_ASSEMBLY")) {
        const QString asmId = qEnvironmentVariable("AUTOMATIONCAD_QT_ASSEMBLY");
        QTimer::singleShot(1500, &window, [&window, asmId]() { window.openAssembly(asmId); });
    }
    // 截图用：AUTOMATIONCAD_QT_DOC=<id> 启动后切到指定文档
    if (qEnvironmentVariableIsSet("AUTOMATIONCAD_QT_DOC")) {
        const QString doc = qEnvironmentVariable("AUTOMATIONCAD_QT_DOC");
        QTimer::singleShot(1500, &window, [&window, doc]() { window.setDocument(doc); window.refreshNow(); });
    }
    // 截图/自检用：AUTOMATIONCAD_QT_VIEW=0..3 启动后直接切标准视角
    if (qEnvironmentVariableIsSet("AUTOMATIONCAD_QT_VIEW")) {
        bool ok = false;
        const int which = qEnvironmentVariable("AUTOMATIONCAD_QT_VIEW").toInt(&ok);
        if (ok) QTimer::singleShot(1800, &window, [&window, which]() { window.applyStandardView(which); });
    }
    return app.exec();
}
