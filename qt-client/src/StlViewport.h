#pragma once
// STL 视口：几何唯一来源是契约服务的 /v1/geometry.stl（服务端 build123d 真建实体导出的二进制 STL）。
// 这里只做「读三角面 + 画」，不在客户端重算体积/质量/孔位。
//
// 为什么不用 OCCT AIS：本机是 Debian 12/13 混源，libocct-data-exchange-dev / visualization-dev
// 的依赖被 libfreetype-dev 版本冲突卡住（apt 报 held broken packages），运行时库虽在但拿不到头文件。
// 所以先用 OpenGL 直接画 STL；等 OCCT dev 包装得上，这个类可以整体换成 AIS_InteractiveContext，
// 上层接口（setRevision + loadFromUrl）不用改。
#include <QMatrix4x4>
#include <QOpenGLBuffer>
#include <QOpenGLFunctions_3_3_Core>
#include <QOpenGLShaderProgram>
#include <QOpenGLVertexArrayObject>
#include <QOpenGLWidget>
#include <QVector3D>
#include <QVector>

class QNetworkAccessManager;
class QNetworkReply;

class StlViewport : public QOpenGLWidget, protected QOpenGLFunctions_3_3_Core {
    Q_OBJECT
public:
    explicit StlViewport(QWidget *parent = nullptr);
    ~StlViewport() override;

    /// 从服务端拉 STL（二进制），成功则替换当前模型并 fit
    void loadFromUrl(const QString &url);
    /// 已经加载的版本号；与传入相同就不重复下载
    void ensureRevision(int revision, const QString &url);
    int triangleCount() const { return m_triangles; }
    void fitView();
    /// 标准视角：0=等轴测 1=正视(前) 2=俯视 3=右视
    void setStandardView(int which);
    /// 自检用：等一次加载结束（最多 timeoutMs），返回是否成功
    bool waitForLoad(int timeoutMs);

signals:
    void loaded(int triangles);
    void failed(const QString &message);

protected:
    void initializeGL() override;
    void resizeGL(int width, int height) override;
    void paintGL() override;
    void mousePressEvent(QMouseEvent *event) override;
    void mouseMoveEvent(QMouseEvent *event) override;
    void wheelEvent(QWheelEvent *event) override;

private:
    bool parseBinaryStl(const QByteArray &data, QVector<float> *vertices, int *triangles, QString *error);
    void uploadVertices(const QVector<float> &vertices);
    QVector3D m_center;
    float m_radius = 1.0f;

    QOpenGLShaderProgram m_program;
    QOpenGLVertexArrayObject m_vao;
    QOpenGLBuffer m_vbo{QOpenGLBuffer::VertexBuffer};
    QVector<float> m_pendingVertices;
    int m_vertexCount = 0;
    int m_triangles = 0;
    bool m_glReady = false;

    float m_yaw = -35.0f;
    float m_pitch = 22.0f;
    float m_zoom = 1.0f;
    QPoint m_lastPos;

    QNetworkAccessManager *m_net = nullptr;
    QNetworkReply *m_pending = nullptr;
    int m_revision = -1;
    bool m_loading = false;
    bool m_success = false;
};
