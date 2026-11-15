// Renders the iPhone app icon (1024×1024, opaque, no alpha channel, as App Store Connect requires).
//   node scripts/ios/make-app-icon.mjs
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';

const out = fileURLToPath(new URL('../../ios/App/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon.png', import.meta.url));

// A calendar page with a tick: "your class is booked". Plain shapes, no text, so it reads at 29 px too.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#2F6FD6"/>
      <stop offset="1" stop-color="#1F4580"/>
    </linearGradient>
  </defs>
  <rect width="1024" height="1024" fill="url(#bg)"/>
  <rect x="212" y="262" width="600" height="540" rx="84" fill="#FFFFFF"/>
  <path d="M212 346a84 84 0 0 1 84-84h432a84 84 0 0 1 84 84v74H212z" fill="#DCE7FA"/>
  <rect x="340" y="196" width="56" height="140" rx="28" fill="#FFFFFF" stroke="#1F4580" stroke-width="20"/>
  <rect x="628" y="196" width="56" height="140" rx="28" fill="#FFFFFF" stroke="#1F4580" stroke-width="20"/>
  <path d="M384 604l92 92 176-196" fill="none" stroke="#1F4580" stroke-width="72" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

await sharp(Buffer.from(svg)).flatten({ background: '#1F4580' }).removeAlpha().png({ compressionLevel: 9 }).toFile(out);
const meta = await sharp(out).metadata();
if (meta.width !== 1024 || meta.height !== 1024 || meta.hasAlpha || meta.channels !== 3) {
  throw new Error(`unexpected icon format: ${JSON.stringify(meta)}`);
}
console.log(`wrote ${out} (${meta.width}×${meta.height}, ${meta.channels} channels, alpha: ${meta.hasAlpha})`);
