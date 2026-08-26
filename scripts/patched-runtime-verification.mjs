import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

function requireFeature(condition, message) {
  if (!condition) throw new Error(`Patched runtime verification failed: ${message}`)
}

function section(source, startMarker, endMarker, message) {
  const start = source.indexOf(startMarker)
  const end = start === -1 ? -1 : source.indexOf(endMarker, start + startMarker.length)
  requireFeature(start !== -1 && end !== -1, message)
  return source.slice(start, end)
}

export async function verifyPatchedRuntimeFiles(appRoot) {
  const dependencyRoot = join(appRoot, 'node_modules', '@deepseek-ai')
  const [codex, directoryPickerWorker, directoryPickerIpc, sandbox, subprocess] = await Promise.all([
    readFile(join(dependencyRoot, 'dsh-llm-pi-ai', 'lib', 'index.js'), 'utf8'),
    readFile(join(dependencyRoot, 'dsh-host-directory-picker-native', 'lib', 'worker.cjs'), 'utf8'),
    readFile(join(dependencyRoot, 'dsh-host-directory-picker-native', 'lib', 'worker-ipc.cjs'), 'utf8'),
    readFile(join(dependencyRoot, 'dsh-sandbox-windows-acl', 'lib', 'types-CNjZgO4h.js'), 'utf8'),
    readFile(join(dependencyRoot, 'dsh-subprocess-local', 'lib', 'index.js'), 'utf8'),
  ])

  const codexClass = section(
    codex,
    'class PiAiCodexCapabilities {',
    '//#endregion',
    'dsh-llm-pi-ai is missing the Codex capability class',
  )
  const codexConstructor = section(
    codexClass,
    'constructor(auth, resolveProvider)',
    '#requireProvider()',
    'dsh-llm-pi-ai is missing private Codex state initialization',
  )
  const codexAuthorization = section(
    codexClass,
    'async #authorization()',
    'async #refreshAfterUnauthorized',
    'dsh-llm-pi-ai is missing private Codex authorization',
  )
  const codexRefresh = section(
    codexClass,
    'async #refreshAfterUnauthorized',
    'async #request(',
    'dsh-llm-pi-ai is missing private Codex refresh',
  )
  const codexRequest = section(
    codexClass,
    'async #request(',
    'async search(',
    'dsh-llm-pi-ai is missing the private Codex request path',
  )
  const codexSearch = section(
    codexClass,
    'async search(',
    'async generateImage(',
    'dsh-llm-pi-ai is missing Codex search',
  )
  const codexImage = codexClass.slice(codexClass.indexOf('async generateImage('))
  requireFeature(
    codex.includes('const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";')
      && codex.includes('function redactCodexText(value, secrets)')
      && codexConstructor.includes('this.#auth = auth;')
      && codexConstructor.includes('this.#resolveProvider = resolveProvider;')
      && codexConstructor.includes('this.search = this.search.bind(this);')
      && codexConstructor.includes('this.generateImage = this.generateImage.bind(this);')
      && codexConstructor.includes('Object.freeze(this);')
      && codexAuthorization.includes('const provider = this.#requireProvider();')
      && codexAuthorization.includes('createModels(this.#auth)')
      && codexAuthorization.includes('baseUrl: CODEX_BASE_URL')
      && codexRefresh.includes('this.#auth.credentials.modify(CODEX_PROVIDER_ID')
      && codexRefresh.includes('current.access !== failedToken')
      && codexRequest.includes('const auth = await this.#authorization();')
      && codexRequest.includes('fetch(`${auth.baseUrl}/${path}`')
      && codexRequest.includes('response.status === 401 && attempt === 0')
      && codexRequest.includes('this.#refreshAfterUnauthorized(auth.provider, auth.token, signal)')
      && codexRequest.includes('const secrets = [auth.token, auth.accountId];')
      && codexSearch.includes('this.#request("alpha/search"')
      && codexSearch.includes('redactCodexText(payload.output, secrets)')
      && codexImage.includes('this.#request("images/generations"')
      && codexImage.includes('redactCodexText(payload.data[0].revised_prompt, secrets)')
      && codex.includes('ctx.provide("piAiCodex", new PiAiCodexCapabilities(auth,')
      && !codex.includes('class PiAiCodexCapabilities extends Service')
      && !codexClass.includes('constructor(ctx, auth, resolveProvider)')
      && !/this\.(?:auth|authorization|credentials|ctx|refreshAfterUnauthorized|request|requireProvider|resolveProvider|token)\b|codexBaseUrl\(/u.test(codexClass),
    'dsh-llm-pi-ai is missing a frozen token-free Codex facade, fixed operations, text redaction, or locked 401 refresh behavior',
  )

  const spawnSandboxed = section(
    sandbox,
    'function spawnSandboxed(',
    'async function drainPipe(',
    'dsh-sandbox-windows-acl is missing spawnSandboxed',
  )
  const spawnSandboxedInherited = section(
    sandbox,
    'function spawnSandboxedInherited(',
    '//#endregion',
    'dsh-sandbox-windows-acl is missing spawnSandboxedInherited',
  )
  const hiddenStartup = /encodeStartupInfo\(startupInfo, \{\s*cb: 104,\s*dwFlags: 257,\s*wShowWindow: 0,/u
  requireFeature(
    hiddenStartup.test(spawnSandboxed) && hiddenStartup.test(spawnSandboxedInherited),
    'dsh-sandbox-windows-acl is missing a hidden-window startup record in a restricted spawn function',
  )

  const taskkillTree = section(
    subprocess,
    'function taskkillTree(',
    'function isInvalidHandle(',
    'dsh-subprocess-local is missing taskkillTree',
  )
  const taskkillProcessTree = section(
    subprocess,
    'function taskkillProcessTree(',
    'function signalTree(',
    'dsh-subprocess-local is missing taskkillProcessTree',
  )
  const spawnSubprocess = section(
    subprocess,
    'function spawnSubprocess(',
    'const collectStream =',
    'dsh-subprocess-local is missing spawnSubprocess',
  )
  const hiddenTaskkill = /spawnSync\("taskkill", \[[\s\S]*?\], \{\s*stdio: "ignore",\s*windowsHide: true\s*\}\);/u
  requireFeature(
    hiddenTaskkill.test(taskkillTree)
      && hiddenTaskkill.test(taskkillProcessTree)
      && /const child = spawn\(program, args, \{[\s\S]*?windowsHide: platform === "win32",[\s\S]*?detached: platform !== "win32"/u.test(spawnSubprocess),
    'dsh-subprocess-local is missing a hidden Win32 option in a specific spawn path',
  )

  const readUtf16 = section(
    directoryPickerWorker,
    'function readUtf16(',
    'const COINIT_APARTMENTTHREADED',
    'directory-picker worker is missing readUtf16',
  )
  const resultPath = section(
    directoryPickerWorker,
    'resultPath: () => {',
    'release: () => {',
    'directory-picker worker is missing resultPath cleanup',
  )
  const runFolderDialog = section(
    directoryPickerWorker,
    'function runFolderDialog(',
    '//#endregion',
    'directory-picker worker is missing dialog cleanup',
  )
  const ipcPost = section(
    directoryPickerIpc,
    'function createWin32DialogPost(',
    'module.exports',
    'directory-picker worker IPC helper is missing',
  )
  requireFeature(
    directoryPickerWorker.includes('require("./worker-ipc.cjs")')
      && readUtf16.includes('return koffi.decode.string16(address);')
      && !directoryPickerWorker.includes('koffi.view(')
      && /try \{[\s\S]*?path: readUtf16\(koffi, name\)[\s\S]*?\} finally \{\s*coTaskMemFree\(name\);/u.test(resultPath)
      && /\} finally \{\s*method\(item, SLOT_RELEASE, protoRelease\)\(\);/u.test(resultPath)
      && /\} finally \{\s*dialog\.release\(\);\s*\}[\s\S]*?\} finally \{\s*bindings\.coUninitialize\(\);/u.test(runFolderDialog)
      && /if \(message\.kind === "showing"\) \{\s*send\(message\);\s*return;\s*\}/u.test(ipcPost)
      && /send\(message, \(\) => \{\s*if \(isConnected\(\)\) disconnect\(\);\s*\}\);/u.test(ipcPost),
    'directory-picker worker is missing safe IPC, UTF-16 decoding, or COM cleanup behavior',
  )
}
