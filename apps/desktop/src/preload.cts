import { contextBridge, ipcRenderer } from 'electron'

// Sandboxed Electron preloads may only require a limited builtin set, so this
// file must remain a single self-contained bundle. The matching main-process
// channel constants live in profile-ipc.cts and are contract-tested at build.
const profileIpc = Object.freeze({
  archive: 'dsh-workbench:profiles:archive',
  context: 'dsh-workbench:profiles:context',
  create: 'dsh-workbench:profiles:create',
  list: 'dsh-workbench:profiles:list',
  rename: 'dsh-workbench:profiles:rename',
  restore: 'dsh-workbench:profiles:restore',
  select: 'dsh-workbench:profiles:select',
})

interface ProfileContext {
  generation: number
  profileId: string
}

let profileContext: ProfileContext | undefined
let resolveProfileContext: ((context: ProfileContext) => void) | undefined
const profileContextReady = new Promise<ProfileContext>((resolve) => {
  resolveProfileContext = resolve
})

function isProfileContext(value: unknown): value is ProfileContext {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  return Object.keys(candidate).length === 2
    && Number.isSafeInteger(candidate.generation)
    && (candidate.generation as number) > 0
    && typeof candidate.profileId === 'string'
    && /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(candidate.profileId)
}

async function waitForProfileContext(): Promise<ProfileContext> {
  if (profileContext) return profileContext
  return new Promise<ProfileContext>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Workbench profile context did not become ready'))
    }, 5_000)
    void profileContextReady.then((context) => {
      clearTimeout(timeout)
      resolve(context)
    })
  })
}

async function invoke(channel: string, payload: Record<string, unknown> = {}): Promise<unknown> {
  const context = await waitForProfileContext()
  return ipcRenderer.invoke(channel, { ...payload, context })
}

ipcRenderer.on(profileIpc.context, (_event, value: unknown) => {
  if (!profileContext && isProfileContext(value)) {
    profileContext = Object.freeze({ ...value })
    resolveProfileContext?.(profileContext)
    resolveProfileContext = undefined
  }
})

contextBridge.exposeInMainWorld('dshWorkbench', {
  platform: process.platform,
  profiles: Object.freeze({
    archive: (profileId: string) => invoke(profileIpc.archive, { profileId }),
    create: (name: string) => invoke(profileIpc.create, { name }),
    list: () => invoke(profileIpc.list),
    rename: (profileId: string, name: string) => invoke(profileIpc.rename, { name, profileId }),
    restore: (profileId: string) => invoke(profileIpc.restore, { profileId }),
    select: (profileId: string) => invoke(profileIpc.select, { profileId }),
  }),
  security: Object.freeze({
    contextIsolated: process.contextIsolated,
    sandboxed: process.sandboxed,
  }),
  versions: Object.freeze({
    chrome: process.versions.chrome,
    electron: process.versions.electron,
    node: process.versions.node,
  }),
})
