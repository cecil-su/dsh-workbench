# AI task platform architecture

## Scope

The task platform is a Workbench-owned control plane, independent from managed
repositories and their documents. The latest product requirements and
`product-direction.md` define its contract.

## Process and storage topology

```text
Electron desktop host
  └─ supervised DSH Host
       └─ @dsh-workbench/task-platform application service
            ├─ platform.sqlite
            ├─ objects/sha256/...
            ├─ Web JSON boundary
            ├─ DSH domain tools
            └─ event subscribers

Web task panel ─┐
Codex MCP ──────┼── application commands/queries only
Pi adapter ─────┤
Agent runtime ──┘
```

Workbench stores platform data under one application-level directory, separate
from every DSH Profile and managed repository. Only the application service
opens the database. Profile switching may restart the service process but does
not change platform identity or storage.

External adapters discover and authenticate to an application endpoint; they do
not load SQLite or reuse renderer HTTP privileges. The renderer remains
sandboxed and uses only an exact-origin Host route.

## Storage layout

```text
<Workbench userData>/task-platform/
├── platform.sqlite
├── platform.sqlite-wal
├── objects/
│   └── sha256/<prefix>/<digest>
├── backups/
└── endpoint.json            # bounded discovery metadata, never database access
```

The directory must resolve to a native local filesystem. Startup rejects unsafe
links and known cross-boundary Windows/WSL locations. SQLite uses WAL, foreign
keys, a bounded busy timeout, explicit transactions, and numbered migrations.
Only database records give an object identity, hash, media type, ACL, retention,
and lifecycle.

## Authoritative model

### Projects and documents

`projects` records platform identity and the canonical managed workspace
location. `documents` gives one logical document an authority kind:

- `platform`: writable platform-native document;
- `project-link`: read-only link to a project-native document;
- `import-snapshot`: immutable imported project version;
- `export-copy`: generated copy with an explicit source version.

`document_versions` is append-only. A relationship always identifies both the
logical document and source version; no undeclared writable twin is allowed.

### Tasks, dependencies, and ownership

`tasks` stores goal, parent, status, priority, risk, blocker, recovery condition,
next action, optimistic version, owner key, and ownership epoch.

New intake is a `draft`. Confirmation and initial Owner assignment occur in one
transaction. Active statuses require an Owner. Ownership transfer increments the
epoch; a command from an old epoch is rejected even if an obsolete process is
still running.

`task_dependencies` is a typed directed graph. The application service rejects
self-dependencies and cycles for blocking and parent relationships.

### Workflows and assignments

`workflow_versions` and `prompt_versions` are immutable. An `assignment` fixes:

- task and ownership epoch;
- stage and role;
- Prompt and Workflow versions;
- context package;
- capability set and source scope;
- required artifacts, acceptance, and stop conditions.

The Owner commits the assignment before dispatch. Assignment rows cannot be
updated or deleted. Stage Agents append reports and events; they cannot directly
transition or close the task.

### Sessions and context

`sessions` records task, project, role, client, model, Prompt, Workflow, context,
parent/continuation relationship, and volatile runtime association.

`session_events` is append-only and stores only observable messages, tool
calls/results, child-agent links, compaction, checkpoint, errors, and recovery.
Provider-hidden reasoning is outside the model.

`context_packages` are immutable manifests. Their items identify source domain,
source record/version, selection reason, hash, sensitivity class, and token/size
budget. Context generation uses current authoritative records plus selected
historical evidence and live observations; it never promotes evidence into task
truth.

### Events, approvals, and audit

Domain state changes append `task_events` and `audit_events` in the same
transaction. Audit records actor, role, client, capability, project, task,
ownership epoch, command, decision, idempotency key, correlation, and a bounded
redacted payload.

Sensitive command input is filtered before persistence. Rejected authorization,
epoch, and transition attempts are audited without storing secret values.

`approvals` represents human confirmation for task creation, Owner assignment,
critical acceptance, Git operations, capability grants, and risk handling.
Events and agent reports cannot approve themselves.

## Application service

All mutations enter typed commands with:

- actor and role;
- project/task scope;
- capability;
- expected task version and ownership epoch where applicable;
- idempotency and correlation keys;
- bounded scalar payload.

The command pipeline is:

1. parse and bound input;
2. authenticate actor and client;
3. authorize role, scope, capability, task, and epoch;
4. resolve idempotency receipt;
5. execute one database transaction;
6. append domain event and audit record;
7. store the receipt;
8. publish a redacted real-time notification after commit.

Queries use explicit projections. No client receives live database, Cordis,
filesystem, Git, Session, or process objects.

## Git boundary

The platform stores intended branch, HEAD, and cleanliness in versioned
`workspace_expectations`. Actual repository root, worktree, branch, HEAD, and
dirty state are captured in append-only `workspace_observations`. Actual values
are derived only by the Host through fixed, read-only Git commands against the
project's validated repository path; clients cannot submit claimed Git state.

Only the Git Integrator role can request modifying branch, worktree, commit,
merge, or push commands, and every such operation requires an explicit
capability and applicable approval. Reports, metrics, task completion, or optimizer output never trigger
Git automatically.

## Interfaces

### Web

The Web client exposes a dedicated **Task platform** launcher in the primary
sidebar footer. It opens a full-frame control center instead of hiding operational
work inside Settings. A persistent project/task rail and focused Overview,
Execution, Evidence, and Governance tabs provide task detail, ownership, stages,
blockers, unique next action, document versions, session timelines,
expected/actual workspace state, approvals, audit, and workflow analysis. Large
content is represented by artifact metadata and fetched only with permission.

### AI

Domain tools cover projects, documents, tasks, owners, assignments, sessions,
events, contexts, workspaces, artifacts, approvals, and audit. Tools expose no
arbitrary SQL, shell, or filesystem access.

Codex and Pi model runtimes consume the same DSH domain tools today. A future
external MCP adapter and any standalone Pi extension must remain thin adapters
over the application service; they may not open the database directly. All
adapters share authorization rules, idempotency receipts, and audit events.

## Security and governance

- Default deny; grants are explicit and scoped.
- Secrets are filtered before database, UI, retrieval, context, and export.
- Session and artifact access has sensitivity, ACL, retention, deletion, and
  export policy.
- Object writes are content-addressed and verified before database commit.
- Database backups use SQLite's consistent `VACUUM INTO` mechanism. A release
  that exports complete platform state must additionally emit an object manifest
  and validate schema, hashes, and destination safety during restore.
- Migrations are monotonic and transactional where SQLite permits.
- Deletion uses policy-aware tombstones plus scheduled physical cleanup where
  audit or legal retention does not apply.
- Analytics and optimizer roles are read-only against production truth.

## Initial implementation boundary

The current vertical slice establishes schema migrations and backup creation;
project and platform-document versions; task drafts/confirmation and dependency
graphs; ownership epochs; immutable Prompt, Workflow, and Assignment records;
append-only assignment/session events; persisted approvals; sourced context
manifests; content-addressed artifacts with ACL checks; Git expected/observed
views; redacted audit; Web projections; and DSH domain tools. External MCP,
automatic runtime dispatch, complete export/restore and retention jobs, advanced
analytics, and authorized Git Integrator execution build on those contracts
without changing their authority boundaries.
