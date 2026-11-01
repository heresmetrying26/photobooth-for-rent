# 360 Animated Video Overlays & Particle Effects (spin-fx)

This directory contains the curated library of **40 animated video overlay loops** for the 360 photo booth desk.

## Directory Structure

* `catalog.json`: Manifest of all 40 effects with category, display title, blend mode, and default opacity.
* `loops/`: 1080×1920 (9:16 vertical) seamless 3–5 second looping video files.
  * `.mp4` (H.264): Used with `blend: "screen"` on pure `#000000` black backgrounds (sparks, light leaks, bokeh, fire, laser beams).
  * `.webm` (VP9 `yuva420p`): Used with `blend: "overlay"` with pre-keyed alpha transparency (confetti, petals, balloons, money).
* `thumbs/`: 150×266 animated WebP or WebM thumbnails for the visual picker in the 360 Desk.

## Adding Custom Loops

Operators can add their own custom animations:
1. Render a seamless 3–5s loop at **1080×1920** (24, 30, or 60 fps).
2. Save to `desktop/resources/spin-fx/loops/<filename>.mp4` (or `.webm`).
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

