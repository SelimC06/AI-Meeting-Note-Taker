// Chunked upload of release files to the R2 bucket (S3 multipart API).
//
// electron-builder's own publisher sends each ~240 MB installer as ONE PUT,
// which kept failing on a flaky connection ("SSL alert bad record mac",
// EPIPE) -- and a failure 200 MB in meant starting over. This sends 10 MB
// parts and retries each part on its own, so a dropped connection costs one
// part, not the whole file. Used by scripts/release.mjs; also runnable by
// hand to re-upload a file:
//
//   AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... node scripts/upload-r2.mjs <file>...
//
// The bucket and endpoint come from build.publish in package.json -- the
// same place electron-builder reads them from.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import aws4 from 'aws4';

export const PART_SIZE = 10 * 1024 * 1024;
export const MAX_ATTEMPTS = 6;
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

const CONTENT_TYPES = {
    '.dmg': 'application/x-apple-diskimage',
    '.zip': 'application/zip',
    '.exe': 'application/vnd.microsoft.portable-executable',
    '.yml': 'text/yaml',
    '.blockmap': 'application/octet-stream',
};

export function contentTypeFor(key) {
    return CONTENT_TYPES[path.extname(key)] ?? 'application/octet-stream';
}

// [{ partNumber, start, length }] covering `size` bytes in `partSize`
// pieces (S3 part numbers start at 1; only the last part may be smaller).
export function splitIntoParts(size, partSize = PART_SIZE) {
    if (!Number.isInteger(size) || size < 0) throw new Error(`invalid size ${size}`);
    if (!Number.isInteger(partSize) || partSize <= 0) throw new Error(`invalid part size ${partSize}`);
    const parts = [];
    for (let start = 0, partNumber = 1; start < size; start += partSize, partNumber++) {
        parts.push({ partNumber, start, length: Math.min(partSize, size - start) });
    }
    return parts;
}

// Runs fn until it resolves, up to maxAttempts times, waiting a little longer
// after each failure. `sleep` and `onRetry` are injectable for tests.
export async function withRetry(label, fn, {
    maxAttempts = MAX_ATTEMPTS,
    delayMs = (attempt) => 2000 * attempt,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    onRetry = (attempt, err) =>
        console.log(`  ${label} failed (${err?.cause?.code ?? err?.message ?? err}), retry ${attempt}/${maxAttempts - 1}...`),
} = {}) {
    for (let attempt = 1; ; attempt++) {
        try {
            return await fn(attempt);
        } catch (err) {
            if (attempt >= maxAttempts) throw err;
            onRetry(attempt, err);
            await sleep(delayMs(attempt));
        }
    }
}

// Manifests (latest*.yml) must go up LAST, after every file they point at
// is completely uploaded: the moment a manifest is live, the in-app updater
// and the website's download button follow it, and a manifest pointing at a
// missing or half-uploaded installer breaks both.
export function isManifest(key) {
    return /^(latest|beta|alpha)(-mac|-linux)?\.yml$/.test(path.basename(key));
}

export function uploadOrder(files) {
    return [...files.filter((f) => !isManifest(f)), ...files.filter((f) => isManifest(f))];
}

// Signs and sends S3 requests to R2. `fetchImpl` is injectable for tests.
export function createR2Client({ endpoint, bucket, accessKeyId, secretAccessKey, fetchImpl = fetch }) {
    const host = new URL(endpoint).host;
    return {
        async request(method, key, query, { body, headers = {} } = {}) {
            const objectPath = `/${bucket}/${encodeURIComponent(key)}`;
            const signed = aws4.sign(
                {
                    service: 's3',
                    region: 'auto',
                    method,
                    host,
                    path: query ? `${objectPath}?${query}` : objectPath,
                    // Binary bodies aren't hashed into the signature (S3's
                    // UNSIGNED-PAYLOAD) -- TLS already protects them in transit,
                    // and each part's ETag is checked by the complete call.
                    headers: Buffer.isBuffer(body) ? { ...headers, 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' } : headers,
                    body: Buffer.isBuffer(body) ? undefined : body,
                },
                { accessKeyId, secretAccessKey },
            );
            const res = await fetchImpl(`https://${host}${signed.path}`, {
                method,
                headers: signed.headers,
                body,
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });
            const text = await res.text();
            if (!res.ok) throw new Error(`${method} ${key}${query ? `?${query}` : ''} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
            return { headers: res.headers, text };
        },
    };
}

// Reads one part of a file into memory (10 MB at a time, never the whole
// installer).
function readPart(filePath, { start, length }) {
    const fd = fs.openSync(filePath, 'r');
    try {
        const buffer = Buffer.alloc(length);
        fs.readSync(fd, buffer, 0, length, start);
        return buffer;
    } finally {
        fs.closeSync(fd);
    }
}

// Uploads one file under `key`. Small files go up in a single (retried)
// PUT; anything larger than one part is a multipart upload, each part
// retried on its own. A multipart upload that fails for good is aborted, so
// R2 doesn't keep its already-uploaded parts around.
export async function uploadFile(client, filePath, key = path.basename(filePath), { partSize = PART_SIZE, retry = {}, log = console.log } = {}) {
    const size = fs.statSync(filePath).size;
    const contentType = contentTypeFor(key);
    // Manifests must never be served stale by the CDN in front of the bucket.
    const cacheHeaders = isManifest(key) ? { 'Cache-Control': 'no-cache' } : {};

    if (size <= partSize) {
        const body = fs.readFileSync(filePath);
        await withRetry(key, () => client.request('PUT', key, '', { body, headers: { 'Content-Type': contentType, ...cacheHeaders } }), retry);
        log(`uploaded ${key} (${size} bytes)`);
        return;
    }

    const parts = splitIntoParts(size, partSize);
    log(`uploading ${key} (${(size / 1e6).toFixed(1)} MB) in ${parts.length} parts`);
    const init = await withRetry(`${key} start`, () =>
        client.request('POST', key, 'uploads=', { headers: { 'Content-Type': contentType, ...cacheHeaders } }), retry);
    const uploadId = /<UploadId>(.+?)<\/UploadId>/.exec(init.text)?.[1];
    if (!uploadId) throw new Error(`${key}: no UploadId in the response to starting the upload`);
    const uploadQuery = `uploadId=${encodeURIComponent(uploadId)}`;

    try {
        const etags = [];
        for (const part of parts) {
            const body = readPart(filePath, part);
            const { headers } = await withRetry(`${key} part ${part.partNumber}`, () =>
                client.request('PUT', key, `partNumber=${part.partNumber}&${uploadQuery}`, { body }), retry);
            etags.push(headers.get('etag'));
            log(`  part ${part.partNumber}/${parts.length} done`);
        }
        const completeXml =
            '<CompleteMultipartUpload>' +
            etags.map((etag, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${etag}</ETag></Part>`).join('') +
            '</CompleteMultipartUpload>';
        await withRetry(`${key} finish`, () =>
            client.request('POST', key, uploadQuery, { body: completeXml, headers: { 'Content-Type': 'application/xml' } }), retry);
    } catch (err) {
        try {
            await client.request('DELETE', key, uploadQuery);
        } catch {
            // best effort -- the bucket's lifecycle rules can clean it up
        }
        throw err;
    }
    log(`uploaded ${key}`);
}

// Uploads `files` in uploadOrder (manifests last). Stops at the first file
// that fails for good, so a manifest is never uploaded after a failed
// installer.
export async function uploadAll(client, files, options) {
    for (const file of uploadOrder(files)) {
        await uploadFile(client, file, path.basename(file), options);
    }
}

export function r2ConfigFromPackageJson(pkg) {
    const publish = pkg?.build?.publish;
    if (publish?.provider !== 's3' || !publish.bucket || !publish.endpoint) {
        throw new Error('package.json build.publish must be the s3 provider with bucket and endpoint');
    }
    return { bucket: publish.bucket, endpoint: publish.endpoint };
}

async function cli() {
    const files = process.argv.slice(2);
    const { AWS_ACCESS_KEY_ID: accessKeyId, AWS_SECRET_ACCESS_KEY: secretAccessKey } = process.env;
    if (files.length === 0 || !accessKeyId || !secretAccessKey) {
        console.error('Usage: AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... node scripts/upload-r2.mjs <file>...');
        process.exit(1);
    }
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const client = createR2Client({ ...r2ConfigFromPackageJson(pkg), accessKeyId, secretAccessKey });
    await uploadAll(client, files);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await cli();
}
