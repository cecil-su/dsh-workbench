import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { readCompatibility } from '../../../scripts/compatibility.mjs'

export const EXPECTED_DSH_VERSION_TOKEN = '__DSH_WORKBENCH_EXPECTED_DSH_VERSION__'
const EXACT_SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u

export function renderDiagnosticsClient(source, dshVersion) {
  const occurrences = source.split(EXPECTED_DSH_VERSION_TOKEN).length - 1
  if (occurrences !== 1) {
    throw new Error(`Diagnostics client must contain exactly one DSH version token; found ${occurrences}`)
  }
  if (typeof dshVersion !== 'string' || !EXACT_SEMVER.test(dshVersion)) {
    throw new Error('Compatibility metadata DSH package version must be an exact semver')
  }
  const quotedToken = JSON.stringify(EXPECTED_DSH_VERSION_TOKEN)
  if (!source.includes(quotedToken)) {
    throw new Error('Diagnostics client DSH version token must be a quoted JavaScript string')
  }
  return source.replace(quotedToken, JSON.stringify(dshVersion))
}

export async function buildDiagnosticsClient(packageRoot) {
  const root = resolve(packageRoot, '..', '..')
  const sourcePath = resolve(packageRoot, 'src', 'client.js')
  const outputPath = resolve(packageRoot, 'lib', 'client.js')
  const [source, compatibility] = await Promise.all([
    readFile(sourcePath, 'utf8'),
    readCompatibility(root),
  ])
  const output = renderDiagnosticsClient(source, compatibility?.dsh?.packageVersion)

  if (!output.includes('window.__ModuleLoader__.load({')) {
    throw new Error('diagnostics-ui client bundle must register with window.__ModuleLoader__')
  }
  if (!output.includes('id: "@dsh-workbench/diagnostics-ui"')) {
    throw new Error('diagnostics-ui client bundle id does not match its package name')
  }

  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, output, { encoding: 'utf8', mode: 0o644 })
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined
if (invokedPath === import.meta.url) await buildDiagnosticsClient(packageRoot)
