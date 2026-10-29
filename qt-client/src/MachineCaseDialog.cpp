#include "MachineCaseDialog.h"

#include <QDialogButtonBox>
#include <QFile>
#include <QFileDialog>
#include <QPushButton>
#include <QMessageBox>
#include <QTextStream>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonParseError>
#include <QLabel>
#include <QTableWidget>
#include <QHeaderView>
#include <QTabWidget>
#include <QWidget>
#include <QMessageBox>
#include <QHBoxLayout>
#include <QSpinBox>
#include <QVBoxLayout>

namespace {

QString number(double value, int decimals) {
    return QString::number(value, 'f', decimals);
}

double valueAt(const QJsonObject &object, const QString &key) {
    return object.value(key).toDouble(0.0);
}

QTableWidget *makeTable(const QStringList &headers, QWidget *parent) {
    auto *table = new QTableWidget(0, headers.size(), parent);
    table->setHorizontalHeaderLabels(headers);
    table->verticalHeader()->setVisible(false);
    table->setEditTriggers(QAbstractItemView::NoEditTriggers);
    table->horizontalHeader()->setStretchLastSection(true);
    return table;
}

void appendRow(QTableWidget *table, const QStringList &cells) {
    const int row = table->rowCount();
    table->insertRow(row);
    for (int column = 0; column < cells.size(); ++column) {
        table->setItem(row, column, new QTableWidgetItem(cells.at(column)));
    }
}

}  // namespace

bool MachineCaseDialog::loadFile(const QString &path, QJsonObject *document, QString *error) {
    QFile file(path);
    if (!file.open(QIODevice::ReadOnly)) {
        *error = QStringLiteral("打不开文件：%1（%2）").arg(path, file.errorString());
        return false;
    }
    QJsonParseError parseError{};
    const QJsonDocument parsed = QJsonDocument::fromJson(file.readAll(), &parseError);
    file.close();
    if (parseError.error != QJsonParseError::NoError) {
        *error = QStringLiteral("JSON 解析失败：%1（偏移 %2）").arg(parseError.errorString()).arg(parseError.offset);
        return false;
    }
    if (!parsed.isObject()) {
        *error = QStringLiteral("不是整机方案文件（顶层应为对象）");
        return false;
    }
    const QJsonObject object = parsed.object();
    if (object.value(QStringLiteral("kind")).toString() != QStringLiteral("machine-case")) {
        *error = QStringLiteral("不是整机方案文件（kind=%1，期望 machine-case）")
                     .arg(object.value(QStringLiteral("kind")).toString());
        return false;
    }
    const int schema = object.value(QStringLiteral("schemaVersion")).toInt(0);
    if (schema != 1) {
        *error = QStringLiteral("不支持的方案版本 schemaVersion=%1（本客户端只认 1）").arg(schema);
        return false;
    }
    *document = object;
    return true;
}

QString MachineCaseDialog::summarize(const QJsonObject &document) {
    const QJsonObject cycle = document.value(QStringLiteral("cycleAnalysis")).toObject();
    const QJsonObject cost = document.value(QStringLiteral("cost")).toObject();
    const QJsonObject electrical = document.value(QStringLiteral("electrical")).toObject();
    const QJsonArray stations = document.value(QStringLiteral("stations")).toArray();
    const QJsonObject bom = document.value(QStringLiteral("bom")).toObject();
    return QStringLiteral("stations=%1 bom=%2 io=%3 kw=%4 throughput=%5 meets=%6 total=%7 missing=%8")
        .arg(stations.size())
        .arg(bom.value(QStringLiteral("items")).toArray().size())
        .arg(document.value(QStringLiteral("ioMap")).toObject().value(QStringLiteral("rowCount")).toInt())
        .arg(number(valueAt(electrical, QStringLiteral("totalDesignW")) / 1000.0, 3))
        .arg(number(valueAt(cycle, QStringLiteral("throughputPerMin")), 2))
        .arg(cycle.value(QStringLiteral("meetsTarget")).toBool() ? 1 : 0)
        .arg(number(valueAt(cost, QStringLiteral("total")), 2))
        .arg(cost.value(QStringLiteral("missingCount")).toInt());
}

bool MachineCaseDialog::writeBomCsv(const QJsonObject &document, const QString &path, int *rows, QString *error) {
    const QJsonArray items = document.value(QStringLiteral("bom")).toObject().value(QStringLiteral("items")).toArray();
    if (items.isEmpty()) {
        *error = QStringLiteral("方案里没有 BOM 行（bom.items 为空）");
        return false;
    }
    QFile file(path);
    if (!file.open(QIODevice::WriteOnly | QIODevice::Text)) {
        *error = QStringLiteral("写文件失败：%1").arg(file.errorString());
        return false;
    }
    QTextStream out(&file);
    out.setEncoding(QStringConverter::Utf8);
    out << "\xEF\xBB\xBF";  // Excel 打开中文不乱码
    out << "类别,名称,型号,数量,来源\n";
    int written = 0;
    for (const QJsonValue &value : items) {
        const QJsonObject item = value.toObject();
        const QString note = item.value(QStringLiteral("note")).toString();
        // CSV 里引号要转义，来源文案里有逗号
        const QString escaped = QStringLiteral("\"%1\"").arg(QString(note).replace(QLatin1Char('"'), QStringLiteral("\"\"")));
        out << item.value(QStringLiteral("kind")).toString() << ','
            << item.value(QStringLiteral("name")).toString() << ','
            << item.value(QStringLiteral("model")).toString() << ','
            << item.value(QStringLiteral("qty")).toInt(1) << ','
            << escaped << '\n';
        ++written;
    }
    const QJsonObject cost = document.value(QStringLiteral("cost")).toObject();
    // 金额固定两位小数：默认流输出会把 34489.91 印成 34489.9
    out << "合计,,,," << QString::number(cost.value(QStringLiteral("total")).toDouble(0.0), 'f', 2) << '\n';
    file.close();
    *rows = written;
    return true;
}

bool MachineCaseDialog::writeResolutionCsv(const QJsonObject &document, const QString &path, int *rows, QString *error) {
    const QJsonObject resolution = document.value(QStringLiteral("geometry")).toObject()
                                       .value(QStringLiteral("resolution")).toObject();
    if (resolution.isEmpty()) {
        *error = QStringLiteral("这个方案没有批量解重叠的结果（管线需 --resolve）");
        return false;
    }
    const QJsonArray moves = resolution.value(QStringLiteral("moves")).toArray();
    QFile file(path);
    if (!file.open(QIODevice::WriteOnly | QIODevice::Text)) {
        *error = QStringLiteral("写文件失败：%1").arg(file.errorString());
        return false;
    }
    QTextStream out(&file);
    out.setEncoding(QStringConverter::Utf8);
    out << "\xEF\xBB\xBF";
    out << "零件,轴,位移(mm),原中心X,原中心Y,原中心Z,新中心X,新中心Y,新中心Z,解后剩余\n";
    for (const QJsonValue &value : moves) {
        const QJsonObject move = value.toObject();
        const QJsonArray from = move.value(QStringLiteral("from")).toArray();
        const QJsonArray to = move.value(QStringLiteral("to")).toArray();
        out << move.value(QStringLiteral("partId")).toString() << ','
            << move.value(QStringLiteral("axis")).toString() << ','
            << QString::number(move.value(QStringLiteral("delta")).toDouble(), 'f', 1);
        for (int axis = 0; axis < 3; ++axis) {
            out << ',' << QString::number(from.at(axis).toDouble(), 'f', 1);
        }
        for (int axis = 0; axis < 3; ++axis) {
            out << ',' << QString::number(to.at(axis).toDouble(), 'f', 1);
        }
        out << ',' << move.value(QStringLiteral("remainingAfter")).toInt() << '\n';
    }
    out << "合计,,,,,,,,,"
        << resolution.value(QStringLiteral("before")).toInt() << "→"
        << resolution.value(QStringLiteral("after")).toInt() << '\n';
    file.close();
    *rows = moves.size();
    return true;
}

bool MachineCaseDialog::writeLayoutCsv(const QJsonObject &document, const QString &path, int *rows, QString *error) {
    const QJsonObject layout = document.value(QStringLiteral("geometry")).toObject()
                                   .value(QStringLiteral("layoutCompliance")).toObject();
    if (layout.isEmpty()) {
        *error = QStringLiteral("这个方案没有排布合规结果（管线需 --layout-compliance 20）");
        return false;
    }
    const QJsonArray moves = layout.value(QStringLiteral("moves")).toArray();
    QFile file(path);
    if (!file.open(QIODevice::WriteOnly | QIODevice::Text)) {
        *error = QStringLiteral("写文件失败：%1").arg(file.errorString());
        return false;
    }
    QTextStream out(&file);
    out.setEncoding(QStringConverter::Utf8);
    out << "\xEF\xBB\xBF";
    out << "类型,零件,轴,位移(mm),原中心X,原中心Y,原中心Z,新中心X,新中心Y,新中心Z\n";
    for (const QJsonValue &value : moves) {
        const QJsonObject move = value.toObject();
        const QJsonArray from = move.value(QStringLiteral("from")).toArray();
        const QJsonArray to = move.value(QStringLiteral("to")).toArray();
        const QString kind = move.value(QStringLiteral("kind")).toString();
        out << (kind == QStringLiteral("overlap") ? QStringLiteral("解重叠") : QStringLiteral("推间距")) << ','
            << move.value(QStringLiteral("partId")).toString() << ','
            << move.value(QStringLiteral("axis")).toString() << ','
            << QString::number(move.value(QStringLiteral("delta")).toDouble(), 'f', 1);
        for (int axis = 0; axis < 3; ++axis) {
            out << ',' << QString::number(from.at(axis).toDouble(), 'f', 1);
        }
        for (int axis = 0; axis < 3; ++axis) {
            out << ',' << QString::number(to.at(axis).toDouble(), 'f', 1);
        }
        out << '\n';
    }
    out << "合计,,,,,,,,,"
        << QStringLiteral("%1轮/%2次").arg(layout.value(QStringLiteral("rounds")).toArray().size())
               .arg(moves.size())
        << '\n';
    file.close();
    *rows = moves.size();
    return true;
}

MachineCaseDialog::MachineCaseDialog(const QJsonObject &document, QWidget *parent,
                                     std::function<void(const QStringList &)> onHighlight,
                                     std::function<void(const QString &, int, double)> onApplyMove,
                                     std::function<void()> onResolveAll,
                                     std::function<void()> onResolveClearance,
                                     std::function<void()> onLayoutCompliance,
                                     std::function<void(int)> onClearanceThreshold,
                                     int uiClearanceMm)
    : QDialog(parent) {
    setWindowTitle(QStringLiteral("整机方案（只读）"));
    resize(760, 520);

    auto *layout = new QVBoxLayout(this);
    const QString brief = document.value(QStringLiteral("brief")).toString();
    m_brief = new QLabel(this);
    m_brief->setWordWrap(true);
    m_brief->setText(QStringLiteral("需求：%1").arg(brief.isEmpty() ? QStringLiteral("（无 brief）") : brief));
    layout->addWidget(m_brief);

    m_tabs = new QTabWidget(this);
    layout->addWidget(m_tabs, 1);

    const QJsonObject cycle = document.value(QStringLiteral("cycleAnalysis")).toObject();
    const QJsonObject electrical = document.value(QStringLiteral("electrical")).toObject();
    const QJsonObject cost = document.value(QStringLiteral("cost")).toObject();

    // 概览：工位/节拍/配电/成本，一行一项，数字原样来自 JSON
    auto *overview = makeTable({QStringLiteral("项"), QStringLiteral("值")}, this);
    appendRow(overview, {QStringLiteral("工位数"), QString::number(document.value(QStringLiteral("stations")).toArray().size())});
    appendRow(overview, {QStringLiteral("节拍目标（件/分）"), number(valueAt(cycle, QStringLiteral("targetPerMin")), 2)});
    appendRow(overview, {QStringLiteral("节拍估算（件/分）"), number(valueAt(cycle, QStringLiteral("throughputPerMin")), 2)});
    appendRow(overview, {QStringLiteral("是否达标"), cycle.value(QStringLiteral("meetsTarget")).toBool() ? QStringLiteral("是") : QStringLiteral("否")});
    appendRow(overview, {QStringLiteral("最慢工位"),
                         QString::number(cycle.value(QStringLiteral("slowestStation")).toInt())});
    appendRow(overview, {QStringLiteral("设计功率（W）"), number(valueAt(electrical, QStringLiteral("totalDesignW")), 1)});
    appendRow(overview, {QStringLiteral("成本合计"), number(valueAt(cost, QStringLiteral("total")), 2)});
    appendRow(overview, {QStringLiteral("无价格项"), QString::number(cost.value(QStringLiteral("missingCount")).toInt())});

    // 合规戳：方案文件自带「按多少 mm 检查过、结论如何」。
    // 界面当前阈值和它不一致时要说出来——否则用户会以为这份方案是按当前阈值查过的。
    const QJsonObject stamp = document.value(QStringLiteral("compliance")).toObject();
    if (!stamp.isEmpty()) {
        const int stampMm = stamp.value(QStringLiteral("clearanceMm")).toInt();
        const bool stampConverged = stamp.value(QStringLiteral("converged")).toBool();
        QString stampText = QStringLiteral("按 %1 mm：%2（%3 轮 / %4 次位移）")
                                .arg(stampMm)
                                .arg(stampConverged ? QStringLiteral("已合规") : QStringLiteral("未收敛"))
                                .arg(stamp.value(QStringLiteral("rounds")).toInt())
                                .arg(stamp.value(QStringLiteral("moves")).toInt());
        if (uiClearanceMm > 0 && uiClearanceMm != stampMm) {
            stampText += QStringLiteral("　⚠ 界面当前阈值是 %1 mm，与这份方案的检查值不同，需重新计算")
                             .arg(uiClearanceMm);
        }
        appendRow(overview, {QStringLiteral("排布合规"), stampText});
    } else {
        appendRow(overview, {QStringLiteral("排布合规"), QStringLiteral("未检查（没有按间距阈值跑过排布合规）")});
    }
    overview->resizeColumnsToContents();
    m_tabs->addTab(overview, QStringLiteral("概览"));

    // BOM
    auto *bomTable = makeTable({QStringLiteral("类别"), QStringLiteral("名称"), QStringLiteral("型号"), QStringLiteral("数量"), QStringLiteral("来源")}, this);
    const QJsonArray items = document.value(QStringLiteral("bom")).toObject().value(QStringLiteral("items")).toArray();
    for (const QJsonValue &value : items) {
        const QJsonObject item = value.toObject();
        appendRow(bomTable, {
            item.value(QStringLiteral("kind")).toString(),
            item.value(QStringLiteral("name")).toString(),
            item.value(QStringLiteral("model")).toString(),
            QString::number(item.value(QStringLiteral("qty")).toInt(1)),
            item.value(QStringLiteral("note")).toString()
        });
    }
    bomTable->resizeColumnsToContents();
    m_tabs->addTab(bomTable, QStringLiteral("BOM（%1）").arg(items.size()));

    // IO
    auto *ioTable = makeTable({QStringLiteral("点号"), QStringLiteral("地址"), QStringLiteral("方向"),
                               QStringLiteral("类型"), QStringLiteral("归属"), QStringLiteral("工位")}, this);
    const QJsonArray rows = document.value(QStringLiteral("ioMap")).toObject().value(QStringLiteral("rows")).toArray();
    for (const QJsonValue &value : rows) {
        const QJsonObject row = value.toObject();
        appendRow(ioTable, {
            row.value(QStringLiteral("point")).toString(),
            row.value(QStringLiteral("address")).toString(),
            row.value(QStringLiteral("direction")).toString(),
            row.value(QStringLiteral("type")).toString(),
            // 归属 = 「工位1夹爪1」，比 ownerType 更能看出是哪个零件
            row.value(QStringLiteral("owner")).toString(row.value(QStringLiteral("ownerType")).toString()),
            row.value(QStringLiteral("station")).toString()
        });
    }
    ioTable->resizeColumnsToContents();
    m_tabs->addTab(ioTable, QStringLiteral("IO（%1）").arg(rows.size()));

    // 排布合规：把「交替跑了几轮、每轮前后两类问题数、一共挪了几次」摆出来。
    // 只有一行状态栏提示是不够的——用户看不到「第 1 轮推间距反而撞出 4 处重叠」这个过程。
    const QJsonObject layoutInfo = document.value(QStringLiteral("geometry")).toObject()
                                       .value(QStringLiteral("layoutCompliance")).toObject();
    if (!layoutInfo.isEmpty()) {
        const QJsonArray rounds = layoutInfo.value(QStringLiteral("rounds")).toArray();
        auto *layoutTable = makeTable({QStringLiteral("轮次"), QStringLiteral("进轮·重叠"), QStringLiteral("出轮·重叠"),
                                       QStringLiteral("进轮·间距不足"), QStringLiteral("出轮·间距不足"),
                                       QStringLiteral("解重叠位移"), QStringLiteral("推间距位移")}, this);
        for (const QJsonValue &value : rounds) {
            const QJsonObject round = value.toObject();
            appendRow(layoutTable, {
                QString::number(round.value(QStringLiteral("round")).toInt()),
                QString::number(round.value(QStringLiteral("suspectsBefore")).toInt()),
                QString::number(round.value(QStringLiteral("suspectsAfter")).toInt()),
                QString::number(round.value(QStringLiteral("clearanceBefore")).toInt()),
                QString::number(round.value(QStringLiteral("clearanceAfter")).toInt()),
                QString::number(round.value(QStringLiteral("overlapMoves")).toInt()),
                QString::number(round.value(QStringLiteral("clearanceMoves")).toInt())
            });
        }
        layoutTable->resizeColumnsToContents();
        m_tabs->addTab(layoutTable, QStringLiteral("排布合规（%1 轮）").arg(rounds.size()));
        if (qEnvironmentVariable("AUTOMATIONCAD_TAB") == QStringLiteral("layout")) {
            m_tabs->setCurrentWidget(layoutTable);
        }

        auto *layoutPage = new QWidget(this);
        auto *layoutPageLayout = new QVBoxLayout(layoutPage);
        const bool converged = layoutInfo.value(QStringLiteral("converged")).toBool();
        const QString stopReason = layoutInfo.value(QStringLiteral("stopReason")).toString();
        auto *verdict = new QLabel(
            converged
                ? QStringLiteral("已合规：%1 轮共 %2 次位移，未声明重叠 %3、间距 < %4 mm %5 处。"
                                 "位移明细可导出 CSV（含原/新中心坐标）。")
                      .arg(rounds.size())
                      .arg(layoutInfo.value(QStringLiteral("moves")).toArray().size())
                      .arg(layoutInfo.value(QStringLiteral("suspects")).toInt())
                      .arg(layoutInfo.value(QStringLiteral("clearanceMm")).toInt())
                      .arg(layoutInfo.value(QStringLiteral("clearance")).toInt())
                : QStringLiteral("**未收敛**：%1。剩余未声明重叠 %2、间距不足 %3 处。"
                                 "这是 AABB 口径下的结果，不代表几何一定可制造。")
                      .arg(stopReason)
                      .arg(layoutInfo.value(QStringLiteral("suspects")).toInt())
                      .arg(layoutInfo.value(QStringLiteral("clearance")).toInt()),
            layoutPage);
        const QJsonArray advice = layoutInfo.value(QStringLiteral("advice")).toArray();
        if (!converged && !advice.isEmpty()) {
            QStringList lines;
            for (const QJsonValue &value : advice) {
                const QJsonObject item = value.toObject();
                const QJsonArray itemPairs = item.value(QStringLiteral("pairs")).toArray();
                const QString first = itemPairs.isEmpty()
                    ? QString()
                    : QStringLiteral("（%1 × %2）")
                          .arg(itemPairs.at(0).toObject().value(QStringLiteral("a")).toString(),
                               itemPairs.at(0).toObject().value(QStringLiteral("b")).toString());
                lines << QStringLiteral("· %1 还差 %2 mm 才到阈值%3")
                             .arg(item.value(QStringLiteral("scope")).toString())
                             .arg(QString::number(item.value(QStringLiteral("shortByMm")).toDouble(), 'f', 1))
                             .arg(first);
            }
            verdict->setText(verdict->text() + QStringLiteral("\n\n建议：\n") + lines.join(QStringLiteral("\n")));
        }
        verdict->setWordWrap(true);
        verdict->setStyleSheet(converged ? QStringLiteral("color:#2e7d32;") : QStringLiteral("color:#b3261e;"));
        layoutPageLayout->addWidget(verdict);
        auto *exportLayout = new QPushButton(QStringLiteral("导出排布位移 CSV…"), layoutPage);
        connect(exportLayout, &QPushButton::clicked, layoutPage, [this, document]() {
            const QString path = QFileDialog::getSaveFileName(this, QStringLiteral("导出排布位移"),
                                                              QStringLiteral("machine-layout.csv"),
                                                              QStringLiteral("CSV 文件 (*.csv)"));
            if (path.isEmpty()) return;
            int rows = 0;
            QString error;
            if (!writeLayoutCsv(document, path, &rows, &error)) {
                QMessageBox::warning(this, QStringLiteral("导出失败"), error);
                return;
            }
            setWindowTitle(windowTitle() + QStringLiteral(" · 已导出 %1 行").arg(rows));
        });
        layoutPageLayout->addWidget(exportLayout, 0, Qt::AlignLeft);
        layoutPageLayout->addStretch(1);
        auto *preview = makeTable({QStringLiteral("类型"), QStringLiteral("零件"), QStringLiteral("轴"),
                                   QStringLiteral("位移(mm)")}, layoutPage);
        for (const QJsonValue &value : layoutInfo.value(QStringLiteral("moves")).toArray()) {
            const QJsonObject move = value.toObject();
            appendRow(preview, {
                move.value(QStringLiteral("kind")).toString() == QStringLiteral("overlap")
                    ? QStringLiteral("解重叠") : QStringLiteral("推间距"),
                move.value(QStringLiteral("partId")).toString(),
                move.value(QStringLiteral("axis")).toString().toUpper(),
                QString::number(move.value(QStringLiteral("delta")).toDouble(), 'f', 1)
            });
        }
        preview->resizeColumnsToContents();
        layoutPageLayout->addWidget(preview, 1);
        m_tabs->addTab(layoutPage, QStringLiteral("位移明细（%1）").arg(preview->rowCount()));
        if (qEnvironmentVariable("AUTOMATIONCAD_TAB") == QStringLiteral("advice")) {
            m_tabs->setCurrentWidget(layoutPage);
        }
        qInfo().noquote() << "FT_QT_LAYOUT_PAGE rounds=" << rounds.size()
                          << "moves=" << preview->rowCount()
                          << "converged=" << converged;
    }

    // 干涉初筛：AABB，只是「疑似」。必须把口径写在页签里，否则很容易被当成真实干涉体积
    const QJsonObject interference = document.value(QStringLiteral("geometry")).toObject()
                                         .value(QStringLiteral("interference")).toObject();
    if (!interference.isEmpty()) {
        const QJsonArray pairs = interference.value(QStringLiteral("pairs")).toArray();
        auto *conflictTable = makeTable({QStringLiteral("判定"), QStringLiteral("零件 A"), QStringLiteral("零件 B"),
                                         QStringLiteral("AABB 重叠体积"), QStringLiteral("重叠盒"),
                                         QStringLiteral("建议位移")}, this);
        for (const QJsonValue &value : pairs) {
            const QJsonObject pair = value.toObject();
            const QJsonArray box = pair.value(QStringLiteral("overlapBox")).toArray();
            const QJsonObject suggestion = pair.value(QStringLiteral("suggestion")).toObject();
            const QString axisName = suggestion.value(QStringLiteral("axis")).toString().toUpper();
            const QString advice = suggestion.isEmpty()
                ? QStringLiteral("—")
                : QStringLiteral("挪 %1 %2 %3%4 mm")
                      .arg(suggestion.value(QStringLiteral("partId")).toString(), axisName,
                           suggestion.value(QStringLiteral("delta")).toDouble() > 0 ? QStringLiteral("+") : QString(),
                           QString::number(suggestion.value(QStringLiteral("delta")).toDouble(), 'f', 1));
            appendRow(conflictTable, {
                pair.value(QStringLiteral("kind")).toString() == QStringLiteral("suspect")
                    ? QStringLiteral("需确认")
                    : QStringLiteral("已声明（%1）").arg(pair.value(QStringLiteral("reason")).toString()),
                pair.value(QStringLiteral("aName")).toString(),
                pair.value(QStringLiteral("bName")).toString(),
                QStringLiteral("%1 mm³").arg(pair.value(QStringLiteral("overlapMm3")).toDouble(), 0, 'f', 1),
                QStringLiteral("%1 × %2 × %3").arg(box.at(0).toDouble(), 0, 'f', 1)
                    .arg(box.at(1).toDouble(), 0, 'f', 1).arg(box.at(2).toDouble(), 0, 'f', 1),
                advice
            });
        }
        conflictTable->resizeColumnsToContents();
        if (onHighlight) {
            // 点一行就把这一对在 3D 里点亮：只给体积不指位置，用户还得自己找
            connect(conflictTable, &QTableWidget::itemSelectionChanged, this,
                    [conflictTable, pairs, onHighlight]() {
                        const int row = conflictTable->currentRow();
                        if (row < 0 || row >= pairs.size()) {
                            onHighlight({});
                            return;
                        }
                        const QJsonObject pair = pairs.at(row).toObject();
                        onHighlight({pair.value(QStringLiteral("a")).toString(),
                                     pair.value(QStringLiteral("b")).toString()});
                    });
        }
        // 自动化钩子：selectRow 会触发 itemSelectionChanged，用它验证「点一行 → 3D 点亮」整条链
        if (qEnvironmentVariableIsSet("AUTOMATIONCAD_PAIR_AUTO") && conflictTable->rowCount() > 0) {
            conflictTable->selectRow(0);
        }
        auto *page = new QWidget(this);
        auto *pageLayout = new QVBoxLayout(page);
        pageLayout->addWidget(conflictTable, 1);
        const int declared = interference.value(QStringLiteral("declared")).toInt();
        const int suspects = interference.value(QStringLiteral("suspects")).toInt();
        QString verdict;
        if (pairs.isEmpty()) {
            verdict = QStringLiteral("未发现 AABB 重叠（%1 个零件两两初筛）").arg(interference.value(QStringLiteral("partCount")).toInt());
        } else if (suspects == 0) {
            verdict = QStringLiteral("%1 对重叠全部是**已声明的结构连接**（立柱插横梁等，见 joints.ts），装配上正常；"
                                     "这不是布尔交集结果，要真实体积请在装配视图里跑干涉检查")
                          .arg(declared);
        } else {
            verdict = QStringLiteral("%1 对重叠：**%2 对未声明、需人工确认** + %3 对已声明连接。"
                                     "「已声明」只表示生成器认为这两件本该相接，不代表几何一定对；"
                                     "AABB 初筛也不等于真实干涉")
                          .arg(pairs.size()).arg(suspects).arg(declared);
        }
        const QString jointSource = interference.value(QStringLiteral("jointSource")).toString();
        verdict += QStringLiteral("\n连接来源：%1").arg(
            jointSource == QStringLiteral("generator")
                ? QStringLiteral("几何生成器产出（新增构件类型会自己登记）")
                : QStringLiteral("命名规则回退（老数据没有 joints 字段）"));
        auto *note = new QLabel(verdict, page);
        note->setWordWrap(true);
        pageLayout->addWidget(note);
        const QJsonObject clearance = document.value(QStringLiteral("geometry")).toObject()
                                          .value(QStringLiteral("clearance")).toObject();
        if (!clearance.isEmpty()) {
            const QJsonArray clearancePairs = clearance.value(QStringLiteral("pairs")).toArray();
            QString tightest;
            if (!clearancePairs.isEmpty()) {
                const QJsonObject first = clearancePairs.at(0).toObject();
                tightest = QStringLiteral("，最紧 %1 mm（%2 × %3）")
                               .arg(QString::number(first.value(QStringLiteral("gapMm")).toDouble(), 'f', 1))
                               .arg(first.value(QStringLiteral("a")).toString(),
                                    first.value(QStringLiteral("b")).toString());
            }
            auto *clearanceLabel = new QLabel(
                QStringLiteral("间距 < %1 mm：%2 处%3　（AABB 距离初筛，贴面 ≤0.5 mm 算接触）")
                    .arg(clearance.value(QStringLiteral("thresholdMm")).toInt())
                    .arg(clearance.value(QStringLiteral("count")).toInt())
                    .arg(tightest), page);
            clearanceLabel->setWordWrap(true);
            clearanceLabel->setStyleSheet(QStringLiteral("color:#8a6d3b;"));
            auto *thresholdRow = new QHBoxLayout();
            thresholdRow->addWidget(clearanceLabel, 1);
            if (onClearanceThreshold) {
                auto *spin = new QSpinBox(page);
                spin->setRange(1, 500);
                spin->setSuffix(QStringLiteral(" mm"));
                spin->setValue(clearance.value(QStringLiteral("thresholdMm")).toInt());
                spin->setToolTip(QStringLiteral("改完点右边按钮按新阈值重算整机"));
                auto *applyThreshold = new QPushButton(QStringLiteral("按此阈值重算…"), page);
                connect(applyThreshold, &QPushButton::clicked, page,
                        [spin, onClearanceThreshold]() { onClearanceThreshold(spin->value()); });
                thresholdRow->addWidget(spin);
                thresholdRow->addWidget(applyThreshold);
            }
            pageLayout->insertLayout(0, thresholdRow);
            qInfo().noquote() << "FT_QT_CLEARANCE_LABEL count=" << clearance.value(QStringLiteral("count")).toInt()
                              << "tightest=" << (clearancePairs.isEmpty() ? 0.0
                                                                         : clearancePairs.at(0).toObject().value(QStringLiteral("gapMm")).toDouble());
        }
        const QJsonObject resolutionForUi = document.value(QStringLiteral("geometry")).toObject()
                                                .value(QStringLiteral("resolution")).toObject();
        if (onApplyMove) {
            auto *applyRow = new QHBoxLayout();
            auto *applyButton = new QPushButton(QStringLiteral("按建议挪这一对…"), page);
            applyButton->setToolTip(QStringLiteral("把「建议位移」应用到选中的那一对，然后重算几何与干涉"));
            connect(applyButton, &QPushButton::clicked, page, [conflictTable, pairs, onApplyMove, page]() {
                const int row = conflictTable->currentRow();
                if (row < 0 || row >= pairs.size()) {
                    QMessageBox::information(page, QStringLiteral("按建议挪"),
                                             QStringLiteral("先在表里选一行，再按这个按钮。"));
                    return;
                }
                const QJsonObject suggestion = pairs.at(row).toObject().value(QStringLiteral("suggestion")).toObject();
                if (suggestion.isEmpty()) {
                    QMessageBox::information(page, QStringLiteral("按建议挪"), QStringLiteral("这一对没有建议位移。"));
                    return;
                }
                const QString axis = suggestion.value(QStringLiteral("axis")).toString();
                const int index = axis == QStringLiteral("x") ? 0 : axis == QStringLiteral("y") ? 1 : 2;
                onApplyMove(suggestion.value(QStringLiteral("partId")).toString(), index,
                            suggestion.value(QStringLiteral("delta")).toDouble());
            });
            applyRow->addWidget(applyButton);
            if (!resolutionForUi.isEmpty()) {
                auto *exportResolution = new QPushButton(QStringLiteral("导出调整清单 CSV…"), page);
                connect(exportResolution, &QPushButton::clicked, page, [this, document]() {
                    const QString path = QFileDialog::getSaveFileName(this, QStringLiteral("导出调整清单"),
                                                                      QStringLiteral("machine-resolve.csv"),
                                                                      QStringLiteral("CSV 文件 (*.csv)"));
                    if (path.isEmpty()) return;
                    int rows = 0;
                    QString error;
                    if (!writeResolutionCsv(document, path, &rows, &error)) {
                        QMessageBox::warning(this, QStringLiteral("导出失败"), error);
                        return;
                    }
                    setWindowTitle(windowTitle() + QStringLiteral(" · 已导出 %1 行调整").arg(rows));
                });
                applyRow->addWidget(exportResolution);
            }
            if (onLayoutCompliance) {
                auto *layoutButton = new QPushButton(QStringLiteral("一键排布合规（解重叠 → 推间距 → 复查）…"), page);
                layoutButton->setToolTip(QStringLiteral("交替跑两段直到「未声明重叠 0 且间距不足 0」，收敛不了会说明原因"));
                connect(layoutButton, &QPushButton::clicked, page, [onLayoutCompliance]() { onLayoutCompliance(); });
                applyRow->addWidget(layoutButton);
            }
            if (onResolveClearance && !clearance.isEmpty()) {
                auto *pushButton = new QPushButton(
                    QStringLiteral("推开到间距 ≥ %1 mm…").arg(clearance.value(QStringLiteral("thresholdMm")).toInt()), page);
                pushButton->setToolTip(QStringLiteral("沿间隙轴把较小的那件推开，逐轮重算"));
                connect(pushButton, &QPushButton::clicked, page, [onResolveClearance]() { onResolveClearance(); });
                applyRow->addWidget(pushButton);
            }
            if (onResolveAll) {
                auto *resolveButton = new QPushButton(QStringLiteral("批量解开未声明的重叠…"), page);
                resolveButton->setToolTip(QStringLiteral("逐轮挪动最小的那一处并重算，直到没有未声明重叠"));
                connect(resolveButton, &QPushButton::clicked, page, [onResolveAll]() { onResolveAll(); });
                applyRow->addWidget(resolveButton);
            }
            applyRow->addStretch(1);
            pageLayout->addLayout(applyRow);
        }
        m_tabs->addTab(page, QStringLiteral("干涉初筛（%1）").arg(pairs.size()));
    }

    auto *boundary = new QLabel(
        QStringLiteral("这是方案级结果：没有 3D 几何、没有工程图、没有公差；节拍为估算，成本按已接入价格簿计算，"
                       "无价格项计 0 并在「无价格项」里计数。"), this);
    boundary->setWordWrap(true);
    layout->addWidget(boundary);

    auto *buttons = new QDialogButtonBox(QDialogButtonBox::Close, this);
    QPushButton *exportCsv = buttons->addButton(QStringLiteral("导出 BOM CSV…"), QDialogButtonBox::ActionRole);
    connect(exportCsv, &QPushButton::clicked, this, [this, document]() {
        const QString path = QFileDialog::getSaveFileName(this, QStringLiteral("导出整机 BOM"),
                                                          QStringLiteral("machine-bom.csv"),
                                                          QStringLiteral("CSV 文件 (*.csv)"));
        if (path.isEmpty()) return;
        int rows = 0;
        QString error;
        if (!writeBomCsv(document, path, &rows, &error)) {
            QMessageBox::warning(this, QStringLiteral("导出失败"), error);
            return;
        }
        // 不弹第二次框：写进标题栏，用户能立刻看到行数
        setWindowTitle(windowTitle() + QStringLiteral(" · 已导出 %1 行").arg(rows));
    });
    connect(buttons, &QDialogButtonBox::rejected, this, &QDialog::reject);
    layout->addWidget(buttons);
}
