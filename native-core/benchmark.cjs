const crypto = require('node:crypto')
const { PacketCrypto } = require('../electron/p2pshare_native.node')

const PACKETS = Number(process.env.P2P_BENCH_PACKETS || 200_000)
const WARMUP_PACKETS = Number(process.env.P2P_BENCH_WARMUP || 10_000)
const PAYLOADS = String(process.env.P2P_BENCH_PAYLOADS || '512,768,1024,1200,1280,1360,1400,1432')
  .split(',')
  .map(Number)
  .filter((value) => Number.isInteger(value) && value > 0)
const JSON_MODE = process.argv.includes('--json') || process.env.P2P_BENCH_JSON === '1'
const key = Buffer.alloc(32, 7)

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

function bench(engine, payloadBytes, seal) {
  const payload = Buffer.alloc(payloadBytes, 0xa5)
  for (let i = 0; i < WARMUP_PACKETS; i++) seal(payload)
  const started = process.hrtime.bigint()
  for (let i = 0; i < PACKETS; i++) seal(payload)
  const elapsedNs = process.hrtime.bigint() - started
  const seconds = Number(elapsedNs) / 1e9
  const mib = PACKETS * payloadBytes / 1048576
  return {
    engine,
    payloadBytes,
    packets: PACKETS,
    warmupPackets: WARMUP_PACKETS,
    seconds,
    mibPerSecond: mib / seconds,
    packetsPerSecond: PACKETS / seconds,
    nsPerPacket: Number(elapsedNs) / PACKETS,
  }
}

const results = []
for (const payloadBytes of PAYLOADS) {
  results.push(bench('node-aes-256-gcm', payloadBytes, nodeSealFactory()))
  const rust = new PacketCrypto(key, 'host')
  results.push(bench('rust-aes-256-gcm', payloadBytes, (plain) => rust.seal(plain)))
}

if (JSON_MODE) {
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    cpuCount: require('node:os').cpus().length,
    results,
  }, null, 2)}\n`)
} else {
  console.log(`P2PShare packet crypto sweep — ${PACKETS.toLocaleString()} packets/case`)
  for (const result of results) {
    console.log(
      `${result.engine.padEnd(20)} ${String(result.payloadBytes).padStart(4)} B: ` +
      `${result.mibPerSecond.toFixed(1).padStart(7)} MiB/s, ` +
      `${Math.round(result.packetsPerSecond).toLocaleString().padStart(10)} pkt/s, ` +
      `${Math.round(result.nsPerPacket).toLocaleString().padStart(7)} ns/pkt`,
    )
  }
}
