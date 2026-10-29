// AutomationCAD Qt 客户端入口 v0.1（壳子）。
// 启动前需先启动 FeatureTree 契约服务（featuretree-service/server.mjs，默认 127.0.0.1:18080），
// 否则主窗口状态栏会显示“服务未连接”，这是预期行为，不是崩溃。
#include "MainWindow.h"
#include "MachineCaseDialog.h"
#include <QApplication>
#include <QSurfaceFormat>
#include <QDebug>
#include <QJsonArray>
#include <QJsonObject>
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
