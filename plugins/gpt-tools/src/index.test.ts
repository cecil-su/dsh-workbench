import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { PiAiCodexCapabilities } from '@deepseek-ai/dsh-llm-pi-ai'
import { createScope } from '@deepseek-ai/dsh-scope'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { defineTool, ToolRuntime } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  apply,
  Config as PluginConfig,
  inject as pluginInject,
  isCodexAgent,
  name as pluginName,
  OPENAI_TOOLS_SETTINGS_NAMESPACE,
} from './index.js'

const contexts: Context[] = []

function accessToken(accountId: string, marker: string): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({
    'https://api.openai.com/auth': { chatgpt_account_id: accountId },
  })}.${Buffer.from(marker).toString('base64url')}`
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

class AgentsStub extends Service {
  constructor(ctx: Context) {
    super(ctx, 'agents')
  }
}

class SystemPromptStub extends Service {
  constructor(ctx: Context) {
    super(ctx, 'systemPrompt')
  }

  tools(): void {}
  section(): () => void {
    return () => {}
  }
}

class AttachmentsStub extends Service {
  readonly inputs: Array<{ data: Uint8Array; mediaType: string; name?: string }> = []

  constructor(ctx: Context) {
    super(ctx, 'attachments')
  }

  saveImage(input: { data: Uint8Array; mediaType: string; name?: string }): Promise<{
    attachmentId: string
    bytes: number
    height: number
    mediaType: string
    name?: string
    width: number
  }> {
    this.inputs.push(input)
    return Promise.resolve({
      attachmentId: 'sha256:generated-image',
      bytes: input.data.byteLength,
      height: 1,
      mediaType: input.mediaType,
      ...(input.name ? { name: input.name } : {}),
      width: 1,
    })
  }
}

class MemorySettingsProvider extends SettingsProvider {
  readonly writable = true
  document: Record<string, unknown> = {}

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(this.document)
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.document = { ...this.document, [ns]: section }
    return Promise.resolve()
  }
}

function installCodexCapabilities(
  ctx: Context,
  providerBaseUrl = 'https://chatgpt.com/backend-api',
): {
  accountId: string
  currentToken(): string
  refreshCount(): number
} {
  const accountId = 'account-workbench'
  let credential = {
    type: 'oauth' as const,
    access: accessToken(accountId, 'initial'),
    refresh: 'refresh-initial',
    expires: Date.now() + 60_000,
  }
  let refreshes = 0
  let modifications: Promise<void> = Promise.resolve()
  const credentials = {
    read: async (providerId: string) => providerId === 'openai-codex' ? credential : undefined,
    list: async () => [{ providerId: 'openai-codex', type: 'oauth' as const }],
    async modify(
      providerId: string,
      mutate: (current: typeof credential | undefined) => Promise<typeof credential | undefined>,
    ) {
      if (providerId !== 'openai-codex') return undefined
      let resolveOperation = (): void => {}
      const previous = modifications
      modifications = new Promise<void>((resolve) => { resolveOperation = resolve })
      await previous
      try {
        const next = await mutate(credential)
        if (next !== undefined) credential = next
        return credential
      } finally {
        resolveOperation()
      }
    },
    delete: async () => {},
  }
  const provider = {
    id: 'openai-codex',
    name: 'OpenAI Codex',
    baseUrl: providerBaseUrl,
    auth: {
      oauth: {
        name: 'OpenAI Codex OAuth',
        login: async () => credential,
        async refresh(current: typeof credential) {
          refreshes += 1
          return {
            ...current,
            access: accessToken(accountId, `refreshed-${refreshes}`),
            refresh: `refresh-${refreshes}`,
            expires: Date.now() + 60_000,
          }
        },
        toAuth: async (current: typeof credential) => ({ apiKey: current.access }),
      },
    },
    getModels: () => [],
    stream: () => { throw new Error('unused') },
    streamSimple: () => { throw new Error('unused') },
  }
  ctx.provide('piAiCodex', new PiAiCodexCapabilities({
    credentials,
    authContext: {
      env: async () => undefined,
      fileExists: async () => false,
    },
  } as never, () => provider as never))
  return {
    accountId,
    currentToken: () => credential.access,
    refreshCount: () => refreshes,
  }
}

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(contexts.splice(0).map((ctx) => ctx.fiber.dispose()))
})

describe('Codex agent selection', () => {
  it('selects only the OAuth-backed openai-codex provider route', () => {
    expect(isCodexAgent({ options: { model: 'gpt-5.4', provider: 'openai-codex' } })).toBe(true)
    expect(isCodexAgent({ options: { model: 'gpt-5.4', provider: 'openai' } })).toBe(false)
    expect(isCodexAgent({ options: { model: 'deepseek-v4', provider: 'openai-codex' } })).toBe(true)
  })
})

describe('OAuth-backed Codex tools', () => {
  it('does not expose OAuth or arbitrary request internals at runtime', () => {
    const ctx = new Context()
    contexts.push(ctx)
    installCodexCapabilities(ctx)

    const capability = ctx.piAiCodex as unknown as Record<PropertyKey, unknown>
    expect(Object.getOwnPropertyNames(capability).sort()).toEqual([
      'generateImage',
      'search',
    ])
    expect(Object.isFrozen(capability)).toBe(true)
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(capability)).sort()).toEqual([
      'constructor',
      'generateImage',
      'search',
    ])
    for (const key of [
      'auth',
      'authorization',
      'credentials',
      'ctx',
      'name',
      'refreshAfterUnauthorized',
      'request',
      'requireProvider',
      'resolveProvider',
      'token',
    ]) {
      expect(Reflect.get(capability, key), key).toBeUndefined()
    }
  })

  it('refreshes OAuth after 401, searches with structured sources, and saves generated images', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    new AgentsStub(ctx)
    new SystemPromptStub(ctx)
    new ToolRuntime(ctx)
    const settings = new MemorySettingsProvider(ctx)
    let attachments!: AttachmentsStub
    let auth!: ReturnType<typeof installCodexCapabilities>
    const capabilityProvider = ctx.plugin({
      apply: (providerCtx: Context) => {
        attachments = new AttachmentsStub(providerCtx)
        auth = installCodexCapabilities(providerCtx)
      },
      name: 'codex-capability-provider',
    })
    await capabilityProvider

    const parentKey = {}
    const parentScope = createScope(ctx, parentKey)
    parentScope.ctx.tools.register(defineTool({
      name: 'web_search',
      description: 'upstream search',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: false, properties: {} },
        render: () => [],
      },
      execute: async () => ({}),
    }))

    const requests: Array<{
      accountId: string | null
      authorization: string | null
      body: Record<string, unknown>
      url: string
    }> = []
    let requestNumber = 0
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
      requestNumber += 1
      const headers = new Headers(init?.headers)
      requests.push({
        accountId: headers.get('chatgpt-account-id'),
        authorization: headers.get('authorization'),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        url: String(input),
      })
      if (requestNumber === 1) return jsonResponse({ error: { message: 'expired' } }, 401)
      if (String(input).endsWith('/alpha/search')) {
        return jsonResponse({
          encrypted_output: 'opaque',
          output: `Current answer; token=${auth.currentToken()}; account=${auth.accountId}.`,
          results: [
            {
              type: 'text_result',
              ref_id: 'turn0search0',
              url: 'https://example.test/source',
              title: `Account ${auth.accountId} source`,
              snippet: 'Source snippet',
            },
            {
              type: 'text_result',
              ref_id: 'turn0search1',
              url: `https://example.test/accounts/${auth.accountId}`,
              title: 'Sensitive URL',
            },
          ],
        })
      }
      return jsonResponse({
        created: 1,
        data: [{
          b64_json: 'iVBORw0KGgo=',
          revised_prompt: `Image for ${auth.accountId} using ${auth.currentToken()}`,
        }],
      })
    }))

    const plugin = ctx.plugin({
      Config: PluginConfig,
      apply,
      inject: pluginInject,
      name: pluginName,
    }, {})
    await plugin
    const agentOwner = ctx.plugin({
      inject: ['tools'],
      apply: () => {},
      name: 'restricted-agent-owner',
    })
    await agentOwner

    const codex = { options: { model: 'gpt-5.4', provider: 'openai-codex' } } as Agent
    const codexScope = createScope(agentOwner.ctx, codex, { parent: parentKey })
    Object.assign(codex, { ctx: codexScope.ctx })
    ctx.emit('agent/created', { agent: codex })

    const publicOpenAI = { options: { model: 'gpt-5.4', provider: 'openai' } } as Agent
    const publicScope = createScope(agentOwner.ctx, publicOpenAI, { parent: parentKey })
    Object.assign(publicOpenAI, { ctx: publicScope.ctx })
    ctx.emit('agent/created', { agent: publicOpenAI })

    codexScope.ctx.tools.register(defineTool({
      name: 'undeclared_codex_probe',
      description: 'test-only undeclared service access',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: false, properties: {} },
        render: () => [],
      },
      execute: async (_args, exec) => codexScope.ctx.piAiCodex.search({
        queries: ['must not run'],
        model: 'gpt-5.4',
        contextSize: 'low',
        maxResults: 1,
        signal: exec.signal,
      }),
    }))

    try {
      const undeclared = await ctx.tools.execute({
        callId: 'undeclared-capability' as never,
        name: 'undeclared_codex_probe',
        arguments: {},
        agent: codex,
        signal: new AbortController().signal,
      })
      expect(undeclared.isError).toBe(true)
      expect(JSON.stringify(undeclared)).toContain('without inject')
      expect(ctx.tools.get('web_search', codex)?.description).toContain('ChatGPT Codex')
      expect(ctx.tools.get('generate_image', codex)).toBeDefined()
      expect(ctx.tools.get('web_search', publicOpenAI)?.description).toBe('upstream search')
      expect(ctx.tools.get('generate_image', publicOpenAI)).toBeUndefined()

      await vi.waitFor(() => {
        expect(settings.get(OPENAI_TOOLS_SETTINGS_NAMESPACE)).toBeDefined()
      })
      await settings.update(OPENAI_TOOLS_SETTINGS_NAMESPACE, {
        imageModel: ' gpt-image-2 ',
        imageTimeoutMs: 12_345,
        searchMaxQueries: 1,
        searchTimeoutMs: 2_345,
      })
      await vi.waitFor(() => {
        const loweredSearch = ctx.tools.get('web_search', codex)
        expect(loweredSearch?.timeoutMs).toBe(2_345)
        expect(loweredSearch?.description).toContain('1–1 queries')
        expect((loweredSearch?.parameters as {
          properties: { queries: { description: string } }
        }).properties.queries.description).toContain('1–1 items')
        expect(ctx.tools.schemas(codex).find(({ name }) => name === 'web_search')?.description)
          .toContain('1–1 queries')
        expect(ctx.tools.get('generate_image', codex)?.timeoutMs).toBe(12_345)
      })

      await settings.update(OPENAI_TOOLS_SETTINGS_NAMESPACE, { searchMaxQueries: 6 })
      await vi.waitFor(() => {
        const raisedSearch = ctx.tools.get('web_search', codex)
        expect(raisedSearch?.description).toContain('1–6 queries')
        expect((raisedSearch?.parameters as {
          properties: { queries: { description: string } }
        }).properties.queries.description).toContain('1–6 items')
      })

      const search = await ctx.tools.execute({
        callId: 'integration-search' as never,
        name: 'web_search',
        arguments: { queries: ['current facts'] },
        agent: codex,
        signal: new AbortController().signal,
      })
      const image = await ctx.tools.execute({
        callId: 'integration-image' as never,
        name: 'generate_image',
        arguments: { prompt: 'A test image' },
        agent: codex,
        signal: new AbortController().signal,
      })

      expect(search).toMatchObject({
        isError: false,
        value: {
          content: 'Current answer; token=[REDACTED]; account=[REDACTED].',
          sources: [{ url: 'https://example.test/source', title: 'Account [REDACTED] source' }],
          truncated: true,
        },
      })
      expect(image).toMatchObject({
        isError: false,
        content: [{
          type: 'text',
          text: 'Generated image. Revised prompt: Image for [REDACTED] using [REDACTED]',
        }, {
          type: 'image',
          attachment: {
            attachmentId: 'sha256:generated-image',
            mediaType: 'image/png',
            name: 'generated-image.png',
          },
        }],
        value: {
          attachment: {
            attachmentId: 'sha256:generated-image',
            mediaType: 'image/png',
            name: 'generated-image.png',
          },
          revisedPrompt: 'Image for [REDACTED] using [REDACTED]',
        },
      })
      expect(image).not.toHaveProperty('additionalContexts')
      expect(auth.refreshCount()).toBe(1)
      expect(requests.map(({ url }) => url)).toEqual([
        'https://chatgpt.com/backend-api/codex/alpha/search',
        'https://chatgpt.com/backend-api/codex/alpha/search',
        'https://chatgpt.com/backend-api/codex/images/generations',
      ])
      expect(requests.every(({ accountId }) => accountId === auth.accountId)).toBe(true)
      expect(requests[0]?.authorization).not.toBe(requests[1]?.authorization)
      expect(requests[1]?.authorization).toBe(`Bearer ${auth.currentToken()}`)
      expect(requests[1]?.body).toMatchObject({
        model: 'gpt-5.4',
        commands: { search_query: [{ q: 'current facts' }] },
        settings: { allowed_callers: ['direct'], search_context_size: 'medium' },
      })
      expect(requests[2]?.body).toMatchObject({
        model: 'gpt-image-2',
        prompt: 'A test image',
        size: 'auto',
        quality: 'auto',
        background: 'auto',
        n: 1,
      })
      expect(attachments.inputs).toEqual([expect.objectContaining({
        mediaType: 'image/png',
        name: 'generated-image.png',
      })])
    } finally {
      ctx.emit('agent/disposed', { agent: codex })
      ctx.emit('agent/disposed', { agent: publicOpenAI })
      await codexScope.dispose()
      await publicScope.dispose()
      await parentScope.dispose()
      await agentOwner.dispose()
    }
  })

  it('never sends OAuth credentials to a configured custom provider Base URL', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    installCodexCapabilities(ctx, 'http://credentials.example/collect')
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ output: 'official only', results: [] })))

    await expect(ctx.piAiCodex.search({
      queries: ['origin isolation'],
      model: 'gpt-5.4',
      contextSize: 'low',
      maxResults: 8,
      signal: new AbortController().signal,
    })).resolves.toEqual({ content: 'official only', sources: [], truncated: false })

    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1)
    expect(String(vi.mocked(fetch).mock.calls[0]?.[0])).toBe(
      'https://chatgpt.com/backend-api/codex/alpha/search',
    )
    expect(vi.mocked(fetch).mock.calls.some(([input]) => (
      String(input).startsWith('http://credentials.example')
    ))).toBe(false)
  })

  it('coalesces concurrent 401 responses through the credential-store refresh lock', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const auth = installCodexCapabilities(ctx)
    const initialToken = auth.currentToken()
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get('authorization')
      if (authorization === `Bearer ${initialToken}`) {
        await new Promise((resolve) => setTimeout(resolve, 10))
        return jsonResponse({ error: { message: 'expired' } }, 401)
      }
      return jsonResponse({ output: 'refreshed', results: [] })
    }))

    const request = () => ctx.piAiCodex.search({
      queries: ['concurrent'],
      model: 'gpt-5.4',
      contextSize: 'low' as const,
      maxResults: 8,
      signal: new AbortController().signal,
    })
    const results = await Promise.all([request(), request()])

    expect(results).toEqual([
      { content: 'refreshed', sources: [], truncated: false },
      { content: 'refreshed', sources: [], truncated: false },
    ])
    expect(auth.refreshCount()).toBe(1)
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(4)
  })

  it('bounds response streams and redacts a reflected OAuth access token', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const auth = installCodexCapabilities(ctx)
    let cancelled = false
    const chunk = new Uint8Array(1024 * 1024)
    let reads = 0
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { input?: string }
      if (body.input?.includes('oversized')) {
        return {
          body: {
            getReader: () => ({
              cancel: async () => { cancelled = true },
              read: async () => {
                reads += 1
                if (reads <= 4) return { done: false as const, value: chunk }
                if (reads === 5) return { done: false as const, value: new Uint8Array(1) }
                throw new Error('reader continued past response limit')
              },
              releaseLock: () => {},
            }),
          },
          headers: { get: () => null },
          ok: true,
          status: 200,
        }
      }
      return jsonResponse({
        error: {
          message: `quota exceeded for ${auth.currentToken()} on ${auth.accountId}`,
        },
      }, 429)
    }))

    await expect(ctx.piAiCodex.search({
      queries: ['oversized'],
      model: 'gpt-5.4',
      contextSize: 'low',
      maxResults: 8,
      signal: new AbortController().signal,
    })).rejects.toThrow(/4194304-byte limit/u)
    expect(reads).toBe(5)
    expect(cancelled).toBe(true)

    const error = await ctx.piAiCodex.search({
      queries: ['provider error'],
      model: 'gpt-5.4',
      contextSize: 'low',
      maxResults: 8,
      signal: new AbortController().signal,
    }).catch((caught: unknown) => caught)
    expect(String(error)).toContain('[REDACTED]')
    expect(String(error)).not.toContain(auth.currentToken())
    expect(String(error)).not.toContain(auth.accountId)
  })
})
