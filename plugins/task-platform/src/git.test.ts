import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { observeRepository, resolveRepository, sameRepository } from './git.js'
import { PlatformError } from './store.js'

const execFileAsync = promisify(execFile)
const temporaryDirectories: string[] = []

async function useWorkspace(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-workbench-repository-'))
  temporaryDirectories.push(workspace)
  return workspace
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { force: true, maxRetries: 3, recursive: true, retryDelay: 100 })
  )))
})

describe('resolveRepository', () => {
  it('canonicalizes nested Project paths to their Git repository root', async () => {
    const workspace = await useWorkspace()
    const project = join(workspace, 'project')
    const nested = join(project, 'src', 'nested')
    await mkdir(nested, { recursive: true })
    await execFileAsync('git', ['init', '--quiet'], { cwd: project })

    const root = await resolveRepository(workspace, 'project/src/nested')
    const same = await resolveRepository(workspace, 'project')
    expect(root.canonicalRoot).toBe(await realpath(project))
    expect(root.displayName).toBe('project')
    expect(sameRepository(root, same)).toBe(true)
  })

  it('derives actual branch, HEAD, and dirty state from fixed Git commands', async () => {
    const workspace = await useWorkspace()
    const project = join(workspace, 'project')
    await mkdir(project)
    await execFileAsync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: project })
    await writeFile(join(project, 'README.md'), '# demo\n')
    await execFileAsync('git', ['add', 'README.md'], { cwd: project })
    await execFileAsync('git', ['-c', 'user.name=Task Platform Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'initial'], { cwd: project })
    const repository = await resolveRepository(workspace, 'project')
    expect(await observeRepository(repository)).toMatchObject({ branch: 'main', dirty: false, repositoryRoot: await realpath(project) })
    await writeFile(join(project, 'untracked.txt'), 'actual change\n')
    expect((await observeRepository(repository)).dirty).toBe(true)
  })

  it('rejects Projects outside the managed workspace', async () => {
    const workspace = await useWorkspace()
    const outside = await useWorkspace()
    await execFileAsync('git', ['init', '--quiet'], { cwd: outside })

    await expect(resolveRepository(workspace, outside)).rejects.toBeInstanceOf(PlatformError)
  })

  it('rejects directories that are not Git repositories', async () => {
    const workspace = await useWorkspace()
    await mkdir(join(workspace, 'plain'))
    await expect(resolveRepository(workspace, 'plain')).rejects.toMatchObject({
      code: 'NOT_GIT_REPOSITORY',
    })
  })
})
