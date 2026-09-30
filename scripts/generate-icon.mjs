import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import png2icons from 'png2icons';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');
const buildDir = path.join(projectRoot, 'build');
fs.mkdirSync(buildDir, { recursive: true });

const BACKGROUND = '#1A1A19';
const FOREGROUND = '#EDE6D6';

// The '>' mark, on a 32-unit grid: the same glyph as
// Website/scripts/generate-favicon.mjs (and Website/index.html's inline SVG
// favicon), so the app icon and the site favicon stay one mark. A path
// traced from the original rendering rather than <text font-family=
// 'monospace'>: which font 'monospace' resolves to depends on the machine
// (a different Chromium drew it rounded), so the old <text> icons changed
// with whoever regenerated them. Thin, square-ended stroke, mitred point.
const GRID = 32;
const GLYPH = `<polyline points='13.04,11.63 18.81,16.63 13.04,21.63' fill='none' stroke='${FOREGROUND}' stroke-width='1.56' stroke-linecap='butt' stroke-linejoin='miter'/>`;

// Windows/Linux icon: the full-bleed square. build/icon.png is the 256px
// render; build/icon.ico holds one PNG per size Windows asks for (taskbar,
// Explorer's views, the installer), so it never has to scale the 256px image
// down to 16px itself.
const PNG_SIZE = 256;
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

function squareSvg(size) {
    return `<svg xmlns='http://www.w3.org/2000/svg' width='${size}' height='${size}' viewBox='0 0 ${GRID} ${GRID}'><rect width='${GRID}' height='${GRID}' fill='${BACKGROUND}'/>${GLYPH}</svg>`;
}

// macOS icon: macOS renders it at up to 512x512@2x, so the .icns source is
// 1024px. And macOS 26+ draws any icon that isn't the standard rounded
// square shrunk onto a grey placeholder tile, so the square above can't be
// reused: this follows Apple's icon grid -- an 824/1024 rounded square
// (corner radius 185/1024) centred on a transparent canvas, with the glyph
// at the same proportions as in the square version.
const ICNS_SOURCE_SIZE = 1024;
const MAC_TILE = ICNS_SOURCE_SIZE * (824 / 1024);
const MAC_INSET = (ICNS_SOURCE_SIZE - MAC_TILE) / 2;
const MAC_RADIUS = ICNS_SOURCE_SIZE * (185 / 1024);

function macSvg(size) {
    return `<svg xmlns='http://www.w3.org/2000/svg' width='${size}' height='${size}' viewBox='0 0 ${ICNS_SOURCE_SIZE} ${ICNS_SOURCE_SIZE}'><rect x='${MAC_INSET}' y='${MAC_INSET}' width='${MAC_TILE}' height='${MAC_TILE}' rx='${MAC_RADIUS}' fill='${BACKGROUND}'/><g transform='translate(${MAC_INSET} ${MAC_INSET}) scale(${MAC_TILE / GRID})'>${GLYPH}</g></svg>`;
}

// An .ico with one PNG-compressed image per size (supported since Windows
// Vista). Directory entries first, then the images, each entry pointing at
// its image's offset.
export function encodeIco(images) {
    const header = Buffer.alloc(6);
    header.writeUInt16LE(0, 0); // reserved
    header.writeUInt16LE(1, 2); // type: icon
    header.writeUInt16LE(images.length, 4);

    let offset = header.length + 16 * images.length;
    const entries = images.map(({ size, png }) => {
        const entry = Buffer.alloc(16);
        entry[0] = size >= 256 ? 0 : size; // width (0 means 256)
        entry[1] = size >= 256 ? 0 : size; // height
        entry[2] = 0; // color palette
        entry[3] = 0; // reserved
        entry.writeUInt16LE(1, 4); // color planes
        entry.writeUInt16LE(32, 6); // bits per pixel
        entry.writeUInt32LE(png.length, 8); // image data size
        entry.writeUInt32LE(offset, 12); // offset to image data
        offset += png.length;
        return entry;
    });
    return Buffer.concat([header, ...entries, ...images.map(({ png }) => png)]);
}

// Renders an SVG that already carries its own width/height at exactly that
// many pixels.
async function renderSvg(page, svg, size, { transparent = false } = {}) {
    await page.setViewportSize({ width: size, height: size });
    const background = transparent ? 'transparent' : BACKGROUND;
    await page.setContent(`<!doctype html><html><body style="margin:0;background:${background}">${svg}</body></html>`);
    return page.screenshot({ omitBackground: transparent, clip: { x: 0, y: 0, width: size, height: size } });
}

async function main() {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    const icoImages = [];
    for (const size of ICO_SIZES) {
        icoImages.push({ size, png: await renderSvg(page, squareSvg(size), size) });
    }
    const png = icoImages.find((image) => image.size === PNG_SIZE).png;
    const icnsSourcePng = await renderSvg(page, macSvg(ICNS_SOURCE_SIZE), ICNS_SOURCE_SIZE, { transparent: true });
    await browser.close();

    const icns = png2icons.createICNS(icnsSourcePng, png2icons.BICUBIC2, 0);
    if (!icns) {
        throw new Error('png2icons failed to produce an .icns file');
    }

    fs.writeFileSync(path.join(buildDir, 'icon.png'), png);
    fs.writeFileSync(path.join(buildDir, 'icon.ico'), encodeIco(icoImages));
    fs.writeFileSync(path.join(buildDir, 'icon.icns'), icns);

    console.log(
        `Wrote ${path.join(buildDir, 'icon.png')}, ${path.join(buildDir, 'icon.ico')} ` +
        `(${ICO_SIZES.join(', ')} px), and ${path.join(buildDir, 'icon.icns')}`
    );
}

// Only when run as a script, so encodeIco can be imported by its test.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await main();
}
