function trustedSender(event, window, expectedUrl) {
  if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return false
  try {
    const actual = new URL(event.senderFrame.url)
    const expected = new URL(expectedUrl)
    actual.hash = ''; expected.hash = ''
    return actual.href === expected.href
  } catch { return false }
}
module.exports = { trustedSender }
