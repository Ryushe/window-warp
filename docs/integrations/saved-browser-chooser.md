# Saved browser chooser integration dossier

- **Status:** implemented, independently reviewed, and verified
- **Owner:** Codex
- **Branch:** `codex/saved-browser-chooser`
- **Base:** `bc39c74f86af0798795af78dc8dbebbb238e9ec2`
- **Intended integration target:** `refs/heads/codex/release-0.1.7-candidate` in `desktop/src-tauri/target/window-warp-release-cache.git`
- **Latest immutable checkpoint:** `3ea1afb47dfc57a0cacad773a605b84553c2594a`
- **Last updated:** 2026-11-07

## Intent and contract

When a saved browser is added to a workspace containing multiple browser
windows, keep Add as new browser disabled until a window is selected, matching
Append tabs and Replace tabs, including the keyboard shortcut. A single browser
remains automatically selected; an empty workspace can still receive its first
browser.

Update the Windows and KDE chooser fixtures for the new initial state. The
Windows fixture's optional output root must also be honored by its Python
executable-identity guard; the prior implementation could not run the chooser
fixture with a short custom path.

## Evidence and review

- Focused saved-browser JavaScript suite: 26 passed; `npm run check` passed.
- Independent review by `workspace_review` found no actionable issues in the
  chooser behavior or fixture path guard; the focused suite passed independently.
- Windows `native.mjs --chooser-only` passed with both default and custom output
  roots. Windows denied focus to the owned keyboard fixture, so its Ctrl+Shift+R
  input was sent to the owned WebView by the existing fixture fallback.
- Syntax and whitespace checks passed. KDE fixture changes were syntax checked
  but not run on KDE.

## Integration and activation

Merge into the named candidate after verification and remove this temporary
dossier from the integration tree. Build the isolated workspace preview from the
merged source; preserve the existing user's preview state and any unsaved draft
when deciding how to activate the new binary. No package publication is requested.

## Resume point

- **Owning feature ref:** `refs/heads/codex/saved-browser-chooser`
- **Latest checkpoint:** `3ea1afb47dfc57a0cacad773a605b84553c2594a`
- **Next action:** merge the reviewed change and build the updated preview.
