import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { prepareDesktopCoreContribution, renderDesktopCorePatch } from './contribution.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  )
})

describe('desktop DSH contribution', () => {
  it('renders a concrete loader entry without runtime expressions', () => {
    expect(JSON.parse(renderDesktopCorePatch('/app/desktop-core.js'))).toEqual([
      {
        insert: [
          {
            id: 'dsh-workbench-desktop-core',
            name: '/app/desktop-core.js',
          },
        ],
      },
    ])
  })

  it('resolves the packaged plugin and writes its overlay outside the DSH profile', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'dsh-workbench-desktop-test-'))
    temporaryDirectories.push(userDataPath)

    const contribution = await prepareDesktopCoreContribution(userDataPath)
    const patch = JSON.parse(await readFile(contribution.patch, 'utf8')) as unknown

    expect(contribution.entry).toContain(join('plugins', 'desktop-core', 'lib', 'index.js'))
    expect(contribution.patch).toBe(
      join(userDataPath, 'workbench', 'desktop-core.patch.json'),
    )
    expect(patch).toEqual([
      {
        insert: [
          {
            id: 'dsh-workbench-desktop-core',
            name: pathToFileURL(contribution.entry).href,
          },
        ],
      },
    ])
  })
})
