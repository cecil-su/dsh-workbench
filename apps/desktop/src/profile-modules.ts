import {
  lstatSync,
  mkdirSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join } from 'node:path'

const require = createRequire(import.meta.url)
const FIRST_PARTY_PROFILE_PACKAGES = [
  '@dsh-workbench/desktop-core',
  '@dsh-workbench/oauth-ui',
] as const

function pathKind(path: string): 'directory' | 'missing' | 'other' | 'symlink' {
  try {
    const stats = lstatSync(path)
    if (stats.isSymbolicLink()) return 'symlink'
    if (stats.isDirectory()) return 'directory'
    return 'other'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    throw error
  }
}

function ensureRealDirectory(path: string): void {
  const kind = pathKind(path)
  if (kind === 'missing') mkdirSync(path, { mode: 0o700 })
  if (pathKind(path) !== 'directory') {
    throw new Error(`Workbench profile module directory must be a real directory: ${path}`)
  }
}

function ensurePackageLink(link: string, target: string): void {
  const kind = pathKind(link)
  if (kind === 'directory' || kind === 'other') {
    throw new Error(`Workbench cannot replace the non-link profile module at ${link}`)
  }
  if (kind === 'symlink') {
    try {
      if (realpathSync(link) === realpathSync(target)) return
    } catch {
      // A dangling link is replaced below.
    }
    unlinkSync(link)
  }
  symlinkSync(target, link, 'junction')
  if (realpathSync(link) !== realpathSync(target)) {
    throw new Error(`Workbench profile module link did not resolve to ${target}`)
  }
}

/** Make first-party Workbench packages resolvable as bare DSH plugin entries. */
export function prepareProfileModuleFallback(dshHome: string): void {
  if (!isAbsolute(dshHome)) throw new TypeError('DSH home must be absolute')
  if (pathKind(dshHome) === 'missing') mkdirSync(dshHome, { mode: 0o700, recursive: true })
  ensureRealDirectory(dshHome)
  const profilesRoot = join(dshHome, 'profiles')
  ensureRealDirectory(profilesRoot)
  const modulesRoot = join(profilesRoot, 'node_modules')
  ensureRealDirectory(modulesRoot)

  for (const packageName of FIRST_PARTY_PROFILE_PACKAGES) {
    const manifest = require.resolve(`${packageName}/package.json`)
    const target = dirname(manifest)
    const link = join(modulesRoot, packageName)
    const scope = dirname(link)
    ensureRealDirectory(scope)
    ensurePackageLink(link, target)
  }
}
