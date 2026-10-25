// SPDX-License-Identifier: GPL-2.0-or-later
// Test-only helper. Never installed with the production companion.
#include <input.h>
#include "compat.h"
#include <plugin.h>
#include <window.h>
#include <workspace.h>
#include <QDBusConnection>
#include <QJsonDocument>
#include <QJsonObject>
#include <QPointer>
#include <cmath>

class Support final : public KWin::Plugin
{
    Q_OBJECT
    Q_CLASSINFO("D-Bus Interface", "com.windowwarp.CompanionTest")
public:
    Support()
    {
        QDBusConnection::sessionBus().registerObject("/WindowWarpCompanionTest", this, QDBusConnection::ExportAllSlots);
        for (auto device : KWin::input()->devices()) track(device);
        connect(KWin::input(),&KWin::InputRedirection::deviceAdded,this,[this](KWin::InputDevice *device){track(device);});
    }
    ~Support() override { QDBusConnection::sessionBus().unregisterObject("/WindowWarpCompanionTest"); }
public Q_SLOTS:
    bool SeatRelease(uint code)
    {
        if (!m_lastDevice || !KWin::input()->devices().contains(m_lastDevice)) return false;
#if QT_VERSION >= QT_VERSION_CHECK(6, 0, 0)
        const auto released = KWin::KeyboardKeyState::Released;
#else
        const auto released = KWin::InputRedirection::KeyboardKeyReleased;
#endif
        // Reproduce libinput's already-aggregated device signal. The fake-input
        // wire protocol itself forbids up on a different client's unpressed key.
        const auto now = std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::steady_clock::now().time_since_epoch());
        Q_EMIT m_lastDevice->keyChanged(code, released, now, m_lastDevice);
        return true;
    }
    bool RemoveLastDevice()
    {
        if (!m_lastDevice || !KWin::input()->devices().contains(m_lastDevice)) return false;
        KWin::input()->removeInputDevice(m_lastDevice);
        return true;
    }
    QString Snapshot() const
    {
        const auto window = KWin::workspace()->activeWindow();
        const auto point = KWin::input()->globalPointer();
        QJsonObject value{{"x", int(std::floor(point.x()+0.5))}, {"y", int(std::floor(point.y()+0.5))}};
        if (window) value["previous"] = QJsonObject{{"id",window->internalId().toString()}, {"pid",double(window->pid())}};
        return QString::fromUtf8(QJsonDocument(value).toJson(QJsonDocument::Compact));
    }
    void ModalThenInvoke(const QString &action, uint code)
    {
        m_action = action;
        for (auto device : KWin::input()->devices()) {
            m_tails.append(connect(device, &KWin::InputDevice::keyChanged, this,
                [this, code](quint32 key, Compat::NativeState state) {
                    if (key != code || Compat::state(state) != Compat::State::Pressed || m_action.isEmpty()) return;
                    const auto action = std::exchange(m_action, {});
                    for (const auto &tail : std::as_const(m_tails)) disconnect(tail);
                    m_tails.clear();
                    auto object = QDBusConnection::sessionBus().objectRegisteredAt("/component/kwin");
                    QMetaObject::invokeMethod(object, "invokeShortcut", Qt::DirectConnection,
                        Q_ARG(QString, action), Q_ARG(QString, QString("default")));
                }, Qt::DirectConnection));
        }
        KWin::input()->startInteractiveWindowSelection([](KWin::Window *) {}, QByteArray());
    }
private:
    void track(KWin::InputDevice *device)
    {
        connect(device,&KWin::InputDevice::keyChanged,this,[this,device](quint32,Compat::NativeState state){
            if(Compat::state(state)==Compat::State::Pressed) m_lastDevice=device;
        });
    }
    QPointer<KWin::InputDevice> m_lastDevice;
    QString m_action;
    QList<QMetaObject::Connection> m_tails;
};
class SupportFactory final : public KWin::PluginFactory
{
    Q_OBJECT
    Q_PLUGIN_METADATA(IID PluginFactory_iid FILE "support.json")
    Q_INTERFACES(KWin::PluginFactory)
public:
    std::unique_ptr<KWin::Plugin> create() const override { return std::make_unique<Support>(); }
};
#include "support.moc"
