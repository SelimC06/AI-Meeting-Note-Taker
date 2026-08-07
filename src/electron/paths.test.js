import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { distReactPath } from './paths.js';

test('distReactPath joins appPath, dist-react, and the given segments', () => {
    const result = distReactPath('/app/root', 'rail.html');
    assert.equal(result, path.join('/app/root', 'dist-react', 'rail.html'));
});

test('distReactPath does not double or drop separators when appPath has a trailing separator', () => {
    const result = distReactPath(`/app/root${path.sep}`, 'index.html');
    assert.equal(result, path.join('/app/root', 'dist-react', 'index.html'));
});

test('distReactPath supports multiple path segments', () => {
    const result = distReactPath('/app/root', 'assets', 'logo.png');
    assert.equal(result, path.join('/app/root', 'dist-react', 'assets', 'logo.png'));
});
