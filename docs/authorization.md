# Authorization

## Ownership

Workbench provides the desktop surface; the pinned DSH release owns the
authorization protocol and credential persistence.

```text
Settings UI
  -> @dsh-workbench/oauth-ui loopback bridge
  -> ctx.authorization
  -> provider flow such as llm-pi-ai/openai-codex
  -> ctx.credentials in the active profile DSH_HOME
```

`oauth-ui` renders the official flow directory, progress notices, external
browser links, verification codes, and `text`/`secret`/`select` prompts. A
successful flow writes its own record through `ctx.credentials`; Workbench does
not receive a token to copy or save. Sign-out deletes the local record through
that same service. In the pinned DSH release this does not revoke the grant at
the issuer.

Each Workbench profile has a separate `DSH_HOME`, so its stored authorization
records remain profile-scoped. Switching profiles also replaces the DSH process
and browser partition as documented in [Workbench profiles](profiles.md).

## Wire boundary

The plugin registers one exact route at `/workbench/authorization` on the
loopback-only DSH Web server. It requires:

- the exact `127.0.0.1:<active-port>` Host and Origin;
- same-origin Fetch Metadata when the header is present;
- `POST` with `application/json`;
- a closed action schema and a 64 KiB request limit;
- opaque UUIDs for live attempts and prompts.

Read operations expose only credential keys, provider labels, method labels,
configured state, record kind, writability, and in-flight state. Credential
values and grant payloads are never returned, logged, sent through Electron
IPC, or written to the package-smoke report. Unexpected provider failures are
replaced with a generic public error so an unsafe error message cannot leak a
credential.

An authorization attempt belongs to the page that started it. Closing or
reloading that page aborts the held request and cancels the official flow; the
pinned DSH authorization service does not support resuming an attempt.

## Acceptance

The automated gates cover:

- closed request parsing, same-origin trust checks, cancellation, prompt
  answers, sign-out, and failure redaction;
- a fake official flow proving secret answers never appear in read responses;
- a real DSH process proving the `openai-codex` OAuth flow is registered;
- a packaged app proving the client bundle and settings section load, the
  official flow is visible, and its snapshot is value-free.

Interactive provider login is intentionally not automated because it requires
a human account and an external authorization session.
