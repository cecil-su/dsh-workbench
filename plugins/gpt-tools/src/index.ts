import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  AttachmentId,
  type ImageAttachmentRef,
  type ImageMediaType,
} from '@deepseek-ai/dsh-attachment'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import {
  formatSearchOutput,
  presentSearchCall,
  presentSearchResult,
  searchMetaFromValue,
} from '@deepseek-ai/dsh-tool-web'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'

export const name = 'dsh-workbench-gpt-tools'
export const inject = ['agents', 'attachments', 'credentials', 'tools']

export const DEFAULT_API_KEY_ENV = 'OPENAI_API_KEY'
export const DEFAULT_BASE_URL = 'https://api.openai.com/v1'
export const DEFAULT_SEARCH_MODEL = 'gpt-5.6'
export const DEFAULT_IMAGE_MODEL = 'gpt-image-2'
export const DEFAULT_SEARCH_MAX_QUERIES = 4
export const DEFAULT_SEARCH_MAX_RESULTS = 8
export const DEFAULT_SEARCH_TIMEOUT_MS = 60_000
export const DEFAULT_IMAGE_TIMEOUT_MS = 300_000
export const OPENAI_TOOLS_SETTINGS_NAMESPACE = settingsNamespace('openai-tools')

const SEARCH_RESPONSE_MAX_BYTES = 4 * 1024 * 1024
const IMAGE_RESPONSE_MAX_BYTES = 32 * 1024 * 1024

export interface Config {
  apiKeyEnv?: string
  baseURL?: string
  searchModel?: string
  imageModel?: string
  searchContextSize?: 'low' | 'medium' | 'high'
  searchMaxQueries?: number
  searchMaxResults?: number
  searchTimeoutMs?: number
  imageTimeoutMs?: number
}

export const Config = z.object({
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  baseURL: z.string().default(DEFAULT_BASE_URL),
  searchModel: z.string().default(DEFAULT_SEARCH_MODEL),
  imageModel: z.string().default(DEFAULT_IMAGE_MODEL),
  searchContextSize: z.union(['low', 'medium', 'high']).default('medium'),
  searchMaxQueries: z.number().step(1).min(1).default(DEFAULT_SEARCH_MAX_QUERIES),
  searchMaxResults: z.number().step(1).min(1).default(DEFAULT_SEARCH_MAX_RESULTS),
  searchTimeoutMs: z.number().step(1).min(1).default(DEFAULT_SEARCH_TIMEOUT_MS),
  imageTimeoutMs: z.number().step(1).min(1).default(DEFAULT_IMAGE_TIMEOUT_MS),
})

interface ResolvedConfig {
  apiKeyEnv: string
  baseURL: string
  searchModel: string
  imageModel: string
  searchContextSize: 'low' | 'medium' | 'high'
  searchMaxQueries: number
  searchMaxResults: number
  searchTimeoutMs: number
  imageTimeoutMs: number
}

interface OpenAISource {
  url: string
  title?: string
}

export interface OpenAISearchResult {
  content?: string
  sources: OpenAISource[]
  truncated: boolean
}

export interface OpenAIGeneratedImage {
  data: Uint8Array
  mediaType: 'image/png'
  revisedPrompt?: string
}

interface FetchResponse {
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  arrayBuffer(): Promise<ArrayBuffer>
}

export type FetchImplementation = (
  input: string | URL,
  init?: RequestInit,
) => Promise<FetchResponse>

function resolvedConfig(config: Config): ResolvedConfig {
  const result: ResolvedConfig = {
    apiKeyEnv: config.apiKeyEnv ?? DEFAULT_API_KEY_ENV,
    baseURL: config.baseURL ?? DEFAULT_BASE_URL,
    searchModel: config.searchModel ?? DEFAULT_SEARCH_MODEL,
    imageModel: config.imageModel ?? DEFAULT_IMAGE_MODEL,
    searchContextSize: config.searchContextSize ?? 'medium',
    searchMaxQueries: config.searchMaxQueries ?? DEFAULT_SEARCH_MAX_QUERIES,
    searchMaxResults: config.searchMaxResults ?? DEFAULT_SEARCH_MAX_RESULTS,
    searchTimeoutMs: config.searchTimeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS,
    imageTimeoutMs: config.imageTimeoutMs ?? DEFAULT_IMAGE_TIMEOUT_MS,
  }
  for (const [field, value] of Object.entries({
    imageTimeoutMs: result.imageTimeoutMs,
    searchMaxQueries: result.searchMaxQueries,
    searchMaxResults: result.searchMaxResults,
    searchTimeoutMs: result.searchTimeoutMs,
  })) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`openai-tools ${field} must be a positive safe integer`)
    }
  }
  return result
}

function apiEndpoint(baseURL: string, path: string): string {
  const normalized = baseURL.trim().replace(/\/+$/u, '')
  if (!URL.canParse(normalized)) throw new Error('OpenAI tools baseURL is invalid')
  const parsed = new URL(normalized)
  const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === '::1' || parsed.hostname === 'localhost'
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    throw new Error('OpenAI tools baseURL must use HTTPS (HTTP is allowed only for loopback testing)')
  }
  return `${normalized}/${path}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function readJson(response: FetchResponse, maxBytes: number): Promise<unknown> {
  const length = response.headers.get('content-length')
  if (length !== null && Number(length) > maxBytes) {
    throw new Error(`OpenAI response exceeds the ${maxBytes}-byte limit`)
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > maxBytes) throw new Error(`OpenAI response exceeds the ${maxBytes}-byte limit`)
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown
  } catch (error) {
    throw new Error('OpenAI returned invalid JSON', { cause: error })
  }
}

function providerError(body: unknown, status: number): Error {
  let detail: string | undefined
  if (isRecord(body)) {
    const error = body.error
    if (typeof error === 'string') detail = error
    else if (isRecord(error) && typeof error.message === 'string') detail = error.message
    else if (typeof body.message === 'string') detail = body.message
  }
  const safeDetail = detail?.replace(/[\r\n]+/gu, ' ').slice(0, 500)
  return new Error(`OpenAI API error (HTTP ${status})${safeDetail ? `: ${safeDetail}` : ''}`)
}

async function postJson(
  fetchImpl: FetchImplementation,
  endpoint: string,
  apiKey: string,
  body: unknown,
  signal: AbortSignal,
  maxResponseBytes: number,
): Promise<unknown> {
  let response: FetchResponse
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        'user-agent': 'dsh-workbench/0.1.0',
      },
      body: JSON.stringify(body),
      signal,
    })
  } catch (error) {
    if (signal.aborted) throw new Error('OpenAI request aborted', { cause: signal.reason })
    throw new Error(`OpenAI request failed: ${String(error)}`, { cause: error })
  }
  const payload = await readJson(response, maxResponseBytes)
  if (!response.ok) throw providerError(payload, response.status)
  return payload
}

function outputText(payload: Record<string, unknown>): string | undefined {
  if (typeof payload.output_text === 'string' && payload.output_text.length > 0) {
    return payload.output_text
  }
  if (!Array.isArray(payload.output)) return undefined
  const texts: string[] = []
  for (const item of payload.output) {
    if (!isRecord(item) || item.type !== 'message' || !Array.isArray(item.content)) continue
    for (const content of item.content) {
      if (isRecord(content) && content.type === 'output_text' && typeof content.text === 'string') {
        texts.push(content.text)
      }
    }
  }
  return texts.length > 0 ? texts.join('\n\n') : undefined
}

function outputSources(payload: Record<string, unknown>): OpenAISource[] {
  const candidates: OpenAISource[] = []
  if (!Array.isArray(payload.output)) return candidates
  for (const item of payload.output) {
    if (!isRecord(item)) continue
    if (item.type === 'web_search_call' && isRecord(item.action) && Array.isArray(item.action.sources)) {
      for (const source of item.action.sources) {
        if (!isRecord(source) || typeof source.url !== 'string' || source.url.length === 0) continue
        candidates.push({
          url: source.url,
          ...(typeof source.title === 'string' && source.title.length > 0 ? { title: source.title } : {}),
        })
      }
    }
    if (item.type !== 'message' || !Array.isArray(item.content)) continue
    for (const content of item.content) {
      if (!isRecord(content) || !Array.isArray(content.annotations)) continue
      for (const annotation of content.annotations) {
        if (!isRecord(annotation) || annotation.type !== 'url_citation') continue
        const citation = isRecord(annotation.url_citation) ? annotation.url_citation : annotation
        if (typeof citation.url !== 'string' || citation.url.length === 0) continue
        candidates.push({
          url: citation.url,
          ...(typeof citation.title === 'string' && citation.title.length > 0 ? { title: citation.title } : {}),
        })
      }
    }
  }
  const seen = new Set<string>()
  return candidates.filter((source) => {
    if (seen.has(source.url)) return false
    seen.add(source.url)
    return true
  })
}

export async function searchWithOpenAI(options: {
  apiKey: string
  baseURL: string
  model: string
  query: string
  contextSize: 'low' | 'medium' | 'high'
  maxResults: number
  signal: AbortSignal
  fetchImpl?: FetchImplementation
}): Promise<OpenAISearchResult> {
  const payload = await postJson(
    options.fetchImpl ?? fetch as FetchImplementation,
    apiEndpoint(options.baseURL, 'responses'),
    options.apiKey,
    {
      model: options.model,
      input: `Search the web for this query and summarize the relevant findings with citations: ${options.query}`,
      tools: [{ type: 'web_search', search_context_size: options.contextSize }],
      tool_choice: { type: 'web_search' },
      include: ['web_search_call.action.sources'],
      max_output_tokens: 1_500,
      store: false,
    },
    options.signal,
    SEARCH_RESPONSE_MAX_BYTES,
  )
  if (!isRecord(payload)) throw new Error('OpenAI returned an invalid Responses payload')
  const allSources = outputSources(payload)
  return {
    ...(outputText(payload) ? { content: outputText(payload) } : {}),
    sources: allSources.slice(0, options.maxResults),
    truncated: allSources.length > options.maxResults,
  }
}

function decodeCanonicalBase64(value: string): Uint8Array {
  if (value.length === 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new Error('OpenAI returned invalid base64 image data')
  }
  const data = Buffer.from(value, 'base64')
  if (data.toString('base64') !== value) throw new Error('OpenAI returned non-canonical base64 image data')
  return new Uint8Array(data)
}

export async function generateWithOpenAI(options: {
  apiKey: string
  baseURL: string
  model: string
  prompt: string
  size: 'auto' | '1024x1024' | '1536x1024' | '1024x1536'
  quality: 'auto' | 'low' | 'medium' | 'high'
  background: 'auto' | 'opaque' | 'transparent'
  signal: AbortSignal
  fetchImpl?: FetchImplementation
}): Promise<OpenAIGeneratedImage> {
  const payload = await postJson(
    options.fetchImpl ?? fetch as FetchImplementation,
    apiEndpoint(options.baseURL, 'images/generations'),
    options.apiKey,
    {
      model: options.model,
      prompt: options.prompt,
      size: options.size,
      quality: options.quality,
      background: options.background,
      output_format: 'png',
      n: 1,
    },
    options.signal,
    IMAGE_RESPONSE_MAX_BYTES,
  )
  if (!isRecord(payload) || !Array.isArray(payload.data) || !isRecord(payload.data[0])) {
    throw new Error('OpenAI returned an invalid image payload')
  }
  const image = payload.data[0]
  if (typeof image.b64_json !== 'string') throw new Error('OpenAI returned no generated image')
  return {
    data: decodeCanonicalBase64(image.b64_json),
    mediaType: 'image/png',
    ...(typeof image.revised_prompt === 'string' && image.revised_prompt.length > 0
      ? { revisedPrompt: image.revised_prompt }
      : {}),
  }
}

function mergeSearchResults(
  queries: readonly string[],
  results: readonly OpenAISearchResult[],
  maxResults: number,
): OpenAISearchResult {
  const seen = new Set<string>()
  const sources: OpenAISource[] = []
  const maxRanks = Math.max(0, ...results.map((result) => result.sources.length))
  let dropped = false
  outer: for (let rank = 0; rank < maxRanks; rank += 1) {
    for (const result of results) {
      const source = result.sources[rank]
      if (!source || seen.has(source.url)) continue
      seen.add(source.url)
      if (sources.length === maxResults) {
        dropped = true
        break outer
      }
      sources.push(source)
    }
  }
  const contents = results.flatMap((result, index) => (
    result.content ? [`### ${queries[index]}\n\n${result.content}`] : []
  ))
  return {
    ...(contents.length > 0 ? { content: contents.join('\n\n') } : {}),
    sources,
    truncated: dropped || results.some((result) => result.truncated),
  }
}

function parseQueries(value: string[], maxQueries: number): string[] {
  if (value.length < 1 || value.length > maxQueries) {
    throw new Error(`queries must contain 1–${maxQueries} items`)
  }
  if (value.some((query) => query.trim().length === 0)) {
    throw new Error('each query must be a non-empty string')
  }
  return [...new Set(value)]
}

async function resolveApiKey(ctx: Context, config: ResolvedConfig): Promise<string> {
  const ref = credentialRef(config.apiKeyEnv)
  const stored = ctx.get('credentials')
    ? (await ctx.get('credentials')?.resolve(ref))?.value
    : launchEnvironmentOf(ctx).get(ref)?.value
  const apiKey = stored?.trim()
  if (!apiKey) {
    throw new Error(`OpenAI tools have no API key for "${config.apiKeyEnv}"; configure the OpenAI API key in Models or export ${config.apiKeyEnv}`)
  }
  if (/\r|\n/u.test(apiKey)) throw new Error(`OpenAI tools credential "${config.apiKeyEnv}" is invalid`)
  return apiKey
}

function attachmentValue(ref: ImageAttachmentRef): {
  attachmentId: string
  mediaType: ImageMediaType
  bytes: number
  width: number
  height: number
  name?: string
  originalDimensions?: { width: number; height: number }
} {
  return {
    attachmentId: String(ref.attachmentId),
    mediaType: ref.mediaType,
    bytes: ref.bytes,
    width: ref.width,
    height: ref.height,
    ...(ref.name ? { name: ref.name } : {}),
    ...(ref.originalDimensions ? { originalDimensions: ref.originalDimensions } : {}),
  }
}

function attachmentRef(value: ReturnType<typeof attachmentValue>): ImageAttachmentRef {
  return {
    ...value,
    attachmentId: AttachmentId(value.attachmentId),
  }
}

export function isGptAgent(agent: Pick<Agent, 'options'>): boolean {
  return typeof agent.options.model === 'string' && /^gpt(?:[-_.]|$)/iu.test(agent.options.model)
}

function installAgentTools(ctx: Context, source: () => Config): void {
  const initial = resolvedConfig(source())
  ctx.tools.register(defineTool({
    name: 'web_search',
    description: `Search the web for current information with OpenAI. Provide 1–${initial.searchMaxQueries} queries in the required queries array. Returns a summary and source URLs.`,
    parameters: {
      queries: {
        type: 'array',
        required: true,
        items: { type: 'string' },
        description: `Required search queries; accepts 1–${initial.searchMaxQueries} items and merges their results.`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          content: { type: 'string' },
          sources: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                url: { type: 'string', required: true },
                title: { type: 'string' },
              },
            },
          },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatSearchOutput(value) }],
      presentationMeta: (_args, value) => searchMetaFromValue(value),
    },
    timeoutMs: initial.searchTimeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const config = resolvedConfig(source())
      const queries = parseQueries(args.queries, config.searchMaxQueries)
      const apiKey = await resolveApiKey(ctx, config)
      const controller = new AbortController()
      const signal = AbortSignal.any([exec.signal, controller.signal])
      let firstFailure: unknown
      const results = await Promise.all(queries.map(async (query) => {
        try {
          return await searchWithOpenAI({
            apiKey,
            baseURL: config.baseURL,
            model: config.searchModel,
            query,
            contextSize: config.searchContextSize,
            maxResults: config.searchMaxResults,
            signal,
          })
        } catch (error) {
          if (firstFailure === undefined) firstFailure = error
          controller.abort(error)
          return undefined
        }
      }))
      if (firstFailure !== undefined) throw firstFailure
      return mergeSearchResults(queries, results as OpenAISearchResult[], config.searchMaxResults)
    },
    presentCall: presentSearchCall,
    presentResult: (args, result) => presentSearchResult(args, result),
  }))

  ctx.tools.register(defineTool({
    name: 'generate_image',
    description: 'Generate one image from a detailed text prompt with OpenAI GPT Image and return the durable image in the conversation.',
    parameters: {
      prompt: {
        type: 'string',
        required: true,
        description: 'A detailed description of the image to generate, including composition, subject, style, lighting, color, and any required text.',
      },
      size: {
        type: 'string',
        enum: ['auto', '1024x1024', '1536x1024', '1024x1536'],
        default: 'auto',
        description: 'Output aspect and size. Defaults to auto.',
      },
      quality: {
        type: 'string',
        enum: ['auto', 'low', 'medium', 'high'],
        default: 'auto',
        description: 'Image quality. Defaults to auto.',
      },
      background: {
        type: 'string',
        enum: ['auto', 'opaque', 'transparent'],
        default: 'auto',
        description: 'Background mode. Use transparent only when the requested asset needs transparency.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          attachment: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              attachmentId: { type: 'string', required: true },
              mediaType: {
                type: 'string',
                required: true,
                enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
              },
              bytes: { type: 'integer', required: true },
              width: { type: 'integer', required: true },
              height: { type: 'integer', required: true },
              name: { type: 'string' },
              originalDimensions: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  width: { type: 'integer', required: true },
                  height: { type: 'integer', required: true },
                },
              },
            },
          },
          revisedPrompt: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.revisedPrompt
          ? `Generated image. Revised prompt: ${value.revisedPrompt}`
          : 'Generated image.',
      }, {
        type: 'image',
        attachment: attachmentRef(value.attachment),
      }],
    },
    timeoutMs: initial.imageTimeoutMs,
    async execute(args, exec) {
      const config = resolvedConfig(source())
      const prompt = args.prompt.trim()
      if (!prompt) throw new Error('prompt must be a non-empty string')
      const apiKey = await resolveApiKey(ctx, config)
      const generated = await generateWithOpenAI({
        apiKey,
        baseURL: config.baseURL,
        model: config.imageModel,
        prompt,
        size: args.size ?? 'auto',
        quality: args.quality ?? 'auto',
        background: args.background ?? 'auto',
        signal: exec.signal,
      })
      const ref = await ctx.attachments.saveImage({
        data: generated.data,
        mediaType: generated.mediaType,
        name: 'generated-image.png',
      })
      return {
        attachment: attachmentValue(ref),
        ...(generated.revisedPrompt ? { revisedPrompt: generated.revisedPrompt } : {}),
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      kind: 'other',
      title: 'Generate image',
      rawInput: args.prompt,
    }),
    presentResult: (_args, result) => ({
      card: 'generic',
      title: result.isError ? 'Image generation failed' : 'Generated image',
      content: result.content,
    }),
  }))
}

export function apply(ctx: Context, config: Config): void {
  let current = () => config
  installSettingsSection(ctx, OPENAI_TOOLS_SETTINGS_NAMESPACE, Config, config, {
    setSource: (source) => {
      current = source
    },
    onChange: () => {},
  })

  ctx.on('agent/created', ({ agent }) => {
    if (!isGptAgent(agent)) return
    installAgentTools(agent.ctx, current)
    ctx.logger(name).info('OpenAI search and image tools active for GPT model %s', agent.options.model)
  })
}
