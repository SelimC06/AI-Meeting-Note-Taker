import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    splitIntoParts, withRetry, uploadOrder, isManifest, uploadFile, uploadAll, createR2Client, r2ConfigFromPackageJson,
} from './upload-r2.mjs';

const noWait = { sleep: async () => {}, onRetry: () => {} };

test('splitIntoParts covers the file exactly, only the last part smaller', () => {
    assert.deepEqual(splitIntoParts(25, 10), [
        { partNumber: 1, start: 0, length: 10 },
        { partNumber: 2, start: 10, length: 10 },
        { partNumber: 3, start: 20, length: 5 },
    ]);
    assert.deepEqual(splitIntoParts(20, 10).map((p) => p.length), [10, 10]);
    assert.deepEqual(splitIntoParts(0, 10), []);
    const big = 240 * 1024 * 1024 + 7;
    const parts = splitIntoParts(big);
    assert.equal(parts.reduce((sum, p) => sum + p.length, 0), big);
    assert.equal(parts.length, 25);
});

test('withRetry retries until success, and gives up after maxAttempts', async () => {
    let calls = 0;
    const result = await withRetry('x', async () => {
        calls++;
        if (calls < 3) throw new Error('EPIPE');
        return 'ok';
    }, { maxAttempts: 5, ...noWait });
    assert.equal(result, 'ok');
    assert.equal(calls, 3);

    let failing = 0;
    await assert.rejects(
        withRetry('y', async () => { failing++; throw new Error('bad record mac'); }, { maxAttempts: 4, ...noWait }),
        /bad record mac/
    );
    assert.equal(failing, 4);
});

test('manifests always go up last', () => {
    assert.equal(isManifest('/r/latest-mac.yml'), true);
    assert.equal(isManifest('latest.yml'), true);
    assert.equal(isManifest('DeskRecap-1.0.1-arm64.dmg'), false);
    assert.deepEqual(
        uploadOrder(['latest-mac.yml', 'a.zip', 'a.zip.blockmap', 'a.dmg']),
        ['a.zip', 'a.zip.blockmap', 'a.dmg', 'latest-mac.yml']
    );
});

// A fake S3: records every request, can fail chosen ones.
function fakeClient({ failWhen = () => false } = {}) {
    const requests = [];
    return {
        requests,
        async request(method, key, query, { body, headers = {} } = {}) {
            requests.push({ method, key, query, size: body?.length, headers });
            if (failWhen({ method, key, query, count: requests.length })) throw new Error('EPIPE');
            if (method === 'POST' && query === 'uploads=') return { headers: new Headers(), text: '<UploadId>U1</UploadId>' };
            if (method === 'PUT' && query.startsWith('partNumber=')) {
                return { headers: new Headers({ etag: `"etag-${query.split('&')[0]}"` }), text: '' };
            }
            return { headers: new Headers(), text: '' };
        },
    };
}

function tempFile(name, size) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-r2-test-'));
    const file = path.join(dir, name);
    fs.writeFileSync(file, Buffer.alloc(size, 7));
    return file;
}

test('a large file goes up as a multipart upload with every part and a complete call', async () => {
    const client = fakeClient();
    await uploadFile(client, tempFile('big.zip', 25), 'big.zip', { partSize: 10, retry: noWait, log: () => {} });

    const summary = client.requests.map((r) => `${r.method} ${r.query}`);
    assert.deepEqual(summary, [
        'POST uploads=',
        'PUT partNumber=1&uploadId=U1',
        'PUT partNumber=2&uploadId=U1',
        'PUT partNumber=3&uploadId=U1',
        'POST uploadId=U1',
    ]);
    assert.deepEqual(client.requests.slice(1, 4).map((r) => r.size), [10, 10, 5]);
});

test('a failed part is retried on its own, not the whole file', async () => {
    let part2Failures = 0;
    const client = fakeClient({
        failWhen: ({ query }) => query.startsWith('partNumber=2') && part2Failures++ < 2,
    });
    await uploadFile(client, tempFile('big.zip', 25), 'big.zip', { partSize: 10, retry: noWait, log: () => {} });

    const parts = client.requests.filter((r) => r.query.startsWith('partNumber=')).map((r) => r.query.split('&')[0]);
    assert.deepEqual(parts, ['partNumber=1', 'partNumber=2', 'partNumber=2', 'partNumber=2', 'partNumber=3']);
});

test('a part that never succeeds aborts the multipart upload and throws', async () => {
    const client = fakeClient({ failWhen: ({ query }) => query.startsWith('partNumber=2') });
    await assert.rejects(
        uploadFile(client, tempFile('big.zip', 25), 'big.zip', { partSize: 10, retry: { maxAttempts: 3, ...noWait }, log: () => {} }),
        /EPIPE/
    );
    const last = client.requests[client.requests.length - 1];
    assert.equal(last.method, 'DELETE');
    assert.equal(last.query, 'uploadId=U1');
    assert.equal(client.requests.some((r) => r.method === 'POST' && r.query === 'uploadId=U1'), false);
});

test('a small file is one PUT; a manifest is sent no-cache', async () => {
    const client = fakeClient();
    await uploadFile(client, tempFile('latest-mac.yml', 3), 'latest-mac.yml', { partSize: 10, retry: noWait, log: () => {} });
    assert.equal(client.requests.length, 1);
    assert.equal(client.requests[0].method, 'PUT');
    assert.equal(client.requests[0].headers['Cache-Control'], 'no-cache');
});

test('uploadAll never uploads the manifest after an installer failed', async () => {
    const client = fakeClient({ failWhen: ({ key }) => key === 'a.dmg' });
    const files = [tempFile('latest-mac.yml', 3), tempFile('a.dmg', 4)];
    await assert.rejects(uploadAll(client, files, { partSize: 10, retry: { maxAttempts: 2, ...noWait }, log: () => {} }));
    assert.equal(client.requests.some((r) => r.key === 'latest-mac.yml'), false);
});

test('createR2Client signs requests for the bucket path on the R2 endpoint', async () => {
    const seen = [];
    const client = createR2Client({
        endpoint: 'https://acct.r2.cloudflarestorage.com',
        bucket: 'my-bucket',
        accessKeyId: 'AKID',
        secretAccessKey: 'secret',
        fetchImpl: async (url, init) => {
            seen.push({ url, init });
            return new Response('<UploadId>X</UploadId>', { status: 200 });
        },
    });
    await client.request('POST', 'DeskRecap Setup 1.0.1.exe', 'uploads=');

    assert.equal(seen[0].url, 'https://acct.r2.cloudflarestorage.com/my-bucket/DeskRecap%20Setup%201.0.1.exe?uploads=');
    assert.match(seen[0].init.headers.Authorization, /^AWS4-HMAC-SHA256 Credential=AKID\//);
});

test('r2ConfigFromPackageJson reads build.publish', () => {
    assert.deepEqual(
        r2ConfigFromPackageJson({ build: { publish: { provider: 's3', bucket: 'b', endpoint: 'https://e' } } }),
        { bucket: 'b', endpoint: 'https://e' }
    );
    assert.throws(() => r2ConfigFromPackageJson({ build: {} }));
});
