import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

function profileChannels(source: string): string[] {
  return [...source.matchAll(/['"](dsh-workbench:profiles:[a-z-]+)['"]/gu)]
    .map((match) => match[1] ?? '')
    .sort()
}

function runtimeDiagnosticsChannels(source: string): string[] {
  return [...source.matchAll(/['"](dsh-workbench:runtime-diagnostics:[a-z-]+)['"]/gu)]
    .map((match) => match[1] ?? '')
    .sort()
}

describe('sandboxed preload bundle', () => {
  it('stays self-contained and mirrors every main-process profile channel', async () => {
    const [preload, mainChannels, runtimeChannels] = await Promise.all([
      readFile(new URL('./preload.cts', import.meta.url), 'utf8'),
      readFile(new URL('./profile-ipc.cts', import.meta.url), 'utf8'),
      readFile(new URL('./runtime-ipc.cts', import.meta.url), 'utf8'),
    ])

    expect(preload).not.toMatch(/from ['"]\.\//u)
    expect(profileChannels(preload)).toEqual(profileChannels(mainChannels))
    expect(profileChannels(preload)).toHaveLength(7)
    expect(runtimeDiagnosticsChannels(preload)).toEqual(runtimeDiagnosticsChannels(runtimeChannels))
    expect(runtimeDiagnosticsChannels(preload)).toHaveLength(3)
    expect(preload).not.toMatch(/openPath|exec\(|ipcRenderer\.send\(/u)
  })
})
