export type TransferEncoding = 'none' | 'deflate'

export interface PreparedTransferFile {
  file: File
  encoding: TransferEncoding
  originalSize: number
}

const KB = 1024
const MIN_COMPRESS_SIZE = 4 * KB
const SAMPLE_BYTES = 64 * KB
const SAMPLE_COUNT = 4
const MIN_SAVINGS_RATIO = 0.95
const COMPRESSIBLE_PREFIXES = ['text/']
const COMPRESSIBLE_MIME_TYPES = new Set([
  'application/json',
  'application/javascript',
  'application/ecmascript',
  'application/xml',
  'application/xhtml+xml',
  'application/ld+json',
  'application/x-yaml',
  'application/yaml',
  'application/toml',
  'application/csv',
  'application/rtf',
])
const NON_COMPRESSIBLE_PREFIXES = ['image/', 'audio/', 'video/']
const NON_COMPRESSIBLE_MIME_TYPES = new Set([
  'application/zip',
  'application/x-zip-compressed',
  'application/gzip',
  'application/x-gzip',
  'application/x-7z-compressed',
  'application/vnd.rar',
  'application/x-rar-compressed',
  'application/x-bzip2',
  'application/x-xz',
  'application/pdf',
  'application/octet-stream',
])
const COMPRESSIBLE_EXTENSIONS = new Set([
  '.txt', '.md', '.csv', '.ts', '.tsx', '.js', '.jsx', '.json', '.xml', '.html', '.css', '.scss', '.less',
  '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.log', '.sql', '.svg', '.env', '.properties', '.rtf',
])
const NON_COMPRESSIBLE_EXTENSIONS = new Set([
  '.zip', '.gz', '.gzip', '.tgz', '.bz2', '.xz', '.7z', '.rar', '.jpg', '.jpeg', '.png', '.webp', '.avif',
  '.gif', '.mp4', '.mov', '.mkv', '.mp3', '.aac', '.ogg', '.opus', '.flac', '.pdf', '.apk', '.jar', '.wasm',
])

function getExtension(name: string): string {
  const idx = name.lastIndexOf('.')
  if (idx < 0) return ''
  return name.slice(idx).toLowerCase()
}

function isLikelyCompressible(file: File): boolean {
  if (file.size < MIN_COMPRESS_SIZE) return false

  const mimeType = (file.type || '').toLowerCase()
  if (NON_COMPRESSIBLE_MIME_TYPES.has(mimeType)) return false
  if (NON_COMPRESSIBLE_PREFIXES.some(prefix => mimeType.startsWith(prefix))) return false
  if (COMPRESSIBLE_MIME_TYPES.has(mimeType)) return true
  if (COMPRESSIBLE_PREFIXES.some(prefix => mimeType.startsWith(prefix))) return true

  const extension = getExtension(file.name)
  if (NON_COMPRESSIBLE_EXTENSIONS.has(extension)) return false
  if (COMPRESSIBLE_EXTENSIONS.has(extension)) return true

  return false
}

async function compressedSize(blob: Blob): Promise<number> {
  return (await new Response(
    blob.stream().pipeThrough(new CompressionStream('deflate'))
  ).blob()).size
}

async function estimateCompressionRatio(file: File): Promise<number> {
  if (file.size <= SAMPLE_BYTES * 2) return (await compressedSize(file)) / Math.max(1, file.size)
  const maxStart = Math.max(0, file.size - SAMPLE_BYTES)
  const starts = new Set<number>()
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    starts.add(Math.floor(maxStart * i / Math.max(1, SAMPLE_COUNT - 1)))
  }
  let rawBytes = 0
  let compressedBytes = 0
  for (const start of starts) {
    const sample = file.slice(start, Math.min(file.size, start + SAMPLE_BYTES))
    rawBytes += sample.size
    compressedBytes += await compressedSize(sample)
  }
  return compressedBytes / Math.max(1, rawBytes)
}

async function compressWithDeflate(file: File): Promise<File | null> {
  if (typeof CompressionStream === 'undefined' || typeof Response === 'undefined') return null

  if (await estimateCompressionRatio(file) >= MIN_SAVINGS_RATIO) return null

  const compressedBlob = await new Response(
    file.stream().pipeThrough(new CompressionStream('deflate'))
  ).blob()

  if (compressedBlob.size >= file.size * MIN_SAVINGS_RATIO) return null

  return new File([compressedBlob], file.name, {
    type: 'application/octet-stream',
    lastModified: file.lastModified,
  })
}

export async function prepareFileForTransfer(file: File): Promise<PreparedTransferFile> {
  if (!isLikelyCompressible(file)) {
    return { file, encoding: 'none', originalSize: file.size }
  }

  try {
    const compressed = await compressWithDeflate(file)
    if (!compressed) return { file, encoding: 'none', originalSize: file.size }
    return { file: compressed, encoding: 'deflate', originalSize: file.size }
  } catch {
    return { file, encoding: 'none', originalSize: file.size }
  }
}
