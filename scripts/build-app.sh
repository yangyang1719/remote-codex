#!/bin/zsh
set -euo pipefail
cd "${0:A:h:h}"
python3 scripts/sync-prototype.py
zsh scripts/build-icon.sh
export CLANG_MODULE_CACHE_PATH="$PWD/.build/ModuleCache"
export SWIFTPM_MODULECACHE_OVERRIDE="$PWD/.build/ModuleCache"
swift build --disable-sandbox --cache-path .build/cache
mkdir -p build
stage=$(mktemp -d "$PWD/build/.remote-codex-build.XXXXXX")
staged_app="$stage/RemoteCodex.app"
mkdir -p "$staged_app/Contents/MacOS" "$staged_app/Contents/Resources"
cp .build/debug/RemoteCodex "$staged_app/Contents/MacOS/RemoteCodex"
cp -R .build/debug/RemoteCodex_RemoteCodex.bundle/Resources "$staged_app/Contents/Resources/"
cp packaging/Info.plist "$staged_app/Contents/Info.plist"
cp packaging/AppIcon.icns "$staged_app/Contents/Resources/AppIcon.icns"
codesign --force --deep --sign - "$staged_app"
codesign --verify --deep --strict "$staged_app"
# Keep mapped executable files intact for any still-running older window.
if [[ -d build/RemoteCodex.app ]]; then
  mv build/RemoteCodex.app "build/RemoteCodex-previous-$(date +%Y%m%d-%H%M%S)-$$.app"
fi
mv "$staged_app" build/RemoteCodex.app
rmdir "$stage"
python3 scripts/clean-build.py
print -r -- "$PWD/build/RemoteCodex.app"
