import {
  execFileSync,
  spawn,
  spawnSync,
  type ChildProcess,
} from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

const require = createRequire(import.meta.url)

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 7_000
const FORCE_KILL_TIMEOUT_MS = 2_000
const MAX_OUTPUT_BYTES = 64 * 1024
const MAX_UNTERMINATED_OUTPUT_CHARS = 16 * 1024
const LOOPBACK_HOST = '127.0.0.1'
const READY_MESSAGE_TYPE = 'dsh-workbench/ready'
const SHUTDOWN_MESSAGE_TYPE = 'dsh-workbench/shutdown'
const DESKTOP_PROTOCOL_VERSION = 1
const UNSAFE_DSH_ENVIRONMENT_KEYS = new Set([
  'ELECTRON_RUN_AS_NODE',
  'NODE_OPTIONS',
  'NODE_PATH',
])

export interface DshRuntimeProcessTableEntry {
  readonly pgid: number
  readonly pid: number
  readonly ppid: number
}

export type DshRuntimeState = 'idle' | 'starting' | 'running' | 'stopping' | 'failed'
export type DshRuntimeErrorStage = 'spawn' | 'startup' | 'readiness' | 'shutdown'

export interface DshRuntimeReady {
  pid: number
  profileEvidence?: DshRuntimeProfileEvidence
  url: string
}

export interface DshRuntimeProfileEvidence {
  readonly ambientCredentialConfigured: boolean
  readonly credentialRecordCount: number
  readonly credentialRecordFingerprint: string
  readonly cwd: string
  readonly dshHome: string
}

export interface DshRuntimeExit {
  code: number | null
  expected: boolean
  output: string
  signal: NodeJS.Signals | null
}

export interface DshRuntimeOutput {
  readonly stream: 'stderr' | 'stdout'
  readonly text: string
}

export interface DshRuntimeOptions {
  cwd?: string
  dshBin?: string
  env?: NodeJS.ProcessEnv
  execPath?: string
  onExit?: (event: DshRuntimeExit) => void
  onOutput?: (event: DshRuntimeOutput) => void
  patchFiles?: readonly string[]
  port?: number
  /** Test seam for deterministic process-tree cleanup coverage. */
  processTable?: () => readonly DshRuntimeProcessTableEntry[]
  readinessProbe?: (url: string, signal: AbortSignal) => Promise<void>
  shutdownTimeoutMs?: number
  startupTimeoutMs?: number
}

interface DesktopReadyMessage {
  profileEvidence?: DshRuntimeProfileEvidence
  protocolVersion: 1
  type: typeof READY_MESSAGE_TYPE
  url: string
}

export function sanitizeDshOutput(value: string): string {
  const withoutTerminalControls = value
    .replace(/\u001B(?:\][^\u0007]*(?:\u0007|\u001B\\)|\[[0-?]*[ -/]*[@-~]|[@-_])/gu, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001A\u001C-\u001F\u007F]/gu, '')
    .replace(/[\u202A-\u202E\u2066-\u2069]/gu, '')
  const sensitiveName = String.raw`(?:[a-z0-9_-]*(?:access[_-]?token|refresh[_-]?token|api[_-]?key|client[_-]?secret|device[_-]?code|user[_-]?code|authorization|password|secret|cookie)[a-z0-9_-]*)`
  return withoutTerminalControls
    .replace(/(\b(?:Proxy-)?Authorization\s*:\s*)[^\r\n]*/giu, '$1[REDACTED]')
    .replace(/(\b(?:Set-)?Cookie\s*:\s*)[^\r\n]*/giu, '$1[REDACTED]')
    .replace(/(\b(?:Basic|Bearer)\s+)[A-Za-z0-9._~+/-]+=*/giu, '$1[REDACTED]')
    .replace(new RegExp(`(\\b${sensitiveName}\\b\\s*["']?\\s*[:=]\\s*)(["'])(.*?)\\2`, 'giu'), '$1$2[REDACTED]$2')
    .replace(new RegExp(`(\\b${sensitiveName}\\b\\s*["']?\\s*[:=]\\s*)([^\\s,"';&}]+)`, 'giu'), '$1[REDACTED]')
    .replace(new RegExp(`([?&]${sensitiveName}=)[^&#\\s]*`, 'giu'), '$1[REDACTED]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|AIza[0-9A-Za-z_-]{12,})\b/gu, '[REDACTED]')
}

export class DshOutputSanitizer {
  readonly #decoder = new StringDecoder('utf8')
  #discarding = false
  #pending = ''

  push(chunk: Buffer): readonly string[] {
    this.#pending += this.#decoder.write(chunk)
    return this.#drain(false)
  }

  finish(): readonly string[] {
    this.#pending += this.#decoder.end()
    return this.#drain(true)
  }

  #drain(final: boolean): readonly string[] {
    const output: string[] = []
    while (this.#pending.length > 0) {
      const boundary = this.#pending.search(/[\r\n]/u)
      if (this.#discarding) {
        if (boundary < 0) {
          this.#pending = ''
          break
        }
        this.#pending = this.#pending.slice(boundary + 1)
        this.#discarding = false
        continue
      }
      if (boundary >= 0) {
        const terminatorLength = this.#pending[boundary] === '\r' && this.#pending[boundary + 1] === '\n'
          ? 2
          : 1
        if (boundary > MAX_UNTERMINATED_OUTPUT_CHARS) {
          output.push('[output omitted: line exceeded the diagnostic limit]\n')
        } else {
          output.push(sanitizeDshOutput(this.#pending.slice(0, boundary + terminatorLength)))
        }
        this.#pending = this.#pending.slice(boundary + terminatorLength)
        continue
      }
      if (this.#pending.length > MAX_UNTERMINATED_OUTPUT_CHARS) {
        output.push('[output omitted: unterminated line exceeded the diagnostic limit]\n')
        this.#pending = ''
        this.#discarding = true
      }
      break
    }
    if (final && !this.#discarding && this.#pending.length > 0) {
      output.push(sanitizeDshOutput(this.#pending))
      this.#pending = ''
    }
    return output
  }
}

class OutputTail {
  readonly #chunks: Buffer[] = []
  #size = 0

  append(stream: 'stdout' | 'stderr', text: string): void {
    const tagged = Buffer.from(`[${stream}] ${text}`)
    this.#chunks.push(tagged)
    this.#size += tagged.byteLength

    while (this.#size > MAX_OUTPUT_BYTES && this.#chunks.length > 0) {
      const first = this.#chunks[0]
      if (!first) break

      const overflow = this.#size - MAX_OUTPUT_BYTES
      if (first.byteLength <= overflow) {
        this.#chunks.shift()
        this.#size -= first.byteLength
      } else {
        this.#chunks[0] = first.subarray(overflow)
        this.#size -= overflow
      }
    }
  }

  toString(): string {
    return Buffer.concat(this.#chunks).toString('utf8').trim()
  }
}

export class DshRuntimeError extends Error {
  readonly output: string
  readonly stage: DshRuntimeErrorStage

  constructor(
    stage: DshRuntimeErrorStage,
    message: string,
    options: { cause?: unknown; output?: string } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'DshRuntimeError'
    this.output = options.output ?? ''
    this.stage = stage
  }
}

function validatePort(port: number): void {
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new RangeError(`DSH port must be an integer between 0 and 65535, got ${port}`)
  }
}

function validateTimeout(name: string, timeoutMs: number): void {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError(`${name} must be greater than zero, got ${timeoutMs}`)
  }
}

export function buildDshWebArgs(
  patchFiles: readonly string[] = [],
  port = 0,
): string[] {
  validatePort(port)
  return [
    'web',
    ...patchFiles.flatMap((file) => ['--patch', file]),
    '--no-open',
    '--host',
    LOOPBACK_HOST,
    '--port',
    String(port),
  ]
}

export function buildDshProcessArgs(
  dshBin: string,
  patchFiles: readonly string[] = [],
  port = 0,
): string[] {
  return ['--expose-internals', dshBin, ...buildDshWebArgs(patchFiles, port)]
}

export function sanitizeDshEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([key]) => !UNSAFE_DSH_ENVIRONMENT_KEYS.has(key.toUpperCase()),
    ),
  )
}

export function parseDesktopReadyMessage(message: unknown): DesktopReadyMessage | undefined {
  if (typeof message !== 'object' || message === null) return undefined

  const candidate = message as Record<string, unknown>
  if (
    candidate.type !== READY_MESSAGE_TYPE
    || candidate.protocolVersion !== DESKTOP_PROTOCOL_VERSION
    || typeof candidate.url !== 'string'
  ) {
    return undefined
  }

  const profileEvidence = parseProfileEvidence(candidate.profileEvidence)
  if ('profileEvidence' in candidate && !profileEvidence) return undefined

  try {
    const url = new URL(candidate.url)
    const port = Number(url.port)
    if (
      url.protocol !== 'http:'
      || url.hostname !== LOOPBACK_HOST
      || url.username !== ''
      || url.password !== ''
      || url.pathname !== '/'
      || url.search !== ''
      || url.hash !== ''
      || !Number.isInteger(port)
      || port < 1
      || port > 65_535
    ) {
      return undefined
    }

    return {
      ...(profileEvidence === undefined ? {} : { profileEvidence }),
      protocolVersion: DESKTOP_PROTOCOL_VERSION,
      type: READY_MESSAGE_TYPE,
      url: url.origin,
    }
  } catch {
    return undefined
  }
}

function parseProfileEvidence(value: unknown): DshRuntimeProfileEvidence | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const candidate = value as Record<string, unknown>
  if (
    Object.keys(candidate).length !== 5
    || typeof candidate.ambientCredentialConfigured !== 'boolean'
    || !Number.isSafeInteger(candidate.credentialRecordCount)
    || (candidate.credentialRecordCount as number) < 0
    || typeof candidate.credentialRecordFingerprint !== 'string'
    || !/^[a-f0-9]{64}$/u.test(candidate.credentialRecordFingerprint)
    || typeof candidate.cwd !== 'string'
    || !isAbsolute(candidate.cwd)
    || typeof candidate.dshHome !== 'string'
    || !isAbsolute(candidate.dshHome)
  ) {
    return undefined
  }
  return Object.freeze({
    ambientCredentialConfigured: candidate.ambientCredentialConfigured,
    credentialRecordCount: candidate.credentialRecordCount as number,
    credentialRecordFingerprint: candidate.credentialRecordFingerprint,
    cwd: candidate.cwd,
    dshHome: candidate.dshHome,
  })
}

export function resolveDshBin(): string {
  const packageJson = require.resolve('@deepseek-ai/dsh/package.json')
  return join(dirname(packageJson), 'lib', 'bin.js')
}

export function resolveDshVersion(): string {
  const manifest = require('@deepseek-ai/dsh/package.json') as { version?: unknown }
  if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
    throw new Error('The pinned DSH package has no valid version')
  }
  return manifest.version
}

async function defaultReadinessProbe(url: string, signal: AbortSignal): Promise<void> {
  const response = await fetch(url, { signal })
  if (!response.ok) {
    throw new Error(`DSH readiness returned HTTP ${response.status}`)
  }

  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().includes('text/html')) {
    throw new Error(`DSH readiness returned ${contentType || 'an unknown content type'}`)
  }

  const html = await response.text()
  if (!html.includes('__DSH_BOOT__')) {
    throw new Error('DSH readiness page is missing its boot payload')
  }
}

function waitForClose(closePromise: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs)
    void closePromise.then(() => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs)
    void operation.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function readPosixProcessTable(): DshRuntimeProcessTableEntry[] {
  const output = execFileSync('ps', ['-axo', 'pid=,ppid=,pgid='], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  return output.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/u.exec(line)
    if (!match) return []
    return [{ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]) }]
  })
}

function readWindowsProcessTable(): DshRuntimeProcessTableEntry[] {
  const output = execFileSync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }',
  ], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  })
  return output.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s*$/u.exec(line)
    if (!match) return []
    const pid = Number(match[1])
    return [{ pgid: pid, pid, ppid: Number(match[2]) }]
  })
}

function readProcessTable(): DshRuntimeProcessTableEntry[] {
  return process.platform === 'win32'
    ? readWindowsProcessTable()
    : readPosixProcessTable()
}

function processTargetsForTree(
  rootPid: number,
  entries: readonly DshRuntimeProcessTableEntry[],
): { groups: number[]; pids: number[] } {
  const byParent = new Map<number, DshRuntimeProcessTableEntry[]>()
  for (const entry of entries) {
    const children = byParent.get(entry.ppid) ?? []
    children.push(entry)
    byParent.set(entry.ppid, children)
  }
  const pending = [rootPid]
  const descendants = new Set([rootPid])
  while (pending.length > 0) {
    const parent = pending.shift()
    if (parent === undefined) break
    for (const child of byParent.get(parent) ?? []) {
      if (descendants.has(child.pid)) continue
      descendants.add(child.pid)
      pending.push(child.pid)
    }
  }

  const ownGroup = entries.find((entry) => entry.pid === process.pid)?.pgid
  const groups = new Set<number>()
  const pids = new Set<number>()
  for (const entry of entries) {
    if (!descendants.has(entry.pid) || entry.pid === rootPid) continue
    if (process.platform === 'win32') pids.add(entry.pid)
    else if (entry.pgid > 0 && entry.pgid !== ownGroup) groups.add(entry.pgid)
    else pids.add(entry.pid)
  }
  return { groups: [...groups].sort((left, right) => left - right), pids: [...pids] }
}

function snapshotProcessTargets(
  rootPid: number,
  readProcessTable: () => readonly DshRuntimeProcessTableEntry[],
): { groups: number[]; pids: number[] } {
  try {
    return processTargetsForTree(rootPid, readProcessTable())
  } catch {
    return { groups: [], pids: [] }
  }
}

function signalProcessTargets(
  targets: { groups: readonly number[]; pids: readonly number[] },
  signal: NodeJS.Signals,
): void {
  if (process.platform === 'win32') {
    for (const descendantPid of targets.pids) {
      spawnSync('taskkill.exe', ['/pid', String(descendantPid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
      })
    }
    return
  }
  for (const group of targets.groups) {
    try {
      process.kill(-group, signal)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
  for (const descendantPid of targets.pids) {
    try {
      process.kill(descendantPid, signal)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
}

function processTargetsAreAlive(
  targets: { groups: readonly number[]; pids: readonly number[] },
): boolean {
  const probes = [
    ...targets.groups.map((group) => -group),
    ...targets.pids,
  ]
  return probes.some((pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM'
    }
  })
}

async function terminateSnapshotTargets(
  targets: { groups: readonly number[]; pids: readonly number[] },
): Promise<boolean> {
  if (targets.groups.length === 0 && targets.pids.length === 0) return true
  signalProcessTargets(targets, 'SIGKILL')
  const deadline = Date.now() + FORCE_KILL_TIMEOUT_MS
  while (processTargetsAreAlive(targets) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return !processTargetsAreAlive(targets)
}

async function signalProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals,
  readProcessTable: () => readonly DshRuntimeProcessTableEntry[],
): Promise<void> {
  const pid = child.pid
  if (pid === undefined || pid <= 0) return
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/pid', String(pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    return
  }

  const targets = snapshotProcessTargets(pid, readProcessTable)
  signalProcessTargets(targets, signal)
  if (targets.groups.length > 0 || targets.pids.length > 0) {
    // Give the still-live DSH parent one event-loop turn to reap terminated
    // descendants before the root itself is signalled.
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  child.kill(signal)
}

export class DshRuntime {
  readonly #cwd: string
  readonly #dshBin: string
  readonly #env: NodeJS.ProcessEnv
  readonly #execPath: string
  readonly #onExit: ((event: DshRuntimeExit) => void) | undefined
  readonly #onOutput: ((event: DshRuntimeOutput) => void) | undefined
  readonly #patchFiles: readonly string[]
  readonly #port: number
  readonly #readProcessTable: () => readonly DshRuntimeProcessTableEntry[]
  readonly #readinessProbe: (url: string, signal: AbortSignal) => Promise<void>
  readonly #shutdownTimeoutMs: number
  readonly #startupTimeoutMs: number
  #child: ChildProcess | undefined
  #closePromise: Promise<void> | undefined
  #gracefulChild: ChildProcess | undefined
  #ready: DshRuntimeReady | undefined
  #startPromise: Promise<DshRuntimeReady> | undefined
  #state: DshRuntimeState = 'idle'
  #stopPromise: Promise<void> | undefined

  constructor(options: DshRuntimeOptions = {}) {
    const port = options.port ?? 0
    validatePort(port)

    this.#cwd = options.cwd ?? process.cwd()
    this.#dshBin = options.dshBin ?? resolveDshBin()
    this.#env = sanitizeDshEnvironment(options.env ?? process.env)
    this.#execPath = options.execPath ?? process.execPath
    this.#onExit = options.onExit
    this.#onOutput = options.onOutput
    this.#patchFiles = [...options.patchFiles ?? []]
    this.#port = port
    this.#readProcessTable = options.processTable ?? readProcessTable
    this.#readinessProbe = options.readinessProbe ?? defaultReadinessProbe
    this.#shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS
    this.#startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS
    validateTimeout('DSH shutdown timeout', this.#shutdownTimeoutMs)
    validateTimeout('DSH startup timeout', this.#startupTimeoutMs)
  }

  get pid(): number | undefined {
    return this.#ready?.pid
  }

  get state(): DshRuntimeState {
    return this.#state
  }

  get url(): string | undefined {
    return this.#ready?.url
  }

  start(): Promise<DshRuntimeReady> {
    if (this.#ready && this.#state === 'running') return Promise.resolve(this.#ready)
    if (this.#startPromise) return this.#startPromise
    if (this.#stopPromise) return this.#stopPromise.then(() => this.start())
    if (this.#state === 'failed') {
      return Promise.reject(new DshRuntimeError('startup', 'DSH runtime requires cleanup before restart'))
    }

    const operation = this.#startProcess()
    this.#startPromise = operation
    void operation.then(
      () => {
        if (this.#startPromise === operation) this.#startPromise = undefined
      },
      () => {
        if (this.#startPromise === operation) this.#startPromise = undefined
      },
    )
    return operation
  }

  stop(): Promise<void> {
    if (this.#stopPromise) return this.#stopPromise

    const child = this.#child
    if (!child) {
      this.#ready = undefined
      this.#state = 'idle'
      return Promise.resolve()
    }

    const closePromise = this.#closePromise
    if (!closePromise) {
      this.#state = 'failed'
      return Promise.reject(new DshRuntimeError('shutdown', 'DSH close tracking is unavailable'))
    }

    const canRequestGracefulShutdown = this.#gracefulChild === child
    this.#state = 'stopping'
    const operation = this.#stopProcess(child, closePromise, canRequestGracefulShutdown)
    this.#stopPromise = operation
    void operation.then(
      () => {
        if (this.#stopPromise === operation) this.#stopPromise = undefined
      },
      () => {
        if (this.#stopPromise === operation) this.#stopPromise = undefined
      },
    )
    return operation
  }

  async #startProcess(): Promise<DshRuntimeReady> {
    this.#state = 'starting'
    this.#ready = undefined
    const output = new OutputTail()
    let child: ChildProcess
    try {
      child = spawn(
        this.#execPath,
        buildDshProcessArgs(this.#dshBin, this.#patchFiles, this.#port),
        {
          cwd: this.#cwd,
          env: {
            ...this.#env,
            ELECTRON_RUN_AS_NODE: '1',
          },
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
          windowsHide: process.platform === 'win32',
        },
      )
    } catch (error) {
      this.#state = 'idle'
      throw new DshRuntimeError('spawn', 'Unable to spawn DSH', { cause: error })
    }
    this.#child = child

    const sanitizers = {
      stderr: new DshOutputSanitizer(),
      stdout: new DshOutputSanitizer(),
    }
    let outputFinished = false
    const relayOutput = (stream: 'stderr' | 'stdout', text: string): void => {
      if (text.length === 0) return
      output.append(stream, text)
      this.#emitOutput(Object.freeze({ stream, text }))
      try {
        if (stream === 'stdout') process.stdout.write(text)
        else process.stderr.write(text)
      } catch (error) {
        this.#reportHandlerFailure('DSH console output failed:', error)
      }
    }
    const finishOutput = (): void => {
      if (outputFinished) return
      outputFinished = true
      for (const stream of ['stdout', 'stderr'] as const) {
        for (const text of sanitizers[stream].finish()) relayOutput(stream, text)
      }
    }

    let resolveClose: (() => void) | undefined
    const closePromise = new Promise<void>((resolve) => {
      resolveClose = resolve
    })
    this.#closePromise = closePromise

    let readySettled = false
    let spawnError: Error | undefined
    const readyMessage = new Promise<DesktopReadyMessage>((resolve, reject) => {
      child.once('error', (error) => {
        spawnError = error
        reject(error)
      })
      child.on('message', (message) => {
        const ready = parseDesktopReadyMessage(message)
        if (!ready || readySettled) return
        readySettled = true
        if (this.#child === child) this.#gracefulChild = child
        resolve(ready)
      })
      child.once('close', (code, signal) => {
        try {
          finishOutput()
        } catch (error) {
          this.#reportHandlerFailure('DSH output finalization failed:', error)
        }
        const ownsChild = this.#child === child
        const expected = ownsChild && this.#state === 'stopping'
        const wasRunning = ownsChild && this.#state === 'running'
        if (ownsChild) {
          this.#child = undefined
          this.#closePromise = undefined
          if (this.#gracefulChild === child) this.#gracefulChild = undefined
          this.#ready = undefined
          this.#state = 'idle'
        }

        if (!readySettled) {
          reject(new Error(`DSH exited before startup (code ${code ?? signal ?? 'unknown'})`))
        }
        if (wasRunning || expected) {
          this.#emitExit({
            code,
            expected,
            output: output.toString(),
            signal,
          })
        }
        resolveClose?.()
      })
    })

    child.stdout?.on('data', (chunk: Buffer) => {
      for (const text of sanitizers.stdout.push(chunk)) relayOutput('stdout', text)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      for (const text of sanitizers.stderr.push(chunk)) relayOutput('stderr', text)
    })

    const deadline = Date.now() + this.#startupTimeoutMs
    try {
      const message = await withTimeout(
        readyMessage,
        this.#startupTimeoutMs,
        'Timed out waiting for the desktop ready message',
      )
      await this.#waitUntilReady(child, message.url, deadline)

      if (this.#child !== child || this.#state !== 'starting' || child.pid === undefined) {
        throw new Error('DSH stopped while startup was completing')
      }

      const ready = Object.freeze({
        pid: child.pid,
        ...(message.profileEvidence === undefined ? {} : { profileEvidence: message.profileEvidence }),
        url: message.url,
      })
      this.#ready = ready
      this.#state = 'running'
      return ready
    } catch (error) {
      let terminated = true
      if (this.#child === child) {
        terminated = await this.#terminateFailedStart(child, closePromise, readySettled)
      }
      if (!terminated) {
        throw new DshRuntimeError(
          'shutdown',
          'DSH did not exit after startup failed',
          { cause: error, output: output.toString() },
        )
      }

      const stage = spawnError === error
        ? 'spawn'
        : error instanceof DshRuntimeError
          ? error.stage
          : 'startup'
      throw new DshRuntimeError(
        stage,
        stage === 'spawn'
          ? 'Unable to spawn DSH'
          : stage === 'readiness'
            ? 'DSH failed readiness verification'
            : 'DSH failed to become ready',
        { cause: error, output: output.toString() },
      )
    }
  }

  async #waitUntilReady(child: ChildProcess, url: string, deadline: number): Promise<void> {
    let lastError: unknown
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null || this.#child !== child) {
        throw new Error(`DSH exited before readiness (code ${child.exitCode ?? child.signalCode ?? 'unknown'})`)
      }

      try {
        const remaining = Math.max(1, deadline - Date.now())
        await this.#readinessProbe(url, AbortSignal.timeout(Math.min(1_000, remaining)))
        return
      } catch (error) {
        lastError = error
      }

      await new Promise((resolve) => setTimeout(resolve, 100))
    }

    throw new DshRuntimeError('readiness', `Timed out verifying ${url}`, { cause: lastError })
  }

  async #terminateFailedStart(
    child: ChildProcess,
    closePromise: Promise<void>,
    requestGracefulShutdown: boolean,
  ): Promise<boolean> {
    const gracefulTargets = requestGracefulShutdown && child.pid
      ? snapshotProcessTargets(child.pid, this.#readProcessTable)
      : undefined
    if (child.exitCode === null && child.signalCode === null) {
      if (requestGracefulShutdown && child.connected) this.#sendShutdownMessage(child)
      else await signalProcessTree(child, 'SIGTERM', this.#readProcessTable)
    }
    if (await waitForClose(closePromise, this.#shutdownTimeoutMs)) {
      return gracefulTargets ? terminateSnapshotTargets(gracefulTargets) : true
    }

    await signalProcessTree(child, 'SIGKILL', this.#readProcessTable)
    if (await waitForClose(closePromise, FORCE_KILL_TIMEOUT_MS)) {
      return gracefulTargets ? terminateSnapshotTargets(gracefulTargets) : true
    }

    this.#state = 'failed'
    return false
  }

  async #stopProcess(
    child: ChildProcess,
    closePromise: Promise<void>,
    requestGracefulShutdown: boolean,
  ): Promise<void> {
    const gracefulTargets = requestGracefulShutdown && child.pid
      ? snapshotProcessTargets(child.pid, this.#readProcessTable)
      : undefined
    if (child.exitCode === null && child.signalCode === null && requestGracefulShutdown && child.connected) {
      this.#sendShutdownMessage(child)
    } else if (child.exitCode === null && child.signalCode === null) {
      await signalProcessTree(child, 'SIGTERM', this.#readProcessTable)
    }

    if (await waitForClose(closePromise, this.#shutdownTimeoutMs)) {
      if (gracefulTargets && !(await terminateSnapshotTargets(gracefulTargets))) {
        this.#state = 'failed'
        throw new DshRuntimeError('shutdown', 'DSH descendants survived graceful root shutdown')
      }
      return
    }

    await signalProcessTree(child, 'SIGKILL', this.#readProcessTable)
    if (await waitForClose(closePromise, FORCE_KILL_TIMEOUT_MS)) {
      if (gracefulTargets && !(await terminateSnapshotTargets(gracefulTargets))) {
        this.#state = 'failed'
        throw new DshRuntimeError('shutdown', 'DSH descendants survived forced root shutdown')
      }
      return
    }

    this.#state = 'failed'
    throw new DshRuntimeError('shutdown', 'DSH did not exit after forced termination')
  }

  #sendShutdownMessage(child: ChildProcess): void {
    try {
      child.send({
        protocolVersion: DESKTOP_PROTOCOL_VERSION,
        type: SHUTDOWN_MESSAGE_TYPE,
      }, (error) => {
        if (!error || child.exitCode !== null || child.signalCode !== null) return
        void signalProcessTree(child, 'SIGTERM', this.#readProcessTable).catch(() => {
          try {
            child.kill('SIGTERM')
          } catch {}
        })
      })
    } catch {
      void signalProcessTree(child, 'SIGTERM', this.#readProcessTable).catch(() => {
        try {
          child.kill('SIGTERM')
        } catch {}
      })
    }
  }

  #emitExit(event: DshRuntimeExit): void {
    if (!this.#onExit) return
    try {
      this.#onExit(event)
    } catch (error) {
      this.#reportHandlerFailure('DSH exit handler failed:', error)
    }
  }

  #emitOutput(event: DshRuntimeOutput): void {
    if (!this.#onOutput) return
    try {
      this.#onOutput(event)
    } catch (error) {
      this.#reportHandlerFailure('DSH output handler failed:', error)
    }
  }

  #reportHandlerFailure(message: string, error: unknown): void {
    try {
      console.error(message, error)
    } catch {
      // Diagnostics must never prevent child-process ownership cleanup.
    }
  }
}
