"""Generate TabKebab PNG icons at all required sizes using Pillow."""

from PIL import Image, ImageDraw
import os

ICONS_DIR = os.path.dirname(os.path.abspath(__file__))
SIZES = [16, 32, 48, 128]

# We render at 512px then downscale for crisp anti-aliasing
RENDER_SIZE = 512


def draw_icon(size):
    """Draw the TabKebab icon at the given canvas size."""
    # Render at high res, then downscale
    img = Image.new('RGBA', (RENDER_SIZE, RENDER_SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    S = RENDER_SIZE  # shorthand

    # Background circle — blue
    margin = int(S * 0.0625)  # 8/128
    draw.ellipse(
        [margin, margin, S - margin, S - margin],
        fill=(37, 99, 235)  # #2563eb
    )

    # Skewer stick (vertical bar)
    stick_w = int(S * 0.0625)  # 8/128
    stick_x = (S - stick_w) // 2
    stick_top = int(S * 0.109)  # 14/128
    stick_bot = int(S * 0.891)  # 114/128
    draw.rounded_rectangle(
        [stick_x, stick_top, stick_x + stick_w, stick_bot],
        radius=stick_w // 2,
        fill=(248, 249, 250)  # #f8f9fa
    )

    # Pointed tip
    tip_top = int(S * 0.844)  # 108/128
    tip_bot = int(S * 0.953)  # 122/128
    cx = S // 2
    draw.polygon(
        [(cx - stick_w // 2, tip_top), (cx + stick_w // 2, tip_top), (cx, tip_bot)],
        fill=(248, 249, 250)
    )

    # Tab chunks — each is a rounded rectangle "threaded" on the skewer
    chunks = [
        # (y_center_ratio, w_ratio, h_ratio, main_color, tab_color)
        (0.234, 0.344, 0.156, (248, 113, 113), (252, 165, 165)),   # red    #f87171 / #fca5a5
        (0.422, 0.344, 0.156, (251, 191, 36),  (253, 230, 138)),   # amber  #fbbf24 / #fde68a
        (0.609, 0.344, 0.156, (52, 211, 153),  (110, 231, 183)),   # green  #34d399 / #6ee7b7
        (0.781, 0.281, 0.125, (167, 139, 250), (196, 181, 253)),   # purple #a78bfa / #c4b5fd
    ]

    for (yc, wr, hr, main_col, tab_col) in chunks:
        w = int(S * wr)
        h = int(S * hr)
        y = int(S * yc) - h // 2
        x = (S - w) // 2
        r = int(S * 0.039)  # ~5/128 corner radius

        # Main chunk body
        draw.rounded_rectangle([x, y, x + w, y + h], radius=r, fill=main_col)

        # Small "tab" notch at top-left
        tab_w = int(S * 0.109)
        tab_h = int(S * 0.047)
        tab_r = max(2, int(S * 0.016))
        draw.rounded_rectangle(
            [x + int(S * 0.031), y, x + int(S * 0.031) + tab_w, y + tab_h],
            radius=tab_r, fill=tab_col
        )

    # Skewer knob on top
    knob_cy = int(S * 0.109)
    knob_r_outer = int(S * 0.047)
    knob_r_inner = int(S * 0.023)
    draw.ellipse(
        [cx - knob_r_outer, knob_cy - knob_r_outer,
         cx + knob_r_outer, knob_cy + knob_r_outer],
        fill=(248, 249, 250)
    )
    draw.ellipse(
        [cx - knob_r_inner, knob_cy - knob_r_inner,
         cx + knob_r_inner, knob_cy + knob_r_inner],
        fill=(37, 99, 235)
    )

    # Downscale to target size with high-quality resampling
    return img.resize((size, size), Image.LANCZOS)


if __name__ == '__main__':
    for s in SIZES:
        icon = draw_icon(s)
        out_path = os.path.join(ICONS_DIR, f'icon{s}.png')
        icon.save(out_path, 'PNG')
        print(f'  Generated {out_path} ({s}x{s})')
    print('Done!')
