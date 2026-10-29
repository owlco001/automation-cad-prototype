// Qt 客户端壳子 v0.1 实现。注意：本文件只用 Qt Widgets + Network，
// 不含 OCCT 头文件；视口是占位 QWidget，OCCT AIS 接入是后续里程碑。
#include "MainWindow.h"

#include <QGuiApplication>
#include "FeatureDialog.h"
#include "MachineCaseDialog.h"

#include <QAction>
#include <QComboBox>
#include <QDialogButtonBox>
#include <QDoubleSpinBox>
#include <QApplication>
#include <QCoreApplication>
#include <QDir>
#include <QEventLoop>
#include <QInputDialog>
#include <QKeyEvent>
#include <QProcess>
#include <QDrag>
#include <QDockWidget>
#include <QFileDialog>
#include <QListWidget>
#include <QMimeData>
#include <QTimer>
#include <QFileInfo>
#include <QFormLayout>
#include <QHeaderView>
#include <QLabel>
#include <QPushButton>
#include <QTableWidget>
#include <QTextStream>
#include <QVBoxLayout>
#include <QKeyEvent>
#include <QColor>
#include <QApplication>
#include <QCoreApplication>
#include <QDir>
#include <QEventLoop>
#include <QKeyEvent>
#include <QProcess>
#include <QApplication>
#include <QCoreApplication>
#include <QDir>
#include <QEventLoop>
#include <QKeyEvent>
#include <QProcess>
#include <QFileDialog>
#include <QFileInfo>
#include <QFormLayout>
#include <QHeaderView>
#include <QLabel>
#include <QPushButton>
#include <QTableWidget>
#include <QTextStream>
#include <QVBoxLayout>
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
#include <QPushButton>
#include <QTableWidget>
#include <QTextStream>
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
    fileMenu->addAction(tr("刷新特征树"), this, &MainWindow::refreshNow);
    fileMenu->addSeparator();
    fileMenu->addAction(tr("打开装配…"), this, [this]() {
        bool ok = false;
        const QString id = QInputDialog::getText(this, tr("打开装配"), tr("装配 id（如 asm-demo）："),
                                                 QLineEdit::Normal, m_assemblyId, &ok);
        if (ok && !id.trimmed().isEmpty()) openAssembly(id.trimmed());
    });
    fileMenu->addAction(tr("退出装配视图"), this, [this]() { m_assemblyId.clear(); refreshNow(); });
    fileMenu->addSeparator();
    fileMenu->addAction(tr("导出 STL…"), this, &MainWindow::exportStlDialog);
    fileMenu->addAction(tr("导出整机示意 STL…"), this, &MainWindow::exportMachineStlDialog);
    fileMenu->addAction(tr("从 brief 生成整机方案…"), this, &MainWindow::designMachineDialog);
    fileMenu->addAction(tr("保存整机方案…"), this, &MainWindow::saveMachineCaseDialog);
    fileMenu->addAction(tr("打开整机方案…"), this, [this]() {
        const QString path = QFileDialog::getOpenFileName(this, tr("打开整机方案"), QString(),
                                                          tr("整机方案 (*.json)"));
        if (path.isEmpty()) return;
        QJsonObject document;
        QString error;
        if (!MachineCaseDialog::loadFile(path, &document, &error)) {
            QMessageBox::warning(this, tr("打不开整机方案"), error);
            return;
        }
        m_lastBrief = document.value(QStringLiteral("brief")).toString();
        m_lastMoves.clear();
        statusBar()->showMessage(tr("整机方案：%1").arg(MachineCaseDialog::summarize(document)), 15000);
        int shapes = 0;
        QString geometryError;
        if (!renderMachineGeometry(document, &shapes, &geometryError)) {
            statusBar()->showMessage(tr("方案已打开，但 3D 示意没画出来：%1").arg(geometryError), 20000);
        }
        showMachineCase(document);
    });
    auto *viewMenu = menuBar()->addMenu(tr("视图"));
    viewMenu->addAction(tr("等轴测"), this, [this]() { setViewportStandardView(0); });
    viewMenu->addAction(tr("正视"), this, [this]() { setViewportStandardView(1); });
    viewMenu->addAction(tr("俯视"), this, [this]() { setViewportStandardView(2); });
    viewMenu->addAction(tr("右视"), this, [this]() { setViewportStandardView(3); });
    viewMenu->addSeparator();
    viewMenu->addAction(tr("适合视图"), this, [this]() { fitViewport(); });
#ifdef AUTOMATIONCAD_HAVE_OCCT
    viewMenu->addSeparator();
    viewMenu->addAction(tr("剖切（沿 Z）…"), this, [this]() {
        if (!m_occtViewport) {
            QMessageBox::information(this, tr("剖切"), tr("这个构建没有 OCCT AIS 视口，剖切不可用"));
            return;
        }
        bool ok = false;
        const double z = QInputDialog::getDouble(this, tr("剖切"),
                                                 tr("切在 Z = ?（mm，保留下方，切掉上方）"),
                                                 m_occtViewport->clipActive() ? m_occtViewport->clipZ() : 600.0,
                                                 -100000.0, 100000.0, 1, &ok);
        if (!ok) return;
        QString error;
        if (!m_occtViewport->setClipZ(z, &error)) {
            QMessageBox::warning(this, tr("剖切失败"), error);
            return;
        }
        qInfo().noquote() << "FT_QT_CLIP" << "z=" << z;
        statusBar()->showMessage(tr("已剖切：Z = %1 mm（保留下方）").arg(z), 15000);
    });
    viewMenu->addAction(tr("取消剖切"), this, [this]() {
        if (m_occtViewport) m_occtViewport->clearClip();
        statusBar()->showMessage(tr("已取消剖切"), 10000);
    });
#else
    viewMenu->addSeparator();
    auto *clipUnavailable = viewMenu->addAction(tr("剖切（需 OCCT 构建）"));
    clipUnavailable->setEnabled(false);
#endif
    // 构件库（停靠面板）：条目可拖到 3D 视口；数据来自 desktop --catalog
#ifdef AUTOMATIONCAD_HAVE_OCCT
    if (m_occtViewport) {
        connect(m_occtViewport, &OcctViewport::partDragMove, this, [this](const QString &partId, double x, double y) {
            // 拖已有零件时也要有预览：尺寸取它自己的包围盒，判定重叠时把自己排除
            for (const QJsonValue &boundValue : m_partBounds) {
                const QJsonObject bound = boundValue.toObject();
                if (bound.value(QStringLiteral("id")).toString() != partId) continue;
                const QJsonArray min = bound.value(QStringLiteral("min")).toArray();
                const QJsonArray max = bound.value(QStringLiteral("max")).toArray();
                if (min.size() != 3 || max.size() != 3) break;
                const double sx = max.at(0).toDouble() - min.at(0).toDouble();
                const double sy = max.at(1).toDouble() - min.at(1).toDouble();
                const double sz = max.at(2).toDouble() - min.at(2).toDouble();
                int state = 0;
                for (const QJsonValue &otherValue : m_partBounds) {
                    const QJsonObject other = otherValue.toObject();
                    if (other.value(QStringLiteral("id")).toString() == partId) continue;
                    const QJsonArray omin = other.value(QStringLiteral("min")).toArray();
                    const QJsonArray omax = other.value(QStringLiteral("max")).toArray();
                    if (omin.size() != 3 || omax.size() != 3) continue;
                    const double cx[3] = {x - sx / 2, y - sy / 2, 0.0};
                    const double cxx[3] = {x + sx / 2, y + sy / 2, sz};
                    bool hit = true;
                    for (int axis = 0; axis < 3; ++axis) {
                        if (omin.at(axis).toDouble() >= cxx[axis] || omax.at(axis).toDouble() <= cx[axis]) { hit = false; break; }
                    }
                    if (hit) { state = 2; break; }
                }
                m_occtViewport->showPreviewBox(sx, sy, sz, x, y, state);
                break;
            }
        });
        connect(m_occtViewport, &OcctViewport::partDragFinished, this, [this](const QString &partId, double x, double y) {
            int count = 0;
            QString error;
            if (m_occtViewport) m_occtViewport->clearPreviewBox();
            if (!movePartTo(partId, x, y, &count, &error)) {
                statusBar()->showMessage(tr("拖动未提交：%1").arg(error), 12000);
                return;
            }
            statusBar()->showMessage(tr("%1 已拖到 (%2, %3)").arg(partId).arg(x).arg(y), 15000);
        });
        connect(m_occtViewport, &OcctViewport::dragPreview, this, [this](const QString &type, double x, double y) {
            for (const QJsonValue &entry : m_catalogCache) {
                const QJsonObject item = entry.toObject();
                if (item.value(QStringLiteral("type")).toString() != type) continue;
                const QJsonObject shape = item.value(QStringLiteral("shape")).toObject();
                const QJsonArray size = shape.value(QStringLiteral("size")).toArray();
                if (size.size() == 3) {
                    m_occtViewport->showPreviewBox(size.at(0).toDouble(), size.at(1).toDouble(),
                                                   size.at(2).toDouble(), x, y);
                }
                break;
            }
        });
        connect(m_occtViewport, &OcctViewport::partDropped, this, [this](const QString &type, double x, double y) {
            int count = 0;
            QString error;
            if (!insertPartFromCatalog(type, QVector3D(static_cast<float>(x), static_cast<float>(y), 0), &count, &error)) {
                QMessageBox::warning(this, tr("插入构件失败"), error);
                return;
            }
            statusBar()->showMessage(tr("已插入 %1 于 (%2, %3)，共 %4 个零件").arg(type).arg(x).arg(y).arg(count), 20000);
        });
    }
#endif

    auto *catalogDock = new QDockWidget(tr("构件库"), this);
    auto *catalogList = new QListWidget(catalogDock);
    catalogList->setDragEnabled(true);
    catalogList->setDragDropMode(QAbstractItemView::DragOnly);
    catalogDock->setWidget(catalogList);
    addDockWidget(Qt::LeftDockWidgetArea, catalogDock);
    QJsonArray catalogCache;
    QTimer::singleShot(600, this, [this, catalogList]() {
        QJsonArray catalog;
        QString error;
        if (!loadCatalog(&catalog, &error)) {
            catalogList->addItem(tr("（读取构件库失败：%1）").arg(error));
            return;
        }
        m_catalogCache = catalog;
        for (const QJsonValue &entry : catalog) {
            const QJsonObject item = entry.toObject();
            auto *row = new QListWidgetItem(item.value(QStringLiteral("label")).toString(), catalogList);
            row->setData(Qt::UserRole, item.value(QStringLiteral("type")).toString());
            row->setToolTip(tr("拖到 3D 视口即可插入（落点按 10 mm 网格吸附、底面贴地）"));
        }
    });
    connect(catalogList, &QListWidget::itemPressed, this, [catalogList](QListWidgetItem *item) {
        QMimeData *mime = new QMimeData();
        mime->setData(QStringLiteral("application/x-cad-part"), item->data(Qt::UserRole).toString().toUtf8());
        auto *drag = new QDrag(catalogList);
        drag->setMimeData(mime);
        drag->exec(Qt::CopyAction);
    });

    auto *insertMenu = menuBar()->addMenu(tr("插入"));
    insertMenu->addAction(tr("插入构件…"), this, [this]() {
        QJsonArray catalog;
        QString error;
        if (!loadCatalog(&catalog, &error)) {
            QMessageBox::warning(this, tr("构件库读取失败"), error);
            return;
        }
        QStringList labels;
        QStringList types;
        for (const QJsonValue &entry : catalog) {
            const QJsonObject item = entry.toObject();
            labels << item.value(QStringLiteral("label")).toString();
            types << item.value(QStringLiteral("type")).toString();
        }
        bool ok = false;
        const QString picked = QInputDialog::getItem(this, tr("插入构件"), tr("构件类型："), labels, 0, false, &ok);
        if (!ok || picked.isEmpty()) return;
        const QString type = types.at(labels.indexOf(picked));
        int count = 0;
        if (!insertPartFromCatalog(type, QVector3D(0, 0, 0), &count, &error)) {
            QMessageBox::warning(this, tr("插入失败"), error);
            return;
        }
        qInfo().noquote() << "FT_QT_INSERT_PART" << "type=" << type << "parts=" << count;
        statusBar()->showMessage(tr("已插入 %1（总共 %2 个零件），位置在原点，可用方向键再挪").arg(picked).arg(count), 20000);
    });
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
            body.insert(QStringLiteral("documentId"), m_documentId);
            body.insert(QStringLiteral("expectedRevision"), m_envelope.value(QStringLiteral("revision")).toInt());
            body.insert(QStringLiteral("actor"), QStringLiteral("manual"));
            body.insert(QStringLiteral("operation"), QStringLiteral("setMaterial"));
            body.insert(QStringLiteral("material"), key);
            postOperation(body);
        });
    }
    auto *evalMenu = menuBar()->addMenu(tr("评估"));
    QAction *interference = evalMenu->addAction(tr("装配干涉检查"), this, &MainWindow::runInterferenceCheck);
    interference->setShortcut(QKeySequence(QStringLiteral("Ctrl+I")));
    evalMenu->addAction(tr("试摆位（移动零件重算干涉）…"), this, &MainWindow::tunePlacementDialog);
    QAction *assemblyBom = evalMenu->addAction(tr("装配清单"), this, &MainWindow::runAssemblyBom);
    assemblyBom->setShortcut(QKeySequence(QStringLiteral("Ctrl+B")));
    interference->setShortcut(QKeySequence(QStringLiteral("Ctrl+I")));

    auto *editMenu = menuBar()->addMenu(tr("编辑"));
    m_undoAction = editMenu->addAction(tr("撤销"), this, &MainWindow::undoOnce);
    m_undoAction->setShortcut(QKeySequence::Undo);
    m_redoAction = editMenu->addAction(tr("重做"), this, &MainWindow::redoOnce);
    editMenu->addSeparator();
    auto *undoEditAction = editMenu->addAction(tr("撤销上一次编辑"), this, [this]() {
        int count = 0;
        QString error;
        if (!undoLastInsert(&count, &error)) {
            statusBar()->showMessage(tr("没有可撤销的插入"), 8000);
            return;
        }
        statusBar()->showMessage(tr("已撤销：回到 %1 个零件（还可撤 %2 步）").arg(count).arg(insertHistoryDepth()), 15000);
    });
    // 菜单文字反映真实可撤步数，不做「看起来能撤」的空菜单
    connect(editMenu, &QMenu::aboutToShow, this, [this, undoEditAction]() {
        const int depth = insertHistoryDepth();
        undoEditAction->setEnabled(depth > 0);
        undoEditAction->setText(depth > 0 ? tr("撤销上一次编辑（可撤 %1 步）").arg(depth) : tr("撤销上一次编辑"));
    });
    m_redoAction->setShortcut(QKeySequence::Redo);
    m_undoAction->setEnabled(false);
    m_redoAction->setEnabled(false);

    auto *toolbar = addToolBar(tr("特征工具栏"));
    // 文档切换：服务端支持多文档，这里列出并允许新建（默认 demo-adapter）
    m_documentCombo = new QComboBox(this);
    m_documentCombo->setMinimumWidth(180);
    m_documentCombo->setToolTip(tr("当前文档（服务端多文档）"));
    toolbar->addWidget(new QLabel(tr("文档 "), this));
    toolbar->addWidget(m_documentCombo);
    toolbar->addAction(tr("新建文档…"), this, &MainWindow::onCreateDocument);
    toolbar->addSeparator();
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
    // 有 OCCT 头文件时默认用 AIS 视口：四个标准视角已用像素比例验过
    // （俯视 639×639 正方形 / 正视与右视 639×103 / 等轴测 639×455）。
    // 选面与测量还没做（点击选中返回空选择），需要自绘视口时用 AUTOMATIONCAD_QT_OCCT=0。
#ifdef AUTOMATIONCAD_HAVE_OCCT
    // offscreen（CI/自检）下没有真实窗口句柄，OCCT 的 WNT_Window 会挂住初始化，
    // 这种场景一律走 STL 视口；另外留 AUTOMATIONCAD_QT_STL=1 手动切回。
    const bool headless = QGuiApplication::platformName().contains(QStringLiteral("offscreen"))
                          || qEnvironmentVariableIsSet("AUTOMATIONCAD_QT_STL");
    const bool preferOcct = !headless
                            && qEnvironmentVariable("AUTOMATIONCAD_QT_OCCT", "1") != QStringLiteral("0");
    if (preferOcct) {
        m_occtViewport = new OcctViewport(this);
        m_viewport = m_occtViewport;
        connect(m_occtViewport, &OcctViewport::loaded, this, [this](int triangles) {
            statusBar()->showMessage(tr("几何已加载：%1 个三角面（OCCT AIS · 服务端 STL）").arg(triangles), 5000);
        });
        connect(m_occtViewport, &OcctViewport::failed, this, [this](const QString &message) {
            statusBar()->showMessage(message, 6000);
        });
        connect(m_occtViewport, &OcctViewport::measured, this, [this](const QString &message) {
            statusBar()->showMessage(message, 10000);
        });
        connect(m_occtViewport, &OcctViewport::partPicked, this, [this](const QString &partId) {
            m_selectedPartId = partId;
            qInfo().noquote() << "FT_QT_PICK part=" << (partId.isEmpty() ? QStringLiteral("(空)") : partId);
            m_occtViewport->highlightPart(partId);
            if (partId.isEmpty()) {
                statusBar()->showMessage(tr("点空白处，已取消选中"), 5000);
                return;
            }
            statusBar()->showMessage(tr("已选 %1 · 方向键 1 mm / Shift+方向键 10 mm，PgUp/PgDn 调 Z")
                                         .arg(partId), 20000);
        });
        connect(m_occtViewport, &OcctViewport::nudgeRequested, this, [this](int dx, int dy, int dz) {
            nudgeSelectedPart(dx, dy, dz);
        });
    }
#endif
    if (!m_viewport) {
        m_glViewport = new StlViewport(this);
        m_viewport = m_glViewport;
        connect(m_glViewport, &StlViewport::loaded, this, [this](int triangles) {
            statusBar()->showMessage(tr("几何已加载：%1 个三角面（服务端 STL）").arg(triangles), 5000);
        });
        connect(m_glViewport, &StlViewport::failed, this, [this](const QString &message) {
            statusBar()->showMessage(message, 6000);
        });
    }

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

    connect(m_documentCombo, QOverload<int>::of(&QComboBox::currentIndexChanged), this, [this](int index) {
        if (index < 0) return;
        setDocument(m_documentCombo->itemData(index).toString());
    });
    connect(m_tree, &QTreeWidget::itemDoubleClicked, this, [this](QTreeWidgetItem *item, int) {
        if (m_assemblyId.isEmpty() || !item) return;
        const QVariant index = item->data(0, Qt::UserRole);
        if (!index.isValid()) return;
        editAssemblyMember(index.toInt());
    });
    connect(m_tree, &QTreeWidget::itemClicked, this, &MainWindow::onTreeItemSelected);
    m_tree->setContextMenuPolicy(Qt::CustomContextMenu);
    connect(m_tree, &QTreeWidget::customContextMenuRequested, this, &MainWindow::showTreeMenu);
    connect(m_panel, &QTableWidget::cellChanged, this, &MainWindow::onPropertyCellChanged);
    loadTree();
    reloadDocuments();
}

void MainWindow::setServiceBase(const QString &base) { m_serviceBase = base; }

QString MainWindow::docQuery() const {
    return QStringLiteral("?documentId=") + QString::fromUtf8(QUrl::toPercentEncoding(m_documentId));
}

void MainWindow::setDocument(const QString &documentId) {
    if (documentId.isEmpty() || documentId == m_documentId) return;
    m_assemblyId.clear(); // 选文档就退出装配视图
    m_documentId = documentId;
    m_envelope = QJsonObject();
    // 换文档必须让视口忘掉上一份的缓存（版本号可能相同，不然不会重载几何）
    setViewportGeometry(-1, QString());
    refreshNow();
}

void MainWindow::editAssemblyMember(int memberIndex) {
    const QJsonObject record = m_assemblyRecord;
    const QJsonArray members = record.value(QStringLiteral("members")).toArray();
    if (memberIndex < 0 || memberIndex >= members.size()) return;
    const QJsonObject member = members.at(memberIndex).toObject();
    const QJsonArray offset = member.value(QStringLiteral("offset")).toArray();

    QDialog dialog(this);
    dialog.setWindowTitle(tr("编辑成员：%1").arg(member.value(QStringLiteral("documentId")).toString()));
    auto *form = new QFormLayout(&dialog);
    auto *x = new QDoubleSpinBox(&dialog);
    auto *y = new QDoubleSpinBox(&dialog);
    auto *z = new QDoubleSpinBox(&dialog);
    auto *rotX = new QDoubleSpinBox(&dialog);
    auto *rotY = new QDoubleSpinBox(&dialog);
    auto *rot = new QDoubleSpinBox(&dialog);
    for (QDoubleSpinBox *box : {x, y, z, rotX, rotY, rot}) {
        box->setRange(-100000.0, 100000.0);
        box->setDecimals(2);
    }
    for (QDoubleSpinBox *box : {rotX, rotY, rot}) {
        box->setRange(-360.0, 360.0);
        box->setSuffix(tr(" °"));
    }
    x->setValue(offset.at(0).toDouble());
    y->setValue(offset.at(1).toDouble());
    z->setValue(offset.at(2).toDouble());
    const QJsonArray rotate = member.value(QStringLiteral("rotate")).toArray();
    if (rotate.size() == 3) {
        rotX->setValue(rotate.at(0).toDouble());
        rotY->setValue(rotate.at(1).toDouble());
        rot->setValue(rotate.at(2).toDouble());
    } else {
        rot->setValue(member.value(QStringLiteral("rotateZ")).toDouble());
    }
    form->addRow(tr("X 偏移 (mm)"), x);
    form->addRow(tr("Y 偏移 (mm)"), y);
    form->addRow(tr("Z 偏移 (mm)"), z);
    form->addRow(tr("绕 X 旋转"), rotX);
    form->addRow(tr("绕 Y 旋转"), rotY);
    form->addRow(tr("绕 Z 旋转"), rot);
    auto *buttons = new QDialogButtonBox(QDialogButtonBox::Ok | QDialogButtonBox::Cancel, &dialog);
    form->addRow(buttons);
    connect(buttons, &QDialogButtonBox::accepted, &dialog, &QDialog::accept);
    connect(buttons, &QDialogButtonBox::rejected, &dialog, &QDialog::reject);
    if (dialog.exec() != QDialog::Accepted) return;

    QJsonArray updated;
    for (int i = 0; i < members.size(); ++i) {
        const QJsonObject existing = members.at(i).toObject();
        QJsonObject entry;
        entry.insert(QStringLiteral("documentId"), existing.value(QStringLiteral("documentId")).toString());
        const QJsonArray oldOffset = existing.value(QStringLiteral("offset")).toArray();
        entry.insert(QStringLiteral("offset"), i == memberIndex
            ? QJsonArray{x->value(), y->value(), z->value()}
            : oldOffset);
        if (i == memberIndex) {
            // 契约：rotate 与 rotateZ 不能同时给。只绕 Z 时继续用简写 rotateZ，避免历史数据被改变语义
            const bool anyAxis = rotX->value() != 0.0 || rotY->value() != 0.0;
            if (anyAxis) {
                entry.insert(QStringLiteral("rotate"), QJsonArray{rotX->value(), rotY->value(), rot->value()});
            } else {
                entry.insert(QStringLiteral("rotateZ"), rot->value());
            }
        } else {
            const QJsonArray oldRotate = existing.value(QStringLiteral("rotate")).toArray();
            if (oldRotate.size() == 3) entry.insert(QStringLiteral("rotate"), oldRotate);
            else entry.insert(QStringLiteral("rotateZ"), existing.value(QStringLiteral("rotateZ")).toDouble());
        }
        updated.append(entry);
    }
    QJsonObject body;
    body.insert(QStringLiteral("members"), updated);
    QNetworkRequest req{QUrl(m_serviceBase + QStringLiteral("/v1/assemblies/") +
                             QString::fromUtf8(QUrl::toPercentEncoding(m_assemblyId)))};
    req.setHeader(QNetworkRequest::ContentTypeHeader, QStringLiteral("application/json"));
    req.setTransferTimeout(60'000);
    QNetworkReply *reply = m_net->put(req, QJsonDocument(body).toJson());
    connect(reply, &QNetworkReply::finished, this, [this, reply]() {
        reply->deleteLater();
        const QJsonObject result = readReply(reply);
        if (reply->error() != QNetworkReply::NoError || result.contains(QStringLiteral("error"))) {
            QMessageBox::warning(this, tr("更新装配失败"),
                result.value(QStringLiteral("message")).toString(reply->errorString()));
            return;
        }
        statusBar()->showMessage(tr("成员位姿已更新，正在重新合成几何…"), 5000);
        loadAssembly(m_assemblyId);
    });
}

bool MainWindow::fetchGeometryStl(QByteArray *bytes, QString *error) {
    const QString url = m_assemblyId.isEmpty()
        ? m_serviceBase + QStringLiteral("/v1/geometry.stl")
        : m_serviceBase + QStringLiteral("/v1/assemblies/") +
              QString::fromUtf8(QUrl::toPercentEncoding(m_assemblyId)) + QStringLiteral("/geometry.stl");
    QNetworkRequest req{QUrl(url)};
    req.setTransferTimeout(60'000);
    QNetworkReply *reply = m_net->get(req);
    QEventLoop loop;
    connect(reply, &QNetworkReply::finished, &loop, &QEventLoop::quit);
    loop.exec();
    reply->deleteLater();
    if (reply->error() != QNetworkReply::NoError) {
        *error = tr("取几何失败：%1").arg(reply->errorString());
        return false;
    }
    const QByteArray data = reply->readAll();
    // 服务端没 sidecar 时回 404 JSON；这里再挡一层，避免把错误文本当 STL 存成文件
    if (!data.startsWith("solid") && data.size() < 84) {
        *error = tr("服务端没有返回 STL（%1 字节）").arg(data.size());
        return false;
    }
    *bytes = data;
    return true;
}

bool MainWindow::exportStl(const QString &path, int *bytes, QString *error) {
    QByteArray stl;
    if (!fetchGeometryStl(&stl, error)) return false;
    QFile file(path);
    if (!file.open(QIODevice::WriteOnly)) {
        *error = tr("写文件失败：%1").arg(file.errorString());
        return false;
    }
    const qint64 written = file.write(stl);
    file.close();
    if (written != stl.size()) {
        *error = tr("只写入 %1/%2 字节").arg(written).arg(stl.size());
        return false;
    }
    *bytes = static_cast<int>(stl.size());
    return true;
}

bool MainWindow::designMachineFromBrief(const QString &brief, QJsonObject *document, QString *error,
                                        const QStringList &moves, bool resolveAll, int clearanceResolveMm,
                                        bool layoutCompliance, int clearanceMm,
                                        bool measureMaxClearance, const QStringList &ignorePairs,
                                        const QString &insertPart) {
    if (brief.trimmed().isEmpty()) {
        *error = tr("brief 不能为空");
        return false;
    }
    // 管线脚本位置：优先环境变量，其次仓库内约定路径（app 在 build 目录时向上找）
    QString script = qEnvironmentVariable("AUTOMATIONCAD_PIPELINE");
    if (script.isEmpty()) {
        const QString rel = QStringLiteral("desktop/scripts/machine-design-cli.mjs");
        QStringList candidates{
            QDir(QCoreApplication::applicationDirPath()).filePath(rel),
            QDir::current().filePath(rel)
        };
        // exe 可能在仓库外的任意构建目录（D:\build\qt-occt-deploy），
        // 从 exe 所在目录一层层往上找仓库根，找到 desktop/scripts 为止
        QDir probe(QCoreApplication::applicationDirPath());
        for (int depth = 0; depth < 8; ++depth) {
            candidates << probe.filePath(rel);
            if (!probe.cdUp()) break;
        }
        for (const QString &candidate : candidates) {
            const QString absolute = QFileInfo(candidate).absoluteFilePath();
            if (QFileInfo::exists(absolute)) {
                script = absolute;
                break;
            }
        }
    }
    if (script.isEmpty() || !QFileInfo::exists(script)) {
        *error = tr("找不到整机管线脚本（%1）；设置环境变量 AUTOMATIONCAD_PIPELINE 指向 desktop/scripts/machine-design-cli.mjs")
                     .arg(script.isEmpty() ? tr("未设置") : script);
        return false;
    }

    QProcess process;
    process.setProcessChannelMode(QProcess::SeparateChannels);
    QStringList arguments{script, QStringLiteral("--brief"), brief, QStringLiteral("--with-geometry")};
    for (const QString &move : moves) arguments << QStringLiteral("--move") << move;
    if (resolveAll) arguments << QStringLiteral("--resolve");
    if (clearanceResolveMm > 0) {
        arguments << QStringLiteral("--resolve-clearance") << QString::number(clearanceResolveMm);
    }
    if (measureMaxClearance) arguments << QStringLiteral("--max-clearance");
    // 复核确认的误报：交给求解器跳过，别为包围盒的假重叠白推距离
    if (!insertPart.isEmpty()) {
        arguments << QStringLiteral("--insert-part") << insertPart;
    }
    if (!ignorePairs.isEmpty()) {
        arguments << QStringLiteral("--ignore-pairs") << ignorePairs.join(QStringLiteral(","));
    }
    if (layoutCompliance) {
        // 与「间距初筛」用同一个阈值：用户在干涉页里改过 20，排布合规就该按那个值算
        arguments << QStringLiteral("--layout-compliance")
                  << QString::number(clearanceMm > 0 ? clearanceMm : m_clearanceMm);
    }
    // 间距初筛阈值可由干涉页调整；默认 20 mm。只读诊断，不改变几何
    arguments << QStringLiteral("--clearance")
              << QString::number(clearanceMm > 0 ? clearanceMm : m_clearanceMm);
    process.start(QStringLiteral("node"), arguments);
    if (!process.waitForStarted(10'000)) {
        *error = tr("启动 node 失败：%1").arg(process.errorString());
        return false;
    }
    if (!process.waitForFinished(180'000)) {
        process.kill();
        process.waitForFinished(2'000);
        *error = tr("整机管线超时（180 秒未结束）");
        return false;
    }
    const QByteArray out = process.readAllStandardOutput();
    const QByteArray err = process.readAllStandardError();
    if (process.exitStatus() != QProcess::NormalExit || process.exitCode() != 0) {
        *error = tr("整机管线退出码 %1：%2")
                     .arg(process.exitCode())
                     .arg(QString::fromUtf8(err).trimmed().left(400));
        return false;
    }
    QJsonParseError parseError{};
    const QJsonDocument parsed = QJsonDocument::fromJson(out, &parseError);
    if (parseError.error != QJsonParseError::NoError || !parsed.isObject()) {
        *error = tr("管线输出不是 JSON（偏移 %1：%2）").arg(parseError.offset).arg(parseError.errorString());
        return false;
    }
    const QJsonObject object = parsed.object();
    if (object.value(QStringLiteral("kind")).toString() != QStringLiteral("machine-case")) {
        *error = tr("管线输出不是整机方案（kind=%1）").arg(object.value(QStringLiteral("kind")).toString());
        return false;
    }
    *document = object;
    // 记住当前文档：插入的撤销快照要靠它（之前只在调用方赋值，插入路径上会拿到空）
    m_lastDocument = object;
    // 记住 brief 与累计位移：方向键微调/试摆位都用这两个，不能只靠调用方传
    m_lastBrief = brief;
    m_lastMoves = moves;
    // 只记「真实戳」；降级成 stale 的事发生在手工挪动处（那里才知道几何真的变了）
    if (object.contains(QStringLiteral("compliance"))) {
        m_lastCompliance = object.value(QStringLiteral("compliance")).toObject();
    }
    return true;
}

bool MainWindow::clipTestMetrics(double z, int *beforePixels, int *afterPixels, QString *error) {
#ifdef AUTOMATIONCAD_HAVE_OCCT
    if (!m_occtViewport) {
        *error = tr("这个构建没有 OCCT AIS 视口，剖切不可用");
        return false;
    }
    // 用「显示集合的实体体积」当判据：像素数会被底色/抗锯齿淹没，体积不会
    const double before = m_occtViewport->displayedVolumeMm3();
    if (before <= 0.0) {
        *error = tr("视口里没有可测体积的几何");
        return false;
    }
    if (!m_occtViewport->setClipZ(z, error)) return false;
    const double after = m_occtViewport->displayedVolumeMm3();
    // 以 mm³ 的整数部分传出（签名沿用 int，够表达四工位 1.2e8 级）
    *beforePixels = static_cast<int>(before / 1000.0);
    *afterPixels = static_cast<int>(after / 1000.0);
    return true;
#else
    Q_UNUSED(z); Q_UNUSED(beforePixels); Q_UNUSED(afterPixels);
    *error = tr("这个构建没有 OCCT（-DAUTOMATIONCAD_OCCT=OFF），剖切不可用");
    return false;
#endif
}

bool MainWindow::renderMachineGeometry(const QJsonObject &document, int *shapeCount, QString *error) {
    const QJsonObject geometry = document.value(QStringLiteral("geometry")).toObject();
    m_partBounds = geometry.value(QStringLiteral("bounds")).toArray();
    if (geometry.isEmpty()) {
        *error = tr("方案里没有 geometry（管线需 --with-geometry）");
        return false;
    }
#ifndef AUTOMATIONCAD_HAVE_OCCT
    *error = tr("这个构建没有 OCCT AIS 视口（CMake 未找到 OCCT 头文件），整机示意 3D 不可用");
    return false;
#endif
#ifdef AUTOMATIONCAD_HAVE_OCCT
    if (m_occtViewport->isHidden()) m_occtViewport->show();
    if (!m_occtViewport->showMachineGeometry(geometry, shapeCount, error)) return false;
#else
    // CI 只装 Qt、没有 OCCT 头文件；这条路径要在「没有视口」时也能编过并给出可操作原因
    *error = tr("这个构建没有 OCCT AIS 视口（CMake 未找到 OCCT 头文件），整机示意 3D 不可用");
    return false;
#endif
    const QJsonArray envelope = geometry.value(QStringLiteral("envelope")).toArray();
    if (envelope.size() == 3) {
        statusBar()->showMessage(tr("整机示意装配：%1 个占位体 · 包络 %2×%3×%4 mm · 精度=概念估算")
                                     .arg(*shapeCount)
                                     .arg(envelope.at(0).toDouble(), 0, 'f', 0)
                                     .arg(envelope.at(1).toDouble(), 0, 'f', 0)
                                     .arg(envelope.at(2).toDouble(), 0, 'f', 0), 20000);
    }
    return true;
}

void MainWindow::designMachineDialog() {
    bool accepted = false;
    const QString brief = QInputDialog::getMultiLineText(
        this, tr("从一句话生成整机方案"),
        tr("写清工位/节拍/执行机构（对话框不预填内容，避免把猜测当用户输入）："),
        QString(), &accepted);
    if (!accepted || brief.trimmed().isEmpty()) return;

    QApplication::setOverrideCursor(Qt::WaitCursor);
    statusBar()->showMessage(tr("正在跑整机管线（brief → 工位 → BOM → IO → 配电 → 节拍 → 成本）…"));
    QJsonObject document;
    QString error;
    const bool ok = designMachineFromBrief(brief, &document, &error);
    QApplication::restoreOverrideCursor();
    if (!ok) {
        QMessageBox::warning(this, tr("生成失败"), error);
        statusBar()->showMessage(tr("整机方案生成失败"), 8000);
        return;
    }
    statusBar()->showMessage(tr("整机方案：%1").arg(MachineCaseDialog::summarize(document)), 15000);
    int shapes = 0;
    QString geometryError;
    if (!renderMachineGeometry(document, &shapes, &geometryError)) {
        statusBar()->showMessage(tr("整机方案已生成，但 3D 示意没画出来：%1").arg(geometryError), 20000);
    }
    showMachineCase(document);
}

void MainWindow::showMachineCase(const QJsonObject &document) {
    QJsonObject current = document;
    while (true) {
        m_pendingMovePartId.clear();
        m_pendingMoveAxis = -1;
        m_pendingMoveDelta = 0.0;
        MachineCaseDialog dialog(
            current, this,
            [this](const QStringList &ids) {
                if (ids.isEmpty()) {
#ifdef AUTOMATIONCAD_HAVE_OCCT
                    if (m_occtViewport) m_occtViewport->highlightPart(QString());
#endif
                    return;
                }
#ifdef AUTOMATIONCAD_HAVE_OCCT
                if (m_occtViewport) m_occtViewport->highlightParts(ids);
#endif
                qInfo().noquote() << "FT_QT_PAIR_HIGHLIGHT" << ids.join(QStringLiteral(","));
                statusBar()->showMessage(tr("干涉对：%1").arg(ids.join(QStringLiteral(" × "))), 15000);
            },
            [this](const QString &partId, int axis, double delta) {
                m_pendingMovePartId = partId;
                m_pendingMoveAxis = axis;
                m_pendingMoveDelta = delta;
            },
            [this]() { m_pendingResolveAll = true; },
            [this]() { m_pendingResolveClearance = true; },
            [this]() { m_pendingLayoutCompliance = true; },
            [this](int thresholdMm) { m_pendingClearanceMm = thresholdMm; },
            m_clearanceMm,
            [this]() { m_pendingMeasureMax = true; },
            [this](int thresholdMm) {
                m_pendingRecomputeCompliance = true;
                m_pendingRecomputeMm = thresholdMm;
            },
            [this](const QString &scope, double mm, const QString &axis) {
                m_pendingShiftScope = true;
                m_pendingShiftScopeName = scope;
                m_pendingShiftMm = mm;
                m_pendingShiftAxis = axis.isEmpty() ? QStringLiteral("x") : axis;
            },
            [this](const QStringList &keys) {
                m_pendingSkipMisreports = true;
                m_pendingIgnoreKeys = keys;
            });
        dialog.exec();
        if (m_pendingResolveAll && !m_lastBrief.trimmed().isEmpty()) {
            m_pendingResolveAll = false;
            QApplication::setOverrideCursor(Qt::WaitCursor);
            QJsonObject resolved;
            QString resolveError;
            const bool ok = designMachineFromBrief(m_lastBrief, &resolved, &resolveError, m_lastMoves, true);
            QApplication::restoreOverrideCursor();
            if (!ok) {
                QMessageBox::warning(this, tr("批量解重叠失败"), resolveError);
                return;
            }
            m_lastDocument = resolved;
            int resolvedShapes = 0;
            QString resolveGeometryError;
            renderMachineGeometry(resolved, &resolvedShapes, &resolveGeometryError);
            const QJsonObject resolution = resolved.value(QStringLiteral("geometry")).toObject()
                                               .value(QStringLiteral("resolution")).toObject();
            qInfo().noquote() << "FT_QT_RESOLVE_ALL before=" << resolution.value(QStringLiteral("before")).toInt()
                              << "after=" << resolution.value(QStringLiteral("after")).toInt()
                              << "moves=" << resolution.value(QStringLiteral("moves")).toArray().size()
                              << "converged=" << resolution.value(QStringLiteral("converged")).toBool();
            statusBar()->showMessage(tr("批量解重叠：%1 → %2 处（挪了 %3 件，%4）")
                                         .arg(resolution.value(QStringLiteral("before")).toInt())
                                         .arg(resolution.value(QStringLiteral("after")).toInt())
                                         .arg(resolution.value(QStringLiteral("moves")).toArray().size())
                                         .arg(resolution.value(QStringLiteral("converged")).toBool()
                                                  ? tr("已收敛") : tr("未收敛")), 20000);
            current = resolved;
            continue;
        }
        if (m_pendingShiftScope && !m_lastBrief.trimmed().isEmpty()) {
            m_pendingShiftScope = false;
            const QString scope = m_pendingShiftScopeName;
            const double mm = m_pendingShiftMm;
            const QStringList members = partsOfScope(m_lastDocument, scope);
            if (members.isEmpty()) {
                QMessageBox::warning(this, tr("整站挪失败"), tr("找不到 %1 的零件").arg(scope));
                return;
            }
            // 沿建议里那个轴挪：建议是「这一对在 Y 方向太近」，就往 Y 推，不能一律往 +X
            const QString axis = m_pendingShiftAxis;
            const double dx = axis == QStringLiteral("x") ? mm : 0.0;
            const double dy = axis == QStringLiteral("y") ? mm : 0.0;
            const double dz = axis == QStringLiteral("z") ? mm : 0.0;
            QStringList moves = m_lastMoves;
            for (const QString &id : members) {
                moves << QStringLiteral("%1:%2,%3,%4").arg(id).arg(dx).arg(dy).arg(dz);
            }
            QApplication::setOverrideCursor(Qt::WaitCursor);
            QJsonObject shifted;
            QString shiftError;
            const bool ok = designMachineFromBrief(m_lastBrief, &shifted, &shiftError, moves,
                                                   false, 0, true, m_clearanceMm);
            QApplication::restoreOverrideCursor();
            if (!ok) {
                QMessageBox::warning(this, tr("整站挪失败"), shiftError);
                return;
            }
            m_lastDocument = shifted;
            m_lastMoves = moves;
            int shiftShapes = 0;
            QString shiftGeometryError;
            renderMachineGeometry(shifted, &shiftShapes, &shiftGeometryError);
            const QJsonObject layoutInfo = shifted.value(QStringLiteral("geometry")).toObject()
                                               .value(QStringLiteral("layoutCompliance")).toObject();
            qInfo().noquote() << "FT_QT_SHIFT_SCOPE scope=" << scope << "axis=" << axis << "mm=" << mm
                              << "members=" << members.size()
                              << "converged=" << layoutInfo.value(QStringLiteral("converged")).toBool()
                              << "clearance=" << layoutInfo.value(QStringLiteral("clearance")).toInt();
            statusBar()->showMessage(tr("整站挪 %1 沿 %2 +%3 mm（%4 件）→ %5（剩余间距不足 %6 处）")
                                         .arg(scope, axis.toUpper(), QString::number(mm, 'f', 1))
                                         .arg(members.size())
                                         .arg(layoutInfo.value(QStringLiteral("converged")).toBool()
                                                  ? tr("已合规") : tr("仍未合规"))
                                         .arg(layoutInfo.value(QStringLiteral("clearance")).toInt()), 25000);
            current = shifted;
            continue;
        }
        if (m_pendingRecomputeCompliance && !m_lastBrief.trimmed().isEmpty()) {
            m_pendingRecomputeCompliance = false;
            const int thresholdMm = m_pendingRecomputeMm > 0 ? m_pendingRecomputeMm : m_clearanceMm;
            QApplication::setOverrideCursor(Qt::WaitCursor);
            QJsonObject refreshed;
            QString refreshError;
            const bool ok = designMachineFromBrief(m_lastBrief, &refreshed, &refreshError, m_lastMoves,
                                                   false, 0, true, thresholdMm);
            QApplication::restoreOverrideCursor();
            if (!ok) {
                QMessageBox::warning(this, tr("重算合规失败"), refreshError);
                return;
            }
            m_lastDocument = refreshed;
            m_clearanceMm = thresholdMm;
            int refreshedShapes = 0;
            QString refreshedGeometryError;
            renderMachineGeometry(refreshed, &refreshedShapes, &refreshedGeometryError);
            const QJsonObject stamp = refreshed.value(QStringLiteral("compliance")).toObject();
            qInfo().noquote() << "FT_QT_RECOMPUTE stampMm=" << stamp.value(QStringLiteral("clearanceMm")).toInt()
                              << "converged=" << stamp.value(QStringLiteral("converged")).toBool()
                              << "stale=" << stamp.value(QStringLiteral("stale")).toBool();
            statusBar()->showMessage(tr("已按 %1 mm 重算：%2（%3 轮 / %4 次位移）")
                                         .arg(thresholdMm)
                                         .arg(stamp.value(QStringLiteral("converged")).toBool()
                                                  ? tr("合规") : tr("仍不合规"))
                                         .arg(stamp.value(QStringLiteral("rounds")).toInt())
                                         .arg(stamp.value(QStringLiteral("moves")).toInt()), 20000);
            current = refreshed;
            continue;
        }
        if (m_pendingMeasureMax && !m_lastBrief.trimmed().isEmpty()) {
            m_pendingMeasureMax = false;
            QApplication::setOverrideCursor(Qt::WaitCursor);
            QJsonObject measured;
            QString measureError;
            const bool ok = designMachineFromBrief(m_lastBrief, &measured, &measureError, m_lastMoves,
                                                   false, 0, false, m_clearanceMm, true);
            QApplication::restoreOverrideCursor();
            if (!ok) {
                QMessageBox::warning(this, tr("测最大间距失败"), measureError);
                return;
            }
            m_lastDocument = measured;
            const QJsonObject maxClearance = measured.value(QStringLiteral("geometry")).toObject()
                                                 .value(QStringLiteral("maxClearance")).toObject();
            qInfo().noquote() << "FT_QT_MAX_CLEARANCE feasible=" << maxClearance.value(QStringLiteral("feasibleMm")).toInt()
                              << "probes=" << maxClearance.value(QStringLiteral("probes")).toArray().size();
            statusBar()->showMessage(tr("最大可行间距：%1 mm（探测 %2 次）")
                                         .arg(maxClearance.value(QStringLiteral("feasibleMm")).toInt())
                                         .arg(maxClearance.value(QStringLiteral("probes")).toArray().size()), 20000);
            current = measured;
            continue;
        }
        if (m_pendingClearanceMm > 0 && !m_lastBrief.trimmed().isEmpty()) {
            const int nextThreshold = m_pendingClearanceMm;
            m_pendingClearanceMm = 0;
            QApplication::setOverrideCursor(Qt::WaitCursor);
            QJsonObject rescreened;
            QString rescreenError;
            const bool ok = designMachineFromBrief(m_lastBrief, &rescreened, &rescreenError, m_lastMoves,
                                                   false, 0, false, nextThreshold);
            QApplication::restoreOverrideCursor();
            if (!ok) {
                QMessageBox::warning(this, tr("按新阈值重算失败"), rescreenError);
                return;
            }
            m_clearanceMm = nextThreshold;
            m_lastDocument = rescreened;
            int rescreenShapes = 0;
            QString rescreenGeometryError;
            renderMachineGeometry(rescreened, &rescreenShapes, &rescreenGeometryError);
            const QJsonObject clearance = rescreened.value(QStringLiteral("geometry")).toObject()
                                              .value(QStringLiteral("clearance")).toObject();
            qInfo().noquote() << "FT_QT_CLEARANCE_THRESHOLD threshold=" << nextThreshold
                              << "count=" << clearance.value(QStringLiteral("count")).toInt();
            statusBar()->showMessage(tr("间距阈值改为 %1 mm：%2 处间距不足")
                                         .arg(nextThreshold)
                                         .arg(clearance.value(QStringLiteral("count")).toInt()), 20000);
            current = rescreened;
            continue;
        }
        if (m_pendingSkipMisreports && !m_lastBrief.trimmed().isEmpty()) {
            m_pendingSkipMisreports = false;
            const QStringList keys = m_pendingIgnoreKeys;
            m_pendingIgnoreKeys.clear();
            QApplication::setOverrideCursor(Qt::WaitCursor);
            QJsonObject skipped;
            QString skipError;
            // 跳过的对是「真实布尔确认过不相交」的，不是凭包围盒猜的
            const bool ok = designMachineFromBrief(m_lastBrief, &skipped, &skipError, m_lastMoves, false, 0, true, -1, false, keys);
            QApplication::restoreOverrideCursor();
            if (!ok) {
                QMessageBox::warning(this, tr("按复核结论重排失败"), skipError);
                return;
            }
            m_lastDocument = skipped;
            int skippedShapes = 0;
            QString skippedGeometryError;
            renderMachineGeometry(skipped, &skippedShapes, &skippedGeometryError);
            const QJsonObject layout = skipped.value(QStringLiteral("geometry")).toObject()
                                           .value(QStringLiteral("layoutCompliance")).toObject();
            qInfo().noquote() << "FT_QT_SKIP_MISREPORTS ignored=" << keys.size()
                              << "suspects=" << layout.value(QStringLiteral("suspects")).toInt()
                              << "clearance=" << layout.value(QStringLiteral("clearance")).toInt()
                              << "converged=" << layout.value(QStringLiteral("converged")).toBool();
            statusBar()->showMessage(tr("按复核结论重排：跳过 %1 处 AABB 误报 · 剩余重叠 %2 / 间距不足 %3 · %4")
                                         .arg(keys.size())
                                         .arg(layout.value(QStringLiteral("suspects")).toInt())
                                         .arg(layout.value(QStringLiteral("clearance")).toInt())
                                         .arg(layout.value(QStringLiteral("converged")).toBool()
                                                  ? tr("已合规") : tr("未收敛")), 20000);
            current = skipped;
            continue;
        }
        if (m_pendingLayoutCompliance && !m_lastBrief.trimmed().isEmpty()) {
            m_pendingLayoutCompliance = false;
            QApplication::setOverrideCursor(Qt::WaitCursor);
            QJsonObject compliant;
            QString layoutError;
            const bool ok = designMachineFromBrief(m_lastBrief, &compliant, &layoutError, m_lastMoves, false, 0, true);
            QApplication::restoreOverrideCursor();
            if (!ok) {
                QMessageBox::warning(this, tr("排布合规失败"), layoutError);
                return;
            }
            m_lastDocument = compliant;
            int layoutShapes = 0;
            QString layoutGeometryError;
            renderMachineGeometry(compliant, &layoutShapes, &layoutGeometryError);
            const QJsonObject layout = compliant.value(QStringLiteral("geometry")).toObject()
                                           .value(QStringLiteral("layoutCompliance")).toObject();
            const QJsonArray layoutRounds = layout.value(QStringLiteral("rounds")).toArray();
            qInfo().noquote() << "FT_QT_LAYOUT_COMPLIANCE rounds=" << layoutRounds.size()
                              << "moves=" << layout.value(QStringLiteral("moves")).toArray().size()
                              << "suspects=" << layout.value(QStringLiteral("suspects")).toInt()
                              << "clearance=" << layout.value(QStringLiteral("clearance")).toInt()
                              << "converged=" << layout.value(QStringLiteral("converged")).toBool();
            statusBar()->showMessage(tr("排布合规：%1 轮 %2 次位移 · 剩余重叠 %3 / 间距不足 %4 · %5")
                                         .arg(layoutRounds.size())
                                         .arg(layout.value(QStringLiteral("moves")).toArray().size())
                                         .arg(layout.value(QStringLiteral("suspects")).toInt())
                                         .arg(layout.value(QStringLiteral("clearance")).toInt())
                                         .arg(layout.value(QStringLiteral("converged")).toBool()
                                                  ? tr("已合规") : tr("未收敛")), 20000);
            current = compliant;
            continue;
        }
        if (m_pendingResolveClearance && !m_lastBrief.trimmed().isEmpty()) {
            m_pendingResolveClearance = false;
            QApplication::setOverrideCursor(Qt::WaitCursor);
            QJsonObject pushed;
            QString pushError;
            const bool ok = designMachineFromBrief(m_lastBrief, &pushed, &pushError, m_lastMoves, false, m_clearanceMm);
            QApplication::restoreOverrideCursor();
            if (!ok) {
                QMessageBox::warning(this, tr("推开间距失败"), pushError);
                return;
            }
            m_lastDocument = pushed;
            int pushedShapes = 0;
            QString pushedGeometryError;
            renderMachineGeometry(pushed, &pushedShapes, &pushedGeometryError);
            const QJsonObject push = pushed.value(QStringLiteral("geometry")).toObject()
                                         .value(QStringLiteral("clearanceResolution")).toObject();
            qInfo().noquote() << "FT_QT_PUSH_CLEARANCE before=" << push.value(QStringLiteral("before")).toInt()
                              << "after=" << push.value(QStringLiteral("after")).toInt()
                              << "moves=" << push.value(QStringLiteral("moves")).toArray().size()
                              << "converged=" << push.value(QStringLiteral("converged")).toBool();
            statusBar()->showMessage(tr("间距：%1 → %2 处（挪了 %3 次，%4）")
                                         .arg(push.value(QStringLiteral("before")).toInt())
                                         .arg(push.value(QStringLiteral("after")).toInt())
                                         .arg(push.value(QStringLiteral("moves")).toArray().size())
                                         .arg(push.value(QStringLiteral("converged")).toBool()
                                                  ? tr("已收敛") : tr("未收敛")), 20000);
            current = pushed;
            continue;
        }
        if (m_pendingMovePartId.isEmpty() || m_lastBrief.trimmed().isEmpty()) return;

        QStringList moves = m_lastMoves;
        moves << QStringLiteral("%1:%2,%3,%4")
                     .arg(m_pendingMovePartId)
                     .arg(m_pendingMoveAxis == 0 ? m_pendingMoveDelta : 0.0)
                     .arg(m_pendingMoveAxis == 1 ? m_pendingMoveDelta : 0.0)
                     .arg(m_pendingMoveAxis == 2 ? m_pendingMoveDelta : 0.0);
        QApplication::setOverrideCursor(Qt::WaitCursor);
        QJsonObject updated;
        QString error;
        const bool ok = designMachineFromBrief(m_lastBrief, &updated, &error, moves);
        QApplication::restoreOverrideCursor();
        if (!ok) {
            QMessageBox::warning(this, tr("按建议挪失败"), error);
            return;
        }
        m_lastDocument = updated;
        int shapes = 0;
        QString geometryError;
        renderMachineGeometry(updated, &shapes, &geometryError);
        const QJsonObject interference = updated.value(QStringLiteral("geometry")).toObject()
                                            .value(QStringLiteral("interference")).toObject();
        qInfo().noquote() << "FT_QT_APPLY_HINT part=" << m_pendingMovePartId
                          << "count=" << interference.value(QStringLiteral("count")).toInt();
        statusBar()->showMessage(tr("已按建议挪 %1 · 重叠 %2 对（需确认 %3）")
                                     .arg(m_pendingMovePartId)
                                     .arg(interference.value(QStringLiteral("count")).toInt())
                                     .arg(interference.value(QStringLiteral("suspects")).toInt()), 15000);
        current = updated;
    }
}

void MainWindow::keyPressEvent(QKeyEvent *event) {
    qInfo().noquote() << "FT_QT_KEY key=" << event->key() << "sel=" << m_selectedPartId;
    const int step = (event->modifiers() & Qt::ShiftModifier) ? 10 : 1;
    // Ctrl + 方向键 = 整站挪（同前缀的所有零件一起动），单件微调调不好一组相对的件时用
    if (!m_selectedPartId.isEmpty() && (event->modifiers() & Qt::ControlModifier)) {
        const QString scope = m_selectedPartId.section(QLatin1Char('-'), 0, 0);
        switch (event->key()) {
        case Qt::Key_Left: nudgeStation(scope, -step, 0, 0); return;
        case Qt::Key_Right: nudgeStation(scope, step, 0, 0); return;
        case Qt::Key_Up: nudgeStation(scope, 0, step, 0); return;
        case Qt::Key_Down: nudgeStation(scope, 0, -step, 0); return;
        case Qt::Key_PageUp: nudgeStation(scope, 0, 0, step); return;
        case Qt::Key_PageDown: nudgeStation(scope, 0, 0, -step); return;
        default: break;
        }
    }
    if (!m_selectedPartId.isEmpty()) {
        switch (event->key()) {
        case Qt::Key_Left: nudgeSelectedPart(-step, 0, 0); return;
        case Qt::Key_Right: nudgeSelectedPart(step, 0, 0); return;
        case Qt::Key_Up: nudgeSelectedPart(0, step, 0); return;
        case Qt::Key_Down: nudgeSelectedPart(0, -step, 0); return;
        case Qt::Key_PageUp: nudgeSelectedPart(0, 0, step); return;
        case Qt::Key_PageDown: nudgeSelectedPart(0, 0, -step); return;
        case Qt::Key_Escape:
            m_selectedPartId.clear();
#ifdef AUTOMATIONCAD_HAVE_OCCT
            if (m_occtViewport) m_occtViewport->highlightPart(QString());
#endif
            statusBar()->showMessage(tr("已取消选中"), 5000);
            return;
        default: break;
        }
    }
    QMainWindow::keyPressEvent(event);
}

QJsonObject MainWindow::withStaleStamp(const QJsonObject &document, const QJsonObject &stamp,
                                      int movesSinceStamp) {
    if (stamp.isEmpty()) return document;
    QJsonObject updated = document;
    QJsonObject stale = stamp;
    stale.insert(QStringLiteral("stale"), true);
    stale.insert(QStringLiteral("movesSinceStamp"), movesSinceStamp);
    updated.insert(QStringLiteral("compliance"), stale);
    return updated;
}

QStringList MainWindow::partsOfScope(const QJsonObject &document, const QString &scope) {
    QStringList members;
    const QJsonArray parts = document.value(QStringLiteral("geometry")).toObject()
                                 .value(QStringLiteral("parts")).toArray();
    for (const QJsonValue &value : parts) {
        const QString id = value.toObject().value(QStringLiteral("id")).toString();
        if (id.section(QLatin1Char('-'), 0, 0) == scope) members << id;
    }
    return members;
}

void MainWindow::saveMachineCaseDialog() {
    if (m_lastDocument.isEmpty()) {
        statusBar()->showMessage(tr("还没有整机方案可存：先「从 brief 生成整机方案」或「打开整机方案」"), 12000);
        return;
    }
    const QString path = QFileDialog::getSaveFileName(this, tr("保存整机方案"),
                                                      QStringLiteral("machine-case.json"),
                                                      tr("整机方案 (*.json)"));
    if (path.isEmpty()) return;
    int bytes = 0;
    QString error;
    if (!MachineCaseDialog::saveFile(m_lastDocument, path, &bytes, &error)) {
        QMessageBox::warning(this, tr("保存整机方案失败"), error);
        return;
    }
    qInfo().noquote() << "FT_QT_CASE_SAVED path=" << path << "bytes=" << bytes
                      << "moves=" << m_lastMoves.size();
    statusBar()->showMessage(tr("已保存整机方案：%1（%2 字节，含 %3 次手工调整）")
                                 .arg(path).arg(bytes).arg(m_lastMoves.size()), 15000);
}

void MainWindow::nudgeStation(const QString &scope, int dx, int dy, int dz) {
    if (m_lastBrief.trimmed().isEmpty()) {
        statusBar()->showMessage(tr("需要先用 brief 生成方案，才知道怎么重算"), 8000);
        return;
    }
    const QStringList members = partsOfScope(m_lastDocument, scope);
    if (members.isEmpty()) {
        statusBar()->showMessage(tr("这个零件没有同前缀的伙伴，按 Ctrl 挪没有意义（用单件微调）"), 8000);
        return;
    }
    QStringList moves = m_lastMoves;
    for (const QString &id : members) {
        moves << QStringLiteral("%1:%2,%3,%4").arg(id).arg(dx).arg(dy).arg(dz);
    }
    QApplication::setOverrideCursor(Qt::WaitCursor);
    QJsonObject updated;
    QString error;
    const bool ok = designMachineFromBrief(m_lastBrief, &updated, &error, moves);
    QApplication::restoreOverrideCursor();
    if (!ok) {
        statusBar()->showMessage(tr("整站挪失败：%1").arg(error), 15000);
        return;
    }
    m_lastMoves = moves;
    updated = withStaleStamp(updated, m_lastCompliance, m_lastMoves.size());
    m_lastDocument = updated;
    int shapes = 0;
    QString geometryError;
    renderMachineGeometry(updated, &shapes, &geometryError);
    const QJsonObject interference = updated.value(QStringLiteral("geometry")).toObject()
                                        .value(QStringLiteral("interference")).toObject();
    qInfo().noquote() << "FT_QT_STATION_MOVE scope=" << scope << "members=" << members.size()
                      << "d=" << dx << dy << dz
                      << "overlaps=" << interference.value(QStringLiteral("count")).toInt();
    const QJsonObject clearance = updated.value(QStringLiteral("geometry")).toObject()
                                      .value(QStringLiteral("clearance")).toObject();
    statusBar()->showMessage(tr("整站挪 %1（%2 件）(%3,%4,%5) · 重叠 %6 对 · 间距不足 %7 处")
                                 .arg(scope).arg(members.size()).arg(dx).arg(dy).arg(dz)
                                 .arg(interference.value(QStringLiteral("count")).toInt())
                                 .arg(clearance.value(QStringLiteral("count")).toInt()), 15000);
}

void MainWindow::nudgeSelectedPart(int dx, int dy, int dz) {
    if (m_selectedPartId.isEmpty()) {
        statusBar()->showMessage(tr("先在 3D 里点选一个零件，再用方向键微调"), 8000);
        return;
    }
    if (m_lastBrief.trimmed().isEmpty()) {
        statusBar()->showMessage(tr("需要先用 brief 生成方案，才知道怎么重算"), 8000);
        return;
    }
    QStringList moves = m_lastMoves;
    moves << QStringLiteral("%1:%2,%3,%4").arg(m_selectedPartId).arg(dx).arg(dy).arg(dz);
    QApplication::setOverrideCursor(Qt::WaitCursor);
    QJsonObject updated;
    QString error;
    const bool ok = designMachineFromBrief(m_lastBrief, &updated, &error, moves);
    QApplication::restoreOverrideCursor();
    if (!ok) {
        statusBar()->showMessage(tr("微调失败：%1").arg(error), 15000);
        return;
    }
    m_lastMoves = moves;   // 单件微调也要累计，否则「按建议挪」会把这次挪动覆盖掉
    // 手工挪动后几何变了：旧合规戳降级成 stale，别再让用户拿它当现状
    updated = withStaleStamp(updated, m_lastCompliance, m_lastMoves.size());
    m_lastDocument = updated;
    int shapes = 0;
    QString geometryError;
    renderMachineGeometry(updated, &shapes, &geometryError);
#ifdef AUTOMATIONCAD_HAVE_OCCT
    m_occtViewport->highlightPart(m_selectedPartId);   // 重算后保持选中态
#endif
    const QJsonObject interference = updated.value(QStringLiteral("geometry")).toObject()
                                        .value(QStringLiteral("interference")).toObject();
    qInfo().noquote() << "FT_QT_NUDGE part=" << m_selectedPartId << "delta=" << dx << dy << dz
                      << "count=" << interference.value(QStringLiteral("count")).toInt();
    statusBar()->showMessage(tr("已挪 %1 (%2,%3,%4) · 重叠 %5 对（需确认 %6）")
                                 .arg(m_selectedPartId).arg(dx).arg(dy).arg(dz)
                                 .arg(interference.value(QStringLiteral("count")).toInt())
                                 .arg(interference.value(QStringLiteral("suspects")).toInt()), 15000);
}

void MainWindow::tunePlacementDialog() {
    if (m_lastBrief.trimmed().isEmpty()) {
        QMessageBox::information(this, tr("试摆位"),
                                 tr("先「从 brief 生成整机方案」或「打开整机方案」，才知道要挪哪台机器。"));
        return;
    }
    QJsonObject document;
    QString error;
    if (!designMachineFromBrief(m_lastBrief, &document, &error, m_lastMoves)) {
        // 重新生成失败时不阻塞：直接拿上一次结果里的零件列表
        document = m_lastDocument;
    }
    const QJsonArray parts = document.value(QStringLiteral("geometry")).toObject()
                                 .value(QStringLiteral("parts")).toArray();
    if (parts.isEmpty()) {
        QMessageBox::information(this, tr("试摆位"), tr("当前方案没有几何，先「从 brief 生成整机方案」。"));
        return;
    }

    QDialog dialog(this);
    dialog.setWindowTitle(tr("试摆位（移动一个零件后重算干涉）"));
    auto *form = new QFormLayout(&dialog);
    auto *combo = new QComboBox(&dialog);
    for (const QJsonValue &value : parts) {
        const QJsonObject part = value.toObject();
        combo->addItem(tr("%1（%2）").arg(part.value(QStringLiteral("name")).toString(),
                                         part.value(QStringLiteral("id")).toString()),
                       part.value(QStringLiteral("id")).toString());
    }
    auto *dx = new QDoubleSpinBox(&dialog);
    auto *dy = new QDoubleSpinBox(&dialog);
    auto *dz = new QDoubleSpinBox(&dialog);
    for (QDoubleSpinBox *box : {dx, dy, dz}) {
        box->setRange(-5000.0, 5000.0);
        box->setDecimals(1);
        box->setSuffix(tr(" mm"));
    }
    form->addRow(tr("零件"), combo);
    form->addRow(tr("X 位移"), dx);
    form->addRow(tr("Y 位移"), dy);
    form->addRow(tr("Z 位移"), dz);
    auto *hint = new QLabel(tr("增量叠加：这次挪 10，下次在这个基础上再挪。只动中心点，不改尺寸/旋转。"), &dialog);
    hint->setWordWrap(true);
    form->addRow(hint);
    auto *buttons = new QDialogButtonBox(QDialogButtonBox::Ok | QDialogButtonBox::Cancel, &dialog);
    form->addRow(buttons);
    connect(buttons, &QDialogButtonBox::accepted, &dialog, &QDialog::accept);
    connect(buttons, &QDialogButtonBox::rejected, &dialog, &QDialog::reject);
    if (dialog.exec() != QDialog::Accepted) return;
    if (dx->value() == 0.0 && dy->value() == 0.0 && dz->value() == 0.0) {
        statusBar()->showMessage(tr("位移全是 0，没有重算"), 6000);
        return;
    }

    QStringList moves = m_lastMoves;
    moves << QStringLiteral("%1:%2,%3,%4").arg(combo->currentData().toString())
                                               .arg(dx->value()).arg(dy->value()).arg(dz->value());

    QApplication::setOverrideCursor(Qt::WaitCursor);
    QJsonObject updated;
    const bool ok = designMachineFromBrief(m_lastBrief, &updated, &error, moves);
    QApplication::restoreOverrideCursor();
    if (!ok) {
        QMessageBox::warning(this, tr("试摆位失败"), error);
        return;
    }
    m_lastDocument = updated;
    int shapes = 0;
    QString geometryError;
    if (!renderMachineGeometry(updated, &shapes, &geometryError)) {
        statusBar()->showMessage(tr("已重算，但 3D 没画出来：%1").arg(geometryError), 15000);
    }
    const QJsonObject interference = updated.value(QStringLiteral("geometry")).toObject()
                                        .value(QStringLiteral("interference")).toObject();
    statusBar()->showMessage(tr("试摆位后：%1 对重叠（需确认 %2 / 已声明 %3）")
                                 .arg(interference.value(QStringLiteral("count")).toInt())
                                 .arg(interference.value(QStringLiteral("suspects")).toInt())
                                 .arg(interference.value(QStringLiteral("declared")).toInt()), 20000);
    showMachineCase(updated);
}

bool MainWindow::exportMachineStlForTest(const QString &path, int *bytes, QString *error) {
#ifdef AUTOMATIONCAD_HAVE_OCCT
    if (!m_occtViewport) {
        *error = tr("没有 3D 视口");
        return false;
    }
    return m_occtViewport->exportMachineStl(path, bytes, error);
#else
    Q_UNUSED(path)
    Q_UNUSED(bytes)
    *error = tr("这个构建没有 OCCT，导出整机示意 STL 不可用");
    return false;
#endif
}

bool MainWindow::loadCatalog(QJsonArray *catalog, QString *error) {
    QString script = qEnvironmentVariable("AUTOMATIONCAD_PIPELINE");
    if (script.isEmpty()) {
        QDir probe(QCoreApplication::applicationDirPath());
        const QString rel = QStringLiteral("desktop/scripts/machine-design-cli.mjs");
        for (int depth = 0; depth < 8; ++depth) {
            const QString candidate = QFileInfo(probe.filePath(rel)).absoluteFilePath();
            if (QFileInfo::exists(candidate)) { script = candidate; break; }
            if (!probe.cdUp()) break;
        }
    }
    if (script.isEmpty() || !QFileInfo::exists(script)) {
        *error = tr("找不到整机管线脚本；设置 AUTOMATIONCAD_PIPELINE");
        return false;
    }
    QProcess process;
    process.start(QStringLiteral("node"), {script, QStringLiteral("--catalog")});
    if (!process.waitForFinished(20'000)) {
        process.kill();
        *error = tr("读取构件库超时");
        return false;
    }
    const QJsonDocument parsed = QJsonDocument::fromJson(process.readAllStandardOutput());
    if (!parsed.isObject() || parsed.object().value(QStringLiteral("kind")).toString() != QStringLiteral("machine-catalog")) {
        *error = tr("构件库输出不是 machine-catalog");
        return false;
    }
    *catalog = parsed.object().value(QStringLiteral("catalog")).toArray();
    return true;
}

bool MainWindow::movePartTo(const QString &partId, double x, double y, int *partCount, QString *error) {
    if (m_lastBrief.trimmed().isEmpty()) {
        *error = tr("还没有整机方案");
        return false;
    }
    // 当前位置从方案里读（不能拿鼠标按下时的坐标当基准）
    QJsonArray parts = m_lastDocument.value(QStringLiteral("geometry")).toObject()
                           .value(QStringLiteral("parts")).toArray();
    QJsonArray center;
    for (const QJsonValue &entry : parts) {
        const QJsonObject part = entry.toObject();
        if (part.value(QStringLiteral("id")).toString() == partId) {
            center = part.value(QStringLiteral("center")).toArray();
            break;
        }
    }
    if (center.size() != 3) {
        *error = tr("方案里找不到零件 %1").arg(partId);
        return false;
    }
    const double dx = x - center.at(0).toDouble();
    const double dy = y - center.at(1).toDouble();
    if (std::abs(dx) < 0.5 && std::abs(dy) < 0.5) {
        *error = tr("位移太小（0 mm），没有提交");
        return false;
    }
    if (!m_lastDocument.isEmpty()) m_insertHistory.append(m_lastDocument);   // 拖动同样可撤销
    QStringList moves = m_lastMoves;
    moves << QStringLiteral("%1:%2,%3,0").arg(partId).arg(dx, 0, 'f', 1).arg(dy, 0, 'f', 1);
    QJsonObject document;
    if (!designMachineFromBrief(m_lastBrief, &document, error, moves)) return false;
    m_lastMoves = moves;
    m_lastDocument = document;
    *partCount = document.value(QStringLiteral("geometry")).toObject()
                     .value(QStringLiteral("parts")).toArray().size();
    int shapes = 0;
    QString renderError;
    renderMachineGeometry(document, &shapes, &renderError);
    qInfo().noquote() << "FT_QT_PART_MOVED" << partId << "dx=" << dx << "dy=" << dy;
    return true;
}

bool MainWindow::undoLastInsert(int *partCount, QString *error) {
    if (m_insertHistory.isEmpty()) {
        *error = tr("没有可撤销的插入");
        return false;
    }
    const QJsonObject previous = m_insertHistory.takeLast();
    m_lastDocument = previous;
    int shapes = 0;
    QString renderError;
    if (!renderMachineGeometry(previous, &shapes, &renderError)) {
        *error = renderError;
        return false;
    }
    *partCount = previous.value(QStringLiteral("geometry")).toObject()
                     .value(QStringLiteral("parts")).toArray().size();
    qInfo().noquote() << "FT_QT_UNDO_INSERT parts=" << *partCount << "depth=" << m_insertHistory.size();
    return true;
}

bool MainWindow::screenPointToGroundForTest(int x, int y, double *worldX, double *worldY) {
#ifdef AUTOMATIONCAD_HAVE_OCCT
    if (!m_occtViewport) return false;
    return m_occtViewport->screenToGround(x, y, worldX, worldY);
#else
    Q_UNUSED(x); Q_UNUSED(y); Q_UNUSED(worldX); Q_UNUSED(worldY);
    return false;
#endif
}

bool MainWindow::previewForTest(const QString &type, double x, double y, QString *error) {
#ifdef AUTOMATIONCAD_HAVE_OCCT
    if (!m_occtViewport) { *error = tr("没有 OCCT 视口"); return false; }
    if (m_catalogCache.isEmpty()) {
        QJsonArray catalog;
        if (!loadCatalog(&catalog, error)) return false;
        m_catalogCache = catalog;
    }
    for (const QJsonValue &entry : m_catalogCache) {
        const QJsonObject item = entry.toObject();
        if (item.value(QStringLiteral("type")).toString() != type) continue;
        const QJsonArray size = item.value(QStringLiteral("shape")).toObject().value(QStringLiteral("size")).toArray();
        if (size.size() != 3) { *error = tr("构件 %1 没有盒体尺寸").arg(type); return false; }
        const double sx = size.at(0).toDouble();
        const double sy = size.at(1).toDouble();
        const double sz = size.at(2).toDouble();
        // 本地 AABB 判定：候选盒 vs 文档里已有零件的包围盒
        const double gapMm = 20.0;
        double nearestGap = 1e9;
        bool overlaps = false;
        for (const QJsonValue &boundValue : m_partBounds) {
            const QJsonObject bound = boundValue.toObject();
            const QJsonArray min = bound.value(QStringLiteral("min")).toArray();
            const QJsonArray max = bound.value(QStringLiteral("max")).toArray();
            if (min.size() != 3 || max.size() != 3) continue;
            double dx = 0, dy = 0, dz = 0;
            const double cmin[3] = {x - sx / 2, y - sy / 2, 0.0};
            const double cmax[3] = {x + sx / 2, y + sy / 2, sz};
            bool hit = true;
            for (int axis = 0; axis < 3; ++axis) {
                const double low = min.at(axis).toDouble();
                const double high = max.at(axis).toDouble();
                const double gap = std::max({0.0, low - cmax[axis], cmin[axis] - high});
                if (axis == 0) dx = gap; else if (axis == 1) dy = gap; else dz = gap;
                if (gap <= 0.0) continue;
                hit = false;
            }
            if (hit) { overlaps = true; break; }
            nearestGap = std::min(nearestGap, std::sqrt(dx * dx + dy * dy + dz * dz));
        }
        const int state = overlaps ? 2 : (nearestGap < gapMm ? 1 : 0);
        m_previewState = state;
        m_occtViewport->showPreviewBox(sx, sy, sz, x, y, state);
        return true;
    }
    *error = tr("构件库里没有 %1").arg(type);
    return false;
#else
    Q_UNUSED(type); Q_UNUSED(x); Q_UNUSED(y);
    *error = tr("这个构建没有 OCCT");
    return false;
#endif
}

bool MainWindow::previewVisibleForTest() const {
#ifdef AUTOMATIONCAD_HAVE_OCCT
    return m_occtViewport && m_occtViewport->previewVisible();
#else
    return false;
#endif
}

bool MainWindow::insertPartFromCatalog(const QString &type, const QVector3D &at, int *partCount, QString *error) {
    if (m_lastBrief.trimmed().isEmpty()) {
        *error = tr("还没有整机方案：先用 文件 → 从一句话生成整机 建一台");
        return false;
    }
    const QString spec = QStringLiteral("%1@%2,%3,%4")
                             .arg(type)
                             .arg(at.x(), 0, 'f', 1)
                             .arg(at.y(), 0, 'f', 1)
                             .arg(at.z(), 0, 'f', 1);
    if (!m_lastDocument.isEmpty()) m_insertHistory.append(m_lastDocument);
    QJsonObject document;
    if (!designMachineFromBrief(m_lastBrief, &document, error, m_lastMoves, false, 0, false, -1, false, {}, spec)) {
        m_insertHistory.removeLast();   // 插入失败就别留快照，否则撤销会倒退到同一个状态
        return false;
    }
    const QJsonObject geometry = document.value(QStringLiteral("geometry")).toObject();
    const QJsonArray parts = geometry.value(QStringLiteral("parts")).toArray();
    *partCount = parts.size();
    // 插入后顺带跑一次**整机**间距初筛（不是只看新构件：最紧的一对可能跟它无关，这里如实报整机口径）
    const QJsonObject clearance = geometry.value(QStringLiteral("clearance")).toObject();
    const QJsonArray gapPairs = clearance.value(QStringLiteral("pairs")).toArray();
    if (!gapPairs.isEmpty()) {
        const QJsonObject tightest = gapPairs.first().toObject();
        qInfo().noquote() << "FT_QT_INSERT_CLEARANCE count=" << clearance.value(QStringLiteral("count")).toInt()
                          << "tightest=" << tightest.value(QStringLiteral("gapMm")).toDouble()
                          << tightest.value(QStringLiteral("a")).toString()
                          << tightest.value(QStringLiteral("b")).toString();
    }
    m_lastDocument = document;
    int shapes = 0;
    QString renderError;
    renderMachineGeometry(document, &shapes, &renderError);
    return true;
}

void MainWindow::exportMachineStlDialog() {
#ifdef AUTOMATIONCAD_HAVE_OCCT
    const QString path = QFileDialog::getSaveFileName(this, tr("导出整机示意 STL"),
                                                      QStringLiteral("machine-layout.stl"), tr("STL 文件 (*.stl)"));
    if (path.isEmpty()) return;
    int bytes = 0;
    QString error;
    if (!m_occtViewport->exportMachineStl(path, &bytes, &error)) {
        QMessageBox::warning(this, tr("导出失败"), error);
        return;
    }
    statusBar()->showMessage(tr("已导出整机示意 %1 · %2 字节（概念占位体，不是制造几何）")
                                 .arg(QFileInfo(path).fileName()).arg(bytes), 15000);
#else
    QMessageBox::information(this, tr("导出整机示意 STL"),
                             tr("这个构建没有 OCCT——需要在带 OCCT 头文件的构建里导出。"));
#endif
}

void MainWindow::exportStlDialog() {
    const QString suggested = m_assemblyId.isEmpty()
        ? m_documentId + QStringLiteral(".stl")
        : m_assemblyId + QStringLiteral(".stl");
    const QString path = QFileDialog::getSaveFileName(this, tr("导出 STL"), suggested, tr("STL 文件 (*.stl)"));
    if (path.isEmpty()) return;
    QByteArray stl;
    QString error;
    if (!fetchGeometryStl(&stl, &error)) {
        QMessageBox::warning(this, tr("导出失败"), error);
        return;
    }
    QFile file(path);
    if (!file.open(QIODevice::WriteOnly)) {
        QMessageBox::warning(this, tr("导出失败"), tr("写文件失败：%1").arg(file.errorString()));
        return;
    }
    file.write(stl);
    file.close();
    const int triangles = stl.size() >= 84 ? (stl.size() - 84) / 50 : 0;
    statusBar()->showMessage(tr("已导出 %1 · %2 字节 · %3 三角面").arg(QFileInfo(path).fileName()).arg(stl.size()).arg(triangles), 10000);
}

void MainWindow::runAssemblyBom() {
    if (m_assemblyId.isEmpty()) {
        QMessageBox::information(this, tr("装配清单"), tr("先打开一个装配，再取清单。"));
        return;
    }
    QNetworkRequest req{QUrl(m_serviceBase + QStringLiteral("/v1/assemblies/") +
                             QString::fromUtf8(QUrl::toPercentEncoding(m_assemblyId)) + QStringLiteral("/bom"))};
    req.setTransferTimeout(20'000);
    QNetworkReply *reply = m_net->get(req);
    connect(reply, &QNetworkReply::finished, this, [this, reply]() {
        reply->deleteLater();
        const QJsonObject result = readReply(reply);
        if (reply->error() != QNetworkReply::NoError || result.contains(QStringLiteral("error"))) {
            QMessageBox::warning(this, tr("装配清单失败"),
                result.value(QStringLiteral("message")).toString(reply->errorString()));
            return;
        }
        const QJsonArray members = result.value(QStringLiteral("members")).toArray();
        QDialog dialog(this);
        dialog.setWindowTitle(tr("装配清单：%1").arg(m_assemblyId));
        auto *layout = new QVBoxLayout(&dialog);
        auto *table = new QTableWidget(members.size(), 5, &dialog);
        table->setHorizontalHeaderLabels({tr("成员"), tr("材质"), tr("单件质量"), tr("数量"), tr("小计")});
        table->verticalHeader()->setVisible(false);
        table->setEditTriggers(QAbstractItemView::NoEditTriggers);
        table->horizontalHeader()->setStretchLastSection(true);
        double total = 0.0;
        bool complete = true;
        for (int row = 0; row < members.size(); ++row) {
            const QJsonObject member = members.at(row).toObject();
            const int count = member.value(QStringLiteral("count")).toInt(1);
            const QJsonValue mass = member.value(QStringLiteral("massKg"));
            table->setItem(row, 0, new QTableWidgetItem(member.value(QStringLiteral("documentId")).toString()));
            table->setItem(row, 1, new QTableWidgetItem(member.value(QStringLiteral("materialLabel")).toString()));
            if (mass.isDouble()) {
                table->setItem(row, 2, new QTableWidgetItem(tr("%1 kg").arg(mass.toDouble(), 0, 'f', 4)));
                table->setItem(row, 3, new QTableWidgetItem(QString::number(count)));
                table->setItem(row, 4, new QTableWidgetItem(tr("%1 kg").arg(mass.toDouble() * count, 0, 'f', 4)));
                total += mass.toDouble() * count;
            } else {
                // 没重建过几何的成员不编质量，标“待重建”
                table->setItem(row, 2, new QTableWidgetItem(tr("待重建")));
                table->setItem(row, 3, new QTableWidgetItem(QString::number(count)));
                table->setItem(row, 4, new QTableWidgetItem(tr("—")));
                complete = false;
            }
        }
        table->resizeColumnsToContents();
        layout->addWidget(table);
        auto *summary = new QLabel(complete
            ? tr("合计 %1 件 · %2 kg").arg(result.value(QStringLiteral("count")).toInt()).arg(total, 0, 'f', 4)
            : tr("合计 %1 件 · 质量未齐（有成员未重建几何）").arg(result.value(QStringLiteral("count")).toInt()), &dialog);
        layout->addWidget(summary);
        auto *buttons = new QDialogButtonBox(QDialogButtonBox::Close, &dialog);
        QPushButton *exportCsv = buttons->addButton(tr("导出 CSV…"), QDialogButtonBox::ActionRole);
        connect(exportCsv, &QPushButton::clicked, &dialog, [this, members, total, complete, &dialog]() {
            const QString path = QFileDialog::getSaveFileName(&dialog, tr("导出装配清单"), m_assemblyId + QStringLiteral("-bom.csv"), tr("CSV 文件 (*.csv)"));
            if (path.isEmpty()) return;
            QFile file(path);
            if (!file.open(QIODevice::WriteOnly | QIODevice::Text)) {
                QMessageBox::warning(&dialog, tr("导出失败"), file.errorString());
                return;
            }
            QTextStream out(&file);
            out.setEncoding(QStringConverter::Utf8);
            out << "\xEF\xBB\xBF";  // BOM：Excel 打开中文不乱码
            out << "成员,材质,单件质量(kg),数量,小计(kg)\n";
            for (const QJsonValue &value : members) {
                const QJsonObject member = value.toObject();
                const int count = member.value(QStringLiteral("count")).toInt(1);
                const QJsonValue mass = member.value(QStringLiteral("massKg"));
                out << member.value(QStringLiteral("documentId")).toString() << ','
                    << member.value(QStringLiteral("materialLabel")).toString() << ',';
                if (mass.isDouble()) {
                    out << QString::number(mass.toDouble(), 'f', 4) << ',' << count << ','
                        << QString::number(mass.toDouble() * count, 'f', 4) << '\n';
                } else {
                    out << "待重建," << count << ",—\n";
                }
            }
            out << "合计,,,," << (complete ? QString::number(total, 'f', 4) : QStringLiteral("未齐")) << '\n';
            file.close();
            statusBar()->showMessage(tr("已导出清单 %1").arg(QFileInfo(path).fileName()), 8000);
        });
        connect(buttons, &QDialogButtonBox::rejected, &dialog, &QDialog::reject);
        layout->addWidget(buttons);
        dialog.resize(620, 320);
        dialog.exec();
    });
}

void MainWindow::runInterferenceCheck() {
    if (m_assemblyId.isEmpty()) {
        statusBar()->showMessage(tr("先在「文件 → 打开装配…」里打开一个装配，再做干涉检查"), 6000);
        return;
    }
    QJsonObject body;
    QNetworkRequest req{QUrl(m_serviceBase + QStringLiteral("/v1/assemblies/") +
                             QString::fromUtf8(QUrl::toPercentEncoding(m_assemblyId)) + QStringLiteral("/interference"))};
    req.setHeader(QNetworkRequest::ContentTypeHeader, QStringLiteral("application/json"));
    req.setTransferTimeout(60'000); // 布尔交集比读树慢得多
    QNetworkReply *reply = m_net->post(req, QJsonDocument(body).toJson());
    statusBar()->showMessage(tr("正在做布尔交集干涉检查（真实几何，不是 AABB 初筛）…"));
    connect(reply, &QNetworkReply::finished, this, [this, reply]() {
        reply->deleteLater();
        const QJsonObject result = readReply(reply);
        if (reply->error() != QNetworkReply::NoError || result.contains(QStringLiteral("error"))) {
            QMessageBox::warning(this, tr("干涉检查失败"),
                result.value(QStringLiteral("message")).toString(reply->errorString()));
            return;
        }
        const QJsonArray pairs = result.value(QStringLiteral("pairs")).toArray();
        QString detail;
        for (const auto &entry : pairs) {
            const QJsonObject pair = entry.toObject();
            const QJsonObject bbox = pair.value(QStringLiteral("bboxMm")).toObject();
            detail += tr("· %1 ↔ %2：干涉体积 %3 mm³（重叠区 %4×%5×%6 mm）\n")
                          .arg(pair.value(QStringLiteral("aId")).toString())
                          .arg(pair.value(QStringLiteral("bId")).toString())
                          .arg(pair.value(QStringLiteral("overlapMm3")).toDouble(), 0, 'f', 2)
                          .arg(bbox.value(QStringLiteral("x")).toDouble())
                          .arg(bbox.value(QStringLiteral("y")).toDouble())
                          .arg(bbox.value(QStringLiteral("z")).toDouble());
        }
        const QString summary = result.value(QStringLiteral("summary")).toString();
        if (pairs.isEmpty()) {
            QMessageBox::information(this, tr("干涉检查"), tr("%1\n\n检查成员：%2 个")
                                         .arg(summary).arg(result.value(QStringLiteral("checked")).toInt()));
        } else {
            QMessageBox::warning(this, tr("干涉检查"), tr("%1\n\n%2").arg(summary, detail));
        }
        statusBar()->showMessage(summary, 8000);
    });
}

void MainWindow::reloadDocuments() {
    QNetworkRequest req{QUrl(m_serviceBase + QStringLiteral("/v1/documents"))};
    req.setTransferTimeout(8000);
    QNetworkReply *reply = m_net->get(req);
    connect(reply, &QNetworkReply::finished, this, [this, reply]() {
        reply->deleteLater();
        const QJsonObject payload = readReply(reply);
        const QJsonArray documents = payload.value(QStringLiteral("documents")).toArray();
        if (reply->error() != QNetworkReply::NoError || documents.isEmpty()) return;
        m_documentCombo->blockSignals(true);
        m_documentCombo->clear();
        for (const auto &entry : documents) {
            const QJsonObject doc = entry.toObject();
            const QString id = doc.value(QStringLiteral("documentId")).toString();
            m_documentCombo->addItem(QStringLiteral("%1 · r%2").arg(id).arg(doc.value(QStringLiteral("revision")).toInt()), id);
            if (id == m_documentId) m_documentCombo->setCurrentIndex(m_documentCombo->count() - 1);
        }
        m_documentCombo->blockSignals(false);
    });
}

void MainWindow::onCreateDocument() {
    bool ok = false;
    const QString name = QInputDialog::getText(this, tr("新建文档"), tr("文档 id（字母数字与 . _ -）："),
                                               QLineEdit::Normal, QString(), &ok);
    if (!ok || name.trimmed().isEmpty()) return;
    QJsonObject body;
    body.insert(QStringLiteral("documentId"), name.trimmed());
    QNetworkRequest req{QUrl(m_serviceBase + QStringLiteral("/v1/documents"))};
    req.setHeader(QNetworkRequest::ContentTypeHeader, QStringLiteral("application/json"));
    req.setTransferTimeout(8000);
    QNetworkReply *reply = m_net->post(req, QJsonDocument(body).toJson());
    connect(reply, &QNetworkReply::finished, this, [this, reply, name]() {
        reply->deleteLater();
        const QJsonObject payload = readReply(reply);
        if (reply->error() != QNetworkReply::NoError || payload.contains(QStringLiteral("error"))) {
            QMessageBox::warning(this, tr("新建文档失败"), payload.value(QStringLiteral("message")).toString(reply->errorString()));
            return;
        }
        statusBar()->showMessage(tr("已新建文档 %1").arg(name), 4000);
        const QString id = payload.value(QStringLiteral("documentId")).toString();
        m_documentId = id;
        reloadDocuments();
        refreshNow();
    });
}

bool MainWindow::runDocumentSelfTest(const QString &base, int *newRevision, double *defaultHeight, QString *error) {
    m_serviceBase = base;
    int status = 0;
    QString localError;
    const auto heightOf = [](const QJsonObject &envelope) {
        for (const auto &fv : envelope.value(QStringLiteral("doc")).toObject().value(QStringLiteral("features")).toArray()) {
            const QJsonObject f = fv.toObject();
            if (f.value(QStringLiteral("id")).toString() == QStringLiteral("f-body")) {
                return f.value(QStringLiteral("params")).toObject().value(QStringLiteral("height")).toDouble();
            }
        }
        return -1.0;
    };

    const QJsonObject created = requestSync("POST", QStringLiteral("/v1/documents"),
                                            QJsonObject{{QStringLiteral("documentId"), QStringLiteral("doc-qt-test")}},
                                            &status, &localError);
    if (status != 201 && status != 409) {
        if (error) *error = tr("新建文档失败（HTTP %1）：%2").arg(status).arg(localError);
        return false;
    }

    QJsonObject body;
    body.insert(QStringLiteral("documentId"), QStringLiteral("doc-qt-test"));
    body.insert(QStringLiteral("expectedRevision"), created.value(QStringLiteral("revision")).toInt(0));
    body.insert(QStringLiteral("actor"), QStringLiteral("manual"));
    body.insert(QStringLiteral("operation"), QStringLiteral("updateFeatureParams"));
    body.insert(QStringLiteral("featureId"), QStringLiteral("f-body"));
    body.insert(QStringLiteral("patch"), QJsonObject{{QStringLiteral("height"), 44.0}});
    const QJsonObject wrote = requestSync("POST", QStringLiteral("/v1/operations"), body, &status, &localError);
    if (status != 200) {
        if (error) *error = tr("新文档写入失败（HTTP %1）：%2").arg(status).arg(wrote.value(QStringLiteral("message")).toString(localError));
        return false;
    }
    if (wrote.value(QStringLiteral("documentId")).toString() != QStringLiteral("doc-qt-test")) {
        if (error) *error = QStringLiteral("包络里的 documentId 不是 doc-qt-test");
        return false;
    }

    const QJsonObject def = requestSync("GET", QStringLiteral("/v1/tree"), {}, &status, &localError);
    if (status != 200) {
        if (error) *error = tr("读默认文档失败（HTTP %1）").arg(status);
        return false;
    }
    if (qAbs(heightOf(def) - 44.0) < 0.01) {
        if (error) *error = QStringLiteral("默认文档被新文档的写入影响了（高度被改成 44）");
        return false;
    }
    if (newRevision) *newRevision = wrote.value(QStringLiteral("revision")).toInt();
    if (defaultHeight) *defaultHeight = heightOf(def);
    return true;
}

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

void MainWindow::refreshNow() {
    if (!m_assemblyId.isEmpty()) { loadAssembly(m_assemblyId); return; }
    loadTree();
}

void MainWindow::openAssembly(const QString &assemblyId) {
    m_assemblyId = assemblyId;
    loadAssembly(assemblyId);
}

void MainWindow::loadAssembly(const QString &assemblyId) {
    QNetworkRequest req{QUrl(m_serviceBase + QStringLiteral("/v1/assemblies/") +
                             QString::fromUtf8(QUrl::toPercentEncoding(assemblyId)))};
    req.setTransferTimeout(30'000); // 装配要 fuse，比读树慢
    QNetworkReply *reply = m_net->get(req);
    connect(reply, &QNetworkReply::finished, this, [this, reply, assemblyId]() {
        reply->deleteLater();
        const QJsonObject record = readReply(reply);
        if (reply->error() != QNetworkReply::NoError || record.contains(QStringLiteral("error"))) {
            statusBar()->showMessage(tr("装配读取失败：%1")
                                         .arg(record.value(QStringLiteral("message")).toString(reply->errorString())), 8000);
            return;
        }
        m_assemblyRecord = record;
        const QJsonObject geometry = record.value(QStringLiteral("geometry")).toObject();
        const QJsonArray members = record.value(QStringLiteral("members")).toArray();

        m_tree->clear();
        auto *root = new QTreeWidgetItem(m_tree, {tr("装配 %1 · %2 个成员").arg(assemblyId).arg(members.size())});
        root->setToolTip(0, tr("装配只读视图：几何由服务端 fuse 合成，不是把成员体积相加"));
        int memberIndex = -1;
        for (const auto &entry : members) {
            ++memberIndex;
            const QJsonObject member = entry.toObject();
            const QJsonArray offset = member.value(QStringLiteral("offset")).toArray();
            const QJsonArray rotate = member.value(QStringLiteral("rotate")).toArray();
            const bool hasRotate = rotate.size() == 3 && (rotate.at(0).toDouble() || rotate.at(1).toDouble() || rotate.at(2).toDouble());
            const double rotateZ = hasRotate ? rotate.at(2).toDouble() : member.value(QStringLiteral("rotateZ")).toDouble();
            const QString rotateText = hasRotate
                ? tr(" · 转 X%1° Y%2° Z%3°").arg(rotate.at(0).toDouble()).arg(rotate.at(1).toDouble()).arg(rotate.at(2).toDouble())
                : (rotateZ != 0.0 ? tr(" · 绕 Z 转 %1°").arg(rotateZ) : QString());
            auto *item = new QTreeWidgetItem(root, {
                tr("%1（r%2） @ %3, %4, %5 mm%6")
                    .arg(member.value(QStringLiteral("documentId")).toString())
                    .arg(member.value(QStringLiteral("revision")).toInt())
                    .arg(offset.at(0).toDouble()).arg(offset.at(1).toDouble()).arg(offset.at(2).toDouble())
                    .arg(rotateText)
            });
            item->setData(0, Qt::UserRole, memberIndex);
            item->setToolTip(0, tr("双击改这个成员的偏移与转角"));
        }
        m_tree->expandAll();
        const QJsonObject bbox = geometry.value(QStringLiteral("bboxMm")).toObject();
        m_statusRevision->setText(tr("装配 %1").arg(assemblyId));
        m_statusGeometry->setText(tr("体积 %1 mm³ · 质量 %2 kg · %3×%4×%5 mm · 合成几何")
                                      .arg(geometry.value(QStringLiteral("volumeMm3")).toDouble(), 0, 'f', 1)
                                      .arg(geometry.value(QStringLiteral("massKg")).toDouble(), 0, 'f', 4)
                                      .arg(bbox.value(QStringLiteral("x")).toDouble())
                                      .arg(bbox.value(QStringLiteral("y")).toDouble())
                                      .arg(bbox.value(QStringLiteral("z")).toDouble()));
        m_documentCombo->setEnabled(false);
        // 装配几何单独取：revision 传 -1 强制重下（不同装配可能同 revision）
        setViewportGeometry(-1, m_serviceBase + QStringLiteral("/v1/assemblies/") +
                                    QString::fromUtf8(QUrl::toPercentEncoding(assemblyId)) + QStringLiteral("/geometry.stl"));
    });
}

void MainWindow::startAutoRefresh(int intervalMs) {
    if (!m_pollTimer) {
        m_pollTimer = new QTimer(this);
        connect(m_pollTimer, &QTimer::timeout, this, &MainWindow::refreshNow);
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
    // 装配视图期间不读零件树：否则启动时那次迟到的 /v1/tree 响应会把装配几何顶掉
    if (!m_assemblyId.isEmpty()) return;
    QNetworkRequest req(QUrl(m_serviceBase + QStringLiteral("/v1/tree") + docQuery()));
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

void MainWindow::setViewportGeometry(int revision, const QString &url) {
#ifdef AUTOMATIONCAD_HAVE_OCCT
    if (m_occtViewport) { m_occtViewport->ensureRevision(revision, url); return; }
#endif
    if (m_glViewport) m_glViewport->ensureRevision(revision, url);
}

void MainWindow::fitViewport() {
#ifdef AUTOMATIONCAD_HAVE_OCCT
    if (m_occtViewport) { m_occtViewport->fitView(); return; }
#endif
    if (m_glViewport) m_glViewport->fitView();
}

void MainWindow::applyStandardView(int which) { setViewportStandardView(which); }

void MainWindow::setViewportStandardView(int which) {
#ifdef AUTOMATIONCAD_HAVE_OCCT
    if (m_occtViewport) { m_occtViewport->setStandardView(which); return; }
#endif
    if (m_glViewport) m_glViewport->setStandardView(which);
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
    body.insert(QStringLiteral("documentId"), m_documentId);
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
    m_documentCombo->setEnabled(true);
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
        setViewportGeometry(-1, QString());
    } else {
        setViewportGeometry(revisionFromEnvelope, m_serviceBase + QStringLiteral("/v1/geometry.stl"));
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
    body.insert(QStringLiteral("documentId"), m_documentId);
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
    body.insert(QStringLiteral("documentId"), m_documentId);
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
    body.insert(QStringLiteral("documentId"), m_documentId);
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
    body.insert(QStringLiteral("documentId"), m_documentId);
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
