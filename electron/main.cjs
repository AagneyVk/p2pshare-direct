const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { trustedSender } = require('./IpcPolicy.cjs')
const { app, BrowserWindow, ipcMain, dialog, clipboard } = require('electron')
const { NativeBridgeController } = require('./nativeBridge.cjs')
const { QuicBridgeController } = require('./QuicBridge.cjs')
const quicMode = process.argv.includes('--quic')

let mainWindow = null
let bridge = null
let trustedRendererUrl = ''
let currentTicket = ''

function registerIpc(channel, callback) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!trustedSender(event, mainWindow, trustedRendererUrl)) throw new Error('Untrusted IPC sender')
    return callback(event, ...args)
  })
}

function resolveRendererUrl() {
  const devUrl = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173'
  return devUrl
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 960,
    backgroundColor: '#0b0b0b',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      additionalArguments: quicMode ? ['--p2pshare-quic'] : [],
    },
  })

  bridge = quicMode ? new QuicBridgeController(app) : new NativeBridgeController(app)
  bridge.bindWindow(mainWindow)
  const windowBridge = bridge
  mainWindow.on('closed', () => { windowBridge.disconnect().catch(() => undefined) })
  const localRenderer = pathToFileURL(path.join(app.getAppPath(), 'dist', 'index.html')).href
  trustedRendererUrl = app.isPackaged || !process.env.VITE_DEV_SERVER_URL ? localRenderer : resolveRendererUrl()
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event, url) => { if (url !== trustedRendererUrl) event.preventDefault() })
  mainWindow.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))

  bridge.on('event', (payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('p2p-native:event', payload)
    }
  })

  if (app.isPackaged || !process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadFile(path.join(app.getAppPath(), 'dist', 'index.html'))
  } else mainWindow.loadURL(resolveRendererUrl()).catch(async () => {
    trustedRendererUrl = localRenderer
    const fallback = path.join(app.getAppPath(), 'dist', 'index.html')
    await mainWindow.loadFile(fallback)
  })
}

app.on('before-quit', () => { bridge?.disconnect().catch(() => undefined) })

registerIpc('p2p:save-received', async (_event, id) => {
  if (!quicMode || !mainWindow || _event.sender !== mainWindow.webContents || _event.senderFrame !== mainWindow.webContents.mainFrame) throw new Error('Unsupported request')
  const item = bridge.received.get(id)
  if (!item) throw new Error('Verified received file not found')
  const safeName = (item.name || 'received-file').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 120)
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    defaultPath: path.join(app.getPath('downloads'), safeName), title: 'Save verified received file',
  })
  if (!canceled && filePath) {
    const fs = require('node:fs/promises')
    await fs.copyFile(item.path, filePath, require('node:fs').constants.COPYFILE_EXCL)
  }
})

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

registerIpc('p2p:create-session', async () => {
  if (!bridge) throw new Error('Bridge not initialized')
  currentTicket = await bridge.createSession()
  return currentTicket
})

registerIpc('p2p:copy-ticket', async () => {
  if (!currentTicket) throw new Error('No current host ticket')
  clipboard.writeText(currentTicket)
})

registerIpc('p2p:join-session', async (_event, code) => {
  if (!bridge) throw new Error('Bridge not initialized')
  return bridge.joinSession(code)
})

registerIpc('p2p:send-message', async (_event, text) => {
  if (!bridge) throw new Error('Bridge not initialized')
  return bridge.sendMessage(text)
})

registerIpc('p2p:file-begin', async (_event, meta) => {
  if (!bridge) throw new Error('Bridge not initialized')
  const fileId = await bridge.beginFile(meta)
  return fileId
})

registerIpc('p2p:file-path', async (_event, payload) => {
  if (!bridge) throw new Error('Bridge not initialized')
  return bridge.sendFilePath(payload?.path, payload?.meta)
})

registerIpc('p2p:file-chunk', async (_event, payload) => {
  if (!bridge) throw new Error('Bridge not initialized')
  return bridge.sendFileChunk(payload.id, payload.seq, payload.chunk)
})

registerIpc('p2p:file-chunks', async (_event, payload) => {
  if (!bridge) throw new Error('Bridge not initialized')
  return bridge.sendFileChunks(payload.id, payload.chunks)
})

registerIpc('p2p:file-done', async (_event, payload) => {
  if (!bridge) throw new Error('Bridge not initialized')
  return bridge.finishFile(payload.id)
})

registerIpc('p2p:disconnect', async () => {
  currentTicket = ''
  if (!bridge) return
  return bridge.disconnect()
})
