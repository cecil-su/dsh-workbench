import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'

export const PROFILE_REGISTRY_SCHEMA_VERSION = 1
export const DEFAULT_PROFILE_ID = 'default'
export const DEFAULT_PROFILE_NAME = 'Default'

const PROFILE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u
const MAX_PROFILE_NAME_LENGTH = 80

export type ProfileStoreErrorCode =
  | 'archive-conflict'
  | 'corrupt-registry'
  | 'duplicate-name'
  | 'invalid-name'
  | 'missing-profile-data'
  | 'profile-active'
  | 'profile-archived'
  | 'profile-not-archived'
  | 'profile-not-found'
  | 'unsafe-path'

export class ProfileStoreError extends Error {
  readonly code: ProfileStoreErrorCode

  constructor(code: ProfileStoreErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ProfileStoreError'
    this.code = code
  }
}

export interface WorkbenchProfile {
  readonly archivedAt?: string
  readonly createdAt: string
  readonly id: string
  readonly lastUsedAt?: string
  readonly name: string
  readonly updatedAt: string
}

export interface ProfileRegistrySnapshot {
  readonly activeProfileId: string
  readonly profiles: readonly WorkbenchProfile[]
  readonly schemaVersion: typeof PROFILE_REGISTRY_SCHEMA_VERSION
}

export interface ProfilePaths {
  readonly dshHome: string
  readonly root: string
  readonly workspace: string
}

export interface ActiveProfile {
  readonly paths: ProfilePaths
  readonly profile: WorkbenchProfile
}

interface ProfileStoreOptions {
  createId?: () => string
  now?: () => Date
}

interface ReadRegistryResult {
  error?: Error
  snapshot?: ProfileRegistrySnapshot
  status: 'invalid' | 'missing' | 'valid'
  unsupportedSchema?: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function cloneSnapshot(snapshot: ProfileRegistrySnapshot): ProfileRegistrySnapshot {
  return structuredClone(snapshot)
}

function isPathInside(parent: string, child: string): boolean {
  const pathFromParent = relative(parent, child)
  return pathFromParent === '' || (
    pathFromParent !== '..'
    && !pathFromParent.startsWith(`..${sep}`)
    && !isAbsolute(pathFromParent)
  )
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
}

function normalizeProfileName(value: string): string {
  const name = value.trim()
  if (
    name.length === 0
    || name.length > MAX_PROFILE_NAME_LENGTH
    || /[\u0000-\u001f\u007f]/u.test(name)
  ) {
    throw new ProfileStoreError(
      'invalid-name',
      `Profile name must contain 1-${MAX_PROFILE_NAME_LENGTH} visible characters`,
    )
  }
  return name
}

function validateProfile(value: unknown): WorkbenchProfile {
  if (!isRecord(value)) {
    throw new Error('profile entry must be an object')
  }
  if (typeof value.id !== 'string' || !PROFILE_ID_PATTERN.test(value.id)) {
    throw new Error('profile id is invalid')
  }
  const name = normalizeProfileName(typeof value.name === 'string' ? value.name : '')
  if (!isCanonicalTimestamp(value.createdAt) || !isCanonicalTimestamp(value.updatedAt)) {
    throw new Error(`profile ${value.id} has invalid timestamps`)
  }
  if (value.lastUsedAt !== undefined && !isCanonicalTimestamp(value.lastUsedAt)) {
    throw new Error(`profile ${value.id} has an invalid lastUsedAt timestamp`)
  }
  if (value.archivedAt !== undefined && !isCanonicalTimestamp(value.archivedAt)) {
    throw new Error(`profile ${value.id} has an invalid archivedAt timestamp`)
  }

  return {
    id: value.id,
    name,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(value.lastUsedAt === undefined ? {} : { lastUsedAt: value.lastUsedAt }),
    ...(value.archivedAt === undefined ? {} : { archivedAt: value.archivedAt }),
  }
}

function validateSnapshot(value: unknown): ProfileRegistrySnapshot {
  if (!isRecord(value) || value.schemaVersion !== PROFILE_REGISTRY_SCHEMA_VERSION) {
    throw new Error(`profile registry schema must be ${PROFILE_REGISTRY_SCHEMA_VERSION}`)
  }
  if (typeof value.activeProfileId !== 'string' || !Array.isArray(value.profiles)) {
    throw new Error('profile registry shape is invalid')
  }

  const profiles = value.profiles.map(validateProfile)
  if (profiles.length === 0) throw new Error('profile registry must contain at least one profile')

  const ids = new Set<string>()
  const names = new Set<string>()
  for (const profile of profiles) {
    if (ids.has(profile.id)) throw new Error(`duplicate profile id ${profile.id}`)
    ids.add(profile.id)
    const foldedName = profile.name.toLocaleLowerCase()
    if (names.has(foldedName)) throw new Error(`duplicate profile name ${profile.name}`)
    names.add(foldedName)
  }

  const active = profiles.find((profile) => profile.id === value.activeProfileId)
  if (!active) throw new Error(`active profile ${value.activeProfileId} does not exist`)
  if (active.archivedAt !== undefined) throw new Error('active profile cannot be archived')

  return {
    activeProfileId: value.activeProfileId,
    profiles,
    schemaVersion: PROFILE_REGISTRY_SCHEMA_VERSION,
  }
}

async function pathStatus(path: string): Promise<'directory' | 'missing' | 'other' | 'symlink'> {
  try {
    const stats = await lstat(path)
    if (stats.isSymbolicLink()) return 'symlink'
    if (stats.isDirectory()) return 'directory'
    return 'other'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    throw error
  }
}

async function readRegistryFile(path: string): Promise<ReadRegistryResult> {
  try {
    const status = await pathStatus(path)
    if (status === 'missing') return { status: 'missing' }
    if (status !== 'other') {
      throw new ProfileStoreError('unsafe-path', `Profile registry must be a regular file: ${path}`)
    }
    const value: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (isRecord(value) && 'schemaVersion' in value && value.schemaVersion !== PROFILE_REGISTRY_SCHEMA_VERSION) {
      return {
        error: new Error(`unsupported profile registry schema ${String(value.schemaVersion)}`),
        status: 'invalid',
        unsupportedSchema: true,
      }
    }
    return { snapshot: validateSnapshot(value), status: 'valid' }
  } catch (error) {
    return {
      error: error instanceof Error ? error : new Error(String(error)),
      status: 'invalid',
    }
  }
}

async function syncFile(path: string): Promise<void> {
  // FlushFileBuffers requires a writable handle on Windows. These files are
  // private temporary snapshots owned by the store, so opening them for
  // update preserves the durability barrier on every supported platform.
  const handle = await open(path, 'r+')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export class ProfileStore {
  readonly #archiveRoot: string
  readonly #backupPath: string
  readonly #createId: () => string
  readonly #legacyDshHome: string
  readonly #legacyWorkspace: string
  readonly #now: () => Date
  readonly #profileRoot: string
  readonly #registryPath: string
  readonly #workbenchRoot: string
  readonly #userDataPath: string
  #queue: Promise<void> = Promise.resolve()

  constructor(userDataPath: string, options: ProfileStoreOptions = {}) {
    if (!isAbsolute(userDataPath)) throw new TypeError('ProfileStore userDataPath must be absolute')
    this.#userDataPath = userDataPath
    this.#workbenchRoot = join(userDataPath, 'workbench')
    this.#profileRoot = join(userDataPath, 'profiles')
    this.#archiveRoot = join(userDataPath, 'profile-archives')
    this.#registryPath = join(this.#workbenchRoot, 'profiles.json')
    this.#backupPath = join(this.#workbenchRoot, 'profiles.json.bak')
    this.#legacyDshHome = join(userDataPath, 'dsh')
    this.#legacyWorkspace = join(userDataPath, 'workspace')
    this.#createId = options.createId ?? randomUUID
    this.#now = options.now ?? (() => new Date())
  }

  initialize(): Promise<ProfileRegistrySnapshot> {
    return this.#enqueue(async () => cloneSnapshot(await this.#loadOrInitialize()))
  }

  list(): Promise<ProfileRegistrySnapshot> {
    return this.#enqueue(async () => cloneSnapshot(await this.#loadOrInitialize()))
  }

  getActiveProfile(): Promise<ActiveProfile> {
    return this.#enqueue(async () => {
      const snapshot = await this.#loadOrInitialize()
      const profile = snapshot.profiles.find((entry) => entry.id === snapshot.activeProfileId)
      if (!profile) throw new ProfileStoreError('profile-not-found', 'Active profile is missing')
      return {
        paths: this.#paths(profile.id, false),
        profile: structuredClone(profile),
      }
    })
  }

  getProfile(profileId: string): Promise<ActiveProfile> {
    return this.#enqueue(async () => {
      const snapshot = await this.#loadOrInitialize()
      const profile = this.#findProfile(snapshot, profileId)
      await this.#assertProfileData(profile)
      return {
        paths: this.#paths(profile.id, profile.archivedAt !== undefined),
        profile: structuredClone(profile),
      }
    })
  }

  create(nameValue: string): Promise<WorkbenchProfile> {
    return this.#enqueue(async () => {
      const snapshot = await this.#loadOrInitialize()
      const name = normalizeProfileName(nameValue)
      this.#assertUniqueName(snapshot, name)

      let id = ''
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const candidate = this.#createId().toLocaleLowerCase()
        if (PROFILE_ID_PATTERN.test(candidate) && !snapshot.profiles.some((item) => item.id === candidate)) {
          id = candidate
          break
        }
      }
      if (id === '') throw new Error('Could not allocate a unique profile id')

      const paths = this.#paths(id, false)
      if (await pathStatus(paths.root) !== 'missing') {
        throw new ProfileStoreError('unsafe-path', `Profile directory already exists for ${id}`)
      }
      await this.#createProfileDirectories(paths)

      const timestamp = this.#timestamp()
      const profile: WorkbenchProfile = {
        createdAt: timestamp,
        id,
        name,
        updatedAt: timestamp,
      }
      const next: ProfileRegistrySnapshot = {
        ...snapshot,
        profiles: [...snapshot.profiles, profile],
      }
      try {
        await this.#writeSnapshot(next)
      } catch (error) {
        await rm(paths.root, { force: true, recursive: true }).catch(() => {})
        await syncDirectory(this.#profileRoot).catch(() => {})
        throw error
      }
      return structuredClone(profile)
    })
  }

  rename(profileId: string, nameValue: string): Promise<WorkbenchProfile> {
    return this.#enqueue(async () => {
      const snapshot = await this.#loadOrInitialize()
      const current = this.#findProfile(snapshot, profileId)
      const name = normalizeProfileName(nameValue)
      this.#assertUniqueName(snapshot, name, profileId)
      const updated: WorkbenchProfile = { ...current, name, updatedAt: this.#timestamp() }
      await this.#writeSnapshot({
        ...snapshot,
        profiles: snapshot.profiles.map((profile) => profile.id === profileId ? updated : profile),
      })
      return structuredClone(updated)
    })
  }

  setActive(profileId: string): Promise<ActiveProfile> {
    return this.#enqueue(async () => {
      const snapshot = await this.#loadOrInitialize()
      const current = this.#findProfile(snapshot, profileId)
      if (current.archivedAt !== undefined) {
        throw new ProfileStoreError('profile-archived', `Profile ${profileId} is archived`)
      }
      await this.#assertProfileData(current)

      const timestamp = this.#timestamp()
      const updated: WorkbenchProfile = {
        ...current,
        lastUsedAt: timestamp,
        updatedAt: timestamp,
      }
      await this.#writeSnapshot({
        activeProfileId: profileId,
        profiles: snapshot.profiles.map((profile) => profile.id === profileId ? updated : profile),
        schemaVersion: PROFILE_REGISTRY_SCHEMA_VERSION,
      })
      return { paths: this.#paths(profileId, false), profile: structuredClone(updated) }
    })
  }

  archive(profileId: string): Promise<WorkbenchProfile> {
    return this.#enqueue(async () => {
      const snapshot = await this.#loadOrInitialize()
      if (snapshot.activeProfileId === profileId) {
        throw new ProfileStoreError('profile-active', 'Select another profile before archiving this one')
      }
      const current = this.#findProfile(snapshot, profileId)
      if (current.archivedAt !== undefined) {
        throw new ProfileStoreError('profile-archived', `Profile ${profileId} is already archived`)
      }
      await this.#assertProfileData(current)

      const from = this.#paths(profileId, false).root
      const to = this.#paths(profileId, true).root
      if (await pathStatus(to) !== 'missing') {
        throw new ProfileStoreError('archive-conflict', `Archive directory already exists for ${profileId}`)
      }
      await this.#ensureSafeRoot(this.#archiveRoot, true)

      const timestamp = this.#timestamp()
      const updated: WorkbenchProfile = {
        ...current,
        archivedAt: timestamp,
        updatedAt: timestamp,
      }
      const next: ProfileRegistrySnapshot = {
        ...snapshot,
        profiles: snapshot.profiles.map((profile) => profile.id === profileId ? updated : profile),
      }
      await this.#commitDirectoryTransition(snapshot, next, from, to)
      return structuredClone(updated)
    })
  }

  restore(profileId: string): Promise<WorkbenchProfile> {
    return this.#enqueue(async () => {
      const snapshot = await this.#loadOrInitialize()
      const current = this.#findProfile(snapshot, profileId)
      if (current.archivedAt === undefined) {
        throw new ProfileStoreError('profile-not-archived', `Profile ${profileId} is not archived`)
      }

      const from = this.#paths(profileId, true).root
      const to = this.#paths(profileId, false).root
      await this.#assertSafeDirectory(from, this.#archiveRoot, 'missing-profile-data')
      if (await pathStatus(to) !== 'missing') {
        throw new ProfileStoreError('archive-conflict', `Profile directory already exists for ${profileId}`)
      }
      await this.#ensureSafeRoot(this.#profileRoot, true)

      const { archivedAt: _archivedAt, ...rest } = current
      const updated: WorkbenchProfile = { ...rest, updatedAt: this.#timestamp() }
      const next: ProfileRegistrySnapshot = {
        ...snapshot,
        profiles: snapshot.profiles.map((profile) => profile.id === profileId ? updated : profile),
      }
      await this.#commitDirectoryTransition(snapshot, next, from, to)
      return structuredClone(updated)
    })
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation, operation)
    this.#queue = result.then(() => undefined, () => undefined)
    return result
  }

  #timestamp(): string {
    const value = this.#now()
    if (!Number.isFinite(value.getTime())) throw new Error('ProfileStore clock returned an invalid date')
    return value.toISOString()
  }

  #paths(profileId: string, archived: boolean): ProfilePaths {
    if (!PROFILE_ID_PATTERN.test(profileId)) {
      throw new ProfileStoreError('profile-not-found', `Invalid profile id ${JSON.stringify(profileId)}`)
    }
    const root = join(archived ? this.#archiveRoot : this.#profileRoot, profileId)
    return {
      dshHome: join(root, 'dsh'),
      root,
      workspace: join(root, 'workspace'),
    }
  }

  #findProfile(snapshot: ProfileRegistrySnapshot, profileId: string): WorkbenchProfile {
    const profile = snapshot.profiles.find((entry) => entry.id === profileId)
    if (!profile) throw new ProfileStoreError('profile-not-found', `Profile ${profileId} does not exist`)
    return profile
  }

  #assertUniqueName(
    snapshot: ProfileRegistrySnapshot,
    name: string,
    exceptProfileId?: string,
  ): void {
    const foldedName = name.toLocaleLowerCase()
    if (snapshot.profiles.some((profile) => (
      profile.id !== exceptProfileId && profile.name.toLocaleLowerCase() === foldedName
    ))) {
      throw new ProfileStoreError('duplicate-name', `A profile named ${JSON.stringify(name)} already exists`)
    }
  }

  async #loadOrInitialize(): Promise<ProfileRegistrySnapshot> {
    await this.#ensureSafeRoot(this.#userDataPath, true)
    await this.#ensureSafeRoot(this.#workbenchRoot, true)
    const primary = await readRegistryFile(this.#registryPath)
    if (primary.status === 'valid' && primary.snapshot) {
      try {
        await this.#assertSnapshotData(primary.snapshot)
        return primary.snapshot
      } catch (error) {
        primary.error = error instanceof Error ? error : new Error(String(error))
      }
    }

    if (primary.unsupportedSchema) {
      throw new ProfileStoreError(
        'corrupt-registry',
        'Profile registry uses an unsupported schema and cannot be downgraded safely',
        { cause: primary.error },
      )
    }

    const backup = await readRegistryFile(this.#backupPath)
    if (backup.status === 'valid' && backup.snapshot) {
      try {
        await this.#assertSnapshotData(backup.snapshot)
        await this.#writeSnapshot(backup.snapshot, false)
        return backup.snapshot
      } catch (error) {
        backup.error = error instanceof Error ? error : new Error(String(error))
      }
    }

    if (
      primary.status === 'invalid'
      || backup.status === 'invalid'
      || primary.error
      || backup.error
    ) {
      const unsafePathError = [primary.error, backup.error].find((error) => (
        error instanceof ProfileStoreError && error.code === 'unsafe-path'
      ))
      if (unsafePathError) throw unsafePathError
      throw new ProfileStoreError(
        'corrupt-registry',
        'Profile registry and its backup could not be read safely',
        { cause: primary.error ?? backup.error },
      )
    }

    await this.#migrateLegacyDefaultProfile()
    const timestamp = this.#timestamp()
    const snapshot: ProfileRegistrySnapshot = {
      activeProfileId: DEFAULT_PROFILE_ID,
      profiles: [{
        createdAt: timestamp,
        id: DEFAULT_PROFILE_ID,
        lastUsedAt: timestamp,
        name: DEFAULT_PROFILE_NAME,
        updatedAt: timestamp,
      }],
      schemaVersion: PROFILE_REGISTRY_SCHEMA_VERSION,
    }
    await this.#writeSnapshot(snapshot, false)
    return snapshot
  }

  async #migrateLegacyDefaultProfile(): Promise<void> {
    await this.#ensureSafeRoot(this.#profileRoot, true)
    const paths = this.#paths(DEFAULT_PROFILE_ID, false)
    await this.#ensureSafeRoot(paths.root, true)
    await this.#moveLegacyDirectory(this.#legacyDshHome, paths.dshHome)
    await this.#moveLegacyDirectory(this.#legacyWorkspace, paths.workspace)
    await this.#assertSafeDirectory(paths.dshHome, paths.root, 'missing-profile-data')
    await this.#assertSafeDirectory(paths.workspace, paths.root, 'missing-profile-data')
    await syncDirectory(paths.root)
  }

  async #moveLegacyDirectory(source: string, target: string): Promise<void> {
    const sourceStatus = await pathStatus(source)
    const targetStatus = await pathStatus(target)
    if (sourceStatus === 'symlink' || sourceStatus === 'other' || targetStatus === 'symlink' || targetStatus === 'other') {
      throw new ProfileStoreError('unsafe-path', `Profile migration encountered an unsafe path at ${source}`)
    }
    if (sourceStatus === 'directory' && targetStatus === 'directory') {
      throw new ProfileStoreError(
        'archive-conflict',
        `Profile migration found data at both ${source} and ${target}`,
      )
    }
    if (sourceStatus === 'directory') {
      await rename(source, target)
      await Promise.all([
        syncDirectory(dirname(source)),
        syncDirectory(dirname(target)),
      ])
    } else if (targetStatus === 'missing') {
      await mkdir(target, { mode: 0o700 })
      await syncDirectory(dirname(target))
    }
    await chmod(target, 0o700)
    await syncDirectory(target)
  }

  async #createProfileDirectories(paths: ProfilePaths): Promise<void> {
    await this.#ensureSafeRoot(this.#profileRoot, true)
    await mkdir(paths.root, { mode: 0o700 })
    await syncDirectory(this.#profileRoot)
    await mkdir(paths.dshHome, { mode: 0o700 })
    await mkdir(paths.workspace, { mode: 0o700 })
    await syncDirectory(paths.root)
    await this.#assertSafeDirectory(paths.root, this.#profileRoot, 'unsafe-path')
  }

  async #assertSnapshotData(snapshot: ProfileRegistrySnapshot): Promise<void> {
    await this.#ensureSafeRoot(this.#profileRoot, false)
    if (snapshot.profiles.some((profile) => profile.archivedAt !== undefined)) {
      await this.#ensureSafeRoot(this.#archiveRoot, false)
    }
    for (const profile of snapshot.profiles) await this.#assertProfileData(profile)
  }

  async #assertProfileData(profile: WorkbenchProfile): Promise<void> {
    const paths = this.#paths(profile.id, profile.archivedAt !== undefined)
    const parent = profile.archivedAt === undefined ? this.#profileRoot : this.#archiveRoot
    await this.#assertSafeDirectory(paths.root, parent, 'missing-profile-data')
    await this.#assertSafeDirectory(paths.dshHome, paths.root, 'missing-profile-data')
    await this.#assertSafeDirectory(paths.workspace, paths.root, 'missing-profile-data')
  }

  async #ensureSafeRoot(path: string, create: boolean): Promise<void> {
    let status = await pathStatus(path)
    if (create && status === 'missing') {
      await mkdir(path, {
        mode: 0o700,
        recursive: path === this.#userDataPath,
      })
      await syncDirectory(dirname(path))
      status = await pathStatus(path)
    }
    if (status !== 'directory') {
      throw new ProfileStoreError('unsafe-path', `Expected a real directory at ${path}`)
    }
    await chmod(path, 0o700)
    await syncDirectory(path)

    const canonicalUserData = await realpath(this.#userDataPath)
    const canonical = await realpath(path)
    if (!isPathInside(canonicalUserData, canonical)) {
      throw new ProfileStoreError('unsafe-path', `Profile path escapes Electron userData: ${path}`)
    }
  }

  async #assertSafeDirectory(
    path: string,
    expectedParent: string,
    errorCode: 'missing-profile-data' | 'unsafe-path',
  ): Promise<void> {
    const status = await pathStatus(path)
    if (status !== 'directory') {
      throw new ProfileStoreError(errorCode, `Expected profile directory at ${path}`)
    }
    const canonicalParent = await realpath(expectedParent)
    const canonical = await realpath(path)
    if (!isPathInside(canonicalParent, canonical)) {
      throw new ProfileStoreError('unsafe-path', `Profile path escapes its managed root: ${path}`)
    }
  }

  async #commitDirectoryTransition(
    previous: ProfileRegistrySnapshot,
    next: ProfileRegistrySnapshot,
    from: string,
    to: string,
  ): Promise<void> {
    await this.#publishSnapshot(this.#backupPath, next)
    try {
      await rename(from, to)
    } catch (error) {
      await this.#publishSnapshot(this.#backupPath, previous).catch(() => {})
      throw error
    }
    await Promise.all([
      syncDirectory(dirname(from)),
      syncDirectory(dirname(to)),
    ])

    // After the directory move, the new backup is already self-consistent. If
    // publishing the primary fails, the next load recovers it from that backup.
    await this.#writeSnapshot(next, false)
  }

  async #writeSnapshot(snapshotValue: ProfileRegistrySnapshot, backupCurrent = true): Promise<void> {
    const snapshot = validateSnapshot(snapshotValue)
    await this.#ensureSafeRoot(this.#workbenchRoot, true)
    const backupTemporary = `${this.#backupPath}.tmp-${process.pid}-${randomUUID()}`
    try {
      if (backupCurrent && await pathStatus(this.#registryPath) === 'other') {
        await copyFile(this.#registryPath, backupTemporary)
        await chmod(backupTemporary, 0o600)
        await syncFile(backupTemporary)
        await rename(backupTemporary, this.#backupPath)
        await syncDirectory(dirname(this.#backupPath))
      }
      await this.#publishSnapshot(this.#registryPath, snapshot)
    } finally {
      await rm(backupTemporary, { force: true }).catch(() => {})
    }
  }

  async #publishSnapshot(path: string, snapshotValue: ProfileRegistrySnapshot): Promise<void> {
    const snapshot = validateSnapshot(snapshotValue)
    const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
    try {
      await writeFile(temporary, `${JSON.stringify(snapshot, undefined, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      })
      await chmod(temporary, 0o600)
      await syncFile(temporary)
      await rename(temporary, path)
      await syncDirectory(dirname(path))
    } finally {
      await rm(temporary, { force: true }).catch(() => {})
    }
  }
}
