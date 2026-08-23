# DSH Workbench

[中文](README.zh.md)

A plugin-first desktop workbench for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

DSH Workbench keeps the upstream harness replaceable. The Electron application
owns native desktop lifecycle and security, product features live in Cordis/DSH
plugins, and upstream packages are pinned to exact versions.

> Status: early scaffold. DeepSeek Harness is a developer preview and may ship
> compatibility-breaking changes.

See [Product direction](docs/product-direction.md) for the long-term scope,
product pillars, and roadmap horizons.

## Architecture

```text
Electron desktop host
        |
        +-- @dsh-workbench/runtime
        |       `-- @deepseek-ai/dsh@0.1.1-rc.2
        |
        +-- DSH Web UI (localhost only)
        |
        `-- product plugins
                +-- desktop-core
                `-- oauth-ui (planned)
```

The project does not fork or modify DSH Core. Any temporary upstream patch must
be documented under `patches/` with an issue, affected version, and removal
condition.

## Requirements

- Node.js `^22.19.0 || >=24.0.0`
- pnpm `11.7.0`
- macOS, Windows, or Linux with Electron support

## Development

```sh
pnpm install
pnpm check
pnpm dev
```

`pnpm dev` builds the local packages, starts the DSH Web host on an OS-assigned
loopback port, verifies the complete Web UI, and loads it inside a sandboxed
Electron window. DSH user data is isolated under Electron's application
`userData` directory. The desktop host also applies the Workbench-owned
`desktop-core` overlay without modifying the user's DSH profile.

The Settings > Profiles surface creates and switches isolated DSH homes,
workspaces, and persistent browser partitions. See
[Workbench profiles](docs/profiles.md) for migration, recovery, and credential
ownership details.

Run `pnpm test:integration` to exercise the real DSH process, dynamic port,
Workbench overlay, Web payload, and graceful IPC shutdown.

Run `pnpm package:dir && pnpm test:package` to build a self-contained application
and exercise a copy outside the checkout with isolated state. Use
`pnpm package:artifacts` for the current platform's unsigned CI distribution
formats and checksums. See [Packaging and release acceptance](docs/packaging.md)
for the artifact matrix, smoke guarantees, and signing boundary.

## Repository layout

```text
apps/desktop/          Electron main and preload processes
packages/runtime/      DSH child-process lifecycle and readiness checks
plugins/desktop-core/  First-party Cordis plugin entrypoint
plugins/oauth-ui/      Planned ChatGPT/Codex authorization UI
docs/                  Architecture and maintenance decisions
patches/               Exceptional, temporary upstream patches only
upstream/              Exact upstream version metadata
```

## Project principles

1. Prefer a DSH/Cordis plugin over a Core modification.
2. Pin every DSH package to an exact version.
3. Treat patches as temporary compatibility bridges.
4. Keep Electron's renderer sandboxed with Node integration disabled.
5. Upgrade upstream through a dedicated compatibility pull request.

## License

No license has been selected yet. Copyright remains with the contributors until
a license is added.
