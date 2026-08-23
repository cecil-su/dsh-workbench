import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { promisify } from 'node:util'

import {
  assertPackagingModeProvenance,
  canonicalJson,
  collectPackageProvenance,
  sha256CanonicalJson,
  sha256File,
} from './package-provenance.mjs'

const temporaryDirectories = []
const execFileAsync = promisify(execFile)

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => (
    rm(path, { force: true, recursive: true })
  )))
})

async function fixture() {
  const projectRoot = await mkdtemp(join(tmpdir(), 'dsh-package-provenance-'))
  temporaryDirectories.push(projectRoot)
  await mkdir(join(projectRoot, 'upstream'))
  await writeFile(join(projectRoot, 'pnpm-lock.yaml'), 'lockfile\n', 'utf8')
  await writeFile(
    join(projectRoot, 'upstream', 'compatibility.json'),
    '{\n  "z": [3, { "b": true, "a": null }],\n  "a": "value"\n}\n',
    'utf8',
  )
  return projectRoot
}

async function initializeGitRepository(projectRoot) {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('GIT_')),
  )
  await execFileAsync('git', ['init', '--quiet'], { cwd: projectRoot, env: environment })
  await execFileAsync('git', ['add', 'pnpm-lock.yaml', 'upstream/compatibility.json'], {
    cwd: projectRoot,
    env: environment,
  })
  await execFileAsync('git', [
    '-c',
    'user.name=DSH Workbench test',
    '-c',
    'user.email=test@invalid.example',
    'commit',
    '--quiet',
    '-m',
    'fixture',
  ], { cwd: projectRoot, env: environment })
  return (await execFileAsync('git', ['rev-parse', 'HEAD'], {
    cwd: projectRoot,
    env: environment,
  })).stdout.trim()
}

describe('package provenance', () => {
  it('canonicalizes object keys recursively while preserving array order', () => {
    assert.equal(
      canonicalJson({ z: [3, { b: true, a: null }], a: 'value' }),
      '{"a":"value","z":[3,{"a":null,"b":true}]}',
    )
    assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]))
  })

  it('hashes semantically identical compatibility JSON to the same identity', async () => {
    const projectRoot = await fixture()
    const firstPath = join(projectRoot, 'upstream', 'compatibility.json')
    const secondPath = join(projectRoot, 'upstream', 'equivalent.json')
    await writeFile(secondPath, '{"a":"value","z":[3,{"a":null,"b":true}]}', 'utf8')

    assert.equal(await sha256CanonicalJson(firstPath), await sha256CanonicalJson(secondPath))
  })

  it('hashes raw lockfile bytes under the repository LF checkout policy', async () => {
    const projectRoot = await fixture()
    const lockfilePath = join(projectRoot, 'pnpm-lock.yaml')
    const lfHash = await sha256File(lockfilePath)
    await writeFile(lockfilePath, 'lockfile\r\n', 'utf8')
    const crlfHash = await sha256File(lockfilePath)

    assert.equal(lfHash, createHash('sha256').update('lockfile\n').digest('hex'))
    assert.equal(crlfHash, createHash('sha256').update('lockfile\r\n').digest('hex'))
    assert.notEqual(crlfHash, lfHash)
  })

  it('collects the exact Git, lockfile, and compatibility identities', async () => {
    const projectRoot = await fixture()
    const calls = []
    const gitSha = '1'.repeat(40)
    const provenance = await collectPackageProvenance({
      projectRoot,
      gitCommand: async (cwd, args) => {
        calls.push({ args, cwd })
        if (args[1] === '--show-toplevel') return `${projectRoot}\n`
        return args[1] === '--verify' ? `${gitSha}\n` : ''
      },
    })

    assert.deepEqual(provenance, {
      compatibilitySha256: createHash('sha256')
        .update('{"a":"value","z":[3,{"a":null,"b":true}]}')
        .digest('hex'),
      gitDirty: false,
      gitSha,
      lockfileSha256: createHash('sha256').update('lockfile\n').digest('hex'),
    })
    assert.deepEqual(calls.map(({ args }) => args), [
      ['rev-parse', '--show-toplevel'],
      ['rev-parse', '--verify', 'HEAD'],
      ['status', '--porcelain=v1', '--untracked-files=normal'],
    ])
    const canonicalProjectRoot = await realpath(projectRoot)
    assert.ok(calls.every(({ cwd }) => cwd === canonicalProjectRoot))
  })

  it('records dirty directory packages and rejects dirty artifact packages', async () => {
    const projectRoot = await fixture()
    const provenance = await collectPackageProvenance({
      projectRoot,
      gitCommand: async (_cwd, args) => {
        if (args[1] === '--show-toplevel') return `${projectRoot}\n`
        return args[1] === '--verify'
          ? `${'a'.repeat(64)}\n`
          : ' M scripts/package.mjs\n'
      },
    })

    assert.equal(provenance.gitDirty, true)
    assert.doesNotThrow(() => assertPackagingModeProvenance('--dir', provenance))
    assert.throws(
      () => assertPackagingModeProvenance('--artifacts', provenance),
      /requires a clean Git worktree/,
    )
  })

  it('rejects project metadata paths that escape the repository', async () => {
    const projectRoot = await fixture()
    const outsideRoot = await mkdtemp(join(tmpdir(), 'dsh-package-provenance-outside-'))
    temporaryDirectories.push(outsideRoot)
    const outsideLockfile = join(outsideRoot, 'pnpm-lock.yaml')
    await writeFile(outsideLockfile, 'outside\n', 'utf8')

    await assert.rejects(
      collectPackageProvenance({
        projectRoot,
        lockfilePath: outsideLockfile,
        gitCommand: async (_cwd, args) => (
          args[0] === 'rev-parse' ? `${'b'.repeat(40)}\n` : ''
        ),
      }),
      /Lockfile must be a file inside the project root/,
    )
  })

  it('rejects malformed Git object IDs', async () => {
    const projectRoot = await fixture()
    await assert.rejects(
      collectPackageProvenance({
        projectRoot,
        gitCommand: async (_cwd, args) => (
          args[1] === '--show-toplevel' ? `${projectRoot}\n` : 'HEAD\n'
        ),
      }),
      /invalid HEAD object ID/,
    )
  })

  it('rejects a Git repository root that differs from the project root', async () => {
    const projectRoot = await fixture()
    const otherRoot = await fixture()
    await assert.rejects(
      collectPackageProvenance({
        projectRoot,
        gitCommand: async (_cwd, args) => (
          args[1] === '--show-toplevel' ? `${otherRoot}\n` : `${'c'.repeat(40)}\n`
        ),
      }),
      /repository root does not match the package project root/,
    )
  })

  it('ignores inherited Git redirection variables when checking the worktree', async () => {
    const dirtyRoot = await fixture()
    const cleanRoot = await fixture()
    const dirtySha = await initializeGitRepository(dirtyRoot)
    await initializeGitRepository(cleanRoot)
    await writeFile(join(dirtyRoot, 'untracked-source.js'), 'dirty\n', 'utf8')

    const redirectedVariables = {
      GIT_DIR: join(cleanRoot, '.git'),
      GIT_INDEX_FILE: join(cleanRoot, '.git', 'index'),
      GIT_WORK_TREE: cleanRoot,
    }
    const previousValues = Object.fromEntries(
      Object.keys(redirectedVariables).map((name) => [name, process.env[name]]),
    )
    try {
      Object.assign(process.env, redirectedVariables)
      const provenance = await collectPackageProvenance({ projectRoot: dirtyRoot })
      assert.equal(provenance.gitSha, dirtySha)
      assert.equal(provenance.gitDirty, true)
      assert.throws(
        () => assertPackagingModeProvenance('--artifacts', provenance),
        /requires a clean Git worktree/,
      )
    } finally {
      for (const [name, value] of Object.entries(previousValues)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })
})
