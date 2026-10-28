#pragma once
// Qt 客户端壳子 v0.1：布局 1:1 对齐 SolidWorks 式五区（菜单 / 工具栏 / 特征树 / 视口 / 属性面板 / 状态栏）。
// 契约：本窗口不持有可独立写回的树副本；一切写操作走 FeatureTree 服务（POST /v1/operations，
// 带 expectedRevision），成功后以返回的包络全文刷新，409 冲突时提示重新读取，禁止自动覆盖。
#include "StlViewport.h"

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

    /// 特征操作自检：压缩 → 体积变大；删除被引用基体 → 409 REFERENCE_IN_USE；解除压缩 → 体积复原。
    bool runFeatureOpsSelfTest(const QString &base, double *suppressedVolume, double *restoredVolume, QString *error);

    /// 撤销/重做自检：改一次 → 撤销 → 重做，三步都要在服务端真的落地。
    bool runHistorySelfTest(const QString &base, int *undoRevision, int *redoRevision, double *height, QString *error);

    /// 服务地址（默认 127.0.0.1:18080）
    void setServiceBase(const QString &base);
    /// 定时拉取 /v1/tree，revision 变化时刷新界面并发出 envelopeRefreshed
    void startAutoRefresh(int intervalMs = 1500);
    /// 订阅 /v1/events（SSE）；断线自动重连，期间保留轮询兜底
    void startEventStream();
    /// SSE 自检：连上后等外部改树，收到变更即打印并退出
    bool runSseSelfTest(const QString &base, int *revision, QString *error);
    /// 立即读一次
    void refreshNow();
    /// 撤销/重做（走服务端 /v1/undo、/v1/redo，带 expectedRevision）
    void undoOnce();
    void redoOnce();

signals:
    /// 每次成功读到包络后发出（首次加载与后续变化都会发）
    void envelopeRefreshed(int revision);

private slots:
    void loadTree();
    void onEventStreamReadyRead();
    void onEventStreamFinished();
    void showTreeMenu(const QPoint &pos);
    void onTreeItemSelected(QTreeWidgetItem *item, int column);
    void onPropertyCellChanged(int row, int column);
    void onTreeReply();
    void onOperationReply();

private:
    void refreshTree(const QJsonObject &envelope);
    void refreshPanel(const QJsonObject &feature);
    void postOperation(const QJsonObject &body);
    /// 撤销/重做共用的写操作（kind = undo | redo）
    void postHistory(const QString &kind);
    void showConflict(const QJsonObject &current);
    void refreshPanelFromEnvelope();
    QJsonObject requestSync(const QByteArray &verb, const QString &path, const QJsonObject &body,
                            int *status, QString *error, int timeoutMs = 8000);

    QNetworkAccessManager *m_net;
    QTreeWidget *m_tree;
    QTableWidget *m_panel;
    StlViewport *m_viewport;
    QLabel *m_statusRevision;
    QLabel *m_statusGeometry;
    QLabel *m_statusLink = nullptr;
    class QNetworkReply *m_eventStream = nullptr;
    QByteArray m_eventBuffer;
    bool m_sseConnected = false;
    class QAction *m_undoAction = nullptr;
    class QAction *m_redoAction = nullptr;
    QSplitter *m_splitter;
    class QTimer *m_pollTimer = nullptr;
    QJsonObject m_envelope;
    QString m_selectedFeatureId;
    bool m_updatingPanel = false;
    QString m_serviceBase = QStringLiteral("http://127.0.0.1:18080");
};
