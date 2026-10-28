#pragma once
// OCCT AIS 视口：真的用 OpenCASCADE 的 V3d_View/AIS_InteractiveContext 渲染，
// 几何来源仍是服务端 /v1/geometry.stl（客户端不重算）。
//
// 为什么之前没用：本机是 Debian 12/13 混源，libocct-{data-exchange,visualization}-dev
// 被 libfreetype-dev 版本冲突卡住。现在把这两个 dev 包的**头文件**单独解出来放到
// /usr/local/include/opencascade（运行时 .so 本来就在），所以能编能跑。
#include <QWidget>

#include <AIS_InteractiveContext.hxx>
#include <AIS_Shape.hxx>
#include <Aspect_NeutralWindow.hxx>
#include <OpenGl_GraphicDriver.hxx>
#include <V3d_View.hxx>
#include <V3d_Viewer.hxx>

class QNetworkAccessManager;
class QNetworkReply;

class OcctViewport : public QWidget {
    Q_OBJECT
public:
    explicit OcctViewport(QWidget *parent = nullptr);
    ~OcctViewport() override;

    void ensureRevision(int revision, const QString &url);
    void loadFromUrl(const QString &url);
    void fitView();
    void setStandardView(int which);
    int triangleCount() const { return m_triangles; }
    bool ready() const { return m_viewReady; }

signals:
    void loaded(int triangles);
    void failed(const QString &message);

protected:
    void paintEvent(QPaintEvent *event) override;
    void resizeEvent(QResizeEvent *event) override;
    void showEvent(QShowEvent *event) override;
    void mousePressEvent(QMouseEvent *event) override;
    void mouseMoveEvent(QMouseEvent *event) override;
    void mouseReleaseEvent(QMouseEvent *event) override;
    void wheelEvent(QWheelEvent *event) override;

private:
    void initializeView();
    void displayShape(const TopoDS_Shape &shape);

    Handle(OpenGl_GraphicDriver) m_driver;
    Handle(V3d_Viewer) m_viewer;
    Handle(V3d_View) m_view;
    Handle(AIS_InteractiveContext) m_context;
    Handle(Aspect_NeutralWindow) m_window;
    Handle(AIS_Shape) m_shape;
    bool m_viewReady = false;
    bool m_hasGeometry = false;
    int m_triangles = 0;
    int m_revision = -1;
    QPoint m_lastPos;
    QNetworkAccessManager *m_net = nullptr;
    QNetworkReply *m_pending = nullptr;
};
