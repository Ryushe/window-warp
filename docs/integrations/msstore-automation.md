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
- The GitHub-hosted build and live Store access cannot be tested until the
  workflow and the user's Partner Center credentials are available.
- The parent release candidate and fetched `main` have known conflicts. Preserve
  both histories and resolve those conflicts before enabling the workflow on
  `main`; do not reset or stage the user's shared checkout.
- Configure the Entra application and Actions secrets described in `release.md`,
  then run the workflow manually to verify the account and identity without
  submitting. Publishing also requires an existing published Store listing and
  no pending Partner Center submission.

## Handoff

Keep the feature ref and this dossier until the release candidate is reconciled,
reviewed, integrated, and the manual Store check succeeds. Retire the dossier
from the integration target after acceptance. A successful manual check proves
access, not Store certification or installation and upgrade behavior. Resume
by reconciling the parent release candidate with the fetched `main`, then
integrate this feature and repeat the checks on the integrated tree.
