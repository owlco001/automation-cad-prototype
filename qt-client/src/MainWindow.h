#pragma once
// Qt 客户端壳子 v0.1：布局 1:1 对齐 SolidWorks 式五区（菜单 / 工具栏 / 特征树 / 视口 / 属性面板 / 状态栏）。
// 契约：本窗口不持有可独立写回的树副本；一切写操作走 FeatureTree 服务（POST /v1/operations，
// 带 expectedRevision），成功后以返回的包络全文刷新，409 冲突时提示重新读取，禁止自动覆盖。
#include "StlViewport.h"
#ifdef AUTOMATIONCAD_HAVE_OCCT
#include "OcctViewport.h"
#endif

#include <QJsonObject>
#include <QMap>

class QComboBox;
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

    /// 多文档自检：建 doc-qt-test → 写入 → 默认文档不受影响 → 切回默认。
    bool runDocumentSelfTest(const QString &base, int *newRevision, double *defaultHeight, QString *error);

    /// 新建特征自检：加一个 Ø4 通孔 → 体积按 πr²t 减少；删掉 → 复原。
    bool runCreateFeatureSelfTest(const QString &base, double *withHole, double *restored, QString *error);

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
    /// 0=等轴测 1=正视 2=俯视 3=右视（截图/自检用，和视图菜单同一实现）
    void applyStandardView(int which);
    /// 当前文档 id（默认 demo-adapter）
    void setDocument(const QString &documentId);
    QString documentId() const { return m_documentId; }
    /// 装配只读视图：按 assemblyId 拉 /v1/assemblies/<id> 与合成 STL；空字符串回到零件文档
    void openAssembly(const QString &assemblyId);
    /// 撤销/重做（走服务端 /v1/undo、/v1/redo，带 expectedRevision）
    void undoOnce();
    void redoOnce();
    /// 装配清单（Ctrl+B 的同一入口，也给 --bom-selftest 用）
    void runAssemblyBom();
    /// 导出当前零件/装配的 STL（几何来自服务端，客户端不重算）
    void exportStlDialog();
    void exportMachineStlDialog();
    bool exportStl(const QString &path, int *bytes, QString *error);
    /// 调 desktop 整机管线（node scripts/machine-design-cli.mjs）把一句话变成方案 JSON
    bool designMachineFromBrief(const QString &brief, QJsonObject *document, QString *error,
                                const QStringList &moves = {}, bool resolveAll = false,
                                int clearanceResolveMm = 0, bool layoutCompliance = false,
                                int clearanceMm = -1, bool measureMaxClearance = false);
    /// 试摆位：在已生成的方案上挪一个零件，重跑管线并重算干涉
    void tunePlacementDialog();
    /// 方向键微调选中零件（3D 里点选后用）
    void nudgeSelectedPart(int dx, int dy, int dz);
    void saveMachineCaseDialog();
    /// 整站挪：同一前缀（st2-…）的所有零件一起平移
    void nudgeStation(const QString &scope, int dx, int dy, int dz);
public:
    /// 同一工位前缀（st2-…）的零件 id 列表，顺序与文档一致（自检也用它）
    static QStringList partsOfScope(const QJsonObject &document, const QString &scope);
    /// 无人值守：直接指定选中零件（--nudge-selftest 用）
    void selectPartForTest(const QString &partId) { m_selectedPartId = partId; }
    void designMachineDialog();
    /// 把方案里的示意几何画到 3D 视口（占位体拼装，客户端只摆位）
    bool renderMachineGeometry(const QJsonObject &document, int *shapeCount, QString *error);
    /// 无人值守导出整机示意 STL（--geometry-selftest --out 用）
    bool exportMachineStlForTest(const QString &path, int *bytes, QString *error);

signals:
    /// 每次成功读到包络后发出（首次加载与后续变化都会发）
    void envelopeRefreshed(int revision);

private slots:
    void loadTree();
    void reloadDocuments();
    void runInterferenceCheck();
    void onCreateDocument();
    void onEventStreamReadyRead();
    void onEventStreamFinished();
    void showTreeMenu(const QPoint &pos);
    void createFeatureDialog();
    void onTreeItemSelected(QTreeWidgetItem *item, int column);
    void onPropertyCellChanged(int row, int column);
    void onTreeReply();
    void onOperationReply();

protected:
    /// 方向键微调选中零件（放在窗口级：视口有没有焦点都能用）
    void keyPressEvent(QKeyEvent *event) override;

private:
    void refreshTree(const QJsonObject &envelope);
    void refreshPanel(const QJsonObject &feature);
    void postOperation(const QJsonObject &body);
    /// 撤销/重做共用的写操作（kind = undo | redo）
    void postHistory(const QString &kind);
    void showConflict(const QJsonObject &current);
    void refreshPanelFromEnvelope();
    void setViewportGeometry(int revision, const QString &url);
    void fitViewport();
    void setViewportStandardView(int which);
    QJsonObject requestSync(const QByteArray &verb, const QString &path, const QJsonObject &body,
                            int *status, QString *error, int timeoutMs = 8000);

    QNetworkAccessManager *m_net;
    QTreeWidget *m_tree;
    QTableWidget *m_panel;
    QWidget *m_viewport = nullptr;
    StlViewport *m_glViewport = nullptr;
#ifdef AUTOMATIONCAD_HAVE_OCCT
    OcctViewport *m_occtViewport = nullptr;
#endif
    QLabel *m_statusRevision;
    QLabel *m_statusGeometry;
    QLabel *m_statusLink = nullptr;
    class QNetworkReply *m_eventStream = nullptr;
    QByteArray m_eventBuffer;
    bool m_sseConnected = false;
    QMap<QString, class QAction *> m_materialActions;
    class QAction *m_undoAction = nullptr;
    class QAction *m_redoAction = nullptr;
    QSplitter *m_splitter;
    class QTimer *m_pollTimer = nullptr;
    QJsonObject m_envelope;
    QString m_selectedFeatureId;
    bool m_updatingPanel = false;
    QString m_serviceBase = QStringLiteral("http://127.0.0.1:18080");
    QString m_documentId = QStringLiteral("demo-adapter");
    QString m_assemblyId;
    QString m_lastBrief;               // 最近一次生成/打开的方案 brief（试摆位要用）
    QStringList m_lastMoves;
    QJsonObject m_lastDocument;
public:
    /// 当前间距阈值（自检用）
    int currentClearanceMm() const { return m_clearanceMm; }
private:        // 最近一次生成的整机方案（试摆位/导出用）
    QString m_selectedPartId;          // 3D 里点选的零件
    /// 方案窗口里点「按建议挪」时的待处理位移（由 showMachineCase 的循环消费）
    QString m_pendingMovePartId;
    int m_pendingMoveAxis = -1;
    double m_pendingMoveDelta = 0.0;
    bool m_pendingResolveAll = false;
    bool m_pendingResolveClearance = false;
    bool m_pendingLayoutCompliance = false;
    /// 间距初筛阈值（mm），可在干涉页改；默认 20
    int m_clearanceMm = 20;
    int m_pendingClearanceMm = 0;
    bool m_pendingMeasureMax = false;
    /// 打开方案窗口并支持「按建议挪 → 重算 → 重新打开」的循环
    void showMachineCase(const QJsonObject &document);           // 累计的 --move 参数，多次试挪会叠加
    QJsonObject m_assemblyRecord;
    void editAssemblyMember(int memberIndex);
    bool fetchGeometryStl(QByteArray *bytes, QString *error);
    void loadAssembly(const QString &assemblyId);
    class QComboBox *m_documentCombo = nullptr;
    QString docQuery() const;
};
