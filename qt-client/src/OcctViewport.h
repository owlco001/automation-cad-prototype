#pragma once
// OCCT AIS 视口：真的用 OpenCASCADE 的 V3d_View/AIS_InteractiveContext 渲染，
// 几何来源仍是服务端 /v1/geometry.stl（客户端不重算）。
//
// 为什么之前没用：本机是 Debian 12/13 混源，libocct-{data-exchange,visualization}-dev
// 被 libfreetype-dev 版本冲突卡住。现在把这两个 dev 包的**头文件**单独解出来放到
// /usr/local/include/opencascade（运行时 .so 本来就在），所以能编能跑。
#include <QColor>
#include <QJsonObject>
#include <QStringList>
#include <QVector>
#include <QWidget>

#include <AIS_InteractiveContext.hxx>
#include <AIS_Shape.hxx>
#include <Aspect_NeutralWindow.hxx>
#include <OpenGl_GraphicDriver.hxx>
#include <V3d_View.hxx>
#include <V3d_Viewer.hxx>

class QJsonObject;
class QNetworkAccessManager;
class QNetworkReply;

class OcctViewport : public QWidget {
    Q_OBJECT
public:
    explicit OcctViewport(QWidget *parent = nullptr);
    ~OcctViewport() override;

    /// 整机「示意装配」：把 machine-geometry 的占位体（box/cylinder）拼成一个 compound 显示。
    /// 几何来自 desktop 管线（conceptual-estimate），客户端不重算，只摆位。
    bool showMachineGeometry(const QJsonObject &geometry, int *shapeCount, QString *error);

    /// 点选整机示意里的一个零件：返回 partId（没点到返回空）。用射线求交，不走 AIS 选择
    /// （NeutralWindow 下 AIS 的 MoveTo/SelectDetected 实测段错误）。
    QString pickPartAt(int x, int y);
    /// 高亮某个零件（传空取消）
    void highlightPart(const QString &partId);
    /// 高亮一组零件（干涉对用：同时点亮两端）
    void highlightParts(const QStringList &partIds);

    /// 把当前整机示意几何导出成 STL（二进制/ASCII 由 OCCT 决定）。
    /// 注意：这是**摆位后的概念占位体**，不是制造几何。
    bool exportMachineStl(const QString &path, int *bytes, QString *error);

    void ensureRevision(int revision, const QString &url);
    void loadFromUrl(const QString &url);
    void fitView();
    void setStandardView(int which);
    int triangleCount() const { return m_triangles; }
    bool ready() const { return m_viewReady; }

signals:
    void loaded(int triangles);
    void failed(const QString &message);
    /// 选中面/边/点的测量结果
    void measured(const QString &message);
    /// 方向键微调请求（dx/dy/dz 单位 mm），由外面决定怎么应用
    void nudgeRequested(int dx, int dy, int dz);
    /// 点中整机示意里的零件（空 = 点到空白）
    void partPicked(const QString &partId);

protected:
    void paintEvent(QPaintEvent *event) override;
    void resizeEvent(QResizeEvent *event) override;
    void showEvent(QShowEvent *event) override;
    void mousePressEvent(QMouseEvent *event) override;
    void mouseMoveEvent(QMouseEvent *event) override;
    void mouseReleaseEvent(QMouseEvent *event) override;
    void wheelEvent(QWheelEvent *event) override;
    void keyPressEvent(QKeyEvent *event) override;

private:
    void initializeView();
    void displayShape(const TopoDS_Shape &shape);

    Handle(OpenGl_GraphicDriver) m_driver;
    Handle(V3d_Viewer) m_viewer;
    Handle(V3d_View) m_view;
    Handle(AIS_InteractiveContext) m_context;
    Handle(Aspect_NeutralWindow) m_window;
    Handle(AIS_Shape) m_shape;
    QVector<Handle(AIS_Shape)> m_shapes;
    QStringList m_shapePartIds;      // 与 m_shapes 一一对应的 partId
    QVector<QColor> m_shapeColors;   // 原始颜色（高亮后要能还原，不能一律变默认灰）
    QString m_highlighted;
    QJsonObject m_lastGeometry;  // 最近一次整机示意几何（导出 STL 用）  // 整机示意：每个零件一个 AIS 对象（各自颜色）
    bool m_viewReady = false;
    bool m_hasGeometry = false;
    int m_triangles = 0;
    int m_revision = -1;
    QPoint m_lastPos;
    QNetworkAccessManager *m_net = nullptr;
    QNetworkReply *m_pending = nullptr;
};
