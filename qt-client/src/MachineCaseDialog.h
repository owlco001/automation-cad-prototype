// 整机方案查看器：读 desktop 管线导出的 machine-case JSON（schemaVersion 1 / kind=machine-case），
// 只读展示「方案级」结果——节拍、配电、成本、BOM、IO。
// 明确边界：这里没有 3D 几何、没有工程图、没有公差；数字全部来自 JSON，客户端不重算也不补默认值。
#pragma once

#include <QDialog>
#include <QJsonObject>
#include <QString>

class QLabel;
class QTabWidget;

class MachineCaseDialog : public QDialog {
    Q_OBJECT
public:
    explicit MachineCaseDialog(const QJsonObject &document, QWidget *parent = nullptr);

    /// 读文件并校验 kind/schemaVersion；失败时 error 给出可操作原因
    static bool loadFile(const QString &path, QJsonObject *document, QString *error);

    /// 摘要一行，供自检/状态栏输出
    static QString summarize(const QJsonObject &document);

private:
    QLabel *m_brief = nullptr;
    QTabWidget *m_tabs = nullptr;
    QString m_source;
};
