const crypto = require('node:crypto')
const { PacketCrypto } = require('../electron/p2pshare_native.node')

const PACKETS = Number(process.env.P2P_BENCH_PACKETS || 200_000)
const PAYLOAD_BYTES = 1435
const key = Buffer.alloc(32, 7)
const payload = Buffer.alloc(PAYLOAD_BYTES, 0xa5)

function prefix(role) {
  return crypto.createHmac('sha256', key).update(`nonce:${role}`).digest().subarray(0, 4)
}

function nodeSealFactory() {
  const noncePrefix = prefix('host')
  let counter = 0n
  return (plain) => {
    counter++
    const counterBytes = Buffer.allocUnsafe(8)
    counterBytes.writeBigUInt64BE(counter)
    const nonce = Buffer.allocUnsafe(12)
    noncePrefix.copy(nonce, 0)
    nonce.writeBigUInt64BE(counter, 4)
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce)
    cipher.setAAD(counterBytes)
    return Buffer.concat([counterBytes, cipher.update(plain), cipher.final(), cipher.getAuthTag()])
  }
}

function bench(name, seal) {
  for (let i = 0; i < 10_000; i++) seal(payload)
  const started = process.hrtime.bigint()
  for (let i = 0; i < PACKETS; i++) seal(payload)
  const seconds = Number(process.hrtime.bigint() - started) / 1e9
  const mib = PACKETS * PAYLOAD_BYTES / 1048576
  console.log(`${name}: ${(mib / seconds).toFixed(1)} MiB/s, ${Math.round(PACKETS / seconds).toLocaleString()} packets/s`)
}

bench('Node AES-256-GCM', nodeSealFactory())
const rust = new PacketCrypto(key, 'host')
bench('Rust AES-256-GCM', (plain) => rust.seal(plain))
