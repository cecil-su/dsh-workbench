import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import { app, BrowserWindow, shell } from 'electron'
import { DshRuntime } from '@dsh-workbench/runtime'

import { prepareDesktopCoreContribution } from './contribution.js'

let runtime: DshRuntime | undefined
let quitting = false

function openExternalUrl(url: string): void {
  const protocol = new URL(url).protocol
  if (protocol === 'https:' || protocol === 'http:') {
    void shell.openExternal(url)
  }
}

async function createMainWindow(): Promise<BrowserWindow> {
  if (!runtime) {
    const userDataPath = app.getPath('userData')
    const desktopCore = await prepareDesktopCoreContribution(userDataPath)
    runtime = new DshRuntime({
      env: {
        ...process.env,
        DSH_HOME: join(userDataPath, 'dsh'),
      },
      patchFiles: [desktopCore.patch],
    })
  }
  await runtime.start()

  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 960,
    minHeight: 640,
    title: 'DSH Workbench',
    backgroundColor: '#111318',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      preload: fileURLToPath(new URL('./preload.js', import.meta.url)),
    },
  })

  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url)
    return { action: 'deny' }
  })

  window.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== new URL(runtime?.url ?? url).origin) {
      event.preventDefault()
      openExternalUrl(url)
    }
  })

  await window.loadURL(runtime.url)
  return window
}

app.whenReady().then(async () => {
  await createMainWindow()

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createMainWindow()
    }
  })
}).catch((error: unknown) => {
  console.error('Failed to start DSH Workbench:', error)
  app.exit(1)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', (event) => {
  if (quitting || !runtime) return

  event.preventDefault()
  quitting = true
  void runtime.stop().finally(() => app.quit())
})
