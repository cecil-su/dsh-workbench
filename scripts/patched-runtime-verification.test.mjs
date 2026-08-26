import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, it } from 'node:test'

import { verifyPatchedRuntimeFiles } from './patched-runtime-verification.mjs'

const fixtures = new Set()

const patchedSources = Object.freeze({
  codex: `
const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
function redactCodexText(value, secrets) {
  for (const secret of secrets) value = value.replaceAll(secret, "[REDACTED]");
  return value;
}
class PiAiCodexCapabilities {
  #auth;
  #resolveProvider;
  constructor(auth, resolveProvider) {
    this.#auth = auth;
    this.#resolveProvider = resolveProvider;
    this.search = this.search.bind(this);
    this.generateImage = this.generateImage.bind(this);
    Object.freeze(this);
  }
  #requireProvider() { return this.#resolveProvider(); }
  async #authorization() {
    const provider = this.#requireProvider();
    const models = createModels(this.#auth);
    return { accountId: "account", baseUrl: CODEX_BASE_URL, provider, token: "token" };
  }
  async #refreshAfterUnauthorized(provider, failedToken, signal) {
    await this.#auth.credentials.modify(CODEX_PROVIDER_ID, async (current) => {
      if (current.access !== failedToken) return;
      return provider.auth.oauth.refresh(current, signal);
    });
  }
  async #request(path, body, signal) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const auth = await this.#authorization();
      const response = await fetch(\`${'${auth.baseUrl}/${path}'}\`, { body, signal });
      if (response.status === 401 && attempt === 0) {
        await this.#refreshAfterUnauthorized(auth.provider, auth.token, signal);
        continue;
      }
      const secrets = [auth.token, auth.accountId];
      return { payload: response, secrets };
    }
  }
  async search(options) {
    const { payload, secrets } = await this.#request("alpha/search", options, options.signal);
    return redactCodexText(payload.output, secrets);
  }
  async generateImage(options) {
    const { payload, secrets } = await this.#request("images/generations", options, options.signal);
    return redactCodexText(payload.data[0].revised_prompt, secrets);
  }
}
//#endregion
ctx.provide("piAiCodex", new PiAiCodexCapabilities(auth, () => provider));
`,
  directoryPickerIpc: `
function createWin32DialogPost(send, isConnected, disconnect) {
  return (message) => {
    if (message.kind === "showing") {
      send(message);
      return;
    }
    send(message, () => {
      if (isConnected()) disconnect();
    });
  };
}
module.exports = { createWin32DialogPost };
`,
  directoryPickerWorker: `
function readUtf16(koffi, address) {
  return koffi.decode.string16(address);
}
const COINIT_APARTMENTTHREADED = 2;
const dialog = {
  resultPath: () => {
    const item = itemOut[0];
    try {
      const name = nameOut[0];
      try {
        return { path: readUtf16(koffi, name) };
      } finally {
        coTaskMemFree(name);
      }
    } finally {
      method(item, SLOT_RELEASE, protoRelease)();
    }
  },
  release: () => {},
};
function runFolderDialog(bindings) {
  try {
    const dialog = bindings.createFolderDialog();
    try {
      return dialog.resultPath();
    } finally {
      dialog.release();
    }
  } finally {
    bindings.coUninitialize();
  }
}
//#endregion
const { createWin32DialogPost } = require("./worker-ipc.cjs");
`,
  sandbox: `
function spawnSandboxed(api, token, options) {
  encodeStartupInfo(startupInfo, { cb: 104, dwFlags: 257, wShowWindow: 0, hStdInput });
}
async function drainPipe() {}
function spawnSandboxedInherited(api, token, options) {
  encodeStartupInfo(startupInfo, { cb: 104, dwFlags: 257, wShowWindow: 0, hStdInput });
}
//#endregion
`,
  subprocess: `
function taskkillTree(pid, force) {
  spawnSync("taskkill", ["/PID", String(pid)], {
    stdio: "ignore",
    windowsHide: true
  });
}
function isInvalidHandle() {}
function taskkillProcessTree(pid) {
  spawnSync("taskkill", ["/PID", String(pid)], {
    stdio: "ignore",
    windowsHide: true
  });
}
function signalTree() {}
function spawnSubprocess(spec, internals = {}) {
  const [program, ...args] = spec.argv;
  const platform = internals.platform;
  const child = spawn(program, args, {
    windowsHide: platform === "win32",
    detached: platform !== "win32"
  });
  const collectStream = () => child;
}
`,
})

async function createFixture(overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-workbench-patched-runtime-'))
  fixtures.add(root)
  const sources = { ...patchedSources, ...overrides }
  const files = [
    ['dsh-llm-pi-ai/lib/index.js', sources.codex],
    ['dsh-host-directory-picker-native/lib/worker.cjs', sources.directoryPickerWorker],
    ['dsh-host-directory-picker-native/lib/worker-ipc.cjs', sources.directoryPickerIpc],
    ['dsh-sandbox-windows-acl/lib/types-CNjZgO4h.js', sources.sandbox],
    ['dsh-subprocess-local/lib/index.js', sources.subprocess],
  ]
  for (const [relativePath, source] of files) {
    const path = join(root, 'node_modules', '@deepseek-ai', relativePath)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, source)
  }
  return root
}

afterEach(async () => {
  await Promise.all([...fixtures].map((path) => rm(path, { force: true, recursive: true })))
  fixtures.clear()
})

describe('packaged patched runtime verification', () => {
  it('accepts runtime files containing every required patch feature', async () => {
    await verifyPatchedRuntimeFiles(await createFixture())
  })

  it('rejects a public or incomplete Codex request surface', async () => {
    for (const codex of [
      patchedSources.codex.replace('this.#auth = auth;', 'this.auth = auth;'),
      patchedSources.codex.replace('Object.freeze(this);', 'this.ctx = ctx;'),
      patchedSources.codex.replace('this.#request("alpha/search"', 'this.#request("alpha/search-missing"'),
      patchedSources.codex.replace('response.status === 401', 'response.status === 403'),
      patchedSources.codex.replace(
        'const secrets = [auth.token, auth.accountId];',
        'const secrets = [auth.token];',
      ),
    ]) {
      await assert.rejects(
        () => createFixture({ codex }).then(verifyPatchedRuntimeFiles),
        /Codex/u,
      )
    }
  })

  it('rejects a sandbox runtime missing either named hidden-window spawn fix', async () => {
    for (const marker of [
      'function spawnSandboxed(api, token, options)',
      'function spawnSandboxedInherited(api, token, options)',
    ]) {
      const start = patchedSources.sandbox.indexOf(marker)
      const source = patchedSources.sandbox.slice(start)
      const broken = source.replace('dwFlags: 257', 'dwFlags: 256')
      const sandbox = patchedSources.sandbox.slice(0, start) + broken
      await assert.rejects(
        () => createFixture({ sandbox }).then(verifyPatchedRuntimeFiles),
        /restricted spawn function/u,
      )
    }
  })

  it('rejects each independently broken subprocess spawn path', async () => {
    for (const subprocess of [
      patchedSources.subprocess.replace(
        'function taskkillTree(pid, force) {\n  spawnSync',
        'function taskkillTree(pid, force) {\n  spawn',
      ),
      patchedSources.subprocess.replace(
        'function taskkillProcessTree(pid) {\n  spawnSync',
        'function taskkillProcessTree(pid) {\n  spawn',
      ),
      patchedSources.subprocess.replace(
        'windowsHide: platform === "win32"',
        'windowsHide: false',
      ),
    ]) {
      await assert.rejects(
        () => createFixture({ subprocess }).then(verifyPatchedRuntimeFiles),
        /specific spawn path/u,
      )
    }
  })

  it('rejects unsafe directory-picker IPC, decoding, or cleanup', async () => {
    const cases = [
      {
        directoryPickerIpc: patchedSources.directoryPickerIpc.replace(
          'send(message);\n      return;',
          'send(message, () => disconnect());\n      return;',
        ),
      },
      {
        directoryPickerWorker: patchedSources.directoryPickerWorker.replace(
          'return koffi.decode.string16(address);',
          'return koffi.view(address, 32768);',
        ),
      },
      {
        directoryPickerWorker: patchedSources.directoryPickerWorker.replace(
          'coTaskMemFree(name);',
          'void name;',
        ),
      },
    ]
    for (const overrides of cases) {
      await assert.rejects(
        () => createFixture(overrides).then(verifyPatchedRuntimeFiles),
        /directory-picker/u,
      )
    }
  })
})
