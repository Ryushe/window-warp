# Workspace editor flow integration dossier

- **Status:** implemented and exercised; independent review and integration pending
- **Owner:** Codex
- **Branch:** `codex/workspace-editor-flow`
- **Base commit:** `bffd59af4fb2605b32c1df59921cf503fbb1b702`
- **Intended integration target:** `refs/heads/codex/release-0.1.7-candidate` in the existing release cache; `refs/heads/main` remains the later release integration target.
- **Last updated:** 2026-11-07
- **Owning feature branch/ref:** `refs/heads/codex/workspace-editor-flow` in this isolated checkout
- **Latest immutable recovery checkpoint:** recorded in the follow-up handoff commit
- **Feature implementation commit(s):** recorded in the follow-up handoff commit
- **References:** user-reviewed workspace previews, `AGENTS.md`, `desktop/HOOK-HANDOFF.md`, `desktop/TODO.md`

## Intent and success criteria

Build the reviewed workspace editor flow on the recent browser-extension
candidate without changing unrelated shared checkout work. Keep saved-workspace
selection available during an edit; protect and clearly name unsaved changes
when switching editors. Put a window's position, monitor, and manual placement
action on its row. Show browser connection state as an accessible dot before
the tab count, with Settings navigation. Make browser URLs directly editable and
offer a focused-tab choice in Advanced alongside existing profile and launch
options. Simplify adding windows, show progress, remove the editor's Remove all
button, and preserve bulk operations and meaningful errors.

The Windows hook, packaging, publishing, and broad three-or-more-monitor support
are outside this feature. Existing app, browser, and terminal launch data must
remain recoverable. Browser focus behavior must not act on an unverified window
or silently discard saved URLs.

## Implemented contract

- Saved workspace selection stays available while a draft exists. Switching to
  another editor asks whether to save, discard, or keep a changed draft; a
  deleted source is preserved as a new draft.
- Window rows expose position presets, real detected monitors and manual
  positioning; monitor IDs remain stable where available. Bulk removal is
  reversible within the draft.
- A keyboard-accessible connection dot precedes the tab count and opens
  extension settings. Browser URLs are editable one per line; Advanced retains
  browser profile, focused-tab, placement, terminal and app launch settings.
- Browser-tab refresh protects edited URLs. Add window provides on-screen and
  multi-select list modes, with progress, wrapping, and error feedback.
- A capable paired extension confirms tab focus only for a uniquely matched
  non-private window whose tab list has not changed. When confirmation is
  unavailable the selected URL is supplied first for new browser windows and
  restore reports the uncertainty. Existing extension versions need to be
  updated before they can perform this new focus operation.

## Evidence and review

- Baseline relevant workspace and browser files match the recovery checkpoint.
- Managed worktree creation could not use the OneDrive checkout because Git
  object mappings failed; this isolated checkout uses the existing recovery
  object store as a read-only alternate.
- Full JavaScript suite passed with the installed `linkedom` and `web-ext`
  dependencies and local loopback access. `npm run check` and `cargo fmt --check`
  passed.
- Full Windows Rust suite passed: 172 passed, 9 opt-in tests ignored.
- `node desktop/tests/windows/native.mjs --ux-only` passed on Windows with
  isolated settings and the task-owned cargo target. It exercised workspace
  monitor selection and restore, the single non-browser divider, the add button
  label, browser dot ordering and settings navigation with draft preservation.
  The run's screenshot is
  `desktop/src-tauri/target/windows-validation/WARP-NATIVE-f9cafd3c-f264-421b-bb0e-15c67577a074/ux-workspace-browser.png`.
- The isolated Windows Edge fixture exercised a real paired extension and
  verified saved-tab focus in both a reused browser window and a newly launched
  window, including URL order in the latter. The full
  `node desktop/tests/windows/native.mjs --chromium-only` fixture passed using
  the installed Edge browser and a short temporary fixture directory.
- Self-review completed. Independent code review remains required before merge.

## Blockers and deferred work

- The existing preview branch and `main` have known conflicts; reconciliation
  and release integration are outside this feature.
- The paired Chromium/Edge focus path has real-browser coverage. Before
  release, run the Firefox extension acceptance fixture with an updated
  extension and verify restored focus for new and reused Firefox windows.
- Extension packaging and published update versioning were not changed. Plan
  the companion extension update under `release.md` before release.

## Interruption / resume handoff

- **Owning feature branch/ref:** `refs/heads/codex/workspace-editor-flow`
- **Latest immutable recovery checkpoint:** recorded in the follow-up handoff commit
- **Exact resume point:** independent review, paired-browser acceptance, and
  candidate-branch reconciliation.
- **Working-tree state at handoff:** implementation checkpoint.

## Decision gates

- **Integration:** review this branch and merge into its named candidate parent.
- **Activation:** use an isolated preview without replacing installed settings.
- **Promotion:** any release follows `release.md` and explicit user direction.
