# Repository instructions

- Read `docs/product-direction.md` before planning product features. Treat its
  product scope and roadmap as the source of truth.
- Keep this repository independent from DeepSeek Harness Core.
- Implement product behavior as a Cordis/DSH plugin whenever an extension point exists.
- Pin every `@deepseek-ai/dsh*` dependency to an exact version.
- Never add an upstream patch without documenting its issue, introduction version,
  owner, and removal condition in `patches/README.md`.
- Preserve Electron's security baseline: `contextIsolation: true`,
  `nodeIntegration: false`, `sandbox: true`, and `webSecurity: true`.
- Run `pnpm check` before committing code changes.
- Never commit API keys, OAuth credentials, tokens, or generated user profiles.
