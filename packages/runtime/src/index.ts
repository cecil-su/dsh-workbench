import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)

export interface DshRuntimeOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  patchFiles?: readonly string[]
  startupTimeoutMs?: number
  url?: string
}

export function buildDshWebArgs(patchFiles: readonly string[] = []): string[] {
  return [
    'web',
    ...patchFiles.flatMap((file) => ['--patch', file]),
    '--no-open',
  ]
}

export function resolveDshBin(): string {
  const packageJson = require.resolve('@deepseek-ai/dsh/package.json')
  return join(dirname(packageJson), 'lib', 'bin.js')
}

export class DshRuntime {
  readonly url: string

  readonly #cwd: string
  readonly #env: NodeJS.ProcessEnv
  readonly #patchFiles: readonly string[]
  readonly #startupTimeoutMs: number
  #child: ChildProcess | undefined
  #stopping = false

  constructor(options: DshRuntimeOptions = {}) {
    this.url = options.url ?? 'http://127.0.0.1:3080'
    this.#cwd = options.cwd ?? process.cwd()
    this.#env = options.env ?? process.env
    this.#patchFiles = [...options.patchFiles ?? []]
    this.#startupTimeoutMs = options.startupTimeoutMs ?? 30_000
  }

  async start(): Promise<void> {
    if (this.#child) return

    const stderr: string[] = []
    const child = spawn(process.execPath, [resolveDshBin(), ...buildDshWebArgs(this.#patchFiles)], {
      cwd: this.#cwd,
      env: {
        ...this.#env,
        ELECTRON_RUN_AS_NODE: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    this.#child = child
    child.stdout?.on('data', (chunk: Buffer) => process.stdout.write(chunk))
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      stderr.push(text)
      if (stderr.length > 20) stderr.shift()
      process.stderr.write(chunk)
    })

    try {
      await this.#waitUntilReady(child)
    } catch (error) {
      await this.stop()
      const details = stderr.join('').trim()
      throw new Error(
        details.length > 0
          ? `DSH failed to become ready: ${details}`
          : 'DSH failed to become ready',
        { cause: error },
      )
    }
  }

  async stop(): Promise<void> {
    const child = this.#child
    if (!child || this.#stopping) return

    this.#stopping = true
    this.#child = undefined

    try {
      if (child.exitCode !== null || child.signalCode !== null) return

      child.kill('SIGTERM')
      const exited = await Promise.race([
        new Promise<true>((resolve) => child.once('exit', () => resolve(true))),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 5_000)),
      ])

      if (!exited && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL')
      }
    } finally {
      this.#stopping = false
    }
  }

  async #waitUntilReady(child: ChildProcess): Promise<void> {
    const deadline = Date.now() + this.#startupTimeoutMs

    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`DSH exited before startup (code ${child.exitCode ?? child.signalCode})`)
      }

      try {
        const response = await fetch(this.url, { signal: AbortSignal.timeout(1_000) })
        if (response.ok) return
      } catch {
        // The host may not have bound its port yet.
      }

      await new Promise((resolve) => setTimeout(resolve, 250))
    }

    throw new Error(`Timed out waiting for ${this.url}`)
  }
}
