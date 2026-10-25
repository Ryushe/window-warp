// SPDX-License-Identifier: GPL-2.0-or-later
#include <input.h>
#include <input_event_spy.h>
#include "compat.h"
#include <plugin.h>
#include <wayland_server.h>
#include <window.h>
#include <workspace.h>

#include <QCoreApplication>
#include <QDBusConnection>
#include <QDBusContext>
#include <QDBusError>
#include <QDBusMessage>
#include <QDBusPendingCallWatcher>
#include <QDBusServiceWatcher>
#include <QDateTime>
#include <QDebug>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QKeySequence>
#include <QPointer>
#include <algorithm>
#include <cmath>
#include <functional>
#include <optional>
#include <utility>

namespace {
constexpr auto service = "com.windowwarp.Companion";
constexpr auto endpoint = "/WindowWarpCompanion";
constexpr auto controlService = "com.windowwarp.Control";

struct Binding {
    QString id;
    int chord;
};
struct Cycle {
    Binding binding;
    KWin::InputDevice *device;
    quint32 code;
    QString token;
    QString generation;
    quint64 number;
    bool ended = false;
};
struct Candidate {
    Binding binding;
    KWin::InputDevice *device;
    quint32 code;
};

QString compact(const QJsonObject &object)
{
    return QString::fromUtf8(QJsonDocument(object).toJson(QJsonDocument::Compact));
}
}

// Never activates a shortcut or filters a fresh key. Only suppresses repetitions
// of admitted bases whose lifecycle guard survives pause/reassignment.
class RepeatGuard final : public KWin::InputEventFilter
{
public:
    explicit RepeatGuard(std::function<bool(const Compat::Event &)> predicate)
#if QT_VERSION >= QT_VERSION_CHECK(6, 0, 0)
        : KWin::InputEventFilter(KWin::InputFilterOrder::GlobalShortcut)
#else
        : KWin::InputEventFilter()
#endif
        , m_predicate(std::move(predicate)) {}
#if QT_VERSION >= QT_VERSION_CHECK(6, 0, 0)
    bool keyboardKey(KWin::KeyboardKeyEvent *event) override { return m_predicate(Compat::event(event)); }
#else
    bool keyEvent(KWin::KeyEvent *event) override { return m_predicate(Compat::event(event)); }
#endif
private:
    std::function<bool(const Compat::Event &)> m_predicate;
};

class Companion final : public KWin::Plugin, protected QDBusContext, public KWin::InputEventSpy
{
    Q_OBJECT
    Q_CLASSINFO("D-Bus Interface", "com.windowwarp.Companion")
public:
    Companion()
        : m_bus(QDBusConnection::sessionBus())
        , m_ownerWatcher(QString::fromLatin1(controlService), m_bus,
                         QDBusServiceWatcher::WatchForOwnerChange, this)
    {
        m_repeatGuard = std::make_unique<RepeatGuard>([this](const Compat::Event &event) {
            if (event.state != Compat::State::Repeated || KWin::waylandServer()->isScreenLocked()
                || KWin::waylandServer()->isKeyboardShortcutsInhibited()) return false;
            return std::any_of(m_cycles.cbegin(), m_cycles.cend(), [&event](const Cycle &cycle) {
                return cycle.code == event.code;
            });
        });
        connect(&m_ownerWatcher, &QDBusServiceWatcher::serviceOwnerChanged, this,
                [this](const QString &, const QString &, const QString &owner) {
            if (!m_owner.isEmpty() && owner != m_owner) clearOwner();
        });
        connect(KWin::input(), &KWin::InputRedirection::deviceAdded, this,
                [this](KWin::InputDevice *device) { if (m_observing) attachDevice(device); });
        connect(KWin::input(), &KWin::InputRedirection::deviceRemoved, this,
                [this](KWin::InputDevice *device) {
            for (const auto &cycle : std::as_const(m_cycles)) {
                if (cycle.device == device && !cycle.ended) deliver(cycle, "cancel");
            }
            m_cycles.erase(std::remove_if(m_cycles.begin(),m_cycles.end(),[device](const Cycle &cycle) { return cycle.device == device; }),m_cycles.end());
            QObject::disconnect(m_devices.take(device));
            m_candidate.reset();
            settleObservation();
        });
        if (KWin::waylandServer()) connect(KWin::waylandServer(), &KWin::WaylandServer::lockStateChanged, this, [this] {
            if (KWin::waylandServer()->isScreenLocked()) cancelCycles();
            // Keep only release guards while locked. No new chord can be admitted.
            m_candidate.reset();
        });
        m_registered = m_bus.registerObject(QString::fromLatin1(endpoint), this, QDBusConnection::ExportAllSlots);
        if (m_registered) m_ready = m_bus.registerService(QString::fromLatin1(service));
        if (!m_ready) qWarning() << "Window Warp companion: cannot register its D-Bus endpoint";
    }
    ~Companion() override
    {
        cancelCycles();
        clearOwner();
        if (m_ready) m_bus.unregisterService(QString::fromLatin1(service));
        if (m_registered) m_bus.unregisterObject(QString::fromLatin1(endpoint));
    }

public Q_SLOTS:
    QString Info() const
    {
        return compact({{"protocol", 1}, {"kwinVersion", QStringLiteral(WARP_KWIN_VERSION)}});
    }

    void Configure(const QString &token, const QString &generation, const QString &bindingsJson)
    {
        if (!calledFromDBus()) return;
        if (!KWin::waylandServer()) {
            sendErrorReply("com.windowwarp.Companion.UnsupportedPlatform", "The physical shortcut companion requires KWin Wayland.");
            return;
        }
        if (!m_ready || QCoreApplication::applicationVersion() != QStringLiteral(WARP_KWIN_VERSION)) {
            sendErrorReply("com.windowwarp.Companion.Unavailable", "Install the companion built for this compositor version.");
            return;
        }
        auto request = QDBusMessage::createMethodCall("org.freedesktop.DBus", "/org/freedesktop/DBus",
                                                     "org.freedesktop.DBus", "GetNameOwner");
        request << QString::fromLatin1(controlService);
        const auto reply = m_bus.call(request, QDBus::Block, 1500);
        if (reply.type() != QDBusMessage::ReplyMessage || reply.arguments().isEmpty()
            || reply.arguments().first().toString() != message().service()) {
            sendErrorReply("com.windowwarp.Companion.Unauthorized", "Configure must use the Window Warp control connection.");
            return;
        }
        QJsonParseError error;
        const auto document = QJsonDocument::fromJson(bindingsJson.toUtf8(), &error);
        QList<Binding> bindings;
        QSet<QString> identifiers;
        QSet<int> chords;
        bool valid = error.error == QJsonParseError::NoError && document.isArray() && !token.isEmpty();
        for (const auto &entry : document.array()) {
            const auto object = entry.toObject();
            const auto id = object["id"].toString();
            const auto shortcut = object["shortcut"].toString();
            const auto sequence = QKeySequence::fromString(shortcut, QKeySequence::PortableText);
            const auto chord = Compat::chord(sequence);
            if (!entry.isObject() || id.isEmpty() || shortcut.isEmpty() || sequence.count() != 1
                || Compat::key(chord) == Qt::Key_unknown || Compat::key(chord) == 0
                || identifiers.contains(id) || chords.contains(chord)) {
                valid = false;
                break;
            }
            identifiers.insert(id);
            chords.insert(chord);
            bindings.append({id, chord});
        }
        if (!valid || (!bindings.isEmpty() && generation.isEmpty())) {
            sendErrorReply("com.windowwarp.Companion.InvalidBindings", "Provide unique identifiers and valid single-chord Qt shortcuts.");
            return;
        }
        auto component = m_bus.objectRegisteredAt("/component/kwin");
        if (!bindings.isEmpty() && (!component || component->metaObject()->indexOfSignal("globalShortcutPressed(QString,QString,qlonglong)") < 0)) {
            sendErrorReply("com.windowwarp.Companion.Unavailable", "Register the KWin shortcuts before configuring physical gestures.");
            return;
        }
        // Validation completes before changing the current session.
        cancelCycles();
        m_owner = message().service();
        m_token = token;
        m_generation = generation;
        m_bindings = bindings;
        m_candidate.reset();
        if (component != m_component) {
            QObject::disconnect(m_activation);
            QObject::disconnect(m_componentDestroyed);
            m_component = component;
            if (component) {
                m_activation = connect(component, SIGNAL(globalShortcutPressed(QString,QString,qlonglong)),
                                       this, SLOT(activated(QString,QString,qlonglong)), Qt::DirectConnection);
                m_componentDestroyed = connect(component, &QObject::destroyed, this, [this] {
                    if (!m_bindings.isEmpty()) fail("KGlobalAccel component disappeared");
                });
            }
        }
        if (!m_bindings.isEmpty()) {
            observe();
        }
        settleObservation();
    }

private Q_SLOTS:
    void activated(const QString &component, const QString &id, qlonglong)
    {
        if (component != "kwin" || !m_candidate || m_candidate->binding.id != id) return;
        const auto candidate = *std::exchange(m_candidate, std::nullopt);
        if (KWin::waylandServer()->isScreenLocked() || KWin::waylandServer()->isKeyboardShortcutsInhibited()) return;
        Cycle cycle{candidate.binding, candidate.device, candidate.code, m_token, m_generation, ++m_nextCycle};
        m_cycles.append(cycle);
        const auto pointer = KWin::input()->globalPointer();
        QJsonValue previous = QJsonValue::Null;
        const auto window = KWin::workspace()->activeWindow();
        if (window && !window->isDeleted()) {
            previous = QJsonObject{{"id", window->internalId().toString()}, {"pid", double(std::max<pid_t>(0, window->pid()))}};
        }
        // Match JavaScript Math.round for fractional negative desktop positions.
        deliver(cycle, "down", compact({{"x", int(std::floor(pointer.x() + 0.5))}, {"y", int(std::floor(pointer.y() + 0.5))},
            {"previous", previous}, {"at", double(QDateTime::currentMSecsSinceEpoch())}}));
    }

private:
    #if QT_VERSION >= QT_VERSION_CHECK(6, 0, 0)
    void keyboardKey(KWin::KeyboardKeyEvent *event) override { handleKey(Compat::event(event)); }
    #else
    void keyEvent(KWin::KeyEvent *event) override { handleKey(Compat::event(event)); }
    #endif
    void handleKey(const Compat::Event &event)
    {
        m_candidate.reset();
        if (event.state == Compat::State::Repeated) return;
        const bool released = event.state == Compat::State::Released;
        for (auto &cycle : m_cycles) {
            // libinput emits the first seat press and final seat release only;
            // those can originate from different physical keyboards.
            const bool baseUp = released && cycle.code == event.code;
            const auto required = Compat::modifiers(cycle.binding.chord);
            const bool modifierUp = (event.modifiers & required) != required;
            if (!cycle.ended && (baseUp || modifierUp)) {
                deliver(cycle, "up");
                cycle.ended = true;
            }
        }
        if (released) {
            m_cycles.erase(std::remove_if(m_cycles.begin(),m_cycles.end(),[&event](const Cycle &cycle) {
                return cycle.code == event.code;
            }),m_cycles.end());
            return;
        }
        if (m_bindings.isEmpty() || !m_devices.contains(event.device)
            || KWin::waylandServer()->isScreenLocked() || KWin::waylandServer()->isKeyboardShortcutsInhibited()) return;
        for (const auto &cycle : std::as_const(m_cycles)) {
            if (cycle.code == event.code) return;
        }
        for (const auto &binding : std::as_const(m_bindings)) {
            if (Compat::matches(binding.chord, event)) {
                m_candidate = Candidate{binding, event.device, event.code};
                break;
            }
        }
    }
    void attachDevice(KWin::InputDevice *device)
    {
        if (m_devices.contains(device)) return;
        // KWin connects processKey before emitting deviceAdded. Qt invokes direct
        // connections in registration order: this runs AFTER spies and filters.
        m_devices.insert(device, connect(device, &KWin::InputDevice::keyChanged, this, [this] {
            m_candidate.reset();
            settleObservation();
        }, Qt::DirectConnection));
    }
    void observe()
    {
        if (m_observing) return;
        for (auto device : KWin::input()->devices()) attachDevice(device);
        KWin::input()->installInputEventSpy(this);
#if QT_VERSION >= QT_VERSION_CHECK(6, 0, 0)
        // Equal weights insert before the existing GlobalShortcut filter, after
        // KWin's lock/modal filters. No private filter-list mutation is needed.
        KWin::input()->installInputEventFilter(m_repeatGuard.get());
#else
        // KWin 5 exposes only prepend. The predicate declines locked/inhibited
        // input, fresh keys, and every unrelated repeat.
        KWin::input()->prependInputEventFilter(m_repeatGuard.get());
#endif
        m_observing = true;
    }
    void settleObservation()
    {
        if (!m_observing || !m_bindings.isEmpty() || !m_cycles.isEmpty()) return;
        detach();
    }
    void detach()
    {
        if (m_observing) {
            KWin::input()->uninstallInputEventFilter(m_repeatGuard.get());
            KWin::input()->uninstallInputEventSpy(this);
        }
        m_observing = false;
        for (const auto &connection : std::as_const(m_devices)) QObject::disconnect(connection);
        m_devices.clear();
        m_candidate.reset();
    }
    void cancelCycles()
    {
        for (auto &cycle : m_cycles) {
            if (!cycle.ended) deliver(cycle, "cancel");
            cycle.ended = true;
        }
        m_candidate.reset();
    }
    void clearOwner()
    {
        m_bindings.clear();
        m_cycles.clear();
        m_token.clear();
        m_generation.clear();
        m_owner.clear();
        detach();
    }
    void deliver(const Cycle &cycle, const QString &phase, const QString &capture = "{}")
    {
        if (!m_ready || m_owner.isEmpty()) return;
        auto call = QDBusMessage::createMethodCall(m_owner, "/Control", controlService, "PhysicalKey");
        call << cycle.token << cycle.generation << cycle.binding.id << phase
             << QVariant::fromValue(cycle.number) << capture;
        auto watcher = new QDBusPendingCallWatcher(m_bus.asyncCall(call, 2000), this);
        const auto owner = m_owner;
        const auto token = cycle.token;
        const auto generation = cycle.generation;
        connect(watcher, &QDBusPendingCallWatcher::finished, this, [this, owner, token, generation](QDBusPendingCallWatcher *finished) {
            if (finished->isError() && owner == m_owner && token == m_token && generation == m_generation && m_ready)
                fail("PhysicalKey callback failed: " + finished->error().name());
            finished->deleteLater();
        });
    }
    void fail(const QString &reason)
    {
        qWarning().noquote() << "Window Warp companion:" << reason << "— detached; application must reactivate.";
        clearOwner();
        if (m_ready) m_bus.unregisterService(QString::fromLatin1(service));
        m_ready = false;
    }

    QDBusConnection m_bus;
    QDBusServiceWatcher m_ownerWatcher;
    bool m_registered = false;
    bool m_ready = false;
    bool m_observing = false;
    std::unique_ptr<RepeatGuard> m_repeatGuard;
    QString m_owner, m_token, m_generation;
    QList<Binding> m_bindings;
    QList<Cycle> m_cycles;
    QHash<KWin::InputDevice *, QMetaObject::Connection> m_devices;
    QPointer<QObject> m_component;
    QMetaObject::Connection m_activation, m_componentDestroyed;
    std::optional<Candidate> m_candidate;
    quint64 m_nextCycle = 0;
};

class CompanionFactory final : public KWin::PluginFactory
{
    Q_OBJECT
    Q_PLUGIN_METADATA(IID PluginFactory_iid FILE "metadata.json")
    Q_INTERFACES(KWin::PluginFactory)
public:
    std::unique_ptr<KWin::Plugin> create() const override
    {
        if (!KWin::waylandServer() || !KWin::input()) {
            qWarning() << "Window Warp companion requires KWin Wayland";
            return nullptr;
        }
        return std::make_unique<Companion>();
    }
};
#include "companion.moc"
