import { app, BrowserWindow, dialog } from 'electron'
import {
  DshRuntime,
  DshRuntimeError,
} from '@dsh-workbench/runtime'

import { prepareDesktopCoreContribution } from './contribution.js'
import { runPackageSmoke } from './package-smoke.js'
import { buildProfileEnvironment } from './profile-environment.js'
import { prepareProfileModuleFallback } from './profile-modules.js'
import {
  ProfileRuntimeController,
  type ProfileRuntimeSession,
  type UnexpectedProfileRuntimeExit,
} from './profile-runtime.js'
import { ProfileStore } from './profile-store.js'
import {
  installProfileIpc,
  ProfileTransitionCoordinator,
  sendProfileContext,
} from './profiles-ipc.js'
import { parsePackageSmokeOptions } from './smoke-options.js'
import {
  createWorkbenchBrowserWindow,
  profileSessionPartition,
} from './window.js'

let mainWindow: BrowserWindow | undefined
let quitting = false
let recoveryPromise: Promise<void> | undefined
let runtimeController: ProfileRuntimeController | undefined
let profileTransitions: ProfileTransitionCoordinator | undefined
let profileTransitionInitialization: Promise<ProfileTransitionCoordinator> | undefined
let uninstallProfileIpc: (() => void) | undefined
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

function scheduleUnexpectedRuntimeExit(exit: UnexpectedProfileRuntimeExit): void {
  if (exit.event.expected || quitting || recoveryPromise) return

  const operation = recoverFromUnexpectedRuntimeExit(exit)
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

async function getProfileTransitions(): Promise<ProfileTransitionCoordinator> {
  if (profileTransitions) return profileTransitions
  if (profileTransitionInitialization) return profileTransitionInitialization

  const operation = (async () => {
    const userDataPath = app.getPath('userData')
    const profiles = new ProfileStore(userDataPath)
    await profiles.initialize()
    const desktopCore = await prepareDesktopCoreContribution(userDataPath)
    const controller = new ProfileRuntimeController(
      profiles,
      (active, onExit) => {
        prepareProfileModuleFallback(active.paths.dshHome)
        return new DshRuntime({
          cwd: active.paths.workspace,
          env: buildProfileEnvironment(process.env, active.paths.dshHome),
          onExit,
          patchFiles: [desktopCore.patch],
        })
      },
      scheduleUnexpectedRuntimeExit,
    )
    const transitions = new ProfileTransitionCoordinator(controller, activateBrowserWindow)
    const uninstall = installProfileIpc({
      confirmArchive: async (profile) => {
        const window = mainWindow
        const options = {
          type: 'warning' as const,
          title: 'Archive profile',
          message: `Archive “${profile.name}”?`,
          detail: 'The profile can be restored later. Its DSH data will not be deleted.',
          buttons: ['Archive', 'Cancel'],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
        }
        const result = window && !window.isDestroyed()
          ? await dialog.showMessageBox(window, options)
          : await dialog.showMessageBox(options)
        return result.response === 0
      },
      controller,
      getWindow: () => mainWindow,
      selectProfile: (profileId) => transitions.select(profileId),
      store: profiles,
    })
    runtimeController = controller
    profileTransitions = transitions
    uninstallProfileIpc = uninstall
    return transitions
  })()

  profileTransitionInitialization = operation
  void operation.then(
    () => {
      if (profileTransitionInitialization === operation) profileTransitionInitialization = undefined
    },
    () => {
      if (profileTransitionInitialization === operation) profileTransitionInitialization = undefined
    },
  )
  return operation
}

async function activateBrowserWindow(session: ProfileRuntimeSession): Promise<void> {
  const previous = mainWindow
  windowReplacementInProgress = true
  const window = createWorkbenchBrowserWindow(session.ready, {
    partition: profileSessionPartition(session.profile.id),
  })
  // The renderer may mount a persisted Settings route as soon as dom-ready
  // fires. Make the replacement authoritative before sending its IPC context.
  mainWindow = window

  window.once('closed', () => {
    if (mainWindow === window) mainWindow = undefined
  })
  window.webContents.once('dom-ready', () => sendProfileContext(window, session))
  try {
    await window.loadURL(session.ready.url)
    if (previous && previous !== window && !previous.isDestroyed()) previous.destroy()
  } catch (error) {
    if (mainWindow === window) mainWindow = previous
    window.destroy()
    throw error
  } finally {
    windowReplacementInProgress = false
  }
}

function installPackageSmokeLifecycle(
  options: NonNullable<ReturnType<typeof parsePackageSmokeOptions>>,
): void {
  app.on('window-all-closed', () => {})
  void app.whenReady().then(async () => {
    const exitCode = await runPackageSmoke(options)
    app.exit(exitCode)
  }).catch((error: unknown) => {
    console.error('Packaged smoke lifecycle failed:', error)
    app.exit(1)
  })
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
      const transitions = await getProfileTransitions()
      await transitions.startActive()
      return
    } catch (error) {
      logRuntimeError('Failed to open DSH Workbench:', error)
      try {
        await (profileTransitions?.stop() ?? runtimeController?.stop())
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

async function recoverFromUnexpectedRuntimeExit(exit: UnexpectedProfileRuntimeExit): Promise<void> {
  const { event, session } = exit
  console.error(
    'DSH for profile %s exited unexpectedly (code %s, signal %s).\n%s',
    session.profile.id,
    event.code ?? 'none',
    event.signal ?? 'none',
    event.output,
  )

  const transitions = await getProfileTransitions()
  const recovered = await transitions.recover(session, () => promptForRetry(
    'DeepSeek Harness stopped unexpectedly.',
    new Error(`Exit code ${event.code ?? 'none'}, signal ${event.signal ?? 'none'}`),
  ))
  if (!recovered && !quitting) app.quit()
}

async function handleFatalError(error: unknown): Promise<void> {
  if (quitting) return
  quitting = true
  logRuntimeError('Fatal DSH Workbench error:', error)

  try {
    await (profileTransitions?.shutdown() ?? runtimeController?.stop())
  } catch (stopError) {
    logRuntimeError('Failed to stop DSH during fatal shutdown:', stopError)
  }

  uninstallProfileIpc?.()
  uninstallProfileIpc = undefined
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
    uninstallProfileIpc?.()
    uninstallProfileIpc = undefined
    void (profileTransitions?.shutdown() ?? runtimeController?.stop() ?? Promise.resolve()).catch((error: unknown) => {
      logRuntimeError('Failed to stop DSH during application shutdown:', error)
    }).finally(() => app.quit())
  })
}

let packageSmokeOptions: ReturnType<typeof parsePackageSmokeOptions> = undefined
let packageSmokeArgumentError = false
try {
  packageSmokeOptions = parsePackageSmokeOptions(process.argv)
  if (packageSmokeOptions) {
    app.setPath('userData', packageSmokeOptions.userDataPath)
    // Copied unsigned macOS test bundles must not block on a user Keychain
    // consent prompt while exercising persistent profile partitions.
    if (process.platform === 'darwin') app.commandLine.appendSwitch('use-mock-keychain')
  }
} catch (error) {
  console.error('Invalid package smoke arguments:', error)
  packageSmokeArgumentError = true
}

if (packageSmokeArgumentError) {
  app.exit(1)
} else if (!app.requestSingleInstanceLock()) {
  app.quit()
} else if (packageSmokeOptions) {
  installPackageSmokeLifecycle(packageSmokeOptions)
} else {
  installApplicationLifecycle()
}
