import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeIco } from './generate-icon.mjs';

test('encodeIco writes one directory entry per image, each pointing at its own PNG', () => {
    const images = [16, 32, 256].map((size) => ({ size, png: Buffer.from(`png-${size}`) }));
    const ico = encodeIco(images);

    assert.equal(ico.readUInt16LE(2), 1); // type: icon
    assert.equal(ico.readUInt16LE(4), 3); // image count
    images.forEach(({ size, png }, i) => {
        const entry = 6 + 16 * i;
        assert.equal(ico[entry], size >= 256 ? 0 : size); // 0 means 256
        const length = ico.readUInt32LE(entry + 8);
        const offset = ico.readUInt32LE(entry + 12);
        assert.equal(length, png.length);
        assert.deepEqual(ico.subarray(offset, offset + length), png);
    });
});
