import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');
const buildDir = path.join(projectRoot, 'build');
fs.mkdirSync(buildDir, { recursive: true });

const SIZE = 256;

// Same '>' glyph as Website/scripts/generate-favicon.mjs (and
// Website/index.html's inline SVG favicon), scaled up -- keeps the desktop
// app icon and the site favicon as the same mark.
const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' fill='#1A1A19'/><text x='16' y='22' font-family='monospace' font-size='20' fill='#EDE6D6' text-anchor='middle'>&gt;</text></svg>`;
const html = `<!doctype html><html><body style="margin:0">${svg}</body></html>`;

function encodeIco(pngBuffer, size) {
    const header = Buffer.alloc(6);
    header.writeUInt16LE(0, 0); // reserved
    header.writeUInt16LE(1, 2); // type: icon
    header.writeUInt16LE(1, 4); // 1 image

    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size; // width (0 means 256)
    entry[1] = size >= 256 ? 0 : size; // height
    entry[2] = 0; // color palette
    entry[3] = 0; // reserved
    entry.writeUInt16LE(1, 4);  // color planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(pngBuffer.length, 8); // image data size
    entry.writeUInt32LE(header.length + entry.length, 12); // offset to image data

    return Buffer.concat([header, entry, pngBuffer]);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE } });
await page.setContent(html);
await page.evaluate((size) => {
    const el = document.querySelector('svg');
    el.setAttribute('width', String(size));
    el.setAttribute('height', String(size));
}, SIZE);
const png = await page.screenshot({ omitBackground: false });
await browser.close();

fs.writeFileSync(path.join(buildDir, 'icon.png'), png);
fs.writeFileSync(path.join(buildDir, 'icon.ico'), encodeIco(png, SIZE));

console.log(`Wrote ${path.join(buildDir, 'icon.png')} and ${path.join(buildDir, 'icon.ico')}`);
