import { copyFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const source = fileURLToPath(new URL('../src/client.js', import.meta.url))
const target = fileURLToPath(new URL('../lib/client.js', import.meta.url))

await mkdir(dirname(target), { recursive: true })
await copyFile(source, target)
