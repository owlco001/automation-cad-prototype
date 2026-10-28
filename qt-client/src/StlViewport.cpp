#include "StlViewport.h"

#include <QCoreApplication>
#include <QDebug>
#include <QElapsedTimer>
#include <QThread>
#include <QMouseEvent>
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QWheelEvent>
#include <QtMath>

#include <cstring>
#include <limits>

namespace {
constexpr int kHeaderBytes = 84;   // 80 字节 header + 4 字节三角面数
constexpr int kTriangleBytes = 50; // normal(12) + 3 × vertex(36) + attr(2)

struct Bounds {
    QVector3D min{std::numeric_limits<float>::max(), std::numeric_limits<float>::max(), std::numeric_limits<float>::max()};
    QVector3D max{std::numeric_limits<float>::lowest(), std::numeric_limits<float>::lowest(), std::numeric_limits<float>::lowest()};
    void include(const QVector3D &p) {
        min.setX(qMin(min.x(), p.x())); min.setY(qMin(min.y(), p.y())); min.setZ(qMin(min.z(), p.z()));
        max.setX(qMax(max.x(), p.x())); max.setY(qMax(max.y(), p.y())); max.setZ(qMax(max.z(), p.z()));
    }
};

const char *kVertexShader = R"(#version 330 core
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
uniform mat4 uMvp;
uniform mat4 uModel;
out vec3 vNormal;
out vec3 vPos;
void main() {
    vec4 world = uModel * vec4(aPos, 1.0);
    vPos = world.xyz;
    vNormal = mat3(uModel) * aNormal;
    gl_Position = uMvp * vec4(aPos, 1.0);
}
)";

const char *kFragmentShader = R"(#version 330 core
in vec3 vNormal;
in vec3 vPos;
uniform vec3 uLightDir;
out vec4 fragColor;
void main() {
    vec3 n = normalize(vNormal);
    // 双面光照：CAD 里常从背面看，背面不该是黑的
    float diff = abs(dot(n, normalize(uLightDir)));
    float rim = pow(1.0 - abs(n.z), 2.0) * 0.25;
    vec3 base = vec3(0.58, 0.64, 0.72);
    vec3 color = base * (0.35 + 0.75 * diff) + vec3(0.25, 0.45, 0.7) * rim;
    fragColor = vec4(color, 1.0);
}
)";
} // namespace

StlViewport::StlViewport(QWidget *parent) : QOpenGLWidget(parent), m_net(new QNetworkAccessManager(this)) {
    setMinimumSize(320, 240);
}

StlViewport::~StlViewport() {
    if (m_pending) m_pending->abort();
    makeCurrent();
    m_vbo.destroy();
    m_vao.destroy();
    doneCurrent();
}

void StlViewport::ensureRevision(int revision, const QString &url) {
    if (revision == m_revision && m_triangles > 0) return;
    m_revision = revision;
    loadFromUrl(url);
}

void StlViewport::loadFromUrl(const QString &url) {
    if (m_pending) { m_pending->abort(); m_pending->deleteLater(); m_pending = nullptr; }
    m_loading = true;
    m_success = false;
    QNetworkRequest request{QUrl(url)};
    request.setTransferTimeout(15'000);
    request.setAttribute(QNetworkRequest::CacheLoadControlAttribute, QNetworkRequest::AlwaysNetwork);
    m_pending = m_net->get(request);
    connect(m_pending, &QNetworkReply::finished, this, [this]() {
        QNetworkReply *reply = m_pending;
        m_pending = nullptr;
        m_loading = false;
        if (!reply) return;
        reply->deleteLater();
        if (reply->error() != QNetworkReply::NoError) {
            m_success = false;
            emit failed(tr("拉取几何失败：%1").arg(reply->errorString()));
            return;
        }
        const QByteArray data = reply->readAll();
        QVector<float> vertices;
        int triangles = 0;
        QString error;
        if (!parseBinaryStl(data, &vertices, &triangles, &error)) {
            m_success = false;
            emit failed(error);
            return;
        }
        m_triangles = triangles;
        m_revision = m_revision < 0 ? 0 : m_revision;
        // 先算包围盒再上传，fit 才有依据
        uploadVertices(vertices);
        m_success = true;
        fitView();
        update();
        emit loaded(m_triangles);
    });
}

bool StlViewport::waitForLoad(int timeoutMs) {
    QElapsedTimer timer;
    timer.start();
    while (m_loading && timer.elapsed() < timeoutMs) {
        QCoreApplication::processEvents(QEventLoop::AllEvents, 50);
        QThread::msleep(10);
    }
    return m_success && !m_loading && m_triangles > 0;
}

bool StlViewport::parseBinaryStl(const QByteArray &data, QVector<float> *vertices, int *triangles, QString *error) {
    if (data.size() < kHeaderBytes) {
        if (error) *error = tr("STL 太短（%1 字节），不是有效文件").arg(data.size());
        return false;
    }
    // ASCII STL 以 "solid" 开头，但二进制也可能以 solid 开头，所以用长度自洽来判断
    quint32 count = 0;
    std::memcpy(&count, data.constData() + 80, sizeof(count));
    if (data.size() == kHeaderBytes + static_cast<qint64>(count) * kTriangleBytes) {
        vertices->clear();
        vertices->reserve(count * 18);
        Bounds bounds;
        for (quint32 t = 0; t < count; ++t) {
            const char *base = data.constData() + kHeaderBytes + t * kTriangleBytes;
            // 不用 reinterpret_cast 读 float：STL 的 50 字节记录不保证 4 字节对齐，
            // 未对齐访问在部分平台会直接崩（x86 能跑，ARM 不一定）。
            const auto readVec = [](const char *from) {
                float xyz[3];
                std::memcpy(xyz, from, sizeof(xyz));
                return QVector3D(xyz[0], xyz[1], xyz[2]);
            };
            QVector3D normal = readVec(base);
            QVector3D a = readVec(base + 12);
            QVector3D b = readVec(base + 24);
            QVector3D c = readVec(base + 36);
            if (normal.lengthSquared() < 1e-12f) {
                // 有些导出器 normal 写 0，这里按顶点顺序补一个，否则整块面是黑的
                normal = QVector3D::crossProduct(b - a, c - a).normalized();
            }
            for (const QVector3D &v : {a, b, c}) {
                vertices->append(v.x()); vertices->append(v.y()); vertices->append(v.z());
                vertices->append(normal.x()); vertices->append(normal.y()); vertices->append(normal.z());
                bounds.include(v);
            }
        }
        m_center = (bounds.min + bounds.max) * 0.5f;
        const QVector3D size = bounds.max - bounds.min;
        m_radius = qMax(1.0f, size.length() * 0.5f);
        if (triangles) *triangles = static_cast<int>(count);
        return true;
    }
    if (error) {
        *error = tr("STL 长度与三角面数不自洽（%1 字节 / %2 面）").arg(data.size()).arg(count);
    }
    return false;
}

void StlViewport::uploadVertices(const QVector<float> &vertices) {
    m_vertexCount = vertices.size() / 6;
    if (m_glReady) {
        makeCurrent();
        m_vbo.bind();
        m_vbo.allocate(vertices.constData(), vertices.size() * static_cast<int>(sizeof(float)));
        m_vbo.release();
        doneCurrent();
    } else {
        // GL 还没初始化时先存着，initializeGL 里再上传
        m_pendingVertices = vertices;
    }
}

void StlViewport::initializeGL() {
    initializeOpenGLFunctions();
    m_glReady = true;
    glClearColor(0.09f, 0.10f, 0.12f, 1.0f);
    glEnable(GL_DEPTH_TEST);
    glEnable(GL_MULTISAMPLE);

    m_program.addShaderFromSourceCode(QOpenGLShader::Vertex, kVertexShader);
    m_program.addShaderFromSourceCode(QOpenGLShader::Fragment, kFragmentShader);
    if (!m_program.link()) {
        qWarning().noquote() << "STL_VIEWPORT_SHADER_FAIL" << m_program.log();
    }

    m_vao.create();
    m_vao.bind();
    m_vbo.create();
    m_vbo.bind();
    m_program.bind();
    m_program.enableAttributeArray(0);
    m_program.setAttributeBuffer(0, GL_FLOAT, 0, 3, 6 * sizeof(float));
    m_program.enableAttributeArray(1);
    m_program.setAttributeBuffer(1, GL_FLOAT, 3 * sizeof(float), 3, 6 * sizeof(float));
    m_vbo.release();
    m_vao.release();
    m_program.release();

    if (!m_pendingVertices.isEmpty()) {
        const QVector<float> pending = m_pendingVertices;
        m_pendingVertices.clear();
        uploadVertices(pending);
    }
}

void StlViewport::resizeGL(int width, int height) {
    glViewport(0, 0, width, height);
}

void StlViewport::paintGL() {
    glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);
    if (m_vertexCount <= 0 || !m_program.isLinked()) return;

    const float aspect = height() > 0 ? static_cast<float>(width()) / height() : 1.0f;
    QMatrix4x4 projection;
    const float distance = m_radius * 3.0f / qMax(0.15f, m_zoom);
    projection.perspective(35.0f, aspect, qMax(0.01f, distance - m_radius * 4.0f), distance + m_radius * 8.0f);

    QMatrix4x4 view;
    view.translate(0.0f, 0.0f, -distance);
    view.rotate(m_pitch, 1.0f, 0.0f, 0.0f);
    view.rotate(m_yaw, 0.0f, 1.0f, 0.0f);
    view.translate(-m_center);

    m_program.bind();
    m_program.setUniformValue("uMvp", projection * view);
    m_program.setUniformValue("uModel", QMatrix4x4());
    m_program.setUniformValue("uLightDir", QVector3D(0.4f, 0.6f, 0.7f));
    m_vao.bind();
    glDrawArrays(GL_TRIANGLES, 0, m_vertexCount);
    m_vao.release();
    m_program.release();
}

void StlViewport::fitView() {
    m_yaw = -35.0f;
    m_pitch = 22.0f;
    m_zoom = 1.0f;
    update();
}

void StlViewport::mousePressEvent(QMouseEvent *event) {
    m_lastPos = event->pos();
}

void StlViewport::mouseMoveEvent(QMouseEvent *event) {
    if (!(event->buttons() & Qt::LeftButton)) return;
    const QPoint delta = event->pos() - m_lastPos;
    m_lastPos = event->pos();
    m_yaw += delta.x() * 0.4f;
    m_pitch = qBound(-89.0f, m_pitch + delta.y() * 0.4f, 89.0f);
    update();
}

void StlViewport::wheelEvent(QWheelEvent *event) {
    m_zoom = qBound(0.2f, m_zoom * (event->angleDelta().y() > 0 ? 1.12f : 0.89f), 8.0f);
    update();
}
