import { spawn } from 'node:child_process'
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifestPath = join(root, 'dist', 'artifacts', 'package-manifest.json')
const smokeOutputDirectory = join(root, 'dist', 'smoke')
const MAX_OUTPUT_BYTES = 128 * 1024
const SMOKE_TIMEOUT_MS = 120_000
const TASKKILL_TIMEOUT_MS = 10_000
const UNSAFE_ELECTRON_ENVIRONMENT_KEYS = new Set([
  'ELECTRON_RUN_AS_NODE',
  'NODE_OPTIONS',
  'NODE_PATH',
])

function assertSmoke(condition, message) {
  if (!condition) throw new Error(message)
}

function isPathInside(parent, child) {
  const pathFromParent = relative(parent, child)
  return pathFromParent !== ''
    && pathFromParent !== '..'
    && !pathFromParent.startsWith(`..${sep}`)
    && !isAbsolute(pathFromParent)
}

function appendBounded(previous, chunk) {
  const combined = previous + chunk
  return combined.length <= MAX_OUTPUT_BYTES
    ? combined
    : combined.slice(combined.length - MAX_OUTPUT_BYTES)
}

function packageContainer(executable) {
  if (process.platform !== 'darwin') return dirname(executable)
  let current = dirname(executable)
  while (dirname(current) !== current) {
    if (current.endsWith('.app')) return current
    current = dirname(current)
  }
  throw new Error(`Packaged macOS executable is not inside an app bundle: ${executable}`)
}

function resourcesPathFor(executable) {
  return process.platform === 'darwin'
    ? join(dirname(dirname(executable)), 'Resources')
    : join(dirname(executable), 'resources')
}

async function extractArchive(archive, destination) {
  const invocation = process.platform === 'darwin'
    ? { args: ['-x', '-k', archive, destination], command: 'ditto' }
    : process.platform === 'win32'
      ? { args: ['-xf', archive, '-C', destination], command: 'tar.exe' }
      : { args: ['-q', archive, '-d', destination], command: 'unzip' }

  await new Promise((resolvePromise, reject) => {
    const child = spawn(invocation.command, invocation.args, { stdio: 'inherit' })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`Archive extraction exited with ${code ?? signal ?? 'an unknown status'}`))
    })
  })
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

async function runTaskkill(pid) {
  await new Promise((resolvePromise, reject) => {
    const killer = spawn('taskkill.exe', ['/pid', String(pid), '/t', '/f'], {
      stdio: 'ignore',
    })
    let settled = false
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (error) reject(error)
      else resolvePromise()
    }
    const timeout = setTimeout(() => {
      killer.kill()
      finish(new Error(`taskkill timed out after ${TASKKILL_TIMEOUT_MS} ms`))
    }, TASKKILL_TIMEOUT_MS)
    killer.once('error', finish)
    killer.once('close', (code, signal) => {
      if (code === 0 || !isProcessAlive(pid)) finish()
      else finish(new Error(`taskkill exited with ${code ?? signal ?? 'an unknown status'}`))
    })
  })
}

async function terminateProcessTree(pid, signal) {
  if (process.platform === 'win32') {
    await runTaskkill(pid)
    return
  }

  try {
    process.kill(-pid, signal)
  } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
}

function isProcessGroupAlive(pid) {
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

async function terminateTimedOutProcessTree(pid) {
  if (process.platform === 'win32') {
    await terminateProcessTree(pid, 'SIGKILL')
    return
  }

  await terminateProcessTree(pid, 'SIGTERM')
  const deadline = Date.now() + 5_000
  while (isProcessGroupAlive(pid) && Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
  }
  if (isProcessGroupAlive(pid)) {
    await terminateProcessTree(pid, 'SIGKILL')
    const forceDeadline = Date.now() + 2_000
    while (isProcessGroupAlive(pid) && Date.now() < forceDeadline) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50))
    }
    if (isProcessGroupAlive(pid)) throw new Error(`Process group ${pid} survived SIGKILL`)
  }
}

async function runPackagedApp(executable, args, cwd) {
  const useXvfb = process.platform === 'linux' && !process.env.DISPLAY
  const command = useXvfb ? 'xvfb-run' : executable
  const commandArgs = useXvfb ? ['-a', executable, ...args] : args
  const environment = { ...process.env }
  for (const key of Object.keys(environment)) {
    if (UNSAFE_ELECTRON_ENVIRONMENT_KEYS.has(key.toUpperCase())) delete environment[key]
  }

  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, commandArgs, {
      cwd,
      detached: process.platform !== 'win32',
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (error) reject(error)
      else resolvePromise(value)
    }

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout = appendBounded(stdout, chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr = appendBounded(stderr, chunk)
    })
    child.once('error', (error) => {
      finish(error)
    })

    const timeout = setTimeout(() => {
      timedOut = true
      if (!child.pid) {
        finish(undefined, {
          cleanupError: 'Packaged process has no PID for timeout cleanup',
          code: child.exitCode,
          signal: child.signalCode,
          stderr,
          stdout,
          timedOut,
        })
        return
      }

      void terminateTimedOutProcessTree(child.pid).then(
        () => finish(undefined, {
          code: child.exitCode,
          signal: child.signalCode,
          stderr,
          stdout,
          timedOut,
        }),
        (error) => finish(undefined, {
          cleanupError: asError(error).message,
          code: child.exitCode,
          signal: child.signalCode,
          stderr,
          stdout,
          timedOut,
        }),
      )
    }, SMOKE_TIMEOUT_MS)

    child.once('close', (code, signal) => {
      if (timedOut) return
      finish(undefined, { code, signal, stderr, stdout, timedOut })
    })
  })
}

function asError(error) {
  return error instanceof Error ? error : new Error(String(error))
}

function validateManifest(manifest) {
  assertSmoke(manifest.schemaVersion === 1, 'Unsupported package manifest schema')
  assertSmoke(manifest.platform === process.platform, 'Package manifest platform does not match the host')
  const expectedArch = process.env.DSH_WORKBENCH_EXPECTED_ARCH ?? process.arch
  assertSmoke(manifest.arch === expectedArch, `Expected ${expectedArch}, packaged ${manifest.arch}`)
  assertSmoke(typeof manifest.executable === 'string', 'Package manifest has no executable')
  assertSmoke(typeof manifest.resourcesPath === 'string', 'Package manifest has no resources path')
  assertSmoke(['artifacts', 'directory'].includes(manifest.mode), 'Package manifest has an invalid mode')
}

function validateReport(report, context) {
  assertSmoke(report.schemaVersion === 1, 'Unsupported package smoke report schema')
  assertSmoke(report.phase === 'verify', 'Package smoke did not complete the restart verification phase')
  assertSmoke(report.status === 'passed', report.error?.message ?? 'Packaged application reported failure')
  assertSmoke(report.app?.isPackaged === true, 'Electron did not identify the copied application as packaged')
  assertSmoke(report.app?.platform === process.platform, 'Smoke report platform does not match the host')
  assertSmoke(report.app?.arch === context.expectedArch, 'Smoke report architecture does not match the job')
  assertSmoke(report.runtime?.httpBootPayload === true, 'Packaged DSH HTTP boot was not verified')
  assertSmoke(report.runtime?.ptyOutputVerified === true, 'Packaged PTY output was not verified')
  assertSmoke(report.runtime?.ptyExitCode === 0, 'Packaged PTY did not exit with code zero')
  assertSmoke(report.runtime?.ptyPidAliveAfterExit === false, 'Packaged PTY process survived exit')
  assertSmoke(report.runtime?.windowLoaded === true, 'Packaged BrowserWindow load was not verified')
  assertSmoke(report.runtime?.windowSecurityVerified === true, 'Packaged BrowserWindow security was not verified')
  assertSmoke(report.runtime?.expectedExit === true, 'Packaged DSH shutdown was not expected')
  assertSmoke(report.runtime?.exitCode === 0, 'Packaged DSH did not exit with code zero')
  assertSmoke(report.runtime?.pidAliveAfterStop === false, 'Packaged DSH process survived shutdown')
  assertSmoke(report.runtime?.portOpenAfterStop === false, 'Packaged DSH port survived shutdown')
  assertSmoke(report.profiles?.activeProfileRestartPersistenceVerified === true, 'Packaged active profile did not survive restart')
  assertSmoke(report.profiles?.defaultPartitionContinuityVerified === true, 'Packaged default profile partition continuity was not verified')
  assertSmoke(report.profiles?.registryVerified === true, 'Packaged profile registry was not verified')
  assertSmoke(report.profiles?.legacyMigrationVerified === true, 'Packaged legacy profile migration was not verified')
  assertSmoke(report.profiles?.ambientCredentialFilteringVerified === true, 'Packaged ambient credential filtering was not verified')
  assertSmoke(report.profiles?.credentialIsolationVerified === true, 'Packaged credential isolation was not verified')
  assertSmoke(report.profiles?.dshHomeIsolationVerified === true, 'Packaged DSH home isolation was not verified')
  assertSmoke(report.profiles?.workspaceIsolationVerified === true, 'Packaged workspace isolation was not verified')
  assertSmoke(report.profiles?.runtimeSwitchVerified === true, 'Packaged profile runtime switching was not verified')
  assertSmoke(report.profiles?.browserPartitionIsolationVerified === true, 'Packaged browser partition isolation was not verified')
  assertSmoke(report.profiles?.browserPartitionRestartPersistenceVerified === true, 'Packaged browser partition restart persistence was not verified')
  assertSmoke(report.profiles?.rendererApiVerified === true, 'Packaged profile renderer API was not verified')
  assertSmoke(report.profiles?.rendererSelectVerified === true, 'Packaged renderer profile selection was not verified')
  assertSmoke(report.profiles?.profileUiMounted === true, 'Packaged Profiles UI was not verified')
  assertSmoke(report.profiles?.profileUiLifecycleVerified === true, 'Packaged Profiles UI lifecycle was not verified')
  assertSmoke(report.profiles?.clientBundleInBootPayload === true, 'Packaged profile client bundle was not verified')
  assertSmoke(report.authorization?.uiMounted === true, 'Packaged authorization UI was not verified')
  assertSmoke(report.authorization?.officialFlowRegistered === true, 'Packaged official authorization flow was not registered')
  assertSmoke(report.authorization?.valueFreeSnapshotVerified === true, 'Packaged authorization snapshot was not verified as value-free')

  const execPath = resolve(report.app.execPath)
  const resourcesPath = resolve(report.app.resourcesPath)
  const userDataPath = resolve(report.app.userDataPath)
  const runtimeCwd = resolve(report.runtime.cwd)
  const dshBin = resolve(report.runtime.dshBin)
  const desktopCoreEntry = resolve(report.runtime.desktopCoreEntry)
  const packagedAppPath = join(resourcesPath, 'app')
  assertSmoke(execPath === context.executable, 'Smoke process did not run the copied executable')
  assertSmoke(resourcesPath === context.resourcesPath, 'Smoke process used an unexpected resources directory')
  assertSmoke(isPathInside(packagedAppPath, dshBin), 'Smoke DSH executable escaped copied resources')
  assertSmoke(isPathInside(packagedAppPath, desktopCoreEntry), 'Smoke Desktop Core escaped copied resources')
  assertSmoke(isPathInside(context.temporaryRoot, userDataPath), 'Smoke user data was not isolated')
  assertSmoke(isPathInside(context.temporaryRoot, runtimeCwd), 'Smoke runtime cwd was not isolated')
  assertSmoke(!isPathInside(root, execPath), 'Packaged smoke executed inside the source checkout')
  assertSmoke(!isPathInside(root, dshBin), 'Packaged DSH resolved inside the source checkout')
  assertSmoke(!isPathInside(root, desktopCoreEntry), 'Packaged Desktop Core resolved inside the source checkout')
}

await mkdir(smokeOutputDirectory, { recursive: true })
const expectedArch = process.env.DSH_WORKBENCH_EXPECTED_ARCH ?? process.arch
const harnessReportPath = join(
  smokeOutputDirectory,
  `package-smoke-harness-${process.platform}-${expectedArch}.json`,
)
let result
let reportPath
let temporaryRoot
let failure
try {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  validateManifest(manifest)
  const originalExecutable = resolve(root, manifest.executable)
  const originalResourcesPath = resolve(root, manifest.resourcesPath)
  await Promise.all([access(originalExecutable), access(originalResourcesPath)])
  reportPath = join(
    smokeOutputDirectory,
    `package-smoke-${process.platform}-${manifest.arch}.json`,
  )
  await rm(reportPath, { force: true })
  temporaryRoot = await mkdtemp(join(tmpdir(), 'dsh-workbench-package-smoke-'))

  const originalContainer = packageContainer(originalExecutable)
  const installationDirectory = join(temporaryRoot, 'installation')
  await mkdir(installationDirectory, { recursive: true })

  let installedExecutable
  if (manifest.mode === 'artifacts') {
    const archivePath = manifest.artifacts
      .map((artifact) => resolve(root, artifact))
      .find((artifact) => artifact.endsWith('.zip'))
    assertSmoke(archivePath, 'Artifact manifest has no ZIP distribution')
    await access(archivePath)
    await extractArchive(archivePath, installationDirectory)
    installedExecutable = process.platform === 'darwin'
      ? join(
        installationDirectory,
        basename(originalContainer),
        relative(originalContainer, originalExecutable),
      )
      : join(installationDirectory, basename(originalExecutable))
  } else {
    const copiedContainer = join(installationDirectory, basename(originalContainer))
    await cp(originalContainer, copiedContainer, {
      recursive: true,
      verbatimSymlinks: true,
    })
    installedExecutable = join(
      copiedContainer,
      relative(originalContainer, originalExecutable),
    )
  }

  const executable = await realpath(installedExecutable)
  const resourcesPath = await realpath(resourcesPathFor(executable))
  const cwd = join(temporaryRoot, 'cwd')
  const userDataPath = join(temporaryRoot, 'user-data')
  await Promise.all([
    mkdir(cwd, { recursive: true }),
    mkdir(userDataPath, { recursive: true }),
  ])
  const legacyDshHome = join(userDataPath, 'dsh')
  const legacyWorkspace = join(userDataPath, 'workspace')
  await Promise.all([
    mkdir(legacyDshHome, { recursive: true }),
    mkdir(legacyWorkspace, { recursive: true }),
  ])
  await Promise.all([
    writeFile(join(legacyDshHome, 'package-smoke-dsh-sentinel'), 'first', { mode: 0o600 }),
    writeFile(join(legacyWorkspace, 'package-smoke-workspace-sentinel'), 'first', { mode: 0o600 }),
  ])

  result = await runPackagedApp(executable, [
    `--dsh-workbench-smoke-report=${reportPath}`,
    '--dsh-workbench-smoke-phase=setup',
    `--dsh-workbench-smoke-user-data=${userDataPath}`,
  ], cwd)
  assertSmoke(!result.timedOut, `Packaged smoke setup timed out after ${SMOKE_TIMEOUT_MS} ms`)
  assertSmoke(result.code === 0, `Packaged smoke setup exited with ${result.code ?? result.signal}`)
  assertSmoke(result.stdout.includes('DSH_WORKBENCH_PACKAGE_SMOKE_OK'), 'Packaged smoke setup success marker is missing')

  result = await runPackagedApp(executable, [
    `--dsh-workbench-smoke-report=${reportPath}`,
    '--dsh-workbench-smoke-phase=verify',
    `--dsh-workbench-smoke-user-data=${userDataPath}`,
  ], cwd)
  assertSmoke(!result.timedOut, `Packaged smoke timed out after ${SMOKE_TIMEOUT_MS} ms`)
  assertSmoke(result.code === 0, `Packaged smoke exited with ${result.code ?? result.signal}`)
  assertSmoke(result.stdout.includes('DSH_WORKBENCH_PACKAGE_SMOKE_OK'), 'Packaged smoke success marker is missing')

  const report = JSON.parse(await readFile(reportPath, 'utf8'))
  validateReport(report, {
    executable,
    expectedArch,
    resourcesPath,
    temporaryRoot,
  })
} catch (error) {
  failure = asError(error)
  if (result?.stdout) console.error(`Packaged smoke stdout:\n${result.stdout}`)
  if (result?.stderr) console.error(`Packaged smoke stderr:\n${result.stderr}`)
} finally {
  const harnessReport = {
    appReportPath: reportPath,
    error: failure ? { message: failure.message, name: failure.name } : undefined,
    platform: process.platform,
    arch: expectedArch,
    process: result ? {
      code: result.code,
      cleanupError: result.cleanupError,
      signal: result.signal,
      stderr: result.stderr,
      stdout: result.stdout,
      timedOut: result.timedOut,
    } : undefined,
    schemaVersion: 1,
    status: failure ? 'failed' : 'passed',
  }
  await writeFile(harnessReportPath, `${JSON.stringify(harnessReport, undefined, 2)}\n`, 'utf8')
  if (temporaryRoot) {
    await rm(temporaryRoot, { force: true, maxRetries: 3, recursive: true, retryDelay: 250 })
  }
}

if (failure) throw failure
console.log(`Packaged smoke passed: ${reportPath}`)
