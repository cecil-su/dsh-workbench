import type { Context } from '@deepseek-ai/cordis'
import type { Loader } from '@deepseek-ai/cordis-plugin-loader'
import type { AppExit } from '@deepseek-ai/dsh-cmdline'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'

export const name = 'dsh-workbench-desktop-core'
export const inject = ['webServer']
export const serviceName = 'dshWorkbenchDesktop'

const READY_MESSAGE_TYPE = 'dsh-workbench/ready'
const SHUTDOWN_MESSAGE_TYPE = 'dsh-workbench/shutdown'
const LOOPBACK_HOST = '127.0.0.1'

export interface DesktopCoreService {
  readonly platform: NodeJS.Platform
  readonly protocolVersion: 1
}

export interface DesktopHostReadyMessage {
  readonly protocolVersion: 1
  readonly type: typeof READY_MESSAGE_TYPE
  readonly url: string
}

interface DesktopHostShutdownMessage {
  readonly protocolVersion: 1
  readonly type: typeof SHUTDOWN_MESSAGE_TYPE
}

type DesktopContext = Context & {
  appExit?: AppExit
  loader?: Loader
  webServer: WebServer
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    dshWorkbenchDesktop: DesktopCoreService
  }
}

export function createDesktopHostReadyMessage(
  host: string,
  port: number,
): DesktopHostReadyMessage {
  if (host !== LOOPBACK_HOST) {
    throw new Error(`Desktop host requires loopback, got ${host}`)
  }
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new RangeError(`Desktop host received an invalid port: ${port}`)
  }

  return Object.freeze({
    protocolVersion: 1,
    type: READY_MESSAGE_TYPE,
    url: `http://${host}:${port}`,
  })
}

export function isDesktopHostShutdownMessage(
  message: unknown,
): message is DesktopHostShutdownMessage {
  if (typeof message !== 'object' || message === null) return false
  const candidate = message as Record<string, unknown>
  return candidate.type === SHUTDOWN_MESSAGE_TYPE && candidate.protocolVersion === 1
}

function installDesktopHostIpc(ctx: DesktopContext): void {
  const send = process.send
  if (typeof send !== 'function') return

  const logger = ctx.logger(name)
  ctx.effect(() => {
    const handleMessage = (message: unknown): void => {
      if (!isDesktopHostShutdownMessage(message)) return
      const exit = ctx.get('appExit', false)
      if (exit) exit(0)
      else logger.error('desktop shutdown requested without the DSH appExit service')
    }
    const handleDisconnect = (): void => {
      ctx.get('appExit', false)?.(0)
    }

    process.on('message', handleMessage)
    process.on('disconnect', handleDisconnect)
    return () => {
      process.off('message', handleMessage)
      process.off('disconnect', handleDisconnect)
    }
  }, 'desktop host IPC')

  const announceReady = (): void => {
    if (!process.connected) return
    const webServer = ctx.get('webServer', false)
    if (!webServer) return

    const message = createDesktopHostReadyMessage(webServer.host, webServer.port)
    send.call(process, message, (error) => {
      if (error) logger.error('failed to announce desktop readiness: %s', error.message)
    })
  }

  const settled = ctx.get('loader', false)?.await()
  if (settled) void settled.then(announceReady, () => {})
  else queueMicrotask(announceReady)
}

/**
 * Root of the first-party desktop contribution.
 *
 * Product capabilities grow from this plugin (or sibling plugins) instead of
 * being patched into DSH Core.
 */
export function apply(ctx: Context): void {
  const service: DesktopCoreService = Object.freeze({
    platform: process.platform,
    protocolVersion: 1,
  })

  ctx.provide(serviceName, service)
  installDesktopHostIpc(ctx as DesktopContext)
  ctx.logger(name).info('desktop contribution active (protocol %d)', service.protocolVersion)
}
