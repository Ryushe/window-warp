#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in
    "") bundle_only=0 ;;
    --bundle-only) bundle_only=1 ;;
    --help) printf '%s\n' 'Usage: tests/kde/build.sh [--bundle-only]' 'Requires WARP_COMPANION_STAGE and WARP_KWIN_PACKAGE_VERSION.' '--bundle-only packages the existing, already validated release executable.'; exit 0 ;;
    *) printf '%s\n' 'Usage: tests/kde/build.sh [--bundle-only]' >&2; exit 2 ;;
esac
(( $# <= 1 )) || exit 2
# The native KWin API is versioned. Package a module built against the target
# distribution's exact KWin SDK, rather than publishing a gesture-less bundle.
: "${WARP_COMPANION_STAGE:?Set WARP_COMPANION_STAGE to the companion CMake DESTDIR}"
: "${WARP_KWIN_PACKAGE_VERSION:?Set WARP_KWIN_PACKAGE_VERSION to the SDK kwin-common Debian version}"
bundle_config="$(mktemp --suffix=.json)"
trap 'rm -f -- "$bundle_config"' EXIT
python3 - "$bundle_config" <<'PY'
import json
import os
from pathlib import Path
import subprocess
import sys

stage = Path(os.environ["WARP_COMPANION_STAGE"]).resolve(strict=True)
version = os.environ["WARP_KWIN_PACKAGE_VERSION"]
subprocess.run(["dpkg", "--validate-version", version], check=True)
modules = list(stage.glob("usr/lib/**/kwin/plugins/windowwarp_companion.so"))
if len(modules) != 1 or not modules[0].is_file():
    raise SystemExit("Companion staging must contain exactly one installed windowwarp_companion.so")
files = {"/" + p.relative_to(stage).as_posix(): str(p)
         for p in sorted(stage.rglob("*")) if p.is_file()}
config = {"bundle": {"linux": {"deb": {
    "depends": ["qdbus-qt6 | qdbus-qt5 | qdbus", f"kwin-common (= {version})"],
    "files": files,
}}}}
Path(sys.argv[1]).write_text(json.dumps(config))
PY
if (( ! bundle_only )); then
    npm ci --no-audit --no-fund
    npm test
    cargo test --release --locked --manifest-path src-tauri/Cargo.toml -j 2
    npm run build -- --no-bundle
fi
npm exec tauri -- bundle --bundles deb --config "$bundle_config"
