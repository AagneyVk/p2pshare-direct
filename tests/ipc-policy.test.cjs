const { test } = require('node:test')
const assert = require('node:assert/strict')
const { trustedSender } = require('../electron/IpcPolicy.cjs')
test('privileged IPC requires both main frame identity and exact trusted URL', () => {
  const frame = { url: 'file:///app/dist/index.html' }
  const webContents = { mainFrame: frame }
  const window = { isDestroyed: () => false, webContents }
  const event = { sender: webContents, senderFrame: frame }
  assert.equal(trustedSender(event, window, frame.url), true)
  assert.equal(trustedSender({ ...event, senderFrame: { ...frame } }, window, frame.url), false)
  assert.equal(trustedSender({ ...event, sender: {} }, window, frame.url), false)
  assert.equal(trustedSender(event, window, 'https://attacker.example/'), false)
  assert.equal(trustedSender(event, null, frame.url), false)
})
