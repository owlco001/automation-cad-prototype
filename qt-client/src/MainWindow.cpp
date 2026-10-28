// Qt 客户端壳子 v0.1 实现。注意：本文件只用 Qt Widgets + Network，
// 不含 OCCT 头文件；视口是占位 QWidget，OCCT AIS 接入是后续里程碑。
#include "MainWindow.h"
#include "FeatureDialog.h"

#include <QAction>
#include <QColor>
#include <QEventLoop>
#include <QFormLayout>
#include <QHeaderView>
#include <QJsonArray>
#include <QJsonDocument>
#include <QLabel>
#include <QMenu>
#include <QMenuBar>
#include <QMessageBox>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QSet>
#include <QSplitter>
#include <QStatusBar>
#include <QTableWidget>
#include <QTimer>
#include <QToolBar>
#include <QTreeWidget>
#include <QVBoxLayout>

namespace {
// 服务端白名单（契约第 4 节）：只有这些字段能通过 updateFeatureParams 直接改。
// 面板若把 centered / edges / depth 这类布尔、枚举也做成可编辑，一改就 422 UNKNOWN_FIELD。
bool isEditableParam(const QString &key) {
    static const QSet<QString> editable = {
        QStringLiteral("length"), QStringLiteral("width"), QStringLiteral("height"),
        QStringLiteral("diameter"), QStringLiteral("cbDiameter"), QStringLiteral("cbDepth"),
        QStringLiteral("radius")
    };
    return editable.contains(key);
}

QJsonObject readReply(QNetworkReply *reply) {
    const QByteArray data = reply->readAll();
    QJsonDocument doc = QJsonDocument::fromJson(data);
    return doc.isObject() ? doc.object() : QJsonObject();
}
} // namespace

MainWindow::MainWindow(QWidget *parent)
    : QMainWindow(parent), m_net(new QNetworkAccessManager(this)) {
    setWindowTitle(tr("AutomationCAD · Qt 工作台（v0.1 壳子）"));
    resize(1280, 800);

    auto *fileMenu = menuBar()->addMenu(tr("文件"));
    fileMenu->addAction(tr("刷新特征树"), this, &MainWindow::loadTree);
    auto *viewMenu = menuBar()->addMenu(tr("视图"));
    viewMenu->addAction(tr("等轴测"), this, [this]() { m_viewport->setStandardView(0); });
    viewMenu->addAction(tr("正视"), this, [this]() { m_viewport->setStandardView(1); });
    viewMenu->addAction(tr("俯视"), this, [this]() { m_viewport->setStandardView(2); });
    viewMenu->addAction(tr("右视"), this, [this]() { m_viewport->setStandardView(3); });
    viewMenu->addSeparator();
    viewMenu->addAction(tr("适合视图"), this, [this]() { m_viewport->fitView(); });
    auto *insertMenu = menuBar()->addMenu(tr("插入"));
    QAction *newFeature = insertMenu->addAction(tr("新建特征…"), this, &MainWindow::createFeatureDialog);
    newFeature->setShortcut(QKeySequence::New);
    auto *toolsMenu = menuBar()->addMenu(tr("工具"));
    // 材质：只改文档属性（密度），几何不变、质量重算；四条固定项对应服务端白名单
    auto *materialMenu = toolsMenu->addMenu(tr("材质"));
    const QVector<QPair<QString, QString>> materials = {
        {QStringLiteral("steel"), tr("钢 7.85 g/cm³")},
        {QStringLiteral("aluminum"), tr("铝 2.70 g/cm³")},
        {QStringLiteral("stainless"), tr("不锈钢 7.93 g/cm³")},
        {QStringLiteral("brass"), tr("黄铜 8.50 g/cm³")}
    };
    for (const auto &entry : materials) {
        QAction *action = materialMenu->addAction(entry.second);
        action->setCheckable(true);
        action->setData(entry.first);
        m_materialActions.insert(entry.first, action);
        connect(action, &QAction::triggered, this, [this, key = entry.first]() {
            QJsonObject body;
            body.insert(QStringLiteral("documentId"), QStringLiteral("demo-adapter"));
            body.insert(QStringLiteral("expectedRevision"), m_envelope.value(QStringLiteral("revision")).toInt());
            body.insert(QStringLiteral("actor"), QStringLiteral("manual"));
            body.insert(QStringLiteral("operation"), QStringLiteral("setMaterial"));
            body.insert(QStringLiteral("material"), key);
            postOperation(body);
        });
    }
    menuBar()->addMenu(tr("评估"));

    auto *editMenu = menuBar()->addMenu(tr("编辑"));
    m_undoAction = editMenu->addAction(tr("撤销"), this, &MainWindow::undoOnce);
    m_undoAction->setShortcut(QKeySequence::Undo);
    m_redoAction = editMenu->addAction(tr("重做"), this, &MainWindow::redoOnce);
    m_redoAction->setShortcut(QKeySequence::Redo);
    m_undoAction->setEnabled(false);
    m_redoAction->setEnabled(false);

    auto *toolbar = addToolBar(tr("特征工具栏"));
    toolbar->addAction(m_undoAction);
    toolbar->addAction(m_redoAction);
    toolbar->addSeparator();
    toolbar->addAction(tr("新建特征"), this, &MainWindow::createFeatureDialog);
    toolbar->addSeparator();
    toolbar->addAction(tr("拉伸凸台"), this, [] {});
    toolbar->addAction(tr("拉伸切除"), this, [] {});
    toolbar->addAction(tr("旋转"), this, [] {});
    toolbar->addAction(tr("圆角"), this, [] {});
    toolbar->addAction(tr("倒角"), this, [] {});
    toolbar->addAction(tr("基准面"), this, [] {});

    m_tree = new QTreeWidget(this);
    m_tree->setHeaderLabel(tr("FeatureManager 设计树"));
    m_tree->setColumnCount(1);

    // 视口：几何来自服务端 /v1/geometry.stl（build123d 真建实体导出的二进制 STL），
    // 客户端只负责画，不参与建模。
    m_viewport = new StlViewport(this);
    connect(m_viewport, &StlViewport::loaded, this, [this](int triangles) {
        statusBar()->showMessage(tr("几何已加载：%1 个三角面（服务端 STL）").arg(triangles), 5000);
    });
    connect(m_viewport, &StlViewport::failed, this, [this](const QString &message) {
        statusBar()->showMessage(message, 6000);
    });

    m_panel = new QTableWidget(0, 2, this);
    m_panel->setHorizontalHeaderLabels({tr("参数"), tr("值")});
    m_panel->horizontalHeader()->setStretchLastSection(true);

    auto *right = new QWidget(this);
    auto *rightLayout = new QVBoxLayout(right);
    rightLayout->addWidget(new QLabel(tr("PropertyManager 属性面板"), right));
    rightLayout->addWidget(m_panel);
    right->setLayout(rightLayout);

    m_splitter = new QSplitter(this);
    m_splitter->addWidget(m_tree);
    m_splitter->addWidget(m_viewport);
    m_splitter->addWidget(right);
    m_splitter->setSizes({260, 720, 300});
    setCentralWidget(m_splitter);

    m_statusRevision = new QLabel(tr("未连接"), this);
    statusBar()->addPermanentWidget(m_statusRevision);
    m_statusGeometry = new QLabel(tr("几何：未接入"), this);
    statusBar()->addPermanentWidget(m_statusGeometry);
    m_statusLink = new QLabel(tr("链路：未连接"), this);
    statusBar()->addPermanentWidget(m_statusLink);
    statusBar()->showMessage(tr("单位：mm 优先"));

    connect(m_tree, &QTreeWidget::itemClicked, this, &MainWindow::onTreeItemSelected);
    m_tree->setContextMenuPolicy(Qt::CustomContextMenu);
    connect(m_tree, &QTreeWidget::customContextMenuRequested, this, &MainWindow::showTreeMenu);
    connect(m_panel, &QTableWidget::cellChanged, this, &MainWindow::onPropertyCellChanged);
    loadTree();
}

void MainWindow::setServiceBase(const QString &base) { m_serviceBase = base; }

bool MainWindow::runCreateFeatureSelfTest(const QString &base, double *withHole, double *restored, QString *error) {
    m_serviceBase = base;
    int status = 0;
    QString localError;
    const QJsonObject tree = requestSync("GET", QStringLiteral("/v1/tree"), {}, &status, &localError);
    if (status != 200) {
        if (error) *error = tr("读取特征树失败（HTTP %1）").arg(status);
        return false;
    }
    const auto volumeOf = [](const QJsonObject &envelope) {
        return envelope.value(QStringLiteral("geometry")).toObject().value(QStringLiteral("volumeMm3")).toDouble();
    };
    const double baseVolume = volumeOf(tree);
    if (baseVolume <= 0) {
        if (error) *error = QStringLiteral("服务端没返回几何（缺 sidecar？）");
        return false;
    }

    // 上次自检异常中断可能留下同名特征：先清掉，让自检可重复跑
    {
        QJsonObject stale;
        stale.insert(QStringLiteral("documentId"), QStringLiteral("demo-adapter"));
        stale.insert(QStringLiteral("expectedRevision"), tree.value(QStringLiteral("revision")).toInt());
        stale.insert(QStringLiteral("actor"), QStringLiteral("manual"));
        stale.insert(QStringLiteral("operation"), QStringLiteral("deleteFeature"));
        stale.insert(QStringLiteral("featureId"), QStringLiteral("f-selftest-hole"));
        int staleStatus = 0;
        QString staleError;
        requestSync("POST", QStringLiteral("/v1/operations"), stale, &staleStatus, &staleError);
        if (staleStatus == 200) return runCreateFeatureSelfTest(base, withHole, restored, error);
    }

    QJsonObject hole; hole.insert(QStringLiteral("id"), QStringLiteral("f-selftest-hole"));
    hole.insert(QStringLiteral("type"), QStringLiteral("holes"));
    hole.insert(QStringLiteral("name"), QStringLiteral("自检孔 Ø4"));
    QJsonObject holeParams;
    holeParams.insert(QStringLiteral("diameter"), 4.0);
    holeParams.insert(QStringLiteral("depth"), QStringLiteral("through"));
    holeParams.insert(QStringLiteral("positions"), QJsonArray{QJsonArray{0.0, 0.0}});
    hole.insert(QStringLiteral("params"), holeParams);

    QJsonObject create;
    create.insert(QStringLiteral("documentId"), QStringLiteral("demo-adapter"));
    create.insert(QStringLiteral("expectedRevision"), tree.value(QStringLiteral("revision")).toInt());
    create.insert(QStringLiteral("actor"), QStringLiteral("manual"));
    create.insert(QStringLiteral("operation"), QStringLiteral("createFeature"));
    create.insert(QStringLiteral("feature"), hole);
    const QJsonObject created = requestSync("POST", QStringLiteral("/v1/operations"), create, &status, &localError);
    if (status != 200) {
        if (error) *error = tr("新建特征失败（HTTP %1）：%2").arg(status).arg(created.value(QStringLiteral("message")).toString(localError));
        return false;
    }
    const double withHoleVolume = volumeOf(created);
    // Ø4 通孔按当前板厚算：π·r²·t（不要写死 12——板厚可能刚被改过）
    double thickness = 0;
    for (const auto &fv : tree.value(QStringLiteral("doc")).toObject().value(QStringLiteral("features")).toArray()) {
        const QJsonObject f = fv.toObject();
        if (f.value(QStringLiteral("id")).toString() == QStringLiteral("f-body")) {
            thickness = f.value(QStringLiteral("params")).toObject().value(QStringLiteral("height")).toDouble();
        }
    }
    if (thickness <= 0) {
        if (error) *error = QStringLiteral("找不到板厚（f-body.height）");
        return false;
    }
    const double expectedDelta = 3.141592653589793 * 4.0 * thickness;
    if (qAbs((baseVolume - withHoleVolume) - expectedDelta) > 2.0) {
        if (error) *error = tr("加孔后体积减少 %1 mm³，期望约 %2").arg(baseVolume - withHoleVolume).arg(expectedDelta, 0, 'f', 1);
        return false;
    }

    QJsonObject del;
    del.insert(QStringLiteral("documentId"), QStringLiteral("demo-adapter"));
    del.insert(QStringLiteral("expectedRevision"), created.value(QStringLiteral("revision")).toInt());
    del.insert(QStringLiteral("actor"), QStringLiteral("manual"));
    del.insert(QStringLiteral("operation"), QStringLiteral("deleteFeature"));
    del.insert(QStringLiteral("featureId"), QStringLiteral("f-selftest-hole"));
    const QJsonObject deleted = requestSync("POST", QStringLiteral("/v1/operations"), del, &status, &localError);
    if (status != 200) {
        if (error) *error = tr("删除自检孔失败（HTTP %1）：%2").arg(status).arg(localError);
        return false;
    }
    const double restoredVolume = volumeOf(deleted);
    if (qAbs(restoredVolume - baseVolume) > 0.5) {
        if (error) *error = tr("删孔后体积没复原：%1 vs %2").arg(restoredVolume).arg(baseVolume);
        return false;
    }
    if (withHole) *withHole = withHoleVolume;
    if (restored) *restored = restoredVolume;
    return true;
}

bool MainWindow::runFeatureOpsSelfTest(const QString &base, double *suppressedVolume, double *restoredVolume, QString *error) {
    m_serviceBase = base;
    int status = 0;
    QString localError;
    const QJsonObject tree = requestSync("GET", QStringLiteral("/v1/tree"), {}, &status, &localError);
    if (status != 200) {
        if (error) *error = tr("读取特征树失败（HTTP %1）").arg(status);
        return false;
    }
    const auto volumeOf = [](const QJsonObject &envelope) {
        return envelope.value(QStringLiteral("geometry")).toObject().value(QStringLiteral("volumeMm3")).toDouble();
    };
    const double baseVolume = volumeOf(tree);
    if (baseVolume <= 0) {
        if (error) *error = QStringLiteral("服务端没返回几何（缺 sidecar？）");
        return false;
    }

    QJsonObject suppress;
    suppress.insert(QStringLiteral("documentId"), QStringLiteral("demo-adapter"));
    suppress.insert(QStringLiteral("expectedRevision"), tree.value(QStringLiteral("revision")).toInt());
    suppress.insert(QStringLiteral("actor"), QStringLiteral("manual"));
    suppress.insert(QStringLiteral("operation"), QStringLiteral("setSuppressed"));
    suppress.insert(QStringLiteral("featureId"), QStringLiteral("f-holes-out"));
    suppress.insert(QStringLiteral("suppressed"), true);
    const QJsonObject suppressed = requestSync("POST", QStringLiteral("/v1/operations"), suppress, &status, &localError);
    if (status != 200) {
        if (error) *error = tr("压缩失败（HTTP %1）：%2").arg(status).arg(localError);
        return false;
    }
    const double suppressedVol = volumeOf(suppressed);
    if (!(suppressedVol > baseVolume + 100)) {
        if (error) *error = tr("压缩孔阵列后体积没变大：%1 → %2").arg(baseVolume).arg(suppressedVol);
        return false;
    }

    // 删除被孔/沉头引用的基体：服务端必须 409 REFERENCE_IN_USE（界面不能只弹个“失败”了事）
    QJsonObject del;
    del.insert(QStringLiteral("documentId"), QStringLiteral("demo-adapter"));
    del.insert(QStringLiteral("expectedRevision"), suppressed.value(QStringLiteral("revision")).toInt());
    del.insert(QStringLiteral("actor"), QStringLiteral("manual"));
    del.insert(QStringLiteral("operation"), QStringLiteral("deleteFeature"));
    del.insert(QStringLiteral("featureId"), QStringLiteral("f-body"));
    const QJsonObject deleted = requestSync("POST", QStringLiteral("/v1/operations"), del, &status, &localError);
    if (status != 409 || deleted.value(QStringLiteral("error")).toString() != QStringLiteral("REFERENCE_IN_USE")) {
        if (error) *error = tr("删除被引用基体应返回 409 REFERENCE_IN_USE，实际 HTTP %1 / %2")
                                .arg(status).arg(deleted.value(QStringLiteral("message")).toString(localError));
        return false;
    }
    if (deleted.value(QStringLiteral("message")).toString().isEmpty()) {
        if (error) *error = QStringLiteral("REFERENCE_IN_USE 没说明引用方");
        return false;
    }

    QJsonObject restore = suppress;
    restore.insert(QStringLiteral("expectedRevision"), suppressed.value(QStringLiteral("revision")).toInt());
    restore.insert(QStringLiteral("suppressed"), false);
    const QJsonObject restored = requestSync("POST", QStringLiteral("/v1/operations"), restore, &status, &localError);
    if (status != 200) {
        if (error) *error = tr("解除压缩失败（HTTP %1）：%2").arg(status).arg(localError);
        return false;
    }
    const double restoredVol = volumeOf(restored);
    if (qAbs(restoredVol - baseVolume) > 0.5) {
        if (error) *error = tr("解除压缩后体积没复原：%1 vs %2").arg(restoredVol).arg(baseVolume);
        return false;
    }
    if (suppressedVolume) *suppressedVolume = suppressedVol;
    if (restoredVolume) *restoredVolume = restoredVol;
    return true;
}

bool MainWindow::runHistorySelfTest(const QString &base, int *undoRevision, int *redoRevision, double *height, QString *error) {
    m_serviceBase = base;
    int status = 0;
    QString localError;
    const QJsonObject tree = requestSync("GET", QStringLiteral("/v1/tree"), {}, &status, &localError);
    if (status != 200) {
        if (error) *error = tr("读取特征树失败（HTTP %1）：%2").arg(status).arg(localError);
        return false;
    }
    const auto heightOf = [](const QJsonObject &envelope) -> double {
        const QJsonArray features = envelope.value(QStringLiteral("doc")).toObject().value(QStringLiteral("features")).toArray();
        for (const auto &fv : features) {
            const QJsonObject f = fv.toObject();
            if (f.value(QStringLiteral("id")).toString() == QStringLiteral("f-body")) {
                return f.value(QStringLiteral("params")).toObject().value(QStringLiteral("height")).toDouble();
            }
        }
        return -1;
    };
    const int startRevision = tree.value(QStringLiteral("revision")).toInt();
    const double startHeight = heightOf(tree);
    if (startHeight <= 0) {
        if (error) *error = QStringLiteral("种子树里找不到 f-body/height");
        return false;
    }

    QJsonObject patch; patch.insert(QStringLiteral("height"), startHeight + 3);
    QJsonObject edit;
    edit.insert(QStringLiteral("documentId"), QStringLiteral("demo-adapter"));
    edit.insert(QStringLiteral("expectedRevision"), startRevision);
    edit.insert(QStringLiteral("actor"), QStringLiteral("manual"));
    edit.insert(QStringLiteral("operation"), QStringLiteral("updateFeatureParams"));
    edit.insert(QStringLiteral("featureId"), QStringLiteral("f-body"));
    edit.insert(QStringLiteral("patch"), patch);
    const QJsonObject edited = requestSync("POST", QStringLiteral("/v1/operations"), edit, &status, &localError);
    if (status != 200) {
        if (error) *error = tr("写入失败（HTTP %1）：%2").arg(status).arg(localError);
        return false;
    }

    QJsonObject undoBody;
    undoBody.insert(QStringLiteral("documentId"), QStringLiteral("demo-adapter"));
    undoBody.insert(QStringLiteral("expectedRevision"), edited.value(QStringLiteral("revision")).toInt());
    undoBody.insert(QStringLiteral("actor"), QStringLiteral("manual"));
    undoBody.insert(QStringLiteral("steps"), 1);
    const QJsonObject undone = requestSync("POST", QStringLiteral("/v1/undo"), undoBody, &status, &localError);
    if (status != 200) {
        if (error) *error = tr("撤销失败（HTTP %1）：%2").arg(status).arg(localError);
        return false;
    }
    if (heightOf(undone) != startHeight) {
        if (error) *error = tr("撤销后高度不是 %1，而是 %2").arg(startHeight).arg(heightOf(undone));
        return false;
    }
    if (undone.value(QStringLiteral("redoDepth")).toInt() < 1) {
        if (error) *error = QStringLiteral("撤销后 redoDepth 应该是 1");
        return false;
    }

    QJsonObject redoBody;
    redoBody.insert(QStringLiteral("documentId"), QStringLiteral("demo-adapter"));
    redoBody.insert(QStringLiteral("expectedRevision"), undone.value(QStringLiteral("revision")).toInt());
    redoBody.insert(QStringLiteral("actor"), QStringLiteral("manual"));
    redoBody.insert(QStringLiteral("steps"), 1);
    const QJsonObject redone = requestSync("POST", QStringLiteral("/v1/redo"), redoBody, &status, &localError);
    if (status != 200) {
        if (error) *error = tr("重做失败（HTTP %1）：%2").arg(status).arg(localError);
        return false;
    }
    if (heightOf(redone) != startHeight + 3) {
        if (error) *error = tr("重做后高度不是 %1，而是 %2").arg(startHeight + 3).arg(heightOf(redone));
        return false;
    }
    if (undoRevision) *undoRevision = undone.value(QStringLiteral("revision")).toInt();
    if (redoRevision) *redoRevision = redone.value(QStringLiteral("revision")).toInt();
    if (height) *height = heightOf(redone);
    return true;
}

void MainWindow::refreshNow() { loadTree(); }

void MainWindow::startAutoRefresh(int intervalMs) {
    if (!m_pollTimer) {
        m_pollTimer = new QTimer(this);
        connect(m_pollTimer, &QTimer::timeout, this, &MainWindow::loadTree);
    }
    m_pollTimer->start(intervalMs);
}

void MainWindow::startEventStream() {
    if (m_eventStream) return;
    QNetworkRequest req{QUrl(m_serviceBase + QStringLiteral("/v1/events"))};
    req.setRawHeader("Accept", "text/event-stream");
    req.setTransferTimeout(0); // 长连接，不能让 8s 超时把流掐了
    m_eventStream = m_net->get(req);
    connect(m_eventStream, &QNetworkReply::readyRead, this, &MainWindow::onEventStreamReadyRead);
    connect(m_eventStream, &QNetworkReply::finished, this, &MainWindow::onEventStreamFinished);
}

void MainWindow::onEventStreamReadyRead() {
    if (!m_eventStream) return;
    m_eventBuffer.append(m_eventStream->readAll());
    int boundary = m_eventBuffer.indexOf("\n\n");
    while (boundary >= 0) {
        const QByteArray event = m_eventBuffer.left(boundary);
        m_eventBuffer.remove(0, boundary + 2);
        if (event.contains("\"hello\":true")) {
            m_sseConnected = true;
            m_statusLink->setText(tr("链路：SSE 已连接"));
        }
        // 只认 revision：具体内容一律重新 GET /v1/tree 拿，避免把事件当权威快照
        const int revisionIndex = event.indexOf("\"revision\":");
        if (revisionIndex >= 0 && !event.contains("\"hello\":true")) {
            int value = 0;
            int cursor = revisionIndex + 11;
            while (cursor < event.size() && (event.at(cursor) < '0' || event.at(cursor) > '9')) ++cursor;
            while (cursor < event.size() && event.at(cursor) >= '0' && event.at(cursor) <= '9') {
                value = value * 10 + (event.at(cursor) - '0');
                ++cursor;
            }
            if (value != m_envelope.value(QStringLiteral("revision")).toInt()) {
                emit envelopeRefreshed(value);
                loadTree();
            } else {
                emit envelopeRefreshed(value);
            }
        }
        boundary = m_eventBuffer.indexOf("\n\n");
    }
}

void MainWindow::onEventStreamFinished() {
    if (m_eventStream) {
        m_eventStream->deleteLater();
        m_eventStream = nullptr;
    }
    const bool wasConnected = m_sseConnected;
    m_sseConnected = false;
    m_statusLink->setText(tr("链路：轮询兜底（SSE 断开）"));
    if (wasConnected) statusBar()->showMessage(tr("SSE 断开，已回退到轮询，3 秒后重连"), 4000);
    // 断线重连：3 秒后再订阅一次；轮询仍在跑，界面不会停更
    QTimer::singleShot(3000, this, [this]() { startEventStream(); });
}

bool MainWindow::runSseSelfTest(const QString &base, int *revision, QString *error) {
    m_serviceBase = base;
    startEventStream();
    QEventLoop loop;
    int seenRevision = -1;
    bool connected = false;
    bool changed = false;
    QObject::connect(this, &MainWindow::envelopeRefreshed, &loop, [&](int rev) {
        if (!connected) {
            connected = true;
            seenRevision = rev;
            return;
        }
        if (rev != seenRevision) {
            changed = true;
            if (revision) *revision = rev;
            loop.quit();
        }
    });
    QTimer::singleShot(15'000, &loop, &QEventLoop::quit);
    // 先无条件读一次，拿到当前版本（SSE 的 hello 也会触发 envelopeRefreshed）
    loadTree();
    loop.exec();
    if (!connected) {
        if (error) *error = QStringLiteral("15 秒内没有收到任何 revision（SSE 或 GET 都没通）");
        return false;
    }
    if (!changed) {
        if (error) *error = QStringLiteral("SSE 连上但没收到外部变更事件");
        return false;
    }
    return true;
}

void MainWindow::loadTree() {
    QNetworkRequest req(QUrl(m_serviceBase + QStringLiteral("/v1/tree")));
    // 服务没起来时不要让界面无限等；8 秒后按连接失败处理
    req.setTransferTimeout(8000);
    QNetworkReply *reply = m_net->get(req);
    connect(reply, &QNetworkReply::finished, this, &MainWindow::onTreeReply);
}

void MainWindow::onTreeReply() {
    auto *reply = qobject_cast<QNetworkReply *>(sender());
    if (!reply) return;
    reply->deleteLater();
    if (reply->error() != QNetworkReply::NoError) {
        m_statusRevision->setText(tr("服务未连接：%1").arg(reply->errorString()));
        return;
    }
    refreshTree(readReply(reply));
}

void MainWindow::undoOnce() {
    postHistory("undo");
}

void MainWindow::redoOnce() {
    postHistory("redo");
}

void MainWindow::postHistory(const QString &kind) {
    const int revision = m_envelope.value(QStringLiteral("revision")).toInt();
    QJsonObject body;
    body.insert(QStringLiteral("documentId"), QStringLiteral("demo-adapter"));
    body.insert(QStringLiteral("expectedRevision"), revision);
    body.insert(QStringLiteral("actor"), QStringLiteral("manual"));
    body.insert(QStringLiteral("steps"), 1);
    QNetworkRequest req(QUrl(m_serviceBase + QStringLiteral("/v1/") + kind));
    req.setHeader(QNetworkRequest::ContentTypeHeader, QStringLiteral("application/json"));
    req.setTransferTimeout(8000);
    QNetworkReply *reply = m_net->post(req, QJsonDocument(body).toJson());
    connect(reply, &QNetworkReply::finished, this, [this, reply, kind]() {
        reply->deleteLater();
        const QJsonObject payload = readReply(reply);
        if (reply->error() != QNetworkReply::NoError || payload.contains(QStringLiteral("error"))) {
            const QString message = payload.value(QStringLiteral("message")).toString(reply->errorString());
            statusBar()->showMessage(tr("%1失败：%2").arg(kind == QStringLiteral("undo") ? tr("撤销") : tr("重做"), message), 6000);
            // 失败（含 409 版本过期）一律重新读一次，绝不在本地硬套
            refreshNow();
            return;
        }
        refreshTree(payload);
        statusBar()->showMessage(tr("%1成功 → 版本 r%2").arg(kind == QStringLiteral("undo") ? tr("撤销") : tr("重做"))
                                     .arg(payload.value(QStringLiteral("revision")).toInt()), 4000);
    });
}

void MainWindow::refreshTree(const QJsonObject &envelope) {
    m_envelope = envelope;
    const QJsonObject doc = envelope.value(QStringLiteral("doc")).toObject();
    const QJsonArray features = doc.value(QStringLiteral("features")).toArray();
    m_tree->clear();
    const int revisionFromEnvelope = envelope.value(QStringLiteral("revision")).toInt();
    auto *root = new QTreeWidgetItem(m_tree, {tr("%1 · 版本 r%2")
                                                  .arg(envelope.value(QStringLiteral("documentId")).toString())
                                                  .arg(revisionFromEnvelope)});
    root->setToolTip(0, tr("文档根节点：点特征看参数；撤销/重做走服务端，版本号只由服务端推进"));
    auto *part = new QTreeWidgetItem(root, {tr("零件：%1").arg(doc.value(QStringLiteral("name")).toString(QStringLiteral("未命名"))) });
    for (const auto &fv : features) {
        QJsonObject f = fv.toObject();
        const QJsonObject params = f.value(QStringLiteral("params")).toObject();
        // 名称后面带一句关键尺寸，树里不用展开就能看出这个特征是什么
        QString summary = f.value(QStringLiteral("name")).toString();
        const bool suppressed = f.value(QStringLiteral("suppressed")).toBool();
        if (suppressed) summary += tr("（已压缩）");
        else if (f.value(QStringLiteral("type")).toString() == QStringLiteral("body")) {
            summary += QStringLiteral("  %1×%2×%3").arg(params.value(QStringLiteral("length")).toDouble())
                           .arg(params.value(QStringLiteral("width")).toDouble())
                           .arg(params.value(QStringLiteral("height")).toDouble());
        } else if (params.contains(QStringLiteral("diameter"))) {
            summary += QStringLiteral("  Ø%1").arg(params.value(QStringLiteral("diameter")).toDouble());
        } else if (params.contains(QStringLiteral("radius"))) {
            summary += QStringLiteral("  R%1").arg(params.value(QStringLiteral("radius")).toDouble());
        }
        auto *item = new QTreeWidgetItem(part, {summary});
        item->setData(0, Qt::UserRole, f.value(QStringLiteral("id")).toString());
        item->setToolTip(0, QString::fromUtf8(QJsonDocument(params).toJson(QJsonDocument::Compact)));
        if (suppressed) item->setForeground(0, Qt::gray);
    }
    m_tree->expandAll();
    m_undoAction->setEnabled(envelope.value(QStringLiteral("undoDepth")).toInt() > 0);
    m_redoAction->setEnabled(envelope.value(QStringLiteral("redoDepth")).toInt() > 0);
    const int revision = envelope.value(QStringLiteral("revision")).toInt();
    m_statusRevision->setText(tr("版本 r%1").arg(revision));
    // 真实几何（build123d sidecar 算出）：体积/质量/包围盒，没有就如实说没有
    const QJsonObject geometryInfo = envelope.value(QStringLiteral("geometry")).toObject();
    if (geometryInfo.isEmpty()) {
        m_statusGeometry->setText(tr("几何：未接 sidecar"));
    } else {
        const QJsonObject bbox = geometryInfo.value(QStringLiteral("bboxMm")).toObject();
        m_statusGeometry->setText(
            QStringLiteral("%1 · 体积 %2 mm³ · 质量 %3 kg · %4×%5×%6 mm · %7")
                .arg(geometryInfo.value(QStringLiteral("materialLabel")).toString(QStringLiteral("钢")))
                .arg(geometryInfo.value(QStringLiteral("volumeMm3")).toDouble(), 0, 'f', 1)
                .arg(geometryInfo.value(QStringLiteral("massKg")).toDouble(), 0, 'f', 4)
                .arg(bbox.value(QStringLiteral("x")).toDouble())
                .arg(bbox.value(QStringLiteral("y")).toDouble())
                .arg(bbox.value(QStringLiteral("z")).toDouble())
                .arg(geometryInfo.value(QStringLiteral("kernel")).toString()));
        const QString materialKey = doc.value(QStringLiteral("material")).toString(QStringLiteral("steel"));
        for (auto it = m_materialActions.begin(); it != m_materialActions.end(); ++it) {
            it.value()->setChecked(it.key() == materialKey);
        }
    }
    // 几何只在版本变化时重新拉，避免每次 1.5s 轮询都下一遍 STL
    if (geometryInfo.isEmpty()) {
        m_viewport->ensureRevision(-1, QString());
    } else {
        m_viewport->ensureRevision(revisionFromEnvelope, m_serviceBase + QStringLiteral("/v1/geometry.stl"));
    }
    emit envelopeRefreshed(revision);
}

void MainWindow::onTreeItemSelected(QTreeWidgetItem *item, int) {
    if (!item) return;
    const QString id = item->data(0, Qt::UserRole).toString();
    if (id.isEmpty()) return;
    m_selectedFeatureId = id;
    const QJsonArray features = m_envelope.value(QStringLiteral("doc")).toObject().value(QStringLiteral("features")).toArray();
    for (const auto &fv : features) {
        QJsonObject f = fv.toObject();
        if (f.value(QStringLiteral("id")).toString() == id) { refreshPanel(f); return; }
    }
}

void MainWindow::refreshPanel(const QJsonObject &feature) {
    m_updatingPanel = true;
    const QJsonObject params = feature.value(QStringLiteral("params")).toObject();
    m_panel->setRowCount(0);
    int row = 0;
    for (auto it = params.begin(); it != params.end(); ++it) {
        if (it.value().isArray() || it.value().isObject()) continue; // 孔位数组等复杂值 v1 不在表格里直改
        m_panel->insertRow(row);
        m_panel->setItem(row, 0, new QTableWidgetItem(it.key()));
        QString v = it.value().isString() ? it.value().toString()
                    : it.value().isBool() ? (it.value().toBool() ? QStringLiteral("true") : QStringLiteral("false"))
                    : QString::number(it.value().toDouble());
        auto *valueItem = new QTableWidgetItem(v);
        valueItem->setData(Qt::UserRole, it.key());
        if (!isEditableParam(it.key())) {
            // 白名单外（centered / edges / depth 等）只读展示，避免"改了就报错"
            valueItem->setFlags(valueItem->flags() & ~Qt::ItemIsEditable);
            valueItem->setToolTip(tr("该字段不通过属性面板直接改（服务端只接受长度/直径/深度/半径等数值）"));
            valueItem->setForeground(QColor(0x9a, 0xa3, 0xb2));
        }
        m_panel->setItem(row, 1, valueItem);
        ++row;
    }
    m_updatingPanel = false;
}

void MainWindow::onPropertyCellChanged(int row, int) {
    if (m_updatingPanel || m_selectedFeatureId.isEmpty()) return;
    QTableWidgetItem *keyItem = m_panel->item(row, 0);
    QTableWidgetItem *valueItem = m_panel->item(row, 1);
    if (!keyItem || !valueItem) return;
    if (!isEditableParam(keyItem->text())) {
        // 兜底：即使有别的路径触发 cellChanged，也不要发一个注定 422 的补丁
        refreshPanelFromEnvelope();
        statusBar()->showMessage(tr("「%1」不支持在属性面板直接修改").arg(keyItem->text()), 4000);
        return;
    }
    bool ok = false;
    const double num = valueItem->text().toDouble(&ok);
    QJsonObject patch;
    patch.insert(keyItem->text(), ok ? QJsonValue(num) : QJsonValue(valueItem->text()));
    QJsonObject body;
    body.insert(QStringLiteral("documentId"), QStringLiteral("demo-adapter"));
    body.insert(QStringLiteral("expectedRevision"), m_envelope.value(QStringLiteral("revision")).toInt());
    body.insert(QStringLiteral("actor"), QStringLiteral("manual"));
    body.insert(QStringLiteral("operation"), QStringLiteral("updateFeatureParams"));
    body.insert(QStringLiteral("featureId"), m_selectedFeatureId);
    body.insert(QStringLiteral("patch"), patch);
    postOperation(body);
}

void MainWindow::createFeatureDialog() {
    FeatureDialog dialog(this);
    if (dialog.exec() != QDialog::Accepted) return;
    QJsonObject body;
    body.insert(QStringLiteral("documentId"), QStringLiteral("demo-adapter"));
    body.insert(QStringLiteral("expectedRevision"), m_envelope.value(QStringLiteral("revision")).toInt());
    body.insert(QStringLiteral("actor"), QStringLiteral("manual"));
    body.insert(QStringLiteral("operation"), QStringLiteral("createFeature"));
    body.insert(QStringLiteral("feature"), dialog.feature());
    postOperation(body);
}

void MainWindow::showTreeMenu(const QPoint &pos) {
    QTreeWidgetItem *item = m_tree->itemAt(pos);
    if (!item) return;
    const QString id = item->data(0, Qt::UserRole).toString();
    if (id.isEmpty()) {
        statusBar()->showMessage(tr("这是文档根或零件节点，右键请选具体特征"), 3000);
        return;
    }
    m_selectedFeatureId = id;
    onTreeItemSelected(item, 0);

    bool suppressed = false;
    const QJsonArray features = m_envelope.value(QStringLiteral("doc")).toObject().value(QStringLiteral("features")).toArray();
    for (const auto &fv : features) {
        const QJsonObject f = fv.toObject();
        if (f.value(QStringLiteral("id")).toString() == id) suppressed = f.value(QStringLiteral("suppressed")).toBool();
    }

    QMenu menu(this);
    QAction *toggle = menu.addAction(suppressed ? tr("解除压缩") : tr("压缩"));
    QAction *remove = menu.addAction(tr("删除特征（可撤销）"));
    QAction *chosen = menu.exec(m_tree->viewport()->mapToGlobal(pos));
    if (!chosen) return;

    QJsonObject body;
    body.insert(QStringLiteral("documentId"), QStringLiteral("demo-adapter"));
    body.insert(QStringLiteral("expectedRevision"), m_envelope.value(QStringLiteral("revision")).toInt());
    body.insert(QStringLiteral("actor"), QStringLiteral("manual"));
    body.insert(QStringLiteral("featureId"), id);
    if (chosen == toggle) {
        body.insert(QStringLiteral("operation"), QStringLiteral("setSuppressed"));
        body.insert(QStringLiteral("suppressed"), !suppressed);
    } else if (chosen == remove) {
        body.insert(QStringLiteral("operation"), QStringLiteral("deleteFeature"));
    }
    postOperation(body);
}

void MainWindow::postOperation(const QJsonObject &body) {
    QNetworkRequest req(QUrl(m_serviceBase + QStringLiteral("/v1/operations")));
    req.setHeader(QNetworkRequest::ContentTypeHeader, QStringLiteral("application/json"));
    req.setTransferTimeout(8000);
    QNetworkReply *reply = m_net->post(req, QJsonDocument(body).toJson());
    connect(reply, &QNetworkReply::finished, this, &MainWindow::onOperationReply);
}

void MainWindow::onOperationReply() {
    auto *reply = qobject_cast<QNetworkReply *>(sender());
    if (!reply) return;
    reply->deleteLater();
    QJsonObject obj = readReply(reply);
    if (reply->error() == QNetworkReply::NoError) { refreshTree(obj); return; }
    if (obj.value(QStringLiteral("error")).toString() == QStringLiteral("CONFLICT_STALE_REVISION")) {
        showConflict(obj.value(QStringLiteral("current")).toObject());
        return;
    }
    QMessageBox::warning(this, tr("保存失败"),
        obj.value(QStringLiteral("message")).toString());
    loadTree(); // 失败后以服务端版本刷新，禁止在旧版本上继续编辑
}

QJsonObject MainWindow::requestSync(const QByteArray &verb, const QString &path, const QJsonObject &body,
                                   int *status, QString *error, int timeoutMs) {
    QNetworkRequest req(QUrl(m_serviceBase + path));
    req.setHeader(QNetworkRequest::ContentTypeHeader, QStringLiteral("application/json"));
    req.setTransferTimeout(timeoutMs);
    QNetworkReply *reply = verb == "GET"
        ? m_net->get(req)
        : m_net->post(req, body.isEmpty() ? QByteArray("{}") : QJsonDocument(body).toJson());
    QEventLoop loop;
    QTimer timer;
    timer.setSingleShot(true);
    connect(&timer, &QTimer::timeout, &loop, &QEventLoop::quit);
    connect(reply, &QNetworkReply::finished, &loop, &QEventLoop::quit);
    timer.start(timeoutMs + 1000);
    loop.exec();
    if (!reply->isFinished()) {
        reply->abort();
        reply->deleteLater();
        if (error) *error = tr("请求超时：%1").arg(path);
        if (status) *status = 0;
        return {};
    }
    if (status) *status = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
    const QJsonObject parsed = readReply(reply);
    if (reply->error() != QNetworkReply::NoError && error) *error = reply->errorString();
    reply->deleteLater();
    return parsed;
}

bool MainWindow::runSelfTest(const QString &base, int *revision, double *height, QString *error) {
    m_serviceBase = base;
    int status = 0;
    QString localError;
    const QJsonObject tree = requestSync("GET", QStringLiteral("/v1/tree"), {}, &status, &localError);
    if (status != 200) {
        if (error) *error = tr("读取特征树失败（HTTP %1）：%2").arg(status).arg(localError);
        return false;
    }
    const int rev = tree.value(QStringLiteral("revision")).toInt();
    const QJsonArray features = tree.value(QStringLiteral("doc")).toObject().value(QStringLiteral("features")).toArray();
    double current = -1;
    for (const auto &fv : features) {
        const QJsonObject f = fv.toObject();
        if (f.value(QStringLiteral("id")).toString() == QStringLiteral("f-body")) {
            current = f.value(QStringLiteral("params")).toObject().value(QStringLiteral("height")).toDouble();
        }
    }
    if (current <= 0) {
        if (error) *error = QStringLiteral("种子树里找不到 f-body/height");
        return false;
    }
    QJsonObject patch; patch.insert(QStringLiteral("height"), current + 1);
    QJsonObject body;
    body.insert(QStringLiteral("documentId"), QStringLiteral("demo-adapter"));
    body.insert(QStringLiteral("expectedRevision"), rev);
    body.insert(QStringLiteral("actor"), QStringLiteral("manual"));
    body.insert(QStringLiteral("operation"), QStringLiteral("updateFeatureParams"));
    body.insert(QStringLiteral("featureId"), QStringLiteral("f-body"));
    body.insert(QStringLiteral("patch"), patch);
    const QJsonObject edited = requestSync("POST", QStringLiteral("/v1/operations"), body, &status, &localError);
    if (status != 200) {
        if (error) *error = tr("写入失败（HTTP %1）：%2").arg(status).arg(edited.value(QStringLiteral("message")).toString(localError));
        return false;
    }
    const int nextRev = edited.value(QStringLiteral("revision")).toInt();
    if (nextRev != rev + 1) {
        if (error) *error = tr("版本未按预期 +1：%1 → %2").arg(rev).arg(nextRev);
        return false;
    }
    // 再读一次，确认服务端真的落了这次修改（不是本地回显）
    const QJsonObject again = requestSync("GET", QStringLiteral("/v1/tree"), {}, &status, &localError);
    if (status != 200 || again.value(QStringLiteral("revision")).toInt() != nextRev) {
        if (error) *error = tr("回读版本不一致（HTTP %1）").arg(status);
        return false;
    }
    const QJsonArray features2 = again.value(QStringLiteral("doc")).toObject().value(QStringLiteral("features")).toArray();
    double after = -1;
    for (const auto &fv : features2) {
        const QJsonObject f = fv.toObject();
        if (f.value(QStringLiteral("id")).toString() == QStringLiteral("f-body")) {
            after = f.value(QStringLiteral("params")).toObject().value(QStringLiteral("height")).toDouble();
        }
    }
    if (after != current + 1) {
        if (error) *error = tr("回读高度不符：期望 %1，实际 %2").arg(current + 1).arg(after);
        return false;
    }
    if (revision) *revision = nextRev;
    if (height) *height = after;
    return true;
}

void MainWindow::refreshPanelFromEnvelope() {
    if (m_selectedFeatureId.isEmpty()) return;
    const QJsonArray features = m_envelope.value(QStringLiteral("doc")).toObject()
                                    .value(QStringLiteral("features")).toArray();
    for (const auto &fv : features) {
        const QJsonObject f = fv.toObject();
        if (f.value(QStringLiteral("id")).toString() == m_selectedFeatureId) { refreshPanel(f); return; }
    }
}

void MainWindow::showConflict(const QJsonObject &current) {
    QMessageBox::warning(this, tr("版本冲突"),
        tr("你的版本已过期，服务端当前版本为 r%1。请重新读取后再改，不要直接覆盖。")
            .arg(current.value(QStringLiteral("revision")).toInt()));
    if (!current.isEmpty()) refreshTree(current);
    else loadTree();
}
