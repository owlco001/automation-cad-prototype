#include "OcctViewport.h"

#include <QDebug>
#include <QDir>
#include <QMouseEvent>
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QPainter>
#include <QTemporaryFile>
#include <QWheelEvent>

#include <Aspect_DisplayConnection.hxx>
#include <BRepAdaptor_Surface.hxx>
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
    setMinimumSize(320, 240);
    setMouseTracking(false);
    setAttribute(Qt::WA_NativeWindow); // OCCT 要真的原生窗口句柄
    setAttribute(Qt::WA_OpaquePaintEvent);
    setAutoFillBackground(false);
}

OcctViewport::~OcctViewport() {
    if (m_pending) m_pending->abort();
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

        m_window = new Aspect_NeutralWindow();
        m_window->SetNativeHandle((Aspect_Drawable)winId());
        const qreal ratio = devicePixelRatioF();
        m_window->SetSize(static_cast<Standard_Integer>(width() * ratio), static_cast<Standard_Integer>(height() * ratio));
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
}

void OcctViewport::resizeEvent(QResizeEvent *event) {
    QWidget::resizeEvent(event);
    if (!m_viewReady || m_window.IsNull() || m_view.IsNull()) return;
    const qreal ratio = devicePixelRatioF();
    m_window->SetSize(static_cast<Standard_Integer>(width() * ratio), static_cast<Standard_Integer>(height() * ratio));
    m_view->MustBeResized();
}

void OcctViewport::paintEvent(QPaintEvent *) {
    if (!m_viewReady) {
        QPainter painter(this);
        painter.fillRect(rect(), QColor(0x17, 0x1a, 0x1f));
        painter.setPen(QColor(0x9a, 0xa3, 0xb2));
        painter.drawText(rect(), Qt::AlignCenter, tr("OCCT 视口未就绪"));
        return;
    }
    m_view->Redraw();
}

void OcctViewport::ensureRevision(int revision, const QString &url) {
    if (revision == m_revision && m_hasGeometry) return;
    m_revision = revision;
    if (!url.isEmpty()) loadFromUrl(url);
}

void OcctViewport::loadFromUrl(const QString &url) {
    qInfo().noquote() << "OCCT_LOAD_URL" << url;
    if (m_pending) { m_pending->abort(); m_pending->deleteLater(); m_pending = nullptr; }
    QNetworkRequest request{QUrl(url)};
    request.setTransferTimeout(15'000);
    request.setAttribute(QNetworkRequest::CacheLoadControlAttribute, QNetworkRequest::AlwaysNetwork);
    m_pending = m_net->get(request);
    connect(m_pending, &QNetworkReply::finished, this, [this]() {
        QNetworkReply *reply = m_pending;
        m_pending = nullptr;
        if (!reply) return;
        reply->deleteLater();
        if (reply->error() != QNetworkReply::NoError) {
            emit failed(tr("拉取几何失败：%1").arg(reply->errorString()));
            return;
        }
        const QByteArray data = reply->readAll();
        if (data.size() < kStlHeaderBytes) {
            emit failed(tr("STL 太短（%1 字节）").arg(data.size()));
            return;
        }
        quint32 count = 0;
        std::memcpy(&count, data.constData() + 80, sizeof(count));
        if (data.size() != kStlHeaderBytes + static_cast<qint64>(count) * kStlTriangleBytes) {
            emit failed(tr("STL 长度与三角面数不自洽（%1 字节 / %2 面）").arg(data.size()).arg(count));
            return;
        }
        // StlAPI_Reader 只吃文件：写临时文件再读，避免自己造 TopoDS 的误差
        // 临时文件必须落到系统临时目录：模板不带路径时会写到进程 cwd（实测把 .stl 漏进仓库根目录）
        QTemporaryFile temp(QDir::tempPath() + QStringLiteral("/automationcad-XXXXXX.stl"));
        temp.setAutoRemove(true);
        if (!temp.open()) {
            emit failed(tr("无法创建临时 STL 文件"));
            return;
        }
        temp.write(data);
        temp.flush();
        TopoDS_Shape shape;
        StlAPI_Reader reader;
        const bool read = reader.Read(shape, temp.fileName().toUtf8().constData());
        if (!read || shape.IsNull()) {
            emit failed(tr("OCCT 读取 STL 失败"));
            return;
        }
        m_triangles = static_cast<int>(count);
        qInfo().noquote() << "OCCT_LOAD_DONE tris=" << m_triangles << "bytes=" << data.size();
        displayShape(shape);
        emit loaded(m_triangles);
    });
}

void OcctViewport::displayShape(const TopoDS_Shape &shape) {
    initializeView();
    if (!m_viewReady) return;
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
    m_view->FitAll(0.02, false);
    m_view->Redraw();
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
