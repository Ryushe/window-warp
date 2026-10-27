# KDE release from main

- Status: feature
- Owner: Codex release task
- Branch: codex/kde-release-main
- Base commit: d9f24c8a48cbdfdf239712285856e74899eba984
- Intended integration target: main (explicit user authorization)
- Last updated: 2026-10-27
- Latest immutable recovery checkpoint: none yet

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
