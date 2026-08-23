# OAuth UI

This first-party Cordis/DSH plugin presents the pinned DSH authorization seam
inside **Settings > Sign-in & authorization**.

The Host half joins `ctx.authorization.list()` with value-free
`ctx.credentials.describeRecord()` facts, relays the official interaction
vocabulary (`notify`, `text`, `secret`, and `select`), and delegates each login
to `ctx.authorization.begin()`. Signing out calls the official
`ctx.credentials.deleteRecord()` operation.

The plugin does not implement provider OAuth, inspect grant payloads, persist
tokens, or refresh credentials. Its loopback endpoint accepts only same-origin
JSON POST requests with a closed command schema and a bounded body. Read
responses contain status and record metadata only; prompt answers travel only
from the active UI to the official flow and are never logged or returned.

See [Authorization ownership and acceptance](../../docs/authorization.md).
