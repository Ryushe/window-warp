# Restore add-browser action integration dossier

- **Status:** independently reviewed and verified; ready for candidate integration
- **Owner:** Codex
- **Branch:** `codex/restore-add-browser`
- **Base:** `608f9650f6b4820e2884114ffb805518c3d6a43f`
- **Target:** `refs/heads/codex/release-0.1.7-candidate` in the existing release cache
- **Latest immutable checkpoint:** `e4457dc258e3013ae1e4d977b65e87f781057bff`
- **Last updated:** 2026-11-07

## Intent and contract

Reverse the previous selection requirement for Add as new browser. Once the
source and destination are loaded, the action and Ctrl+Shift+N work without
selecting an existing browser. Append and Replace still require a selected
browser. Loading and in-progress actions remain disabled.

## Evidence and review

- Focused saved-browser JavaScript suite: 26 passed.
- `npm run check`, Windows fixture syntax, and whitespace checks passed.
- Independent review by `workspace_review` found no actionable issues; the
  reviewer also passed all 26 focused JavaScript tests.
- The Windows `native.mjs --chooser-only` fixture passed. Windows denied focus
  to the owned keyboard fixture, so its existing WebView fallback was used.

## Integration and activation

Merge into the named local candidate and remove this temporary dossier from
the integration tree. Rebuild the isolated workspace preview with the same
preview state; the user previously approved restarting this preview to apply
changes. No release or publication is requested.

## Resume point

- **Owning feature ref:** `refs/heads/codex/restore-add-browser`
- **Latest checkpoint:** `e4457dc258e3013ae1e4d977b65e87f781057bff`
- **Next action:** merge the reviewed change and refresh the preview.
