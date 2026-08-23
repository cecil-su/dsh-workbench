import { randomUUID } from 'node:crypto'
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'

import type { Context } from '@deepseek-ai/cordis'
import {
  AuthorizationDeclinedError,
  type AuthorizationEntry,
  type AuthorizationNotice,
  type AuthorizationPrompt,
  type AuthorizationService,
} from '@deepseek-ai/dsh-authorization'
import {
  parseCredentialKey,
  type CredentialKey,
  type CredentialProvider,
  type CredentialRecordInfo,
} from '@deepseek-ai/dsh-credentials'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'

export const name = 'dsh-workbench-oauth-ui'
export const inject = ['authorization', 'credentials', 'webServer']
export const AUTHORIZATION_ROUTE = '/workbench/authorization'

const MAX_BODY_BYTES = 64 * 1024
const MAX_ANSWER_LENGTH = 16 * 1024
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

type AuthorizationFacade = Pick<
  AuthorizationService,
  'begin' | 'cancel' | 'describe' | 'list'
>
type CredentialsFacade = Pick<
  CredentialProvider,
  'deleteRecord' | 'describeRecord' | 'listRecords'
>

export interface AuthorizationMethodView {
  id: string
  label: string
}

export interface AuthorizationEntryView {
  configured: boolean
  inFlight: boolean
  key: string
  kind?: 'api-key' | 'grant'
  label: string
  methods: readonly AuthorizationMethodView[]
  orphan: boolean
  writable: boolean
}

export interface AuthorizationSnapshot {
  entries: readonly AuthorizationEntryView[]
}

export interface AuthorizationNoticeView {
  code?: string
  message: string
  url?: string
}

export type AuthorizationPromptView = {
  id: string
  message: string
  placeholder?: string
} & (
  | { kind: 'secret' | 'text' }
  | {
      kind: 'select'
      options: readonly {
        description?: string
        id: string
        label: string
      }[]
    }
)

export interface AuthorizationAttemptView {
  attemptId: string
  key: string
  method: string
  notices: readonly AuthorizationNoticeView[]
  prompt?: AuthorizationPromptView
  revision: number
  status: 'running'
}

export type AuthorizationCommand =
  | { action: 'snapshot' }
  | { action: 'begin'; attemptId: string; key: string; method: string }
  | { action: 'state'; attemptId: string }
  | { action: 'answer'; answer: string; attemptId: string; promptId: string }
  | { action: 'decline'; attemptId: string; promptId: string }
  | { action: 'cancel'; key: string }
  | { action: 'delete'; key: string }

export class AuthorizationProtocolError extends Error {
  readonly code: string
  readonly status: number

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'AuthorizationProtocolError'
    this.code = code
    this.status = status
  }
}

interface PendingPrompt {
  answer(value: string): void
  decline(): void
  view: AuthorizationPromptView
  withdraw(reason: Error): void
}

interface AttemptState {
  abortController: AbortController
  attemptId: string
  key: CredentialKey
  method: string
  notices: AuthorizationNoticeView[]
  pendingPrompt?: PendingPrompt
  revision: number
}

function recordOf(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AuthorizationProtocolError(400, 'INVALID_COMMAND', 'Request body must be an object.')
  }
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new AuthorizationProtocolError(400, 'INVALID_COMMAND', 'Request body has unexpected fields.')
  }
}

function boundedString(
  value: unknown,
  field: string,
  maximum: number,
  options: { allowEmpty?: boolean } = {},
): string {
  if (
    typeof value !== 'string'
    || value.length > maximum
    || (!options.allowEmpty && value.length === 0)
  ) {
    throw new AuthorizationProtocolError(400, 'INVALID_COMMAND', `${field} is invalid.`)
  }
  return value
}

function attemptIdOf(value: unknown): string {
  const attemptId = boundedString(value, 'attemptId', 36)
  if (!UUID_PATTERN.test(attemptId)) {
    throw new AuthorizationProtocolError(400, 'INVALID_COMMAND', 'attemptId is invalid.')
  }
  return attemptId.toLowerCase()
}

function keyStringOf(value: unknown): string {
  return boundedString(value, 'key', 128)
}

export function parseAuthorizationCommand(value: unknown): AuthorizationCommand {
  const command = recordOf(value)
  const action = boundedString(command.action, 'action', 16)

  switch (action) {
    case 'snapshot':
      exactKeys(command, ['action'])
      return { action }
    case 'begin':
      exactKeys(command, ['action', 'attemptId', 'key', 'method'])
      return {
        action,
        attemptId: attemptIdOf(command.attemptId),
        key: keyStringOf(command.key),
        method: boundedString(command.method, 'method', 80),
      }
    case 'state':
      exactKeys(command, ['action', 'attemptId'])
      return { action, attemptId: attemptIdOf(command.attemptId) }
    case 'answer':
      exactKeys(command, ['action', 'answer', 'attemptId', 'promptId'])
      return {
        action,
        answer: boundedString(command.answer, 'answer', MAX_ANSWER_LENGTH, { allowEmpty: true }),
        attemptId: attemptIdOf(command.attemptId),
        promptId: attemptIdOf(command.promptId),
      }
    case 'decline':
      exactKeys(command, ['action', 'attemptId', 'promptId'])
      return {
        action,
        attemptId: attemptIdOf(command.attemptId),
        promptId: attemptIdOf(command.promptId),
      }
    case 'cancel':
    case 'delete':
      exactKeys(command, ['action', 'key'])
      return { action, key: keyStringOf(command.key) }
    default:
      throw new AuthorizationProtocolError(400, 'INVALID_COMMAND', 'Unknown authorization action.')
  }
}

function credentialKeyOf(value: string): CredentialKey {
  try {
    return parseCredentialKey(value)
  } catch {
    throw new AuthorizationProtocolError(400, 'INVALID_KEY', 'Credential key is invalid.')
  }
}

function boundedProviderText(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) {
    throw new Error(`Authorization provider supplied an invalid ${field}.`)
  }
  return value
}

function noticeView(notice: AuthorizationNotice): AuthorizationNoticeView {
  const view: AuthorizationNoticeView = {
    message: boundedProviderText(notice.message, 'notice message', 4096),
  }
  if (notice.code !== undefined) {
    view.code = boundedProviderText(notice.code, 'notice code', 256)
  }
  if (notice.url !== undefined) {
    const rawUrl = boundedProviderText(notice.url, 'notice URL', 4096)
    const parsed = new URL(rawUrl)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error('Authorization provider supplied an unsupported notice URL.')
    }
    view.url = parsed.href
  }
  return view
}

function promptView(prompt: AuthorizationPrompt): AuthorizationPromptView {
  const base = {
    id: randomUUID(),
    message: boundedProviderText(prompt.message, 'prompt message', 4096),
    ...(!('placeholder' in prompt) || prompt.placeholder === undefined
      ? {}
      : { placeholder: boundedProviderText(prompt.placeholder, 'prompt placeholder', 512) }),
  }
  if (prompt.kind !== 'select') return { ...base, kind: prompt.kind }
  if (prompt.options.length === 0 || prompt.options.length > 32) {
    throw new Error('Authorization provider supplied an invalid option list.')
  }
  const ids = new Set<string>()
  const options = prompt.options.map((option) => {
    const id = boundedProviderText(option.id, 'option id', 256)
    if (ids.has(id)) throw new Error('Authorization provider supplied duplicate option ids.')
    ids.add(id)
    return {
      id,
      label: boundedProviderText(option.label, 'option label', 512),
      ...(option.description === undefined
        ? {}
        : { description: boundedProviderText(option.description, 'option description', 2048) }),
    }
  })
  return { ...base, kind: 'select', options }
}

function cloneAttempt(state: AttemptState): AuthorizationAttemptView {
  return {
    attemptId: state.attemptId,
    key: state.key,
    method: state.method,
    notices: state.notices.map((notice) => ({ ...notice })),
    ...(state.pendingPrompt === undefined ? {} : { prompt: structuredClone(state.pendingPrompt.view) }),
    revision: state.revision,
    status: 'running',
  }
}

function publicAuthorizationFailure(error: unknown): AuthorizationProtocolError {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : ''
  switch (code) {
    case 'ALREADY_IN_FLIGHT':
      return new AuthorizationProtocolError(409, code, 'This authorization is already in progress.')
    case 'NO_FLOW':
      return new AuthorizationProtocolError(404, code, 'This authorization method is unavailable.')
    case 'UNKNOWN_METHOD':
      return new AuthorizationProtocolError(400, code, 'The selected authorization method is unavailable.')
    case 'NOT_COMMITTED':
      return new AuthorizationProtocolError(502, code, 'Authorization finished without saving a credential.')
    default:
      return new AuthorizationProtocolError(502, 'AUTHORIZATION_FAILED', 'Authorization failed. Try again.')
  }
}

export class AuthorizationController {
  readonly #attempts = new Map<string, AttemptState>()

  constructor(
    readonly authorization: AuthorizationFacade,
    readonly credentials: CredentialsFacade,
  ) {}

  async snapshot(): Promise<AuthorizationSnapshot> {
    const flows = this.authorization.list()
    const records = await this.credentials.listRecords()
    const flowKeys = new Set(flows.map((entry) => String(entry.key)))
    const flowViews = await Promise.all(flows.map(async (entry) => (
      this.entryView(entry, await this.credentials.describeRecord(entry.key))
    )))
    const orphanViews = await Promise.all(records
      .filter((entry) => !flowKeys.has(String(entry.key)))
      .map(async (entry): Promise<AuthorizationEntryView> => {
        const info = await this.credentials.describeRecord(entry.key)
        return {
          configured: info.configured,
          inFlight: false,
          key: String(entry.key),
          ...(info.kind === undefined ? {} : { kind: info.kind }),
          label: String(entry.key),
          methods: [],
          orphan: true,
          writable: info.writable,
        }
      }))

    return {
      entries: [...flowViews, ...orphanViews].sort((left, right) => (
        Number(left.orphan) - Number(right.orphan)
        || left.label.localeCompare(right.label)
        || left.key.localeCompare(right.key)
      )),
    }
  }

  async dispatch(command: AuthorizationCommand, signal?: AbortSignal): Promise<unknown> {
    switch (command.action) {
      case 'snapshot': return this.snapshot()
      case 'begin': return this.begin(command, signal)
      case 'state': return this.state(command.attemptId)
      case 'answer': return this.answer(command)
      case 'decline': return this.decline(command)
      case 'cancel': return this.cancel(command.key)
      case 'delete': return this.delete(command.key)
    }
  }

  dispose(): void {
    const keys = new Set<CredentialKey>()
    for (const attempt of this.#attempts.values()) {
      keys.add(attempt.key)
      attempt.abortController.abort(new Error('Authorization surface stopped.'))
    }
    for (const key of keys) this.authorization.cancel(key)
    this.#attempts.clear()
  }

  private entryView(entry: AuthorizationEntry, info: CredentialRecordInfo): AuthorizationEntryView {
    return {
      configured: info.configured,
      inFlight: entry.inFlight,
      key: String(entry.key),
      ...(info.kind === undefined ? {} : { kind: info.kind }),
      label: boundedProviderText(entry.label, 'flow label', 512),
      methods: entry.methods.map((method) => ({
        id: boundedProviderText(method.id, 'method id', 80),
        label: boundedProviderText(method.label, 'method label', 512),
      })),
      orphan: false,
      writable: info.writable,
    }
  }

  private async begin(
    command: Extract<AuthorizationCommand, { action: 'begin' }>,
    requestSignal?: AbortSignal,
  ): Promise<{ status: 'authorized' | 'cancelled' }> {
    if (this.#attempts.has(command.attemptId)) {
      throw new AuthorizationProtocolError(409, 'DUPLICATE_ATTEMPT', 'This authorization attempt already exists.')
    }
    const key = credentialKeyOf(command.key)
    const flow = this.authorization.describe(key)
    if (!flow) {
      throw new AuthorizationProtocolError(404, 'NO_FLOW', 'This authorization method is unavailable.')
    }
    if (!flow.methods.some((method) => method.id === command.method)) {
      throw new AuthorizationProtocolError(400, 'UNKNOWN_METHOD', 'The selected authorization method is unavailable.')
    }

    const attempt: AttemptState = {
      abortController: new AbortController(),
      attemptId: command.attemptId,
      key,
      method: command.method,
      notices: [],
      revision: 0,
    }
    this.#attempts.set(command.attemptId, attempt)

    const abortFromRequest = (): void => {
      attempt.abortController.abort(new Error('Authorization request disconnected.'))
    }
    if (requestSignal?.aborted) abortFromRequest()
    else requestSignal?.addEventListener('abort', abortFromRequest, { once: true })

    try {
      return await this.authorization.begin({
        interaction: {
          notify: (notice) => {
            attempt.notices.push(noticeView(notice))
            if (attempt.notices.length > 8) attempt.notices.shift()
            attempt.revision += 1
          },
          prompt: (prompt) => this.waitForPrompt(attempt, prompt),
        },
        key,
        method: command.method,
        signal: attempt.abortController.signal,
      })
    } catch (error) {
      throw publicAuthorizationFailure(error)
    } finally {
      requestSignal?.removeEventListener('abort', abortFromRequest)
      attempt.abortController.abort(new Error('Authorization attempt ended.'))
      this.#attempts.delete(command.attemptId)
    }
  }

  private state(attemptId: string): AuthorizationAttemptView {
    const attempt = this.#attempts.get(attemptId)
    if (!attempt) {
      throw new AuthorizationProtocolError(404, 'ATTEMPT_NOT_FOUND', 'Authorization attempt is no longer running.')
    }
    return cloneAttempt(attempt)
  }

  private answer(command: Extract<AuthorizationCommand, { action: 'answer' }>): AuthorizationAttemptView {
    const attempt = this.#attempts.get(command.attemptId)
    const pending = attempt?.pendingPrompt
    if (!attempt || !pending || pending.view.id !== command.promptId) {
      throw new AuthorizationProtocolError(409, 'PROMPT_NOT_FOUND', 'Authorization prompt is no longer waiting.')
    }
    if (
      pending.view.kind === 'select'
      && !pending.view.options.some((option) => option.id === command.answer)
    ) {
      throw new AuthorizationProtocolError(400, 'INVALID_ANSWER', 'The selected answer is unavailable.')
    }
    pending.answer(command.answer)
    return cloneAttempt(attempt)
  }

  private decline(command: Extract<AuthorizationCommand, { action: 'decline' }>): AuthorizationAttemptView {
    const attempt = this.#attempts.get(command.attemptId)
    const pending = attempt?.pendingPrompt
    if (!attempt || !pending || pending.view.id !== command.promptId) {
      throw new AuthorizationProtocolError(409, 'PROMPT_NOT_FOUND', 'Authorization prompt is no longer waiting.')
    }
    pending.decline()
    return cloneAttempt(attempt)
  }

  private cancel(rawKey: string): { cancelled: true } {
    const key = credentialKeyOf(rawKey)
    const flow = this.authorization.describe(key)
    if (!flow) {
      throw new AuthorizationProtocolError(404, 'NO_FLOW', 'This authorization method is unavailable.')
    }
    for (const attempt of this.#attempts.values()) {
      if (attempt.key === key) {
        attempt.abortController.abort(new Error('Authorization cancelled.'))
      }
    }
    this.authorization.cancel(key)
    return { cancelled: true }
  }

  private async delete(rawKey: string): Promise<{ deleted: true }> {
    const key = credentialKeyOf(rawKey)
    const flow = this.authorization.describe(key)
    if (flow?.inFlight) {
      throw new AuthorizationProtocolError(409, 'ALREADY_IN_FLIGHT', 'Cancel authorization before signing out.')
    }
    const records = await this.credentials.listRecords()
    if (!flow && !records.some((entry) => entry.key === key)) {
      throw new AuthorizationProtocolError(404, 'CREDENTIAL_NOT_FOUND', 'Credential is no longer stored.')
    }
    const info = await this.credentials.describeRecord(key)
    if (!info.writable) {
      throw new AuthorizationProtocolError(409, 'CREDENTIAL_READ_ONLY', 'This credential cannot be removed here.')
    }
    if (this.authorization.describe(key)?.inFlight) {
      throw new AuthorizationProtocolError(409, 'ALREADY_IN_FLIGHT', 'Cancel authorization before signing out.')
    }
    await this.credentials.deleteRecord(key)
    return { deleted: true }
  }

  private waitForPrompt(attempt: AttemptState, prompt: AuthorizationPrompt): Promise<string> {
    if (attempt.pendingPrompt) {
      return Promise.reject(new Error('Authorization provider opened more than one prompt at a time.'))
    }
    const view = promptView(prompt)
    return new Promise<string>((resolve, reject) => {
      let settled = false
      const finish = (callback: () => void): void => {
        if (settled) return
        settled = true
        attempt.abortController.signal.removeEventListener('abort', onAttemptAbort)
        prompt.signal?.removeEventListener('abort', onPromptAbort)
        attempt.pendingPrompt = undefined
        attempt.revision += 1
        callback()
      }
      const onAttemptAbort = (): void => {
        finish(() => reject(new Error('Authorization attempt was cancelled.')))
      }
      const onPromptAbort = (): void => {
        finish(() => reject(new Error('Authorization prompt was withdrawn.')))
      }
      const pending: PendingPrompt = {
        answer: (value) => finish(() => resolve(value)),
        decline: () => finish(() => reject(new AuthorizationDeclinedError())),
        view,
        withdraw: (reason) => finish(() => reject(reason)),
      }
      attempt.pendingPrompt = pending
      attempt.revision += 1
      attempt.abortController.signal.addEventListener('abort', onAttemptAbort, { once: true })
      prompt.signal?.addEventListener('abort', onPromptAbort, { once: true })
      if (attempt.abortController.signal.aborted) pending.withdraw(new Error('Authorization attempt was cancelled.'))
      else if (prompt.signal?.aborted) pending.withdraw(new Error('Authorization prompt was withdrawn.'))
    })
  }
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? undefined : value
}

export function assertTrustedLoopbackRequest(
  headers: IncomingHttpHeaders,
  port: number,
): void {
  const authority = `127.0.0.1:${String(port)}`
  if (singleHeader(headers.host)?.toLowerCase() !== authority) {
    throw new AuthorizationProtocolError(403, 'UNTRUSTED_REQUEST', 'Authorization request is not trusted.')
  }
  if (singleHeader(headers.origin)?.toLowerCase() !== `http://${authority}`) {
    throw new AuthorizationProtocolError(403, 'UNTRUSTED_REQUEST', 'Authorization request is not trusted.')
  }
  const fetchSite = singleHeader(headers['sec-fetch-site'])
  if (fetchSite !== undefined && fetchSite.toLowerCase() !== 'same-origin') {
    throw new AuthorizationProtocolError(403, 'UNTRUSTED_REQUEST', 'Authorization request is not trusted.')
  }
}

async function readRequestBody(req: IncomingMessage): Promise<unknown> {
  const declaredLength = Number(singleHeader(req.headers['content-length']))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new AuthorizationProtocolError(413, 'REQUEST_TOO_LARGE', 'Authorization request is too large.')
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const rawChunk of req) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk)
    size += chunk.byteLength
    if (size > MAX_BODY_BYTES) {
      throw new AuthorizationProtocolError(413, 'REQUEST_TOO_LARGE', 'Authorization request is too large.')
    }
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw new AuthorizationProtocolError(400, 'INVALID_JSON', 'Authorization request must contain valid JSON.')
  }
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.destroyed || res.writableEnded) return
  const serialized = JSON.stringify(body)
  res.writeHead(status, {
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(serialized),
    'content-type': 'application/json; charset=utf-8',
  })
  res.end(serialized)
}

export function createAuthorizationHttpHandler(
  controller: AuthorizationController,
  port: number | (() => number),
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const requestAbort = new AbortController()
    const handleClose = (): void => {
      if (!res.writableEnded) requestAbort.abort(new Error('Authorization request disconnected.'))
    }
    res.once('close', handleClose)
    try {
      const activePort = typeof port === 'function' ? port() : port
      assertTrustedLoopbackRequest(req.headers, activePort)
      if (req.method !== 'POST') {
        throw new AuthorizationProtocolError(405, 'METHOD_NOT_ALLOWED', 'Authorization requests require POST.')
      }
      const contentType = singleHeader(req.headers['content-type'])?.split(';', 1)[0]?.trim().toLowerCase()
      if (contentType !== 'application/json') {
        throw new AuthorizationProtocolError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Authorization requests require JSON.')
      }
      const command = parseAuthorizationCommand(await readRequestBody(req))
      const value = await controller.dispatch(command, requestAbort.signal)
      writeJson(res, 200, { ok: true, value })
    } catch (error) {
      const failure = error instanceof AuthorizationProtocolError
        ? error
        : new AuthorizationProtocolError(500, 'INTERNAL', 'Authorization service is unavailable.')
      writeJson(res, failure.status, {
        error: { code: failure.code, message: failure.message },
        ok: false,
      })
    } finally {
      res.off('close', handleClose)
    }
  }
}

type OAuthContext = Context & {
  authorization: AuthorizationService
  credentials: CredentialProvider
  webServer: WebServer
}

export function apply(ctx: Context): void {
  const oauthContext = ctx as OAuthContext
  if (oauthContext.webServer.host !== '127.0.0.1') {
    throw new Error('Workbench authorization UI requires a loopback-only Web server.')
  }
  const controller = new AuthorizationController(
    oauthContext.authorization,
    oauthContext.credentials,
  )
  ctx.effect(() => {
    const unregister = oauthContext.webServer.register({
      handler: createAuthorizationHttpHandler(controller, () => oauthContext.webServer.port),
      kind: 'exact',
      path: AUTHORIZATION_ROUTE,
    })
    return () => {
      controller.dispose()
      unregister()
    }
  }, 'Workbench authorization route')
}
