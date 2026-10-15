#!/bin/bash
# Builds the notifier app bundle: native/build.sh <output dir> (default: native/build)
set -euo pipefail
cd "$(dirname "$0")"
OUT="${1:-build}"
APP="$OUT/sessionhue.app"
VERSION="$(node -p 'require("../package.json").version' 2>/dev/null || echo 0.0.0)"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
# Universal binary, so one release build runs on Apple silicon and Intel Macs.
TMP="$(mktemp -d)"
for arch in arm64 x86_64; do
  swiftc -O -target "$arch-apple-macos12" -o "$TMP/$arch" notify.swift
done
lipo -create -output "$APP/Contents/MacOS/sessionhue" "$TMP/arm64" "$TMP/x86_64"
rm -rf "$TMP"
[ -f icon.icns ] && cp icon.icns "$APP/Contents/Resources/icon.icns"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>com.getitdone.sessionhue</string>
  <key>CFBundleName</key><string>sessionhue</string>
  <key>CFBundleDisplayName</key><string>sessionhue</string>
  <key>CFBundleExecutable</key><string>sessionhue</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>LSUIElement</key><true/>
  <key>NSUserNotificationAlertStyle</key><string>alert</string>
  <key>NSAppleEventsUsageDescription</key><string>sessionhue types your answer from a notification into the terminal session it belongs to.</string>
</dict>
</plist>
PLIST

# A real signing identity keeps notification and automation permissions across rebuilds; ad-hoc works too.
IDENTITY="${SESSIONHUE_SIGN_IDENTITY:-$(security find-identity -v -p codesigning 2>/dev/null | awk -F'"' '/Apple Development|Developer ID Application/ {print $2; exit}')}"
codesign --force --options runtime --entitlements entitlements.plist -s "${IDENTITY:--}" "$APP" >/dev/null
echo "$APP"
