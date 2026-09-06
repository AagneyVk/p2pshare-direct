const { test } = require('node:test')
const assert = require('node:assert/strict')
const { ReplayWindow } = require('../electron/ReplayWindow.cjs')
const { NativeBridgeController } = require('../electron/nativeBridge.cjs')

function pair() {
  const host = new NativeBridgeController({})
  const guest = new NativeBridgeController({})
  for (const [controller, role] of [[host, 'host'], [guest, 'guest']]) {
    controller.role = role
    controller.ticketSecret = Buffer.alloc(10, 7)
    controller.establishSessionKey(Buffer.alloc(16, 1), Buffer.alloc(16, 2))
  }
  return { host, guest }
}

test('replay window accepts reordering but rejects duplicates and expired packets', () => {
  const window = new ReplayWindow()
  assert.equal(window.accept(0n), false)
  assert.equal(window.accept(100n), true)
  assert.equal(window.accept(99n), true)
  assert.equal(window.accept(99n), false)
  assert.equal(window.accept(36n), false)
  assert.equal(window.accept(37n), true)
  assert.equal(window.accept(100001n), true)
  assert.equal(window.accept(100n), false)
})

test('real AEAD roundtrip rejects tampering and replay without poisoning state', () => {
  const { host, guest } = pair()
  const packet = guest.sealPacket(Buffer.from('payload'))
  const corrupt = Buffer.from(packet)
  corrupt[corrupt.length - 1] ^= 1
  assert.equal(host.openEncryptedPacket(corrupt), null)
  assert.deepEqual(host.openEncryptedPacket(packet), Buffer.from('payload'))
  assert.equal(host.openEncryptedPacket(packet), null)
})

test('plaintext data plane never reaches event dispatch, before or after pairing', () => {
  const { host, guest } = pair()
  const id = Buffer.alloc(36, 65)
  const ack = Buffer.concat([guest.makeHeader(4), id])
  const events = []
  host.emitToRenderer = event => events.push(event)
  const remote = { address: '127.0.0.1', port: 45882 }
  host.handlePacket(ack, remote)
  assert.equal(events.length, 0)
  host.handlePacket(guest.sealPacket(ack), remote)
  assert.equal(events.length, 1)
  host.sessionKey = null
  host.handlePacket(ack, remote)
  assert.equal(events.length, 1)
})

test('inner protocol header is validated even when encryption is authentic', () => {
  const { host, guest } = pair()
  const ack = Buffer.concat([guest.makeHeader(4), Buffer.alloc(36)])
  ack[0] ^= 1
  host.emitToRenderer = () => assert.fail('invalid header dispatched')
  host.handlePacket(guest.sealPacket(ack), { address: '127.0.0.1', port: 45882 })
})
