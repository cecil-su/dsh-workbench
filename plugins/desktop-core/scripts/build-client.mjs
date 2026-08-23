import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourcePath = resolve(packageRoot, 'src', 'client.js')
const outputPath = resolve(packageRoot, 'lib', 'client.js')
const source = await readFile(sourcePath, 'utf8')

if (!source.includes('window.__ModuleLoader__.load({')) {
  throw new Error('desktop-core client bundle must register with window.__ModuleLoader__')
}
if (!source.includes('id: "@dsh-workbench/desktop-core"')) {
  throw new Error('desktop-core client bundle id does not match its package name')
}

await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, source, { encoding: 'utf8', mode: 0o644 })
