import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isTrustedProjectArchiveRequest } from '../../electron/project-archive-ipc-auth.ts';

const expectedUrl = 'file:///opt/automationcad/index.html';
const mainFrame = { url: expectedUrl };
const mainWindowSender = { mainFrame };

function trusted(isMainWindowSender, senderFrame, sender = mainWindowSender) {
  return isTrustedProjectArchiveRequest(isMainWindowSender, sender, senderFrame, expectedUrl);
}

test('只接受主应用 WebContents 的预期本地 mainFrame', () => {
  assert.equal(trusted(true, mainFrame), true);
});

test('拒绝同一 WebContents 中的子框架，即使它报告相同文件 URL', () => {
  assert.equal(trusted(true, { url: expectedUrl }), false);
});

test('拒绝远程 frame URL 与非预期的本地 renderer 路径', () => {
  assert.equal(trusted(true, { url: 'https://example.invalid/index.html' }), false);
  assert.equal(trusted(true, { url: 'file:///tmp/attacker.html' }), false);
  assert.equal(trusted(true, { url: 'file://remote-host/share/index.html' }), false);
});

test('拒绝非主窗口 WebContents 的请求', () => {
  assert.equal(trusted(false, mainFrame), false);
});
