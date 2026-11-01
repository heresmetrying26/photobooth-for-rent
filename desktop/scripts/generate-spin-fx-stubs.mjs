// Creates lightweight stub assets for all 40 catalog items in desktop/resources/spin-fx/
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'spin-fx');
const cat = JSON.parse(readFileSync(join(DIR, 'catalog.json'), 'utf8'));

// Minimal 1x1 WebP (38 bytes)
const WEBP_1X1 = Buffer.from('UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAgA0JaQAA3AA/vv9UAA=', 'base64');

// Minimal MP4 ftyp header (32 bytes)
const MP4_STUB = Buffer.from([
  0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, // size 32, 'ftyp'
  0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00, // major 'isom', minor 512
  0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32, // 'isom', 'iso2'
  0x61, 0x76, 0x63, 0x31, 0x6d, 0x70, 0x34, 0x31  // 'avc1', 'mp41'
]);

// Minimal WebM EBML header (32 bytes)
const WEBM_STUB = Buffer.from([
  0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, // EBML ID
  0x01, 0x42, 0xf7, 0x81, 0x01, 0x42, 0xf2, 0x81,
  0x04, 0x42, 0xf3, 0x81, 0x08, 0x42, 0x82, 0x84,
  0x77, 0x65, 0x62, 0x6d, 0x42, 0x87, 0x81, 0x02
]);

let createdLoops = 0, createdThumbs = 0;

for (const item of cat) {
  const loopPath = join(DIR, 'loops', item.file);
  const thumbPath = join(DIR, 'thumbs', item.thumb);

  if (!existsSync(loopPath)) {
    writeFileSync(loopPath, item.file.endsWith('.webm') ? WEBM_STUB : MP4_STUB);
    createdLoops++;
  }

  if (!existsSync(thumbPath)) {
    writeFileSync(thumbPath, WEBP_1X1);
    createdThumbs++;
  }
}

console.log(`[spin-fx] Generated ${createdLoops} loop files and ${createdThumbs} thumb files.`);
console.log(`[spin-fx] All ${cat.length} catalog effects now exist in desktop/resources/spin-fx/`);

