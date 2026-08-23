import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { verifyReleaseMatrix } from './verify-release-matrix.mjs'

const PLATFORMS = [
  {
    arch: 'x64',
    artifacts: ['DSH-Workbench.AppImage', 'DSH-Workbench-linux.tar.gz', 'DSH-Workbench-linux.zip'],
    id: 'linux-x64',
    platform: 'linux',
  },
  {
    arch: 'arm64',
    artifacts: ['DSH-Workbench-arm64.dmg', 'DSH-Workbench-macos.zip'],
    id: 'macos-arm64',
    platform: 'darwin',
  },
  {
    arch: 'x64',
    artifacts: ['DSH-Workbench-setup.exe', 'DSH-Workbench-windows.zip'],
    id: 'windows-x64',
    platform: 'win32',
  },
]

const TRUE_AUTHORIZATION_FIELDS = [
  'officialFlowRegistered',
  'uiMounted',
  'valueFreeSnapshotVerified',
]

const TRUE_DIAGNOSTIC_FIELDS = [
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
]

const TRUE_PROFILE_FIELDS = [
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
]

function trueFields(fields) {
  return Object.fromEntries(fields.map((field) => [field, true]))
}

function hash(content) {
  return createHash('sha256').update(content).digest('hex')
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, undefined, 2)}\n`, 'utf8')
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

function createAppSmoke(definition, marker) {
  return {
    app: {
      arch: definition.arch,
      electronVersion: '38.4.0',
      isPackaged: true,
      platform: definition.platform,
      version: '0.1.0',
    },
    authorization: trueFields(TRUE_AUTHORIZATION_FIELDS),
    diagnostics: {
      ...trueFields(TRUE_DIAGNOSTIC_FIELDS),
      outputPipelineMarker: marker,
    },
    phase: 'verify',
    profiles: trueFields(TRUE_PROFILE_FIELDS),
    runtime: {
      dshVersion: '0.1.1-rc.2',
      exitCode: 0,
      expectedExit: true,
      httpBootPayload: true,
      pidAliveAfterStop: false,
      portOpenAfterStop: false,
      ptyExitCode: 0,
      ptyOutputVerified: true,
      ptyPidAliveAfterExit: false,
      windowLoaded: true,
      windowSecurityVerified: true,
    },
    schemaVersion: 1,
    status: 'passed',
  }
}

function createHarnessSmoke(definition, marker, appReportPath, packageManifestSha256) {
  return {
    appReportPath,
    arch: definition.arch,
    diagnostics: { outputPipelineMarker: marker },
    packageManifestSha256,
    platform: definition.platform,
    process: {
      code: 0,
      diagnosticCanaryExposed: false,
      signal: null,
      stderr: '',
      stdout: `${marker}\nDSH_WORKBENCH_PACKAGE_SMOKE_OK\n`,
      timedOut: false,
    },
    schemaVersion: 2,
    status: 'passed',
  }
}

async function createFixture() {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'dsh-workbench-release-matrix-'))
  const evidenceRoot = join(temporaryRoot, 'evidence')
  const outputPath = join(temporaryRoot, 'release-qualification.json')
  const entries = new Map()
  await mkdir(evidenceRoot)

  for (const definition of PLATFORMS) {
    const releaseDirectory = join(evidenceRoot, `dsh-workbench-${definition.id}-unsigned-ci`)
    const diagnosticsDirectory = join(evidenceRoot, `dsh-workbench-${definition.id}-diagnostics`)
    await Promise.all([mkdir(releaseDirectory), mkdir(diagnosticsDirectory)])

    const checksumLines = []
    for (const name of definition.artifacts) {
      const content = `artifact:${definition.id}:${name}\n`
      await writeFile(join(releaseDirectory, name), content, 'utf8')
      checksumLines.push(`${hash(content)}  ${name}`)
    }
    const checksumPath = join(releaseDirectory, 'SHA256SUMS')
    await writeFile(checksumPath, `${checksumLines.join('\n')}\n`, 'utf8')

    const manifestPath = join(releaseDirectory, 'package-manifest.json')
    await writeJson(manifestPath, {
      arch: definition.arch,
      artifacts: definition.artifacts.map((name) => `dist/artifacts/${name}`),
      compatibilitySha256: 'c'.repeat(64),
      electronBuilderVersion: '26.15.3',
      electronVersion: '38.4.0',
      gitDirty: false,
      gitSha: 'a'.repeat(40),
      lockfileSha256: 'b'.repeat(64),
      mode: 'artifacts',
      platform: definition.platform,
      schemaVersion: 2,
      versions: {
        desktop: '0.1.0',
        dsh: '0.1.1-rc.2',
      },
    })

    const marker = `package-smoke-benign-${hash(definition.id).slice(0, 32)}`
    const appSmokePath = join(
      diagnosticsDirectory,
      `package-smoke-${definition.platform}-${definition.arch}.json`,
    )
    const harnessSmokePath = join(
      diagnosticsDirectory,
      `package-smoke-harness-${definition.platform}-${definition.arch}.json`,
    )
    await writeJson(appSmokePath, createAppSmoke(definition, marker))
    await writeJson(
      harnessSmokePath,
      createHarnessSmoke(
        definition,
        marker,
        `/runner/dist/smoke/${appSmokePath.split('/').at(-1)}`,
        hash(await readFile(manifestPath)),
      ),
    )
    entries.set(definition.id, {
      appSmokePath,
      checksumPath,
      definition,
      diagnosticsDirectory,
      harnessSmokePath,
      manifestPath,
      releaseDirectory,
    })
  }
  return { entries, evidenceRoot, outputPath, temporaryRoot }
}

async function withFixture(run) {
  const fixture = await createFixture()
  try {
    return await run(fixture)
  } finally {
    await rm(fixture.temporaryRoot, { force: true, recursive: true })
  }
}

async function assertRejected(mutate, expected) {
  await withFixture(async (fixture) => {
    await mutate(fixture)
    await assert.rejects(
      verifyReleaseMatrix(fixture.evidenceRoot, fixture.outputPath),
      expected,
    )
  })
}

test('qualifies an exact three-platform matrix and writes deterministic evidence', async () => {
  await withFixture(async ({ evidenceRoot, outputPath }) => {
    const first = await verifyReleaseMatrix(evidenceRoot, outputPath)
    const firstOutput = await readFile(outputPath, 'utf8')
    const second = await verifyReleaseMatrix(evidenceRoot, outputPath)
    const secondOutput = await readFile(outputPath, 'utf8')

    assert.deepEqual(second, first)
    assert.equal(secondOutput, firstOutput)
    assert.equal(first.status, 'passed')
    assert.deepEqual(first.platforms.map(({ id }) => id), [
      'linux-x64',
      'macos-arm64',
      'windows-x64',
    ])
    assert.equal(first.identity.gitDirty, false)
    assert.equal(first.identity.compatibilitySha256, 'c'.repeat(64))
    assert.equal(first.identity.lockfileSha256, 'b'.repeat(64))
    assert.equal(first.platforms[0].artifacts.length, 3)
    assert.equal(first.platforms[1].artifacts.length, 2)
    assert.equal(first.platforms[2].artifacts.length, 2)
    assert.match(first.platforms[0].evidence.manifest.sha256, /^[a-f0-9]{64}$/u)
    assert.equal(
      first.platforms[0].evidence.manifest.path,
      'dsh-workbench-linux-x64-unsigned-ci/package-manifest.json',
    )
    assert.ok(firstOutput.endsWith('\n'))
  })
})

test('rejects a dirty or legacy package manifest', async (context) => {
  await context.test('dirty worktree', async () => {
    await assertRejected(async ({ entries }) => {
      const path = entries.get('linux-x64').manifestPath
      const manifest = await readJson(path)
      manifest.gitDirty = true
      await writeJson(path, manifest)
    }, /clean git worktree/u)
  })

  await context.test('legacy schema', async () => {
    await assertRejected(async ({ entries }) => {
      const path = entries.get('linux-x64').manifestPath
      const manifest = await readJson(path)
      manifest.schemaVersion = 1
      await writeJson(path, manifest)
    }, /schemaVersion 2/u)
  })
})

test('rejects duplicate, missing, extra, or malformed platform evidence', async (context) => {
  await context.test('duplicate platform', async () => {
    await assertRejected(async ({ entries }) => {
      const path = entries.get('macos-arm64').manifestPath
      const manifest = await readJson(path)
      manifest.platform = 'linux'
      manifest.arch = 'x64'
      await writeJson(path, manifest)
    }, /duplicate package manifest for linux-x64/u)
  })

  await context.test('missing report', async () => {
    await assertRejected(async ({ entries }) => {
      await unlink(entries.get('windows-x64').harnessSmokePath)
    }, /expected exactly 3 harness smoke reports, found 2/u)
  })

  await context.test('extra report', async () => {
    await assertRejected(async ({ evidenceRoot }) => {
      await writeJson(join(evidenceRoot, 'package-smoke-freebsd-x64.json'), {
        app: { arch: 'x64', platform: 'freebsd' },
      })
    }, /expected exactly 3 app smoke reports, found 4/u)
  })

  await context.test('unsupported platform and architecture pair', async () => {
    await assertRejected(async ({ entries }) => {
      const path = entries.get('windows-x64').manifestPath
      const manifest = await readJson(path)
      manifest.arch = 'arm64'
      await writeJson(path, manifest)
    }, /unsupported platform\/architecture win32\/arm64/u)
  })
})

test('rejects unsafe paths and incomplete or corrupt artifact evidence', async (context) => {
  await context.test('manifest path traversal', async () => {
    await assertRejected(async ({ entries }) => {
      const path = entries.get('linux-x64').manifestPath
      const manifest = await readJson(path)
      manifest.artifacts[0] = '../DSH-Workbench.AppImage'
      await writeJson(path, manifest)
    }, /unsafe path segment/u)
  })

  await context.test('filesystem symlink escape', async () => {
    await assertRejected(async ({ evidenceRoot, temporaryRoot }) => {
      const outside = join(temporaryRoot, 'outside')
      await mkdir(outside)
      await symlink(outside, join(evidenceRoot, 'escaped-evidence'), 'junction')
    }, /symbolic links are forbidden/u)
  })

  await context.test('missing expected suffix', async () => {
    await assertRejected(async ({ entries }) => {
      const path = entries.get('linux-x64').manifestPath
      const manifest = await readJson(path)
      manifest.artifacts = manifest.artifacts.filter((artifact) => !artifact.endsWith('.AppImage'))
      await writeJson(path, manifest)
    }, /must contain exactly 3 release artifacts/u)
  })

  await context.test('non-bijective checksum list', async () => {
    await assertRejected(async ({ entries }) => {
      const entry = entries.get('macos-arm64')
      const lines = (await readFile(entry.checksumPath, 'utf8')).trim().split('\n')
      await writeFile(entry.checksumPath, `${lines[0]}\n${lines[0]}\n`, 'utf8')
    }, /duplicate artifact/u)
  })

  await context.test('actual artifact hash mismatch', async () => {
    await assertRejected(async ({ entries }) => {
      const entry = entries.get('windows-x64')
      await writeFile(join(entry.releaseDirectory, entry.definition.artifacts[0]), 'tampered\n', 'utf8')
    }, /checksum mismatch/u)
  })

  await context.test('renamed artifact outside manifest set', async () => {
    await assertRejected(async ({ entries }) => {
      const entry = entries.get('windows-x64')
      await rename(
        join(entry.releaseDirectory, entry.definition.artifacts[0]),
        join(entry.releaseDirectory, 'unexpected.exe'),
      )
    }, /artifact files do not exactly match/u)
  })

  await context.test('extra release artifact outside every manifest directory', async () => {
    await assertRejected(async ({ evidenceRoot }) => {
      const unrelated = join(evidenceRoot, 'unrelated')
      await mkdir(unrelated)
      await writeFile(join(unrelated, 'unclaimed.zip'), 'extra\n', 'utf8')
    }, /expected exactly 7 release artifacts, found 8/u)
  })
})

test('rejects every cross-platform release identity mismatch', async (context) => {
  const mutations = [
    ['gitSha', (manifest) => { manifest.gitSha = 'd'.repeat(40) }],
    ['lockfileSha256', (manifest) => { manifest.lockfileSha256 = 'd'.repeat(64) }],
    ['compatibilitySha256', (manifest) => { manifest.compatibilitySha256 = 'd'.repeat(64) }],
    ['electronVersion', (manifest) => { manifest.electronVersion = '99.0.0' }],
    ['electronBuilderVersion', (manifest) => { manifest.electronBuilderVersion = '99.0.0' }],
    ['workbenchVersion', (manifest) => { manifest.versions.desktop = '9.9.9' }],
    ['dshVersion', (manifest) => { manifest.versions.dsh = '9.9.9' }],
  ]
  for (const [field, mutate] of mutations) {
    await context.test(field, async () => {
      await assertRejected(async ({ entries }) => {
        const path = entries.get('macos-arm64').manifestPath
        const manifest = await readJson(path)
        mutate(manifest)
        await writeJson(path, manifest)
      }, new RegExp(`${field} does not match`, 'u'))
    })
  }
})

test('rejects failed and weak M6 smoke evidence', async (context) => {
  await context.test('failed app smoke', async () => {
    await assertRejected(async ({ entries }) => {
      const path = entries.get('linux-x64').appSmokePath
      const report = await readJson(path)
      report.status = 'failed'
      await writeJson(path, report)
    }, /package-smoke-linux-x64\.json did not pass/u)
  })

  await context.test('failed harness smoke', async () => {
    await assertRejected(async ({ entries }) => {
      const path = entries.get('macos-arm64').harnessSmokePath
      const report = await readJson(path)
      report.status = 'failed'
      await writeJson(path, report)
    }, /harness.*did not pass/u)
  })

  await context.test('weak M6 diagnostics field', async () => {
    await assertRejected(async ({ entries }) => {
      const path = entries.get('windows-x64').appSmokePath
      const report = await readJson(path)
      report.diagnostics.repairActionVerified = false
      await writeJson(path, report)
    }, /repairActionVerified must be true/u)
  })

  await context.test('weak M6 authorization field', async () => {
    await assertRejected(async ({ entries }) => {
      const path = entries.get('windows-x64').appSmokePath
      const report = await readJson(path)
      report.authorization.valueFreeSnapshotVerified = false
      await writeJson(path, report)
    }, /valueFreeSnapshotVerified must be true/u)
  })

  await context.test('weak M6 profile field', async () => {
    await assertRejected(async ({ entries }) => {
      const path = entries.get('macos-arm64').appSmokePath
      const report = await readJson(path)
      report.profiles.credentialIsolationVerified = false
      await writeJson(path, report)
    }, /credentialIsolationVerified must be true/u)
  })

  await context.test('surviving runtime process', async () => {
    await assertRejected(async ({ entries }) => {
      const path = entries.get('windows-x64').appSmokePath
      const report = await readJson(path)
      report.runtime.pidAliveAfterStop = true
      await writeJson(path, report)
    }, /pidAliveAfterStop must be false/u)
  })

  await context.test('harness canary exposure', async () => {
    await assertRejected(async ({ entries }) => {
      const path = entries.get('linux-x64').harnessSmokePath
      const report = await readJson(path)
      report.process.diagnosticCanaryExposed = true
      await writeJson(path, report)
    }, /diagnosticCanaryExposed must be false/u)
  })

  await context.test('legacy harness without manifest binding', async () => {
    await assertRejected(async ({ entries }) => {
      const path = entries.get('macos-arm64').harnessSmokePath
      const report = await readJson(path)
      report.schemaVersion = 1
      delete report.packageManifestSha256
      await writeJson(path, report)
    }, /must use schemaVersion 2/u)
  })

  await context.test('harness bound to another package manifest', async () => {
    await assertRejected(async ({ entries }) => {
      const path = entries.get('windows-x64').harnessSmokePath
      const report = await readJson(path)
      report.packageManifestSha256 = 'd'.repeat(64)
      await writeJson(path, report)
    }, /packageManifestSha256 does not match its package manifest/u)
  })
})
