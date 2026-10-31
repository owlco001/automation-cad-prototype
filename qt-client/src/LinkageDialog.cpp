#include "LinkageDialog.h"

#include "OcctViewport.h"

#include <QHBoxLayout>
#include <QJsonArray>
#include <QLabel>
#include <QPushButton>
#include <QSlider>
#include <QTimer>
#include <QVBoxLayout>

LinkageDialog::LinkageDialog(const QJsonObject &linkage, OcctViewport *viewport, QWidget *parent)
    : QDialog(parent), m_linkage(linkage), m_viewport(viewport)
{
    setWindowTitle(tr("3D 联动调试（示意级）"));
    resize(520, 220);

    auto *layout = new QVBoxLayout(this);

    const int cycleMs = m_linkage.value(QStringLiteral("cycleMs")).toInt();
    const int axisCount = m_linkage.value(QStringLiteral("axisCount")).toInt();
    const QJsonObject io = m_linkage.value(QStringLiteral("io")).toObject();
    const int matched = io.value(QStringLiteral("matched")).toInt();
    const int used = io.value(QStringLiteral("used")).toArray().size();
    const int missing = io.value(QStringLiteral("missing")).toArray().size();

    auto *summary = new QLabel(tr("循环 %1 ms · 运动轴 %2 · IO 点位 %3（与 PLC 表对齐 %4，缺 %5）")
                                   .arg(cycleMs).arg(axisCount).arg(used).arg(matched).arg(missing), this);
    summary->setWordWrap(true);
    layout->addWidget(summary);

    m_timeLabel = new QLabel(this);
    m_actionLabel = new QLabel(this);
    m_actionLabel->setWordWrap(true);
    m_ioLabel = new QLabel(this);
    m_ioLabel->setWordWrap(true);

    m_slider = new QSlider(Qt::Horizontal, this);
    m_slider->setRange(0, qMax(0, frameCount() - 1));
    m_playButton = new QPushButton(tr("播放"), this);

    auto *row = new QHBoxLayout();
    row->addWidget(m_playButton);
    row->addWidget(m_slider, 1);
    layout->addLayout(row);
    layout->addWidget(m_timeLabel);
    layout->addWidget(m_actionLabel);
    layout->addWidget(m_ioLabel);

    m_timer = new QTimer(this);
    m_timer->setInterval(33);
    connect(m_timer, &QTimer::timeout, this, [this]() {
        const int next = (m_frame + 1) % qMax(1, frameCount());
        m_slider->setValue(next);
    });
    connect(m_slider, &QSlider::valueChanged, this, [this](int value) { showFrame(value); });
    connect(m_playButton, &QPushButton::clicked, this, [this]() { togglePlay(); });

    m_slider->setValue(0);
    showFrame(0);
}

int LinkageDialog::frameCount() const
{
    return m_linkage.value(QStringLiteral("frames")).toArray().size();
}

int LinkageDialog::applyFrame(int index)
{
    const QJsonArray frames = m_linkage.value(QStringLiteral("frames")).toArray();
    if (frames.isEmpty()) return 0;
    const int clamped = qBound(0, index, frames.size() - 1);
    const QJsonObject frame = frames.at(clamped).toObject();
    m_viewport->applyLinkagePose(frame.value(QStringLiteral("offsets")).toObject(),
                                 frame.value(QStringLiteral("rotZDeg")).toObject());
    return m_viewport->lastLinkageMoved();
}

int LinkageDialog::seekFrame(int index)
{
    const QJsonArray frames = m_linkage.value(QStringLiteral("frames")).toArray();
    if (frames.isEmpty()) return 0;
    const int clamped = qBound(0, index, frames.size() - 1);
    m_slider->setValue(clamped);   // setValue 会触发 showFrame
    return m_viewport->lastLinkageMoved();
}

void LinkageDialog::showFrame(int index)
{
    const QJsonArray frames = m_linkage.value(QStringLiteral("frames")).toArray();
    if (frames.isEmpty()) {
        m_timeLabel->setText(tr("这份方案没有可播放的运动轴"));
        return;
    }
    m_frame = qBound(0, index, frames.size() - 1);
    const QJsonObject frame = frames.at(m_frame).toObject();
    const int moved = applyFrame(m_frame);

    m_timeLabel->setText(tr("第 %1 / %2 帧 · t = %3 ms · 在动零件 %4")
                             .arg(m_frame + 1).arg(frames.size())
                             .arg(frame.value(QStringLiteral("tMs")).toInt()).arg(moved));

    QStringList steps;
    for (const QJsonValue &value : frame.value(QStringLiteral("activeSteps")).toArray()) {
        steps << value.toString();
    }
    m_actionLabel->setText(steps.isEmpty() ? tr("动作：无（等待）") : tr("动作：%1").arg(steps.join(QStringLiteral("、"))));

    QStringList io;
    for (const QJsonValue &value : frame.value(QStringLiteral("activeIO")).toArray()) {
        io << value.toString();
    }
    m_ioLabel->setText(io.isEmpty() ? tr("输出：全部 OFF") : tr("输出 ON：%1").arg(io.join(QStringLiteral("、"))));
}

void LinkageDialog::togglePlay()
{
    m_playing = !m_playing;
    if (m_playing) {
        m_timer->start();
        m_playButton->setText(tr("暂停"));
    } else {
        m_timer->stop();
        m_playButton->setText(tr("播放"));
    }
}
