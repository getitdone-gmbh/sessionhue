#!/bin/bash
# Builds the notifier app bundle: native/build.sh [--icloud] <output dir> (default: native/build)
# --icloud signs it with the iCloud container (Apple developer team, xcodegen), so it can relay to iPhone and Apple Watch.
set -euo pipefail
cd "$(dirname "$0")"
ICLOUD=""
[ "${1:-}" = "--icloud" ] && { ICLOUD=1; shift; }
OUT="${1:-build}"
APP="$OUT/sessionhue.app"
VERSION="$(node -p 'require("../package.json").version' 2>/dev/null || echo 0.0.0)"

if [ -n "$ICLOUD" ]; then
  xcodegen -q
  # An App Store Connect key lets xcodebuild create the profile without an Xcode login.
  AUTH=()
  if [ -n "${ASC_KEY_PATH:-}" ]; then
    AUTH=(-authenticationKeyPath "$ASC_KEY_PATH" -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID")
  fi
  xcodebuild -project sessionhue-notifier.xcodeproj -scheme sessionhue -configuration Release -derivedDataPath build/xcode \
    MARKETING_VERSION="$VERSION" -allowProvisioningUpdates ${AUTH[@]+"${AUTH[@]}"} -destination 'generic/platform=macOS' build -quiet
  rm -rf "$APP"
  mkdir -p "$OUT"
  cp -R build/xcode/Build/Products/Release/sessionhue.app "$APP"
  echo "$APP"
  exit 0
fi

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
# Universal binary, so one release build runs on Apple silicon and Intel Macs.
TMP="$(mktemp -d)"
for arch in arm64 x86_64; do
  swiftc -O -parse-as-library -target "$arch-apple-macos12" -o "$TMP/$arch" notify.swift
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
