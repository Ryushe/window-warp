# Companion protocol 1

The runtime plugin ID is `windowwarp_companion`. Load it through
`org.kde.KWin /Plugins org.kde.KWin.Plugins.LoadPlugin(string) -> bool`.
It owns service **com.windowwarp.Companion**, object **/WindowWarpCompanion**,
interface **com.windowwarp.Companion**. Watch that service's unique owner:
unload or terminal callback failure removes the service, and all local gesture
state must then be cancelled. An owner change starts a new cycle-number epoch.

Methods:

- `Info() -> string`: JSON `{"protocol":1,"kwinVersion":"6.3.6"}` identifying
  the exact build. Configure also verifies the running compositor version.
- `Configure(string token, string generation, string bindingsJson) -> void`:
  JSON array `[{"id":"exact-registered-KGlobalAccel-action-id","shortcut":"Ctrl+Alt+K"}]`.
  Shortcuts use Qt PortableText single chords, including the same normalization
  used by the registration script. IDs and chords must be unique. Register
  shortcuts first. Empty bindings disable new cycles; generation may then be
  empty. Only the unique connection currently owning `com.windowwarp.Control`
  may configure. No configuration changes occur for an invalid request.

Typed errors are `com.windowwarp.Companion.Unauthorized`, `InvalidBindings`,
`Unavailable`, and `UnsupportedPlatform`. This adapter requires KWin Wayland.

One ordered method-call stream targets that exact owner's unique bus name:

```
/Control com.windowwarp.Control.PhysicalKey(
    string token, string generation, string id, string phase,
    uint64 cycle, string captureJson) -> void
```

`phase` is `down`, `up`, or `cancel`. Down contains
`{"x":integer,"y":integer,"previous":{"id":"{UUID}","pid":integer}|null,"at":unixMilliseconds}`.
The UUID uses the same Qt `QUuid::toString()` format as the KWin script wrapper.
Up/cancel contain `{}`. The consumer must keep dispatch ordered (the Rust
interface uses `spawn=false`) and enqueue each message before returning.
There is no join with asynchronous script pointer or KGlobalAccel signals.
`cycle` increases on each admitted activation within this provider instance.

The pre-filter spy keeps only a matching fresh native key candidate. Actual
local `Component.globalShortcutPressed` is connected directly and consumes it
once while still inside KWin's keyboard dispatch. A trailing direct connection
to `InputDevice::keyChanged` clears an unmatched candidate synchronously after
KWin's handler. A device without that guaranteed boundary cannot admit a cycle.
Repeats and programmatic shortcut invocation without a fresh native dispatch
cannot create cycles. KWin's modal/inhibitor policy therefore remains decisive.

Physical base release is keyed by seat scan code, since libinput may deliver
first-down and final-up from different keyboards. The origin device is retained
only for device-removal cancellation. Loss of a required modifier also sends up. Modifier-first
release keeps a base-key guard until the base actually rises, preventing repeat
restart. Reconfigure/pause/lock cancels active old-generation cycles immediately
and keeps those guards. The later base release only clears the guard; each cycle emits one terminal
up/cancel. Owner loss detaches all observation. A key already held before a new
Configure cannot start a cycle: repeats and modifier-only events never create
a fresh base-key candidate. Device removal cancels its cycles. No key text or unrelated key
events leave the compositor. While locked only old-cycle releases are observed.

The retained base guard also suppresses **only Repeated events** for that admitted
seat scan code. This prevents a reassigned direct shortcut from firing on an old
held key. It never activates a shortcut, grabs input, filters a fresh press or
release, or filters unrelated repeats. Locked/inhibited input passes unchanged.
KWin 6 installs this guard at the public GlobalShortcut weight, immediately before
the built-in shortcut filter and after lock/modal filters. KWin 5 exposes only
prepend; the same restricted predicate explicitly declines locked/inhibited
input there. The guard ends on base-up, cancellation by device removal, owner
loss or unload; pause/reconfigure retain it until physical release.

Callbacks are asynchronous with a two-second deadline. Failure of a callback
for the current owner/token/generation detaches and releases the service, with
one sanitized diagnostic. Late failure from an older generation cannot cancel
a newer session. The consumer must treat provider disappearance as cancellation,
never as a tap or a reason to fall back to semantic shortcut release. On explicit
reactivation, if the service is absent but LoadedPlugins still lists this module,
unload that failed module before loading it again. There is no automatic retry.

Hardware dispatch uses the same synchronous boundary: KWin's LibinputBackend
queues `eventsRead` to its main-thread context, whose lambda calls
`Connection::processEvents`; that method emits each device's `keyChanged`.
The libinput device's QObject affinity can be the worker thread, but emission
and KWin keyboard processing occur on the main thread. The exact distro source,
not only fake-input timing, establishes this supported backend contract.

