import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
export const DESKTOP_CORE_SPECIFIER = '@dsh-workbench/desktop-core'
export const OAUTH_UI_SPECIFIER = '@dsh-workbench/oauth-ui'
export const DIAGNOSTICS_UI_SPECIFIER = '@dsh-workbench/diagnostics-ui'
export const TASK_PLATFORM_SPECIFIER = '@dsh-workbench/task-platform'
export const DSH_AUTHORIZATION_SPECIFIER = '@deepseek-ai/dsh-authorization'

export interface DesktopCoreContribution {
  diagnosticsEntry: string
  entry: string
  taskPlatformEntry: string
  oauthEntry: string
  patch: string
}

export function renderDesktopCorePatch(
  entry: string,
  oauthEntry: string = OAUTH_UI_SPECIFIER,
  taskPlatformEntry: string = TASK_PLATFORM_SPECIFIER,
  diagnosticsEntry: string = DIAGNOSTICS_UI_SPECIFIER,
): string {
  return `${JSON.stringify([
    {
      insert: [
        {
          id: 'dsh-workbench-authorization',
          name: DSH_AUTHORIZATION_SPECIFIER,
        },
        {
          id: 'dsh-workbench-desktop-core',
          name: entry,
        },
        {
          id: 'dsh-workbench-oauth-ui',
          name: oauthEntry,
        },
        {
          id: 'dsh-workbench-task-platform',
          name: taskPlatformEntry,
        },
        {
          id: 'dsh-workbench-diagnostics-ui',
          name: diagnosticsEntry,
        },
      ],
    },
  ], undefined, 2)}\n`
}

async function ensureRealContributionDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }

  const stats = await lstat(path)
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`Workbench contribution directory must be a real directory: ${path}`)
  }
}

export async function prepareDesktopCoreContribution(
  userDataPath: string,
): Promise<DesktopCoreContribution> {
  const entry = require.resolve('@dsh-workbench/desktop-core')
  const oauthEntry = require.resolve('@dsh-workbench/oauth-ui')
  const diagnosticsEntry = require.resolve('@dsh-workbench/diagnostics-ui')
  const taskPlatformEntry = require.resolve('@dsh-workbench/task-platform')
  const contributionPath = join(userDataPath, 'workbench')
  const patch = join(contributionPath, 'desktop-core.patch.json')
  const temporaryPatch = `${patch}.tmp-${process.pid}-${randomUUID()}`

  await ensureRealContributionDirectory(contributionPath)
  try {
    await writeFile(temporaryPatch, renderDesktopCorePatch(
      DESKTOP_CORE_SPECIFIER,
      OAUTH_UI_SPECIFIER,
      TASK_PLATFORM_SPECIFIER,
      DIAGNOSTICS_UI_SPECIFIER,
    ), {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    })
    await chmod(temporaryPatch, 0o600)
    // Re-check the fixed parent immediately before the atomic replacement so
    // an already-unsafe overlay is never followed into another directory.
    await ensureRealContributionDirectory(contributionPath)
    await rename(temporaryPatch, patch)
  } finally {
    await rm(temporaryPatch, { force: true }).catch(() => {})
  }

  return { diagnosticsEntry, entry, taskPlatformEntry, oauthEntry, patch }
}
