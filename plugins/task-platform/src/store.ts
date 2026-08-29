import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'

export const PLATFORM_SCHEMA_VERSION = 2
export const MAX_PAGE_SIZE = 200
export const MAX_TEXT = 64 * 1024
export const MAX_EVENT_PAYLOAD = 256 * 1024

export type ActorRole = 'human' | 'registry_manager' | 'task_owner' | 'stage_agent' | 'git_integrator' | 'process_analyst' | 'workflow_optimizer' | 'system'
export interface ActorContext {
  actorKey: string
  role: ActorRole
  client: 'web' | 'codex' | 'pi' | 'agent_runtime' | 'system'
  capabilities: readonly string[]
  projectScope?: readonly string[]
  taskScope?: readonly string[]
  ownershipEpoch?: number
}
export interface ProjectView { id: string; key: string; name: string; description: string; workspacePath?: string; version: number; createdAt: string; updatedAt: string }
export interface DocumentView { id: string; projectId?: string; key: string; title: string; authorityKind: 'platform' | 'project-link' | 'import-snapshot' | 'export-copy'; writable: boolean; sourcePath?: string; latestVersion: number; createdAt: string; updatedAt: string }
export interface DocumentVersionView { id: string; documentId: string; version: number; content: string; contentHash: string; relationship?: Record<string, unknown>; createdBy: string; createdAt: string }
export type TaskStatus = 'draft' | 'open' | 'in_progress' | 'blocked' | 'deferred' | 'closed' | 'cancelled'
export interface TaskView { id: string; projectId: string; parentTaskId?: string; title: string; goal: string; status: TaskStatus; priority: number; risk: string; blocker?: string; recoveryCondition?: string; nextAction?: string; ownerKey?: string; ownershipEpoch: number; version: number; createdAt: string; updatedAt: string }
export interface DependencyView { taskId: string; dependsOnTaskId: string; type: 'blocks' | 'parent-child' | 'related' | 'discovered-from'; createdAt: string }
export interface AssignmentView { id: string; taskId: string; ownershipEpoch: number; stage: string; role: string; promptVersionId?: string; workflowVersionId?: string; contextPackageId?: string; capabilitySet: readonly string[]; sourceScope: readonly string[]; requiredArtifacts: readonly string[]; acceptance: readonly string[]; stopConditions: readonly string[]; status: 'pending' | 'dispatched' | 'reported' | 'accepted' | 'rejected' | 'cancelled'; createdBy: string; createdAt: string }
export interface SessionView { id: string; projectId: string; taskId?: string; assignmentId?: string; role: string; client: string; model?: string; promptVersionId?: string; workflowVersionId?: string; contextPackageId?: string; parentSessionId?: string; continuationOfSessionId?: string; runtimeId?: string; status: 'open' | 'compacted' | 'completed' | 'failed' | 'abandoned'; createdAt: string; updatedAt: string }
export interface ContextItemView { sourceDomain: string; sourceId: string; sourceVersion: string; selectionReason: string; contentHash: string; sensitivity: 'public' | 'internal' | 'confidential' | 'restricted'; ordinal: number }
export interface ContextPackageView { id: string; projectId: string; taskId?: string; ownershipEpoch?: number; manifestHash: string; tokenBudget?: number; byteBudget: number; createdBy: string; createdAt: string; items: readonly ContextItemView[] }
export interface AuditView { id: number; occurredAt: string; actorKey: string; role: ActorRole; client: string; capability: string; projectId?: string; taskId?: string; ownershipEpoch?: number; command: string; decision: 'accepted' | 'rejected'; reason?: string; idempotencyKey?: string; correlationKey?: string; payload: Record<string, unknown> }
export interface PromptVersionView { id: string; key: string; version: number; content: string; contentHash: string; createdBy: string; createdAt: string }
export interface WorkflowVersionView { id: string; key: string; version: number; definition: Record<string, unknown>; definitionHash: string; createdBy: string; createdAt: string }
export interface AssignmentEventView { id: number; assignmentId: string; sequence: number; type: Exclude<AssignmentView['status'], 'pending'>; actorKey: string; payload: Record<string, unknown>; occurredAt: string }
export interface SessionEventView { id: number; sessionId: string; sequence: number; type: string; payload: Record<string, unknown>; contentHash: string; occurredAt: string }
export interface TaskEventView { id: number; taskId: string; type: string; actorKey: string; ownershipEpoch?: number; payload: Record<string, unknown>; occurredAt: string }
export interface ApprovalView { id: string; projectId: string; taskId?: string; kind: string; status: 'pending' | 'approved' | 'rejected' | 'cancelled' | 'expired'; requestedBy: string; decidedBy?: string; request: Record<string, unknown>; decisionReason?: string; createdAt: string; decidedAt?: string }
export interface ArtifactView { id: string; projectId: string; taskId?: string; assignmentId?: string; objectHash: string; mediaType: string; sizeBytes: number; sensitivity: ContextItemView['sensitivity']; acl: readonly string[]; retentionUntil?: string; lifecycle: 'active' | 'tombstoned' | 'deleted'; createdBy: string; createdAt: string }
export interface WorkspaceExpectationView { projectId: string; branch?: string; head?: string; cleanRequired: boolean; version: number; updatedBy: string; updatedAt: string }
export interface WorkspaceObservationView { id: number; projectId: string; taskId?: string; repositoryRoot: string; worktree: string; branch?: string; head?: string; dirty: boolean; sourceCommand: string; observedAt: string }
export interface AnalyticsView { projectId: string; taskStatus: Record<string, number>; ownerLoad: Array<{ ownerKey: string; activeTasks: number }>; assignmentStatus: Record<string, number>; sessionStatus: Record<string, number>; generatedAt: string }

export class PlatformError extends Error {
  constructor(message: string, readonly code: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'PlatformError'
  }
}

const KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u
const ACTIVE_STATUSES = new Set<TaskStatus>(['open', 'in_progress', 'blocked', 'deferred'])
const MUTATION_DENIED_ROLES = new Set<ActorRole>(['process_analyst', 'workflow_optimizer'])
const SENSITIVE_KEY = /(?:authorization|cookie|credential|password|secret|token)/iu
const now = (): string => new Date().toISOString()
const newId = (prefix: string): string => `${prefix}_${randomUUID()}`

function redactTextSecrets(value: string): string {
  return value
    .replace(/(authorization\s*:\s*(?:bearer|basic)\s+)[^\s,;]+/giu, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password)\s*[:=]\s*)[^\s,;]+/giu, '$1[REDACTED]')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu, '[REDACTED PRIVATE KEY]')
}

function scalarText(value: unknown, field: string, maximum = MAX_TEXT, allowEmpty = false): string {
  if (typeof value !== 'string') throw new PlatformError(`${field} must be a string`, 'INVALID_INPUT')
  const result = redactTextSecrets(value.trim())
  if ((!allowEmpty && !result) || result.length > maximum || result.includes('\0')) throw new PlatformError(`${field} is empty or too large`, 'INVALID_INPUT')
  return result
}
function optionalText(value: unknown, field: string, maximum = MAX_TEXT): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  return scalarText(value, field, maximum)
}
function boundedKey(value: unknown, field: string): string {
  const result = scalarText(value, field, 128).toLowerCase()
  if (!KEY_PATTERN.test(result)) throw new PlatformError(`${field} is invalid`, 'INVALID_INPUT')
  return result
}
function boundedId(value: unknown, field: string): string {
  const result = scalarText(value, field, 192)
  if (!ID_PATTERN.test(result)) throw new PlatformError(`${field} is invalid`, 'INVALID_INPUT')
  return result
}
function integer(value: unknown, field: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) throw new PlatformError(`${field} must be an integer from ${minimum} through ${maximum}`, 'INVALID_INPUT')
  return value as number
}
function stringArray(value: unknown, field: string, maximum = 64): string[] {
  if (!Array.isArray(value) || value.length > maximum) throw new PlatformError(`${field} must be a bounded array`, 'INVALID_INPUT')
  const result = value.map((item, index) => scalarText(item, `${field}[${index}]`, 512))
  if (new Set(result).size !== result.length) throw new PlatformError(`${field} contains duplicates`, 'INVALID_INPUT')
  return result
}
function jsonObject(value: unknown, field: string, maximum = MAX_EVENT_PAYLOAD): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PlatformError(`${field} must be an object`, 'INVALID_INPUT')
  const serialized = JSON.stringify(value)
  if (Buffer.byteLength(serialized, 'utf8') > maximum) throw new PlatformError(`${field} is too large`, 'INVALID_INPUT')
  return JSON.parse(serialized) as Record<string, unknown>
}
function redact(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[TRUNCATED]'
  if (typeof value === 'string') { const safe = redactTextSecrets(value); return safe.length <= 2_048 ? safe : `${safe.slice(0, 2_048)}…` }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value
  if (Array.isArray(value)) return value.slice(0, 64).map((item) => redact(item, depth + 1))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 128).map(([key, item]) => [key, SENSITIVE_KEY.test(key) ? '[REDACTED]' : redact(item, depth + 1)]))
  return String(value)
}
function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback
  try { return JSON.parse(value) as T } catch { return fallback }
}
function pathInside(parent: string, child: string): boolean {
  const result = relative(parent, child)
  return result === '' || (result !== '..' && !result.startsWith(`..${sep}`) && !isAbsolute(result))
}
export function resolvePlatformDataRoot(input: string): string {
  const target = resolve(input)
  mkdirSync(target, { recursive: true, mode: 0o700 })
  const info = lstatSync(target)
  if (info.isSymbolicLink() || !info.isDirectory()) throw new PlatformError('Platform data root must be a real directory', 'UNSAFE_DATA_ROOT')
  const canonical = realpathSync(target)
  if (!pathInside(realpathSync(dirname(canonical)), canonical)) throw new PlatformError('Platform data root escaped its parent', 'UNSAFE_DATA_ROOT')
  return canonical
}

function projectFrom(row: Record<string, unknown>): ProjectView {
  return { id: String(row.id), key: String(row.key), name: String(row.name), description: String(row.description ?? ''), ...(row.workspace_path ? { workspacePath: String(row.workspace_path) } : {}), version: Number(row.version), createdAt: String(row.created_at), updatedAt: String(row.updated_at) }
}
function documentFrom(row: Record<string, unknown>): DocumentView {
  return { id: String(row.id), ...(row.project_id ? { projectId: String(row.project_id) } : {}), key: String(row.key), title: String(row.title), authorityKind: String(row.authority_kind) as DocumentView['authorityKind'], writable: Number(row.writable) === 1, ...(row.source_path ? { sourcePath: String(row.source_path) } : {}), latestVersion: Number(row.latest_version), createdAt: String(row.created_at), updatedAt: String(row.updated_at) }
}
function documentVersionFrom(row: Record<string, unknown>): DocumentVersionView {
  const relationship = parseJson<Record<string, unknown> | undefined>(row.relationship_json, undefined)
  return { id: String(row.id), documentId: String(row.document_id), version: Number(row.version), content: String(row.content), contentHash: String(row.content_hash), ...(relationship ? { relationship } : {}), createdBy: String(row.created_by), createdAt: String(row.created_at) }
}
function taskFrom(row: Record<string, unknown>): TaskView {
  return { id: String(row.id), projectId: String(row.project_id), ...(row.parent_task_id ? { parentTaskId: String(row.parent_task_id) } : {}), title: String(row.title), goal: String(row.goal), status: String(row.status) as TaskStatus, priority: Number(row.priority), risk: String(row.risk ?? ''), ...(row.blocker ? { blocker: String(row.blocker) } : {}), ...(row.recovery_condition ? { recoveryCondition: String(row.recovery_condition) } : {}), ...(row.next_action ? { nextAction: String(row.next_action) } : {}), ...(row.owner_key ? { ownerKey: String(row.owner_key) } : {}), ownershipEpoch: Number(row.ownership_epoch), version: Number(row.version), createdAt: String(row.created_at), updatedAt: String(row.updated_at) }
}
function assignmentFrom(row: Record<string, unknown>): AssignmentView {
  return { id: String(row.id), taskId: String(row.task_id), ownershipEpoch: Number(row.ownership_epoch), stage: String(row.stage), role: String(row.role), ...(row.prompt_version_id ? { promptVersionId: String(row.prompt_version_id) } : {}), ...(row.workflow_version_id ? { workflowVersionId: String(row.workflow_version_id) } : {}), ...(row.context_package_id ? { contextPackageId: String(row.context_package_id) } : {}), capabilitySet: parseJson(row.capability_set_json, []), sourceScope: parseJson(row.source_scope_json, []), requiredArtifacts: parseJson(row.required_artifacts_json, []), acceptance: parseJson(row.acceptance_json, []), stopConditions: parseJson(row.stop_conditions_json, []), status: String(row.latest_status ?? row.status) as AssignmentView['status'], createdBy: String(row.created_by), createdAt: String(row.created_at) }
}
function sessionFrom(row: Record<string, unknown>): SessionView {
  return { id: String(row.id), projectId: String(row.project_id), ...(row.task_id ? { taskId: String(row.task_id) } : {}), ...(row.assignment_id ? { assignmentId: String(row.assignment_id) } : {}), role: String(row.role), client: String(row.client), ...(row.model ? { model: String(row.model) } : {}), ...(row.prompt_version_id ? { promptVersionId: String(row.prompt_version_id) } : {}), ...(row.workflow_version_id ? { workflowVersionId: String(row.workflow_version_id) } : {}), ...(row.context_package_id ? { contextPackageId: String(row.context_package_id) } : {}), ...(row.parent_session_id ? { parentSessionId: String(row.parent_session_id) } : {}), ...(row.continuation_of_session_id ? { continuationOfSessionId: String(row.continuation_of_session_id) } : {}), ...(row.runtime_id ? { runtimeId: String(row.runtime_id) } : {}), status: String(row.status) as SessionView['status'], createdAt: String(row.created_at), updatedAt: String(row.updated_at) }
}
function approvalFrom(row: Record<string, unknown>): ApprovalView {
  return { id: String(row.id), projectId: String(row.project_id), ...(row.task_id ? { taskId: String(row.task_id) } : {}), kind: String(row.kind), status: String(row.status) as ApprovalView['status'], requestedBy: String(row.requested_by), ...(row.decided_by ? { decidedBy: String(row.decided_by) } : {}), request: parseJson(row.request_json, {}), ...(row.decision_reason ? { decisionReason: String(row.decision_reason) } : {}), createdAt: String(row.created_at), ...(row.decided_at ? { decidedAt: String(row.decided_at) } : {}) }
}
function artifactFrom(row: Record<string, unknown>): ArtifactView {
  return { id: String(row.id), projectId: String(row.project_id), ...(row.task_id ? { taskId: String(row.task_id) } : {}), ...(row.assignment_id ? { assignmentId: String(row.assignment_id) } : {}), objectHash: String(row.object_hash), mediaType: String(row.media_type), sizeBytes: Number(row.size_bytes), sensitivity: String(row.sensitivity) as ArtifactView['sensitivity'], acl: parseJson(row.acl_json, []), ...(row.retention_until ? { retentionUntil: String(row.retention_until) } : {}), lifecycle: String(row.lifecycle) as ArtifactView['lifecycle'], createdBy: String(row.created_by), createdAt: String(row.created_at) }
}

export class PlatformStore {
  readonly dataRoot: string
  readonly databasePath: string
  readonly objectRoot: string
  readonly database: DatabaseSync

  constructor(dataRoot: string) {
    this.dataRoot = resolvePlatformDataRoot(dataRoot)
    this.databasePath = join(this.dataRoot, 'platform.sqlite')
    const objectRoot = join(this.dataRoot, 'objects'); mkdirSync(objectRoot, { recursive: true, mode: 0o700 })
    const objectInfo = lstatSync(objectRoot)
    if (objectInfo.isSymbolicLink() || !objectInfo.isDirectory()) throw new PlatformError('Platform object root must be a real directory', 'UNSAFE_OBJECT_ROOT')
    this.objectRoot = realpathSync(objectRoot)
    if (!pathInside(this.dataRoot, this.objectRoot)) throw new PlatformError('Platform object root escaped the data root', 'UNSAFE_OBJECT_ROOT')
    if (existsSync(this.databasePath)) {
      const info = lstatSync(this.databasePath)
      if (info.isSymbolicLink() || !info.isFile()) throw new PlatformError('Platform database must be a regular file', 'UNSAFE_DATABASE')
    }
    this.database = new DatabaseSync(this.databasePath)
    this.database.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;')
    this.#migrate()
  }
  close(): void { this.database.close() }
  schemaVersion(): number { return Number((this.database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version) }
  query<T>(actor: ActorContext, input: { capability: string; command: string; projectId?: string; taskId?: string; ownershipEpoch?: number; payload?: Record<string, unknown> }, operation: () => T): T {
    try {
      this.#authorize(actor, input.capability, false)
      this.#authorizeScope(actor, input)
      const result = operation()
      this.#transaction(() => this.#audit(actor, { ...input, decision: 'accepted' }))
      return result
    } catch (error) {
      try { this.#transaction(() => this.#audit(actor, { ...input, decision: 'rejected', reason: error instanceof Error ? error.message : String(error) })) } catch {}
      throw error
    }
  }

  #migrate(): void {
    const current = this.schemaVersion()
    if (current > PLATFORM_SCHEMA_VERSION) throw new PlatformError('Platform database schema is newer than this application', 'SCHEMA_TOO_NEW')
    if (current === PLATFORM_SCHEMA_VERSION) return
    this.database.exec('BEGIN IMMEDIATE')
    try {
      if (current < 1) this.#migrationOne()
      if (current < 2) this.#migrationTwo()
      this.database.exec(`PRAGMA user_version = ${PLATFORM_SCHEMA_VERSION}; COMMIT`)
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  #migrationOne(): void {
    this.database.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', workspace_path TEXT, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;
      CREATE TABLE documents (id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id), scope_key TEXT NOT NULL, key TEXT NOT NULL, title TEXT NOT NULL, authority_kind TEXT NOT NULL CHECK(authority_kind IN ('platform','project-link','import-snapshot','export-copy')), writable INTEGER NOT NULL CHECK(writable IN (0,1)), source_path TEXT, latest_version INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(scope_key,key), CHECK((authority_kind='platform' AND writable=1) OR (authority_kind<>'platform' AND writable=0))) STRICT;
      CREATE TABLE document_versions (id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id), version INTEGER NOT NULL, content TEXT NOT NULL, content_hash TEXT NOT NULL, relationship_json TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(document_id,version)) STRICT;
      CREATE TABLE owners (owner_key TEXT PRIMARY KEY, display_name TEXT NOT NULL, kind TEXT NOT NULL, active INTEGER NOT NULL CHECK(active IN (0,1)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;
      CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), parent_task_id TEXT REFERENCES tasks(id), title TEXT NOT NULL, goal TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('draft','open','in_progress','blocked','deferred','closed','cancelled')), priority INTEGER NOT NULL CHECK(priority BETWEEN 0 AND 4), risk TEXT NOT NULL DEFAULT '', blocker TEXT, recovery_condition TEXT, next_action TEXT, owner_key TEXT REFERENCES owners(owner_key), ownership_epoch INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, CHECK(status IN ('draft','closed','cancelled') OR owner_key IS NOT NULL), CHECK(parent_task_id IS NULL OR parent_task_id<>id)) STRICT;
      CREATE INDEX tasks_project_status ON tasks(project_id,status,priority);
      CREATE TABLE task_dependencies (task_id TEXT NOT NULL REFERENCES tasks(id), depends_on_task_id TEXT NOT NULL REFERENCES tasks(id), type TEXT NOT NULL CHECK(type IN ('blocks','parent-child','related','discovered-from')), created_at TEXT NOT NULL, PRIMARY KEY(task_id,depends_on_task_id,type), CHECK(task_id<>depends_on_task_id)) STRICT;
      CREATE TABLE prompt_versions (id TEXT PRIMARY KEY, key TEXT NOT NULL, version INTEGER NOT NULL, content TEXT NOT NULL, content_hash TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(key,version)) STRICT;
      CREATE TABLE workflow_versions (id TEXT PRIMARY KEY, key TEXT NOT NULL, version INTEGER NOT NULL, definition_json TEXT NOT NULL, definition_hash TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(key,version)) STRICT;
      CREATE TABLE context_packages (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), task_id TEXT REFERENCES tasks(id), ownership_epoch INTEGER, manifest_hash TEXT NOT NULL, token_budget INTEGER, byte_budget INTEGER NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;
      CREATE TABLE context_items (context_package_id TEXT NOT NULL REFERENCES context_packages(id), ordinal INTEGER NOT NULL, source_domain TEXT NOT NULL, source_id TEXT NOT NULL, source_version TEXT NOT NULL, selection_reason TEXT NOT NULL, content_hash TEXT NOT NULL, sensitivity TEXT NOT NULL CHECK(sensitivity IN ('public','internal','confidential','restricted')), PRIMARY KEY(context_package_id,ordinal)) STRICT;
      CREATE TABLE assignments (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), ownership_epoch INTEGER NOT NULL, stage TEXT NOT NULL, role TEXT NOT NULL, prompt_version_id TEXT REFERENCES prompt_versions(id), workflow_version_id TEXT REFERENCES workflow_versions(id), context_package_id TEXT REFERENCES context_packages(id), capability_set_json TEXT NOT NULL, source_scope_json TEXT NOT NULL, required_artifacts_json TEXT NOT NULL, acceptance_json TEXT NOT NULL, stop_conditions_json TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','dispatched','reported','accepted','rejected','cancelled')), created_by TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;
      CREATE TABLE sessions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), task_id TEXT REFERENCES tasks(id), assignment_id TEXT REFERENCES assignments(id), role TEXT NOT NULL, client TEXT NOT NULL, model TEXT, prompt_version_id TEXT REFERENCES prompt_versions(id), workflow_version_id TEXT REFERENCES workflow_versions(id), context_package_id TEXT REFERENCES context_packages(id), parent_session_id TEXT REFERENCES sessions(id), continuation_of_session_id TEXT REFERENCES sessions(id), runtime_id TEXT, status TEXT NOT NULL CHECK(status IN ('open','compacted','completed','failed','abandoned')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;
      CREATE TABLE session_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id), sequence INTEGER NOT NULL, type TEXT NOT NULL, payload_json TEXT NOT NULL, content_hash TEXT NOT NULL, occurred_at TEXT NOT NULL, UNIQUE(session_id,sequence)) STRICT;
      CREATE TABLE task_events (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id), type TEXT NOT NULL, actor_key TEXT NOT NULL, ownership_epoch INTEGER, payload_json TEXT NOT NULL, occurred_at TEXT NOT NULL) STRICT;
      CREATE TABLE approvals (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), task_id TEXT REFERENCES tasks(id), kind TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','cancelled','expired')), requested_by TEXT NOT NULL, decided_by TEXT, request_json TEXT NOT NULL, decision_reason TEXT, created_at TEXT NOT NULL, decided_at TEXT) STRICT;
      CREATE TABLE artifacts (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), task_id TEXT REFERENCES tasks(id), assignment_id TEXT REFERENCES assignments(id), object_hash TEXT NOT NULL, media_type TEXT NOT NULL, size_bytes INTEGER NOT NULL, sensitivity TEXT NOT NULL, acl_json TEXT NOT NULL, retention_until TEXT, lifecycle TEXT NOT NULL CHECK(lifecycle IN ('active','tombstoned','deleted')), created_by TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;
      CREATE TABLE workspace_observations (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL REFERENCES projects(id), task_id TEXT REFERENCES tasks(id), repository_root TEXT NOT NULL, worktree TEXT NOT NULL, branch TEXT, head TEXT, dirty INTEGER NOT NULL CHECK(dirty IN (0,1)), source_command TEXT NOT NULL, observed_at TEXT NOT NULL) STRICT;
      CREATE TABLE audit_events (id INTEGER PRIMARY KEY AUTOINCREMENT, occurred_at TEXT NOT NULL, actor_key TEXT NOT NULL, role TEXT NOT NULL, client TEXT NOT NULL, capability TEXT NOT NULL, project_id TEXT, task_id TEXT, ownership_epoch INTEGER, command TEXT NOT NULL, decision TEXT NOT NULL CHECK(decision IN ('accepted','rejected')), reason TEXT, idempotency_key TEXT, correlation_key TEXT, payload_json TEXT NOT NULL) STRICT;
      CREATE TABLE command_receipts (actor_key TEXT NOT NULL, idempotency_key TEXT NOT NULL, command TEXT NOT NULL, result_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(actor_key,idempotency_key)) STRICT;
      CREATE TRIGGER document_versions_no_update BEFORE UPDATE ON document_versions BEGIN SELECT RAISE(ABORT,'document versions are append-only'); END;
      CREATE TRIGGER document_versions_no_delete BEFORE DELETE ON document_versions BEGIN SELECT RAISE(ABORT,'document versions are append-only'); END;
      CREATE TRIGGER assignments_no_update BEFORE UPDATE ON assignments BEGIN SELECT RAISE(ABORT,'assignments are immutable'); END;
      CREATE TRIGGER assignments_no_delete BEFORE DELETE ON assignments BEGIN SELECT RAISE(ABORT,'assignments are immutable'); END;
      CREATE TRIGGER session_events_no_update BEFORE UPDATE ON session_events BEGIN SELECT RAISE(ABORT,'session events are append-only'); END;
      CREATE TRIGGER session_events_no_delete BEFORE DELETE ON session_events BEGIN SELECT RAISE(ABORT,'session events are append-only'); END;
      CREATE TRIGGER task_events_no_update BEFORE UPDATE ON task_events BEGIN SELECT RAISE(ABORT,'task events are append-only'); END;
      CREATE TRIGGER task_events_no_delete BEFORE DELETE ON task_events BEGIN SELECT RAISE(ABORT,'task events are append-only'); END;
      CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT,'audit events are append-only'); END;
      CREATE TRIGGER audit_events_no_delete BEFORE DELETE ON audit_events BEGIN SELECT RAISE(ABORT,'audit events are append-only'); END;
      CREATE TRIGGER prompt_versions_no_update BEFORE UPDATE ON prompt_versions BEGIN SELECT RAISE(ABORT,'prompt versions are immutable'); END;
      CREATE TRIGGER workflow_versions_no_update BEFORE UPDATE ON workflow_versions BEGIN SELECT RAISE(ABORT,'workflow versions are immutable'); END;
    `)
  }

  #migrationTwo(): void {
    this.database.exec(`
      CREATE TABLE assignment_events (id INTEGER PRIMARY KEY AUTOINCREMENT, assignment_id TEXT NOT NULL REFERENCES assignments(id), sequence INTEGER NOT NULL, type TEXT NOT NULL CHECK(type IN ('dispatched','reported','accepted','rejected','cancelled')), actor_key TEXT NOT NULL, payload_json TEXT NOT NULL, occurred_at TEXT NOT NULL, UNIQUE(assignment_id,sequence)) STRICT;
      CREATE TABLE workspace_expectations (project_id TEXT PRIMARY KEY REFERENCES projects(id), branch TEXT, head TEXT, clean_required INTEGER NOT NULL CHECK(clean_required IN (0,1)), version INTEGER NOT NULL, updated_by TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;
      CREATE INDEX assignment_events_assignment_sequence ON assignment_events(assignment_id,sequence DESC);
      CREATE INDEX session_events_session_sequence ON session_events(session_id,sequence);
      CREATE INDEX artifacts_project_task ON artifacts(project_id,task_id,created_at);
      CREATE TRIGGER assignment_events_no_update BEFORE UPDATE ON assignment_events BEGIN SELECT RAISE(ABORT,'assignment events are append-only'); END;
      CREATE TRIGGER assignment_events_no_delete BEFORE DELETE ON assignment_events BEGIN SELECT RAISE(ABORT,'assignment events are append-only'); END;
      CREATE TRIGGER prompt_versions_no_delete BEFORE DELETE ON prompt_versions BEGIN SELECT RAISE(ABORT,'prompt versions are immutable'); END;
      CREATE TRIGGER workflow_versions_no_delete BEFORE DELETE ON workflow_versions BEGIN SELECT RAISE(ABORT,'workflow versions are immutable'); END;
    `)
  }

  #authorize(actor: ActorContext, capability: string, mutation = true): void {
    boundedId(actor.actorKey, 'actorKey')
    if (mutation && MUTATION_DENIED_ROLES.has(actor.role)) throw new PlatformError(`${actor.role} is read-only`, 'FORBIDDEN')
    if (!actor.capabilities.includes('*') && !actor.capabilities.includes(capability)) throw new PlatformError(`Missing capability ${capability}`, 'FORBIDDEN')
  }
  #authorizeScope(actor: ActorContext, input: { projectId?: string; taskId?: string; ownershipEpoch?: number }): void {
    if (input.projectId && actor.projectScope && !actor.projectScope.includes(input.projectId)) throw new PlatformError('Actor is outside the project scope', 'FORBIDDEN')
    if (input.taskId && actor.taskScope && !actor.taskScope.includes(input.taskId)) throw new PlatformError('Actor is outside the task scope', 'FORBIDDEN')
    if (input.ownershipEpoch !== undefined && actor.ownershipEpoch !== undefined && actor.ownershipEpoch !== input.ownershipEpoch) throw new PlatformError('Actor ownership epoch is stale', 'OWNERSHIP_CONFLICT')
  }
  #transaction<T>(operation: () => T): T {
    this.database.exec('BEGIN IMMEDIATE')
    try { const result = operation(); this.database.exec('COMMIT'); return result } catch (error) { this.database.exec('ROLLBACK'); throw error }
  }
  #audit(actor: ActorContext, input: { capability: string; command: string; decision: 'accepted' | 'rejected'; reason?: string; projectId?: string; taskId?: string; ownershipEpoch?: number; idempotencyKey?: string; correlationKey?: string; payload?: Record<string, unknown> }): void {
    this.database.prepare(`INSERT INTO audit_events (occurred_at,actor_key,role,client,capability,project_id,task_id,ownership_epoch,command,decision,reason,idempotency_key,correlation_key,payload_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(now(), actor.actorKey, actor.role, actor.client, input.capability, input.projectId ?? null, input.taskId ?? null, input.ownershipEpoch ?? null, input.command, input.decision, input.reason ?? null, input.idempotencyKey ?? null, input.correlationKey ?? null, JSON.stringify(redact(input.payload ?? {})))
  }
  #command<T>(actor: ActorContext, input: { capability: string; command: string; idempotencyKey: string; correlationKey?: string; projectId?: string; taskId?: string; ownershipEpoch?: number; payload?: Record<string, unknown> }, operation: () => T): T {
    const idempotencyKey = boundedId(input.idempotencyKey, 'idempotencyKey')
    try {
      this.#authorize(actor, input.capability)
      this.#authorizeScope(actor, input)
      const receipt = this.database.prepare('SELECT command,result_json FROM command_receipts WHERE actor_key=? AND idempotency_key=?').get(actor.actorKey, idempotencyKey) as { command: string; result_json: string } | undefined
      if (receipt) { if (receipt.command !== input.command) throw new PlatformError('Idempotency key was used for another command', 'IDEMPOTENCY_CONFLICT'); return JSON.parse(receipt.result_json) as T }
      return this.#transaction(() => {
        const result = operation()
        this.#audit(actor, { ...input, idempotencyKey, decision: 'accepted' })
        this.database.prepare('INSERT INTO command_receipts (actor_key,idempotency_key,command,result_json,created_at) VALUES (?,?,?,?,?)').run(actor.actorKey, idempotencyKey, input.command, JSON.stringify(result), now())
        return result
      })
    } catch (error) {
      try { this.#transaction(() => this.#audit(actor, { ...input, idempotencyKey, decision: 'rejected', reason: error instanceof Error ? error.message : String(error) })) } catch {}
      throw error
    }
  }

  createProject(actor: ActorContext, input: { key: string; name: string; description?: string; workspacePath?: string; idempotencyKey: string; correlationKey?: string }): ProjectView {
    const key = boundedKey(input.key, 'key'); const name = scalarText(input.name, 'name', 256); const description = optionalText(input.description, 'description') ?? ''; const workspacePath = optionalText(input.workspacePath, 'workspacePath', 4_096)
    return this.#command(actor, { capability: 'project:create', command: 'project.create', idempotencyKey: input.idempotencyKey, correlationKey: input.correlationKey, payload: { key, name, workspacePath } }, () => {
      const projectId = newId('project'); const timestamp = now()
      this.database.prepare('INSERT INTO projects (id,key,name,description,workspace_path,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(projectId, key, name, description, workspacePath ?? null, timestamp, timestamp)
      return this.getProject(projectId)
    })
  }
  getProject(projectId: string): ProjectView {
    const row = this.database.prepare('SELECT * FROM projects WHERE id=?').get(boundedId(projectId, 'projectId')) as Record<string, unknown> | undefined
    if (!row) throw new PlatformError('Project was not found', 'NOT_FOUND')
    return projectFrom(row)
  }
  listProjects(limit = 100): ProjectView[] { return (this.database.prepare('SELECT * FROM projects ORDER BY updated_at DESC LIMIT ?').all(integer(limit, 'limit', 1, MAX_PAGE_SIZE)) as Record<string, unknown>[]).map(projectFrom) }

  createDocument(actor: ActorContext, input: { projectId?: string; key: string; title: string; authorityKind: DocumentView['authorityKind']; sourcePath?: string; content?: string; relationship?: Record<string, unknown>; idempotencyKey: string; correlationKey?: string }): { document: DocumentView; version?: DocumentVersionView } {
    const projectId = input.projectId ? boundedId(input.projectId, 'projectId') : undefined; const key = boundedKey(input.key, 'key'); const title = scalarText(input.title, 'title', 256); const sourcePath = optionalText(input.sourcePath, 'sourcePath', 4_096); const content = optionalText(input.content, 'content'); const relationship = input.relationship ? jsonObject(input.relationship, 'relationship') : undefined
    if (!['platform', 'project-link', 'import-snapshot', 'export-copy'].includes(input.authorityKind)) throw new PlatformError('authorityKind is invalid', 'INVALID_INPUT')
    if (input.authorityKind === 'project-link' && !sourcePath) throw new PlatformError('project-link requires sourcePath', 'INVALID_INPUT')
    if (input.authorityKind !== 'project-link' && !content) throw new PlatformError('A document version is required', 'INVALID_INPUT')
    return this.#command(actor, { capability: 'document:create', command: 'document.create', idempotencyKey: input.idempotencyKey, correlationKey: input.correlationKey, projectId, payload: { key, title, authorityKind: input.authorityKind, sourcePath } }, () => {
      if (projectId) this.getProject(projectId)
      const documentId = newId('document'); const timestamp = now(); const writable = input.authorityKind === 'platform' ? 1 : 0
      this.database.prepare('INSERT INTO documents (id,project_id,scope_key,key,title,authority_kind,writable,source_path,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(documentId, projectId ?? null, projectId ?? 'platform', key, title, input.authorityKind, writable, sourcePath ?? null, timestamp, timestamp)
      let version: DocumentVersionView | undefined
      if (content) version = this.#appendDocumentVersion(documentId, content, relationship, actor.actorKey)
      return { document: this.getDocument(documentId), ...(version ? { version } : {}) }
    })
  }
  appendDocumentVersion(actor: ActorContext, input: { documentId: string; content: string; relationship?: Record<string, unknown>; idempotencyKey: string; correlationKey?: string }): DocumentVersionView {
    const documentId = boundedId(input.documentId, 'documentId'); const document = this.getDocument(documentId)
    if (!document.writable) throw new PlatformError('Only platform-native documents are writable', 'READ_ONLY_DOCUMENT')
    const content = scalarText(input.content, 'content'); const relationship = input.relationship ? jsonObject(input.relationship, 'relationship') : undefined
    return this.#command(actor, { capability: 'document:version', command: 'document.version', idempotencyKey: input.idempotencyKey, correlationKey: input.correlationKey, projectId: document.projectId, payload: { documentId } }, () => this.#appendDocumentVersion(documentId, content, relationship, actor.actorKey))
  }
  #appendDocumentVersion(documentId: string, content: string, relationship: Record<string, unknown> | undefined, actorKey: string): DocumentVersionView {
    const version = this.getDocument(documentId).latestVersion + 1; const versionId = newId('document_version'); const timestamp = now(); const hash = createHash('sha256').update(content).digest('hex')
    this.database.prepare('INSERT INTO document_versions (id,document_id,version,content,content_hash,relationship_json,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)').run(versionId, documentId, version, content, hash, relationship ? JSON.stringify(relationship) : null, actorKey, timestamp)
    this.database.prepare('UPDATE documents SET latest_version=?,updated_at=? WHERE id=?').run(version, timestamp, documentId)
    return this.getDocumentVersion(documentId, version)
  }
  getDocument(documentId: string): DocumentView {
    const row = this.database.prepare('SELECT * FROM documents WHERE id=?').get(boundedId(documentId, 'documentId')) as Record<string, unknown> | undefined
    if (!row) throw new PlatformError('Document was not found', 'NOT_FOUND')
    return documentFrom(row)
  }
  listDocuments(projectId?: string, limit = 100): DocumentView[] {
    const rows = projectId ? this.database.prepare('SELECT * FROM documents WHERE project_id=? ORDER BY updated_at DESC LIMIT ?').all(boundedId(projectId, 'projectId'), integer(limit, 'limit', 1, MAX_PAGE_SIZE)) : this.database.prepare('SELECT * FROM documents ORDER BY updated_at DESC LIMIT ?').all(integer(limit, 'limit', 1, MAX_PAGE_SIZE))
    return (rows as Record<string, unknown>[]).map(documentFrom)
  }
  getDocumentVersion(documentId: string, version?: number): DocumentVersionView {
    const document = this.getDocument(documentId); const selected = version ?? document.latestVersion
    if (selected < 1) throw new PlatformError('Document has no stored content version', 'NOT_FOUND')
    const row = this.database.prepare('SELECT * FROM document_versions WHERE document_id=? AND version=?').get(document.id, selected) as Record<string, unknown> | undefined
    if (!row) throw new PlatformError('Document version was not found', 'NOT_FOUND')
    return documentVersionFrom(row)
  }

  createTaskDraft(actor: ActorContext, input: { projectId: string; parentTaskId?: string; title: string; goal: string; priority?: number; risk?: string; nextAction?: string; idempotencyKey: string; correlationKey?: string }): TaskView {
    const projectId = boundedId(input.projectId, 'projectId'); const parentTaskId = input.parentTaskId ? boundedId(input.parentTaskId, 'parentTaskId') : undefined; const title = scalarText(input.title, 'title', 512); const goal = scalarText(input.goal, 'goal'); const priority = input.priority === undefined ? 2 : integer(input.priority, 'priority', 0, 4); const risk = optionalText(input.risk, 'risk', 8_192) ?? ''; const nextAction = optionalText(input.nextAction, 'nextAction', 4_096)
    return this.#command(actor, { capability: 'task:draft', command: 'task.draft', idempotencyKey: input.idempotencyKey, correlationKey: input.correlationKey, projectId, payload: { title, parentTaskId, priority } }, () => {
      this.getProject(projectId)
      if (parentTaskId && this.getTask(parentTaskId).projectId !== projectId) throw new PlatformError('Parent task belongs to another project', 'INVALID_INPUT')
      const taskId = newId('task'); const timestamp = now()
      this.database.prepare("INSERT INTO tasks (id,project_id,parent_task_id,title,goal,status,priority,risk,next_action,created_at,updated_at) VALUES (?,?,?,?,?,'draft',?,?,?,?,?)").run(taskId, projectId, parentTaskId ?? null, title, goal, priority, risk, nextAction ?? null, timestamp, timestamp)
      this.#taskEvent(taskId, 'draft.created', actor, undefined, { title, priority })
      return this.getTask(taskId)
    })
  }
  confirmTask(actor: ActorContext, input: { taskId: string; ownerKey: string; ownerDisplayName?: string; expectedVersion: number; idempotencyKey: string; correlationKey?: string }): TaskView {
    const taskId = boundedId(input.taskId, 'taskId'); const ownerKey = boundedId(input.ownerKey, 'ownerKey'); const expectedVersion = integer(input.expectedVersion, 'expectedVersion', 1, Number.MAX_SAFE_INTEGER); const current = this.getTask(taskId)
    return this.#command(actor, { capability: 'task:confirm', command: 'task.confirm', idempotencyKey: input.idempotencyKey, correlationKey: input.correlationKey, projectId: current.projectId, taskId, payload: { ownerKey, expectedVersion } }, () => {
      const task = this.getTask(taskId)
      if (task.status !== 'draft') throw new PlatformError('Only draft tasks can be confirmed', 'INVALID_TRANSITION')
      if (task.version !== expectedVersion) throw new PlatformError('Task version changed', 'VERSION_CONFLICT')
      if (!task.nextAction) throw new PlatformError('Confirming a task requires one nextAction', 'INVALID_INPUT')
      this.#ensureOwner(ownerKey, input.ownerDisplayName ?? ownerKey)
      this.database.prepare("UPDATE tasks SET status='open',owner_key=?,ownership_epoch=1,version=version+1,updated_at=? WHERE id=?").run(ownerKey, now(), taskId)
      this.#taskEvent(taskId, 'task.confirmed', actor, 1, { ownerKey })
      return this.getTask(taskId)
    })
  }
  transferOwner(actor: ActorContext, input: { taskId: string; newOwnerKey: string; newOwnerDisplayName?: string; expectedOwnershipEpoch: number; reason: string; idempotencyKey: string; correlationKey?: string }): TaskView {
    const taskId = boundedId(input.taskId, 'taskId'); const newOwnerKey = boundedId(input.newOwnerKey, 'newOwnerKey'); const epoch = integer(input.expectedOwnershipEpoch, 'expectedOwnershipEpoch', 1, Number.MAX_SAFE_INTEGER); const reason = scalarText(input.reason, 'reason', 4_096); const current = this.getTask(taskId)
    return this.#command(actor, { capability: 'owner:transfer', command: 'owner.transfer', idempotencyKey: input.idempotencyKey, correlationKey: input.correlationKey, projectId: current.projectId, taskId, ownershipEpoch: epoch, payload: { newOwnerKey, reason } }, () => {
      const task = this.getTask(taskId)
      if (!ACTIVE_STATUSES.has(task.status)) throw new PlatformError('Only active tasks can transfer ownership', 'INVALID_TRANSITION')
      if (task.ownershipEpoch !== epoch) throw new PlatformError('Ownership epoch changed', 'OWNERSHIP_CONFLICT')
      this.#ensureOwner(newOwnerKey, input.newOwnerDisplayName ?? newOwnerKey)
      const nextEpoch = epoch + 1
      this.database.prepare('UPDATE tasks SET owner_key=?,ownership_epoch=?,version=version+1,updated_at=? WHERE id=?').run(newOwnerKey, nextEpoch, now(), taskId)
      this.#taskEvent(taskId, 'owner.transferred', actor, nextEpoch, { previousOwnerKey: task.ownerKey, newOwnerKey, reason })
      return this.getTask(taskId)
    })
  }
  transitionTask(actor: ActorContext, input: { taskId: string; status: Exclude<TaskStatus, 'draft'>; expectedVersion: number; expectedOwnershipEpoch: number; nextAction?: string; blocker?: string; recoveryCondition?: string; reason: string; idempotencyKey: string; correlationKey?: string }): TaskView {
    const taskId = boundedId(input.taskId, 'taskId'); const current = this.getTask(taskId); const reason = scalarText(input.reason, 'reason', 4_096)
    if (!['open', 'in_progress', 'blocked', 'deferred', 'closed', 'cancelled'].includes(input.status)) throw new PlatformError('status is invalid', 'INVALID_INPUT')
    return this.#command(actor, { capability: 'task:transition', command: 'task.transition', idempotencyKey: input.idempotencyKey, correlationKey: input.correlationKey, projectId: current.projectId, taskId, ownershipEpoch: input.expectedOwnershipEpoch, payload: { status: input.status, reason } }, () => {
      const task = this.getTask(taskId); this.#assertCurrentOwner(actor, task, input.expectedOwnershipEpoch)
      if (task.version !== integer(input.expectedVersion, 'expectedVersion', 1, Number.MAX_SAFE_INTEGER)) throw new PlatformError('Task version changed', 'VERSION_CONFLICT')
      const nextAction = optionalText(input.nextAction, 'nextAction', 4_096); const blocker = optionalText(input.blocker, 'blocker', 8_192); const recovery = optionalText(input.recoveryCondition, 'recoveryCondition', 8_192)
      if (input.status === 'blocked' && (!blocker || !recovery)) throw new PlatformError('Blocked tasks require blocker and recoveryCondition', 'INVALID_INPUT')
      if (ACTIVE_STATUSES.has(input.status) && !nextAction) throw new PlatformError('Active tasks require one nextAction', 'INVALID_INPUT')
      this.database.prepare('UPDATE tasks SET status=?,next_action=?,blocker=?,recovery_condition=?,version=version+1,updated_at=? WHERE id=?').run(input.status, nextAction ?? null, blocker ?? null, recovery ?? null, now(), taskId)
      this.#taskEvent(taskId, 'status.transitioned', actor, task.ownershipEpoch, { from: task.status, to: input.status, reason, nextAction })
      return this.getTask(taskId)
    })
  }
  addDependency(actor: ActorContext, input: { taskId: string; dependsOnTaskId: string; type: DependencyView['type']; idempotencyKey: string; correlationKey?: string }): DependencyView {
    const taskId = boundedId(input.taskId, 'taskId'); const dependsOnTaskId = boundedId(input.dependsOnTaskId, 'dependsOnTaskId'); const task = this.getTask(taskId)
    if (!['blocks', 'parent-child', 'related', 'discovered-from'].includes(input.type)) throw new PlatformError('dependency type is invalid', 'INVALID_INPUT')
    return this.#command(actor, { capability: 'task:dependency', command: 'task.dependency.add', idempotencyKey: input.idempotencyKey, correlationKey: input.correlationKey, projectId: task.projectId, taskId, payload: { dependsOnTaskId, type: input.type } }, () => {
      if (task.projectId !== this.getTask(dependsOnTaskId).projectId) throw new PlatformError('Cross-project dependencies require an explicit external relationship', 'INVALID_INPUT')
      if (input.type === 'blocks' || input.type === 'parent-child') this.#assertNoDependencyCycle(taskId, dependsOnTaskId)
      const createdAt = now(); this.database.prepare('INSERT INTO task_dependencies (task_id,depends_on_task_id,type,created_at) VALUES (?,?,?,?)').run(taskId, dependsOnTaskId, input.type, createdAt)
      this.#taskEvent(taskId, 'dependency.added', actor, task.ownershipEpoch || undefined, { dependsOnTaskId, type: input.type })
      return { taskId, dependsOnTaskId, type: input.type, createdAt }
    })
  }
  listDependencies(taskId?: string, limit = 200): DependencyView[] {
    const rows = taskId ? this.database.prepare('SELECT * FROM task_dependencies WHERE task_id=? OR depends_on_task_id=? ORDER BY created_at DESC LIMIT ?').all(boundedId(taskId, 'taskId'), taskId, integer(limit, 'limit', 1, MAX_PAGE_SIZE)) : this.database.prepare('SELECT * FROM task_dependencies ORDER BY created_at DESC LIMIT ?').all(integer(limit, 'limit', 1, MAX_PAGE_SIZE))
    return (rows as Record<string, unknown>[]).map((row) => ({ taskId: String(row.task_id), dependsOnTaskId: String(row.depends_on_task_id), type: String(row.type) as DependencyView['type'], createdAt: String(row.created_at) }))
  }
  #assertNoDependencyCycle(taskId: string, dependsOnTaskId: string): void {
    if (taskId === dependsOnTaskId) throw new PlatformError('A task cannot depend on itself', 'DEPENDENCY_CYCLE')
    const found = this.database.prepare("WITH RECURSIVE reachable(id) AS (SELECT depends_on_task_id FROM task_dependencies WHERE task_id=? AND type IN ('blocks','parent-child') UNION SELECT d.depends_on_task_id FROM task_dependencies d JOIN reachable r ON d.task_id=r.id WHERE d.type IN ('blocks','parent-child')) SELECT 1 AS found FROM reachable WHERE id=? LIMIT 1").get(dependsOnTaskId, taskId)
    if (found) throw new PlatformError('Dependency would create a cycle', 'DEPENDENCY_CYCLE')
  }

  createPromptVersion(actor: ActorContext, input: { key: string; content: string; idempotencyKey: string; correlationKey?: string }): PromptVersionView {
    const key = boundedKey(input.key, 'key'); const content = scalarText(input.content, 'content', MAX_TEXT, true)
    return this.#command(actor, { capability: 'workflow:write', command: 'prompt.version.create', idempotencyKey: input.idempotencyKey, correlationKey: input.correlationKey, payload: { key, contentHash: createHash('sha256').update(content).digest('hex') } }, () => {
      const version = Number((this.database.prepare('SELECT COALESCE(MAX(version),0)+1 AS version FROM prompt_versions WHERE key=?').get(key) as { version: number }).version)
      const id = newId('prompt'); const contentHash = createHash('sha256').update(content).digest('hex'); const createdAt = now()
      this.database.prepare('INSERT INTO prompt_versions (id,key,version,content,content_hash,created_by,created_at) VALUES (?,?,?,?,?,?,?)').run(id, key, version, content, contentHash, actor.actorKey, createdAt)
      return { id, key, version, content, contentHash, createdBy: actor.actorKey, createdAt }
    })
  }
  createWorkflowVersion(actor: ActorContext, input: { key: string; definition: Record<string, unknown>; idempotencyKey: string; correlationKey?: string }): WorkflowVersionView {
    const key = boundedKey(input.key, 'key'); const definition = jsonObject(input.definition, 'definition'); const stored = redact(definition) as Record<string, unknown>; const serialized = JSON.stringify(stored)
    return this.#command(actor, { capability: 'workflow:write', command: 'workflow.version.create', idempotencyKey: input.idempotencyKey, correlationKey: input.correlationKey, payload: { key, definitionHash: createHash('sha256').update(serialized).digest('hex') } }, () => {
      const version = Number((this.database.prepare('SELECT COALESCE(MAX(version),0)+1 AS version FROM workflow_versions WHERE key=?').get(key) as { version: number }).version)
      const id = newId('workflow'); const definitionHash = createHash('sha256').update(serialized).digest('hex'); const createdAt = now()
      this.database.prepare('INSERT INTO workflow_versions (id,key,version,definition_json,definition_hash,created_by,created_at) VALUES (?,?,?,?,?,?,?)').run(id, key, version, serialized, definitionHash, actor.actorKey, createdAt)
      return { id, key, version, definition: stored, definitionHash, createdBy: actor.actorKey, createdAt }
    })
  }
  listPromptVersions(key?: string, limit = 100): PromptVersionView[] {
    const rows = key ? this.database.prepare('SELECT * FROM prompt_versions WHERE key=? ORDER BY version DESC LIMIT ?').all(boundedKey(key, 'key'), integer(limit, 'limit', 1, MAX_PAGE_SIZE)) : this.database.prepare('SELECT * FROM prompt_versions ORDER BY created_at DESC LIMIT ?').all(integer(limit, 'limit', 1, MAX_PAGE_SIZE))
    return (rows as Record<string, unknown>[]).map((row) => ({ id: String(row.id), key: String(row.key), version: Number(row.version), content: String(row.content), contentHash: String(row.content_hash), createdBy: String(row.created_by), createdAt: String(row.created_at) }))
  }
  listWorkflowVersions(key?: string, limit = 100): WorkflowVersionView[] {
    const rows = key ? this.database.prepare('SELECT * FROM workflow_versions WHERE key=? ORDER BY version DESC LIMIT ?').all(boundedKey(key, 'key'), integer(limit, 'limit', 1, MAX_PAGE_SIZE)) : this.database.prepare('SELECT * FROM workflow_versions ORDER BY created_at DESC LIMIT ?').all(integer(limit, 'limit', 1, MAX_PAGE_SIZE))
    return (rows as Record<string, unknown>[]).map((row) => ({ id: String(row.id), key: String(row.key), version: Number(row.version), definition: parseJson(row.definition_json, {}), definitionHash: String(row.definition_hash), createdBy: String(row.created_by), createdAt: String(row.created_at) }))
  }

  createAssignment(actor: ActorContext, input: { taskId: string; expectedOwnershipEpoch: number; stage: string; role: string; promptVersionId?: string; workflowVersionId?: string; contextPackageId?: string; capabilitySet: string[]; sourceScope: string[]; requiredArtifacts: string[]; acceptance: string[]; stopConditions: string[]; idempotencyKey: string; correlationKey?: string }): AssignmentView {
    const taskId = boundedId(input.taskId, 'taskId'); const task = this.getTask(taskId)
    return this.#command(actor, { capability: 'assignment:create', command: 'assignment.create', idempotencyKey: input.idempotencyKey, correlationKey: input.correlationKey, projectId: task.projectId, taskId, ownershipEpoch: input.expectedOwnershipEpoch, payload: { stage: input.stage, role: input.role } }, () => {
      const current = this.getTask(taskId); this.#assertCurrentOwner(actor, current, input.expectedOwnershipEpoch); const assignmentId = newId('assignment')
      const values = [assignmentId, taskId, current.ownershipEpoch, scalarText(input.stage, 'stage', 128), scalarText(input.role, 'role', 128), input.promptVersionId ? boundedId(input.promptVersionId, 'promptVersionId') : null, input.workflowVersionId ? boundedId(input.workflowVersionId, 'workflowVersionId') : null, input.contextPackageId ? boundedId(input.contextPackageId, 'contextPackageId') : null, JSON.stringify(stringArray(input.capabilitySet, 'capabilitySet')), JSON.stringify(stringArray(input.sourceScope, 'sourceScope')), JSON.stringify(stringArray(input.requiredArtifacts, 'requiredArtifacts')), JSON.stringify(stringArray(input.acceptance, 'acceptance')), JSON.stringify(stringArray(input.stopConditions, 'stopConditions')), 'pending', actor.actorKey, now()] as SQLInputValue[]
      this.database.prepare('INSERT INTO assignments (id,task_id,ownership_epoch,stage,role,prompt_version_id,workflow_version_id,context_package_id,capability_set_json,source_scope_json,required_artifacts_json,acceptance_json,stop_conditions_json,status,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(...values)
      this.#taskEvent(taskId, 'assignment.created', actor, current.ownershipEpoch, { assignmentId, stage: input.stage, role: input.role })
      return this.getAssignment(assignmentId)
    })
  }
  getAssignment(assignmentId: string): AssignmentView {
    const row = this.database.prepare("SELECT a.*,COALESCE((SELECT e.type FROM assignment_events e WHERE e.assignment_id=a.id ORDER BY e.sequence DESC LIMIT 1),a.status) AS latest_status FROM assignments a WHERE a.id=?").get(boundedId(assignmentId, 'assignmentId')) as Record<string, unknown> | undefined
    if (!row) throw new PlatformError('Assignment was not found', 'NOT_FOUND')
    return assignmentFrom(row)
  }
  listAssignments(input: { taskId?: string; status?: AssignmentView['status']; limit?: number } = {}): AssignmentView[] {
    const clauses: string[] = []; const parameters: SQLInputValue[] = []
    if (input.taskId) { clauses.push('a.task_id=?'); parameters.push(boundedId(input.taskId, 'taskId')) }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    parameters.push(integer(input.limit ?? 100, 'limit', 1, MAX_PAGE_SIZE))
    const rows = (this.database.prepare(`SELECT a.*,COALESCE((SELECT e.type FROM assignment_events e WHERE e.assignment_id=a.id ORDER BY e.sequence DESC LIMIT 1),a.status) AS latest_status FROM assignments a ${where} ORDER BY a.created_at DESC LIMIT ?`).all(...parameters) as Record<string, unknown>[]).map(assignmentFrom)
    return input.status ? rows.filter((item) => item.status === input.status) : rows
  }
  appendAssignmentEvent(actor: ActorContext, input: { assignmentId: string; expectedOwnershipEpoch: number; type: AssignmentEventView['type']; payload?: Record<string, unknown>; idempotencyKey: string; correlationKey?: string }): AssignmentEventView {
    const assignmentId = boundedId(input.assignmentId, 'assignmentId'); const assignment = this.getAssignment(assignmentId); const task = this.getTask(assignment.taskId); const epoch = integer(input.expectedOwnershipEpoch, 'expectedOwnershipEpoch', 1, Number.MAX_SAFE_INTEGER); const payload = jsonObject(input.payload ?? {}, 'payload')
    const allowed: Record<AssignmentView['status'], AssignmentEventView['type'][]> = { pending: ['dispatched', 'cancelled'], dispatched: ['reported', 'cancelled'], reported: ['accepted', 'rejected', 'cancelled'], accepted: [], rejected: [], cancelled: [] }
    return this.#command(actor, { capability: `assignment:${input.type}`, command: 'assignment.event.append', idempotencyKey: input.idempotencyKey, correlationKey: input.correlationKey, projectId: task.projectId, taskId: task.id, ownershipEpoch: epoch, payload: { assignmentId, type: input.type } }, () => {
      const currentTask = this.getTask(task.id); const currentAssignment = this.getAssignment(assignmentId)
      if (currentTask.ownershipEpoch !== epoch || currentAssignment.ownershipEpoch !== epoch) throw new PlatformError('Assignment ownership epoch is stale', 'OWNERSHIP_CONFLICT')
      if (input.type !== 'reported') this.#assertCurrentOwner(actor, currentTask, epoch)
      if (!allowed[currentAssignment.status].includes(input.type)) throw new PlatformError(`Cannot move assignment from ${currentAssignment.status} to ${input.type}`, 'INVALID_TRANSITION')
      const sequence = Number((this.database.prepare('SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM assignment_events WHERE assignment_id=?').get(assignmentId) as { sequence: number }).sequence); const occurredAt = now(); const stored = redact(payload) as Record<string, unknown>
      const result = this.database.prepare('INSERT INTO assignment_events (assignment_id,sequence,type,actor_key,payload_json,occurred_at) VALUES (?,?,?,?,?,?)').run(assignmentId, sequence, input.type, actor.actorKey, JSON.stringify(stored), occurredAt)
      this.#taskEvent(task.id, `assignment.${input.type}`, actor, epoch, { assignmentId, sequence })
      return { id: Number(result.lastInsertRowid), assignmentId, sequence, type: input.type, actorKey: actor.actorKey, payload: stored, occurredAt }
    })
  }
  listAssignmentEvents(assignmentId: string): AssignmentEventView[] {
    return (this.database.prepare('SELECT * FROM assignment_events WHERE assignment_id=? ORDER BY sequence').all(boundedId(assignmentId, 'assignmentId')) as Record<string, unknown>[]).map((row) => ({ id: Number(row.id), assignmentId: String(row.assignment_id), sequence: Number(row.sequence), type: String(row.type) as AssignmentEventView['type'], actorKey: String(row.actor_key), payload: parseJson(row.payload_json, {}), occurredAt: String(row.occurred_at) }))
  }

  openSession(actor: ActorContext, input: { projectId: string; taskId?: string; assignmentId?: string; role: string; client: string; model?: string; promptVersionId?: string; workflowVersionId?: string; contextPackageId?: string; parentSessionId?: string; continuationOfSessionId?: string; runtimeId?: string; idempotencyKey: string; correlationKey?: string }): SessionView {
    const projectId = boundedId(input.projectId, 'projectId')
    return this.#command(actor, { capability: 'session:open', command: 'session.open', idempotencyKey: input.idempotencyKey, correlationKey: input.correlationKey, projectId, taskId: input.taskId, payload: { role: input.role, client: input.client } }, () => {
      this.getProject(projectId); const sessionId = newId('session'); const timestamp = now()
      const values = [sessionId, projectId, input.taskId ?? null, input.assignmentId ?? null, scalarText(input.role, 'role', 128), scalarText(input.client, 'client', 128), optionalText(input.model, 'model', 256) ?? null, input.promptVersionId ?? null, input.workflowVersionId ?? null, input.contextPackageId ?? null, input.parentSessionId ?? null, input.continuationOfSessionId ?? null, optionalText(input.runtimeId, 'runtimeId', 256) ?? null, 'open', timestamp, timestamp] as SQLInputValue[]
      this.database.prepare('INSERT INTO sessions (id,project_id,task_id,assignment_id,role,client,model,prompt_version_id,workflow_version_id,context_package_id,parent_session_id,continuation_of_session_id,runtime_id,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(...values)
      return this.getSession(sessionId)
    })
  }
  appendSessionEvent(actor: ActorContext, input: { sessionId: string; type: string; payload: Record<string, unknown>; idempotencyKey: string; correlationKey?: string }): { sessionId: string; sequence: number; type: string; contentHash: string; occurredAt: string } {
    const sessionId = boundedId(input.sessionId, 'sessionId'); const type = boundedKey(input.type, 'type'); const payload = jsonObject(input.payload, 'payload'); const session = this.getSession(sessionId)
    return this.#command(actor, { capability: 'session:event', command: 'session.event.append', idempotencyKey: input.idempotencyKey, correlationKey: input.correlationKey, projectId: session.projectId, taskId: session.taskId, payload: { sessionId, type } }, () => {
      const serialized = JSON.stringify(redact(payload)); const sequence = Number((this.database.prepare('SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM session_events WHERE session_id=?').get(sessionId) as { sequence: number }).sequence); const contentHash = createHash('sha256').update(serialized).digest('hex'); const occurredAt = now()
      this.database.prepare('INSERT INTO session_events (session_id,sequence,type,payload_json,content_hash,occurred_at) VALUES (?,?,?,?,?,?)').run(sessionId, sequence, type, serialized, contentHash, occurredAt)
      this.database.prepare('UPDATE sessions SET updated_at=? WHERE id=?').run(occurredAt, sessionId)
      return { sessionId, sequence, type, contentHash, occurredAt }
    })
  }
  listSessionEvents(sessionId: string, limit = 200): SessionEventView[] {
    return (this.database.prepare('SELECT * FROM session_events WHERE session_id=? ORDER BY sequence LIMIT ?').all(boundedId(sessionId, 'sessionId'), integer(limit, 'limit', 1, MAX_PAGE_SIZE)) as Record<string, unknown>[]).map((row) => ({ id: Number(row.id), sessionId: String(row.session_id), sequence: Number(row.sequence), type: String(row.type), payload: parseJson(row.payload_json, {}), contentHash: String(row.content_hash), occurredAt: String(row.occurred_at) }))
  }
  closeSession(actor: ActorContext, input: { sessionId: string; status: Exclude<SessionView['status'], 'open'>; idempotencyKey: string; correlationKey?: string }): SessionView {
    const sessionId = boundedId(input.sessionId, 'sessionId'); const session = this.getSession(sessionId)
    if (!['compacted', 'completed', 'failed', 'abandoned'].includes(input.status)) throw new PlatformError('Session terminal status is invalid', 'INVALID_INPUT')
    return this.#command(actor, { capability: 'session:close', command: 'session.close', idempotencyKey: input.idempotencyKey, correlationKey: input.correlationKey, projectId: session.projectId, taskId: session.taskId, payload: { sessionId, status: input.status } }, () => {
      if (this.getSession(sessionId).status !== 'open') throw new PlatformError('Session is already terminal', 'INVALID_TRANSITION')
      this.database.prepare('UPDATE sessions SET status=?,updated_at=? WHERE id=?').run(input.status, now(), sessionId)
      return this.getSession(sessionId)
    })
  }
  listSessions(input: { projectId?: string; taskId?: string; assignmentId?: string; limit?: number } = {}): SessionView[] {
    const clauses: string[] = []; const parameters: SQLInputValue[] = []
    if (input.projectId) { clauses.push('project_id=?'); parameters.push(boundedId(input.projectId, 'projectId')) }
    if (input.taskId) { clauses.push('task_id=?'); parameters.push(boundedId(input.taskId, 'taskId')) }
    if (input.assignmentId) { clauses.push('assignment_id=?'); parameters.push(boundedId(input.assignmentId, 'assignmentId')) }
    parameters.push(integer(input.limit ?? 100, 'limit', 1, MAX_PAGE_SIZE)); const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    return (this.database.prepare(`SELECT * FROM sessions ${where} ORDER BY updated_at DESC LIMIT ?`).all(...parameters) as Record<string, unknown>[]).map(sessionFrom)
  }

  createContextPackage(actor: ActorContext, input: { projectId: string; taskId?: string; ownershipEpoch?: number; tokenBudget?: number; byteBudget: number; items: Array<Omit<ContextItemView, 'ordinal'>>; idempotencyKey: string; correlationKey?: string }): ContextPackageView {
    const projectId = boundedId(input.projectId, 'projectId'); const items = input.items.map((item, ordinal) => ({ sourceDomain: boundedKey(item.sourceDomain, `items[${ordinal}].sourceDomain`), sourceId: boundedId(item.sourceId, `items[${ordinal}].sourceId`), sourceVersion: scalarText(item.sourceVersion, `items[${ordinal}].sourceVersion`, 128), selectionReason: scalarText(item.selectionReason, `items[${ordinal}].selectionReason`, 2_048), contentHash: scalarText(item.contentHash, `items[${ordinal}].contentHash`, 128), sensitivity: item.sensitivity, ordinal }))
    if (items.length > 256) throw new PlatformError('Context package has too many items', 'INVALID_INPUT')
    return this.#command(actor, { capability: 'context:create', command: 'context.create', idempotencyKey: input.idempotencyKey, correlationKey: input.correlationKey, projectId, taskId: input.taskId, ownershipEpoch: input.ownershipEpoch, payload: { itemCount: items.length, tokenBudget: input.tokenBudget, byteBudget: input.byteBudget } }, () => {
      const contextId = newId('context'); const manifestHash = createHash('sha256').update(JSON.stringify(items)).digest('hex'); const createdAt = now()
      this.database.prepare('INSERT INTO context_packages (id,project_id,task_id,ownership_epoch,manifest_hash,token_budget,byte_budget,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(contextId, projectId, input.taskId ?? null, input.ownershipEpoch ?? null, manifestHash, input.tokenBudget ?? null, integer(input.byteBudget, 'byteBudget', 1, 32 * 1024 * 1024), actor.actorKey, createdAt)
      const statement = this.database.prepare('INSERT INTO context_items (context_package_id,ordinal,source_domain,source_id,source_version,selection_reason,content_hash,sensitivity) VALUES (?,?,?,?,?,?,?,?)')
      for (const item of items) statement.run(contextId, item.ordinal, item.sourceDomain, item.sourceId, item.sourceVersion, item.selectionReason, item.contentHash, item.sensitivity)
      return this.getContextPackage(contextId)
    })
  }
  getContextPackage(contextId: string): ContextPackageView {
    const row = this.database.prepare('SELECT * FROM context_packages WHERE id=?').get(boundedId(contextId, 'contextId')) as Record<string, unknown> | undefined
    if (!row) throw new PlatformError('Context package was not found', 'NOT_FOUND')
    const items = (this.database.prepare('SELECT * FROM context_items WHERE context_package_id=? ORDER BY ordinal').all(contextId) as Record<string, unknown>[]).map((item) => ({ sourceDomain: String(item.source_domain), sourceId: String(item.source_id), sourceVersion: String(item.source_version), selectionReason: String(item.selection_reason), contentHash: String(item.content_hash), sensitivity: String(item.sensitivity) as ContextItemView['sensitivity'], ordinal: Number(item.ordinal) }))
    return { id: String(row.id), projectId: String(row.project_id), ...(row.task_id ? { taskId: String(row.task_id) } : {}), ...(row.ownership_epoch !== null && row.ownership_epoch !== undefined ? { ownershipEpoch: Number(row.ownership_epoch) } : {}), manifestHash: String(row.manifest_hash), ...(row.token_budget ? { tokenBudget: Number(row.token_budget) } : {}), byteBudget: Number(row.byte_budget), createdBy: String(row.created_by), createdAt: String(row.created_at), items }
  }

  requestApproval(actor: ActorContext, input: { projectId: string; taskId?: string; kind: string; request: Record<string, unknown>; idempotencyKey: string; correlationKey?: string }): ApprovalView {
    const projectId = boundedId(input.projectId, 'projectId'); const taskId = input.taskId ? boundedId(input.taskId, 'taskId') : undefined; const kind = boundedKey(input.kind, 'kind'); const request = redact(jsonObject(input.request, 'request')) as Record<string, unknown>
    return this.#command(actor, { capability: 'approval:request', command: 'approval.request', idempotencyKey: input.idempotencyKey, correlationKey: input.correlationKey, projectId, taskId, payload: { kind } }, () => {
      this.getProject(projectId); if (taskId && this.getTask(taskId).projectId !== projectId) throw new PlatformError('Approval task is outside the project', 'INVALID_INPUT')
      const id = newId('approval'); const createdAt = now()
      this.database.prepare("INSERT INTO approvals (id,project_id,task_id,kind,status,requested_by,request_json,created_at) VALUES (?,?,?,?,'pending',?,?,?)").run(id, projectId, taskId ?? null, kind, actor.actorKey, JSON.stringify(request), createdAt)
      return this.getApproval(id)
    })
  }
  decideApproval(actor: ActorContext, input: { approvalId: string; decision: 'approved' | 'rejected' | 'cancelled'; reason: string; idempotencyKey: string; correlationKey?: string }): ApprovalView {
    const approvalId = boundedId(input.approvalId, 'approvalId'); const current = this.getApproval(approvalId); const reason = scalarText(input.reason, 'reason', 4_096)
    if (!['approved', 'rejected', 'cancelled'].includes(input.decision)) throw new PlatformError('Approval decision is invalid', 'INVALID_INPUT')
    return this.#command(actor, { capability: 'approval:decide', command: 'approval.decide', idempotencyKey: input.idempotencyKey, correlationKey: input.correlationKey, projectId: current.projectId, taskId: current.taskId, payload: { approvalId, decision: input.decision } }, () => {
      if (this.getApproval(approvalId).status !== 'pending') throw new PlatformError('Approval is already decided', 'INVALID_TRANSITION')
      this.database.prepare('UPDATE approvals SET status=?,decided_by=?,decision_reason=?,decided_at=? WHERE id=?').run(input.decision, actor.actorKey, reason, now(), approvalId)
      return this.getApproval(approvalId)
    })
  }
  getApproval(approvalId: string): ApprovalView {
    const row = this.database.prepare('SELECT * FROM approvals WHERE id=?').get(boundedId(approvalId, 'approvalId')) as Record<string, unknown> | undefined
    if (!row) throw new PlatformError('Approval was not found', 'NOT_FOUND')
    return approvalFrom(row)
  }
  listApprovals(input: { projectId?: string; taskId?: string; status?: ApprovalView['status']; limit?: number } = {}): ApprovalView[] {
    const clauses: string[] = []; const parameters: SQLInputValue[] = []
    if (input.projectId) { clauses.push('project_id=?'); parameters.push(boundedId(input.projectId, 'projectId')) }
    if (input.taskId) { clauses.push('task_id=?'); parameters.push(boundedId(input.taskId, 'taskId')) }
    if (input.status) { clauses.push('status=?'); parameters.push(input.status) }
    parameters.push(integer(input.limit ?? 100, 'limit', 1, MAX_PAGE_SIZE)); const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    return (this.database.prepare(`SELECT * FROM approvals ${where} ORDER BY created_at DESC LIMIT ?`).all(...parameters) as Record<string, unknown>[]).map(approvalFrom)
  }

  createArtifact(actor: ActorContext, input: { projectId: string; taskId?: string; assignmentId?: string; mediaType: string; sensitivity: ArtifactView['sensitivity']; acl: string[]; retentionUntil?: string; data: Uint8Array; idempotencyKey: string; correlationKey?: string }): ArtifactView {
    const projectId = boundedId(input.projectId, 'projectId'); const taskId = input.taskId ? boundedId(input.taskId, 'taskId') : undefined; const assignmentId = input.assignmentId ? boundedId(input.assignmentId, 'assignmentId') : undefined; const mediaType = scalarText(input.mediaType, 'mediaType', 256); const acl = stringArray(input.acl, 'acl'); const retentionUntil = optionalText(input.retentionUntil, 'retentionUntil', 128)
    if (!['public', 'internal', 'confidential', 'restricted'].includes(input.sensitivity)) throw new PlatformError('Artifact sensitivity is invalid', 'INVALID_INPUT')
    if (retentionUntil && Number.isNaN(Date.parse(retentionUntil))) throw new PlatformError('retentionUntil must be an ISO timestamp', 'INVALID_INPUT')
    const data = Buffer.from(input.data); if (data.byteLength > 32 * 1024 * 1024) throw new PlatformError('Artifact is too large', 'INVALID_INPUT'); const objectHash = createHash('sha256').update(data).digest('hex')
    return this.#command(actor, { capability: 'artifact:create', command: 'artifact.create', idempotencyKey: input.idempotencyKey, correlationKey: input.correlationKey, projectId, taskId, payload: { assignmentId, objectHash, mediaType, sizeBytes: data.byteLength, sensitivity: input.sensitivity } }, () => {
      this.getProject(projectId); if (taskId && this.getTask(taskId).projectId !== projectId) throw new PlatformError('Artifact task is outside the project', 'INVALID_INPUT'); if (assignmentId && this.getAssignment(assignmentId).taskId !== taskId) throw new PlatformError('Artifact assignment does not match task', 'INVALID_INPUT')
      this.#writeObject(objectHash, data); const id = newId('artifact'); const createdAt = now()
      this.database.prepare("INSERT INTO artifacts (id,project_id,task_id,assignment_id,object_hash,media_type,size_bytes,sensitivity,acl_json,retention_until,lifecycle,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,'active',?,?)").run(id, projectId, taskId ?? null, assignmentId ?? null, objectHash, mediaType, data.byteLength, input.sensitivity, JSON.stringify(acl), retentionUntil ?? null, actor.actorKey, createdAt)
      return this.getArtifact(id)
    })
  }
  getArtifact(artifactId: string): ArtifactView {
    const row = this.database.prepare('SELECT * FROM artifacts WHERE id=?').get(boundedId(artifactId, 'artifactId')) as Record<string, unknown> | undefined
    if (!row) throw new PlatformError('Artifact was not found', 'NOT_FOUND')
    return artifactFrom(row)
  }
  tombstoneArtifact(actor: ActorContext, input: { artifactId: string; reason: string; idempotencyKey: string; correlationKey?: string }): ArtifactView {
    const artifactId = boundedId(input.artifactId, 'artifactId'); const current = this.getArtifact(artifactId); const reason = scalarText(input.reason, 'reason', 4_096)
    return this.#command(actor, { capability: 'artifact:delete', command: 'artifact.tombstone', idempotencyKey: input.idempotencyKey, correlationKey: input.correlationKey, projectId: current.projectId, taskId: current.taskId, payload: { artifactId, reason } }, () => {
      if (this.getArtifact(artifactId).lifecycle !== 'active') throw new PlatformError('Artifact is already inactive', 'INVALID_TRANSITION')
      this.database.prepare("UPDATE artifacts SET lifecycle='tombstoned' WHERE id=?").run(artifactId)
      return this.getArtifact(artifactId)
    })
  }
  purgeArtifact(actor: ActorContext, input: { artifactId: string; idempotencyKey: string; correlationKey?: string }): ArtifactView {
    const artifactId = boundedId(input.artifactId, 'artifactId'); const current = this.getArtifact(artifactId)
    if (actor.role !== 'system') throw new PlatformError('Only the retention system can purge artifacts', 'FORBIDDEN')
    const result = this.#command(actor, { capability: 'artifact:purge', command: 'artifact.purge', idempotencyKey: input.idempotencyKey, correlationKey: input.correlationKey, projectId: current.projectId, taskId: current.taskId, payload: { artifactId } }, () => {
      const artifact = this.getArtifact(artifactId)
      if (artifact.lifecycle !== 'tombstoned') throw new PlatformError('Only tombstoned artifacts can be purged', 'INVALID_TRANSITION')
      if (artifact.retentionUntil && Date.parse(artifact.retentionUntil) > Date.now()) throw new PlatformError('Artifact retention period has not elapsed', 'RETENTION_ACTIVE')
      this.database.prepare("UPDATE artifacts SET lifecycle='deleted' WHERE id=?").run(artifactId)
      return this.getArtifact(artifactId)
    })
    const activeReference = this.database.prepare("SELECT 1 FROM artifacts WHERE object_hash=? AND lifecycle<>'deleted' LIMIT 1").get(result.objectHash)
    if (!activeReference) rmSync(this.#objectPath(result.objectHash), { force: true })
    return result
  }
  readArtifact(actor: ActorContext, artifactId: string): { artifact: ArtifactView; data: Buffer } {
    this.#authorize(actor, 'artifact:read', false); const artifact = this.getArtifact(artifactId)
    if (artifact.lifecycle !== 'active') throw new PlatformError('Artifact is not active', 'NOT_FOUND')
    if (!artifact.acl.includes('*') && !artifact.acl.includes(actor.actorKey) && !artifact.acl.includes(`role:${actor.role}`)) throw new PlatformError('Artifact ACL denied access', 'FORBIDDEN')
    const data = readFileSync(this.#objectPath(artifact.objectHash)); if (createHash('sha256').update(data).digest('hex') !== artifact.objectHash) throw new PlatformError('Artifact object integrity check failed', 'CORRUPT_OBJECT')
    return { artifact, data }
  }
  listArtifacts(input: { projectId?: string; taskId?: string; assignmentId?: string; limit?: number } = {}): ArtifactView[] {
    const clauses = ["lifecycle='active'"]; const parameters: SQLInputValue[] = []
    if (input.projectId) { clauses.push('project_id=?'); parameters.push(boundedId(input.projectId, 'projectId')) }
    if (input.taskId) { clauses.push('task_id=?'); parameters.push(boundedId(input.taskId, 'taskId')) }
    if (input.assignmentId) { clauses.push('assignment_id=?'); parameters.push(boundedId(input.assignmentId, 'assignmentId')) }
    parameters.push(integer(input.limit ?? 100, 'limit', 1, MAX_PAGE_SIZE))
    return (this.database.prepare(`SELECT * FROM artifacts WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT ?`).all(...parameters) as Record<string, unknown>[]).map(artifactFrom)
  }

  setWorkspaceExpectation(actor: ActorContext, input: { projectId: string; branch?: string; head?: string; cleanRequired: boolean; expectedVersion: number; idempotencyKey: string; correlationKey?: string }): WorkspaceExpectationView {
    const projectId = boundedId(input.projectId, 'projectId'); const branch = optionalText(input.branch, 'branch', 512); const head = optionalText(input.head, 'head', 128); const expectedVersion = integer(input.expectedVersion, 'expectedVersion', 0, Number.MAX_SAFE_INTEGER)
    return this.#command(actor, { capability: 'workspace:expect', command: 'workspace.expectation.set', idempotencyKey: input.idempotencyKey, correlationKey: input.correlationKey, projectId, payload: { branch, head, cleanRequired: input.cleanRequired, expectedVersion } }, () => {
      this.getProject(projectId); const existing = this.getWorkspaceExpectation(projectId)
      if ((existing?.version ?? 0) !== expectedVersion) throw new PlatformError('Workspace expectation version changed', 'VERSION_CONFLICT')
      const version = expectedVersion + 1; const updatedAt = now()
      this.database.prepare('INSERT INTO workspace_expectations (project_id,branch,head,clean_required,version,updated_by,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET branch=excluded.branch,head=excluded.head,clean_required=excluded.clean_required,version=excluded.version,updated_by=excluded.updated_by,updated_at=excluded.updated_at').run(projectId, branch ?? null, head ?? null, input.cleanRequired ? 1 : 0, version, actor.actorKey, updatedAt)
      return { projectId, ...(branch ? { branch } : {}), ...(head ? { head } : {}), cleanRequired: input.cleanRequired, version, updatedBy: actor.actorKey, updatedAt }
    })
  }
  getWorkspaceExpectation(projectId: string): WorkspaceExpectationView | undefined {
    const row = this.database.prepare('SELECT * FROM workspace_expectations WHERE project_id=?').get(boundedId(projectId, 'projectId')) as Record<string, unknown> | undefined
    return row ? { projectId: String(row.project_id), ...(row.branch ? { branch: String(row.branch) } : {}), ...(row.head ? { head: String(row.head) } : {}), cleanRequired: Number(row.clean_required) === 1, version: Number(row.version), updatedBy: String(row.updated_by), updatedAt: String(row.updated_at) } : undefined
  }
  recordWorkspaceObservation(actor: ActorContext, input: { projectId: string; taskId?: string; repositoryRoot: string; worktree: string; branch?: string; head?: string; dirty: boolean; sourceCommand: string; idempotencyKey: string; correlationKey?: string }): WorkspaceObservationView {
    if (actor.role !== 'git_integrator' && actor.role !== 'system') throw new PlatformError('Workspace observations must come from an authorized Git observer', 'FORBIDDEN')
    const projectId = boundedId(input.projectId, 'projectId'); const taskId = input.taskId ? boundedId(input.taskId, 'taskId') : undefined; const repositoryRoot = scalarText(input.repositoryRoot, 'repositoryRoot', 4_096); const worktree = scalarText(input.worktree, 'worktree', 4_096); const branch = optionalText(input.branch, 'branch', 512); const head = optionalText(input.head, 'head', 128); const sourceCommand = scalarText(input.sourceCommand, 'sourceCommand', 2_048)
    return this.#command(actor, { capability: 'workspace:observe', command: 'workspace.observation.record', idempotencyKey: input.idempotencyKey, correlationKey: input.correlationKey, projectId, taskId, payload: { repositoryRoot, worktree, branch, head, dirty: input.dirty } }, () => {
      this.getProject(projectId); const observedAt = now(); const result = this.database.prepare('INSERT INTO workspace_observations (project_id,task_id,repository_root,worktree,branch,head,dirty,source_command,observed_at) VALUES (?,?,?,?,?,?,?,?,?)').run(projectId, taskId ?? null, repositoryRoot, worktree, branch ?? null, head ?? null, input.dirty ? 1 : 0, sourceCommand, observedAt)
      return { id: Number(result.lastInsertRowid), projectId, ...(taskId ? { taskId } : {}), repositoryRoot, worktree, ...(branch ? { branch } : {}), ...(head ? { head } : {}), dirty: input.dirty, sourceCommand, observedAt }
    })
  }
  listWorkspaceObservations(projectId: string, limit = 100): WorkspaceObservationView[] {
    return (this.database.prepare('SELECT * FROM workspace_observations WHERE project_id=? ORDER BY id DESC LIMIT ?').all(boundedId(projectId, 'projectId'), integer(limit, 'limit', 1, MAX_PAGE_SIZE)) as Record<string, unknown>[]).map((row) => ({ id: Number(row.id), projectId: String(row.project_id), ...(row.task_id ? { taskId: String(row.task_id) } : {}), repositoryRoot: String(row.repository_root), worktree: String(row.worktree), ...(row.branch ? { branch: String(row.branch) } : {}), ...(row.head ? { head: String(row.head) } : {}), dirty: Number(row.dirty) === 1, sourceCommand: String(row.source_command), observedAt: String(row.observed_at) }))
  }

  analyticsSnapshot(projectId: string): AnalyticsView {
    const id = boundedId(projectId, 'projectId'); this.getProject(id)
    const grouped = (sql: string, parameter: string): Record<string, number> => Object.fromEntries((this.database.prepare(sql).all(parameter) as Array<{ key: string; count: number }>).map((row) => [row.key, Number(row.count)]))
    const taskStatus = grouped('SELECT status AS key,COUNT(*) AS count FROM tasks WHERE project_id=? GROUP BY status', id)
    const assignmentStatus = grouped("SELECT COALESCE((SELECT e.type FROM assignment_events e WHERE e.assignment_id=a.id ORDER BY e.sequence DESC LIMIT 1),a.status) AS key,COUNT(*) AS count FROM assignments a JOIN tasks t ON t.id=a.task_id WHERE t.project_id=? GROUP BY key", id)
    const sessionStatus = grouped('SELECT status AS key,COUNT(*) AS count FROM sessions WHERE project_id=? GROUP BY status', id)
    const ownerLoad = (this.database.prepare("SELECT owner_key,COUNT(*) AS active_tasks FROM tasks WHERE project_id=? AND status IN ('open','in_progress','blocked','deferred') AND owner_key IS NOT NULL GROUP BY owner_key ORDER BY active_tasks DESC,owner_key").all(id) as Array<{ owner_key: string; active_tasks: number }>).map((row) => ({ ownerKey: row.owner_key, activeTasks: Number(row.active_tasks) }))
    return { projectId: id, taskStatus, ownerLoad, assignmentStatus, sessionStatus, generatedAt: now() }
  }

  createBackup(destinationRoot: string): string {
    const root = resolvePlatformDataRoot(destinationRoot); const target = join(root, `platform-backup-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}.sqlite`)
    this.database.prepare('VACUUM INTO ?').run(target)
    return target
  }

  getTask(taskId: string): TaskView {
    const row = this.database.prepare('SELECT * FROM tasks WHERE id=?').get(boundedId(taskId, 'taskId')) as Record<string, unknown> | undefined
    if (!row) throw new PlatformError('Task was not found', 'NOT_FOUND')
    return taskFrom(row)
  }
  listTasks(input: { projectId?: string; status?: TaskStatus; ownerKey?: string; query?: string; limit?: number } = {}): TaskView[] {
    const clauses: string[] = []; const parameters: SQLInputValue[] = []
    if (input.projectId) { clauses.push('project_id=?'); parameters.push(boundedId(input.projectId, 'projectId')) }
    if (input.status) { clauses.push('status=?'); parameters.push(input.status) }
    if (input.ownerKey) { clauses.push('owner_key=?'); parameters.push(boundedId(input.ownerKey, 'ownerKey')) }
    if (input.query) { clauses.push("(title LIKE ? ESCAPE '\\' OR goal LIKE ? ESCAPE '\\')"); const query = `%${input.query.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`; parameters.push(query, query) }
    parameters.push(integer(input.limit ?? 100, 'limit', 1, MAX_PAGE_SIZE)); const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    return (this.database.prepare(`SELECT * FROM tasks ${where} ORDER BY priority,updated_at DESC LIMIT ?`).all(...parameters) as Record<string, unknown>[]).map(taskFrom)
  }
  listTaskEvents(taskId: string, limit = 200): TaskEventView[] {
    return (this.database.prepare('SELECT * FROM task_events WHERE task_id=? ORDER BY id DESC LIMIT ?').all(boundedId(taskId, 'taskId'), integer(limit, 'limit', 1, MAX_PAGE_SIZE)) as Record<string, unknown>[]).map((row) => ({ id: Number(row.id), taskId: String(row.task_id), type: String(row.type), actorKey: String(row.actor_key), ...(row.ownership_epoch !== null && row.ownership_epoch !== undefined ? { ownershipEpoch: Number(row.ownership_epoch) } : {}), payload: parseJson(row.payload_json, {}), occurredAt: String(row.occurred_at) }))
  }
  createTaskRecoveryContext(actor: ActorContext, input: { taskId: string; tokenBudget?: number; byteBudget: number; idempotencyKey: string; correlationKey?: string }): ContextPackageView {
    const task = this.getTask(input.taskId); const items: Array<Omit<ContextItemView, 'ordinal'>> = []
    const add = (sourceDomain: string, sourceId: string, sourceVersion: string, selectionReason: string, value: unknown, sensitivity: ContextItemView['sensitivity'] = 'internal') => items.push({ sourceDomain, sourceId, sourceVersion, selectionReason, contentHash: createHash('sha256').update(JSON.stringify(value)).digest('hex'), sensitivity })
    add('task', task.id, String(task.version), 'Current authoritative task and Owner epoch', task)
    for (const event of this.listTaskEvents(task.id, 32).reverse()) add('task-event', String(event.id), String(event.id), 'Recent observable task transition', event)
    for (const assignment of this.listAssignments({ taskId: task.id, limit: 32 })) add('assignment', assignment.id, assignment.status, 'Persisted stage contract and latest lifecycle state', assignment)
    for (const session of this.listSessions({ taskId: task.id, limit: 16 })) {
      const events = this.listSessionEvents(session.id, 32); add('session', session.id, session.updatedAt, 'Observable session timeline', { session, events })
    }
    for (const artifact of this.listArtifacts({ taskId: task.id, limit: 32 })) add('artifact', artifact.id, artifact.objectHash, 'Task artifact metadata and content identity', artifact, artifact.sensitivity)
    const observation = this.listWorkspaceObservations(task.projectId, 1)[0]; if (observation) add('workspace-observation', String(observation.id), observation.observedAt, 'Latest actual Git and worktree observation', observation)
    const expectation = this.getWorkspaceExpectation(task.projectId); if (expectation) add('workspace-expectation', task.projectId, String(expectation.version), 'Current expected Git state', expectation)
    return this.createContextPackage(actor, { projectId: task.projectId, taskId: task.id, ownershipEpoch: task.ownershipEpoch || undefined, tokenBudget: input.tokenBudget, byteBudget: input.byteBudget, items, idempotencyKey: input.idempotencyKey, correlationKey: input.correlationKey })
  }

  getSession(sessionId: string): SessionView {
    const row = this.database.prepare('SELECT * FROM sessions WHERE id=?').get(boundedId(sessionId, 'sessionId')) as Record<string, unknown> | undefined
    if (!row) throw new PlatformError('Session was not found', 'NOT_FOUND')
    return sessionFrom(row)
  }
  listAudit(input: { projectId?: string; taskId?: string; limit?: number } = {}): AuditView[] {
    const clauses: string[] = []; const parameters: SQLInputValue[] = []
    if (input.projectId) { clauses.push('project_id=?'); parameters.push(boundedId(input.projectId, 'projectId')) }
    if (input.taskId) { clauses.push('task_id=?'); parameters.push(boundedId(input.taskId, 'taskId')) }
    parameters.push(integer(input.limit ?? 100, 'limit', 1, MAX_PAGE_SIZE)); const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    return (this.database.prepare(`SELECT * FROM audit_events ${where} ORDER BY id DESC LIMIT ?`).all(...parameters) as Record<string, unknown>[]).map((row) => ({ id: Number(row.id), occurredAt: String(row.occurred_at), actorKey: String(row.actor_key), role: String(row.role) as ActorRole, client: String(row.client), capability: String(row.capability), ...(row.project_id ? { projectId: String(row.project_id) } : {}), ...(row.task_id ? { taskId: String(row.task_id) } : {}), ...(row.ownership_epoch !== null && row.ownership_epoch !== undefined ? { ownershipEpoch: Number(row.ownership_epoch) } : {}), command: String(row.command), decision: String(row.decision) as AuditView['decision'], ...(row.reason ? { reason: String(row.reason) } : {}), ...(row.idempotency_key ? { idempotencyKey: String(row.idempotency_key) } : {}), ...(row.correlation_key ? { correlationKey: String(row.correlation_key) } : {}), payload: parseJson(row.payload_json, {}) }))
  }

  #objectPath(hash: string): string {
    if (!/^[a-f0-9]{64}$/u.test(hash)) throw new PlatformError('Object hash is invalid', 'INVALID_INPUT')
    return join(this.objectRoot, hash.slice(0, 2), hash.slice(2))
  }
  #writeObject(hash: string, data: Buffer): void {
    const target = this.#objectPath(hash); const shard = dirname(target); mkdirSync(shard, { recursive: true, mode: 0o700 })
    const shardInfo = lstatSync(shard)
    if (shardInfo.isSymbolicLink() || !shardInfo.isDirectory() || !pathInside(this.objectRoot, realpathSync(shard))) throw new PlatformError('Artifact object shard is unsafe', 'UNSAFE_OBJECT')
    if (existsSync(target)) {
      const info = lstatSync(target); if (info.isSymbolicLink() || !info.isFile()) throw new PlatformError('Artifact object path is unsafe', 'UNSAFE_OBJECT')
      if (createHash('sha256').update(readFileSync(target)).digest('hex') !== hash) throw new PlatformError('Artifact object hash collision', 'CORRUPT_OBJECT')
      return
    }
    const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`
    try { writeFileSync(temporary, data, { flag: 'wx', mode: 0o600 }); renameSync(temporary, target) } finally { rmSync(temporary, { force: true }) }
  }

  #ensureOwner(ownerKey: string, displayName: string): void {
    const timestamp = now(); this.database.prepare("INSERT INTO owners (owner_key,display_name,kind,active,created_at,updated_at) VALUES (?,?,'logical-ai',1,?,?) ON CONFLICT(owner_key) DO UPDATE SET display_name=excluded.display_name,active=1,updated_at=excluded.updated_at").run(ownerKey, scalarText(displayName, 'ownerDisplayName', 256), timestamp, timestamp)
  }
  #assertCurrentOwner(actor: ActorContext, task: TaskView, expectedEpoch: number): void {
    const epoch = integer(expectedEpoch, 'expectedOwnershipEpoch', 1, Number.MAX_SAFE_INTEGER)
    if (task.ownershipEpoch !== epoch) throw new PlatformError('Ownership epoch changed', 'OWNERSHIP_CONFLICT')
    if (actor.role !== 'human' && actor.role !== 'system' && (actor.role !== 'task_owner' || actor.actorKey !== task.ownerKey)) throw new PlatformError('Only the current logical Owner can perform this command', 'NOT_CURRENT_OWNER')
  }
  #taskEvent(taskId: string, type: string, actor: ActorContext, ownershipEpoch: number | undefined, payload: Record<string, unknown>): void {
    this.database.prepare('INSERT INTO task_events (task_id,type,actor_key,ownership_epoch,payload_json,occurred_at) VALUES (?,?,?,?,?,?)').run(taskId, type, actor.actorKey, ownershipEpoch ?? null, JSON.stringify(redact(payload)), now())
  }
}
