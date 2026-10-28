#!/bin/zsh
set -euo pipefail
cd "${0:A:h:h}"
mkdir -p build
icon_stage=$(mktemp -d "$PWD/build/.app-icon.XXXXXX")
trap 'rm -rf "$icon_stage"' EXIT
iconset="$icon_stage/AppIcon.iconset"
mkdir -p "$iconset"
for size in 16 32 128 256 512; do
  for scale in 1 2; do
    suffix=""
    if (( scale == 2 )); then suffix="@2x"; fi
    pixels=$((size * scale))
    /usr/bin/sips -s format png --resampleHeightWidth "$pixels" "$pixels" \
      packaging/AppIcon.png --out "$iconset/icon_${size}x${size}${suffix}.png" >/dev/null
  done
done
/usr/bin/iconutil --convert icns "$iconset" --output packaging/AppIcon.icns
