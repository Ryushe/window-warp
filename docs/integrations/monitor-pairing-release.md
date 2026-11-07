# Monitor, pairing, and 0.1.6 preview release

- **Status:** independently reviewed; preview release preparation in progress
- **Owner:** Codex
- **Working branch:** `codex/desktop-shortcut-ux`, base `6cd6da003b0896c11f7b7e125686ee5db6733b1e`
- **Release ref:** `refs/heads/codex/window-warp-0.1.6-preview`; preview tag `v0.1.6`
- **Future integration target:** `refs/heads/main`, fetched tip `16d8b97da718de47cc78749602b89c95095709b7`
- **Last updated:** 2026-11-06
- **Recovery checkpoint / implementation commit:** not yet committed
- **References:** `AGENTS.md`, `release.md`, `desktop/HOOK-HANDOFF.md`

## Intent and contract

Publish the user's current Windows and KDE application as a preview so Firefox
reviewers can test the companion extension. Settings must show connected monitor
names, preserve stable monitor identities where available, and explain that the
Firefox pairing code is pasted into the extension. Existing numeric monitor
settings and the single Windows hook remain supported.

On Plasma 5 and on systems without stable display IDs, monitor selection remains
position-based; the UI and release notes tell users to refresh and reselect after
display changes. Named selections add settings fields that older app versions
cannot read; empty fields are omitted to preserve ordinary rollback.

## Evidence and review

- JavaScript suite: 299 passed on Windows. PortaFort's build passed 298;
  the final pairing and restored upstream timing tests passed separately.
- Windows Rust suite: 169 passed, nine ignored. PortaFort Rust: 144 passed,
  one ignored.
- Windows native `--ux-only`: passed against the reviewed source, including
  named monitor selection. Receipt: `WARP-NATIVE-cd4d88f1-0d22-494c-894c-0b331802d060`.
- Windows native `--firefox-extension-only`: passed real Firefox pairing,
  capture, live opening and closing tabs, and manual updates in an isolated
  profile. Receipt: `WARP-NATIVE-c283935a-0da0-40af-bfbf-2f6305a455d8`.
- The built KDE package passed 21 checks in a private compositor and process
  namespace, including named monitor selection and discard, without stopping
  the installed app. Task-owned receipt: `gui-v3-private/gui-result.json`.
- The same package passed 29 private KDE Firefox and browser-bridge checks,
  including ownership-scoped live updates with a synthetic extension client.
  The Firefox crash reporter exited abnormally during fixture teardown after
  the successful result. Receipt: `gui-v3-firefox/gui-result.json`.
- Independent monitor/pairing review: focused tests 136 passed; main's empty-ID
  matching regression and KDE GUI readiness fixes were reconciled. `cargo fmt
  --check` passes.
- Both packages are built and validated; the GitHub tag and release assets
  are pending. The Firefox listing URL and a live Mozilla
  credential test are pending.

## Release and recovery gates

The local Git object store contains unavailable OneDrive placeholders. A fresh
bare remote cache under `desktop/src-tauri/target/window-warp-release-cache.git`
contains the fetched remote refs and the checkout base; do not reset, clean, or
overwrite the user's checkout to work around it. Before publication, audit the
direction from fetched `main` to the release tree and preserve all applicable
upstream fixes. The preview branch remains separate from `main`: a three-way
merge check found conflicts in twelve files, so main integration is deferred
instead of overwriting either history. The Firefox workflow runs only from an enabled default-branch
workflow on stable releases; this preview must not silently submit the user's
in-progress Mozilla listing.

Next: complete exact-source Windows and KDE checks, build the installers, create
a recoverable release commit and preview tag, publish the assets, and read back
the public release. Carry any unverified behavior into the release notes.
