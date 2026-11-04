import fs from 'node:fs';
import path from 'node:path';

const docsImgDir = path.resolve('docs/keychain-guide/img');
const publicImgDir = path.resolve('public/keychain-guide/img');

fs.mkdirSync(docsImgDir, { recursive: true });
fs.mkdirSync(publicImgDir, { recursive: true });

// 1. Mockup: Step 3 Layout Selection
const svg1 = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 540 280" width="100%" height="100%" style="background:#FAF7F2;border-radius:12px;font-family:'Manrope',system-ui,sans-serif;">
  <!-- Card Background -->
  <rect x="0" y="0" width="540" height="280" rx="12" fill="#FAF7F2" stroke="#E4DCCF" stroke-width="1"/>
  
  <!-- Step Header -->
  <rect x="18" y="16" width="504" height="42" rx="8" fill="#FFFFFF" stroke="#E4DCCF" stroke-width="1"/>
  <circle cx="40" cy="37" r="12" fill="#C93D27"/>
  <text x="40" y="41" fill="#FFFFFF" font-size="12" font-weight="800" text-anchor="middle">3</text>
  <text x="62" y="41" fill="#1C1A1E" font-size="14" font-weight="800">Step 3: Choose Layout &amp; Design</text>
  <text x="502" y="41" fill="#6B666C" font-size="11" font-weight="700" text-anchor="end">Setup Mode</text>

  <!-- Layout Cards Grid -->
  <!-- Card 1: Classic Strip -->
  <g transform="translate(24, 76)">
    <rect width="150" height="184" rx="10" fill="#FFFFFF" stroke="#E4DCCF" stroke-width="1.5"/>
    <rect x="52" y="14" width="46" height="120" rx="4" fill="#F0E8DD" stroke="#D5CBBF" stroke-width="1"/>
    <!-- Strip miniature photos -->
    <rect x="56" y="22" width="38" height="28" rx="2" fill="#8CB89F"/>
    <rect x="56" y="54" width="38" height="28" rx="2" fill="#B88C9F"/>
    <rect x="56" y="86" width="38" height="28" rx="2" fill="#8C9FB8"/>
    <text x="75" y="152" fill="#1C1A1E" font-size="12" font-weight="700" text-anchor="middle">Classic Strip</text>
    <text x="75" y="168" fill="#6B666C" font-size="10" text-anchor="middle">2×6 in · 3 shots</text>
  </g>

  <!-- Card 2: My Frame (Keychain) -->
  <g transform="translate(195, 76)">
    <rect width="150" height="184" rx="10" fill="#FFFFFF" stroke="#E4DCCF" stroke-width="1.5"/>
    <rect x="50" y="12" width="50" height="124" rx="4" fill="#FDFBF7" stroke="#D4AF37" stroke-width="1.5"/>
    <!-- Photo Cutouts -->
    <rect x="55" y="24" width="40" height="28" rx="2" fill="#E6F4EF" stroke="#1B7358" stroke-width="1"/>
    <text x="75" y="42" fill="#1B7358" font-size="8" font-weight="800" text-anchor="middle">CUTOUT</text>
    <rect x="55" y="56" width="40" height="28" rx="2" fill="#E6F4EF" stroke="#1B7358" stroke-width="1"/>
    <text x="75" y="74" fill="#1B7358" font-size="8" font-weight="800" text-anchor="middle">CUTOUT</text>
    <rect x="55" y="88" width="40" height="28" rx="2" fill="#E6F4EF" stroke="#1B7358" stroke-width="1"/>
    <text x="75" y="106" fill="#1B7358" font-size="8" font-weight="800" text-anchor="middle">CUTOUT</text>
    <text x="75" y="152" fill="#1C1A1E" font-size="12" font-weight="700" text-anchor="middle">My Frame</text>
    <rect x="18" y="160" width="114" height="16" rx="4" fill="#E6F4EF"/>
    <text x="75" y="172" fill="#1B7358" font-size="8.5" font-weight="800" text-anchor="middle">fits 2.5×7.5 keychain ✓</text>
  </g>

  <!-- Card 3: Frame Collage (SELECTED / ACTIVE) -->
  <g transform="translate(366, 76)">
    <rect width="150" height="184" rx="10" fill="#FFFFFF" stroke="#C93D27" stroke-width="2.5"/>
    <!-- Selected Badge -->
    <rect x="36" y="-8" width="78" height="18" rx="9" fill="#C93D27"/>
    <text x="75" y="5" fill="#FFFFFF" font-size="9" font-weight="800" text-anchor="middle">SELECTED ✓</text>
    
    <!-- Mini Imposition Sheet -->
    <rect x="25" y="18" width="100" height="114" rx="4" fill="#FAF7F2" stroke="#D5CBBF" stroke-width="1"/>
    <!-- 3 Mini strips side by side -->
    <rect x="31" y="24" width="26" height="98" rx="2" fill="#FFFFFF" stroke="#C93D27" stroke-width="1"/>
    <rect x="62" y="24" width="26" height="98" rx="2" fill="#FFFFFF" stroke="#C93D27" stroke-width="1"/>
    <rect x="93" y="24" width="26" height="98" rx="2" fill="#FFFFFF" stroke="#C93D27" stroke-width="1"/>
    
    <text x="75" y="150" fill="#C93D27" font-size="12" font-weight="800" text-anchor="middle">Frame Collage</text>
    <text x="75" y="168" fill="#6B666C" font-size="9.5" font-weight="600" text-anchor="middle">Multi-Keychain Sheet</text>
  </g>
</svg>`;

// 2. Mockup: Frames on this sheet controls
const svg2 = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 540 320" width="100%" height="100%" style="background:#FAF7F2;border-radius:12px;font-family:'Manrope',system-ui,sans-serif;">
  <rect x="0" y="0" width="540" height="320" rx="12" fill="#FAF7F2" stroke="#E4DCCF" stroke-width="1"/>
  
  <g transform="translate(20, 16)">
    <text x="0" y="16" fill="#1C1A1E" font-size="14" font-weight="800">Frames on this sheet</text>
    <text x="0" y="32" fill="#6B666C" font-size="11">Select your frame and arrange copies across the paper.</text>

    <!-- Selected Frame Tile -->
    <g transform="translate(0, 44)">
      <rect width="180" height="54" rx="8" fill="#FFFFFF" stroke="#C93D27" stroke-width="2"/>
      <rect x="10" y="8" width="16" height="38" rx="2" fill="#FDFBF7" stroke="#D4AF37" stroke-width="1"/>
      <text x="34" y="26" fill="#1C1A1E" font-size="11" font-weight="800">Keychain 2.5×7.5</text>
      <text x="34" y="40" fill="#1B7358" font-size="9.5" font-weight="700">✓ On Sheet (×3)</text>
      <circle cx="162" cy="27" r="9" fill="#1B7358"/>
      <text x="162" y="31" fill="#FFFFFF" font-size="10" font-weight="800" text-anchor="middle">✓</text>
    </g>

    <!-- Upload More Button -->
    <g transform="translate(192, 44)">
      <rect width="130" height="54" rx="8" fill="#FAF7F2" stroke="#D5CBBF" stroke-dasharray="4,3" stroke-width="1.5"/>
      <text x="65" y="25" fill="#6B666C" font-size="16" font-weight="800" text-anchor="middle">+</text>
      <text x="65" y="41" fill="#6B666C" font-size="10.5" font-weight="700" text-anchor="middle">Upload more</text>
    </g>

    <!-- Sheet Size Row -->
    <g transform="translate(0, 116)">
      <text x="0" y="14" fill="#1C1A1E" font-size="12" font-weight="800">Sheet size</text>
      <g transform="translate(0, 22)">
        <rect width="240" height="36" rx="6" fill="#FFFFFF" stroke="#C93D27" stroke-width="1.5"/>
        <text x="14" y="23" fill="#1C1A1E" font-size="12" font-weight="700">A4 Paper (210 × 297 mm)</text>
        <path d="M 215 15 L 222 23 L 229 15" fill="none" stroke="#6B666C" stroke-width="2"/>
      </g>
      <text x="254" y="44" fill="#6B666C" font-size="11">← Pick A4, Letter, or 8R for 2.5×7.5"</text>
    </g>

    <!-- Patterns Row -->
    <g transform="translate(0, 192)">
      <text x="0" y="14" fill="#1C1A1E" font-size="12" font-weight="800">Arrange them on the sheet</text>
      
      <!-- Pattern 1: 2 side by side -->
      <g transform="translate(0, 24)">
        <rect width="84" height="60" rx="6" fill="#FFFFFF" stroke="#E4DCCF" stroke-width="1"/>
        <rect x="18" y="8" width="20" height="44" rx="1" fill="#1C1A1E"/>
        <rect x="44" y="8" width="20" height="44" rx="1" fill="#1C1A1E"/>
        <text x="42" y="74" fill="#6B666C" font-size="9" text-anchor="middle">2 side by side</text>
      </g>

      <!-- Pattern 2: 3 strips (ACTIVE) -->
      <g transform="translate(96, 24)">
        <rect width="84" height="60" rx="6" fill="#FFFFFF" stroke="#C93D27" stroke-width="2"/>
        <rect x="12" y="8" width="16" height="44" rx="1" fill="#C93D27"/>
        <rect x="34" y="8" width="16" height="44" rx="1" fill="#C93D27"/>
        <rect x="56" y="8" width="16" height="44" rx="1" fill="#C93D27"/>
        <text x="42" y="74" fill="#C93D27" font-size="9.5" font-weight="800" text-anchor="middle">3 strips ✓</text>
      </g>

      <!-- Pattern 3: 4 strips -->
      <g transform="translate(192, 24)">
        <rect width="84" height="60" rx="6" fill="#FFFFFF" stroke="#E4DCCF" stroke-width="1"/>
        <rect x="10" y="8" width="12" height="44" rx="1" fill="#1C1A1E"/>
        <rect x="27" y="8" width="12" height="44" rx="1" fill="#1C1A1E"/>
        <rect x="44" y="8" width="12" height="44" rx="1" fill="#1C1A1E"/>
        <rect x="61" y="8" width="12" height="44" rx="1" fill="#1C1A1E"/>
        <text x="42" y="74" fill="#6B666C" font-size="9" text-anchor="middle">4 strips</text>
      </g>

      <!-- Action Button: Add a copy -->
      <g transform="translate(290, 24)">
        <rect width="110" height="34" rx="6" fill="#FFFFFF" stroke="#C93D27" stroke-width="1.5"/>
        <text x="55" y="21" fill="#C93D27" font-size="11" font-weight="800" text-anchor="middle">+ Add a copy</text>
        
        <rect y="40" width="110" height="34" rx="6" fill="#C93D27"/>
        <text x="55" y="61" fill="#FFFFFF" font-size="11" font-weight="800" text-anchor="middle">👁 Open preview</text>
      </g>
    </g>
  </g>
</svg>`;

// 3. Mockup: Live Sheet Imposition Preview
const svg3 = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 540 360" width="100%" height="100%" style="background:#FAF7F2;border-radius:12px;font-family:'Manrope',system-ui,sans-serif;">
  <rect x="0" y="0" width="540" height="360" rx="12" fill="#FAF7F2" stroke="#E4DCCF" stroke-width="1"/>
  
  <!-- Sheet Container (Represents A4 Paper) -->
  <g transform="translate(45, 16)">
    <!-- A4 Paper Sheet -->
    <rect width="450" height="328" rx="8" fill="#FFFFFF" stroke="#D5CBBF" stroke-width="1.5" filter="drop-shadow(0 4px 12px rgba(0,0,0,0.06))"/>
    
    <!-- Paper Banner -->
    <text x="225" y="22" fill="#6B666C" font-size="10" font-weight="800" text-anchor="middle" letter-spacing="1">A4 SHEET (210 × 297 MM) · 100% ACTUAL PRINT SCALE</text>
    <line x1="20" y1="30" x2="430" y2="30" stroke="#F0E8DD" stroke-width="1"/>

    <!-- 3 Upright Strips (Each 2.5 x 7.5 in equivalent) -->
    <!-- Strip 1 -->
    <g transform="translate(36, 42)">
      <!-- Cut Line -->
      <rect width="116" height="266" rx="4" fill="#FDFBF7" stroke="#B5B5B5" stroke-dasharray="4,3" stroke-width="1.5"/>
      <text x="58" y="22" fill="#C93D27" font-size="8.5" font-weight="800" text-anchor="middle">LUCAS &amp; EMMA</text>
      <text x="58" y="32" fill="#6B666C" font-size="6.5" font-weight="700" text-anchor="middle">2.5×7.5 IN KEYCHAIN</text>
      <!-- Photos -->
      <rect x="12" y="38" width="92" height="64" rx="2" fill="#8CB89F"/>
      <text x="58" y="74" fill="#FFFFFF" font-size="9" font-weight="800" text-anchor="middle">SHOT #1</text>
      <rect x="12" y="108" width="92" height="64" rx="2" fill="#B88C9F"/>
      <text x="58" y="144" fill="#FFFFFF" font-size="9" font-weight="800" text-anchor="middle">SHOT #2</text>
      <rect x="12" y="178" width="92" height="64" rx="2" fill="#8C9FB8"/>
      <text x="58" y="214" fill="#FFFFFF" font-size="9" font-weight="800" text-anchor="middle">SHOT #3</text>
      <text x="58" y="254" fill="#1C1A1E" font-size="7" font-weight="600" text-anchor="middle">2026 · THANK YOU</text>
    </g>

    <!-- Strip 2 -->
    <g transform="translate(167, 42)">
      <rect width="116" height="266" rx="4" fill="#FDFBF7" stroke="#B5B5B5" stroke-dasharray="4,3" stroke-width="1.5"/>
      <text x="58" y="22" fill="#C93D27" font-size="8.5" font-weight="800" text-anchor="middle">LUCAS &amp; EMMA</text>
      <text x="58" y="32" fill="#6B666C" font-size="6.5" font-weight="700" text-anchor="middle">2.5×7.5 IN KEYCHAIN</text>
      <rect x="12" y="38" width="92" height="64" rx="2" fill="#8CB89F"/>
      <text x="58" y="74" fill="#FFFFFF" font-size="9" font-weight="800" text-anchor="middle">SHOT #1</text>
      <rect x="12" y="108" width="92" height="64" rx="2" fill="#B88C9F"/>
      <text x="58" y="144" fill="#FFFFFF" font-size="9" font-weight="800" text-anchor="middle">SHOT #2</text>
      <rect x="12" y="178" width="92" height="64" rx="2" fill="#8C9FB8"/>
      <text x="58" y="214" fill="#FFFFFF" font-size="9" font-weight="800" text-anchor="middle">SHOT #3</text>
      <text x="58" y="254" fill="#1C1A1E" font-size="7" font-weight="600" text-anchor="middle">2026 · THANK YOU</text>
    </g>

    <!-- Strip 3 -->
    <g transform="translate(298, 42)">
      <rect width="116" height="266" rx="4" fill="#FDFBF7" stroke="#B5B5B5" stroke-dasharray="4,3" stroke-width="1.5"/>
      <text x="58" y="22" fill="#C93D27" font-size="8.5" font-weight="800" text-anchor="middle">LUCAS &amp; EMMA</text>
      <text x="58" y="32" fill="#6B666C" font-size="6.5" font-weight="700" text-anchor="middle">2.5×7.5 IN KEYCHAIN</text>
      <rect x="12" y="38" width="92" height="64" rx="2" fill="#8CB89F"/>
      <text x="58" y="74" fill="#FFFFFF" font-size="9" font-weight="800" text-anchor="middle">SHOT #1</text>
      <rect x="12" y="108" width="92" height="64" rx="2" fill="#B88C9F"/>
      <text x="58" y="144" fill="#FFFFFF" font-size="9" font-weight="800" text-anchor="middle">SHOT #2</text>
      <rect x="12" y="178" width="92" height="64" rx="2" fill="#8C9FB8"/>
      <text x="58" y="214" fill="#FFFFFF" font-size="9" font-weight="800" text-anchor="middle">SHOT #3</text>
      <text x="58" y="254" fill="#1C1A1E" font-size="7" font-weight="600" text-anchor="middle">2026 · THANK YOU</text>
    </g>

    <!-- Dimension Label -->
    <g transform="translate(36, 314)">
      <text x="0" y="0" fill="#C93D27" font-size="8" font-weight="800">↔ Width: 2.5 in (63.5 mm)</text>
      <text x="280" y="0" fill="#C93D27" font-size="8" font-weight="800">↕ Height: 7.5 in (190.5 mm)</text>
    </g>
  </g>
</svg>`;

// 4. Mockup: Print Settings Modal with Keychain Toggle
const svg4 = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 540 340" width="100%" height="100%" style="background:#FAF7F2;border-radius:12px;font-family:'Manrope',system-ui,sans-serif;">
  <rect x="0" y="0" width="540" height="340" rx="12" fill="#FAF7F2" stroke="#E4DCCF" stroke-width="1"/>
  
  <!-- Modal Card -->
  <g transform="translate(40, 16)">
    <rect width="460" height="308" rx="12" fill="#FFFFFF" stroke="#E4DCCF" stroke-width="1.5" filter="drop-shadow(0 8px 24px rgba(0,0,0,0.08))"/>
    
    <!-- Title -->
    <text x="24" y="32" fill="#1C1A1E" font-size="16" font-weight="800">Print settings</text>
    <text x="436" y="32" fill="#6B666C" font-size="16" font-weight="700" text-anchor="end">✕</text>
    <line x1="24" y1="44" x2="436" y2="44" stroke="#F0E8DD" stroke-width="1"/>

    <!-- Paper Size Section -->
    <text x="24" y="68" fill="#1C1A1E" font-size="11.5" font-weight="800">Paper size</text>
    <g transform="translate(24, 78)">
      <rect width="70" height="32" rx="6" fill="#FAF7F2" stroke="#E4DCCF" stroke-width="1"/>
      <text x="35" y="20" fill="#6B666C" font-size="11" font-weight="700" text-anchor="middle">4×6 (4R)</text>

      <rect x="78" width="70" height="32" rx="6" fill="#C93D27"/>
      <text x="113" y="20" fill="#FFFFFF" font-size="11" font-weight="800" text-anchor="middle">A4 ✓</text>

      <rect x="156" width="70" height="32" rx="6" fill="#FAF7F2" stroke="#E4DCCF" stroke-width="1"/>
      <text x="191" y="20" fill="#6B666C" font-size="11" font-weight="700" text-anchor="middle">Letter</text>

      <rect x="234" width="70" height="32" rx="6" fill="#FAF7F2" stroke="#E4DCCF" stroke-width="1"/>
      <text x="269" y="20" fill="#6B666C" font-size="11" font-weight="700" text-anchor="middle">8×10 (8R)</text>
    </g>

    <!-- Keychain Toggle Row (CRITICAL) -->
    <g transform="translate(24, 126)">
      <rect width="412" height="42" rx="8" fill="#FDF5F3" stroke="#F2D9D2" stroke-width="1.5"/>
      <text x="14" y="26" fill="#1C1A1E" font-size="12" font-weight="800">Keychain strips at real size (2.5×7.5 in)</text>
      
      <!-- Toggle Switch ON -->
      <g transform="translate(360, 11)">
        <rect width="38" height="20" rx="10" fill="#21764D"/>
        <circle cx="28" cy="10" r="8" fill="#FFFFFF"/>
      </g>
    </g>

    <!-- Dynamic Hint Callout -->
    <g transform="translate(24, 178)">
      <rect width="412" height="40" rx="6" fill="#FAF7F2" stroke="#E4DCCF" stroke-width="1"/>
      <text x="14" y="24" fill="#C93D27" font-size="11" font-weight="700">3 keychains at 2.5×7.5 in, 3 per A4 page. Print at 100%.</text>
    </g>

    <!-- Borderless Switch OFF -->
    <g transform="translate(24, 230)">
      <text x="0" y="16" fill="#6B666C" font-size="11.5" font-weight="700">Borderless, no trimming (Leave OFF for keychains)</text>
      <!-- Toggle Switch OFF -->
      <g transform="translate(360, 0)">
        <rect width="38" height="20" rx="10" fill="#D5CBBF"/>
        <circle cx="10" cy="10" r="8" fill="#FFFFFF"/>
      </g>
    </g>

    <!-- Print Button -->
    <g transform="translate(24, 264)">
      <rect width="412" height="34" rx="8" fill="#C93D27"/>
      <text x="206" y="22" fill="#FFFFFF" font-size="13" font-weight="800" text-anchor="middle">Print 1 copy (A4 Paper)</text>
    </g>
  </g>
</svg>`;

// 5. Mockup: Acrylic Assembly & Cutting Flow
const svg5 = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 540 240" width="100%" height="100%" style="background:#FAF7F2;border-radius:12px;font-family:'Manrope',system-ui,sans-serif;">
  <rect x="0" y="0" width="540" height="240" rx="12" fill="#FAF7F2" stroke="#E4DCCF" stroke-width="1"/>
  
  <text x="24" y="28" fill="#1C1A1E" font-size="14" font-weight="800">Keychain Trimming &amp; Assembly Process</text>
  <text x="24" y="44" fill="#6B666C" font-size="11">From printed paper to finished clear acrylic souvenir in 4 steps.</text>

  <!-- 4 Process Cards -->
  <!-- Step 1 -->
  <g transform="translate(20, 60)">
    <rect width="115" height="155" rx="8" fill="#FFFFFF" stroke="#E4DCCF" stroke-width="1"/>
    <circle cx="20" cy="20" r="10" fill="#C93D27"/>
    <text x="20" y="24" fill="#FFFFFF" font-size="10" font-weight="800" text-anchor="middle">1</text>
    <text x="36" y="24" fill="#1C1A1E" font-size="11" font-weight="800">Print Sheet</text>
    
    <rect x="25" y="44" width="65" height="75" rx="2" fill="#FDFBF7" stroke="#D5CBBF" stroke-width="1"/>
    <line x1="46" y1="44" x2="46" y2="119" stroke="#B5B5B5" stroke-dasharray="2,2"/>
    <line x1="68" y1="44" x2="68" y2="119" stroke="#B5B5B5" stroke-dasharray="2,2"/>
    <text x="57" y="136" fill="#6B666C" font-size="9" text-anchor="middle">Scale: 100%</text>
    <text x="57" y="147" fill="#6B666C" font-size="9" text-anchor="middle">A4 or 4R Paper</text>
  </g>

  <!-- Step 2 -->
  <g transform="translate(148, 60)">
    <rect width="115" height="155" rx="8" fill="#FFFFFF" stroke="#E4DCCF" stroke-width="1"/>
    <circle cx="20" cy="20" r="10" fill="#C93D27"/>
    <text x="20" y="24" fill="#FFFFFF" font-size="10" font-weight="800" text-anchor="middle">2</text>
    <text x="36" y="24" fill="#1C1A1E" font-size="11" font-weight="800">Trim Strips</text>
    
    <!-- Paper cutter illustration -->
    <rect x="20" y="48" width="75" height="65" rx="3" fill="#F0E8DD"/>
    <rect x="35" y="42" width="22" height="78" rx="1" fill="#FFFFFF" stroke="#C93D27" stroke-width="1"/>
    <!-- Blade line -->
    <line x1="62" y1="36" x2="62" y2="124" stroke="#C93D27" stroke-width="2"/>
    <text x="57" y="136" fill="#6B666C" font-size="9" text-anchor="middle">Cut inside lines</text>
    <text x="57" y="147" fill="#6B666C" font-size="9" text-anchor="middle">Rotary cutter</text>
  </g>

  <!-- Step 3 -->
  <g transform="translate(276, 60)">
    <rect width="115" height="155" rx="8" fill="#FFFFFF" stroke="#E4DCCF" stroke-width="1"/>
    <circle cx="20" cy="20" r="10" fill="#C93D27"/>
    <text x="20" y="24" fill="#FFFFFF" font-size="10" font-weight="800" text-anchor="middle">3</text>
    <text x="36" y="24" fill="#1C1A1E" font-size="11" font-weight="800">Insert Strip</text>
    
    <!-- Acrylic Blank with paper sliding in -->
    <rect x="25" y="44" width="65" height="76" rx="4" fill="none" stroke="#6B666C" stroke-width="2"/>
    <circle cx="57" cy="40" r="4" fill="#6B666C"/>
    <rect x="32" y="52" width="51" height="60" rx="1" fill="#FAF7F2" stroke="#D4AF37" stroke-width="1"/>
    <text x="57" y="136" fill="#6B666C" font-size="9" text-anchor="middle">Slide face down</text>
    <text x="57" y="147" fill="#6B666C" font-size="9" text-anchor="middle">Double-sided ok</text>
  </g>

  <!-- Step 4 -->
  <g transform="translate(404, 60)">
    <rect width="115" height="155" rx="8" fill="#FFFFFF" stroke="#C93D27" stroke-width="2"/>
    <circle cx="20" cy="20" r="10" fill="#21764D"/>
    <text x="20" y="24" fill="#FFFFFF" font-size="10" font-weight="800" text-anchor="middle">4</text>
    <text x="36" y="24" fill="#1C1A1E" font-size="11" font-weight="800">Snap Shut</text>
    
    <!-- Acrylic casing with lid snapping -->
    <rect x="25" y="44" width="65" height="76" rx="4" fill="#E6F4EF" stroke="#21764D" stroke-width="2"/>
    <circle cx="57" cy="40" r="4" fill="#21764D"/>
    <!-- Lid snapping arrows -->
    <text x="57" y="78" fill="#21764D" font-size="11" font-weight="800" text-anchor="middle">CLICK!</text>
    <text x="57" y="98" fill="#21764D" font-size="9" font-weight="700" text-anchor="middle">✓ Finished</text>
    <text x="57" y="136" fill="#21764D" font-size="9" font-weight="800" text-anchor="middle">Press firmly</text>
    <text x="57" y="147" fill="#6B666C" font-size="9" text-anchor="middle">Tabs lock tight</text>
  </g>
</svg>`;

const files = [
  ['1-step3-layout-grid.svg', svg1],
  ['2-step3-framesheet-panel.svg', svg2],
  ['3-step3-preview-sheet.svg', svg3],
  ['4-print-settings-modal.svg', svg4],
  ['5-acrylic-assembly.svg', svg5]
];

files.forEach(([name, content]) => {
  fs.writeFileSync(path.join(docsImgDir, name), content, 'utf8');
  fs.writeFileSync(path.join(publicImgDir, name), content, 'utf8');
  console.log('Created vector mockup:', name);
});

console.log('All 5 vector mockups successfully created!');

