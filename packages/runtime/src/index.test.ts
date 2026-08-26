import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  buildDshWebArgs,
  buildDshProcessArgs,
  DshRuntime,
  DshRuntimeError,
  DshOutputSanitizer,
  parseDesktopReadyMessage,
  resolveDshBin,
  resolveDshVersion,
  sanitizeDshOutput,
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

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

describe('DSH runtime', () => {
  it('resolves the pinned DSH executable', () => {
    expect(existsSync(resolveDshBin())).toBe(true)
    expect(resolveDshVersion()).toBe('0.1.1-rc.2')
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

  it('redacts credential-shaped output and removes terminal controls', () => {
    const sanitized = sanitizeDshOutput([
      '\u001B[31mwarning\u001B[0m',
      'Authorization: Bearer runtime-canary-secret',
      'Proxy-Authorization: Basic cnVudGltZS1jYW5hcnktc2VjcmV0',
      'Authorization: AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE Signature=aws-signature-canary',
      'Cookie: sessionid=session-cookie-canary; csrftoken=csrf-cookie-canary',
      'Set-Cookie: refresh=refresh-cookie-canary; HttpOnly; Secure',
      'api_key="runtime-canary-secret with spaces"',
      'https://example.test/callback?access_token=runtime-canary-secret&safe=yes',
      'sk-runtimecanarysecret',
      'benign-marker',
      '\u202E',
    ].join('\n'))
    expect(sanitized).toContain('warning')
    expect(sanitized).toContain('benign-marker')
    expect(sanitized).toContain('safe=yes')
    expect(sanitized).not.toContain('\u001B')
    expect(sanitized).not.toContain('runtime-canary-secret')
    expect(sanitized).not.toContain('runtimecanarysecret')
    expect(sanitized).not.toContain('cnVudGltZS1jYW5hcnktc2VjcmV0')
    expect(sanitized).not.toContain('aws-signature-canary')
    expect(sanitized).not.toContain('session-cookie-canary')
    expect(sanitized).not.toContain('csrf-cookie-canary')
    expect(sanitized).not.toContain('refresh-cookie-canary')
    expect(sanitized).not.toContain('\u202E')
  })

  it('holds split UTF-8 and secret fields until a complete line can be sanitized', () => {
    const sanitizer = new DshOutputSanitizer()
    const encoded = Buffer.from('before secret=分片密钥 after\n', 'utf8')
    const split = encoded.indexOf(Buffer.from('片', 'utf8')) + 1
    expect(sanitizer.push(encoded.subarray(0, split))).toEqual([])
    const output = sanitizer.push(encoded.subarray(split))
    expect(output.join('')).toContain('before')
    expect(output.join('')).toContain('after')
    expect(output.join('')).not.toContain('分片密钥')
    expect(sanitizer.finish()).toEqual([])
  })

  it('omits an unterminated output flood instead of retaining or exposing it', () => {
    const sanitizer = new DshOutputSanitizer()
    const output = sanitizer.push(Buffer.from(`secret=${'x'.repeat(20_000)}`))
    expect(output).toEqual(['[output omitted: unterminated line exceeded the diagnostic limit]\n'])
    expect(sanitizer.push(Buffer.from('still-secret'))).toEqual([])
    expect(sanitizer.push(Buffer.from('\nbenign-marker\n'))).toEqual(['benign-marker\n'])
  })

  it('rejects invalid configured ports', () => {
    expect(() => buildDshWebArgs([], -1)).toThrow(RangeError)
    expect(() => buildDshWebArgs([], 65_536)).toThrow(RangeError)
    expect(() => buildDshWebArgs([], 1.5)).toThrow(RangeError)
  })

  it('accepts only protocol-matched loopback ready messages', () => {
    const profileEvidence = {
      ambientCredentialConfigured: false,
      credentialRecordCount: 1,
      credentialRecordFingerprint: 'a'.repeat(64),
      cwd: process.cwd(),
      dshHome: process.cwd(),
    }
    expect(parseDesktopReadyMessage({
      profileEvidence,
      protocolVersion: 1,
      type: 'dsh-workbench/ready',
      url: 'http://127.0.0.1:43123',
    })).toEqual({
      profileEvidence,
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
    expect(parseDesktopReadyMessage({
      profileEvidence: { ...profileEvidence, credentialRecordFingerprint: 'not-a-hash' },
      protocolVersion: 1,
      type: 'dsh-workbench/ready',
      url: 'http://127.0.0.1:43123',
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
  }, 15_000)

  it('force-terminates detached descendant trees when graceful shutdown hangs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-workbench-runtime-tree-'))
    const pidPath = join(root, 'descendant.pid')
    let descendantPid = 0
    let runtime: DshRuntime
    runtime = fakeRuntime('hang-with-descendant', {
      env: { DSH_WORKBENCH_FAKE_DESCENDANT_PID_PATH: pidPath },
      processTable: () => {
        const rootPid = runtime.pid ?? -1
        return [
          { pgid: 1, pid: process.pid, ppid: 1, startTime: 'supervisor' },
          { pgid: 1, pid: rootPid, ppid: process.pid, startTime: 'root' },
          { pgid: descendantPid, pid: descendantPid, ppid: rootPid, startTime: 'descendant' },
        ]
      },
      shutdownTimeoutMs: 50,
    })
    try {
      await runtime.start()
      await vi.waitFor(async () => {
        descendantPid = Number(await readFile(pidPath, 'utf8'))
        expect(descendantPid).toBeGreaterThan(0)
      })
      expect(isProcessAlive(descendantPid)).toBe(true)

      await runtime.stop()
      expect(isProcessAlive(descendantPid)).toBe(false)
      expect(runtime.state).toBe('idle')
    } finally {
      if (descendantPid > 0 && isProcessAlive(descendantPid)) {
        try {
          if (process.platform === 'win32') process.kill(descendantPid, 'SIGKILL')
          else process.kill(-descendantPid, 'SIGKILL')
        } catch {}
      }
      await rm(root, { force: true, recursive: true })
    }
  })

  it('sweeps detached descendants after the DSH root exits gracefully', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-workbench-runtime-graceful-tree-'))
    const pidPath = join(root, 'descendant.pid')
    let descendantPid = 0
    let runtime: DshRuntime
    runtime = fakeRuntime('graceful-with-descendant', {
      env: { DSH_WORKBENCH_FAKE_DESCENDANT_PID_PATH: pidPath },
      processTable: () => {
        const rootPid = runtime.pid ?? -1
        return [
          { pgid: 1, pid: process.pid, ppid: 1, startTime: 'supervisor' },
          { pgid: 1, pid: rootPid, ppid: process.pid, startTime: 'root' },
          { pgid: descendantPid, pid: descendantPid, ppid: rootPid, startTime: 'descendant' },
        ]
      },
    })
    try {
      await runtime.start()
      await vi.waitFor(async () => {
        descendantPid = Number(await readFile(pidPath, 'utf8'))
        expect(descendantPid).toBeGreaterThan(0)
      })
      expect(isProcessAlive(descendantPid)).toBe(true)

      await runtime.stop()
      expect(isProcessAlive(descendantPid)).toBe(false)
      expect(runtime.state).toBe('idle')
    } finally {
      if (descendantPid > 0 && isProcessAlive(descendantPid)) {
        try {
          if (process.platform === 'win32') process.kill(descendantPid, 'SIGKILL')
          else process.kill(-descendantPid, 'SIGKILL')
        } catch {}
      }
      await rm(root, { force: true, recursive: true })
    }
  })

  it('does not signal a snapshotted PID after its process identity changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-workbench-runtime-reused-pid-'))
    const pidPath = join(root, 'descendant.pid')
    let descendantPid = 0
    let processTableReads = 0
    let runtime: DshRuntime
    runtime = fakeRuntime('graceful-with-descendant', {
      env: { DSH_WORKBENCH_FAKE_DESCENDANT_PID_PATH: pidPath },
      processTable: () => {
        processTableReads += 1
        const rootPid = runtime.pid ?? -1
        return [
          { pgid: 1, pid: process.pid, ppid: 1, startTime: 'supervisor' },
          { pgid: 1, pid: rootPid, ppid: process.pid, startTime: 'root' },
          {
            pgid: descendantPid,
            pid: descendantPid,
            ppid: rootPid,
            startTime: processTableReads === 1 ? 'original' : 'reused',
          },
        ]
      },
    })
    try {
      await runtime.start()
      await vi.waitFor(async () => {
        descendantPid = Number(await readFile(pidPath, 'utf8'))
        expect(descendantPid).toBeGreaterThan(0)
      })

      await runtime.stop()
      expect(isProcessAlive(descendantPid)).toBe(true)
      expect(runtime.state).toBe('idle')
    } finally {
      if (descendantPid > 0 && isProcessAlive(descendantPid)) {
        try {
          if (process.platform === 'win32') process.kill(descendantPid, 'SIGKILL')
          else process.kill(-descendantPid, 'SIGKILL')
        } catch {}
      }
      await rm(root, { force: true, recursive: true })
    }
  })

  it('fails shutdown when the process table cannot be snapshotted', async () => {
    let discoveryFails = true
    const runtime = fakeRuntime('ready', {
      processTable: () => {
        if (discoveryFails) throw new Error('injected process discovery failure')
        const rootPid = runtime.pid ?? -1
        return [{ pgid: 1, pid: rootPid, ppid: process.pid, startTime: 'root' }]
      },
    })
    await runtime.start()

    await expect(runtime.stop()).rejects.toMatchObject({
      name: 'DshRuntimeError',
      stage: 'shutdown',
    })
    expect(runtime.state).toBe('failed')

    discoveryFails = false
    await runtime.stop()
  })

  it('keeps failed state when descendant revalidation fails after root close', async () => {
    let processTableReads = 0
    let runtime: DshRuntime
    runtime = fakeRuntime('ready', {
      processTable: () => {
        processTableReads += 1
        if (processTableReads > 1) throw new Error('injected process revalidation failure')
        const rootPid = runtime.pid ?? -1
        return [
          { pgid: 1, pid: process.pid, ppid: 1, startTime: 'supervisor' },
          { pgid: 1, pid: rootPid, ppid: process.pid, startTime: 'root' },
          { pgid: 2_147_483_647, pid: 2_147_483_647, ppid: rootPid, startTime: 'descendant' },
        ]
      },
    })
    await runtime.start()

    await expect(runtime.stop()).rejects.toMatchObject({
      name: 'DshRuntimeError',
      stage: 'shutdown',
    })
    expect(runtime.state).toBe('failed')
    await expect(runtime.stop()).rejects.toMatchObject({
      name: 'DshRuntimeError',
      stage: 'shutdown',
    })
    expect(runtime.state).toBe('failed')
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
      startupTimeoutMs: 10_000,
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

  it('sanitizes split child output before callbacks, tails, and console forwarding', async () => {
    const output: string[] = []
    const stdout: string[] = []
    const stderr: string[] = []
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout.push(String(chunk))
      return true
    })
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk))
      return true
    })
    const runtime = fakeRuntime('sensitive-output', {
      onOutput: (event) => output.push(`[${event.stream}] ${event.text}`),
    })
    try {
      await runtime.start()
      await vi.waitFor(() => expect(output.join('')).toContain('marker-stderr'))
      await runtime.stop()
    } finally {
      stdoutWrite.mockRestore()
      stderrWrite.mockRestore()
    }
    const joined = output.join('')
    const consoleOutput = `${stdout.join('')}\n${stderr.join('')}`
    expect(joined).toContain('benign-before')
    expect(joined).toContain('benign-after')
    expect(joined).toContain('marker-stderr')
    expect(joined).not.toContain('runtime-canary-secret')
    expect(joined).not.toContain('\u001B')
    expect(stdout.join('')).toContain('benign-before')
    expect(stdout.join('')).toContain('benign-after')
    expect(stderr.join('')).toContain('marker-stderr')
    expect(consoleOutput).toContain('[REDACTED]')
    expect(consoleOutput).toContain('safe=yes')
    expect(consoleOutput).not.toContain('runtime-canary-secret')
    expect(consoleOutput).not.toContain('\u001B')
  })

  it('contains output observer failures while the runtime is active', async () => {
    const runtime = fakeRuntime('sensitive-output', {
      onOutput: () => { throw new Error('injected output observer failure') },
    })
    const ready = await runtime.start()
    await vi.waitFor(() => expect(isProcessAlive(ready.pid)).toBe(true))
    await expect(runtime.stop()).resolves.toBeUndefined()
    expect(runtime.state).toBe('idle')
    expect(isProcessAlive(ready.pid)).toBe(false)
  })

  it('contains output observer failures while flushing a final partial line', async () => {
    const exit = vi.fn()
    const runtime = fakeRuntime('unterminated-output', {
      onExit: exit,
      onOutput: () => { throw new Error('injected close observer failure') },
    })
    const ready = await runtime.start()
    await expect(runtime.stop()).resolves.toBeUndefined()
    expect(runtime.state).toBe('idle')
    expect(isProcessAlive(ready.pid)).toBe(false)
    expect(exit).toHaveBeenCalledWith(expect.objectContaining({
      expected: true,
      output: expect.stringContaining('final-partial-marker'),
    }))
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
