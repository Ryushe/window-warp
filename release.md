# Window Warp releases

- **Windows:** Build an MSIX package for the Microsoft Store.
- **Linux:** Build a Debian `.deb` package for official app releases.
- **Browser extensions:** Firefox Add-ons submission is prepared below. Chrome
  Web Store distribution is pending.

## Firefox Add-ons

The Firefox extension uses the existing ID `window-warp@ryushe.local` and its
own version in `desktop/browser-extension/firefox-manifest.json`. The Firefox
distribution is MIT-licensed; its license notice is
`desktop/browser-extension/FIREFOX-LICENSE`.

To enable automatic submission:

1. Create a Mozilla Add-ons developer account, accept any required agreements,
   and create an API key and secret on the [API credentials page](https://addons.mozilla.org/en-US/developers/addon/api/key/).
2. In the repository's [Actions secrets](https://github.com/Ryushe/window-warp/settings/secrets/actions),
   add `AMO_JWT_ISSUER` for the API key and `AMO_JWT_SECRET` for the secret.
   Do not put either value in the repository or a chat message.
3. Commit the workflow, extension files, `Privacy Policy.txt`, and these release
   instructions into the release tag. Publish a **stable** GitHub release.

`.github/workflows/firefox-addon.yml` checks out that release commit, runs the
JavaScript checks and tests, assembles the Firefox extension, runs Mozilla's
`web-ext lint`, and submits it to the **listed** Firefox Add-ons channel.
Pre-releases do not submit. The first listing uses the MIT license, the Tabs
category, and `firefox-amo-metadata.json`; its description links to the
approved privacy policy at the release commit. After submission, the workflow
adds that policy to the listing if none exists. Existing listing descriptions
and privacy policies are left alone. Update an existing policy on Mozilla
Add-ons when needed.

Mozilla may make a submitted listing available before any later review is
complete. Monitor the Actions run and Mozilla's developer dashboard for
validation or review results. No signing credentials or live submission are
needed to run the local tests and `web-ext lint`.

On later desktop releases, the workflow skips an already submitted listed
Firefox version only when the submitted source fingerprint matches. If the
same version has different or unverifiable source, or exists in another
distribution channel, it fails with instructions to increase the extension
version. Keep the fingerprint in the version's Mozilla reviewer notes. When
extension files change, increase the version in **both** browser manifests so
prepared development copies can update.

Once Mozilla has assigned the public add-on URL, set
`WINDOW_WARP_FIREFOX_ADDON_URL` to that exact URL when building the desktop app.
The regular Settings screen then opens the listing and offers a pairing code.
Without a listing URL, it keeps the temporary Firefox setup available instead.
Quit any running copy before launching with `--developer-extensions` to expose
the Firefox and Chromium development-install controls.

GitHub does not normally trigger a new release-event workflow for a release
created by another workflow using `GITHUB_TOKEN`. If release creation is
automated later, use a suitably scoped GitHub App or personal access token,
or invoke the Firefox submission in that release workflow. See [GitHub's event
documentation](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow).

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
currently covers updates to an existing, published free app. The initial app
submission, Partner Center package identity, and Store product ID must be set up
first. An update workflow can then build and validate the MSIX and use
`microsoft/microsoft-store-apppublisher` with the Microsoft Store CLI. It needs
a Partner Center-linked Microsoft Entra application with the appropriate role,
plus tenant ID, client ID, client secret, seller ID, and Store product ID.
Keep credentials in GitHub Actions secrets and restrict the workflow to stable
releases; verify certification and release state in Partner Center. No Microsoft
Store workflow is enabled until these account and package details are verified.

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

The package pins `kwin-common` to that SDK version; it is not a universal
Plasma package. See `tests/kde/README.md` for the SDK, isolated compositor,
and native GUI tests. Test installation, upgrade, and login behavior on the
target distribution before publishing.

The package's visible `window-warp.desktop` matches the Wayland application
ID and uses the uniquely named `com.windowwarp.desktop` icon. The generated
legacy entry stays available but hidden from launchers to avoid duplicates.
