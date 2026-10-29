// AutomationCAD Qt 客户端入口 v0.1（壳子）。
// 启动前需先启动 FeatureTree 契约服务（featuretree-service/server.mjs，默认 127.0.0.1:18080），
// 否则主窗口状态栏会显示“服务未连接”，这是预期行为，不是崩溃。
#include "MainWindow.h"
#include "MachineCaseDialog.h"
#include <QApplication>
#include <QSurfaceFormat>
#include <QDebug>
#include <QDir>
#include <QFile>
#include <QStandardPaths>
#include <QJsonArray>
#include <QJsonObject>
#include <QStringList>
#include <QSpinBox>
#include <QTableWidget>
#include <QTableWidgetItem>
#include <QAbstractButton>
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
    // Windows 上 Qt 默认消息处理器走 OutputDebugString：从脚本/CI 起进程时
    // stdout 是空的，所有 FT_QT_* 自检行都收不到（Linux 走 stderr 没这问题）。
    // 这里强制写 stderr，自检脚本按行解析才有东西可读。
    qInstallMessageHandler([](QtMsgType, const QMessageLogContext &, const QString &message) {
        std::fprintf(stderr, "%s\n", message.toUtf8().constData());
        std::fflush(stderr);
    });
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

    // 批量解重叠自检：--resolve-selftest "brief"，与界面「批量解开未声明的重叠」同一条路径
    if (args.contains(QStringLiteral("--resolve-selftest"))) {
        const int briefIndex = args.indexOf(QStringLiteral("--resolve-selftest"));
        if (briefIndex + 1 >= args.size()) {
            qCritical().noquote() << "FT_QT_RESOLVE_FAIL 用法：--resolve-selftest \"brief\"";
            return 2;
        }
        MainWindow window;
        QJsonObject resolved;
        QString error;
        if (!window.designMachineFromBrief(args.at(briefIndex + 1), &resolved, &error, {}, true)) {
            qCritical().noquote() << "FT_QT_RESOLVE_FAIL" << error;
            return 1;
        }
        const QJsonObject resolution = resolved.value(QStringLiteral("geometry")).toObject()
                                           .value(QStringLiteral("resolution")).toObject();
        qInfo().noquote() << QStringLiteral("FT_QT_RESOLVE_OK before=%1 after=%2 moves=%3 converged=%4")
                                 .arg(resolution.value(QStringLiteral("before")).toInt())
                                 .arg(resolution.value(QStringLiteral("after")).toInt())
                                 .arg(resolution.value(QStringLiteral("moves")).toArray().size())
                                 .arg(resolution.value(QStringLiteral("converged")).toBool() ? 1 : 0);
        return 0;
    }

    // 按建议挪自检：--apply-hint-selftest "brief"，取第一对的 suggestion 应用后重算
    if (args.contains(QStringLiteral("--apply-hint-selftest"))) {
        const int briefIndex = args.indexOf(QStringLiteral("--apply-hint-selftest"));
        if (briefIndex + 1 >= args.size()) {
            qCritical().noquote() << "FT_QT_APPLY_HINT_FAIL 用法：--apply-hint-selftest \"brief\"";
            return 2;
        }
        MainWindow window;
        QJsonObject before;
        QString error;
        if (!window.designMachineFromBrief(args.at(briefIndex + 1), &before, &error)) {
            qCritical().noquote() << "FT_QT_APPLY_HINT_FAIL" << error;
            return 1;
        }
        const auto counts = [](const QJsonObject &document) {
            return document.value(QStringLiteral("geometry")).toObject()
                .value(QStringLiteral("interference")).toObject();
        };
        const QJsonObject beforeInterference = counts(before);
        const QJsonArray pairs = beforeInterference.value(QStringLiteral("pairs")).toArray();
        if (pairs.isEmpty()) {
            qInfo().noquote() << "FT_QT_APPLY_HINT_OK count=0 没有重叠对";
            return 0;
        }
        const QJsonObject suggestion = pairs.at(0).toObject().value(QStringLiteral("suggestion")).toObject();
        if (suggestion.isEmpty()) {
            qCritical().noquote() << "FT_QT_APPLY_HINT_FAIL 第一对没有 suggestion";
            return 1;
        }
        const QString axis = suggestion.value(QStringLiteral("axis")).toString();
        const double delta = suggestion.value(QStringLiteral("delta")).toDouble();
        const QStringList moves{QStringLiteral("%1:%2,%3,%4")
                                    .arg(suggestion.value(QStringLiteral("partId")).toString())
                                    .arg(axis == QStringLiteral("x") ? delta : 0.0)
                                    .arg(axis == QStringLiteral("y") ? delta : 0.0)
                                    .arg(axis == QStringLiteral("z") ? delta : 0.0)};
        QJsonObject after;
        if (!window.designMachineFromBrief(args.at(briefIndex + 1), &after, &error, moves)) {
            qCritical().noquote() << "FT_QT_APPLY_HINT_FAIL" << error;
            return 1;
        }
        const QJsonObject afterInterference = counts(after);
        qInfo().noquote() << QStringLiteral("FT_QT_APPLY_HINT_OK part=%1 axis=%2 delta=%3 before=%4 after=%5")
                                 .arg(suggestion.value(QStringLiteral("partId")).toString(), axis)
                                 .arg(delta, 0, 'f', 1)
                                 .arg(beforeInterference.value(QStringLiteral("count")).toInt())
                                 .arg(afterInterference.value(QStringLiteral("count")).toInt());
        return 0;
    }

    // 方向键微调自检：--nudge-selftest "brief" --part <id> --delta dx,dy,dz
    if (args.contains(QStringLiteral("--nudge-selftest"))) {
        const int briefIndex = args.indexOf(QStringLiteral("--nudge-selftest"));
        const int partIndex = args.indexOf(QStringLiteral("--part"));
        const int deltaIndex = args.indexOf(QStringLiteral("--delta"));
        if (briefIndex + 1 >= args.size() || partIndex < 0 || deltaIndex < 0) {
            qCritical().noquote() << "FT_QT_NUDGE_FAIL 用法：--nudge-selftest \"brief\" --part <id> --delta dx,dy,dz";
            return 2;
        }
        MainWindow window;
        QJsonObject document;
        QString error;
        if (!window.designMachineFromBrief(args.at(briefIndex + 1), &document, &error)) {
            qCritical().noquote() << "FT_QT_NUDGE_FAIL" << error;
            return 1;
        }
        const QStringList parts = args.at(deltaIndex + 1).split(QLatin1Char(','));
        if (parts.size() != 3) {
            qCritical().noquote() << "FT_QT_NUDGE_FAIL --delta 需要 dx,dy,dz";
            return 2;
        }
        window.selectPartForTest(args.at(partIndex + 1));
        window.nudgeSelectedPart(parts.at(0).toInt(), parts.at(1).toInt(), parts.at(2).toInt());
        return 0;
    }

    // 试摆位自检：--tune-selftest "brief" --move id:dx,dy,dz（可重复），打印挪之前/之后的重叠数
    if (args.contains(QStringLiteral("--tune-selftest"))) {
        const int briefIndex = args.indexOf(QStringLiteral("--tune-selftest"));
        if (briefIndex + 1 < args.size()) {
            const QString brief = args.at(briefIndex + 1);
            QStringList moves;
            for (int i = 0; i < args.size(); ++i) {
                if (args.at(i) == QStringLiteral("--move") && i + 1 < args.size()) moves << args.at(i + 1);
            }
            MainWindow window;
            QJsonObject before;
            QJsonObject after;
            QString error;
            if (!window.designMachineFromBrief(brief, &before, &error)) {
                qCritical().noquote() << "FT_QT_TUNE_FAIL" << error;
                return 1;
            }
            if (!window.designMachineFromBrief(brief, &after, &error, moves)) {
                qCritical().noquote() << "FT_QT_TUNE_FAIL" << error;
                return 1;
            }
            const auto counts = [](const QJsonObject &document) {
                const QJsonObject interference = document.value(QStringLiteral("geometry")).toObject()
                                                     .value(QStringLiteral("interference")).toObject();
                return QStringLiteral("count=%1 suspects=%2 declared=%3")
                    .arg(interference.value(QStringLiteral("count")).toInt())
                    .arg(interference.value(QStringLiteral("suspects")).toInt())
                    .arg(interference.value(QStringLiteral("declared")).toInt());
            };
            qInfo().noquote() << "FT_QT_TUNE_OK before" << counts(before) << "| after" << counts(after);
            return 0;
        }
    }

    // 整机示意 3D 自检：--geometry-selftest "一句话"（要 node + OCCT 视口）
    if (args.contains(QStringLiteral("--geometry-selftest")) && args.indexOf(QStringLiteral("--geometry-selftest")) + 1 < args.size()) {
        const int geoIndex = args.indexOf(QStringLiteral("--geometry-selftest"));
        {
            MainWindow window;
            window.show();
            QJsonObject document;
            QString error;
            if (!window.designMachineFromBrief(args.at(geoIndex + 1), &document, &error)) {
                qCritical().noquote() << "FT_QT_GEOMETRY_FAIL" << error;
                return 1;
            }
            int shapes = 0;
            if (!window.renderMachineGeometry(document, &shapes, &error)) {
                qCritical().noquote() << "FT_QT_GEOMETRY_FAIL" << error;
                return 1;
            }
            const QJsonObject geometry = document.value(QStringLiteral("geometry")).toObject();
            const QJsonArray envelope = geometry.value(QStringLiteral("envelope")).toArray();
            const int outIndex = args.indexOf(QStringLiteral("--out"));
            if (outIndex >= 0 && outIndex + 1 < args.size()) {
                int bytes = 0;
                if (!window.exportMachineStlForTest(args.at(outIndex + 1), &bytes, &error)) {
                    qCritical().noquote() << "FT_QT_GEOMETRY_FAIL" << error;
                    return 1;
                }
                qInfo().noquote() << QStringLiteral("FT_QT_MACHINE_STL_OK path=%1 bytes=%2")
                                         .arg(args.at(outIndex + 1)).arg(bytes);
            }
            qInfo().noquote() << QStringLiteral("FT_QT_GEOMETRY_OK shapes=%1 parts=%2 envelope=%3x%4x%5 fidelity=%6")
                                     .arg(shapes)
                                     .arg(geometry.value(QStringLiteral("parts")).toArray().size())
                                     .arg(envelope.at(0).toDouble(), 0, 'f', 0)
                                     .arg(envelope.at(1).toDouble(), 0, 'f', 0)
                                     .arg(envelope.at(2).toDouble(), 0, 'f', 0)
                                     .arg(geometry.value(QStringLiteral("geometryFidelity")).toString());
            return 0;
        }
    }

    // 整机示意 3D 窗口：--geometry-ui "一句话"（停在窗口上，供截图/人肉核对）
    if (args.contains(QStringLiteral("--geometry-ui"))) {
        const int geoIndex = args.indexOf(QStringLiteral("--geometry-ui"));
        if (geoIndex + 1 < args.size()) {
            MainWindow window;
            window.resize(1400, 900);
            window.show();
            QJsonObject document;
            QString error;
            if (!window.designMachineFromBrief(args.at(geoIndex + 1), &document, &error)) {
                qCritical().noquote() << "FT_QT_GEOMETRY_FAIL" << error;
                return 1;
            }
            // 等窗口真正显示（拿到窗口尺寸）再渲染，否则 FitAll 在 0 尺寸上算比例，画面会是空的
            QTimer::singleShot(1500, &window, [&window, document]() {
                int shapes = 0;
                QString renderError;
                if (!window.renderMachineGeometry(document, &shapes, &renderError)) {
                    qCritical().noquote() << "FT_QT_GEOMETRY_FAIL" << renderError;
                    return;
                }
                qInfo().noquote() << "FT_QT_GEOMETRY_UI_OPEN shapes=" << shapes;
            });
            return app.exec();
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
            MachineCaseDialog dialog(document, nullptr, [](const QStringList &ids) {
                qInfo().noquote() << "FT_QT_PAIR_HIGHLIGHT" << ids.join(QStringLiteral(","));
            });
            dialog.exec();
            return 0;
        }
    }

    // 排布合规自检：--layout-selftest "brief"
    if (args.contains(QStringLiteral("--layout-selftest"))) {
        const int index = args.indexOf(QStringLiteral("--layout-selftest"));
        if (index + 1 >= args.size()) {
            qCritical().noquote() << "FT_QT_LAYOUT_FAIL 用法：--layout-selftest \"brief\"";
            return 2;
        }
        // 可选第二个参数是间距阈值（mm），默认 20
        int layoutThreshold = 20;
        if (index + 2 < args.size() && !args.at(index + 2).startsWith(QStringLiteral("--"))) {
            layoutThreshold = args.at(index + 2).toInt();
        }
        MainWindow window;
        QJsonObject compliant;
        QString error;
        if (!window.designMachineFromBrief(args.at(index + 1), &compliant, &error, {}, false, 0, true, layoutThreshold)) {
            qCritical().noquote() << "FT_QT_LAYOUT_FAIL" << error;
            return 1;
        }
        const QJsonObject layout = compliant.value(QStringLiteral("geometry")).toObject()
                                       .value(QStringLiteral("layoutCompliance")).toObject();
        qInfo().noquote() << QStringLiteral("FT_QT_LAYOUT_OK threshold=%1 rounds=%2 moves=%3 suspects=%4 clearance=%5 converged=%6")
                                 .arg(layout.value(QStringLiteral("clearanceMm")).toInt())
                                 .arg(layout.value(QStringLiteral("rounds")).toArray().size())
                                 .arg(layout.value(QStringLiteral("moves")).toArray().size())
                                 .arg(layout.value(QStringLiteral("suspects")).toInt())
                                 .arg(layout.value(QStringLiteral("clearance")).toInt())
                                 .arg(layout.value(QStringLiteral("converged")).toBool() ? 1 : 0);
        return 0;
    }

    // 推开间距自检：--push-selftest "brief"
    if (args.contains(QStringLiteral("--push-selftest"))) {
        const int index = args.indexOf(QStringLiteral("--push-selftest"));
        if (index + 1 >= args.size()) {
            qCritical().noquote() << "FT_QT_PUSH_FAIL 用法：--push-selftest \"brief\"";
            return 2;
        }
        MainWindow window;
        QJsonObject pushed;
        QString error;
        if (!window.designMachineFromBrief(args.at(index + 1), &pushed, &error, {}, false, 20)) {
            qCritical().noquote() << "FT_QT_PUSH_FAIL" << error;
            return 1;
        }
        const QJsonObject push = pushed.value(QStringLiteral("geometry")).toObject()
                                     .value(QStringLiteral("clearanceResolution")).toObject();
        qInfo().noquote() << QStringLiteral("FT_QT_PUSH_OK before=%1 after=%2 moves=%3 converged=%4")
                                 .arg(push.value(QStringLiteral("before")).toInt())
                                 .arg(push.value(QStringLiteral("after")).toInt())
                                 .arg(push.value(QStringLiteral("moves")).toArray().size())
                                 .arg(push.value(QStringLiteral("converged")).toBool() ? 1 : 0);
        return 0;
    }

    // 方案存取往返自检：--case-save-selftest <case.json>（存→读→比对关键字段）
    {
        const int index = args.indexOf(QStringLiteral("--case-save-selftest"));
        if (index >= 0 && index + 1 < args.size()) {
            QJsonObject original;
            QString error;
            if (!MachineCaseDialog::loadFile(args.at(index + 1), &original, &error)) {
                qCritical().noquote() << "FT_QT_CASE_RT_FAIL" << error;
                return 1;
            }
            const QString outPath = QDir::tempPath() + QStringLiteral("/automationcad-roundtrip.json");
            int bytes = 0;
            if (!MachineCaseDialog::saveFile(original, outPath, &bytes, &error)) {
                qCritical().noquote() << "FT_QT_CASE_RT_FAIL" << error;
                return 1;
            }
            QJsonObject reloaded;
            if (!MachineCaseDialog::loadFile(outPath, &reloaded, &error)) {
                qCritical().noquote() << "FT_QT_CASE_RT_FAIL 回读失败：" << error;
                return 1;
            }
            const auto partsOf = [](const QJsonObject &document) {
                return document.value(QStringLiteral("geometry")).toObject()
                    .value(QStringLiteral("parts")).toArray().size();
            };
            const QJsonObject originalStamp = original.value(QStringLiteral("compliance")).toObject();
            const QJsonObject reloadedStamp = reloaded.value(QStringLiteral("compliance")).toObject();
            if (partsOf(original) != partsOf(reloaded)
                || original.value(QStringLiteral("brief")).toString() != reloaded.value(QStringLiteral("brief")).toString()
                || originalStamp.value(QStringLiteral("clearanceMm")).toInt() != reloadedStamp.value(QStringLiteral("clearanceMm")).toInt()
                || originalStamp.value(QStringLiteral("moves")).toInt() != reloadedStamp.value(QStringLiteral("moves")).toInt()) {
                qCritical().noquote() << "FT_QT_CASE_RT_FAIL 往返后字段不一致";
                return 1;
            }
            QFile cleanup(outPath);
            cleanup.remove();
            qInfo().noquote() << QStringLiteral("FT_QT_CASE_RT_OK bytes=%1 parts=%2 stampMm=%3 moves=%4")
                                     .arg(bytes).arg(partsOf(reloaded))
                                     .arg(reloadedStamp.value(QStringLiteral("clearanceMm")).toInt())
                                     .arg(reloadedStamp.value(QStringLiteral("moves")).toInt());
            return 0;
        }
    }

    // 整站挪自检：--station-move-selftest "brief"（按前缀成组 + 整组平移 + 别的不动）
    if (args.contains(QStringLiteral("--station-move-selftest"))) {
        const int index = args.indexOf(QStringLiteral("--station-move-selftest"));
        if (index + 1 >= args.size()) {
            qCritical().noquote() << "FT_QT_STATION_FAIL 用法：--station-move-selftest \"brief\"";
            return 2;
        }
        MainWindow window;
        QJsonObject before;
        QString error;
        if (!window.designMachineFromBrief(args.at(index + 1), &before, &error)) {
            qCritical().noquote() << "FT_QT_STATION_FAIL" << error;
            return 1;
        }
        const QStringList members = MainWindow::partsOfScope(before, QStringLiteral("st2"));
        if (members.size() < 2) {
            qCritical().noquote() << "FT_QT_STATION_FAIL st2 只有" << members.size() << "个零件";
            return 1;
        }
        QStringList moves;
        for (const QString &id : members) moves << QStringLiteral("%1:10,0,0").arg(id);
        QJsonObject after;
        if (!window.designMachineFromBrief(args.at(index + 1), &after, &error, moves)) {
            qCritical().noquote() << "FT_QT_STATION_FAIL" << error;
            return 1;
        }
        // 组内每一件都要 +10，组外一件都不能动
        const auto centers = [](const QJsonObject &document) {
            QHash<QString, QJsonArray> map;
            for (const QJsonValue &value : document.value(QStringLiteral("geometry")).toObject()
                                                .value(QStringLiteral("parts")).toArray()) {
                const QJsonObject part = value.toObject();
                map.insert(part.value(QStringLiteral("id")).toString(),
                           part.value(QStringLiteral("center")).toArray());
            }
            return map;
        };
        const QHash<QString, QJsonArray> beforeCenters = centers(before);
        const QHash<QString, QJsonArray> afterCenters = centers(after);
        int moved = 0;
        for (auto it = beforeCenters.constBegin(); it != beforeCenters.constEnd(); ++it) {
            const bool inScope = members.contains(it.key());
            const QJsonArray oldCenter = it.value();
            const QJsonArray newCenter = afterCenters.value(it.key());
            const double dx = newCenter.at(0).toDouble() - oldCenter.at(0).toDouble();
            const double dy = newCenter.at(1).toDouble() - oldCenter.at(1).toDouble();
            const double dz = newCenter.at(2).toDouble() - oldCenter.at(2).toDouble();
            if (inScope) {
                if (qAbs(dx - 10.0) > 1e-6 || qAbs(dy) > 1e-6 || qAbs(dz) > 1e-6) {
                    qCritical().noquote() << "FT_QT_STATION_FAIL" << it.key() << "位移不对：" << dx << dy << dz;
                    return 1;
                }
                moved += 1;
            } else if (qAbs(dx) > 1e-6 || qAbs(dy) > 1e-6 || qAbs(dz) > 1e-6) {
                qCritical().noquote() << "FT_QT_STATION_FAIL 组外零件" << it.key() << "被挪了：" << dx;
                return 1;
            }
        }
        qInfo().noquote() << QStringLiteral("FT_QT_STATION_OK scope=st2 members=%1 moved=%2 others=unchanged")
                                 .arg(members.size()).arg(moved);
        return 0;
    }

    // 统一冒烟入口：--qt-smoke <fixture.json>（把下面几条串起来，省得手敲一长串环境变量）
    {
        const int index = args.indexOf(QStringLiteral("--qt-smoke"));
        if (index >= 0 && index + 1 < args.size()) {
            QJsonObject document;
            QString error;
            if (!MachineCaseDialog::loadFile(args.at(index + 1), &document, &error)) {
                qCritical().noquote() << "QT_SMOKE_FAIL" << error;
                return 1;
            }
            int checks = 0;

            // 1) 概览页能读到合规戳（不是只有 JSON 里有）
            MachineCaseDialog dialog(document, nullptr, {}, {}, {}, {}, {}, {}, 20);
            QString stampText;
            for (QTableWidget *table : dialog.findChildren<QTableWidget *>()) {
                for (int row = 0; row < table->rowCount(); ++row) {
                    if (table->item(row, 0) && table->item(row, 0)->text() == QStringLiteral("排布合规")) {
                        stampText = table->item(row, 1) ? table->item(row, 1)->text() : QString();
                    }
                }
            }
            if (stampText.isEmpty()) {
                qCritical().noquote() << "QT_SMOKE_FAIL 概览页缺少排布合规行";
                return 1;
            }
            qInfo().noquote() << "QT_SMOKE_STAMP" << stampText;
            checks += 1;

            // 2) 排布位移 CSV 能导出且行数与 JSON 一致
            const QString csvPath = QDir::tempPath() + QStringLiteral("/automationcad-smoke-layout.csv");
            int csvRows = 0;
            if (!MachineCaseDialog::writeLayoutCsv(document, csvPath, &csvRows, &error)) {
                qCritical().noquote() << "QT_SMOKE_FAIL" << error;
                return 1;
            }
            const QJsonObject layoutInfo = document.value(QStringLiteral("geometry")).toObject()
                                               .value(QStringLiteral("layoutCompliance")).toObject();
            if (csvRows != layoutInfo.value(QStringLiteral("moves")).toArray().size()) {
                qCritical().noquote() << "QT_SMOKE_FAIL CSV 行数" << csvRows << "与 JSON 位移数"
                                      << layoutInfo.value(QStringLiteral("moves")).toArray().size() << "不一致";
                return 1;
            }
            qInfo().noquote() << "QT_SMOKE_CSV rows=" << csvRows;
            checks += 1;

            // 3) 同一条 brief 重跑管线：排布合规必须仍收敛（防算法漂移把 fixture 变成假绿）
            const QString brief = document.value(QStringLiteral("brief")).toString();
            // 重放需要 node + 管线，CI 里没装 node，所以默认只验「读文件 + 导出」；本地加 --replay
            if (!brief.isEmpty() && args.contains(QStringLiteral("--replay"))) {
                MainWindow window;
                QJsonObject replayed;
                if (!window.designMachineFromBrief(brief, &replayed, &error, {}, false, 0, true, 20)) {
                    qCritical().noquote() << "QT_SMOKE_FAIL 重跑管线：" << error;
                    return 1;
                }
                const QJsonObject replayedLayout = replayed.value(QStringLiteral("geometry")).toObject()
                                                       .value(QStringLiteral("layoutCompliance")).toObject();
                if (!replayedLayout.value(QStringLiteral("converged")).toBool()) {
                    qCritical().noquote() << "QT_SMOKE_FAIL 重跑后排布不收敛";
                    return 1;
                }
                qInfo().noquote() << "QT_SMOKE_REPLAY rounds="
                                  << replayedLayout.value(QStringLiteral("rounds")).toArray().size()
                                  << "moves=" << replayedLayout.value(QStringLiteral("moves")).toArray().size();
                checks += 1;
            }

            qInfo().noquote() << "QT_SMOKE_OK checks=" << checks;
            return 0;
        }
    }

    // 最大可行间距自检：--max-clearance-selftest "brief"
    if (args.contains(QStringLiteral("--max-clearance-selftest"))) {
        const int index = args.indexOf(QStringLiteral("--max-clearance-selftest"));
        if (index + 1 >= args.size()) {
            qCritical().noquote() << "FT_QT_MAXCLEARANCE_FAIL 用法：--max-clearance-selftest \"brief\"";
            return 2;
        }
        MainWindow window;
        QJsonObject measured;
        QString error;
        if (!window.designMachineFromBrief(args.at(index + 1), &measured, &error, {}, false, 0, false,
                                           window.currentClearanceMm(), true)) {
            qCritical().noquote() << "FT_QT_MAXCLEARANCE_FAIL" << error;
            return 1;
        }
        const QJsonObject maxClearance = measured.value(QStringLiteral("geometry")).toObject()
                                             .value(QStringLiteral("maxClearance")).toObject();
        const int feasible = maxClearance.value(QStringLiteral("feasibleMm")).toInt();
        const QJsonArray probes = maxClearance.value(QStringLiteral("probes")).toArray();
        if (feasible <= 0 || probes.isEmpty()) {
            qCritical().noquote() << "FT_QT_MAXCLEARANCE_FAIL feasible=" << feasible << "probes=" << probes.size();
            return 1;
        }
        // 可行性必须自洽：可行的那个阈值下，排布合规必须真的收敛
        QJsonObject recheck;
        if (!window.designMachineFromBrief(args.at(index + 1), &recheck, &error, {}, false, 0, true, feasible)) {
            qCritical().noquote() << "FT_QT_MAXCLEARANCE_FAIL" << error;
            return 1;
        }
        const QJsonObject layout = recheck.value(QStringLiteral("geometry")).toObject()
                                       .value(QStringLiteral("layoutCompliance")).toObject();
        if (!layout.value(QStringLiteral("converged")).toBool()) {
            qCritical().noquote() << "FT_QT_MAXCLEARANCE_FAIL 声称" << feasible << "mm 可行但复算不收敛";
            return 1;
        }
        qInfo().noquote() << QStringLiteral("FT_QT_MAXCLEARANCE_OK feasible=%1 probes=%2 recheck=%3")
                                 .arg(feasible).arg(probes.size())
                                 .arg(layout.value(QStringLiteral("moves")).toArray().size());
        return 0;
    }

    // 合规戳自检：--compliance-stamp-selftest <case.json> [界面阈值]
    {
        const int index = args.indexOf(QStringLiteral("--compliance-stamp-selftest"));
        if (index >= 0 && index + 1 < args.size()) {
            int uiThreshold = 20;
            if (index + 2 < args.size() && !args.at(index + 2).startsWith(QStringLiteral("--"))) {
                uiThreshold = args.at(index + 2).toInt();
            }
            QJsonObject document;
            QString error;
            if (!MachineCaseDialog::loadFile(args.at(index + 1), &document, &error)) {
                qCritical().noquote() << "FT_QT_STAMP_FAIL" << error;
                return 1;
            }
            const QJsonObject stamp = document.value(QStringLiteral("compliance")).toObject();
            if (stamp.isEmpty()) {
                qCritical().noquote() << "FT_QT_STAMP_FAIL" << "文档没有 compliance 戳（管线需 --layout-compliance）";
                return 1;
            }
            // 概览页必须真的把这一行显示出来，而不是只有 JSON 里有
            MachineCaseDialog dialog(document, nullptr, {}, {}, {}, {}, {}, {}, uiThreshold);
            QString shown;
            for (QTableWidget *table : dialog.findChildren<QTableWidget *>()) {
                for (int row = 0; row < table->rowCount(); ++row) {
                    if (table->item(row, 0) && table->item(row, 0)->text() == QStringLiteral("排布合规")) {
                        shown = table->item(row, 1) ? table->item(row, 1)->text() : QString();
                    }
                }
            }
            if (shown.isEmpty()) {
                qCritical().noquote() << "FT_QT_STAMP_FAIL" << "概览页没有「排布合规」这一行";
                return 1;
            }
            qInfo().noquote() << QStringLiteral("FT_QT_STAMP_OK mm=%1 converged=%2 rounds=%3 moves=%4 shown=%5")
                                     .arg(stamp.value(QStringLiteral("clearanceMm")).toInt())
                                     .arg(stamp.value(QStringLiteral("converged")).toBool() ? 1 : 0)
                                     .arg(stamp.value(QStringLiteral("rounds")).toInt())
                                     .arg(stamp.value(QStringLiteral("moves")).toInt())
                                     .arg(shown);
            return 0;
        }
    }

    // 排布位移导出自检：--layout-csv-selftest <case.json> --out <csv>
    {
        const int index = args.indexOf(QStringLiteral("--layout-csv-selftest"));
        if (index >= 0 && index + 1 < args.size()) {
            const int outIndex = args.indexOf(QStringLiteral("--out"));
            if (outIndex < 0 || outIndex + 1 >= args.size()) {
                qCritical().noquote() << "FT_QT_LAYOUTCSV_FAIL" << "缺 --out <csv>";
                return 1;
            }
            QJsonObject document;
            QString error;
            if (!MachineCaseDialog::loadFile(args.at(index + 1), &document, &error)) {
                qCritical().noquote() << "FT_QT_LAYOUTCSV_FAIL" << error;
                return 1;
            }
            int rows = 0;
            if (!MachineCaseDialog::writeLayoutCsv(document, args.at(outIndex + 1), &rows, &error)) {
                qCritical().noquote() << "FT_QT_LAYOUTCSV_FAIL" << error;
                return 1;
            }
            qInfo().noquote() << QStringLiteral("FT_QT_LAYOUTCSV_OK rows=%1").arg(rows);
            return 0;
        }
    }

    // 间距阈值可改自检：--threshold-selftest "brief"（20 与 40 两档，次数必须不同）
    if (args.contains(QStringLiteral("--threshold-selftest"))) {
        const int index = args.indexOf(QStringLiteral("--threshold-selftest"));
        if (index + 1 >= args.size()) {
            qCritical().noquote() << "FT_QT_THRESHOLD_FAIL 用法：--threshold-selftest \"brief\"";
            return 2;
        }
        MainWindow window;
        QJsonObject tight;
        QJsonObject loose;
        QString error;
        if (!window.designMachineFromBrief(args.at(index + 1), &tight, &error, {}, false, 0, false, 20)) {
            qCritical().noquote() << "FT_QT_THRESHOLD_FAIL" << error;
            return 1;
        }
        if (!window.designMachineFromBrief(args.at(index + 1), &loose, &error, {}, false, 0, false, 40)) {
            qCritical().noquote() << "FT_QT_THRESHOLD_FAIL" << error;
            return 1;
        }
        const auto countOf = [](const QJsonObject &document) {
            return document.value(QStringLiteral("geometry")).toObject()
                .value(QStringLiteral("clearance")).toObject()
                .value(QStringLiteral("count")).toInt();
        };
        const int tightCount = countOf(tight);
        const int looseCount = countOf(loose);
        if (!(looseCount > tightCount)) {
            qCritical().noquote() << "FT_QT_THRESHOLD_FAIL 阈值放大到 40 后间距问题反而没变多"
                                  << tightCount << looseCount;
            return 1;
        }
        // 界面侧真有一行「阈值 + 按此阈值重算」：只靠状态栏日志证不出来，直接数控件
        MachineCaseDialog dialog(tight, nullptr, {}, {}, {}, {}, {}, [](int) {});
        const int spinCount = dialog.findChildren<QSpinBox *>().size();
        int thresholdButtons = 0;
        for (QAbstractButton *button : dialog.findChildren<QAbstractButton *>()) {
            if (button->text().startsWith(QStringLiteral("按此阈值重算"))) thresholdButtons += 1;
        }
        if (spinCount < 1 || thresholdButtons < 1) {
            qCritical().noquote() << "FT_QT_THRESHOLD_UI_FAIL spins=" << spinCount
                                  << "buttons=" << thresholdButtons;
            return 1;
        }
        qInfo().noquote() << QStringLiteral("FT_QT_THRESHOLD_OK at20=%1 at40=%2 spins=%3 buttons=%4")
                                 .arg(tightCount).arg(looseCount).arg(spinCount).arg(thresholdButtons);
        return 0;
    }

    // 间距初筛自检：--clearance-selftest <case.json>
    {
        const int index = args.indexOf(QStringLiteral("--clearance-selftest"));
        if (index >= 0 && index + 1 < args.size()) {
            QJsonObject document;
            QString error;
            if (!MachineCaseDialog::loadFile(args.at(index + 1), &document, &error)) {
                qCritical().noquote() << "FT_QT_CLEARANCE_FAIL" << error;
                return 1;
            }
            const QJsonObject clearance = document.value(QStringLiteral("geometry")).toObject()
                                              .value(QStringLiteral("clearance")).toObject();
            if (clearance.isEmpty()) {
                qCritical().noquote() << "FT_QT_CLEARANCE_FAIL" << "文档没有 clearance（管线需 --clearance 20）";
                return 1;
            }
            const QJsonArray pairs = clearance.value(QStringLiteral("pairs")).toArray();
            const double tightest = pairs.isEmpty() ? 0.0
                                                    : pairs.at(0).toObject().value(QStringLiteral("gapMm")).toDouble();
            qInfo().noquote() << QStringLiteral("FT_QT_CLEARANCE_OK threshold=%1 count=%2 tightest=%3")
                                     .arg(clearance.value(QStringLiteral("thresholdMm")).toInt())
                                     .arg(clearance.value(QStringLiteral("count")).toInt())
                                     .arg(tightest, 0, 'f', 1);
            return 0;
        }
    }

    // 调整清单导出自检：--resolve-csv-selftest <case.json> --out <csv>
    {
        const int index = args.indexOf(QStringLiteral("--resolve-csv-selftest"));
        if (index >= 0 && index + 1 < args.size()) {
            const int outIndex = args.indexOf(QStringLiteral("--out"));
            if (outIndex < 0 || outIndex + 1 >= args.size()) {
                qCritical().noquote() << "FT_QT_RESOLVECSV_FAIL" << "缺 --out <csv>";
                return 1;
            }
            QJsonObject document;
            QString error;
            if (!MachineCaseDialog::loadFile(args.at(index + 1), &document, &error)) {
                qCritical().noquote() << "FT_QT_RESOLVECSV_FAIL" << error;
                return 1;
            }
            int rows = 0;
            if (!MachineCaseDialog::writeResolutionCsv(document, args.at(outIndex + 1), &rows, &error)) {
                qCritical().noquote() << "FT_QT_RESOLVECSV_FAIL" << error;
                return 1;
            }
            qInfo().noquote() << QStringLiteral("FT_QT_RESOLVECSV_OK rows=%1").arg(rows);
            return 0;
        }
    }

    // 整机 BOM 导出自检：--machine-bom-selftest <case.json> --out <csv>
    {
        const int bomIndex = args.indexOf(QStringLiteral("--machine-bom-selftest"));
        if (bomIndex >= 0 && bomIndex + 1 < args.size()) {
            const int outIndex = args.indexOf(QStringLiteral("--out"));
            if (outIndex < 0 || outIndex + 1 >= args.size()) {
                qCritical().noquote() << "FT_QT_MACHINEBOM_FAIL" << "缺 --out <csv>";
                return 1;
            }
            QJsonObject document;
            QString error;
            if (!MachineCaseDialog::loadFile(args.at(bomIndex + 1), &document, &error)) {
                qCritical().noquote() << "FT_QT_MACHINEBOM_FAIL" << error;
                return 1;
            }
            int rows = 0;
            if (!MachineCaseDialog::writeBomCsv(document, args.at(outIndex + 1), &rows, &error)) {
                qCritical().noquote() << "FT_QT_MACHINEBOM_FAIL" << error;
                return 1;
            }
            qInfo().noquote() << QStringLiteral("FT_QT_MACHINEBOM_OK rows=%1 path=%2").arg(rows).arg(args.at(outIndex + 1));
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
            MachineCaseDialog dialog(document, nullptr, [](const QStringList &ids) {
                qInfo().noquote() << "FT_QT_PAIR_HIGHLIGHT" << ids.join(QStringLiteral(","));
            });
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
            // 跨平台临时目录：/tmp 在 Windows 不存在，自检会写不出去
            ? args.at(outIndex + 1) : QDir(QDir::tempPath()).filePath(QStringLiteral("export-selftest.stl"));
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
