const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const names = process.platform === 'win32'
  ? ['p2pshare_native.dll']
  : process.platform === 'darwin'
    ? ['libp2pshare_native.dylib']
    : ['libp2pshare_native.so']
const source = names
  .map((name) => path.join(__dirname, 'target', 'release', name))
  .find((candidate) => fs.existsSync(candidate))

if (!source) throw new Error('Native library was not produced by Cargo')
const destination = path.join(root, 'electron', 'p2pshare_native.node')
fs.copyFileSync(source, destination)
console.log(`Installed ${path.relative(root, destination)}`)
