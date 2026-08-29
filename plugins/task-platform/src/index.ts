import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type JsonValue, type ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'

import {
  PLATFORM_SCHEMA_VERSION,
  PlatformError,
  PlatformStore,
  type ActorContext,
  type AssignmentView,
  type AuditView,
  type ContextPackageView,
  type DependencyView,
  type DocumentVersionView,
  type DocumentView,
  type ProjectView,
  type SessionView,
  type TaskStatus,
  type TaskView,
} from './store.js'
import { observeRepository, resolveRepository } from './git.js'

export const name = 'dsh-workbench-task-platform'
export const inject = ['tools', 'webServer']
export const serviceName = 'dshWorkbenchTaskPlatform'
export const TASK_PLATFORM_ROUTE = '/workbench/task-platform'
export const Config = z.object({ dataRoot: z.string().default('') })
export interface Config { dataRoot?: string }

const MAX_HTTP_BODY_BYTES = 512 * 1024
const MUTATING_TOOLS = new Set([
  'platform_project_create',
  'platform_task_confirm',
  'platform_task_transfer_owner',
])

const WEB_ACTOR: ActorContext = Object.freeze({
  actorKey: 'human:local',
  role: 'human',
  client: 'web',
  capabilities: Object.freeze(['*']),
})
const RECOVERY_ACTOR: ActorContext = Object.freeze({
  actorKey: 'system:context-recovery',
  role: 'system',
  client: 'agent_runtime',
  capabilities: Object.freeze(['context:create']),
})
const INTAKE_ACTOR: ActorContext = Object.freeze({
  actorKey: 'ai:task-intake',
  role: 'registry_manager',
  client: 'agent_runtime',
  capabilities: Object.freeze([
    'project:create', 'task:draft', 'task:confirm', 'owner:transfer',
    'task:dependency', 'document:create', 'document:version',
    'platform:read', 'project:read', 'document:read', 'task:read', 'assignment:read', 'session:read', 'approval:read', 'analytics:read', 'workspace:observe', 'audit:read',
  ]),
})

export interface TaskPlatformSnapshot {
  schemaVersion: number
  projects: ProjectView[]
  tasks: TaskView[]
  audit: AuditView[]
}

export interface TaskPlatformOperationsSnapshot {
  documents: DocumentView[]
  dependencies: DependencyView[]
  assignments: ReturnType<PlatformStore['listAssignments']>
  taskEvents: ReturnType<PlatformStore['listTaskEvents']>
  sessions: ReturnType<PlatformStore['listSessions']>
  approvals: ReturnType<PlatformStore['listApprovals']>
  artifacts: ReturnType<PlatformStore['listArtifacts']>
  workspaceExpectation: ReturnType<PlatformStore['getWorkspaceExpectation']>
  workspaceObservations: ReturnType<PlatformStore['listWorkspaceObservations']>
  promptVersions: ReturnType<PlatformStore['listPromptVersions']>
  workflowVersions: ReturnType<PlatformStore['listWorkflowVersions']>
  analytics: ReturnType<PlatformStore['analyticsSnapshot']>
}

export interface TaskPlatformService {
  snapshot(actor: ActorContext, input?: { projectId?: string; status?: TaskStatus; query?: string }): TaskPlatformSnapshot
  operationsSnapshot(actor: ActorContext, input: { projectId: string; taskId?: string }): TaskPlatformOperationsSnapshot
  listProjects(actor: ActorContext, limit?: number): ProjectView[]
  getProject(actor: ActorContext, projectId: string): ProjectView
  createProject(actor: ActorContext, input: Parameters<PlatformStore['createProject']>[1]): ProjectView
  createDocument(actor: ActorContext, input: Parameters<PlatformStore['createDocument']>[1]): { document: DocumentView; version?: DocumentVersionView }
  appendDocumentVersion(actor: ActorContext, input: Parameters<PlatformStore['appendDocumentVersion']>[1]): DocumentVersionView
  getDocument(actor: ActorContext, documentId: string): DocumentView
  listDocuments(actor: ActorContext, projectId?: string, limit?: number): DocumentView[]
  getDocumentVersion(actor: ActorContext, documentId: string, version?: number): DocumentVersionView
  listTasks(actor: ActorContext, input?: Parameters<PlatformStore['listTasks']>[0]): TaskView[]
  getTask(actor: ActorContext, taskId: string): TaskView
  listTaskEvents(actor: ActorContext, taskId: string, limit?: number): ReturnType<PlatformStore['listTaskEvents']>
  createTaskRecoveryContext(actor: ActorContext, input: Parameters<PlatformStore['createTaskRecoveryContext']>[1]): ContextPackageView
  createTaskDraft(actor: ActorContext, input: Parameters<PlatformStore['createTaskDraft']>[1]): TaskView
  confirmTask(actor: ActorContext, input: Parameters<PlatformStore['confirmTask']>[1]): TaskView
  transferOwner(actor: ActorContext, input: Parameters<PlatformStore['transferOwner']>[1]): TaskView
  transitionTask(actor: ActorContext, input: Parameters<PlatformStore['transitionTask']>[1]): TaskView
  addDependency(actor: ActorContext, input: Parameters<PlatformStore['addDependency']>[1]): DependencyView
  listDependencies(actor: ActorContext, taskId?: string, limit?: number): DependencyView[]
  createPromptVersion(actor: ActorContext, input: Parameters<PlatformStore['createPromptVersion']>[1]): ReturnType<PlatformStore['createPromptVersion']>
  createWorkflowVersion(actor: ActorContext, input: Parameters<PlatformStore['createWorkflowVersion']>[1]): ReturnType<PlatformStore['createWorkflowVersion']>
  listPromptVersions(actor: ActorContext, key?: string, limit?: number): ReturnType<PlatformStore['listPromptVersions']>
  listWorkflowVersions(actor: ActorContext, key?: string, limit?: number): ReturnType<PlatformStore['listWorkflowVersions']>
  createAssignment(actor: ActorContext, input: Parameters<PlatformStore['createAssignment']>[1]): AssignmentView
  getAssignment(actor: ActorContext, assignmentId: string): AssignmentView
  listAssignments(actor: ActorContext, input?: Parameters<PlatformStore['listAssignments']>[0]): ReturnType<PlatformStore['listAssignments']>
  appendAssignmentEvent(actor: ActorContext, input: Parameters<PlatformStore['appendAssignmentEvent']>[1]): ReturnType<PlatformStore['appendAssignmentEvent']>
  listAssignmentEvents(actor: ActorContext, assignmentId: string): ReturnType<PlatformStore['listAssignmentEvents']>
  openSession(actor: ActorContext, input: Parameters<PlatformStore['openSession']>[1]): SessionView
  appendSessionEvent(actor: ActorContext, input: Parameters<PlatformStore['appendSessionEvent']>[1]): ReturnType<PlatformStore['appendSessionEvent']>
  closeSession(actor: ActorContext, input: Parameters<PlatformStore['closeSession']>[1]): SessionView
  listSessions(actor: ActorContext, input?: Parameters<PlatformStore['listSessions']>[0]): ReturnType<PlatformStore['listSessions']>
  listSessionEvents(actor: ActorContext, sessionId: string, limit?: number): ReturnType<PlatformStore['listSessionEvents']>
  createContextPackage(actor: ActorContext, input: Parameters<PlatformStore['createContextPackage']>[1]): ContextPackageView
  getContextPackage(actor: ActorContext, contextId: string): ContextPackageView
  requestApproval(actor: ActorContext, input: Parameters<PlatformStore['requestApproval']>[1]): ReturnType<PlatformStore['requestApproval']>
  decideApproval(actor: ActorContext, input: Parameters<PlatformStore['decideApproval']>[1]): ReturnType<PlatformStore['decideApproval']>
  listApprovals(actor: ActorContext, input?: Parameters<PlatformStore['listApprovals']>[0]): ReturnType<PlatformStore['listApprovals']>
  createArtifact(actor: ActorContext, input: Parameters<PlatformStore['createArtifact']>[1]): ReturnType<PlatformStore['createArtifact']>
  tombstoneArtifact(actor: ActorContext, input: Parameters<PlatformStore['tombstoneArtifact']>[1]): ReturnType<PlatformStore['tombstoneArtifact']>
  purgeArtifact(actor: ActorContext, input: Parameters<PlatformStore['purgeArtifact']>[1]): ReturnType<PlatformStore['purgeArtifact']>
  listArtifacts(actor: ActorContext, input?: Parameters<PlatformStore['listArtifacts']>[0]): ReturnType<PlatformStore['listArtifacts']>
  setWorkspaceExpectation(actor: ActorContext, input: Parameters<PlatformStore['setWorkspaceExpectation']>[1]): ReturnType<PlatformStore['setWorkspaceExpectation']>
  getWorkspaceExpectation(actor: ActorContext, projectId: string): ReturnType<PlatformStore['getWorkspaceExpectation']>
  observeWorkspace(actor: ActorContext, input: { projectId: string; taskId?: string; idempotencyKey: string; correlationKey?: string; signal?: AbortSignal }): Promise<ReturnType<PlatformStore['recordWorkspaceObservation']>>
  listWorkspaceObservations(actor: ActorContext, projectId: string, limit?: number): ReturnType<PlatformStore['listWorkspaceObservations']>
  analyticsSnapshot(actor: ActorContext, projectId: string): ReturnType<PlatformStore['analyticsSnapshot']>
  listAudit(actor: ActorContext, input?: Parameters<PlatformStore['listAudit']>[0]): AuditView[]
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    dshWorkbenchTaskPlatform: TaskPlatformService
  }
}

type PlatformCommand =
  | { action: 'snapshot'; projectId?: string; status?: TaskStatus; query?: string }
  | { action: 'operations-snapshot'; projectId: string; taskId?: string }
  | { action: 'project-create'; key: string; name: string; description?: string; workspacePath?: string; idempotencyKey: string }
  | { action: 'task-draft'; projectId: string; parentTaskId?: string; title: string; goal: string; priority?: number; risk?: string; nextAction?: string; idempotencyKey: string }
  | { action: 'task-confirm'; taskId: string; ownerKey: string; ownerDisplayName?: string; expectedVersion: number; idempotencyKey: string }
  | { action: 'task-transition'; taskId: string; status: Exclude<TaskStatus, 'draft'>; expectedVersion: number; expectedOwnershipEpoch: number; nextAction?: string; blocker?: string; recoveryCondition?: string; reason: string; idempotencyKey: string }
  | { action: 'owner-transfer'; taskId: string; newOwnerKey: string; newOwnerDisplayName?: string; expectedOwnershipEpoch: number; reason: string; idempotencyKey: string }
  | { action: 'dependency-add'; taskId: string; dependsOnTaskId: string; type: DependencyView['type']; idempotencyKey: string }
  | { action: 'document-create'; projectId?: string; key: string; title: string; authorityKind: DocumentView['authorityKind']; sourcePath?: string; content?: string; relationship?: Record<string, unknown>; idempotencyKey: string }
  | { action: 'document-version'; documentId: string; content: string; relationship?: Record<string, unknown>; idempotencyKey: string }
  | { action: 'document-get'; documentId: string; version?: number }
  | { action: 'prompt-version-create'; key: string; content: string; idempotencyKey: string }
  | { action: 'workflow-version-create'; key: string; definition: Record<string, unknown>; idempotencyKey: string }
  | { action: 'assignment-create'; taskId: string; expectedOwnershipEpoch: number; stage: string; role: string; promptVersionId?: string; workflowVersionId?: string; contextPackageId?: string; capabilitySet: string[]; sourceScope: string[]; requiredArtifacts: string[]; acceptance: string[]; stopConditions: string[]; idempotencyKey: string }
  | { action: 'assignment-event'; assignmentId: string; expectedOwnershipEpoch: number; type: 'dispatched' | 'reported' | 'accepted' | 'rejected' | 'cancelled'; payload?: Record<string, unknown>; idempotencyKey: string }
  | { action: 'session-open'; projectId: string; taskId?: string; assignmentId?: string; role: string; client: string; model?: string; contextPackageId?: string; parentSessionId?: string; continuationOfSessionId?: string; runtimeId?: string; idempotencyKey: string }
  | { action: 'session-event'; sessionId: string; type: string; payload: Record<string, unknown>; idempotencyKey: string }
  | { action: 'session-close'; sessionId: string; status: 'compacted' | 'completed' | 'failed' | 'abandoned'; idempotencyKey: string }
  | { action: 'context-recover'; taskId: string; tokenBudget?: number; byteBudget: number; idempotencyKey: string }
  | { action: 'context-create'; projectId: string; taskId?: string; ownershipEpoch?: number; tokenBudget?: number; byteBudget: number; items: Array<{ sourceDomain: string; sourceId: string; sourceVersion: string; selectionReason: string; contentHash: string; sensitivity: 'public' | 'internal' | 'confidential' | 'restricted' }>; idempotencyKey: string }
  | { action: 'approval-request'; projectId: string; taskId?: string; kind: string; request: Record<string, unknown>; idempotencyKey: string }
  | { action: 'approval-decide'; approvalId: string; decision: 'approved' | 'rejected' | 'cancelled'; reason: string; idempotencyKey: string }
  | { action: 'artifact-create'; projectId: string; taskId?: string; assignmentId?: string; mediaType: string; sensitivity: 'public' | 'internal' | 'confidential' | 'restricted'; acl: string[]; retentionUntil?: string; dataBase64: string; idempotencyKey: string }
  | { action: 'artifact-tombstone'; artifactId: string; reason: string; idempotencyKey: string }
  | { action: 'workspace-expectation-set'; projectId: string; branch?: string; head?: string; cleanRequired: boolean; expectedVersion: number; idempotencyKey: string }
  | { action: 'workspace-observe'; projectId: string; taskId?: string; idempotencyKey: string }
  | { action: 'audit-list'; projectId?: string; taskId?: string; limit?: number }

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PlatformError('Request body must be an object', 'INVALID_COMMAND')
  return value as Record<string, unknown>
}
function exact(command: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set(['action', ...required, ...optional])
  for (const key of Object.keys(command)) if (!allowed.has(key)) throw new PlatformError(`Unexpected request field ${key}`, 'INVALID_COMMAND')
  for (const key of required) if (!(key in command)) throw new PlatformError(`Missing request field ${key}`, 'INVALID_COMMAND')
}
function text(command: Record<string, unknown>, field: string, optional = false): string | undefined {
  const value = command[field]
  if (value === undefined && optional) return undefined
  if (typeof value !== 'string' || !value.trim() || value.length > 64 * 1024) throw new PlatformError(`${field} is invalid`, 'INVALID_COMMAND')
  return value
}
function numberValue(command: Record<string, unknown>, field: string, optional = false): number | undefined {
  const value = command[field]
  if (value === undefined && optional) return undefined
  if (!Number.isInteger(value)) throw new PlatformError(`${field} must be an integer`, 'INVALID_COMMAND')
  return value as number
}
function booleanValue(command: Record<string, unknown>, field: string): boolean {
  if (typeof command[field] !== 'boolean') throw new PlatformError(`${field} must be a boolean`, 'INVALID_COMMAND')
  return command[field] as boolean
}
function strings(command: Record<string, unknown>, field: string): string[] {
  const value = command[field]
  if (!Array.isArray(value) || value.length > 64 || value.some((item) => typeof item !== 'string')) throw new PlatformError(`${field} must be a bounded string array`, 'INVALID_COMMAND')
  return value as string[]
}
function record(command: Record<string, unknown>, field: string, optional = false): Record<string, unknown> | undefined {
  const value = command[field]
  if (value === undefined && optional) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PlatformError(`${field} must be an object`, 'INVALID_COMMAND')
  return value as Record<string, unknown>
}

export function parsePlatformCommand(value: unknown): PlatformCommand {
  const command = object(value)
  const action = text(command, 'action')
  switch (action) {
    case 'snapshot':
      exact(command, [], ['projectId', 'status', 'query'])
      return { action, projectId: text(command, 'projectId', true), status: text(command, 'status', true) as TaskStatus | undefined, query: text(command, 'query', true) }
    case 'operations-snapshot':
      exact(command, ['projectId'], ['taskId'])
      return { action, projectId: text(command, 'projectId')!, taskId: text(command, 'taskId', true) }
    case 'project-create':
      exact(command, ['key', 'name', 'idempotencyKey'], ['description', 'workspacePath'])
      return { action, key: text(command, 'key')!, name: text(command, 'name')!, description: text(command, 'description', true), workspacePath: text(command, 'workspacePath', true), idempotencyKey: text(command, 'idempotencyKey')! }
    case 'task-draft':
      exact(command, ['projectId', 'title', 'goal', 'idempotencyKey'], ['parentTaskId', 'priority', 'risk', 'nextAction'])
      return { action, projectId: text(command, 'projectId')!, parentTaskId: text(command, 'parentTaskId', true), title: text(command, 'title')!, goal: text(command, 'goal')!, priority: numberValue(command, 'priority', true), risk: text(command, 'risk', true), nextAction: text(command, 'nextAction', true), idempotencyKey: text(command, 'idempotencyKey')! }
    case 'task-confirm':
      exact(command, ['taskId', 'ownerKey', 'expectedVersion', 'idempotencyKey'], ['ownerDisplayName'])
      return { action, taskId: text(command, 'taskId')!, ownerKey: text(command, 'ownerKey')!, ownerDisplayName: text(command, 'ownerDisplayName', true), expectedVersion: numberValue(command, 'expectedVersion')!, idempotencyKey: text(command, 'idempotencyKey')! }
    case 'task-transition':
      exact(command, ['taskId', 'status', 'expectedVersion', 'expectedOwnershipEpoch', 'reason', 'idempotencyKey'], ['nextAction', 'blocker', 'recoveryCondition'])
      return { action, taskId: text(command, 'taskId')!, status: text(command, 'status')! as Exclude<TaskStatus, 'draft'>, expectedVersion: numberValue(command, 'expectedVersion')!, expectedOwnershipEpoch: numberValue(command, 'expectedOwnershipEpoch')!, nextAction: text(command, 'nextAction', true), blocker: text(command, 'blocker', true), recoveryCondition: text(command, 'recoveryCondition', true), reason: text(command, 'reason')!, idempotencyKey: text(command, 'idempotencyKey')! }
    case 'owner-transfer':
      exact(command, ['taskId', 'newOwnerKey', 'expectedOwnershipEpoch', 'reason', 'idempotencyKey'], ['newOwnerDisplayName'])
      return { action, taskId: text(command, 'taskId')!, newOwnerKey: text(command, 'newOwnerKey')!, newOwnerDisplayName: text(command, 'newOwnerDisplayName', true), expectedOwnershipEpoch: numberValue(command, 'expectedOwnershipEpoch')!, reason: text(command, 'reason')!, idempotencyKey: text(command, 'idempotencyKey')! }
    case 'dependency-add':
      exact(command, ['taskId', 'dependsOnTaskId', 'type', 'idempotencyKey'])
      return { action, taskId: text(command, 'taskId')!, dependsOnTaskId: text(command, 'dependsOnTaskId')!, type: text(command, 'type')! as DependencyView['type'], idempotencyKey: text(command, 'idempotencyKey')! }
    case 'document-create':
      exact(command, ['key', 'title', 'authorityKind', 'idempotencyKey'], ['projectId', 'sourcePath', 'content', 'relationship'])
      return { action, projectId: text(command, 'projectId', true), key: text(command, 'key')!, title: text(command, 'title')!, authorityKind: text(command, 'authorityKind')! as DocumentView['authorityKind'], sourcePath: text(command, 'sourcePath', true), content: text(command, 'content', true), relationship: record(command, 'relationship', true), idempotencyKey: text(command, 'idempotencyKey')! }
    case 'document-version':
      exact(command, ['documentId', 'content', 'idempotencyKey'], ['relationship'])
      return { action, documentId: text(command, 'documentId')!, content: text(command, 'content')!, relationship: record(command, 'relationship', true), idempotencyKey: text(command, 'idempotencyKey')! }
    case 'document-get':
      exact(command, ['documentId'], ['version'])
      return { action, documentId: text(command, 'documentId')!, version: numberValue(command, 'version', true) }
    case 'prompt-version-create':
      exact(command, ['key', 'content', 'idempotencyKey'])
      return { action, key: text(command, 'key')!, content: text(command, 'content')!, idempotencyKey: text(command, 'idempotencyKey')! }
    case 'workflow-version-create':
      exact(command, ['key', 'definition', 'idempotencyKey'])
      return { action, key: text(command, 'key')!, definition: record(command, 'definition')!, idempotencyKey: text(command, 'idempotencyKey')! }
    case 'assignment-create':
      exact(command, ['taskId', 'expectedOwnershipEpoch', 'stage', 'role', 'capabilitySet', 'sourceScope', 'requiredArtifacts', 'acceptance', 'stopConditions', 'idempotencyKey'], ['promptVersionId', 'workflowVersionId', 'contextPackageId'])
      return { action, taskId: text(command, 'taskId')!, expectedOwnershipEpoch: numberValue(command, 'expectedOwnershipEpoch')!, stage: text(command, 'stage')!, role: text(command, 'role')!, promptVersionId: text(command, 'promptVersionId', true), workflowVersionId: text(command, 'workflowVersionId', true), contextPackageId: text(command, 'contextPackageId', true), capabilitySet: strings(command, 'capabilitySet'), sourceScope: strings(command, 'sourceScope'), requiredArtifacts: strings(command, 'requiredArtifacts'), acceptance: strings(command, 'acceptance'), stopConditions: strings(command, 'stopConditions'), idempotencyKey: text(command, 'idempotencyKey')! }
    case 'assignment-event':
      exact(command, ['assignmentId', 'expectedOwnershipEpoch', 'type', 'idempotencyKey'], ['payload'])
      return { action, assignmentId: text(command, 'assignmentId')!, expectedOwnershipEpoch: numberValue(command, 'expectedOwnershipEpoch')!, type: text(command, 'type')! as 'dispatched' | 'reported' | 'accepted' | 'rejected' | 'cancelled', payload: record(command, 'payload', true), idempotencyKey: text(command, 'idempotencyKey')! }
    case 'session-open':
      exact(command, ['projectId', 'role', 'client', 'idempotencyKey'], ['taskId', 'assignmentId', 'model', 'contextPackageId', 'parentSessionId', 'continuationOfSessionId', 'runtimeId'])
      return { action, projectId: text(command, 'projectId')!, taskId: text(command, 'taskId', true), assignmentId: text(command, 'assignmentId', true), role: text(command, 'role')!, client: text(command, 'client')!, model: text(command, 'model', true), contextPackageId: text(command, 'contextPackageId', true), parentSessionId: text(command, 'parentSessionId', true), continuationOfSessionId: text(command, 'continuationOfSessionId', true), runtimeId: text(command, 'runtimeId', true), idempotencyKey: text(command, 'idempotencyKey')! }
    case 'session-event':
      exact(command, ['sessionId', 'type', 'payload', 'idempotencyKey'])
      return { action, sessionId: text(command, 'sessionId')!, type: text(command, 'type')!, payload: record(command, 'payload')!, idempotencyKey: text(command, 'idempotencyKey')! }
    case 'session-close':
      exact(command, ['sessionId', 'status', 'idempotencyKey'])
      return { action, sessionId: text(command, 'sessionId')!, status: text(command, 'status')! as 'compacted' | 'completed' | 'failed' | 'abandoned', idempotencyKey: text(command, 'idempotencyKey')! }
    case 'context-recover':
      exact(command, ['taskId', 'byteBudget', 'idempotencyKey'], ['tokenBudget'])
      return { action, taskId: text(command, 'taskId')!, tokenBudget: numberValue(command, 'tokenBudget', true), byteBudget: numberValue(command, 'byteBudget')!, idempotencyKey: text(command, 'idempotencyKey')! }
    case 'context-create': {
      exact(command, ['projectId', 'byteBudget', 'items', 'idempotencyKey'], ['taskId', 'ownershipEpoch', 'tokenBudget'])
      if (!Array.isArray(command.items) || command.items.length > 256) throw new PlatformError('items must be a bounded array', 'INVALID_COMMAND')
      const items = command.items.map((item) => {
        const entry = object(item); exact(entry, ['sourceDomain', 'sourceId', 'sourceVersion', 'selectionReason', 'contentHash', 'sensitivity'])
        return { sourceDomain: text(entry, 'sourceDomain')!, sourceId: text(entry, 'sourceId')!, sourceVersion: text(entry, 'sourceVersion')!, selectionReason: text(entry, 'selectionReason')!, contentHash: text(entry, 'contentHash')!, sensitivity: text(entry, 'sensitivity')! as 'public' | 'internal' | 'confidential' | 'restricted' }
      })
      return { action, projectId: text(command, 'projectId')!, taskId: text(command, 'taskId', true), ownershipEpoch: numberValue(command, 'ownershipEpoch', true), tokenBudget: numberValue(command, 'tokenBudget', true), byteBudget: numberValue(command, 'byteBudget')!, items, idempotencyKey: text(command, 'idempotencyKey')! }
    }
    case 'approval-request':
      exact(command, ['projectId', 'kind', 'request', 'idempotencyKey'], ['taskId'])
      return { action, projectId: text(command, 'projectId')!, taskId: text(command, 'taskId', true), kind: text(command, 'kind')!, request: record(command, 'request')!, idempotencyKey: text(command, 'idempotencyKey')! }
    case 'approval-decide':
      exact(command, ['approvalId', 'decision', 'reason', 'idempotencyKey'])
      return { action, approvalId: text(command, 'approvalId')!, decision: text(command, 'decision')! as 'approved' | 'rejected' | 'cancelled', reason: text(command, 'reason')!, idempotencyKey: text(command, 'idempotencyKey')! }
    case 'artifact-create':
      exact(command, ['projectId', 'mediaType', 'sensitivity', 'acl', 'dataBase64', 'idempotencyKey'], ['taskId', 'assignmentId', 'retentionUntil'])
      return { action, projectId: text(command, 'projectId')!, taskId: text(command, 'taskId', true), assignmentId: text(command, 'assignmentId', true), mediaType: text(command, 'mediaType')!, sensitivity: text(command, 'sensitivity')! as 'public' | 'internal' | 'confidential' | 'restricted', acl: strings(command, 'acl'), retentionUntil: text(command, 'retentionUntil', true), dataBase64: text(command, 'dataBase64')!, idempotencyKey: text(command, 'idempotencyKey')! }
    case 'artifact-tombstone':
      exact(command, ['artifactId', 'reason', 'idempotencyKey'])
      return { action, artifactId: text(command, 'artifactId')!, reason: text(command, 'reason')!, idempotencyKey: text(command, 'idempotencyKey')! }
    case 'workspace-expectation-set':
      exact(command, ['projectId', 'cleanRequired', 'expectedVersion', 'idempotencyKey'], ['branch', 'head'])
      return { action, projectId: text(command, 'projectId')!, branch: text(command, 'branch', true), head: text(command, 'head', true), cleanRequired: booleanValue(command, 'cleanRequired'), expectedVersion: numberValue(command, 'expectedVersion')!, idempotencyKey: text(command, 'idempotencyKey')! }
    case 'workspace-observe':
      exact(command, ['projectId', 'idempotencyKey'], ['taskId'])
      return { action, projectId: text(command, 'projectId')!, taskId: text(command, 'taskId', true), idempotencyKey: text(command, 'idempotencyKey')! }
    case 'audit-list':
      exact(command, [], ['projectId', 'taskId', 'limit'])
      return { action, projectId: text(command, 'projectId', true), taskId: text(command, 'taskId', true), limit: numberValue(command, 'limit', true) }
    default:
      throw new PlatformError('Unknown task platform command', 'INVALID_COMMAND')
  }
}

export function assertTrustedLoopbackRequest(headers: IncomingHttpHeaders, port: number): void {
  const expected = `127.0.0.1:${port}`
  if (headers.host !== expected || headers.origin !== `http://${expected}` || (headers['sec-fetch-site'] && headers['sec-fetch-site'] !== 'same-origin')) throw new PlatformError('Task platform request is not trusted', 'UNTRUSTED_REQUEST')
}
async function readRequestBody(req: IncomingMessage): Promise<unknown> {
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > MAX_HTTP_BODY_BYTES) throw new PlatformError('Task platform request is too large', 'REQUEST_TOO_LARGE')
  const chunks: Buffer[] = []; let size = 0
  for await (const chunk of req) { const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += buffer.length; if (size > MAX_HTTP_BODY_BYTES) throw new PlatformError('Task platform request is too large', 'REQUEST_TOO_LARGE'); chunks.push(buffer) }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch (error) { throw new PlatformError('Task platform request must contain valid JSON', 'INVALID_JSON', { cause: error }) }
}
function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body), 'content-type': 'application/json; charset=utf-8', 'x-content-type-options': 'nosniff' })
  res.end(body)
}
function publicError(error: unknown): { status: number; code: string; message: string } {
  const code = error instanceof PlatformError ? error.code : 'INTERNAL'
  const status = code === 'UNTRUSTED_REQUEST' ? 403 : code === 'NOT_FOUND' ? 404 : code === 'INTERNAL' ? 500 : 400
  return { status, code, message: error instanceof PlatformError ? error.message : 'Task platform is unavailable' }
}

function decodeBase64(value: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) throw new PlatformError('Artifact dataBase64 is invalid', 'INVALID_COMMAND')
  return Buffer.from(value, 'base64')
}

async function dispatch(service: TaskPlatformService, command: PlatformCommand): Promise<unknown> {
  switch (command.action) {
    case 'snapshot': return service.snapshot(WEB_ACTOR, command)
    case 'operations-snapshot': return service.operationsSnapshot(WEB_ACTOR, command)
    case 'project-create': return service.createProject(WEB_ACTOR, command)
    case 'task-draft': return service.createTaskDraft(WEB_ACTOR, command)
    case 'task-confirm': return service.confirmTask(WEB_ACTOR, command)
    case 'task-transition': return service.transitionTask(WEB_ACTOR, command)
    case 'owner-transfer': return service.transferOwner(WEB_ACTOR, command)
    case 'dependency-add': return service.addDependency(WEB_ACTOR, command)
    case 'document-create': return service.createDocument(WEB_ACTOR, command)
    case 'document-version': return service.appendDocumentVersion(WEB_ACTOR, command)
    case 'document-get': return service.getDocumentVersion(WEB_ACTOR, command.documentId, command.version)
    case 'prompt-version-create': return service.createPromptVersion(WEB_ACTOR, command)
    case 'workflow-version-create': return service.createWorkflowVersion(WEB_ACTOR, command)
    case 'assignment-create': return service.createAssignment(WEB_ACTOR, command)
    case 'assignment-event': return service.appendAssignmentEvent(WEB_ACTOR, command)
    case 'session-open': return service.openSession(WEB_ACTOR, command)
    case 'session-event': return service.appendSessionEvent(WEB_ACTOR, command)
    case 'session-close': return service.closeSession(WEB_ACTOR, command)
    case 'context-recover': return service.createTaskRecoveryContext(WEB_ACTOR, command)
    case 'context-create': return service.createContextPackage(WEB_ACTOR, command)
    case 'approval-request': return service.requestApproval(WEB_ACTOR, command)
    case 'approval-decide': return service.decideApproval(WEB_ACTOR, command)
    case 'artifact-create': return service.createArtifact(WEB_ACTOR, { ...command, data: decodeBase64(command.dataBase64) })
    case 'artifact-tombstone': return service.tombstoneArtifact(WEB_ACTOR, command)
    case 'workspace-expectation-set': return service.setWorkspaceExpectation(WEB_ACTOR, command)
    case 'workspace-observe': return service.observeWorkspace(WEB_ACTOR, command)
    case 'audit-list': return service.listAudit(WEB_ACTOR, command)
  }
}

export function createTaskPlatformHttpHandler(service: TaskPlatformService, port: number | (() => number)): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    try {
      assertTrustedLoopbackRequest(req.headers, typeof port === 'function' ? port() : port)
      if (req.method !== 'POST') throw new PlatformError('Task platform requests require POST', 'METHOD_NOT_ALLOWED')
      if (String(req.headers['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') throw new PlatformError('Task platform requests require JSON', 'UNSUPPORTED_MEDIA_TYPE')
      const result = await dispatch(service, parsePlatformCommand(await readRequestBody(req)))
      sendJson(res, 200, { ok: true, value: result })
    } catch (error) {
      const failure = publicError(error)
      sendJson(res, failure.status, { ok: false, error: { code: failure.code, message: failure.message } })
    }
  }
}

const projectOutputSchema = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    id: { type: 'string' as const, required: true },
    key: { type: 'string' as const, required: true },
    name: { type: 'string' as const, required: true },
    description: { type: 'string' as const, required: true },
    workspacePath: { type: 'string' as const },
    version: { type: 'number' as const, required: true },
    createdAt: { type: 'string' as const, required: true },
    updatedAt: { type: 'string' as const, required: true },
  },
} as const satisfies ValueSchemaSpec
const documentOutputSchema = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    id: { type: 'string' as const, required: true },
    projectId: { type: 'string' as const },
    key: { type: 'string' as const, required: true },
    title: { type: 'string' as const, required: true },
    authorityKind: { type: 'string' as const, required: true },
    writable: { type: 'boolean' as const, required: true },
    sourcePath: { type: 'string' as const },
    latestVersion: { type: 'number' as const, required: true },
    createdAt: { type: 'string' as const, required: true },
    updatedAt: { type: 'string' as const, required: true },
  },
} as const satisfies ValueSchemaSpec
const taskOutputSchema = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    id: { type: 'string' as const, required: true },
    projectId: { type: 'string' as const, required: true },
    parentTaskId: { type: 'string' as const },
    title: { type: 'string' as const, required: true },
    goal: { type: 'string' as const, required: true },
    status: { type: 'string' as const, required: true },
    priority: { type: 'number' as const, required: true },
    risk: { type: 'string' as const, required: true },
    blocker: { type: 'string' as const },
    recoveryCondition: { type: 'string' as const },
    nextAction: { type: 'string' as const },
    ownerKey: { type: 'string' as const },
    ownershipEpoch: { type: 'number' as const, required: true },
    version: { type: 'number' as const, required: true },
    createdAt: { type: 'string' as const, required: true },
    updatedAt: { type: 'string' as const, required: true },
  },
} as const satisfies ValueSchemaSpec
const assignmentOutputSchema = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    id: { type: 'string' as const, required: true },
    taskId: { type: 'string' as const, required: true },
    ownershipEpoch: { type: 'number' as const, required: true },
    stage: { type: 'string' as const, required: true },
    role: { type: 'string' as const, required: true },
    status: { type: 'string' as const, required: true },
    createdAt: { type: 'string' as const, required: true },
  },
} as const satisfies ValueSchemaSpec

function installTools(ctx: Context, service: TaskPlatformService): void {
  ctx.on('tools/pre-execute', async (exec, next) => MUTATING_TOOLS.has(exec.name)
    ? { kind: 'ask', reason: `${exec.name} changes the authoritative task platform` }
    : next())

  ctx.tools.register(defineTool({
    name: 'platform_project_list', description: 'List projects in the authoritative AI task platform.',
    parameters: { limit: { type: 'number', default: 100 } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { projects: { type: 'array', required: true, items: projectOutputSchema } } },
      render: (_args, value) => [{ type: 'text', text: value.projects.map((item) => `${item.key}: ${item.name}`).join('\n') || 'No projects.' }],
    },
    execute: async ({ limit }) => ({ projects: service.listProjects(INTAKE_ACTOR, limit) }),
  }))
  ctx.tools.register(defineTool({
    name: 'platform_project_create', description: 'Create one platform project record. Requires approval.',
    parameters: {
      key: { type: 'string', required: true }, name: { type: 'string', required: true },
      description: { type: 'string' }, workspacePath: { type: 'string' }, idempotencyKey: { type: 'string', required: true },
    },
    output: { schema: projectOutputSchema, render: (_args, value) => [{ type: 'text', text: `Created project ${value.key} (${value.id}).` }] },
    execute: async (args) => service.createProject(INTAKE_ACTOR, args),
  }))
  ctx.tools.register(defineTool({
    name: 'platform_document_list', description: 'List authoritative platform document records and their latest immutable versions.',
    parameters: { projectId: { type: 'string' }, limit: { type: 'number', default: 100 } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { documents: { type: 'array', required: true, items: documentOutputSchema } } },
      render: (_args, value) => [{ type: 'text', text: value.documents.map((item) => `${item.id} ${item.key} v${item.latestVersion} [${item.authorityKind}] ${item.title}`).join('\n') || 'No documents.' }],
    },
    execute: async ({ projectId, limit }) => ({ documents: service.listDocuments(INTAKE_ACTOR, projectId, limit) }),
  }))
  ctx.tools.register(defineTool({
    name: 'platform_task_list', description: 'List authoritative platform tasks with Owner epoch and next action.',
    parameters: {
      projectId: { type: 'string' }, status: { type: 'string' }, ownerKey: { type: 'string' }, query: { type: 'string' },
      limit: { type: 'number', default: 100 },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { tasks: { type: 'array', required: true, items: taskOutputSchema } } },
      render: (_args, value) => [{ type: 'text', text: value.tasks.map((item) => `${item.id} [${item.status}] P${item.priority} ${item.title} owner=${item.ownerKey ?? '-'}@${item.ownershipEpoch}`).join('\n') || 'No tasks.' }],
    },
    execute: async (args) => ({ tasks: service.listTasks(INTAKE_ACTOR, args as Parameters<PlatformStore['listTasks']>[0]) }),
  }))
  ctx.tools.register(defineTool({
    name: 'platform_task_show', description: 'Read one authoritative platform task.',
    parameters: { taskId: { type: 'string', required: true } },
    output: { schema: taskOutputSchema, render: (_args, value) => [{ type: 'text', text: `${value.id} [${value.status}] ${value.title}\nOwner: ${value.ownerKey ?? '-'} epoch ${value.ownershipEpoch}\nNext: ${value.nextAction ?? '-'}` }] },
    execute: async ({ taskId }) => service.getTask(INTAKE_ACTOR, taskId),
  }))
  ctx.tools.register(defineTool({
    name: 'platform_task_event_list', description: 'Read observable authoritative events for one task in reverse chronological order.',
    parameters: { taskId: { type: 'string', required: true }, limit: { type: 'number', default: 200 } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { events: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { id: { type: 'number', required: true }, type: { type: 'string', required: true }, actorKey: { type: 'string', required: true }, ownershipEpoch: { type: 'number' }, occurredAt: { type: 'string', required: true }, payload: { type: 'object', required: true, additionalProperties: true } } } } } },
      render: (_args, value) => [{ type: 'text', text: value.events.map((item) => `${item.id} ${item.occurredAt} ${item.type} actor=${item.actorKey}${item.ownershipEpoch === undefined ? '' : `@${item.ownershipEpoch}`}`).join('\n') || 'No task events.' }],
    },
    execute: async ({ taskId, limit }) => ({ events: service.listTaskEvents(INTAKE_ACTOR, taskId, limit).map((item) => ({ id: item.id, type: item.type, actorKey: item.actorKey, ...(item.ownershipEpoch === undefined ? {} : { ownershipEpoch: item.ownershipEpoch }), occurredAt: item.occurredAt, payload: item.payload as Record<string, JsonValue> })) }),
  }))
  ctx.tools.register(defineTool({
    name: 'platform_task_draft', description: 'Create a confirmable task-intake draft without activating it.',
    parameters: {
      projectId: { type: 'string', required: true }, parentTaskId: { type: 'string' }, title: { type: 'string', required: true },
      goal: { type: 'string', required: true }, priority: { type: 'number', default: 2 }, risk: { type: 'string' },
      nextAction: { type: 'string' }, idempotencyKey: { type: 'string', required: true },
    },
    output: { schema: taskOutputSchema, render: (_args, value) => [{ type: 'text', text: `Draft ${value.id}: ${value.title}. Human confirmation and Owner assignment are still required.` }] },
    execute: async (args) => service.createTaskDraft(INTAKE_ACTOR, args),
  }))
  ctx.tools.register(defineTool({
    name: 'platform_task_confirm', description: 'Confirm a task draft and assign its first logical Owner epoch. Requires approval.',
    parameters: {
      taskId: { type: 'string', required: true }, ownerKey: { type: 'string', required: true }, ownerDisplayName: { type: 'string' },
      expectedVersion: { type: 'number', required: true }, idempotencyKey: { type: 'string', required: true },
    },
    output: { schema: taskOutputSchema, render: (_args, value) => [{ type: 'text', text: `Confirmed ${value.id}; Owner ${value.ownerKey}@${value.ownershipEpoch}.` }] },
    execute: async (args) => service.confirmTask(INTAKE_ACTOR, args),
  }))
  ctx.tools.register(defineTool({
    name: 'platform_task_transfer_owner', description: 'Transfer a task to a new logical Owner and increment the ownership epoch. Requires approval.',
    parameters: {
      taskId: { type: 'string', required: true }, newOwnerKey: { type: 'string', required: true }, newOwnerDisplayName: { type: 'string' },
      expectedOwnershipEpoch: { type: 'number', required: true }, reason: { type: 'string', required: true }, idempotencyKey: { type: 'string', required: true },
    },
    output: { schema: taskOutputSchema, render: (_args, value) => [{ type: 'text', text: `Transferred ${value.id} to ${value.ownerKey}@${value.ownershipEpoch}.` }] },
    execute: async (args) => service.transferOwner(INTAKE_ACTOR, args),
  }))
  ctx.tools.register(defineTool({
    name: 'platform_assignment_list', description: 'List immutable stage assignments and their derived lifecycle status.',
    parameters: { taskId: { type: 'string' }, status: { type: 'string' }, limit: { type: 'number', default: 100 } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { assignments: { type: 'array', required: true, items: assignmentOutputSchema } } },
      render: (_args, value) => [{ type: 'text', text: value.assignments.map((item) => `${item.id} ${item.stage}/${item.role} [${item.status}] task=${item.taskId}@${item.ownershipEpoch}`).join('\n') || 'No assignments.' }],
    },
    execute: async (args) => ({ assignments: service.listAssignments(INTAKE_ACTOR, args as Parameters<PlatformStore['listAssignments']>[0]).map((item) => ({ id: item.id, taskId: item.taskId, ownershipEpoch: item.ownershipEpoch, stage: item.stage, role: item.role, status: item.status, createdAt: item.createdAt })) }),
  }))
  ctx.tools.register(defineTool({
    name: 'platform_session_event_list', description: 'Read observable events from one platform session ledger.',
    parameters: { sessionId: { type: 'string', required: true }, limit: { type: 'number', default: 200 } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { events: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { sequence: { type: 'number', required: true }, type: { type: 'string', required: true }, contentHash: { type: 'string', required: true }, occurredAt: { type: 'string', required: true }, payload: { type: 'object', required: true, additionalProperties: true } } } } } },
      render: (_args, value) => [{ type: 'text', text: value.events.map((item) => `${item.sequence} ${item.occurredAt} ${item.type} ${item.contentHash}`).join('\n') || 'No session events.' }],
    },
    execute: async ({ sessionId, limit }) => ({ events: service.listSessionEvents(INTAKE_ACTOR, sessionId, limit).map((item) => ({ sequence: item.sequence, type: item.type, contentHash: item.contentHash, occurredAt: item.occurredAt, payload: item.payload as Record<string, JsonValue> })) }),
  }))
  ctx.tools.register(defineTool({
    name: 'platform_approval_list', description: 'List persisted platform approvals and decisions.',
    parameters: { projectId: { type: 'string' }, taskId: { type: 'string' }, status: { type: 'string' }, limit: { type: 'number', default: 100 } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { approvals: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string', required: true }, projectId: { type: 'string', required: true }, taskId: { type: 'string' }, kind: { type: 'string', required: true }, status: { type: 'string', required: true }, requestedBy: { type: 'string', required: true }, createdAt: { type: 'string', required: true } } } } } },
      render: (_args, value) => [{ type: 'text', text: value.approvals.map((item) => `${item.id} ${item.kind} [${item.status}] ${item.requestedBy}`).join('\n') || 'No approvals.' }],
    },
    execute: async (args) => ({ approvals: service.listApprovals(INTAKE_ACTOR, args as Parameters<PlatformStore['listApprovals']>[0]).map((item) => ({ id: item.id, projectId: item.projectId, ...(item.taskId ? { taskId: item.taskId } : {}), kind: item.kind, status: item.status, requestedBy: item.requestedBy, createdAt: item.createdAt })) }),
  }))
  ctx.tools.register(defineTool({
    name: 'platform_context_recover', description: 'Create an immutable sourced context package from current task authority, observable events, assignments, sessions, artifacts, and Git evidence.',
    parameters: { taskId: { type: 'string', required: true }, tokenBudget: { type: 'number' }, byteBudget: { type: 'number', default: 262144 }, idempotencyKey: { type: 'string', required: true } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { contextId: { type: 'string', required: true }, projectId: { type: 'string', required: true }, taskId: { type: 'string', required: true }, ownershipEpoch: { type: 'number' }, manifestHash: { type: 'string', required: true }, itemCount: { type: 'number', required: true }, createdAt: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: `Context ${value.contextId} for ${value.taskId} contains ${value.itemCount} sourced items (${value.manifestHash}).` }],
    },
    execute: async (args) => {
      const value = service.createTaskRecoveryContext(RECOVERY_ACTOR, { ...args, byteBudget: args.byteBudget ?? 262144 })
      return { contextId: value.id, projectId: value.projectId, taskId: value.taskId ?? args.taskId, ...(value.ownershipEpoch === undefined ? {} : { ownershipEpoch: value.ownershipEpoch }), manifestHash: value.manifestHash, itemCount: value.items.length, createdAt: value.createdAt }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'platform_workspace_observe', description: 'Capture actual branch, HEAD, and dirty state using fixed read-only Git commands for one configured project repository.',
    parameters: { projectId: { type: 'string', required: true }, taskId: { type: 'string' }, idempotencyKey: { type: 'string', required: true } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { id: { type: 'number', required: true }, projectId: { type: 'string', required: true }, taskId: { type: 'string' }, repositoryRoot: { type: 'string', required: true }, worktree: { type: 'string', required: true }, branch: { type: 'string' }, head: { type: 'string' }, dirty: { type: 'boolean', required: true }, observedAt: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: `${value.repositoryRoot}: ${value.branch ?? '(detached)'}@${value.head ?? '-'} dirty=${value.dirty} (${value.observedAt})` }],
    },
    execute: async (args, exec) => {
      const value = await service.observeWorkspace(INTAKE_ACTOR, { ...args, signal: exec.signal })
      return { id: value.id, projectId: value.projectId, ...(value.taskId ? { taskId: value.taskId } : {}), repositoryRoot: value.repositoryRoot, worktree: value.worktree, ...(value.branch ? { branch: value.branch } : {}), ...(value.head ? { head: value.head } : {}), dirty: value.dirty, observedAt: value.observedAt }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'platform_analytics_show', description: 'Read derived process analytics without modifying authoritative project state.',
    parameters: { projectId: { type: 'string', required: true } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { projectId: { type: 'string', required: true }, taskStatus: { type: 'array', required: true, items: { type: 'string' } }, assignmentStatus: { type: 'array', required: true, items: { type: 'string' } }, sessionStatus: { type: 'array', required: true, items: { type: 'string' } }, ownerLoad: { type: 'array', required: true, items: { type: 'string' } }, generatedAt: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: [`Tasks: ${value.taskStatus.join(', ') || '-'}`, `Assignments: ${value.assignmentStatus.join(', ') || '-'}`, `Sessions: ${value.sessionStatus.join(', ') || '-'}`, `Owner load: ${value.ownerLoad.join(', ') || '-'}`].join('\n') }],
    },
    execute: async ({ projectId }) => {
      const value = service.analyticsSnapshot(INTAKE_ACTOR, projectId)
      const lines = (record: Record<string, number>) => Object.entries(record).map(([key, count]) => `${key}:${count}`)
      return { projectId: value.projectId, taskStatus: lines(value.taskStatus), assignmentStatus: lines(value.assignmentStatus), sessionStatus: lines(value.sessionStatus), ownerLoad: value.ownerLoad.map((item) => `${item.ownerKey}:${item.activeTasks}`), generatedAt: value.generatedAt }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'platform_audit_list', description: 'Read the redacted append-only platform audit trail.',
    parameters: { projectId: { type: 'string' }, taskId: { type: 'string' }, limit: { type: 'number', default: 100 } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { events: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } } } },
      render: (_args, value) => [{ type: 'text', text: value.events.map((item) => `${String(item.occurredAt)} ${String(item.decision)} ${String(item.actorKey)} ${String(item.command)}`).join('\n') || 'No audit events.' }],
    },
    execute: async (args) => ({
      events: service.listAudit(INTAKE_ACTOR, args).map((event) => ({
        ...event,
        payload: event.payload as JsonValue,
      })),
    }),
  }))
}

type PlatformContext = Context & { webServer: WebServer }

export function runTaskPlatformPackageProbe(dataRoot: string, phase: 'setup' | 'verify'): { databasePath: string; projectPersisted: boolean; schemaVersion: number } {
  const store = new PlatformStore(dataRoot)
  try {
    if (phase === 'setup') store.createProject({ actorKey: 'system:package-smoke', role: 'system', client: 'system', capabilities: ['project:create'] }, { key: 'package-smoke', name: 'Package smoke project', description: 'Persistent task platform probe', idempotencyKey: 'package-smoke-project-v1' })
    return { databasePath: store.databasePath, projectPersisted: store.listProjects().some((project) => project.key === 'package-smoke'), schemaVersion: store.schemaVersion() }
  } finally { store.close() }
}

export function apply(ctx: Context, config: Config): void {
  const fallbackBase = process.env.LOCALAPPDATA || process.env.HOME || process.cwd()
  const dataRoot = config.dataRoot?.trim() || process.env.DSH_WORKBENCH_PLATFORM_DATA_DIR || join(fallbackBase, 'dsh-workbench', 'task-platform')
  const store = new PlatformStore(dataRoot)
  const service = Object.freeze<TaskPlatformService>({
    snapshot: (actor, input = {}) => store.query(actor, { capability: 'platform:read', command: 'platform.snapshot', projectId: input.projectId }, () => ({ schemaVersion: store.schemaVersion(), projects: store.listProjects(), tasks: store.listTasks(input), audit: store.listAudit({ projectId: input.projectId, limit: 50 }) })),
    operationsSnapshot: (actor, { projectId, taskId }) => store.query(actor, { capability: 'platform:read', command: 'platform.operations.snapshot', projectId, taskId }, () => ({ documents: store.listDocuments(projectId), dependencies: store.listDependencies(taskId), assignments: store.listAssignments({ taskId }), taskEvents: taskId ? store.listTaskEvents(taskId, 100) : [], sessions: store.listSessions({ projectId, taskId }), approvals: store.listApprovals({ projectId, taskId }), artifacts: store.listArtifacts({ projectId, taskId }), workspaceExpectation: store.getWorkspaceExpectation(projectId), workspaceObservations: store.listWorkspaceObservations(projectId, 50), promptVersions: store.listPromptVersions(), workflowVersions: store.listWorkflowVersions(), analytics: store.analyticsSnapshot(projectId) })),
    listProjects: (actor, limit) => store.query(actor, { capability: 'project:read', command: 'project.list' }, () => store.listProjects(limit)),
    getProject: (actor, projectId) => store.query(actor, { capability: 'project:read', command: 'project.get', projectId }, () => store.getProject(projectId)),
    createProject: (actor, input) => store.createProject(actor, input),
    createDocument: (actor, input) => store.createDocument(actor, input), appendDocumentVersion: (actor, input) => store.appendDocumentVersion(actor, input),
    getDocument: (actor, documentId) => store.query(actor, { capability: 'document:read', command: 'document.get', payload: { documentId } }, () => store.getDocument(documentId)),
    listDocuments: (actor, projectId, limit) => store.query(actor, { capability: 'document:read', command: 'document.list', projectId }, () => store.listDocuments(projectId, limit)),
    getDocumentVersion: (actor, documentId, version) => store.query(actor, { capability: 'document:read', command: 'document.version.get', payload: { documentId, version } }, () => store.getDocumentVersion(documentId, version)),
    listTasks: (actor, input) => store.query(actor, { capability: 'task:read', command: 'task.list', projectId: input?.projectId }, () => store.listTasks(input)),
    getTask: (actor, taskId) => store.query(actor, { capability: 'task:read', command: 'task.get', taskId }, () => store.getTask(taskId)),
    listTaskEvents: (actor, taskId, limit) => store.query(actor, { capability: 'task:read', command: 'task.events.list', taskId }, () => store.listTaskEvents(taskId, limit)),
    createTaskRecoveryContext: (actor, input) => store.createTaskRecoveryContext(actor, input), createTaskDraft: (actor, input) => store.createTaskDraft(actor, input),
    confirmTask: (actor, input) => store.confirmTask(actor, input), transferOwner: (actor, input) => store.transferOwner(actor, input),
    transitionTask: (actor, input) => store.transitionTask(actor, input), addDependency: (actor, input) => store.addDependency(actor, input),
    listDependencies: (actor, taskId, limit) => store.query(actor, { capability: 'task:read', command: 'task.dependencies.list', taskId }, () => store.listDependencies(taskId, limit)),
    createPromptVersion: (actor, input) => store.createPromptVersion(actor, input), createWorkflowVersion: (actor, input) => store.createWorkflowVersion(actor, input),
    listPromptVersions: (actor, key, limit) => store.query(actor, { capability: 'workflow:read', command: 'prompt.versions.list' }, () => store.listPromptVersions(key, limit)),
    listWorkflowVersions: (actor, key, limit) => store.query(actor, { capability: 'workflow:read', command: 'workflow.versions.list' }, () => store.listWorkflowVersions(key, limit)),
    createAssignment: (actor, input) => store.createAssignment(actor, input),
    getAssignment: (actor, assignmentId) => store.query(actor, { capability: 'assignment:read', command: 'assignment.get', payload: { assignmentId } }, () => store.getAssignment(assignmentId)),
    listAssignments: (actor, input) => store.query(actor, { capability: 'assignment:read', command: 'assignment.list', taskId: input?.taskId }, () => store.listAssignments(input)),
    appendAssignmentEvent: (actor, input) => store.appendAssignmentEvent(actor, input),
    listAssignmentEvents: (actor, assignmentId) => store.query(actor, { capability: 'assignment:read', command: 'assignment.events.list', payload: { assignmentId } }, () => store.listAssignmentEvents(assignmentId)),
    openSession: (actor, input) => store.openSession(actor, input), appendSessionEvent: (actor, input) => store.appendSessionEvent(actor, input), closeSession: (actor, input) => store.closeSession(actor, input),
    listSessions: (actor, input) => store.query(actor, { capability: 'session:read', command: 'session.list', projectId: input?.projectId, taskId: input?.taskId }, () => store.listSessions(input)),
    listSessionEvents: (actor, sessionId, limit) => store.query(actor, { capability: 'session:read', command: 'session.events.list', payload: { sessionId } }, () => store.listSessionEvents(sessionId, limit)),
    createContextPackage: (actor, input) => store.createContextPackage(actor, input),
    getContextPackage: (actor, contextId) => store.query(actor, { capability: 'context:read', command: 'context.get', payload: { contextId } }, () => store.getContextPackage(contextId)),
    requestApproval: (actor, input) => store.requestApproval(actor, input), decideApproval: (actor, input) => store.decideApproval(actor, input),
    listApprovals: (actor, input) => store.query(actor, { capability: 'approval:read', command: 'approval.list', projectId: input?.projectId, taskId: input?.taskId }, () => store.listApprovals(input)),
    createArtifact: (actor, input) => store.createArtifact(actor, input), tombstoneArtifact: (actor, input) => store.tombstoneArtifact(actor, input), purgeArtifact: (actor, input) => store.purgeArtifact(actor, input),
    listArtifacts: (actor, input) => store.query(actor, { capability: 'artifact:read', command: 'artifact.list', projectId: input?.projectId, taskId: input?.taskId }, () => store.listArtifacts(input)),
    setWorkspaceExpectation: (actor, input) => store.setWorkspaceExpectation(actor, input),
    getWorkspaceExpectation: (actor, projectId) => store.query(actor, { capability: 'workspace:read', command: 'workspace.expectation.get', projectId }, () => store.getWorkspaceExpectation(projectId)),
    observeWorkspace: async (actor, input) => {
      const project = store.query(actor, { capability: 'workspace:observe', command: 'workspace.observation.request', projectId: input.projectId, taskId: input.taskId }, () => store.getProject(input.projectId))
      if (!project.workspacePath) throw new PlatformError('Project has no managed repository path', 'PROJECT_NOT_CONFIGURED')
      const repository = await resolveRepository(project.workspacePath, '.', input.signal)
      const observation = await observeRepository(repository, input.signal)
      const gitActor: ActorContext = { actorKey: 'system:git-observer', role: 'git_integrator', client: 'system', capabilities: ['workspace:observe'], projectScope: [project.id], ...(input.taskId ? { taskScope: [input.taskId] } : {}) }
      return store.recordWorkspaceObservation(gitActor, { projectId: project.id, taskId: input.taskId, ...observation, idempotencyKey: input.idempotencyKey, correlationKey: input.correlationKey })
    },
    listWorkspaceObservations: (actor, projectId, limit) => store.query(actor, { capability: 'workspace:read', command: 'workspace.observations.list', projectId }, () => store.listWorkspaceObservations(projectId, limit)),
    analyticsSnapshot: (actor, projectId) => store.query(actor, { capability: 'analytics:read', command: 'analytics.snapshot', projectId }, () => store.analyticsSnapshot(projectId)),
    listAudit: (actor, input) => store.query(actor, { capability: 'audit:read', command: 'audit.list', projectId: input?.projectId, taskId: input?.taskId }, () => store.listAudit(input)),
  })
  ctx.provide(serviceName, service)
  installTools(ctx, service)
  const platformContext = ctx as PlatformContext
  if (platformContext.webServer.host !== '127.0.0.1') throw new PlatformError('Task platform UI requires a loopback-only Web server', 'UNSAFE_WEB_SERVER')
  ctx.effect(() => platformContext.webServer.register({ handler: createTaskPlatformHttpHandler(service, () => platformContext.webServer.port), kind: 'exact', path: TASK_PLATFORM_ROUTE }), 'task-platform: HTTP route')
  ctx.effect(() => () => store.close(), 'task-platform: database')
  ctx.logger(name).info('AI task platform schema %s active', store.schemaVersion())
}

export { PLATFORM_SCHEMA_VERSION, PlatformError, type ActorContext, type TaskStatus }
