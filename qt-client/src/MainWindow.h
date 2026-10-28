#pragma once
// Qt 客户端壳子 v0.1：布局 1:1 对齐 SolidWorks 式五区（菜单 / 工具栏 / 特征树 / 视口 / 属性面板 / 状态栏）。
// 契约：本窗口不持有可独立写回的树副本；一切写操作走 FeatureTree 服务（POST /v1/operations，
// 带 expectedRevision），成功后以返回的包络全文刷新，409 冲突时提示重新读取，禁止自动覆盖。
#include <QJsonObject>
#include <QMainWindow>
#include <QNetworkAccessManager>

class QLabel;
class QSplitter;
class QTableWidget;
class QTreeWidget;
class QTreeWidgetItem;

class MainWindow : public QMainWindow {
    Q_OBJECT
public:
    explicit MainWindow(QWidget *parent = nullptr);

    /// 无人值守自检：读树 → 改一个参数 → 再读，验证 Qt 侧网络/解析/乐观锁链路。
    /// 成功返回 true 并填 revision/height；失败返回 false 并填 error。
    bool runSelfTest(const QString &base, int *revision, double *height, QString *error);

private slots:
    void loadTree();
    void onTreeItemSelected(QTreeWidgetItem *item, int column);
    void onPropertyCellChanged(int row, int column);
    void onTreeReply();
    void onOperationReply();

private:
    void refreshTree(const QJsonObject &envelope);
    void refreshPanel(const QJsonObject &feature);
    void postOperation(const QJsonObject &body);
    void showConflict(const QJsonObject &current);
    void refreshPanelFromEnvelope();
    QJsonObject requestSync(const QByteArray &verb, const QString &path, const QJsonObject &body,
                            int *status, QString *error, int timeoutMs = 8000);

    QNetworkAccessManager *m_net;
    QTreeWidget *m_tree;
    QTableWidget *m_panel;
    QLabel *m_viewportPlaceholder;
    QLabel *m_statusRevision;
    QSplitter *m_splitter;
    QJsonObject m_envelope;
    QString m_selectedFeatureId;
    bool m_updatingPanel = false;
    QString m_serviceBase = QStringLiteral("http://127.0.0.1:18080");
};
