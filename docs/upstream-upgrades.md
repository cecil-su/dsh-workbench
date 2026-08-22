# Upstream upgrade procedure

DeepSeek Harness is a developer preview. Every version change is treated as a
compatibility migration, even when SemVer appears compatible.

1. Create a dedicated `chore/dsh-<version>` branch.
2. Update the catalog entry in `pnpm-workspace.yaml` and `upstream/version.json`.
3. Regenerate `pnpm-lock.yaml` with `pnpm install`.
4. Run `pnpm check` and `pnpm build`.
5. Smoke-test desktop startup, shutdown, sessions, models, credentials, and
   authorization.
6. Revalidate every file under `patches/`; delete patches covered upstream.
7. Record breaking contract changes in the pull request.

Do not combine an upstream migration with unrelated product features.
