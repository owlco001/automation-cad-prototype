import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { isTrustedIpcSender, isTrustedUiUrl } from '../../electron/security.ts';

const trustedPath = '/opt/automation cad/index.html';
const trustedUrl = pathToFileURL(trustedPath).href;

function eventFor(frame, { senderId = 42, mainFrame = frame, destroyed = false } = {}) {
  return {
    sender: {
      id: senderId,
      mainFrame,
      isDestroyed: () => destroyed
    },
    senderFrame: frame
  };
}

test('Electron 页面边界仅允许入口 HTML 的 file URL', () => {
  assert.equal(isTrustedUiUrl(trustedUrl, trustedPath), true);
  assert.equal(isTrustedUiUrl(`${trustedUrl}#settings`, trustedPath), true);
  assert.equal(isTrustedUiUrl('https://example.com/index.html', trustedPath), false);
  assert.equal(isTrustedUiUrl(pathToFileURL('/opt/automation cad/other.html').href, trustedPath), false);
  assert.equal(isTrustedUiUrl(`${trustedUrl}.backup`, trustedPath), false);
  assert.equal(isTrustedUiUrl('not a url', trustedPath), false);
});

test('敏感 IPC 仅接受当前主窗口的可信主 frame', () => {
  const mainFrame = { url: trustedUrl };
  assert.equal(isTrustedIpcSender(eventFor(mainFrame), 42, trustedPath), true);
  assert.equal(isTrustedIpcSender(eventFor(mainFrame, { senderId: 99 }), 42, trustedPath), false);
  assert.equal(isTrustedIpcSender(eventFor({ url: trustedUrl }, { mainFrame }), 42, trustedPath), false);
  assert.equal(isTrustedIpcSender(eventFor({ url: 'https://example.com/' }), 42, trustedPath), false);
  assert.equal(isTrustedIpcSender(eventFor(mainFrame, { destroyed: true }), 42, trustedPath), false);
  assert.equal(isTrustedIpcSender(eventFor(null), 42, trustedPath), false);
});
