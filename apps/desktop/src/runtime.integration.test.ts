import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { DshRuntime } from '@dsh-workbench/runtime'

import { prepareDesktopCoreContribution } from './contribution.js'

const temporaryDirectories: string[] = []
const runtimes: DshRuntime[] = []

afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.stop()))
  await Promise.allSettled(
    temporaryDirectories.splice(0).map((directory) => rm(directory, {
      force: true,
      maxRetries: 3,
      recursive: true,
      retryDelay: 100,
    })),
  )
})

describe('desktop DSH lifecycle', () => {
  it('starts on an OS-assigned port, serves the complete UI, and shuts down through IPC', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'dsh-workbench-integration-'))
    temporaryDirectories.push(userDataPath)
    const contribution = await prepareDesktopCoreContribution(userDataPath)
    const onExit = vi.fn()
    const runtime = new DshRuntime({
      cwd: userDataPath,
      env: {
        ...process.env,
        DSH_HOME: join(userDataPath, 'dsh'),
      },
      onExit,
      patchFiles: [contribution.patch],
    })
    runtimes.push(runtime)

    const ready = await runtime.start()
    const url = new URL(ready.url)
    expect(url.hostname).toBe('127.0.0.1')
    expect(Number(url.port)).toBeGreaterThan(0)
    expect(ready.pid).toBeGreaterThan(0)
    expect(runtime.state).toBe('running')

    const response = await fetch(ready.url)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(await response.text()).toContain('__DSH_BOOT__')

    await runtime.stop()
    expect(runtime.state).toBe('idle')
    expect(runtime.url).toBeUndefined()
    expect(onExit).toHaveBeenCalledWith(expect.objectContaining({
      code: 0,
      expected: true,
    }))
  })
})
