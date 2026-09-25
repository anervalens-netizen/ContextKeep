/**
 * Renders the ContextKeep CK monogram into the full PWA icon set, following the
 * production logo kit in brand/contextkeep-logo-kit/:
 *   - app icons 192/512 + apple-touch 180: white glyph on the #0F1119 brand tile
 *   - maskable 512: same tile, glyph at 60% so it stays inside the 80% safe zone
 *   - favicon 32 + SVG copies: the mark itself, on transparent
 * source SVGs: assets/logo.svg (dark) and assets/logo-inverse.svg (white).
 * public/favicon.ico is a checked-in kit asset (04_Favicons/favicon.ico).
 * Run: pnpm --filter @contextkeep/web icons
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, "..");
const markPath = path.join(webRoot, "assets", "logo.svg");
const inversePath = path.join(webRoot, "assets", "logo-inverse.svg");
const outDir = path.join(webRoot, "public", "icons");

// Brand ink from brand/contextkeep-logo-kit/07_Guidelines/README.txt (#0F1119).
const INK = { r: 15, g: 17, b: 25, alpha: 1 };

async function renderTile(out: string, size: number, glyphRatio: number): Promise<void> {
  const glyphSize = Math.round(size * glyphRatio);
  const glyph = await sharp(inversePath, { density: 384 })
    .resize(glyphSize, glyphSize, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  await sharp({ create: { width: size, height: size, channels: 4, background: INK } })
    .composite([{ input: glyph, gravity: "center" }])
    .png()
    .toFile(out);
}

async function renderGlyph(out: string, size: number): Promise<void> {
  await sharp(markPath, { density: 384 })
    .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(out);
}

fs.mkdirSync(outDir, { recursive: true });
await renderTile(path.join(outDir, "pwa-192x192.png"), 192, 0.62);
await renderTile(path.join(outDir, "pwa-512x512.png"), 512, 0.62);
await renderTile(path.join(outDir, "maskable-512x512.png"), 512, 0.6);
await renderTile(path.join(outDir, "apple-touch-icon-180x180.png"), 180, 0.62);
await renderGlyph(path.join(outDir, "favicon-32x32.png"), 32);
fs.copyFileSync(markPath, path.join(outDir, "logo.svg"));
fs.copyFileSync(markPath, path.join(outDir, "favicon.svg"));

for (const f of fs.readdirSync(outDir).sort()) {
  const stat = fs.statSync(path.join(outDir, f));
  console.log(`icons/${f} (${stat.size} bytes)`);
}
console.log("icon set generated from assets/logo.svg + assets/logo-inverse.svg (logo kit)");
