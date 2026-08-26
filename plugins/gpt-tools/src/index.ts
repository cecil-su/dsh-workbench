import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  AttachmentId,
  type ImageAttachmentRef,
  type ImageMediaType,
} from '@deepseek-ai/dsh-attachment'
import type {
  PiAiCodexGeneratedImage,
  PiAiCodexSearchResult,
} from '@deepseek-ai/dsh-llm-pi-ai'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import {
  formatSearchOutput,
  presentSearchCall,
  presentSearchResult,
  searchMetaFromValue,
} from '@deepseek-ai/dsh-tool-web'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'

export const name = 'dsh-workbench-gpt-tools'
export const inject = ['agents', 'attachments', 'piAiCodex', 'tools']

export const DEFAULT_IMAGE_MODEL = 'gpt-image-2'
export const DEFAULT_SEARCH_MAX_QUERIES = 4
export const DEFAULT_SEARCH_MAX_RESULTS = 8
export const DEFAULT_SEARCH_TIMEOUT_MS = 60_000
export const DEFAULT_IMAGE_TIMEOUT_MS = 300_000
export const OPENAI_TOOLS_SETTINGS_NAMESPACE = settingsNamespace('openai-tools')

export interface Config {
  imageModel?: string
  searchContextSize?: 'low' | 'medium' | 'high'
  searchMaxQueries?: number
  searchMaxResults?: number
  searchTimeoutMs?: number
  imageTimeoutMs?: number
}

export const Config = z.object({
  imageModel: z.string().default(DEFAULT_IMAGE_MODEL),
  searchContextSize: z.union(['low', 'medium', 'high']).default('medium'),
  searchMaxQueries: z.number().step(1).min(1).default(DEFAULT_SEARCH_MAX_QUERIES),
  searchMaxResults: z.number().step(1).min(1).default(DEFAULT_SEARCH_MAX_RESULTS),
  searchTimeoutMs: z.number().step(1).min(1).default(DEFAULT_SEARCH_TIMEOUT_MS),
  imageTimeoutMs: z.number().step(1).min(1).default(DEFAULT_IMAGE_TIMEOUT_MS),
})

interface ResolvedConfig {
  imageModel: string
  searchContextSize: 'low' | 'medium' | 'high'
  searchMaxQueries: number
  searchMaxResults: number
  searchTimeoutMs: number
  imageTimeoutMs: number
}

function resolvedConfig(config: Config): ResolvedConfig {
  const result: ResolvedConfig = {
    imageModel: (config.imageModel ?? DEFAULT_IMAGE_MODEL).trim(),
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
  if (!result.imageModel) throw new Error('openai-tools imageModel must be non-empty')
  return result
}

function parseQueries(value: string[], maxQueries: number): string[] {
  if (value.length < 1 || value.length > maxQueries) {
    throw new Error(`queries must contain 1–${maxQueries} items`)
  }
  if (value.some((query) => query.trim().length === 0)) {
    throw new Error('each query must be a non-empty string')
  }
  return [...new Set(value.map((query) => query.trim()))]
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

export function isCodexAgent(agent: Pick<Agent, 'options'>): boolean {
  return agent.options.provider === 'openai-codex'
    && typeof agent.options.model === 'string'
    && agent.options.model.length > 0
}

interface InstalledAgentTools {
  image: ToolDefinition
  search: ToolDefinition
}

interface AgentToolCapabilities {
  attachments: Context['attachments']
  codex: Context['piAiCodex']
}

function installAgentTools(
  ctx: Context,
  source: () => Config,
  searchModel: string,
  capabilities: AgentToolCapabilities,
): InstalledAgentTools {
  const initial = resolvedConfig(source())
  const search = defineTool({
    name: 'web_search',
    description: `Search the web with the signed-in ChatGPT Codex account. Provide 1–${initial.searchMaxQueries} queries in the required queries array. Returns findings and source URLs.`,
    parameters: {
      queries: {
        type: 'array',
        required: true,
        items: { type: 'string' },
        description: `Required search queries; accepts 1–${initial.searchMaxQueries} items.`,
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
    async execute(args, exec): Promise<PiAiCodexSearchResult> {
      const config = resolvedConfig(source())
      return capabilities.codex.search({
        queries: parseQueries(args.queries, config.searchMaxQueries),
        model: searchModel,
        contextSize: config.searchContextSize,
        maxResults: config.searchMaxResults,
        signal: exec.signal,
      })
    },
    presentCall: presentSearchCall,
    presentResult: (args, result) => presentSearchResult(args, result),
  })
  ctx.tools.register(search)

  const image = defineTool({
    name: 'generate_image',
    description: 'Generate one image with the signed-in ChatGPT Codex account and return the durable image in the conversation.',
    parameters: {
      prompt: {
        type: 'string',
        required: true,
        description: 'A detailed description of the image, including composition, subject, style, lighting, color, and any required text.',
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
      const generated: PiAiCodexGeneratedImage = await capabilities.codex.generateImage({
        model: config.imageModel,
        prompt,
        size: args.size ?? 'auto',
        quality: args.quality ?? 'auto',
        background: args.background ?? 'auto',
        signal: exec.signal,
      })
      const ref = await capabilities.attachments.saveImage({
        data: generated.data,
        mediaType: generated.mediaType,
        name: 'generated-image.png',
      })
      const attachment = attachmentValue(ref)
      return {
        attachment,
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
  })
  ctx.tools.register(image)
  return { image, search }
}

export function apply(ctx: Context, config: Config): void {
  let current = () => config
  const capabilities: AgentToolCapabilities = {
    attachments: ctx.attachments,
    codex: ctx.piAiCodex,
  }
  const installed = new Map<Agent, InstalledAgentTools>()
  const refreshDefinitions = (): void => {
    const resolved = resolvedConfig(current())
    const description = `Search the web with the signed-in ChatGPT Codex account. Provide 1–${resolved.searchMaxQueries} queries in the required queries array. Returns findings and source URLs.`
    const queriesDescription = `Required search queries; accepts 1–${resolved.searchMaxQueries} items.`
    for (const tools of installed.values()) {
      tools.search.description = description
      ;(tools.search.parameters as {
        properties: { queries: { description: string } }
      }).properties.queries.description = queriesDescription
      tools.search.timeoutMs = resolved.searchTimeoutMs
      tools.image.timeoutMs = resolved.imageTimeoutMs
    }
    ctx.emit('tools/change')
  }
  installSettingsSection(ctx, OPENAI_TOOLS_SETTINGS_NAMESPACE, Config, config, {
    setSource: (source) => {
      current = source
    },
    validate: (candidate) => {
      resolvedConfig(candidate)
    },
    onChange: refreshDefinitions,
  })

  ctx.on('agent/created', ({ agent }) => {
    const searchModel = agent.options.model
    if (!isCodexAgent(agent) || typeof searchModel !== 'string') return
    installed.set(agent, installAgentTools(agent.ctx, current, searchModel, capabilities))
    ctx.logger(name).info(
      'ChatGPT Codex search and image tools active for %s/%s',
      agent.options.provider,
      agent.options.model,
    )
  })
  ctx.on('agent/disposed', ({ agent }) => {
    installed.delete(agent)
  })
}
