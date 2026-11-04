# 360 Animated Video Overlays & Particle Effects (spin-fx)

This directory contains the curated library of **40 animated video overlay loops** for the 360 photo booth desk.

## Directory Structure

* `catalog.json`: Manifest of all 40 effects with category, display title, blend mode, and default opacity.
* `loops/`: 1080×1920 (9:16 vertical) seamless 3-second looping video files (30 fps).
  * `.mp4` (H.264): Used with `blend: "screen"` on pure `#000000` black backgrounds (sparks, light leaks, bokeh, fire, laser beams).
  * `.webm` (VP9 `yuva420p`): Used with `blend: "overlay"` with pre-keyed alpha channel transparency (confetti, petals, balloons, money).
* `loops/landscape/`: 1920×1080 (16:9 horizontal) native landscape variants of all 40 loops for landscape and widescreen video compositions.
* `thumbs/`: 150×266 animated WebP thumbnails for the visual picker in the 360 Desk.

## Blend Modes & Composition

1. **Screen Blend (`blend: "screen"`)**:
   - Files: `.mp4` (H.264, `yuv420p`).
   - Pure black pixels (`#000000`) become transparent when blended.
   - Ideal for emissive, glowing, or lighting effects (laser beams, golden glitter, fire embers, light leaks, lens flares, electric arcs).
   - In FFmpeg: `[base][fx]blend=all_mode='screen':all_opacity=0.85`.

2. **Alpha Channel Overlay (`blend: "overlay"`)**:
   - Files: `.webm` (VP9, `yuva420p` alpha pixel format).
   - Opaque physical particles with fully transparent backgrounds.
   - Ideal for physical objects that need full color saturation without blending into the background (multi-color confetti, rose petals, balloons, dollar bills).
   - In FFmpeg: `[base][fx]overlay=0:0:format=auto`.

3. **Aspect Ratio & Square (1:1) Fitting**:
   - When rendering square (1:1) or custom aspect videos, the engine automatically pads and centers the overlay loop (`scale=W:H:force_original_aspect_ratio=decrease,pad=W:H:(ow-iw)/2:(oh-ih)/2:color=black@0`) without stretching or distortion.

## Procedural Generator CLI (`generate-spin-fx-loops.mjs`)

The effects are generated 100% locally with zero external API or AI dependencies using procedural algorithms in Node.js and FFmpeg.

```bash
node desktop/scripts/generate-spin-fx-loops.mjs [options]
```

### CLI Options:
* `--1080p`: (Default) Generates 1080×1920 portrait loops at 30 fps (3 seconds duration, seamless loop).
* `--landscape`: Generates native 1920×1080 landscape loops into `desktop/resources/spin-fx/loops/landscape/`.
* `--sd` or `--540p`: Generates compact 540×960 (or 960×540) loops at 25 fps.
* `--only=<id>`: Generates only a single effect by catalog ID (e.g. `--only=confetti_gold`).
* `--3s`: Forces a 3-second loop duration.

### Examples:
```bash
# Regenerate all 40 portrait 1080p loops
node desktop/scripts/generate-spin-fx-loops.mjs --1080p

# Generate all 40 native landscape 1080p loops
node desktop/scripts/generate-spin-fx-loops.mjs --landscape --1080p

# Regenerate only the golden confetti loop in 1080p
node desktop/scripts/generate-spin-fx-loops.mjs --only=confetti_gold --1080p
```

## Adding Custom Loops

Operators can add their own custom animations:
1. Render a seamless 3–5s loop at **1080×1920** for portrait or **1920×1080** for landscape (30 or 60 fps).
2. Save to `desktop/resources/spin-fx/loops/<filename>.mp4` (or `.webm` with `yuva420p` alpha). For landscape, save to `loops/landscape/<filename>.mp4`.
3. Add a corresponding entry in `catalog.json`:
   ```json
   {
     "id": "my_custom_fx",
     "name": "My Custom FX",
     "category": "VIP & Luxury",
     "description": "Custom animated effect",
     "file": "my_custom_fx.mp4",
     "thumb": "my_custom_fx.webp",
     "blend": "screen",
     "opacity": 0.9
   }
   ```
4. Re-run `npm run prepare-app` (or restart the desktop app).
