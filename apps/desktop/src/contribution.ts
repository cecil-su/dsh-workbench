import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)

export interface DesktopCoreContribution {
  entry: string
  patch: string
}

export function renderDesktopCorePatch(entry: string): string {
  return `${JSON.stringify([
    {
      insert: [
        {
          id: 'dsh-workbench-desktop-core',
          name: entry,
        },
      ],
    },
  ], undefined, 2)}\n`
}

export async function prepareDesktopCoreContribution(
  userDataPath: string,
): Promise<DesktopCoreContribution> {
  const entry = require.resolve('@dsh-workbench/desktop-core')
  const moduleSpecifier = pathToFileURL(entry).href
  const contributionPath = join(userDataPath, 'workbench')
  const patch = join(contributionPath, 'desktop-core.patch.json')

  await mkdir(contributionPath, { mode: 0o700, recursive: true })
  await writeFile(patch, renderDesktopCorePatch(moduleSpecifier), { encoding: 'utf8', mode: 0o600 })

  return { entry, patch }
}
