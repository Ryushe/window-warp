# Browser focus extension version integration dossier

- **Status:** independently reviewed and verified
- **Owner:** Codex
- **Branch:** `codex/extension-focus-version`
- **Base:** `d7cd97a9efbe04a2035c6a58e5701e5d6779353d`
- **Intended integration target:** `refs/heads/codex/release-0.1.7-candidate` in the existing release cache, then the user-requested `refs/heads/codex/desktop-shortcut-ux`
- **Latest immutable checkpoint:** recorded after implementation commit
- **Last updated:** 2026-11-07

## Intent and contract

The reviewed workspace editor changed the shared extension background to focus
saved tabs. `release.md` requires both browser manifest versions to advance when
extension files change, so bump the independent Firefox and Chromium extension
versions from 0.1.7 to 0.1.8. The desktop application remains 0.1.7. This lets
prepared development copies recognize the newer extension; it does not publish
or submit an extension.

## Evidence and review

- Full focused extension and Firefox release JavaScript tests passed (32 tests),
  including the local mock.
- The Rust prepared-extension refresh test passed.
- `npm run check` passed; `web-ext lint` reported zero errors or warnings.
- Independent review by `workspace_review` found no actionable issues.
- Live Firefox focused-tab restoration remains an end-to-end gap before release.

## Integration and activation

Merge into the local candidate, remove this temporary dossier from the
integration tree, then merge the candidate into the explicitly requested
`codex/desktop-shortcut-ux` branch and push that branch. Keep the user's dirty
checkout and its separate extension-library changes untouched. No release,
store submission, or installed-app update is requested.

## Resume point

- **Owning feature ref:** `refs/heads/codex/extension-focus-version`
- **Latest checkpoint:** recorded after implementation commit
- **Next action:** integrate the manifest version bump and push the user-named branch.
