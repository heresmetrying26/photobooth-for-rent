"""
android/scripts/gen_icons.py
Generates Android mipmap launcher icons (ic_launcher.png + ic_launcher_round.png)
from a 1024×1024 source image.

Usage:
    python android/scripts/gen_icons.py <source.png|.jpg>

The script writes into android/app/src/main/res/mipmap-{mdpi,hdpi,xhdpi,xxhdpi,xxxhdpi}/.
It also produces the adaptive icon foreground/background layers for API 26+
in mipmap-anydpi-v26/.
"""
import sys, os
from pathlib import Path
from PIL import Image, ImageDraw

DENSITIES = {
    'mdpi':    48,
    'hdpi':    72,
    'xhdpi':   96,
    'xxhdpi':  144,
    'xxxhdpi': 192,
}

def circle_mask(size):
    mask = Image.new('L', (size, size), 0)
    draw = ImageDraw.Draw(mask)
    draw.ellipse((0, 0, size - 1, size - 1), fill=255)
    return mask

def main():
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parent.parent / 'resources' / 'icon_source.png'
    if not src.exists():
        print(f'Source not found: {src}', file=sys.stderr)
        sys.exit(1)

    res_dir = Path(__file__).parent.parent / 'app' / 'src' / 'main' / 'res'
    img = Image.open(src).convert('RGBA')

    for density, size in DENSITIES.items():
        out_dir = res_dir / f'mipmap-{density}'
        out_dir.mkdir(parents=True, exist_ok=True)

        # Square icon (with rounded corners baked in via the image itself)
        scaled = img.resize((size, size), Image.LANCZOS)
        scaled.save(out_dir / 'ic_launcher.png')

        # Round icon: crop to circle
        round_img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
        round_img.paste(scaled, mask=circle_mask(size))
        round_img.save(out_dir / 'ic_launcher_round.png')

        print(f'  {density}: {size}×{size}  ✓')

    # Adaptive icon XML resources (API 26+)
    anydpi_dir = res_dir / 'mipmap-anydpi-v26'
    anydpi_dir.mkdir(parents=True, exist_ok=True)

    adaptive_xml = '''<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background"/>
    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
</adaptive-icon>
'''
    (anydpi_dir / 'ic_launcher.xml').write_text(adaptive_xml)
    (anydpi_dir / 'ic_launcher_round.xml').write_text(adaptive_xml)
    print('  anydpi-v26 adaptive XML  ✓')

    # Foreground: the icon image itself, all density buckets
    for density, size in DENSITIES.items():
        out_dir = res_dir / f'mipmap-{density}'
        # Foreground is the full icon scaled slightly smaller to give safe-zone padding
        fg_size = int(size * 0.75)
        pad = (size - fg_size) // 2
        fg = img.resize((fg_size, fg_size), Image.LANCZOS)
        canvas = Image.new('RGBA', (size, size), (0, 0, 0, 0))
        canvas.paste(fg, (pad, pad))
        canvas.save(out_dir / 'ic_launcher_foreground.png')

    # Background color
    values_dir = res_dir / 'values'
    values_dir.mkdir(parents=True, exist_ok=True)
    colors_path = values_dir / 'colors.xml'
    colors_content = colors_path.read_text() if colors_path.exists() else '<resources></resources>'
    if 'ic_launcher_background' not in colors_content:
        colors_content = colors_content.replace(
            '</resources>',
            '    <color name="ic_launcher_background">#F5F1EA</color>\n</resources>'
        )
        colors_path.write_text(colors_content)
        print('  colors.xml: added ic_launcher_background  ✓')

    print('\nDone. All mipmap icons generated.')

if __name__ == '__main__':
    main()
