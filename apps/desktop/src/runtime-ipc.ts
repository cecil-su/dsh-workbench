import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { ipcMain } from 'electron'

import runtimeDiagnosticsIpcModule from './runtime-ipc.cjs'
import type { ProfileRuntimeController, ProfileRuntimeSession } from './profile-runtime.js'
import {
  authorizeProfileRequest,
  type AuthorizedRequest,
  type ProfileRequestContext,
  type ProfileTransitionCoordinator,
} from './profiles-ipc.js'
import {
  type RuntimeDiagnosticLog,
  runtimeDiagnosticSnapshot,
} from './runtime-diagnostics.js'

const runtimeDiagnosticsIpc = runtimeDiagnosticsIpcModule.default
const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const PROFILE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u
const MAX_COMPLETED_REPAIRS = 128

export type RuntimeRepairAction =
  | 'clear-runtime-logs'
  | 'repair-first-party-overlay'
  | 'restart-active-runtime'

type RuntimeDiagnosticsRequest =
  | { readonly context: ProfileRequestContext; readonly operation: 'snapshot' }
  | {
      readonly afterCursor: number
      readonly context: ProfileRequestContext
      readonly limit: number
      readonly operation: 'readTail'
    }
  | {
      readonly action: RuntimeRepairAction
      readonly context: ProfileRequestContext
      readonly operation: 'repair'
      readonly requestId: string
    }

interface InstallRuntimeDiagnosticsIpcOptions {
  readonly appVersion: string
  readonly confirmRepair: (
    action: Exclude<RuntimeRepairAction, 'clear-runtime-logs'>,
    session: ProfileRuntimeSession,
  ) => Promise<boolean>
  readonly controller: ProfileRuntimeController
  readonly dshVersion: string
  readonly getWindow: () => BrowserWindow | undefined
  readonly log: RuntimeDiagnosticLog
  readonly repairFirstPartyOverlay: (session: ProfileRuntimeSession) => Promise<void>
  readonly transitions: ProfileTransitionCoordinator
}

interface RuntimeRepairRecord {
  completed: boolean
  readonly promise: Promise<{ accepted: boolean }>
  readonly request: Pick<
    Extract<RuntimeDiagnosticsRequest, { operation: 'repair' }>,
    'action' | 'context'
  >
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(record).sort()
  return keys.length === expected.length
    && [...expected].sort().every((key, index) => keys[index] === key)
}

function parseContext(value: unknown): ProfileRequestContext {
  if (!isRecord(value) || !exactKeys(value, ['generation', 'profileId'])) {
    throw new TypeError('Runtime diagnostic context is invalid')
  }
  if (
    !Number.isSafeInteger(value.generation)
    || (value.generation as number) < 1
    || typeof value.profileId !== 'string'
    || !PROFILE_ID_PATTERN.test(value.profileId)
  ) {
    throw new TypeError('Runtime diagnostic context is invalid')
  }
  return { generation: value.generation as number, profileId: value.profileId }
}

export function parseRuntimeDiagnosticsRequest(
  value: unknown,
  operation: 'snapshot',
): Extract<RuntimeDiagnosticsRequest, { operation: 'snapshot' }>
export function parseRuntimeDiagnosticsRequest(
  value: unknown,
  operation: 'readTail',
): Extract<RuntimeDiagnosticsRequest, { operation: 'readTail' }>
export function parseRuntimeDiagnosticsRequest(
  value: unknown,
  operation: 'repair',
): Extract<RuntimeDiagnosticsRequest, { operation: 'repair' }>
export function parseRuntimeDiagnosticsRequest(
  value: unknown,
  operation: RuntimeDiagnosticsRequest['operation'],
): RuntimeDiagnosticsRequest {
  if (!isRecord(value)) throw new TypeError('Runtime diagnostic request must be an object')
  if (operation === 'snapshot') {
    if (!exactKeys(value, ['context'])) throw new TypeError('Runtime diagnostic request fields are invalid')
    return { context: parseContext(value.context), operation }
  }
  if (operation === 'readTail') {
    if (!exactKeys(value, ['afterCursor', 'context', 'limit'])) {
      throw new TypeError('Runtime diagnostic request fields are invalid')
    }
    if (
      !Number.isSafeInteger(value.afterCursor)
      || (value.afterCursor as number) < 0
      || !Number.isSafeInteger(value.limit)
      || (value.limit as number) < 1
      || (value.limit as number) > 200
    ) {
      throw new TypeError('Runtime diagnostic pagination is invalid')
    }
    return {
      afterCursor: value.afterCursor as number,
      context: parseContext(value.context),
      limit: value.limit as number,
      operation,
    }
  }
  if (!exactKeys(value, ['action', 'context', 'requestId'])) {
    throw new TypeError('Runtime repair request fields are invalid')
  }
  if (
    value.action !== 'clear-runtime-logs'
    && value.action !== 'repair-first-party-overlay'
    && value.action !== 'restart-active-runtime'
  ) {
    throw new TypeError('Runtime repair action is invalid')
  }
  if (typeof value.requestId !== 'string' || !REQUEST_ID_PATTERN.test(value.requestId)) {
    throw new TypeError('Runtime repair request id is invalid')
  }
  return {
    action: value.action,
    context: parseContext(value.context),
    operation,
    requestId: value.requestId.toLowerCase(),
  }
}

function authorizedRequest(request: RuntimeDiagnosticsRequest): AuthorizedRequest {
  return { context: request.context }
}

function isSameRepairRequest(
  left: RuntimeRepairRecord['request'],
  right: Extract<RuntimeDiagnosticsRequest, { operation: 'repair' }>,
): boolean {
  return left.action === right.action
    && left.context.generation === right.context.generation
    && left.context.profileId === right.context.profileId
}

export function installRuntimeDiagnosticsIpc(options: InstallRuntimeDiagnosticsIpcOptions): () => void {
  const repairs = new Map<string, RuntimeRepairRecord>()
  const trimCompletedRepairs = (): void => {
    let completed = 0
    for (const repair of repairs.values()) {
      if (repair.completed) completed += 1
    }
    if (completed <= MAX_COMPLETED_REPAIRS) return
    for (const [requestId, repair] of repairs) {
      if (!repair.completed) continue
      repairs.delete(requestId)
      completed -= 1
      if (completed <= MAX_COMPLETED_REPAIRS) return
    }
  }
  const authorize = (event: IpcMainInvokeEvent, request: RuntimeDiagnosticsRequest): void => {
    authorizeProfileRequest(
      event,
      authorizedRequest(request),
      options.controller,
      options.getWindow(),
    )
  }

  ipcMain.handle(runtimeDiagnosticsIpc.snapshot, async (event, value: unknown) => {
    const request = parseRuntimeDiagnosticsRequest(value, 'snapshot')
    authorize(event, request)
    const session = options.controller.current
    if (!session) throw new Error('No active runtime diagnostics')
    return runtimeDiagnosticSnapshot({
      generation: session.generation,
      profileId: session.profile.id,
      profileName: session.profile.name,
    }, {
      app: options.appVersion,
      dsh: options.dshVersion,
    }, options.controller.state, options.log.latestCursor)
  })

  ipcMain.handle(runtimeDiagnosticsIpc.readTail, async (event, value: unknown) => {
    const request = parseRuntimeDiagnosticsRequest(value, 'readTail')
    authorize(event, request)
    return options.log.read(request.context, {
      afterCursor: request.afterCursor,
      limit: request.limit,
    })
  })

  ipcMain.handle(runtimeDiagnosticsIpc.repair, async (event, value: unknown) => {
    const request = parseRuntimeDiagnosticsRequest(value, 'repair')
    authorize(event, request)
    const existing = repairs.get(request.requestId)
    if (existing) {
      if (!isSameRepairRequest(existing.request, request)) {
        throw new Error('Runtime repair request id was reused with a different action or context')
      }
      return existing.promise
    }

    const operation = (async (): Promise<{ accepted: boolean }> => {
      if (request.action === 'clear-runtime-logs') {
        options.log.clear(request.context)
        return { accepted: true }
      }
      const session = options.controller.current
      if (!session) throw new Error('No active runtime to repair')
      if (!(await options.confirmRepair(request.action, session))) return { accepted: false }
      authorize(event, request)
      const restarted = await options.transitions.restartActive(
        request.context.generation,
        request.action === 'repair-first-party-overlay'
          ? options.repairFirstPartyOverlay
          : undefined,
      )
      options.log.append({
        generation: restarted.generation,
        profileId: restarted.profile.id,
      }, {
        code: request.action === 'repair-first-party-overlay'
          ? 'FIRST_PARTY_OVERLAY_REPAIRED'
          : 'RUNTIME_RESTARTED',
        level: 'info',
        text: request.action === 'repair-first-party-overlay'
          ? 'First-party Workbench plugin links were repaired and DSH restarted.'
          : 'DSH restarted from Workbench diagnostics.',
      })
      return { accepted: true }
    })()
    const record: RuntimeRepairRecord = {
      completed: false,
      promise: operation,
      request: {
        action: request.action,
        context: request.context,
      },
    }
    repairs.set(request.requestId, record)
    void operation.then(
      () => {
        record.completed = true
        trimCompletedRepairs()
      },
      () => {
        record.completed = true
        trimCompletedRepairs()
      },
    )
    return operation
  })

  return () => {
    ipcMain.removeHandler(runtimeDiagnosticsIpc.snapshot)
    ipcMain.removeHandler(runtimeDiagnosticsIpc.readTail)
    ipcMain.removeHandler(runtimeDiagnosticsIpc.repair)
    repairs.clear()
  }
}
