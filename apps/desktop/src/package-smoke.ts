import { createHash, randomUUID } from 'node:crypto'
import { createConnection } from 'node:net'
import { spawn as spawnChildProcess } from 'node:child_process'
import { access, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

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
import { RuntimeDiagnosticLog } from './runtime-diagnostics.js'
import { installRuntimeDiagnosticsIpc } from './runtime-ipc.js'
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
const DIAGNOSTIC_CANARY_ENV = 'DSH_WORKBENCH_PACKAGE_SMOKE_CANARY'
const DIAGNOSTIC_MARKER_ENV = 'DSH_WORKBENCH_PACKAGE_SMOKE_MARKER'
const PACKAGE_SMOKE_OUTPUT_PROBE_ID = 'dsh-workbench-package-smoke-output-probe'

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
  bridgeRuntimeDiagnosticsType?: unknown
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
  diagnostics: {
    compatibilityVerified?: boolean
    inventoryRemoteVerified?: boolean
    logOutputDomVerified?: boolean
    logOutputIpcVerified?: boolean
    logOutputRingVerified?: boolean
    logProfileIsolationVerified?: boolean
    logRedactionVerified?: boolean
    outputPipelineMarker?: string
    overlayAttentionVerified?: boolean
    repairActionVerified?: boolean
    repairHealthyVerified?: boolean
    repairPidTurnoverVerified?: boolean
    repairPortTurnoverVerified?: boolean
    repairUiMounted?: boolean
    staleWindowDestroyed?: boolean
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
    diagnosticsUiEntry?: string
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

interface PackageSmokeDiagnosticProbe {
  readonly canary: string
  readonly marker: string
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

function readPackageSmokeDiagnosticProbe(): PackageSmokeDiagnosticProbe {
  const canary = process.env[DIAGNOSTIC_CANARY_ENV]
  const marker = process.env[DIAGNOSTIC_MARKER_ENV]
  delete process.env[DIAGNOSTIC_CANARY_ENV]
  delete process.env[DIAGNOSTIC_MARKER_ENV]
  if (
    typeof canary !== 'string'
    || !/^package-smoke-canary-[a-f0-9]{64}$/u.test(canary)
    || typeof marker !== 'string'
    || !/^package-smoke-benign-[a-f0-9]{32}$/u.test(marker)
  ) {
    throw new Error('Package smoke diagnostic probe is invalid')
  }
  return Object.freeze({ canary, marker })
}

async function preparePackageSmokeOutputProbe(
  userDataPath: string,
  probe: PackageSmokeDiagnosticProbe,
): Promise<string> {
  const directory = join(userDataPath, 'workbench', 'package-smoke-output-probe')
  const entry = join(directory, 'index.mjs')
  const patch = join(directory, 'probe.patch.json')
  const stdoutPrefix = `${probe.marker}-stdout-before\n`
  const stdoutSuffix = `Authorization: Bearer ${probe.canary}\n${probe.marker}-stdout-after\n`
  const stderrPrefix = `${probe.marker}-stderr-before\n`
  const stderrSuffix = `url=https://example.test/callback?access_token=${probe.canary}&safe=yes\n${probe.marker}-stderr-after\n`
  const source = [
    `export const name = ${JSON.stringify(PACKAGE_SMOKE_OUTPUT_PROBE_ID)}`,
    'export async function apply() {',
    `  process.stdout.write(${JSON.stringify(stdoutPrefix)})`,
    `  process.stderr.write(${JSON.stringify(stderrPrefix)})`,
    '  await new Promise((resolve) => setTimeout(resolve, 100))',
    `  process.stdout.write(${JSON.stringify(stdoutSuffix)})`,
    `  process.stderr.write(${JSON.stringify(stderrSuffix)})`,
    '}',
    '',
  ].join('\n')
  const overlay = [{
    insert: [{
      id: PACKAGE_SMOKE_OUTPUT_PROBE_ID,
      name: pathToFileURL(entry).href,
    }],
  }]
  await mkdir(directory, { mode: 0o700, recursive: true })
  await Promise.all([
    writeFile(entry, source, { encoding: 'utf8', mode: 0o600 }),
    writeFile(patch, `${JSON.stringify(overlay, undefined, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    }),
  ])
  return patch
}

async function writeBrokenFirstPartyOverlay(patch: string): Promise<void> {
  const overlay = JSON.parse(await readFile(patch, 'utf8')) as unknown
  assertSmoke(Array.isArray(overlay) && overlay.length === 1, 'First-party overlay shape is invalid')
  const contribution = overlay[0] as { insert?: unknown }
  assertSmoke(Array.isArray(contribution.insert), 'First-party overlay entries are invalid')
  const entries = contribution.insert.filter((entry): entry is { id: string; name: string } => (
    typeof entry === 'object'
    && entry !== null
    && typeof (entry as { id?: unknown }).id === 'string'
    && typeof (entry as { name?: unknown }).name === 'string'
  ))
  assertSmoke(entries.length === contribution.insert.length, 'First-party overlay entry is invalid')
  const brokenEntries = entries.filter((entry) => entry.id !== 'dsh-workbench-oauth-ui')
  assertSmoke(
    brokenEntries.length === entries.length - 1
    && brokenEntries.some((entry) => entry.id === 'dsh-workbench-diagnostics-ui'),
    'Unable to create a loadable first-party overlay failure',
  )
  const temporaryPatch = `${patch}.package-smoke-${process.pid}-${randomUUID()}`
  await writeFile(temporaryPatch, `${JSON.stringify([{ insert: brokenEntries }], undefined, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  await rename(temporaryPatch, patch)
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

async function openSettingsDialog(window: BrowserWindow): Promise<void> {
  await window.webContents.executeJavaScript(`(() => {
    const labels = new Set(["Continue", "继续"])
    const button = [...document.querySelectorAll("button")]
      .find((candidate) => labels.has(candidate.innerText.trim()))
    button?.click()
    return true
  })()`, true)

  await waitForRendererCondition(window, `(() => {
    const labels = new Set(["Settings", "设置"])
    const newSessionLabels = new Set(["New session", "新建会话"])
    const buttons = [...document.querySelectorAll("button")]
    const newSessionButton = buttons.find((candidate) => (
      newSessionLabels.has(candidate.getAttribute("aria-label"))
    ))
    let sidebar = newSessionButton?.parentElement
    while (sidebar && !sidebar.querySelector('button[aria-haspopup="dialog"][aria-expanded]')) {
      sidebar = sidebar.parentElement
    }
    const button = buttons.find((candidate) => labels.has(candidate.innerText.trim()))
      ?? sidebar?.querySelector('button[aria-haspopup="dialog"][aria-expanded]')
    if (!button) return false
    if (button.getAttribute("aria-expanded") !== "true") {
      button.click()
      return false
    }
    const dialog = document.querySelector('[role="dialog"][aria-modal="true"]')
    if (!dialog) return false
    const navigationLabels = new Set(
      [...dialog.querySelectorAll("nav button")].map((candidate) => candidate.innerText.trim()),
    )
    return ["Profiles", "配置档案"].some((label) => navigationLabels.has(label))
      && ["Plugins", "插件"].some((label) => navigationLabels.has(label))
  })()`, 'the Settings dialog')
}

async function openProfilesUi(
  window: BrowserWindow,
  expectedProfiles: readonly { id: string; name: string }[],
): Promise<void> {
  await openSettingsDialog(window)

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

function diagnosticMarker(profileId: string, generation: number): string {
  return `package-smoke-runtime-${profileId}-${generation}`
}

function assertDiagnosticProbeEvidence(
  serialized: string,
  probe: PackageSmokeDiagnosticProbe,
  location: string,
): void {
  for (const suffix of [
    '-stdout-before',
    '-stdout-after',
    '-stderr-before',
    '-stderr-after',
  ]) {
    assertSmoke(
      serialized.includes(`${probe.marker}${suffix}`),
      `${location} omitted the packaged DSH output marker ${suffix}`,
    )
  }
  assertSmoke(serialized.includes('[REDACTED]'), `${location} omitted the output redaction marker`)
  assertSmoke(serialized.includes('safe=yes'), `${location} omitted the benign query marker`)
  assertSmoke(!serialized.includes(probe.canary), `${location} exposed the diagnostic canary`)
}

async function waitForRuntimeProbeEvidence(
  log: RuntimeDiagnosticLog,
  context: { generation: number; profileId: string },
  probe: PackageSmokeDiagnosticProbe,
): Promise<void> {
  const deadline = Date.now() + PROFILE_UI_TIMEOUT_MS
  while (Date.now() < deadline) {
    const serialized = JSON.stringify(log.read(context, { limit: 200 }))
    if (
      serialized.includes(`${probe.marker}-stdout-after`)
      && serialized.includes(`${probe.marker}-stderr-after`)
    ) {
      assertDiagnosticProbeEvidence(serialized, probe, 'Runtime diagnostic ring')
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('Timed out waiting for packaged DSH output in the runtime diagnostic ring')
}

async function readRendererDiagnostics(window: BrowserWindow): Promise<{
  snapshot: { generation: number; profileId: string; runtimeState: string }
  tail: { entries: Array<{ text: string }>; latestCursor: number; nextCursor: number }
}> {
  const serialized = await window.webContents.executeJavaScript(`(async () => JSON.stringify({
    snapshot: await globalThis.dshWorkbench.runtimeDiagnostics.snapshot(),
    tail: await globalThis.dshWorkbench.runtimeDiagnostics.readTail(0, 200),
  }))()`, true) as unknown
  assertSmoke(typeof serialized === 'string', 'Runtime diagnostics bridge returned unserializable data')
  const value = JSON.parse(serialized) as {
    snapshot?: { generation?: unknown; profileId?: unknown; runtimeState?: unknown }
    tail?: { entries?: unknown; latestCursor?: unknown; nextCursor?: unknown }
  }
  assertSmoke(
    Number.isSafeInteger(value.snapshot?.generation)
    && typeof value.snapshot?.profileId === 'string'
    && typeof value.snapshot?.runtimeState === 'string',
    'Runtime diagnostics snapshot is invalid',
  )
  assertSmoke(
    Array.isArray(value.tail?.entries)
    && Number.isSafeInteger(value.tail?.latestCursor)
    && Number.isSafeInteger(value.tail?.nextCursor),
    'Runtime diagnostics tail is invalid',
  )
  assertSmoke(value.tail.entries.every((entry) => (
    typeof entry === 'object'
    && entry !== null
    && typeof (entry as { text?: unknown }).text === 'string'
  )), 'Runtime diagnostics tail contains an invalid entry')
  return value as {
    snapshot: { generation: number; profileId: string; runtimeState: string }
    tail: { entries: Array<{ text: string }>; latestCursor: number; nextCursor: number }
  }
}

async function openDiagnosticsUi(window: BrowserWindow): Promise<void> {
  await openSettingsDialog(window)

  await waitForRendererCondition(window, `(() => {
    const labels = new Set(["Plugins", "插件"])
    const button = [...document.querySelectorAll("button")]
      .find((candidate) => labels.has(candidate.innerText.trim()))
    if (!button) return false
    button.click()
    return true
  })()`, 'the Plugins navigation item')

  await waitForRendererCondition(window, `(() => {
    const labels = new Set(["Workbench diagnostics", "Workbench 诊断"])
    const button = [...document.querySelectorAll("button,[role=tab]")]
      .find((candidate) => labels.has(candidate.innerText.trim()))
    if (!button) return false
    button.click()
    return true
  })()`, 'the Workbench diagnostics tab')
}

async function readDiagnosticsCompatibility(window: BrowserWindow): Promise<{
  health?: unknown
  repairActionPresent: boolean
  rows: Array<{ entryId: string | null; status: string | null }>
}> {
  const serialized = await window.webContents.executeJavaScript(`(() => {
    const root = document.querySelector("[data-workbench-diagnostics]")
    return JSON.stringify({
      health: root?.getAttribute("data-diagnostics-health"),
      repairActionPresent: Boolean(root?.querySelector('[data-diagnostics-action="repair-first-party-overlay"]')),
      rows: [...(root?.querySelectorAll("[data-diagnostics-entry]") ?? [])].map((row) => ({
        entryId: row.getAttribute("data-diagnostics-entry"),
        status: row.getAttribute("data-diagnostics-status"),
      })),
    })
  })()`, true) as unknown
  assertSmoke(typeof serialized === 'string', 'Diagnostics compatibility state is unserializable')
  const value = JSON.parse(serialized) as {
    health?: unknown
    repairActionPresent?: unknown
    rows?: unknown
  }
  assertSmoke(
    typeof value.repairActionPresent === 'boolean'
    && Array.isArray(value.rows)
    && value.rows.every((row) => (
      typeof row === 'object'
      && row !== null
      && (typeof (row as { entryId?: unknown }).entryId === 'string'
        || (row as { entryId?: unknown }).entryId === null)
      && (typeof (row as { status?: unknown }).status === 'string'
        || (row as { status?: unknown }).status === null)
    )),
    'Diagnostics compatibility state is invalid',
  )
  return value as {
    health?: unknown
    repairActionPresent: boolean
    rows: Array<{ entryId: string | null; status: string | null }>
  }
}

async function verifyDiagnosticsUi(
  window: BrowserWindow,
  expectedMarker: string,
  probe: PackageSmokeDiagnosticProbe,
): Promise<void> {
  await openDiagnosticsUi(window)

  await waitForRendererCondition(window, `(() => {
    const root = document.querySelector("[data-workbench-diagnostics]")
    if (!root || root.getAttribute("data-diagnostics-health") === "loading") return false
    const expected = [
      "dsh-workbench-authorization",
      "dsh-workbench-desktop-core",
      "dsh-workbench-oauth-ui",
      "dsh-workbench-diagnostics-ui",
    ]
    const rows = [...root.querySelectorAll("[data-diagnostics-entry]")]
    return rows.length === expected.length && expected.every((entryId) => rows.some((row) => (
      row.getAttribute("data-diagnostics-entry") === entryId
    )))
  })()`, 'Workbench diagnostics from the official plugin inventory')

  const compatibility = await readDiagnosticsCompatibility(window)
  assertSmoke(
    compatibility.health === 'healthy',
    `Workbench diagnostics reported ${JSON.stringify(compatibility)}`,
  )

  const diagnostics = await readRendererDiagnostics(window)
  const serialized = JSON.stringify(diagnostics)
  assertSmoke(serialized.includes(expectedMarker), 'Runtime diagnostics omitted the active generation marker')
  assertDiagnosticProbeEvidence(serialized, probe, 'Runtime diagnostics IPC')

  const rootText = await window.webContents.executeJavaScript(
    'document.querySelector("[data-workbench-diagnostics]")?.innerText ?? ""',
    true,
  ) as unknown
  assertSmoke(typeof rootText === 'string' && rootText.includes(expectedMarker), 'Diagnostics UI omitted the active generation marker')
  assertDiagnosticProbeEvidence(rootText, probe, 'Diagnostics UI DOM')

  await waitForRendererCondition(window, `(() => {
    const labels = new Set(["Profiles", "配置档案"])
    const button = [...document.querySelectorAll("button")]
      .find((candidate) => labels.has(candidate.innerText.trim()))
    if (!button) return false
    button.click()
    return true
  })()`, 'the Profiles navigation item after diagnostics verification')
  await waitForRendererCondition(
    window,
    'Boolean(document.querySelector("[data-workbench-profiles]"))',
    'the restored Profiles section after diagnostics verification',
  )
}

async function clickDiagnosticsRestart(window: BrowserWindow): Promise<void> {
  await openDiagnosticsUi(window)
  await waitForRendererCondition(
    window,
    'document.querySelector("[data-workbench-diagnostics]")?.getAttribute("data-diagnostics-health") === "healthy"',
    'healthy Workbench diagnostics before restart',
  )
  await waitForRendererCondition(window, `(() => {
    const button = document.querySelector('[data-diagnostics-action="restart-active-runtime"]')
    if (!button || button.disabled) return false
    button.click()
    return true
  })()`, 'the diagnostics runtime restart action')
}

async function clickDiagnosticsOverlayRepair(
  window: BrowserWindow,
  expectedMarker: string,
  probe: PackageSmokeDiagnosticProbe,
): Promise<void> {
  await openDiagnosticsUi(window)
  await waitForRendererCondition(window, `(() => {
    const root = document.querySelector("[data-workbench-diagnostics]")
    const missing = root?.querySelector('[data-diagnostics-entry="dsh-workbench-oauth-ui"]')
    const repair = root?.querySelector('[data-diagnostics-action="repair-first-party-overlay"]')
    return root?.getAttribute("data-diagnostics-health") === "attention"
      && missing?.getAttribute("data-diagnostics-status") === "missing"
      && Boolean(repair && !repair.disabled)
  })()`, 'a loadable first-party overlay failure and its repair action')

  const compatibility = await readDiagnosticsCompatibility(window)
  assertSmoke(compatibility.health === 'attention', 'Broken overlay did not require attention')
  assertSmoke(
    compatibility.rows.some((row) => (
      row.entryId === 'dsh-workbench-oauth-ui' && row.status === 'missing'
    )),
    'Broken overlay did not report the intentionally missing OAuth UI entry',
  )
  assertSmoke(compatibility.repairActionPresent, 'Broken overlay did not render its repair action')

  const diagnostics = await readRendererDiagnostics(window)
  const serialized = JSON.stringify(diagnostics)
  assertSmoke(serialized.includes(expectedMarker), 'Broken-overlay diagnostics omitted the active generation marker')
  assertDiagnosticProbeEvidence(serialized, probe, 'Broken-overlay diagnostics IPC')
  const rootText = await window.webContents.executeJavaScript(
    'document.querySelector("[data-workbench-diagnostics]")?.innerText ?? ""',
    true,
  ) as unknown
  assertSmoke(typeof rootText === 'string', 'Broken-overlay diagnostics DOM is unavailable')
  assertDiagnosticProbeEvidence(rootText, probe, 'Broken-overlay diagnostics DOM')

  await waitForRendererCondition(window, `(() => {
    const button = document.querySelector('[data-diagnostics-action="repair-first-party-overlay"]')
    if (!button || button.disabled) return false
    button.click()
    return true
  })()`, 'the first-party overlay repair action')
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
          bridgeRuntimeDiagnosticsType: typeof globalThis.dshWorkbench?.runtimeDiagnostics?.snapshot,
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
  const diagnosticProbe = readPackageSmokeDiagnosticProbe()
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
    diagnostics: { outputPipelineMarker: diagnosticProbe.marker },
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
  const runtimeDiagnostics = new RuntimeDiagnosticLog()
  const runtimes: DshRuntime[] = []
  const startedSessions: ProfileRuntimeSession[] = []
  const previousAmbientCredentialProbe = process.env[AMBIENT_CREDENTIAL_PROBE_REF]
  let ambientCredentialProbeInjected = false
  let uninstallProfileIpc: (() => void) | undefined
  let uninstallRuntimeDiagnosticsIpc: (() => void) | undefined
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
    const outputProbePatch = await preparePackageSmokeOutputProbe(
      options.userDataPath,
      diagnosticProbe,
    )
    const desktopCoreEntry = await realpath(desktopCore.entry)
    const diagnosticsUiEntry = await realpath(desktopCore.diagnosticsEntry)
    const oauthUiEntry = await realpath(desktopCore.oauthEntry)
    assertSmoke(isPathInside(packagedAppRoot, dshBin), 'DSH executable escaped the packaged application')
    assertSmoke(
      isPathInside(packagedAppRoot, desktopCoreEntry),
      'Desktop Core entry escaped the packaged application',
    )
    assertSmoke(
      isPathInside(packagedAppRoot, diagnosticsUiEntry),
      'Diagnostics UI entry escaped the packaged application',
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
    report.runtime.diagnosticsUiEntry = diagnosticsUiEntry
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
      (active, onExit, generation) => {
        prepareProfileModuleFallback(active.paths.dshHome)
        const diagnosticContext = { generation, profileId: active.profile.id }
        runtimeDiagnostics.append(diagnosticContext, {
          code: 'PACKAGE_SMOKE_RUNTIME',
          level: 'info',
          text: diagnosticMarker(active.profile.id, generation),
        })
        const runtime = new DshRuntime({
          cwd: active.paths.workspace,
          env: buildProfileEnvironment(process.env, active.paths.dshHome),
          onExit: (event) => {
            runtimeExitEvents.push(event)
            onExit(event)
          },
          onOutput: (event) => runtimeDiagnostics.appendOutput(diagnosticContext, event),
          patchFiles: [desktopCore.patch, outputProbePatch],
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
    uninstallRuntimeDiagnosticsIpc = installRuntimeDiagnosticsIpc({
      appVersion: app.getVersion(),
      confirmRepair: async () => true,
      controller,
      dshVersion: dshPackage.version,
      getWindow: () => window,
      log: runtimeDiagnostics,
      repairFirstPartyOverlay: async (session) => {
        await prepareDesktopCoreContribution(options.userDataPath)
        prepareProfileModuleFallback(session.paths.dshHome)
      },
      transitions,
    })

    const initialSession = await controller.startActive()
    await writeSmokeProgress(options.phase, 'initial-runtime-ready')
    startedSessions.push(initialSession)
    await waitForRuntimeProbeEvidence(runtimeDiagnostics, {
      generation: initialSession.generation,
      profileId: initialSession.profile.id,
    }, diagnosticProbe)
    report.diagnostics.logOutputRingVerified = true
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
    assertSmoke(
      html.includes('@dsh-workbench/diagnostics-ui'),
      'Packaged DSH boot payload is missing the Diagnostics UI client bundle',
    )
    assertSmoke(
      !html.includes('@dsh-workbench/gpt-tools'),
      'Packaged DSH boot payload unexpectedly includes the optional GPT tools plugin',
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
    assertSmoke(
      initialWindow.probe.bridgeRuntimeDiagnosticsType === 'function',
      'Preload runtime diagnostics bridge is unavailable',
    )
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
    await verifyDiagnosticsUi(
      initialWindow.window,
      diagnosticMarker(initialSession.profile.id, initialSession.generation),
      diagnosticProbe,
    )
    report.diagnostics.compatibilityVerified = true
    report.diagnostics.inventoryRemoteVerified = true
    report.diagnostics.logOutputDomVerified = true
    report.diagnostics.logOutputIpcVerified = true
    report.diagnostics.logRedactionVerified = true
    report.diagnostics.repairUiMounted = true
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
    const middleDiagnostics = await readRendererDiagnostics(middleWindow)
    const middleDiagnosticsText = JSON.stringify(middleDiagnostics)
    assertSmoke(
      middleDiagnosticsText.includes(diagnosticMarker(middleSession.profile.id, middleSession.generation)),
      'Middle profile diagnostics omitted its active generation marker',
    )
    assertSmoke(
      !middleDiagnosticsText.includes(diagnosticMarker(initialSession.profile.id, initialSession.generation)),
      'Middle profile diagnostics inherited the previous profile generation',
    )
    assertDiagnosticProbeEvidence(middleDiagnosticsText, diagnosticProbe, 'Middle profile diagnostics IPC')
    report.diagnostics.logProfileIsolationVerified = true
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
    let reportWindow = finalWindow
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
      reportWindow = persistedActivation.window
    }

    const healthySession = reportSession
    const healthyWindow = reportWindow
    await openProfilesUi(healthyWindow, expectedProfiles())
    await verifyDiagnosticsUi(
      healthyWindow,
      diagnosticMarker(healthySession.profile.id, healthySession.generation),
      diagnosticProbe,
    )
    await writeBrokenFirstPartyOverlay(desktopCore.patch)
    await clickDiagnosticsRestart(healthyWindow)
    const brokenActivation = await waitForActivatedProfile(
      healthySession.profile.id,
      healthyWindow,
    )
    await transitions.waitForIdle()
    const brokenSession = brokenActivation.session
    startedSessions.push(brokenSession)
    assertSmoke(
      brokenSession.generation > healthySession.generation,
      'Applying the broken overlay did not advance the runtime generation',
    )
    assertSmoke(
      brokenSession.ready.pid !== healthySession.ready.pid,
      'Applying the broken overlay did not replace the DSH process',
    )
    assertSmoke(!isProcessAlive(healthySession.ready.pid), 'The pre-failure DSH process survived restart')
    assertSmoke(healthyWindow.isDestroyed(), 'The broken-overlay restart retained the healthy BrowserWindow')
    await waitForRuntimeProbeEvidence(runtimeDiagnostics, {
      generation: brokenSession.generation,
      profileId: brokenSession.profile.id,
    }, diagnosticProbe)
    await clickDiagnosticsOverlayRepair(
      brokenActivation.window,
      diagnosticMarker(brokenSession.profile.id, brokenSession.generation),
      diagnosticProbe,
    )
    report.diagnostics.overlayAttentionVerified = true
    report.diagnostics.repairActionVerified = true

    const repairedActivation = await waitForActivatedProfile(
      brokenSession.profile.id,
      brokenActivation.window,
    )
    await transitions.waitForIdle()
    const repairedSession = repairedActivation.session
    startedSessions.push(repairedSession)
    assertSmoke(
      repairedSession.generation > brokenSession.generation,
      'Overlay repair did not advance the runtime generation',
    )
    assertSmoke(
      repairedSession.ready.pid !== brokenSession.ready.pid,
      'Overlay repair did not replace the DSH process',
    )
    assertSmoke(
      !isProcessAlive(brokenSession.ready.pid),
      'The broken-overlay DSH process survived repair',
    )
    assertSmoke(
      repairedSession.ready.url !== brokenSession.ready.url,
      'Overlay repair reused the broken runtime port instead of turning it over',
    )
    const brokenUrl = new URL(brokenSession.ready.url)
    assertSmoke(
      !(await isPortOpen(brokenUrl.hostname, Number(brokenUrl.port))),
      'The broken-overlay DSH port survived repair',
    )
    assertSmoke(brokenActivation.window.isDestroyed(), 'Overlay repair left the stale BrowserWindow alive')
    await waitForRuntimeProbeEvidence(runtimeDiagnostics, {
      generation: repairedSession.generation,
      profileId: repairedSession.profile.id,
    }, diagnosticProbe)
    await verifyDiagnosticsUi(
      repairedActivation.window,
      diagnosticMarker(repairedSession.profile.id, repairedSession.generation),
      diagnosticProbe,
    )
    const repairedDiagnostics = await readRendererDiagnostics(repairedActivation.window)
    const repairedDiagnosticsText = JSON.stringify(repairedDiagnostics)
    assertSmoke(
      repairedDiagnosticsText.includes(diagnosticMarker(repairedSession.profile.id, repairedSession.generation)),
      'Repaired runtime diagnostics omitted the new generation marker',
    )
    assertSmoke(
      !repairedDiagnosticsText.includes(diagnosticMarker(
        brokenSession.profile.id,
        brokenSession.generation,
      )),
      'Repaired runtime diagnostics retained the stale generation',
    )
    assertDiagnosticProbeEvidence(repairedDiagnosticsText, diagnosticProbe, 'Repaired diagnostics IPC')
    report.diagnostics.repairHealthyVerified = true
    report.diagnostics.repairPidTurnoverVerified = true
    report.diagnostics.repairPortTurnoverVerified = true
    report.diagnostics.staleWindowDestroyed = true
    reportSession = repairedSession

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
    uninstallRuntimeDiagnosticsIpc?.()
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

  if (JSON.stringify(report).includes(diagnosticProbe.canary)) {
    captureFailure(new Error('Packaged smoke report exposed the diagnostic canary'))
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
