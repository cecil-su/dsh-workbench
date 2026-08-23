import { randomUUID } from 'node:crypto'
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
export const DESKTOP_CORE_SPECIFIER = '@dsh-workbench/desktop-core'
export const OAUTH_UI_SPECIFIER = '@dsh-workbench/oauth-ui'
export const DSH_AUTHORIZATION_SPECIFIER = '@deepseek-ai/dsh-authorization'

export interface DesktopCoreContribution {
  entry: string
  oauthEntry: string
  patch: string
}

export function renderDesktopCorePatch(
  entry: string,
  oauthEntry: string = OAUTH_UI_SPECIFIER,
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
      ],
    },
  ], undefined, 2)}\n`
}

export async function prepareDesktopCoreContribution(
  userDataPath: string,
): Promise<DesktopCoreContribution> {
  const entry = require.resolve('@dsh-workbench/desktop-core')
  const oauthEntry = require.resolve('@dsh-workbench/oauth-ui')
  const contributionPath = join(userDataPath, 'workbench')
  const patch = join(contributionPath, 'desktop-core.patch.json')
  const temporaryPatch = `${patch}.tmp-${process.pid}-${randomUUID()}`

  await mkdir(contributionPath, { mode: 0o700, recursive: true })
  try {
    await writeFile(temporaryPatch, renderDesktopCorePatch(
      DESKTOP_CORE_SPECIFIER,
      OAUTH_UI_SPECIFIER,
    ), {
      encoding: 'utf8',
      mode: 0o600,
    })
    await chmod(temporaryPatch, 0o600)
    await rename(temporaryPatch, patch)
  } finally {
    await rm(temporaryPatch, { force: true }).catch(() => {})
  }

  return { entry, oauthEntry, patch }
}
