import type { Context } from '@deepseek-ai/cordis'

export const name = 'dsh-workbench-desktop-core'
export const serviceName = 'dshWorkbenchDesktop'

export interface DesktopCoreService {
  readonly platform: NodeJS.Platform
  readonly protocolVersion: 1
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    dshWorkbenchDesktop: DesktopCoreService
  }
}

/**
 * Root of the first-party desktop contribution.
 *
 * Native capabilities will be registered here as Cordis services instead of
 * being patched into DSH Core.
 */
export function apply(ctx: Context): void {
  const service: DesktopCoreService = Object.freeze({
    platform: process.platform,
    protocolVersion: 1,
  })

  ctx.provide(serviceName, service)
  ctx.logger(name).info('desktop contribution active (protocol %d)', service.protocolVersion)
}
