# ChatGPT Codex web search and image generation

`@dsh-workbench/gpt-tools` is an optional plugin for agents whose provider route
is exactly `openai-codex`. Workbench packages it for explicit profile
configuration but does not load it by default because it depends on private
ChatGPT Codex capability endpoints that have no third-party compatibility
contract.

The plugin registers two agent tools:

- `web_search` sends one bounded structured request to the Codex standalone
  search endpoint and returns its findings plus deduplicated source URLs.
- `generate_image` calls the Codex Images endpoint and stores the returned PNG
  through DSH's durable attachment service. Its client tool view resolves that
  same session-authorized reference into a clickable conversation preview; no
  second copy, provider URL, or base64 payload is persisted in the session.

Neither tool implementation reads an OAuth grant or accepts an API key. The
patched `@deepseek-ai/dsh-llm-pi-ai` provider owns the narrow `ctx.piAiCodex`
capability: it resolves and refreshes the existing `llm-pi-ai/openai-codex`
credential under the credential-store lock, derives account routing, performs
only the fixed search and image operations, and returns token-free results. The
injected capability is frozen, exposes only `search()` and `generateImage()`,
and retains no Cordis context. OAuth-bearing requests are fixed to
`https://chatgpt.com/backend-api/codex`; provider/profile Base URL overrides are
ignored. Access tokens and ChatGPT account IDs are redacted from provider text
before it reaches this tool plugin, a session result, or Electron Renderer.

Cordis Host plugins are trusted same-process code, not a credential sandbox. A
separately installed malicious Host plugin could use general Host capabilities
to seek local credentials regardless of this facade. The enforced boundary is
that `gpt-tools`, agent tools, session output, and Renderer code receive only the
fixed operations and sanitized results—not OAuth credentials or authenticated
transport.

Sign in through **Settings > Sign-in & authorization > ChatGPT (Codex)** before
using the tools. Availability still depends on ChatGPT plan, workspace policy,
rate limits, and server-side capabilities; successful OAuth login alone does
not guarantee image generation access.

The `openai-tools` settings section supports:

| Field | Default | Meaning |
| --- | --- | --- |
| `imageModel` | `gpt-image-2` | Image model used for one-shot generation. |
| `searchContextSize` | `medium` | Codex search context size. |
| `searchMaxQueries` | `4` | Maximum queries in one tool call. |
| `searchMaxResults` | `8` | Maximum deduplicated source URLs returned. |
| `searchTimeoutMs` | `60000` | Cooperative search deadline. |
| `imageTimeoutMs` | `300000` | Cooperative image-generation deadline. |

Requests reject redirects, bound response bodies, retry authentication only
once after a 401 through the provider-owned refresh path, and never retry image
generation after an ambiguous transport or provider failure.
