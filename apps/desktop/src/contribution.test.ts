import { lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  DESKTOP_CORE_SPECIFIER,
  DIAGNOSTICS_UI_SPECIFIER,
  DSH_AUTHORIZATION_SPECIFIER,
  TASK_PLATFORM_SPECIFIER,
  OAUTH_UI_SPECIFIER,
  prepareDesktopCoreContribution,
  renderDesktopCorePatch,
} from './contribution.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  )
})

describe('desktop DSH contribution', () => {
  it('renders a concrete loader entry without runtime expressions', () => {
    expect(JSON.parse(renderDesktopCorePatch(
      '/app/desktop-core.js',
      '/app/oauth-ui.js',
      '/app/task-platform.js',
      '/app/diagnostics-ui.js',
    ))).toEqual([
      {
        insert: [
          {
            id: 'dsh-workbench-authorization',
            name: DSH_AUTHORIZATION_SPECIFIER,
          },
          {
            id: 'dsh-workbench-desktop-core',
            name: '/app/desktop-core.js',
          },
          {
            id: 'dsh-workbench-oauth-ui',
            name: '/app/oauth-ui.js',
          },
          {
            id: 'dsh-workbench-task-platform',
            name: '/app/task-platform.js',
          },
          {
            id: 'dsh-workbench-diagnostics-ui',
            name: '/app/diagnostics-ui.js',
          },
        ],
      },
    ])
  })

  it('resolves the packaged plugin and writes a bare overlay outside the DSH profile', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'dsh-workbench-desktop-test-'))
    temporaryDirectories.push(userDataPath)

    const contribution = await prepareDesktopCoreContribution(userDataPath)
    const patch = JSON.parse(await readFile(contribution.patch, 'utf8')) as unknown

    expect(contribution.entry).toContain(join('plugins', 'desktop-core', 'lib', 'index.js'))
    expect(contribution.oauthEntry).toContain(join('plugins', 'oauth-ui', 'lib', 'index.js'))
    expect(contribution.diagnosticsEntry).toContain(join('plugins', 'diagnostics-ui', 'lib', 'index.js'))
    expect(contribution.taskPlatformEntry).toContain(join('plugins', 'task-platform', 'lib', 'index.js'))
    expect(contribution.patch).toBe(
      join(userDataPath, 'workbench', 'desktop-core.patch.json'),
    )
    expect(patch).toEqual([
      {
        insert: [
          {
            id: 'dsh-workbench-authorization',
            name: DSH_AUTHORIZATION_SPECIFIER,
          },
          {
            id: 'dsh-workbench-desktop-core',
            name: DESKTOP_CORE_SPECIFIER,
          },
          {
            id: 'dsh-workbench-oauth-ui',
            name: OAUTH_UI_SPECIFIER,
          },
          {
            id: 'dsh-workbench-task-platform',
            name: TASK_PLATFORM_SPECIFIER,
          },
          {
            id: 'dsh-workbench-diagnostics-ui',
            name: DIAGNOSTICS_UI_SPECIFIER,
          },
        ],
      },
    ])
  })

  it('refuses a workbench symlink without writing through it or overwriting outside data', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'dsh-workbench-desktop-test-'))
    const outside = await mkdtemp(join(tmpdir(), 'dsh-workbench-desktop-outside-'))
    temporaryDirectories.push(userDataPath, outside)
    const outsidePatch = join(outside, 'desktop-core.patch.json')
    await writeFile(outsidePatch, 'outside-sentinel', 'utf8')
    await symlink(outside, join(userDataPath, 'workbench'), 'junction')

    await expect(prepareDesktopCoreContribution(userDataPath)).rejects.toThrow(/real directory/u)

    await expect(readFile(outsidePatch, 'utf8')).resolves.toBe('outside-sentinel')
    await expect(readdir(outside)).resolves.toEqual(['desktop-core.patch.json'])
  })

  it('refuses to replace a non-directory workbench target', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'dsh-workbench-desktop-test-'))
    temporaryDirectories.push(userDataPath)
    const workbenchPath = join(userDataPath, 'workbench')
    await writeFile(workbenchPath, 'not-a-directory', 'utf8')

    await expect(prepareDesktopCoreContribution(userDataPath)).rejects.toThrow(/real directory/u)

    expect((await lstat(workbenchPath)).isFile()).toBe(true)
    await expect(readFile(workbenchPath, 'utf8')).resolves.toBe('not-a-directory')
  })
})
