# Browser focus after launch integration dossier

- **Status:** feature; verification in progress
- **Owner:** Codex
- **Owning feature branch/ref:** `codex/fix-focus-after-launch`
- **Base commit:** `1b99c0c` (`owner/workspace-editor-flow`)
- **Intended integration target:** `refs/heads/main`, through the existing 0.1.7 release descendants
- **Last updated:** 2026-11-07
- **Latest immutable recovery checkpoint:** base commit; implementation pending commit
- **Inspiration / canonical references:** `AGENTS.md`, `release.md`, and the disposable Chromium acceptance fixture

## Intent and implemented contract

The native Chromium fixture exposed a race while opening a workspace in a new
browser window. The extension already reported the saved URLs while the native
window still had an `Untitled` title; the resulting focus request was omitted
and the user saw a warning. Reobserve both sides briefly for a newly launched
window. Continue requiring the same unique window, browser profile, and saved
URL checks, and retain the warning if the match remains uncertain. Existing
windows do not receive the launch-specific retry. The extension is sampled
once and native titles are rechecked within one eight-second budget, avoiding
another five-second extension poll. A target title must be stable across two
native observations, and a selected URL shared by another possibly matching
profile is treated as ambiguous. Cancellation is rechecked under the queue lock.

## Evidence and review

- The disposable Chromium fixture failed twice on release candidate `c25ed73`;
  failure-only diagnostics showed `Untitled` on the native side and the loaded
  page title on the extension side. A diagnostic run with a delay passed.
- The focused regression was first run against a single observation and failed
  as expected. All 49 Windows browser-bridge tests then passed with loopback.
  The regression also verifies that ambiguous windows remain unmatched after
  all retries. A fresh native Chromium run is pending after propagation.
- Independent review identified the need for a shared time budget, stable
  titles, and handling an extension that polls every five seconds. An initial
  fix passed 49 bridge tests but still failed the native Chromium fixture; the
  revised single-snapshot approach passed all 49 bridge tests, including
  deadline, ambiguous URL, and mixed matched/unmatched cases. The real browser
  fixture and final review remain pending after propagation.

## Blockers and deferred work

- Run `cargo test --offline --manifest-path desktop/src-tauri/Cargo.toml
  browser_bridge::tests` and the isolated Windows `node
  desktop/tests/windows/native.mjs --chromium-only` fixture after integrating
  the fix. The native test must verify the real launched browser and extension.

## Interruption / resume handoff

- **Owning feature branch/ref:** `codex/fix-focus-after-launch`
- **Latest immutable recovery checkpoint:** `1b99c0c`
- **Exact resume point:** finish focused tests, record results, commit, merge
  into affected descendants, and re-run the release checks.
- **Activation boundary:** a rebuilt app is required; no installed app was changed.

## Decision gates

- **Integration gate:** focused regression, bridge tests, and review.
- **Promotion gate:** native browser acceptance and the existing release gates.
