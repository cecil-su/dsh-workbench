import {
  DshRuntimeError,
  sanitizeDshOutput,
  type DshRuntimeOutput,
  type DshRuntimeState,
} from '@dsh-workbench/runtime'

const DEFAULT_MAX_BYTES = 64 * 1024
const DEFAULT_MAX_ENTRIES = 256
const MAX_ENTRY_CHARS = 4 * 1024
const MAX_READ_LIMIT = 200
const MAX_FAILURE_DIAGNOSTIC_CHARS = 64 * 1024

export type RuntimeDiagnosticLevel = 'error' | 'info' | 'warning'
export type RuntimeDiagnosticStream = 'stderr' | 'stdout' | 'system'

export interface RuntimeDiagnosticContext {
  readonly generation: number
  readonly profileId: string
}

export interface RuntimeDiagnosticEntry extends RuntimeDiagnosticContext {
  readonly code: string
  readonly cursor: number
  readonly level: RuntimeDiagnosticLevel
  readonly stream: RuntimeDiagnosticStream
  readonly text: string
  readonly timestamp: string
}

export interface RuntimeDiagnosticPage {
  readonly entries: readonly RuntimeDiagnosticEntry[]
  readonly latestCursor: number
  readonly nextCursor: number
}

export interface RuntimeDiagnosticSnapshot extends RuntimeDiagnosticContext {
  readonly appVersion: string
  readonly dshVersion: string
  readonly latestCursor: number
  readonly profileName: string
  readonly runtimeState: DshRuntimeState
  readonly schemaVersion: 1
}

interface RuntimeDiagnosticLogOptions {
  readonly clock?: () => Date
  readonly maxBytes?: number
  readonly maxEntries?: number
}

function assertContext(context: RuntimeDiagnosticContext): void {
  if (
    !Number.isSafeInteger(context.generation)
    || context.generation < 1
    || typeof context.profileId !== 'string'
    || !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(context.profileId)
  ) {
    throw new TypeError('Runtime diagnostic context is invalid')
  }
}

function boundedFragments(text: string): string[] {
  if (text.length === 0) return []
  const fragments: string[] = []
  for (let offset = 0; offset < text.length; offset += MAX_ENTRY_CHARS) {
    fragments.push(text.slice(offset, offset + MAX_ENTRY_CHARS))
  }
  return fragments
}

export class RuntimeDiagnosticLog {
  readonly #clock: () => Date
  readonly #entries: RuntimeDiagnosticEntry[] = []
  readonly #maxBytes: number
  readonly #maxEntries: number
  #bytes = 0
  #cursor = 0

  constructor(options: RuntimeDiagnosticLogOptions = {}) {
    this.#clock = options.clock ?? (() => new Date())
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
    this.#maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
    if (!Number.isSafeInteger(this.#maxBytes) || this.#maxBytes < 1024) {
      throw new RangeError('Runtime diagnostic byte capacity is invalid')
    }
    if (!Number.isSafeInteger(this.#maxEntries) || this.#maxEntries < 1) {
      throw new RangeError('Runtime diagnostic entry capacity is invalid')
    }
  }

  get latestCursor(): number {
    return this.#cursor
  }

  appendOutput(context: RuntimeDiagnosticContext, output: DshRuntimeOutput): void {
    this.append(context, {
      code: output.stream === 'stderr' ? 'DSH_STDERR' : 'DSH_STDOUT',
      level: output.stream === 'stderr' ? 'warning' : 'info',
      stream: output.stream,
      text: output.text,
    })
  }

  append(
    context: RuntimeDiagnosticContext,
    event: {
      readonly code: string
      readonly level: RuntimeDiagnosticLevel
      readonly stream?: RuntimeDiagnosticStream
      readonly text: string
    },
  ): void {
    assertContext(context)
    if (!/^[A-Z][A-Z0-9_]{0,63}$/u.test(event.code)) {
      throw new TypeError('Runtime diagnostic code is invalid')
    }
    const sanitized = sanitizeDshOutput(event.text)
    for (const text of boundedFragments(sanitized)) {
      const entry = Object.freeze({
        code: event.code,
        cursor: ++this.#cursor,
        generation: context.generation,
        level: event.level,
        profileId: context.profileId,
        stream: event.stream ?? 'system',
        text,
        timestamp: this.#clock().toISOString(),
      })
      this.#entries.push(entry)
      this.#bytes += Buffer.byteLength(text)
      this.#trim()
    }
  }

  clear(context: RuntimeDiagnosticContext): void {
    assertContext(context)
    for (let index = this.#entries.length - 1; index >= 0; index -= 1) {
      const entry = this.#entries[index]
      if (entry?.profileId !== context.profileId || entry.generation !== context.generation) continue
      this.#bytes -= Buffer.byteLength(entry.text)
      this.#entries.splice(index, 1)
    }
  }

  read(
    context: RuntimeDiagnosticContext,
    options: { readonly afterCursor?: number; readonly limit?: number } = {},
  ): RuntimeDiagnosticPage {
    assertContext(context)
    const afterCursor = options.afterCursor ?? 0
    const limit = options.limit ?? 100
    if (!Number.isSafeInteger(afterCursor) || afterCursor < 0) {
      throw new TypeError('Runtime diagnostic cursor is invalid')
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_READ_LIMIT) {
      throw new TypeError('Runtime diagnostic limit is invalid')
    }
    const entries = this.#entries
      .filter((entry) => (
        entry.profileId === context.profileId
        && entry.generation === context.generation
        && entry.cursor > afterCursor
      ))
      .slice(0, limit)
      .map((entry) => Object.freeze({ ...entry }))
    return Object.freeze({
      entries: Object.freeze(entries),
      latestCursor: this.#cursor,
      nextCursor: entries.at(-1)?.cursor ?? afterCursor,
    })
  }

  #trim(): void {
    while (this.#entries.length > this.#maxEntries || this.#bytes > this.#maxBytes) {
      const removed = this.#entries.shift()
      if (!removed) break
      this.#bytes -= Buffer.byteLength(removed.text)
    }
  }
}

export function runtimeDiagnosticSnapshot(
  context: RuntimeDiagnosticContext & { readonly profileName: string },
  versions: { readonly app: string; readonly dsh: string },
  state: DshRuntimeState,
  latestCursor: number,
): RuntimeDiagnosticSnapshot {
  assertContext(context)
  return Object.freeze({
    appVersion: versions.app,
    dshVersion: versions.dsh,
    generation: context.generation,
    latestCursor,
    profileId: context.profileId,
    profileName: context.profileName.slice(0, 80),
    runtimeState: state,
    schemaVersion: 1,
  })
}

export function runtimeFailureDiagnostic(error: unknown): string {
  const description = error instanceof DshRuntimeError
    ? `${error.message} (${error.stage})`
    : error instanceof Error
      ? error.message
      : String(error)
  const diagnosticOutput = typeof error === 'object'
    && error !== null
    && 'output' in error
    && typeof error.output === 'string'
    ? error.output
    : ''
  const output = diagnosticOutput
    ? `\n\nRecent DSH output:\n${diagnosticOutput}`
    : ''
  return sanitizeDshOutput(`${description}${output}`).slice(-MAX_FAILURE_DIAGNOSTIC_CHARS)
}
