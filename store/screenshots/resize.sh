#!/bin/bash
DIR="/mnt/c/Users/michel/TabKebab/store/screenshots"
OUT="$DIR/store"
mkdir -p "$OUT"
BG="#f5f6fa"

compose() {
  local src="$1" label="$2" out="$3"
  convert \
    -size 1280x800 "xc:$BG" \
    \( "$src" -resize x760 -background none -flatten \) \
    -gravity center -composite \
    -gravity north -pointsize 28 -fill "#1e293b" -font "DejaVu-Sans-Bold" \
    -annotate +0+10 "$label" \
    -flatten -type TrueColor -alpha off \
    "$out"
  echo "  done: $(basename "$out")"
}

echo "Compositing screenshots to 1280x800..."
compose "$DIR/01-tabs-domains.png" "Tabs — Grouped by Domain"       "$OUT/01-tabs-domains.png"
compose "$DIR/04-stash.png"        "Stash — Save & Restore Later"   "$OUT/02-stash.png"
compose "$DIR/05-sessions.png"     "Sessions — Full Window Snapshots" "$OUT/03-sessions.png"
compose "$DIR/03-windows.png"      "Windows — Overview & Controls"  "$OUT/04-windows.png"
compose "$DIR/06-settings.png"     "Settings — Customize Everything" "$OUT/05-settings.png"

echo ""
echo "Verifying:"
for f in "$OUT"/*.png; do
  identify -format "  %f: %wx%h %m\n" "$f"
done
