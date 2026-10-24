#!/usr/bin/env bash
set -euo pipefail
npm ci --no-audit --no-fund
npm test
cargo test --release --locked --manifest-path src-tauri/Cargo.toml -j 2
npm run build -- --no-bundle
npm exec tauri -- bundle --bundles deb
