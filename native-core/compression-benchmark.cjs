const os = require('node:os')
const crypto = require('node:crypto')
const native = require('../electron/p2pshare_native.node')

const MIB = 1024 * 1024
const SIZE_MIB = Number(process.env.P2P_COMPRESS_MIB || 64)
const REGION_MIB = String(process.env.P2P_COMPRESS_REGIONS_MIB || '0.25,1,4,16')
  .split(',').map(Number).filter(n => Number.isFinite(n) && n > 0)
const WORKERS = String(process.env.P2P_COMPRESS_WORKERS || `1,2,4,${os.cpus().length}`)
  .split(',').map(Number).filter(n => Number.isInteger(n) && n > 0)
const LEVEL = Number(process.env.P2P_COMPRESS_LEVEL || 1)
const JSON_MODE = process.argv.includes('--json') || process.env.P2P_BENCH_JSON === '1'

function corpus(kind, bytes) {
  if (kind === 'repetitive') return Buffer.alloc(bytes, 0x41)
  if (kind === 'mixed') {
    const out = Buffer.allocUnsafe(bytes)
    for (let offset = 0; offset < bytes; offset += 64 * 1024) {
      const end = Math.min(bytes, offset + 64 * 1024)
      if (((offset / (64 * 1024)) & 1) === 0) out.fill(0x41, offset, end)
      else crypto.randomFillSync(out, offset, end - offset)
    }
    return out
  }
  return crypto.randomBytes(bytes)
}

function run(kind, source, regionMiB, workers) {
  const regionBytes = Math.max(1, Math.floor(regionMiB * MIB))
  const start = process.hrtime.bigint()
  const encoded = native.zstdCompressRegions(source, regionBytes, LEVEL, workers)
  const elapsedNs = Number(process.hrtime.bigint() - start)
  const encodedBytes = encoded.reduce((sum, b) => sum + b.length, 0)
  const seconds = elapsedNs / 1e9
  const sourceMiBps = source.length / MIB / seconds
  const ratio = encodedBytes / source.length
  // Compression is useful when network time saved exceeds compression time.
  // Ignoring overlapped decode for this conservative first-order threshold:
  // S/B = Tc + Sc/B => B = (S-Sc)/Tc.
  const breakEvenMbps = ((source.length - encodedBytes) * 8 / 1_000_000) / seconds
  return { kind, sourceBytes: source.length, encodedBytes, regionBytes, workers, level: LEVEL,
    seconds, sourceMiBps, ratio, breakEvenMbps }
}

const results = []
for (const kind of ['repetitive', 'mixed', 'random']) {
  const source = corpus(kind, SIZE_MIB * MIB)
  for (const regionMiB of REGION_MIB) {
    for (const workers of [...new Set(WORKERS)]) results.push(run(kind, source, regionMiB, workers))
  }
}

const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), platform: process.platform,
  arch: process.arch, node: process.version, cpuCount: os.cpus().length, sizeMiB: SIZE_MIB, results }

if (JSON_MODE) process.stdout.write(JSON.stringify(report, null, 2) + '\n')
else {
  console.log(`P2PShare independent-region Zstd benchmark — ${SIZE_MIB} MiB/corpus, level ${LEVEL}`)
  for (const r of results) console.log(
    `${r.kind.padEnd(10)} region=${String(r.regionBytes / MIB).padStart(5)} MiB ` +
    `workers=${String(r.workers).padStart(2)}  ${r.sourceMiBps.toFixed(1).padStart(7)} MiB/s ` +
    `ratio=${r.ratio.toFixed(3)}  break-even≈${Math.max(0, r.breakEvenMbps).toFixed(0)} Mbps`)
}
