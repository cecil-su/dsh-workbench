import { describe, expect, it, vi } from 'vitest'

import type { ProfileRuntimeSession } from './profile-runtime.js'
import {
  authorizeProfileRequest,
  createSerializedProfileSelector,
  parseProfileRequest,
  ProfileTransitionCoordinator,
  publicProfileSnapshot,
  switchProfileAndActivate,
} from './profiles-ipc.js'

const context = { generation: 3, profileId: 'profile-current' }
const timestamp = '2026-08-23T00:00:00.000Z'

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
    ready: { pid: generation, url: `http://127.0.0.1:${String(4500 + generation)}` },
  }
}

describe('profile IPC validation', () => {
  it('accepts only exact operation schemas', () => {
    expect(parseProfileRequest({ context }, 'list')).toEqual({ context })
    expect(parseProfileRequest({ context, name: 'Second' }, 'create')).toEqual({
      context,
      name: 'Second',
    })
    expect(parseProfileRequest({ context, profileId: 'profile-next' }, 'select')).toEqual({
      context,
      profileId: 'profile-next',
    })
    expect(() => parseProfileRequest({ context, extra: true }, 'list')).toThrow(/fields/u)
    expect(() => parseProfileRequest({ context, profileId: '../escape' }, 'select')).toThrow(/id/u)
    expect(() => parseProfileRequest({
      context: { ...context, generation: 4, extra: true },
    }, 'list')).toThrow(/context/u)
  })

  it('authorizes only the active main frame, origin, and runtime generation', () => {
    const session = runtimeSession(context.profileId, context.generation)
    const mainFrame = { url: session.ready.url }
    const webContents = { mainFrame }
    const window = { isDestroyed: () => false, webContents }
    const controller = { current: session }
    const event = { sender: webContents, senderFrame: mainFrame }
    const request = { context }

    expect(() => authorizeProfileRequest(
      event as never,
      request,
      controller as never,
      window as never,
    )).not.toThrow()
    expect(() => authorizeProfileRequest(
      { ...event, senderFrame: { url: session.ready.url } } as never,
      request,
      controller as never,
      window as never,
    )).toThrow(/main frame/u)
    const wrongOriginFrame = { url: 'http://127.0.0.1:9999/' }
    const wrongOriginWebContents = { mainFrame: wrongOriginFrame }
    expect(() => authorizeProfileRequest(
      { sender: wrongOriginWebContents, senderFrame: wrongOriginFrame } as never,
      request,
      controller as never,
      { isDestroyed: () => false, webContents: wrongOriginWebContents } as never,
    )).toThrow(/origin/u)
    expect(() => authorizeProfileRequest(
      event as never,
      { context: { ...context, generation: context.generation - 1 } },
      controller as never,
      window as never,
    )).toThrow(/stale/u)
  })

  it('never exposes filesystem paths or archived timestamps to the renderer', () => {
    const result = publicProfileSnapshot({
      activeProfileId: 'profile-current',
      profiles: [{
        archivedAt: '2026-08-23T02:00:00.000Z',
        createdAt: '2026-08-23T00:00:00.000Z',
        id: 'profile-current',
        name: 'Current',
        updatedAt: '2026-08-23T01:00:00.000Z',
      }],
      schemaVersion: 1,
    })

    expect(result.profiles[0]).toEqual({
      archived: true,
      createdAt: '2026-08-23T00:00:00.000Z',
      id: 'profile-current',
      name: 'Current',
      updatedAt: '2026-08-23T01:00:00.000Z',
    })
    expect(JSON.stringify(result)).not.toContain('path')
  })

  it('displays the recovered generation when the runtime switch itself fails', async () => {
    const previous = runtimeSession('profile-current', 1)
    const recovered = runtimeSession('profile-current', 3)
    const failure = new Error('target failed')
    let current = previous
    const controller = {
      get current() { return current },
      async switchTo() {
        current = recovered
        throw failure
      },
    }
    const activate = vi.fn(async () => {})

    await expect(switchProfileAndActivate(controller, activate, 'profile-next')).rejects.toBe(failure)
    expect(activate).toHaveBeenCalledWith(recovered)
  })

  it('rolls runtime and window back when the target window cannot load', async () => {
    const previous = runtimeSession('profile-current', 1)
    const target = runtimeSession('profile-next', 2)
    const recovered = runtimeSession('profile-current', 3)
    let current = previous
    const controller = {
      get current() { return current },
      async switchTo(profileId: string) {
        current = profileId === target.profile.id ? target : recovered
        return current
      },
    }
    const failure = new Error('window load failed')
    const activate = vi.fn(async (session: ProfileRuntimeSession) => {
      if (session === target) throw failure
    })

    await expect(switchProfileAndActivate(controller, activate, target.profile.id)).rejects.toBe(failure)
    expect(controller.current).toBe(recovered)
    expect(activate.mock.calls.map(([session]) => session)).toEqual([target, recovered])
  })

  it('displays the runtime recovered by a failed window rollback', async () => {
    const previous = runtimeSession('profile-current', 1)
    const target = runtimeSession('profile-next', 2)
    const recoveredTarget = runtimeSession('profile-next', 3)
    let current = previous
    let switches = 0
    const controller = {
      get current() { return current },
      async switchTo() {
        switches += 1
        if (switches === 1) {
          current = target
          return target
        }
        current = recoveredTarget
        throw new Error('previous profile restart failed')
      },
    }
    const activate = vi.fn(async (session: ProfileRuntimeSession) => {
      if (session === target) throw new Error('target window load failed')
    })

    await expect(switchProfileAndActivate(controller, activate, target.profile.id)).rejects.toBeInstanceOf(AggregateError)
    expect(controller.current).toBe(recoveredTarget)
    expect(activate.mock.calls.map(([session]) => session)).toEqual([target, recoveredTarget])
  })

  it('serializes runtime switches together with BrowserWindow activation', async () => {
    const first = runtimeSession('profile-current', 1)
    const second = runtimeSession('profile-second', 2)
    const third = runtimeSession('profile-third', 3)
    const sessions = new Map([
      [second.profile.id, second],
      [third.profile.id, third],
    ])
    const order: string[] = []
    let current = first
    let releaseSecondWindow: (() => void) | undefined
    const secondWindow = new Promise<void>((resolve) => {
      releaseSecondWindow = resolve
    })
    const controller = {
      get current() { return current },
      async switchTo(profileId: string) {
        order.push(`switch:${profileId}`)
        current = sessions.get(profileId) ?? first
        return current
      },
    }
    const activate = vi.fn(async (session: ProfileRuntimeSession) => {
      order.push(`activate:${session.profile.id}:start`)
      if (session === second) await secondWindow
      order.push(`activate:${session.profile.id}:end`)
    })
    const select = createSerializedProfileSelector(controller, activate)

    const selectingSecond = select(second.profile.id)
    await vi.waitFor(() => expect(order).toContain(`activate:${second.profile.id}:start`))
    const selectingThird = select(third.profile.id)
    await Promise.resolve()
    expect(order).not.toContain(`switch:${third.profile.id}`)

    releaseSecondWindow?.()
    await Promise.all([selectingSecond, selectingThird])
    expect(order).toEqual([
      `switch:${second.profile.id}`,
      `activate:${second.profile.id}:start`,
      `activate:${second.profile.id}:end`,
      `switch:${third.profile.id}`,
      `activate:${third.profile.id}:start`,
      `activate:${third.profile.id}:end`,
    ])
    expect(current).toBe(third)
  })

  it('serializes unexpected-exit recovery behind an in-flight window activation', async () => {
    const first = runtimeSession('profile-current', 1)
    const target = runtimeSession('profile-next', 2)
    const recovered = runtimeSession('profile-next', 3)
    const order: string[] = []
    let current: ProfileRuntimeSession | undefined = first
    let releaseTargetWindow: (() => void) | undefined
    const targetWindow = new Promise<void>((resolve) => {
      releaseTargetWindow = resolve
    })
    const controller = {
      get current() { return current },
      async restartActive() {
        order.push('restart')
        current = recovered
        return recovered
      },
      async startActive() { return current ?? first },
      async stop() { current = undefined },
      async switchTo() {
        order.push('switch')
        current = target
        return target
      },
    }
    const activate = vi.fn(async (session: ProfileRuntimeSession) => {
      order.push(`activate:${String(session.generation)}:start`)
      if (session === target) await targetWindow
      order.push(`activate:${String(session.generation)}:end`)
    })
    const shouldRetry = vi.fn(async () => true)
    const transitions = new ProfileTransitionCoordinator(controller, activate)

    const selecting = transitions.select(target.profile.id)
    await vi.waitFor(() => expect(order).toContain('activate:2:start'))
    current = undefined
    const recovering = transitions.recover(target, shouldRetry)
    await Promise.resolve()
    expect(order).not.toContain('restart')

    releaseTargetWindow?.()
    await Promise.all([selecting, recovering])
    expect(order).toEqual([
      'switch',
      'activate:2:start',
      'activate:2:end',
      'restart',
      'activate:3:start',
      'activate:3:end',
    ])
    expect(shouldRetry).toHaveBeenCalledOnce()
  })

  it('waits for active transitions before shutdown and rejects later recovery', async () => {
    const first = runtimeSession('profile-current', 1)
    const target = runtimeSession('profile-next', 2)
    const order: string[] = []
    let current: ProfileRuntimeSession | undefined = first
    let releaseTargetWindow: (() => void) | undefined
    const targetWindow = new Promise<void>((resolve) => {
      releaseTargetWindow = resolve
    })
    const controller = {
      get current() { return current },
      async restartActive() {
        order.push('restart')
        return first
      },
      async startActive() { return current ?? first },
      async stop() {
        order.push('stop')
        current = undefined
      },
      async switchTo() {
        order.push('switch')
        current = target
        return target
      },
    }
    const activate = async (): Promise<void> => {
      order.push('activate:start')
      await targetWindow
      order.push('activate:end')
    }
    const shouldRetry = vi.fn(async () => true)
    const transitions = new ProfileTransitionCoordinator(controller, activate)

    const selecting = transitions.select(target.profile.id)
    await vi.waitFor(() => expect(order).toContain('activate:start'))
    const shuttingDown = transitions.shutdown()
    const recovering = transitions.recover(target, shouldRetry)
    await Promise.resolve()
    expect(order).not.toContain('stop')

    releaseTargetWindow?.()
    await Promise.all([selecting, shuttingDown, recovering])
    expect(order).toEqual(['switch', 'activate:start', 'activate:end', 'stop'])
    expect(shouldRetry).not.toHaveBeenCalled()
  })
})
