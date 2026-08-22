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
apps/desktop -> packages/runtime -> @deepseek-ai/dsh
plugins/* -----------------------> @deepseek-ai/cordis
```

Upstream packages never import Workbench packages. Product plugins may depend
on published DSH contracts, but the Electron renderer never receives Node.js
access.

## Initial milestone

The first milestone is deliberately narrow:

1. Start the pinned DSH Web host as a supervised child process.
2. Wait until the loopback HTTP endpoint is ready.
3. Load it in a sandboxed `BrowserWindow`.
4. Shut down the child process with the application.

Packaging, auto-update, profiles, tray integration, and OAuth UI follow only
after this lifecycle is reliable.
