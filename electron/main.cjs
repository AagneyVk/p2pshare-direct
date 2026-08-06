const path = require('node:path')
const { app, BrowserWindow, ipcMain } = require('electron')
const { NativeBridgeController } = require('./nativeBridge.cjs')

let mainWindow = null
let bridge = null

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
    },
  })

  bridge = new NativeBridgeController(app)
  bridge.bindWindow(mainWindow)

  bridge.on('event', (payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('p2p-native:event', payload)
    }
  })

  mainWindow.loadURL(resolveRendererUrl()).catch(async () => {
    const fallback = path.join(app.getAppPath(), 'dist', 'index.html')
    await mainWindow.loadFile(fallback)
  })
}

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

ipcMain.handle('p2p:create-session', async () => {
  if (!bridge) throw new Error('Bridge not initialized')
  return bridge.createSession()
})

ipcMain.handle('p2p:join-session', async (_event, code) => {
  if (!bridge) throw new Error('Bridge not initialized')
  return bridge.joinSession(code)
})

ipcMain.handle('p2p:send-message', async (_event, text) => {
  if (!bridge) throw new Error('Bridge not initialized')
  return bridge.sendMessage(text)
})

ipcMain.handle('p2p:file-begin', async (_event, meta) => {
  if (!bridge) throw new Error('Bridge not initialized')
  const fileId = await bridge.beginFile(meta)
  return fileId
})

ipcMain.handle('p2p:file-path', async (_event, payload) => {
  if (!bridge) throw new Error('Bridge not initialized')
  return bridge.sendFilePath(payload?.path, payload?.meta)
})

ipcMain.handle('p2p:file-chunk', async (_event, payload) => {
  if (!bridge) throw new Error('Bridge not initialized')
  return bridge.sendFileChunk(payload.id, payload.seq, payload.chunk)
})

ipcMain.handle('p2p:file-chunks', async (_event, payload) => {
  if (!bridge) throw new Error('Bridge not initialized')
  return bridge.sendFileChunks(payload.id, payload.chunks)
})

ipcMain.handle('p2p:file-done', async (_event, payload) => {
  if (!bridge) throw new Error('Bridge not initialized')
  return bridge.finishFile(payload.id)
})

ipcMain.handle('p2p:disconnect', async () => {
  if (!bridge) return
  return bridge.disconnect()
})
