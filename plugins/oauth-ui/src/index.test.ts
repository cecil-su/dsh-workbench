import { createServer } from 'node:http'

import { credentialKey, type CredentialKey } from '@deepseek-ai/dsh-credentials'
import { describe, expect, it, vi } from 'vitest'

import {
  AuthorizationController,
  AuthorizationProtocolError,
  assertTrustedLoopbackRequest,
  createAuthorizationHttpHandler,
  parseAuthorizationCommand,
} from './index.js'

const ATTEMPT_ID = '10000000-0000-4000-8000-000000000001'
const SECRET = 'credential-value-must-never-cross-the-read-wire'

function createHarness() {
  const key = credentialKey('llm-pi-ai', 'openai-codex')
  let configured = false
  let inFlight = false
  let storedKind: 'grant' | undefined
  let cancel: (() => void) | undefined

  const entry = () => ({
    inFlight,
    key,
    label: 'ChatGPT (Codex)',
    methods: [{ id: 'oauth', label: 'Sign in with ChatGPT' }],
  })
  const authorization = {
    async begin(request: {
      interaction: {
        notify(notice: { code?: string; message: string; url?: string }): void
        prompt(prompt: {
          kind: 'secret'
          message: string
          placeholder?: string
        }): Promise<string>
      }
      signal?: AbortSignal
    }) {
      inFlight = true
      try {
        request.interaction.notify({
          code: 'ABCD-EFGH',
          message: 'Continue in your browser',
          url: 'https://example.test/device',
        })
        const cancelled = new Promise<'cancelled'>((resolve) => {
          cancel = () => resolve('cancelled')
          request.signal?.addEventListener('abort', () => resolve('cancelled'), { once: true })
        })
        const answered = request.interaction.prompt({
          kind: 'secret',
          message: 'Paste the one-time secret',
          placeholder: 'Secret',
        }).then((answer) => {
          expect(answer).toBe(SECRET)
          configured = true
          storedKind = 'grant'
          return 'authorized' as const
        })
        return { status: await Promise.race([answered, cancelled]) }
      } finally {
        inFlight = false
        cancel = undefined
      }
    },
    cancel() {
      cancel?.()
    },
    describe(candidate: CredentialKey) {
      return candidate === key ? entry() : undefined
    },
    list() {
      return [entry()]
    },
  }
  const credentials = {
    async deleteRecord(candidate: CredentialKey) {
      expect(candidate).toBe(key)
      configured = false
      storedKind = undefined
    },
    async describeRecord(candidate: CredentialKey) {
      expect(candidate).toBe(key)
      return {
        configured,
        ...(storedKind === undefined ? {} : { kind: storedKind }),
        writable: true,
      }
    },
    async listRecords() {
      return configured && storedKind
        ? [{ key, kind: storedKind }]
        : []
    },
  }
  return {
    controller: new AuthorizationController(authorization as never, credentials),
    inFlight: () => inFlight,
    key,
  }
}

interface HttpResponse {
  body: unknown
  raw: string
  status: number
}

async function createHttpHarness(controller: AuthorizationController) {
  let port = 0
  const handler = createAuthorizationHttpHandler(controller, () => port)
  const server = createServer((request, response) => {
    void handler(request, response)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('HTTP test server has no TCP port.')
  port = address.port
  const origin = `http://127.0.0.1:${String(port)}`

  return {
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve())
      })
    },
    async post(command: unknown, signal?: AbortSignal): Promise<HttpResponse> {
      const response = await fetch(`${origin}/workbench/authorization`, {
        body: JSON.stringify(command),
        headers: {
          'content-type': 'application/json',
          origin,
          'sec-fetch-site': 'same-origin',
        },
        method: 'POST',
        signal,
      })
      const raw = await response.text()
      return {
        body: JSON.parse(raw) as unknown,
        raw,
        status: response.status,
      }
    },
  }
}

describe('Workbench authorization protocol', () => {
  it('strictly parses the closed command vocabulary', () => {
    expect(parseAuthorizationCommand({ action: 'snapshot' })).toEqual({ action: 'snapshot' })
    expect(parseAuthorizationCommand({
      action: 'begin',
      attemptId: ATTEMPT_ID,
      key: 'llm-pi-ai/openai-codex',
      method: 'oauth',
    })).toEqual({
      action: 'begin',
      attemptId: ATTEMPT_ID,
      key: 'llm-pi-ai/openai-codex',
      method: 'oauth',
    })
    expect(() => parseAuthorizationCommand({ action: 'snapshot', extra: true })).toThrow(
      AuthorizationProtocolError,
    )
    expect(() => parseAuthorizationCommand({ action: 'state', attemptId: '../escape' })).toThrow(
      AuthorizationProtocolError,
    )
    expect(() => parseAuthorizationCommand({ action: 'answer', attemptId: ATTEMPT_ID })).toThrow(
      AuthorizationProtocolError,
    )
  })

  it('relays an official flow while every read response remains value-free', async () => {
    const { controller, key } = createHarness()
    const before = await controller.snapshot()
    expect(before.entries).toEqual([
      expect.objectContaining({
        configured: false,
        key: String(key),
        methods: [{ id: 'oauth', label: 'Sign in with ChatGPT' }],
      }),
    ])

    const begin = controller.dispatch({
      action: 'begin',
      attemptId: ATTEMPT_ID,
      key: String(key),
      method: 'oauth',
    })
    await vi.waitFor(async () => {
      await expect(controller.dispatch({ action: 'state', attemptId: ATTEMPT_ID })).resolves.toEqual(
        expect.objectContaining({ status: 'running' }),
      )
    })
    const state = await controller.dispatch({ action: 'state', attemptId: ATTEMPT_ID }) as {
      notices: { code?: string; url?: string }[]
      prompt: { id: string; kind: string }
    }
    expect(state.notices).toEqual([
      expect.objectContaining({ code: 'ABCD-EFGH', url: 'https://example.test/device' }),
    ])
    expect(state.prompt.kind).toBe('secret')
    expect(JSON.stringify(state)).not.toContain(SECRET)

    const afterAnswer = await controller.dispatch({
      action: 'answer',
      answer: SECRET,
      attemptId: ATTEMPT_ID,
      promptId: state.prompt.id,
    })
    expect(JSON.stringify(afterAnswer)).not.toContain(SECRET)
    await expect(begin).resolves.toEqual({ status: 'authorized' })

    const after = await controller.snapshot()
    expect(after.entries[0]).toEqual(expect.objectContaining({ configured: true, kind: 'grant' }))
    expect(JSON.stringify(after)).not.toContain(SECRET)
  })

  it('cancels a running attempt and rejects unknown records', async () => {
    const { controller, key } = createHarness()
    const begin = controller.dispatch({
      action: 'begin',
      attemptId: ATTEMPT_ID,
      key: String(key),
      method: 'oauth',
    })
    await vi.waitFor(async () => {
      await expect(controller.dispatch({ action: 'state', attemptId: ATTEMPT_ID })).resolves.toEqual(
        expect.objectContaining({ status: 'running' }),
      )
    })
    await expect(controller.dispatch({ action: 'cancel', key: String(key) })).resolves.toEqual({
      cancelled: true,
    })
    await expect(begin).resolves.toEqual({ status: 'cancelled' })
    await expect(controller.dispatch({ action: 'delete', key: 'other/missing' })).rejects.toMatchObject({
      code: 'CREDENTIAL_NOT_FOUND',
    })
  })

  it('runs authorization and sign-out through the real HTTP boundary without returning answers', async () => {
    const { controller, key } = createHarness()
    const http = await createHttpHarness(controller)
    try {
      const begin = http.post({
        action: 'begin',
        attemptId: ATTEMPT_ID,
        key: String(key),
        method: 'oauth',
      })
      let state: HttpResponse | undefined
      await vi.waitFor(async () => {
        state = await http.post({ action: 'state', attemptId: ATTEMPT_ID })
        expect(state.status).toBe(200)
        expect(state.body).toEqual({
          ok: true,
          value: expect.objectContaining({
            prompt: expect.objectContaining({ kind: 'secret' }),
            status: 'running',
          }),
        })
      })
      const promptId = (state?.body as {
        value?: { prompt?: { id?: unknown } }
      }).value?.prompt?.id
      expect(typeof promptId).toBe('string')
      expect(state?.raw).not.toContain(SECRET)

      const answer = await http.post({
        action: 'answer',
        answer: SECRET,
        attemptId: ATTEMPT_ID,
        promptId,
      })
      expect(answer.status).toBe(200)
      expect(answer.raw).not.toContain(SECRET)
      await expect(begin).resolves.toMatchObject({
        body: { ok: true, value: { status: 'authorized' } },
        status: 200,
      })

      const configured = await http.post({ action: 'snapshot' })
      expect(configured.body).toEqual({
        ok: true,
        value: {
          entries: [expect.objectContaining({ configured: true, kind: 'grant' })],
        },
      })
      expect(configured.raw).not.toContain(SECRET)
      await expect(http.post({ action: 'delete', key: String(key) })).resolves.toMatchObject({
        body: { ok: true, value: { deleted: true } },
        status: 200,
      })
      await expect(http.post({ action: 'snapshot' })).resolves.toMatchObject({
        body: {
          ok: true,
          value: { entries: [expect.objectContaining({ configured: false })] },
        },
      })
    } finally {
      await http.close()
      controller.dispose()
    }
  })

  it('aborts the official flow and clears its attempt when the begin response disconnects', async () => {
    const { controller, inFlight, key } = createHarness()
    const http = await createHttpHarness(controller)
    const disconnected = new AbortController()
    try {
      const begin = http.post({
        action: 'begin',
        attemptId: ATTEMPT_ID,
        key: String(key),
        method: 'oauth',
      }, disconnected.signal)
      await vi.waitFor(async () => {
        await expect(http.post({ action: 'state', attemptId: ATTEMPT_ID })).resolves.toMatchObject({
          body: { ok: true, value: { status: 'running' } },
          status: 200,
        })
      })
      disconnected.abort()
      await expect(begin).rejects.toThrow()
      await vi.waitFor(async () => {
        expect(inFlight()).toBe(false)
        await expect(http.post({ action: 'state', attemptId: ATTEMPT_ID })).resolves.toMatchObject({
          body: { error: { code: 'ATTEMPT_NOT_FOUND' }, ok: false },
          status: 404,
        })
      })
    } finally {
      await http.close()
      controller.dispose()
    }
  })

  it('redacts unexpected provider failures', async () => {
    const key = credentialKey('llm-pi-ai', 'openai-codex')
    const controller = new AuthorizationController({
      begin: async () => {
        throw new Error(`provider leaked ${SECRET}`)
      },
      cancel: () => {},
      describe: () => ({
        inFlight: false,
        key,
        label: 'ChatGPT',
        methods: [{ id: 'oauth', label: 'Sign in' }],
      }),
      list: () => [],
    } as never, {
      deleteRecord: async () => {},
      describeRecord: async () => ({ configured: false, writable: true }),
      listRecords: async () => [],
    })

    await expect(controller.dispatch({
      action: 'begin',
      attemptId: ATTEMPT_ID,
      key: String(key),
      method: 'oauth',
    })).rejects.toMatchObject({
      code: 'AUTHORIZATION_FAILED',
      message: expect.not.stringContaining(SECRET),
    })
  })

  it('accepts only same-origin requests to the exact loopback authority', () => {
    expect(() => assertTrustedLoopbackRequest({
      host: '127.0.0.1:43123',
      origin: 'http://127.0.0.1:43123',
      'sec-fetch-site': 'same-origin',
    }, 43_123)).not.toThrow()
    expect(() => assertTrustedLoopbackRequest({
      host: '127.0.0.1:43123',
      origin: 'https://attacker.example',
      'sec-fetch-site': 'cross-site',
    }, 43_123)).toThrow(AuthorizationProtocolError)
    expect(() => assertTrustedLoopbackRequest({
      host: 'localhost:43123',
      origin: 'http://localhost:43123',
    }, 43_123)).toThrow(AuthorizationProtocolError)
  })
})
