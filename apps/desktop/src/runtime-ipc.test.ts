import { beforeEach, describe, expect, it, vi } from 'vitest'

const electronIpc = vi.hoisted(() => {
  const handlers = new Map<
    string,
    (event: unknown, value: unknown) => unknown
  >()
  return {
    handle: vi.fn((channel: string, handler: (event: unknown, value: unknown) => unknown) => {
      handlers.set(channel, handler)
    }),
    handlers,
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel)
    }),
  }
})

vi.mock('electron', () => ({
  ipcMain: {
    handle: electronIpc.handle,
    removeHandler: electronIpc.removeHandler,
  },
}))

vi.mock('./runtime-ipc.cjs', () => ({
  default: {
    default: {
      readTail: 'dsh-workbench:runtime-diagnostics:read-tail',
      repair: 'dsh-workbench:runtime-diagnostics:repair',
      snapshot: 'dsh-workbench:runtime-diagnostics:snapshot',
    },
  },
}))

import type { ProfileRuntimeSession } from './profile-runtime.js'
import { ProfileTransitionCoordinator } from './profiles-ipc.js'
import { RuntimeDiagnosticLog } from './runtime-diagnostics.js'
import {
  installRuntimeDiagnosticsIpc,
  parseRuntimeDiagnosticsRequest,
  type RuntimeRepairAction,
} from './runtime-ipc.js'

const context = { generation: 4, profileId: 'profile-current' }
const requestId = '10000000-0000-4000-8000-000000000006'
const repairChannel = 'dsh-workbench:runtime-diagnostics:repair'
const timestamp = '2026-08-23T00:00:00.000Z'

function deferred<T>(): {
  readonly promise: Promise<T>
  readonly reject: (reason?: unknown) => void
  readonly resolve: (value: T) => void
} {
  let reject!: (reason?: unknown) => void
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    reject = rejectPromise
    resolve = resolvePromise
  })
  return { promise, reject, resolve }
}

function runtimeSession(profileId: string, generation: number): ProfileRuntimeSession {
  return {
    generation,
    paths: {
      dshHome: `/profiles/${profileId}/dsh`,
      root: `/profiles/${profileId}`,
      workspace: `/profiles/${profileId}/workspace`,
    },
    profile: {
      createdAt: timestamp,
      id: profileId,
      name: profileId,
      updatedAt: timestamp,
    },
    ready: { pid: generation, url: 'http://127.0.0.1:4555' },
  }
}

function repairRequest(
  action: RuntimeRepairAction,
  id = requestId,
  requestContext = context,
): Record<string, unknown> {
  return { action, context: requestContext, requestId: id }
}

function createHandlerHarness(options: {
  readonly confirmRepair?: (
    action: Exclude<RuntimeRepairAction, 'clear-runtime-logs'>,
    session: ProfileRuntimeSession,
  ) => Promise<boolean>
  readonly repairFirstPartyOverlay?: (session: ProfileRuntimeSession) => Promise<void>
} = {}) {
  const initial = runtimeSession(context.profileId, context.generation)
  let current: ProfileRuntimeSession | undefined = initial
  let generation = initial.generation
  let window = createWindow(initial)
  const order: string[] = []
  const restartActive = vi.fn(async () => {
    order.push('restart')
    if (!current) throw new Error('No active profile')
    current = runtimeSession(current.profile.id, ++generation)
    return current
  })
  const switchTo = vi.fn(async (profileId: string) => {
    order.push(`switch:${profileId}`)
    current = runtimeSession(profileId, ++generation)
    return current
  })
  const stop = vi.fn(async () => {
    order.push('stop')
    current = undefined
  })
  const startActive = vi.fn(async () => {
    if (!current) current = runtimeSession(context.profileId, ++generation)
    return current
  })
  const controller = {
    get current() { return current },
    get state() { return current ? 'running' as const : 'idle' as const },
    restartActive,
    startActive,
    stop,
    switchTo,
  }
  const activate = vi.fn(async (session: ProfileRuntimeSession) => {
    order.push(`activate:${session.profile.id}:${String(session.generation)}`)
    window = createWindow(session)
  })
  const transitions = new ProfileTransitionCoordinator(controller, activate)
  const confirmRepair = vi.fn(options.confirmRepair ?? (async () => true))
  const repairFirstPartyOverlay = vi.fn(
    options.repairFirstPartyOverlay ?? (async () => {}),
  )
  const log = new RuntimeDiagnosticLog({ clock: () => new Date(timestamp) })
  const append = vi.spyOn(log, 'append')
  const clear = vi.spyOn(log, 'clear')
  const uninstall = installRuntimeDiagnosticsIpc({
    appVersion: '0.1.0',
    confirmRepair,
    controller: controller as never,
    dshVersion: '0.1.1-rc.2',
    getWindow: () => window as never,
    log,
    repairFirstPartyOverlay,
    transitions,
  })
  const handler = electronIpc.handlers.get(repairChannel)
  if (!handler) throw new Error('Runtime repair IPC handler was not installed')

  return {
    activate,
    append,
    clear,
    confirmRepair,
    controller,
    current: () => current,
    event: () => createEvent(window),
    initial,
    invoke: (
      request: Record<string, unknown>,
      event = createEvent(window),
    ): Promise<{ accepted: boolean }> => Promise.resolve(
      handler(event, request) as Promise<{ accepted: boolean }>,
    ),
    order,
    repairFirstPartyOverlay,
    restartActive,
    startActive,
    stop,
    switchTo,
    transitions,
    uninstall,
  }
}

function createWindow(session: ProfileRuntimeSession) {
  const mainFrame = { url: session.ready.url }
  const webContents = { mainFrame }
  return {
    isDestroyed: () => false,
    webContents,
  }
}

function createEvent(window: ReturnType<typeof createWindow>) {
  return {
    sender: window.webContents,
    senderFrame: window.webContents.mainFrame,
  }
}

beforeEach(() => {
  electronIpc.handlers.clear()
  electronIpc.handle.mockClear()
  electronIpc.removeHandler.mockClear()
})

describe('runtime diagnostics IPC validation', () => {
  it('accepts only closed read schemas and bounded pagination', () => {
    expect(parseRuntimeDiagnosticsRequest({ context }, 'snapshot')).toEqual({ context, operation: 'snapshot' })
    expect(parseRuntimeDiagnosticsRequest({ afterCursor: 12, context, limit: 100 }, 'readTail')).toEqual({
      afterCursor: 12,
      context,
      limit: 100,
      operation: 'readTail',
    })
    expect(() => parseRuntimeDiagnosticsRequest({ context, path: '/tmp' }, 'snapshot')).toThrow(/fields/u)
    expect(() => parseRuntimeDiagnosticsRequest({ afterCursor: 0, context, limit: 201 }, 'readTail')).toThrow(/pagination/u)
  })

  it('accepts only fixed repair actions and rejects ambient authority fields', () => {
    expect(parseRuntimeDiagnosticsRequest({
      action: 'restart-active-runtime',
      context,
      requestId,
    }, 'repair')).toEqual({
      action: 'restart-active-runtime',
      context,
      operation: 'repair',
      requestId,
    })
    for (const action of ['repair-first-party-overlay', 'clear-runtime-logs']) {
      expect(() => parseRuntimeDiagnosticsRequest({ action, context, requestId }, 'repair')).not.toThrow()
    }
    for (const extra of [
      { command: 'rm -rf /' },
      { moduleName: '@attacker/plugin' },
      { path: '/tmp/escape' },
      { pluginId: 'arbitrary' },
    ]) {
      expect(() => parseRuntimeDiagnosticsRequest({
        action: 'restart-active-runtime',
        context,
        requestId,
        ...extra,
      }, 'repair')).toThrow(/fields/u)
    }
    expect(() => parseRuntimeDiagnosticsRequest({ action: 'run-command', context, requestId }, 'repair')).toThrow(/action/u)
    expect(() => parseRuntimeDiagnosticsRequest({
      action: 'restart-active-runtime',
      context,
      requestId: '../stale',
    }, 'repair')).toThrow(/request id/u)
  })
})

describe('runtime diagnostics repair handler', () => {
  it('has zero repair side effects when native confirmation is cancelled', async () => {
    const harness = createHandlerHarness({ confirmRepair: async () => false })

    await expect(harness.invoke(repairRequest('repair-first-party-overlay'))).resolves.toEqual({
      accepted: false,
    })

    expect(harness.confirmRepair).toHaveBeenCalledOnce()
    expect(harness.repairFirstPartyOverlay).not.toHaveBeenCalled()
    expect(harness.restartActive).not.toHaveBeenCalled()
    expect(harness.startActive).not.toHaveBeenCalled()
    expect(harness.stop).not.toHaveBeenCalled()
    expect(harness.append).not.toHaveBeenCalled()
    expect(harness.clear).not.toHaveBeenCalled()
  })

  it('rejects an old window after its profile changes while confirmation is pending', async () => {
    const confirmation = deferred<boolean>()
    const harness = createHandlerHarness({
      confirmRepair: async () => confirmation.promise,
    })
    const repairing = harness.invoke(repairRequest('repair-first-party-overlay'))
    await vi.waitFor(() => expect(harness.confirmRepair).toHaveBeenCalledOnce())

    await harness.transitions.select('profile-next')
    confirmation.resolve(true)

    await expect(repairing).rejects.toThrow(/active main frame|stale runtime generation/u)
    expect(harness.repairFirstPartyOverlay).not.toHaveBeenCalled()
    expect(harness.restartActive).not.toHaveBeenCalled()
    expect(harness.startActive).not.toHaveBeenCalled()
    expect(harness.stop).not.toHaveBeenCalled()
    expect(harness.append).not.toHaveBeenCalled()
  })

  it('coalesces concurrent repeats of one request id into one confirmation and restart', async () => {
    const confirmation = deferred<boolean>()
    const harness = createHandlerHarness({
      confirmRepair: async () => confirmation.promise,
    })
    const request = repairRequest('repair-first-party-overlay')
    const event = harness.event()
    const first = harness.invoke(request, event)
    const second = harness.invoke(request, event)

    await vi.waitFor(() => expect(harness.confirmRepair).toHaveBeenCalledOnce())
    confirmation.resolve(true)

    await expect(Promise.all([first, second])).resolves.toEqual([
      { accepted: true },
      { accepted: true },
    ])
    expect(harness.confirmRepair).toHaveBeenCalledOnce()
    expect(harness.repairFirstPartyOverlay).toHaveBeenCalledOnce()
    expect(harness.restartActive).not.toHaveBeenCalled()
    expect(harness.startActive).toHaveBeenCalledOnce()
    expect(harness.stop).toHaveBeenCalledOnce()
    expect(harness.append).toHaveBeenCalledOnce()
  })

  it('rejects reuse of one request id with a different action or active context', async () => {
    const cancelled = createHandlerHarness({ confirmRepair: async () => false })
    await cancelled.invoke(repairRequest('repair-first-party-overlay'))

    await expect(cancelled.invoke(repairRequest('restart-active-runtime'))).rejects.toThrow(
      /reused with a different action or context/u,
    )
    expect(cancelled.confirmRepair).toHaveBeenCalledOnce()
    expect(cancelled.restartActive).not.toHaveBeenCalled()
    expect(cancelled.startActive).not.toHaveBeenCalled()
    expect(cancelled.stop).not.toHaveBeenCalled()

    cancelled.uninstall()
    const restarted = createHandlerHarness()
    await restarted.invoke(repairRequest('restart-active-runtime'))
    const active = restarted.current()
    expect(active).toBeDefined()

    await expect(restarted.invoke(repairRequest(
      'restart-active-runtime',
      requestId,
      { generation: active?.generation ?? 0, profileId: active?.profile.id ?? '' },
    ))).rejects.toThrow(/reused with a different action or context/u)
    expect(restarted.confirmRepair).toHaveBeenCalledOnce()
    expect(restarted.restartActive).not.toHaveBeenCalled()
    expect(restarted.startActive).toHaveBeenCalledOnce()
    expect(restarted.stop).toHaveBeenCalledOnce()
  })

  it('never evicts an in-flight idempotency record while completed records are trimmed', async () => {
    const confirmation = deferred<boolean>()
    const harness = createHandlerHarness({
      confirmRepair: async () => confirmation.promise,
    })
    const request = repairRequest('repair-first-party-overlay')
    const pending = harness.invoke(request)
    await vi.waitFor(() => expect(harness.confirmRepair).toHaveBeenCalledOnce())

    for (let index = 0; index < 129; index += 1) {
      const id = `20000000-0000-4000-8000-${String(index).padStart(12, '0')}`
      await harness.invoke(repairRequest('clear-runtime-logs', id))
    }
    const duplicate = harness.invoke(request)
    expect(harness.confirmRepair).toHaveBeenCalledOnce()
    confirmation.resolve(false)

    await expect(Promise.all([pending, duplicate])).resolves.toEqual([
      { accepted: false },
      { accepted: false },
    ])
    expect(harness.confirmRepair).toHaveBeenCalledOnce()
  })

  it('serializes overlay repair ahead of a concurrent profile selection', async () => {
    const overlay = deferred<void>()
    const harness = createHandlerHarness({
      repairFirstPartyOverlay: async () => overlay.promise,
    })
    const repairing = harness.invoke(repairRequest('repair-first-party-overlay'))
    await vi.waitFor(() => expect(harness.repairFirstPartyOverlay).toHaveBeenCalledOnce())

    const selecting = harness.transitions.select('profile-next')
    await Promise.resolve()
    expect(harness.switchTo).not.toHaveBeenCalled()
    overlay.resolve()

    await expect(repairing).resolves.toEqual({ accepted: true })
    await expect(selecting).resolves.toMatchObject({ profile: { id: 'profile-next' } })
    expect(harness.restartActive).not.toHaveBeenCalled()
    expect(harness.startActive).toHaveBeenCalledOnce()
    expect(harness.stop).toHaveBeenCalledOnce()
    expect(harness.switchTo).toHaveBeenCalledOnce()
    expect(harness.current()?.profile.id).toBe('profile-next')
  })

  it('lets concurrent exit recovery adopt the generation created by repair', async () => {
    const overlay = deferred<void>()
    const harness = createHandlerHarness({
      repairFirstPartyOverlay: async () => overlay.promise,
    })
    const repairing = harness.invoke(repairRequest('repair-first-party-overlay'))
    await vi.waitFor(() => expect(harness.repairFirstPartyOverlay).toHaveBeenCalledOnce())
    const shouldRetry = vi.fn(async () => true)
    const recovering = harness.transitions.recover(harness.initial, shouldRetry)
    overlay.resolve()

    await expect(repairing).resolves.toEqual({ accepted: true })
    await expect(recovering).resolves.toBe(harness.current())
    expect(harness.restartActive).not.toHaveBeenCalled()
    expect(harness.startActive).toHaveBeenCalledOnce()
    expect(harness.stop).toHaveBeenCalledOnce()
    expect(shouldRetry).not.toHaveBeenCalled()
  })

  it('cleans up a repair restart when shutdown wins during overlay repair', async () => {
    const overlay = deferred<void>()
    const harness = createHandlerHarness({
      repairFirstPartyOverlay: async () => overlay.promise,
    })
    const repairing = harness.invoke(repairRequest('repair-first-party-overlay'))
    const rejectedRepair = expect(repairing).rejects.toThrow(/shutting down/u)
    await vi.waitFor(() => expect(harness.repairFirstPartyOverlay).toHaveBeenCalledOnce())

    const shuttingDown = harness.transitions.shutdown()
    overlay.resolve()

    await rejectedRepair
    await shuttingDown
    expect(harness.restartActive).not.toHaveBeenCalled()
    expect(harness.startActive).not.toHaveBeenCalled()
    expect(harness.stop).toHaveBeenCalledTimes(2)
    expect(harness.current()).toBeUndefined()
    expect(harness.append).not.toHaveBeenCalled()
  })
})
