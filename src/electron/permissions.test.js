import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedPermission } from './permissions.js';

const PAGE = 'file:///Applications/DeskRecap.app/Contents/Resources/app.asar/dist-react/rail.html';

test('allows only the permissions recording and the copy button use, for the app pages', () => {
    for (const permission of ['media', 'display-capture', 'clipboard-sanitized-write']) {
        assert.equal(isAllowedPermission(permission, PAGE), true, permission);
    }
    for (const permission of ['geolocation', 'notifications', 'midi', 'pointerLock', 'openExternal', 'fullscreen']) {
        assert.equal(isAllowedPermission(permission, PAGE), false, permission);
    }
});

test('denies even allowed permissions to anything that is not a bundled file:// page', () => {
    assert.equal(isAllowedPermission('media', 'https://evil.example/'), false);
    assert.equal(isAllowedPermission('media', 'http://127.0.0.1:8000/'), false);
    assert.equal(isAllowedPermission('media', ''), false);
    assert.equal(isAllowedPermission('media', undefined), false);
});
