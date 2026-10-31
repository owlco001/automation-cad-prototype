#include "PlcAuditDialog.h"

#include <QHeaderView>
#include <QJsonArray>
#include <QLabel>
#include <QTableWidget>
#include <QTextEdit>
#include <QVBoxLayout>

PlcAuditDialog::PlcAuditDialog(const QJsonObject &audit, QWidget *parent)
    : QDialog(parent)
{
    setWindowTitle(tr("PLC 体检（缺口 / 步序 / 程序↔3D 对账）"));
    resize(780, 560);

    const int gapsFound = audit.value(QStringLiteral("gapsFound")).toInt();
    const int autoFixable = audit.value(QStringLiteral("autoFixable")).toInt();
    const QJsonArray applied = audit.value(QStringLiteral("applied")).toArray();
    const bool generated = audit.value(QStringLiteral("generated")).toBool();
    const int sequenceSteps = audit.value(QStringLiteral("sequenceSteps")).toInt();
    const int files = audit.value(QStringLiteral("files")).toInt();
    const QJsonObject recon = audit.value(QStringLiteral("audit")).toObject();
    const int linkagePoints = recon.value(QStringLiteral("linkagePoints")).toInt();
    const int driven = recon.value(QStringLiteral("pointsDriven")).toInt();
    const int reconGaps = recon.value(QStringLiteral("gaps")).toArray().size();

    m_summaryText = tr("缺口 %1 条（可自动补 %2，已补 %3）· PLC 工程 %4（%5 个文件）· 步序 %6 步 · "
                       "联动点位 %7 个，被 PLC 驱动 %8 个 · 对账缺口 %9 处")
                        .arg(gapsFound).arg(autoFixable).arg(applied.size())
                        .arg(generated ? tr("生成成功") : tr("生成失败"))
                        .arg(files).arg(sequenceSteps).arg(linkagePoints).arg(driven).arg(reconGaps);

    auto *layout = new QVBoxLayout(this);

    m_summary = new QLabel(m_summaryText, this);
    m_summary->setWordWrap(true);
    QFont summaryFont = m_summary->font();
    summaryFont.setBold(true);
    m_summary->setFont(summaryFont);
    layout->addWidget(m_summary);

    // 结论不符合预期时必须说清楚「为什么」，不能只有一个数字
    const QJsonArray remaining = audit.value(QStringLiteral("remainingErrors")).toArray();
    QString stateText;
    if (!generated) {
        QStringList reasons;
        for (const QJsonValue &value : audit.value(QStringLiteral("generateErrors")).toArray()) {
            reasons << value.toObject().value(QStringLiteral("message")).toString();
        }
        stateText = tr("⚠ PLC 工程没有生成：%1").arg(reasons.isEmpty() ? tr("原因未知") : reasons.join(QStringLiteral("；")));
    } else if (reconGaps > 0) {
        stateText = tr("⚠ 生成成功，但程序与 3D 联动对不上 %1 处，看下面的对账缺口。").arg(reconGaps);
    } else if (!remaining.isEmpty()) {
        stateText = tr("⚠ 补齐后仍有 %1 条预检错误（未自动处理，需人工决定）。").arg(remaining.size());
    } else {
        stateText = tr("✓ 缺口已补齐、PLC 工程生成成功，联动用到的点位全部被步序驱动，安全门条件存在。");
    }
    stateText += tr("　注意：缺口是按最小改动补出来的（每轴 1 个到位检测 + 急停 + 安全门），这是补齐后的方案。");
    m_state = new QLabel(stateText, this);
    m_state->setWordWrap(true);
    layout->addWidget(m_state);

    auto *gapTitle = new QLabel(tr("预检缺口与处置"), this);
    layout->addWidget(gapTitle);
    m_gaps = new QTableWidget(this);
    m_gaps->setColumnCount(3);
    m_gaps->setHorizontalHeaderLabels({tr("错误码"), tr("说明"), tr("处置")});
    m_gaps->horizontalHeader()->setSectionResizeMode(1, QHeaderView::Stretch);
    m_gaps->setRowCount(audit.value(QStringLiteral("fixes")).toArray().size());
    int row = 0;
    for (const QJsonValue &value : audit.value(QStringLiteral("fixes")).toArray()) {
        const QJsonObject gap = value.toObject();
        m_gaps->setItem(row, 0, new QTableWidgetItem(gap.value(QStringLiteral("code")).toString()));
        m_gaps->setItem(row, 1, new QTableWidgetItem(gap.value(QStringLiteral("message")).toString()));
        const QString fix = gap.value(QStringLiteral("fix")).toString();
        m_gaps->setItem(row, 2, new QTableWidgetItem(fix.isEmpty() ? tr("需人工决定（工具不猜）") : fix));
        ++row;
    }
    m_gaps->resizeRowsToContents();
    layout->addWidget(m_gaps, 1);

    auto *appliedTitle = new QLabel(tr("已补齐（写进本次生成的方案）"), this);
    layout->addWidget(appliedTitle);
    m_applied = new QTextEdit(this);
    m_applied->setReadOnly(true);
    QStringList appliedLines;
    for (const QJsonValue &value : applied) appliedLines << QStringLiteral("· ") + value.toString();
    m_applied->setPlainText(appliedLines.isEmpty() ? tr("（没有补齐项）") : appliedLines.join(QStringLiteral("\n")));
    m_applied->setMaximumHeight(110);
    layout->addWidget(m_applied);

    auto *reconTitle = new QLabel(tr("程序 ↔ 3D 对账缺口"), this);
    layout->addWidget(reconTitle);
    m_auditGaps = new QTextEdit(this);
    m_auditGaps->setReadOnly(true);
    QStringList reconLines;
    for (const QJsonValue &value : recon.value(QStringLiteral("gaps")).toArray()) {
        reconLines << QStringLiteral("· ") + value.toObject().value(QStringLiteral("detail")).toString();
    }
    m_auditGaps->setPlainText(reconLines.isEmpty() ? tr("（无缺口：联动点位全部在 PLC 表里、被步序驱动、程序里有引用）")
                                                   : reconLines.join(QStringLiteral("\n")));
    m_auditGaps->setMaximumHeight(110);
    layout->addWidget(m_auditGaps);
}

QString PlcAuditDialog::summaryText() const
{
    return m_summaryText;
}
