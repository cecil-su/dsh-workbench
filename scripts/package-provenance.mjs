import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { spawn } from 'node:child_process'

import {
  canonicalizeCompatibility,
  compatibilitySha256,
} from './compatibility.mjs'

const GIT_OUTPUT_LIMIT = 1024 * 1024
const GIT_SHA_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/

function sanitizedGitEnvironment(environment) {
  const safeEnvironment = Object.fromEntries(
    Object.entries(environment).filter(([name]) => !name.toUpperCase().startsWith('GIT_')),
  )
  safeEnvironment.GIT_OPTIONAL_LOCKS = '0'
  return safeEnvironment
}

function isPathAtOrInside(parent, child) {
  const pathFromParent = relative(parent, child)
  return pathFromParent === '' || (
    pathFromParent !== '..'
    && !pathFromParent.startsWith(`..${sep}`)
    && !isAbsolute(pathFromParent)
  )
}

async function resolveProjectFile(projectRoot, candidate, label) {
  const canonicalRoot = await realpath(resolve(projectRoot))
  const canonicalFile = await realpath(resolve(canonicalRoot, candidate))
  if (!isPathAtOrInside(canonicalRoot, canonicalFile) || canonicalFile === canonicalRoot) {
    throw new Error(`${label} must be a file inside the project root`)
  }
  if (!(await stat(canonicalFile)).isFile()) {
    throw new Error(`${label} must be a regular file`)
  }
  return canonicalFile
}

export async function sha256File(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

export const canonicalJson = canonicalizeCompatibility

export async function sha256CanonicalJson(path) {
  const serialized = await readFile(path, 'utf8')
  let parsed
  try {
    parsed = JSON.parse(serialized)
  } catch (error) {
    throw new Error(`Compatibility metadata is not valid JSON: ${error.message}`, { cause: error })
  }
  return compatibilitySha256(parsed)
}

function defaultGitCommand(projectRoot, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('git', args, {
      cwd: projectRoot,
      env: sanitizedGitEnvironment(process.env),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const stdout = []
    const stderr = []
    let stdoutLength = 0
    let stderrLength = 0
    let settled = false

    const fail = (error) => {
      if (settled) return
      settled = true
      child.kill()
      reject(error)
    }
    child.stdout.on('data', (chunk) => {
      stdoutLength += chunk.byteLength
      if (stdoutLength > GIT_OUTPUT_LIMIT) {
        fail(new Error('Git produced unexpectedly large standard output'))
        return
      }
      stdout.push(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderrLength += chunk.byteLength
      if (stderrLength > GIT_OUTPUT_LIMIT) {
        fail(new Error('Git produced unexpectedly large error output'))
        return
      }
      stderr.push(chunk)
    })
    child.once('error', fail)
    child.once('close', (code, signal) => {
      if (settled) return
      settled = true
      if (code !== 0) {
        const detail = Buffer.concat(stderr).toString('utf8').trim()
        reject(new Error(
          `git ${args[0]} failed with ${code ?? signal ?? 'an unknown status'}${detail ? `: ${detail}` : ''}`,
        ))
        return
      }
      resolvePromise(Buffer.concat(stdout).toString('utf8'))
    })
  })
}

export async function collectPackageProvenance({
  projectRoot,
  lockfilePath,
  compatibilityPath,
  // This callable injection exists for isolated unit tests. package.mjs never supplies it.
  gitCommand = defaultGitCommand,
}) {
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
    throw new TypeError('projectRoot must be a non-empty path')
  }
  const canonicalRoot = await realpath(resolve(projectRoot))
  const canonicalLockfile = await resolveProjectFile(
    canonicalRoot,
    lockfilePath ?? join(canonicalRoot, 'pnpm-lock.yaml'),
    'Lockfile',
  )
  const canonicalCompatibility = await resolveProjectFile(
    canonicalRoot,
    compatibilityPath ?? join(canonicalRoot, 'upstream', 'compatibility.json'),
    'Compatibility metadata',
  )

  const topLevelOutput = await gitCommand(canonicalRoot, ['rev-parse', '--show-toplevel'])
  if (typeof topLevelOutput !== 'string') throw new TypeError('Git command must return text')
  const topLevel = topLevelOutput.trim()
  if (topLevel === '') throw new Error('Git returned an empty repository root')
  let canonicalTopLevel
  try {
    canonicalTopLevel = await realpath(resolve(canonicalRoot, topLevel))
  } catch (error) {
    throw new Error('Git returned an invalid repository root', { cause: error })
  }
  if (canonicalTopLevel !== canonicalRoot) {
    throw new Error('Git repository root does not match the package project root')
  }

  const gitShaOutput = await gitCommand(canonicalRoot, ['rev-parse', '--verify', 'HEAD'])
  if (typeof gitShaOutput !== 'string') throw new TypeError('Git command must return text')
  const gitSha = gitShaOutput.trim()
  if (!GIT_SHA_PATTERN.test(gitSha)) {
    throw new Error('Git returned an invalid HEAD object ID')
  }
  const status = await gitCommand(canonicalRoot, [
    'status',
    '--porcelain=v1',
    '--untracked-files=normal',
  ])
  if (typeof status !== 'string') throw new TypeError('Git command must return text')

  const [lockfileSha256, compatibilitySha256] = await Promise.all([
    sha256File(canonicalLockfile),
    sha256CanonicalJson(canonicalCompatibility),
  ])
  return Object.freeze({
    compatibilitySha256,
    gitDirty: status.length !== 0,
    gitSha,
    lockfileSha256,
  })
}

export function assertPackagingModeProvenance(mode, provenance) {
  if (!['--artifacts', '--dir'].includes(mode)) {
    throw new Error(`Unsupported packaging mode: ${mode}`)
  }
  if (mode === '--artifacts' && provenance.gitDirty !== false) {
    throw new Error('Release artifact packaging requires a clean Git worktree')
  }
}
