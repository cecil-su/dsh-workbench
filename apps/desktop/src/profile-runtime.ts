import type {
  DshRuntimeExit,
  DshRuntimeReady,
  DshRuntimeState,
} from '@dsh-workbench/runtime'

import type { ActiveProfile, ProfileStore } from './profile-store.js'

export interface ProfileRuntimeAdapter {
  readonly state: DshRuntimeState
  start(): Promise<DshRuntimeReady>
  stop(): Promise<void>
}

export interface ProfileRuntimeSession extends ActiveProfile {
  readonly generation: number
  readonly ready: DshRuntimeReady
}

export type ProfileRuntimeFactory = (
  active: ActiveProfile,
  onExit: (event: DshRuntimeExit) => void,
) => ProfileRuntimeAdapter

export interface UnexpectedProfileRuntimeExit {
  readonly event: DshRuntimeExit
  readonly session: ProfileRuntimeSession
}

export class ProfileSwitchError extends Error {
  readonly recoveredProfileId?: string

  constructor(
    message: string,
    options: { cause: unknown; recoveredProfileId?: string },
  ) {
    super(message, { cause: options.cause })
    this.name = 'ProfileSwitchError'
    this.recoveredProfileId = options.recoveredProfileId
  }
}

export class ProfileRuntimeController {
  readonly #createRuntime: ProfileRuntimeFactory
  readonly #onUnexpectedExit: (exit: UnexpectedProfileRuntimeExit) => void
  readonly #store: ProfileStore
  #generation = 0
  #queue: Promise<void> = Promise.resolve()
  #runtime: ProfileRuntimeAdapter | undefined
  #session: ProfileRuntimeSession | undefined
  #transitioning = false

  constructor(
    store: ProfileStore,
    createRuntime: ProfileRuntimeFactory,
    onUnexpectedExit: (exit: UnexpectedProfileRuntimeExit) => void,
  ) {
    this.#store = store
    this.#createRuntime = createRuntime
    this.#onUnexpectedExit = onUnexpectedExit
  }

  get current(): ProfileRuntimeSession | undefined {
    return this.#session
  }

  startActive(): Promise<ProfileRuntimeSession> {
    return this.#enqueue(async () => {
      if (this.#session && this.#runtime?.state === 'running') return this.#session
      const active = await this.#store.getActiveProfile()
      return this.#start(active)
    })
  }

  restartActive(): Promise<ProfileRuntimeSession> {
    return this.#enqueue(async () => {
      await this.#stopCurrent()
      return this.#start(await this.#store.getActiveProfile())
    })
  }

  switchTo(profileId: string): Promise<ProfileRuntimeSession> {
    return this.#enqueue(async () => {
      if (this.#session?.profile.id === profileId && this.#runtime?.state === 'running') {
        return this.#session
      }

      const previous = await this.#store.getActiveProfile()
      const target = await this.#store.getProfile(profileId)
      if (target.profile.archivedAt !== undefined) {
        throw new ProfileSwitchError('Cannot start an archived profile', { cause: profileId })
      }

      this.#transitioning = true
      try {
        await this.#stopCurrent()
        let targetSession: ProfileRuntimeSession
        try {
          targetSession = await this.#start(target)
        } catch (error) {
          const recovered = await this.#recover(previous, error)
          throw new ProfileSwitchError(
            `Could not start profile ${target.profile.name}`,
            { cause: error, recoveredProfileId: recovered.profile.id },
          )
        }

        try {
          const committed = await this.#store.setActive(profileId)
          if (this.#session !== targetSession || this.#runtime?.state !== 'running') {
            throw new Error(`Profile ${target.profile.name} exited while its selection was being committed`)
          }
          targetSession = Object.freeze({
            ...targetSession,
            paths: committed.paths,
            profile: committed.profile,
          })
          this.#session = targetSession
          return targetSession
        } catch (error) {
          try {
            await this.#stopCurrent()
          } catch (stopError) {
            throw new AggregateError(
              [error, stopError],
              `Profile ${target.profile.name} started but could not be committed or stopped`,
            )
          }
          const recovered = await this.#recover(previous, error)
          throw new ProfileSwitchError(
            `Could not commit profile ${target.profile.name}`,
            { cause: error, recoveredProfileId: recovered.profile.id },
          )
        }
      } finally {
        this.#transitioning = false
      }
    })
  }

  stop(): Promise<void> {
    return this.#enqueue(() => this.#stopCurrent())
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation, operation)
    this.#queue = result.then(() => undefined, () => undefined)
    return result
  }

  async #start(active: ActiveProfile): Promise<ProfileRuntimeSession> {
    if (this.#runtime) throw new Error('Cannot start a profile while another runtime is owned')

    const generation = ++this.#generation
    let instance: ProfileRuntimeAdapter | undefined
    instance = this.#createRuntime(active, (event) => {
      if (instance) this.#handleExit(instance, generation, event)
    })
    this.#runtime = instance
    try {
      const ready = await instance.start()
      if (this.#runtime !== instance || generation !== this.#generation) {
        throw new Error('Profile runtime ownership changed during startup')
      }
      const session = Object.freeze({ ...active, generation, ready })
      this.#session = session
      return session
    } catch (error) {
      if (this.#runtime === instance) {
        this.#runtime = undefined
        this.#session = undefined
      }
      try {
        await instance.stop()
      } catch (stopError) {
        throw new AggregateError([error, stopError], 'Profile startup and cleanup both failed')
      }
      throw error
    }
  }

  async #stopCurrent(): Promise<void> {
    const instance = this.#runtime
    if (!instance) {
      this.#session = undefined
      return
    }
    await instance.stop()
    if (this.#runtime === instance) {
      this.#runtime = undefined
      this.#session = undefined
    }
  }

  async #recover(
    previous: ActiveProfile,
    originalError: unknown,
  ): Promise<ProfileRuntimeSession> {
    let recovered: ProfileRuntimeSession
    try {
      recovered = await this.#start(previous)
    } catch (recoveryError) {
      throw new AggregateError(
        [originalError, recoveryError],
        `Profile transition failed and ${previous.profile.name} could not be recovered`,
      )
    }

    try {
      const committed = await this.#store.setActive(previous.profile.id)
      if (this.#session !== recovered || this.#runtime?.state !== 'running') {
        throw new Error(`Recovered profile ${previous.profile.name} exited while being committed`)
      }
      recovered = Object.freeze({
        ...recovered,
        paths: committed.paths,
        profile: committed.profile,
      })
      this.#session = recovered
      return recovered
    } catch (commitError) {
      try {
        await this.#stopCurrent()
      } catch (stopError) {
        throw new AggregateError(
          [originalError, commitError, stopError],
          `Profile transition failed and ${previous.profile.name} recovery could not be committed or stopped`,
        )
      }
      throw new AggregateError(
        [originalError, commitError],
        `Profile transition failed and ${previous.profile.name} recovery could not be committed`,
      )
    }
  }

  #handleExit(
    instance: ProfileRuntimeAdapter,
    generation: number,
    event: DshRuntimeExit,
  ): void {
    if (event.expected || instance !== this.#runtime || generation !== this.#generation) return
    const session = this.#session
    this.#runtime = undefined
    this.#session = undefined
    if (session && !this.#transitioning) this.#onUnexpectedExit({ event, session })
  }
}
