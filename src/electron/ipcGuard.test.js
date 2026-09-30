import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTrustedIpcSender } from './ipcGuard.js';

function makeWindow(url = 'file:///app/dist-react/index.html') {
    const mainFrame = { url };
    const webContents = { mainFrame };
    return { isDestroyed: () => false, webContents, mainFrame };
}

test('accepts the top frame of one of the app windows loading a bundled file:// page', () => {
    const win = makeWindow();
    const event = { sender: win.webContents, senderFrame: win.mainFrame };
    assert.equal(isTrustedIpcSender(event, [win, null]), true);
});

test('rejects a webContents that is not one of the app windows', () => {
    const win = makeWindow();
    const stranger = makeWindow();
    const event = { sender: stranger.webContents, senderFrame: stranger.mainFrame };
    assert.equal(isTrustedIpcSender(event, [win]), false);
});

test('rejects a subframe of an app window', () => {
    const win = makeWindow();
    const event = { sender: win.webContents, senderFrame: { url: 'file:///app/dist-react/index.html' } };
    assert.equal(isTrustedIpcSender(event, [win]), false);
});

test('rejects an app window whose top frame is not a bundled file:// page', () => {
    const win = makeWindow('https://evil.example/');
    const event = { sender: win.webContents, senderFrame: win.mainFrame };
    assert.equal(isTrustedIpcSender(event, [win]), false);
});

test('rejects a destroyed window and a missing senderFrame', () => {
    const win = makeWindow();
    const destroyed = { ...win, isDestroyed: () => true };
    assert.equal(isTrustedIpcSender({ sender: win.webContents, senderFrame: win.mainFrame }, [destroyed]), false);
    assert.equal(isTrustedIpcSender({ sender: win.webContents, senderFrame: null }, [win]), false);
    assert.equal(isTrustedIpcSender(undefined, [win]), false);
});
