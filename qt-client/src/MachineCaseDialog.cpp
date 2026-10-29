#include "MachineCaseDialog.h"

#include <QDialogButtonBox>
#include <QFile>
#include <QFileDialog>
#include <QPushButton>
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

MachineCaseDialog::MachineCaseDialog(const QJsonObject &document, QWidget *parent,
                                     std::function<void(const QStringList &)> onHighlight)
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

    // 干涉初筛：AABB，只是「疑似」。必须把口径写在页签里，否则很容易被当成真实干涉体积
    const QJsonObject interference = document.value(QStringLiteral("geometry")).toObject()
                                         .value(QStringLiteral("interference")).toObject();
    if (!interference.isEmpty()) {
        const QJsonArray pairs = interference.value(QStringLiteral("pairs")).toArray();
        auto *conflictTable = makeTable({QStringLiteral("判定"), QStringLiteral("零件 A"), QStringLiteral("零件 B"),
                                         QStringLiteral("AABB 重叠体积"), QStringLiteral("重叠盒")}, this);
        for (const QJsonValue &value : pairs) {
            const QJsonObject pair = value.toObject();
            const QJsonArray box = pair.value(QStringLiteral("overlapBox")).toArray();
            appendRow(conflictTable, {
                pair.value(QStringLiteral("kind")).toString() == QStringLiteral("suspect")
                    ? QStringLiteral("需确认")
                    : QStringLiteral("已声明（%1）").arg(pair.value(QStringLiteral("reason")).toString()),
                pair.value(QStringLiteral("aName")).toString(),
                pair.value(QStringLiteral("bName")).toString(),
                QStringLiteral("%1 mm³").arg(pair.value(QStringLiteral("overlapMm3")).toDouble(), 0, 'f', 1),
                QStringLiteral("%1 × %2 × %3").arg(box.at(0).toDouble(), 0, 'f', 1)
                    .arg(box.at(1).toDouble(), 0, 'f', 1).arg(box.at(2).toDouble(), 0, 'f', 1)
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
