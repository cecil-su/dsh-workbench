import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  buildDshWebArgs,
  buildDshProcessArgs,
  DshRuntime,
  DshRuntimeError,
  parseDesktopReadyMessage,
  resolveDshBin,
  sanitizeDshEnvironment,
} from './index.js'

const fakeDshBin = fileURLToPath(new URL('../test/fixtures/fake-dsh.mjs', import.meta.url))
const runtimes: DshRuntime[] = []

afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.stop()))
})

function fakeRuntime(
  mode = 'ready',
  options: ConstructorParameters<typeof DshRuntime>[0] = {},
): DshRuntime {
  const runtime = new DshRuntime({
    ...options,
    dshBin: fakeDshBin,
    env: {
      ...process.env,
      ...options.env,
      DSH_WORKBENCH_FAKE_MODE: mode,
    },
    readinessProbe: options.readinessProbe ?? (async () => {}),
    shutdownTimeoutMs: options.shutdownTimeoutMs ?? 500,
    startupTimeoutMs: options.startupTimeoutMs ?? 500,
  })
  runtimes.push(runtime)
  return runtime
}

describe('DSH runtime', () => {
  it('resolves the pinned DSH executable', () => {
    expect(existsSync(resolveDshBin())).toBe(true)
  })

  it('passes overlays before explicit loopback Web arguments', () => {
    expect(buildDshWebArgs(['/one.patch.yml', '/two.patch.yml'])).toEqual([
      'web',
      '--patch',
      '/one.patch.yml',
      '--patch',
      '/two.patch.yml',
      '--no-open',
      '--host',
      '127.0.0.1',
      '--port',
      '0',
    ])
  })

  it('exposes Node internals only to the supervised DSH process', () => {
    expect(buildDshProcessArgs('/opt/dsh/lib/bin.js', ['/one.patch.yml'], 43123)).toEqual([
      '--expose-internals',
      '/opt/dsh/lib/bin.js',
      'web',
      '--patch',
      '/one.patch.yml',
      '--no-open',
      '--host',
      '127.0.0.1',
      '--port',
      '43123',
    ])
  })

  it('removes Node and Electron injection variables case-insensitively', () => {
    expect(sanitizeDshEnvironment({
      DSH_SAFE_VALUE: 'preserved',
      electron_run_as_node: '1',
      Node_Options: '--inspect',
      node_path: '/tmp/poison',
    })).toEqual({ DSH_SAFE_VALUE: 'preserved' })
  })

  it('rejects invalid configured ports', () => {
    expect(() => buildDshWebArgs([], -1)).toThrow(RangeError)
    expect(() => buildDshWebArgs([], 65_536)).toThrow(RangeError)
    expect(() => buildDshWebArgs([], 1.5)).toThrow(RangeError)
  })

  it('accepts only protocol-matched loopback ready messages', () => {
    expect(parseDesktopReadyMessage({
      protocolVersion: 1,
      type: 'dsh-workbench/ready',
      url: 'http://127.0.0.1:43123',
    })).toEqual({
      protocolVersion: 1,
      type: 'dsh-workbench/ready',
      url: 'http://127.0.0.1:43123',
    })

    expect(parseDesktopReadyMessage({
      protocolVersion: 2,
      type: 'dsh-workbench/ready',
      url: 'http://127.0.0.1:43123',
    })).toBeUndefined()
    expect(parseDesktopReadyMessage({
      protocolVersion: 1,
      type: 'dsh-workbench/ready',
      url: 'http://example.com:43123',
    })).toBeUndefined()
    expect(parseDesktopReadyMessage({
      protocolVersion: 1,
      type: 'dsh-workbench/ready',
      url: 'https://127.0.0.1:43123',
    })).toBeUndefined()
  })

  it('shares concurrent startup and shutdown operations', async () => {
    const probe = vi.fn(async () => {})
    const runtime = fakeRuntime('ready', { readinessProbe: probe })

    const firstStart = runtime.start()
    const secondStart = runtime.start()
    expect(secondStart).toBe(firstStart)

    const [firstReady, secondReady] = await Promise.all([firstStart, secondStart])
    expect(secondReady).toEqual(firstReady)
    expect(runtime.state).toBe('running')
    expect(runtime.url).toBe('http://127.0.0.1:43123')
    expect(probe).toHaveBeenCalledTimes(1)

    const firstStop = runtime.stop()
    const secondStop = runtime.stop()
    expect(secondStop).toBe(firstStop)
    await firstStop
    expect(runtime.state).toBe('idle')
    expect(runtime.url).toBeUndefined()
  })

  it('uses IPC shutdown after ready arrives while the HTTP probe is pending', async () => {
    let announceProbe: (() => void) | undefined
    const probeStarted = new Promise<void>((resolve) => {
      announceProbe = resolve
    })
    const exit = vi.fn()
    const runtime = fakeRuntime('ready', {
      onExit: exit,
      readinessProbe: async (_url, signal) => {
        announceProbe?.()
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      },
      startupTimeoutMs: 2_000,
    })

    const startup = runtime.start()
    await probeStarted
    await runtime.stop()
    await expect(startup).rejects.toMatchObject({ stage: 'startup' })
    expect(exit).toHaveBeenCalledWith(expect.objectContaining({
      code: 0,
      expected: true,
      signal: null,
    }))
  })

  it('captures startup output when DSH exits before ready', async () => {
    const runtime = fakeRuntime('exit-before-ready')

    const error = await runtime.start().catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(DshRuntimeError)
    expect(error).toMatchObject({ stage: 'startup' })
    expect((error as DshRuntimeError).output).toContain('fake DSH failed before ready')
    expect(runtime.state).toBe('idle')
  })

  it('reports an unexpected exit and can start a fresh runtime', async () => {
    const exit = vi.fn()
    const runtime = fakeRuntime('exit-after-ready', { onExit: exit })

    await runtime.start()
    await vi.waitFor(() => expect(exit).toHaveBeenCalledTimes(1))
    expect(exit).toHaveBeenCalledWith(expect.objectContaining({
      code: 17,
      expected: false,
      signal: null,
    }))
    expect(runtime.state).toBe('idle')
    expect(runtime.url).toBeUndefined()

    const replacement = fakeRuntime()
    await replacement.start()
    await replacement.stop()
  })

  it('fails closed when the child sends an invalid ready URL', async () => {
    const runtime = fakeRuntime('invalid-ready', { startupTimeoutMs: 100 })

    await expect(runtime.start()).rejects.toMatchObject({
      name: 'DshRuntimeError',
      stage: 'startup',
    })
    expect(runtime.state).toBe('idle')
  })

  it('distinguishes readiness verification failures', async () => {
    const runtime = fakeRuntime('ready', {
      readinessProbe: async () => {
        throw new Error('not the DSH UI')
      },
      startupTimeoutMs: 100,
    })

    await expect(runtime.start()).rejects.toMatchObject({
      name: 'DshRuntimeError',
      stage: 'readiness',
    })
    expect(runtime.state).toBe('idle')
  })

  it('turns spawn errors into typed runtime failures', async () => {
    const runtime = fakeRuntime('ready', { execPath: '/definitely-not-a-node-executable' })

    await expect(runtime.start()).rejects.toMatchObject({
      name: 'DshRuntimeError',
      stage: 'spawn',
    })
    expect(runtime.state).toBe('idle')
  })

  it('removes parent Node injection variables from the supervised process', async () => {
    const runtime = fakeRuntime('ready', {
      env: {
        ...process.env,
        NODE_OPTIONS: '--definitely-not-a-valid-node-option',
        NODE_PATH: '/tmp/dsh-workbench-node-path-poison',
      },
    })

    await expect(runtime.start()).resolves.toMatchObject({
      url: 'http://127.0.0.1:43123',
    })
  })
})
