import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const mode = process.env.DSH_WORKBENCH_FAKE_MODE ?? 'ready'

if (mode === 'hang-with-descendant' || mode === 'graceful-with-descendant') {
  const descendant = spawn(process.execPath, [
    '-e',
    'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)',
  ], {
    detached: process.platform !== 'win32',
    stdio: 'ignore',
  })
  const pidPath = process.env.DSH_WORKBENCH_FAKE_DESCENDANT_PID_PATH
  if (pidPath && descendant.pid) writeFileSync(pidPath, String(descendant.pid), { mode: 0o600 })
  descendant.unref()
  process.on('SIGTERM', () => {})
}

if (mode === 'exit-before-ready') {
  process.stderr.write('fake DSH failed before ready\n')
  process.exit(23)
}

if (mode === 'invalid-ready') {
  process.send?.({
    protocolVersion: 1,
    type: 'dsh-workbench/ready',
    url: 'http://example.com:43123',
  })
} else {
  process.send?.({
    protocolVersion: 1,
    type: 'dsh-workbench/ready',
    url: 'http://127.0.0.1:43123',
  })
}

if (mode === 'exit-after-ready') {
  setTimeout(() => process.exit(17), 50)
}

process.on('message', (message) => {
  if (
    typeof message === 'object'
    && message !== null
    && message.type === 'dsh-workbench/shutdown'
    && message.protocolVersion === 1
  ) {
    if (mode === 'hang-with-descendant') return
    process.exit(0)
  }
})

process.on('disconnect', () => process.exit(0))
setInterval(() => {}, 1_000)
