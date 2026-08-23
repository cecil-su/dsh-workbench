import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { ipcMain } from 'electron'

import profileIpcModule from './profile-ipc.cjs'
import type { ProfileRuntimeController, ProfileRuntimeSession } from './profile-runtime.js'
import type { ProfileRegistrySnapshot, ProfileStore, WorkbenchProfile } from './profile-store.js'

const profileIpc = profileIpcModule.default

export interface PublicProfile {
  readonly archived: boolean
  readonly createdAt: string
  readonly id: string
  readonly lastUsedAt?: string
  readonly name: string
  readonly updatedAt: string
}

export interface PublicProfileSnapshot {
  readonly activeProfileId: string
  readonly profiles: readonly PublicProfile[]
  readonly schemaVersion: 1
}

export interface ProfileRequestContext {
  readonly generation: number
  readonly profileId: string
}

interface InstallProfileIpcOptions {
  confirmArchive: (profile: WorkbenchProfile) => Promise<boolean>
  controller: ProfileRuntimeController
  getWindow: () => BrowserWindow | undefined
  selectProfile: (profileId: string) => Promise<ProfileRuntimeSession>
  store: ProfileStore
}

interface ProfileSessionSwitcher {
  readonly current: ProfileRuntimeSession | undefined
  switchTo(profileId: string): Promise<ProfileRuntimeSession>
}

interface ProfileLifecycleController extends ProfileSessionSwitcher {
  restartActive(): Promise<ProfileRuntimeSession>
  startActive(): Promise<ProfileRuntimeSession>
  stop(): Promise<void>
}

export interface AuthorizedRequest {
  readonly context: ProfileRequestContext
  readonly name?: string
  readonly profileId?: string
}

const PROFILE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(record).sort()
  return keys.length === expected.length
    && [...expected].sort().every((key, index) => keys[index] === key)
}

function parseContext(value: unknown): ProfileRequestContext {
  if (!isRecord(value) || !hasExactKeys(value, ['generation', 'profileId'])) {
    throw new TypeError('Profile request context is invalid')
  }
  if (
    !Number.isSafeInteger(value.generation)
    || (value.generation as number) < 1
    || typeof value.profileId !== 'string'
    || !PROFILE_ID_PATTERN.test(value.profileId)
  ) {
    throw new TypeError('Profile request context is invalid')
  }
  return { generation: value.generation as number, profileId: value.profileId }
}

export function parseProfileRequest(
  value: unknown,
  operation: 'archive' | 'create' | 'list' | 'rename' | 'restore' | 'select',
): AuthorizedRequest {
  if (!isRecord(value)) throw new TypeError('Profile request must be an object')
  const expectedKeys = operation === 'list'
    ? ['context']
    : operation === 'create'
      ? ['context', 'name']
      : operation === 'rename'
        ? ['context', 'name', 'profileId']
        : ['context', 'profileId']
  if (!hasExactKeys(value, expectedKeys)) throw new TypeError('Profile request fields are invalid')

  const context = parseContext(value.context)
  if (expectedKeys.includes('profileId') && (
    typeof value.profileId !== 'string' || !PROFILE_ID_PATTERN.test(value.profileId)
  )) {
    throw new TypeError('Profile id is invalid')
  }
  if (expectedKeys.includes('name') && typeof value.name !== 'string') {
    throw new TypeError('Profile name is invalid')
  }
  return {
    context,
    ...(value.name === undefined ? {} : { name: value.name as string }),
    ...(value.profileId === undefined ? {} : { profileId: value.profileId as string }),
  }
}

export function publicProfileSnapshot(snapshot: ProfileRegistrySnapshot): PublicProfileSnapshot {
  return {
    activeProfileId: snapshot.activeProfileId,
    profiles: snapshot.profiles.map((profile) => ({
      archived: profile.archivedAt !== undefined,
      createdAt: profile.createdAt,
      id: profile.id,
      ...(profile.lastUsedAt === undefined ? {} : { lastUsedAt: profile.lastUsedAt }),
      name: profile.name,
      updatedAt: profile.updatedAt,
    })),
    schemaVersion: 1,
  }
}

export function sendProfileContext(
  window: BrowserWindow,
  session: ProfileRuntimeSession,
): void {
  window.webContents.send(profileIpc.context, Object.freeze({
    generation: session.generation,
    profileId: session.profile.id,
  }))
}

export async function switchProfileAndActivate(
  controller: ProfileSessionSwitcher,
  activateSession: (session: ProfileRuntimeSession) => Promise<void>,
  profileId: string,
  transitionCancelled: () => boolean = () => false,
): Promise<ProfileRuntimeSession> {
  const previousSession = controller.current
  let session: ProfileRuntimeSession
  try {
    session = await controller.switchTo(profileId)
  } catch (error) {
    const recovered = controller.current
    if (
      !transitionCancelled()
      && recovered
      && recovered.generation !== previousSession?.generation
    ) {
      try {
        await activateSession(recovered)
      } catch (activationError) {
        throw new AggregateError(
          [error, activationError],
          `Profile switch failed and recovered profile ${recovered.profile.name} could not be displayed`,
        )
      }
    }
    throw error
  }

  try {
    await activateSession(session)
  } catch (error) {
    if (
      !transitionCancelled()
      && previousSession
      && previousSession.profile.id !== session.profile.id
    ) {
      let recovered: ProfileRuntimeSession
      try {
        recovered = await controller.switchTo(previousSession.profile.id)
      } catch (rollbackError) {
        const owned = controller.current
        if (owned && owned.generation !== session.generation) {
          try {
            await activateSession(owned)
          } catch (recoveredActivationError) {
            throw new AggregateError(
              [error, rollbackError, recoveredActivationError],
              'The target window failed and the recovered runtime could not be displayed',
            )
          }
        }
        throw new AggregateError(
          [error, rollbackError],
          'The target window failed and the previous profile could not be restored',
        )
      }
      try {
        await activateSession(recovered)
      } catch (rollbackActivationError) {
        throw new AggregateError(
          [error, rollbackActivationError],
          'The target window failed and the restored profile could not be displayed',
        )
      }
    }
    throw error
  }
  return session
}

export function createSerializedProfileSelector(
  controller: ProfileSessionSwitcher,
  activateSession: (session: ProfileRuntimeSession) => Promise<void>,
): (profileId: string) => Promise<ProfileRuntimeSession> {
  let queue: Promise<void> = Promise.resolve()
  return (profileId) => {
    const operation = queue.then(() => switchProfileAndActivate(
      controller,
      activateSession,
      profileId,
    ))
    queue = operation.then(() => undefined, () => undefined)
    return operation
  }
}

/**
 * Owns the single main-process serialization domain for runtime and window
 * transitions. Renderer selection, unexpected-exit recovery, and shutdown
 * must all pass through this coordinator so none can activate or restart a
 * profile behind another transition.
 */
export class ProfileTransitionCoordinator {
  readonly #activateSession: (session: ProfileRuntimeSession) => Promise<void>
  readonly #controller: ProfileLifecycleController
  #queue: Promise<void> = Promise.resolve()
  #shutdownRequested = false

  constructor(
    controller: ProfileLifecycleController,
    activateSession: (session: ProfileRuntimeSession) => Promise<void>,
  ) {
    this.#controller = controller
    this.#activateSession = activateSession
  }

  startActive(): Promise<ProfileRuntimeSession> {
    return this.#enqueue(async () => {
      this.#assertAcceptingTransitions()
      const session = await this.#controller.startActive()
      await this.#activateSession(session)
      return session
    })
  }

  select(profileId: string): Promise<ProfileRuntimeSession> {
    return this.#enqueue(async () => {
      this.#assertAcceptingTransitions()
      const session = await switchProfileAndActivate(
        this.#controller,
        this.#activateSession,
        profileId,
        () => this.#shutdownRequested,
      )
      return session
    })
  }

  restartActive(
    expectedGeneration: number,
    afterStopBeforeStart: (session: ProfileRuntimeSession) => Promise<void> = async () => {},
  ): Promise<ProfileRuntimeSession> {
    return this.#enqueue(async () => {
      this.#assertAcceptingTransitions()
      const current = this.#controller.current
      if (!current || current.generation !== expectedGeneration) {
        throw new Error('Runtime restart belongs to a stale generation')
      }

      await this.#controller.stop()
      if (this.#controller.current) {
        throw new Error('Runtime remained active after it was stopped for repair')
      }
      this.#assertAcceptingTransitions()
      await afterStopBeforeStart(current)
      if (this.#controller.current) {
        try {
          await this.#controller.stop()
        } catch (stopError) {
          throw new AggregateError(
            [new Error('Runtime ownership changed while repair was in progress'), stopError],
            'Runtime ownership changed during repair and could not be stopped',
          )
        }
        throw new Error('Runtime ownership changed while repair was in progress')
      }
      this.#assertAcceptingTransitions()

      const session = await this.#controller.startActive()
      if (this.#shutdownRequested) {
        await this.#controller.stop()
        throw new Error('Workbench profile lifecycle is shutting down')
      }
      try {
        await this.#activateSession(session)
      } catch (error) {
        try {
          await this.#controller.stop()
        } catch (stopError) {
          throw new AggregateError(
            [error, stopError],
            'The restarted runtime could not be displayed or stopped',
          )
        }
        throw error
      }
      return session
    })
  }

  recover(
    exitedSession: ProfileRuntimeSession,
    shouldRetry: () => Promise<boolean>,
  ): Promise<ProfileRuntimeSession | undefined> {
    return this.#enqueue(async () => {
      if (this.#shutdownRequested) return undefined

      // A queued select may already have recovered or replaced the exited
      // generation while this recovery waited for the lifecycle queue.
      const current = this.#controller.current
      if (current && current.generation !== exitedSession.generation) return current
      if (!(await shouldRetry()) || this.#shutdownRequested) return undefined

      const recovered = await this.#controller.restartActive()
      if (this.#shutdownRequested) {
        await this.#controller.stop()
        return undefined
      }
      await this.#activateSession(recovered)
      return recovered
    })
  }

  stop(): Promise<void> {
    return this.#enqueue(() => this.#controller.stop())
  }

  shutdown(): Promise<void> {
    this.#shutdownRequested = true
    return this.#enqueue(() => this.#controller.stop())
  }

  waitForIdle(): Promise<void> {
    return this.#queue
  }

  #assertAcceptingTransitions(): void {
    if (this.#shutdownRequested) throw new Error('Workbench profile lifecycle is shutting down')
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation, operation)
    this.#queue = result.then(() => undefined, () => undefined)
    return result
  }
}

export function authorizeProfileRequest(
  event: IpcMainInvokeEvent,
  request: AuthorizedRequest,
  controller: ProfileRuntimeController,
  window: BrowserWindow | undefined,
): void {
  const session = controller.current
  if (!session || !window || window.isDestroyed()) throw new Error('No active profile window')
  if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
    throw new Error('Profile request did not come from the active main frame')
  }

  let senderOrigin: string
  try {
    senderOrigin = new URL(event.senderFrame.url).origin
  } catch {
    throw new Error('Profile request sender URL is invalid')
  }
  if (senderOrigin !== new URL(session.ready.url).origin) {
    throw new Error('Profile request sender origin is not active')
  }
  if (
    request.context.generation !== session.generation
    || request.context.profileId !== session.profile.id
  ) {
    throw new Error('Profile request belongs to a stale runtime generation')
  }
}

export function installProfileIpc(options: InstallProfileIpcOptions): () => void {
  const channels = [
    profileIpc.archive,
    profileIpc.create,
    profileIpc.list,
    profileIpc.rename,
    profileIpc.restore,
    profileIpc.select,
  ] as const
  const install = (
    channel: string,
    operation: Parameters<typeof parseProfileRequest>[1],
    handler: (request: AuthorizedRequest) => Promise<PublicProfileSnapshot>,
  ): void => {
    ipcMain.handle(channel, async (event, value: unknown) => {
      const request = parseProfileRequest(value, operation)
      authorizeProfileRequest(event, request, options.controller, options.getWindow())
      return handler(request)
    })
  }

  install(profileIpc.list, 'list', async () => publicProfileSnapshot(await options.store.list()))
  install(profileIpc.create, 'create', async (request) => {
    await options.store.create(request.name ?? '')
    return publicProfileSnapshot(await options.store.list())
  })
  install(profileIpc.rename, 'rename', async (request) => {
    await options.store.rename(request.profileId ?? '', request.name ?? '')
    return publicProfileSnapshot(await options.store.list())
  })
  install(profileIpc.archive, 'archive', async (request) => {
    const selected = await options.store.getProfile(request.profileId ?? '')
    if (!(await options.confirmArchive(selected.profile))) {
      return publicProfileSnapshot(await options.store.list())
    }
    await options.store.archive(selected.profile.id)
    return publicProfileSnapshot(await options.store.list())
  })
  install(profileIpc.restore, 'restore', async (request) => {
    await options.store.restore(request.profileId ?? '')
    return publicProfileSnapshot(await options.store.list())
  })
  install(profileIpc.select, 'select', async (request) => {
    await options.selectProfile(request.profileId ?? '')
    return publicProfileSnapshot(await options.store.list())
  })

  return () => {
    for (const channel of channels) ipcMain.removeHandler(channel)
  }
}
