# Window Warp KWin companion

This GPL-2.0-or-later native module supplies independent physical lifetimes for
configured application shortcuts. KGlobalAccel still reserves and activates the
shortcuts. The module never grabs the keyboard, changes focus, or exports key text.
A narrow filter suppresses only autorepeats of a previously admitted, still-held
base key, so reassigning that chord cannot revive it before release. Fresh keys
and unrelated repeats pass unchanged, as do locked or shortcut-inhibited input.
See [PROTOCOL.md](PROTOCOL.md) for the authenticated protocol and cleanup rules.
This license applies to the companion directory; it does not change the license
of other application components. [COPYING](COPYING) contains GPL version 2;
the companion may also be used under any later version, as its SPDX headers state.

KWin's internal plugin ABI changes with each release. Build against the exact
distro compositor SDK; do not reuse a module across KWin releases or Qt majors.
The runtime factory IID embeds KWin's version, metadata embeds the build version,
and Configure checks the running version again. The module is disabled by default.

Example for a KWin 6.3.6 SDK containing `kwin-dev`, ECM, CMake, Ninja and a C++20
compiler (Qt/KF development dependencies come from that distro SDK):

```sh
cmake -S desktop/kwin-companion -B build/companion -G Ninja \
  -DWARP_KWIN_VERSION=6.3.6 -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/usr
cmake --build build/companion -j1
DESTDIR="$PWD/stage" cmake --install build/companion
```

The install target uses `KDE_INSTALL_PLUGINDIR/kwin/plugins/windowwarp_companion.so`
under the standard Qt plugin root. The package must depend on the exact matching
distro KWin package, include this source/license information, and ship the staged
module. Setting `QT_PLUGIN_PATH` is suitable for private native tests; it is not
a way to change an already-running user's compositor search path.

Exact source contracts used here: KWin 6.3.6 and 5.27.11 `input.cpp::addInputDevice`,
`keyboard_input.cpp::processKey`, `globalshortcuts.cpp::processKey`, and the local
KGlobalAccel component signal. The native fixture checks dispatch ordering and
real captured identities. Plasma 5 uses the same lifecycle with the Qt5 adapter
in `compat.h`, built against matching distro source/generated headers and libkwin.

The installed `source/` directory contains the module and build sources alongside
the license. `WARP_COMPANION_NATIVE_TESTS=ON` builds a separate test-support plugin;
it is never installed. Run `tests/native.py` only through the repository's
`tests/kde/nested.sh --input-probe` entry point with this directory as its root,
the built modules under a private `QT_PLUGIN_PATH/kwin/plugins`, and
`WARP_COMPANION_OUTPUT` naming the receipt. The fixture needs the existing GI,
PyQt5 and authorized fake-input dependencies of the KDE harness.
