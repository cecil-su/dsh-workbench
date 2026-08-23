import assert from 'node:assert/strict'
import test from 'node:test'

import { diagnosticConsoleProbeEvidence } from './package-smoke-evidence.mjs'

const marker = 'package-smoke-benign-00000000000000000000000000000000'
const stdoutProbe = `${marker}-stdout-before\n${marker}-stdout-after\n`
const stderrProbe = `${marker}-stderr-before\n${marker}-stderr-after\n`

test('accepts exact parent stream attribution', () => {
  assert.deepEqual(diagnosticConsoleProbeEvidence({
    stderr: stderrProbe,
    stdout: stdoutProbe,
  }, marker), {
    combined: true,
    stderr: true,
    stdout: true,
  })
})

test('distinguishes an Xvfb-remapped console from exact stream attribution', () => {
  assert.deepEqual(diagnosticConsoleProbeEvidence({
    stderr: '',
    stdout: `${stdoutProbe}${stderrProbe}`,
  }, marker), {
    combined: true,
    stderr: false,
    stdout: true,
  })
})

test('rejects incomplete combined console evidence', () => {
  assert.equal(diagnosticConsoleProbeEvidence({
    stderr: `${marker}-stderr-before\n`,
    stdout: stdoutProbe,
  }, marker).combined, false)
})
