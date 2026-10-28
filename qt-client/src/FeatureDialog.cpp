#include "FeatureDialog.h"

#include <QComboBox>
#include <QDialogButtonBox>
#include <QFormLayout>
#include <QJsonArray>
#include <QLabel>
#include <QLineEdit>
#include <QRegularExpression>
#include <QVBoxLayout>

namespace {
// 每种特征要填哪些字段（键名与服务端 validate.mjs 的字段一致）
struct FieldSpec {
    QString key;
    QString label;
    QString placeholder;
};

QVector<FieldSpec> fieldsFor(const QString &type) {
    if (type == QStringLiteral("box")) {
        return {{QStringLiteral("length"), QStringLiteral("长 length (mm)"), QStringLiteral("90")},
                {QStringLiteral("width"), QStringLiteral("宽 width (mm)"), QStringLiteral("90")},
                {QStringLiteral("height"), QStringLiteral("高 height (mm)"), QStringLiteral("12")}};
    }
    if (type == QStringLiteral("cylinder")) {
        return {{QStringLiteral("diameter"), QStringLiteral("直径 (mm)"), QStringLiteral("20")},
                {QStringLiteral("height"), QStringLiteral("高 (mm)"), QStringLiteral("30")}};
    }
    if (type == QStringLiteral("holes")) {
        return {{QStringLiteral("diameter"), QStringLiteral("孔径 (mm)"), QStringLiteral("5.5")},
                {QStringLiteral("positions"), QStringLiteral("孔位 x,y; x,y"), QStringLiteral("0,0")}};
    }
    if (type == QStringLiteral("counterbore")) {
        return {{QStringLiteral("diameter"), QStringLiteral("通孔直径 (mm)"), QStringLiteral("5.5")},
                {QStringLiteral("cbDiameter"), QStringLiteral("沉孔直径 (mm)"), QStringLiteral("8.5")},
                {QStringLiteral("cbDepth"), QStringLiteral("沉孔深 (mm)"), QStringLiteral("5")},
                {QStringLiteral("positions"), QStringLiteral("孔位 x,y; x,y"), QStringLiteral("0,0")}};
    }
    if (type == QStringLiteral("fillet")) {
        return {{QStringLiteral("radius"), QStringLiteral("圆角半径 (mm)"), QStringLiteral("3")}};
    }
    return {};
}

QString typeLabel(const QString &type) {
    if (type == QStringLiteral("box")) return QStringLiteral("拉伸基体（长方体）");
    if (type == QStringLiteral("cylinder")) return QStringLiteral("圆柱");
    if (type == QStringLiteral("holes")) return QStringLiteral("孔阵列");
    if (type == QStringLiteral("counterbore")) return QStringLiteral("沉头孔");
    if (type == QStringLiteral("fillet")) return QStringLiteral("四角圆角");
    return type;
}
} // namespace

FeatureDialog::FeatureDialog(QWidget *parent) : QDialog(parent) {
    setWindowTitle(tr("新建特征"));
    auto *layout = new QVBoxLayout(this);

    auto *top = new QFormLayout();
    m_type = new QComboBox(this);
    m_type->addItem(typeLabel(QStringLiteral("holes")), QStringLiteral("holes"));
    m_type->addItem(typeLabel(QStringLiteral("counterbore")), QStringLiteral("counterbore"));
    m_type->addItem(typeLabel(QStringLiteral("box")), QStringLiteral("box"));
    m_type->addItem(typeLabel(QStringLiteral("cylinder")), QStringLiteral("cylinder"));
    m_type->addItem(typeLabel(QStringLiteral("fillet")), QStringLiteral("fillet"));
    m_id = new QLineEdit(this);
    m_id->setPlaceholderText(QStringLiteral("f-holes-new"));
    m_name = new QLineEdit(this);
    m_name->setPlaceholderText(QStringLiteral("新孔阵列"));
    top->addRow(tr("类型"), m_type);
    top->addRow(tr("特征 id"), m_id);
    top->addRow(tr("名称"), m_name);
    layout->addLayout(top);

    m_paramsHost = new QWidget(this);
    m_paramsForm = new QFormLayout(m_paramsHost);
    m_paramsForm->setContentsMargins(0, 0, 0, 0);
    layout->addWidget(m_paramsHost);

    m_hint = new QLabel(tr("参数由服务端校验：写不进的字段会原样告诉你原因，不会静默改数。"), this);
    m_hint->setWordWrap(true);
    m_hint->setStyleSheet(QStringLiteral("color:#9aa3b2;"));
    layout->addWidget(m_hint);

    auto *buttons = new QDialogButtonBox(QDialogButtonBox::Ok | QDialogButtonBox::Cancel, this);
    connect(buttons, &QDialogButtonBox::accepted, this, &QDialog::accept);
    connect(buttons, &QDialogButtonBox::rejected, this, &QDialog::reject);
    layout->addWidget(buttons);

    connect(m_type, QOverload<int>::of(&QComboBox::currentIndexChanged), this, [this]() { rebuildFields(); });
    rebuildFields();
    resize(420, 320);
}

QString FeatureDialog::currentType() const { return m_type->currentData().toString(); }

void FeatureDialog::rebuildFields() {
    while (m_paramsForm->rowCount() > 0) m_paramsForm->removeRow(0);
    m_fields.clear();
    const QString type = currentType();
    for (const FieldSpec &spec : fieldsFor(type)) {
        auto *edit = new QLineEdit(m_paramsHost);
        edit->setPlaceholderText(spec.placeholder);
        m_paramsForm->addRow(spec.label, edit);
        m_fields.insert(spec.key, edit);
    }
    if (m_id->text().trimmed().isEmpty()) m_id->setText(QStringLiteral("f-%1-new").arg(type));
    m_hint->setText(type == QStringLiteral("holes") || type == QStringLiteral("counterbore")
        ? tr("孔位写成 x,y; x,y（mm，相对板中心）。服务端会重建并核对体积，写错会 422 拒绝。")
        : tr("参数由服务端校验：写不进的字段会原样告诉你原因，不会静默改数。"));
}

QJsonObject FeatureDialog::feature() const {
    const QString type = currentType();
    QJsonObject params;
    for (auto it = m_fields.begin(); it != m_fields.end(); ++it) {
        const QString text = it.value()->text().trimmed();
        if (it.key() == QStringLiteral("positions")) {
            QJsonArray positions;
            for (const QString &pair : text.split(QLatin1Char(';'), Qt::SkipEmptyParts)) {
                const QStringList xy = pair.split(QLatin1Char(','), Qt::SkipEmptyParts);
                if (xy.size() != 2) continue;
                bool okX = false;
                bool okY = false;
                const double x = xy.at(0).trimmed().toDouble(&okX);
                const double y = xy.at(1).trimmed().toDouble(&okY);
                if (okX && okY) positions.append(QJsonArray{x, y});
            }
            params.insert(it.key(), positions);
        } else if (it.key() == QStringLiteral("depth") || it.key() == QStringLiteral("edges") ||
                   it.key() == QStringLiteral("centered")) {
            params.insert(it.key(), text);
        } else {
            bool ok = false;
            const double value = text.toDouble(&ok);
            if (ok) params.insert(it.key(), value);
            else params.insert(it.key(), text);
        }
    }
    // 与服务端语义对齐的固定项：孔默认通孔、板体默认居中
    if (type == QStringLiteral("holes") || type == QStringLiteral("counterbore")) params.insert(QStringLiteral("depth"), QStringLiteral("through"));
    if (type == QStringLiteral("box")) params.insert(QStringLiteral("centered"), true);
    if (type == QStringLiteral("fillet")) params.insert(QStringLiteral("edges"), QStringLiteral("|Z"));

    QJsonObject out;
    out.insert(QStringLiteral("id"), m_id->text().trimmed());
    out.insert(QStringLiteral("type"), type);
    out.insert(QStringLiteral("name"), m_name->text().trimmed().isEmpty() ? typeLabel(type) : m_name->text().trimmed());
    out.insert(QStringLiteral("params"), params);
    return out;
}
