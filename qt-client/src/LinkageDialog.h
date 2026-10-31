#ifndef AUTOMATIONCAD_LINKAGEDIALOG_H
#define AUTOMATIONCAD_LINKAGEDIALOG_H

#include <QDialog>
#include <QJsonObject>

class QLabel;
class QSlider;
class QPushButton;
class QTimer;
class OcctViewport;

/**
 * 3D 联动调试窗口。
 *
 * 纪律：**运动学全部来自 desktop**。这个窗口只做三件事——
 * 拿 desktop 预生成的帧（tMs / offsets / rotZDeg / activeIO）、按时间播放、把帧交给视口摆位。
 * 客户端不做插值、不自行推断行程，避免两套运动学漂移。
 */
class LinkageDialog : public QDialog {
    Q_OBJECT
public:
    /// @param linkage desktop `--linkage` 的输出（含 cycleMs / steps / frames / io）
    LinkageDialog(const QJsonObject &linkage, OcctViewport *viewport, QWidget *parent = nullptr);

    /// 自检用：跳到第 index 帧并应用，返回被摆动的零件数
    int applyFrame(int index);
    /// 跳到第 index 帧并同步到界面（截图/联调用），返回被摆动的零件数
    int seekFrame(int index);
    int frameCount() const;

    /// 单步：跳到上/下一个动作边界（暂停播放）。返回当前所处步号（没有步则 0）。
    int stepForward();
    int stepBackward();
    /// 当前所处步号（0 = 不在任何动作窗口内）
    int currentStepNo() const;
    /// 自检用：单步文案
    QString stepText() const;
    /// 自检用：当前帧对应时刻（ms）
    int currentTimeMs() const;

private:
    void showFrame(int index);
    void togglePlay();

    QJsonObject m_linkage;
    OcctViewport *m_viewport = nullptr;
    QSlider *m_slider = nullptr;
    QPushButton *m_playButton = nullptr;
    QPushButton *m_prevStep = nullptr;
    QPushButton *m_nextStep = nullptr;
    QLabel *m_stepLabel = nullptr;
    QLabel *m_timeLabel = nullptr;
    QLabel *m_ioLabel = nullptr;
    QLabel *m_actionLabel = nullptr;
    QTimer *m_timer = nullptr;
    int m_frame = 0;
    bool m_playing = false;
};

#endif
