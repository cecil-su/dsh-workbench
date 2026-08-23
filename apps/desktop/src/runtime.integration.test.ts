import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { DshRuntime } from '@dsh-workbench/runtime'

import { prepareDesktopCoreContribution } from './contribution.js'
import { buildProfileEnvironment } from './profile-environment.js'
import { prepareProfileModuleFallback } from './profile-modules.js'
import { ProfileRuntimeController } from './profile-runtime.js'
import { ProfileStore } from './profile-store.js'

const temporaryDirectories: string[] = []
const runtimes: DshRuntime[] = []

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function isPortOpen(url: string): Promise<boolean> {
  const parsed = new URL(url)
  return new Promise((resolve) => {
    const socket = createConnection({ host: parsed.hostname, port: Number(parsed.port) })
    const finish = (open: boolean): void => {
      socket.destroy()
      resolve(open)
    }
    socket.setTimeout(750)
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.once('timeout', () => finish(false))
  })
}

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
    const dshHome = join(userDataPath, 'dsh')
    prepareProfileModuleFallback(dshHome)
    const onExit = vi.fn()
    const runtime = new DshRuntime({
      cwd: userDataPath,
      env: buildProfileEnvironment(process.env, dshHome),
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
    const html = await response.text()
    expect(html).toContain('__DSH_BOOT__')
    expect(html).toContain('@dsh-workbench/desktop-core')
    expect(html).toContain('@dsh-workbench/oauth-ui')
    expect(html).toContain('@dsh-workbench/diagnostics-ui')

    const authorizationResponse = await fetch(
      new URL('/workbench/authorization', ready.url),
      {
        body: JSON.stringify({ action: 'snapshot' }),
        headers: {
          'content-type': 'application/json',
          origin: new URL(ready.url).origin,
          'sec-fetch-site': 'same-origin',
        },
        method: 'POST',
      },
    )
    expect(authorizationResponse.status).toBe(200)
    const authorizationPayload = await authorizationResponse.json() as {
      ok: boolean
      value: {
        entries: Array<{
          configured: boolean
          key: string
          methods: Array<{ id: string; label: string }>
        }>
      }
    }
    expect(authorizationPayload.ok).toBe(true)
    expect(authorizationPayload.value.entries).toContainEqual(expect.objectContaining({
      configured: false,
      key: 'llm-pi-ai/openai-codex',
      methods: expect.arrayContaining([expect.objectContaining({ id: 'oauth' })]),
    }))
    expect(JSON.stringify(authorizationPayload)).not.toContain('payload')

    await runtime.stop()
    expect(runtime.state).toBe('idle')
    expect(runtime.url).toBeUndefined()
    expect(onExit).toHaveBeenCalledWith(expect.objectContaining({
      code: 0,
      expected: true,
    }))
  })

  it('switches real DSH processes across isolated profile homes and workspaces', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'dsh-workbench-profile-integration-'))
    temporaryDirectories.push(userDataPath)
    const profiles = new ProfileStore(userDataPath, { createId: () => 'profile-second' })
    const first = await profiles.getActiveProfile()
    const secondProfile = await profiles.create('Second')
    const second = await profiles.getProfile(secondProfile.id)
    const contribution = await prepareDesktopCoreContribution(userDataPath)

    await writeFile(join(first.paths.dshHome, 'profile-sentinel'), 'first')
    await writeFile(join(second.paths.dshHome, 'profile-sentinel'), 'second')
    await writeFile(join(first.paths.workspace, 'workspace-sentinel'), 'first')
    await expect(access(join(second.paths.workspace, 'workspace-sentinel'))).rejects.toMatchObject({
      code: 'ENOENT',
    })

    const controller = new ProfileRuntimeController(
      profiles,
      (active, onExit) => {
        prepareProfileModuleFallback(active.paths.dshHome)
        const instance = new DshRuntime({
          cwd: active.paths.workspace,
          env: buildProfileEnvironment(process.env, active.paths.dshHome),
          onExit,
          patchFiles: [contribution.patch],
        })
        runtimes.push(instance)
        return instance
      },
      vi.fn(),
    )

    const firstSession = await controller.startActive()
    const secondSession = await controller.switchTo(second.profile.id)

    expect(firstSession.profile.id).toBe(first.profile.id)
    expect(secondSession.profile.id).toBe(second.profile.id)
    expect(secondSession.paths.dshHome).not.toBe(firstSession.paths.dshHome)
    expect(secondSession.paths.workspace).not.toBe(firstSession.paths.workspace)
    expect(secondSession.ready.pid).not.toBe(firstSession.ready.pid)
    expect(isProcessAlive(firstSession.ready.pid)).toBe(false)
    expect(await isPortOpen(firstSession.ready.url)).toBe(false)
    expect(await isPortOpen(secondSession.ready.url)).toBe(true)

    await controller.stop()
    expect(isProcessAlive(secondSession.ready.pid)).toBe(false)
    expect(await isPortOpen(secondSession.ready.url)).toBe(false)
  })
})
