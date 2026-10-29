#include "OcctViewport.h"

#include <QDebug>
#include <QDir>
#include <QDragEnterEvent>
#include <QDropEvent>
#include <QMimeData>
#include <QMouseEvent>
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QPainter>
#include <QTemporaryFile>
#include <QWheelEvent>

#include <Aspect_DisplayConnection.hxx>
#ifdef _WIN32
#include <WNT_Window.hxx>
#else
#include <Aspect_NeutralWindow.hxx>
#include <BRepAlgoAPI_Cut.hxx>
#include <BRepBndLib.hxx>
#include <BRepPrimAPI_MakeBox.hxx>
#include <Bnd_Box.hxx>
#endif
#include <BRepAdaptor_Surface.hxx>
#include <BRepBuilderAPI_Transform.hxx>
#include <BRepPrimAPI_MakeBox.hxx>
#include <BRepPrimAPI_MakeCylinder.hxx>
#include <BRep_Builder.hxx>
#include <StlAPI_Writer.hxx>
#include <TopoDS_Compound.hxx>
#include <QFileInfo>
#include <QKeyEvent>
#include <QSet>
#include <QJsonArray>
#include <QJsonObject>
#include <gp_Ax1.hxx>
#include <gp_Ax2.hxx>
#include <gp_Dir.hxx>
#include <gp_Trsf.hxx>
#include <gp_Vec.hxx>
#include <cmath>
#include <BRepGProp.hxx>
#include <TopExp_Explorer.hxx>
#include <cmath>
#include <gp_Lin.hxx>
#include <IntCurvesFace_ShapeIntersector.hxx>
#include <gp_Dir.hxx>
#include <gp_Pnt.hxx>
#include <BRep_Tool.hxx>
#include <GProp_GProps.hxx>
#include <TopAbs_ShapeEnum.hxx>
#include <TopoDS.hxx>
#include <gp_Pnt.hxx>
#include <Graphic3d_MaterialAspect.hxx>
#include <Quantity_Color.hxx>
#include <V3d_ListOfLight.hxx>
#include <StlAPI_Reader.hxx>

namespace {
constexpr int kStlHeaderBytes = 84;
constexpr int kStlTriangleBytes = 50;
} // namespace

OcctViewport::OcctViewport(QWidget *parent) : QWidget(parent), m_net(new QNetworkAccessManager(this)) {
    // OCCT 用 WNT_Window 自己持有 GL 上下文，Qt 这边必须让开绘制权：
    // 不加 WA_PaintOnScreen，Qt 的 backing store 会把 GL 画面盖成纯黑（实测）。
    setAttribute(Qt::WA_PaintOnScreen, true);
    setAttribute(Qt::WA_NoSystemBackground, true);
    setAttribute(Qt::WA_OpaquePaintEvent, true);
    setAutoFillBackground(false);
    setFocusPolicy(Qt::StrongFocus);
    setMinimumSize(320, 240);
    setMouseTracking(false);
    setAttribute(Qt::WA_NativeWindow); // OCCT 要真的原生窗口句柄
    setAttribute(Qt::WA_OpaquePaintEvent);
    setAutoFillBackground(false);
}

OcctViewport::~OcctViewport() {
    if (m_pending) m_pending->abort();
    // 先放掉 AIS 对象，再拆 context/viewer：反过来的话 AIS_Shape 析构时还会碰已释放的 context
    if (!m_context.IsNull()) m_context->RemoveAll(false);
    m_shapes.clear();
    if (!m_shape.IsNull()) m_shape.Nullify();
    if (m_view) {
        m_view->Remove();
    }
    m_context.Nullify();
    m_view.Nullify();
    m_viewer.Nullify();
    m_driver.Nullify();
}

void OcctViewport::initializeView() {
    if (m_viewReady) return;
    try {
        Handle(Aspect_DisplayConnection) display = new Aspect_DisplayConnection();
        m_driver = new OpenGl_GraphicDriver(display);
        m_viewer = new V3d_Viewer(m_driver);
        m_viewer->SetDefaultLights();
        m_viewer->SetLightOn();
        // 默认灯光在浅色面上会过曝（实测俯视整块变纯白），统一压到 0.6
        for (V3d_ListOfLight::Iterator it(m_viewer->ActiveLights()); it.More(); it.Next()) {
            it.Value()->SetIntensity(0.85f);
        }
        m_context = new AIS_InteractiveContext(m_viewer);
        m_view = m_viewer->CreateView();

#ifdef _WIN32
        // Windows 上必须给 WNT_Window：Aspect_NeutralWindow 的 OpenGl_Window 建不出 GL 上下文，
        // SetWindow 会“成功”但画面永远是黑的（实测）；Linux 仍走 NeutralWindow。
        m_window = new WNT_Window(reinterpret_cast<Aspect_Handle>(winId()));
#else
        Handle(Aspect_NeutralWindow) neutral = new Aspect_NeutralWindow();
        neutral->SetNativeHandle((Aspect_Drawable)winId());
        const qreal ratio = devicePixelRatioF();
        neutral->SetSize(static_cast<Standard_Integer>(width() * ratio), static_cast<Standard_Integer>(height() * ratio));
        m_window = neutral;
#endif
        m_view->SetWindow(m_window);
        if (m_window.IsNull() || m_window->NativeHandle() == 0) {
            emit failed(tr("OCCT 视口初始化失败（窗口句柄无效），请检查图形驱动"));
            return;
        }
        // 注意用 sRGB 口径：OCCT 的 RGB 是线性色，直接塞 0.09 会被写进 sRGB 帧缓冲变成
        // 亮度 85 的中灰（实测），所以这里显式声明 sRGB，让它自己做转换。
        m_view->SetBackgroundColor(Quantity_Color(0.09, 0.10, 0.12, Quantity_TOC_sRGB));
        // 截图测量视角时用 AUTOMATIONCAD_OCCT_NO_TRIEDRON=1 关掉坐标三面，避免污染包围盒
        if (!qEnvironmentVariableIsSet("AUTOMATIONCAD_OCCT_NO_TRIEDRON")) {
            m_view->TriedronDisplay(Aspect_TOTP_LEFT_LOWER, Quantity_NOC_GRAY70, 0.08, V3d_ZBUFFER);
        }
        m_view->SetImmediateUpdate(false);
        m_viewReady = true;
    } catch (const Standard_Failure &error) {
            emit failed(tr("OCCT 初始化异常：%1").arg(QString::fromUtf8(error.GetMessageString())));
    }
}

void OcctViewport::showEvent(QShowEvent *event) {
    QWidget::showEvent(event);
    initializeView();
    // 初始化时控件还没拿到最终尺寸，窗口句柄尺寸要在 show 之后再同步一次
    if (m_viewReady && !m_view.IsNull()) m_view->MustBeResized();
}

void OcctViewport::resizeEvent(QResizeEvent *event) {
    QWidget::resizeEvent(event);
    if (!m_viewReady || m_window.IsNull() || m_view.IsNull()) return;
#ifndef _WIN32
    // WNT_Window 自己从 HWND 读客户区大小，不需要（也没有）SetSize
    const qreal ratio = devicePixelRatioF();
    Handle(Aspect_NeutralWindow)::DownCast(m_window)->SetSize(
        static_cast<Standard_Integer>(width() * ratio), static_cast<Standard_Integer>(height() * ratio));
#endif
    m_view->MustBeResized();
}

void OcctViewport::paintEvent(QPaintEvent *) {
    // paintEngine() 返回 nullptr，这里不能再用 QPainter
    if (!m_viewReady || m_view.IsNull()) return;
    m_view->Redraw();
}

bool OcctViewport::showMachineGeometry(const QJsonObject &geometry, int *shapeCount, QString *error) {
    const QJsonArray parts = geometry.value(QStringLiteral("parts")).toArray();
    if (parts.isEmpty()) {
        *error = tr("方案里没有几何（parts 为空）");
        return false;
    }
    if (!m_viewReady) {
        initializeView();
    }
    if (!m_viewReady) {
        *error = tr("3D 视口初始化失败");
        return false;
    }
    // 视口可能还没拿到真实尺寸（构造后立刻渲染时 width/height 是 0 → FitAll 算不出比例，画面空白）
    m_view->MustBeResized();

    // 每个零件单独显示并用自己的颜色：整机是 70 个占位体拼起来的，合成一个 compound 会变成一坨同色实体，
    // 看不出工位/门架/执行机构的结构。
    m_context->RemoveAll(false);
    m_shapes.clear();
    m_shapePartIds.clear();
    m_shapeColors.clear();
    m_highlighted.clear();
    int count = 0;
    for (const QJsonValue &value : parts) {
        const QJsonObject part = value.toObject();
        const QJsonObject shape = part.value(QStringLiteral("shape")).toObject();
        const QJsonArray center = part.value(QStringLiteral("center")).toArray();
        if (center.size() != 3) continue;

        TopoDS_Shape solid;
        if (shape.value(QStringLiteral("type")).toString() == QStringLiteral("box")) {
            const QJsonArray size = shape.value(QStringLiteral("size")).toArray();
            if (size.size() != 3) continue;
            const double x = size.at(0).toDouble();
            const double y = size.at(1).toDouble();
            const double z = size.at(2).toDouble();
            // center 是形体中心，不是角点
            solid = BRepPrimAPI_MakeBox(gp_Pnt(-x / 2, -y / 2, -z / 2), x, y, z).Shape();
        } else if (shape.value(QStringLiteral("type")).toString() == QStringLiteral("cylinder")) {
            const double radius = shape.value(QStringLiteral("radius")).toDouble();
            const double length = shape.value(QStringLiteral("length")).toDouble();
            if (radius <= 0 || length <= 0) continue;
            const QString axis = shape.value(QStringLiteral("axis")).toString();
            gp_Ax2 axis2(gp_Pnt(0, 0, 0), gp_Dir(0, 0, 1));
            if (axis == QStringLiteral("x")) axis2.SetDirection(gp_Dir(1, 0, 0));
            else if (axis == QStringLiteral("y")) axis2.SetDirection(gp_Dir(0, 1, 0));
            solid = BRepPrimAPI_MakeCylinder(axis2, radius, length).Shape();
            // 圆柱默认从原点朝 +轴 长出来，先挪到「以中心对称」
            gp_Trsf recenter;
            if (axis == QStringLiteral("x")) recenter.SetTranslation(gp_Vec(-length / 2, 0, 0));
            else if (axis == QStringLiteral("y")) recenter.SetTranslation(gp_Vec(0, -length / 2, 0));
            else recenter.SetTranslation(gp_Vec(0, 0, -length / 2));
            solid = BRepBuilderAPI_Transform(solid, recenter, true).Shape();
        }
        if (solid.IsNull()) continue;

        gp_Trsf placement;
        placement.SetRotation(gp_Ax1(gp_Pnt(0, 0, 0), gp_Dir(0, 0, 1)),
                              part.value(QStringLiteral("rotationZDeg")).toDouble() * M_PI / 180.0);
        placement.SetTranslationPart(gp_Vec(center.at(0).toDouble(), center.at(1).toDouble(), center.at(2).toDouble()));

        Handle(AIS_Shape) shapeHandle = new AIS_Shape(BRepBuilderAPI_Transform(solid, placement, true).Shape());
        const QString hex = part.value(QStringLiteral("color")).toString();
        QColor color(hex);
        if (!color.isValid()) color = QColor(QStringLiteral("#8a949c"));
        shapeHandle->SetColor(Quantity_Color(color.redF(), color.greenF(), color.blueF(), Quantity_TOC_sRGB));
        shapeHandle->SetMaterial(Graphic3d_NOM_PLASTIC);
#ifdef AUTOMATIONCAD_HAVE_OCCT
        m_machineSolids.append(shapeHandle->Shape());
#endif
        m_context->Display(shapeHandle, AIS_Shaded, -1, false);
        m_shapes.append(shapeHandle);
        m_shapePartIds.append(part.value(QStringLiteral("id")).toString());
        m_shapeColors.append(color);
        ++count;
    }
    if (count == 0) {
        *error = tr("几何里没有可显示的形体（%1 个零件全部无法识别）").arg(parts.size());
        return false;
    }
    m_hasGeometry = true;
    m_lastGeometry = geometry;
    *shapeCount = count;
    m_view->FitAll(0.02, false);
    m_view->Redraw();
    return true;
}


QString OcctViewport::pickPartAt(int x, int y) {
    if (!m_viewReady || m_shapes.isEmpty()) return QString();
    m_view->MustBeResized();
    Standard_Real px = 0.0, py = 0.0, pz = 0.0, dx = 0.0, dy = 0.0, dz = 0.0;
    m_view->ConvertWithProj(x, y, px, py, pz, dx, dy, dz);
    gp_Dir direction(dx, dy, dz);
    if (gp_Vec(direction).SquareMagnitude() < 1e-12) return QString();
    const gp_Pnt origin(px, py, pz);

    // 逐件求交取最近：70 个零件也就几十次射线求交，比维护 AIS 选择状态可靠
    Standard_Real best = 1e18;
    QString pickedId;
    for (int i = 0; i < m_shapes.size(); ++i) {
        IntCurvesFace_ShapeIntersector intersector;
        intersector.Load(m_shapes.at(i)->Shape(), 1e-6);
        intersector.Perform(gp_Lin(origin, direction), -1e6, 1e6);
        if (!intersector.IsDone() || intersector.NbPnt() < 1) continue;
        const Standard_Real w = intersector.WParameter(1);
        if (w < best) {
            best = w;
            pickedId = m_shapePartIds.value(i);
        }
    }
    return pickedId;
}

void OcctViewport::highlightParts(const QStringList &partIds) {
    if (!m_viewReady) return;
    const QSet<QString> wanted(partIds.begin(), partIds.end());
    for (int i = 0; i < m_shapes.size(); ++i) {
        const bool match = wanted.contains(m_shapePartIds.value(i));
        if (match) {
            m_shapes.at(i)->SetColor(Quantity_Color(1.0, 0.62, 0.20, Quantity_TOC_sRGB));
        } else if (i < m_shapeColors.size() && m_shapeColors.at(i).isValid()) {
            const QColor original = m_shapeColors.at(i);
            m_shapes.at(i)->SetColor(Quantity_Color(original.redF(), original.greenF(),
                                                    original.blueF(), Quantity_TOC_sRGB));
        }
    }
    m_highlighted = partIds.join(QLatin1Char(','));
    m_view->Redraw();
}

void OcctViewport::highlightPart(const QString &partId) {
    if (!m_viewReady) return;
    for (int i = 0; i < m_shapes.size(); ++i) {
        const bool match = !partId.isEmpty() && m_shapePartIds.value(i) == partId;
        if (match) {
            // 选中件用暖色，未选中恢复各自原始颜色（管线给的颜色，不能一律抹成默认灰）
            m_shapes.at(i)->SetColor(Quantity_Color(1.0, 0.62, 0.20, Quantity_TOC_sRGB));
        } else if (i < m_shapeColors.size() && m_shapeColors.at(i).isValid()) {
            const QColor original = m_shapeColors.at(i);
            m_shapes.at(i)->SetColor(Quantity_Color(original.redF(), original.greenF(),
                                                    original.blueF(), Quantity_TOC_sRGB));
        }
    }
    m_highlighted = partId;
    m_view->Redraw();
}

void OcctViewport::keyPressEvent(QKeyEvent *event) {
    const int step = (event->modifiers() & Qt::ShiftModifier) ? 10 : 1;
    switch (event->key()) {
    case Qt::Key_Left: emit nudgeRequested(-step, 0, 0); return;
    case Qt::Key_Right: emit nudgeRequested(step, 0, 0); return;
    case Qt::Key_Up: emit nudgeRequested(0, step, 0); return;
    case Qt::Key_Down: emit nudgeRequested(0, -step, 0); return;
    case Qt::Key_PageUp: emit nudgeRequested(0, 0, step); return;
    case Qt::Key_PageDown: emit nudgeRequested(0, 0, -step); return;
    default: break;
    }
    QWidget::keyPressEvent(event);
}

bool OcctViewport::exportMachineStl(const QString &path, int *bytes, QString *error) {
    if (m_shapes.isEmpty()) {
        *error = tr("当前没有整机示意几何可导出");
        return false;
    }
    BRep_Builder builder;
    TopoDS_Compound compound;
    builder.MakeCompound(compound);
    for (const Handle(AIS_Shape) &shape : m_shapes) {
        builder.Add(compound, shape->Shape());
    }
    StlAPI_Writer writer;
    writer.ASCIIMode() = Standard_False;
    if (!writer.Write(compound, path.toUtf8().constData())) {
        *error = tr("写 STL 失败：%1").arg(path);
        return false;
    }
    const qint64 size = QFileInfo(path).size();
    if (size <= 0) {
        *error = tr("写出的 STL 是空文件：%1").arg(path);
        return false;
    }
    *bytes = static_cast<int>(size);
    return true;
}

void OcctViewport::ensureRevision(int revision, const QString &url) {
    if (revision == m_revision && m_hasGeometry) return;
    m_revision = revision;
    if (!url.isEmpty()) loadFromUrl(url);
}

void OcctViewport::loadFromUrl(const QString &url) {
    if (url.isEmpty() || !m_net) return;
    if (m_pending) {
        // 同一个 URL 重复请求（刷新树和几何事件都会调到这里）直接合并。
        // 以前这里 abort() 旧请求再重发：实测 abort 会同步发 finished，把调用栈卡住不返回。
        if (m_pendingUrl == url) return;
        m_queuedUrl = url;   // 换成别的几何了：排队，等这次结束再发
        return;
    }
    startRequest(url);
}

void OcctViewport::startRequest(const QString &url) {
    qInfo().noquote() << "OCCT_LOAD" << url;
    QNetworkRequest request{QUrl(url)};
    request.setTransferTimeout(20'000);
    request.setAttribute(QNetworkRequest::CacheLoadControlAttribute, QNetworkRequest::AlwaysNetwork);
    QNetworkReply *reply = m_net->get(request);
    m_pending = reply;
    m_pendingUrl = url;
    connect(reply, &QNetworkReply::finished, this, [this, reply]() {
        // 捕获 reply 而不是读 m_pending：两次请求交错时 m_pending 已经换成新的了
        const bool replyOk = reply->error() == QNetworkReply::NoError;
        const QString replyError = reply->errorString();
        const QByteArray data = replyOk ? reply->readAll() : QByteArray();
        if (m_pending == reply) { m_pending = nullptr; m_pendingUrl.clear(); }
        reply->deleteLater();

        const QString queued = m_queuedUrl;
        m_queuedUrl.clear();

        if (!replyOk) {
            if (reply->error() != QNetworkReply::OperationCanceledError)
                emit failed(tr("拉取几何失败：%1").arg(replyError));
        } else if (data.size() < kStlHeaderBytes) {
            emit failed(tr("STL 太短（%1 字节）").arg(data.size()));
        } else {
            quint32 count = 0;
            std::memcpy(&count, data.constData() + 80, sizeof(count));
            if (data.size() != kStlHeaderBytes + static_cast<qint64>(count) * kStlTriangleBytes) {
                emit failed(tr("STL 长度与三角面数不自洽（%1 字节 / %2 面）").arg(data.size()).arg(count));
            } else {
                // StlAPI_Reader 只吃文件：写临时文件再读，避免自己造 TopoDS 的误差
                QTemporaryFile temp(QDir::tempPath() + QStringLiteral("/automationcad-XXXXXX.stl"));
                temp.setAutoRemove(true);
                if (!temp.open()) {
                    emit failed(tr("无法创建临时 STL 文件"));
                } else {
                    temp.write(data);
                    temp.flush();
                    TopoDS_Shape shape;
                    StlAPI_Reader reader;
                    const bool read = reader.Read(shape, temp.fileName().toUtf8().constData());
                    if (!read || shape.IsNull()) {
                        emit failed(tr("OCCT 读取 STL 失败"));
                    } else {
                        m_triangles = static_cast<int>(count);
                        qInfo().noquote() << "OCCT_LOAD_DONE tris=" << m_triangles << "bytes=" << data.size();
                        displayShape(shape);
                        emit loaded(m_triangles);
                    }
                }
            }
        }
        if (!queued.isEmpty()) loadFromUrl(queued);
    });
}

void OcctViewport::dragEnterEvent(QDragEnterEvent *event) {
    if (event->mimeData()->hasFormat(QStringLiteral("application/x-cad-part"))) event->acceptProposedAction();
}

void OcctViewport::dragMoveEvent(QDragMoveEvent *event) {
    if (!event->mimeData()->hasFormat(QStringLiteral("application/x-cad-part"))) return;
    const QString type = QString::fromUtf8(event->mimeData()->data(QStringLiteral("application/x-cad-part")));
    const QPoint pos = event->position().toPoint();
#ifdef AUTOMATIONCAD_HAVE_OCCT
    double wx = 0, wy = 0;
    if (screenToGround(pos.x(), pos.y(), &wx, &wy)) {
        emit dragPreview(type, std::round(wx / 10.0) * 10.0, std::round(wy / 10.0) * 10.0);
    }
#endif
    Q_UNUSED(pos);
    event->acceptProposedAction();
}

void OcctViewport::dragLeaveEvent(QDragLeaveEvent *event) {
    Q_UNUSED(event);
    clearPreviewBox();
}

void OcctViewport::showPreviewBox(double sizeX, double sizeY, double sizeZ, double x, double y, int state) {
#ifdef AUTOMATIONCAD_HAVE_OCCT
    if (!m_viewReady) return;
    clearPreviewBox();
    // 预览盒：只画不提交。半透明蓝灰，落地贴底（z 从 0 到 sizeZ）
    const TopoDS_Shape box = BRepPrimAPI_MakeBox(gp_Pnt(-sizeX / 2, -sizeY / 2, 0), sizeX, sizeY, sizeZ).Shape();
    gp_Trsf placement;
    placement.SetTranslation(gp_Vec(x, y, 0));
    m_previewHandle = new AIS_Shape(BRepBuilderAPI_Transform(box, placement, true).Shape());
    // 颜色即结论：绿=可以放、黄=贴近阈值、红=已经撞上（松手前就该看出来）
    const Quantity_Color color = state == 2 ? Quantity_Color(0.85, 0.25, 0.25, Quantity_TOC_sRGB)
                                : state == 1 ? Quantity_Color(0.90, 0.70, 0.20, Quantity_TOC_sRGB)
                                             : Quantity_Color(0.30, 0.75, 0.35, Quantity_TOC_sRGB);
    m_previewHandle->SetColor(color);
    m_previewHandle->SetTransparency(0.55);
    m_context->Display(m_previewHandle, AIS_Shaded, -1, false);
    m_previewActive = true;
    m_view->Redraw();
#endif
}

void OcctViewport::clearPreviewBox() {
#ifdef AUTOMATIONCAD_HAVE_OCCT
    if (m_previewActive && !m_previewHandle.IsNull()) {
        m_context->Remove(m_previewHandle, false);
        m_previewHandle.Nullify();
        if (m_viewReady) m_view->Redraw();
    }
#endif
    m_previewActive = false;
}

void OcctViewport::dropEvent(QDropEvent *event) {
    if (!event->mimeData()->hasFormat(QStringLiteral("application/x-cad-part"))) return;
    const QString type = QString::fromUtf8(event->mimeData()->data(QStringLiteral("application/x-cad-part")));
    const QPoint pos = event->position().toPoint();
#ifdef AUTOMATIONCAD_HAVE_OCCT
    double wx = 0, wy = 0;
    if (!screenToGround(pos.x(), pos.y(), &wx, &wy)) {
        qInfo().noquote() << "FT_QT_DROP_REJECT reason=no-ground-hit";
        return;
    }
    clearPreviewBox();   // 松手后预览盒必须消失，否则会和真实构件叠在一起
    const double snappedX = std::round(wx / 10.0) * 10.0;   // 10 mm 网格吸附
    const double snappedY = std::round(wy / 10.0) * 10.0;
    qInfo().noquote() << "FT_QT_DROP type=" << type << "ground=" << wx << wy
                      << "snapped=" << snappedX << snappedY;
    emit partDropped(type, snappedX, snappedY);
    event->acceptProposedAction();
#else
    Q_UNUSED(type); Q_UNUSED(pos);
#endif
}

void OcctViewport::displayShape(const TopoDS_Shape &shape) {
    initializeView();
    if (!m_viewReady) return;
#ifdef AUTOMATIONCAD_HAVE_OCCT
    m_fullShape = shape;   // 留一份原始几何，剖切可还原
#endif
    m_context->RemoveAll(false);
    m_shape = new AIS_Shape(shape);
    m_shape->SetColor(Quantity_Color(0.64, 0.70, 0.80, Quantity_TOC_sRGB));
    m_shape->SetMaterial(Graphic3d_NOM_PLASTIC);
    m_context->Display(m_shape, AIS_Shaded, -1, true);
    // 关键：显示之后再按「这个对象」激活选面模式。之前在 initializeView 里全局 Activate，
    // 会被 Display(..., mode=-1) 的默认模式覆盖，MoveTo 自然选不中任何东西。
    m_context->Activate(m_shape, AIS_Shape::SelectionMode(TopAbs_FACE));
    m_context->SetAutomaticHilight(true);
    m_hasGeometry = true;
    m_view->MustBeResized();   // 先按当前控件尺寸校正投影，再缩放
    m_view->FitAll(0.02, false);
    m_view->Redraw();
}

double OcctViewport::displayedVolumeMm3() const {
#ifdef AUTOMATIONCAD_HAVE_OCCT
    double total = 0.0;
    for (const Handle(AIS_Shape) &shape : m_shapes) {
        if (shape.IsNull()) continue;
        GProp_GProps props;
        BRepGProp::VolumeProperties(shape->Shape(), props);
        total += props.Mass();
    }
    return total;
#else
    return 0.0;
#endif
}

bool OcctViewport::setClipZ(double positionMm, QString *error) {
#ifndef AUTOMATIONCAD_HAVE_OCCT
    if (error) *error = QStringLiteral("这个构建没有 OCCT（-DAUTOMATIONCAD_OCCT=OFF），剖切不可用");
    Q_UNUSED(positionMm);
    return false;
#else
    if (!m_viewReady) {
        if (error) *error = QStringLiteral("视口还没建好，剖切无从下手");
        return false;
    }
    if (m_machineSolids.isEmpty()) {
        *error = QStringLiteral("视口里没有整机示意几何（剖切目前只对整机方案生效）");
        return false;
    }
    Bnd_Box box;
    for (const TopoDS_Shape &solid : m_machineSolids) BRepBndLib::Add(solid, box);
    double xmin = 0, ymin = 0, zmin = 0, xmax = 0, ymax = 0, zmax = 0;
    box.Get(xmin, ymin, zmin, xmax, ymax, zmax);
    const double pad = 50.0;
    const double height = positionMm - (zmin - pad);
    if (height <= 0) {
        *error = QStringLiteral("剖切位置 %1 mm 低于模型底面 %2 mm，切完什么都不剩").arg(positionMm).arg(zmin);
        return false;
    }
    // 用布尔切，不用 Graphic3d_ClipPlane：本机实测 AddClipPlane 之后画面一个像素都没变
    //（121951 → 121962），属于「标志位成功、实际没裁」，宁可慢也要真裁掉。
    const TopoDS_Shape cutter = BRepPrimAPI_MakeBox(gp_Pnt(xmin - pad, ymin - pad, zmin - pad),
                                                   (xmax - xmin) + 2 * pad, (ymax - ymin) + 2 * pad, height).Shape();
    m_context->RemoveAll(false);
    m_shapes.clear();
    int kept = 0;
    for (int i = 0; i < m_machineSolids.size(); ++i) {
        const TopoDS_Shape clipped = BRepAlgoAPI_Cut(m_machineSolids.at(i), cutter).Shape();
        if (clipped.IsNull()) continue;   // 整个件都在切掉的那一半
        Handle(AIS_Shape) handle = new AIS_Shape(clipped);
        const QColor color = i < m_shapeColors.size() ? m_shapeColors.at(i) : QColor(QStringLiteral("#8a949c"));
        handle->SetColor(Quantity_Color(color.redF(), color.greenF(), color.blueF(), Quantity_TOC_sRGB));
        handle->SetMaterial(Graphic3d_NOM_PLASTIC);
        m_context->Display(handle, AIS_Shaded, -1, false);
        m_shapes.append(handle);
        ++kept;
    }
    if (kept == 0) {
        *error = QStringLiteral("剖切后没有任何零件剩下");
        return false;
    }
    m_clipActive = true;
    m_clipZ = positionMm;
    m_view->FitAll(0.02, false);
    m_view->Redraw();
    return true;
#endif
}

void OcctViewport::clearClip() {
#ifdef AUTOMATIONCAD_HAVE_OCCT
    if (m_clipActive && !m_machineSolids.isEmpty()) {
        m_context->RemoveAll(false);
        m_shapes.clear();
        for (int i = 0; i < m_machineSolids.size(); ++i) {
            Handle(AIS_Shape) handle = new AIS_Shape(m_machineSolids.at(i));
            const QColor color = i < m_shapeColors.size() ? m_shapeColors.at(i) : QColor(QStringLiteral("#8a949c"));
            handle->SetColor(Quantity_Color(color.redF(), color.greenF(), color.blueF(), Quantity_TOC_sRGB));
            handle->SetMaterial(Graphic3d_NOM_PLASTIC);
            m_context->Display(handle, AIS_Shaded, -1, false);
            m_shapes.append(handle);
        }
        if (m_viewReady) { m_view->FitAll(0.02, false); m_view->Redraw(); }
    }
#endif
    m_clipActive = false;
}

bool OcctViewport::screenToGround(int x, int y, double *worldX, double *worldY) {
#ifdef AUTOMATIONCAD_HAVE_OCCT
    if (!m_viewReady) return false;
    Standard_Real px = 0, py = 0, pz = 0, vx = 0, vy = 0, vz = 0;
    m_view->ConvertWithProj(x, y, px, py, pz, vx, vy, vz);
    if (std::abs(vz) < 1e-9) return false;   // 视线与地面平行
    const double t = -pz / vz;
    if (t <= 0) return false;                // 地面在相机背后
    *worldX = px + vx * t;
    *worldY = py + vy * t;
    return true;
#else
    Q_UNUSED(x); Q_UNUSED(y); Q_UNUSED(worldX); Q_UNUSED(worldY);
    return false;
#endif
}

void OcctViewport::fitView() {
    if (!m_viewReady) return;
    m_view->FitAll(0.02, false);
    m_view->Redraw();
}

void OcctViewport::setStandardView(int which) {
    if (!m_viewReady) return;
    switch (which) {
    case 1: m_view->SetProj(V3d_Yneg); break;  // 正视
    case 2: m_view->SetProj(V3d_Zpos); break;  // 俯视
    case 3: m_view->SetProj(V3d_Xpos); break;  // 右视
    default: m_view->SetProj(V3d_XposYnegZpos); break; // 等轴测
    }
    m_view->FitAll(0.02, false);
    m_view->Redraw();
}

void OcctViewport::mousePressEvent(QMouseEvent *event) {
    m_lastPos = event->pos();
    if (event->button() == Qt::LeftButton && m_viewReady) m_view->StartRotation(event->pos().x(), event->pos().y());
}

void OcctViewport::mouseMoveEvent(QMouseEvent *event) {
    if (!(event->buttons() & Qt::LeftButton) || !m_viewReady) return;
    m_view->Rotation(event->pos().x(), event->pos().y());
    m_view->Redraw();
    m_lastPos = event->pos();
}

void OcctViewport::mouseReleaseEvent(QMouseEvent *event) {
    if (!m_viewReady) return;
    const QPoint delta = event->pos() - m_lastPos;
    m_view->Redraw();
    if (event->button() != Qt::LeftButton || delta.manhattanLength() > 4 || !m_hasGeometry) return;

    // 整机示意模式：点选零件（逐件射线求交），不走下面 STL 单件的测面积路径
    if (!m_shapes.isEmpty()) {
        setFocus(Qt::MouseFocusReason);
        emit partPicked(pickPartAt(event->pos().x(), event->pos().y()));
        return;
    }

    // 不用 AIS 的 SelectDetected：在 Aspect_NeutralWindow 下 MoveTo 会直接段错误（实测两次）。
    // 改成自己算射线，再与 BRep 求交——结果一样（最近的面），但没有那套隐藏状态。
    Standard_Real px = 0.0, py = 0.0, pz = 0.0, dx = 0.0, dy = 0.0, dz = 0.0;
    m_view->ConvertWithProj(event->pos().x(), event->pos().y(), px, py, pz, dx, dy, dz);
    gp_Pnt origin(px, py, pz);
    gp_Dir direction(dx, dy, dz);
    if (gp_Vec(direction).SquareMagnitude() < 1e-12) return;

    IntCurvesFace_ShapeIntersector intersector;
    intersector.Load(m_shape->Shape(), 1e-6);
    intersector.Perform(gp_Lin(origin, direction), -1e6, 1e6);
    if (!intersector.IsDone() || intersector.NbPnt() < 1) {
        emit measured(tr("未选中（点到空白处）"));
        return;
    }
    // 取最近的交点所在面
    Standard_Real nearest = 1e18;
    TopoDS_Face picked;
    for (Standard_Integer i = 1; i <= intersector.NbPnt(); ++i) {
        const Standard_Real w = intersector.WParameter(i);
        if (w < nearest) {
            nearest = w;
            picked = intersector.Face(i);
        }
    }
    if (picked.IsNull()) {
        emit measured(tr("未选中"));
        return;
    }
    // STL 读进来是「一个三角面 = 一个 TopoDS_Face」，直接取单面面积只有几 mm²。
    // 所以按「同一平面」把三角形合并：法向一致 + 到点同距，面积相加。
    BRepAdaptor_Surface pickedSurface(picked);
    double area = 0.0;
    if (pickedSurface.GetType() == GeomAbs_Plane) {
        const gp_Dir normal = pickedSurface.Plane().Axis().Direction();
        const gp_Pnt hit = intersector.Pnt(1);
        for (TopExp_Explorer explorer(m_shape->Shape(), TopAbs_FACE); explorer.More(); explorer.Next()) {
            const TopoDS_Face face = TopoDS::Face(explorer.Current());
            BRepAdaptor_Surface surface(face);
            if (surface.GetType() != GeomAbs_Plane) continue;
            gp_Dir faceNormal = surface.Plane().Axis().Direction();
            if (face.Orientation() == TopAbs_REVERSED) faceNormal.Reverse();
            if (std::abs(faceNormal.Dot(normal)) < 0.999) continue;
            if (std::abs(surface.Plane().Distance(hit)) > 1e-3) continue;
            GProp_GProps faceProps;
            BRepGProp::SurfaceProperties(face, faceProps);
            area += faceProps.Mass();
        }
    } else {
        GProp_GProps faceProps;
        BRepGProp::SurfaceProperties(picked, faceProps);
        area = faceProps.Mass();
    }
    emit measured(tr("选中平面 · 面积 %1 mm²（命中点 %2, %3, %4 mm）")
                      .arg(area, 0, 'f', 2)
                      .arg(intersector.Pnt(1).X(), 0, 'f', 2)
                      .arg(intersector.Pnt(1).Y(), 0, 'f', 2)
                      .arg(intersector.Pnt(1).Z(), 0, 'f', 2));
    qInfo().noquote() << "OCCT_PICK_RAY area=" << area << "w=" << nearest;
}

void OcctViewport::wheelEvent(QWheelEvent *event) {
    if (!m_viewReady) return;
    const double factor = event->angleDelta().y() > 0 ? 1.15 : 1.0 / 1.15;
    m_view->SetZoom(factor, true);
    m_view->Redraw();
}
