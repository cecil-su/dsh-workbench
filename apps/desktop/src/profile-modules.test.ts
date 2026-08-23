import { lstat, mkdir, realpath, symlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { prepareProfileModuleFallback } from './profile-modules.js'
import { useTemporaryDirectory } from './test-helpers.js'

const require = createRequire(import.meta.url)

describe('prepareProfileModuleFallback', () => {
  it('creates and heals the namespaced bare-package link used by DSH profiles', async () => {
    const root = await useTemporaryDirectory('dsh-workbench-modules-')
    const dshHome = join(root, 'dsh')
    const outside = await useTemporaryDirectory('dsh-workbench-modules-wrong-')
    const link = join(dshHome, 'profiles', 'node_modules', '@dsh-workbench', 'desktop-core')
    await mkdir(dirname(link), { recursive: true })
    await symlink(outside, link, 'junction')

    prepareProfileModuleFallback(dshHome)
    const expected = dirname(require.resolve('@dsh-workbench/desktop-core/package.json'))

    expect((await lstat(link)).isSymbolicLink()).toBe(true)
    expect(await realpath(link)).toBe(await realpath(expected))
    const oauthLink = join(dshHome, 'profiles', 'node_modules', '@dsh-workbench', 'oauth-ui')
    const expectedOauth = dirname(require.resolve('@dsh-workbench/oauth-ui/package.json'))
    expect((await lstat(oauthLink)).isSymbolicLink()).toBe(true)
    expect(await realpath(oauthLink)).toBe(await realpath(expectedOauth))
    expect(() => prepareProfileModuleFallback(dshHome)).not.toThrow()
  })

  it('refuses to replace a real directory in the managed namespace', async () => {
    const root = await useTemporaryDirectory('dsh-workbench-modules-')
    const dshHome = join(root, 'dsh')
    const link = join(dshHome, 'profiles', 'node_modules', '@dsh-workbench', 'desktop-core')
    await mkdir(link, { recursive: true })

    expect(() => prepareProfileModuleFallback(dshHome)).toThrow(/cannot replace the non-link/u)
  })

  it('refuses a symlink in the managed profile module parent chain', async () => {
    const root = await useTemporaryDirectory('dsh-workbench-modules-')
    const outside = await useTemporaryDirectory('dsh-workbench-modules-outside-')
    const dshHome = join(root, 'dsh')
    await mkdir(dshHome)
    await symlink(outside, join(dshHome, 'profiles'), 'junction')

    expect(() => prepareProfileModuleFallback(dshHome)).toThrow(/must be a real directory/u)
    await expect(lstat(join(outside, 'node_modules'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
