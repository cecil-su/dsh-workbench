import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  canonicalizeCompatibility,
  compatibilitySha256,
} from './compatibility.mjs'
import {
  CompatibilityVerificationError,
  verifyCompatibility,
} from './verify-compatibility.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixtures = new Set()
const requiredFixturePaths = [
  '.gitattributes',
  'package.json',
  'pnpm-workspace.yaml',
  'pnpm-lock.yaml',
  'electron-builder.config.mjs',
  'patches/README.md',
  'patches/@deepseek-ai__dsh-llm-pi-ai@0.1.1-rc.2.patch',
  'patches/@deepseek-ai__dsh-host-directory-picker-native@0.1.1-rc.2.patch',
  'patches/@deepseek-ai__dsh-sandbox-windows-acl@0.1.1-rc.2.patch',
  'patches/@deepseek-ai__dsh-subprocess-local@0.1.1-rc.2.patch',
  'upstream/compatibility.json',
  'upstream/version.json',
  'apps/desktop/package.json',
  'apps/desktop/src/contribution.ts',
  'packages/runtime/package.json',
  'plugins/desktop-core/package.json',
  'plugins/diagnostics-ui/package.json',
  'plugins/diagnostics-ui/src/client.js',
  'plugins/diagnostics-ui/scripts/build-client.mjs',
  'plugins/gpt-tools/package.json',
  'plugins/oauth-ui/package.json',
  'scripts/package.mjs',
  'scripts/patched-runtime-verification.mjs',
  'scripts/patched-runtime-verification.test.mjs',
  'scripts/codex-capabilities-patch.test.mjs',
  'scripts/directory-picker-patch.test.mjs',
  'scripts/subprocess-windows-hide-patch.test.mjs',
]

after(async () => {
  await Promise.all([...fixtures].map((path) => rm(path, { force: true, recursive: true })))
})

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-workbench-compatibility-'))
  fixtures.add(root)
  for (const relativePath of requiredFixturePaths) {
    const destination = join(root, relativePath)
    await mkdir(dirname(destination), { recursive: true })
    await cp(join(repositoryRoot, relativePath), destination)
  }
  return root
}

async function editJson(root, relativePath, edit) {
  const path = join(root, relativePath)
  const value = JSON.parse(await readFile(path, 'utf8'))
  edit(value)
  await writeFile(path, `${JSON.stringify(value, undefined, 2)}\n`)
}

async function replaceExactlyOnce(root, relativePath, before, afterValue) {
  const path = join(root, relativePath)
  const source = await readFile(path, 'utf8')
  assert.equal(source.split(before).length - 1, 1, `fixture replacement must be unique: ${before}`)
  await writeFile(path, source.replace(before, afterValue))
}

async function replaceInPatchSection(root, patchKey, before, afterValue) {
  const path = join(root, 'patches/README.md')
  const source = await readFile(path, 'utf8')
  const heading = `## \`${patchKey}\``
  const start = source.indexOf(heading)
  assert.notEqual(start, -1, `fixture patch section must exist: ${patchKey}`)
  const next = source.indexOf('\n## ', start + heading.length)
  const end = next === -1 ? source.length : next
  const section = source.slice(start, end)
  assert.equal(section.split(before).length - 1, 1, `fixture section replacement must be unique: ${before}`)
  await writeFile(path, source.slice(0, start) + section.replace(before, afterValue) + source.slice(end))
}

async function expectFailure(root, pattern) {
  await assert.rejects(
    () => verifyCompatibility(root),
    (error) => error instanceof CompatibilityVerificationError && pattern.test(error.message),
  )
}

describe('compatibility identity', () => {
  it('is semantic across object key order and preserves array order', () => {
    const left = { z: 1, nested: { b: 2, a: 1 }, values: ['first', 'second'] }
    const reordered = { values: ['first', 'second'], nested: { a: 1, b: 2 }, z: 1 }
    const reversed = { values: ['second', 'first'], nested: { a: 1, b: 2 }, z: 1 }

    assert.equal(canonicalizeCompatibility(left), canonicalizeCompatibility(reordered))
    assert.equal(compatibilitySha256(left), compatibilitySha256(reordered))
    assert.notEqual(compatibilitySha256(left), compatibilitySha256(reversed))
    assert.match(compatibilitySha256(left), /^[a-f0-9]{64}$/u)
  })
})

describe('compatibility verifier', () => {
  it('accepts the complete repository lock and reports every workspace package', async () => {
    const result = await verifyCompatibility(repositoryRoot)

    assert.match(result.compatibilitySha256, /^[a-f0-9]{64}$/u)
    assert.deepEqual(result.workspacePackages, [
      'apps/desktop',
      'packages/runtime',
      'plugins/desktop-core',
      'plugins/diagnostics-ui',
      'plugins/gpt-tools',
      'plugins/oauth-ui',
    ])
  })

  it('rejects a release tag that differs from packageVersion', async () => {
    const root = await createFixture()
    await editJson(root, 'upstream/version.json', (value) => { value.release = 'dsh-v0.1.1-rc.1' })

    await expectFailure(root, /upstream\/version\.json release differs/u)
  })

  it('rejects removal of the lockfile LF provenance policy', async () => {
    const root = await createFixture()
    await replaceExactlyOnce(
      root,
      '.gitattributes',
      'pnpm-lock.yaml text eol=lf',
      'pnpm-lock.yaml text',
    )

    await expectFailure(root, /must pin pnpm-lock\.yaml to LF/u)
  })

  it('rejects non-exact DSH workspace catalog values', async () => {
    const root = await createFixture()
    await replaceExactlyOnce(
      root,
      'pnpm-workspace.yaml',
      "  '@deepseek-ai/dsh': 0.1.1-rc.2",
      "  '@deepseek-ai/dsh': ^0.1.1-rc.2",
    )

    await expectFailure(root, /pnpm catalog @deepseek-ai\/dsh must pin exact/u)
  })

  it('rejects removal of the exact directory-picker patch declaration', async () => {
    const root = await createFixture()
    await replaceExactlyOnce(
      root,
      'pnpm-workspace.yaml',
      [
        'patchedDependencies:',
        "  '@deepseek-ai/dsh-host-directory-picker-native@0.1.1-rc.2': patches/@deepseek-ai__dsh-host-directory-picker-native@0.1.1-rc.2.patch",
      ].join('\n'),
      'patchedDependencies:',
    )

    await expectFailure(root, /must patch @deepseek-ai\/dsh-host-directory-picker-native@0\.1\.1-rc\.2/u)
  })

  it('rejects a directory-picker patch that disconnects the showing notice', async () => {
    const root = await createFixture()
    await replaceExactlyOnce(
      root,
      'patches/@deepseek-ai__dsh-host-directory-picker-native@0.1.1-rc.2.patch',
      '+    if (message.kind === "showing") {',
      '+    if (message.kind === "done") {',
    )

    await expectFailure(root, /must keep showing non-terminal and flush terminal outcomes/u)
  })

  it('rejects a directory-picker patch that uses Electron external buffers', async () => {
    const root = await createFixture()
    await replaceExactlyOnce(
      root,
      'patches/@deepseek-ai__dsh-host-directory-picker-native@0.1.1-rc.2.patch',
      '+\treturn koffi.decode.string16(address);',
      '+\treturn Buffer.from(koffi.view(address, 32768)).toString("utf16le");',
    )

    await expectFailure(root, /must decode UTF-16 without Electron external buffers and free COM memory/u)
  })

  it('rejects omission of the patched helper from stage verification', async () => {
    const root = await createFixture()
    await replaceExactlyOnce(
      root,
      'scripts/package.mjs',
      '    access(directoryPickerWorkerIpc),\n',
      '',
    )

    await expectFailure(root, /must require staged directory-picker worker-ipc\.cjs/u)
  })

  it('rejects removal of the exact subprocess patch declaration', async () => {
    const root = await createFixture()
    await replaceExactlyOnce(
      root,
      'pnpm-workspace.yaml',
      "  '@deepseek-ai/dsh-subprocess-local@0.1.1-rc.2': patches/@deepseek-ai__dsh-subprocess-local@0.1.1-rc.2.patch\n",
      '',
    )

    await expectFailure(root, /must patch @deepseek-ai\/dsh-subprocess-local@0\.1\.1-rc\.2/u)
  })

  it('rejects a subprocess patch that leaves Win32 consoles visible', async () => {
    const root = await createFixture()
    await replaceExactlyOnce(
      root,
      'patches/@deepseek-ai__dsh-subprocess-local@0.1.1-rc.2.patch',
      '+\t\twindowsHide: platform === "win32",',
      '+\t\twindowsHide: false,',
    )

    await expectFailure(root, /must hide direct Win32 subprocess console windows/u)
  })

  it('rejects removal of the exact pi-ai Codex capability patch declaration', async () => {
    const root = await createFixture()
    await replaceExactlyOnce(
      root,
      'pnpm-workspace.yaml',
      "  '@deepseek-ai/dsh-llm-pi-ai@0.1.1-rc.2': patches/@deepseek-ai__dsh-llm-pi-ai@0.1.1-rc.2.patch\n",
      '',
    )

    await expectFailure(root, /must patch @deepseek-ai\/dsh-llm-pi-ai@0\.1\.1-rc\.2/u)
  })

  it('rejects a pi-ai patch that derives OAuth capability targets from provider configuration', async () => {
    const root = await createFixture()
    await replaceExactlyOnce(
      root,
      'patches/@deepseek-ai__dsh-llm-pi-ai@0.1.1-rc.2.patch',
      'baseUrl: CODEX_BASE_URL',
      'baseUrl: provider.baseUrl',
    )

    await expectFailure(root, /fixed token-free Codex operations/u)
  })

  it('rejects a pi-ai patch without the fixed Codex search operation', async () => {
    const root = await createFixture()
    await replaceExactlyOnce(
      root,
      'patches/@deepseek-ai__dsh-llm-pi-ai@0.1.1-rc.2.patch',
      'this.#request("alpha/search"',
      'this.#request("alpha/search-missing"',
    )

    await expectFailure(root, /fixed token-free Codex operations/u)
  })

  it('rejects a pi-ai Codex capability that inherits a runtime context', async () => {
    const root = await createFixture()
    await replaceExactlyOnce(
      root,
      'patches/@deepseek-ai__dsh-llm-pi-ai@0.1.1-rc.2.patch',
      'class PiAiCodexCapabilities {\n+\t#auth;',
      'class PiAiCodexCapabilities extends Service {\n+\t#auth;',
    )

    await expectFailure(root, /fixed token-free Codex operations/u)
  })

  it('rejects omission of the ChatGPT account ID from response redaction', async () => {
    const root = await createFixture()
    await replaceExactlyOnce(
      root,
      'patches/@deepseek-ai__dsh-llm-pi-ai@0.1.1-rc.2.patch',
      'const secrets = [auth.token, auth.accountId];',
      'const secrets = [auth.token];',
    )

    await expectFailure(root, /fixed token-free Codex operations/u)
  })

  it('rejects patch metadata borrowed from another README section', async () => {
    const root = await createFixture()
    await replaceInPatchSection(
      root,
      '@deepseek-ai/dsh-llm-pi-ai@0.1.1-rc.2',
      '- Owner: DSH Workbench maintainers (`cecil-su`).',
      '- Maintainer: DSH Workbench maintainers (`cecil-su`).',
    )

    await expectFailure(root, /pi-ai Codex capability patch documentation/u)
  })

  it('stops patch metadata sections at CommonMark-indented level-one and level-two headings', async () => {
    for (const heading of [' # Borrowed metadata', '   ## Borrowed metadata']) {
      const root = await createFixture()
      await replaceInPatchSection(
        root,
        '@deepseek-ai/dsh-llm-pi-ai@0.1.1-rc.2',
        '- Owner: DSH Workbench maintainers (`cecil-su`).',
        `${heading}\n- Owner: DSH Workbench maintainers (\`cecil-su\`).`,
      )

      await expectFailure(root, /pi-ai Codex capability patch documentation/u)
    }
  })

  it('rejects omission of pi-ai Codex capabilities from stage verification', async () => {
    const root = await createFixture()
    await replaceExactlyOnce(
      root,
      'scripts/package.mjs',
      '    access(piAiCodexCapabilities),\n',
      '',
    )

    await expectFailure(root, /must require staged dsh-llm-pi-ai/u)
  })

  it('rejects omission of runtime patch-feature verification', async () => {
    const root = await createFixture()
    await replaceExactlyOnce(
      root,
      'scripts/package.mjs',
      '  await verifyPatchedRuntimeFiles(stageDir)\n',
      '',
    )

    await expectFailure(root, /must inspect patch features in the production stage and final packaged app/u)
  })

  it('rejects removal of the exact sandbox Windows ACL patch declaration', async () => {
    const root = await createFixture()
    await replaceExactlyOnce(
      root,
      'pnpm-workspace.yaml',
      "  '@deepseek-ai/dsh-sandbox-windows-acl@0.1.1-rc.2': patches/@deepseek-ai__dsh-sandbox-windows-acl@0.1.1-rc.2.patch\n",
      '',
    )

    await expectFailure(root, /must patch @deepseek-ai\/dsh-sandbox-windows-acl@0\.1\.1-rc\.2/u)
  })

  it('rejects a sandbox Windows ACL patch that leaves a restricted child visible', async () => {
    const root = await createFixture()
    await replaceExactlyOnce(
      root,
      'patches/@deepseek-ai__dsh-sandbox-windows-acl@0.1.1-rc.2.patch',
      '@@ -853,7 +854,8 @@ function spawnSandboxed(api, token, options) {\n \tconst startupInfo = allocStartupInfo();\n \tencodeStartupInfo(startupInfo, {\n \t\tcb: 104,\n-\t\tdwFlags: 256,\n+\t\tdwFlags: 257,',
      '@@ -853,7 +854,8 @@ function spawnSandboxed(api, token, options) {\n \tconst startupInfo = allocStartupInfo();\n \tencodeStartupInfo(startupInfo, {\n \t\tcb: 104,\n-\t\tdwFlags: 256,\n+\t\tdwFlags: 256,',
    )

    await expectFailure(root, /must hide both restricted-token child process paths/u)
  })

  it('validates sandbox patch documentation inside its own README section', async () => {
    const root = await createFixture()
    await replaceInPatchSection(
      root,
      '@deepseek-ai/dsh-sandbox-windows-acl@0.1.1-rc.2',
      '- Removal condition:',
      '- Retirement condition:',
    )

    await expectFailure(root, /sandbox Windows ACL patch documentation/u)
  })

  it('rejects omission of subprocess-local from stage verification', async () => {
    const root = await createFixture()
    await replaceExactlyOnce(
      root,
      'scripts/package.mjs',
      '    access(subprocessLocal),\n',
      '',
    )

    await expectFailure(root, /must require staged subprocess-local/u)
  })

  it('rejects omission of sandbox-windows-acl from stage verification', async () => {
    const root = await createFixture()
    await replaceExactlyOnce(
      root,
      'scripts/package.mjs',
      '    access(sandboxWindowsAcl),\n',
      '',
    )

    await expectFailure(root, /must require staged sandbox-windows-acl/u)
  })

  it('rejects a ranged DSH dependency in any workspace package manifest', async () => {
    const root = await createFixture()
    await editJson(root, 'plugins/oauth-ui/package.json', (value) => {
      value.dependencies['@deepseek-ai/dsh-authorization'] = '^0.1.1-rc.2'
    })

    await expectFailure(root, /plugins\/oauth-ui\/package\.json @deepseek-ai\/dsh-authorization must pin exact/u)
  })

  it('rejects a stale lock importer resolution', async () => {
    const root = await createFixture()
    await replaceExactlyOnce(
      root,
      'pnpm-lock.yaml',
      'version: 0.1.1-rc.2(9e5083aa0287631f52a6ca114653706c)',
      'version: 0.1.1-rc.1(9e5083aa0287631f52a6ca114653706c)',
    )

    await expectFailure(root, /importer packages\/runtime must resolve @deepseek-ai\/dsh/u)
  })

  it('rejects a divergent DSH package resolution in the lockfile', async () => {
    const root = await createFixture()
    await replaceExactlyOnce(
      root,
      'pnpm-lock.yaml',
      "  '@deepseek-ai/dsh-authorization@0.1.1-rc.2':",
      "  '@deepseek-ai/dsh-authorization@0.1.1-rc.1':",
    )

    await expectFailure(root, /packages contains @deepseek-ai\/dsh-authorization@0\.1\.1-rc\.1/u)
  })

  it('rejects a diagnostics bundle that hardcodes its expected DSH version', async () => {
    const root = await createFixture()
    await replaceExactlyOnce(
      root,
      'plugins/diagnostics-ui/src/client.js',
      '__DSH_WORKBENCH_EXPECTED_DSH_VERSION__',
      '0.1.1-rc.2',
    )

    await expectFailure(root, /diagnostics client must contain exactly one compatibility DSH version token/u)
  })

  it('rejects Electron catalog and builder configuration drift', async () => {
    const catalogRoot = await createFixture()
    await replaceExactlyOnce(catalogRoot, 'pnpm-workspace.yaml', '  electron: 43.4.1', '  electron: 43.4.0')
    await expectFailure(catalogRoot, /pnpm catalog electron must pin exact/u)

    const configRoot = await createFixture()
    await replaceExactlyOnce(configRoot, 'electron-builder.config.mjs', "electronVersion: '43.4.1'", "electronVersion: '43.4.0'")
    await expectFailure(configRoot, /electron-builder config must select Electron 43\.4\.1/u)
  })

  it('rejects Electron toolchain drift in any workspace package manifest', async () => {
    const root = await createFixture()
    await editJson(root, 'plugins/oauth-ui/package.json', (value) => {
      value.devDependencies.electron = '99.0.0'
    })

    await expectFailure(
      root,
      /plugins\/oauth-ui\/package\.json electron must pin exact 43\.4\.1/u,
    )
  })

  it('rejects first-party plugin drift in metadata, overlay, desktop dependencies, and packaging checks', async () => {
    const metadataRoot = await createFixture()
    await editJson(metadataRoot, 'upstream/compatibility.json', (value) => { value.firstPartyPlugins.pop() })
    await expectFailure(metadataRoot, /exactly four first-party plugins/u)

    const activationRoot = await createFixture()
    await editJson(activationRoot, 'upstream/compatibility.json', (value) => {
      const gptTools = value.firstPartyPlugins.find((plugin) => (
        plugin.entryId === 'dsh-workbench-gpt-tools'
      ))
      gptTools.enabledByDefault = true
    })
    await expectFailure(activationRoot, /expected default activation/u)

    const overlayRoot = await createFixture()
    await replaceExactlyOnce(overlayRoot, 'apps/desktop/src/contribution.ts', "id: 'dsh-workbench-oauth-ui'", "id: 'dsh-workbench-oauth-ui-missing'")
    await expectFailure(overlayRoot, /desktop overlay is missing dsh-workbench-oauth-ui/u)

    const desktopRoot = await createFixture()
    await editJson(desktopRoot, 'apps/desktop/package.json', (value) => {
      delete value.dependencies['@dsh-workbench/diagnostics-ui']
    })
    await expectFailure(desktopRoot, /desktop dependencies must include @dsh-workbench\/diagnostics-ui/u)

    const packageRoot = await createFixture()
    await replaceExactlyOnce(packageRoot, 'scripts/package.mjs', '    access(diagnosticsUiClient),\n', '')
    await expectFailure(packageRoot, /package verifier does not require @dsh-workbench\/diagnostics-ui\/lib\/client\.js/u)
  })

  it('rejects a workspace plugin omitted from the compatibility identity', async () => {
    const root = await createFixture()
    await mkdir(join(root, 'plugins', 'rogue'), { recursive: true })
    await writeFile(
      join(root, 'plugins', 'rogue', 'package.json'),
      `${JSON.stringify({
        dependencies: { marker: '1.0.0' },
        name: '@dsh-workbench/rogue',
        version: '0.1.0',
      }, undefined, 2)}\n`,
      'utf8',
    )
    await replaceExactlyOnce(
      root,
      'pnpm-lock.yaml',
      '\npackages:\n',
      [
        '',
        '  plugins/rogue:',
        '    dependencies:',
        '      marker:',
        '        specifier: 1.0.0',
        '        version: 1.0.0',
        '',
        'packages:',
        '',
      ].join('\n'),
    )

    await expectFailure(
      root,
      /compatibility firstPartyPlugins package names must exactly match workspace plugins\/\* manifests/u,
    )
  })
})
