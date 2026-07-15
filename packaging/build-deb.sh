#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
VERSION=${PIXELRULLER_VERSION:-$(tr -d '[:space:]' < "$ROOT/VERSION")}
PKGROOT="$ROOT/packaging/build/pixelruller_${VERSION}_all"
OUT="$ROOT/dist/pixelruller_${VERSION}_all.deb"

rm -rf "$PKGROOT"
mkdir -p \
  "$PKGROOT/DEBIAN" \
  "$PKGROOT/opt/pixelruller" \
  "$PKGROOT/usr/bin" \
  "$PKGROOT/usr/share/applications" \
  "$PKGROOT/usr/share/icons/hicolor/scalable/apps" \
  "$PKGROOT/usr/share/doc/pixelruller" \
  "$ROOT/dist"

sed "s/@VERSION@/$VERSION/g" "$ROOT/packaging/control.in" > "$PKGROOT/DEBIAN/control"
install -m 0755 "$ROOT/packaging/pixelruller" "$PKGROOT/usr/bin/pixelruller"
install -m 0644 "$ROOT/packaging/pixelruller.desktop" "$PKGROOT/usr/share/applications/pixelruller.desktop"
install -m 0644 "$ROOT/Assets/SVGs/screen-svgrepo-com.svg" "$PKGROOT/usr/share/icons/hicolor/scalable/apps/pixelruller.svg"

install -m 0644 "$ROOT/server.py" "$PKGROOT/opt/pixelruller/server.py"
install -m 0644 "$ROOT/VERSION" "$PKGROOT/opt/pixelruller/VERSION"
cp -a "$ROOT/web" "$PKGROOT/opt/pixelruller/web"
cp -a "$ROOT/Assets" "$PKGROOT/opt/pixelruller/Assets"

install -m 0644 "$ROOT/README.md" "$PKGROOT/usr/share/doc/pixelruller/README.md"
install -m 0644 "$ROOT/AI_SKILL.md" "$PKGROOT/usr/share/doc/pixelruller/AI_SKILL.md"
install -m 0644 "$ROOT/CHANGELOG.md" "$PKGROOT/usr/share/doc/pixelruller/CHANGELOG.md"
install -m 0644 "$ROOT/LICENSE" "$PKGROOT/usr/share/doc/pixelruller/copyright"

find "$PKGROOT" -type d -exec chmod 0755 {} +
dpkg-deb --build --root-owner-group "$PKGROOT" "$OUT"
echo "$OUT"
