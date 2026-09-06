const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { QuicBridgeController } = require('../electron/QuicBridge.cjs')

function waitEvent(bridge, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { bridge.off('event', listener); reject(new Error('event timeout')) }, 20000)
    const listener = event => {
      if (predicate(event)) { clearTimeout(timer); bridge.off('event', listener); resolve(event) }
    }
    bridge.on('event', listener)
  })
}

test('real native sidecars pair, transfer both directions, and reuse completed content', { timeout: 60000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'p2pshare-quic-test-'))
  const app = { isPackaged: false, getPath: () => root }
  const host = new QuicBridgeController(app, { ip: '127.0.0.1', directory: path.join(root, 'host') })
  const guest = new QuicBridgeController(app, { directory: path.join(root, 'guest') })
  t.after(async () => { await Promise.all([host.disconnect(), guest.disconnect()]); await fs.rm(root, { recursive: true, force: true }) })
  const ticket = await host.createSession()
  assert.ok(ticket.startsWith('p2p3:'))
  const connected = waitEvent(host, e => e.type === 'state' && e.state === 'connected')
  await guest.joinSession(ticket)
  await connected
  const source = path.join(root, 'sample.bin')
  const bytes = Buffer.alloc(8 * 1024 * 1024 + 17)
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31) ^ (i >>> 9)
  await fs.writeFile(source, bytes)
  const receipts = []
  guest.on('verified', r => receipts.push(r))
  const received = waitEvent(host, e => e.type === 'transfer' && e.transfer.done)
  await guest.sendFilePath(source)
  const receipt = await received
  assert.equal(receipt.transfer.name, 'sample.bin')
  assert.equal(receipt.transfer.progress, 1)
  assert.deepEqual(await fs.readFile(host.received.get(receipt.transfer.id).path), bytes)
  assert.equal(receipts[0].payload_bytes, bytes.length)
  await guest.sendFilePath(source)
  assert.equal(receipts[1].payload_bytes, 0)
  assert.equal(receipts[1].reused_bytes, bytes.length)
  const reverse = waitEvent(guest, e => e.type === 'transfer' && e.transfer.incoming && e.transfer.done)
  await host.sendFilePath(source)
  const reverseReceipt = await reverse
  assert.deepEqual(await fs.readFile(guest.received.get(reverseReceipt.transfer.id).path), bytes)

  // New engine processes must revalidate a persisted partial, not trust an old
  // in-memory bitmap. Simulate two durable blocks from an interrupted transfer.
  await Promise.all([host.disconnect(), guest.disconnect()])
  const completed = path.join(root, 'host', receipts[0].digest)
  await fs.rename(completed, completed + '.part')
  await fs.truncate(completed + '.part', 2 * 1024 * 1024)
  const nextTicket = await host.createSession()
  const reconnected = waitEvent(host, e => e.type === 'state' && e.state === 'connected')
  await guest.joinSession(nextTicket)
  await reconnected
  const repaired = waitEvent(host, e => e.type === 'transfer' && e.transfer.incoming && e.transfer.done)
  await guest.sendFilePath(source)
  await repaired
  assert.equal(receipts[2].reused_bytes, 2 * 1024 * 1024)
  assert.equal(receipts[2].payload_bytes, bytes.length - 2 * 1024 * 1024)
  assert.deepEqual(await fs.readFile(completed), bytes)
})

test('legacy or oversized tickets are rejected without launching an engine', async () => {
  const bridge = new QuicBridgeController({ getPath: () => os.tmpdir() })
  await assert.rejects(bridge.joinSession('INVALID'), /QUIC v3 ticket/)
  await assert.rejects(bridge.joinSession('p2p3:' + 'a'.repeat(8192)), /QUIC v3 ticket/)
  assert.equal(bridge.child, null)
})
