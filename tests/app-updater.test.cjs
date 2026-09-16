const assert = require('node:assert/strict')
const fs = require('node:fs')
const { test } = require('node:test')
const { ASSET_NAME, RELEASE_PREFIX, compareVersions, parseVersion, selectRelease } = require('../electron/AppUpdater.cjs')

function asset(overrides = {}) {
  return {
    name: ASSET_NAME,
    size: 1024,
    digest: `sha256:${'a'.repeat(64)}`,
    browser_download_url: `${RELEASE_PREFIX}v1.1.0/${ASSET_NAME}`,
    ...overrides,
  }
}

test('release versions order stable builds after release candidates', () => {
  assert.deepEqual(parseVersion('v2.3.4-rc5'), [2, 3, 4, 5])
  assert.ok(compareVersions('1.1.0', '1.1.0-rc99') > 0)
  assert.ok(compareVersions('1.2.0-rc1', '1.1.9') > 0)
})

test('update selection accepts only bounded GitHub assets with a digest', () => {
  const releases = [
    { tag_name: 'v1.1.0-rc2', assets: [asset()] },
    { tag_name: 'v1.1.0', assets: [asset()] },
    { tag_name: 'v9.0.0', assets: [asset({ digest: null })] },
    { tag_name: 'v8.0.0', assets: [asset({ browser_download_url: 'https://example.com/update.exe' })] },
    { tag_name: 'v7.0.0', draft: true, assets: [asset()] },
  ]
  assert.equal(selectRelease(releases, '1.0.0').tag, 'v1.1.0')
  assert.equal(selectRelease(releases, '1.1.0'), null)
})

test('desktop and Android release versions stay aligned', () => {
  const desktop = JSON.parse(fs.readFileSync('package.json', 'utf8')).version
  const android = fs.readFileSync('android/app/build.gradle.kts', 'utf8')
  assert.match(android, new RegExp(`versionName = "${desktop.replaceAll('.', '\\.')}"`))
})
