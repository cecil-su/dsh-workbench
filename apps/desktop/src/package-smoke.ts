import { createHash } from 'node:crypto'
import { createConnection } from 'node:net'
import { spawn as spawnChildProcess } from 'node:child_process'
import { access, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises'
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
import { buildProfileEnvironment } from './profile-environment.js'
import { prepareProfileModuleFallback } from './profile-modules.js'
import { ProfileRuntimeController, type ProfileRuntimeSession } from './profile-runtime.js'
import {
  DEFAULT_PROFILE_ID,
  ProfileStore,
  type ActiveProfile,
  type WorkbenchProfile,
} from './profile-store.js'
import {
  installProfileIpc,
  ProfileTransitionCoordinator,
  sendProfileContext,
} from './profiles-ipc.js'
import type { PackageSmokeOptions } from './smoke-options.js'
import {
  createWorkbenchBrowserWindow,
  profileSessionPartition,
  WORKBENCH_WEB_PREFERENCES,
} from './window.js'

const require = createRequire(import.meta.url)
const MAX_PTY_OUTPUT_BYTES = 16 * 1024
const PTY_TIMEOUT_MS = 10_000
const TASKKILL_TIMEOUT_MS = 5_000
const WINDOW_LOAD_TIMEOUT_MS = 20_000
const PROFILE_UI_TIMEOUT_MS = 10_000
const PTY_SUCCESS_MARKER = 'DSH_WORKBENCH_PTY_OK'
const AMBIENT_CREDENTIAL_PROBE_REF = 'DSH_WORKBENCH_AMBIENT_CREDENTIAL_PROBE'

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
  bridgeProfilesType?: unknown
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
  authorization: {
    officialFlowRegistered?: boolean
    uiMounted?: boolean
    valueFreeSnapshotVerified?: boolean
  }
  profiles: {
    activeProfileRestartPersistenceVerified?: boolean
    ambientCredentialFilteringVerified?: boolean
    browserPartitionIsolationVerified?: boolean
    browserPartitionRestartPersistenceVerified?: boolean
    clientBundleInBootPayload?: boolean
    credentialIsolationVerified?: boolean
    defaultPartitionContinuityVerified?: boolean
    dshHomeIsolationVerified?: boolean
    legacyMigrationVerified?: boolean
    profileUiLifecycleVerified?: boolean
    profileUiMounted?: boolean
    registryVerified?: boolean
    rendererApiVerified?: boolean
    rendererSelectVerified?: boolean
    runtimeSwitchVerified?: boolean
    workspaceIsolationVerified?: boolean
  }
  runtime: {
    desktopCoreEntry?: string
    dshBin?: string
    dshVersion?: string
    cwd?: string
    exitCode?: number | null
    expectedExit?: boolean
    httpBootPayload?: boolean
    oauthUiEntry?: string
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
  phase: 'setup' | 'verify'
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

interface CredentialRecordProbe {
  readonly key: string
  readonly kind: 'api-key' | 'grant'
}

function fingerprintCredentialRecordProbes(entries: readonly CredentialRecordProbe[]): string {
  const records = entries
    .map((entry) => ({ key: entry.key, kind: entry.kind }))
    .sort((left, right) => (
      left.key.localeCompare(right.key) || left.kind.localeCompare(right.kind)
    ))
  return createHash('sha256').update(JSON.stringify(records)).digest('hex')
}

async function writeCredentialRecordProbe(
  dshHome: string,
  entry: CredentialRecordProbe,
): Promise<void> {
  const record = entry.kind === 'api-key'
    ? { kind: entry.kind }
    : { kind: entry.kind, payload: { packageSmoke: true } }
  await writeFile(join(dshHome, '.credentials.yaml'), `${JSON.stringify({
    records: { [entry.key]: record },
    version: 1,
  }, undefined, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
}

async function verifySessionProfileEvidence(
  session: ProfileRuntimeSession,
  expected: { dshHome: string; record: CredentialRecordProbe; workspace: string },
): Promise<void> {
  const evidence = session.ready.profileEvidence
  assertSmoke(evidence, `DSH for ${session.profile.id} omitted profile evidence`)
  const [actualDshHome, actualWorkspace, expectedDshHome, expectedWorkspace] = await Promise.all([
    realpath(evidence.dshHome),
    realpath(evidence.cwd),
    realpath(expected.dshHome),
    realpath(expected.workspace),
  ])
  assertSmoke(actualDshHome === expectedDshHome, `DSH for ${session.profile.id} used the wrong DSH_HOME`)
  assertSmoke(actualWorkspace === expectedWorkspace, `DSH for ${session.profile.id} used the wrong workspace`)
  assertSmoke(
    evidence.ambientCredentialConfigured === false,
    `DSH for ${session.profile.id} inherited the ambient credential probe`,
  )
  assertSmoke(evidence.credentialRecordCount === 1, `DSH for ${session.profile.id} read the wrong credential record count`)
  assertSmoke(
    evidence.credentialRecordFingerprint === fingerprintCredentialRecordProbes([expected.record]),
    `DSH for ${session.profile.id} read credential metadata from the wrong profile`,
  )
}

async function waitForRendererCondition(
  window: BrowserWindow,
  expression: string,
  description: string,
): Promise<void> {
  const deadline = Date.now() + PROFILE_UI_TIMEOUT_MS
  let lastError: unknown
  while (Date.now() < deadline) {
    if (window.isDestroyed()) throw new Error(`Renderer was destroyed while waiting for ${description}`)
    try {
      if (await window.webContents.executeJavaScript(expression, true) === true) return
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(
    `Timed out waiting for ${description}`,
    lastError === undefined ? undefined : { cause: lastError },
  )
}

async function openProfilesUi(
  window: BrowserWindow,
  expectedProfiles: readonly { id: string; name: string }[],
): Promise<void> {
  await window.webContents.executeJavaScript(`(() => {
    const labels = new Set(["Continue", "继续"])
    const button = [...document.querySelectorAll("button")]
      .find((candidate) => labels.has(candidate.innerText.trim()))
    button?.click()
    return true
  })()`, true)

  await waitForRendererCondition(window, `(() => {
    const labels = new Set(["Settings", "设置"])
    const button = [...document.querySelectorAll("button")]
      .find((candidate) => labels.has(candidate.innerText.trim()))
    if (!button) return false
    if (button.getAttribute("aria-expanded") !== "true") button.click()
    return true
  })()`, 'the Settings dialog')

  await waitForRendererCondition(window, `(() => {
    const labels = new Set(["Profiles", "配置档案"])
    const button = [...document.querySelectorAll("button")]
      .find((candidate) => labels.has(candidate.innerText.trim()))
    if (!button) return false
    button.click()
    return true
  })()`, 'the Profiles navigation item')

  const expected = JSON.stringify(expectedProfiles)
  await waitForRendererCondition(window, `(() => {
    const root = document.querySelector("[data-workbench-profiles]")
    if (!root || root.querySelector("[role=alert]")) return false
    const rows = [...root.querySelectorAll("[data-profile-id]")]
    const expected = ${expected}
    return rows.length === expected.length && expected.every((profile) => {
      const row = rows.find((candidate) => candidate.getAttribute("data-profile-id") === profile.id)
      return Boolean(row && row.innerText.includes(profile.name))
    })
  })()`, 'the populated Profiles section')
}

async function verifyAuthorizationUi(window: BrowserWindow): Promise<void> {
  await waitForRendererCondition(window, `(() => {
    const labels = new Set(["Sign-in & authorization", "登录与授权"])
    const button = [...document.querySelectorAll("button")]
      .find((candidate) => labels.has(candidate.innerText.trim()))
    if (!button) return false
    button.click()
    return true
  })()`, 'the authorization navigation item')

  await waitForRendererCondition(window, `(() => {
    const root = document.querySelector("[data-workbench-authorization]")
    const row = root?.querySelector('[data-authorization-key="llm-pi-ai/openai-codex"]')
    return Boolean(row && !root.querySelector("[role=alert]"))
  })()`, 'the official ChatGPT authorization row')

  const serialized = await window.webContents.executeJavaScript(`(async () => {
    const response = await fetch(${JSON.stringify('/workbench/authorization')}, {
      body: JSON.stringify({ action: "snapshot" }),
      cache: "no-store",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      method: "POST",
    })
    return JSON.stringify({ status: response.status, payload: await response.json() })
  })()`, true) as unknown
  assertSmoke(typeof serialized === 'string', 'Authorization UI returned an unserializable snapshot')
  const response = JSON.parse(serialized) as {
    payload?: {
      ok?: unknown
      value?: { entries?: unknown }
    }
    status?: unknown
  }
  assertSmoke(response.status === 200 && response.payload?.ok === true, 'Authorization snapshot request failed')
  const entries = response.payload.value?.entries
  assertSmoke(Array.isArray(entries), 'Authorization snapshot omitted its entry list')
  const official = entries.find((entry) => (
    typeof entry === 'object'
    && entry !== null
    && (entry as { key?: unknown }).key === 'llm-pi-ai/openai-codex'
  )) as { configured?: unknown; methods?: unknown } | undefined
  assertSmoke(official, 'Official ChatGPT authorization flow is missing')
  assertSmoke(official.configured === false, 'Package smoke unexpectedly used an existing ChatGPT credential')
  assertSmoke(
    Array.isArray(official.methods)
    && official.methods.some((method) => (
      typeof method === 'object'
      && method !== null
      && (method as { id?: unknown }).id === 'oauth'
    )),
    'Official ChatGPT OAuth method is missing',
  )
  const forbiddenFields = new Set(['accessToken', 'payload', 'refreshToken', 'secret', 'token'])
  const containsForbiddenField = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(containsForbiddenField)
    if (typeof value !== 'object' || value === null) return false
    return Object.entries(value).some(([key, child]) => (
      forbiddenFields.has(key) || containsForbiddenField(child)
    ))
  }
  assertSmoke(!containsForbiddenField(entries), 'Authorization read response exposed a credential value field')

  await waitForRendererCondition(window, `(() => {
    const labels = new Set(["Profiles", "配置档案"])
    const button = [...document.querySelectorAll("button")]
      .find((candidate) => labels.has(candidate.innerText.trim()))
    if (!button) return false
    button.click()
    return true
  })()`, 'the Profiles navigation item after authorization verification')
  await waitForRendererCondition(
    window,
    'Boolean(document.querySelector("[data-workbench-profiles]"))',
    'the restored Profiles section',
  )
}

async function selectProfileFromRenderer(window: BrowserWindow, profileId: string): Promise<void> {
  const encodedProfileId = JSON.stringify(profileId)
  await waitForRendererCondition(window, `(() => {
    const row = [...document.querySelectorAll("[data-workbench-profiles] [data-profile-id]")]
      .find((candidate) => candidate.getAttribute("data-profile-id") === ${encodedProfileId})
    const button = row?.querySelector("button[data-profile-action=select]")
    if (!button || button.disabled) return false
    button.click()
    return true
  })()`, `the renderer profile switch to ${profileId}`)
}

async function exerciseProfileLifecycleFromRenderer(
  window: BrowserWindow,
  store: ProfileStore,
): Promise<WorkbenchProfile> {
  const createdName = 'Package Smoke UI Profile'
  const renamedName = 'Package Smoke UI Renamed'
  await window.webContents.executeJavaScript(`(async () => {
    const root = document.querySelector("[data-workbench-profiles]")
    const form = root?.querySelector("form")
    const input = form?.querySelector("input")
    if (!form || !input) throw new Error("Profiles create form is unavailable")
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
    setter?.call(input, ${JSON.stringify(createdName)})
    input.dispatchEvent(new Event("input", { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    form.requestSubmit()
    return true
  })()`, true)
  await waitForRendererCondition(window, `(() => {
    return [...document.querySelectorAll("[data-workbench-profiles] [data-profile-id]")]
      .some((row) => row.innerText.includes(${JSON.stringify(createdName)}))
  })()`, 'the renderer-created profile')

  const created = (await store.list()).profiles.find((profile) => profile.name === createdName)
  assertSmoke(created, 'Renderer profile creation did not reach the profile store')
  const profileId = JSON.stringify(created.id)
  await window.webContents.executeJavaScript(`(() => {
    const row = document.querySelector('[data-profile-id=' + JSON.stringify(${profileId}) + ']')
    const button = row?.querySelector("button[data-profile-action=rename]")
    if (!button) throw new Error("Profiles rename action is unavailable")
    button.click()
    return true
  })()`, true)
  await waitForRendererCondition(window, `(() => {
    const row = document.querySelector('[data-profile-id=' + JSON.stringify(${profileId}) + ']')
    return Boolean(row?.querySelector("input"))
  })()`, 'the profile rename editor')
  await window.webContents.executeJavaScript(`(async () => {
    const row = document.querySelector('[data-profile-id=' + JSON.stringify(${profileId}) + ']')
    const input = row?.querySelector("input")
    if (!input) throw new Error("Profiles rename input is unavailable")
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
    setter?.call(input, ${JSON.stringify(renamedName)})
    input.dispatchEvent(new Event("input", { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    const save = row.querySelector("button[data-profile-action=save]")
    if (!save) throw new Error("Profiles save action is unavailable")
    save.click()
    return true
  })()`, true)
  await waitForRendererCondition(window, `(() => {
    const row = document.querySelector('[data-profile-id=' + JSON.stringify(${profileId}) + ']')
    return Boolean(row && !row.querySelector("input") && row.innerText.includes(${JSON.stringify(renamedName)}))
  })()`, 'the renamed profile')

  await window.webContents.executeJavaScript(`(() => {
    const row = document.querySelector('[data-profile-id=' + JSON.stringify(${profileId}) + ']')
    const archive = row?.querySelector("button[data-profile-action=archive]")
    if (!archive) throw new Error("Profiles archive action is unavailable")
    archive.click()
    return true
  })()`, true)
  await waitForRendererCondition(window, `(() => {
    const row = document.querySelector('[data-profile-id=' + JSON.stringify(${profileId}) + ']')
    return Boolean(row?.querySelector("button[data-profile-action=restore]"))
  })()`, 'the archived profile')

  await window.webContents.executeJavaScript(`(() => {
    const row = document.querySelector('[data-profile-id=' + JSON.stringify(${profileId}) + ']')
    const restore = row?.querySelector("button[data-profile-action=restore]")
    if (!restore) throw new Error("Profiles restore action is unavailable")
    restore.click()
    return true
  })()`, true)
  await waitForRendererCondition(window, `(() => {
    const row = document.querySelector('[data-profile-id=' + JSON.stringify(${profileId}) + ']')
    return Boolean(row?.querySelector("button[data-profile-action=archive]"))
      && !row.querySelector("button[data-profile-action=restore]")
  })()`, 'the restored profile')

  const restored = (await store.list()).profiles.find((profile) => profile.id === created.id)
  assertSmoke(restored?.name === renamedName, 'Renderer profile rename did not reach the profile store')
  assertSmoke(restored.archivedAt === undefined, 'Renderer profile restore did not reach the profile store')
  return restored
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
  const allowedOrigin = new URL(url).origin
  return new Promise((resolve, reject) => {
    const debuggerClient = window.webContents.debugger
    let settled = false
    let probeInFlight = false
    let rendererReady = false
    const finish = (error?: Error, probe?: RendererSecurityProbe): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearInterval(probeInterval)
      window.webContents.removeListener('did-fail-load', handleFailedLoad)
      window.webContents.removeListener('dom-ready', handleDomReady)
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
      if (settled || probeInFlight || !rendererReady) return
      try {
        if (new URL(window.webContents.getURL()).origin !== allowedOrigin) return
      } catch {
        return
      }

      probeInFlight = true
      try {
        if (!debuggerClient.isAttached()) debuggerClient.attach('1.3')
      } catch (error) {
        finish(asError(error))
        return
      }
      void debuggerClient.sendCommand('Runtime.evaluate', {
        expression: `({
          bridgeContextIsolated: globalThis.dshWorkbench?.security?.contextIsolated,
          bridgeProfilesType: typeof globalThis.dshWorkbench?.profiles?.list,
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
    const handleDomReady = (): void => {
      rendererReady = true
      probeRenderer()
    }
    const timer = setTimeout(() => {
      finish(new Error(
        `Packaged BrowserWindow load timed out after ${WINDOW_LOAD_TIMEOUT_MS} ms at ${window.webContents.getURL()}`,
      ))
    }, WINDOW_LOAD_TIMEOUT_MS)
    const probeInterval = setInterval(probeRenderer, 250)

    window.webContents.on('did-fail-load', handleFailedLoad)
    window.webContents.on('dom-ready', handleDomReady)
    window.webContents.on('render-process-gone', handleRendererGone)
    window.once('closed', handleClosed)
    window.once('unresponsive', handleUnresponsive)
    void window.loadURL(url).then(() => {
      rendererReady = true
      probeRenderer()
    }).catch((error: unknown) => finish(asError(error)))
  })
}

function writeStdout(message: string): Promise<void> {
  return new Promise((resolve) => {
    process.stdout.write(message, () => resolve())
  })
}

async function writeSmokeProgress(
  phase: PackageSmokeOptions['phase'],
  step: string,
): Promise<void> {
  await writeStdout(`DSH_WORKBENCH_PACKAGE_SMOKE_PROGRESS ${phase} ${step}\n`)
}

async function readRendererProfileSnapshot(window: BrowserWindow): Promise<{
  activeProfileId: string
  profiles: Array<{ id: string }>
  schemaVersion: number
}> {
  const serialized = await window.webContents.executeJavaScript(
    '(async () => JSON.stringify(await globalThis.dshWorkbench.profiles.list()))()',
    true,
  ) as unknown
  assertSmoke(typeof serialized === 'string', 'Profile bridge did not return serializable data')
  const value = JSON.parse(serialized) as unknown
  assertSmoke(typeof value === 'object' && value !== null, 'Profile bridge returned an invalid snapshot')
  const snapshot = value as {
    activeProfileId?: unknown
    profiles?: unknown
    schemaVersion?: unknown
  }
  assertSmoke(typeof snapshot.activeProfileId === 'string', 'Profile bridge omitted the active profile')
  assertSmoke(Array.isArray(snapshot.profiles), 'Profile bridge omitted the profile list')
  assertSmoke(snapshot.schemaVersion === 1, 'Profile bridge returned an unsupported schema')
  assertSmoke(snapshot.profiles.every((profile) => (
    typeof profile === 'object'
    && profile !== null
    && typeof (profile as { id?: unknown }).id === 'string'
  )), 'Profile bridge returned an invalid profile entry')
  return snapshot as {
    activeProfileId: string
    profiles: Array<{ id: string }>
    schemaVersion: number
  }
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
    authorization: {},
    profiles: {},
    runtime: {},
    phase: options.phase,
    schemaVersion: 1,
    status: 'failed',
  }

  let failure: Error | undefined
  let controller: ProfileRuntimeController | undefined
  let transitions: ProfileTransitionCoordinator | undefined
  const runtimeExitEvents: DshRuntimeExit[] = []
  const runtimes: DshRuntime[] = []
  const startedSessions: ProfileRuntimeSession[] = []
  const previousAmbientCredentialProbe = process.env[AMBIENT_CREDENTIAL_PROBE_REF]
  let ambientCredentialProbeInjected = false
  let uninstallProfileIpc: (() => void) | undefined
  let window: BrowserWindow | undefined
  let ready: DshRuntimeReady | undefined

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
    const dshBin = await realpath(resolveDshBin())
    const desktopCore = await prepareDesktopCoreContribution(options.userDataPath)
    const desktopCoreEntry = await realpath(desktopCore.entry)
    const oauthUiEntry = await realpath(desktopCore.oauthEntry)
    assertSmoke(isPathInside(packagedAppRoot, dshBin), 'DSH executable escaped the packaged application')
    assertSmoke(
      isPathInside(packagedAppRoot, desktopCoreEntry),
      'Desktop Core entry escaped the packaged application',
    )
    assertSmoke(
      isPathInside(packagedAppRoot, oauthUiEntry),
      'OAuth UI entry escaped the packaged application',
    )

    const dshPackage = JSON.parse(await readFile(join(dirname(dirname(dshBin)), 'package.json'), 'utf8')) as {
      version?: unknown
    }
    assertSmoke(typeof dshPackage.version === 'string', 'Packaged DSH version is missing')
    report.runtime.dshBin = dshBin
    report.runtime.dshVersion = dshPackage.version
    report.runtime.desktopCoreEntry = desktopCoreEntry
    report.runtime.oauthUiEntry = oauthUiEntry

    const allocatedProfileIds = ['package-smoke-second', 'package-smoke-ui']
    const profiles = new ProfileStore(options.userDataPath, {
      createId: () => allocatedProfileIds.shift() ?? 'package-smoke-unexpected',
    })
    const initialSnapshot = await profiles.initialize()
    let secondProfile: WorkbenchProfile
    let uiProfile: WorkbenchProfile | undefined
    if (options.phase === 'setup') {
      assertSmoke(initialSnapshot.activeProfileId === DEFAULT_PROFILE_ID, 'Fresh package smoke active profile was not Default')
      assertSmoke(initialSnapshot.profiles.length === 1, 'Fresh package smoke profile registry was not empty')
      secondProfile = await profiles.create('Package Smoke Second')
    } else {
      assertSmoke(initialSnapshot.profiles.length === 3, 'Persisted package smoke registry lost a profile')
      const persistedSecond = initialSnapshot.profiles.find((profile) => profile.id === 'package-smoke-second')
      const persistedUiProfile = initialSnapshot.profiles.find((profile) => profile.id === 'package-smoke-ui')
      assertSmoke(persistedSecond, 'Persisted package smoke second profile is missing')
      assertSmoke(persistedUiProfile, 'Persisted renderer-created profile is missing')
      assertSmoke(
        persistedUiProfile.name === 'Package Smoke UI Renamed' && persistedUiProfile.archivedAt === undefined,
        'Persisted renderer profile lifecycle state is incorrect',
      )
      assertSmoke(initialSnapshot.activeProfileId === persistedSecond.id, 'Non-default active profile did not survive restart')
      secondProfile = persistedSecond
      uiProfile = persistedUiProfile
    }
    const first = await profiles.getProfile(DEFAULT_PROFILE_ID)
    const second = await profiles.getProfile(secondProfile.id)
    const initialProfile = options.phase === 'setup' ? first : second
    const middleProfile = options.phase === 'setup' ? second : first
    const finalProfile = options.phase === 'setup' ? first : second
    const expectedProfiles = (): Array<{ id: string; name: string }> => [
      { id: first.profile.id, name: first.profile.name },
      { id: second.profile.id, name: second.profile.name },
      ...(uiProfile ? [{ id: uiProfile.id, name: uiProfile.name }] : []),
    ]
    assertSmoke(
      (await profiles.list()).profiles.length === (options.phase === 'setup' ? 2 : 3),
      'Package smoke profile registry has an unexpected size',
    )
    assertSmoke(
      profileSessionPartition(first.profile.id) === 'persist:dsh-workbench',
      'Default profile did not preserve the historical browser partition',
    )
    report.profiles.defaultPartitionContinuityVerified = true
    report.profiles.registryVerified = true

    const dshSentinel = 'package-smoke-dsh-sentinel'
    const workspaceSentinel = 'package-smoke-workspace-sentinel'
    assertSmoke(await readFile(join(first.paths.dshHome, dshSentinel), 'utf8') === 'first', 'First profile lost its DSH sentinel')
    assertSmoke(await readFile(join(first.paths.workspace, workspaceSentinel), 'utf8') === 'first', 'First profile lost its workspace sentinel')
    await Promise.all([
      access(join(options.userDataPath, 'dsh')).then(
        () => { throw new Error('Legacy DSH home was not migrated') },
        (error: unknown) => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        },
      ),
      access(join(options.userDataPath, 'workspace')).then(
        () => { throw new Error('Legacy workspace was not migrated') },
        (error: unknown) => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        },
      ),
    ])
    report.profiles.legacyMigrationVerified = true
    await access(join(second.paths.dshHome, dshSentinel)).then(
      () => { throw new Error('Second profile inherited first profile DSH data') },
      (error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      },
    )
    await access(join(second.paths.workspace, workspaceSentinel)).then(
      () => { throw new Error('Second profile inherited first profile workspace data') },
      (error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      },
    )
    report.runtime.cwd = initialProfile.paths.workspace

    const firstCredentialRecord: CredentialRecordProbe = {
      key: 'dsh-workbench-package-smoke/profile-a',
      kind: 'api-key',
    }
    const secondCredentialRecord: CredentialRecordProbe = {
      key: 'dsh-workbench-package-smoke/profile-b',
      kind: 'grant',
    }
    const profileEvidenceExpectation = (profile: ActiveProfile) => ({
      dshHome: profile.paths.dshHome,
      record: profile.profile.id === first.profile.id
        ? firstCredentialRecord
        : secondCredentialRecord,
      workspace: profile.paths.workspace,
    })
    if (options.phase === 'setup') {
      await Promise.all([
        writeCredentialRecordProbe(first.paths.dshHome, firstCredentialRecord),
        writeCredentialRecordProbe(second.paths.dshHome, secondCredentialRecord),
      ])
    }
    process.env[AMBIENT_CREDENTIAL_PROBE_REF] = 'package-smoke-non-secret-probe'
    ambientCredentialProbeInjected = true

    controller = new ProfileRuntimeController(
      profiles,
      (active, onExit) => {
        prepareProfileModuleFallback(active.paths.dshHome)
        const runtime = new DshRuntime({
          cwd: active.paths.workspace,
          env: buildProfileEnvironment(process.env, active.paths.dshHome),
          onExit: (event) => {
            runtimeExitEvents.push(event)
            onExit(event)
          },
          patchFiles: [desktopCore.patch],
        })
        runtimes.push(runtime)
        return runtime
      },
      (exit) => captureFailure(new Error(
        `Packaged DSH exited unexpectedly for ${exit.session.profile.id}`,
      )),
    )

    const loadProfileWindow = async (
      session: ProfileRuntimeSession,
    ): Promise<{ probe: RendererSecurityProbe; window: BrowserWindow }> => {
      const previous = window
      const next = createWorkbenchBrowserWindow(session.ready, {
        partition: profileSessionPartition(session.profile.id),
        show: false,
      })
      next.webContents.once('dom-ready', () => sendProfileContext(next, session))
      window = next
      try {
        const probe = await waitForWindowRenderer(next, session.ready.url)
        if (previous && !previous.isDestroyed()) previous.destroy()
        return { probe, window: next }
      } catch (error) {
        if (window === next) window = previous
        if (!next.isDestroyed()) next.destroy()
        throw error
      }
    }

    transitions = new ProfileTransitionCoordinator(
      controller,
      async (session) => { await loadProfileWindow(session) },
    )
    uninstallProfileIpc = installProfileIpc({
      confirmArchive: async () => true,
      controller,
      getWindow: () => window,
      selectProfile: (profileId) => {
        if (!transitions) throw new Error('Package smoke profile transitions are unavailable')
        return transitions.select(profileId)
      },
      store: profiles,
    })

    const initialSession = await controller.startActive()
    await writeSmokeProgress(options.phase, 'initial-runtime-ready')
    startedSessions.push(initialSession)
    assertSmoke(initialSession.profile.id === initialProfile.profile.id, 'DSH started the wrong persisted active profile')
    await verifySessionProfileEvidence(initialSession, profileEvidenceExpectation(initialProfile))
    const response = await fetch(initialSession.ready.url, { signal: AbortSignal.timeout(10_000) })
    const html = await response.text()
    assertSmoke(response.ok, `Packaged DSH returned HTTP ${response.status}`)
    assertSmoke(html.includes('__DSH_BOOT__'), 'Packaged DSH page is missing its boot payload')
    assertSmoke(
      html.includes('@dsh-workbench/desktop-core'),
      'Packaged DSH boot payload is missing the Desktop Core client bundle',
    )
    assertSmoke(
      html.includes('@dsh-workbench/oauth-ui'),
      'Packaged DSH boot payload is missing the OAuth UI client bundle',
    )
    report.runtime.httpBootPayload = true
    report.profiles.clientBundleInBootPayload = true

    const ptyResult = await runPtySmoke(initialProfile.paths.workspace)
    report.runtime.ptyExitCode = ptyResult.exitCode
    report.runtime.ptyOutputVerified = ptyResult.outputVerified
    report.runtime.ptyPidAliveAfterExit = ptyResult.pidAliveAfterExit

    const initialWindow = await loadProfileWindow(initialSession)
    const initialOrigin = new URL(initialSession.ready.url).origin
    assertSmoke(new URL(initialWindow.window.webContents.getURL()).origin === initialOrigin, 'BrowserWindow loaded an unexpected origin')
    assertSmoke(WORKBENCH_WEB_PREFERENCES.contextIsolation === true, 'BrowserWindow context isolation is disabled')
    assertSmoke(WORKBENCH_WEB_PREFERENCES.nodeIntegration === false, 'BrowserWindow Node integration is enabled')
    assertSmoke(WORKBENCH_WEB_PREFERENCES.sandbox === true, 'BrowserWindow sandbox is disabled')
    assertSmoke(WORKBENCH_WEB_PREFERENCES.webSecurity === true, 'BrowserWindow web security is disabled')
    assertSmoke(new URL(initialWindow.probe.href).origin === initialOrigin, 'Renderer probe used an unexpected origin')
    assertSmoke(
      ['interactive', 'complete'].includes(initialWindow.probe.documentReadyState),
      `Renderer document is only ${initialWindow.probe.documentReadyState}`,
    )
    assertSmoke(initialWindow.probe.bridgeContextIsolated === true, 'Preload context isolation probe failed')
    assertSmoke(initialWindow.probe.bridgeSandboxed === true, 'Preload sandbox probe failed')
    assertSmoke(initialWindow.probe.bridgeProfilesType === 'function', 'Preload profile bridge is unavailable')
    assertSmoke(initialWindow.probe.processType === 'undefined', 'Renderer exposed the Node process global')
    assertSmoke(initialWindow.probe.requireType === 'undefined', 'Renderer exposed the Node require global')
    const initialBridgeSnapshot = await readRendererProfileSnapshot(initialWindow.window)
    assertSmoke(initialBridgeSnapshot.activeProfileId === initialProfile.profile.id, 'Profile bridge reported the wrong initial profile')
    assertSmoke(
      initialBridgeSnapshot.profiles.length === expectedProfiles().length,
      'Profile bridge did not return every expected profile',
    )
    await openProfilesUi(initialWindow.window, expectedProfiles())
    await verifyAuthorizationUi(initialWindow.window)
    report.authorization.officialFlowRegistered = true
    report.authorization.uiMounted = true
    report.authorization.valueFreeSnapshotVerified = true
    if (options.phase === 'setup') {
      uiProfile = await exerciseProfileLifecycleFromRenderer(initialWindow.window, profiles)
      assertSmoke(uiProfile.id === 'package-smoke-ui', 'Renderer-created profile used an unexpected id')
    }
    await writeSmokeProgress(options.phase, 'profiles-ui-verified')
    report.profiles.profileUiLifecycleVerified = true
    report.profiles.profileUiMounted = true
    report.runtime.windowLoaded = true
    report.runtime.windowSecurityVerified = true

    const cookieName = 'dsh-workbench-profile-smoke'
    const cookieExpirationDate = Math.floor(Date.now() / 1_000) + 24 * 60 * 60
    const assertProfileCookie = async (
      activeWindow: BrowserWindow,
      profile: ActiveProfile,
      message: string,
    ): Promise<void> => {
      const cookies = await activeWindow.webContents.session.cookies.get({ name: cookieName })
      assertSmoke(
        cookies.length === 1 && cookies[0]?.value === profile.profile.id,
        message,
      )
    }
    if (options.phase === 'setup') {
      assertSmoke(
        (await initialWindow.window.webContents.session.cookies.get({ name: cookieName })).length === 0,
        'Fresh first profile browser partition was not empty',
      )
      await initialWindow.window.webContents.session.cookies.set({
        expirationDate: cookieExpirationDate,
        httpOnly: true,
        name: cookieName,
        sameSite: 'lax',
        url: initialSession.ready.url,
        value: initialProfile.profile.id,
      })
    } else {
      await assertProfileCookie(
        initialWindow.window,
        initialProfile,
        'Persisted active profile browser state did not survive an application restart',
      )
    }

    const waitForActivatedProfile = async (
      profileId: string,
      previousWindow: BrowserWindow,
    ): Promise<{ session: ProfileRuntimeSession; window: BrowserWindow }> => {
      const deadline = Date.now() + WINDOW_LOAD_TIMEOUT_MS
      while (Date.now() < deadline) {
        const session = controller?.current
        const activeWindow = window
        if (
          session?.profile.id === profileId
          && activeWindow
          && activeWindow !== previousWindow
          && !activeWindow.isDestroyed()
        ) {
          return { session, window: activeWindow }
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      throw new Error(`Timed out waiting for profile ${profileId} to activate its BrowserWindow`)
    }

    await selectProfileFromRenderer(initialWindow.window, middleProfile.profile.id)
    const middleActivation = await waitForActivatedProfile(middleProfile.profile.id, initialWindow.window)
    await transitions.waitForIdle()
    const middleSession = middleActivation.session
    await writeSmokeProgress(options.phase, 'middle-runtime-ready')
    startedSessions.push(middleSession)
    await verifySessionProfileEvidence(middleSession, profileEvidenceExpectation(middleProfile))
    assertSmoke(!isProcessAlive(initialSession.ready.pid), 'Initial profile DSH process survived the switch')
    if (initialSession.ready.url !== middleSession.ready.url) {
      const initialUrl = new URL(initialSession.ready.url)
      assertSmoke(
        !(await isPortOpen(initialUrl.hostname, Number(initialUrl.port))),
        'Initial profile DSH port survived the switch',
      )
    }
    const middleWindow = middleActivation.window
    const middleBridgeSnapshot = await readRendererProfileSnapshot(middleWindow)
    assertSmoke(middleBridgeSnapshot.activeProfileId === middleProfile.profile.id, 'Profile bridge reported the wrong switched profile')
    if (options.phase === 'setup') {
      assertSmoke(
        (await middleWindow.webContents.session.cookies.get({ name: cookieName })).length === 0,
        'Second profile inherited the first profile browser partition',
      )
      await middleWindow.webContents.session.cookies.set({
        expirationDate: cookieExpirationDate,
        httpOnly: true,
        name: cookieName,
        sameSite: 'lax',
        url: middleSession.ready.url,
        value: middleProfile.profile.id,
      })
    } else {
      await assertProfileCookie(
        middleWindow,
        middleProfile,
        'Inactive profile browser state did not survive an application restart',
      )
    }
    await middleWindow.webContents.session.cookies.flushStore()

    await openProfilesUi(middleWindow, expectedProfiles())
    await selectProfileFromRenderer(middleWindow, finalProfile.profile.id)
    const finalActivation = await waitForActivatedProfile(finalProfile.profile.id, middleWindow)
    await transitions.waitForIdle()
    const finalSession = finalActivation.session
    await writeSmokeProgress(options.phase, 'final-runtime-ready')
    startedSessions.push(finalSession)
    await verifySessionProfileEvidence(finalSession, profileEvidenceExpectation(finalProfile))
    assertSmoke(!isProcessAlive(middleSession.ready.pid), 'Middle profile DSH process survived the switch back')
    if (middleSession.ready.url !== finalSession.ready.url) {
      const middleUrl = new URL(middleSession.ready.url)
      assertSmoke(
        !(await isPortOpen(middleUrl.hostname, Number(middleUrl.port))),
        'Middle profile DSH port survived the switch back',
      )
    }
    const finalWindow = finalActivation.window
    const finalSnapshot = await readRendererProfileSnapshot(finalWindow)
    assertSmoke(finalSnapshot.activeProfileId === finalProfile.profile.id, 'Profile bridge did not report the final profile')
    await assertProfileCookie(
      finalWindow,
      finalProfile,
      options.phase === 'setup'
        ? 'First profile browser partition was not recovered after switching back'
        : 'Persisted active profile browser partition was not recovered after switching back',
    )
    await finalWindow.webContents.session.cookies.flushStore()
    assertSmoke(
      (await profiles.getActiveProfile()).profile.id === finalProfile.profile.id,
      'Profile registry did not commit the final switch',
    )

    let reportSession = finalSession
    if (options.phase === 'setup') {
      await openProfilesUi(finalWindow, expectedProfiles())
      await selectProfileFromRenderer(finalWindow, second.profile.id)
      const persistedActivation = await waitForActivatedProfile(second.profile.id, finalWindow)
      await transitions.waitForIdle()
      const persistedSession = persistedActivation.session
      await writeSmokeProgress(options.phase, 'persisted-runtime-ready')
      startedSessions.push(persistedSession)
      await verifySessionProfileEvidence(persistedSession, profileEvidenceExpectation(second))
      assertSmoke(!isProcessAlive(finalSession.ready.pid), 'Previous DSH process survived the persisted active-profile switch')
      await assertProfileCookie(
        persistedActivation.window,
        second,
        'Second profile browser partition was not recovered before restart',
      )
      await persistedActivation.window.webContents.session.cookies.flushStore()
      assertSmoke(
        (await profiles.getActiveProfile()).profile.id === second.profile.id,
        'Non-default profile was not committed before restart',
      )
      reportSession = persistedSession
    }

    report.profiles.activeProfileRestartPersistenceVerified = options.phase === 'verify'
    report.profiles.ambientCredentialFilteringVerified = true
    report.profiles.browserPartitionIsolationVerified = true
    report.profiles.browserPartitionRestartPersistenceVerified = options.phase === 'verify'
    report.profiles.credentialIsolationVerified = true
    report.profiles.dshHomeIsolationVerified = true
    report.profiles.rendererApiVerified = true
    report.profiles.rendererSelectVerified = true
    report.profiles.runtimeSwitchVerified = true
    report.profiles.workspaceIsolationVerified = true
    ready = reportSession.ready
    report.runtime.pid = ready.pid
    report.runtime.url = ready.url
    await writeSmokeProgress(options.phase, 'acceptance-complete')
  } catch (error) {
    captureFailure(error)
  } finally {
    await writeSmokeProgress(options.phase, 'cleanup-start')
    if (window && !window.isDestroyed()) window.destroy()
    uninstallProfileIpc?.()
    if (transitions || controller) {
      try {
        await (transitions?.shutdown() ?? controller?.stop())
        await writeSmokeProgress(options.phase, 'transition-shutdown-complete')
      } catch (error) {
        captureFailure(error)
      }
    }
    const fallbackStops = await Promise.allSettled(runtimes.map((runtime) => runtime.stop()))
    for (const result of fallbackStops) {
      if (result.status === 'rejected') captureFailure(result.reason)
    }
    await writeSmokeProgress(options.phase, 'cleanup-complete')
    if (ambientCredentialProbeInjected) {
      if (previousAmbientCredentialProbe === undefined) delete process.env[AMBIENT_CREDENTIAL_PROBE_REF]
      else process.env[AMBIENT_CREDENTIAL_PROBE_REF] = previousAmbientCredentialProbe
    }
  }

  if (ready) {
    const exitEvent = runtimeExitEvents.at(-1)
    report.runtime.exitCode = exitEvent?.code
    report.runtime.expectedExit = runtimeExitEvents.length === startedSessions.length
      && runtimeExitEvents.every((event) => event.expected && event.code === 0)
    report.runtime.pidAliveAfterStop = isProcessAlive(ready.pid)
    const url = new URL(ready.url)
    report.runtime.portOpenAfterStop = await isPortOpen(url.hostname, Number(url.port))

    if (!report.runtime.expectedExit) {
      captureFailure(new Error('Not every packaged profile DSH reported a graceful zero-code exit'))
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
