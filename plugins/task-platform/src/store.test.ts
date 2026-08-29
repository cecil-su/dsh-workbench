import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  PLATFORM_SCHEMA_VERSION,
  PlatformError,
  PlatformStore,
  type ActorContext,
} from './store.js'

const roots: string[] = []
const human: ActorContext = { actorKey: 'human:test', role: 'human', client: 'web', capabilities: ['*'] }
const intake: ActorContext = {
  actorKey: 'ai:intake', role: 'registry_manager', client: 'agent_runtime',
  capabilities: ['project:create', 'document:create', 'document:version', 'task:draft', 'task:confirm', 'owner:transfer', 'task:dependency'],
}

async function useStore(): Promise<PlatformStore> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-workbench-task-platform-'))
  roots.push(root)
  return new PlatformStore(root)
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true, maxRetries: 3, retryDelay: 100 })
})

function createProject(store: PlatformStore) {
  return store.createProject(intake, {
    key: 'demo', name: 'Demo project', workspacePath: 'E:/projects/demo', idempotencyKey: 'project-create-1',
  })
}
function createConfirmedTask(store: PlatformStore) {
  const project = createProject(store)
  const draft = store.createTaskDraft(intake, {
    projectId: project.id, title: 'Durable task', goal: 'Survive context loss', nextAction: 'Scout the repository',
    idempotencyKey: 'task-draft-1',
  })
  const task = store.confirmTask(intake, {
    taskId: draft.id, ownerKey: 'owner:alpha', ownerDisplayName: 'Owner Alpha', expectedVersion: draft.version,
    idempotencyKey: 'task-confirm-1',
  })
  return { project, task }
}

describe('PlatformStore schema and documents', () => {
  it('creates the complete authority schema with WAL and foreign keys', async () => {
    const store = await useStore()
    expect(store.schemaVersion()).toBe(PLATFORM_SCHEMA_VERSION)
    expect((store.database.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal')
    expect((store.database.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys).toBe(1)
    const names = (store.database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((row) => row.name)
    expect(names).toEqual(expect.arrayContaining([
      'projects', 'documents', 'document_versions', 'tasks', 'task_dependencies', 'owners',
      'assignments', 'assignment_events', 'sessions', 'session_events', 'context_packages', 'context_items',
      'prompt_versions', 'workflow_versions', 'approvals', 'artifacts', 'workspace_expectations',
      'workspace_observations', 'audit_events', 'command_receipts',
    ]))
    store.close()
  })

  it('migrates a schema-one database forward without losing authority data', async () => {
    const store = await useStore()
    const project = createProject(store)
    const root = store.dataRoot
    store.database.exec(`
      DROP TRIGGER assignment_events_no_update;
      DROP TRIGGER assignment_events_no_delete;
      DROP TRIGGER prompt_versions_no_delete;
      DROP TRIGGER workflow_versions_no_delete;
      DROP INDEX session_events_session_sequence;
      DROP INDEX artifacts_project_task;
      DROP TABLE assignment_events;
      DROP TABLE workspace_expectations;
      PRAGMA user_version = 1;
    `)
    store.close()
    const migrated = new PlatformStore(root)
    expect(migrated.schemaVersion()).toBe(PLATFORM_SCHEMA_VERSION)
    expect(migrated.getProject(project.id).key).toBe('demo')
    expect((migrated.database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='assignment_events'").get() as { name: string }).name).toBe('assignment_events')
    migrated.close()
  })

  it('versions platform documents and declares external document relationships', async () => {
    const store = await useStore()
    const project = createProject(store)
    const created = store.createDocument(human, {
      projectId: project.id, key: 'architecture', title: 'Architecture', authorityKind: 'platform',
      content: '# v1', idempotencyKey: 'document-create-1',
    })
    expect(created.document.latestVersion).toBe(1)
    const v2 = store.appendDocumentVersion(human, {
      documentId: created.document.id, content: '# v2\napi_key=must-not-persist', relationship: { supersedes: created.version?.id },
      idempotencyKey: 'document-version-2',
    })
    expect(v2).toMatchObject({ version: 2, content: '# v2\napi_key=[REDACTED]' })
    expect(() => store.database.prepare('UPDATE document_versions SET content = ? WHERE id = ?').run('tampered', v2.id)).toThrow(/append-only/u)

    const linked = store.createDocument(human, {
      projectId: project.id, key: 'project-readme', title: 'Project README', authorityKind: 'project-link',
      sourcePath: 'README.md', idempotencyKey: 'document-link-1',
    })
    expect(linked.document).toMatchObject({ writable: false, sourcePath: 'README.md', latestVersion: 0 })
    expect(() => store.appendDocumentVersion(human, {
      documentId: linked.document.id, content: 'copy', idempotencyKey: 'document-link-write',
    })).toThrowError(PlatformError)
    store.close()
  })
})

describe('task ownership and graph invariants', () => {
  it('requires confirmation, increments ownership epoch, and rejects stale owners', async () => {
    const store = await useStore()
    const { task } = createConfirmedTask(store)
    expect(task).toMatchObject({ status: 'open', ownerKey: 'owner:alpha', ownershipEpoch: 1, version: 2 })

    const replay = store.confirmTask(intake, {
      taskId: task.id, ownerKey: 'owner:alpha', expectedVersion: 1, idempotencyKey: 'task-confirm-1',
    })
    expect(replay).toEqual(task)

    const transferred = store.transferOwner(human, {
      taskId: task.id, newOwnerKey: 'owner:beta', expectedOwnershipEpoch: 1, reason: 'Handoff',
      idempotencyKey: 'owner-transfer-1',
    })
    expect(transferred).toMatchObject({ ownerKey: 'owner:beta', ownershipEpoch: 2 })

    const staleOwner: ActorContext = {
      actorKey: 'owner:alpha', role: 'task_owner', client: 'agent_runtime', capabilities: ['task:transition'],
    }
    expect(() => store.transitionTask(staleOwner, {
      taskId: task.id, status: 'in_progress', expectedVersion: transferred.version, expectedOwnershipEpoch: 1,
      nextAction: 'Write code', reason: 'Starting', idempotencyKey: 'stale-transition',
    })).toThrowError(/epoch changed/u)
    expect(store.listAudit({ taskId: task.id })).toEqual(expect.arrayContaining([
      expect.objectContaining({ decision: 'rejected', command: 'task.transition' }),
    ]))
    store.close()
  })

  it('enforces a single next action, blocked recovery data, and dependency acyclicity', async () => {
    const store = await useStore()
    const { project, task } = createConfirmedTask(store)
    const owner: ActorContext = { actorKey: 'owner:alpha', role: 'task_owner', client: 'agent_runtime', capabilities: ['task:transition'] }
    expect(() => store.transitionTask(owner, {
      taskId: task.id, status: 'blocked', expectedVersion: task.version, expectedOwnershipEpoch: 1,
      reason: 'Waiting', idempotencyKey: 'blocked-invalid',
    })).toThrowError(/blocker and recoveryCondition/u)
    const blocked = store.transitionTask(owner, {
      taskId: task.id, status: 'blocked', expectedVersion: task.version, expectedOwnershipEpoch: 1,
      blocker: 'External API unavailable', recoveryCondition: 'API health check passes', nextAction: 'Poll owner approval',
      reason: 'External dependency', idempotencyKey: 'blocked-valid',
    })
    expect(blocked).toMatchObject({ status: 'blocked', nextAction: 'Poll owner approval' })

    const otherDraft = store.createTaskDraft(intake, {
      projectId: project.id, title: 'Dependency', goal: 'Provide API', nextAction: 'Implement endpoint', idempotencyKey: 'task-draft-2',
    })
    const other = store.confirmTask(intake, {
      taskId: otherDraft.id, ownerKey: 'owner:gamma', expectedVersion: 1, idempotencyKey: 'task-confirm-2',
    })
    store.addDependency(intake, { taskId: task.id, dependsOnTaskId: other.id, type: 'blocks', idempotencyKey: 'dep-1' })
    expect(() => store.addDependency(intake, {
      taskId: other.id, dependsOnTaskId: task.id, type: 'blocks', idempotencyKey: 'dep-cycle',
    })).toThrowError(/cycle/u)
    store.close()
  })
})

describe('assignments, sessions, context, and audit', () => {
  it('persists immutable assignment inputs before runtime work', async () => {
    const store = await useStore()
    const { task } = createConfirmedTask(store)
    const owner: ActorContext = { actorKey: 'owner:alpha', role: 'task_owner', client: 'agent_runtime', capabilities: ['assignment:create'] }
    const assignment = store.createAssignment(owner, {
      taskId: task.id, expectedOwnershipEpoch: 1, stage: 'scout', role: 'stage_agent',
      capabilitySet: ['fs:read', 'git:observe'], sourceScope: ['src/**'], requiredArtifacts: ['scout-report'],
      acceptance: ['Report cites files'], stopConditions: ['No writes'], idempotencyKey: 'assignment-1',
    })
    expect(assignment).toMatchObject({ ownershipEpoch: 1, stage: 'scout', status: 'pending' })
    expect(() => store.database.prepare('UPDATE assignments SET stage = ? WHERE id = ?').run('writer', assignment.id)).toThrow(/immutable/u)
    store.close()
  })

  it('records observable session events, filters secrets, and builds sourced context manifests', async () => {
    const store = await useStore()
    const { project, task } = createConfirmedTask(store)
    const runtime: ActorContext = { actorKey: 'runtime:one', role: 'stage_agent', client: 'agent_runtime', capabilities: ['session:open', 'session:event', 'context:create'] }
    const context = store.createContextPackage(runtime, {
      projectId: project.id, taskId: task.id, ownershipEpoch: 1, byteBudget: 64_000, tokenBudget: 8_000,
      items: [{ sourceDomain: 'task', sourceId: task.id, sourceVersion: String(task.version), selectionReason: 'Current authority', contentHash: 'a'.repeat(64), sensitivity: 'internal' }],
      idempotencyKey: 'context-1',
    })
    expect(context).toMatchObject({ taskId: task.id, ownershipEpoch: 1, items: [expect.objectContaining({ sourceDomain: 'task' })] })
    const session = store.openSession(runtime, {
      projectId: project.id, taskId: task.id, role: 'stage_agent', client: 'codex', model: 'test-model',
      contextPackageId: context.id, idempotencyKey: 'session-1',
    })
    const event = store.appendSessionEvent(runtime, {
      sessionId: session.id, type: 'tool.result', payload: { output: 'Authorization: Bearer string-secret-must-not-persist', accessToken: 'must-not-persist' },
      idempotencyKey: 'session-event-1',
    })
    expect(event.sequence).toBe(1)
    const stored = store.database.prepare('SELECT payload_json FROM session_events WHERE session_id = ?').get(session.id) as { payload_json: string }
    expect(stored.payload_json).toContain('[REDACTED]')
    expect(stored.payload_json).not.toContain('must-not-persist')
    expect(stored.payload_json).not.toContain('string-secret-must-not-persist')
    expect(() => store.database.prepare('DELETE FROM session_events WHERE session_id = ?').run(session.id)).toThrow(/append-only/u)
    store.close()
  })

  it('runs immutable prompt, workflow, assignment, and session lifecycles', async () => {
    const store = await useStore()
    const { project, task } = createConfirmedTask(store)
    const prompt = store.createPromptVersion(human, { key: 'scout', content: 'Inspect only.', idempotencyKey: 'prompt-v1' })
    const workflow = store.createWorkflowVersion(human, { key: 'default', definition: { stages: ['scout', 'implement'] }, idempotencyKey: 'workflow-v1' })
    const owner: ActorContext = { actorKey: 'owner:alpha', role: 'task_owner', client: 'agent_runtime', capabilities: ['*'] }
    const assignment = store.createAssignment(owner, {
      taskId: task.id, expectedOwnershipEpoch: 1, stage: 'scout', role: 'stage_agent', promptVersionId: prompt.id,
      workflowVersionId: workflow.id, capabilitySet: ['fs:read'], sourceScope: ['src/**'], requiredArtifacts: ['report'],
      acceptance: ['Cites evidence'], stopConditions: ['No writes'], idempotencyKey: 'assignment-lifecycle',
    })
    store.appendAssignmentEvent(owner, { assignmentId: assignment.id, expectedOwnershipEpoch: 1, type: 'dispatched', idempotencyKey: 'assignment-dispatch' })
    const stageAgent: ActorContext = { actorKey: 'stage:one', role: 'stage_agent', client: 'agent_runtime', capabilities: ['assignment:reported', 'session:open', 'session:event', 'session:close'] }
    store.appendAssignmentEvent(stageAgent, { assignmentId: assignment.id, expectedOwnershipEpoch: 1, type: 'reported', payload: { summary: 'done' }, idempotencyKey: 'assignment-report' })
    store.appendAssignmentEvent(owner, { assignmentId: assignment.id, expectedOwnershipEpoch: 1, type: 'accepted', payload: { reason: 'evidence complete' }, idempotencyKey: 'assignment-accept' })
    expect(store.getAssignment(assignment.id).status).toBe('accepted')
    expect(store.listAssignmentEvents(assignment.id).map((item) => item.type)).toEqual(['dispatched', 'reported', 'accepted'])
    expect(() => store.database.prepare('DELETE FROM assignment_events WHERE assignment_id=?').run(assignment.id)).toThrow(/append-only/u)

    const session = store.openSession(stageAgent, { projectId: project.id, taskId: task.id, assignmentId: assignment.id, role: 'stage_agent', client: 'codex', promptVersionId: prompt.id, workflowVersionId: workflow.id, idempotencyKey: 'session-lifecycle' })
    store.appendSessionEvent(stageAgent, { sessionId: session.id, type: 'report.submitted', payload: { assignmentId: assignment.id }, idempotencyKey: 'session-report-event' })
    expect(store.listSessionEvents(session.id)).toHaveLength(1)
    expect(store.closeSession(stageAgent, { sessionId: session.id, status: 'completed', idempotencyKey: 'session-close' }).status).toBe('completed')
    const recovery = store.createTaskRecoveryContext(human, { taskId: task.id, tokenBudget: 8_000, byteBudget: 128_000, idempotencyKey: 'recovery-context' })
    expect(recovery.items.map((item) => item.sourceDomain)).toEqual(expect.arrayContaining(['task', 'task-event', 'assignment', 'session']))
    expect(store.listTaskEvents(task.id).length).toBeGreaterThan(2)
    store.close()
  })

  it('persists approvals, artifacts, workspace expected/actual views, and backups', async () => {
    const store = await useStore()
    const { project, task } = createConfirmedTask(store)
    const approval = store.requestApproval(human, { projectId: project.id, taskId: task.id, kind: 'git-integration', request: { branch: 'main', secretToken: 'never-store' }, idempotencyKey: 'approval-request' })
    expect(approval.request).toMatchObject({ secretToken: '[REDACTED]' })
    expect(store.decideApproval(human, { approvalId: approval.id, decision: 'approved', reason: 'Reviewed', idempotencyKey: 'approval-decision' }).status).toBe('approved')

    const artifact = store.createArtifact(human, { projectId: project.id, taskId: task.id, mediaType: 'text/plain', sensitivity: 'internal', acl: [human.actorKey], data: Buffer.from('evidence'), idempotencyKey: 'artifact-create' })
    expect(store.readArtifact(human, artifact.id).data.toString()).toBe('evidence')
    const outsider: ActorContext = { actorKey: 'human:other', role: 'human', client: 'web', capabilities: ['artifact:read'] }
    expect(() => store.readArtifact(outsider, artifact.id)).toThrow(/ACL denied/u)
    expect(store.tombstoneArtifact(human, { artifactId: artifact.id, reason: 'Test retention lifecycle', idempotencyKey: 'artifact-tombstone' }).lifecycle).toBe('tombstoned')
    const retentionSystem: ActorContext = { actorKey: 'system:retention', role: 'system', client: 'system', capabilities: ['artifact:purge'] }
    expect(store.purgeArtifact(retentionSystem, { artifactId: artifact.id, idempotencyKey: 'artifact-purge' }).lifecycle).toBe('deleted')
    expect(store.listArtifacts({ projectId: project.id })).toEqual([])

    const expected = store.setWorkspaceExpectation(human, { projectId: project.id, branch: 'main', head: 'a'.repeat(40), cleanRequired: true, expectedVersion: 0, idempotencyKey: 'workspace-expect' })
    expect(expected.version).toBe(1)
    const gitObserver: ActorContext = { actorKey: 'git:observer', role: 'git_integrator', client: 'system', capabilities: ['workspace:observe'] }
    store.recordWorkspaceObservation(gitObserver, { projectId: project.id, taskId: task.id, repositoryRoot: 'E:/projects/demo', worktree: 'E:/projects/demo', branch: 'main', head: 'b'.repeat(40), dirty: true, sourceCommand: 'git status --porcelain=v2', idempotencyKey: 'workspace-observe' })
    expect(store.listWorkspaceObservations(project.id)[0]).toMatchObject({ dirty: true, branch: 'main' })
    expect(store.analyticsSnapshot(project.id)).toMatchObject({ taskStatus: { open: 1 }, ownerLoad: [{ ownerKey: 'owner:alpha', activeTasks: 1 }] })

    const backupRoot = await mkdtemp(join(tmpdir(), 'dsh-workbench-task-platform-backup-'))
    roots.push(backupRoot)
    const backup = store.createBackup(backupRoot)
    await expect(access(backup)).resolves.toBeUndefined()
    store.close()
  })

  it('enforces project, task, and ownership scopes on application queries and commands', async () => {
    const store = await useStore()
    const { project, task } = createConfirmedTask(store)
    const scoped: ActorContext = { actorKey: 'stage:scoped', role: 'stage_agent', client: 'agent_runtime', capabilities: ['task:read', 'session:event'], projectScope: [project.id], taskScope: [task.id], ownershipEpoch: 1 }
    expect(store.query(scoped, { capability: 'task:read', command: 'task.get', projectId: project.id, taskId: task.id, ownershipEpoch: 1 }, () => store.getTask(task.id)).id).toBe(task.id)
    expect(() => store.query(scoped, { capability: 'task:read', command: 'task.get', projectId: 'project_other', taskId: task.id }, () => task)).toThrow(/project scope/u)
    expect(() => store.query(scoped, { capability: 'task:read', command: 'task.get', projectId: project.id, taskId: task.id, ownershipEpoch: 2 }, () => task)).toThrow(/epoch is stale/u)
    store.close()
  })

  it('keeps analyst and optimizer roles read-only', async () => {
    const store = await useStore()
    const analyst: ActorContext = { actorKey: 'analyst:one', role: 'process_analyst', client: 'agent_runtime', capabilities: ['project:create'] }
    expect(() => store.createProject(analyst, {
      key: 'forbidden', name: 'Forbidden', idempotencyKey: 'analyst-write',
    })).toThrowError(/read-only/u)
    expect(store.listAudit()).toEqual([expect.objectContaining({ actorKey: 'analyst:one', decision: 'rejected' })])
    store.close()
  })
})
