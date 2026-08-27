import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import png2icons from 'png2icons';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');
const buildDir = path.join(projectRoot, 'build');
fs.mkdirSync(buildDir, { recursive: true });

const SIZE = 256;
// .icns needs a much larger source than the Windows .ico does -- macOS
// renders this at up to 512x512@2x (1024px) in Finder/the dock, and
// upscaling the 256px source left visible blur/aliasing on the glyph.

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

const ICNS_SOURCE_SIZE = 1024;

async function renderPng(page, size) {
    await page.setViewportSize({ width: size, height: size });
    await page.evaluate((s) => {
        const el = document.querySelector('svg');
        el.setAttribute('width', String(s));
        el.setAttribute('height', String(s));
    }, size);
    return page.screenshot({ omitBackground: false });
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE } });
await page.setContent(html);
const png = await renderPng(page, SIZE);
const icnsSourcePng = await renderPng(page, ICNS_SOURCE_SIZE);
await browser.close();

const icns = png2icons.createICNS(icnsSourcePng, png2icons.BICUBIC2, 0);
if (!icns) {
    throw new Error('png2icons failed to produce an .icns file');
}

fs.writeFileSync(path.join(buildDir, 'icon.png'), png);
fs.writeFileSync(path.join(buildDir, 'icon.ico'), encodeIco(png, SIZE));
fs.writeFileSync(path.join(buildDir, 'icon.icns'), icns);

console.log(`Wrote ${path.join(buildDir, 'icon.png')}, ${path.join(buildDir, 'icon.ico')}, and ${path.join(buildDir, 'icon.icns')}`);
