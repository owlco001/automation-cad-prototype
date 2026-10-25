interface FrameLike {
  url: string;
}

interface SenderLike {
  mainFrame: FrameLike;
}

function isLocalFileUrl(value: URL): boolean {
  return value.protocol === 'file:' && value.hostname === '' &&
    value.username === '' && value.password === '' && value.port === '';
}

export function isTrustedProjectArchiveRequest(
  isMainWindowSender: boolean,
  sender: SenderLike,
  senderFrame: FrameLike | null | undefined,
  expectedMainFrameUrl: string
): boolean {
  if (!isMainWindowSender || !senderFrame || senderFrame !== sender.mainFrame) return false;

  try {
    const actualUrl = new URL(senderFrame.url);
    const expectedUrl = new URL(expectedMainFrameUrl);
    return isLocalFileUrl(actualUrl) && isLocalFileUrl(expectedUrl) && actualUrl.href === expectedUrl.href;
  } catch {
    return false;
  }
}
