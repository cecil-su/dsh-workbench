import { describe, expect, it } from 'vitest'
import { DshRuntimeError } from '@dsh-workbench/runtime'

import {
  RuntimeDiagnosticLog,
  runtimeDiagnosticSnapshot,
  runtimeFailureDiagnostic,
} from './runtime-diagnostics.js'

const first = { generation: 1, profileId: 'profile-first' }
const second = { generation: 2, profileId: 'profile-second' }

describe('runtime diagnostics', () => {
  it('isolates generations and paginates with monotonic cursors', () => {
    const log = new RuntimeDiagnosticLog({
      clock: () => new Date('2026-08-23T00:00:00.000Z'),
    })
    log.append(first, { code: 'RUNTIME_READY', level: 'info', text: 'first' })
    log.append(second, { code: 'RUNTIME_READY', level: 'info', text: 'second-a' })
    log.append(second, { code: 'RUNTIME_READY', level: 'info', text: 'second-b' })

    expect(log.read(first).entries.map((entry) => entry.text)).toEqual(['first'])
    const page = log.read(second, { limit: 1 })
    expect(page.entries.map((entry) => entry.text)).toEqual(['second-a'])
    expect(log.read(second, { afterCursor: page.nextCursor }).entries.map((entry) => entry.text)).toEqual([
      'second-b',
    ])
    expect(page.latestCursor).toBe(3)
  })

  it('defensively redacts output before it enters the bounded ring', () => {
    const log = new RuntimeDiagnosticLog()
    log.appendOutput(first, {
      stream: 'stderr',
      text: 'before api_key=runtime-canary-secret after\n',
    })
    const serialized = JSON.stringify(log.read(first))
    expect(serialized).toContain('before')
    expect(serialized).toContain('after')
    expect(serialized).toContain('[REDACTED]')
    expect(serialized).not.toContain('runtime-canary-secret')
  })

  it('bounds entry count, byte capacity, line fragments, and read limits', () => {
    const log = new RuntimeDiagnosticLog({ maxBytes: 1024, maxEntries: 3 })
    for (let index = 0; index < 5; index += 1) {
      log.append(first, { code: 'DSH_STDOUT', level: 'info', text: `${String(index)}-${'x'.repeat(500)}` })
    }
    const page = log.read(first)
    expect(page.entries.length).toBeLessThanOrEqual(2)
    expect(page.entries.reduce((size, entry) => size + Buffer.byteLength(entry.text), 0)).toBeLessThanOrEqual(1024)
    expect(() => log.read(first, { limit: 201 })).toThrow(/limit/u)
    expect(() => log.read(first, { afterCursor: -1 })).toThrow(/cursor/u)
  })

  it('clears only the active context and emits a value-free snapshot', () => {
    const log = new RuntimeDiagnosticLog()
    log.append(first, { code: 'RUNTIME_READY', level: 'info', text: 'first' })
    log.append(second, { code: 'RUNTIME_READY', level: 'info', text: 'second' })
    log.clear(first)
    expect(log.read(first).entries).toEqual([])
    expect(log.read(second).entries).toHaveLength(1)

    const snapshot = runtimeDiagnosticSnapshot(
      { ...second, profileName: 'Second' },
      { app: '0.1.0', dsh: '0.1.1-rc.2' },
      'running',
      log.latestCursor,
    )
    expect(snapshot).toEqual({
      appVersion: '0.1.0',
      dshVersion: '0.1.1-rc.2',
      generation: 2,
      latestCursor: 2,
      profileId: 'profile-second',
      profileName: 'Second',
      runtimeState: 'running',
      schemaVersion: 1,
    })
    expect(JSON.stringify(snapshot)).not.toMatch(/path|credential|output/iu)
  })

  it('creates a bounded, copyable, redacted startup failure diagnostic', () => {
    const diagnostic = runtimeFailureDiagnostic(new DshRuntimeError(
      'readiness',
      'DSH did not become ready',
      { output: `Bearer startup-copy-canary\napi_key=${'x'.repeat(80_000)}` },
    ))
    expect(diagnostic).toContain('Recent DSH output')
    expect(diagnostic).toContain('[REDACTED]')
    expect(diagnostic).not.toContain('startup-copy-canary')
    expect(diagnostic.length).toBeLessThanOrEqual(64 * 1024)
  })

  it('includes sanitized output from an unexpected runtime exit diagnostic', () => {
    const error = Object.assign(new Error('DSH stopped unexpectedly'), {
      output: 'marker Authorization: Bearer unexpected-exit-canary',
    })
    const diagnostic = runtimeFailureDiagnostic(error)
    expect(diagnostic).toContain('marker')
    expect(diagnostic).toContain('[REDACTED]')
    expect(diagnostic).not.toContain('unexpected-exit-canary')
  })
})
