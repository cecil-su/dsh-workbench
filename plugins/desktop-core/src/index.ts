import type { Context } from '@deepseek-ai/cordis'

export const name = 'dsh-workbench-desktop-core'

/**
 * Root of the first-party desktop contribution.
 *
 * Native capabilities will be registered here as Cordis services instead of
 * being patched into DSH Core.
 */
export function apply(ctx: Context): void {
  void ctx
}
