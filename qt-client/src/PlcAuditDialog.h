#ifndef AUTOMATIONCAD_PLCAUDITDIALOG_H
#define AUTOMATIONCAD_PLCAUDITDIALOG_H

#include <QDialog>
#include <QJsonObject>

class QLabel;
class QTableWidget;
class QTextEdit;

/**
 * PLC 体检窗口。
 *
 * 只展示 desktop `--plc-audit` 的结论，不在客户端做任何 PLC 推断：
 *   缺口（缺什么、补到谁身上）→ 已补齐项 → 生成结果 → 程序↔3D 对账缺口。
 * 补齐是「方案缺件」的处置，必须在界面上写明「这是补齐后的方案」，不能当成原始方案。
 */
class PlcAuditDialog : public QDialog {
    Q_OBJECT
public:
    explicit PlcAuditDialog(const QJsonObject &audit, QWidget *parent = nullptr);

    /// 自检用：结论行文本（含缺口/生成/对账数字）
    QString summaryText() const;

private:
    QLabel *m_summary = nullptr;
    QLabel *m_state = nullptr;
    QTableWidget *m_gaps = nullptr;
    QTextEdit *m_applied = nullptr;
    QTextEdit *m_auditGaps = nullptr;
    QString m_summaryText;
};

#endif
