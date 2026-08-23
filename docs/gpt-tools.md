# GPT web search and image generation

`@dsh-workbench/gpt-tools` gives DSH agents using a `gpt-*` model two Workbench
capabilities:

- `web_search` uses the OpenAI Responses API hosted `web_search` tool. It shadows
  the standard DSH search tool only for that GPT agent; DeepSeek and other model
  routes keep the upstream search composition.
- `generate_image` creates one image through the OpenAI Image API and stores the
  returned bytes through DSH's durable attachment service. The conversation log
  stores only the content-addressed attachment reference.

Both capabilities resolve `OPENAI_API_KEY` through the active DSH profile's
credential service on every call. A ChatGPT/Codex OAuth login is not treated as
an API key and is not forwarded to the public OpenAI API. Configure an OpenAI
API-key route in Models or export `OPENAI_API_KEY` before starting Workbench.

The `openai-tools` settings section supports these deployment fields:

| Field | Default | Meaning |
| --- | --- | --- |
| `apiKeyEnv` | `OPENAI_API_KEY` | Credential reference resolved for each call. |
| `baseURL` | `https://api.openai.com/v1` | HTTPS Responses/Image API base; loopback HTTP is allowed for tests. |
| `searchModel` | `gpt-5.6` | Mainline GPT model that invokes hosted web search. |
| `imageModel` | `gpt-image-2` | Image model used for one-shot generation. |
| `searchContextSize` | `medium` | OpenAI hosted-search context size. |
| `searchMaxQueries` | `4` | Maximum queries in one DSH tool call. |
| `searchMaxResults` | `8` | Maximum deduplicated sources returned to the conversation. |
| `searchTimeoutMs` | `60000` | Cooperative search deadline. |
| `imageTimeoutMs` | `300000` | Cooperative image-generation deadline. |

Remote custom bases must use HTTPS, redirects are rejected, response bodies are
bounded, and credentials are never persisted by this plugin. GPT Image access
can also depend on OpenAI organization verification and account limits.
