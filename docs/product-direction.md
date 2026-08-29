# Product direction

## Purpose

DSH Workbench is an independent, local-first AI multi-agent task-management
platform. It combines a secure desktop host with a durable control plane for
projects, documents, task graphs, ownership, assignments, observable sessions,
artifacts, context recovery, and audit.

The platform exists so work can continue safely across projects, branches,
models, agents, context windows, compaction, crashes, and ownership transfers
without treating one process or one model conversation as durable truth.

## Users and runtimes

The platform serves:

- people using the Web panel or Codex/Pi conversations;
- Registry Manager and Task Intake agents that prepare confirmable task drafts;
- one logical Task Owner AI for each active task;
- bounded Stage Agents such as Scout, Writer, Reviewer, and Test Agent;
- a separately authorized Git Integrator;
- read-only Process Analysts;
- Workflow Optimizers that produce proposals and evaluations, not production
  mutations.

Web, Codex, Pi, and background runtimes call the same application service. They
must not maintain independent task state or write the platform database
 directly.

## Product pillars

### Durable platform authority

Workbench owns one platform data domain, separate from DSH profiles and managed
repositories. The platform database is authoritative for project records,
platform documents and versions, tasks, ownership epochs, assignments,
workflows, approvals, and audit. An append-only ledger is authoritative for the
observable parts of AI sessions.

### Controlled multi-agent execution

Every active task has one stable logical Owner key and monotonically increasing
ownership epoch. An Owner persists an immutable stage assignment before a
Dispatcher starts or associates a runtime. Stage Agents report events and
artifacts; only the current Owner may request task transitions after verifying
those reports and the live project state.

Session, pane, process, and model identifiers are volatile runtime facts. They
never become long-lived Owner identity.

### Recoverable, sourced context

A new or resumed runtime receives a bounded context package generated from
current task state, versioned platform documents, decisions, checkpoints,
relevant session evidence, and live repository observations. Every included
item records its source and version. Historical messages, summaries, completion
scores, and agent claims are evidence or derived views and cannot overwrite
current task truth.

### Shared interfaces and complete audit

The Web UI, MCP server, Pi adapter, and background Agent Runtime use the same
domain commands and queries. Authorization is evaluated by user, role, project,
task, ownership epoch, and capability. Accepted and rejected mutations enter a
common audit/event stream and can be synchronized to other clients.

### Observable and improvable workflows

Prompt, Workflow, model, capability, tool, and context versions accompany every
assignment and session. The platform records queue, execution, external block,
user wait, review, rework, and recovery time separately, together with test,
review, reopen, intervention, token, and tool-call evidence. Quality is
presented by acceptance dimension, never collapsed into one authoritative
percentage.

Workflow optimizations require offline replay or evaluation, independent review,
controlled rollout, and verifiable rollback.

### Secure, distributable desktop foundation

The Electron host continues to own DSH startup, readiness, restart, shutdown,
logs, profile isolation, official authorization, and packaging. Product
behavior uses Cordis/DSH plugins and public interfaces where possible. Renderer
sandboxing, context isolation, Web security, least privilege, secret filtering,
and fixed-scope tools remain mandatory.

## Authority boundaries

| Fact domain | Authority |
| --- | --- |
| Platform project records and platform-native documents | Platform database and document versions |
| Tasks, owners, statuses, assignments, workflows, approvals, and audit | Platform database |
| Observable AI conversations and runtime events | Append-only session event ledger |
| Business source code and actual Git state | Managed project filesystem and Git |
| Business runtime data | The managed project's own databases and services |
| Project-native documents | Managed project; platform stores an explicit link, import snapshot, or export relationship |
| Code graphs, summaries, boards, scores, and metrics | Rebuildable derived data |
| Large tool output and binary artifacts | Platform-controlled object storage, identified and governed by database records |

No logical document may have two writable authoritative copies without an
explicit relationship. Managed repositories, their Git histories, and business
databases are not copied into the platform authority.

## Core safety rules

1. Deny by default and grant the minimum capability.
2. Make domain writes transactional, idempotent, audited, and concurrency-safe.
3. Require human confirmation points for task creation, Owner assignment, and
   critical acceptance by default.
4. Never let events, agent self-reports, metrics, or optimizer output
   automatically commit Git, close tasks, or elevate privileges.
5. Give Git lifecycle operations only to the separately authorized Git
   Integrator.
6. Do not expose arbitrary SQL, shell, filesystem, or provider credentials to AI
   interfaces.
7. Filter sensitive values on ingestion, display, retrieval, export, and model
   context paths.
8. Keep the active platform database on one native filesystem boundary; do not
   share it across unreliable Windows/WSL locking boundaries.
9. Test schema migration, backup, restore, idempotency, concurrent claims,
   retention, export, and deletion as product behavior.
10. Treat hidden model reasoning as unavailable unless a provider explicitly
    exposes a permitted observable representation.

## Product surfaces

The Web application must provide project overview, task board and dependency
graph, Owner/stage/blocker/next-action views, platform documents and versions,
session and subagent timelines, expected-versus-actual Git state, approvals and
ownership transfer, Prompt/Workflow versions, quality/time/cost evidence, and
optimization proposals.

Codex should integrate primarily through a platform MCP server. Pi uses a
separate package or extension over the same application API. Domain interfaces
cover project, document, task, owner, assignment, session, event, context,
workspace, artifact, approval, and audit operations.

## Delivery sequence

1. Establish platform storage, migrations, domain commands, audit, and backup.
2. Add projects, versioned documents, task graphs, ownership epochs, and
   confirmation flows.
3. Add immutable assignments, runtime dispatch contracts, session ledger, and
   context packages.
4. Expose the shared Web and AI application interfaces with authorization and
   real-time events.
5. Add live workspace/Git observations and separately authorized integration.
6. Add process analytics, offline evaluation, rollout, and rollback controls.
7. Qualify Windows x64, Linux x64, and macOS arm64 packages and recovery paths.

## Success criteria

The direction succeeds when a clean installation can create and recover durable
platform work; every active task has one enforceable logical Owner; new runtimes
receive sourced context without changing task truth; all clients observe the
same audited state; stage and Git capabilities remain bounded; session evidence
is replayable and governed; workflows can be compared without self-modifying
production; and packaged builds pass migration, backup, security, runtime, and
shutdown acceptance tests.
