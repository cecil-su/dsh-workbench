import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
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
const autoPickerManifest = require.resolve(
  '@deepseek-ai/dsh-host-directory-picker-auto/package.json',
  { paths: [dirname(dshManifest)] },
)
const nativePickerManifest = require.resolve(
  '@deepseek-ai/dsh-host-directory-picker-native/package.json',
  { paths: [dirname(autoPickerManifest)] },
)
const nativePickerRoot = dirname(nativePickerManifest)
const helperPath = join(nativePickerRoot, 'lib', 'worker-ipc.cjs')
const workerPath = join(nativePickerRoot, 'lib', 'worker.cjs')
const { createWin32DialogPost } = require(helperPath)

function harness({ connected = true } = {}) {
  const messages = []
  const callbacks = []
  let disconnects = 0
  const post = createWin32DialogPost(
    (message, callback) => {
      messages.push(message)
      callbacks.push(callback)
    },
    () => connected,
    () => { disconnects += 1 },
  )
  return {
    callbacks,
    disconnects: () => disconnects,
    messages,
    post,
  }
}

describe('patched Win32 directory picker worker IPC', () => {
  it('keeps IPC connected after showing and disconnects after done', () => {
    const probe = harness()
    const showing = { kind: 'showing', threadId: 41 }
    const done = { kind: 'done', path: 'C:\\workspace' }

    probe.post(showing)
    assert.deepEqual(probe.messages, [showing])
    assert.equal(probe.callbacks[0], undefined)
    assert.equal(probe.disconnects(), 0)

    probe.post(done)
    assert.deepEqual(probe.messages, [showing, done])
    assert.equal(typeof probe.callbacks[1], 'function')
    assert.equal(probe.disconnects(), 0)
    probe.callbacks[1]()
    assert.equal(probe.disconnects(), 1)
  })

  it('treats an error as a terminal message', () => {
    const probe = harness()
    probe.post({ kind: 'error', message: 'CoCreateInstance failed' })
    assert.equal(typeof probe.callbacks[0], 'function')
    probe.callbacks[0]()
    assert.equal(probe.disconnects(), 1)
  })

  it('does not disconnect an already-disconnected worker', () => {
    const probe = harness({ connected: false })
    probe.post({ kind: 'done', path: null })
    probe.callbacks[0]()
    assert.equal(probe.disconnects(), 0)
  })

  it('delivers showing and done through a real child IPC channel before exit', async () => {
    const source = [
      "const { createWin32DialogPost } = require(process.env.DSH_WORKBENCH_PICKER_IPC_HELPER)",
      'const post = createWin32DialogPost(',
      '  process.send.bind(process),',
      '  () => process.connected,',
      '  () => process.disconnect(),',
      ')',
      "post({ kind: 'showing', threadId: 41 })",
      'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)',
      "post({ kind: 'done', path: 'C:/workspace' })",
    ].join('\n')
    const messages = []
    const child = spawn(process.execPath, ['-e', source], {
      env: {
        ...process.env,
        DSH_WORKBENCH_PICKER_IPC_HELPER: helperPath,
      },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    })
    child.on('message', (message) => messages.push(message))

    const exitCode = await new Promise((resolveExit, reject) => {
      const timeout = setTimeout(() => {
        child.kill()
        reject(new Error('directory-picker IPC child timed out'))
      }, 5_000)
      child.once('error', (error) => {
        clearTimeout(timeout)
        reject(error)
      })
      child.once('exit', (code, signal) => {
        clearTimeout(timeout)
        if (signal) reject(new Error(`directory-picker IPC child exited with ${signal}`))
        else resolveExit(code)
      })
    })

    assert.equal(exitCode, 0)
    assert.deepEqual(messages, [
      { kind: 'showing', threadId: 41 },
      { kind: 'done', path: 'C:/workspace' },
    ])
  })

  it('loads the helper from the exact patched worker artifact', async () => {
    const manifest = JSON.parse(await readFile(nativePickerManifest, 'utf8'))
    const worker = await readFile(workerPath, 'utf8')

    assert.equal(manifest.version, '0.1.1-rc.2')
    assert.match(worker, /require\("\.\/worker-ipc\.cjs"\)/u)
    assert.doesNotMatch(
      worker,
      /const post = \(message\) => \{[\s\S]*if \(process\.connected\) process\.disconnect\(\);/u,
    )
  })
})
