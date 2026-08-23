import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach } from 'vitest'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.allSettled(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    force: true,
    maxRetries: 3,
    recursive: true,
    retryDelay: 100,
  })))
})

export async function useTemporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}
