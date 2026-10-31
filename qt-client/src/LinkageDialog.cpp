#include "LinkageDialog.h"

#include "OcctViewport.h"

#include <QHBoxLayout>

#include <algorithm>
#include <cmath>
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

    // 运动包络：跨工位疑似碰撞 ≠ 静态布局问题，单独一行，避免和间距/干涉混在一起
    const QJsonObject motion = m_linkage.value(QStringLiteral("motion")).toObject();
    if (!motion.isEmpty()) {
        const QJsonArray suspects = motion.value(QStringLiteral("suspects")).toArray();
        QString text = tr("运动包络：跨工位疑似 %1 处（最深 %2 mm）· 同工位接触 %3 对 · %4 帧扫掠")
                           .arg(suspects.size())
                           .arg(motion.value(QStringLiteral("maxDepthMm")).toDouble())
                           .arg(motion.value(QStringLiteral("intraStation")).toInt())
                           .arg(motion.value(QStringLiteral("frames")).toInt());
        if (!suspects.isEmpty()) {
            QStringList top;
            for (int i = 0; i < suspects.size() && i < 3; ++i) {
                const QJsonObject hit = suspects.at(i).toObject();
                top << tr("%1×%2 %3 %4 mm @%5 ms")
                           .arg(hit.value(QStringLiteral("a")).toString())
                           .arg(hit.value(QStringLiteral("b")).toString())
                           .arg(hit.value(QStringLiteral("axis")).toString())
                           .arg(hit.value(QStringLiteral("depthMm")).toDouble())
                           .arg(hit.value(QStringLiteral("tMs")).toInt());
            }
            text += tr("　最深三处：%1").arg(top.join(QStringLiteral("；")));
        }
        text += tr("　（AABB 初筛，确认需真实布尔）");
        auto *motionLabel = new QLabel(text, this);
        motionLabel->setWordWrap(true);
        motionLabel->setObjectName(QStringLiteral("motionEnvelopeLabel"));
        layout->addWidget(motionLabel);
    }

    m_timeLabel = new QLabel(this);
    m_actionLabel = new QLabel(this);
    m_actionLabel->setWordWrap(true);
    m_ioLabel = new QLabel(this);
    m_ioLabel->setWordWrap(true);

    m_slider = new QSlider(Qt::Horizontal, this);
    m_slider->setRange(0, qMax(0, frameCount() - 1));
    m_playButton = new QPushButton(tr("播放"), this);
    m_prevStep = new QPushButton(tr("◀ 上一步"), this);
    m_nextStep = new QPushButton(tr("下一步 ▶"), this);

    auto *row = new QHBoxLayout();
    row->addWidget(m_playButton);
    row->addWidget(m_prevStep);
    row->addWidget(m_nextStep);
    row->addWidget(m_slider, 1);
    layout->addLayout(row);
    m_stepLabel = new QLabel(this);
    m_stepLabel->setWordWrap(true);
    m_stepLabel->setObjectName(QStringLiteral("stepLabel"));
    layout->addWidget(m_stepLabel);
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
    connect(m_prevStep, &QPushButton::clicked, this, [this]() { stepBackward(); });
    connect(m_nextStep, &QPushButton::clicked, this, [this]() { stepForward(); });

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


namespace {

struct StepWindow {
    int stepNo = 0;
    int startMs = 0;
    int endMs = 0;
};

// 步窗口按开始时刻排序；站与站之间会重叠（流水线并行），所以单步按「时间边界」走，
// 不能按 stepNo 顺序走——否则会跳过别的工位正在进行的动作。
QList<StepWindow> orderedSteps(const QJsonArray &steps)
{
    QList<StepWindow> windows;
    for (const QJsonValue &value : steps) {
        const QJsonObject step = value.toObject();
        windows.append({step.value(QStringLiteral("stepNo")).toInt(),
                        step.value(QStringLiteral("startMs")).toInt(),
                        step.value(QStringLiteral("endMs")).toInt()});
    }
    std::sort(windows.begin(), windows.end(), [](const StepWindow &a, const StepWindow &b) {
        return a.startMs < b.startMs || (a.startMs == b.startMs && a.endMs < b.endMs);
    });
    return windows;
}

int frameForMs(const QJsonArray &frames, int cycleMs, int ms)
{
    if (frames.isEmpty() || cycleMs <= 0) return 0;
    const int index = qRound(double(qBound(0, ms, cycleMs)) / cycleMs * frames.size());
    return qBound(0, index, frames.size() - 1);
}

// 向前单步要「至少到」边界，取向上取整；否则 60 帧 / 1890 ms 时
// 980 ms 会取到 976 ms 的帧，下一次又算出同一个边界，单步卡死。
int frameAtOrAfter(const QJsonArray &frames, int cycleMs, int ms)
{
    if (frames.isEmpty() || cycleMs <= 0) return 0;
    const int index = int(std::ceil(double(qBound(0, ms, cycleMs)) / cycleMs * frames.size()));
    return qBound(0, index, frames.size() - 1);
}

}   // namespace

int LinkageDialog::currentStepNo() const
{
    const QJsonArray frames = m_linkage.value(QStringLiteral("frames")).toArray();
    if (frames.isEmpty()) return 0;
    const int tMs = frames.at(m_frame).toObject().value(QStringLiteral("tMs")).toInt();
    // 重叠时取「最近开始的」那一步：此刻新动作才是调试关注点
    int current = 0;
    int latestStart = -1;
    for (const StepWindow &window : orderedSteps(m_linkage.value(QStringLiteral("steps")).toArray())) {
        if (tMs >= window.startMs && tMs <= window.endMs && window.startMs >= latestStart) {
            latestStart = window.startMs;
            current = window.stepNo;
        }
    }
    return current;
}

int LinkageDialog::currentTimeMs() const
{
    const QJsonArray frames = m_linkage.value(QStringLiteral("frames")).toArray();
    if (frames.isEmpty()) return 0;
    return frames.at(m_frame).toObject().value(QStringLiteral("tMs")).toInt();
}

QString LinkageDialog::stepText() const
{
    return m_stepLabel ? m_stepLabel->text() : QString();
}

int LinkageDialog::stepForward()
{
    const QJsonArray frames = m_linkage.value(QStringLiteral("frames")).toArray();
    const QList<StepWindow> windows = orderedSteps(m_linkage.value(QStringLiteral("steps")).toArray());
    if (frames.isEmpty() || windows.isEmpty()) return 0;
    const int cycleMs = m_linkage.value(QStringLiteral("cycleMs")).toInt();
    if (m_playing) togglePlay();

    // 下一个边界 = 按结束时刻升序，第一个落在当前帧之后的动作终点
    QList<int> ends;
    for (const StepWindow &window : windows) ends.append(window.endMs);
    std::sort(ends.begin(), ends.end());
    for (const int endMs : ends) {
        const int index = frameAtOrAfter(frames, cycleMs, endMs);
        if (index > m_frame) {
            showFrame(index);
            return currentStepNo();
        }
    }
    return currentStepNo();
}

int LinkageDialog::stepBackward()
{
    const QJsonArray frames = m_linkage.value(QStringLiteral("frames")).toArray();
    const QList<StepWindow> windows = orderedSteps(m_linkage.value(QStringLiteral("steps")).toArray());
    if (frames.isEmpty() || windows.isEmpty()) return 0;
    const int cycleMs = m_linkage.value(QStringLiteral("cycleMs")).toInt();
    if (m_playing) togglePlay();

    // 上一步 = 按开始时刻降序，第一个落在当前帧之前的起点
    QList<int> starts;
    for (const StepWindow &window : windows) starts.append(window.startMs);
    std::sort(starts.begin(), starts.end());
    for (int i = starts.size() - 1; i >= 0; --i) {
        const int index = frameForMs(frames, cycleMs, starts.at(i));
        if (index < m_frame) {
            showFrame(index);
            return currentStepNo();
        }
    }
    showFrame(0);
    return 0;
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

    const int stepNo = currentStepNo();
    if (stepNo > 0) {
        QJsonObject step;
        for (const QJsonValue &value : m_linkage.value(QStringLiteral("steps")).toArray()) {
            if (value.toObject().value(QStringLiteral("stepNo")).toInt() == stepNo) { step = value.toObject(); break; }
        }
        QStringList points;
        for (const QJsonValue &value : step.value(QStringLiteral("io")).toArray()) points << value.toString();
        m_stepLabel->setText(tr("程序步 S%1 · %2 · %3 动作 %4 ms · 点位 %5")
                                 .arg(stepNo)
                                 .arg(step.value(QStringLiteral("actuatorId")).toString())
                                 .arg(step.value(QStringLiteral("kind")).toString())
                                 .arg(step.value(QStringLiteral("endMs")).toInt() - step.value(QStringLiteral("startMs")).toInt())
                                 .arg(points.join(QStringLiteral("/"))));
    } else {
        m_stepLabel->setText(tr("程序步：不在任何动作窗口内（等待）"));
    }
    m_prevStep->setEnabled(stepNo > 1 || m_frame > 0);
    m_nextStep->setEnabled(stepNo < m_linkage.value(QStringLiteral("steps")).toArray().size());

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
