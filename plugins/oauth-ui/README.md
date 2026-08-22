# OAuth UI

This directory owns the planned Web controls for DSH authorization flows,
including `openai-codex` / “Sign in with ChatGPT”.

Implementation starts only after confirming the public Web wire contract in the
pinned DSH release. It must call the official authorization service and must not
reimplement provider OAuth, refresh-token handling, or credential persistence.
