import { createConnection } from 'node:net'
import { spawn as spawnChildProcess } from 'node:child_process'
import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'

import { app, type BrowserWindow } from 'electron'
import {
  DshRuntime,
  type DshRuntimeExit,
  type DshRuntimeReady,
  resolveDshBin,
} from '@dsh-workbench/runtime'

import { prepareDesktopCoreContribution } from './contribution.js'
import type { PackageSmokeOptions } from './smoke-options.js'
import {
  createWorkbenchBrowserWindow,
  WORKBENCH_WEB_PREFERENCES,
} from './window.js'

const require = createRequire(import.meta.url)
const MAX_PTY_OUTPUT_BYTES = 16 * 1024
const PTY_TIMEOUT_MS = 10_000
const TASKKILL_TIMEOUT_MS = 5_000
const WINDOW_LOAD_TIMEOUT_MS = 20_000
const PTY_SUCCESS_MARKER = 'DSH_WORKBENCH_PTY_OK'

interface Disposable {
  dispose(): void
}

interface NodePtyProcess {
  kill(signal?: string): void
  onData(listener: (data: string) => void): Disposable
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): Disposable
  pid: number
}

interface NodePtyModule {
  spawn(
    file: string,
    args: string[],
    options: {
      cols: number
      cwd: string
      env: Record<string, string>
      name: string
      rows: number
    },
  ): NodePtyProcess
}

interface RendererSecurityProbe {
  bridgeContextIsolated?: unknown
  bridgeSandboxed?: unknown
  documentReadyState: string
  href: string
  processType: string
  requireType: string
}

interface PackageSmokeReport {
  app: {
    arch: string
    electronVersion: string | undefined
    execPath: string
    isPackaged: boolean
    platform: NodeJS.Platform
    resourcesPath: string
    userDataPath: string
    version: string
  }
  error?: {
    message: string
    name: string
  }
  runtime: {
    desktopCoreEntry?: string
    dshBin?: string
    dshVersion?: string
    cwd?: string
    exitCode?: number | null
    expectedExit?: boolean
    httpBootPayload?: boolean
    pid?: number
    pidAliveAfterStop?: boolean
    portOpenAfterStop?: boolean
    ptyExitCode?: number
    ptyOutputVerified?: boolean
    ptyPidAliveAfterExit?: boolean
    url?: string
    windowLoaded?: boolean
    windowSecurityVerified?: boolean
  }
  schemaVersion: 1
  status: 'failed' | 'passed'
}

function assertSmoke(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function isPathInside(parent: string, child: string): boolean {
  const pathFromParent = relative(parent, child)
  return pathFromParent !== ''
    && !pathFromParent.startsWith(`..${sep}`)
    && pathFromParent !== '..'
    && !isAbsolute(pathFromParent)
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function isPortOpen(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port })
    let settled = false
    const finish = (open: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(open)
    }

    socket.setTimeout(750)
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.once('timeout', () => finish(false))
  })
}

async function writeReport(reportPath: string, report: PackageSmokeReport): Promise<void> {
  await mkdir(dirname(reportPath), { mode: 0o700, recursive: true })
  const temporaryPath = `${reportPath}.tmp-${process.pid}`
  await writeFile(temporaryPath, `${JSON.stringify(report, undefined, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  await rename(temporaryPath, reportPath)
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function stringEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter((entry): entry is [string, string] => (
      typeof entry[1] === 'string'
    )),
  )
}

async function forceKillPtyProcessTree(pty: NodePtyProcess): Promise<void> {
  if (process.platform === 'win32') {
    await new Promise<void>((resolve, reject) => {
      const killer = spawnChildProcess(
        'taskkill.exe',
        ['/pid', String(pty.pid), '/t', '/f'],
        { stdio: 'ignore' },
      )
      let settled = false
      const finish = (error?: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        if (error) reject(error)
        else resolve()
      }
      const timeout = setTimeout(() => {
        killer.kill()
        finish(new Error(`taskkill timed out after ${TASKKILL_TIMEOUT_MS} ms`))
      }, TASKKILL_TIMEOUT_MS)
      killer.once('error', finish)
      killer.once('close', (code, signal) => {
        if (code === 0 || !isProcessAlive(pty.pid)) finish()
        else finish(new Error(`taskkill exited with ${code ?? signal ?? 'an unknown status'}`))
      })
    })
    return
  }

  try {
    process.kill(-pty.pid, 'SIGKILL')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return
    pty.kill('SIGKILL')
  }
}

async function runPtySmoke(cwd: string): Promise<{
  exitCode: number
  outputVerified: boolean
  pidAliveAfterExit: boolean
}> {
  const nodePty = require('node-pty') as NodePtyModule
  const shell = process.platform === 'win32'
    ? process.env.ComSpec ?? 'cmd.exe'
    : '/bin/sh'
  const args = process.platform === 'win32'
    ? ['/d', '/s', '/c', `echo ${PTY_SUCCESS_MARKER}`]
    : ['-c', `printf ${PTY_SUCCESS_MARKER}`]
  const pty = nodePty.spawn(shell, args, {
    cols: 80,
    cwd,
    env: stringEnvironment(process.env),
    name: 'xterm-color',
    rows: 24,
  })
  let output = ''

  const exit = await new Promise<{ exitCode: number; signal?: number }>((resolve, reject) => {
    let dataSubscription: Disposable | undefined
    let exitSubscription: Disposable | undefined
    let forceTimer: NodeJS.Timeout | undefined
    let forceExitTimer: NodeJS.Timeout | undefined
    let settled = false
    let timedOut = false

    const cleanup = (): void => {
      clearTimeout(timeout)
      if (forceTimer) clearTimeout(forceTimer)
      if (forceExitTimer) clearTimeout(forceExitTimer)
      dataSubscription?.dispose()
      exitSubscription?.dispose()
    }
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const timeout = setTimeout(() => {
      timedOut = true
      try {
        pty.kill()
      } catch {
        // The process may have exited between the timer firing and kill().
      }
      forceTimer = setTimeout(() => {
        void forceKillPtyProcessTree(pty).then(
          () => {
            if (settled) return
            forceExitTimer = setTimeout(() => {
              fail(new Error('Packaged PTY did not exit after forced tree termination'))
            }, 2_000)
          },
          (error: unknown) => fail(asError(error)),
        )
      }, 2_000)
    }, PTY_TIMEOUT_MS)

    dataSubscription = pty.onData((data) => {
      output = `${output}${data}`.slice(-MAX_PTY_OUTPUT_BYTES)
    })
    exitSubscription = pty.onExit((event) => {
      if (settled) return
      settled = true
      cleanup()
      if (timedOut) {
        reject(new Error(`Packaged PTY timed out after ${PTY_TIMEOUT_MS} ms`))
      } else {
        resolve(event)
      }
    })
  })

  const pidAliveAfterExit = isProcessAlive(pty.pid)
  assertSmoke(exit.exitCode === 0, `Packaged PTY exited with code ${exit.exitCode}`)
  assertSmoke(output.includes(PTY_SUCCESS_MARKER), 'Packaged PTY output marker is missing')
  assertSmoke(!pidAliveAfterExit, `Packaged PTY process ${pty.pid} is still alive after exit`)
  return { exitCode: exit.exitCode, outputVerified: true, pidAliveAfterExit }
}

function waitForWindowRenderer(window: BrowserWindow, url: string): Promise<RendererSecurityProbe> {
  return new Promise((resolve, reject) => {
    const debuggerClient = window.webContents.debugger
    let settled = false
    let probeInFlight = false
    const finish = (error?: Error, probe?: RendererSecurityProbe): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearInterval(probeInterval)
      window.webContents.removeListener('did-fail-load', handleFailedLoad)
      window.webContents.removeListener('render-process-gone', handleRendererGone)
      window.removeListener('closed', handleClosed)
      window.removeListener('unresponsive', handleUnresponsive)
      if (debuggerClient.isAttached()) debuggerClient.detach()
      if (error) reject(error)
      else if (probe) resolve(probe)
      else reject(new Error('Packaged renderer probe completed without a result'))
    }
    const handleClosed = (): void => finish(new Error('Packaged BrowserWindow closed during load'))
    const handleFailedLoad = (
      _event: Electron.Event,
      errorCode: number,
      errorDescription: string,
      validatedUrl: string,
      isMainFrame: boolean,
    ): void => {
      if (!isMainFrame) return
      finish(new Error(
        `Packaged BrowserWindow failed to load ${validatedUrl} (${errorCode}: ${errorDescription})`,
      ))
    }
    const handleRendererGone = (
      _event: Electron.Event,
      details: Electron.RenderProcessGoneDetails,
    ): void => finish(new Error(`Packaged renderer exited: ${details.reason}`))
    const handleUnresponsive = (): void => finish(new Error('Packaged BrowserWindow became unresponsive'))
    const probeRenderer = (): void => {
      if (settled || probeInFlight) return
      try {
        if (new URL(window.webContents.getURL()).origin !== url) return
      } catch {
        return
      }

      probeInFlight = true
      void debuggerClient.sendCommand('Runtime.evaluate', {
        expression: `({
          bridgeContextIsolated: globalThis.dshWorkbench?.security?.contextIsolated,
          bridgeSandboxed: globalThis.dshWorkbench?.security?.sandboxed,
          documentReadyState: document.readyState,
          href: globalThis.location.href,
          processType: typeof globalThis.process,
          requireType: typeof globalThis.require,
        })`,
        returnByValue: true,
      }).then(
        (response: { result?: { value?: RendererSecurityProbe } }) => {
          const probe = response.result?.value
          if (!probe) {
            probeInFlight = false
            return
          }
          if (probe.documentReadyState === 'loading') {
            probeInFlight = false
            return
          }
          finish(undefined, probe)
        },
        () => {
          probeInFlight = false
        },
      )
    }
    const timer = setTimeout(() => {
      finish(new Error(`Packaged BrowserWindow load timed out after ${WINDOW_LOAD_TIMEOUT_MS} ms`))
    }, WINDOW_LOAD_TIMEOUT_MS)
    const probeInterval = setInterval(probeRenderer, 250)

    try {
      debuggerClient.attach('1.3')
    } catch (error) {
      finish(asError(error))
      return
    }
    window.webContents.on('did-fail-load', handleFailedLoad)
    window.webContents.on('render-process-gone', handleRendererGone)
    window.once('closed', handleClosed)
    window.once('unresponsive', handleUnresponsive)
    void window.loadURL(url).catch((error: unknown) => finish(asError(error)))
  })
}

function writeStdout(message: string): Promise<void> {
  return new Promise((resolve) => {
    process.stdout.write(message, () => resolve())
  })
}

export async function runPackageSmoke(options: PackageSmokeOptions): Promise<number> {
  const report: PackageSmokeReport = {
    app: {
      arch: process.arch,
      electronVersion: process.versions.electron,
      execPath: process.execPath,
      isPackaged: app.isPackaged,
      platform: process.platform,
      resourcesPath: process.resourcesPath,
      userDataPath: app.getPath('userData'),
      version: app.getVersion(),
    },
    runtime: {},
    schemaVersion: 1,
    status: 'failed',
  }

  let failure: Error | undefined
  let runtime: DshRuntime | undefined
  let window: BrowserWindow | undefined
  let ready: DshRuntimeReady | undefined
  let exitEvent: DshRuntimeExit | undefined
  let resolveExit: ((event: DshRuntimeExit) => void) | undefined
  const exitPromise = new Promise<DshRuntimeExit>((resolve) => {
    resolveExit = resolve
  })

  const captureFailure = (error: unknown): void => {
    const next = asError(error)
    failure = failure
      ? new Error(`${failure.message}; cleanup: ${next.message}`, { cause: failure })
      : next
  }

  try {
    assertSmoke(app.isPackaged, 'Smoke mode must run from a packaged application')
    assertSmoke(options.userDataPath === app.getPath('userData'), 'Smoke user-data isolation was not applied')

    const packagedAppRoot = await realpath(join(process.resourcesPath, 'app'))
    const workspacePath = join(options.userDataPath, 'workspace')
    await mkdir(workspacePath, { mode: 0o700, recursive: true })
    report.runtime.cwd = workspacePath

    const dshBin = await realpath(resolveDshBin())
    const desktopCore = await prepareDesktopCoreContribution(options.userDataPath)
    const desktopCoreEntry = await realpath(desktopCore.entry)
    assertSmoke(isPathInside(packagedAppRoot, dshBin), 'DSH executable escaped the packaged application')
    assertSmoke(
      isPathInside(packagedAppRoot, desktopCoreEntry),
      'Desktop Core entry escaped the packaged application',
    )

    const dshPackage = JSON.parse(await readFile(join(dirname(dirname(dshBin)), 'package.json'), 'utf8')) as {
      version?: unknown
    }
    assertSmoke(typeof dshPackage.version === 'string', 'Packaged DSH version is missing')
    report.runtime.dshBin = dshBin
    report.runtime.dshVersion = dshPackage.version
    report.runtime.desktopCoreEntry = desktopCoreEntry

    runtime = new DshRuntime({
      cwd: workspacePath,
      env: {
        ...process.env,
        DSH_HOME: join(options.userDataPath, 'dsh'),
      },
      onExit: (event) => {
        exitEvent = event
        resolveExit?.(event)
      },
      patchFiles: [desktopCore.patch],
    })
    ready = await runtime.start()
    report.runtime.pid = ready.pid
    report.runtime.url = ready.url

    const response = await fetch(ready.url, { signal: AbortSignal.timeout(10_000) })
    const html = await response.text()
    assertSmoke(response.ok, `Packaged DSH returned HTTP ${response.status}`)
    assertSmoke(html.includes('__DSH_BOOT__'), 'Packaged DSH page is missing its boot payload')
    report.runtime.httpBootPayload = true

    const ptyResult = await runPtySmoke(workspacePath)
    report.runtime.ptyExitCode = ptyResult.exitCode
    report.runtime.ptyOutputVerified = ptyResult.outputVerified
    report.runtime.ptyPidAliveAfterExit = ptyResult.pidAliveAfterExit

    window = createWorkbenchBrowserWindow(ready, {
      partition: `dsh-workbench-smoke-${process.pid}`,
      show: false,
    })
    const rendererSecurity = await Promise.race([
      waitForWindowRenderer(window, ready.url),
      exitPromise.then((event) => {
        throw new Error(`Packaged DSH exited during window load (code ${event.code ?? event.signal ?? 'unknown'})`)
      }),
    ])
    assertSmoke(new URL(window.webContents.getURL()).origin === ready.url, 'BrowserWindow loaded an unexpected origin')
    assertSmoke(WORKBENCH_WEB_PREFERENCES.contextIsolation === true, 'BrowserWindow context isolation is disabled')
    assertSmoke(WORKBENCH_WEB_PREFERENCES.nodeIntegration === false, 'BrowserWindow Node integration is enabled')
    assertSmoke(WORKBENCH_WEB_PREFERENCES.sandbox === true, 'BrowserWindow sandbox is disabled')
    assertSmoke(WORKBENCH_WEB_PREFERENCES.webSecurity === true, 'BrowserWindow web security is disabled')
    assertSmoke(new URL(rendererSecurity.href).origin === ready.url, 'Renderer probe used an unexpected origin')
    assertSmoke(
      ['interactive', 'complete'].includes(rendererSecurity.documentReadyState),
      `Renderer document is only ${rendererSecurity.documentReadyState}`,
    )
    assertSmoke(rendererSecurity.bridgeContextIsolated === true, 'Preload context isolation probe failed')
    assertSmoke(rendererSecurity.bridgeSandboxed === true, 'Preload sandbox probe failed')
    assertSmoke(rendererSecurity.processType === 'undefined', 'Renderer exposed the Node process global')
    assertSmoke(rendererSecurity.requireType === 'undefined', 'Renderer exposed the Node require global')
    report.runtime.windowLoaded = true
    report.runtime.windowSecurityVerified = true
  } catch (error) {
    captureFailure(error)
  } finally {
    if (window && !window.isDestroyed()) window.destroy()
    if (runtime) {
      try {
        await runtime.stop()
      } catch (error) {
        captureFailure(error)
      }
    }
  }

  if (ready) {
    report.runtime.exitCode = exitEvent?.code
    report.runtime.expectedExit = exitEvent?.expected
    report.runtime.pidAliveAfterStop = isProcessAlive(ready.pid)
    const url = new URL(ready.url)
    report.runtime.portOpenAfterStop = await isPortOpen(url.hostname, Number(url.port))

    if (!exitEvent?.expected || exitEvent.code !== 0) {
      captureFailure(new Error('Packaged DSH did not report a graceful zero-code exit'))
    }
    if (report.runtime.pidAliveAfterStop) {
      captureFailure(new Error(`Packaged DSH process ${ready.pid} is still alive after shutdown`))
    }
    if (report.runtime.portOpenAfterStop) {
      captureFailure(new Error(`Packaged DSH port ${url.port} is still accepting connections`))
    }
  }

  if (failure) {
    report.error = { message: failure.message, name: failure.name }
  } else {
    report.status = 'passed'
  }

  try {
    await writeReport(options.reportPath, report)
  } catch (error) {
    console.error('Failed to write packaged smoke report:', error)
    return 1
  }

  if (failure) {
    console.error('Packaged smoke failed:', failure)
    return 1
  }

  await writeStdout('DSH_WORKBENCH_PACKAGE_SMOKE_OK\n')
  return 0
}
