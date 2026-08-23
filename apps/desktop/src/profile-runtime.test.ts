import { describe, expect, it, vi } from 'vitest'
import type { DshRuntimeExit, DshRuntimeReady, DshRuntimeState } from '@dsh-workbench/runtime'

import { ProfileRuntimeController, type ProfileRuntimeAdapter } from './profile-runtime.js'
import { ProfileStore } from './profile-store.js'
import { useTemporaryDirectory } from './test-helpers.js'

interface FakeRuntime extends ProfileRuntimeAdapter {
  emit(event: DshRuntimeExit): void
  profileId: string
}

function exitEvent(expected = false): DshRuntimeExit {
  return { code: 1, expected, output: '', signal: null }
}

describe('ProfileRuntimeController', () => {
  it('stops the old runtime before starting and committing a new profile', async () => {
    const root = await useTemporaryDirectory('dsh-workbench-runtime-')
    const store = new ProfileStore(root, { createId: () => 'profile-b' })
    const initial = await store.getActiveProfile()
    const second = await store.create('Second')
    const order: string[] = []
    const runtimes: FakeRuntime[] = []

    const controller = new ProfileRuntimeController(store, (active, onExit) => {
      let state: DshRuntimeState = 'idle'
      const runtime: FakeRuntime = {
        profileId: active.profile.id,
        get state() { return state },
        async start(): Promise<DshRuntimeReady> {
          state = 'running'
          order.push(`start:${active.profile.id}`)
          return { pid: runtimes.length + 100, url: `http://127.0.0.1:${String(4000 + runtimes.length)}` }
        },
        async stop(): Promise<void> {
          state = 'idle'
          order.push(`stop:${active.profile.id}`)
          onExit(exitEvent(true))
        },
        emit: onExit,
      }
      runtimes.push(runtime)
      return runtime
    }, vi.fn())

    await controller.startActive()
    const switched = await controller.switchTo(second.id)

    expect(switched.profile.id).toBe(second.id)
    expect((await store.getActiveProfile()).profile.id).toBe(second.id)
    expect(order).toEqual([
      `start:${initial.profile.id}`,
      `stop:${initial.profile.id}`,
      `start:${second.id}`,
    ])
  })

  it('serializes concurrent profile switches and never owns two runtimes', async () => {
    const root = await useTemporaryDirectory('dsh-workbench-runtime-')
    let id = 0
    const store = new ProfileStore(root, { createId: () => `profile-${String(++id)}` })
    await store.initialize()
    const second = await store.create('Second')
    const third = await store.create('Third')
    let running = 0
    let maximumRunning = 0

    const controller = new ProfileRuntimeController(store, (active, onExit) => {
      let state: DshRuntimeState = 'idle'
      return {
        get state() { return state },
        async start() {
          state = 'running'
          running += 1
          maximumRunning = Math.max(maximumRunning, running)
          return { pid: 100 + id, url: `http://127.0.0.1:${String(4100 + id)}` }
        },
        async stop() {
          if (state === 'running') running -= 1
          state = 'idle'
          onExit(exitEvent(true))
        },
      }
    }, vi.fn())

    await controller.startActive()
    await Promise.all([controller.switchTo(second.id), controller.switchTo(third.id)])

    expect(maximumRunning).toBe(1)
    expect(controller.current?.profile.id).toBe(third.id)
    expect((await store.getActiveProfile()).profile.id).toBe(third.id)
  })

  it('recovers the previous profile when the target fails before commit', async () => {
    const root = await useTemporaryDirectory('dsh-workbench-runtime-')
    const store = new ProfileStore(root, { createId: () => 'profile-failing' })
    const initial = await store.getActiveProfile()
    const failing = await store.create('Failing')
    const starts: string[] = []

    const controller = new ProfileRuntimeController(store, (active, onExit) => {
      let state: DshRuntimeState = 'idle'
      return {
        get state() { return state },
        async start() {
          starts.push(active.profile.id)
          if (active.profile.id === failing.id) throw new Error('injected startup failure')
          state = 'running'
          return { pid: 100, url: 'http://127.0.0.1:4200' }
        },
        async stop() {
          state = 'idle'
          onExit(exitEvent(true))
        },
      }
    }, vi.fn())

    await controller.startActive()
    await expect(controller.switchTo(failing.id)).rejects.toMatchObject({
      recoveredProfileId: initial.profile.id,
    })

    expect(starts).toEqual([initial.profile.id, failing.id, initial.profile.id])
    expect(controller.current?.profile.id).toBe(initial.profile.id)
    expect((await store.getActiveProfile()).profile.id).toBe(initial.profile.id)
  })

  it('ignores late exit events from an old generation', async () => {
    const root = await useTemporaryDirectory('dsh-workbench-runtime-')
    const store = new ProfileStore(root, { createId: () => 'profile-next' })
    await store.initialize()
    const next = await store.create('Next')
    const runtimes: FakeRuntime[] = []
    const onUnexpectedExit = vi.fn()

    const controller = new ProfileRuntimeController(store, (active, onExit) => {
      let state: DshRuntimeState = 'idle'
      const runtime: FakeRuntime = {
        profileId: active.profile.id,
        get state() { return state },
        async start() {
          state = 'running'
          return { pid: runtimes.length + 100, url: `http://127.0.0.1:${String(4300 + runtimes.length)}` }
        },
        async stop() {
          state = 'idle'
          onExit(exitEvent(true))
        },
        emit: onExit,
      }
      runtimes.push(runtime)
      return runtime
    }, onUnexpectedExit)

    await controller.startActive()
    const old = runtimes[0]
    await controller.switchTo(next.id)
    old?.emit(exitEvent(false))

    expect(onUnexpectedExit).not.toHaveBeenCalled()
    expect(controller.current?.profile.id).toBe(next.id)
  })

  it('rolls back when the target exits while its active profile is being committed', async () => {
    const root = await useTemporaryDirectory('dsh-workbench-runtime-')
    const store = new ProfileStore(root, { createId: () => 'profile-next' })
    const initial = await store.getActiveProfile()
    const next = await store.create('Next')
    const runtimes: FakeRuntime[] = []
    const onUnexpectedExit = vi.fn()

    const controller = new ProfileRuntimeController(store, (active, onExit) => {
      let state: DshRuntimeState = 'idle'
      const runtime: FakeRuntime = {
        profileId: active.profile.id,
        get state() { return state },
        async start() {
          state = 'running'
          return { pid: runtimes.length + 100, url: `http://127.0.0.1:${String(4400 + runtimes.length)}` }
        },
        async stop() {
          state = 'idle'
          onExit(exitEvent(true))
        },
        emit(event) {
          state = 'idle'
          onExit(event)
        },
      }
      runtimes.push(runtime)
      return runtime
    }, onUnexpectedExit)

    await controller.startActive()
    const setActive = store.setActive.bind(store)
    vi.spyOn(store, 'setActive').mockImplementation(async (profileId) => {
      const committed = await setActive(profileId)
      if (profileId === next.id) runtimes.at(-1)?.emit(exitEvent(false))
      return committed
    })

    await expect(controller.switchTo(next.id)).rejects.toMatchObject({
      recoveredProfileId: initial.profile.id,
    })
    expect(controller.current?.profile.id).toBe(initial.profile.id)
    expect((await store.getActiveProfile()).profile.id).toBe(initial.profile.id)
    expect(onUnexpectedExit).not.toHaveBeenCalled()
  })
})
