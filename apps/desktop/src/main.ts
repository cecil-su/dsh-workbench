import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { app, BrowserWindow, dialog, shell } from 'electron'
import {
  DshRuntime,
  DshRuntimeError,
  type DshRuntimeExit,
  type DshRuntimeReady,
} from '@dsh-workbench/runtime'

import { prepareDesktopCoreContribution } from './contribution.js'
import { isAllowedNavigation, isExternalHttpUrl } from './navigation.js'

let mainWindow: BrowserWindow | undefined
let quitting = false
let recoveryPromise: Promise<void> | undefined
let runtime: DshRuntime | undefined
let runtimeInitialization: Promise<DshRuntime> | undefined
let windowOpenPromise: Promise<void> | undefined
let windowReplacementInProgress = false

function describeError(error: unknown): string {
  if (error instanceof DshRuntimeError) {
    return `${error.message} (${error.stage})`
  }
  if (error instanceof Error) return error.message
  return String(error)
}

function logRuntimeError(message: string, error: unknown): void {
  console.error(message, error)
  if (error instanceof DshRuntimeError && error.output) {
    console.error('Recent DSH output:\n%s', error.output)
  }
}

function openExternalUrl(url: string, allowedOrigin: string): void {
  if (!isExternalHttpUrl(url, allowedOrigin)) return
  void shell.openExternal(url).catch((error: unknown) => {
    console.error('Failed to open external URL:', error)
  })
}

async function promptForRetry(message: string, error: unknown): Promise<boolean> {
  const options = {
    type: 'error' as const,
    title: 'DSH Workbench',
    message,
    detail: describeError(error),
    buttons: ['Retry', 'Quit'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  }

  const window = mainWindow
  const result = window && !window.isDestroyed()
    ? await dialog.showMessageBox(window, options)
    : await dialog.showMessageBox(options)
  return result.response === 0
}

function scheduleUnexpectedRuntimeExit(event: DshRuntimeExit): void {
  if (event.expected || quitting || recoveryPromise) return

  const operation = recoverFromUnexpectedRuntimeExit(event)
  recoveryPromise = operation
  void operation.then(
    () => {
      if (recoveryPromise === operation) recoveryPromise = undefined
    },
    (error: unknown) => {
      if (recoveryPromise === operation) recoveryPromise = undefined
      void handleFatalError(error)
    },
  )
}

async function getRuntime(): Promise<DshRuntime> {
  if (runtime) return runtime
  if (runtimeInitialization) return runtimeInitialization

  const operation = (async () => {
    const userDataPath = app.getPath('userData')
    const desktopCore = await prepareDesktopCoreContribution(userDataPath)
    const instance = new DshRuntime({
      env: {
        ...process.env,
        DSH_HOME: join(userDataPath, 'dsh'),
      },
      onExit: scheduleUnexpectedRuntimeExit,
      patchFiles: [desktopCore.patch],
    })
    runtime = instance
    return instance
  })()

  runtimeInitialization = operation
  void operation.then(
    () => {
      if (runtimeInitialization === operation) runtimeInitialization = undefined
    },
    () => {
      if (runtimeInitialization === operation) runtimeInitialization = undefined
    },
  )
  return operation
}

function configureWindowSecurity(window: BrowserWindow, allowedOrigin: string): void {
  const dshSession = window.webContents.session
  dshSession.setPermissionCheckHandler(() => false)
  dshSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false)
  })

  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url, allowedOrigin)
    return { action: 'deny' }
  })

  const guardNavigation = (event: Electron.Event, url: string): void => {
    if (isAllowedNavigation(url, allowedOrigin)) return
    event.preventDefault()
    openExternalUrl(url, allowedOrigin)
  }
  window.webContents.on('will-navigate', guardNavigation)
  window.webContents.on('will-redirect', guardNavigation)
}

async function createBrowserWindow(ready: DshRuntimeReady): Promise<BrowserWindow> {
  const allowedOrigin = new URL(ready.url).origin
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
      partition: 'persist:dsh-workbench',
      sandbox: true,
      webSecurity: true,
      preload: fileURLToPath(new URL('./preload.js', import.meta.url)),
    },
  })

  mainWindow = window
  window.once('closed', () => {
    if (mainWindow === window) mainWindow = undefined
  })
  configureWindowSecurity(window, allowedOrigin)

  try {
    await window.loadURL(ready.url)
    windowReplacementInProgress = false
    return window
  } catch (error) {
    windowReplacementInProgress = true
    window.destroy()
    throw error
  }
}

async function performOpenMainWindowWithRecovery(): Promise<void> {
  const existing = mainWindow
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore()
    existing.show()
    existing.focus()
    return
  }

  while (!quitting) {
    try {
      const host = await getRuntime()
      const ready = await host.start()
      await createBrowserWindow(ready)
      return
    } catch (error) {
      logRuntimeError('Failed to open DSH Workbench:', error)
      try {
        await runtime?.stop()
      } catch (stopError) {
        logRuntimeError('Failed to clean up DSH after startup:', stopError)
        await handleFatalError(stopError)
        return
      }

      if (!(await promptForRetry('DeepSeek Harness could not start.', error))) {
        windowReplacementInProgress = false
        app.quit()
        return
      }
    }
  }
}

function openMainWindowWithRecovery(): Promise<void> {
  if (windowOpenPromise) return windowOpenPromise

  const operation = performOpenMainWindowWithRecovery()
  windowOpenPromise = operation
  void operation.then(
    () => {
      if (windowOpenPromise === operation) windowOpenPromise = undefined
    },
    () => {
      if (windowOpenPromise === operation) windowOpenPromise = undefined
    },
  )
  return operation
}

async function recoverFromUnexpectedRuntimeExit(event: DshRuntimeExit): Promise<void> {
  console.error(
    'DSH exited unexpectedly (code %s, signal %s).\n%s',
    event.code ?? 'none',
    event.signal ?? 'none',
    event.output,
  )

  const retry = await promptForRetry(
    'DeepSeek Harness stopped unexpectedly.',
    new Error(`Exit code ${event.code ?? 'none'}, signal ${event.signal ?? 'none'}`),
  )
  if (!retry) {
    app.quit()
    return
  }

  const window = mainWindow
  windowReplacementInProgress = true
  if (window && !window.isDestroyed()) window.destroy()
  await openMainWindowWithRecovery()
}

async function handleFatalError(error: unknown): Promise<void> {
  if (quitting) return
  quitting = true
  logRuntimeError('Fatal DSH Workbench error:', error)

  try {
    await runtime?.stop()
  } catch (stopError) {
    logRuntimeError('Failed to stop DSH during fatal shutdown:', stopError)
  }

  dialog.showErrorBox('DSH Workbench', describeError(error))
  app.exit(1)
}

function focusMainWindow(): void {
  const window = mainWindow
  if (!window || window.isDestroyed()) return
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}

function installApplicationLifecycle(): void {
  app.on('second-instance', focusMainWindow)

  void app.whenReady().then(openMainWindowWithRecovery).catch((error: unknown) => {
    void handleFatalError(error)
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length > 0) return
    void openMainWindowWithRecovery().catch((error: unknown) => {
      void handleFatalError(error)
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' && !windowReplacementInProgress) app.quit()
  })

  app.on('before-quit', (event) => {
    if (quitting) return

    event.preventDefault()
    quitting = true
    void (runtime?.stop() ?? Promise.resolve()).catch((error: unknown) => {
      logRuntimeError('Failed to stop DSH during application shutdown:', error)
    }).finally(() => app.quit())
  })
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  installApplicationLifecycle()
}
