#!/bin/bash
OUT="/mnt/c/Users/michel/TabKebab/store/screenshots/store"
ICON="/mnt/c/Users/michel/TabKebab/icons/icon128.png"
BG="#f5f6fa"
TITLE_COLOR="#1e293b"
SUB_COLOR="#64748b"
ACCENT="#3b82f6"

# ─── Small promo tile 440x280 ───
echo "Creating small promo tile (440x280)..."
convert -size 440x280 "xc:$BG" \
  \( "$ICON" -resize 80x80 \) -gravity center -geometry +0-40 -composite \
  -gravity center -pointsize 30 -fill "$TITLE_COLOR" -font "DejaVu-Sans-Bold" \
  -annotate +0+30 "TabKebab" \
  -gravity center -pointsize 14 -fill "$SUB_COLOR" -font "DejaVu-Sans" \
  -annotate +0+60 "Stack and organize your browser tabs" \
  -flatten -type TrueColor -alpha off \
  "$OUT/small-promo-440x280.png"
echo "  done: small-promo-440x280.png"

# ─── Marquee promo tile 1400x560 ───
echo "Creating marquee promo tile (1400x560)..."
convert -size 1400x560 "xc:$BG" \
  \( "$ICON" -resize 120x120 \) -gravity west -geometry +120+0 -composite \
  -gravity west -pointsize 52 -fill "$TITLE_COLOR" -font "DejaVu-Sans-Bold" \
  -annotate +270-30 "TabKebab" \
  -gravity west -pointsize 22 -fill "$SUB_COLOR" -font "DejaVu-Sans" \
  -annotate +270+30 "Stack and organize your browser tabs like a kebab skewer." \
  -gravity west -pointsize 16 -fill "$ACCENT" -font "DejaVu-Sans" \
  -annotate +270+65 "Group by domain or AI  ·  Sessions  ·  Stash  ·  Tab Sleep  ·  Zero telemetry" \
  -flatten -type TrueColor -alpha off \
  "$OUT/marquee-promo-1400x560.png"
echo "  done: marquee-promo-1400x560.png"

echo ""
echo "Verifying:"
identify -format "  %f: %wx%h %m\n" "$OUT/small-promo-440x280.png" "$OUT/marquee-promo-1400x560.png"
