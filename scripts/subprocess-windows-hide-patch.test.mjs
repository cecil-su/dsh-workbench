import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dshManifest = require.resolve('@deepseek-ai/dsh/package.json', {
  paths: [join(root, 'packages', 'runtime')],
})
const subprocessManifest = require.resolve('@deepseek-ai/dsh-subprocess-local/package.json', {
  paths: [dirname(dshManifest)],
})
const subprocessRoot = dirname(subprocessManifest)
const implementationPath = join(subprocessRoot, 'lib', 'index.js')
const runtimeSourcePath = join(root, 'packages', 'runtime', 'src', 'index.ts')

describe('patched local subprocess Windows behavior', () => {
  it('hides direct subprocess console windows only on Windows', async () => {
    const manifest = JSON.parse(await readFile(subprocessManifest, 'utf8'))
    const implementation = await readFile(implementationPath, 'utf8')

    assert.equal(manifest.version, '0.1.1-rc.2')
    assert.match(
      implementation,
      /const child = spawn\(program, args, \{[\s\S]*?windowsHide: platform === "win32",[\s\S]*?detached: platform !== "win32"/u,
    )
  })

  it('hides Workbench-owned Windows console processes', async () => {
    const runtimeSource = await readFile(runtimeSourcePath, 'utf8')

    assert.match(
      runtimeSource,
      /execFileSync\('powershell\.exe', \[[\s\S]*?\], \{\s*encoding: 'utf8',\s*stdio: \['ignore', 'pipe', 'ignore'\],\s*windowsHide: true,/u,
    )
    assert.equal(
      [...runtimeSource.matchAll(/spawnSync\('taskkill\.exe',[\s\S]*?\{\s*stdio: 'ignore',\s*windowsHide: true,\s*\}\)/gu)].length,
      2,
    )
    assert.match(
      runtimeSource,
      /stdio: \['ignore', 'pipe', 'pipe', 'ipc'\],\s*windowsHide: process\.platform === 'win32',/u,
    )
  })
})
