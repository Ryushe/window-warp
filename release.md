# Window Warp releases

- **Windows:** Build an MSIX package for the Microsoft Store.
- **Linux:** Build a Debian `.deb` package for official app releases.
- **Browser extensions:** Firefox Add-ons is packaged for manual submission below. Chrome
  Web Store distribution is pending.

## Firefox Add-ons

The Firefox extension uses the existing ID `window-warp@ryushe.local` and its
own version in `desktop/browser-extension/firefox-manifest.json`. The Firefox
distribution is MIT-licensed; its license notice is
`desktop/browser-extension/FIREFOX-LICENSE`.

Create a Mozilla Add-ons developer account and accept its agreements before
uploading the ZIP through the developer dashboard. The first listing uses the
MIT license, the Tabs category, and the approved `Privacy Policy.txt`.

For a stable GitHub release, `.github/workflows/firefox-addon.yml` checks out
the release commit, runs the JavaScript checks and tests, assembles the Firefox
extension, runs Mozilla's `web-ext lint`, and saves an unsigned ZIP as an Actions
artifact for manual submission. It does not upload, sign, or submit the add-on.
No Mozilla API credentials are required to build the ZIP or submit it manually.
When extension files change, increase the version in **both** browser manifests
so prepared development copies can update.

Once Mozilla has assigned the public add-on URL, set
`WINDOW_WARP_FIREFOX_ADDON_URL` to that exact URL when building the desktop app.
The regular Settings screen then opens the listing and offers a pairing code.
Without a listing URL, it keeps the temporary Firefox setup available instead.
Quit any running copy before launching with `--developer-extensions` to expose
the Firefox and Chromium development-install controls.

## Windows MSIX

Build the current Windows release executable first, then run:

```powershell
cd desktop
npm run build -- --no-bundle
cd ..
./desktop/scripts/build-msix.ps1
```

The script uses the Windows SDK's MakeAppx and writes an **unsigned** MSIX under
`desktop/src-tauri/target/release/bundle/msix/`. Use `-WhatIf` to inspect the
output path, or `-Binary`, `-OutputDirectory`, and `-MakeAppx` to select other
inputs. It refuses to overwrite an existing package. Update the four-part
version in `desktop/packaging/msix/AppxManifest.xml` when the app version changes.
Before submission, verify the manifest's identity and publisher against Partner
Center. Local installation requires a suitably signed package and trusted
certificate; a built package alone is not installation or upgrade evidence.

Script index: `desktop/scripts/build-msix.ps1` packages a built Windows executable
for the Microsoft Store without installing or signing it.

### Microsoft Store automation

Microsoft's [Store publishing action guidance](https://learn.microsoft.com/en-us/windows/apps/publish/msstore-dev-cli/github-actions)
currently covers updates to an existing, published free app. Window Warp's
Store product ID is `9NVBS6W8RV54`. Before enabling the workflow, confirm that
the app's MSIX identity and publisher in Partner Center match
`desktop/packaging/msix/AppxManifest.xml`.

One-time account setup:

1. Associate a Microsoft Entra tenant with the Partner Center account. Register
   an Entra application and add it under Partner Center's **Account settings →
   User management → Microsoft Entra applications**, with the Manager role.
2. Create a client secret for that application. In the repository's
   [Actions secrets](https://github.com/Ryushe/window-warp/settings/secrets/actions),
   set `AZURE_AD_TENANT_ID`, `AZURE_AD_APPLICATION_CLIENT_ID`,
   `AZURE_AD_APPLICATION_SECRET`, and `SELLER_ID` to the corresponding tenant,
   application, secret value, and Partner Center seller IDs. Never put their
   values in the repository or chat. The client secret is shown only once.
3. When the Firefox listing URL is known, set the repository Actions variable
   `WINDOW_WARP_FIREFOX_ADDON_URL` to that URL for Store builds.
4. After the workflow is integrated into the default branch, run **Publish
   Microsoft Store update** manually from the Actions tab. This manual run only
   verifies access and app identity; it does not create or change a submission.

For each **stable** GitHub release, `.github/workflows/microsoft-store.yml`
checks the release tag, runs the desktop checks, builds an MSIX from that commit,
and submits it using the Microsoft Store CLI. Pre-releases do not submit. The
workflow keeps the package as an Actions artifact; Microsoft certification
still determines when the update becomes available. Confirm its result in
Partner Center. A release created by another workflow using `GITHUB_TOKEN` does
not normally trigger a release-event workflow; see the Firefox section above.

The CLI replaces a pending Partner Center submission when publishing. The
workflow checks for one immediately before submission and stops if it finds
one; finish or remove that draft deliberately before rerunning the release.
This check is not atomic with publishing, so do not create a Partner Center
draft while the Store workflow is running. Microsoft documents this behavior in
its [MSIX CLI reference](https://learn.microsoft.com/en-us/windows/apps/publish/msstore-dev-cli/publish-command).
Run `desktop/tests/windows/check-msstore.ps1` to exercise the read-only checks
without credentials. GitHub can run the release workflow from a tagged commit
that contains it even before that commit is merged into `main`; do not publish
a stable tag from this branch before integration and account checks. The manual
Actions run is available after the workflow exists on the default branch.

Script index: `desktop/scripts/check-msstore.ps1` checks the Store account,
package identity, and existing submission without modifying Partner Center.

## Chrome Web Store

Google's [Chrome Web Store API](https://developer.chrome.com/docs/webstore/using-api)
can upload and submit updates after the developer account and store listing are
configured. A first listing needs its Store listing and Privacy fields completed
in the dashboard, and publishing requires two-step verification. Enable the API
in a Google Cloud project and authorize either an OAuth client or a
[service account](https://developer.chrome.com/docs/webstore/service-accounts)
for the publisher. A future stable-release workflow needs the publisher ID,
extension ID, authorized credentials, and a versioned Chromium package; Google
reviews submissions before publishing. No Chrome workflow is enabled until the
listing and credentials are available.

## Linux Debian package

Build the KWin companion against the exact target distribution's KWin SDK,
then package it with the release executable:

```sh
cd desktop
export WARP_COMPANION_STAGE=/absolute/path/to/companion-stage
export WARP_KWIN_PACKAGE_VERSION="$(dpkg-query -W -f='${Version}' kwin-common)"
bash tests/kde/build.sh
```

The 0.1.7 package targets Linux Mint 22.2 amd64 with KDE Plasma 5 on Wayland
and pins `kwin-common` to `4:5.27.11-0ubuntu3`; it is not a universal Plasma
package. See `tests/kde/README.md` for the SDK, isolated compositor,
and native GUI tests. Test installation, upgrade, and login behavior on the
target distribution before publishing.

The package's visible `window-warp.desktop` matches the Wayland application
ID and uses the uniquely named `com.windowwarp.desktop` icon. The generated
legacy entry stays available but hidden from launchers to avoid duplicates.
