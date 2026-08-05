import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');
const buildDir = path.join(projectRoot, 'build');
fs.mkdirSync(buildDir, { recursive: true });

const SIZE = 256;
const BG = [0x1a, 0x1a, 0x1f]; // dark slate, matches app's dark theme
const FG = [0x7c, 0xa8, 0xff]; // light blue inset square (placeholder monogram)

function buildPixels() {
    const pixels = Buffer.alloc(SIZE * SIZE * 4);
    const inset = Math.round(SIZE * 0.28);
    for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) {
            const isInset = x >= inset && x < SIZE - inset && y >= inset && y < SIZE - inset;
            const [r, g, b] = isInset ? FG : BG;
            const i = (y * SIZE + x) * 4;
            pixels[i] = r; pixels[i + 1] = g; pixels[i + 2] = b; pixels[i + 3] = 255;
        }
    }
    return pixels;
}

function crc32(buf) {
    let c;
    const table = crc32.table || (crc32.table = (() => {
        const t = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
            t[n] = c >>> 0;
        }
        return t;
    })());
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const typeBuf = Buffer.from(type, 'ascii');
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(data.length, 0);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function encodePng(pixels, width, height) {
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    const ihdrData = Buffer.alloc(13);
    ihdrData.writeUInt32BE(width, 0);
    ihdrData.writeUInt32BE(height, 4);
    ihdrData[8] = 8;  // bit depth
    ihdrData[9] = 6;  // color type: RGBA
    ihdrData[10] = 0; // compression
    ihdrData[11] = 0; // filter
    ihdrData[12] = 0; // interlace
    const ihdr = chunk('IHDR', ihdrData);

    const rowBytes = width * 4;
    const raw = Buffer.alloc((rowBytes + 1) * height);
    for (let y = 0; y < height; y++) {
        raw[y * (rowBytes + 1)] = 0; // filter type: none
        pixels.copy(raw, y * (rowBytes + 1) + 1, y * rowBytes, (y + 1) * rowBytes);
    }
    const idat = chunk('IDAT', zlib.deflateSync(raw));

    const iend = chunk('IEND', Buffer.alloc(0));

    return Buffer.concat([signature, ihdr, idat, iend]);
}

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

const pixels = buildPixels();
const png = encodePng(pixels, SIZE, SIZE);
const ico = encodeIco(png, SIZE);

fs.writeFileSync(path.join(buildDir, 'icon.png'), png);
fs.writeFileSync(path.join(buildDir, 'icon.ico'), ico);

console.log(`Wrote ${path.join(buildDir, 'icon.png')} and ${path.join(buildDir, 'icon.ico')}`);
