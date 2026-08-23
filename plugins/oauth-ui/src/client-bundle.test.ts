import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'

import { describe, expect, it, vi } from 'vitest'

describe('oauth-ui client bundle', () => {
  it('registers an authorization settings section through the public client module contract', async () => {
    const source = await readFile(new URL('./client.js', import.meta.url), 'utf8')
    let definition: {
      factory: (require: (name: string) => unknown) => {
        apply(ctx: unknown): void
        inject: string[]
      }
      id: string
    } | undefined

    runInNewContext(source, {
      AbortController,
      clearInterval,
      crypto,
      fetch: vi.fn(),
      setInterval,
      window: {
        __ModuleLoader__: {
          load(value: typeof definition) {
            definition = value
          },
        },
      },
    })

    expect(definition?.id).toBe('@dsh-workbench/oauth-ui')
    const client = definition?.factory((dependency) => {
      if (dependency === 'react') {
        return {
          createElement: vi.fn(),
          useCallback: vi.fn(),
          useEffect: vi.fn(),
          useRef: vi.fn(),
          useState: vi.fn(),
        }
      }
      throw new Error(`Unexpected client external ${dependency}`)
    })
    const register = vi.fn(() => vi.fn())
    const inject = vi.fn((_name: string, callback: () => unknown) => callback())
    const localeRegister = vi.fn(() => vi.fn())
    const context = {
      effect: (callback: () => unknown) => callback(),
      locale: {
        bind: () => (key: string) => key,
        register: localeRegister,
      },
      slots: { inject, register },
    }

    client?.apply(context)

    expect(client?.inject).toEqual(['slots', 'locale'])
    expect(localeRegister).toHaveBeenCalledOnce()
    expect(inject).toHaveBeenCalledWith('settings.section', expect.any(Function))
    expect(register).toHaveBeenCalledWith(expect.objectContaining({
      id: 'dsh-workbench-authorization',
      name: 'settings.section',
    }), expect.any(Function))
    expect(source).not.toContain('console.')
  })
})
