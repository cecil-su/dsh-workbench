import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  access,
  cp,
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
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'

import { build, Platform } from 'electron-builder'

import baseConfig from '../electron-builder.config.mjs'
import {
  assertPackagingModeProvenance,
  collectPackageProvenance,
} from './package-provenance.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const distRoot = join(root, 'dist')
const stageDir = join(distRoot, 'package-stage')
const outputDir = join(distRoot, 'artifacts')
const releaseUploadDir = join(distRoot, 'release-upload')
const mode = process.argv.slice(2)
const configuredElectronDist = process.env.DSH_WORKBENCH_ELECTRON_DIST?.trim()

if (mode.length !== 1 || !['--artifacts', '--dir'].includes(mode[0])) {
  throw new Error('Usage: node scripts/package.mjs --dir|--artifacts')
}

function isPathInside(parent, child) {
  const pathFromParent = relative(parent, child)
  return pathFromParent !== ''
    && pathFromParent !== '..'
    && !pathFromParent.startsWith(`..${sep}`)
    && !isAbsolute(pathFromParent)
}

function assertGeneratedPath(path, expectedName) {
  if (dirname(path) !== distRoot || path !== join(distRoot, expectedName)) {
    throw new Error(`Refusing to replace unsafe build path: ${path}`)
  }
}

async function resetBuildDirectories() {
  assertGeneratedPath(stageDir, 'package-stage')
  assertGeneratedPath(outputDir, 'artifacts')
  assertGeneratedPath(releaseUploadDir, 'release-upload')
  await rm(stageDir, { force: true, recursive: true })
  await rm(outputDir, { force: true, recursive: true })
  await rm(releaseUploadDir, { force: true, recursive: true })
  await mkdir(distRoot, { recursive: true })
}

function pnpmInvocation(args) {
  const npmExecPath = process.env.npm_execpath
  if (npmExecPath && npmExecPath.toLowerCase().includes('pnpm')) {
    return { args: [npmExecPath, ...args], command: process.execPath }
  }
  return {
    args,
    command: process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
  }
}

async function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: { ...process.env, CI: 'true' },
      stdio: options.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    })
    let stdout = ''
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => {
      stdout += chunk
    })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0) {
        resolvePromise(stdout.trim())
        return
      }
      reject(new Error(`${command} exited with ${code ?? signal ?? 'an unknown status'}`))
    })
  })
}

async function deployProductionApp() {
  const invocation = pnpmInvocation([
    '--config.inject-workspace-packages=true',
    '--config.node-linker=hoisted',
    '--filter',
    '@dsh-workbench/desktop',
    '--prod',
    'deploy',
    stageDir,
  ])
  await run(invocation.command, invocation.args)
}

function installedPackageManifestPath(appRoot, packageName) {
  return join(appRoot, 'node_modules', ...packageName.split('/'), 'package.json')
}

async function firstPartyManifestPaths(appRoot) {
  const paths = [join(appRoot, 'package.json')]
  const scopeDirectory = join(appRoot, 'node_modules', '@dsh-workbench')
  const entries = await readdir(scopeDirectory, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isDirectory() || entry.isSymbolicLink()) {
      paths.push(join(scopeDirectory, entry.name, 'package.json'))
    }
  }
  return paths
}

async function exactInstalledDependencies(appRoot, dependencies) {
  if (!dependencies) return dependencies
  const exact = {}
  for (const packageName of Object.keys(dependencies).sort()) {
    const installed = await readJson(installedPackageManifestPath(appRoot, packageName))
    if (typeof installed.version !== 'string' || installed.version === '') {
      throw new Error(`Installed dependency ${packageName} has no version`)
    }
    exact[packageName] = installed.version
  }
  return exact
}

async function sanitizeProductionManifests(appRoot) {
  for (const manifestPath of await firstPartyManifestPaths(appRoot)) {
    const resolvedManifestPath = await realpath(manifestPath)
    if (!isPathInside(appRoot, resolvedManifestPath)) {
      throw new Error(`Production manifest escapes the deployment tree: ${manifestPath}`)
    }
    const manifest = await readJson(manifestPath)
    manifest.dependencies = await exactInstalledDependencies(appRoot, manifest.dependencies)
    manifest.optionalDependencies = await exactInstalledDependencies(
      appRoot,
      manifest.optionalDependencies,
    )
    delete manifest.devDependencies
    delete manifest.scripts
    const temporaryPath = `${manifestPath}.sanitized-${process.pid}`
    await writeFile(temporaryPath, `${JSON.stringify(manifest, undefined, 2)}\n`, 'utf8')
    await rename(temporaryPath, manifestPath)
  }
}

async function removePnpmDeploymentMetadata(appRoot) {
  await Promise.all([
    rm(join(appRoot, 'node_modules', '.modules.yaml'), { force: true }),
    rm(join(appRoot, 'node_modules', '.pnpm'), { force: true, recursive: true }),
    rm(join(appRoot, 'node_modules', '.pnpm-workspace-state-v1.json'), { force: true }),
  ])
}

async function fileContainsAny(path, needles) {
  const maximumNeedleLength = Math.max(...needles.map((needle) => needle.byteLength))
  let tail = Buffer.alloc(0)
  for await (const chunk of createReadStream(path)) {
    const combined = Buffer.concat([tail, chunk])
    if (needles.some((needle) => combined.indexOf(needle) !== -1)) return true
    tail = combined.subarray(Math.max(0, combined.byteLength - maximumNeedleLength + 1))
  }
  return false
}

async function validateNoSourceCheckoutReferences(path) {
  const needles = [Buffer.from(root), Buffer.from(pathToFileURL(root).href)]
  const pathStat = await lstat(path)
  if (pathStat.isFile()) {
    if (await fileContainsAny(path, needles)) {
      throw new Error(`Packaged file exposes the source checkout: ${path}`)
    }
    return
  }
  if (!pathStat.isDirectory()) return

  const entries = await readdir(path, { withFileTypes: true })
  for (const entry of entries) {
    const childPath = join(path, entry.name)
    if (entry.isDirectory()) {
      await validateNoSourceCheckoutReferences(childPath)
    } else if (entry.isFile() && await fileContainsAny(childPath, needles)) {
      throw new Error(`Packaged file exposes the source checkout: ${childPath}`)
    }
  }
}

async function validateProductionManifests(appRoot) {
  const checkoutUrl = pathToFileURL(root).href
  for (const manifestPath of await firstPartyManifestPaths(appRoot)) {
    const serialized = await readFile(manifestPath, 'utf8')
    if (/(?:file|workspace|catalog):/i.test(serialized)) {
      throw new Error(`Production manifest contains a local dependency protocol: ${manifestPath}`)
    }
    if (serialized.includes(root) || serialized.includes(checkoutUrl)) {
      throw new Error(`Production manifest exposes the source checkout: ${manifestPath}`)
    }

    const manifest = JSON.parse(serialized)
    if (manifest.scripts || manifest.devDependencies) {
      throw new Error(`Production manifest retains development-only fields: ${manifestPath}`)
    }
    for (const group of [manifest.dependencies, manifest.optionalDependencies]) {
      for (const [packageName, version] of Object.entries(group ?? {})) {
        const installed = await readJson(installedPackageManifestPath(appRoot, packageName))
        if (version !== installed.version) {
          throw new Error(`Production dependency ${packageName} is not pinned to its installed version`)
        }
      }
    }
  }
}

async function validateSymlinks(directory, allowedRoot) {
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isSymbolicLink()) {
      const target = await realpath(path)
      if (!isPathInside(allowedRoot, target)) {
        throw new Error(`Symlink escapes its packaged dependency tree: ${path} -> ${target}`)
      }
    } else if (entry.isDirectory()) {
      await validateSymlinks(path, allowedRoot)
    }
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function validateStage() {
  const dshBin = join(stageDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const directoryPickerWorker = join(
    stageDir,
    'node_modules',
    '@deepseek-ai',
    'dsh-host-directory-picker-native',
    'lib',
    'worker.cjs',
  )
  const directoryPickerWorkerIpc = join(
    stageDir,
    'node_modules',
    '@deepseek-ai',
    'dsh-host-directory-picker-native',
    'lib',
    'worker-ipc.cjs',
  )
  const subprocessLocal = join(
    stageDir,
    'node_modules',
    '@deepseek-ai',
    'dsh-subprocess-local',
    'lib',
    'index.js',
  )
  const desktopCore = join(stageDir, 'node_modules', '@dsh-workbench', 'desktop-core', 'lib', 'index.js')
  const desktopCoreClient = join(stageDir, 'node_modules', '@dsh-workbench', 'desktop-core', 'lib', 'client.js')
  const oauthUi = join(stageDir, 'node_modules', '@dsh-workbench', 'oauth-ui', 'lib', 'index.js')
  const oauthUiClient = join(stageDir, 'node_modules', '@dsh-workbench', 'oauth-ui', 'lib', 'client.js')
  const diagnosticsUi = join(stageDir, 'node_modules', '@dsh-workbench', 'diagnostics-ui', 'lib', 'index.js')
  const diagnosticsUiClient = join(stageDir, 'node_modules', '@dsh-workbench', 'diagnostics-ui', 'lib', 'client.js')
  await Promise.all([
    access(join(stageDir, 'lib', 'main.js')),
    access(join(stageDir, 'lib', 'preload.cjs')),
    access(dshBin),
    access(directoryPickerWorker),
    access(directoryPickerWorkerIpc),
    access(subprocessLocal),
    access(desktopCore),
    access(desktopCoreClient),
    access(oauthUi),
    access(oauthUiClient),
    access(diagnosticsUi),
    access(diagnosticsUiClient),
  ])
  await validateSymlinks(stageDir, stageDir)
  return readJson(join(dirname(dirname(dshBin)), 'package.json'))
}

async function findPackagedExecutable() {
  const outputEntries = await readdir(outputDir, { withFileTypes: true })
  const unpackedDirectories = outputEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(outputDir, entry.name))

  if (process.platform === 'darwin') {
    for (const directory of unpackedDirectories) {
      const entries = await readdir(directory, { withFileTypes: true })
      const appBundle = entries.find((entry) => entry.isDirectory() && entry.name.endsWith('.app'))
      if (!appBundle) continue
      const executablesDirectory = join(directory, appBundle.name, 'Contents', 'MacOS')
      const executables = await readdir(executablesDirectory, { withFileTypes: true })
      const executable = executables.find((entry) => entry.isFile() && (
        entry.name === 'dsh-workbench' || entry.name === 'DSH Workbench'
      )) ?? executables.find((entry) => entry.isFile())
      if (executable) return join(executablesDirectory, executable.name)
    }
  } else {
    const executableName = process.platform === 'win32' ? 'dsh-workbench.exe' : 'dsh-workbench'
    for (const directory of unpackedDirectories) {
      const candidate = join(directory, executableName)
      try {
        const candidateStat = await lstat(candidate)
        if (candidateStat.isFile()) return candidate
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
    }
  }

  throw new Error(`Unable to find the packaged executable in ${outputDir}`)
}

function resourcesPathFor(executable) {
  return process.platform === 'darwin'
    ? join(dirname(dirname(executable)), 'Resources')
    : join(dirname(executable), 'resources')
}

function projectRelative(path) {
  const projectPath = relative(root, path)
  if (projectPath === '' || projectPath === '..' || projectPath.startsWith(`..${sep}`)) {
    throw new Error(`Generated path escaped the project: ${path}`)
  }
  return projectPath.split(sep).join('/')
}

async function sha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function isReleaseArtifact(name) {
  return name.endsWith('.dmg')
    || name.endsWith('.zip')
    || name.endsWith('.exe')
    || name.endsWith('.AppImage')
    || name.endsWith('.tar.gz')
}

async function listReleaseArtifacts() {
  const entries = await readdir(outputDir, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && isReleaseArtifact(entry.name))
    .map((entry) => join(outputDir, entry.name))
    .sort()
}

async function writeChecksums(artifacts) {
  const lines = []
  for (const artifact of artifacts) {
    lines.push(`${await sha256(artifact)}  ${artifact.split(sep).at(-1)}`)
  }
  await writeFile(join(outputDir, 'SHA256SUMS'), `${lines.join('\n')}\n`, 'utf8')
}

function expectedArtifactSuffixes() {
  if (process.platform === 'darwin') return ['.dmg', '.zip']
  if (process.platform === 'win32') return ['.exe', '.zip']
  return ['.AppImage', '.tar.gz', '.zip']
}

function validateReleaseArtifactSet(artifacts) {
  const expectedSuffixes = expectedArtifactSuffixes()
  if (artifacts.length !== expectedSuffixes.length) {
    throw new Error(
      `Expected ${expectedSuffixes.length} release artifacts, found ${artifacts.length}`,
    )
  }
  for (const suffix of expectedSuffixes) {
    const matches = artifacts.filter((artifact) => artifact.endsWith(suffix))
    if (matches.length !== 1) {
      throw new Error(`Expected exactly one ${suffix} release artifact, found ${matches.length}`)
    }
  }
}

async function verifyChecksums(artifacts) {
  const checksumPath = join(outputDir, 'SHA256SUMS')
  const lines = (await readFile(checksumPath, 'utf8')).trim().split('\n')
  if (lines.length !== artifacts.length) {
    throw new Error('SHA256SUMS does not cover the complete release artifact set')
  }

  const expectedNames = new Set(artifacts.map((artifact) => artifact.split(sep).at(-1)))
  for (const line of lines) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line)
    if (!match) throw new Error(`Invalid SHA256SUMS entry: ${line}`)
    const [, expectedHash, name] = match
    if (!name || !expectedNames.delete(name)) {
      throw new Error(`SHA256SUMS contains an unexpected artifact: ${name ?? line}`)
    }
    const actualHash = await sha256(join(outputDir, name))
    if (actualHash !== expectedHash) throw new Error(`Checksum verification failed for ${name}`)
  }
  if (expectedNames.size !== 0) throw new Error('SHA256SUMS is missing a release artifact')
}

async function prepareReleaseUpload(artifacts, packageManifestPath) {
  await mkdir(releaseUploadDir, { recursive: true })
  await Promise.all([
    ...artifacts.map((artifact) => (
      cp(artifact, join(releaseUploadDir, artifact.split(sep).at(-1)))
    )),
    cp(packageManifestPath, join(releaseUploadDir, 'package-manifest.json')),
    cp(join(outputDir, 'SHA256SUMS'), join(releaseUploadDir, 'SHA256SUMS')),
  ])
  const uploadedManifestPath = join(releaseUploadDir, 'package-manifest.json')
  if (await sha256(packageManifestPath) !== await sha256(uploadedManifestPath)) {
    throw new Error('Release-upload package manifest does not match the artifact manifest')
  }
}

const provenance = await collectPackageProvenance({ projectRoot: root })
assertPackagingModeProvenance(mode[0], provenance)

await resetBuildDirectories()
await deployProductionApp()
await validateSymlinks(stageDir, stageDir)
await removePnpmDeploymentMetadata(stageDir)
await sanitizeProductionManifests(stageDir)
await validateProductionManifests(stageDir)
await Promise.all([
  validateNoSourceCheckoutReferences(join(stageDir, 'package.json')),
  validateNoSourceCheckoutReferences(join(stageDir, 'lib')),
  validateNoSourceCheckoutReferences(join(stageDir, 'node_modules')),
])
const dshPackage = await validateStage()

const config = {
  ...baseConfig,
  ...(configuredElectronDist ? { electronDist: configuredElectronDist } : {}),
  afterPack: async (context) => {
    const resourcesPath = process.platform === 'darwin'
      ? join(
        context.appOutDir,
        `${context.packager.appInfo.productFilename}.app`,
        'Contents',
        'Resources',
      )
      : join(context.appOutDir, 'resources')
    const packagedNodeModules = join(resourcesPath, 'app', 'node_modules')
    await rm(packagedNodeModules, { force: true, recursive: true })
    await cp(join(stageDir, 'node_modules'), packagedNodeModules, {
      recursive: true,
      verbatimSymlinks: true,
    })
    await validateSymlinks(packagedNodeModules, packagedNodeModules)
    await validateProductionManifests(join(resourcesPath, 'app'))
    await validateNoSourceCheckoutReferences(join(resourcesPath, 'app'))
  },
  directories: {
    output: outputDir,
  },
}
const buildOptions = {
  config,
  projectDir: stageDir,
  publish: 'never',
  ...(mode[0] === '--dir' ? { targets: Platform.current().createTarget('dir') } : {}),
}
await build(buildOptions)

const executable = await findPackagedExecutable()
const resourcesPath = resourcesPathFor(executable)
const packagedAppPath = join(resourcesPath, 'app')
await Promise.all([
  access(join(packagedAppPath, 'lib', 'main.js')),
  access(join(packagedAppPath, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')),
  access(join(
    packagedAppPath,
    'node_modules',
    '@deepseek-ai',
    'dsh-host-directory-picker-native',
    'lib',
    'worker.cjs',
  )),
  access(join(
    packagedAppPath,
    'node_modules',
    '@deepseek-ai',
    'dsh-host-directory-picker-native',
    'lib',
    'worker-ipc.cjs',
  )),
  access(join(
    packagedAppPath,
    'node_modules',
    '@deepseek-ai',
    'dsh-subprocess-local',
    'lib',
    'index.js',
  )),
  access(join(packagedAppPath, 'node_modules', '@dsh-workbench', 'desktop-core', 'lib', 'index.js')),
])
await validateSymlinks(join(packagedAppPath, 'node_modules'), join(packagedAppPath, 'node_modules'))
await validateProductionManifests(packagedAppPath)
await validateNoSourceCheckoutReferences(packagedAppPath)

const artifacts = await listReleaseArtifacts()
if (mode[0] === '--artifacts' && artifacts.length === 0) {
  throw new Error('electron-builder did not produce any release artifacts')
}
if (mode[0] === '--artifacts') validateReleaseArtifactSet(artifacts)

const builderPackage = await readJson(join(root, 'node_modules', 'electron-builder', 'package.json'))
const manifest = {
  appPath: projectRelative(packagedAppPath),
  arch: process.arch,
  artifacts: artifacts.map(projectRelative),
  electronVersion: baseConfig.electronVersion,
  electronBuilderVersion: builderPackage.version,
  executable: projectRelative(executable),
  compatibilitySha256: provenance.compatibilitySha256,
  gitDirty: provenance.gitDirty,
  gitSha: provenance.gitSha,
  lockfileSha256: provenance.lockfileSha256,
  mode: mode[0] === '--dir' ? 'directory' : 'artifacts',
  platform: process.platform,
  resourcesPath: projectRelative(resourcesPath),
  schemaVersion: 2,
  versions: {
    desktop: (await readJson(join(stageDir, 'package.json'))).version,
    dsh: dshPackage.version,
  },
}
const packageManifestPath = join(outputDir, 'package-manifest.json')
await writeFile(
  packageManifestPath,
  `${JSON.stringify(manifest, undefined, 2)}\n`,
  'utf8',
)
if (mode[0] === '--artifacts') {
  await writeChecksums(artifacts)
  await verifyChecksums(artifacts)
  await prepareReleaseUpload(artifacts, packageManifestPath)
}

console.log(`Packaged executable: ${executable}`)
