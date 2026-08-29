import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

import { assertTrustedLoopbackRequest, inject, parsePlatformCommand } from './index.js'
import { PlatformError } from './store.js'

describe('task platform plugin wiring', () => {
  it('waits for the actual DSH Tool and Web Server services', () => {
    expect(inject).toEqual(['tools', 'webServer'])
  })

  it('registers sourced recovery, observable history, Git evidence, documents, and analytics for AI clients', async () => {
    const source = await readFile(new URL('./index.ts', import.meta.url), 'utf8')
    for (const name of ['platform_document_list', 'platform_task_event_list', 'platform_context_recover', 'platform_workspace_observe', 'platform_analytics_show']) expect(source).toContain(`name: '${name}'`)
    expect(source).not.toContain('parameters: { sql:')
  })
})

describe('task platform HTTP parser', () => {
  it('accepts project, draft, confirmation, transition, and session commands', () => {
    expect(parsePlatformCommand({
      action: 'project-create', key: 'demo', name: 'Demo', idempotencyKey: 'request-1',
    })).toEqual({
      action: 'project-create', key: 'demo', name: 'Demo', description: undefined,
      workspacePath: undefined, idempotencyKey: 'request-1',
    })
    expect(parsePlatformCommand({
      action: 'task-draft', projectId: 'project_1', title: 'Task', goal: 'Goal',
      nextAction: 'Scout', idempotencyKey: 'request-2',
    })).toMatchObject({ action: 'task-draft', nextAction: 'Scout' })
    expect(parsePlatformCommand({
      action: 'task-confirm', taskId: 'task_1', ownerKey: 'owner:one', expectedVersion: 1,
      idempotencyKey: 'request-3',
    })).toMatchObject({ action: 'task-confirm', ownerKey: 'owner:one' })
    expect(parsePlatformCommand({
      action: 'task-transition', taskId: 'task_1', status: 'blocked', expectedVersion: 2,
      expectedOwnershipEpoch: 1, blocker: 'API', recoveryCondition: 'API ready', nextAction: 'Wait',
      reason: 'External', idempotencyKey: 'request-4',
    })).toMatchObject({ action: 'task-transition', status: 'blocked' })
    expect(parsePlatformCommand({
      action: 'session-event', sessionId: 'session_1', type: 'tool.result', payload: { ok: true },
      idempotencyKey: 'request-5',
    })).toMatchObject({ action: 'session-event', type: 'tool.result' })
  })

  it('accepts assignment, approval, artifact, and workspace control-plane commands', () => {
    expect(parsePlatformCommand({ action: 'operations-snapshot', projectId: 'project_1', taskId: 'task_1' })).toMatchObject({ action: 'operations-snapshot', taskId: 'task_1' })
    expect(parsePlatformCommand({ action: 'assignment-event', assignmentId: 'assignment_1', expectedOwnershipEpoch: 2, type: 'reported', payload: { summary: 'done' }, idempotencyKey: 'request-6' })).toMatchObject({ action: 'assignment-event', type: 'reported' })
    expect(parsePlatformCommand({ action: 'approval-request', projectId: 'project_1', kind: 'git-integration', request: { branch: 'main' }, idempotencyKey: 'request-7' })).toMatchObject({ action: 'approval-request', kind: 'git-integration' })
    expect(parsePlatformCommand({ action: 'artifact-create', projectId: 'project_1', mediaType: 'text/plain', sensitivity: 'internal', acl: ['human:local'], dataBase64: 'b2s=', idempotencyKey: 'request-8' })).toMatchObject({ action: 'artifact-create', dataBase64: 'b2s=' })
    expect(parsePlatformCommand({ action: 'workspace-expectation-set', projectId: 'project_1', branch: 'main', cleanRequired: true, expectedVersion: 0, idempotencyKey: 'request-9' })).toMatchObject({ action: 'workspace-expectation-set', cleanRequired: true })
  })

  it('rejects unknown fields and malformed bodies', () => {
    expect(() => parsePlatformCommand({ action: 'snapshot', sql: 'DROP TABLE tasks' })).toThrowError(PlatformError)
    expect(() => parsePlatformCommand({ action: 'task-confirm', taskId: 'task_1' })).toThrowError(PlatformError)
    expect(() => parsePlatformCommand(null)).toThrowError(PlatformError)
  })
})

describe('task platform HTTP origin policy', () => {
  it('accepts only the exact loopback host and same origin', () => {
    expect(() => assertTrustedLoopbackRequest({
      host: '127.0.0.1:52130', origin: 'http://127.0.0.1:52130', 'sec-fetch-site': 'same-origin',
    }, 52130)).not.toThrow()
    expect(() => assertTrustedLoopbackRequest({
      host: 'localhost:52130', origin: 'http://localhost:52130',
    }, 52130)).toThrowError(PlatformError)
    expect(() => assertTrustedLoopbackRequest({
      host: '127.0.0.1:52130', origin: 'https://attacker.example',
    }, 52130)).toThrowError(PlatformError)
  })
})
