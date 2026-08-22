const mode = process.env.DSH_WORKBENCH_FAKE_MODE ?? 'ready'

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
    process.exit(0)
  }
})

process.on('disconnect', () => process.exit(0))
setInterval(() => {}, 1_000)
