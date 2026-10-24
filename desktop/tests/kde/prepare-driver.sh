#!/usr/bin/env bash
set -euo pipefail
cd "${1:?Usage: prepare-driver.sh TEST_DIRECTORY}"
mkdir -p driver
cd driver
apt-get download webkit2gtk-driver
for package in webkit2gtk-driver_*.deb; do
    dpkg-deb -x "$package" extracted
done
./extracted/usr/bin/WebKitWebDriver --help
