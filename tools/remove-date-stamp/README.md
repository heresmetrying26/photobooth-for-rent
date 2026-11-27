# Batch Date Stamp Remover (Offline Tool)

Removes the photobooth4u vintage orange corner date stamp (`'YY MM DD`) from already-taken solo photos in batch — completely offline, with zero installation.

## How to use

1. Double-click `index.html` to open it in **Chrome** or **Edge** (works offline; no internet or server needed).
2. Click **Choose Folder** (or drag and drop your event's `Solo Shots` folder onto the page).
3. Click **Clean All Photos**.
4. Click any photo on the left to inspect the **Corner Zoom** before/after split slider.
   - If a photo has any tricky edge or stray orange tint, switch to **Paint Mask +** / **Erase Mask −** and click **Re-Clean This Photo**.
5. Click **Save to Folder** (recommended for large batches — writes directly into a new empty folder you pick) or **Download ZIP**.

## Quality & Safety

- **Originals are never overwritten** — cleaned copies are always saved into a new folder or ZIP.
- **Full original resolution** is preserved (no resizing).
- **Only the tiny bottom-right corner mask** is reconstructed using multi-scale PatchMatch texture synthesis; every other pixel is kept intact.
- **EXIF, ICC color profile, and 300 DPI JFIF metadata** are preserved when exporting JPEGs.
- Photos without an orange corner stamp are detected automatically and passed through as untouched original file bytes.
