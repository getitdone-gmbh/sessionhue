#!/bin/bash
# Builds the release assets into ./release:
#   sessionhue-<version>.tgz  versioned npm package
#   sessionhue.tgz            same package, stable name for releases/latest/download
#   install.sh                one-line installer
#   Install-sessionhue.zip    double-click installer ("Install sessionhue.command")
set -euo pipefail
cd "$(dirname "$0")/.."

rm -rf release && mkdir -p release/command
npm run build >/dev/null
npm test >/dev/null
npm pack --pack-destination release >/dev/null
cp release/sessionhue-*.tgz release/sessionhue.tgz
cp install.sh release/install.sh

cat > "release/command/Install sessionhue.command" <<'CMD'
#!/bin/bash
# Double-click installer for sessionhue (terminal session colors).
/bin/bash -c "$(curl -fsSL https://github.com/getitdone-gmbh/sessionhue/releases/latest/download/install.sh)"
echo
read -r -p "Press Enter to close this window. "
CMD
chmod +x "release/command/Install sessionhue.command"
# ditto keeps the executable bit, so the file can be double-clicked after unzipping.
(cd release/command && ditto -c -k --sequesterRsrc "Install sessionhue.command" ../Install-sessionhue.zip)
rm -rf release/command
ls -1 release
