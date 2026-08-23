import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalValue(value[key])]),
    )
  }
  return value
}

/** Recursively sort object keys while preserving array order. */
export function canonicalizeCompatibility(value) {
  return JSON.stringify(canonicalValue(value))
}

/** Return the lowercase, prefix-free SHA-256 required by package provenance. */
export function compatibilitySha256(value) {
  return createHash('sha256').update(canonicalizeCompatibility(value), 'utf8').digest('hex')
}

export async function readCompatibility(root) {
  const rootPath = root instanceof URL ? fileURLToPath(root) : root
  const path = join(rootPath, 'upstream', 'compatibility.json')
  return JSON.parse(await readFile(path, 'utf8'))
}
