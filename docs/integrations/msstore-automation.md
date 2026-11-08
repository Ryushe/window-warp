# Microsoft Store automation integration dossier

- **Status:** published on a feature branch; not integrated into `main`
- **Owner:** Codex
- **Feature ref:** `refs/heads/codex/msstore-automation` in
  `desktop/src-tauri/target/window-warp-release-cache.git`
- **Remote feature ref:** `origin/codex/msstore-automation`
- **Parent and merge-back target:** `refs/heads/codex/release-0.1.7-candidate`,
  checkpoint `bffd59af4fb2605b32c1df59921cf503fbb1b702`
- **Final integration target:** `refs/heads/main`, fetched at
  `16d8b97da718de47cc78749602b89c95095709b7`
- **Implementation checkpoint:** `409da7ac798ce32243c3b75a4014ddc4965f483a`

## Intent and contract

On stable GitHub releases, test and build the matching Windows MSIX and submit
it to the existing free Microsoft Store listing. A manual workflow run checks
credentials and identity without submitting anything. Store credentials are
repository secrets; the optional Firefox listing URL is an Actions variable.
The workflow checks for a pending Partner Center submission before publishing
because the Microsoft CLI otherwise replaces it. The API check and publish are
not atomic with concurrent manual Partner Center changes. A stable GitHub
release whose tag contains this workflow can trigger it before a merge to
`main`; the manual Actions run requires the workflow on the default branch.

## Evidence and blockers

- `pwsh -NoProfile -File desktop/tests/windows/check-msstore.ps1` covers a
  normal account, a pending draft, identity and publisher mismatch, an initial
  submission, incomplete data, CLI failure, and invalid JSON without a network.
- Parsed the workflow YAML and all eight embedded PowerShell steps; checked the
  stable-release/manual-run boundaries. Exercised the actual release-version
  step with a matching tag and a mismatched tag.
- Executed the actual submit and manual-check workflow steps with a fake Store
  CLI: a release without a draft submitted, a pending draft prevented
  submission, and the manual account check never submitted.
- The parent 0.1.7 candidate passed `npm run check` and all 336 JavaScript
  tests. Its local Firefox mock requires loopback access outside the sandbox.
- The existing GitHub desktop checks passed on Windows and Ubuntu for feature
  checkpoint `ec67d580e63e7c59377ac4ac30ca3389d17f6e04`:
  `https://github.com/Ryushe/window-warp/actions/runs/42428031052`.
- A temporary push trigger ran the read-only Store check on feature checkpoint
  `187db65b6da2b7f9c1f471dd306520a8afbc4f80`. Authentication and MSIX identity
  verification passed; the Store submission step was skipped:
  `https://github.com/Ryushe/window-warp/actions/runs/42434835778`.
  The temporary push trigger has been removed. The Store release workflow's
  package build and actual Store submission remain unverified on GitHub.
- The parent release candidate and fetched `main` have known conflicts. Preserve
  both histories and resolve those conflicts before enabling the workflow on
  `main`; do not reset or stage the user's shared checkout.
- The user configured the Entra application and Actions secrets described in
  `release.md`; the read-only check succeeded. Publishing also requires an
  existing published Store listing and no pending Partner Center submission.

## Handoff

Keep the feature ref and this dossier until the release candidate is reconciled,
reviewed, and integrated. Retire the dossier from the integration target after
acceptance. A successful read-only check proves
access, not Store certification or installation and upgrade behavior. Resume
by reconciling the parent release candidate with the fetched `main`, then
integrate this feature and repeat the checks on the integrated tree.
