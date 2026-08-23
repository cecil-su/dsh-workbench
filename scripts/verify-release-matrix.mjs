import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLATFORM_DEFINITIONS = Object.freeze([
  Object.freeze({
    arch: 'x64',
    artifactSuffixes: Object.freeze(['.AppImage', '.tar.gz', '.zip']),
    id: 'linux-x64',
    platform: 'linux',
  }),
  Object.freeze({
    arch: 'arm64',
    artifactSuffixes: Object.freeze(['.dmg', '.zip']),
    id: 'macos-arm64',
    platform: 'darwin',
  }),
  Object.freeze({
    arch: 'x64',
    artifactSuffixes: Object.freeze(['.exe', '.zip']),
    id: 'windows-x64',
    platform: 'win32',
  }),
])

const RELEASE_ARTIFACT_SUFFIXES = Object.freeze([
  '.AppImage',
  '.tar.gz',
  '.dmg',
  '.exe',
  '.zip',
])

const REQUIRED_AUTHORIZATION_EVIDENCE = Object.freeze([
  'officialFlowRegistered',
  'uiMounted',
  'valueFreeSnapshotVerified',
])

const REQUIRED_DIAGNOSTIC_EVIDENCE = Object.freeze([
  'compatibilityVerified',
  'inventoryRemoteVerified',
  'logOutputDomVerified',
  'logOutputIpcVerified',
  'logOutputRingVerified',
  'logProfileIsolationVerified',
  'logRedactionVerified',
  'overlayAttentionVerified',
  'repairActionVerified',
  'repairHealthyVerified',
  'repairPidTurnoverVerified',
  'repairPortTurnoverVerified',
  'repairUiMounted',
  'staleWindowDestroyed',
])

const REQUIRED_PROFILE_EVIDENCE = Object.freeze([
  'activeProfileRestartPersistenceVerified',
  'ambientCredentialFilteringVerified',
  'browserPartitionIsolationVerified',
  'browserPartitionRestartPersistenceVerified',
  'clientBundleInBootPayload',
  'credentialIsolationVerified',
  'defaultPartitionContinuityVerified',
  'dshHomeIsolationVerified',
  'legacyMigrationVerified',
  'profileUiLifecycleVerified',
  'profileUiMounted',
  'registryVerified',
  'rendererApiVerified',
  'rendererSelectVerified',
  'runtimeSwitchVerified',
  'workspaceIsolationVerified',
])

const REQUIRED_RUNTIME_TRUE_EVIDENCE = Object.freeze([
  'expectedExit',
  'httpBootPayload',
  'ptyOutputVerified',
  'windowLoaded',
  'windowSecurityVerified',
])

const REQUIRED_RUNTIME_FALSE_EVIDENCE = Object.freeze([
  'pidAliveAfterStop',
  'portOpenAfterStop',
  'ptyPidAliveAfterExit',
])

const SHA256_PATTERN = /^[a-f0-9]{64}$/u
const GIT_SHA_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u
const DIAGNOSTIC_MARKER_PATTERN = /^package-smoke-benign-[a-f0-9]{32}$/u
const MAX_JSON_BYTES = 1024 * 1024
const MAX_CHECKSUM_BYTES = 64 * 1024
const EXPECTED_RELEASE_ARTIFACT_COUNT = PLATFORM_DEFINITIONS.reduce(
  (count, definition) => count + definition.artifactSuffixes.length,
  0,
)

function fail(message) {
  throw new Error(`Release matrix verification failed: ${message}`)
}

function assert(condition, message) {
  if (!condition) fail(message)
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireRecord(value, label) {
  assert(isRecord(value), `${label} must be an object`)
  return value
}

function requireNonEmptyString(value, label) {
  assert(typeof value === 'string' && value.length > 0 && value === value.trim(), `${label} must be a non-empty trimmed string`)
  return value
}

function requireSha256(value, label) {
  assert(typeof value === 'string' && SHA256_PATTERN.test(value), `${label} must be a lowercase SHA-256 digest`)
  return value
}

function definitionFor(platform, arch, label) {
  const definition = PLATFORM_DEFINITIONS.find((candidate) => (
    candidate.platform === platform && candidate.arch === arch
  ))
  assert(definition, `${label} has unsupported platform/architecture ${String(platform)}/${String(arch)}`)
  return definition
}

function isPathInsideOrEqual(parent, child) {
  const fromParent = relative(parent, child)
  return fromParent === '' || (
    fromParent !== '..'
    && !fromParent.startsWith(`..${sep}`)
    && !isAbsolute(fromParent)
  )
}

function portableRelativePath(root, path) {
  const fromRoot = relative(root, path)
  assert(fromRoot !== '' && isPathInsideOrEqual(root, path), `evidence path escaped its root: ${path}`)
  return fromRoot.split(sep).join('/')
}

function portableBasename(path) {
  return path.replaceAll('\\', '/').split('/').at(-1)
}

function isReleaseArtifactName(name) {
  return RELEASE_ARTIFACT_SUFFIXES.some((suffix) => name.endsWith(suffix))
}

function validateManifestArtifactPath(value, label) {
  const artifactPath = requireNonEmptyString(value, label)
  assert(!isAbsolute(artifactPath), `${label} must be relative`)
  assert(!artifactPath.includes('\\'), `${label} must use portable forward slashes`)
  const segments = artifactPath.split('/')
  assert(
    segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..'),
    `${label} contains an unsafe path segment`,
  )
  const name = segments.at(-1)
  assert(name && isReleaseArtifactName(name), `${label} is not a supported release artifact`)
  return name
}

async function readBoundedText(path, maximumBytes, label) {
  const metadata = await lstat(path)
  assert(metadata.isFile() && !metadata.isSymbolicLink(), `${label} must be a regular file`)
  assert(metadata.size <= maximumBytes, `${label} exceeds ${maximumBytes} bytes`)
  return readFile(path, 'utf8')
}

async function readJson(path, label) {
  const serialized = await readBoundedText(path, MAX_JSON_BYTES, label)
  try {
    return JSON.parse(serialized)
  } catch (error) {
    fail(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function sha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function collectEvidenceFiles(evidenceRoot) {
  const files = []
  const visit = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))
    for (const entry of entries) {
      const path = join(directory, entry.name)
      assert(!entry.isSymbolicLink(), `symbolic links are forbidden in release evidence: ${portableRelativePath(evidenceRoot, path)}`)
      if (entry.isDirectory()) {
        await visit(path)
      } else if (entry.isFile()) {
        files.push(path)
      } else {
        fail(`unsupported filesystem entry in release evidence: ${portableRelativePath(evidenceRoot, path)}`)
      }
    }
  }
  await visit(evidenceRoot)
  return files
}

function indexUniqueByPlatform(entries, label) {
  const result = new Map()
  for (const entry of entries) {
    const definition = definitionFor(entry.platform, entry.arch, entry.label)
    assert(!result.has(definition.id), `duplicate ${label} for ${definition.id}`)
    result.set(definition.id, { ...entry, definition })
  }
  assert(result.size === PLATFORM_DEFINITIONS.length, `expected ${PLATFORM_DEFINITIONS.length} ${label} files, found ${result.size}`)
  for (const definition of PLATFORM_DEFINITIONS) {
    assert(result.has(definition.id), `missing ${label} for ${definition.id}`)
  }
  return result
}

function validateManifestShape(manifest, label) {
  const value = requireRecord(manifest, label)
  assert(value.schemaVersion === 2, `${label} must use schemaVersion 2`)
  assert(value.mode === 'artifacts', `${label} must describe an artifact build`)
  assert(value.gitDirty === false, `${label} must prove a clean git worktree`)
  assert(typeof value.gitSha === 'string' && GIT_SHA_PATTERN.test(value.gitSha), `${label}.gitSha is invalid`)
  requireSha256(value.lockfileSha256, `${label}.lockfileSha256`)
  requireSha256(value.compatibilitySha256, `${label}.compatibilitySha256`)
  requireNonEmptyString(value.electronVersion, `${label}.electronVersion`)
  requireNonEmptyString(value.electronBuilderVersion, `${label}.electronBuilderVersion`)
  const versions = requireRecord(value.versions, `${label}.versions`)
  requireNonEmptyString(versions.desktop, `${label}.versions.desktop`)
  requireNonEmptyString(versions.dsh, `${label}.versions.dsh`)
  assert(Array.isArray(value.artifacts), `${label}.artifacts must be an array`)
  return value
}

async function validateArtifacts(manifestPath, manifest, definition, evidenceRoot) {
  const label = portableRelativePath(evidenceRoot, manifestPath)
  const artifactNames = manifest.artifacts.map((artifact, index) => (
    validateManifestArtifactPath(artifact, `${label}.artifacts[${index}]`)
  ))
  assert(new Set(artifactNames).size === artifactNames.length, `${label} contains duplicate artifacts`)
  assert(
    artifactNames.length === definition.artifactSuffixes.length,
    `${label} must contain exactly ${definition.artifactSuffixes.length} release artifacts`,
  )
  for (const suffix of definition.artifactSuffixes) {
    assert(
      artifactNames.filter((name) => name.endsWith(suffix)).length === 1,
      `${label} must contain exactly one ${suffix} artifact`,
    )
  }

  const manifestDirectory = dirname(manifestPath)
  const directEntries = await readdir(manifestDirectory, { withFileTypes: true })
  const actualReleaseNames = directEntries
    .filter((entry) => entry.isFile() && isReleaseArtifactName(entry.name))
    .map((entry) => entry.name)
    .sort()
  const expectedNames = [...artifactNames].sort()
  assert(
    JSON.stringify(actualReleaseNames) === JSON.stringify(expectedNames),
    `${label} artifact files do not exactly match its manifest`,
  )

  const checksumPath = join(manifestDirectory, 'SHA256SUMS')
  const checksumText = await readBoundedText(checksumPath, MAX_CHECKSUM_BYTES, `${label} SHA256SUMS`)
  const checksumLines = checksumText.endsWith('\n')
    ? checksumText.slice(0, -1).split('\n')
    : checksumText.split('\n')
  assert(checksumLines.length === expectedNames.length, `${label} SHA256SUMS has the wrong entry count`)
  const checksums = new Map()
  for (const line of checksumLines) {
    const match = /^([a-f0-9]{64})  ([^/\\]+)$/u.exec(line)
    assert(match, `${label} contains an invalid SHA256SUMS entry`)
    const [, expectedHash, name] = match
    assert(expectedNames.includes(name), `${label} SHA256SUMS contains unexpected artifact ${name}`)
    assert(!checksums.has(name), `${label} SHA256SUMS contains duplicate artifact ${name}`)
    checksums.set(name, expectedHash)
  }

  const qualifiedArtifacts = []
  for (const name of expectedNames) {
    assert(checksums.has(name), `${label} SHA256SUMS is missing artifact ${name}`)
    const artifactPath = join(manifestDirectory, name)
    const metadata = await lstat(artifactPath)
    assert(metadata.isFile() && !metadata.isSymbolicLink(), `${label} artifact ${name} must be a regular file`)
    const resolvedArtifact = await realpath(artifactPath)
    assert(isPathInsideOrEqual(evidenceRoot, resolvedArtifact), `${label} artifact ${name} escaped the evidence root`)
    const actualHash = await sha256(resolvedArtifact)
    assert(actualHash === checksums.get(name), `${label} checksum mismatch for ${name}`)
    qualifiedArtifacts.push({ name, sha256: actualHash })
  }
  return qualifiedArtifacts
}

function requireTrueEvidence(group, fields, label) {
  const value = requireRecord(group, label)
  for (const field of fields) assert(value[field] === true, `${label}.${field} must be true`)
  return value
}

function validateAppSmoke(report, definition, manifest, label) {
  const value = requireRecord(report, label)
  assert(value.schemaVersion === 1, `${label} must use schemaVersion 1`)
  assert(value.phase === 'verify', `${label} must be the verify phase`)
  assert(value.status === 'passed', `${label} did not pass`)
  assert(value.error === undefined || value.error === null, `${label} contains an error`)

  const app = requireRecord(value.app, `${label}.app`)
  assert(app.isPackaged === true, `${label}.app.isPackaged must be true`)
  assert(app.platform === definition.platform, `${label}.app.platform does not match ${definition.id}`)
  assert(app.arch === definition.arch, `${label}.app.arch does not match ${definition.id}`)
  assert(app.version === manifest.versions.desktop, `${label}.app.version does not match the manifest`)
  assert(app.electronVersion === manifest.electronVersion, `${label}.app.electronVersion does not match the manifest`)

  requireTrueEvidence(value.authorization, REQUIRED_AUTHORIZATION_EVIDENCE, `${label}.authorization`)
  const diagnostics = requireTrueEvidence(value.diagnostics, REQUIRED_DIAGNOSTIC_EVIDENCE, `${label}.diagnostics`)
  const marker = diagnostics.outputPipelineMarker
  assert(typeof marker === 'string' && DIAGNOSTIC_MARKER_PATTERN.test(marker), `${label}.diagnostics.outputPipelineMarker is invalid`)
  requireTrueEvidence(value.profiles, REQUIRED_PROFILE_EVIDENCE, `${label}.profiles`)

  const runtime = requireTrueEvidence(value.runtime, REQUIRED_RUNTIME_TRUE_EVIDENCE, `${label}.runtime`)
  for (const field of REQUIRED_RUNTIME_FALSE_EVIDENCE) {
    assert(runtime[field] === false, `${label}.runtime.${field} must be false`)
  }
  assert(runtime.exitCode === 0, `${label}.runtime.exitCode must be zero`)
  assert(runtime.ptyExitCode === 0, `${label}.runtime.ptyExitCode must be zero`)
  assert(runtime.dshVersion === manifest.versions.dsh, `${label}.runtime.dshVersion does not match the manifest`)
  return { marker, value }
}

function validateHarnessSmoke(
  report,
  definition,
  marker,
  appSmokePath,
  packageManifestSha256,
  label,
) {
  const value = requireRecord(report, label)
  assert(value.schemaVersion === 2, `${label} must use schemaVersion 2`)
  assert(value.status === 'passed', `${label} did not pass`)
  assert(value.error === undefined || value.error === null, `${label} contains an error`)
  assert(value.platform === definition.platform, `${label}.platform does not match ${definition.id}`)
  assert(value.arch === definition.arch, `${label}.arch does not match ${definition.id}`)
  assert(
    portableBasename(requireNonEmptyString(value.appReportPath, `${label}.appReportPath`)) === portableBasename(appSmokePath),
    `${label}.appReportPath does not identify its app smoke report`,
  )
  requireSha256(value.packageManifestSha256, `${label}.packageManifestSha256`)
  assert(
    value.packageManifestSha256 === packageManifestSha256,
    `${label}.packageManifestSha256 does not match its package manifest`,
  )
  const diagnostics = requireRecord(value.diagnostics, `${label}.diagnostics`)
  assert(diagnostics.outputPipelineMarker === marker, `${label} diagnostic marker does not match its app report`)
  const processReport = requireRecord(value.process, `${label}.process`)
  assert(processReport.code === 0, `${label}.process.code must be zero`)
  assert(processReport.timedOut === false, `${label}.process.timedOut must be false`)
  assert(processReport.diagnosticCanaryExposed === false, `${label}.process.diagnosticCanaryExposed must be false`)
  assert(processReport.signal === null, `${label}.process.signal must be null`)
  assert(processReport.cleanupError === undefined || processReport.cleanupError === null, `${label}.process contains a cleanup error`)
  assert(typeof processReport.stdout === 'string' && processReport.stdout.includes('DSH_WORKBENCH_PACKAGE_SMOKE_OK'), `${label}.process.stdout lacks the success marker`)
  assert(processReport.stdout.includes(marker), `${label}.process.stdout lacks the diagnostic marker`)
  assert(typeof processReport.stderr === 'string', `${label}.process.stderr must be a string`)
  if (definition.platform !== 'linux') return undefined

  const sandbox = requireRecord(value.sandbox, `${label}.sandbox`)
  assert(sandbox.helperContentVerified === true, `${label}.sandbox.helperContentVerified must be true`)
  assert(sandbox.helperModeVerified === true, `${label}.sandbox.helperModeVerified must be true`)
  return {
    helperContentVerified: true,
    helperModeVerified: true,
    helperSha256: requireSha256(sandbox.helperSha256, `${label}.sandbox.helperSha256`),
  }
}

function identityFromManifest(manifest) {
  return {
    compatibilitySha256: manifest.compatibilitySha256,
    dshVersion: manifest.versions.dsh,
    electronBuilderVersion: manifest.electronBuilderVersion,
    electronVersion: manifest.electronVersion,
    gitDirty: manifest.gitDirty,
    gitSha: manifest.gitSha,
    lockfileSha256: manifest.lockfileSha256,
    workbenchVersion: manifest.versions.desktop,
  }
}

function assertSameIdentity(reference, candidate, platformId) {
  for (const [field, expected] of Object.entries(reference)) {
    assert(candidate[field] === expected, `${platformId} ${field} does not match the release identity`)
  }
}

export async function verifyReleaseMatrix(evidenceRootPath, outputPath) {
  assert(typeof evidenceRootPath === 'string' && evidenceRootPath.length > 0, 'an evidence root is required')
  assert(typeof outputPath === 'string' && outputPath.length > 0, 'an output path is required')
  const evidenceRoot = await realpath(resolve(evidenceRootPath))
  const destination = resolve(outputPath)
  const evidenceMetadata = await lstat(evidenceRoot)
  assert(evidenceMetadata.isDirectory(), 'the evidence root must be a directory')
  const files = await collectEvidenceFiles(evidenceRoot)
  const releaseArtifactPaths = files.filter((path) => isReleaseArtifactName(portableBasename(path)))
  assert(
    releaseArtifactPaths.length === EXPECTED_RELEASE_ARTIFACT_COUNT,
    `expected exactly ${EXPECTED_RELEASE_ARTIFACT_COUNT} release artifacts, found ${releaseArtifactPaths.length}`,
  )
  if (files.includes(destination)) {
    const destinationName = portableBasename(destination)
    assert(
      destinationName !== 'package-manifest.json'
      && destinationName !== 'SHA256SUMS'
      && !/^package-smoke-.+\.json$/u.test(destinationName)
      && !isReleaseArtifactName(destinationName),
      'the output path must not overwrite release evidence',
    )
  }

  const manifestPaths = files.filter((path) => portableBasename(path) === 'package-manifest.json')
  const checksumPaths = files.filter((path) => portableBasename(path) === 'SHA256SUMS')
  assert(manifestPaths.length === PLATFORM_DEFINITIONS.length, `expected exactly ${PLATFORM_DEFINITIONS.length} package manifests, found ${manifestPaths.length}`)
  assert(checksumPaths.length === PLATFORM_DEFINITIONS.length, `expected exactly ${PLATFORM_DEFINITIONS.length} SHA256SUMS files, found ${checksumPaths.length}`)

  const appSmokePaths = []
  const harnessSmokePaths = []
  for (const path of files) {
    const name = portableBasename(path)
    if (/^package-smoke-harness-.+\.json$/u.test(name)) harnessSmokePaths.push(path)
    else if (/^package-smoke-.+\.json$/u.test(name)) appSmokePaths.push(path)
  }
  assert(appSmokePaths.length === PLATFORM_DEFINITIONS.length, `expected exactly ${PLATFORM_DEFINITIONS.length} app smoke reports, found ${appSmokePaths.length}`)
  assert(harnessSmokePaths.length === PLATFORM_DEFINITIONS.length, `expected exactly ${PLATFORM_DEFINITIONS.length} harness smoke reports, found ${harnessSmokePaths.length}`)

  const manifests = []
  for (const path of manifestPaths) {
    const label = portableRelativePath(evidenceRoot, path)
    const manifest = validateManifestShape(await readJson(path, label), label)
    manifests.push({
      arch: manifest.arch,
      label,
      manifest,
      path,
      platform: manifest.platform,
    })
  }
  const manifestsByPlatform = indexUniqueByPlatform(manifests, 'package manifest')

  const appSmokes = []
  for (const path of appSmokePaths) {
    const label = portableRelativePath(evidenceRoot, path)
    const report = requireRecord(await readJson(path, label), label)
    const app = requireRecord(report.app, `${label}.app`)
    appSmokes.push({ arch: app.arch, label, path, platform: app.platform, report })
  }
  const appSmokesByPlatform = indexUniqueByPlatform(appSmokes, 'app smoke report')

  const harnessSmokes = []
  for (const path of harnessSmokePaths) {
    const label = portableRelativePath(evidenceRoot, path)
    const report = requireRecord(await readJson(path, label), label)
    harnessSmokes.push({
      arch: report.arch,
      label,
      path,
      platform: report.platform,
      report,
    })
  }
  const harnessSmokesByPlatform = indexUniqueByPlatform(harnessSmokes, 'harness smoke report')

  const firstManifest = manifestsByPlatform.get(PLATFORM_DEFINITIONS[0].id).manifest
  const releaseIdentity = identityFromManifest(firstManifest)
  const platformQualifications = []
  const usedChecksumPaths = new Set()

  for (const definition of PLATFORM_DEFINITIONS) {
    const manifestEntry = manifestsByPlatform.get(definition.id)
    const appSmokeEntry = appSmokesByPlatform.get(definition.id)
    const harnessSmokeEntry = harnessSmokesByPlatform.get(definition.id)
    assert(
      portableBasename(appSmokeEntry.path) === `package-smoke-${definition.platform}-${definition.arch}.json`,
      `${definition.id} app smoke report has a non-canonical filename`,
    )
    assert(
      portableBasename(harnessSmokeEntry.path) === `package-smoke-harness-${definition.platform}-${definition.arch}.json`,
      `${definition.id} harness smoke report has a non-canonical filename`,
    )
    assert(
      dirname(appSmokeEntry.path) === dirname(harnessSmokeEntry.path),
      `${definition.id} app and harness smoke reports are not a paired evidence set`,
    )
    assertSameIdentity(releaseIdentity, identityFromManifest(manifestEntry.manifest), definition.id)
    const checksumPath = join(dirname(manifestEntry.path), 'SHA256SUMS')
    assert(checksumPaths.includes(checksumPath), `${definition.id} package manifest has no adjacent SHA256SUMS`)
    assert(!usedChecksumPaths.has(checksumPath), `${definition.id} reuses another platform's SHA256SUMS`)
    usedChecksumPaths.add(checksumPath)
    const artifacts = await validateArtifacts(
      manifestEntry.path,
      manifestEntry.manifest,
      definition,
      evidenceRoot,
    )
    const packageManifestSha256 = await sha256(manifestEntry.path)
    const { marker } = validateAppSmoke(
      appSmokeEntry.report,
      definition,
      manifestEntry.manifest,
      appSmokeEntry.label,
    )
    const sandbox = validateHarnessSmoke(
      harnessSmokeEntry.report,
      definition,
      marker,
      appSmokeEntry.path,
      packageManifestSha256,
      harnessSmokeEntry.label,
    )
    platformQualifications.push({
      arch: definition.arch,
      artifacts,
      evidence: {
        appSmoke: {
          path: portableRelativePath(evidenceRoot, appSmokeEntry.path),
          sha256: await sha256(appSmokeEntry.path),
        },
        harnessSmoke: {
          path: portableRelativePath(evidenceRoot, harnessSmokeEntry.path),
          sha256: await sha256(harnessSmokeEntry.path),
        },
        manifest: {
          path: portableRelativePath(evidenceRoot, manifestEntry.path),
          sha256: packageManifestSha256,
        },
        sha256sums: {
          path: portableRelativePath(evidenceRoot, checksumPath),
          sha256: await sha256(checksumPath),
        },
      },
      id: definition.id,
      platform: definition.platform,
      ...(sandbox ? { sandbox } : {}),
      status: 'passed',
    })
  }
  assert(usedChecksumPaths.size === checksumPaths.length, 'found an unpaired SHA256SUMS file')

  const qualification = {
    identity: releaseIdentity,
    platforms: platformQualifications,
    schemaVersion: 1,
    status: 'passed',
  }
  await mkdir(dirname(destination), { recursive: true })
  const temporaryPath = `${destination}.tmp-${process.pid}`
  try {
    await writeFile(temporaryPath, `${JSON.stringify(qualification, undefined, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    await rename(temporaryPath, destination)
  } finally {
    await rm(temporaryPath, { force: true })
  }
  return qualification
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined
if (invokedPath === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4) {
    console.error('Usage: node scripts/verify-release-matrix.mjs <evidence-root> <output-path>')
    process.exitCode = 1
  } else {
    try {
      const qualification = await verifyReleaseMatrix(process.argv[2], process.argv[3])
      console.log(`Release matrix qualified: ${qualification.platforms.map(({ id }) => id).join(', ')}`)
    } catch (error) {
      console.error(error instanceof Error ? error.message : error)
      process.exitCode = 1
    }
  }
}
