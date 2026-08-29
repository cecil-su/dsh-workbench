import { execFile } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'

import { PlatformError } from './store.js'

const GIT_TIMEOUT_MS = 5_000
const GIT_MAX_BUFFER = 256 * 1024

export interface RepositoryIdentity {
  canonicalRoot: string
  commonDirectory: string
  displayName: string
}

interface GitResult {
  stdout: string
  stderr: string
  exitCode: number
}

function pathKey(value: string): string {
  const normalized = resolve(value)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function pathInside(parent: string, child: string): boolean {
  const fromParent = relative(parent, child)
  return fromParent === '' || (
    fromParent !== '..'
    && !fromParent.startsWith(`..${sep}`)
    && !isAbsolute(fromParent)
  )
}

function runGit(cwd: string, args: readonly string[], signal?: AbortSignal): Promise<GitResult> {
  return new Promise((resolveResult, reject) => {
    execFile('git', [...args], {
      cwd,
      encoding: 'utf8',
      maxBuffer: GIT_MAX_BUFFER,
      shell: false,
      signal,
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error && (error as NodeJS.ErrnoException).code === 'ABORT_ERR') {
        reject(error)
        return
      }
      resolveResult({
        stdout: String(stdout).replaceAll('\r\n', '\n').trim(),
        stderr: String(stderr).replaceAll('\r\n', '\n').trim(),
        exitCode: typeof (error as { code?: unknown } | null)?.code === 'number'
          ? (error as unknown as { code: number }).code
          : error ? 1 : 0,
      })
    })
  })
}

function requireGit(result: GitResult, operation: string): string {
  if (result.exitCode !== 0 || !result.stdout) {
    throw new PlatformError(
      `Git ${operation} failed: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`,
      'NOT_GIT_REPOSITORY',
    )
  }
  return result.stdout
}

async function requireRealDirectory(path: string, label: string): Promise<string> {
  let info
  try {
    info = await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new PlatformError(`${label} does not exist`, 'PROJECT_NOT_FOUND')
    }
    throw error
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new PlatformError(`${label} must be a real directory`, 'UNSAFE_PATH')
  }
  return realpath(path)
}

export async function resolveRepository(
  workspaceRoot: string,
  value: string,
  signal?: AbortSignal,
): Promise<RepositoryIdentity> {
  const canonicalWorkspace = await requireRealDirectory(resolve(workspaceRoot), 'managed workspace')
  const candidate = await requireRealDirectory(resolve(canonicalWorkspace, value || '.'), 'Project directory')
  if (!pathInside(canonicalWorkspace, candidate)) {
    throw new PlatformError('Project directory escapes the managed workspace', 'UNSAFE_PATH')
  }

  const rootOutput = requireGit(
    await runGit(candidate, ['rev-parse', '--show-toplevel'], signal),
    'repository-root inspection',
  )
  const root = await requireRealDirectory(resolve(candidate, rootOutput), 'Git repository root')
  if (!pathInside(canonicalWorkspace, root)) {
    throw new PlatformError('Git repository root escapes the managed workspace', 'UNSAFE_PATH')
  }

  const commonOutput = requireGit(
    await runGit(root, ['rev-parse', '--git-common-dir'], signal),
    'common-directory inspection',
  )
  const commonDirectory = await requireRealDirectory(resolve(root, commonOutput), 'Git common directory')

  return {
    canonicalRoot: root,
    commonDirectory,
    displayName: basename(root),
  }
}

export interface RepositoryObservation {
  repositoryRoot: string
  worktree: string
  branch?: string
  head: string
  dirty: boolean
  sourceCommand: string
}

export async function observeRepository(repository: RepositoryIdentity, signal?: AbortSignal): Promise<RepositoryObservation> {
  const head = requireGit(await runGit(repository.canonicalRoot, ['rev-parse', 'HEAD'], signal), 'HEAD inspection')
  const branchResult = await runGit(repository.canonicalRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD'], signal)
  const statusResult = await runGit(repository.canonicalRoot, ['status', '--porcelain=v2', '--untracked-files=normal'], signal)
  if (statusResult.exitCode !== 0) throw new PlatformError(`Git status inspection failed: ${statusResult.stderr || `exit ${statusResult.exitCode}`}`, 'GIT_INSPECTION_FAILED')
  return {
    repositoryRoot: repository.canonicalRoot,
    worktree: repository.canonicalRoot,
    ...(branchResult.exitCode === 0 && branchResult.stdout ? { branch: branchResult.stdout } : {}),
    head,
    dirty: statusResult.stdout.length > 0,
    sourceCommand: 'git rev-parse HEAD; git symbolic-ref --quiet --short HEAD; git status --porcelain=v2 --untracked-files=normal',
  }
}

export function sameRepository(left: RepositoryIdentity, right: RepositoryIdentity): boolean {
  return pathKey(left.canonicalRoot) === pathKey(right.canonicalRoot)
    || pathKey(left.commonDirectory) === pathKey(right.commonDirectory)
}
