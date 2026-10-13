#!/usr/bin/env node
/**
 * Builds PowerPoint slides of screenshots with every image scaled to fit (aspect ratio kept, never stretched).
 * Several viewports go on one slide, four per slide, and longer sets continue on the next slide.
 *
 *   node scripts/build-screenshot-slides.mjs --title "Craft theme" --out scratch/craft-shots.pptx \
 *     --group "Product page=scratch/craft-jpg/product-page" --group "Cart drawer=scratch/craft-jpg/cart-drawer" ...
 *
 * Each group is a folder of JPEG/PNG files. Files are sorted by viewport width, largest first.
 */
import PptxGenJS from 'pptxgenjs';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

const args = process.argv.slice(2);
const all = (k) => args.flatMap((a, i) => (a === `--${k}` ? [args[i + 1]] : []));
const one = (k) => all(k)[0];
const out = one('out');
const themeTitle = one('title') ?? 'Screenshots';
const groups = all('group').map((g) => {
  const [label, dir] = g.split('=');
  return { label, dir };
});
if (!out || groups.length === 0) {
  console.error('Usage: --out <file.pptx> --title <text> --group "Label=folder" [--group ...]');
  process.exit(1);
}

// Image size from file header (PNG IHDR or JPEG SOF marker). No extra packages needed.
function imageSize(path) {
  const b = readFileSync(path);
  if (b[0] === 0x89 && b[1] === 0x50) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1];
      const len = b.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
  }
  throw new Error(`Unknown image format: ${path}`);
}

function viewportWidth(name) {
  const m = name.match(/(\d{3,4})x(\d{3,4})/);
  return m ? Number(m[1]) : 0;
}

const pptx = new PptxGenJS();
pptx.defineLayout({ name: 'WIDE_16_9', width: 13.33, height: 7.5 });
pptx.layout = 'WIDE_16_9';

const PER_SLIDE = 4;
const GRID = { x: 0.6, y: 1.95, w: 12.13, h: 5.05, gap: 0.25 };
const cellW = (GRID.w - GRID.gap * (PER_SLIDE - 1)) / PER_SLIDE;

function deviceLabel(name) {
  const m = name.match(/_(desktop|tablet|mobile)_(\d+x\d+)/);
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2].replace('x', ' x ')}` : name;
}

for (const g of groups) {
  const files = readdirSync(g.dir)
    .filter((f) => /\.(png|jpe?g)$/i.test(f))
    .sort((a, b) => viewportWidth(b) - viewportWidth(a));
  const pages = Math.ceil(files.length / PER_SLIDE);
  for (let p = 0; p < pages; p++) {
    const slide = pptx.addSlide();
    slide.background = { fill: 'F6F8FA' };
    const title = pages > 1 ? `${g.label} (${p + 1} of ${pages})` : g.label;
    slide.addText(themeTitle, { x: 0.6, y: 0.35, w: 9, h: 0.35, fontSize: 13, color: '0EA5E9', bold: true, fontFace: 'Plus Jakarta Sans' });
    slide.addText(title, { x: 0.6, y: 0.7, w: 12, h: 0.7, fontSize: 26, color: '0F172A', bold: true, fontFace: 'Outfit' });

    const chunk = files.slice(p * PER_SLIDE, p * PER_SLIDE + PER_SLIDE);
    chunk.forEach((f, i) => {
      const x0 = GRID.x + i * (cellW + GRID.gap);
      const { w: iw, h: ih } = imageSize(join(g.dir, f));
      const scale = Math.min(cellW / iw, (GRID.h - 0.4) / ih);
      const w = iw * scale;
      const h = ih * scale;
      const x = x0 + (cellW - w) / 2;
      const y = GRID.y + 0.4 + ((GRID.h - 0.4) - h) / 2;
      slide.addText(deviceLabel(basename(f)), { x: x0, y: GRID.y - 0.05, w: cellW, h: 0.3, fontSize: 12, bold: true, color: '334155', align: 'center', fontFace: 'Plus Jakarta Sans' });
      slide.addImage({ path: join(g.dir, f), x, y, w, h });
    });
  }
}

await pptx.writeFile({ fileName: out });
console.log('wrote', out);
