// 整机方案查看器：读 desktop 管线导出的 machine-case JSON（schemaVersion 1 / kind=machine-case），
// 只读展示「方案级」结果——节拍、配电、成本、BOM、IO。
// 明确边界：这里没有 3D 几何、没有工程图、没有公差；数字全部来自 JSON，客户端不重算也不补默认值。
#pragma once

#include <QDialog>
#include <functional>
#include <QJsonObject>
#include <QString>

class QLabel;
class QTabWidget;

class MachineCaseDialog : public QDialog {
    Q_OBJECT
public:
    /// onHighlight：选中干涉对时通知外面在 3D 里点亮两端（空列表 = 取消）
    /// onApplyMove：按建议位移挪零件（partId, axis 0/1/2, deltaMm）
    explicit MachineCaseDialog(const QJsonObject &document, QWidget *parent = nullptr,
                               std::function<void(const QStringList &)> onHighlight = {},
                               std::function<void(const QString &, int, double)> onApplyMove = {},
                               std::function<void()> onResolveAll = {},
                               std::function<void()> onResolveClearance = {},
                               std::function<void()> onLayoutCompliance = {},
                               std::function<void(int)> onClearanceThreshold = {},
                               int uiClearanceMm = -1);

    /// 读文件并校验 kind/schemaVersion；失败时 error 给出可操作原因
    static bool loadFile(const QString &path, QJsonObject *document, QString *error);

    /// 摘要一行，供自检/状态栏输出
    static QString summarize(const QJsonObject &document);

    /// 把 BOM 写成 CSV（UTF-8 BOM + 合计行）；返回写入行数，失败时 error 给原因
    static bool writeBomCsv(const QJsonObject &document, const QString &path, int *rows, QString *error);

    /// 把「批量解重叠」的调整清单写成 CSV（零件/轴/位移/原坐标/新坐标/解后剩余）
    static bool writeResolutionCsv(const QJsonObject &document, const QString &path, int *rows, QString *error);

    /// 把「一键排布合规」的位移写成 CSV（类型=重叠/间距 · 零件 · 轴 · 位移 · 原/新中心）
    static bool writeLayoutCsv(const QJsonObject &document, const QString &path, int *rows, QString *error);

private:
    QLabel *m_brief = nullptr;
    QTabWidget *m_tabs = nullptr;
    QString m_source;
};
