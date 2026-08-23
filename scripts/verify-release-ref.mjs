import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

if (process.env.GITHUB_REF_TYPE === 'tag') {
  const desktopPackage = JSON.parse(
    await readFile(join(root, 'apps', 'desktop', 'package.json'), 'utf8'),
  )
  const expectedTag = `v${desktopPackage.version}`
  if (process.env.GITHUB_REF_NAME !== expectedTag) {
    throw new Error(
      `Release tag ${process.env.GITHUB_REF_NAME ?? '(missing)'} does not match ${expectedTag}`,
    )
  }
  console.log(`Release tag matches desktop version: ${expectedTag}`)
} else {
  console.log('Manual unsigned artifact build: release tag validation is not applicable')
}
