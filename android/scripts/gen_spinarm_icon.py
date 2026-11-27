"""
android/scripts/gen_spinarm_icon.py
Generates the standalone "360 Arm Cam" app icon (1024x1024 master PNG + iOS AppIcon.appiconset)
using the inverted photobooth4u brand palette:
  - Background: deep charcoal (#1C1A1E)
  - 360 orbit ring & badge: vermilion red (#C93D27)
  - Camera emblem & typography: warm cream (#F5F1EA)

Usage:
    python android/scripts/gen_spinarm_icon.py
"""
import json
import math
import os
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

# Exact photobooth4u palette
CHARCOAL = (0x1C, 0x1A, 0x1E)
CHARCOAL_LIGHT = (0x29, 0x26, 0x2C)
CHARCOAL_DARK = (0x15, 0x13, 0x17)
VERMILION = (0xC9, 0x3D, 0x27)
VERMILION_LIGHT = (0xDD, 0x4E, 0x36)
CREAM = (0xF5, 0xF1, 0xEA)
CREAM_SHADE = (0xDD, 0xD5, 0xC7)


def load_bold_font(size):
    candidates = [
        r'C:\Windows\Fonts\ARLRDBD.TTF',
        r'C:\Windows\Fonts\segoeuib.ttf',
        r'C:\Windows\Fonts\arialbd.ttf',
        '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
        '/System/Library/Fonts/Supplemental/Arial Rounded Bold.ttf',
    ]
    for path in candidates:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                pass
    return ImageFont.load_default()


def draw_thick_arc(draw, cx, cy, radius, thickness, start_deg, end_deg, color, steps=360, round_start=True, round_end=False):
    """Draws a smooth, anti-aliased thick circular arc using overlapping circles along the path."""
    r_dot = thickness / 2.0
    total = end_deg - start_deg
    n = max(60, int(abs(total) * steps / 360.0))
    for i in range(n + 1):
        deg = start_deg + total * (i / n)
        rad = math.radians(deg)
        x = cx + radius * math.cos(rad)
        y = cy + radius * math.sin(rad)
        draw.ellipse((x - r_dot, y - r_dot, x + r_dot, y + r_dot), fill=color)


def render_icon(size=1024):
    # 4x supersampling for crisp vector-grade edges
    S = size * 4
    img = Image.new('RGB', (S, S), CHARCOAL)
    draw = ImageDraw.Draw(img)

    # Subtle radial charcoal depth (stays solid #1C1A1E at edges for seamless adaptive icons)
    cx, cy = S * 0.5, S * 0.5
    max_r = S * 0.62
    for step in range(48, 0, -1):
        t = step / 48.0
        r = max_r * t
        blend = (1.0 - t) ** 1.8
        col = tuple(int(CHARCOAL[i] + (CHARCOAL_LIGHT[i] - CHARCOAL[i]) * blend) for i in range(3))
        draw.ellipse((cx - r, cy - r, cx + r, cy + r), fill=col)

    # Orbit ring center
    ocx = S * 0.50
    ocy = S * 0.49
    orbit_r = S * 0.375
    orbit_w = S * 0.044

    # Smooth subtle inner precision ring
    guide_r = S * 0.312
    guide_col = (0x34, 0x2F, 0x37)
    draw.ellipse(
        (ocx - guide_r, ocy - guide_r, ocx + guide_r, ocy + guide_r),
        outline=guide_col,
        width=int(S * 0.008),
    )

    # Bold vermilion 360-degree sweep arc (clockwise from 96 deg around to 334 deg,
    # leaving the bottom-right quadrant cleanly open for the "360" sibling badge!)
    arc_start = 96.0
    arc_end = 334.0
    draw_thick_arc(draw, ocx, ocy, orbit_r, orbit_w, arc_start, arc_end, VERMILION, steps=720)

    # Crisp geometric arrowhead tangent to the orbit ring at arc_end (no stray pin dot)
    tip_rad = math.radians(arc_end + 13.5)
    base_rad = math.radians(arc_end - 3.0)
    tip_x = ocx + orbit_r * math.cos(tip_rad)
    tip_y = ocy + orbit_r * math.sin(tip_rad)
    wing = orbit_w * 1.38
    out_x = ocx + (orbit_r + wing) * math.cos(base_rad)
    out_y = ocy + (orbit_r + wing) * math.sin(base_rad)
    in_x = ocx + (orbit_r - wing) * math.cos(base_rad)
    in_y = ocy + (orbit_r - wing) * math.sin(base_rad)
    draw.polygon([(tip_x, tip_y), (out_x, out_y), (in_x, in_y)], fill=VERMILION)

    # ---------- Warm cream camera silhouette (sibling of photobooth4u icon) ----------
    cam_cx = S * 0.485
    cam_cy = S * 0.505
    cam_w = S * 0.455
    cam_h = S * 0.310
    cam_x0 = cam_cx - cam_w / 2.0
    cam_y0 = cam_cy - cam_h / 2.0
    cam_x1 = cam_cx + cam_w / 2.0
    cam_y1 = cam_cy + cam_h / 2.0
    cam_rad = S * 0.064

    # Shutter release button (top left)
    sh_x0 = cam_x0 + cam_w * 0.13
    sh_x1 = sh_x0 + cam_w * 0.145
    sh_y0 = cam_y0 - cam_h * 0.115
    sh_y1 = cam_y0 + cam_h * 0.06
    draw.rounded_rectangle((sh_x0, sh_y0, sh_x1, sh_y1), radius=S * 0.018, fill=CREAM)

    # Top viewfinder hump (smooth rounded shoulders)
    hump_w_top = cam_w * 0.33
    hump_w_bot = cam_w * 0.46
    hump_h = cam_h * 0.185
    draw.polygon([
        (cam_cx - hump_w_bot / 2.0, cam_y0 + S * 0.012),
        (cam_cx - hump_w_top / 2.0 + S * 0.014, cam_y0 - hump_h + S * 0.008),
        (cam_cx + hump_w_top / 2.0 - S * 0.014, cam_y0 - hump_h + S * 0.008),
        (cam_cx + hump_w_bot / 2.0, cam_y0 + S * 0.012),
    ], fill=CREAM)
    draw.rounded_rectangle(
        (cam_cx - hump_w_top / 2.0, cam_y0 - hump_h, cam_cx + hump_w_top / 2.0, cam_y0 + S * 0.02),
        radius=S * 0.026,
        fill=CREAM,
    )

    # Camera body with subtle warm sand bottom depth (mirroring photobooth4u icon)
    draw.rounded_rectangle((cam_x0, cam_y0, cam_x1, cam_y1), radius=cam_rad, fill=CREAM_SHADE)
    draw.rounded_rectangle(
        (cam_x0, cam_y0, cam_x1, cam_y1 - S * 0.016),
        radius=cam_rad,
        fill=CREAM,
    )

    # Small flash bar (top-left of camera face) in charcoal
    fl_x0 = cam_x0 + cam_w * 0.105
    fl_y0 = cam_y0 + cam_h * 0.165
    fl_w = cam_w * 0.125
    fl_h = cam_h * 0.088
    draw.rounded_rectangle((fl_x0, fl_y0, fl_x0 + fl_w, fl_y0 + fl_h), radius=fl_h / 2.0, fill=CHARCOAL)

    # Vermilion REC indicator dot (top-right of camera face)
    rec_r = S * 0.021
    rec_cx = cam_x1 - cam_w * 0.14
    rec_cy = cam_y0 + cam_h * 0.21
    draw.ellipse((rec_cx - rec_r, rec_cy - rec_r, rec_cx + rec_r, rec_cy + rec_r), fill=VERMILION)

    # Center camera lens (concentric charcoal / cream / charcoal rings + specular crescent)
    lens_cx = cam_cx
    lens_cy = cam_cy + cam_h * 0.015
    r_outer = S * 0.118
    r_mid = S * 0.089
    r_inner = S * 0.067
    draw.ellipse((lens_cx - r_outer, lens_cy - r_outer, lens_cx + r_outer, lens_cy + r_outer), fill=CHARCOAL)
    draw.ellipse((lens_cx - r_mid, lens_cy - r_mid, lens_cx + r_mid, lens_cy + r_mid), fill=CREAM)
    draw.ellipse((lens_cx - r_inner, lens_cy - r_inner, lens_cx + r_inner, lens_cy + r_inner), fill=CHARCOAL)

    # Crisp specular highlight arc inside the lens (upper-left, matching photobooth4u icon!)
    spec_r = S * 0.043
    draw_thick_arc(draw, lens_cx, lens_cy, spec_r, S * 0.014, 196, 260, CREAM, steps=180)

    # ---------- Vermilion red "360" sibling badge (bottom-right, echoing photobooth4u's "4u" badge) ----------
    badge_w = S * 0.335
    badge_h = S * 0.205
    badge_x1 = S * 0.875
    badge_y1 = S * 0.845
    badge_x0 = badge_x1 - badge_w
    badge_y0 = badge_y1 - badge_h
    badge_r = S * 0.060

    # Charcoal cutout halo around the badge so it floats crisply over camera & orbit ring
    halo = S * 0.024
    draw.rounded_rectangle(
        (badge_x0 - halo, badge_y0 - halo, badge_x1 + halo, badge_y1 + halo),
        radius=badge_r + halo * 0.72,
        fill=CHARCOAL,
    )
    draw.rounded_rectangle(
        (badge_x0, badge_y0, badge_x1, badge_y1),
        radius=badge_r,
        fill=VERMILION,
    )

    # Bold "360" label generously filling the vermilion badge
    font = load_bold_font(int(S * 0.132))
    text = "360"
    bbox = draw.textbbox((0, 0), text, font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    tx = (badge_x0 + badge_x1 - tw) / 2.0 - bbox[0]
    ty = (badge_y0 + badge_y1 - th) / 2.0 - bbox[1] - S * 0.004
    draw.text((tx, ty), text, fill=CREAM, font=font)

    # Downsample with Lanczos for ultra-smooth anti-aliasing
    return img.resize((size, size), Image.LANCZOS)


def write_ios_asset_catalog(master_img, ios_assets_dir):
    appicon_dir = ios_assets_dir / 'AppIcon.appiconset'
    appicon_dir.mkdir(parents=True, exist_ok=True)

    # Root Assets.xcassets Contents.json
    (ios_assets_dir / 'Contents.json').write_text(
        json.dumps({"info": {"author": "xcode", "version": 1}}, indent=2) + '\n',
        encoding='utf-8',
    )

    # Generate all classic iPhone/iPad + modern universal 1024x1024 slots so iOS 15..18+ and Sideloadly render cleanly
    specs = [
        ("icon-40.png", 40, "iphone", "20x20", "2x"),
        ("icon-60.png", 60, "iphone", "20x20", "3x"),
        ("icon-58.png", 58, "iphone", "29x29", "2x"),
        ("icon-87.png", 87, "iphone", "29x29", "3x"),
        ("icon-80.png", 80, "iphone", "40x40", "2x"),
        ("icon-120-s.png", 120, "iphone", "40x40", "3x"),
        ("icon-120.png", 120, "iphone", "60x60", "2x"),
        ("icon-180.png", 180, "iphone", "60x60", "3x"),
        ("icon-20.png", 20, "ipad", "20x20", "1x"),
        ("icon-40-ipad.png", 40, "ipad", "20x20", "2x"),
        ("icon-29.png", 29, "ipad", "29x29", "1x"),
        ("icon-58-ipad.png", 58, "ipad", "29x29", "2x"),
        ("icon-40-s.png", 40, "ipad", "40x40", "1x"),
        ("icon-80-ipad.png", 80, "ipad", "40x40", "2x"),
        ("icon-76.png", 76, "ipad", "76x76", "1x"),
        ("icon-152.png", 152, "ipad", "76x76", "2x"),
        ("icon-167.png", 167, "ipad", "83.5x83.5", "2x"),
        ("icon-1024.png", 1024, "ios-marketing", "1024x1024", "1x"),
    ]
    images_json = []
    for fname, px, idiom, pt_size, scale in specs:
        resized = master_img if px == master_img.width else master_img.resize((px, px), Image.LANCZOS)
        # Ensure strictly opaque RGB PNG (Apple forbids alpha channel in AppIcon)
        resized.convert('RGB').save(appicon_dir / fname, format='PNG', optimize=True)
        images_json.append({
            "filename": fname,
            "idiom": idiom,
            "scale": scale,
            "size": pt_size,
        })

    contents = {
        "images": images_json,
        "info": {"author": "xcode", "version": 1},
    }
    (appicon_dir / 'Contents.json').write_text(json.dumps(contents, indent=2) + '\n', encoding='utf-8')
    print(f'Wrote iOS AppIcon catalog ({len(specs)} PNGs) -> {appicon_dir}')


def main():
    repo_root = Path(__file__).resolve().parent.parent.parent
    master = render_icon(1024)

    android_out = repo_root / 'android' / 'resources' / 'spinarm_icon_source.png'
    android_out.parent.mkdir(parents=True, exist_ok=True)
    master.convert('RGB').save(android_out, format='PNG', optimize=True)
    print(f'Wrote master icon (1024x1024) -> {android_out}')

    ios_assets = repo_root / 'ios' / 'spinarm' / 'Assets.xcassets'
    write_ios_asset_catalog(master, ios_assets)


if __name__ == '__main__':
    main()
