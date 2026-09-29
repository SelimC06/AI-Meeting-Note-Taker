import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAppMenuTemplate, isZoomShortcut } from './appMenu.js';

// Every role anywhere in the template, submenus included.
function allRoles(template) {
    const roles = [];
    const walk = (items) => {
        for (const item of items) {
            if (item.role) roles.push(item.role);
            if (Array.isArray(item.submenu)) walk(item.submenu);
        }
    };
    walk(template);
    return roles;
}

const RELOAD_AND_DEVTOOLS = ['reload', 'forceReload', 'toggleDevTools'];

for (const platform of ['darwin', 'win32', 'linux']) {
    test(`packaged ${platform} menu has no reload, devtools or zoom items`, () => {
        // The bug this guards against: Electron's default menu's View >
        // Reload (Cmd/Ctrl+R) reloaded the focused window -- including the
        // rail, whose renderer holds the only copy of a live recording.
        const roles = allRoles(buildAppMenuTemplate({ platform, isPackaged: true, appName: 'DeskRecap' }));
        for (const role of [...RELOAD_AND_DEVTOOLS, 'zoomIn', 'zoomOut', 'resetZoom', 'viewMenu']) {
            assert.ok(!roles.includes(role), `unexpected ${role} on ${platform}`);
        }
    });

    test(`${platform} menu keeps the standard Edit roles so copy/paste works in text fields`, () => {
        const roles = allRoles(buildAppMenuTemplate({ platform, isPackaged: true, appName: 'DeskRecap' }));
        for (const role of ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll']) {
            assert.ok(roles.includes(role), `missing ${role} on ${platform}`);
        }
    });
}

test('macOS menu starts with the app menu, which holds Quit', () => {
    const template = buildAppMenuTemplate({ platform: 'darwin', isPackaged: true, appName: 'DeskRecap' });
    assert.equal(template[0].label, 'DeskRecap');
    assert.ok(allRoles([template[0]]).includes('quit'));
});

test('non-macOS menus have no app menu', () => {
    const template = buildAppMenuTemplate({ platform: 'win32', isPackaged: true, appName: 'DeskRecap' });
    assert.ok(!allRoles(template).includes('quit'));
    assert.equal(template[0].label, 'Edit');
});

test('dev builds still get reload and devtools', () => {
    const roles = allRoles(buildAppMenuTemplate({ platform: 'darwin', isPackaged: false, appName: 'DeskRecap' }));
    for (const role of RELOAD_AND_DEVTOOLS) {
        assert.ok(roles.includes(role), `missing ${role} in dev`);
    }
});

test('isZoomShortcut uses Cmd on macOS', () => {
    // The bug this guards against: only input.control was checked, so
    // Cmd+= / Cmd+- still zoomed both windows on macOS.
    for (const key of ['=', '-', '0', '+']) {
        assert.equal(isZoomShortcut({ key, meta: true, control: false }, 'darwin'), true);
    }
    assert.equal(isZoomShortcut({ key: '=', meta: false, control: true }, 'darwin'), false);
});

test('isZoomShortcut uses Ctrl on Windows/Linux', () => {
    for (const platform of ['win32', 'linux']) {
        assert.equal(isZoomShortcut({ key: '=', control: true, meta: false }, platform), true);
        assert.equal(isZoomShortcut({ key: '-', control: false, meta: true }, platform), false);
    }
});

test('isZoomShortcut ignores non-zoom keys and bare keypresses', () => {
    assert.equal(isZoomShortcut({ key: 'c', meta: true }, 'darwin'), false);
    assert.equal(isZoomShortcut({ key: '=', meta: false, control: false }, 'darwin'), false);
    assert.equal(isZoomShortcut(undefined, 'darwin'), false);
});
