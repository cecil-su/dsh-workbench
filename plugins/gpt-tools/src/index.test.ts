import { describe, expect, it, vi } from 'vitest'

import {
  generateWithOpenAI,
  isGptAgent,
  searchWithOpenAI,
  type FetchImplementation,
} from './index.js'

function jsonResponse(value: unknown, status = 200) {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => name.toLowerCase() === 'content-length' ? String(bytes.byteLength) : null },
    arrayBuffer: async () => bytes.buffer,
  }
}

describe('GPT tool routing', () => {
  it('matches GPT model ids without affecting non-GPT routes', () => {
    expect(isGptAgent({ options: { model: 'gpt-5.6', provider: 'openai' } })).toBe(true)
    expect(isGptAgent({ options: { model: 'GPT-5.4-codex', provider: 'openai-codex' } })).toBe(true)
    expect(isGptAgent({ options: { model: 'o3', provider: 'openai' } })).toBe(false)
    expect(isGptAgent({ options: { model: 'deepseek-v4-flash', provider: 'deepseek-official' } })).toBe(false)
  })
})

describe('OpenAI web search transport', () => {
  it('forces the native web tool and projects deduplicated sources', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      output_text: 'Current answer with citations.',
      output: [{
        type: 'web_search_call',
        action: {
          sources: [
            { url: 'https://example.com/a', title: 'A' },
            { url: 'https://example.com/a', title: 'duplicate' },
            { url: 'https://example.com/b', title: 'B' },
          ],
        },
      }],
    })) as unknown as FetchImplementation

    const result = await searchWithOpenAI({
      apiKey: 'test-key',
      baseURL: 'https://api.openai.com/v1/',
      model: 'gpt-5.6',
      query: 'current facts',
      contextSize: 'medium',
      maxResults: 1,
      signal: new AbortController().signal,
      fetchImpl,
    })

    expect(result).toEqual({
      content: 'Current answer with citations.',
      sources: [{ url: 'https://example.com/a', title: 'A' }],
      truncated: true,
    })
    expect(fetchImpl).toHaveBeenCalledOnce()
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0]
    expect(url).toBe('https://api.openai.com/v1/responses')
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    expect(body.tools).toEqual([{ type: 'web_search', search_context_size: 'medium' }])
    expect(body.tool_choice).toEqual({ type: 'web_search' })
    expect(String((init?.headers as Record<string, string>).authorization)).toBe('Bearer test-key')
  })

  it('rejects non-TLS remote gateways before sending credentials', async () => {
    const fetchImpl = vi.fn() as unknown as FetchImplementation
    await expect(searchWithOpenAI({
      apiKey: 'secret',
      baseURL: 'http://example.com/v1',
      model: 'gpt-5.6',
      query: 'query',
      contextSize: 'low',
      maxResults: 8,
      signal: new AbortController().signal,
      fetchImpl,
    })).rejects.toThrow(/must use HTTPS/u)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('returns a bounded provider error without exposing request credentials', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: { message: 'quota exceeded' } }, 429)) as unknown as FetchImplementation
    await expect(searchWithOpenAI({
      apiKey: 'top-secret',
      baseURL: 'https://api.openai.com/v1',
      model: 'gpt-5.6',
      query: 'query',
      contextSize: 'low',
      maxResults: 8,
      signal: new AbortController().signal,
      fetchImpl,
    })).rejects.toThrow('OpenAI API error (HTTP 429): quota exceeded')
  })
})

describe('OpenAI image transport', () => {
  it('decodes one canonical PNG response and sends explicit output controls', async () => {
    const image = new Uint8Array([137, 80, 78, 71])
    const fetchImpl = vi.fn(async () => jsonResponse({
      data: [{ b64_json: Buffer.from(image).toString('base64'), revised_prompt: 'Revised' }],
    })) as unknown as FetchImplementation

    const result = await generateWithOpenAI({
      apiKey: 'test-key',
      baseURL: 'https://api.openai.com/v1',
      model: 'gpt-image-2',
      prompt: 'A test image',
      size: '1024x1024',
      quality: 'high',
      background: 'transparent',
      signal: new AbortController().signal,
      fetchImpl,
    })

    expect(result).toEqual({ data: image, mediaType: 'image/png', revisedPrompt: 'Revised' })
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0]
    expect(url).toBe('https://api.openai.com/v1/images/generations')
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: 'gpt-image-2',
      prompt: 'A test image',
      size: '1024x1024',
      quality: 'high',
      background: 'transparent',
      output_format: 'png',
      n: 1,
    })
  })

  it('rejects malformed base64 image data', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [{ b64_json: 'not base64' }] })) as unknown as FetchImplementation
    await expect(generateWithOpenAI({
      apiKey: 'test-key',
      baseURL: 'https://api.openai.com/v1',
      model: 'gpt-image-2',
      prompt: 'test',
      size: 'auto',
      quality: 'auto',
      background: 'auto',
      signal: new AbortController().signal,
      fetchImpl,
    })).rejects.toThrow(/invalid base64/u)
  })
})
