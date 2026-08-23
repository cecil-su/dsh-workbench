import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, posix, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  compatibilitySha256,
  readCompatibility,
} from './compatibility.mjs'

const rootFromScript = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DSH_PACKAGE_PREFIX = '@deepseek-ai/dsh'
const DIRECTORY_PICKER_PATCH_PACKAGE = '@deepseek-ai/dsh-host-directory-picker-native'
const DIRECTORY_PICKER_PATCH_PATH = 'patches/@deepseek-ai__dsh-host-directory-picker-native@0.1.1-rc.2.patch'
const SUBPROCESS_PATCH_PACKAGE = '@deepseek-ai/dsh-subprocess-local'
const SUBPROCESS_PATCH_PATH = 'patches/@deepseek-ai__dsh-subprocess-local@0.1.1-rc.2.patch'
const EXACT_SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u
const EXPECTED_FIRST_PARTY_PLUGINS = Object.freeze([
  Object.freeze({
    entryId: 'dsh-workbench-desktop-core',
    packageName: '@dsh-workbench/desktop-core',
  }),
  Object.freeze({
    entryId: 'dsh-workbench-oauth-ui',
    packageName: '@dsh-workbench/oauth-ui',
  }),
  Object.freeze({
    entryId: 'dsh-workbench-diagnostics-ui',
    packageName: '@dsh-workbench/diagnostics-ui',
  }),
  Object.freeze({
    entryId: 'dsh-workbench-gpt-tools',
    packageName: '@dsh-workbench/gpt-tools',
  }),
])
const DEPENDENCY_GROUPS = Object.freeze([
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
])

export class CompatibilityVerificationError extends Error {
  constructor(issues) {
    super(`Compatibility verification failed:\n- ${issues.join('\n- ')}`)
    this.name = 'CompatibilityVerificationError'
    this.issues = Object.freeze([...issues])
  }
}

function record(issues, condition, message) {
  if (!condition) issues.push(message)
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isDshPackage(packageName) {
  return packageName === DSH_PACKAGE_PREFIX || packageName.startsWith(`${DSH_PACKAGE_PREFIX}-`)
}

function withoutYamlComment(value) {
  let quote = ''
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if (quote) {
      if (character === quote && value[index - 1] !== '\\') quote = ''
    } else if (character === '"' || character === "'") {
      quote = character
    } else if (character === '#' && (index === 0 || /\s/u.test(value[index - 1]))) {
      return value.slice(0, index).trimEnd()
    }
  }
  return value.trimEnd()
}

function splitYamlMapping(value) {
  let quote = ''
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if (quote) {
      if (character === quote && value[index - 1] !== '\\') quote = ''
    } else if (character === '"' || character === "'") {
      quote = character
    } else if (character === ':') {
      return [value.slice(0, index).trim(), value.slice(index + 1).trim()]
    }
  }
  throw new Error(`Unsupported YAML mapping line: ${value}`)
}

function parseYamlScalar(value) {
  if ((value.startsWith("'") && value.endsWith("'"))
    || (value.startsWith('"') && value.endsWith('"'))) {
    if (value.startsWith("'")) return value.slice(1, -1).replaceAll("''", "'")
    return JSON.parse(value)
  }
  if (value === 'true') return true
  if (value === 'false') return false
  if (value === 'null' || value === '~') return null
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) return Number(value)
  return value
}

function parseYamlKey(value) {
  return parseYamlScalar(value)
}

/** Parse the mapping/list subset emitted by pnpm for workspace and lock files. */
export function parsePnpmYaml(source) {
  const lines = source
    .replaceAll('\r\n', '\n')
    .split('\n')
    .map((raw, sourceIndex) => {
      if (/\t/u.test(raw.match(/^\s*/u)?.[0] ?? '')) {
        throw new Error(`Tabs are unsupported in YAML indentation at line ${sourceIndex + 1}`)
      }
      const uncommented = withoutYamlComment(raw)
      return {
        indent: uncommented.length - uncommented.trimStart().length,
        sourceIndex,
        text: uncommented.trim(),
      }
    })
    .filter((line) => line.text !== '' && line.text !== '---')

  function parseBlock(startIndex, indent) {
    const array = lines[startIndex]?.text.startsWith('- ')
    const container = array ? [] : Object.create(null)
    let index = startIndex
    while (index < lines.length) {
      const line = lines[index]
      if (line.indent < indent) break
      if (line.indent > indent) {
        throw new Error(`Unexpected YAML indentation at line ${line.sourceIndex + 1}`)
      }
      if (array) {
        if (!line.text.startsWith('- ')) {
          throw new Error(`Mixed YAML sequence and mapping at line ${line.sourceIndex + 1}`)
        }
        const item = line.text.slice(2).trim()
        if (item === '') {
          const next = lines[index + 1]
          if (!next || next.indent <= indent) container.push(null)
          else {
            const nested = parseBlock(index + 1, next.indent)
            container.push(nested.value)
            index = nested.index - 1
          }
        } else {
          container.push(parseYamlScalar(item))
        }
      } else {
        if (line.text.startsWith('- ')) {
          throw new Error(`Mixed YAML mapping and sequence at line ${line.sourceIndex + 1}`)
        }
        let rawKey
        let rawValue
        let explicitNestedKey
        if (line.text.startsWith('? ')) {
          rawKey = line.text.slice(2).trim()
          const valueLine = lines[index + 1]
          if (!valueLine || valueLine.indent !== indent || !valueLine.text.startsWith(': ')) {
            throw new Error(`Unsupported explicit YAML key at line ${line.sourceIndex + 1}`)
          }
          rawValue = valueLine.text.slice(2).trim()
          index += 1
          if (rawValue.endsWith(':')) {
            explicitNestedKey = parseYamlKey(rawValue.slice(0, -1).trim())
            rawValue = ''
          }
        } else {
          ;[rawKey, rawValue] = splitYamlMapping(line.text)
        }
        const key = parseYamlKey(rawKey)
        if (typeof key !== 'string') {
          throw new Error(`Non-string YAML key at line ${line.sourceIndex + 1}`)
        }
        if (Object.hasOwn(container, key)) {
          throw new Error(`Duplicate YAML key ${key} at line ${line.sourceIndex + 1}`)
        }
        if (rawValue !== '') {
          container[key] = parseYamlScalar(rawValue)
        } else {
          const next = lines[index + 1]
          if (!next || next.indent <= indent) {
            container[key] = explicitNestedKey ? { [explicitNestedKey]: null } : null
          } else {
            const nested = parseBlock(index + 1, next.indent)
            container[key] = explicitNestedKey
              ? { [explicitNestedKey]: nested.value }
              : nested.value
            index = nested.index - 1
          }
        }
      }
      index += 1
    }
    return { index, value: container }
  }

  return lines.length === 0 ? Object.create(null) : parseBlock(0, lines[0].indent).value
}

function globPattern(pattern) {
  let expression = '^'
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        expression += '.*'
        index += 1
      } else {
        expression += '[^/]*'
      }
    } else if (character === '?') {
      expression += '[^/]'
    } else {
      expression += character.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    }
  }
  return new RegExp(`${expression}$`, 'u')
}

async function workspaceManifestPaths(root, patterns) {
  const matchers = patterns.map((pattern) => {
    if (typeof pattern !== 'string' || pattern.startsWith('!')) {
      throw new Error(`Unsupported workspace package pattern: ${String(pattern)}`)
    }
    return globPattern(pattern.replaceAll('\\', '/').replace(/\/$/u, ''))
  })
  const results = []

  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory() || ['.git', 'dist', 'node_modules'].includes(entry.name)) continue
      const path = join(directory, entry.name)
      const relativeDirectory = relative(root, path).split(sep).join(posix.sep)
      if (matchers.some((matcher) => matcher.test(relativeDirectory))) {
        results.push(join(path, 'package.json'))
        continue
      }
      await walk(path)
    }
  }

  await walk(root)
  return results.sort()
}

function resolveCatalogSpecifier(workspace, packageName, specifier) {
  if (specifier === 'catalog:' || specifier === 'catalog:default') {
    return workspace.catalog?.[packageName]
  }
  if (specifier.startsWith('catalog:')) {
    return workspace.catalogs?.[specifier.slice('catalog:'.length)]?.[packageName]
  }
  return undefined
}

function resolutionUsesVersion(value, expectedVersion) {
  return typeof value === 'string'
    && (value === expectedVersion || value.startsWith(`${expectedVersion}(`))
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function quoted(value) {
  return `["']${escapeRegex(value)}["']`
}

function verifyCompatibilityMetadata(compatibility, issues) {
  record(issues, isObject(compatibility), 'upstream/compatibility.json must contain an object')
  if (!isObject(compatibility)) return
  record(issues, compatibility.schemaVersion === 1, 'compatibility schemaVersion must be 1')
  record(issues, isObject(compatibility.dsh), 'compatibility dsh metadata is missing')
  record(issues, isObject(compatibility.electron), 'compatibility electron metadata is missing')
  const dshVersion = compatibility.dsh?.packageVersion
  const release = compatibility.dsh?.release
  const electronVersion = compatibility.electron?.version
  const builderVersion = compatibility.electron?.builderVersion
  record(issues, typeof dshVersion === 'string' && EXACT_SEMVER.test(dshVersion), 'compatibility DSH packageVersion must be an exact semver')
  record(issues, release === `dsh-v${dshVersion}`, 'compatibility DSH release must equal dsh-v<packageVersion>')
  record(issues, typeof electronVersion === 'string' && EXACT_SEMVER.test(electronVersion), 'compatibility Electron version must be an exact semver')
  record(issues, typeof builderVersion === 'string' && EXACT_SEMVER.test(builderVersion), 'compatibility electron-builder version must be an exact semver')

  const plugins = compatibility.firstPartyPlugins
  record(issues, Array.isArray(plugins), 'compatibility firstPartyPlugins must be an array')
  if (!Array.isArray(plugins)) return
  record(issues, plugins.length === EXPECTED_FIRST_PARTY_PLUGINS.length, 'compatibility must declare exactly four first-party plugins')
  const identities = new Set()
  for (const expected of EXPECTED_FIRST_PARTY_PLUGINS) {
    const matches = plugins.filter((plugin) => (
      plugin?.entryId === expected.entryId && plugin?.packageName === expected.packageName
    ))
    record(issues, matches.length === 1, `compatibility must declare ${expected.entryId} as ${expected.packageName} exactly once`)
  }
  for (const plugin of plugins) {
    record(issues, isObject(plugin), 'compatibility firstPartyPlugins entries must be objects')
    if (!isObject(plugin)) continue
    record(issues, typeof plugin.entryId === 'string' && plugin.entryId !== '', 'compatibility first-party plugin entryId must be a non-empty string')
    record(issues, typeof plugin.packageName === 'string' && plugin.packageName !== '', 'compatibility first-party plugin packageName must be a non-empty string')
    const identity = `${plugin?.entryId}\0${plugin?.packageName}`
    record(issues, !identities.has(identity), `compatibility contains duplicate first-party plugin ${String(plugin?.entryId)}`)
    identities.add(identity)
  }
}

function verifyManifestDshDependencies(manifest, manifestLabel, workspace, expectedVersion, issues) {
  for (const groupName of DEPENDENCY_GROUPS) {
    const group = manifest[groupName]
    if (group === undefined) continue
    record(issues, isObject(group), `${manifestLabel} ${groupName} must be an object`)
    if (!isObject(group)) continue
    for (const [packageName, specifier] of Object.entries(group)) {
      if (!isDshPackage(packageName)) continue
      record(issues, typeof specifier === 'string', `${manifestLabel} ${packageName} must use a string specifier`)
      if (typeof specifier !== 'string') continue
      if (specifier.startsWith('catalog:')) {
        const resolved = resolveCatalogSpecifier(workspace, packageName, specifier)
        record(issues, resolved === expectedVersion && EXACT_SEMVER.test(String(resolved)), `${manifestLabel} ${packageName} catalog must resolve to exact ${expectedVersion}`)
      } else {
        record(issues, specifier === expectedVersion && EXACT_SEMVER.test(specifier), `${manifestLabel} ${packageName} must pin exact ${expectedVersion}`)
      }
    }
  }
}

function compatibilityDependencyVersion(packageName, versions) {
  if (isDshPackage(packageName)) return versions.dsh
  if (packageName === 'electron') return versions.electron
  if (packageName === 'electron-builder') return versions.electronBuilder
  return undefined
}

function verifyManifestToolchainDependencies(manifest, manifestLabel, workspace, versions, issues) {
  for (const groupName of DEPENDENCY_GROUPS) {
    const group = manifest[groupName]
    if (group === undefined) continue
    record(issues, isObject(group), `${manifestLabel} ${groupName} must be an object`)
    if (!isObject(group)) continue
    for (const [packageName, specifier] of Object.entries(group)) {
      if (!['electron', 'electron-builder'].includes(packageName)) continue
      const expectedVersion = compatibilityDependencyVersion(packageName, versions)
      record(issues, typeof specifier === 'string', `${manifestLabel} ${packageName} must use a string specifier`)
      if (typeof specifier !== 'string') continue
      if (specifier.startsWith('catalog:')) {
        const resolved = resolveCatalogSpecifier(workspace, packageName, specifier)
        record(
          issues,
          resolved === expectedVersion && EXACT_SEMVER.test(String(resolved)),
          `${manifestLabel} ${packageName} catalog must resolve to exact ${expectedVersion}`,
        )
      } else {
        record(
          issues,
          specifier === expectedVersion && EXACT_SEMVER.test(specifier),
          `${manifestLabel} ${packageName} must pin exact ${expectedVersion}`,
        )
      }
    }
  }
}

function verifyLockImporter(importer, manifest, importerName, expectedDshVersion, issues) {
  record(issues, isObject(importer), `pnpm lock is missing importer ${importerName}`)
  if (!isObject(importer)) return
  for (const groupName of DEPENDENCY_GROUPS) {
    const manifestGroup = manifest[groupName]
    if (!isObject(manifestGroup)) continue
    for (const [packageName, specifier] of Object.entries(manifestGroup)) {
      if (!isDshPackage(packageName)) continue
      const locked = importer[groupName]?.[packageName]
      record(issues, isObject(locked), `pnpm lock importer ${importerName} is missing ${packageName}`)
      if (!isObject(locked)) continue
      record(issues, locked.specifier === specifier, `pnpm lock importer ${importerName} has a stale specifier for ${packageName}`)
      record(issues, resolutionUsesVersion(locked.version, expectedDshVersion), `pnpm lock importer ${importerName} must resolve ${packageName} to ${expectedDshVersion}`)
    }
  }
}

function verifyLockToolchainImporter(importer, manifest, importerName, versions, issues) {
  if (!isObject(importer)) return
  for (const groupName of DEPENDENCY_GROUPS) {
    const manifestGroup = manifest[groupName]
    if (!isObject(manifestGroup)) continue
    for (const [packageName, specifier] of Object.entries(manifestGroup)) {
      if (!['electron', 'electron-builder'].includes(packageName)) continue
      const expectedVersion = compatibilityDependencyVersion(packageName, versions)
      const locked = importer[groupName]?.[packageName]
      record(issues, isObject(locked), `pnpm lock importer ${importerName} is missing ${packageName}`)
      if (!isObject(locked)) continue
      record(issues, locked.specifier === specifier, `pnpm lock importer ${importerName} has a stale specifier for ${packageName}`)
      record(issues, resolutionUsesVersion(locked.version, expectedVersion), `pnpm lock importer ${importerName} must resolve ${packageName} to ${expectedVersion}`)
    }
  }
}

function verifyLockDshResolutions(lock, expectedVersion, issues) {
  let resolutions = 0
  for (const sectionName of ['packages', 'snapshots']) {
    const section = lock[sectionName]
    record(issues, isObject(section), `pnpm lock ${sectionName} section is missing`)
    if (!isObject(section)) continue
    for (const key of Object.keys(section)) {
      const match = key.match(/^(@deepseek-ai\/dsh(?:-[A-Za-z0-9._-]+)?)@([^()]+)/u)
      if (!match) continue
      const [, packageName, version] = match
      resolutions += 1
      record(issues, version === expectedVersion, `pnpm lock ${sectionName} contains ${packageName}@${version}; expected ${expectedVersion}`)
    }
  }
  record(issues, resolutions > 0, 'pnpm lock contains no DSH package resolutions')
}

function verifyLockToolchainResolutions(lock, versions, issues) {
  const expectedPackages = new Map([
    ['electron', versions.electron],
    ['electron-builder', versions.electronBuilder],
  ])
  const resolutionCounts = new Map([...expectedPackages.keys()].map((name) => [name, 0]))
  for (const sectionName of ['packages', 'snapshots']) {
    const section = lock[sectionName]
    if (!isObject(section)) continue
    for (const key of Object.keys(section)) {
      const match = /^(electron|electron-builder)@([^()]+)/u.exec(key)
      if (!match) continue
      const [, packageName, version] = match
      resolutionCounts.set(packageName, resolutionCounts.get(packageName) + 1)
      record(
        issues,
        version === expectedPackages.get(packageName),
        `pnpm lock ${sectionName} contains ${packageName}@${version}; expected ${expectedPackages.get(packageName)}`,
      )
    }
  }
  for (const [packageName, count] of resolutionCounts) {
    record(issues, count > 0, `pnpm lock contains no ${packageName} resolutions`)
  }
}

function verifyOverlay(source, plugins, issues) {
  const invocation = source.match(/renderDesktopCorePatch\(\s*([A-Z_]+)\s*,\s*([A-Z_]+)\s*,\s*([A-Z_]+)\s*,\s*([A-Z_]+)\s*,?\s*\)/u)
  const argumentNames = ['entry', 'oauthEntry', 'diagnosticsEntry', 'gptToolsEntry']
  for (const [index, plugin] of plugins.entries()) {
    const match = source.match(new RegExp(
      `\\{\\s*id:\\s*${quoted(plugin.entryId)}\\s*,\\s*name:\\s*([^,}\\n]+)`,
      'u',
    ))
    record(issues, Boolean(match), `desktop overlay is missing ${plugin.entryId}`)
    if (!match) continue
    const rawName = match[1].trim()
    const literal = rawName.match(/^["']([^"']+)["']$/u)?.[1]
    const expectedArgumentName = argumentNames[index]
    const constantName = rawName === expectedArgumentName ? invocation?.[index + 1] : rawName
    const constant = literal ?? (constantName && source.match(new RegExp(
      `(?:export\\s+)?const\\s+${escapeRegex(constantName)}\\s*=\\s*${quoted(plugin.packageName)}`,
      'u',
    ))?.[0])
    record(issues, literal === plugin.packageName || Boolean(constant), `desktop overlay maps ${plugin.entryId} to the wrong module`)
  }
}

function verifyPackageVerifier(source, plugins, issues) {
  for (const plugin of plugins) {
    const segments = plugin.packageName.split('/').map(quoted).join('\\s*,\\s*')
    for (const fileName of ['index.js', 'client.js']) {
      const assignment = source.match(new RegExp(
        `const\\s+(\\w+)\\s*=\\s*join\\(stageDir,\\s*${quoted('node_modules')}\\s*,\\s*${segments}\\s*,\\s*${quoted('lib')}\\s*,\\s*${quoted(fileName)}\\s*\\)`,
        'u',
      ))
      record(issues, Boolean(assignment), `package verifier does not resolve ${plugin.packageName}/lib/${fileName}`)
      if (assignment) {
        record(issues, new RegExp(`access\\(\\s*${escapeRegex(assignment[1])}\\s*\\)`, 'u').test(source), `package verifier does not require ${plugin.packageName}/lib/${fileName}`)
      }
    }
  }
}

function verifyDirectoryPickerPatch({
  dshVersion,
  lock,
  packageVerifierSource,
  patchDocumentation,
  patchSource,
  rootPackage,
  testSource,
  workspace,
}, issues) {
  const patchKey = `${DIRECTORY_PICKER_PATCH_PACKAGE}@${dshVersion}`
  record(
    issues,
    workspace.patchedDependencies?.[patchKey] === DIRECTORY_PICKER_PATCH_PATH,
    `pnpm workspace must patch ${patchKey} from ${DIRECTORY_PICKER_PATCH_PATH}`,
  )

  const patchHash = lock.patchedDependencies?.[patchKey]
  record(
    issues,
    typeof patchHash === 'string' && /^[a-f0-9]{64}$/u.test(patchHash),
    `pnpm lock must record a SHA-256 patch hash for ${patchKey}`,
  )
  const snapshotKeys = isObject(lock.snapshots)
    ? Object.keys(lock.snapshots).filter((key) => key.startsWith(`${patchKey}(`))
    : []
  record(issues, snapshotKeys.length === 1, `pnpm lock must contain exactly one patched ${patchKey} snapshot`)
  if (typeof patchHash === 'string') {
    for (const key of snapshotKeys) {
      record(
        issues,
        key.includes(`patch_hash=${patchHash}`),
        `pnpm lock ${patchKey} snapshot must use its declared patch hash`,
      )
    }
  }

  record(
    issues,
    patchSource.includes('diff --git a/lib/worker.cjs b/lib/worker.cjs')
      && patchSource.includes('require("./worker-ipc.cjs")'),
    'directory-picker patch must wire worker.cjs to the IPC helper',
  )
  record(
    issues,
    patchSource.includes('diff --git a/lib/worker-ipc.cjs b/lib/worker-ipc.cjs')
      && /message\.kind === "showing"[\s\S]*send\(message\);[\s\S]*return;[\s\S]*send\(message, \(\) =>/u.test(patchSource),
    'directory-picker patch must keep showing non-terminal and flush terminal outcomes',
  )
  record(
    issues,
    /^\+\s*return koffi\.decode\.string16\(address\);$/mu.test(patchSource)
      && !/^\+.*koffi\.view\(/mu.test(patchSource)
      && /^\+\s*\}\s*finally\s*\{$[\s\S]*?^\+\s*coTaskMemFree\(name\);$/mu.test(patchSource),
    'directory-picker patch must decode UTF-16 without Electron external buffers and free COM memory',
  )
  record(
    issues,
    patchDocumentation.includes(`\`${patchKey}\``)
      && patchDocumentation.includes('https://github.com/cecil-su/dsh-workbench/issues/8')
      && patchDocumentation.includes('https://github.com/cecil-su/dsh-workbench/issues/10')
      && patchDocumentation.includes('Owner:')
      && patchDocumentation.includes('Introduced: 2026-08-23')
      && patchDocumentation.includes('Removal condition:')
      && patchDocumentation.includes('scripts/directory-picker-patch.test.mjs'),
    'directory-picker patch documentation must record issue, owner, introduction, protection, and removal condition',
  )
  record(
    issues,
    rootPackage.scripts?.['test:scripts']?.split('scripts/directory-picker-patch.test.mjs').length === 2
      && testSource.includes('createWin32DialogPost')
      && testSource.includes("kind: 'showing'")
      && testSource.includes("kind: 'done'")
      && testSource.includes("kind: 'error'")
      && testSource.includes('koffi\\.decode\\.string16')
      && testSource.includes('koffi\\.view'),
    'directory-picker patch regression test must cover IPC outcomes and the Electron-safe decoder',
  )
  for (const fileName of ['worker.cjs', 'worker-ipc.cjs']) {
    const stageAssignment = packageVerifierSource.match(new RegExp(
      `const\\s+(\\w+)\\s*=\\s*join\\(\\s*stageDir\\s*,\\s*${quoted('node_modules')}\\s*,\\s*${quoted('@deepseek-ai')}\\s*,\\s*${quoted('dsh-host-directory-picker-native')}\\s*,\\s*${quoted('lib')}\\s*,\\s*${quoted(fileName)}\\s*,?\\s*\\)`,
      'u',
    ))
    record(
      issues,
      Boolean(stageAssignment),
      `package verifier must resolve directory-picker ${fileName} in the production stage`,
    )
    if (stageAssignment) {
      record(
        issues,
        new RegExp(`access\\(\\s*${escapeRegex(stageAssignment[1])}\\s*\\)`, 'u').test(packageVerifierSource),
        `package verifier must require staged directory-picker ${fileName}`,
      )
    }
    record(
      issues,
      new RegExp(
        `access\\(\\s*join\\(\\s*packagedAppPath\\s*,\\s*${quoted('node_modules')}\\s*,\\s*${quoted('@deepseek-ai')}\\s*,\\s*${quoted('dsh-host-directory-picker-native')}\\s*,\\s*${quoted('lib')}\\s*,\\s*${quoted(fileName)}\\s*,?\\s*\\)\\s*\\)`,
        'u',
      ).test(packageVerifierSource),
      `package verifier must require packaged directory-picker ${fileName}`,
    )
  }
}

function verifySubprocessPatch({
  dshVersion,
  lock,
  packageVerifierSource,
  patchDocumentation,
  patchSource,
  rootPackage,
  testSource,
  workspace,
}, issues) {
  const patchKey = `${SUBPROCESS_PATCH_PACKAGE}@${dshVersion}`
  record(
    issues,
    workspace.patchedDependencies?.[patchKey] === SUBPROCESS_PATCH_PATH,
    `pnpm workspace must patch ${patchKey} from ${SUBPROCESS_PATCH_PATH}`,
  )

  const patchHash = lock.patchedDependencies?.[patchKey]
  record(
    issues,
    typeof patchHash === 'string' && /^[a-f0-9]{64}$/u.test(patchHash),
    `pnpm lock must record a SHA-256 patch hash for ${patchKey}`,
  )
  const snapshotKeys = isObject(lock.snapshots)
    ? Object.keys(lock.snapshots).filter((key) => key.startsWith(`${patchKey}(`))
    : []
  record(issues, snapshotKeys.length === 1, `pnpm lock must contain exactly one patched ${patchKey} snapshot`)
  if (typeof patchHash === 'string') {
    for (const key of snapshotKeys) {
      record(
        issues,
        key.includes(`patch_hash=${patchHash}`),
        `pnpm lock ${patchKey} snapshot must use its declared patch hash`,
      )
    }
  }

  record(
    issues,
    patchSource.includes('diff --git a/lib/index.js b/lib/index.js')
      && /^\+\s*windowsHide: platform === "win32",$/mu.test(patchSource),
    'subprocess patch must hide direct Win32 subprocess console windows',
  )
  record(
    issues,
    patchDocumentation.includes(`\`${patchKey}\``)
      && patchDocumentation.includes('https://github.com/cecil-su/dsh-workbench/issues/11')
      && patchDocumentation.includes('Owner:')
      && patchDocumentation.includes('Introduced: 2026-08-23')
      && patchDocumentation.includes('Removal condition:')
      && patchDocumentation.includes('scripts/subprocess-windows-hide-patch.test.mjs'),
    'subprocess patch documentation must record issue, owner, introduction, protection, and removal condition',
  )
  record(
    issues,
    rootPackage.scripts?.['test:scripts']?.split('scripts/subprocess-windows-hide-patch.test.mjs').length === 2
      && testSource.includes('windowsHide: platform === "win32"')
      && testSource.includes("assert.equal(manifest.version, '0.1.1-rc.2')"),
    'subprocess patch regression test must cover the exact package and Win32-only hidden spawn option',
  )

  const stageAssignment = packageVerifierSource.match(new RegExp(
    `const\\s+(\\w+)\\s*=\\s*join\\(\\s*stageDir\\s*,\\s*${quoted('node_modules')}\\s*,\\s*${quoted('@deepseek-ai')}\\s*,\\s*${quoted('dsh-subprocess-local')}\\s*,\\s*${quoted('lib')}\\s*,\\s*${quoted('index.js')}\\s*,?\\s*\\)`,
    'u',
  ))
  record(issues, Boolean(stageAssignment), 'package verifier must resolve subprocess-local in the production stage')
  if (stageAssignment) {
    record(
      issues,
      new RegExp(`access\\(\\s*${escapeRegex(stageAssignment[1])}\\s*\\)`, 'u').test(packageVerifierSource),
      'package verifier must require staged subprocess-local',
    )
  }
  record(
    issues,
    new RegExp(
      `access\\(\\s*join\\(\\s*packagedAppPath\\s*,\\s*${quoted('node_modules')}\\s*,\\s*${quoted('@deepseek-ai')}\\s*,\\s*${quoted('dsh-subprocess-local')}\\s*,\\s*${quoted('lib')}\\s*,\\s*${quoted('index.js')}\\s*,?\\s*\\)\\s*\\)`,
      'u',
    ).test(packageVerifierSource),
    'package verifier must require packaged subprocess-local',
  )
}

export async function verifyCompatibility(root = rootFromScript) {
  const issues = []
  const [attributesSource, compatibility, upstreamVersion, workspaceSource, lockSource, rootPackage, desktopPackage, overlaySource, packageVerifierSource, diagnosticsTemplate, diagnosticsBuilderSource, patchDocumentation, directoryPickerPatchSource, directoryPickerTestSource, subprocessPatchSource, subprocessTestSource] = await Promise.all([
    readFile(join(root, '.gitattributes'), 'utf8'),
    readCompatibility(root),
    readFile(join(root, 'upstream', 'version.json'), 'utf8').then(JSON.parse),
    readFile(join(root, 'pnpm-workspace.yaml'), 'utf8'),
    readFile(join(root, 'pnpm-lock.yaml'), 'utf8'),
    readFile(join(root, 'package.json'), 'utf8').then(JSON.parse),
    readFile(join(root, 'apps', 'desktop', 'package.json'), 'utf8').then(JSON.parse),
    readFile(join(root, 'apps', 'desktop', 'src', 'contribution.ts'), 'utf8'),
    readFile(join(root, 'scripts', 'package.mjs'), 'utf8'),
    readFile(join(root, 'plugins', 'diagnostics-ui', 'src', 'client.js'), 'utf8'),
    readFile(join(root, 'plugins', 'diagnostics-ui', 'scripts', 'build-client.mjs'), 'utf8'),
    readFile(join(root, 'patches', 'README.md'), 'utf8'),
    readFile(join(root, ...DIRECTORY_PICKER_PATCH_PATH.split('/')), 'utf8'),
    readFile(join(root, 'scripts', 'directory-picker-patch.test.mjs'), 'utf8'),
    readFile(join(root, ...SUBPROCESS_PATCH_PATH.split('/')), 'utf8'),
    readFile(join(root, 'scripts', 'subprocess-windows-hide-patch.test.mjs'), 'utf8'),
  ])
  const workspace = parsePnpmYaml(workspaceSource)
  const lock = parsePnpmYaml(lockSource)
  const attributeLines = attributesSource
    .replaceAll('\r\n', '\n')
    .split('\n')
    .map((line) => line.replace(/\s+#.*$/u, '').trim())
    .filter(Boolean)
  record(
    issues,
    attributeLines.includes('pnpm-lock.yaml text eol=lf'),
    '.gitattributes must pin pnpm-lock.yaml to LF for cross-platform provenance',
  )
  verifyCompatibilityMetadata(compatibility, issues)
  const dshVersion = typeof compatibility?.dsh?.packageVersion === 'string'
    ? compatibility.dsh.packageVersion
    : ''
  const electronVersion = typeof compatibility?.electron?.version === 'string'
    ? compatibility.electron.version
    : ''
  const builderVersion = typeof compatibility?.electron?.builderVersion === 'string'
    ? compatibility.electron.builderVersion
    : ''
  const compatibilityVersions = Object.freeze({
    dsh: dshVersion,
    electron: electronVersion,
    electronBuilder: builderVersion,
  })
  const plugins = Array.isArray(compatibility?.firstPartyPlugins)
    ? compatibility.firstPartyPlugins.filter((plugin) => (
        isObject(plugin)
        && typeof plugin.entryId === 'string'
        && typeof plugin.packageName === 'string'
      ))
    : []

  record(issues, upstreamVersion.release === compatibility?.dsh?.release, 'upstream/version.json release differs from compatibility metadata')
  record(issues, upstreamVersion.packageVersion === dshVersion, 'upstream/version.json packageVersion differs from compatibility metadata')

  const defaultCatalog = workspace.catalog
  record(issues, isObject(defaultCatalog), 'pnpm workspace default catalog is missing')
  if (isObject(defaultCatalog)) {
    for (const [packageName, version] of Object.entries(defaultCatalog)) {
      if (isDshPackage(packageName)) {
        record(issues, version === dshVersion && EXACT_SEMVER.test(String(version)), `pnpm catalog ${packageName} must pin exact ${dshVersion}`)
      } else if (packageName === 'electron' || packageName === 'electron-builder') {
        const expectedVersion = compatibilityDependencyVersion(packageName, compatibilityVersions)
        record(issues, version === expectedVersion && EXACT_SEMVER.test(String(version)), `pnpm catalog ${packageName} must pin exact ${expectedVersion}`)
      }
    }
    record(issues, defaultCatalog['@deepseek-ai/dsh'] === dshVersion, `pnpm catalog @deepseek-ai/dsh must equal ${dshVersion}`)
    record(issues, defaultCatalog.electron === electronVersion && EXACT_SEMVER.test(String(defaultCatalog.electron)), `pnpm catalog electron must pin exact ${electronVersion}`)
  }
  if (isObject(workspace.catalogs)) {
    for (const [catalogName, catalog] of Object.entries(workspace.catalogs)) {
      if (!isObject(catalog)) continue
      for (const [packageName, version] of Object.entries(catalog)) {
        if (isDshPackage(packageName)) {
          record(issues, version === dshVersion && EXACT_SEMVER.test(String(version)), `pnpm catalog ${catalogName}/${packageName} must pin exact ${dshVersion}`)
        } else if (packageName === 'electron' || packageName === 'electron-builder') {
          const expectedVersion = compatibilityDependencyVersion(packageName, compatibilityVersions)
          record(issues, version === expectedVersion && EXACT_SEMVER.test(String(version)), `pnpm catalog ${catalogName}/${packageName} must pin exact ${expectedVersion}`)
        }
      }
    }
  }

  const workspacePatterns = workspace.packages
  record(issues, Array.isArray(workspacePatterns), 'pnpm workspace packages must be an array')
  const manifestPaths = Array.isArray(workspacePatterns)
    ? await workspaceManifestPaths(root, workspacePatterns)
    : []
  record(issues, manifestPaths.length > 0, 'no workspace package manifests were found')
  const manifests = [{ path: join(root, 'package.json'), manifest: rootPackage }]
  for (const path of manifestPaths) {
    manifests.push({ path, manifest: JSON.parse(await readFile(path, 'utf8')) })
  }
  const pluginManifestEntries = manifests.filter(({ path }) => (
    /^plugins\/[^/]+\/package\.json$/u.test(relative(root, path).split(sep).join(posix.sep))
  ))
  for (const { path, manifest } of pluginManifestEntries) {
    record(
      issues,
      typeof manifest.name === 'string' && manifest.name !== '',
      `${relative(root, path).split(sep).join(posix.sep)} must declare a package name`,
    )
  }
  const workspacePluginNames = pluginManifestEntries
    .map(({ manifest }) => manifest.name)
    .filter((name) => typeof name === 'string' && name !== '')
    .sort()
  const compatibilityPluginNames = plugins.map(({ packageName }) => packageName).sort()
  record(
    issues,
    JSON.stringify(workspacePluginNames) === JSON.stringify(compatibilityPluginNames),
    'compatibility firstPartyPlugins package names must exactly match workspace plugins/* manifests',
  )
  for (const { path, manifest } of manifests) {
    const label = relative(root, path).split(sep).join(posix.sep)
    verifyManifestDshDependencies(manifest, label, workspace, dshVersion, issues)
    verifyManifestToolchainDependencies(
      manifest,
      label,
      workspace,
      compatibilityVersions,
      issues,
    )
    const importerName = label === 'package.json' ? '.' : posix.dirname(label)
    const importer = lock.importers?.[importerName]
    verifyLockImporter(importer, manifest, importerName, dshVersion, issues)
    verifyLockToolchainImporter(
      importer,
      manifest,
      importerName,
      compatibilityVersions,
      issues,
    )
  }
  verifyLockDshResolutions(lock, dshVersion, issues)
  verifyLockToolchainResolutions(lock, compatibilityVersions, issues)

  const lockDshCatalog = lock.catalogs?.default?.['@deepseek-ai/dsh']
  record(issues, lockDshCatalog?.specifier === dshVersion, 'pnpm lock DSH catalog specifier differs from compatibility metadata')
  record(issues, resolutionUsesVersion(lockDshCatalog?.version, dshVersion), 'pnpm lock DSH catalog resolution differs from compatibility metadata')
  const lockElectronCatalog = lock.catalogs?.default?.electron
  record(issues, lockElectronCatalog?.specifier === electronVersion, 'pnpm lock Electron catalog specifier differs from compatibility metadata')
  record(issues, resolutionUsesVersion(lockElectronCatalog?.version, electronVersion), 'pnpm lock Electron catalog resolution differs from compatibility metadata')

  const desktopElectronSpecifier = desktopPackage.devDependencies?.electron
  record(issues, desktopElectronSpecifier === 'catalog:', 'desktop Electron dependency must use the default catalog')
  const desktopElectronLock = lock.importers?.['apps/desktop']?.devDependencies?.electron
  record(issues, desktopElectronLock?.specifier === desktopElectronSpecifier, 'pnpm lock desktop Electron specifier is stale')
  record(issues, resolutionUsesVersion(desktopElectronLock?.version, electronVersion), `pnpm lock desktop Electron must resolve ${electronVersion}`)
  record(issues, rootPackage.devDependencies?.['electron-builder'] === builderVersion, `root electron-builder must pin exact ${builderVersion}`)
  const lockedBuilder = lock.importers?.['.']?.devDependencies?.['electron-builder']
  record(issues, lockedBuilder?.specifier === builderVersion, 'pnpm lock electron-builder specifier differs from compatibility metadata')
  record(issues, resolutionUsesVersion(lockedBuilder?.version, builderVersion), 'pnpm lock electron-builder resolution differs from compatibility metadata')

  try {
    const configUrl = `${pathToFileURL(join(root, 'electron-builder.config.mjs')).href}?compatibility=${compatibilitySha256(compatibility)}`
    const config = (await import(configUrl)).default
    record(issues, config?.electronVersion === electronVersion, `electron-builder config must select Electron ${electronVersion}`)
  } catch (error) {
    issues.push(`electron-builder config could not be loaded: ${error instanceof Error ? error.message : String(error)}`)
  }

  const token = '__DSH_WORKBENCH_EXPECTED_DSH_VERSION__'
  const tokenCount = diagnosticsTemplate.split(token).length - 1
  record(issues, tokenCount === 1, `diagnostics client must contain exactly one compatibility DSH version token; found ${tokenCount}`)
  const renderedDiagnostics = diagnosticsTemplate.replace(token, dshVersion)
  record(issues, new RegExp(`const\\s+EXPECTED_DSH_VERSION\\s*=\\s*${quoted(dshVersion)}`, 'u').test(renderedDiagnostics), 'diagnostics expected DSH version differs from compatibility metadata')
  record(issues, diagnosticsBuilderSource.includes("readCompatibility(root)"), 'diagnostics build must read compatibility metadata')
  record(issues, diagnosticsBuilderSource.includes('compatibility?.dsh?.packageVersion'), 'diagnostics build must inject the compatibility DSH package version')

  verifyOverlay(overlaySource, plugins, issues)
  for (const plugin of plugins) {
    record(issues, desktopPackage.dependencies?.[plugin.packageName] === 'workspace:*', `desktop dependencies must include ${plugin.packageName} as workspace:*`)
  }
  verifyPackageVerifier(packageVerifierSource, plugins, issues)
  verifyDirectoryPickerPatch({
    dshVersion,
    lock,
    packageVerifierSource,
    patchDocumentation,
    patchSource: directoryPickerPatchSource,
    rootPackage,
    testSource: directoryPickerTestSource,
    workspace,
  }, issues)
  verifySubprocessPatch({
    dshVersion,
    lock,
    packageVerifierSource,
    patchDocumentation,
    patchSource: subprocessPatchSource,
    rootPackage,
    testSource: subprocessTestSource,
    workspace,
  }, issues)

  if (issues.length > 0) throw new CompatibilityVerificationError(issues)
  const hash = compatibilitySha256(compatibility)
  return Object.freeze({
    compatibility,
    compatibilitySha256: hash,
    workspacePackages: Object.freeze(manifestPaths.map((path) => relative(root, dirname(path)).split(sep).join(posix.sep))),
  })
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined
if (invokedPath === import.meta.url) {
  const result = await verifyCompatibility()
  console.log(`Compatibility verified: DSH ${result.compatibility.dsh.packageVersion}, Electron ${result.compatibility.electron.version}, ${result.compatibilitySha256}`)
}
