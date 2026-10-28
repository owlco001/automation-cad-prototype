#pragma once
// 新建特征对话框：只负责收集参数并产出一个 feature JSON，校验与落库全在服务端（契约 §4/§5）。
// 这里不做「猜一个合理值」——默认值只用于占位，用户点了确定就以他填的为准。
#include <QDialog>
#include <QJsonObject>

class QComboBox;
class QLineEdit;
class QFormLayout;
class QLabel;

class FeatureDialog : public QDialog {
    Q_OBJECT
public:
    explicit FeatureDialog(QWidget *parent = nullptr);
    /// 生成 createFeature 需要的 feature 对象（{id,type,name,params}）
    QJsonObject feature() const;

private:
    void rebuildFields();
    QString currentType() const;

    QComboBox *m_type = nullptr;
    QLineEdit *m_id = nullptr;
    QLineEdit *m_name = nullptr;
    QFormLayout *m_paramsForm = nullptr;
    QLabel *m_hint = nullptr;
    QWidget *m_paramsHost = nullptr;
    // 按类型存的输入框（键名与服务端字段一致）
    QMap<QString, QLineEdit *> m_fields;
};
