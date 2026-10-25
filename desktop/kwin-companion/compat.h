// SPDX-License-Identifier: GPL-2.0-or-later
#pragma once

#include <input.h>
#include <input_event.h>
#include <core/inputdevice.h>
#include <QKeySequence>

namespace Compat {
enum class State { Pressed, Released, Repeated };

#if QT_VERSION < QT_VERSION_CHECK(6, 0, 0)
using NativeState = KWin::InputRedirection::KeyboardKeyState;
#else
using NativeState = KWin::KeyboardKeyState;
#endif

inline State state(NativeState value)
{
    switch (value) {
#if QT_VERSION < QT_VERSION_CHECK(6, 0, 0)
    case KWin::InputRedirection::KeyboardKeyPressed: return State::Pressed;
    case KWin::InputRedirection::KeyboardKeyReleased: return State::Released;
    case KWin::InputRedirection::KeyboardKeyAutoRepeat: return State::Repeated;
#else
    case KWin::KeyboardKeyState::Pressed: return State::Pressed;
    case KWin::KeyboardKeyState::Released: return State::Released;
    case KWin::KeyboardKeyState::Repeated: return State::Repeated;
#endif
    }
    Q_UNREACHABLE();
}

struct Event {
    KWin::InputDevice *device;
    State state;
    quint32 code;
    int key;
    Qt::KeyboardModifiers modifiers;
    Qt::KeyboardModifiers shortcutModifiers;
};

#if QT_VERSION < QT_VERSION_CHECK(6, 0, 0)
inline Event event(KWin::KeyEvent *value)
{
    const auto kind = value->isAutoRepeat() ? State::Repeated
        : value->type() == QEvent::KeyRelease ? State::Released : State::Pressed;
    return {value->device(), kind, value->nativeScanCode(), value->key(),
            value->modifiers(), value->modifiersRelevantForGlobalShortcuts()};
}
#else
inline Event event(KWin::KeyboardKeyEvent *value)
{
    return {value->device, state(value->state), value->nativeScanCode, value->key,
            value->modifiers, value->modifiersRelevantForGlobalShortcuts};
}
#endif

inline int chord(const QKeySequence &sequence)
{
#if QT_VERSION < QT_VERSION_CHECK(6, 0, 0)
    return sequence[0];
#else
    return sequence[0].toCombined();
#endif
}

inline Qt::KeyboardModifiers modifiers(int value)
{
    return Qt::KeyboardModifiers(value & int(Qt::KeyboardModifierMask));
}

inline int key(int value)
{
    return value & ~int(Qt::KeyboardModifierMask);
}

inline bool matches(int chord, const Event &event)
{
    const auto combined = [mods = event.shortcutModifiers](int key, Qt::KeyboardModifiers extra = {}) {
        return int(mods | extra) | key;
    };
    if (chord == combined(event.key)) return true;
    // Match KWin's GlobalShortcutsManager Backtab alternatives on both versions.
    return event.key == Qt::Key_Backtab
        && (chord == combined(Qt::Key_Backtab, Qt::ShiftModifier)
            || chord == combined(Qt::Key_Tab, Qt::ShiftModifier));
}
}
