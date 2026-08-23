import { chmod, mkdir, readFile, rename, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  DEFAULT_PROFILE_ID,
  ProfileStore,
  ProfileStoreError,
} from './profile-store.js'
import { useTemporaryDirectory } from './test-helpers.js'

const FIXED_NOW = new Date('2026-08-23T00:00:00.000Z')

function createStore(root: string, ids: string[] = ['profile-one']): ProfileStore {
  let nextId = 0
  return new ProfileStore(root, {
    createId: () => ids[nextId++] ?? `profile-${String(nextId)}`,
    now: () => FIXED_NOW,
  })
}

describe('ProfileStore', () => {
  it('migrates the legacy DSH home and workspace into a recoverable default profile', async () => {
    const root = await useTemporaryDirectory('dsh-workbench-profile-')
    await mkdir(join(root, 'dsh'), { recursive: true })
    await mkdir(join(root, 'workspace'), { recursive: true })
    await writeFile(join(root, 'dsh', 'credential-marker'), 'preserved')
    await writeFile(join(root, 'workspace', 'project-marker'), 'preserved')

    const store = createStore(root)
    const snapshot = await store.initialize()
    const active = await store.getActiveProfile()

    expect(snapshot.activeProfileId).toBe(DEFAULT_PROFILE_ID)
    expect(snapshot.profiles).toEqual([
      expect.objectContaining({ id: DEFAULT_PROFILE_ID, name: 'Default' }),
    ])
    expect(await readFile(join(active.paths.dshHome, 'credential-marker'), 'utf8')).toBe('preserved')
    expect(await readFile(join(active.paths.workspace, 'project-marker'), 'utf8')).toBe('preserved')
  })

  it('resumes a legacy migration interrupted after moving the DSH home', async () => {
    const root = await useTemporaryDirectory('dsh-workbench-profile-')
    await mkdir(join(root, 'profiles', DEFAULT_PROFILE_ID, 'dsh'), { recursive: true })
    await mkdir(join(root, 'workspace'), { recursive: true })
    await writeFile(join(root, 'profiles', DEFAULT_PROFILE_ID, 'dsh', 'credential-marker'), 'preserved')
    await writeFile(join(root, 'workspace', 'project-marker'), 'preserved')

    const store = createStore(root)
    const active = await store.getActiveProfile()

    expect(await readFile(join(active.paths.dshHome, 'credential-marker'), 'utf8')).toBe('preserved')
    expect(await readFile(join(active.paths.workspace, 'project-marker'), 'utf8')).toBe('preserved')
  })

  it('creates, renames, selects, archives, and restores isolated profiles', async () => {
    const root = await useTemporaryDirectory('dsh-workbench-profile-')
    const store = createStore(root)
    await store.initialize()

    const created = await store.create('Research')
    expect(created.id).toBe('profile-one')
    const createdPaths = (await store.getProfile(created.id)).paths
    await writeFile(join(createdPaths.dshHome, 'credential-marker'), 'credential')
    await writeFile(join(createdPaths.workspace, 'workspace-marker'), 'workspace')
    await expect(store.create(' research ')).rejects.toMatchObject({ code: 'duplicate-name' })

    const renamed = await store.rename(created.id, 'Engineering')
    expect(renamed.name).toBe('Engineering')

    const selected = await store.setActive(created.id)
    expect(selected.profile.lastUsedAt).toBe(FIXED_NOW.toISOString())
    await expect(store.archive(created.id)).rejects.toMatchObject({ code: 'profile-active' })

    await store.setActive(DEFAULT_PROFILE_ID)
    const archived = await store.archive(created.id)
    expect(archived.archivedAt).toBe(FIXED_NOW.toISOString())
    const archivedPaths = (await store.getProfile(created.id)).paths
    expect(await readFile(join(archivedPaths.dshHome, 'credential-marker'), 'utf8')).toBe('credential')
    expect(await readFile(join(archivedPaths.workspace, 'workspace-marker'), 'utf8')).toBe('workspace')
    await expect(store.setActive(created.id)).rejects.toMatchObject({ code: 'profile-archived' })

    const restored = await store.restore(created.id)
    expect(restored.archivedAt).toBeUndefined()
    const restoredPaths = (await store.getProfile(created.id)).paths
    expect(await readFile(join(restoredPaths.dshHome, 'credential-marker'), 'utf8')).toBe('credential')
    expect(await readFile(join(restoredPaths.workspace, 'workspace-marker'), 'utf8')).toBe('workspace')
    expect((await store.setActive(created.id)).profile.id).toBe(created.id)
  })

  it('recovers a corrupt primary registry from the last valid backup', async () => {
    const root = await useTemporaryDirectory('dsh-workbench-profile-')
    const store = createStore(root)
    await store.initialize()
    await store.create('Research')
    await store.rename(DEFAULT_PROFILE_ID, 'Personal')

    const registry = join(root, 'workbench', 'profiles.json')
    await writeFile(registry, '{ broken json', 'utf8')

    const recovered = await createStore(root).initialize()
    expect(recovered.profiles.map((profile) => profile.name)).toEqual(['Default', 'Research'])
    expect(JSON.parse(await readFile(registry, 'utf8'))).toMatchObject({ schemaVersion: 1 })
  })

  it('keeps archive and restore backups consistent with the directory location', async () => {
    const root = await useTemporaryDirectory('dsh-workbench-profile-')
    const store = createStore(root)
    await store.initialize()
    const created = await store.create('Research')
    await store.archive(created.id)

    const registry = join(root, 'workbench', 'profiles.json')
    await writeFile(registry, '{ broken after archive', 'utf8')
    const recoveredArchive = await createStore(root).initialize()
    expect(recoveredArchive.profiles.find((profile) => profile.id === created.id)?.archivedAt).toBeDefined()

    const recoveredStore = createStore(root)
    await recoveredStore.restore(created.id)
    await writeFile(registry, '{ broken after restore', 'utf8')
    const recoveredRestore = await createStore(root).initialize()
    expect(recoveredRestore.profiles.find((profile) => profile.id === created.id)?.archivedAt).toBeUndefined()
  })

  it('fails closed on a future primary schema instead of downgrading to a backup', async () => {
    const root = await useTemporaryDirectory('dsh-workbench-profile-')
    const store = createStore(root)
    await store.initialize()
    await store.create('Research')
    await writeFile(join(root, 'workbench', 'profiles.json'), JSON.stringify({
      activeProfileId: DEFAULT_PROFILE_ID,
      profiles: [],
      schemaVersion: 99,
    }), 'utf8')

    await expect(createStore(root).initialize()).rejects.toMatchObject({ code: 'corrupt-registry' })
  })

  it('fails closed when both the registry and backup are corrupt', async () => {
    const root = await useTemporaryDirectory('dsh-workbench-profile-')
    const store = createStore(root)
    await store.initialize()
    await store.create('Research')

    await writeFile(join(root, 'workbench', 'profiles.json'), '{ broken', 'utf8')
    await writeFile(join(root, 'workbench', 'profiles.json.bak'), '{ also broken', 'utf8')

    await expect(createStore(root).initialize()).rejects.toBeInstanceOf(ProfileStoreError)
    await expect(createStore(root).initialize()).rejects.toMatchObject({ code: 'corrupt-registry' })
  })

  it('fails closed when a registry file is replaced by a symbolic link', async () => {
    const root = await useTemporaryDirectory('dsh-workbench-profile-')
    const outside = await useTemporaryDirectory('dsh-workbench-profile-outside-')
    const store = createStore(root)
    await store.initialize()
    const registry = join(root, 'workbench', 'profiles.json')
    const externalRegistry = join(outside, 'profiles.json')
    await writeFile(externalRegistry, await readFile(registry))
    await rename(registry, `${registry}.real`)
    await symlink(externalRegistry, registry)

    await expect(createStore(root).initialize()).rejects.toMatchObject({ code: 'unsafe-path' })
  })

  it('refuses profile roots that are replaced by symlinks', async () => {
    const root = await useTemporaryDirectory('dsh-workbench-profile-')
    const outside = await useTemporaryDirectory('dsh-workbench-profile-outside-')
    const store = createStore(root)
    await store.initialize()

    await rename(join(root, 'profiles'), join(root, 'profiles-real'))
    await symlink(outside, join(root, 'profiles'), 'dir')

    await expect(store.list()).rejects.toMatchObject({ code: 'unsafe-path' })
  })

  it('refuses an archived profile root redirected outside userData', async () => {
    const root = await useTemporaryDirectory('dsh-workbench-profile-')
    const outside = await useTemporaryDirectory('dsh-workbench-profile-outside-')
    const store = createStore(root)
    await store.initialize()
    const created = await store.create('Research')
    await store.archive(created.id)

    await rename(join(root, 'profile-archives'), join(outside, 'profile-archives'))
    await symlink(join(outside, 'profile-archives'), join(root, 'profile-archives'), 'dir')

    await expect(createStore(root).initialize()).rejects.toMatchObject({ code: 'unsafe-path' })
  })

  it('requires visible bounded names and preserves private filesystem modes', async () => {
    const root = await useTemporaryDirectory('dsh-workbench-profile-')
    const store = createStore(root)
    await store.initialize()

    await expect(store.create('   ')).rejects.toMatchObject({ code: 'invalid-name' })
    await expect(store.create('bad\nname')).rejects.toMatchObject({ code: 'invalid-name' })
    await expect(store.create('x'.repeat(81))).rejects.toMatchObject({ code: 'invalid-name' })

    await chmod(join(root, 'workbench'), 0o777)
    await store.list()
    const mode = (await stat(join(root, 'workbench'))).mode & 0o777
    expect(mode).toBe(0o700)
  })
})
