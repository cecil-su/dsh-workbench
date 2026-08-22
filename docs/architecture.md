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

## Initial milestone

The first milestone is deliberately narrow:

1. Start the pinned DSH Web host as a supervised child process.
2. Wait for the versioned desktop-ready message and verify the loopback UI.
3. Load it in a sandboxed `BrowserWindow`.
4. Shut down the child process with the application.

Packaging, auto-update, profiles, tray integration, and OAuth UI follow only
after this lifecycle is reliable.
