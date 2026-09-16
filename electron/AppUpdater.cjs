const { createHash } = require('node:crypto')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const https = require('node:https')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { Transform } = require('node:stream')
const { pipeline } = require('node:stream/promises')

const API = 'https://api.github.com/repos/AagneyVk/p2pshare-direct/releases?per_page=30'
const RELEASE_PREFIX = 'https://github.com/AagneyVk/p2pshare-direct/releases/download/'
const ASSET_NAME = 'P2PShare-Setup.exe'
const MAX_METADATA_BYTES = 1024 * 1024
const MAX_INSTALLER_BYTES = 500 * 1024 * 1024

function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-rc(\d+))?$/.exec(String(value))
  if (!match) throw new Error('Unsupported release version')
  return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] ? Number(match[4]) : 1_000_000]
}

function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index]
  }
  return 0
}

function selectRelease(releases, currentVersion) {
  const candidates = []
  for (const release of Array.isArray(releases) ? releases : []) {
    if (!release || release.draft) continue
    try {
      if (compareVersions(release.tag_name, currentVersion) <= 0) continue
    } catch { continue }
    for (const asset of Array.isArray(release.assets) ? release.assets : []) {
      const digest = asset?.digest
      const url = asset?.browser_download_url
      const size = asset?.size
      if (asset?.name !== ASSET_NAME || !/^sha256:[0-9a-f]{64}$/.test(digest || '')) continue
      if (typeof url !== 'string' || !url.startsWith(RELEASE_PREFIX)) continue
      if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_INSTALLER_BYTES) continue
      candidates.push({ tag: release.tag_name, url, digest: digest.slice(7), size })
    }
  }
  return candidates.sort((a, b) => compareVersions(b.tag, a.tag))[0] || null
}

function openHttps(url, redirects = 0) {
  if (!String(url).startsWith('https://')) return Promise.reject(new Error('Insecure update URL'))
  if (redirects > 6) return Promise.reject(new Error('Too many update redirects'))
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: { 'User-Agent': 'P2PShare-updater', Accept: 'application/vnd.github+json' },
      timeout: 30_000,
    }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        const location = response.headers.location
        response.resume()
        if (!location) return reject(new Error('Missing update redirect'))
        return resolve(openHttps(new URL(location, url).href, redirects + 1))
      }
      if (response.statusCode !== 200) {
        response.resume()
        return reject(new Error(`Update server returned ${response.statusCode}`))
      }
      resolve(response)
    })
    request.on('timeout', () => request.destroy(new Error('Update request timed out')))
    request.on('error', reject)
  })
}

async function readBounded(stream, limit) {
  const chunks = []
  let total = 0
  for await (const chunk of stream) {
    total += chunk.length
    if (total > limit) throw new Error('Update metadata is too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

class AppUpdater {
  constructor(app) {
    this.app = app
    this.release = null
    this.installer = null
  }

  info() {
    return { version: this.app.getVersion(), packaged: this.app.isPackaged, platform: process.platform }
  }

  async check() {
    const stream = await openHttps(API)
    const releases = JSON.parse((await readBounded(stream, MAX_METADATA_BYTES)).toString('utf8'))
    this.release = selectRelease(releases, this.app.getVersion())
    this.installer = null
    return this.release
  }

  async download() {
    if (!this.release) throw new Error('Check for an update first')
    if (!this.app.isPackaged || process.platform !== 'win32') {
      throw new Error('Source checkouts update with git pull; install the Windows release once for in-app updates')
    }
    const directory = path.join(this.app.getPath('userData'), 'updates')
    await fsp.mkdir(directory, { recursive: true })
    const target = path.join(directory, ASSET_NAME)
    const partial = `${target}.partial`
    await fsp.rm(partial, { force: true })
    const hash = createHash('sha256')
    let total = 0
    try {
      const input = await openHttps(this.release.url)
      const verifier = new Transform({
        transform: (chunk, _encoding, callback) => {
          total += chunk.length
          if (total > this.release.size || total > MAX_INSTALLER_BYTES) return callback(new Error('Installer size mismatch'))
          hash.update(chunk)
          callback(null, chunk)
        },
      })
      await pipeline(input, verifier, fs.createWriteStream(partial, { flags: 'wx' }))
      if (total !== this.release.size || hash.digest('hex') !== this.release.digest) {
        throw new Error('Installer verification failed; nothing was installed')
      }
      await fsp.rm(target, { force: true })
      await fsp.rename(partial, target)
      this.installer = target
      return { tag: this.release.tag }
    } finally {
      await fsp.rm(partial, { force: true })
    }
  }

  install() {
    if (!this.installer || !this.app.isPackaged || process.platform !== 'win32') {
      throw new Error('No verified Windows update is ready')
    }
    spawn(this.installer, ['/S', '/CLOSEAPPLICATIONS'], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
    setImmediate(() => this.app.quit())
    return true
  }
}

module.exports = { AppUpdater, ASSET_NAME, RELEASE_PREFIX, compareVersions, parseVersion, selectRelease }
