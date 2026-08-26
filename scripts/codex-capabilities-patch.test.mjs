import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dshManifest = require.resolve('@deepseek-ai/dsh/package.json', {
  paths: [join(root, 'packages', 'runtime')],
})
const dshBaseManifest = require.resolve('@deepseek-ai/dsh-base/package.json', {
  paths: [dirname(dshManifest)],
})
const manifestPath = require.resolve('@deepseek-ai/dsh-llm-pi-ai/package.json', {
  paths: [dirname(dshBaseManifest)],
})
const packageRoot = dirname(manifestPath)
const implementationPath = join(packageRoot, 'lib', 'index.js')
const typesPath = join(packageRoot, 'lib', 'types', 'index.d.ts')

describe('patched pi-ai Codex provider capabilities', () => {
  it('owns fixed search and image operations without exposing OAuth tokens', async () => {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    const implementation = await readFile(implementationPath, 'utf8')
    const types = await readFile(typesPath, 'utf8')

    assert.equal(manifest.version, '0.1.1-rc.2')
    assert.match(implementation, /const CODEX_BASE_URL = "https:\/\/chatgpt\.com\/backend-api\/codex"/u)
    assert.match(implementation, /class PiAiCodexCapabilities \{/u)
    assert.doesNotMatch(implementation, /class PiAiCodexCapabilities extends Service/u)
    assert.match(implementation, /this\.#request\("alpha\/search"/u)
    assert.match(implementation, /this\.#request\("images\/generations"/u)
    assert.match(implementation, /this\.#auth\.credentials\.modify\(CODEX_PROVIDER_ID/u)
    assert.match(implementation, /current\.access !== failedToken/u)
    assert.match(implementation, /response\.status === 401 && attempt === 0/u)
    assert.match(implementation, /baseUrl: CODEX_BASE_URL/u)
    assert.doesNotMatch(implementation, /codexBaseUrl\(|DEFAULT_CODEX_BASE_URL/u)
    assert.match(implementation, /this\.search = this\.search\.bind\(this\)/u)
    assert.match(implementation, /this\.generateImage = this\.generateImage\.bind\(this\)/u)
    assert.match(implementation, /Object\.freeze\(this\)/u)
    assert.match(implementation, /const secrets = \[auth\.token, auth\.accountId\]/u)
    assert.match(implementation, /redactCodexText\(payload\.output, secrets\)/u)
    assert.match(implementation, /redactCodexText\(payload\.data\[0\]\.revised_prompt, secrets\)/u)
    assert.doesNotMatch(
      implementation,
      /this\.(?:auth|authorization|credentials|ctx|refreshAfterUnauthorized|request|requireProvider|resolveProvider|token)\b/u,
    )
    assert.match(
      implementation,
      /ctx\.provide\("piAiCodex", new PiAiCodexCapabilities\(auth,/u,
    )
    assert.match(types, /interface Context \{\s*piAiCodex: PiAiCodexCapabilities;/u)
    assert.match(types, /search\(options: PiAiCodexSearchOptions\)/u)
    assert.match(types, /generateImage\(options: PiAiCodexImageOptions\)/u)
    assert.doesNotMatch(types, /PiAiCodexCapabilities extends Service|constructor\(ctx:/u)
    assert.doesNotMatch(types, /accessToken|getAccessToken|authenticatedFetch/u)
  })
})
