# KDE release from main

- Status: review-ready
- Owner: Codex release task
- Branch: codex/kde-release-main
- Base commit: d9f24c8a48cbdfdf239712285856e74899eba984
- Intended integration target: main (explicit user authorization)
- Last updated: 2026-10-27
- Latest immutable recovery checkpoint: 6c12f445a26adcae193b5d870fcc7977a3411584

## Intent and contract
Fix release blockers and publish a KDE package alongside Windows. Preserve main runtime behavior; exclude all Windows hook/window-change experiments from the active Windows checkout. Rust formatting is the initial CI fix. Package the exact KWin 5.27.11 Ubuntu 24.04 companion with source/license and its exact package dependency.

## Evidence and review
Main differs from v0.1.0 only in desktop/TODO.md. The audit passed 136 Node tests and syntax checks; both remote CI jobs failed rustfmt before native builds. Formatting was reproduced and applied in this isolated checkout. Hoster unit hoster-warp-release-build-20261027 owns a bounded fresh-source build, logs at ~/.cache/window-warp-release-20261027/build.log. Independent review pending. Fresh Linux compilation exposed a stale reassignment test: the default pause binding also uses Super+Semicolon, producing [0, 2, 8] rather than the fixture's [0, 2]. The fixture now keeps only its five explicit bindings; runtime code is unchanged. Recovery checkpoint a708262 contains the formatting fix.

## Blockers and deferred work
Run fresh Linux Rust tests, package build, isolated package installation and launch checks, then verify Windows CI. Existing experimental native Windows receipts are not release acceptance. Physical display/login acceptance and arbitrary KWin versions remain outside this bounded release. Re-run these on their actual hardware/version when claiming that coverage.

## Resume
Source lives in /tmp/window-warp-release-audit.hVDFsu/repo. Inspect the Hoster build log and task unit, repair only demonstrated release failures, review, integrate to main, and publish the verified package. Existing Windows installers may be retained if no runtime change requires a version bump. No other branch is merged.

## Decision gates
Integration: focused fixes, passing declared checks and independent review. Publication: verified artifact provenance, exact KWin dependency, package contents and installation/launch acceptance, honest release notes. Experimental branch propagation is deferred to its owner because it is actively edited and explicitly excluded by the user.

## Final decision and release evidence
Accepted for main on 2026-10-27. Independent release_review verified that all eight changed Rust files equal rustfmt(base), plus only the two test fixture lines. No production behavior changes or experimental branch changes. Independent 136 Node tests, syntax, fmt and whitespace checks passed. GitHub run 40546018701 passes Windows and Ubuntu tests/builds at 6c12f44. Fresh Hoster build passes 84 Linux Rust tests (one opt-in ignored) and 136 Node tests.

Fresh package SHA256: 0a839a7ca9942f451da810841bc0034916ca95f8b26a5007d241e3c7db1032ea. Installed executable SHA256: e93f93754edc9bdd4d9b91184026450df04549a63b3be219cd011e638a2cb2d6. Companion SHA256: f4a91a60eb8a7715f74fbadd0569989f4c5aa073ebbdfd23eb326f05d9bc2107. Every tracked desktop source hash matches this branch. Package contains module/source/GPL and excludes test plugin.

Hoster unit hoster-warp-package-acceptance-20261027-api passes installation, standalone KWin checks, eight installed-app smoke checks and uninstallation in a disposable matching Ubuntu/KWin container. Smoke covers rendering, persistence, companion load, pause/resume, shared theme/popup, second editor shortcut, two-window restore and startup registration. The initial smoke attempt used an invalid plugin-inspection property; corrected to introspect the actual companion endpoint. This is not physical keyboard/login/hardware acceptance. Screenshots inspected.

Hoster cleanup sidecar inspected three unregistered live scopes and correctly retained all; no apply. Main integration will remove this branch-local dossier. Publish the KDE .deb, exact main source snapshot and checksums on existing v0.1.0; retain original Windows installers because no runtime behavior changed. Do not move the existing tag. Release notes must identify the KDE build source commit and exact supported KWin package. Verify remote assets after upload, then retire this task branch.
