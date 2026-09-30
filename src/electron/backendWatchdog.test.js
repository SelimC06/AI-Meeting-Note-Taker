import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { nextWatchdogState, probeHealthOnce, fetchBackendBusy, watchdogThreshold, WATCHDOG_FAILURE_THRESHOLD, WATCHDOG_BUSY_FAILURE_THRESHOLD, WATCHDOG_INTERVAL_MS } from './backendWatchdog.js';

test('nextWatchdogState resets the counter and does not restart on a successful probe', () => {
    assert.deepEqual(nextWatchdogState(0, true), { consecutiveFailures: 0, shouldRestart: false });
    assert.deepEqual(nextWatchdogState(2, true), { consecutiveFailures: 0, shouldRestart: false });
});

test('nextWatchdogState increments the counter on failure without restarting below threshold', () => {
    assert.deepEqual(nextWatchdogState(0, false, 3), { consecutiveFailures: 1, shouldRestart: false });
    assert.deepEqual(nextWatchdogState(1, false, 3), { consecutiveFailures: 2, shouldRestart: false });
});

test('nextWatchdogState signals a restart once the failure count reaches the threshold', () => {
    assert.deepEqual(nextWatchdogState(2, false, 3), { consecutiveFailures: 3, shouldRestart: true });
});

test('nextWatchdogState keeps signalling a restart past the threshold (caller resets the counter)', () => {
    assert.deepEqual(nextWatchdogState(5, false, 3), { consecutiveFailures: 6, shouldRestart: true });
});

test('nextWatchdogState defaults to WATCHDOG_FAILURE_THRESHOLD when no threshold is passed', () => {
    const result = nextWatchdogState(WATCHDOG_FAILURE_THRESHOLD - 1, false);
    assert.equal(result.shouldRestart, true);
});

function findFreePort() {
    return new Promise((resolve) => {
        const srv = http.createServer();
        srv.listen(0, '127.0.0.1', () => {
            const { port } = srv.address();
            srv.close(() => resolve(port));
        });
    });
}

test('probeHealthOnce resolves true when /health responds ok', async () => {
    const port = await findFreePort();
    const server = http.createServer((req, res) => {
        if (req.url === '/health') { res.writeHead(200); res.end('{"ok":true}'); }
        else { res.writeHead(404); res.end(); }
    });
    await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
    try {
        const ok = await probeHealthOnce(`http://127.0.0.1:${port}`);
        assert.equal(ok, true);
    } finally {
        server.close();
    }
});

test('probeHealthOnce sends the backend token, and a 401 counts as unhealthy', async () => {
    const port = await findFreePort();
    const seen = [];
    const server = http.createServer((req, res) => {
        seen.push(req.headers['x-deskrecap-token']);
        res.writeHead(req.headers['x-deskrecap-token'] === 'tok' ? 200 : 401);
        res.end();
    });
    await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
    try {
        assert.equal(await probeHealthOnce(`http://127.0.0.1:${port}`, undefined, 'tok'), true);
        assert.equal(await probeHealthOnce(`http://127.0.0.1:${port}`), false);
        assert.deepEqual(seen, ['tok', undefined]);
    } finally {
        server.close();
    }
});

test('probeHealthOnce resolves false when nothing is listening', async () => {
    const ok = await probeHealthOnce('http://127.0.0.1:1');
    assert.equal(ok, false);
});

test('probeHealthOnce resolves false (not rejects) when the request times out', async () => {
    const port = await findFreePort();
    // Accepts the connection but never responds -- simulates the exact hang
    // this module exists to detect (a deadlocked backend that still holds
    // its socket open).
    const server = http.createServer(() => {
        // never calls res.end()
    });
    await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
    try {
        const ok = await probeHealthOnce(`http://127.0.0.1:${port}`, 50);
        assert.equal(ok, false);
    } finally {
        server.close();
    }
});

test('watchdogThreshold is far more patient while a job is known to be running', () => {
    assert.equal(watchdogThreshold(false), WATCHDOG_FAILURE_THRESHOLD);
    assert.equal(watchdogThreshold(true), WATCHDOG_BUSY_FAILURE_THRESHOLD);
    assert.ok(WATCHDOG_BUSY_FAILURE_THRESHOLD * WATCHDOG_INTERVAL_MS >= 5 * 60 * 1000);
});

test('a CPU-saturated backend missing probes mid-job is not restarted at the idle threshold', () => {
    let failures = 0;
    let restarted = false;
    for (let i = 0; i < 10; i++) {
        const next = nextWatchdogState(failures, false, watchdogThreshold(true));
        failures = next.consecutiveFailures;
        restarted ||= next.shouldRestart;
    }
    assert.equal(restarted, false);
});

function serveJobs(body, status = 200) {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            assert.equal(req.url, '/jobs');
            assert.equal(req.headers['x-deskrecap-token'], 'tok');
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(body));
        });
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

test('fetchBackendBusy reports a queued/running job, and false when there is none', async () => {
    for (const [jobs, expected] of [
        [[{ status: 'running' }], true],
        [[{ status: 'queued' }, { status: 'done' }], true],
        [[{ status: 'done' }, { status: 'failed' }], false],
    ]) {
        const server = await serveJobs(jobs);
        try {
            assert.equal(await fetchBackendBusy(`http://127.0.0.1:${server.address().port}`, 'tok'), expected);
        } finally {
            server.close();
        }
    }
});

test('fetchBackendBusy returns null (unknown) when /jobs fails or is unreachable', async () => {
    const server = await serveJobs({}, 500);
    try {
        assert.equal(await fetchBackendBusy(`http://127.0.0.1:${server.address().port}`, 'tok'), null);
    } finally {
        server.close();
    }
    assert.equal(await fetchBackendBusy('http://127.0.0.1:1', 'tok', 200), null);
});
