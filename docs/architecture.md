# Architecture

## Ownership boundaries

| Layer | Owns | Must not own |
| --- | --- | --- |
| Electron host | windows, tray, updater, native dialogs, process lifecycle | agent logic or provider auth |
| Runtime | exact DSH executable, lifecycle, readiness, shutdown | DSH service implementations |
| DSH/Cordis plugins | product features and extension services | Electron renderer privileges |
| Upstream DSH | agents, sessions, tools, credentials, authorization | product-specific desktop policy |

## Dependency direction

```text
apps/desktop -> packages/runtime      -> @deepseek-ai/dsh
             -> plugins/desktop-core -> @deepseek-ai/cordis
             -> plugins/oauth-ui     -> public DSH authorization contracts
             -> plugins/diagnostics-ui -> official plugin inventory Remote
```

Upstream packages never import Workbench packages. Product plugins may depend
on published DSH contracts, but the Electron renderer never receives Node.js
access.

The desktop host resolves first-party plugin entries from its own packaged
dependencies, writes a concrete Workbench-owned JSON overlay under Electron's
`userData`, and passes it to the pinned DSH process with `--patch`. This keeps
first-party composition deterministic without installing packages into, or
rewriting, the user's DSH profile.

The host explicitly binds DSH to `127.0.0.1` with port `0`. After the complete
Loader tree settles, `desktop-core` reports the OS-assigned URL over a versioned
Node IPC message. The Runtime validates the loopback URL and the rendered DSH
boot payload before Electron navigates. Shutdown travels back over the same IPC
channel so DSH can dispose its Cordis tree before process-level termination is
used as a fallback.

## Foundation milestones

The first milestone is deliberately narrow:

1. Start the pinned DSH Web host as a supervised child process.
2. Wait for the versioned desktop-ready message and verify the loopback UI.
3. Load it in a sandboxed `BrowserWindow`.
4. Shut down the child process with the application.

The next foundation milestone packages a self-contained production dependency
closure and verifies a copied application outside the checkout. DSH and
first-party plugin entries remain ordinary files under `resources/app` because
the runtime spawns DSH directly and DSH may link its dependency closure into an
isolated profile. The packaged Electron binary therefore keeps its RunAsNode
fuse while disabling Node option and inspector injection.

Profile storage and switching build on that package boundary. The host owns the
registry, runtime transition, and Electron session partition; DSH continues to
own settings and credentials under the selected `DSH_HOME`, while the
`desktop-core` plugin contributes the Profiles settings surface. See
[Workbench profiles](profiles.md) for the storage, migration, recovery, and
credential boundaries.

Official authorization builds on the profile boundary. The `oauth-ui` plugin
renders DSH's neutral interaction vocabulary and delegates storage to the
active profile's official credential provider; see [Authorization](authorization.md).

Diagnostics build on the same profile generation boundary. The
`diagnostics-ui` plugin reads plugin state only from DSH's official inventory
Remote, while the host exposes a closed preload API for a sanitized in-memory
log and three fixed recovery actions. Runtime/window replacement remains owned
by the main-process transition coordinator; see
[Diagnostics and repair](diagnostics.md).

Cross-platform release qualification builds on the packaged smoke boundary.
The compatibility lock binds the pinned DSH, Electron toolchain, first-party
overlay, and package checks to one semantic identity. Each native package adds
clean-source and lockfile provenance, and the release workflow accepts the
candidate only after the Linux, macOS, and Windows identities and evidence sets
match; see [Release qualification](release-qualification.md).

Signing, auto-update, and native lifecycle integration follow only after the
runtime, profiles, authorization, and cross-platform package acceptance are
reliable.
